import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { rpcChain, VaultFault } from "../src/chain.ts";
import { CallFailed, jsonRpc, type Rpc } from "../src/rpc.ts";
import { startNode, stranger, vault } from "./helpers.ts";
// The fake node speaks the ABI the frontend exports from the contracts, so a
// signature the server gets wrong, or one the contracts later change, fails
// here instead of on a live chain.
const abi = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../frontend/src/abi/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Abi;
const factoryAbi = abi("ManagedUsdcVaultFactory");
const vaultAbi = abi("ManagedUsdcVault");
const factory = `0x${"f0".repeat(20)}` as Address;
const owner = `0x${"0e".repeat(20)}` as Address;
type Account = {
  balanceOf: bigint;
  controllerRequest: bigint;
  maxRedeem: bigint;
};
// What the node does instead of answering, for the contract it is set on.
type Trouble = { at: Address; fails?: unknown; returns?: Hex };
function node(chainId = 999) {
  const state = {
    chainId,
    down: false,
    asked: [] as string[],
    accounts: new Map<Address, Partial<Account>>(),
    trouble: undefined as Trouble | undefined,
  };
  function answer(to: Address, data: Hex): Hex {
    if (to === factory) {
      const call = decodeFunctionData({ abi: factoryAbi, data });
      assert.equal(call.functionName, "isVault");
      return encodeFunctionResult({
        abi: factoryAbi,
        functionName: "isVault",
        result: String(call.args?.[0]).toLowerCase() === vault,
      });
    }
    // An address without code answers with no data.
    if (to !== vault) return "0x";
    const { functionName, args } = decodeFunctionData({ abi: vaultAbi, data });
    if (functionName === "owner")
      return encodeFunctionResult({
        abi: vaultAbi,
        functionName,
        result: owner,
      });
    const account = String(args?.[0]).toLowerCase() as Address;
    const amount =
      state.accounts.get(account)?.[functionName as keyof Account] ?? 0n;
    return encodeFunctionResult({
      abi: vaultAbi,
      functionName,
      result: amount,
    });
  }
  const rpc: Rpc = {
    async chainId() {
      state.asked.push("chainId");
      if (state.down) throw new Error("connection refused");
      return state.chainId;
    },
    async call(to, data) {
      state.asked.push("call");
      if (state.down) throw new Error("connection refused");
      const { trouble } = state;
      if (trouble?.at === to && trouble.fails !== undefined)
        throw trouble.fails;
      if (trouble?.at === to && trouble.returns) return trouble.returns;
      return answer(to.toLowerCase() as Address, data);
    },
  };
  return { state, chain: rpcChain({ chainId: 999, factory, rpc }) };
}
test("isVault asks the configured Factory", async () => {
  const { chain } = node();
  assert.equal(await chain.isVault(vault), true);
  assert.equal(await chain.isVault(stranger), false);
});
test("ownerOf reads the vault's owner", async () => {
  const { chain } = node();
  assert.equal((await chain.ownerOf(vault)).toLowerCase(), owner);
});
test("a depositor holds shares, an open redeem request or claimable shares", async () => {
  const { state, chain } = node();
  assert.equal(await chain.isDepositor(vault, stranger), false);
  for (const holding of [
    { balanceOf: 1n },
    { controllerRequest: 7n },
    { maxRedeem: 1n },
    { balanceOf: 5n, controllerRequest: 2n, maxRedeem: 3n },
  ]) {
    state.accounts.set(stranger, holding);
    assert.equal(
      await chain.isDepositor(vault, stranger),
      true,
      Object.keys(holding).join(),
    );
  }
  state.accounts.set(stranger, {});
  assert.equal(await chain.isDepositor(vault, stranger), false);
});
test("an RPC on another chain is refused before any contract read", async () => {
  const { state, chain } = node(998);
  for (const read of [
    () => chain.isVault(vault),
    () => chain.ownerOf(vault),
    () => chain.isDepositor(vault, stranger),
  ])
    await assert.rejects(read, /RPC chain id does not match CHAIN_ID/);
  assert.deepEqual(new Set(state.asked), new Set(["chainId"]));
});
test("the chain id is proven once and reused", async () => {
  const { state, chain } = node();
  await chain.isVault(vault);
  await chain.ownerOf(vault);
  await chain.isDepositor(vault, stranger);
  assert.equal(state.asked.filter((what) => what === "chainId").length, 1);
  assert.equal(state.asked.filter((what) => what === "call").length, 5);
});
test("a failed read rejects and leaves nothing behind", async () => {
  const { state, chain } = node();
  state.down = true;
  await assert.rejects(chain.isVault(vault));
  await assert.rejects(chain.ownerOf(vault));
  await assert.rejects(chain.isDepositor(vault, stranger));
  state.down = false;
  assert.equal(await chain.isVault(vault), true);
  state.accounts.set(stranger, { balanceOf: 1n });
  state.down = true;
  await assert.rejects(chain.isDepositor(vault, stranger));
});
test("a read is the vault's failure when the node says the call failed there, or when the vault's bytes are not an answer", async () => {
  const { state, chain } = node();
  const reads = [
    () => chain.ownerOf(vault),
    () => chain.isDepositor(vault, stranger),
  ];
  // The node's word that the call failed, with what it said kept for the log.
  state.trouble = { at: vault, fails: new CallFailed("execution reverted: x") };
  for (const read of reads)
    await assert.rejects(
      read,
      (thrown) =>
        thrown instanceof VaultFault &&
        thrown.cause === "execution reverted: x",
    );
  // Nothing, too little, or one byte short of a word.
  for (const returns of ["0x", "0x1234", `0x${"00".repeat(31)}`] as const) {
    state.trouble = { at: vault, returns };
    for (const read of reads) await assert.rejects(read, VaultFault, returns);
  }
  // A whole word is an answer, whatever follows it.
  state.trouble = {
    at: vault,
    returns: `0x${"00".repeat(31)}01${"ff".repeat(9)}`,
  };
  assert.equal(await chain.isDepositor(vault, stranger), true);
  assert.equal(
    await chain.ownerOf(vault),
    "0x0000000000000000000000000000000000000001",
  );
  // An address without code returns nothing: a failure, not an empty answer.
  state.trouble = undefined;
  await assert.rejects(chain.ownerOf(stranger), VaultFault);
  await assert.rejects(chain.isDepositor(stranger, vault), VaultFault);
});
test("a depositor read ends when its three calls have, and reports the vault's failure before the RPC's", async () => {
  // A node that answers each of the three calls when the test says so.
  const names = ["balanceOf", "controllerRequest", "maxRedeem"];
  const open = new Map<
    string,
    { answer(held: bigint): void; fail(reason: unknown): void }
  >();
  const rpc: Rpc = {
    chainId: async () => 999,
    call: (_, data) =>
      new Promise((resolve, reject) => {
        const { functionName } = decodeFunctionData({ abi: vaultAbi, data });
        open.set(functionName, {
          answer: (held) =>
            resolve(
              encodeFunctionResult({
                abi: vaultAbi,
                functionName,
                result: held,
              }),
            ),
          fail: reject,
        });
      }),
  };
  const chain = rpcChain({ chainId: 999, factory, rpc });
  const tick = () => new Promise((done) => setImmediate(done));
  async function started() {
    open.clear();
    const state = { ended: false };
    const read = chain
      .isDepositor(vault, stranger)
      .then(
        (held): unknown => held,
        (reason: unknown) => reason,
      )
      .finally(() => {
        state.ended = true;
      });
    await tick();
    assert.deepEqual([...open.keys()].sort(), names);
    return { read, state };
  }
  // One call fails at once while two are still out: the read goes on, or
  // whoever counts reads in flight would not count those two.
  const rpcDown = new Error("the RPC answered HTTP 429");
  const first = await started();
  open.get("balanceOf")?.fail(rpcDown);
  await tick();
  assert.equal(first.state.ended, false);
  open.get("controllerRequest")?.fail(new CallFailed("execution reverted"));
  await tick();
  assert.equal(first.state.ended, false);
  // The last call ends it. The failure is the vault's, though the RPC's
  // came first and this answer alone would have meant a deposit.
  open.get("maxRedeem")?.answer(1n);
  assert.ok((await first.read) instanceof VaultFault);
  // Without a failure of the vault's, the RPC's is passed on as it came.
  const second = await started();
  open.get("maxRedeem")?.fail(rpcDown);
  await tick();
  assert.equal(second.state.ended, false);
  open.get("balanceOf")?.answer(0n);
  open.get("controllerRequest")?.answer(5n);
  assert.equal(await second.read, rpcDown);
  // And with no failure the three answers decide.
  const third = await started();
  for (const name of names)
    open.get(name)?.answer(name === "maxRedeem" ? 1n : 0n);
  assert.equal(await third.read, true);
});
test("any other failed read is not the vault's, and is passed on as it came", async () => {
  const { state, chain } = node();
  // The RPC's own failures.
  for (const fails of [
    new Error("the RPC answered HTTP 429"),
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
    "not even an error",
  ]) {
    state.trouble = { at: vault, fails };
    for (const read of [
      () => chain.ownerOf(vault),
      () => chain.isDepositor(vault, stranger),
    ])
      await assert.rejects(read, (thrown) => thrown === fails);
  }
  // The Factory is not a vault: its failures are held against none.
  for (const trouble of [
    { at: factory, fails: new CallFailed("execution reverted") },
    { at: factory, returns: "0x" },
    { at: factory, returns: "0x1234" },
  ] satisfies Trouble[]) {
    state.trouble = trouble;
    await assert.rejects(
      chain.isVault(vault),
      (thrown) => !(thrown instanceof VaultFault),
    );
  }
  // Nor is a node that fails to say which chain it is on.
  const unproven = rpcChain({
    chainId: 999,
    factory,
    rpc: {
      chainId: () => Promise.reject(new CallFailed("execution reverted")),
      call: () => assert.fail("no call before the chain id is proven"),
    },
  });
  for (const read of [
    () => unproven.isVault(vault),
    () => unproven.ownerOf(vault),
    () => unproven.isDepositor(vault, stranger),
  ])
    await assert.rejects(read, (thrown) => !(thrown instanceof VaultFault));
});
test("a vault cannot make the server fetch a URL of its choosing", async (t) => {
  // A vault is an upgradeable proxy, so its owner can make any read revert
  // with an EIP-3668 OffchainLookup that names URLs for the caller to fetch.
  // The gateway it names here is a node of its own, which counts the visits.
  const gateway = await startNode(t, () => ({ result: "0x" }));
  const offchainLookup = encodeErrorResult({
    abi: parseAbi([
      "error OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)",
    ]),
    errorName: "OffchainLookup",
    args: [vault, [`${gateway.url}/{sender}/{data}`], "0x", "0x00000000", "0x"],
  });
  // Every URL the process fetches while the reads run.
  const visits: string[] = [];
  const send = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (...args: Parameters<typeof fetch>) => {
    visits.push(String(args[0]));
    return send(...args);
  });
  const { url, calls } = await startNode(t, ({ to }) =>
    to === factory
      ? {
          result: encodeFunctionResult({
            abi: factoryAbi,
            functionName: "isVault",
            result: true,
          }),
        }
      : {
          error: {
            code: 3,
            message: "execution reverted",
            data: offchainLookup,
          },
        },
  );
  const chain = rpcChain({ chainId: 999, factory, rpc: jsonRpc(url) });
  assert.equal(await chain.isVault(vault), true);
  await assert.rejects(chain.ownerOf(vault), VaultFault);
  await assert.rejects(chain.isDepositor(vault, stranger), VaultFault);
  // Time for anything set off by those replies to show.
  await new Promise((done) => setTimeout(done, 50));
  // The chain id, isVault, owner() and the three balance reads, all sent to
  // the configured RPC and nowhere else.
  assert.equal(calls.length, 5);
  assert.equal(visits.length, 6);
  assert.deepEqual(new Set(visits), new Set([`${url}/`]));
  assert.equal(gateway.calls.length, 0);
});
