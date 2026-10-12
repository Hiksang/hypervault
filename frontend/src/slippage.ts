/**
 * Deposit tolerance: a hedged vault's NAV moves by hundredths of a percent between the quote and
 * the transaction, so the exact quote as a minimum would fail most deposits. One percent never
 * binds in normal operation and still stops a deposit after an abnormal move (a liquidation, a
 * bad trade, a wrong price).
 */
export const DEPOSIT_TOLERANCE_BPS = 100n;

/** The fewest shares a deposit quoted at `quoted` may mint. */
export function minShares(quoted: bigint, bps = DEPOSIT_TOLERANCE_BPS): bigint {
  return (quoted * (10_000n - bps)) / 10_000n;
}
