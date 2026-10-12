/**
 * "Current net yield (annualized)": what the vault's Core account earns at this hour's rates,
 * from HyperCore precompile reads (position, balances, lending, reserve rates) plus the current
 * HYPE funding rate (no precompile exposes funding; the page takes it from the Hyperliquid API
 * and says so). Distinct from "Estimated net APR (90d funding)" and from the target scenario.
 * An hourly rate annualized: it moves every hour and is not a forecast.
 */

export type LendingLeg = {
  /** Token units (not raw). */
  supplied: number;
  borrowed: number;
  /** USD per token unit (1 for USDC; the reserve's oracle price otherwise). */
  px: number;
  /** Yearly rates as fractions (reserve bps / 10,000). */
  supplyRate: number;
  borrowRate: number;
};

export type YieldInput = {
  /** Signed perp size in base units: negative = short. */
  perpSize: number;
  /** Oracle price funding is paid on, USD per base unit. */
  oraclePx: number;
  /** Current hourly funding rate (positive: longs pay shorts). */
  fundingHourly: number;
  lending: LendingLeg[];
  navUsd: number;
  performanceFee: number;
};

export type YieldBreakdown = {
  /** USD per year at the current rates. */
  fundingUsd: number;
  supplyUsd: number;
  borrowUsd: number;
  grossUsd: number;
  feeUsd: number;
  netUsd: number;
  /** Net per year / NAV. */
  apr: number;
  /** Each leg / NAV, before the fee. */
  fundingApr: number;
  supplyApr: number;
  borrowApr: number;
  shortNotionalUsd: number;
};

/**
 * Funding: a short receives size × oracle × rate each hour when the rate is positive and pays
 * when it is negative, so the leg is −size × oracle × hourly × 8,760. Lending: supplied value ×
 * supply rate, less borrowed value × borrow rate. The fee is taken only from a positive total.
 */
export function currentYield(i: YieldInput): YieldBreakdown | null {
  if (!(i.navUsd > 0) || !Number.isFinite(i.oraclePx)) return null;
  const fundingUsd = -i.perpSize * i.oraclePx * i.fundingHourly * 8760;
  const supplyUsd = i.lending.reduce(
    (s, l) => s + l.supplied * l.px * l.supplyRate,
    0,
  );
  const borrowUsd = i.lending.reduce(
    (s, l) => s + l.borrowed * l.px * l.borrowRate,
    0,
  );
  const grossUsd = fundingUsd + supplyUsd - borrowUsd;
  const feeUsd = grossUsd > 0 ? grossUsd * i.performanceFee : 0;
  const netUsd = grossUsd - feeUsd;
  return {
    fundingUsd,
    supplyUsd,
    borrowUsd,
    grossUsd,
    feeUsd,
    netUsd,
    apr: netUsd / i.navUsd,
    fundingApr: fundingUsd / i.navUsd,
    supplyApr: supplyUsd / i.navUsd,
    borrowApr: borrowUsd / i.navUsd,
    shortNotionalUsd: Math.max(-i.perpSize, 0) * i.oraclePx,
  };
}

/** Raw precompile integers to units: perp px has 6 − szDecimals decimals, spot px 8 − szDecimals. */
export const perpPx = (raw: bigint, szDecimals: number) =>
  Number(raw) / 10 ** (6 - szDecimals);
export const spotPx = (raw: bigint, szDecimals: number) =>
  Number(raw) / 10 ** (8 - szDecimals);
export const units = (raw: bigint, decimals: number) =>
  Number(raw) / 10 ** decimals;
