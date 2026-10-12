import { zeroAddress, type Address } from "viem";
import { format, units } from "./domain.ts";
import {
  USDC,
  inScope,
  type Dex,
  type Market,
  type OpenOrder,
  type Scope,
} from "./hyperliquid/info.ts";
import {
  MIN_ORDER_USDC,
  cancelAction,
  meetsMinimum,
  orderAction,
  orderWire,
  priceWire,
  sizeWire,
  slippagePrice,
  type Builder,
  type OrderResult,
  type Tif,
} from "./hyperliquid/orders.ts";

export type OrderType = "limit" | "post" | "market";
export type Ticket = {
  isBuy: boolean;
  type: OrderType;
  /** Limit price. An immediate order derives its own from the mid. */
  price: string;
  size: string;
  /** Percent the mid may move against an immediate order. */
  slippage: string;
  reduceOnly: boolean;
};
export const ORDER_TYPES: Record<OrderType, { tif: Tif; label: string }> = {
  limit: { tif: "Gtc", label: "지정가" },
  post: { tif: "Alo", label: "지정가 Post-only" },
  market: { tif: "Ioc", label: "즉시 체결" },
};
export type Action =
  | ReturnType<typeof orderAction>
  | ReturnType<typeof cancelAction>;
export type Order = {
  action: ReturnType<typeof orderAction>;
  summary: string;
  /** Set when the exchange may refuse an order this form lets through. */
  warning: string;
  /**
   * A statement the operator must agree to before this order is sent, or "": a limit that
   * would not rest but fill at once far from the mid, or one whose distance could not be told.
   */
  consent: string;
};

const MAX_SLIPPAGE_BPS = 1000n;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether the UI may offer a market. `null` says the Vault's verifier keeps no scope at all: any
 * USDC market then. `undefined` says the scope is not known, because it was not read yet or the
 * read failed: nothing is offered, since an unknown scope is not an absent one.
 */
export function tradable(
  market: Market,
  scope: Scope | null | undefined,
): boolean {
  if (scope === undefined) return false;
  return scope ? inScope(market, scope) : market.quote === USDC;
}

/** Why a market is not offered, or "" when it is. */
export function marketBlock(
  market: Market,
  scope: Scope | null | undefined,
): string {
  if (market.quote !== USDC)
    return market.kind === "perp"
      ? "USDC 담보가 아닌 DEX — 지원하지 않음"
      : "USDC 호가가 아닌 pair — 지원하지 않음";
  if (scope === undefined)
    return "평가 범위 확인 전 — 조회된 뒤에 고를 수 있음";
  return tradable(market, scope) ? "" : "범위 밖 — 평가 범위에 먼저 등록";
}

type Hold = "" | "unsupported" | "unread" | "outside" | "stale";
/** What stands between a market and an order that opens exposure on it. */
function hold(
  market: Market,
  scope: Scope | null | undefined,
  fresh: boolean,
): Hold {
  if (market.quote !== USDC) return "unsupported";
  if (scope === undefined) return "unread";
  if (!tradable(market, scope)) return "outside";
  return fresh ? "" : "stale";
}
const HOLD = {
  unread: "평가 범위 확인 전",
  outside: "범위 밖",
  stale: "평가 범위 조회 만료",
};

/**
 * What may be sent on a market, with the note it carries in the list. The registered scope, and
 * a recent read of it (`fresh`), are asked only of an order that can open or add exposure. A
 * reduce-only order can do neither, so a USDC perp market always takes one: a position outside
 * the scope, or one held while the scope cannot be read, must stay closable.
 */
export function offered(
  market: Market,
  scope: Scope | null | undefined,
  fresh: boolean,
): { orders: "any" | "reduce" | "none"; note: string } {
  const held = hold(market, scope, fresh);
  if (!held) return { orders: "any", note: "" };
  if (held !== "unsupported" && market.kind === "perp")
    return { orders: "reduce", note: `${HOLD[held]} — reduce-only 주문만` };
  return {
    orders: "none",
    note:
      held === "stale"
        ? "평가 범위 조회 만료 — 다시 조회된 뒤에 고를 수 있음"
        : marketBlock(market, scope),
  };
}

/**
 * Why an order may not be sent now, or "". A cancel is not asked this at all: it goes through
 * whenever the key is open.
 */
export function orderBlock(
  market: Market,
  reduceOnly: boolean,
  scope: Scope | null | undefined,
  fresh: boolean,
): string {
  const held = hold(market, scope, fresh);
  if (!held) return "";
  if (held === "unsupported") return marketBlock(market, scope);
  if (market.kind === "perp" && reduceOnly) return "";
  const why = {
    unread: "평가 범위를 확인하지 못해 이 주문은 보낼 수 없습니다.",
    outside:
      "이 시장은 평가 범위 밖입니다. 평가 범위에 먼저 등록해야 포지션을 열거나 늘릴 수 있습니다.",
    stale:
      "평가 범위 조회가 만료되어, 다시 조회될 때까지 이 주문은 보낼 수 없습니다.",
  }[held];
  return market.kind === "perp"
    ? `${why} 포지션을 줄이는 reduce-only 주문과 취소는 지금도 보낼 수 있습니다.`
    : why;
}

/** A confirmation takes no click for this long after it appears. */
export const CONFIRM_ARM_MS = 700;
/** A confirmation is good for this long. */
export const CONFIRM_TTL_MS = 30_000;

/**
 * What a click on a confirmation shown at `shownAt` does. "": it sends. "early": it is ignored,
 * because a click that soon was aimed at what stood there before, as the second half of a double
 * click is. "expired": it is refused, and the order is reviewed again. A clock that runs behind
 * `shownAt` is not trusted: that click is ignored too.
 */
export function confirmClick(
  shownAt: number,
  now: number,
): "" | "early" | "expired" {
  if (!(now - shownAt >= CONFIRM_ARM_MS)) return "early";
  return now - shownAt < CONFIRM_TTL_MS ? "" : "expired";
}

export function slippageBps(percent: string): number {
  const message = "슬리피지는 0.01~10% 사이로, 소수 2자리까지 입력하세요.";
  let bps: bigint;
  try {
    bps = units(percent, 2);
  } catch {
    throw new Error(message);
  }
  if (bps > MAX_SLIPPAGE_BPS) throw new Error(message);
  return Number(bps);
}

const scaled = (text: string) => {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(8, "0"));
};

/** price x size as USDC with 6 decimals, cut not rounded: a figure for the summary line only. */
export function orderValue(price: string, size: string): bigint {
  return (scaled(price) * scaled(size)) / 10n ** 10n;
}

/** A limit further than this beyond the mid, in basis points, needs the operator's consent. */
export const FAR_LIMIT_BPS = 100;

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const precise = (text: string) => {
  const [whole, fraction = ""] = text.split(".");
  return BigInt(whole + fraction.padEnd(18, "0").slice(0, 18));
};

/**
 * How far a limit price lies beyond the mid on the side where it does not rest but fills at
 * once: a buy above the mid, a sell below it. `bps` is that distance in basis points of the mid,
 * cut down, and zero when the order would rest; `far` compares it with the threshold exactly.
 * Null when the mid is not a usable price, so that the distance cannot be told.
 */
export function crossing(
  isBuy: boolean,
  price: string,
  mid: string | undefined,
): { bps: number; far: boolean } | null {
  if (!mid || !DECIMAL.test(mid) || !DECIMAL.test(price)) return null;
  const at = precise(mid);
  if (at === 0n) return null;
  const beyond = isBuy ? precise(price) - at : at - precise(price);
  if (beyond <= 0n) return { bps: 0, far: false };
  return {
    bps: Number((beyond * 10_000n) / at),
    far: beyond * 10_000n > at * BigInt(FAR_LIMIT_BPS),
  };
}

/**
 * What the operator must agree to before a resting-type limit is sent. Such an order is meant to
 * wait in the book; typed far on the wrong side of the mid, by a slipped digit, it fills at once
 * at that price instead. An immediate order states its own bound and a post-only one is refused
 * by the exchange rather than filled, so neither asks.
 */
export function farLimitConsent(
  ticket: Pick<Ticket, "isBuy" | "type">,
  price: string,
  mid: string | undefined,
): string {
  if (ticket.type !== "limit") return "";
  const distance = crossing(ticket.isBuy, price, mid);
  if (!distance)
    return "현재가를 확인하지 못해, 이 지정가가 시장 가격에서 얼마나 떨어져 있는지 알 수 없습니다. 대기하지 않고 바로, 입력한 가격에 체결될 수 있습니다.";
  if (!distance.far) return "";
  return `이 지정가는 현재가(mid ${mid})보다 ${format(BigInt(distance.bps), 2, 2)}% ${ticket.isBuy ? "높습니다" : "낮습니다"}. 대기하지 않고 바로, 그만큼 불리한 가격까지 체결될 수 있습니다.`;
}

/**
 * The builder fee an order carries, in tenths of a basis point: the configured rate, never more
 * than the Vault approved on Core. Nothing is attached when either is zero.
 */
export function builderFor(
  builder: Address | null,
  configured: string | undefined,
  approved: number,
): Builder | undefined {
  const text = configured || "0";
  if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text)))
    throw new Error("VITE_BUILDER_FEE_TENTHS_BPS는 0 이상의 정수여야 합니다.");
  const f = Math.min(Number(text), Math.floor(approved));
  return builder && !same(builder, zeroAddress) && f > 0
    ? { b: builder, f }
    : undefined;
}

/** Tenths of a basis point as basis points, e.g. 15 -> "1.5bp". */
export const feeText = (tenths: number) => `${format(BigInt(tenths), 1, 1)}bp`;

/**
 * The ticket as the action the agent signs, with the line the operator confirms. Throws the
 * validation error of the first field that is wrong.
 */
export function buildOrder(
  market: Market,
  ticket: Ticket,
  mid: string | undefined,
  builder?: Builder,
): Order {
  const { tif, label } = ORDER_TYPES[ticket.type];
  const price =
    ticket.type === "market"
      ? slippagePrice(
          mid || "",
          ticket.isBuy,
          slippageBps(ticket.slippage),
          market.szDecimals,
          market.kind,
        )
      : priceWire(ticket.price, market.szDecimals, market.kind);
  const size = sizeWire(ticket.size, market.szDecimals);
  const reduceOnly = market.kind === "perp" && ticket.reduceOnly;
  const small = !meetsMinimum(price, size);
  // A closing order is left to the exchange to judge: flattening a small position before an exit
  // must not be blocked here.
  if (small && !reduceOnly)
    throw new Error(`주문 금액은 ${MIN_ORDER_USDC} USDC 이상이어야 합니다.`);
  const bound =
    ticket.type === "market" ? (ticket.isBuy ? " 이하" : " 이상") : "";
  return {
    action: orderAction(
      [
        orderWire({
          asset: market.asset,
          isBuy: ticket.isBuy,
          price,
          size,
          reduceOnly,
          tif,
        }),
      ],
      builder,
    ),
    summary: [
      `${ticket.isBuy ? "매수" : "매도"} ${size} ${market.label} @ ${price}${bound}`,
      `약 ${format(orderValue(price, size), 6, 2)} USDC`,
      label,
      ...(reduceOnly ? ["reduce-only"] : []),
      ...(builder ? [`builder fee ${feeText(builder.f)}`] : []),
    ].join(" · "),
    warning: small
      ? `${MIN_ORDER_USDC} USDC 미만입니다. 포지션을 모두 닫는 주문이 아니면 거래소가 거부할 수 있습니다.`
      : "",
    consent: farLimitConsent(ticket, price, mid),
  };
}

/** A cancel names the asset id, which the open-order list does not carry: found by coin. */
export function cancelFor(
  markets: readonly Market[],
  order: Pick<OpenOrder, "coin" | "oid">,
) {
  const market = markets.find((row) => row.coin === order.coin);
  if (!market)
    throw new Error(
      "이 주문의 시장 정보를 찾을 수 없어 취소 요청을 만들 수 없습니다.",
    );
  return cancelAction([{ asset: market.asset, oid: order.oid }]);
}

export function resultText(result: OrderResult): {
  ok: boolean;
  text: string;
} {
  if (result.kind === "resting")
    return { ok: true, text: `접수·대기 · 주문 #${result.oid}` };
  if (result.kind === "filled")
    return {
      ok: true,
      text: `체결 · ${result.size} @ ${result.price} · 주문 #${result.oid}`,
    };
  if (result.kind === "ok") return { ok: true, text: "처리됨" };
  return { ok: false, text: `거부 · ${result.message}` };
}

/**
 * Where one order stands after the exchange answered: resting (pending), filled in full or in
 * part, an immediate order that found nothing to match (unfilled), or rejected. `requested` is
 * the order's size: without it a fill cannot be told partial.
 */
export type OrderState =
  | "pending"
  | "filled"
  | "partial"
  | "unfilled"
  | "rejected"
  | "done";
export const ORDER_STATE_LABEL: Record<OrderState, string> = {
  pending: "대기",
  filled: "체결",
  partial: "부분 체결",
  unfilled: "미체결",
  rejected: "거부",
  done: "처리됨",
};
export function orderState(
  result: OrderResult,
  requested?: string,
): OrderState {
  if (result.kind === "resting") return "pending";
  if (result.kind === "ok") return "done";
  if (result.kind === "filled")
    return requested !== undefined && Number(result.size) < Number(requested)
      ? "partial"
      : "filled";
  return /could not immediately match/i.test(result.message)
    ? "unfilled"
    : "rejected";
}

/**
 * Where the browser's agent key stands against the Vault:
 * none — no key stored here; unsent — stored, its registration never reached the Vault;
 * pending — registration submitted, waiting for the Vault to confirm it; retired — the Vault used
 * this address before and now has another agent, so it can never be registered again;
 * unconfirmed — the Vault names it, the exchange does not (yet) list it as a live agent;
 * locked — usable once opened with the passphrase; ready — open in memory.
 */
export type AgentStatus =
  | "none"
  | "unsent"
  | "pending"
  | "retired"
  | "unconfirmed"
  | "locked"
  | "ready";

export function agentStatus(input: {
  /** Address of the key sealed in this browser. */
  stored: Address | null;
  /**
   * The Vault's confirmed agent, or the zero address. Null when the Vault could not be read:
   * whether the key can sign is then what the exchange lists, and nothing else is known.
   */
  apiWallet: Address | null;
  /** Agent of the Vault's pending registration, if one is waiting. */
  pendingAgent: Address | null;
  /** `usedAgents(stored)`: the Vault has taken this address once. */
  used: boolean;
  /** Whether the exchange lists the stored address as a live agent; null when not known. */
  active: boolean | null;
  unlocked: boolean;
}): AgentStatus {
  const { stored, apiWallet, pendingAgent, used, active, unlocked } = input;
  if (!stored) return "none";
  if (apiWallet !== null && !same(stored, apiWallet)) {
    if (pendingAgent && same(pendingAgent, stored)) return "pending";
    return used ? "retired" : "unsent";
  }
  if (!active) return "unconfirmed";
  return unlocked ? "ready" : "locked";
}

/**
 * How long an opened key stays in memory without trading activity: unlocking it, picking a
 * market, editing or confirming an order, sending or cancelling one.
 */
export const KEY_IDLE_MS = 10 * 60_000;

/**
 * Milliseconds until an opened key is locked for want of activity; zero means lock it now. A
 * clock that runs behind the last activity is not trusted: that locks too.
 */
export function idleLockIn(lastActivity: number, now: number): number {
  if (!(now >= lastActivity)) return 0;
  return Math.max(0, lastActivity + KEY_IDLE_MS - now);
}

/**
 * What a trading activity does to the key's idle time: "renew" it, or "lock" a key that is open
 * although that time has already run out. The timer that should have locked it can be held up (a
 * sleeping machine, a tab in the background), and the first keystroke afterwards must not be what
 * keeps the key open. A key that is not open has nothing to lock: opening it starts the time.
 */
export function keyActivity(
  opened: boolean,
  lastActivity: number,
  now: number,
): "renew" | "lock" {
  return opened && idleLockIn(lastActivity, now) === 0 ? "lock" : "renew";
}

/**
 * DEXes whose ledgers the account view reads: the registered ones (all of them without a scope,
 * or while the scope is not known), and always the first, because spot orders are listed only
 * with it.
 */
export function accountDexes(
  dexes: readonly Dex[],
  scope: Scope | null | undefined,
) {
  return dexes.filter(
    (dex) => !scope || dex.index === 0 || scope.dexes.includes(dex.index),
  );
}

/**
 * Milliseconds between account refreshes. One refresh costs 22 info weight per DEX and 2 for
 * spot, against 1200 a minute per IP: ten seconds, or longer to stay under half of that.
 */
export function accountInterval(dexCount: number): number {
  return Math.max(10_000, 100 * (22 * dexCount + 2));
}
