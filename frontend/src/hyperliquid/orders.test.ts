import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress, zeroAddress } from "viem";
import {
  cancelAction,
  leverageAction,
  meetsMinimum,
  orderAction,
  orderWire,
  perpAsset,
  priceWire,
  results,
  sizeWire,
  slippagePrice,
  spotAsset,
  wire,
} from "./orders.ts";
import {
  agentActive,
  apiBase,
  fetchAccount,
  fetchMarkets,
  inScope,
  type Scope,
} from "./info.ts";
import { ACTION_TTL_MS, exchange } from "./exchange.ts";
import { actionHash } from "./signing.ts";
import {
  MIN_PASSPHRASE,
  loadAgent,
  newAgent,
  nextNonce,
  open,
  removeAgent,
  saveAgent,
  seal,
} from "./agentKey.ts";

const VAULT = "0x1111111111111111111111111111111111111111";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("numbers are sent as canonical decimals and never rounded", () => {
  assert.equal(wire("100.0"), "100");
  assert.equal(wire("0.014700"), "0.0147");
  assert.equal(wire("1670.1"), "1670.1");
  for (const bad of [
    "1e3",
    "-1",
    "",
    " 1",
    "01",
    "1.",
    ".5",
    "0",
    "0.0",
    "1.123456789",
    "NaN",
  ])
    assert.throws(() => wire(bad), bad);
});

test("price and size follow the documented tick and lot rules", () => {
  // Examples from the official "Tick and lot size" page.
  assert.equal(priceWire("1234.5", 0, "perp"), "1234.5");
  assert.throws(() => priceWire("1234.56", 0, "perp"), /유효숫자/);
  assert.equal(priceWire("0.001234", 0, "perp"), "0.001234");
  assert.throws(() => priceWire("0.0012345", 0, "perp"), /소수 6자리/);
  assert.equal(priceWire("0.01234", 1, "perp"), "0.01234");
  assert.throws(() => priceWire("0.012345", 1, "perp"), /소수 5자리/);
  assert.equal(priceWire("0.0001234", 1, "spot"), "0.0001234");
  assert.throws(() => priceWire("0.0001234", 3, "spot"), /소수 5자리/);
  assert.equal(
    priceWire("123456", 0, "perp"),
    "123456",
    "an integer price is always allowed",
  );
  assert.equal(sizeWire("1.001", 3), "1.001");
  assert.throws(() => sizeWire("1.0001", 3), /소수 3자리/);
  assert.equal(sizeWire("5.0", 0), "5");
});

test("minimum order value is exact", () => {
  assert.equal(meetsMinimum("10", "1"), true);
  assert.equal(meetsMinimum("9.99999999", "1"), false);
  assert.equal(meetsMinimum("0.00001", "1000000"), true);
  assert.equal(meetsMinimum("0.00001", "999999.99999999"), false);
  assert.equal(
    meetsMinimum("90071992547.40993", "0.00000001"),
    true,
    "beyond double precision",
  );
});

test("an immediate order's limit never lies beyond the slippage asked for", () => {
  // 1891.4 x 1.05 = 1985.97: the SDK rounds to 1986, which is past the bound. Cut down to 1985.9.
  assert.equal(slippagePrice("1891.4", true, 500, 4, "perp"), "1985.9");
  // 1891.4 x 0.95 = 1796.83: a sell bound is cut up.
  assert.equal(slippagePrice("1891.4", false, 500, 4, "perp"), "1796.9");
  assert.equal(slippagePrice("123456", true, 100, 5, "perp"), "124690");
  assert.equal(slippagePrice("123456", false, 100, 5, "perp"), "122230");
  assert.equal(slippagePrice("0.012345", true, 100, 0, "spot"), "0.012468");
  // The market's decimals are the coarser grid here: two decimals for a perp with four size decimals.
  assert.equal(slippagePrice("1.2345", true, 100, 4, "perp"), "1.24");
  assert.equal(slippagePrice("1.2345", false, 100, 4, "perp"), "1.23");
  // A grid that leaves three figures: asked 0.5%, nearest would give 0.101 (1%).
  assert.equal(slippagePrice("0.1", true, 50, 3, "perp"), "0.1");
  assert.equal(slippagePrice("0.1", false, 50, 3, "perp"), "0.1");
  // Exactly on the grid stays where it is, and zero slippage is the mid cut towards itself.
  assert.equal(slippagePrice("100", true, 100, 0, "perp"), "101");
  assert.equal(slippagePrice("100", false, 100, 0, "perp"), "99");
  assert.equal(slippagePrice("0.5", true, 0, 0, "spot"), "0.5");
  // No rounding step may carry a limit past its bound, whatever the mid.
  for (const mid of [
    "0.000012345678",
    "0.99999",
    "9.99995",
    "99999.5",
    "1234567.891",
  ])
    for (const bps of [1, 37, 100, 1000])
      for (const [sz, kind] of [
        [0, "perp"],
        [2, "perp"],
        [5, "perp"],
        [0, "spot"],
        [3, "spot"],
      ] as const) {
        const up = Number(mid) * (1 + bps / 1e4);
        const down = Number(mid) * (1 - bps / 1e4);
        let buy: string | null = null;
        try {
          buy = slippagePrice(mid, true, bps, sz, kind);
        } catch {
          // a mid below the market's smallest price leaves no price to cut down to
        }
        if (buy !== null)
          assert.ok(
            Number(buy) <= up * (1 + 1e-12),
            `${mid} ${bps} ${sz} ${kind} buy ${buy}`,
          );
        const sell = slippagePrice(mid, false, bps, sz, kind);
        assert.ok(
          Number(sell) >= down * (1 - 1e-12),
          `${mid} ${bps} ${sz} ${kind} sell ${sell}`,
        );
      }
  assert.throws(() => slippagePrice("0", true, 100, 0, "perp"));
  assert.throws(() => slippagePrice("x", true, 100, 0, "perp"));
  assert.throws(() => slippagePrice("1.2.3", true, 100, 0, "perp"));
  assert.throws(() => slippagePrice("-1", true, 100, 0, "perp"));
  assert.throws(
    () => slippagePrice("100", false, 10_000, 0, "perp"),
    "a sell at zero",
  );
  assert.throws(() => slippagePrice("100", true, 1.5, 0, "perp"));
  assert.throws(
    () => slippagePrice("0.0000001", true, 100, 2, "perp"),
    "cut down to nothing",
  );
});

test("asset ids follow the documented encoding", () => {
  assert.equal(perpAsset(0, 0), 0);
  assert.equal(perpAsset(1, 0), 110_000); // test:ABC in the docs
  assert.equal(spotAsset(0), 10_000); // PURR/USDC
  assert.equal(spotAsset(107), 10_107); // HYPE on mainnet
});

test("actions keep the key order the exchange hashes", () => {
  const order = orderWire({
    asset: 1,
    isBuy: true,
    price: "100",
    size: "100",
    reduceOnly: false,
    tif: "Gtc",
  });
  assert.deepEqual(Object.keys(order), ["a", "b", "p", "s", "r", "t"]);
  const plain = orderAction([order]);
  assert.deepEqual(Object.keys(plain), ["type", "orders", "grouping"]);
  // The same action the official SDK signs in test_l1_action_signing_order_matches.
  assert.equal(
    actionHash(plain, 0),
    actionHash(
      {
        type: "order",
        orders: [
          {
            a: 1,
            b: true,
            p: "100",
            s: "100",
            r: false,
            t: { limit: { tif: "Gtc" } },
          },
        ],
        grouping: "na",
      },
      0,
    ),
  );
  const built = orderAction([order], {
    b: "0xABCDEFabcdef0000000000000000000000000001",
    f: 10,
  });
  assert.deepEqual(Object.keys(built), [
    "type",
    "orders",
    "grouping",
    "builder",
  ]);
  assert.deepEqual(built.builder, {
    b: "0xabcdefabcdef0000000000000000000000000001",
    f: 10,
  });
  const withId = orderWire({
    asset: 1,
    isBuy: false,
    price: "1",
    size: "1",
    reduceOnly: true,
    tif: "Alo",
    cloid: "0x00000000000000000000000000000001",
  });
  assert.deepEqual(Object.keys(withId), ["a", "b", "p", "s", "r", "t", "c"]);
  assert.throws(() =>
    orderWire({
      asset: 1,
      isBuy: false,
      price: "1",
      size: "1",
      reduceOnly: true,
      tif: "Alo",
      cloid: "0xAB",
    }),
  );
  assert.deepEqual(cancelAction([{ asset: 10_107, oid: 5 }]), {
    type: "cancel",
    cancels: [{ a: 10_107, o: 5 }],
  });
  assert.deepEqual(leverageAction(3, true, 5), {
    type: "updateLeverage",
    asset: 3,
    isCross: true,
    leverage: 5,
  });
  assert.throws(() => leverageAction(3, true, 0.5));
});

test("exchange answers are read per order and an acceptance is not a fill", () => {
  const ok = (statuses: unknown[]) => ({
    status: "ok",
    response: { type: "order", data: { statuses } },
  });
  assert.deepEqual(results(ok([{ resting: { oid: 77738308 } }])), [
    { kind: "resting", oid: 77738308 },
  ]);
  assert.deepEqual(
    results(
      ok([{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 77747314 } }]),
    ),
    [{ kind: "filled", oid: 77747314, size: "0.02", price: "1891.4" }],
  );
  assert.deepEqual(
    results(
      ok([{ error: "Order must have minimum value of $10." }, "success"]),
    ),
    [
      { kind: "error", message: "Order must have minimum value of $10." },
      { kind: "ok" },
    ],
  );
  assert.deepEqual(
    results({
      status: "err",
      response: "User or API Wallet 0xabc does not exist.",
    }),
    [{ kind: "error", message: "User or API Wallet 0xabc does not exist." }],
  );
  assert.equal(
    results({ status: "ok", response: { type: "default" } })[0].kind,
    "ok",
  );
  assert.equal(results(null)[0].kind, "error");
  assert.equal(results(ok([{}]))[0].kind, "error");
});

test("markets are listed with their ids and only in-scope ones are tradable", async () => {
  const calls: unknown[] = [];
  const answers: Record<string, unknown> = {
    perpDexs: [null, { name: "xyz" }, { name: "flx" }],
    "meta:": {
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40 },
        { name: "OLD", szDecimals: 1, maxLeverage: 3, isDelisted: true },
        { name: "ETH", szDecimals: 4, maxLeverage: 25 },
      ],
      collateralToken: 0,
    },
    "meta:xyz": {
      universe: [{ name: "xyz:XYZ100", szDecimals: 3, maxLeverage: 20 }],
      collateralToken: 0,
    },
    "meta:flx": {
      universe: [{ name: "flx:OIL", szDecimals: 2, maxLeverage: 10 }],
      collateralToken: 360,
    },
    spotMeta: {
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
    },
  };
  const fetcher = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push([url, body]);
    const key = body.type === "meta" ? `meta:${body.dex}` : body.type;
    return { ok: true, json: async () => answers[key] };
  }) as unknown as typeof fetch;
  const { dexes, markets } = await fetchMarkets("https://api.example", fetcher);
  assert.deepEqual(
    dexes.map((dex) => dex.collateralToken),
    [0, 0, 360],
  );
  const byKey = Object.fromEntries(
    markets.map((market) => [market.key, market]),
  );
  assert.equal(byKey["perp:0:BTC"].asset, 0);
  assert.equal(
    byKey["perp:0:ETH"].asset,
    2,
    "a delisted market keeps its index slot",
  );
  assert.equal(byKey["perp:0:OLD"], undefined);
  assert.equal(byKey["perp:1:xyz:XYZ100"].asset, 110_000);
  assert.equal(byKey["spot:107"].asset, 10_107);
  assert.equal(byKey["spot:107"].label, "HYPE/USDC");
  assert.equal(byKey["spot:107"].szDecimals, 2);
  assert.equal(byKey["spot:107"].coin, "@107");
  assert.equal((calls[0] as [string])[0], "https://api.example/info");

  const scope: Scope = {
    version: 1n,
    enabled: true,
    tokens: [
      { index: 0, usdcSpot: 0, lending: true, reservePrice: false },
      { index: 150, usdcSpot: 107, lending: false, reservePrice: true },
    ],
    dexes: [0, 2],
    coreVaults: [],
  };
  assert.equal(inScope(byKey["perp:0:BTC"], scope), true);
  assert.equal(
    inScope(byKey["perp:1:xyz:XYZ100"], scope),
    false,
    "unregistered DEX",
  );
  assert.equal(
    inScope(byKey["perp:2:flx:OIL"], scope),
    false,
    "registered, but not USDC collateral",
  );
  assert.equal(inScope(byKey["spot:107"], scope), true);
  assert.equal(inScope(byKey["spot:0"], scope), false, "unregistered token");
  assert.equal(inScope(byKey["spot:200"], scope), false, "not quoted in USDC");
  scope.tokens[1].usdcSpot = 108;
  assert.equal(
    inScope(byKey["spot:107"], scope),
    false,
    "the scope prices another pair",
  );

  // A DEX whose collateral token is missing from the metadata is refused, not assumed to be USDC.
  await assert.rejects(
    fetchMarkets("https://api.example", (async () => ({
      ok: true,
      json: async () => [null],
    })) as unknown as typeof fetch),
    /담보/,
  );
  await assert.rejects(
    fetchMarkets("https://api.example", (async () => ({
      ok: false,
      status: 429,
    })) as unknown as typeof fetch),
    /429/,
  );
});

test("the account view keeps each ledger apart and a failed read is an error", async () => {
  const fetcher = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const value =
      body.type === "clearinghouseState"
        ? {
            marginSummary: { accountValue: body.dex ? "25.0" : "100.5" },
            withdrawable: "90.0",
            assetPositions: body.dex
              ? []
              : [
                  {
                    position: {
                      coin: "BTC",
                      szi: "-0.01",
                      entryPx: "60000",
                      positionValue: "600",
                      unrealizedPnl: "-3.2",
                      liquidationPx: null,
                    },
                  },
                ],
          }
        : body.type === "frontendOpenOrders"
          ? body.dex
            ? [
                {
                  coin: "xyz:SPCX",
                  side: "A",
                  limitPx: "139.5",
                  sz: "0.0",
                  oid: 10,
                  timestamp: 2,
                  reduceOnly: true,
                  orderType: "Take Profit Market",
                  isTrigger: true,
                  triggerPx: "140.0",
                },
              ]
            : [
                {
                  coin: "@107",
                  side: "B",
                  limitPx: "30.5",
                  sz: "2.0",
                  oid: 9,
                  timestamp: 1,
                  reduceOnly: false,
                },
              ]
          : {
              balances: [
                { token: 0, coin: "USDC", total: "50.0", hold: "0.0" },
                { token: 1, coin: "PURR", total: "0.0", hold: "0.0" },
              ],
            };
    return { ok: true, json: async () => value };
  }) as unknown as typeof fetch;
  const account = await fetchAccount(
    "https://api.example",
    VAULT,
    [
      { index: 0, name: "", collateralToken: 0 },
      { index: 1, name: "xyz", collateralToken: 0 },
    ],
    fetcher,
  );
  assert.deepEqual(account.margins, [
    { dex: 0, accountValue: "100.5", withdrawable: "90.0" },
    { dex: 1, accountValue: "25.0", withdrawable: "90.0" },
  ]);
  assert.deepEqual(
    account.positions.map((p) => [p.dex, p.coin, p.size]),
    [[0, "BTC", "-0.01"]],
  );
  assert.deepEqual(account.orders, [
    {
      dex: 0,
      coin: "@107",
      isBuy: true,
      price: "30.5",
      size: "2.0",
      oid: 9,
      time: 1,
      reduceOnly: false,
      type: "Limit",
      triggerPrice: null,
    },
    // A take-profit order is shown as what it is, not as a limit order of size zero.
    {
      dex: 1,
      coin: "xyz:SPCX",
      isBuy: false,
      price: "139.5",
      size: "0.0",
      oid: 10,
      time: 2,
      reduceOnly: true,
      type: "Take Profit Market",
      triggerPrice: "140.0",
    },
  ]);
  assert.deepEqual(
    account.balances.map((b) => b.coin),
    ["USDC"],
  );
  await assert.rejects(
    fetchAccount(
      "https://api.example",
      VAULT,
      [{ index: 0, name: "", collateralToken: 0 }],
      (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch,
    ),
    /500/,
  );
});

test("only mainnet and testnet have a HyperCore API, and agents expire", () => {
  assert.equal(apiBase(999), "https://api.hyperliquid.xyz");
  assert.equal(apiBase(998), "https://api.hyperliquid-testnet.xyz");
  assert.equal(apiBase(31337), null);
  const agents = [
    {
      address: "0xAbCd000000000000000000000000000000000001" as const,
      name: "",
      validUntil: 1000,
    },
  ];
  assert.equal(
    agentActive(agents, "0xabcd000000000000000000000000000000000001", 999),
    true,
  );
  assert.equal(
    agentActive(agents, "0xabcd000000000000000000000000000000000001", 1000),
    false,
  );
  assert.equal(agentActive(agents, VAULT, 1), false);
});

test("a submitted action is signed by the agent, expires, and names no vault address", async () => {
  const agent = privateKeyToAccount(
    "0x0123456789012345678901234567890123456789012345678901234567890123",
  );
  const action = orderAction([
    orderWire({
      asset: 1,
      isBuy: true,
      price: "100",
      size: "100",
      reduceOnly: false,
      tif: "Ioc",
    }),
  ]);
  let sent: { url: string; body: any } | null = null;
  const fetcher = (async (url: string, init: { body: string }) => {
    sent = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      json: async () => ({
        status: "ok",
        response: {
          type: "order",
          data: { statuses: [{ resting: { oid: 1 } }] },
        },
      }),
    };
  }) as unknown as typeof fetch;
  assert.deepEqual(
    await exchange(
      "https://api.example",
      agent,
      action,
      1_700_000_300_000,
      false,
      fetcher,
      1_700_000_000_000,
    ),
    [{ kind: "resting", oid: 1 }],
  );
  const { url, body } = sent!;
  assert.equal(url, "https://api.example/exchange");
  assert.equal(body.vaultAddress, null);
  assert.equal(body.nonce, 1_700_000_300_000);
  assert.equal(
    body.expiresAfter,
    1_700_000_000_000 + ACTION_TTL_MS,
    "counted from the clock: a nonce five minutes ahead does not extend it",
  );
  assert.deepEqual(body.action, action);
  const signer = await recoverTypedDataAddress({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: zeroAddress,
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: {
      source: "b",
      connectionId: actionHash(action, body.nonce, null, body.expiresAfter),
    },
    signature: {
      r: body.signature.r,
      s: body.signature.s,
      v: BigInt(body.signature.v),
    },
  });
  assert.equal(signer, agent.address);
  await assert.rejects(
    exchange("https://api.example", agent, action, 1, true, (async () => ({
      ok: false,
      status: 429,
    })) as unknown as typeof fetch),
    /429/,
  );
});

test("the agent key is stored only encrypted and opens only with its passphrase", async () => {
  const agent = newAgent();
  const sealed = await seal(agent.privateKey, "correct horse battery", 123);
  assert.equal(sealed.address, agent.address);
  assert.equal(sealed.createdAt, 123);
  assert.ok(
    !JSON.stringify(sealed).includes(agent.privateKey.slice(2)),
    "no plaintext key",
  );
  assert.equal(await open(sealed, "correct horse battery"), agent.privateKey);
  await assert.rejects(open(sealed, "wrong horse battery"), /암호가 올바르지/);
  await assert.rejects(
    open({ ...sealed, address: VAULT }, "correct horse battery"),
    /손상/,
  );
  await assert.rejects(seal(agent.privateKey, "short"), /12자/);
  await assert.rejects(seal(agent.privateKey, "elevenchars"), /12자/);
  assert.equal(MIN_PASSPHRASE, 12);
  const again = await seal(agent.privateKey, "correct horse battery");
  assert.notEqual(again.data, sealed.data, "fresh salt and iv each time");

  const store = memory();
  assert.equal(loadAgent(store, 999, VAULT), null);
  saveAgent(store, 999, VAULT, sealed);
  assert.deepEqual(
    loadAgent(
      store,
      999,
      VAULT.toUpperCase().replace("0X", "0x") as typeof VAULT,
    ),
    sealed,
  );
  assert.equal(loadAgent(store, 998, VAULT), null, "per chain");
  store.setItem("corevault:agent:998:" + VAULT, "{broken");
  assert.equal(loadAgent(store, 998, VAULT), null);
  // What comes back from storage is not trusted: a record whose work factor was edited would
  // either freeze the tab on unlock or be a weaker seal than this page writes.
  for (const edited of [
    { ...sealed, iterations: 1 },
    { ...sealed, iterations: 599_999 },
    { ...sealed, iterations: 6_000_001 },
    { ...sealed, iterations: 1e21 },
    { ...sealed, iterations: "600000" },
    { ...sealed, salt: "salt" },
    { ...sealed, iv: 12 },
    { ...sealed, data: "0xzz" },
    { ...sealed, address: "0x1234" },
  ]) {
    store.setItem("corevault:agent:998:" + VAULT, JSON.stringify(edited));
    assert.equal(loadAgent(store, 998, VAULT), null, JSON.stringify(edited));
  }
  removeAgent(store, 999, VAULT);
  assert.equal(loadAgent(store, 999, VAULT), null);
});

test("a nonce is never reused, across reloads or a clock that stands still", () => {
  const store = memory();
  const signer = "0xabcd000000000000000000000000000000000001";
  assert.equal(nextNonce(store, signer, 1000), 1000);
  assert.equal(nextNonce(store, signer, 1000), 1001);
  assert.equal(nextNonce(store, signer, 900), 1002, "the clock went back");
  assert.equal(nextNonce(store, signer, 5000), 5000);
  // A stored nonce the exchange would refuse (more than a day ahead) is not followed.
  const day = 86_400_000;
  store.setItem("corevault:nonce:" + signer.toLowerCase(), String(6000 + day));
  assert.equal(
    nextNonce(store, signer, 6000),
    6000 + day + 1,
    "a day ahead is still followed",
  );
  store.setItem(
    "corevault:nonce:" + signer.toLowerCase(),
    String(7000 + day + 1),
  );
  assert.equal(nextNonce(store, signer, 7000), 7000);
  assert.equal(nextNonce(store, signer, 7000), 7001);
  assert.equal(
    nextNonce(store, "0xabcd000000000000000000000000000000000002", 1),
    1,
    "per signer",
  );
});
