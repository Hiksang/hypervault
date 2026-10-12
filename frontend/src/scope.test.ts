import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, zeroAddress, type Address } from "viem";
import { spotMarkets, perpMarkets, type Scope } from "./hyperliquid/info.ts";
import {
  addCoreVault,
  addDex,
  addToken,
  answer,
  configureArgs,
  dexName,
  draftOf,
  flagToken,
  priceHistory,
  priceRefusal,
  recordedPrice,
  registered,
  removeCoreVault,
  removeDex,
  removeToken,
  sameScope,
  tokenChoices,
  tokenName,
  type Draft,
} from "./scope.ts";

const VAULT = "0x1111111111111111111111111111111111111111";
const usdc = { index: 0, usdcSpot: 0, lending: true, reservePrice: false };
const hype = { index: 150, usdcSpot: 107, lending: false, reservePrice: true };
const purr = { index: 1, usdcSpot: 0, lending: false, reservePrice: false };
const scope: Scope = {
  version: 2n,
  enabled: true,
  tokens: [usdc, hype],
  dexes: [0, 2],
  coreVaults: [],
};
const empty: Scope = {
  version: 0n,
  enabled: false,
  tokens: [],
  dexes: [],
  coreVaults: [],
};
const dexes = [
  { index: 0, name: "", collateralToken: 0 },
  { index: 1, name: "xyz", collateralToken: 0 },
  { index: 2, name: "flx", collateralToken: 360 },
];
const markets = [
  ...perpMarkets(dexes[0], {
    universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }],
  }),
  ...spotMarkets({
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
      { name: "@166", tokens: [268, 0], index: 166 },
    ],
  }),
];

test("a draft is a copy of the registered scope, or starts from the mandatory USDC", () => {
  const draft = draftOf(scope);
  assert.equal(sameScope(draft, scope), true);
  draft.tokens[0].lending = false;
  draft.dexes.push(9);
  assert.equal(
    scope.tokens[0].lending,
    true,
    "the registered scope is not edited",
  );
  assert.deepEqual(scope.dexes, [0, 2]);
  assert.equal(sameScope(draft, scope), false);

  const fresh = draftOf(empty);
  assert.deepEqual(fresh.tokens, [
    { index: 0, usdcSpot: 0, lending: false, reservePrice: false },
  ]);
  assert.equal(
    sameScope(fresh, empty),
    false,
    "nothing registered yet: unsaved",
  );
});

test("tokens stay sorted, unique and within the contract's limit; USDC cannot leave", () => {
  let draft = addToken(draftOf(scope), purr);
  assert.deepEqual(
    draft.tokens.map((row) => row.index),
    [0, 1, 150],
  );
  assert.throws(() => addToken(draft, { ...purr, lending: true }), /이미 등록/);
  for (const index of [5, 4, 3]) draft = addToken(draft, { ...purr, index });
  assert.deepEqual(
    draft.tokens.map((row) => row.index),
    [0, 1, 3, 4, 5, 150],
  );
  assert.throws(() => addToken(draft, { ...purr, index: 7 }), /6개까지/);
  for (const index of [-1, 1.5, 100_000_000, NaN])
    assert.throws(() => addToken(draftOf(scope), { ...purr, index }), /index/);
  assert.throws(
    () => addToken(draftOf(scope), { ...purr, usdcSpot: 2 ** 32 }),
    /pair/,
  );

  assert.throws(() => removeToken(draft, 0), /USDC는 범위에서 뺄 수 없습니다/);
  assert.deepEqual(
    removeToken(draft, 150).tokens.map((row) => row.index),
    [0, 1, 3, 4, 5],
  );
  const flagged = flagToken(
    flagToken(draft, 150, "lending", true),
    0,
    "lending",
    false,
  );
  assert.deepEqual(flagged.tokens[5], { ...hype, lending: true });
  assert.equal(flagged.tokens[0].lending, false);
  assert.equal(draft.tokens[5].lending, false, "edits return a new draft");
  assert.throws(() => flagToken(draft, 0, "reservePrice", true), /항상 1/);
});

test("DEXes and HyperCore vaults stay sorted numerically, unique and limited", () => {
  let draft = addDex(addDex(draftOf(empty), 7), 3);
  assert.deepEqual(draft.dexes, [3, 7]);
  assert.throws(() => addDex(draft, 3), /이미 등록/);
  for (const dex of [-1, 0.5, 2 ** 32])
    assert.throws(() => addDex(draft, dex), /DEX index/);
  for (const dex of [10, 0, 2, 1, 5, 4]) draft = addDex(draft, dex);
  assert.deepEqual(draft.dexes, [0, 1, 2, 3, 4, 5, 7, 10]);
  assert.throws(() => addDex(draft, 6), /8개까지/);
  assert.deepEqual(removeDex(draft, 10).dexes, [0, 1, 2, 3, 4, 5, 7]);

  // Vault addresses are ordered as numbers: 0x…0a comes after 0x…09, whatever its checksum case.
  const nine = "0x0000000000000000000000000000000000000009";
  const ten = "0x000000000000000000000000000000000000000a";
  draft = addCoreVault(addCoreVault(draft, ten), nine);
  assert.deepEqual(draft.coreVaults, [nine, getAddress(ten)]);
  assert.throws(() => addCoreVault(draft, getAddress(ten)), /이미 등록/);
  assert.throws(
    () => addCoreVault(removeCoreVault(draft, nine), ten),
    /이미 등록/,
  );
  assert.throws(() => addCoreVault(draft, VAULT), /2개까지/);
  assert.deepEqual(removeCoreVault(draft, ten).coreVaults, [nine]);
  for (const bad of ["", "0x12", "not an address"])
    assert.throws(() => addCoreVault(draftOf(empty), bad), /올바른 EVM 주소/);
  assert.throws(
    () =>
      addCoreVault(
        draftOf(empty),
        "0x0000000000000000000000000000000000000000",
      ),
    /0 주소/,
  );
});

test("configure gets the whole scope, strictly ascending, or a reason why not", () => {
  const low = "0x0000000000000000000000000000000000000010";
  const high = "0x00000000000000000000000000000000000000ff";
  const unsorted: Draft = {
    tokens: [hype, purr, usdc],
    dexes: [2, 0, 1],
    coreVaults: [high, low],
  };
  assert.deepEqual(configureArgs(VAULT, unsorted, true), [
    VAULT,
    [usdc, purr, hype],
    [0, 1, 2],
    [low, getAddress(high)],
    true,
  ]);
  assert.deepEqual(unsorted.dexes, [2, 0, 1], "the draft itself is left alone");
  assert.equal(configureArgs(VAULT, draftOf(empty), false)[4], false);

  const draft = draftOf(scope);
  const reasons: [Draft, RegExp][] = [
    [{ ...draft, tokens: [hype] }, /USDC\(index 0\)는 반드시/],
    [{ ...draft, tokens: [] }, /USDC\(index 0\)는 반드시/],
    [
      { ...draft, tokens: [usdc, hype, { ...hype, lending: true }] },
      /같은 토큰/,
    ],
    [
      {
        ...draft,
        tokens: [
          usdc,
          ...[1, 2, 3, 4, 5, 6].map((index) => ({ ...purr, index })),
        ],
      },
      /6개까지/,
    ],
    [{ ...draft, tokens: [usdc, { ...purr, index: 100_000_000 }] }, /outcome/],
    [{ ...draft, dexes: [1, 1] }, /같은 DEX/],
    [{ ...draft, dexes: [0, 1, 2, 3, 4, 5, 6, 7, 8] }, /8개까지/],
    [{ ...draft, dexes: [-1] }, /DEX index/],
    [{ ...draft, coreVaults: [VAULT, VAULT] }, /같은 HyperCore vault/],
    [
      { ...draft, coreVaults: ["0x0000000000000000000000000000000000000000"] },
      /0 주소/,
    ],
    [
      {
        ...draft,
        coreVaults: [1, 2, 3].map(
          (n) => `0x${n.toString().padStart(40, "0")}` as `0x${string}`,
        ),
      },
      /2개까지/,
    ],
  ];
  for (const [bad, reason] of reasons)
    assert.throws(() => configureArgs(VAULT, bad, true), reason);
});

test("only USDC-quoted spot tokens and named DEXes are offered", () => {
  assert.deepEqual(
    tokenChoices(markets, draftOf(scope)).map((market) => market.label),
    ["PURR/USDC", "USDT0/USDC"],
    "HYPE is registered, HYPE/USDT0 is not quoted in USDC, BTC is a perp",
  );
  assert.equal(tokenName(markets, 0), "USDC");
  assert.equal(tokenName(markets, 150), "HYPE");
  assert.equal(tokenName(markets, 999), "토큰 #999");
  assert.equal(tokenName([], 150), "토큰 #150", "no metadata");
  assert.equal(dexName(dexes, 0), "기본 perp DEX");
  assert.equal(dexName(dexes, 1), "xyz");
  assert.equal(dexName(dexes, 5), "DEX #5");
});

test("price history follows the verifier: half a window of age, an eighth between records", () => {
  const window = 3600n;
  const now = 1_000_000n;
  const at = (...ages: bigint[]) =>
    ages.map((age) => ({ price: 1n, time: now - age }));
  assert.deepEqual(priceHistory([], window, now), {
    count: 0,
    uncounted: 0,
    newestAge: null,
    oldestAge: null,
    aged: false,
    agedIn: null,
    recordIn: 0n,
    highest: 0n,
  });
  assert.deepEqual(priceHistory(at(100n), window, now), {
    count: 1,
    uncounted: 0,
    newestAge: 100n,
    oldestAge: 100n,
    aged: false,
    agedIn: 1700n,
    recordIn: 351n,
    highest: 1n,
  });
  assert.equal(priceHistory(at(1799n), window, now).aged, false);
  assert.equal(priceHistory(at(1800n), window, now).aged, true);
  assert.equal(priceHistory(at(3600n), window, now).aged, true, "still inside");
  // A record that left the window no longer counts as history, but it was the last one written.
  assert.deepEqual(priceHistory(at(3601n), window, now), {
    count: 1,
    uncounted: 0,
    newestAge: 3601n,
    oldestAge: null,
    aged: false,
    agedIn: null,
    recordIn: 0n,
    highest: 0n,
  });
  const several = priceHistory(at(500n, 4000n, 2000n, 1200n), window, now);
  assert.equal(several.oldestAge, 2000n, "the oldest inside the window");
  assert.equal(several.newestAge, 500n);
  assert.equal(several.aged, true);
  assert.equal(several.recordIn, 0n);
  // recordPrice reverts while now - last <= window / 8.
  assert.equal(priceHistory(at(450n), window, now).recordIn, 1n);
  assert.equal(priceHistory(at(451n), window, now).recordIn, 0n);
  // An unwritten slot (time 0) is not a record.
  assert.equal(priceHistory([{ price: 0n, time: 0n }], window, now).count, 0);
});

test("a price is refused without half a window of history, or far below the window's highest record", () => {
  const window = 3600n;
  const now = 1_000_000n;
  // The Vault's own ratio: one more asset unit over a thousand more share units.
  assert.equal(recordedPrice(0n, 0n), 10n ** 27n);
  assert.equal(
    recordedPrice(110000_000000n, 100000_000000000n),
    1099999999999000000000009999n,
    "1.1 USDC a share, less the offset, rounded down",
  );
  const price = recordedPrice(1000_000000n, 1000_000000000n);
  const made = (...rows: [bigint, bigint][]) =>
    rows.map(([age, value]) => ({ price: value, time: now - age }));
  const check = (records: ReturnType<typeof made>, value = price) =>
    priceRefusal(records, window, 500n, value, now);
  assert.equal(check([]), "PriceHistoryTooShort");
  assert.equal(check(made([1799n, price])), "PriceHistoryTooShort");
  assert.equal(check(made([1800n, price])), "");
  assert.equal(
    check(made([3601n, price], [900n, price])),
    "PriceHistoryTooShort",
    "the old record left the window, the new one is too young",
  );
  // Measured against the highest record inside the window, not the latest.
  const fell = made([3000n, price * 2n], [2000n, price], [100n, price]);
  assert.equal(check(fell), "PriceDropCooldown");
  assert.equal(check(fell, price * 2n), "");
  assert.equal(check(fell, (price * 2n * 95n) / 100n), "", "exactly the limit");
  assert.equal(
    check(fell, (price * 2n * 95n) / 100n - 1n),
    "PriceDropCooldown",
  );
  // That record leaves the window and the lower price becomes the bar.
  assert.equal(
    check(made([3601n, price * 2n], [2000n, price], [100n, price])),
    "",
  );
});

test("after a report is answered only later records are history, and older ones still set the bar", () => {
  const window = 3600n;
  const now = 1_000_000n;
  const price = recordedPrice(1000_000000n, 1000_000000000n);
  const made = (...rows: [bigint, bigint][]) =>
    rows.map(([age, value]) => ({ price: value, time: now - age }));
  const records = made([2500n, price * 2n], [2000n, price], [900n, price]);
  assert.equal(priceHistory(records, window, now).aged, true, "unanswered");
  // The owner registered the reported venue 1000 seconds ago.
  const answered = now - 1000n;
  assert.deepEqual(priceHistory(records, window, now, answered), {
    count: 3,
    uncounted: 2,
    newestAge: 900n,
    oldestAge: 900n,
    aged: false,
    agedIn: 900n,
    recordIn: 0n,
    highest: price * 2n,
  });
  const check = (value: bigint, at: bigint, since = answered) =>
    priceRefusal(records, window, 500n, value, at, since);
  assert.equal(check(price * 2n, now), "PriceHistoryTooShort");
  assert.equal(check(price * 2n, now + 899n), "PriceHistoryTooShort");
  // The later record is half a window old: prices are used again, against the old high.
  assert.equal(check(price * 2n, now + 900n), "");
  assert.equal(
    check(price, now + 900n),
    "PriceDropCooldown",
    "a record from before the answer is still the bar",
  );
  // A record made in the block of the answer is not after it.
  const sameBlock = priceHistory(records, window, now, now - 900n);
  assert.equal(sameBlock.uncounted, 3);
  assert.equal(sameBlock.oldestAge, null);
  assert.equal(
    sameBlock.agedIn,
    null,
    "the history starts with the next sample",
  );
  assert.equal(sameBlock.newestAge, 900n);
  // Right after an answer the next sample may not be due yet: until then nothing can count.
  const fresh = priceHistory(made([200n, price]), window, now, now - 100n);
  assert.equal(fresh.agedIn, null);
  assert.equal(fresh.recordIn, 251n);
  // An answer older than every record in the window changes nothing.
  assert.deepEqual(
    priceHistory(records, window, now, now - 2500n - 1n),
    priceHistory(records, window, now),
  );
});

test("a report names a venue the scope may list, and listing it answers the report at once only for a DEX or HyperCore vault", () => {
  const nine = "0x0000000000000000000000000000000000000009";
  const draft: Draft = { ...draftOf(scope), coreVaults: [getAddress(VAULT)] };
  const report = (
    kind: "token" | "dex" | "coreVault",
    id: number,
    coreVault: Address = zeroAddress,
  ) => ({ kind, id, coreVault, expiresAt: 1000n });
  assert.equal(registered(draft, report("dex", 2)), true);
  assert.equal(registered(draft, report("dex", 1)), false);
  assert.equal(registered(draft, report("token", 150)), true);
  assert.equal(registered(draft, report("token", 2)), false, "2 is a DEX here");
  assert.equal(registered(draft, report("dex", 150)), false, "150 is a token");
  assert.equal(registered(draft, report("coreVault", 0, VAULT)), true);
  assert.equal(registered(draft, report("coreVault", 0, nine)), false);
  assert.equal(
    registered(draftOf(scope), report("coreVault", 0)),
    false,
    "a vault report's id is not an index: neither USDC nor the first DEX",
  );
  // Registering a reported DEX or HyperCore vault lifts a report that stands: that restarts
  // the price history. One that had stopped standing by itself is only dropped.
  assert.equal(answer(draft, report("dex", 2), 999n, true), "answered");
  assert.equal(
    answer(draft, report("coreVault", 0, VAULT), 999n, true),
    "answered",
  );
  assert.equal(answer(draft, report("dex", 2), 999n, false), "dropped");
  assert.equal(
    answer(draft, report("coreVault", 0, VAULT), 999n, false),
    "dropped",
  );
  for (const standing of [true, false]) {
    assert.equal(
      answer(draft, report("dex", 2), 1000n, standing),
      "",
      "lapsed",
    );
    assert.equal(answer(draft, report("dex", 1), 999n, standing), "");
    // A registered token is counted only for what its pair pays: that block decides.
    assert.equal(
      answer(draft, report("token", 150), 999n, standing),
      "depends",
    );
    assert.equal(answer(draft, report("token", 150), 1000n, standing), "");
    assert.equal(answer(draft, report("token", 1), 999n, standing), "");
  }
});
