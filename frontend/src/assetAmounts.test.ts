import { test } from "node:test";
import assert from "node:assert/strict";
import { assetUnits, assetAmount } from "./assetAmounts.ts";

test("USDC, HYPE and UBTC keep their native precision", () => {
  assert.equal(assetUnits("1.000001", 6), 1000001n);
  assert.equal(assetUnits("1.000000000000000001", 18), 1000000000000000001n);
  assert.equal(assetUnits("0.00000001", 8), 1n);
  assert.equal(assetAmount(100000n, 8), "0.001");
});
test("extra fractional digits cannot silently round deposits", () => {
  for (const value of ["0.000000001", "-1", "1e6", "NaN", "0", " 1", "01"])
    assert.throws(() => assetUnits(value, 8));
  assert.throws(() => assetUnits((2n ** 128n).toString(), 0));
});
