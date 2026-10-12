import { test } from "node:test";
import assert from "node:assert/strict";
import { minShares } from "./slippage.ts";

test("1% below the quote, rounded down", () => {
  assert.equal(minShares(22_000_000_000n), 21_780_000_000n);
  assert.equal(minShares(199n), 197n);
});

test("a normal NAV move between quote and execution stays above the minimum", () => {
  // shares = amount x supply / nav; NAV up 0.02% => shares down ~0.02%
  const quoted = (10_000_000n * 22_014_520_239n) / 22_146_055n;
  const executed =
    (10_000_000n * 22_014_520_239n) / ((22_146_055n * 10_002n) / 10_000n);
  assert.ok(executed < quoted);
  assert.ok(executed >= minShares(quoted));
});

test("an abnormal 2% move is refused", () => {
  const quoted = 1_000_000n;
  assert.ok((quoted * 98n) / 100n < minShares(quoted));
});
