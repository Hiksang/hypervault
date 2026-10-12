import type { Abi, Address } from "viem";
import lensJson from "./abi/HyperVaultLens.json";

export const lensAbi = lensJson as Abi;

/** `HyperVaultLens.Block`: why `redeemNow` would refuse, in the Vault's own order (ADR-041). */
export const LENS_BLOCKS = [
  "None",
  "WrongPhase",
  "InvalidAmount",
  "NavUnavailable",
  "NeedsRecord",
  "ZeroAssets",
  "OverFreeCash",
  "CashDeficit",
] as const;
export type LensBlock = (typeof LENS_BLOCKS)[number];

/** `HyperVaultLens.Account`: everything the account card needs, from one view call. */
export type LensAccount = {
  phase: number;
  navOk: boolean;
  nav: bigint;
  realized: boolean;
  totalSupply: bigint;
  price: bigint;
  feeShares: bigint;
  feeAssets: bigint;
  windowLow: bigint;
  oracleOnly: boolean;
  availableCash: bigint;
  maxDeposit: bigint;
  minimumDeposit: bigint;
  maximumAssets: bigint;
  shares: bigint;
  value: bigint;
  redeemNowShares: bigint;
  redeemNowAssets: bigint;
  redeemNowBlock: number;
  requestId: bigint;
  pendingShares: bigint;
  claimableShares: bigint;
  claimableAssets: bigint;
};

export const blockOf = (n: number): LensBlock =>
  LENS_BLOCKS[n] ?? "NavUnavailable";

/** What the withdraw tab says when the buffer cannot pay this account now. */
export const BLOCK_TEXT: Record<LensBlock, string> = {
  None: "",
  WrongPhase: "No strategy is running: a withdrawal request pays at once.",
  InvalidAmount:
    "You hold no shares, or all of them: the last holder withdraws by request.",
  NavUnavailable:
    "The vault's value cannot be read right now (a Core action may be pending). Try again shortly.",
  NeedsRecord:
    "Instant withdrawal needs a recent share-price record. Anyone can record one.",
  ZeroAssets: "The amount rounds to nothing.",
  OverFreeCash:
    "The buffer cannot pay right now: request a withdrawal instead.",
  CashDeficit:
    "The vault's cash accounting does not hold: withdrawals are refused until it does.",
};

/** The buffer's instant offer to the account, in the shape the withdraw tab already uses. */
export type LensInstant = {
  price: bigint;
  shares: bigint;
  assets: bigint;
  needsRecord: boolean;
  reason: LensBlock;
};

/**
 * Null when there is no instant path in this phase (Idle pays through the request, Exiting
 * through the epoch), as the older read path returned. Otherwise the most the account can take
 * now, with the refusal reason when that is zero.
 */
export function instantFromLens(a: LensAccount): LensInstant | null {
  const reason = blockOf(a.redeemNowBlock);
  if (reason === "WrongPhase") return null;
  return {
    price: a.price,
    shares: a.redeemNowShares,
    assets: a.redeemNowAssets,
    needsRecord: reason === "NeedsRecord",
    reason,
  };
}

/** One `account(vault, user)` read; `read` batches it into the page's Multicall3 aggregate. */
export async function lensAccount(
  read: <T>(
    at: Address,
    fn: string,
    args: readonly unknown[],
    abi: Abi,
  ) => Promise<T>,
  lens: Address,
  vault: Address,
  user: Address,
): Promise<LensAccount> {
  const a = await read<Record<string, unknown>>(
    lens,
    "account",
    [vault, user],
    lensAbi,
  );
  return {
    ...(a as unknown as LensAccount),
    phase: Number(a.phase),
    redeemNowBlock: Number(a.redeemNowBlock),
  };
}
