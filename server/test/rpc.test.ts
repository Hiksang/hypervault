import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { encodeErrorResult, parseAbi, type Hex } from "viem";
import { describe } from "../src/log.ts";
import { CallFailed, jsonRpc, type Rpc } from "../src/rpc.ts";
import { startNode, vault, type NodeAnswer } from "./helpers.ts";
// owner(), and the address a vault answers it with.
const data: Hex = "0x8da5cb5b";
const owner: Hex = `0x${"0e".repeat(20).padStart(64, "0")}`;
const revertData = encodeErrorResult({
  abi: parseAbi(["error Error(string)"]),
  errorName: "Error",
  args: ["nope"],
});
const error = (
  code: number,
  message: string,
  data?: unknown,
  status?: number,
): NodeAnswer => ({
  error: { code, message, ...(data !== undefined && { data }) },
  ...(status !== undefined && { status }),
});
// A node whose next answer the test sets, and a client pointed at it.
async function node(t: { after(fn: () => unknown): void }, timeout?: number) {
  const state: { answer: NodeAnswer } = { answer: { result: owner } };
  const { url, port, calls } = await startNode(t, () => state.answer);
  return { state, calls, port, rpc: jsonRpc(url, timeout) };
}
// Whose failure a rejected call is: the contract's, or the RPC's.
const whose = (rpc: Rpc) =>
  rpc.call(vault, data).then(
    () => assert.fail("the call should fail"),
    (thrown: unknown) => (thrown instanceof CallFailed ? "contract" : "rpc"),
  );
test("a call is one JSON-RPC request and resolves to what the contract returned", async (t) => {
  const { state, calls, rpc } = await node(t);
  assert.equal(await rpc.call(vault, data), owner);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.body, {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: vault, data }, "latest"],
  });
  assert.equal(calls[0]?.headers["content-type"], "application/json");
  // A contract that returns nothing is an answer of no bytes, not a failure.
  state.answer = { result: "0x" };
  assert.equal(await rpc.call(vault, data), "0x");
  assert.equal(await rpc.chainId(), 999);
});
test("the chain id has to be a hex number", async (t) => {
  for (const [said, id] of [
    ["0x3e7", 999],
    ["0x7a69", 31337],
  ] as const) {
    const { url } = await startNode(t, () => ({}), said);
    assert.equal(await jsonRpc(url).chainId(), id);
  }
  for (const said of [999, "999", null, { id: 999 }]) {
    const { url } = await startNode(t, () => ({}), said);
    await assert.rejects(jsonRpc(url).chainId(), JSON.stringify(said));
  }
});
test("a call that failed in the contract is told apart from one the RPC failed", async (t) => {
  const { state, rpc } = await node(t);
  const outcome = (answer: NodeAnswer) => {
    state.answer = answer;
    return whose(rpc);
  };
  // The contract's doing: the node's code for a revert, whatever comes with
  // it and whatever the HTTP status.
  for (const answer of [
    error(3, "execution reverted"),
    error(3, "execution reverted: nope", revertData),
    error(3, "execution reverted", "0x"),
    error(3, "no"),
    error(3, "execution reverted", revertData, 500),
  ])
    assert.equal(await outcome(answer), "contract", JSON.stringify(answer));
  // The RPC's doing: it refused, limited or broke, or sent no result. None
  // of it is the contract's fault, and an outsider can provoke some of it.
  for (const answer of [
    { status: 429, body: "Too Many Requests" },
    error(-32005, "rate limited", undefined, 429),
    error(-32005, "project ID request rate exceeded", {
      see: "https://infura.io/dashboard",
      rate: { backoff_seconds: 30 },
    }),
    error(429, "Your app has exceeded its compute units per second capacity."),
    error(-32007, "50/second request limit reached - reduce calls per second"),
    error(-32603, "Internal error"),
    error(-32000, "header not found"),
    error(
      -32000,
      "missing trie node 5f3a (path ) state 0xabc is not available",
    ),
    error(-32002, "resource unavailable"),
    error(-32000, "execution aborted (timeout = 5s)"),
    // An error is not the contract's for what it says or carries: a rate
    // limiter or a proxy words its refusals as it likes.
    error(-32005, "rate limited", "0x01"),
    error(-32005, "VM execution error: too many requests"),
    error(-32603, "execution reverted", revertData),
    error(-32000, "execution reverted", revertData),
    error(-32000, "out of gas"),
    error(-32000, "invalid opcode: INVALID"),
    error(-32003, "EVM error: InvalidFEOpcode"),
    error(-32015, "VM execution error.", `Reverted ${revertData}`),
    error(
      -32603,
      "Error: VM Exception while processing transaction: reverted with reason string 'nope'",
      { message: "reverted with reason string 'nope'", data: revertData },
    ),
    // Nor for a code that only looks like the revert code.
    error(-3, "execution reverted", revertData),
    error(30, "execution reverted", revertData),
    {
      body: '{"jsonrpc":"2.0","id":1,"error":{"code":"3","message":"execution reverted"}}',
      type: "application/json",
    },
    {
      body: '{"jsonrpc":"2.0","id":1,"error":[3,"execution reverted"]}',
      type: "application/json",
    },
    { status: 500, body: "oops" },
    { status: 502, body: "<html>bad gateway</html>", type: "text/html" },
    { body: "<html>not json</html>", type: "text/html" },
    { act: "reset" },
    // No result at all, which is not the same as a result of no bytes.
    { result: null },
    {},
    { body: "" },
    { body: "{}", type: "application/json" },
    { body: "[]", type: "application/json" },
    { body: "null", type: "application/json" },
    { body: '{"error":"boom"}', type: "application/json" },
    // A result that is not bytes, or one sent with an HTTP error status.
    { result: 7 },
    { result: "owner" },
    { result: ["0x"] },
    { result: owner, status: 500 },
  ] satisfies NodeAnswer[])
    assert.equal(await outcome(answer), "rpc", JSON.stringify(answer));
  // The same call is answered again once the node does answer.
  state.answer = { result: owner };
  assert.equal(await rpc.call(vault, data), owner);
});
test("a reply over 8 KB is not read, and counts against the contract only when its start shows the call ran", async (t) => {
  const { state, calls, rpc } = await node(t);
  const outcome = (answer: NodeAnswer) => {
    state.answer = answer;
    return whose(rpc);
  };
  // An address followed by padding is fine while the reply stays small.
  const padded = (bytes: number) => `${owner}${"00".repeat(bytes)}`;
  state.answer = { result: padded(2_000) };
  assert.equal(await rpc.call(vault, data), padded(2_000));
  // The contract's: a return value or a revert far too long to be an
  // answer, judged as a short one is.
  for (const answer of [
    { result: padded(4_100) },
    { result: padded(1_000_000) },
    error(3, `execution reverted: ${"A".repeat(1_000_000)}`, revertData),
    error(3, "no", `0x${"41".repeat(100_000)}`),
  ])
    assert.equal(
      await outcome(answer),
      "contract",
      JSON.stringify(answer).slice(0, 80),
    );
  // The RPC's: the page of whatever stands in front of the node, with any
  // status, or an error of the node's own that happens to be long.
  const page = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>${'<div class="cf-error">rate limited</div>'.repeat(300)}</body></html>`;
  // The same with words in it that a node uses for a failed call.
  const wordy = `<html>EVM error upstream: execution reverted, "code":3, "result":"0x00", "data":"0x08c379a0" ${"x".repeat(20_000)}</html>`;
  for (const answer of [
    { status: 429, body: page, type: "text/html" },
    { status: 503, body: page, type: "text/html" },
    { status: 403, body: page, type: "text/html" },
    { status: 200, body: page, type: "text/html" },
    { status: 502, body: wordy, type: "text/html" },
    { status: 200, body: wordy, type: "application/json" },
    // A long error under any code but the revert's, whatever it says.
    error(-32005, `execution reverted: ${"A".repeat(100_000)}`, revertData),
    error(-32000, "Execution reverted", `0x${"41".repeat(100_000)}`),
    error(-32000, `out of gas: ${"A".repeat(100_000)}`),
    error(-32603, "no", `0x${"41".repeat(100_000)}`),
    // A long result that is not bytes, or one sent with an HTTP error status.
    { result: "z".repeat(20_000) },
    { result: padded(1_000_000), status: 500 },
    error(
      -32603,
      `Internal error: ${"at upstream.handler (proxy.js:1:1) ".repeat(300)}`,
    ),
    error(-32005, "rate limited", { hint: "x".repeat(20_000) }),
  ])
    assert.equal(
      await outcome(answer),
      "rpc",
      JSON.stringify(answer).slice(0, 80),
    );
  // The limit is 8192 bytes of reply, to the byte.
  const sized = (bytes: number) => {
    const around = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" });
    const result = `0x${"0".repeat(bytes - around.length)}`;
    return {
      result,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      type: "application/json",
    };
  };
  state.answer = sized(8 * 1024);
  assert.equal(state.answer.body?.length, 8 * 1024);
  assert.equal(await rpc.call(vault, data), sized(8 * 1024).result);
  assert.equal(await outcome(sized(8 * 1024 + 1)), "contract");
  // Wherever the cut falls in the text of a revert, the reply is still read
  // as what it is: these messages are all escapes of two or six characters.
  for (const filler of ['"', String.fromCharCode(92), String.fromCharCode(0)])
    for (let shift = 0; shift < 6; shift++)
      assert.equal(
        await outcome(
          error(
            3,
            `execution reverted: ${"A".repeat(shift)}${filler.repeat(5_000)}`,
          ),
        ),
        "contract",
        JSON.stringify([filler, shift]),
      );
  // What lies past the limit is never fetched: a return value without end
  // is refused at once, where reading it would last until the time ran out.
  const started = performance.now();
  assert.equal(await outcome({ act: "endless" }), "contract");
  assert.ok(performance.now() - started < 2_000);
  await new Promise((done) => setTimeout(done, 50));
  const written = calls.at(-1)?.written ?? 0;
  assert.ok(written > 8 * 1024 && written < 8 * 1024 * 1024, `${written}`);
});
test("a reply has to arrive in full within the time limit, and running out of it is the RPC's failure", async (t) => {
  const { state, rpc } = await node(t, 300);
  // No reply at all, and one that starts and then stops.
  for (const act of ["silent", "stall"] as const) {
    state.answer = { act };
    const started = performance.now();
    assert.equal(await whose(rpc), "rpc", act);
    const took = performance.now() - started;
    assert.ok(took >= 290 && took < 2_000, `${act}: ${took} ms`);
  }
  state.answer = { result: owner };
  assert.equal(await rpc.call(vault, data), owner);
});
test(
  "left to its own limit a call gives up after four seconds",
  {
    timeout: 15_000,
  },
  async (t) => {
    const { state, rpc } = await node(t);
    state.answer = { act: "silent" };
    const started = performance.now();
    assert.equal(await whose(rpc), "rpc");
    const took = performance.now() - started;
    assert.ok(took >= 3_900 && took < 6_000, `${took} ms`);
  },
);
test("a refusal is not waited on and not asked again, whatever Retry-After says", async (t) => {
  const { state, calls, rpc } = await node(t);
  const started = performance.now();
  for (const answer of [
    { status: 429, body: "slow down", headers: { "Retry-After": "3600" } },
    { status: 503, body: "", headers: { "Retry-After": "3600" } },
    error(-32005, "rate limited", undefined, 429),
    error(-32603, "Internal error"),
    error(3, "execution reverted", revertData),
    { result: null },
  ] satisfies NodeAnswer[]) {
    const before = calls.length;
    state.answer = answer;
    await assert.rejects(rpc.call(vault, data));
    assert.equal(calls.length, before + 1, JSON.stringify(answer));
  }
  assert.ok(performance.now() - started < 2_000);
});
test("a dropped connection is tried once more, and no more than that", async (t) => {
  let drops = 1;
  const { url, calls } = await startNode(t, () =>
    drops-- > 0 ? { act: "reset" } : { result: owner },
  );
  const rpc = jsonRpc(url);
  assert.equal(await rpc.call(vault, data), owner);
  assert.equal(calls.length, 2);
  drops = 5;
  assert.equal(await whose(rpc), "rpc");
  assert.equal(calls.length, 4);
});
test("a node that cannot be reached is logged with the reason, and without its address", async () => {
  // A port nothing listens on: a server is started there and stopped again.
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  const rpc = jsonRpc(`http://127.0.0.1:${port}/evm/SECRET-KEY`);
  const thrown: unknown = await rpc.call(vault, data).then(
    () => assert.fail("the call should fail"),
    (reason: unknown) => reason,
  );
  assert.equal(thrown instanceof CallFailed, false);
  // What roles.ts writes for it.
  const line = describe(thrown, 200);
  assert.match(line, /^"TypeError: fetch failed \[ECONNREFUSED\] at /);
  assert.doesNotMatch(line, new RegExp(`SECRET|127\\.0\\.0\\.1|${port}`));
});
test("credentials in the RPC URL travel in a header, and no error says where the request went", async (t) => {
  const { state, calls, port } = await node(t);
  const rpc = jsonRpc(
    `http://reader:p%40ss%3Aword@127.0.0.1:${port}/evm/SECRET-KEY?token=SECRET-TOKEN`,
    300,
  );
  assert.equal(await rpc.call(vault, data), owner);
  assert.equal(
    calls[0]?.headers.authorization,
    `Basic ${Buffer.from("reader:p@ss:word").toString("base64")}`,
  );
  assert.equal(calls[0]?.path, "/evm/SECRET-KEY?token=SECRET-TOKEN");
  for (const answer of [
    { status: 500, body: "oops" },
    error(-32005, "rate limited"),
    error(3, "execution reverted", revertData),
    { result: null },
    { result: 7 },
    { status: 429, body: "x".repeat(10_000) },
    { result: `0x${"00".repeat(10_000)}` },
    { act: "reset" },
    { act: "silent" },
  ] satisfies NodeAnswer[]) {
    state.answer = answer;
    const thrown: unknown = await rpc.call(vault, data).then(
      () => assert.fail("the call should fail"),
      (reason: unknown) => reason,
    );
    assert.doesNotMatch(
      inspect(thrown, { depth: 8 }),
      /SECRET|reader|p@ss|p%40ss|token=/,
      JSON.stringify(answer).slice(0, 80),
    );
  }
  // Without credentials no Authorization header is sent.
  state.answer = { result: owner };
  await jsonRpc(`http://127.0.0.1:${port}`).call(vault, data);
  assert.equal(calls.at(-1)?.headers.authorization, undefined);
});
