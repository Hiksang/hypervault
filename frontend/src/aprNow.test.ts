import { test } from "node:test";
import assert from "node:assert/strict";
import { estAprNow } from "./aprNow.ts";

test("hedged share of NAV at the stated funding, after cost and fee", () => {
  const r = estAprNow(10, 20, 0.1023)!;
  assert.equal(r.hedgedShare, 0.5);
  assert.ok(Math.abs(r.apr - 0.5 * 0.1 * 0.9) < 1e-12);
});

test("unknown or empty NAV gives no estimate", () => {
  assert.equal(estAprNow(null, 20), null);
  assert.equal(estAprNow(10, 0), null);
  assert.equal(estAprNow(10, null), null);
});

test("negative funding is a loss and pays no fee", () => {
  const r = estAprNow(10, 10, -0.05)!;
  assert.ok(Math.abs(r.apr - (-0.05 - 0.0023)) < 1e-12);
});

test("borrowed USDC costs interest in the live estimate", async () => {
  const { estAprNow } = await import("./aprNow.ts");
  // NAV 39.23, short 45.65, borrowed 23.94 at 5%, funding 10.1%.
  const r = estAprNow(45.65, 39.23, 0.101, 23.94, 0.05)!;
  const gross = (45.65 / 39.23) * (0.101 - 0.0023) - (23.94 / 39.23) * 0.05;
  assert.ok(Math.abs(r.apr - gross * 0.9) < 1e-12);
  assert.ok(
    r.apr < estAprNow(45.65, 39.23, 0.101)!.apr,
    "lower than without the borrow",
  );
});
