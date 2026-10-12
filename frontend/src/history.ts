import { parseAbi, type Address, type Hash } from "viem";
import { REDEEM_NOW_SELECTOR } from "./instant.ts";

/** The vault events that make up one holder's activity (HyperVaultTypes / IERC7540). */
export const historyEvents = parseAbi([
  "event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)",
  "event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares)",
]);

export type HistoryKind = "Deposit" | "Instant withdraw" | "Request" | "Claim";

export type HistoryItem = {
  kind: HistoryKind;
  /** USDC raw units; null for a request (paid later, at settlement). */
  assets: bigint | null;
  shares: bigint;
  block: bigint;
  tx: Hash;
  logIndex: number;
  /** Unix seconds, once the block time is read. */
  time?: number;
};

/** A decoded log, as viem's getLogs returns it for `historyEvents`. */
export type DecodedLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
};

const same = (a: unknown, b: Address) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * The holder's rows in a batch of vault logs: deposits credited to `user`, withdrawals of
 * `user`'s shares, and requests `user` controls. A withdrawal is a claim until its transaction
 * is shown to be `redeemNow` (`withdrawKind`).
 */
export function decodeHistory(
  logs: DecodedLog[],
  user: Address,
): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const l of logs) {
    if (l.blockNumber === null || l.transactionHash === null) continue; // pending
    const base = {
      block: l.blockNumber,
      tx: l.transactionHash,
      logIndex: l.logIndex ?? 0,
    };
    const a = l.args;
    if (l.eventName === "Deposit" && same(a.owner, user))
      out.push({
        kind: "Deposit",
        assets: a.assets as bigint,
        shares: a.shares as bigint,
        ...base,
      });
    else if (l.eventName === "Withdraw" && same(a.owner, user))
      out.push({
        kind: "Claim",
        assets: a.assets as bigint,
        shares: a.shares as bigint,
        ...base,
      });
    else if (l.eventName === "RedeemRequest" && same(a.controller, user))
      out.push({
        kind: "Request",
        assets: null,
        shares: a.shares as bigint,
        ...base,
      });
  }
  return out;
}

/** A withdrawal paid by `redeemNow` is an instant withdrawal; any other is a claim. */
export function withdrawKind(input: string): HistoryKind {
  return input.slice(2, 10).toLowerCase() === REDEEM_NOW_SELECTOR
    ? "Instant withdraw"
    : "Claim";
}

/** Newest first, then by position in the block. */
export function sortHistory(items: HistoryItem[]): HistoryItem[] {
  return [...items].sort((x, y) =>
    x.block === y.block ? y.logIndex - x.logIndex : x.block > y.block ? -1 : 1,
  );
}

/** Inclusive [from, to] windows of at most `size` blocks, newest window first. */
export function windowsBackward(
  from: bigint,
  to: bigint,
  size: bigint,
): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let hi = to; hi >= from; hi -= size) {
    const lo = hi - size + 1n > from ? hi - size + 1n : from;
    out.push([lo, hi]);
    if (lo === from) break;
  }
  return out;
}

/** The node refused the block range: retry the window in smaller pieces. */
export function isRangeError(e: unknown): boolean {
  const m = String(
    (e as { details?: string; message?: string })?.details ??
      (e as Error)?.message ??
      e,
  );
  return /max block range|block range|-32602|invalid block range/i.test(m);
}

/** The node is shedding load (-32005 "rate limited"): wait and ask again. */
export function isRateLimit(e: unknown): boolean {
  // viem wraps the node's error (UnknownRpcError → RpcRequestError): look down the whole chain.
  for (
    let x = e as Record<string, unknown> | undefined, n = 0;
    x && n < 6;
    n++
  ) {
    const text = `${x.details ?? ""} ${x.shortMessage ?? ""} ${x.message ?? ""}`;
    if (x.code === -32005 || /rate limit/i.test(text)) return true;
    x = x.cause as Record<string, unknown> | undefined;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One window, retried with backoff while the node rate-limits (the public node: ~100/min/IP). */
export async function withBackoff<T>(
  work: () => Promise<T>,
  waits = [2000, 5000, 10000, 20000],
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await work();
    } catch (e) {
      if (!isRateLimit(e) || i >= waits.length) throw e;
      await sleep(waits[i]!);
    }
  }
}

/** The public node allows 1,000 blocks per eth_getLogs (measured 2026-10-13). */
export const MAX_RANGE = 1000n;

export type Fetch = (from: bigint, to: bigint) => Promise<DecodedLog[]>;

/**
 * Logs of [from, to], split into windows the node accepts. A refused window is halved until it
 * passes (down to one block, then the error is real and thrown).
 */
export async function fetchRange(
  fetch: Fetch,
  from: bigint,
  to: bigint,
  size: bigint = MAX_RANGE,
  waits: number[] = [2000, 5000, 10000, 20000],
): Promise<DecodedLog[]> {
  const logs: DecodedLog[] = [];
  for (const [lo, hi] of windowsBackward(from, to, size)) {
    try {
      logs.push(...(await withBackoff(() => fetch(lo, hi), waits)));
    } catch (e) {
      if (!isRangeError(e) || hi === lo) throw e;
      logs.push(
        ...(await fetchRange(fetch, lo, hi, (hi - lo + 1n) / 2n || 1n)),
      );
    }
  }
  return logs;
}
