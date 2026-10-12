import type { Address, Hex } from "viem";

export type MarketKind = "perp" | "spot";
export type Tif = "Gtc" | "Alo" | "Ioc";
export type OrderWire = {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } };
  c?: Hex;
};
export type Builder = { b: Address; f: number };

// Prices carry at most MAX_DECIMALS - szDecimals decimals: 6 for perps, 8 for spot.
const MAX_DECIMALS = { perp: 6, spot: 8 } as const;
/** Core rejects an order worth less than 10 quote tokens. */
export const MIN_ORDER_USDC = 10n;
const SCALE = 8;

/** Canonical decimal the exchange hashes: plain digits, no trailing zeros. Never rounds. */
export function wire(value: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$/.test(value))
    throw new Error("소수점 8자리 이내의 숫자를 입력하세요.");
  const text = value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
  if (/^0(\.0*)?$/.test(text)) throw new Error("0보다 큰 값을 입력하세요.");
  return text;
}

/** Up to five significant figures unless an integer, and no more decimals than the market has. */
export function priceWire(
  price: string,
  szDecimals: number,
  kind: MarketKind,
): string {
  const text = wire(price);
  const [whole, fraction = ""] = text.split(".");
  const decimals = MAX_DECIMALS[kind] - szDecimals;
  if (fraction.length > decimals)
    throw new Error(`이 시장의 가격은 소수 ${decimals}자리까지입니다.`);
  if (fraction && (whole + fraction).replace(/^0+/, "").length > 5)
    throw new Error("가격은 유효숫자 5자리까지입니다(정수 가격은 예외).");
  return text;
}

export function sizeWire(size: string, szDecimals: number): string {
  const text = wire(size);
  if ((text.split(".")[1] || "").length > szDecimals)
    throw new Error(`이 시장의 수량은 소수 ${szDecimals}자리까지입니다.`);
  return text;
}

function scaled(text: string): bigint {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(SCALE, "0"));
}

/** Whether price x size reaches the exchange's minimum order value. Exact, no floating point. */
export function meetsMinimum(price: string, size: string): boolean {
  return (
    scaled(wire(price)) * scaled(wire(size)) >=
    MIN_ORDER_USDC * 10n ** BigInt(2 * SCALE)
  );
}

/**
 * Limit price of an order meant to fill now: the mid moved against the taker by `slippageBps`
 * and cut to the prices the market accepts (five significant figures, the market's decimals).
 * The cut goes towards the mid, down for a buy and up for a sell, so the limit never lies
 * beyond the slippage that was asked for. The official SDK rounds to the nearest price, which
 * on a coarse grid can double it. Exact decimal arithmetic.
 */
export function slippagePrice(
  mid: string,
  isBuy: boolean,
  slippageBps: number,
  szDecimals: number,
  kind: MarketKind,
): string {
  const failure = new Error("현재가를 확인할 수 없습니다.");
  const [whole, fraction = "", ...rest] = mid.split(".");
  if (
    rest.length ||
    !/^[0-9]+$/.test(whole) ||
    !/^[0-9]{0,18}$/.test(fraction) ||
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps >= 10_000
  )
    throw failure;
  const WORK = 18; // decimals carried while computing
  const midScaled = BigInt(whole + fraction.padEnd(WORK, "0"));
  const factor = BigInt(isBuy ? 10_000 + slippageBps : 10_000 - slippageBps);
  const product = midScaled * factor;
  // The bound itself, rounded towards the mid at the working precision.
  const bound = isBuy ? product / 10_000n : (product + 9_999n) / 10_000n;
  if (bound <= 0n) throw failure;
  // The coarser of the two grids: five significant figures, and the market's decimals.
  const digits = bound.toString().length;
  const step =
    10n **
    BigInt(Math.max(digits - 5, WORK - (MAX_DECIMALS[kind] - szDecimals), 0));
  const cut = isBuy
    ? bound - (bound % step)
    : bound + ((step - (bound % step)) % step);
  if (cut <= 0n) throw failure;
  const text = cut.toString().padStart(WORK + 1, "0");
  const value = `${text.slice(0, -WORK)}.${text.slice(-WORK)}`;
  return priceWire(
    value.replace(/0+$/, "").replace(/\.$/, ""),
    szDecimals,
    kind,
  );
}

export function perpAsset(dexIndex: number, index: number): number {
  return dexIndex === 0 ? index : 100_000 + dexIndex * 10_000 + index;
}

export function spotAsset(pairIndex: number): number {
  return 10_000 + pairIndex;
}

/** Key order is part of the signed bytes: a, b, p, s, r, t, then the optional cloid. */
export function orderWire(order: {
  asset: number;
  isBuy: boolean;
  price: string;
  size: string;
  reduceOnly: boolean;
  tif: Tif;
  cloid?: Hex;
}): OrderWire {
  const result: OrderWire = {
    a: order.asset,
    b: order.isBuy,
    p: order.price,
    s: order.size,
    r: order.reduceOnly,
    t: { limit: { tif: order.tif } },
  };
  if (order.cloid) {
    if (!/^0x[0-9a-f]{32}$/.test(order.cloid))
      throw new Error("cloid는 소문자 16바이트 hex여야 합니다.");
    result.c = order.cloid;
  }
  return result;
}

export function orderAction(orders: OrderWire[], builder?: Builder) {
  const action = { type: "order", orders, grouping: "na" };
  // The address is hashed as text: it must be lowercase.
  return builder
    ? {
        ...action,
        builder: { b: builder.b.toLowerCase() as Address, f: builder.f },
      }
    : action;
}

export function cancelAction(cancels: { asset: number; oid: number }[]) {
  return {
    type: "cancel",
    cancels: cancels.map(({ asset, oid }) => ({ a: asset, o: oid })),
  };
}

export function leverageAction(
  asset: number,
  isCross: boolean,
  leverage: number,
) {
  if (!Number.isInteger(leverage) || leverage < 1)
    throw new Error("레버리지는 1 이상의 정수입니다.");
  return { type: "updateLeverage", asset, isCross, leverage };
}

export type OrderResult =
  | { kind: "resting"; oid: number }
  | { kind: "filled"; oid: number; size: string; price: string }
  | { kind: "ok" }
  | { kind: "error"; message: string };

/**
 * One result per order or cancel. An accepted response is the exchange taking the request, not
 * proof of a fill or of settlement.
 */
export function results(response: unknown): OrderResult[] {
  const body = response as {
    status?: string;
    response?: { data?: { statuses?: unknown[] } } | string;
  };
  if (body?.status !== "ok")
    return [
      {
        kind: "error",
        message:
          typeof body?.response === "string"
            ? body.response
            : "거래소가 요청을 거부했습니다.",
      },
    ];
  const statuses =
    typeof body.response === "object" ? body.response?.data?.statuses : null;
  if (!Array.isArray(statuses)) return [{ kind: "ok" }];
  return statuses.map((status): OrderResult => {
    if (status === "success") return { kind: "ok" };
    const row = status as {
      resting?: { oid: number };
      filled?: { oid: number; totalSz: string; avgPx: string };
      error?: string;
    };
    if (row?.error) return { kind: "error", message: String(row.error) };
    if (row?.resting) return { kind: "resting", oid: row.resting.oid };
    if (row?.filled)
      return {
        kind: "filled",
        oid: row.filled.oid,
        size: row.filled.totalSz,
        price: row.filled.avgPx,
      };
    return { kind: "error", message: "알 수 없는 응답입니다." };
  });
}
