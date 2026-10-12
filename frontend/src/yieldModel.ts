/**
 * Illustrative yield arithmetic for the user docs. Inputs are dated market observations, not
 * forecasts: funding changes every hour and is sometimes negative.
 */

/** Hyperliquid base-tier taker fees (docs: trading/fees, tier 0). */
export const TAKER = { perp: 0.00045, spot: 0.0007 } as const;

export type CarryInput = {
  /** Vault NAV in USDC. */
  nav: number;
  /** Short leverage on the perp leg: margin = spot / leverage. */
  leverage: number;
  /** Fraction of NAV kept as EVM cash for withdrawals. */
  buffer: number;
  /** Annualized funding the short receives (negative = it pays). */
  fundingApr: number;
  /** Times per year both legs are opened and closed. */
  roundTripsPerYear: number;
  /** Performance fee on gains above the high-water mark, as a fraction. */
  performanceFee: number;
  /**
   * Portfolio Margin: spot HYPE is the short's collateral, so no separate USDC margin is held
   * and everything but the buffer is hedged. Requires a Core account above the PM minimum.
   */
  portfolioMargin?: boolean;
};

export type CarryResult = {
  /** USDC in spot HYPE, equal to the short notional. */
  hedged: number;
  margin: number;
  buffer: number;
  funding: number;
  tradingCost: number;
  fee: number;
  net: number;
  netApr: number;
};

/**
 * USDC delta-neutral carry: buy spot, short the same size on the perp, keep a cash buffer.
 * spot + spot / leverage + buffer = NAV (spot + buffer = NAV under Portfolio Margin). Funding accrues on the hedged notional; each round
 * trip pays spot and perp taker fees on entry and exit. The fee is charged only on a gain.
 */
export function usdcCarry(i: CarryInput): CarryResult {
  const buffer = i.nav * i.buffer;
  const hedged = i.portfolioMargin
    ? i.nav - buffer
    : (i.nav - buffer) / (1 + 1 / i.leverage);
  const margin = i.portfolioMargin ? 0 : hedged / i.leverage;
  const funding = hedged * i.fundingApr;
  const tradingCost =
    hedged * (TAKER.spot + TAKER.perp) * 2 * i.roundTripsPerYear;
  const gross = funding - tradingCost;
  const fee = gross > 0 ? gross * i.performanceFee : 0;
  const net = gross - fee;
  return {
    hedged,
    margin,
    buffer,
    funding,
    tradingCost,
    fee,
    net,
    netApr: net / i.nav,
  };
}

/**
 * Extra-leg carry of a HYPE or BTC vault: borrow USDC against the deposit, buy that much more
 * spot and short the same amount. The deposit's own exposure is unchanged; the extra leg earns
 * funding minus the borrow rate, in proportion to how much is borrowed.
 */
export function extraLegSpreadApr(
  borrowedShareOfNav: number,
  fundingApr: number,
  borrowApr: number,
): number {
  return borrowedShareOfNav * (fundingApr - borrowApr);
}

/** Hyperliquid Portfolio Margin parameters (docs: trading/portfolio-margin, 2026-10-12). */
export const PM = {
  ltv: { HYPE: 0.65, BTC: 0.5 },
  /** Stablecoin borrow APY = 0.05 + 4.75 * max(0, utilization - 0.8). */
  borrowApr: (utilization: number) =>
    0.05 + 4.75 * Math.max(0, utilization - 0.8),
  /** Collateral share at which borrows are liquidated: 0.5 + 0.5 * LTV. */
  liquidationThreshold: (ltv: number) => 0.5 + 0.5 * ltv,
} as const;

export type PmLoopInput = {
  /** Unhedged base-asset exposure per unit of NAV: 0 for the USDC vault, 1 for a HYPE/BTC vault. */
  ownAsset: number;
  /** USDC equity on Core per unit of NAV (the USDC vault's deposit after the EVM buffer). */
  coreUsdc: number;
  /** Hedged notional per unit of NAV: spot bought and shorted the same amount. */
  hedged: number;
  /** Perp leverage; the initial margin hedged / leverage is borrowed under PM. */
  perpLeverage: number;
  ltv: number;
  fundingApr: number;
  borrowApr: number;
  roundTripsPerYear: number;
  performanceFee: number;
};

export type PmLoopResult = {
  /** Spot held per unit of NAV (own asset + hedged spot). */
  spot: number;
  /** USDC borrowed per unit of NAV (extra spot + perp initial margin - Core USDC). */
  borrowed: number;
  /** Borrowed / (spot x LTV); above 1 the position cannot be opened. */
  ltvUsed: number;
  /**
   * Price move of the base asset that reaches the borrow liquidation threshold with no
   * rebalancing (positive = rally, negative = drop), or null if none within -100%..+1000%.
   * Approximate: ignores the perp maintenance margin and the 20 USDC minimum offset.
   */
  liquidationMove: number | null;
  /** Per unit of NAV per year: funding earned, borrow interest, trading cost, fee. */
  funding: number;
  interest: number;
  tradingCost: number;
  fee: number;
  netApr: number;
};

/**
 * Funding carry under Portfolio Margin with a borrow loop: spot is collateral, USDC is borrowed
 * automatically for extra spot and for the short's initial margin, and the short equals the
 * hedged spot. Earns funding on the hedged notional, pays the borrow rate on what is borrowed.
 */
export function pmLoop(i: PmLoopInput): PmLoopResult {
  const spot = i.ownAsset + i.hedged;
  const borrowed = Math.max(
    0,
    i.hedged - i.coreUsdc + i.hedged / i.perpLeverage,
  );
  const funding = i.hedged * i.fundingApr;
  const interest = borrowed * i.borrowApr;
  const tradingCost =
    i.hedged * (TAKER.spot + TAKER.perp) * 2 * i.roundTripsPerYear;
  const gross = funding - interest - tradingCost;
  const fee = gross > 0 ? gross * i.performanceFee : 0;
  const net = gross - fee;
  // Debt after a price move r: borrowed + hedged * r (short pnl). Collateral: spot * (1 + r).
  const t = PM.liquidationThreshold(i.ltv);
  const denom = i.hedged - t * spot;
  const r = denom === 0 ? null : (t * spot - borrowed) / denom;
  return {
    spot,
    borrowed,
    ltvUsed: borrowed / (spot * i.ltv),
    liquidationMove: r !== null && r > -1 && r < 10 ? r : null,
    funding,
    interest,
    tradingCost,
    fee,
    netApr: net,
  };
}

/**
 * Target-scenario inputs of the 2026-10-12 APR / LTV recalculation. Funding is the 90-day
 * average the site quotes, rounded to 0.1 point (HYPE 10.1%, BTC 8.5%); borrow is a flat 5%
 * simple-cost approximation (the official rate moves with utilization and compounds). Not a
 * forecast and not an approved operating LTV.
 */
export const TARGET = {
  funding: { HYPE: 0.101, BTC: 0.085 },
  borrowApr: 0.05,
  /** Short margin ratio (not the vault's leverage). */
  shortLeverage: { HYPE: 10, BTC: 40 },
  /** Spot + perp taker, open and close once: 0.07% + 0.045%, twice. */
  roundTripCost: 0.0023,
  roundTripsPerYear: 1,
  performanceFee: 0.1,
  /** EVM USDC kept for withdrawals by the USDC vault. */
  buffer: 0.1,
  /** Official new-borrow LTV factors (docs: trading/portfolio-margin). */
  officialLtv: { HYPE: 0.65, BTC: 0.5 },
} as const;

export type LtvInput = {
  /** "plus": the deposit is the asset and stays exposed; "usdc": every spot unit is shorted. */
  kind: "plus" | "usdc";
  /** Actual LTV: total USDC debt / dollar value of all spot collateral. */
  ltv: number;
  shortLeverage: number;
  fundingApr: number;
  borrowApr: number;
  roundTripCost: number;
  roundTripsPerYear: number;
  performanceFee: number;
  /** USDC vault only: share kept as EVM cash. */
  buffer?: number;
};

export type LtvScenario = {
  /** Per unit of the initial deposit's dollar value. */
  hedged: number;
  spot: number;
  debt: number;
  gross: number;
  netApr: number;
};

/**
 * Fixed-price LTV scenario (initial prices, positions and debt held for a year).
 * Plus: spot = (1 + h), debt = h (1 + 1/L), so h = q / (1 + 1/L - q).
 * USDC: spot = h, debt = h (1 + 1/L) - (1 - b), so h = (1 - b) / (1 + 1/L - q).
 * Net = [h funding - debt borrow - h cost trips] x (1 - fee) when positive; a loss pays no fee.
 * The short's initial margin is assumed borrowed (code-model assumption from the official carry
 * example); PM ratio, maintenance margin, the 20 USDC offset and borrow caps are not modelled.
 */
export function ltvScenario(i: LtvInput): LtvScenario {
  const k = 1 + 1 / i.shortLeverage;
  const hedged =
    i.kind === "plus"
      ? i.ltv / (k - i.ltv)
      : (1 - (i.buffer ?? 0)) / (k - i.ltv);
  const spot = i.kind === "plus" ? 1 + hedged : hedged;
  const debt =
    i.kind === "plus" ? hedged * k : hedged * k - (1 - (i.buffer ?? 0));
  const gross =
    hedged * i.fundingApr -
    debt * i.borrowApr -
    hedged * i.roundTripCost * i.roundTripsPerYear;
  const netApr = gross > 0 ? gross * (1 - i.performanceFee) : gross;
  return { hedged, spot, debt, gross, netApr };
}

/** Funding at which a scenario breaks even before the fee. */
export function breakevenFunding(i: LtvInput): number {
  const s = ltvScenario({ ...i, fundingApr: 0 });
  return -s.gross / s.hedged;
}
