import { test } from "node:test";
import assert from "node:assert/strict";
import {
  feedbackAfter,
  parseRoute,
  routeHash,
  showsPlace,
  TABS,
  type Feedback,
  type Tab,
} from "./route.ts";
import { loadRecent, recentSlot, remember } from "./recent.ts";

const VAULT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

function memory(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

test("the hash names a page, a vault and one of its tabs", () => {
  for (const hash of ["", "#", "#/"])
    assert.deepEqual(parseRoute(hash), { page: "home" });
  assert.deepEqual(parseRoute("#/explore"), { page: "explore" });
  assert.deepEqual(parseRoute("#/create"), { page: "create" });
  assert.deepEqual(parseRoute(`#/vault/${VAULT}`), {
    page: "vault",
    vault: VAULT,
    tab: "deposit",
  });
  assert.deepEqual(parseRoute(`#/vault/${VAULT}/trade/`), {
    page: "vault",
    vault: VAULT,
    tab: "trade",
  });
  for (const tab of TABS) {
    const route = { page: "vault", vault: VAULT, tab } as const;
    assert.deepEqual(parseRoute(routeHash(route)), route);
  }
  assert.equal(
    routeHash({ page: "vault", vault: VAULT, tab: "deposit" }),
    `#/vault/${VAULT}`,
  );
  assert.equal(routeHash({ page: "create" }), "#/create");
  assert.equal(routeHash({ page: "explore" }), "#/explore");
  assert.equal(routeHash({ page: "home" }), "#/");
  assert.equal(routeHash({ page: "unknown" }), "#/");
});

test("the HyperVault pages and a direct vault's page and its trade tab", () => {
  for (const page of ["vaults", "ops", "strategy", "docs"] as const) {
    assert.deepEqual(parseRoute(`#/${page}`), { page });
    assert.equal(routeHash({ page }), `#/${page}`);
  }
  for (const trade of [false, true]) {
    const route = { page: "direct", vault: VAULT, trade } as const;
    assert.deepEqual(parseRoute(routeHash(route)), route);
  }
  assert.deepEqual(parseRoute(`#/vaults/${VAULT.toLowerCase()}/trade/`), {
    page: "direct",
    vault: VAULT,
    trade: true,
  });
  for (const hash of [
    "#/vaults/0x123",
    `#/vaults/${VAULT}/deposit`,
    `#/vaults/${VAULT}/trade/extra`,
    "#/ops/now",
  ])
    assert.deepEqual(parseRoute(hash), { page: "unknown" }, hash);
  assert.equal(
    showsPlace({ page: "direct", vault: VAULT, trade: false }, VAULT),
    true,
  );
});

test("an address in a link is normalized, and anything else is not a page", () => {
  // Lowercase or wrongly cased links still open the same vault under its checksum form.
  for (const typed of [VAULT.toLowerCase(), VAULT.replace("5aA", "5AA")])
    assert.deepEqual(parseRoute(`#/vault/${typed}/chat`), {
      page: "vault",
      vault: VAULT,
      tab: "chat",
    });
  for (const hash of [
    "#/vault",
    "#/vault/0x123",
    `#/vault/${VAULT}x`,
    `#/vault/${VAULT}/nope`,
    `#/vault/${VAULT}/trade/extra`,
    "#/create/now",
    "#/elsewhere",
    "#/<script>alert(1)</script>",
  ])
    assert.deepEqual(parseRoute(hash), { page: "unknown" }, hash);
});

test("feedback is shown only on the page it belongs to, and leaves with it", () => {
  const OTHER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  const on = (vault: `0x${string}`, tab: Tab = "deposit") =>
    ({ page: "vault", vault, tab }) as const;
  const list = { page: "explore" } as const;
  const create = { page: "create" } as const;
  assert.equal(showsPlace(on(VAULT), VAULT), true);
  assert.equal(
    showsPlace(on(VAULT, "trade"), VAULT.toLowerCase() as `0x${string}`),
    true,
    "any tab of that vault, however the address is cased",
  );
  assert.equal(showsPlace(on(OTHER), VAULT), false);
  assert.equal(showsPlace(list, VAULT), false);
  assert.equal(showsPlace(create, "create"), true);
  assert.equal(showsPlace(list, "explore"), true);
  assert.equal(showsPlace({ page: "unknown" }, "explore"), true);
  assert.equal(showsPlace(on(VAULT), "explore"), false);
  assert.equal(showsPlace(on(VAULT), "create"), false);
  for (const route of [list, create, on(VAULT), { page: "unknown" } as const])
    assert.equal(showsPlace(route, null), true, "about no page in particular");

  const done: Feedback = { text: "입금 확정", error: false, place: VAULT };
  assert.equal(feedbackAfter(done, on(VAULT), on(VAULT, "withdraw")), done);
  assert.equal(feedbackAfter(done, on(VAULT), on(OTHER)), null);
  assert.equal(feedbackAfter(done, on(VAULT), list), null);
  // A new vault's confirmation is made on the create page for the page that opens next.
  assert.equal(feedbackAfter(done, create, on(VAULT, "manage")), done);
  // An action that ended after the visitor moved on: nothing under the other vault, and the
  // line is there when they come straight back.
  assert.equal(showsPlace(on(OTHER), done.place), false);
  assert.equal(feedbackAfter(done, on(OTHER), on(VAULT)), done);
  assert.equal(feedbackAfter(done, on(OTHER), list), null);

  // An error that was on screen goes with any move, even to another tab.
  const failed: Feedback = { text: "거부", error: true, place: VAULT };
  assert.equal(feedbackAfter(failed, on(VAULT), on(VAULT, "trade")), null);
  assert.equal(feedbackAfter(failed, on(VAULT), on(OTHER)), null);
  // One the visitor has not seen yet is kept for its own page.
  assert.equal(feedbackAfter(failed, on(OTHER), on(VAULT)), failed);
  assert.equal(feedbackAfter(failed, on(OTHER), list), null);

  const wallet: Feedback = {
    text: "지갑 연결 완료",
    error: false,
    place: null,
  };
  assert.equal(feedbackAfter(wallet, list, on(VAULT)), wallet);
  assert.equal(feedbackAfter({ ...wallet, error: true }, list, create), null);
  assert.equal(feedbackAfter(null, list, on(VAULT)), null);
});

test("recently opened vaults are kept newest first, once each, and only five", () => {
  const store = memory();
  const slot = recentSlot(false, 999);
  assert.deepEqual(loadRecent(store, slot), []);
  const address = (n: number) =>
    `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
  for (let n = 1; n <= 6; n++)
    remember(store, slot, { address: address(n), name: `볼트 ${n}` });
  assert.deepEqual(
    loadRecent(store, slot).map((row) => row.name),
    ["볼트 6", "볼트 5", "볼트 4", "볼트 3", "볼트 2"],
  );
  // Opening one again moves it to the front under its new name instead of listing it twice.
  const list = remember(store, slot, { address: address(4), name: "새 이름" });
  assert.deepEqual(
    list.map((row) => row.name),
    ["새 이름", "볼트 6", "볼트 5", "볼트 3", "볼트 2"],
  );
  assert.deepEqual(loadRecent(store, slot), list);
  assert.deepEqual(loadRecent(store, recentSlot(true, 999)), [], "demo apart");
  assert.deepEqual(loadRecent(store, recentSlot(false, 998)), [], "per chain");
});

test("a stored list is not trusted and a blocked store is not an error", () => {
  const slot = recentSlot(true, 999);
  const rows = [
    { address: VAULT.toLowerCase(), name: "x".repeat(200) },
    { address: "0x123", name: "short address" },
    { address: VAULT, name: 7 },
    null,
    "text",
  ];
  const loaded = loadRecent(memory({ [slot]: JSON.stringify(rows) }), slot);
  assert.deepEqual(loaded, [{ address: VAULT, name: "x".repeat(96) }]);
  for (const broken of ["{", '{"a":1}', '"text"', "null"])
    assert.deepEqual(loadRecent(memory({ [slot]: broken }), slot), []);
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.deepEqual(loadRecent(blocked, slot), []);
  assert.deepEqual(remember(blocked, slot, { address: VAULT, name: "a" }), [
    { address: VAULT, name: "a" },
  ]);
});

test("a vault's name is stored only as long as a name may be", () => {
  const slot = recentSlot(false, 999);
  const store = memory();
  const list = remember(store, slot, {
    address: VAULT,
    name: "한".repeat(400_000),
  });
  assert.deepEqual(list, [{ address: VAULT, name: "한".repeat(32) }]);
  assert.ok(
    store.getItem(slot)!.length < 300,
    "what is written is bounded too",
  );
  assert.deepEqual(loadRecent(store, slot), list);
  // A stored name is cut by bytes as well, whoever wrote it.
  const loaded = loadRecent(
    memory({
      [slot]: JSON.stringify([{ address: VAULT, name: "한".repeat(96) }]),
    }),
    slot,
  );
  assert.deepEqual(loaded, [{ address: VAULT, name: "한".repeat(32) }]);
});
