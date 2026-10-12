import type { Address } from "viem";
import { info, type Fetcher } from "./hyperliquid/info.ts";

/**
 * Public, read-only view of a vault's HyperCore account from the Hyperliquid HTTP API: what it
 * holds now, what it did, and the market rates its strategy depends on. Unpinned HTTP data:
 * never a NAV input (the NAV is the verifier's onchain value).
 */

export type Fill = {
  time: number;
  market: string;
  side: "buy" | "sell";
  dir: string;
  price: string;
  size: string;
  fee: string;
  feeToken: string;
  closedPnl: string;
  hash: string;
};
export type LedgerRow = {
  time: number;
  kind: string;
  detail: string;
  hash: string;
};
export type PerpPosition = {
  coin: string;
  size: string;
  entryPrice: string;
  positionValue: string;
  pnl: string;
  liquidationPrice: string | null;
  leverage: string;
};
export type LendingRow = {
  token: string;
  supplied: string;
  borrowed: string;
  oraclePrice: string;
  ltv: string;
};
export type Health = {
  borrowedUsd: number;
  healthFactor: number | null;
  liquidationUsage: number;
  dropToLiquidation: number | null;
};
export type Rates = {
  hypeFundingApr: number;
  /** The current hourly HYPE funding rate as the API states it (positive: longs pay shorts). */
  hypeFundingHourly: number;
  usdcBorrowApr: number;
  usdcSupplyApr: number;
  hypeLtv: number;
  /** HYPE perp mark price, to value spot HYPE for the position map. */
  hypeMark: number;
};
export type Activity = {
  readAt: number;
  balances: { coin: string; total: string; hold: string }[];
  positions: PerpPosition[];
  accountValue: string;
  lending: LendingRow[];
  health: Health;
  fills: Fill[];
  funding: { time: number; coin: string; usdc: string; rate: string }[];
  ledger: LedgerRow[];
  rates: Rates;
};

type Reserve = {
  oraclePx: string;
  ltv: string;
  borrowYearlyRate: string;
  supplyYearlyRate: string;
};
type LendingState = {
  tokenToState: [
    number,
    { borrow: { value: string }; supply: { value: string } },
  ][];
};

/**
 * Manual-borrow health (docs: support/faq/manual-borrows), the same formulas as the monitor:
 * health factor = sum(supplied x oracle x LTV) / borrowed; partial liquidation starts when
 * borrowed > sum(supplied x oracle x (1+LTV)/2).
 */
export function blpHealth(
  state: LendingState,
  reserves: Map<number, Reserve>,
): Health {
  let borrowed = 0,
    capacity = 0,
    liquidation = 0;
  for (const [token, s] of state.tokenToState) {
    const r = reserves.get(token);
    if (!r) throw new Error(`no reserve state for token ${token}`);
    const px = Number(r.oraclePx),
      ltv = Number(r.ltv);
    borrowed += Number(s.borrow.value) * px;
    if (ltv > 0) {
      const supplied = Number(s.supply.value) * px;
      capacity += supplied * ltv;
      liquidation += (supplied * (1 + ltv)) / 2;
    }
  }
  if (borrowed === 0)
    return {
      borrowedUsd: 0,
      healthFactor: null,
      liquidationUsage: 0,
      dropToLiquidation: null,
    };
  const usage = liquidation > 0 ? borrowed / liquidation : Infinity;
  return {
    borrowedUsd: borrowed,
    healthFactor: capacity / borrowed,
    liquidationUsage: usage,
    dropToLiquidation: Math.max(1 - usage, 0),
  };
}

/** Hourly funding rate to a simple annual rate (x 24 x 365), as Hyperliquid quotes it. */
export const fundingApr = (hourly: string) => Number(hourly) * 24 * 365;

/** One line per ledger update, in words, for the operations the vault performs. */
export function ledgerRow(u: {
  time: number;
  hash: string;
  delta: Record<string, unknown> & { type: string };
}): LedgerRow {
  const d = u.delta;
  const s = (k: string) => String(d[k] ?? "");
  const short = (a: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
  let detail: string;
  switch (d.type) {
    case "borrowLend":
      detail = `${s("operation")} ${s("amount")} ${s("token")}${Number(d.interestAmount ?? 0) ? ` (interest ${s("interestAmount")})` : ""}`;
      break;
    case "spotTransfer":
      detail = `${s("amount")} ${s("token")} from ${short(s("user"))} to ${short(s("destination"))}`;
      break;
    case "send":
      detail = `${s("amount")} ${s("token")} from ${short(s("user"))} to ${short(s("destination"))}`;
      break;
    case "accountActivationGas":
      detail = `${s("amount")} ${s("token")} account activation`;
      break;
    default:
      detail = JSON.stringify(d).slice(0, 160);
  }
  return { time: u.time, kind: d.type, detail, hash: u.hash };
}

const DAY = 86_400_000;

export async function fetchActivity(
  base: string,
  user: Address,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<Activity> {
  const ask = <T>(body: Record<string, unknown>) =>
    info<T>(base, body, fetcher);
  const [
    spot,
    perp,
    lending,
    reserveList,
    fills,
    funding,
    ledger,
    meta,
    spotMeta,
  ] = await Promise.all([
    ask<{ balances: { coin: string; total: string; hold: string }[] }>({
      type: "spotClearinghouseState",
      user,
    }),
    ask<{
      marginSummary: { accountValue: string };
      assetPositions: {
        position: {
          coin: string;
          szi: string;
          entryPx: string;
          positionValue: string;
          unrealizedPnl: string;
          liquidationPx: string | null;
          leverage: { value: number };
        };
      }[];
    }>({ type: "clearinghouseState", user }),
    ask<LendingState>({ type: "borrowLendUserState", user }),
    ask<[number, Reserve][]>({ type: "allBorrowLendReserveStates" }),
    ask<
      {
        time: number;
        coin: string;
        side: "A" | "B";
        dir: string;
        px: string;
        sz: string;
        fee: string;
        feeToken: string;
        closedPnl: string;
        hash: string;
      }[]
    >({ type: "userFills", user }),
    ask<
      {
        time: number;
        delta: { coin: string; usdc: string; fundingRate: string };
      }[]
    >({ type: "userFunding", user, startTime: now - 30 * DAY }),
    ask<
      {
        time: number;
        hash: string;
        delta: Record<string, unknown> & { type: string };
      }[]
    >({ type: "userNonFundingLedgerUpdates", user, startTime: now - 30 * DAY }),
    ask<
      [{ universe: { name: string }[] }, { funding: string; markPx?: string }[]]
    >({
      type: "metaAndAssetCtxs",
    }),
    ask<{
      tokens: { name: string; index: number }[];
      universe: { name: string; index: number; tokens: [number, number] }[];
    }>({ type: "spotMeta" }),
  ]);
  const tokenName = new Map(spotMeta.tokens.map((t) => [t.index, t.name]));
  const pairName = new Map(
    spotMeta.universe.map((u) => [
      `@${u.index}`,
      `${tokenName.get(u.tokens[0]) ?? u.tokens[0]}/${tokenName.get(u.tokens[1]) ?? u.tokens[1]}`,
    ]),
  );
  const reserves = new Map(reserveList);
  const hype = meta[0].universe.findIndex((u) => u.name === "HYPE");
  const usdc = reserves.get(0);
  return {
    readAt: now,
    balances: spot.balances.filter((b) => Number(b.total) !== 0),
    positions: perp.assetPositions.map(({ position: p }) => ({
      coin: p.coin,
      size: p.szi,
      entryPrice: p.entryPx,
      positionValue: p.positionValue,
      pnl: p.unrealizedPnl,
      liquidationPrice: p.liquidationPx,
      leverage: String(p.leverage?.value ?? ""),
    })),
    accountValue: perp.marginSummary.accountValue,
    lending: lending.tokenToState
      .filter(([, s]) => Number(s.supply.value) || Number(s.borrow.value))
      .map(([token, s]) => ({
        token: tokenName.get(token) ?? `#${token}`,
        supplied: s.supply.value,
        borrowed: s.borrow.value,
        oraclePrice: reserves.get(token)?.oraclePx ?? "",
        ltv: reserves.get(token)?.ltv ?? "",
      })),
    health: blpHealth(lending, reserves),
    fills: fills
      .slice()
      .sort((a, b) => b.time - a.time)
      .slice(0, 50)
      .map((f) => ({
        time: f.time,
        market: pairName.get(f.coin) ?? f.coin,
        side: f.side === "B" ? "buy" : "sell",
        dir: f.dir,
        price: f.px,
        size: f.sz,
        fee: f.fee,
        feeToken: f.feeToken,
        closedPnl: f.closedPnl,
        hash: f.hash,
      })),
    funding: funding
      .slice()
      .sort((a, b) => b.time - a.time)
      .map((f) => ({
        time: f.time,
        coin: f.delta.coin,
        usdc: f.delta.usdc,
        rate: f.delta.fundingRate,
      })),
    ledger: ledger
      .slice()
      .sort((a, b) => b.time - a.time)
      .map(ledgerRow),
    rates: {
      hypeFundingApr: hype >= 0 ? fundingApr(meta[1][hype]!.funding) : NaN,
      hypeFundingHourly: hype >= 0 ? Number(meta[1][hype]!.funding) : NaN,
      usdcBorrowApr: Number(usdc?.borrowYearlyRate ?? NaN),
      usdcSupplyApr: Number(usdc?.supplyYearlyRate ?? NaN),
      hypeLtv: Number(reserves.get(150)?.ltv ?? NaN),
      hypeMark: hype >= 0 ? Number(meta[1][hype]!.markPx ?? NaN) : NaN,
    },
  };
}

export type Allocation = {
  evmCash: number;
  /** Core USDC (spot ledger), which in Unified mode also backs perp margin. */
  coreUsdc: number;
  spotHypeUsd: number;
  shortHypeUsd: number;
  /** Quantities in HYPE: spot held (incl. supplied) and short size. */
  spotHype: number;
  shortHype: number;
  borrowedUsd: number;
  /** spot HYPE minus short HYPE, in USD: the price exposure left unhedged. */
  deltaUsd: number;
  /** Gross asset value used for the bar (cash + Core USDC + spot HYPE). */
  gross: number;
  running: boolean;
};

/** Where the vault's money sits now, for the position map (display only, at the HYPE mark). */
export function allocation(a: Activity, evmCash: number): Allocation {
  const bal = (coin: string) =>
    Number(a.balances.find((b) => b.coin === coin)?.total ?? 0);
  const lent = (token: string) =>
    Number(a.lending.find((l) => l.token === token)?.supplied ?? 0);
  const mark = Number.isFinite(a.rates.hypeMark) ? a.rates.hypeMark : 0;
  const spotHype = bal("HYPE") + lent("HYPE");
  const spotHypeUsd = spotHype * mark;
  const shortHype = a.positions
    .filter((p) => p.coin === "HYPE" && Number(p.size) < 0)
    .reduce((s, p) => s - Number(p.size), 0);
  const shortHypeUsd = a.positions
    .filter((p) => p.coin === "HYPE" && Number(p.size) < 0)
    .reduce((s, p) => s + Math.abs(Number(p.positionValue)), 0);
  const coreUsdc = bal("USDC") + lent("USDC");
  const borrowedUsd = a.health.borrowedUsd;
  return {
    evmCash,
    coreUsdc,
    spotHypeUsd,
    shortHypeUsd,
    spotHype,
    shortHype,
    borrowedUsd,
    deltaUsd: spotHypeUsd - shortHypeUsd,
    gross: evmCash + coreUsdc + spotHypeUsd,
    // A few dollars of HYPE gas reserve is not a running strategy.
    running: shortHypeUsd > 1 || spotHypeUsd > 1 || coreUsdc > 1,
  };
}
