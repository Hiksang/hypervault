import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress } from "viem";
import { perpMarkets, spotMarkets, type Scope } from "./hyperliquid/info.ts";
import {
  CONFIRM_ARM_MS,
  CONFIRM_TTL_MS,
  FAR_LIMIT_BPS,
  KEY_IDLE_MS,
  accountDexes,
  accountInterval,
  agentStatus,
  buildOrder,
  builderFor,
  cancelFor,
  confirmClick,
  crossing,
  feeText,
  idleLockIn,
  keyActivity,
  marketBlock,
  offered,
  orderBlock,
  orderState,
  orderValue,
  resultText,
  slippageBps,
  tradable,
  type Ticket,
} from "./trade.ts";

const BUILDER = "0xABCDEFabcdef0000000000000000000000000001";
const AGENT = "0xAbCd000000000000000000000000000000000001";
const OTHER = "0x2222222222222222222222222222222222222222";
const dexes = [
  { index: 0, name: "", collateralToken: 0 },
  { index: 1, name: "xyz", collateralToken: 0 },
  { index: 2, name: "flx", collateralToken: 360 },
];
const [btc] = perpMarkets(dexes[0], {
  universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
});
const [xyz] = perpMarkets(dexes[1], {
  universe: [{ name: "xyz:XYZ100", szDecimals: 3, maxLeverage: 20 }],
});
const [oil] = perpMarkets(dexes[2], {
  universe: [{ name: "flx:OIL", szDecimals: 2, maxLeverage: 10 }],
});
const [purr, hype, hypeUsdt] = spotMarkets({
  tokens: [
    { name: "USDC", index: 0, szDecimals: 8 },
    { name: "PURR", index: 1, szDecimals: 0 },
    { name: "HYPE", index: 150, szDecimals: 2 },
    { name: "USDT0", index: 268, szDecimals: 2 },
  ],
  universe: [
    { name: "PURR/USDC", tokens: [1, 0], index: 0 },
    { name: "@107", tokens: [150, 0], index: 107 },
    { name: "@200", tokens: [150, 268], index: 200 },
  ],
});
const scope: Scope = {
  version: 1n,
  enabled: true,
  tokens: [
    { index: 0, usdcSpot: 0, lending: true, reservePrice: false },
    { index: 150, usdcSpot: 107, lending: false, reservePrice: true },
  ],
  dexes: [0],
  coreVaults: [],
};
const ticket = (change: Partial<Ticket> = {}): Ticket => ({
  isBuy: true,
  type: "limit",
  price: "60000",
  size: "0.01",
  slippage: "1",
  reduceOnly: false,
  ...change,
});

test("a limit ticket becomes the exact action the agent signs, with what was typed", () => {
  const order = buildOrder(btc, ticket(), undefined);
  assert.deepEqual(order.action, {
    type: "order",
    orders: [
      {
        a: 0,
        b: true,
        p: "60000",
        s: "0.01",
        r: false,
        t: { limit: { tif: "Gtc" } },
      },
    ],
    grouping: "na",
  });
  assert.equal(
    order.summary,
    "매수 0.01 BTC-PERP @ 60000 · 약 600.00 USDC · 지정가",
  );
  assert.equal(order.warning, "");
  // Trailing zeros are dropped for the wire; the value itself is never rounded.
  const typed = buildOrder(
    btc,
    ticket({ price: "60000.0", size: "0.01230" }),
    undefined,
  );
  assert.deepEqual(
    [typed.action.orders[0].p, typed.action.orders[0].s],
    ["60000", "0.0123"],
  );
  const post = buildOrder(
    hype,
    ticket({ isBuy: false, type: "post", price: "30.125", size: "12.5" }),
    undefined,
  );
  assert.deepEqual(post.action.orders[0], {
    a: 10_107,
    b: false,
    p: "30.125",
    s: "12.5",
    r: false,
    t: { limit: { tif: "Alo" } },
  });
  assert.equal(
    post.summary,
    "매도 12.5 HYPE/USDC @ 30.125 · 약 376.56 USDC · 지정가 Post-only",
  );
});

test("an immediate order is an IOC bounded by the mid and the slippage", () => {
  const buy = buildOrder(btc, ticket({ type: "market", price: "" }), "60000");
  assert.deepEqual(buy.action.orders[0], {
    a: 0,
    b: true,
    p: "60600",
    s: "0.01",
    r: false,
    t: { limit: { tif: "Ioc" } },
  });
  assert.equal(
    buy.summary,
    "매수 0.01 BTC-PERP @ 60600 이하 · 약 606.00 USDC · 즉시 체결",
  );
  const sell = buildOrder(
    btc,
    ticket({ type: "market", isBuy: false, slippage: "0.5" }),
    "60000",
  );
  assert.equal(sell.action.orders[0].p, "59700");
  assert.match(sell.summary, /^매도 0.01 BTC-PERP @ 59700 이상 · /);
  for (const mid of [undefined, "", "0", "x"])
    assert.throws(
      () => buildOrder(btc, ticket({ type: "market" }), mid),
      /현재가를 확인할 수 없습니다/,
    );
  assert.equal(slippageBps("0.01"), 1);
  assert.equal(slippageBps("10"), 1000);
  for (const bad of ["0", "10.01", "1.234", "", "-1", "1e1", "abc"])
    assert.throws(
      () => buildOrder(btc, ticket({ type: "market", slippage: bad }), "60000"),
      /슬리피지는 0\.01~10%/,
      bad,
    );
});

test("the wire rules reject a ticket with their own messages", () => {
  const bad: [Partial<Ticket>, RegExp][] = [
    [{ price: "60000.5" }, /유효숫자 5자리/],
    [{ price: "0.12" }, /소수 1자리/],
    [{ price: "" }, /소수점 8자리 이내/],
    [{ price: "0" }, /0보다 큰 값/],
    [{ price: "6e4" }, /소수점 8자리 이내/],
    [{ size: "0.000001" }, /수량은 소수 5자리/],
    [{ size: "-1" }, /소수점 8자리 이내/],
    [{ size: "0.0" }, /0보다 큰 값/],
  ];
  for (const [change, reason] of bad)
    assert.throws(() => buildOrder(btc, ticket(change), "60000"), reason);
  assert.throws(
    () => buildOrder(purr, ticket({ price: "0.2", size: "100.5" }), "0.2"),
    /수량은 소수 0자리/,
  );
});

test("an order under the exchange minimum is refused, except one that only reduces", () => {
  const small = { size: "0.0001" }; // 6 USDC
  assert.throws(
    () => buildOrder(btc, ticket(small), undefined),
    /주문 금액은 10 USDC 이상/,
  );
  assert.equal(
    buildOrder(btc, ticket({ size: "0.00017" }), undefined).warning,
    "",
    "10.2 USDC",
  );
  const closing = buildOrder(
    btc,
    ticket({ ...small, isBuy: false, reduceOnly: true }),
    undefined,
  );
  assert.equal(closing.action.orders[0].r, true);
  assert.match(closing.warning, /10 USDC 미만/);
  assert.match(closing.summary, / · 지정가 · reduce-only$/);
  // Spot has no positions to reduce: the flag is dropped and the minimum applies.
  const spot = buildOrder(
    hype,
    ticket({ price: "30", size: "1", reduceOnly: true }),
    undefined,
  );
  assert.equal(spot.action.orders[0].r, false);
  assert.throws(
    () =>
      buildOrder(
        hype,
        ticket({ price: "30", size: "0.33", reduceOnly: true }),
        undefined,
      ),
    /10 USDC 이상/,
  );
  assert.equal(orderValue("0.00001", "1000000"), 10_000000n);
  assert.equal(orderValue("90071992547.40993", "0.00000001"), 900_719925n);
});

test("a builder fee is attached only as configured and never above the approval", () => {
  assert.deepEqual(builderFor(BUILDER, "10", 25), { b: BUILDER, f: 10 });
  assert.deepEqual(builderFor(BUILDER, "50", 25), { b: BUILDER, f: 25 });
  for (const [builder, configured, approved] of [
    [BUILDER, undefined, 25],
    [BUILDER, "", 25],
    [BUILDER, "0", 25],
    [BUILDER, "10", 0],
    [BUILDER, "10", NaN],
    [BUILDER, "10", -3],
    [zeroAddress, "10", 25],
    [null, "10", 25],
  ] as const)
    assert.equal(builderFor(builder, configured, approved), undefined);
  for (const bad of ["1.5", "-1", "abc", "01", " 5", "1e2"])
    assert.throws(() => builderFor(BUILDER, bad, 25), /0 이상의 정수/);
  assert.equal(feeText(10), "1.0bp");
  assert.equal(feeText(5), "0.5bp");

  const order = buildOrder(btc, ticket(), undefined, { b: BUILDER, f: 10 });
  assert.deepEqual(Object.keys(order.action), [
    "type",
    "orders",
    "grouping",
    "builder",
  ]);
  assert.deepEqual("builder" in order.action && order.action.builder, {
    b: BUILDER.toLowerCase(),
    f: 10,
  });
  assert.match(order.summary, / · 지정가 · builder fee 1\.0bp$/);
  assert.equal("builder" in buildOrder(btc, ticket(), undefined).action, false);
});

test("the agent key is usable only when the Vault and the exchange both name it", () => {
  const base = {
    stored: AGENT,
    apiWallet: AGENT,
    pendingAgent: null,
    used: true,
    active: true,
    unlocked: false,
  } as const;
  assert.equal(agentStatus({ ...base, stored: null }), "none");
  assert.equal(
    agentStatus({ ...base, stored: null, apiWallet: zeroAddress }),
    "none",
  );
  assert.equal(agentStatus(base), "locked");
  assert.equal(agentStatus({ ...base, unlocked: true }), "ready");
  assert.equal(
    agentStatus({ ...base, apiWallet: AGENT.toLowerCase() as typeof AGENT }),
    "locked",
    "addresses compare without case",
  );
  // The Vault names the key but the exchange does not, or could not be asked: no trading yet.
  for (const active of [false, null])
    assert.equal(
      agentStatus({ ...base, active, unlocked: true }),
      "unconfirmed",
    );
  // Not the Vault's agent: waiting for confirmation, never submitted, or used up.
  const apart = { ...base, apiWallet: zeroAddress, unlocked: true };
  assert.equal(agentStatus({ ...apart, pendingAgent: AGENT }), "pending");
  assert.equal(agentStatus({ ...apart, used: false }), "unsent");
  assert.equal(agentStatus({ ...apart, pendingAgent: OTHER }), "retired");
  assert.equal(agentStatus({ ...apart, apiWallet: OTHER }), "retired");
  assert.equal(
    agentStatus({
      ...apart,
      apiWallet: OTHER,
      used: false,
      pendingAgent: OTHER,
    }),
    "unsent",
  );
  // The Vault could not be read: what the exchange lists is all that is known, and it decides.
  const unread = { ...base, apiWallet: null, used: false };
  assert.equal(agentStatus(unread), "locked");
  assert.equal(agentStatus({ ...unread, unlocked: true }), "ready");
  for (const active of [false, null])
    assert.equal(agentStatus({ ...unread, active }), "unconfirmed");
  assert.equal(agentStatus({ ...unread, stored: null }), "none");
});

test("only markets the scope values are offered, and the rest say why", () => {
  assert.deepEqual(
    [btc, xyz, oil, purr, hype, hypeUsdt].map((market) =>
      tradable(market, scope),
    ),
    [true, false, false, false, true, false],
  );
  assert.equal(marketBlock(btc, scope), "");
  assert.match(marketBlock(xyz, scope), /범위 밖 — 평가 범위에 먼저 등록/);
  assert.match(marketBlock(purr, scope), /범위 밖/);
  assert.match(marketBlock(oil, scope), /USDC 담보가 아닌 DEX/);
  assert.match(marketBlock(hypeUsdt, scope), /USDC 호가가 아닌 pair/);
  // No scope to read: every USDC market is offered, and still nothing else.
  assert.deepEqual(
    [btc, xyz, oil, purr, hype, hypeUsdt].map((market) =>
      tradable(market, null),
    ),
    [true, true, false, true, true, false],
  );
  assert.match(marketBlock(oil, null), /USDC 담보가 아닌 DEX/);
  // A scope that was not read, or whose read failed, is not "no scope": nothing is offered.
  assert.deepEqual(
    [btc, xyz, oil, purr, hype, hypeUsdt].map((market) =>
      tradable(market, undefined),
    ),
    [false, false, false, false, false, false],
  );
  assert.match(marketBlock(btc, undefined), /평가 범위 확인 전/);
  assert.match(marketBlock(oil, undefined), /USDC 담보가 아닌 DEX/);
});

test("a limit that would fill at once far from the mid needs the operator's consent", () => {
  // The distance is counted only on the side that does not rest, in basis points of the mid,
  // and "far" is more than one percent of it, compared exactly.
  assert.deepEqual(crossing(true, "60600", "60000"), { bps: 100, far: false });
  assert.deepEqual(crossing(true, "60601", "60000"), { bps: 100, far: true });
  assert.deepEqual(crossing(true, "59000", "60000"), { bps: 0, far: false });
  assert.deepEqual(crossing(false, "59400", "60000"), { bps: 100, far: false });
  assert.deepEqual(crossing(false, "59399", "60000"), { bps: 100, far: true });
  assert.deepEqual(crossing(false, "61000", "60000"), { bps: 0, far: false });
  assert.deepEqual(crossing(true, "0.2021", "0.2"), { bps: 105, far: true });
  assert.deepEqual(crossing(true, "590000", "60000.0"), {
    bps: 88_333,
    far: true,
  });
  for (const mid of [undefined, "", "0", "0.0", "abc", "-1", "1e5", ".5"])
    assert.equal(crossing(true, "60000", mid), null, String(mid));

  const consent = (change: Partial<Ticket>, mid: string | undefined) =>
    buildOrder(btc, ticket(change), mid).consent;
  assert.equal(FAR_LIMIT_BPS, 100);
  assert.equal(consent({ price: "60600" }, "60000"), "", "exactly 1%");
  assert.equal(consent({ price: "59000" }, "60000"), "", "it rests");
  assert.equal(
    consent({ price: "60601" }, "60000"),
    "이 지정가는 현재가(mid 60000)보다 1.00% 높습니다. 대기하지 않고 바로, 그만큼 불리한 가격까지 체결될 수 있습니다.",
  );
  // A slipped digit: 6,900 typed for 69,000.
  assert.match(
    consent({ isBuy: false, price: "6900" }, "69000"),
    /현재가\(mid 69000\)보다 90\.00% 낮습니다/,
  );
  // Without a mid the distance cannot be told, and that is said instead of assumed away.
  assert.match(
    consent({ price: "60000" }, undefined),
    /현재가를 확인하지 못해/,
  );
  // A post-only order is refused rather than filled, and an immediate one states its bound.
  assert.equal(consent({ type: "post", price: "66000" }, "60000"), "");
  assert.equal(consent({ type: "market", slippage: "5" }, "60000"), "");
});

test("an opened key is locked after ten minutes without trading activity", () => {
  const at = 1_800_000_000_000;
  assert.equal(KEY_IDLE_MS, 600_000);
  assert.equal(idleLockIn(at, at), 600_000);
  assert.equal(idleLockIn(at, at + 599_999), 1);
  assert.equal(idleLockIn(at, at + 600_000), 0);
  assert.equal(idleLockIn(at, at + 86_400_000), 0);
  // A clock behind the last activity cannot say how long ago it was: locked, not extended.
  assert.equal(idleLockIn(at, at - 1), 0);
  assert.equal(idleLockIn(at, Number.NaN), 0);
});

test("an activity after the idle time ran out locks the key instead of renewing it", () => {
  const at = 1_700_000_000_000;
  assert.equal(keyActivity(true, at, at), "renew");
  assert.equal(keyActivity(true, at, at + KEY_IDLE_MS - 1), "renew");
  // The timer stood still while the machine slept: the first keystroke after is too late.
  assert.equal(keyActivity(true, at, at + KEY_IDLE_MS), "lock");
  assert.equal(keyActivity(true, at, at + 86_400_000), "lock");
  // A clock behind the last activity is not trusted, as for the countdown.
  assert.equal(keyActivity(true, at, at - 1), "lock");
  assert.equal(keyActivity(true, at, Number.NaN), "lock");
  // A key that is not open has nothing to lock: opening it starts the time.
  assert.equal(keyActivity(false, at, at + 86_400_000), "renew");
  assert.equal(keyActivity(false, at, at - 1), "renew");
});

test("a cancel finds its asset by coin, and results read as accepted, filled or refused", () => {
  const markets = [btc, xyz, purr, hype];
  assert.deepEqual(cancelFor(markets, { coin: "@107", oid: 9 }), {
    type: "cancel",
    cancels: [{ a: 10_107, o: 9 }],
  });
  assert.deepEqual(cancelFor(markets, { coin: "xyz:XYZ100", oid: 1 }).cancels, [
    { a: 110_000, o: 1 },
  ]);
  assert.throws(
    () => cancelFor(markets, { coin: "DOGE", oid: 1 }),
    /시장 정보를 찾을 수 없어/,
  );
  assert.deepEqual(resultText({ kind: "resting", oid: 7 }), {
    ok: true,
    text: "접수·대기 · 주문 #7",
  });
  assert.deepEqual(
    resultText({ kind: "filled", oid: 8, size: "0.02", price: "1891.4" }),
    { ok: true, text: "체결 · 0.02 @ 1891.4 · 주문 #8" },
  );
  assert.deepEqual(resultText({ kind: "ok" }), { ok: true, text: "처리됨" });
  assert.deepEqual(
    resultText({
      kind: "error",
      message: "Order must have minimum value of $10.",
    }),
    { ok: false, text: "거부 · Order must have minimum value of $10." },
  );
});

test("the account view reads the registered ledgers at a pace the API allows", () => {
  assert.deepEqual(
    accountDexes(dexes, { ...scope, dexes: [2] }).map((dex) => dex.index),
    [0, 2],
    "the first DEX also lists spot orders",
  );
  assert.deepEqual(
    accountDexes(dexes, scope).map((dex) => dex.index),
    [0],
  );
  assert.equal(accountDexes(dexes, null).length, 3);
  // The account, and with it the open orders to cancel, is read whatever is known of the scope.
  assert.equal(accountDexes(dexes, undefined).length, 3);
  assert.equal(accountInterval(1), 10_000);
  assert.equal(accountInterval(4), 10_000);
  assert.equal(accountInterval(8), 17_800);
  // Never more than half of the 1200 weight a minute, however many DEXes there are.
  for (const count of [1, 4, 8, 30])
    assert.ok(
      60_000 * (22 * count + 2) <= 600 * accountInterval(count),
      String(count),
    );
});

test("the scope holds back only what can open or add exposure", () => {
  const fresh = true;
  // In scope and read recently: any order.
  assert.deepEqual(offered(btc, scope, fresh), { orders: "any", note: "" });
  assert.equal(orderBlock(btc, false, scope, fresh), "");
  // A perp market outside the scope, or under a scope that is stale or was never read, still
  // takes an order that only reduces: such a position must stay closable.
  for (const [market, known, recent, why] of [
    [xyz, scope, true, /범위 밖/],
    [btc, scope, false, /평가 범위 조회 만료/],
    [btc, undefined, false, /평가 범위 확인 전/],
    [xyz, undefined, true, /평가 범위 확인 전/],
  ] as const) {
    const offer = offered(market, known, recent);
    assert.equal(offer.orders, "reduce", market.label);
    assert.match(offer.note, why);
    assert.match(offer.note, /reduce-only 주문만/);
    assert.equal(orderBlock(market, true, known, recent), "");
    const refused = orderBlock(market, false, known, recent);
    assert.match(refused, /reduce-only 주문과 취소는 지금도 보낼 수 있습니다/);
  }
  assert.match(orderBlock(btc, false, scope, false), /조회가 만료/);
  assert.match(orderBlock(btc, false, undefined, true), /확인하지 못해/);
  assert.match(orderBlock(xyz, false, scope, true), /평가 범위 밖/);
  // Spot has no reducing order: it waits for the scope like any order that buys.
  for (const [known, recent] of [
    [scope, false],
    [undefined, false],
  ] as const) {
    assert.equal(offered(hype, known, recent).orders, "none");
    assert.notEqual(orderBlock(hype, false, known, recent), "");
    assert.notEqual(orderBlock(hype, true, known, recent), "", "no such order");
  }
  assert.equal(offered(purr, scope, fresh).orders, "none");
  assert.equal(offered(hype, scope, fresh).orders, "any");
  // What the page does not support stays unsupported, reducing or not.
  for (const market of [oil, hypeUsdt]) {
    assert.equal(offered(market, scope, fresh).orders, "none");
    assert.equal(offered(market, undefined, false).orders, "none");
    assert.match(orderBlock(market, true, scope, fresh), /지원하지 않음/);
  }
  // A verifier that keeps no scope: every USDC market, as long as that was read recently.
  assert.equal(offered(xyz, null, true).orders, "any");
  assert.equal(offered(xyz, null, false).orders, "reduce");
  assert.equal(offered(purr, null, true).orders, "any");
});

test("a confirmation takes no click for 700 ms and none after 30 s", () => {
  const shown = 1_800_000_000_000;
  assert.equal(CONFIRM_ARM_MS, 700);
  assert.equal(CONFIRM_TTL_MS, 30_000);
  // The second click of a double click comes within a few hundred milliseconds.
  for (const after of [0, 1, 90, 120, 350, 699])
    assert.equal(confirmClick(shown, shown + after), "early", String(after));
  for (const after of [700, 701, 5_000, 29_999])
    assert.equal(confirmClick(shown, shown + after), "", String(after));
  for (const after of [30_000, 40_000, 86_400_000])
    assert.equal(confirmClick(shown, shown + after), "expired", String(after));
  // A clock that went back, or is no number at all, sends nothing.
  for (const now of [shown - 1, shown - 60_000, NaN])
    assert.equal(confirmClick(shown, now), "early", String(now));
  assert.equal(confirmClick(NaN, shown), "early");
});

test("an order's state tells pending, partial, unfilled and rejected apart", () => {
  assert.equal(orderState({ kind: "resting", oid: 1 }), "pending");
  const fill = { kind: "filled", oid: 2, size: "0.5", price: "10" } as const;
  assert.equal(orderState(fill, "1"), "partial");
  assert.equal(orderState(fill, "0.5"), "filled");
  assert.equal(orderState(fill), "filled");
  assert.equal(
    orderState({
      kind: "error",
      message: "Order could not immediately match against any resting orders.",
    }),
    "unfilled",
  );
  assert.equal(
    orderState({ kind: "error", message: "Insufficient margin" }),
    "rejected",
  );
  assert.equal(orderState({ kind: "ok" }), "done");
});
