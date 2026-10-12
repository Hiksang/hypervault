import { test } from "node:test";
import assert from "node:assert/strict";
import { extraLegSpreadApr, usdcCarry } from "./yieldModel.ts";

const base = {
  nav: 1000,
  leverage: 2,
  buffer: 0.1,
  roundTripsPerYear: 1,
  performanceFee: 0.1,
};

test("1,000 USDC: 600 hedged, 300 margin, 100 buffer", () => {
  const r = usdcCarry({ ...base, fundingApr: 0.1005 });
  assert.ok(Math.abs(r.hedged - 600) < 1e-9);
  assert.ok(Math.abs(r.margin - 300) < 1e-9);
  assert.ok(Math.abs(r.funding - 60.3) < 1e-9);
  // 600 x (0.07% + 0.045%) x 2 = 1.38
  assert.ok(Math.abs(r.tradingCost - 1.38) < 1e-9);
  assert.ok(Math.abs(r.net - (60.3 - 1.38) * 0.9) < 1e-9);
});

test("Portfolio Margin: 900 hedged, no USDC margin, ~7.95% net", () => {
  const r = usdcCarry({ ...base, fundingApr: 0.1005, portfolioMargin: true });
  assert.ok(Math.abs(r.hedged - 900) < 1e-9);
  assert.equal(r.margin, 0);
  // 900 x 10.05% = 90.45; costs 900 x 0.23% = 2.07; 10% fee
  assert.ok(Math.abs(r.net - (90.45 - 2.07) * 0.9) < 1e-9);
});

test("negative funding is a loss and pays no fee", () => {
  const r = usdcCarry({ ...base, fundingApr: -0.05 });
  assert.equal(r.fee, 0);
  assert.ok(r.net < 0);
});

test("extra leg earns funding minus borrow on the borrowed share", () => {
  assert.ok(Math.abs(extraLegSpreadApr(0.3, 0.1005, 0.05) - 0.01515) < 1e-12);
  assert.ok(extraLegSpreadApr(0.3, 0.04, 0.05) < 0);
});

test("PM loop: HYPE vault liquidates on a drop, never on a rally", async () => {
  const { pmLoop } = await import("./yieldModel.ts");
  const r = pmLoop({
    ownAsset: 1,
    coreUsdc: 0,
    hedged: 0.5,
    perpLeverage: 5,
    ltv: 0.65,
    fundingApr: 0.1005,
    borrowApr: 0.05,
    roundTripsPerYear: 1,
    performanceFee: 0.1,
  });
  assert.ok(Math.abs(r.borrowed - 0.6) < 1e-12);
  assert.ok(Math.abs(r.liquidationMove! - 0.6375 / -0.7375) < 1e-12);
});

test("PM loop: the extra leg loses when funding is below the borrow cost", async () => {
  const { pmLoop, PM } = await import("./yieldModel.ts");
  assert.ok(Math.abs(PM.borrowApr(0.85) - 0.2875) < 1e-12);
  const r = pmLoop({
    ownAsset: 1,
    coreUsdc: 0,
    hedged: 0.5,
    perpLeverage: 5,
    ltv: 0.65,
    fundingApr: 0.04,
    borrowApr: 0.05,
    roundTripsPerYear: 1,
    performanceFee: 0.1,
  });
  assert.ok(r.netApr < 0);
});

const r2 = (x: number) => Math.round(x * 10000) / 100;

test("LTV table: HYPE Plus 30–60% (2026-10-12 recalculation)", async () => {
  const { scenario } = await import("./products.ts");
  const got = [0.3, 0.4, 0.5, 0.55, 0.6].map((q) =>
    r2(scenario("HYPE", undefined, q).netApr),
  );
  assert.deepEqual(got, [1.47, 2.25, 3.28, 3.93, 4.72]);
  const s = scenario("HYPE", undefined, 0.6);
  assert.deepEqual([r2(s.spot), r2(s.hedged), r2(s.debt)], [220, 120, 132]);
});

test("LTV table: BTC Plus 30–40%", async () => {
  const { scenario } = await import("./products.ts");
  assert.deepEqual(
    [0.3, 0.4].map((q) => r2(scenario("BTC", undefined, q).netApr)),
    [1.17, 1.81],
  );
  const s = scenario("BTC", undefined, 0.4);
  assert.deepEqual([r2(s.spot), r2(s.hedged), r2(s.debt)], [164, 64, 65.6]);
});

test("LTV table: USDC Carry 30–60% with a 10% buffer", async () => {
  const { scenario } = await import("./products.ts");
  const got = [0.3, 0.4, 0.5, 0.55, 0.6].map((q) =>
    r2(scenario("USDC", undefined, q).netApr),
  );
  assert.deepEqual(got, [8.47, 9.11, 9.95, 10.49, 11.13]);
  const s = scenario("USDC", undefined, 0.6);
  assert.deepEqual([r2(s.spot), r2(s.debt)], [180, 108]);
});

test("HYPE Plus 60%: sensitivity to funding and borrow", async () => {
  const { scenario } = await import("./products.ts");
  const { breakevenFunding, TARGET } = await import("./yieldModel.ts");
  const be = breakevenFunding({
    kind: "plus",
    ltv: 0.6,
    shortLeverage: TARGET.shortLeverage.HYPE,
    fundingApr: 0,
    borrowApr: 0.05,
    roundTripCost: TARGET.roundTripCost,
    roundTripsPerYear: 1,
    performanceFee: 0.1,
  });
  assert.equal(r2(be), 5.73);
  assert.equal(r2(scenario("HYPE", 0.06).netApr), 0.29);
  assert.equal(r2(scenario("HYPE", 0).netApr), -6.88);
  assert.equal(r2(scenario("HYPE", 0.101, 0.6, 0.08).netApr), 1.16);
});

test("PM scenario (details): 11.1% / 4.7% / 1.8%", async () => {
  const { PRODUCTS, pmEst } = await import("./products.ts");
  const by = Object.fromEntries(PRODUCTS.map((p) => [p.id, pmEst(p.maxApr)]));
  assert.deepEqual(by, { USDC: "11.1%", HYPE: "4.7%", BTC: "1.8%" });
});

test("cards: user-value taglines; coming vaults quoted at the 40% LTV scenario", async () => {
  const { PRODUCTS, launchApr, approx } = await import("./products.ts");
  const by = Object.fromEntries(PRODUCTS.map((p) => [p.id, p.tagline]));
  assert.deepEqual(by, {
    USDC: "Earn yield on your USDC.",
    HYPE: "Keep your HYPE. Earn extra yield.",
    BTC: "Keep your BTC. Earn extra yield.",
  });
  assert.equal(approx(launchApr(PRODUCTS[1]!)), "~2.2%"); // HYPE Plus at 40%: 2.2499…%
  assert.equal(approx(launchApr(PRODUCTS[2]!)), "~1.8%"); // BTC Plus at 40%: 1.81%
});
