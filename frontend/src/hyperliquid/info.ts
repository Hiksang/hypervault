import type { Address } from "viem";
import { perpAsset, spotAsset, type MarketKind } from "./orders.ts";

/** Core token index of USDC, the only quote and collateral the Vault's valuation supports. */
export const USDC = 0;

export type Fetcher = typeof fetch;
export type Dex = { index: number; name: string; collateralToken: number };
export type Market = {
  key: string;
  kind: MarketKind;
  label: string;
  /** Name the API uses for this market in mids, positions and open orders. */
  coin: string;
  asset: number;
  szDecimals: number;
  maxLeverage: number;
  /** Perp DEX index, or -1 for spot. */
  dex: number;
  /** Spot base token and pair index, or -1 for perps. */
  token: number;
  pair: number;
  /** Quote token (spot) or collateral token of the DEX (perps). */
  quote: number;
};
export type Scope = {
  version: bigint;
  enabled: boolean;
  tokens: {
    index: number;
    usdcSpot: number;
    lending: boolean;
    reservePrice: boolean;
  }[];
  dexes: number[];
  coreVaults: Address[];
};
type PerpMeta = {
  universe: {
    name: string;
    szDecimals: number;
    maxLeverage: number;
    isDelisted?: boolean;
  }[];
  collateralToken?: number;
};
type SpotMeta = {
  tokens: { name: string; index: number; szDecimals: number }[];
  universe: { name: string; tokens: [number, number]; index: number }[];
};

export function apiBase(chainId: number): string | null {
  if (chainId === 999) return "https://api.hyperliquid.xyz";
  if (chainId === 998) return "https://api.hyperliquid-testnet.xyz";
  return null; // a local chain has no HyperCore behind it
}

export async function info<T>(
  base: string,
  body: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const response = await fetcher(`${base}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok)
    throw new Error(`Hyperliquid API 오류 (${response.status})`);
  return (await response.json()) as T;
}

export function perpMarkets(dex: Dex, meta: PerpMeta): Market[] {
  return meta.universe.flatMap((entry, index) =>
    entry.isDelisted
      ? []
      : [
          {
            key: `perp:${dex.index}:${entry.name}`,
            kind: "perp" as const,
            label: `${entry.name}-PERP`,
            coin: entry.name,
            asset: perpAsset(dex.index, index),
            szDecimals: entry.szDecimals,
            maxLeverage: entry.maxLeverage,
            dex: dex.index,
            token: -1,
            pair: -1,
            quote: dex.collateralToken,
          },
        ],
  );
}

export function spotMarkets(meta: SpotMeta): Market[] {
  const tokens = new Map(meta.tokens.map((token) => [token.index, token]));
  return meta.universe.flatMap((pair) => {
    const base = tokens.get(pair.tokens[0]);
    const quote = tokens.get(pair.tokens[1]);
    return base && quote
      ? [
          {
            key: `spot:${pair.index}`,
            kind: "spot" as const,
            label: `${base.name}/${quote.name}`,
            coin: pair.name,
            asset: spotAsset(pair.index),
            szDecimals: base.szDecimals,
            maxLeverage: 1,
            dex: -1,
            token: base.index,
            pair: pair.index,
            quote: quote.index,
          },
        ]
      : [];
  });
}

export async function fetchMarkets(
  base: string,
  fetcher: Fetcher = fetch,
): Promise<{ dexes: Dex[]; markets: Market[] }> {
  const listed = await info<({ name: string } | null)[]>(
    base,
    { type: "perpDexs" },
    fetcher,
  );
  const dexes: Dex[] = [];
  const markets: Market[] = [];
  for (const [index, entry] of listed.entries()) {
    // Only the first entry is the validator DEX, listed as null. A null anywhere else is not
    // a second copy of it: reading it as "" would list the main markets under another DEX's ids.
    if (entry === null && index !== 0) continue;
    const name = entry === null ? "" : entry.name;
    const meta = await info<PerpMeta>(
      base,
      { type: "meta", dex: name },
      fetcher,
    );
    // A DEX whose collateral cannot be read is not guessed to be USDC.
    if (typeof meta.collateralToken !== "number")
      throw new Error("perp DEX의 담보 토큰을 확인할 수 없습니다.");
    const dex = { index, name, collateralToken: meta.collateralToken };
    dexes.push(dex);
    markets.push(...perpMarkets(dex, meta));
  }
  markets.push(
    ...spotMarkets(await info<SpotMeta>(base, { type: "spotMeta" }, fetcher)),
  );
  return { dexes, markets };
}

/**
 * Whether the Vault's registered scope values this market. Trading outside it creates a holding
 * the NAV does not see, which misprices new shares: the UI must not offer it.
 */
export function inScope(market: Market, scope: Scope): boolean {
  if (market.quote !== USDC) return false;
  if (market.kind === "perp") return scope.dexes.includes(market.dex);
  return scope.tokens.some(
    (token) => token.index === market.token && token.usdcSpot === market.pair,
  );
}

export type Position = {
  dex: number;
  coin: string;
  size: string;
  entryPrice: string | null;
  value: string;
  pnl: string;
  liquidationPrice: string | null;
};
export type Margin = {
  dex: number;
  accountValue: string;
  withdrawable: string;
};
export type Balance = {
  token: number;
  coin: string;
  total: string;
  hold: string;
};
export type OpenOrder = {
  dex: number;
  coin: string;
  isBuy: boolean;
  price: string;
  size: string;
  oid: number;
  time: number;
  reduceOnly: boolean;
  /** The exchange's order type, e.g. "Limit" or "Stop Market". */
  type?: string;
  /** Set for trigger orders (take profit / stop), which may show a size of zero. */
  triggerPrice?: string | null;
};
export type Account = {
  positions: Position[];
  margins: Margin[];
  balances: Balance[];
  orders: OpenOrder[];
};
type ClearinghouseState = {
  marginSummary: { accountValue: string };
  withdrawable: string;
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string | null;
      positionValue: string;
      unrealizedPnl: string;
      liquidationPx: string | null;
    };
  }[];
};
type FrontendOrder = {
  coin: string;
  side: "A" | "B";
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  reduceOnly?: boolean;
  orderType?: string;
  isTrigger?: boolean;
  triggerPx?: string;
};

/** HTTP view of the Vault's Core account for the operator. Unpinned: never a NAV input. */
export async function fetchAccount(
  base: string,
  user: Address,
  dexes: Dex[],
  fetcher: Fetcher = fetch,
): Promise<Account> {
  const account: Account = {
    positions: [],
    margins: [],
    balances: [],
    orders: [],
  };
  for (const dex of dexes) {
    const [state, orders] = await Promise.all([
      info<ClearinghouseState>(
        base,
        { type: "clearinghouseState", user, dex: dex.name },
        fetcher,
      ),
      // Spot orders are listed with the first DEX only.
      info<FrontendOrder[]>(
        base,
        { type: "frontendOpenOrders", user, dex: dex.name },
        fetcher,
      ),
    ]);
    account.margins.push({
      dex: dex.index,
      accountValue: state.marginSummary.accountValue,
      withdrawable: state.withdrawable,
    });
    for (const { position } of state.assetPositions)
      account.positions.push({
        dex: dex.index,
        coin: position.coin,
        size: position.szi,
        entryPrice: position.entryPx,
        value: position.positionValue,
        pnl: position.unrealizedPnl,
        liquidationPrice: position.liquidationPx,
      });
    for (const order of orders)
      account.orders.push({
        dex: dex.index,
        coin: order.coin,
        isBuy: order.side === "B",
        price: order.limitPx,
        size: order.sz,
        oid: order.oid,
        time: order.timestamp,
        reduceOnly: !!order.reduceOnly,
        type: order.orderType || "Limit",
        triggerPrice: order.isTrigger ? (order.triggerPx ?? null) : null,
      });
  }
  const spot = await info<{ balances: Balance[] }>(
    base,
    { type: "spotClearinghouseState", user },
    fetcher,
  );
  account.balances = spot.balances.filter((row) => Number(row.total) !== 0);
  return account;
}

export function fetchMids(
  base: string,
  dexName: string,
  fetcher: Fetcher = fetch,
): Promise<Record<string, string>> {
  return info(base, { type: "allMids", dex: dexName }, fetcher);
}

export type Agent = { address: Address; name: string; validUntil: number };

export function fetchAgents(
  base: string,
  user: Address,
  fetcher: Fetcher = fetch,
): Promise<Agent[]> {
  return info(base, { type: "extraAgents", user }, fetcher);
}

/** Core knows this agent for the account and its approval has not expired. */
export function agentActive(agents: Agent[], address: Address, now: number) {
  return agents.some(
    (agent) =>
      agent.address.toLowerCase() === address.toLowerCase() &&
      agent.validUntil > now,
  );
}

/** Largest builder fee the account approved for `builder`, in tenths of a basis point. */
export function fetchMaxBuilderFee(
  base: string,
  user: Address,
  builder: Address,
  fetcher: Fetcher = fetch,
): Promise<number> {
  return info(base, { type: "maxBuilderFee", user, builder }, fetcher);
}
