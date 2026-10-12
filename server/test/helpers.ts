import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type RequestListener,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/app.ts";
import { sessionTypedData } from "../src/auth.ts";
import type { Chain } from "../src/chain.ts";
import type { Config } from "../src/config.ts";
import type { ErrorCode } from "../src/errors.ts";
import { statuses } from "../src/errors.ts";
import { listen } from "../src/http.ts";
import { openStore, type Message, type Store } from "../src/store.ts";
export const chainId = 31337;
export const factory = `0x${"f0".repeat(20)}` as Address;
export const origin = "http://127.0.0.1:5173";
export const vault = `0x${"a1".repeat(20)}` as Address;
export const otherVault = `0x${"b2".repeat(20)}` as Address;
export const stranger = `0x${"c3".repeat(20)}` as Address;
// Keys are generated per run, so no key material lives in the repository.
export type Wallet = ReturnType<typeof wallet>;
export function wallet() {
  const account = privateKeyToAccount(generatePrivateKey());
  return { account, address: account.address.toLowerCase() as Address };
}
// Signs a session for `audience`. `named` lets a test sign a message that
// names another wallet or another chain than the signer's own.
export function sign(
  from: Wallet,
  issuedAt: number,
  audience: string,
  named: { wallet?: Address; chain?: number } = {},
): Promise<Hex> {
  return from.account.signTypedData(
    sessionTypedData(
      { chainId: named.chain ?? chainId, audience },
      named.wallet ?? from.address,
      BigInt(issuedAt),
    ),
  );
}
// What the stub chain reports. `failing` makes every read reject: as the RPC
// failing, unless `failure` gives another error (a VaultFault for a vault
// that will not answer). `reads` counts the reads that reached it.
export type Ledger = {
  vaults: Map<Address, { owner: Address; depositors: Set<Address> }>;
  failing: boolean;
  failure?: unknown;
  reads: number;
};
export function stubChain(ledger: Ledger): Chain {
  async function read<T>(answer: () => T): Promise<T> {
    ledger.reads += 1;
    if (ledger.failing)
      throw (
        ledger.failure ??
        new Error("stub RPC down at http://rpc.invalid/private-api-key")
      );
    return answer();
  }
  return {
    isVault: (at) => read(() => ledger.vaults.has(at)),
    ownerOf: (at) =>
      read(() => {
        const found = ledger.vaults.get(at);
        if (!found) throw new Error("stub call reverted");
        return found.owner;
      }),
    isDepositor: (at, account) =>
      read(() => ledger.vaults.get(at)?.depositors.has(account) ?? false),
  };
}
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    host: "127.0.0.1",
    chainId,
    rpcUrl: "http://rpc.invalid",
    factory,
    audience: "http://chat.invalid",
    databasePath: ":memory:",
    sessionSecret: randomBytes(24).toString("hex"),
    corsOrigins: [origin],
    posting: "members",
    admin: null,
    ...overrides,
  };
}
export type Reply = {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
};
// The two clocks a test moves by hand. `ms` is the wall clock: moving it
// forward is time passing, which the monotonic clock `up` follows; moving it
// back is a correction of the wall clock, which `up` ignores. Writing `wall`
// moves the wall clock alone, for a correction forward.
export function testClock() {
  return {
    wall: 1_800_000_000_000,
    up: 5_000_000,
    get ms() {
      return this.wall;
    },
    set ms(value: number) {
      if (value > this.wall) this.up += value - this.wall;
      this.wall = value;
    },
  };
}
export type Chat = Awaited<ReturnType<typeof startChat>>;
// A real HTTP server on an ephemeral loopback port, backed by an in-memory
// database, the stub chain and clocks the test moves by hand. Unless a test
// says otherwise the audience is the URL the server is reached at, which is
// only known once it listens, so the handler is bound after that.
export async function startChat(
  overrides: Partial<Config> = {},
  parts: {
    db?: (db: Store) => Store;
    chain?: Chain;
    // Leaves the app on its own monotonic clock instead of the test's.
    ownClock?: boolean;
  } = {},
) {
  const owner = wallet();
  const depositor = wallet();
  const visitor = wallet();
  const ledger: Ledger = {
    vaults: new Map([
      [
        vault,
        { owner: owner.address, depositors: new Set([depositor.address]) },
      ],
      [otherVault, { owner: depositor.address, depositors: new Set() }],
    ]),
    failing: false,
    reads: 0,
  };
  const clock = testClock();
  const logs: string[] = [];
  const base = testConfig(overrides);
  const db = openStore(base.databasePath);
  let app: RequestListener = (_, res) => res.destroy();
  const server = await listen(
    (req, res) => app(req, res),
    base.host,
    base.port,
  );
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = { ...base, audience: overrides.audience ?? url };
  app = createApp({
    db: parts.db ? parts.db(db) : db,
    chain: parts.chain ?? stubChain(ledger),
    config,
    now: () => clock.wall,
    ...(!parts.ownClock && { monotonic: () => clock.up }),
    log: (line) => logs.push(line),
  });
  const seconds = () => Math.floor(clock.wall / 1000);
  async function call(
    method: string,
    path: string,
    options: {
      token?: string;
      body?: unknown;
      raw?: string | Uint8Array<ArrayBuffer>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Reply> {
    const sends = options.body !== undefined || options.raw !== undefined;
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(sends && { "Content-Type": "application/json" }),
        ...(options.token && { Authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      body: options.raw ?? (sends ? JSON.stringify(options.body) : undefined),
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
  }
  async function signIn(from: Wallet): Promise<string> {
    const issuedAt = seconds();
    const reply = await call("POST", "/session", {
      body: {
        address: from.address,
        issuedAt,
        signature: await sign(from, issuedAt, config.audience),
      },
    });
    assert.equal(reply.status, 200);
    return reply.body.token as string;
  }
  function post(token: string, text: string, at = vault): Promise<Reply> {
    return call("POST", `/vaults/${at}/messages`, { token, body: { text } });
  }
  // Posts and moves the clock past the three-second gap.
  async function say(token: string, text: string, at = vault) {
    const reply = await post(token, text, at);
    assert.equal(reply.status, 201);
    clock.ms += 3_000;
    return reply.body.message as Message;
  }
  async function messages(query = "", at = vault): Promise<Message[]> {
    const reply = await call("GET", `/vaults/${at}/messages${query}`);
    assert.equal(reply.status, 200);
    return reply.body.messages as Message[];
  }
  function hide(token: string, id: number, hidden: boolean, at = vault) {
    return call("POST", `/vaults/${at}/messages/${id}/hide`, {
      token,
      body: { hidden },
    });
  }
  async function close() {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    db.close();
  }
  return {
    url,
    config,
    db,
    clock,
    ledger,
    logs,
    owner,
    depositor,
    visitor,
    seconds,
    call,
    signIn,
    post,
    say,
    messages,
    hide,
    close,
  };
}
// A JSON-RPC node on loopback, for what only shows over HTTP: status codes,
// error objects as nodes word them, the size of a reply, a reply that never
// comes. `answer` decides the reply to each eth_call: a JSON-RPC reply with
// `result` or `error`, or `body` as the whole reply, or with `act` no reply
// at all, one that stops half way, a dropped connection, or a return value
// that never ends.
export type NodeCall = {
  to: Address;
  data: Hex;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  // Bytes the node had written to the connection when the exchange ended.
  written: number;
};
export type NodeAnswer = {
  status?: number;
  headers?: Record<string, string>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  body?: string;
  type?: string;
  act?: "silent" | "stall" | "reset" | "endless";
};
export async function startNode(
  t: { after(fn: () => unknown): void },
  answer: (call: NodeCall) => NodeAnswer,
  chain: unknown = "0x3e7",
) {
  const calls: NodeCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const reply = (payload: object, status = 200, headers = {}) =>
        res
          .writeHead(status, { "Content-Type": "application/json", ...headers })
          .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }));
      if (body.method === "eth_chainId") return void reply({ result: chain });
      assert.equal(body.method, "eth_call");
      const [{ to, data }] = body.params as [{ to: Address; data: Hex }];
      const before = req.socket.bytesWritten;
      const call: NodeCall = {
        to: to.toLowerCase() as Address,
        data,
        path: req.url ?? "",
        headers: req.headers,
        body,
        written: 0,
      };
      res.on("close", () => {
        call.written = req.socket.bytesWritten - before;
      });
      calls.push(call);
      const said = answer(call);
      if (said.act === "silent") return;
      if (said.act === "reset") return void req.socket.destroy();
      if (said.act === "stall" || said.act === "endless") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(`{"jsonrpc":"2.0","id":${body.id},"result":"0x`);
        // Writes for as long as the other side keeps reading.
        const pump = () => {
          while (!res.destroyed && res.write("00".repeat(16 * 1024)));
          if (!res.destroyed) res.once("drain", pump);
        };
        return void (said.act === "endless" && pump());
      }
      if (said.body !== undefined)
        return void res
          .writeHead(said.status ?? 200, {
            "Content-Type": said.type ?? "text/plain",
            ...said.headers,
          })
          .end(said.body);
      reply(
        said.error ? { error: said.error } : { result: said.result },
        said.status,
        said.headers,
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, calls };
}
// Waits for something another part of the test is about to bring about, and
// fails instead of waiting for ever when it does not come.
export async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 5) {
    if (waited >= 2_000) throw new Error("waited two seconds in vain");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
// The body must be the code and nothing else: no message, no stack.
export function refused(reply: Reply, code: ErrorCode) {
  assert.deepEqual(
    { status: reply.status, body: reply.body },
    { status: statuses[code], body: { error: code } },
  );
}
