import { test } from "node:test";
import assert from "node:assert/strict";
import { addChainParams, ensureChain, isUnknownChain } from "./network.ts";

function wallet(start: string, known: string[]) {
  let chain = start;
  const calls: string[] = [];
  const request = async ({
    method,
    params,
  }: {
    method: string;
    params?: unknown[];
  }) => {
    calls.push(method);
    if (method === "eth_chainId") return chain;
    if (method === "wallet_switchEthereumChain") {
      const id = (params![0] as { chainId: string }).chainId;
      if (!known.includes(id))
        throw Object.assign(new Error("unknown"), { code: 4902 });
      chain = id;
      return null;
    }
    if (method === "wallet_addEthereumChain") {
      known.push((params![0] as { chainId: string }).chainId);
      return null;
    }
    throw new Error(method);
  };
  return { request, calls, chain: () => chain };
}

test("already on the chain: nothing is asked", async () => {
  const w = wallet("0x3e7", ["0x3e7"]);
  assert.equal(await ensureChain(w.request, 999), false);
  assert.deepEqual(w.calls, ["eth_chainId"]);
});

test("known chain: one switch", async () => {
  const w = wallet("0x1", ["0x1", "0x3e7"]);
  assert.equal(await ensureChain(w.request, 999), true);
  assert.equal(w.chain(), "0x3e7");
  assert.ok(!w.calls.includes("wallet_addEthereumChain"));
});

test("unknown chain: add, then switch", async () => {
  const w = wallet("0x1", ["0x1"]);
  assert.equal(await ensureChain(w.request, 999), true);
  assert.equal(w.chain(), "0x3e7");
  assert.deepEqual(
    w.calls.filter((c) => c.startsWith("wallet_")),
    [
      "wallet_switchEthereumChain",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ],
  );
});

test("a refusal (4001) is not turned into an add", async () => {
  const request = async ({ method }: { method: string }) => {
    if (method === "eth_chainId") return "0x1";
    throw Object.assign(new Error("User rejected"), { code: 4001 });
  };
  await assert.rejects(ensureChain(request, 999), /User rejected/);
});

test("4902 is recognised directly or wrapped (MetaMask mobile)", () => {
  assert.ok(isUnknownChain({ code: 4902 }));
  assert.ok(isUnknownChain({ data: { originalError: { code: 4902 } } }));
  assert.ok(!isUnknownChain({ code: 4001 }));
  assert.ok(!isUnknownChain(null));
});

test("add parameters use the public RPC and the explorer", () => {
  const p = addChainParams(999, "https://proxy.example/evm");
  assert.equal(p.chainId, "0x3e7");
  assert.deepEqual(p.rpcUrls, ["https://rpc.hyperliquid.xyz/evm"]);
  assert.deepEqual(p.blockExplorerUrls, ["https://hyperevmscan.io"]);
});
