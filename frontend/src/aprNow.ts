import { SNAPSHOT } from "./marketSnapshot.ts";

/** Round-trip trading cost per year on the hedged notional (spot + perp, in and out). */
export const ROUND_TRIP_COST = 0.0023;
/** The performance fee taken from gains. */
export const PERFORMANCE_FEE = 0.1;

/**
 * "Estimated net APR (90d funding)": what the vault earns as it stands at the 90-day average
 * funding (not today's rate), not the target scenario. The hedged
 * share of NAV (short notional / NAV) times the stated funding, less the trading cost, after the
 * fee. Display only; null when the short or the NAV is unknown.
 */
export function estAprNow(
  shortUsd: number | null,
  navUsd: number | null,
  fundingApr: number = SNAPSHOT.hype.funding90d,
  borrowedUsd = 0,
  borrowApr = 0,
): { hedgedShare: number; apr: number } | null {
  if (shortUsd === null || navUsd === null || !(navUsd > 0)) return null;
  const hedgedShare = shortUsd / navUsd;
  // USDC borrowed against the spot (manual borrow in Unified, automatic in PM) costs interest.
  const gross =
    hedgedShare * (fundingApr - ROUND_TRIP_COST) -
    (borrowedUsd / navUsd) * borrowApr;
  return {
    hedgedShare,
    apr: gross > 0 ? gross * (1 - PERFORMANCE_FEE) : gross,
  };
}
