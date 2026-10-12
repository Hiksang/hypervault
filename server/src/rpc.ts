import { isHex, type Address, type Hex } from "viem";
// The two things the service asks of a node. `call` resolves to the bytes
// the contract returned, "0x" when it returned none. Both have to settle,
// because callers share a read in flight.
export type Rpc = {
  chainId(): Promise<number>;
  call(to: Address, data: Hex): Promise<Hex>;
};
// What `call` rejects with when the node says the call failed in the
// contract: it reverted there, or returned far more than an answer holds.
// Whoever controls the contract can produce these at will. Any other
// rejection is the RPC's own (no reply in time, an HTTP error, a rate limit,
// an error of any other kind, something that is not a JSON-RPC reply) and
// says nothing about the contract: an outsider can provoke those.
export class CallFailed extends Error {}
// A node reports a revert as an error with code 3. Nothing else in an error
// is taken as the contract's doing: not its message and not data sent along,
// because a proxy or a rate limiter in front of the node words its refusals
// as it likes.
const reverted = 3;
// A reply cut at the limit was cut inside the one long string it holds: the
// return value, or the message or data of an error. Closing that string and
// the objects around it gives the reply's own fields back, with that string
// cut short. The cut can fall inside an escape, so up to five characters may
// have to go first. What cannot be closed this way was no JSON-RPC reply.
function mend(start: string): unknown {
  for (let drop = 0; drop < 6; drop++)
    for (const end of ['"}', '"}}'])
      try {
        return JSON.parse(start.slice(0, start.length - drop) + end);
      } catch {
        // The next ending is tried.
      }
  return null;
}
// A read is answered in well under a kilobyte. Without a limit a contract
// could answer in megabytes, and fetching and decoding them would stall every
// room.
const replyLimit = 8 * 1024;
// viem's own transport is not used: its timeout stops at the reply's headers,
// it waits as long as a Retry-After header says before it tries again, and it
// reports a reply without a result as the contract returning nothing.
export function jsonRpc(rpcUrl: string, timeout = 4_000): Rpc {
  // fetch refuses a URL that carries credentials, and quotes it when it does.
  const url = new URL(rpcUrl);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (url.username || url.password) {
    const [user, password] = [url.username, url.password].map(
      decodeURIComponent,
    );
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    url.username = "";
    url.password = "";
  }
  let sent = 0;
  async function ask(method: string, params: unknown[]): Promise<unknown> {
    // The whole reply has this long to arrive. A node that goes quiet,
    // before it or half way through, must turn into a 503 well inside the
    // 15 s a client waits.
    const signal = AbortSignal.timeout(timeout);
    const send = () =>
      fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++sent, method, params }),
        signal,
      });
    // A connection the node closed while it sat idle fails on its next use,
    // which is worth one more try. Nothing else is tried twice.
    const response = await send().catch((error: unknown) => {
      if (signal.aborted) throw error;
      return send();
    });
    const kept: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      kept.push(chunk);
      size += chunk.byteLength;
      // Leaving the loop drops the connection: the rest is never fetched.
      if (size > replyLimit) break;
    }
    const cut = size > replyLimit;
    const text = Buffer.concat(kept).subarray(0, replyLimit).toString();
    let reply: { result?: unknown; error?: unknown } = {};
    try {
      const parsed: unknown = cut ? mend(text) : JSON.parse(text);
      if (typeof parsed === "object" && parsed !== null) reply = parsed;
    } catch {
      // Not JSON: neither a result nor an error, which is refused below.
    }
    if (typeof reply.error === "object" && reply.error !== null) {
      const error = reply.error as Record<string, unknown>;
      const said =
        typeof error.message === "string" ? error.message : "no message";
      if (error.code === reverted) throw new CallFailed(said);
      throw new Error(
        `the RPC answered with error ${JSON.stringify(error.code)}: ${said}`,
      );
    }
    if (!response.ok)
      throw new Error(`the RPC answered HTTP ${response.status}`);
    if (cut) {
      if (isHex(reply.result))
        throw new CallFailed("returned more than 8 KB, which is no answer");
      throw new Error("the RPC answered with more than 8 KB and no result");
    }
    if (reply.result === undefined || reply.result === null)
      throw new Error("the RPC answered without a result");
    return reply.result;
  }
  return {
    async chainId() {
      const result = await ask("eth_chainId", []);
      if (!isHex(result))
        throw new Error("the RPC answered with a chain id that is not hex");
      return Number(result);
    },
    async call(to, data) {
      const result = await ask("eth_call", [{ to, data }, "latest"]);
      if (!isHex(result))
        throw new Error("the RPC answered a call with something not hex");
      return result;
    },
  };
}
