import { test } from "node:test";
import assert from "node:assert/strict";
import { currentYield, perpPx, spotPx, units } from "./coreYield.ts";

const close = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("precompile decimals: perp 6 − szDecimals, spot 8 − szDecimals", () => {
  close(perpPx(853335n, 2), 85.3335); // HYPE perp oracle, szDecimals 2
  close(spotPx(85325000n, 2), 85.325); // HYPE reserve oracle (spot format)
  close(units(-12n, 2), -0.12); // perp szi in szDecimals
  close(units(11991601n, 8), 0.11991601); // HYPE spot balance, weiDecimals 8
});

test("short 0.12 HYPE, positive funding, no lending: funding leg after the fee", () => {
  // 0.12 x 85 x 0.0000125 x 8760 = 1.1169 USD/yr on 20 USD NAV
  const r = currentYield({
    perpSize: -0.12,
    oraclePx: 85,
    fundingHourly: 0.0000125,
    lending: [],
    navUsd: 20,
    performanceFee: 0.1,
  })!;
  close(r.fundingUsd, 1.1169);
  close(r.shortNotionalUsd, 10.2);
  close(r.feeUsd, 0.11169);
  close(r.apr, (1.1169 * 0.9) / 20);
});

test("negative funding is a cost and pays no fee", () => {
  const r = currentYield({
    perpSize: -0.12,
    oraclePx: 85.3335,
    fundingHourly: -0.0000108345,
    lending: [],
    navUsd: 20.48,
    performanceFee: 0.1,
  })!;
  assert.ok(r.fundingUsd < 0);
  assert.equal(r.feeUsd, 0);
  close(r.apr, r.fundingUsd / 20.48);
});

test("lending legs: supply earns, borrow costs, priced at the reserve oracle", () => {
  const r = currentYield({
    perpSize: -1,
    oraclePx: 100,
    fundingHourly: 0.00001,
    lending: [
      { supplied: 0, borrowed: 50, px: 1, supplyRate: 0.034, borrowRate: 0.05 },
      { supplied: 1, borrowed: 0, px: 100, supplyRate: 0.01, borrowRate: 0.05 },
    ],
    navUsd: 100,
    performanceFee: 0.1,
  })!;
  close(r.fundingUsd, 8.76);
  close(r.supplyUsd, 1);
  close(r.borrowUsd, 2.5);
  close(r.grossUsd, 7.26);
  close(r.netUsd, 7.26 * 0.9);
  close(r.fundingApr, 0.0876);
  close(r.borrowApr, 0.025);
});

test("no NAV: nothing to annualize against", () => {
  assert.equal(
    currentYield({
      perpSize: -1,
      oraclePx: 1,
      fundingHourly: 0,
      lending: [],
      navUsd: 0,
      performanceFee: 0.1,
    }),
    null,
  );
});
