import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blpHealth,
  fetchActivity,
  fundingApr,
  ledgerRow,
} from "./vaultActivity.ts";

const reserves = new Map([
  [
    0,
    {
      oraclePx: "1.0",
      ltv: "0.0",
      borrowYearlyRate: "0.05",
      supplyYearlyRate: "0.03",
    },
  ],
  [
    150,
    {
      oraclePx: "40",
      ltv: "0.65",
      borrowYearlyRate: "0.05",
      supplyYearlyRate: "0",
    },
  ],
]);
const state = (hype: string, usdc: string) => ({
  tokenToState: [
    [0, { borrow: { value: usdc }, supply: { value: "0" } }],
    [150, { borrow: { value: "0" }, supply: { value: hype } }],
  ] as [number, { borrow: { value: string }; supply: { value: string } }][],
});

test("health matches the manual-borrow docs example", () => {
  // 100 HYPE at $40, 2,000 USDC borrowed: health factor 130%, liquidation price ~$24.24.
  const h = blpHealth(state("100", "2000"), reserves);
  assert.ok(Math.abs(h.healthFactor! - 1.3) < 1e-9);
  assert.ok(Math.abs(40 * (1 - h.dropToLiquidation!) - 24.2424) < 1e-3);
  assert.equal(blpHealth(state("1", "0"), reserves).healthFactor, null);
  assert.throws(() =>
    blpHealth(state("1", "1"), new Map([[0, reserves.get(0)!]])),
  );
});

test("funding APR is the hourly rate x 24 x 365", () => {
  assert.ok(Math.abs(fundingApr("0.0000125") - 0.1095) < 1e-12);
});

test("ledger rows describe borrowLend operations with interest", () => {
  const row = ledgerRow({
    time: 1,
    hash: "0x1",
    delta: {
      type: "borrowLend",
      token: "USDC",
      operation: "repay",
      amount: "5.0000007",
      interestAmount: "0.0000007",
    },
  });
  assert.equal(row.detail, "repay 5.0000007 USDC (interest 0.0000007)");
});

test("fetchActivity maps the API answers, newest first, spot pairs by name", async () => {
  const answers: Record<string, unknown> = {
    spotClearinghouseState: {
      balances: [
        { coin: "USDC", total: "1.5", hold: "0" },
        { coin: "UBTC", total: "0", hold: "0" },
      ],
    },
    clearinghouseState: {
      marginSummary: { accountValue: "0" },
      assetPositions: [
        {
          position: {
            coin: "HYPE",
            szi: "-0.16",
            entryPx: "86.3",
            positionValue: "13.8",
            unrealizedPnl: "0.01",
            liquidationPx: null,
            leverage: { value: 2 },
          },
        },
      ],
    },
    borrowLendUserState: state("0.13", "5"),
    allBorrowLendReserveStates: [...reserves.entries()],
    userFills: [
      {
        time: 1,
        coin: "@107",
        side: "B",
        dir: "Buy",
        px: "86",
        sz: "0.13",
        fee: "0.01",
        feeToken: "HYPE",
        closedPnl: "0",
        hash: "0xa",
      },
      {
        time: 2,
        coin: "HYPE",
        side: "A",
        dir: "Open Short",
        px: "86",
        sz: "0.16",
        fee: "0.01",
        feeToken: "USDC",
        closedPnl: "0",
        hash: "0xb",
      },
    ],
    userFunding: [
      {
        time: 5,
        delta: { coin: "HYPE", usdc: "0.000173", fundingRate: "0.0000125" },
      },
    ],
    userNonFundingLedgerUpdates: [
      {
        time: 3,
        hash: "0xc",
        delta: {
          type: "borrowLend",
          token: "HYPE",
          operation: "supply",
          amount: "0.13",
          interestAmount: "0.0",
        },
      },
    ],
    metaAndAssetCtxs: [
      { universe: [{ name: "BTC" }, { name: "HYPE" }] },
      [{ funding: "0" }, { funding: "0.0000125" }],
    ],
    spotMeta: {
      tokens: [
        { name: "USDC", index: 0 },
        { name: "HYPE", index: 150 },
      ],
      universe: [{ name: "@107", index: 107, tokens: [150, 0] }],
    },
  };
  const fetcher = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { type: string };
    return { ok: true, json: async () => answers[body.type] } as Response;
  }) as unknown as typeof fetch;
  const a = await fetchActivity(
    "https://api.example",
    "0x0000000000000000000000000000000000000001",
    fetcher,
    1_000,
  );
  assert.deepEqual(
    a.balances.map((b) => b.coin),
    ["USDC"],
  );
  assert.equal(a.positions[0]!.leverage, "2");
  assert.deepEqual(
    a.fills.map((f) => f.market),
    ["HYPE", "HYPE/USDC"],
  );
  assert.equal(a.fills[1]!.side, "buy");
  assert.equal(a.lending[0]!.token, "USDC");
  assert.ok(Math.abs(a.health.healthFactor! - (0.13 * 40 * 0.65) / 5) < 1e-9);
  assert.equal(a.ledger[0]!.detail, "supply 0.13 HYPE");
  assert.ok(Math.abs(a.rates.hypeFundingApr - 0.1095) < 1e-12);
  assert.equal(a.rates.usdcBorrowApr, 0.05);
});

test("allocation splits cash, Core USDC, spot HYPE and the short", async () => {
  const { allocation } = await import("./vaultActivity.ts");
  const a = {
    balances: [
      { coin: "USDC", total: "300", hold: "0" },
      { coin: "HYPE", total: "6", hold: "0" },
    ],
    lending: [],
    positions: [
      {
        coin: "HYPE",
        size: "-6",
        entryPrice: "100",
        positionValue: "600",
        pnl: "0",
        liquidationPrice: null,
        leverage: "2",
      },
    ],
    health: {
      borrowedUsd: 0,
      healthFactor: null,
      liquidationUsage: 0,
      dropToLiquidation: null,
    },
    rates: {
      hypeFundingApr: 0.1,
      hypeFundingHourly: 0.1 / 8760,
      usdcBorrowApr: 0.05,
      usdcSupplyApr: 0.03,
      hypeLtv: 0.65,
      hypeMark: 100,
    },
  } as unknown as Parameters<typeof allocation>[0];
  const r = allocation(a, 100);
  assert.equal(r.spotHypeUsd, 600);
  assert.equal(r.shortHypeUsd, 600);
  assert.equal(r.deltaUsd, 0);
  assert.equal(r.gross, 1000);
  assert.equal(r.running, true);
});
