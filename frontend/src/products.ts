import { SNAPSHOT } from "./marketSnapshot.ts";
import { ltvScenario, TARGET, type LtvScenario } from "./yieldModel.ts";

export type ProductId = "USDC" | "HYPE" | "BTC";

/** One row of a product's LTV table (all ratios per unit of the initial deposit's value). */
export type LtvRow = LtvScenario & { ltv: number };

export type Product = {
  id: ProductId;
  name: string;
  asset: string;
  /** "live" products have a reviewed manifest entry; the others are announced only. */
  status: "live" | "soon";
  tagline: string;
  how: string[];
  /**
   * Target scenario, up to: the net APR at the highest LTV of the table, 90-day funding, flat
   * 5% borrow, after costs and the 10% fee. A calculation scenario, never a promise and never
   * the live vault's return (the live vault is not on Portfolio Margin).
   */
  maxApr: number;
  /** The LTV the maximum is computed at, and the table it comes from. */
  maxLtv: number;
  table: LtvRow[];
  shortLeverage: number;
  fundingApr: number;
  aprBasis: string;
  exposure: string;
  /** A few key numbers for the product card. */
  specs?: [string, string][];
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** LTV rows of the recalculation: 30–60% for HYPE-collateral products, 30–40% for BTC. */
export const LTVS: Record<ProductId, number[]> = {
  USDC: [0.3, 0.4, 0.5, 0.55, 0.6],
  HYPE: [0.3, 0.4, 0.5, 0.55, 0.6],
  BTC: [0.3, 0.4],
};

const BASE = {
  borrowApr: TARGET.borrowApr,
  roundTripCost: TARGET.roundTripCost,
  roundTripsPerYear: TARGET.roundTripsPerYear,
  performanceFee: TARGET.performanceFee,
};

/** The scenario of `id` at a given LTV and funding (defaults: the table's top row, 90d funding). */
export function scenario(
  id: ProductId,
  fundingApr: number = id === "BTC" ? TARGET.funding.BTC : TARGET.funding.HYPE,
  ltv = LTVS[id][LTVS[id].length - 1]!,
  borrowApr: number = TARGET.borrowApr,
): LtvRow {
  const base = id === "BTC" ? "BTC" : "HYPE";
  return {
    ltv,
    ...ltvScenario({
      ...BASE,
      borrowApr,
      kind: id === "USDC" ? "usdc" : "plus",
      ltv,
      shortLeverage: TARGET.shortLeverage[base],
      fundingApr,
      buffer: id === "USDC" ? TARGET.buffer : 0,
    }),
  };
}

/** The top-LTV scenario of `id` at a given funding rate (for downside scenarios). */
export const planAt = (id: ProductId, fundingApr: number) =>
  scenario(id, fundingApr);

const tableOf = (id: ProductId) =>
  LTVS[id].map((q) => scenario(id, undefined, q));

const usdc = tableOf("USDC");
const hype = tableOf("HYPE");
const btc = tableOf("BTC");
const top = (t: LtvRow[]) => t[t.length - 1]!;
const f = (x: number) => `${(x * 100).toFixed(1)}%`;

export const PRODUCTS: Product[] = [
  {
    id: "USDC",
    name: "USDC Carry",
    asset: "USDC",
    status: "live",
    tagline: "Earn yield on your USDC.",
    how: [
      "Keeps 10% as USDC on HyperEVM for withdrawals",
      "Buys HYPE spot and shorts the same amount",
      "Target: the spot backs USDC borrowing for more of the same pair (Portfolio Margin)",
    ],
    maxApr: top(usdc).netApr,
    maxLtv: top(usdc).ltv,
    table: usdc,
    shortLeverage: TARGET.shortLeverage.HYPE,
    fundingApr: TARGET.funding.HYPE,
    aprBasis: `Target scenario at ${pct(top(usdc).ltv)} actual LTV: HYPE spot = short ${pct(top(usdc).spot)} of the deposit, USDC debt ${pct(top(usdc).debt)}, short ${TARGET.shortLeverage.HYPE}x, HYPE funding ${f(TARGET.funding.HYPE)} (90-day average), borrow 5% flat, one round trip a year, after the 10% fee. Needs Portfolio Margin; the live vault is not on it`,
    exposure: "No HYPE price exposure while hedged",
  },
  {
    id: "HYPE",
    name: "HYPE Plus",
    asset: "HYPE",
    status: "soon",
    tagline: "Keep your HYPE. Earn extra yield.",
    how: [
      "Your HYPE stays exposed and is collateral",
      `Borrows USDC to buy up to ${pct(top(hype).hedged)} more HYPE`,
      "Shorts only the extra HYPE",
    ],
    maxApr: top(hype).netApr,
    maxLtv: top(hype).ltv,
    table: hype,
    shortLeverage: TARGET.shortLeverage.HYPE,
    fundingApr: TARGET.funding.HYPE,
    aprBasis: `Target scenario at ${pct(top(hype).ltv)} actual LTV: extra spot = short ${pct(top(hype).hedged)} of the deposit, USDC debt ${pct(top(hype).debt)}, short ${TARGET.shortLeverage.HYPE}x, HYPE funding ${f(TARGET.funding.HYPE)}, borrow 5% flat, after the 10% fee. Measured against the deposit's initial dollar value; HYPE price moves are separate`,
    exposure: "Full HYPE price exposure, as if you held HYPE",
  },
  {
    id: "BTC",
    name: "BTC Plus",
    asset: "UBTC",
    status: "soon",
    tagline: "Keep your BTC. Earn extra yield.",
    how: [
      "Your UBTC stays exposed and is collateral",
      `Borrows USDC to buy up to ${pct(top(btc).hedged)} more BTC`,
      "Shorts only the extra BTC",
    ],
    maxApr: top(btc).netApr,
    maxLtv: top(btc).ltv,
    table: btc,
    shortLeverage: TARGET.shortLeverage.BTC,
    fundingApr: TARGET.funding.BTC,
    aprBasis: `Target scenario at ${pct(top(btc).ltv)} actual LTV: extra spot = short ${pct(top(btc).hedged)} of the deposit, USDC debt ${pct(top(btc).debt)}, short ${TARGET.shortLeverage.BTC}x, BTC funding ${f(TARGET.funding.BTC)}, borrow 5% flat, after the 10% fee. Measured against the deposit's initial dollar value; BTC price moves are separate`,
    exposure: "Full BTC price exposure, as if you held BTC",
  },
];

/** "Up to 11.1%": the maximum of a target-scenario table, one decimal. */
export const upTo = (apr: number) => `Up to ${(apr * 100).toFixed(1)}%`;

/** The PM scenario's estimate, shown only in detail areas: "11.1%". */
export const pmEst = (apr: number) => `${(apr * 100).toFixed(1)}%`;

/** LTV a not-yet-live product's card estimate is quoted at: the middle of its table, not the top. */
export const LAUNCH_LTV = 0.4;

/** Card estimate for a product that is not live: its scenario at LAUNCH_LTV. */
export function launchApr(p: Product): number {
  return (
    p.table.find((r) => Math.abs(r.ltv - LAUNCH_LTV) < 1e-9) ?? p.table[0]!
  ).netApr;
}
/** "~4.5%": live estimates are shown approximately, one decimal. */
export const approx = (apr: number) => `~${(apr * 100).toFixed(1)}%`;

/** Snapshot date the funding averages come from. */
export const FUNDING_DATE = SNAPSHOT.date;
/** Official source of the LTV factors and the borrow mechanics. */
export const PM_SOURCE =
  "https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-margin";
