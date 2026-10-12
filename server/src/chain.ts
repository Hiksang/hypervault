import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { CallFailed, type Rpc } from "./rpc.ts";
// Everything the service learns from the chain. A rejected promise means
// "unknown" and callers must not turn it into an answer. Every call has to
// settle, because callers share a read in flight, and must leave nothing out
// at the node when it does, because reads in flight are what is limited.
export type Chain = {
  isVault(vault: Address): Promise<boolean>;
  ownerOf(vault: Address): Promise<Address>;
  isDepositor(vault: Address, account: Address): Promise<boolean>;
};
// The rejection of a read that failed at the vault, on the node's word: the
// call failed in the vault's code, or returned bytes that are not an answer.
// A vault's owner can replace its code, so these can be produced at will and
// repeated for every request. Any other rejection is the RPC's and says
// nothing about the vault.
export class VaultFault extends Error {
  constructor(cause: unknown) {
    super("the vault gave no usable answer", { cause });
  }
}
const factoryAbi = parseAbi(["function isVault(address) view returns (bool)"]);
const vaultAbi = parseAbi([
  "function owner() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function controllerRequest(address) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
]);
// viem's contract reads are not used, for two reasons. A vault is an
// upgradeable proxy whose owner can make a read revert with an EIP-3668
// OffchainLookup, and viem would then fetch the URLs it names: this service
// must never fetch a URL chosen by a contract. And viem reports a node's
// internal error as a revert, which would be held against the vault.
export function rpcChain(options: {
  chainId: number;
  factory: Address;
  rpc: Rpc;
}): Chain {
  const { rpc } = options;
  let verified = false;
  // A factory at the same address on another network would hand out that
  // network's owners and depositors, so the RPC must prove its chain first.
  async function ready() {
    if (verified) return;
    if ((await rpc.chainId()) !== options.chainId)
      throw new Error("RPC chain id does not match CHAIN_ID");
    verified = true;
  }
  async function askVault<T>(
    vault: Address,
    data: Hex,
    decode: (returned: Hex) => T,
  ): Promise<T> {
    await ready();
    const returned = await rpc.call(vault, data).catch((error: unknown) => {
      throw error instanceof CallFailed ? new VaultFault(error.message) : error;
    });
    try {
      return decode(returned);
    } catch {
      throw new VaultFault(
        `returned ${(returned.length - 2) / 2} bytes that are not an answer`,
      );
    }
  }
  const amount = (
    functionName: "balanceOf" | "controllerRequest" | "maxRedeem",
    vault: Address,
    account: Address,
  ) =>
    askVault(
      vault,
      encodeFunctionData({ abi: vaultAbi, functionName, args: [account] }),
      (data) => decodeFunctionResult({ abi: vaultAbi, functionName, data }),
    );
  return {
    // The Factory is not a vault: a failure there is held against none.
    async isVault(vault) {
      await ready();
      const data = await rpc.call(
        options.factory,
        encodeFunctionData({
          abi: factoryAbi,
          functionName: "isVault",
          args: [vault],
        }),
      );
      return decodeFunctionResult({
        abi: factoryAbi,
        functionName: "isVault",
        data,
      });
    },
    ownerOf(vault) {
      return askVault(
        vault,
        encodeFunctionData({ abi: vaultAbi, functionName: "owner" }),
        (data) =>
          decodeFunctionResult({ abi: vaultAbi, functionName: "owner", data }),
      );
    },
    // Shares in escrow for a redeem request leave balanceOf, so an open or
    // claimable request still counts as a deposit. The read ends when all
    // three calls have: were it to end with the first that failed, the other
    // two would still be out at the node with nobody counting them. Of
    // several failures the vault's own is the one reported.
    async isDepositor(vault, account) {
      const calls = await Promise.allSettled([
        amount("balanceOf", vault, account),
        amount("controllerRequest", vault, account),
        amount("maxRedeem", vault, account),
      ]);
      const failures = calls.flatMap((call) =>
        call.status === "rejected" ? [call.reason as unknown] : [],
      );
      if (failures.length)
        throw (
          failures.find((reason) => reason instanceof VaultFault) ?? failures[0]
        );
      return calls.some(
        (call) => call.status === "fulfilled" && call.value > 0n,
      );
    },
  };
}
