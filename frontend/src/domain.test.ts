import { test } from "node:test";
import assert from "node:assert/strict";
import {
  units,
  format,
  validName,
  nameAllowed,
  boundedName,
  NAME_BYTES,
  feeBps,
  minShares,
  depositOpen,
  sharePrice,
  duration,
  uint,
} from "./domain.ts";
test("financial inputs never round extra decimals or use floating point", () => {
  assert.equal(units("9007199254740993.123456"), 9007199254740993123456n);
  for (const input of ["1e3", "-1", "0", "1.0000001", "NaN", " 10", "01", "1."])
    assert.throws(() => units(input));
  assert.equal(format(9007199254740993123456n), "9,007,199,254,740,993.12");
  assert.equal(format(null), "—");
});
test("names use UTF-8 byte cap and escape responsibility belongs to React", () => {
  assert.equal(validName("한글 볼트"), "한글 볼트");
  for (const name of ["", " x", "x ", "x\n", "한".repeat(33)])
    assert.throws(() => validName(name));
  assert.equal(validName("한".repeat(32)).length, 32);
});
test("a name a contract answers is shown and stored only as long as a name may be", () => {
  assert.equal(boundedName("USDC Prime"), "USDC Prime");
  assert.equal(
    boundedName("한".repeat(32)),
    "한".repeat(32),
    "exactly 96 bytes",
  );
  // Cut at a character, never inside one: 96 bytes hold 32 three-byte characters, and a
  // four-byte one that would straddle the limit is left out whole.
  assert.equal(boundedName("한".repeat(40)), "한".repeat(32));
  assert.equal(boundedName("x" + "한".repeat(40)), "x" + "한".repeat(31));
  assert.equal(boundedName("x".repeat(94) + "😀"), "x".repeat(94));
  const huge = boundedName("x".repeat(400_000));
  assert.equal(huge.length, NAME_BYTES);
  assert.ok(
    new TextEncoder().encode(boundedName("😀".repeat(1000))).length <=
      NAME_BYTES,
  );
  // The Vault's own code refuses these names, so a Vault that answers one runs other code.
  for (const name of ["", " x", "x ", "a\nb", "x\x7f", "x".repeat(97)])
    assert.equal(nameAllowed(name), false, JSON.stringify(name));
  for (const name of ["x", "한글 볼트", "x".repeat(96), "a  b"])
    assert.equal(nameAllowed(name), true, name);
});
test("fee percent and slippage limits", () => {
  assert.equal(feeBps("10"), 1000);
  assert.equal(feeBps("0"), 0);
  assert.equal(feeBps("0.00"), 0);
  assert.equal(feeBps("100"), 10000);
  assert.throws(() => feeBps("100.01"));
  assert.equal(minShares(1001n), 995n);
});
test("Active admits only verified fresh pricing; exit, pending and failure close it", () => {
  assert.equal(depositOpen(4, 100n, 0n, true), true);
  assert.equal(depositOpen(2, 100n, 0n, true), true);
  for (const args of [
    [4, 0n, 0n, true],
    [4, 100n, 1n, true],
    [4, 100n, 0n, false],
    [5, 100n, 0n, true],
  ] as const)
    assert.equal(depositOpen(...args), false);
});
test("no deposit is offered to a Vault whose code changed, whatever it reports", () => {
  assert.equal(depositOpen(4, 100n, 0n, true, false), true);
  assert.equal(depositOpen(4, 100n, 0n, true, true), false);
  assert.equal(depositOpen(3, 10n ** 30n, 0n, true, true), false);
});
test("share price is USDC per whole share, cut not rounded, and absent without a valuation", () => {
  assert.equal(sharePrice(110000_000000n, 100000_000000000n), 1_100000n);
  assert.equal(sharePrice(2_000000n, 3_000000000n), 666666n);
  assert.equal(sharePrice(1n, 3_000000000n), 0n);
  assert.equal(
    format(sharePrice(254300_120000n, 240000_000000000n), 6, 4),
    "1.0595",
  );
  assert.equal(
    sharePrice(9007199254740993_000000n, 1_000000000n),
    9007199254740993_000000n,
    "beyond double precision",
  );
  for (const [nav, supply] of [
    [null, 1n],
    [undefined, 1n],
    [1n, 0n],
    [1n, undefined],
  ] as const)
    assert.equal(sharePrice(nav, supply), null);
});
test("a duration names its two largest units and never goes negative", () => {
  for (const [seconds, text] of [
    [0, "0초"],
    [59, "59초"],
    [60, "1분"],
    [3599, "59분 59초"],
    [3600, "1시간"],
    [3660, "1시간 1분"],
    [86400, "1일"],
    [86401, "1일"],
    [90000, "1일 1시간"],
    [-5, "0초"],
  ] as const)
    assert.equal(duration(seconds), text);
  assert.equal(duration(43200n), "12시간");
  assert.equal(duration(1700n), "28분 20초");
});
test("raw integers are taken exactly and kept inside their width", () => {
  assert.equal(uint("4294967295", 32), 4294967295);
  assert.equal(uint("0", 32), 0);
  assert.equal(uint("18446744073709551615", 64), 18446744073709551615n);
  assert.throws(() => uint("4294967296", 32), /범위/);
  assert.throws(() => uint("18446744073709551616", 64), /범위/);
  for (const bad of ["", "1.0", "-1", "01", "1e3", " 1", "0x10"])
    assert.throws(() => uint(bad, 64), /정수/);
});
