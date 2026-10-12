import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  hasSelector,
  instantCap,
  payout,
  PRICE_SCALE,
  REDEEM_NOW_SELECTOR,
  REDEEM_NOW_SIGNATURE,
  sharesFor,
} from "./instant.ts";

// 1.006269 USDC per hvUSDC: USDC has 6 decimals, hvUSDC 9, so 1e30 x 1.006269e6 / 1e9.
const price = (PRICE_SCALE * 1_006_269n) / 1_000_000_000n;

test("selector matches the signature", () => {
  assert.equal(
    keccak256(toBytes(REDEEM_NOW_SIGNATURE)).slice(2, 10),
    REDEEM_NOW_SELECTOR,
  );
});

test("cap: free cash binds before the holder's balance", () => {
  const c = instantCap(22_015_232_765n, 3_216_000n, price);
  assert.ok(c.assets <= 3_216_000n && c.assets > 3_215_990n);
  assert.ok(c.shares < 22_015_232_765n);
});

test("cap: a small holder takes all of their shares", () => {
  const c = instantCap(1_000_000_000n, 3_216_000n, price);
  assert.equal(c.shares, 1_000_000_000n);
  assert.equal(c.assets, 1_005_262n); // 1.006269 less 0.1%
});

test("shares for an amount round down and stay within the cap", () => {
  const s = sharesFor(1_000_000n, price, 10n ** 12n);
  assert.ok(payout(s, price) <= 1_000_000n && payout(s, price) > 999_990n);
  assert.equal(sharesFor(10n ** 9n, price, 5n), 5n);
  assert.equal(sharesFor(1n, 0n, 5n), 0n);
});

test("selector detection looks for PUSH4", () => {
  assert.ok(hasSelector("0x6080604052" + "63782500e1" + "14", "782500e1"));
  assert.ok(!hasSelector("0x6080604052", "782500e1"));
  assert.ok(!hasSelector(undefined, "782500e1"));
});
