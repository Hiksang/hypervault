import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  toFunctionSelector,
  type Address,
} from "viem";
import { rpcChain } from "../src/chain.ts";
import { jsonRpc } from "../src/rpc.ts";
import {
  factory,
  refused,
  startChat,
  startNode,
  until,
  vault,
} from "./helpers.ts";
// A vault is a proxy that its owner can point at other code, and the Factory
// goes on reporting it as a vault. So whatever a vault answers, down to the
// text of a revert, is chosen by a possible attacker. This node plays such a
// vault over HTTP on loopback, behind the service's own RPC client; nothing
// leaves the machine.
const abi = parseAbi([
  "function isVault(address) view returns (bool)",
  "function owner() view returns (address)",
  "error Error(string)",
]);
const operator = `0x${"0e".repeat(20)}` as Address;
async function hostileVault(
  t: { after(fn: () => unknown): void },
  reason: string,
  reverting: "every read" | "balance",
) {
  const calls = { factory: 0, vault: 0 };
  const { url } = await startNode(t, ({ to, data }) => {
    if (to === factory) {
      calls.factory += 1;
      return {
        result: encodeFunctionResult({
          abi,
          functionName: "isVault",
          result: true,
        }),
      };
    }
    calls.vault += 1;
    const asksOwner = data.startsWith(toFunctionSelector("function owner()"));
    if (reverting === "balance" && asksOwner)
      return {
        result: encodeFunctionResult({
          abi,
          functionName: "owner",
          result: operator,
        }),
      };
    // How a node such as geth answers Solidity's revert("..."): the reason
    // in the message, and encoded in the data.
    return {
      error: {
        code: 3,
        message: `execution reverted: ${reason}`,
        data: encodeErrorResult({ abi, errorName: "Error", args: [reason] }),
      },
    };
  });
  return {
    calls,
    chain: rpcChain({ chainId: 999, factory, rpc: jsonRpc(url) }),
  };
}
const account = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
// The three balance reads go out together and the first to fail answers the
// request: this gives the other two time to reach the node and be counted.
const settled = () => new Promise((done) => setTimeout(done, 50));
// The part of a log line that quotes the error, with the quotes taken off.
const quoted = (line: string) =>
  JSON.parse(/: (".*")$/.exec(line)?.[1] ?? '""') as string;
test("a revert reason cannot forge a log entry or reach the response", async (t) => {
  const forged =
    'x\n2026-10-05T00:00:00Z chat: admin 0xattacker signed in from 10.0.0.1\n\u001b[2J\u001b[31mALERT" (99 left out) "';
  const node = await hostileVault(t, forged, "every read");
  const chat = await startChat({}, { chain: node.chain });
  t.after(chat.close);
  refused(
    await chat.call("GET", `/vaults/${vault}/role?address=${account(1)}`),
    "CHAIN_UNAVAILABLE",
  );
  assert.equal(chat.logs.length, 1);
  const [line = ""] = chat.logs;
  // One printable line, and all of the vault's words inside one pair of
  // quotes: none of them can pass for the log's own.
  assert.match(line, /^[\x20-\x7e]+$/);
  assert.ok(line.startsWith(`vault read failed (${vault}): "`));
  assert.equal(
    quoted(line),
    'execution reverted: x 2026-10-05T00:00:00Z chat: admin 0xattacker signed in from 10.0.0.1 ?[2J?[31mALERT" (99 left out) "',
  );
});
test("a megabyte of revert reason costs one read and one short line each pause, however it is asked for", async (t) => {
  const node = await hostileVault(t, "A".repeat(1_000_000), "every read");
  const chat = await startChat({}, { chain: node.chain });
  t.after(chat.close);
  const ask = (i: number) =>
    chat.call("GET", `/vaults/${vault}/role?address=${account(i)}`);
  for (let i = 0; i < 20; i++) refused(await ask(i), "CHAIN_UNAVAILABLE");
  assert.deepEqual(node.calls, { factory: 1, vault: 1 });
  assert.equal(chat.logs.length, 1);
  assert.ok((chat.logs[0] ?? "").length <= 270);
  // Asking for the same wallet again is no different.
  for (let i = 0; i < 5; i++) refused(await ask(0), "CHAIN_UNAVAILABLE");
  assert.deepEqual(node.calls, { factory: 1, vault: 1 });
  // After the pause forty requests sent together still cost one read.
  chat.clock.ms += 5_000;
  const together = await Promise.all(
    Array.from({ length: 40 }, (_, i) => ask(100 + i)),
  );
  for (const reply of together) refused(reply, "CHAIN_UNAVAILABLE");
  assert.deepEqual(node.calls, { factory: 1, vault: 2 });
  assert.equal(chat.logs.length, 2);
  assert.ok(chat.logs.join("").length <= 540);
});
test("a vault whose balance reads revert is asked once per pause, and its owner is still known", async (t) => {
  const node = await hostileVault(t, "no\nbalance\nfor you", "balance");
  const chat = await startChat({}, { chain: node.chain });
  t.after(chat.close);
  const ask = (address: string) =>
    chat.call("GET", `/vaults/${vault}/role?address=${address}`);
  for (let i = 0; i < 20; i++)
    refused(await ask(account(i)), "CHAIN_UNAVAILABLE");
  // owner() once, then balanceOf, controllerRequest and maxRedeem together.
  await settled();
  assert.deepEqual(node.calls, { factory: 1, vault: 4 });
  assert.equal(chat.logs.length, 1);
  assert.match(chat.logs[0] ?? "", /^[\x20-\x7e]+$/);
  // The owner is decided by owner() alone, which this vault does answer.
  assert.deepEqual((await ask(operator)).body, {
    role: "owner",
    canPost: true,
  });
  assert.deepEqual(node.calls, { factory: 1, vault: 4 });
  // After the pause, forty wallets asked about together cost one more
  // balance read (three calls), not forty.
  chat.clock.ms += 5_000;
  const together = await Promise.all(
    Array.from({ length: 40 }, (_, i) => ask(account(100 + i))),
  );
  for (const reply of together) refused(reply, "CHAIN_UNAVAILABLE");
  await settled();
  assert.deepEqual(node.calls, { factory: 1, vault: 7 });
  assert.equal(chat.logs.length, 2);
});
test("a vault that fails one balance read at once and never answers the others has no more calls out than its reads allow", async (t) => {
  // owner() answers, balanceOf halts as the public RPC words a halt, and
  // the other two calls are never answered.
  const selector = (name: string) =>
    toFunctionSelector(`function ${name}(address)`);
  const seen = { owner: 0, halting: 0, silent: 0 };
  const { url } = await startNode(t, ({ to, data }) => {
    if (to === factory)
      return {
        result: encodeFunctionResult({
          abi,
          functionName: "isVault",
          result: true,
        }),
      };
    if (data.startsWith(toFunctionSelector("function owner()"))) {
      seen.owner += 1;
      return {
        result: encodeFunctionResult({
          abi,
          functionName: "owner",
          result: operator,
        }),
      };
    }
    if (data.startsWith(selector("balanceOf"))) {
      seen.halting += 1;
      return {
        error: { code: -32003, message: "EVM error: InvalidFEOpcode" },
      };
    }
    seen.silent += 1;
    return { act: "silent" };
  });
  // A call is given up after a second here instead of four.
  const chain = rpcChain({ chainId: 999, factory, rpc: jsonRpc(url, 1_000) });
  const chat = await startChat({}, { chain });
  t.after(chat.close);
  const ask = (i: number) =>
    chat.call("GET", `/vaults/${vault}/role?address=${account(i)}`);
  // Six requests, each for another wallet, are read: the failed call of
  // each has been answered, and its two unanswered ones are still out.
  const first = Array.from({ length: 6 }, (_, i) => ask(i));
  await until(() => seen.halting === 6 && seen.silent === 12);
  await settled();
  // So those six reads have not ended, and twenty-four requests more are
  // sent nowhere: the node has twelve calls open and gets no others.
  const later = await Promise.all(
    Array.from({ length: 24 }, (_, i) => ask(6 + i)),
  );
  for (const reply of later) refused(reply, "CHAIN_BUSY");
  assert.deepEqual(seen, { owner: 1, halting: 6, silent: 12 });
  // The six end when their calls are given up.
  for (const reply of await Promise.all(first))
    refused(reply, "CHAIN_UNAVAILABLE");
  assert.deepEqual(seen, { owner: 1, halting: 6, silent: 12 });
  // The failure is the RPC's kind, so one line for the vault and no pause.
  assert.equal(chat.logs.length, 1);
  assert.match(chat.logs[0] ?? "", /^chain read failed \(0x[0-9a-f]{40}\): "/);
});
