import { test } from "node:test";
import assert from "node:assert/strict";
import { zeroAddress } from "viem";
import {
  demoAgent,
  demoBeginExit,
  demoClaim,
  demoClear,
  demoConfigure,
  demoCreate,
  demoExchange,
  demoMarkets,
  demoPriced,
  demoRecord,
  demoRequest,
  demoSettle,
  demoState,
  demoSubmit,
  demoSummary,
  demoSync,
  demoViewer,
  demoWorld,
  patchVault,
  type DemoVault,
} from "./demo.ts";
import {
  addDex,
  addToken,
  draftOf,
  recordedPrice,
  removeDex,
} from "./scope.ts";
import { buildOrder, cancelFor, type Ticket } from "./trade.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const named = (name: string, world = demoWorld(NOW)): DemoVault =>
  world.vaults.find((vault) => vault.state.name === name)!;
const market = (label: string) =>
  demoMarkets.find((row) => row.label === label)!;
const ticket = (change: Partial<Ticket>): Ticket => ({
  isBuy: true,
  type: "limit",
  price: "",
  size: "",
  slippage: "1",
  reduceOnly: false,
  ...change,
});

test("the sample vaults show each state a visitor can meet", () => {
  const world = demoWorld(NOW);
  assert.deepEqual(
    world.vaults.map((vault) => vault.index),
    [7n, 6n, 5n, 4n, 3n, 2n, 1n],
    "newest first, as the factory lists them",
  );
  assert.deepEqual(
    world.vaults
      .filter((vault) => vault.state.owner === demoViewer)
      .map((vault) => vault.state.name),
    ["Core Multi-Market", "Delta Neutral 실험", "Genesis Exit"],
  );
  const rows = world.vaults.map((vault) => {
    const { name, nav, depositsPriced, closedBy } = demoSummary(vault, NOW);
    return [name, nav !== null, depositsPriced, closedBy];
  });
  assert.deepEqual(rows, [
    ["Core Multi-Market", true, true, null],
    ["HYPE Basis Carry", true, true, null],
    ["BTC 추세 추종", true, false, "PriceHistoryTooShort"],
    ["Stable Lending Ladder", true, true, null], // idle: realized cash, no verifier
    ["Delta Neutral 실험", false, false, "OpenReport"], // not even a display value
    ["Genesis Exit", true, false, "NavUnavailable"], // settling an exit
    ["Momentum One", true, true, null], // what an upgraded vault says of itself
  ]);
  // Only the oldest runs other code than it was created with, and the page is told so.
  assert.deepEqual(
    world.vaults.map((vault) => demoSummary(vault, NOW).codeChanged),
    [false, false, false, false, false, false, true],
  );
  assert.equal(demoState(named("Momentum One", world), NOW).codeChanged, true);
  // One has an upgrade proposed, and the list says so before the page is opened.
  assert.deepEqual(
    world.vaults.map((vault) => demoSummary(vault, NOW).upgradePending),
    [false, false, false, true, false, false, false],
  );
  assert.equal(
    world.vaults.every((vault) => {
      const { unreadable, missed } = demoSummary(vault, NOW);
      return unreadable === null && missed === null;
    }),
    true,
  );
  // The same vault still holds an approval of the viewer's, left by a deposit that never
  // confirmed: the page names it beside the proposed upgrade. No other sample holds one.
  assert.deepEqual(
    world.vaults.map((vault) => demoState(vault, NOW).allowance),
    [0n, 0n, 0n, 250_000000n, 0n, 0n, 0n],
  );
  // Each state carries the vault's place in the factory and the account it was read for.
  assert.deepEqual(
    world.vaults.map((vault) => demoState(vault, NOW).index),
    [7n, 6n, 5n, 4n, 3n, 2n, 1n],
  );
  assert.equal(
    world.vaults.every((vault) => demoState(vault, NOW).account === demoViewer),
    true,
  );
  // A vault whose deposits are not priced answers like the contract: no NAV, no capacity, and
  // the error that closed it.
  const closed = demoState(named("BTC 추세 추종", world), NOW);
  assert.equal(closed.nav, null);
  assert.equal(closed.capacity, 0n);
  assert.equal(closed.closedBy, "PriceHistoryTooShort");
  const open = demoState(named("Core Multi-Market", world), NOW);
  assert.equal(open.nav, 110000_000000n);
  assert.equal(open.capacity, 890000_000000n);
  assert.equal(open.closedBy, null);
  assert.equal(open.readAt, NOW);
});

test("the owner's switch, a pending action, a short history and a fallen price each close deposits", () => {
  const vault = named("Core Multi-Market");
  const time = BigInt(NOW / 1000);
  assert.equal(demoPriced(vault, time), true);
  const off = {
    ...vault,
    guards: {
      ...vault.guards,
      scope: { ...vault.guards.scope, enabled: false },
    },
  };
  assert.equal(demoState(off, NOW).closedBy, "ScopeUnavailable");
  assert.equal(demoSummary(off, NOW).nav, null);
  const pending = { ...vault, state: { ...vault.state, pending: 13n } };
  assert.equal(demoState(pending, NOW).closedBy, "NavUnavailable");
  assert.equal(demoPriced(pending, time), false);
  // Nobody records a price for a day: every record leaves the window.
  assert.equal(demoPriced(vault, time + 86400n), false);
  const stale = demoState(vault, NOW + 24 * HOUR);
  assert.equal(stale.nav, null);
  assert.equal(stale.closedBy, "PriceHistoryTooShort");
  // The records were made at 110,000. Five percent below them still prices, a little more waits.
  const worth = (nav: bigint) =>
    demoState({ ...vault, state: { ...vault.state, nav } }, NOW);
  assert.equal(worth(104500_000000n).closedBy, null);
  assert.equal(worth(104499_000000n).closedBy, "PriceDropCooldown");
  assert.equal(worth(104499_000000n).capacity, 0n);
  // An Idle vault is valued at its cash whatever is pending, but takes no deposit meanwhile.
  const idle = named("Stable Lending Ladder");
  const settled = {
    ...idle.state,
    upgradePending: false,
    upgradeAt: 0n,
    upgradeTo: zeroAddress,
  };
  assert.equal(
    demoState({ ...idle, state: settled }, NOW).capacity,
    925000_000000n,
  );
  const waiting = demoState(
    { ...idle, state: { ...settled, pending: 5n } },
    NOW,
  );
  assert.equal(waiting.nav, 75000_000000n);
  assert.equal(waiting.closedBy, null);
  assert.equal(waiting.capacity, 0n);
  // The sample has an upgrade proposed: it is still valued, and takes no deposit until then.
  const proposed = demoState(idle, NOW);
  assert.equal(proposed.upgradePending, true);
  assert.equal(proposed.upgradeAt, BigInt(NOW / 1000 + 30 * 3600));
  assert.notEqual(proposed.upgradeTo, zeroAddress, "the code it would install");
  assert.equal(proposed.nav, 75000_000000n);
  assert.equal(proposed.capacity, 0n);
});

test("a report closes the vault while its holding stays outside the scope, and answering it restarts the price history", () => {
  const vault = named("Delta Neutral 실험");
  const time = BigInt(NOW / 1000);
  const draft = draftOf(vault.guards.scope);
  assert.equal(demoPriced(vault, time), false);
  assert.equal(demoState(vault, NOW).closedBy, "OpenReport");
  assert.equal(demoSummary(vault, NOW).nav, null, "not even a display value");
  assert.throws(() => demoClear(vault, 0, NOW), /ReportStands/);
  assert.throws(() => demoClear(vault, 3, NOW), /해당 신고가 없습니다/);
  // A scope change that does not register the reported DEX answers nothing.
  const other = demoConfigure(vault, addDex(draft, 5), true, NOW);
  assert.equal(other.guards.reports.length, 1);
  assert.equal(other.guards.answeredAt, 0n);
  assert.equal(demoState(other, NOW).closedBy, "OpenReport");
  // Registering it answers the report: it leaves the list in the same call, the vault is valued
  // again, and the records made so far stop being history.
  const answered = demoConfigure(vault, addDex(draft, 1), true, NOW);
  assert.deepEqual(answered.guards.scope.dexes, [0, 1]);
  assert.equal(answered.guards.scope.version, 2n);
  assert.deepEqual(answered.guards.reports, []);
  assert.equal(answered.guards.answeredAt, time);
  assert.equal(
    answered.guards.records.length,
    4,
    "kept: they still set the bar",
  );
  assert.equal(demoState(answered, NOW).closedBy, "PriceHistoryTooShort");
  assert.equal(demoSummary(answered, NOW).nav, 20400_000000n);
  assert.equal(demoSummary(answered, NOW).depositsPriced, false);
  // Waiting does not help: a record has to be made after the answer and grow half a window old.
  assert.equal(
    demoState(answered, NOW + 8 * HOUR).closedBy,
    "PriceHistoryTooShort",
    "the oldest record is 23 hours old, and from before the answer",
  );
  const recorded = demoRecord(answered, NOW + HOUR);
  assert.equal(
    demoState(recorded, NOW + 13 * HOUR - 1000).closedBy,
    "PriceHistoryTooShort",
  );
  const reopened = demoState(recorded, NOW + 13 * HOUR);
  assert.equal(reopened.closedBy, null);
  assert.equal(reopened.nav, 20400_000000n);
  // An entry that still holds something cannot be taken out again.
  assert.throws(
    () =>
      demoConfigure(
        answered,
        removeDex(draftOf(answered.guards.scope), 1),
        true,
        NOW,
      ),
    /ScopeInUse/,
  );
  // Emptied first, the reported DEX no longer closes anything: registering it then only drops
  // the report, and the history stays.
  const emptied = {
    ...vault,
    account: {
      ...vault.account,
      positions: vault.account.positions.filter((row) => row.dex !== 1),
      margins: vault.account.margins.filter((row) => row.dex !== 1),
    },
  };
  assert.equal(demoState(emptied, NOW).closedBy, null);
  const tidied = demoConfigure(emptied, addDex(draft, 1), true, NOW);
  assert.deepEqual(tidied.guards.reports, []);
  assert.equal(tidied.guards.answeredAt, 0n);
  assert.equal(demoState(tidied, NOW).closedBy, null);
  // An unrenewed report lapses within a day: the vault is valued again and it can be dropped.
  assert.equal(demoPriced(vault, time + 19n * 3600n), false);
  const later = demoSummary(vault, NOW + 21 * HOUR);
  assert.equal(later.nav, 20400_000000n);
  assert.equal(later.depositsPriced, true);
  assert.deepEqual(demoClear(vault, 0, NOW + 21 * HOUR).guards.reports, []);
  // Registering the venue of a lapsed report drops it too, and the history stays.
  const late = demoConfigure(vault, addDex(draft, 1), true, NOW + 21 * HOUR);
  assert.deepEqual(late.guards.reports, []);
  assert.equal(late.guards.answeredAt, 0n);
  assert.equal(demoState(late, NOW + 21 * HOUR).closedBy, null);
});

test("a registered token stays reported while its pair pays nothing and the holding sells for 20 USDC elsewhere", () => {
  // The account holds 500 HYPE, registered on its USDC market, where the demo pays 30 each.
  const base = named("Core Multi-Market");
  const time = BigInt(NOW / 1000);
  const [usdc, hype] = base.guards.scope.tokens;
  const report = {
    index: 0,
    kind: "token" as const,
    id: hype.index,
    coreVault: zeroAddress,
    expiresAt: time + 3600n,
  };
  const scoped = (tokens: (typeof hype)[], reports = [report]): DemoVault => ({
    ...base,
    guards: {
      ...base.guards,
      scope: { ...base.guards.scope, tokens },
      reports,
    },
  });
  const holding = (vault: DemoVault, total: string): DemoVault => ({
    ...vault,
    account: {
      ...base.account,
      balances: [{ token: hype.index, coin: "HYPE", total, hold: "0.0" }],
    },
  });
  const closed = (vault: DemoVault) => demoState(vault, NOW).closedBy;
  // Held and not registered: the report stands for whatever sells for the minimum order.
  const outside = scoped([usdc]);
  assert.equal(closed(outside), "OpenReport");
  assert.equal(closed(holding(outside, "0.34")), "OpenReport", "10.20 USDC");
  assert.equal(closed(holding(outside, "0.33")), null, "9.90 USDC");
  // Registered on its market: the pair pays for the holding, and the scope answers for it.
  const counted = scoped([usdc, hype]);
  assert.equal(closed(counted), null);
  assert.equal(closed(holding(counted, "0.34")), null);
  // A remainder its own pair values under the minimum is not hidden either: nowhere does it
  // sell for twice the minimum.
  assert.equal(closed(holding(counted, "0.33")), null);
  // Registered on a pair that is no market: counted as nothing, so the holding can still be
  // named, from 20 USDC up.
  const dead = { ...hype, usdcSpot: 999 };
  const unpaid = scoped([usdc, dead]);
  assert.equal(closed(unpaid), "OpenReport");
  assert.throws(() => demoClear(unpaid, 0, NOW), /ReportStands/);
  assert.equal(closed(holding(unpaid, "0.66666667")), "OpenReport");
  assert.equal(closed(holding(unpaid, "0.66666666")), null, "19.9999998 USDC");
  assert.equal(
    closed(holding(unpaid, "0.34")),
    null,
    "enough only unregistered",
  );
  // Sold: nothing is held, so nothing stands. USDC is always counted in full.
  const sold = { ...base.account, balances: [] };
  assert.equal(closed({ ...outside, account: sold }), null);
  assert.equal(closed(scoped([usdc, hype], [{ ...report, id: 0 }])), null);

  // A save that registers the token on a pair that pays nothing lifts nothing: the report
  // stays, the vault stays closed and no history restarts.
  const draft = draftOf(outside.guards.scope);
  const kept = demoConfigure(outside, addToken(draft, dead), true, NOW);
  assert.equal(kept.guards.scope.version, base.guards.scope.version + 1n);
  assert.equal(kept.guards.reports.length, 1);
  assert.equal(kept.guards.answeredAt, 0n);
  assert.equal(closed(kept), "OpenReport");
  // On the pair that pays, the same save lifts the report, and that restarts the history.
  const answered = demoConfigure(outside, addToken(draft, hype), true, NOW);
  assert.deepEqual(answered.guards.reports, []);
  assert.equal(answered.guards.answeredAt, time);
  assert.equal(closed(answered), "PriceHistoryTooShort");
  // So does moving a registered token from the pair that pays nothing to the one that pays.
  const moved = demoConfigure(
    unpaid,
    { ...draftOf(unpaid.guards.scope), tokens: [usdc, hype] },
    true,
    NOW,
  );
  assert.deepEqual(moved.guards.reports, []);
  assert.equal(moved.guards.answeredAt, time);
  // A report that had stopped standing by itself is only dropped: the save lifted nothing.
  for (const quiet of [
    { ...outside, account: sold },
    holding(outside, "0.33"),
  ]) {
    assert.equal(closed(quiet), null);
    const tidied = demoConfigure(quiet, addToken(draft, hype), true, NOW);
    assert.deepEqual(tidied.guards.reports, []);
    assert.equal(tidied.guards.answeredAt, 0n);
    assert.equal(closed(tidied), null);
  }
  // A lapsed report on a registered token is dropped by any save, and the history stays.
  const lapsed = scoped([usdc, dead], [{ ...report, expiresAt: time }]);
  assert.equal(closed(lapsed), null);
  const dropped = demoConfigure(
    lapsed,
    draftOf(lapsed.guards.scope),
    true,
    NOW,
  );
  assert.deepEqual(dropped.guards.reports, []);
  assert.equal(dropped.guards.answeredAt, 0n);
});

test("a price sample is added an eighth of a window after the last, and only raised before", () => {
  let vault = named("Core Multi-Market");
  const richer = (profit: bigint) => ({
    ...vault,
    state: { ...vault.state, nav: vault.state.nav! + profit },
  });
  // Two hours after the last sample: the same or a lower price changes nothing.
  assert.throws(() => demoRecord(vault, NOW), /PriceRecordTooSoon/);
  assert.throws(() => demoRecord(richer(-500_000000n), NOW), /TooSoon/);
  // A higher one replaces that sample's price and keeps its time.
  const raised = demoRecord(richer(1000_000000n), NOW).guards.records;
  assert.equal(raised.length, 4);
  assert.equal(raised.at(-1)!.time, vault.guards.records.at(-1)!.time);
  assert.ok(raised.at(-1)!.price > vault.guards.records.at(-1)!.price);
  assert.deepEqual(raised.slice(0, 3), vault.guards.records.slice(0, 3));
  // Three hours is exactly an eighth of the day-long window: the next sample is not due yet.
  assert.throws(() => demoRecord(vault, NOW + HOUR), /PriceRecordTooSoon/);
  for (let hours = 2; hours <= 22; hours += 4)
    vault = demoRecord(vault, NOW + hours * HOUR);
  assert.equal(vault.guards.records.length, 8);
  assert.equal(
    vault.guards.records.at(-1)!.time,
    BigInt((NOW + 22 * HOUR) / 1000),
  );
  // A Vault without shares has no price.
  assert.throws(
    () =>
      demoRecord(
        { ...vault, state: { ...vault.state, supply: 0n } },
        NOW + 30 * HOUR,
      ),
    /NoShares/,
  );
});

test("neither the owner's switch, a report nor a pending action stops a price record, and an idle vault records its cash", () => {
  const reported = named("Delta Neutral 실험");
  assert.equal(demoState(reported, NOW).closedBy, "OpenReport");
  const kept = demoRecord(reported, NOW + HOUR).guards.records;
  assert.equal(kept.length, 5);
  assert.deepEqual(kept.at(-1), {
    price: recordedPrice(20400_000000n, 20000_000000000n),
    time: BigInt((NOW + HOUR) / 1000),
  });
  const vault = named("Core Multi-Market");
  const off = { ...vault.guards.scope, enabled: false };
  assert.equal(
    demoRecord(
      { ...vault, guards: { ...vault.guards, scope: off } },
      NOW + 2 * HOUR,
    ).guards.records.length,
    5,
  );
  const pending = { ...vault, state: { ...vault.state, pending: 13n } };
  assert.equal(demoState(pending, NOW).closedBy, "NavUnavailable");
  assert.equal(demoRecord(pending, NOW + 2 * HOUR).guards.records.length, 5);
  // An Idle vault issues at its cash alone: that is recorded, with no scope registered at all.
  const idle = named("Stable Lending Ladder");
  assert.equal(idle.guards.scope.version, 0n);
  const cash = {
    price: recordedPrice(75000_000000n, 75000_000000000n),
    time: BigInt(NOW / 1000),
  };
  assert.deepEqual(demoRecord(idle, NOW).guards.records, [cash]);
  assert.deepEqual(
    demoRecord({ ...idle, state: { ...idle.state, nav: 80000_000000n } }, NOW)
      .guards.records,
    [cash],
    "not the scope's value",
  );
  // Outside Idle a Vault that never registered a scope has nothing to price.
  assert.throws(
    () => demoRecord({ ...idle, state: { ...idle.state, phase: 4 } }, NOW),
    /ScopeUnavailable/,
  );
});

test("a created vault waits for Core, then for its scope and its price history", () => {
  const made = demoCreate(
    demoWorld(NOW),
    { name: "나의 USDC 볼트", fee: 1000n, minimum: 10_000000n },
    NOW,
  );
  let vault = made.world.vaults[0];
  assert.equal(vault.address, made.vault);
  assert.equal(vault.index, 8n);
  assert.equal(vault.state.owner, demoViewer);
  assert.equal(vault.state.phase, 1);
  assert.equal(vault.state.shares, 100_000000000n);
  assert.throws(
    () => demoSubmit(vault, { kind: "agent", agent: demoAgent(vault) }),
    /CoreNotReady/,
  );
  vault = demoSync(vault);
  assert.equal(vault.state.phase, 2);
  assert.equal(vault.state.pending, 0n);
  assert.equal(demoState(vault, NOW).nav, null, "nothing registered yet");
  assert.equal(demoState(vault, NOW).closedBy, "ScopeUnavailable");
  assert.throws(() => demoRecord(vault, NOW), /ScopeUnavailable/);
  assert.throws(() => demoSync(vault), /EvidenceRejected/);

  vault = demoConfigure(vault, draftOf(vault.guards.scope), true, NOW);
  assert.equal(vault.guards.answeredAt, 0n, "no report was answered");
  vault = demoRecord(vault, NOW);
  assert.equal(
    demoState(vault, NOW + 11 * HOUR).closedBy,
    "PriceHistoryTooShort",
  );
  assert.equal(demoState(vault, NOW + 12 * HOUR).nav, 100_000000n);
  const world = patchVault(made.world, made.vault, () => vault);
  assert.equal(world.vaults[0], vault);
  assert.equal(world.vaults.length, 8);
});

test("a redeem request takes its part of the basis, and an idle vault settles it at once", () => {
  // The viewer holds 500 shares with a basis of 512.30 USDC in someone else's vault.
  const carry = named("HYPE Basis Carry");
  assert.throws(() => demoRequest(carry, 0n), /InvalidAmount/);
  assert.throws(() => demoRequest(carry, 500_000000001n), /InvalidAmount/);
  const asked = demoRequest(carry, 200_000000000n);
  assert.equal(asked.state.shares, 300_000000000n);
  assert.equal(asked.state.basis, 307_380000n);
  assert.deepEqual(asked.redeeming, {
    shares: 200_000000000n,
    basis: 204_920000n,
    gross: 0n,
  });
  assert.equal(asked.state.request, 1n);
  assert.equal(asked.state.supply, carry.state.supply, "burned at settlement");
  assert.equal(asked.state.claimShares, 0n, "waits for the operator");
  assert.throws(() => demoRequest(asked, 1n), /OutstandingRequest/);
  assert.throws(() => demoClaim(asked), /NotClaimable/);
  const exiting = { ...carry, state: { ...carry.state, phase: 5 } };
  assert.throws(() => demoRequest(exiting, 1n), /WrongPhase/);

  // The same vault holding only cash: the request is paid at the cash price in the same call,
  // less the 15% fee on the gain over its basis.
  const idle = {
    ...carry,
    state: { ...carry.state, phase: 3, cash: 254300_120000n },
  };
  const paid = demoRequest(idle, 500_000000000n);
  assert.equal(paid.state.claimShares, 500_000000000n);
  assert.equal(paid.state.claimNet, 527_168129n);
  assert.equal(paid.state.reserved, 529_791916n);
  assert.equal(paid.state.cash, 253770_328084n);
  assert.equal(paid.state.nav, 253770_328084n);
  assert.equal(paid.state.supply, 239500_000000000n);
  const claimed = demoClaim(paid);
  assert.equal(claimed.state.request, 0n);
  assert.equal(claimed.state.claimShares, 0n);
  assert.equal(claimed.state.claimNet, 0n);
  assert.equal(claimed.state.reserved, 0n);
  assert.equal(claimed.redeeming, null);
  assert.throws(() => demoClaim(claimed), /NotClaimable/);
});

test("an exit settles only with nothing pending, Core empty and a price history behind its cash", () => {
  const exit = named("Genesis Exit");
  const why = (change: Partial<DemoVault>, at = NOW) => {
    try {
      demoSettle({ ...exit, ...change }, at);
      return "settled";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const state = (change: Partial<DemoVault["state"]>) => ({
    state: { ...exit.state, ...change },
  });
  const guards = (change: Partial<DemoVault["guards"]>) => ({
    guards: { ...exit.guards, ...change },
  });
  assert.equal(why({}), "settled");
  assert.equal(why(state({ phase: 4 })), "WrongPhase()");
  assert.equal(why(state({ pending: 9n })), "PendingCoreAction()");
  assert.equal(
    why(state({ agent: demoAgent(exit) })),
    "PendingCoreAction()",
    "an agent could still trade",
  );
  // An exit needs a registered scope, not the owner's switch.
  const scope = exit.guards.scope;
  assert.equal(why(guards({ scope: { ...scope, enabled: false } })), "settled");
  assert.equal(
    why(guards({ scope: { ...scope, version: 0n } })),
    "ScopeUnavailable()",
  );
  const elsewhere = named("Delta Neutral 실험");
  assert.equal(
    why({
      ...guards({ reports: elsewhere.guards.reports }),
      account: elsewhere.account,
    }),
    "OpenReport()",
  );
  const left = [{ token: 0, coin: "USDC", total: "12.5", hold: "0.0" }];
  assert.equal(
    why({ account: { ...exit.account, balances: left } }),
    "CoreNotFlat()",
  );
  // The same history as issuance: a record inside the window at least half a window old.
  const records = exit.guards.records;
  assert.equal(why(guards({ records: [] })), "PriceHistoryTooShort()");
  assert.equal(
    why(guards({ records: records.slice(-1) })),
    "PriceHistoryTooShort()",
    "four hours old",
  );
  assert.equal(why({}, NOW + 8 * HOUR), "settled", "the oldest is a day old");
  assert.equal(
    why({}, NOW + 21 * HOUR),
    "PriceHistoryTooShort()",
    "all lapsed",
  );
  // After an answered report only later records are that history: here the one four hours old.
  const answeredAt = (hoursAgo: number) =>
    guards({ answeredAt: BigInt((NOW - hoursAgo * HOUR) / 1000) });
  assert.equal(why(answeredAt(5)), "PriceHistoryTooShort()");
  assert.equal(why(answeredAt(5), NOW + 8 * HOUR), "settled");
  assert.equal(
    why(answeredAt(13)),
    "settled",
    "a later record is 12 hours old",
  );
  // The records were made at 1 USDC a share: cash 5% below still settles, a little less waits.
  assert.equal(why(state({ cash: 11400_000000n })), "settled");
  assert.equal(why(state({ cash: 11399_000000n })), "PriceDropCooldown()");
  // An exit of a Vault without shares pays nobody: no record can be made, and none is needed.
  const empty = { redeeming: null, ...state({ supply: 0n, shares: 0n }) };
  assert.equal(why({ ...empty, ...guards({ records: [] }) }), "settled");
  assert.equal(
    why({ ...empty, account: { ...exit.account, balances: left } }),
    "CoreNotFlat()",
    "Core still has to be empty",
  );

  // Settled: the Vault holds only cash, and the viewer's 250 requested shares can be claimed.
  const idle = demoSettle(exit, NOW);
  assert.equal(idle.state.phase, 3);
  assert.equal(idle.state.claimShares, 250_000000000n);
  assert.equal(idle.state.claimNet, 250_000000n, "the owner pays no fee");
  assert.equal(idle.state.reserved, 250_000000n);
  assert.equal(idle.state.cash, 11750_000000n);
  assert.equal(idle.state.supply, 11750_000000000n);
  assert.equal(demoState(idle, NOW).nav, 11750_000000n);
  assert.equal(demoState(idle, NOW).closedBy, null);
  assert.throws(() => demoSettle(idle, NOW), /WrongPhase/);
  const claimed = demoClaim(idle);
  assert.equal(claimed.state.reserved, 0n);
  assert.equal(claimed.state.request, 0n);
  assert.equal(claimed.state.shares, 750_000000000n);
});

test("beginning an exit closes deposits, and the exit then waits for the agent and for Core", () => {
  const vault = named("Core Multi-Market");
  const exiting = demoBeginExit(vault);
  assert.equal(exiting.state.phase, 5);
  assert.equal(demoState(exiting, NOW).closedBy, "NavUnavailable");
  assert.throws(() => demoBeginExit(exiting), /WrongPhase/);
  assert.throws(
    () => demoBeginExit(named("Stable Lending Ladder")),
    /WrongPhase/,
  );
  const created = demoCreate(
    demoWorld(NOW),
    { name: "v", fee: 0n, minimum: 1n },
    NOW,
  ).world.vaults[0];
  assert.throws(() => demoBeginExit(created), /PendingCoreAction/);
  // The agent is still registered, and after its removal the positions are still open.
  assert.throws(() => demoSettle(exiting, NOW), /PendingCoreAction/);
  const revoked = demoSync(demoSubmit(exiting, { kind: "revoke" }));
  assert.throws(() => demoSettle(revoked, NOW), /CoreNotFlat/);
  // A price can still be recorded while the exit goes on.
  assert.equal(demoRecord(revoked, NOW + 2 * HOUR).guards.records.length, 5);
});

test("an agent registration is pending until confirmed, and an address is used only once", () => {
  let vault = demoSync(
    demoCreate(demoWorld(NOW), { name: "v", fee: 0n, minimum: 1n }, NOW).world
      .vaults[0],
  );
  const agent = demoAgent(vault);
  vault = demoSubmit(vault, { kind: "agent", agent });
  assert.equal(vault.state.pending, 2n);
  assert.equal(
    vault.state.phase,
    4,
    "a Core action makes a Ready vault Active",
  );
  assert.equal(
    vault.state.agent,
    zeroAddress,
    "not the agent before confirmation",
  );
  assert.throws(
    () => demoSubmit(vault, { kind: "revoke" }),
    /PendingCoreAction/,
  );
  vault = demoSync(vault);
  assert.equal(vault.state.agent, agent);
  assert.throws(
    () => demoSubmit(vault, { kind: "agent", agent }),
    /AgentAlreadyUsed/,
  );
  assert.notEqual(demoAgent(vault), agent);

  vault = demoSync(demoSubmit(vault, { kind: "revoke" }));
  assert.equal(vault.state.agent, zeroAddress);
  assert.throws(() => demoSubmit(vault, { kind: "revoke" }), /InvalidReceiver/);
  assert.throws(
    () => demoSubmit(vault, { kind: "builderFee", rate: 101 }),
    /InvalidAmount/,
  );
  vault = demoSubmit(vault, { kind: "builderFee", rate: 25 });
  assert.equal(vault.approvedFee, 0, "not approved before confirmation");
  assert.equal(demoSync(vault).approvedFee, 25);
});

test("a simulated order rests away from the mid, fills at it, and can be cancelled", () => {
  const vault = named("Core Multi-Market");
  const btc = market("BTC-PERP");
  const rest = demoExchange(
    vault,
    buildOrder(btc, ticket({ price: "59000", size: "0.01" }), undefined).action,
    NOW,
  );
  assert.deepEqual(rest.results, [{ kind: "resting", oid: 77_000_001 }]);
  assert.deepEqual(rest.vault.account.orders.at(-1), {
    dex: 0,
    coin: "BTC",
    isBuy: true,
    price: "59000",
    size: "0.01",
    oid: 77_000_001,
    time: NOW,
    reduceOnly: false,
  });
  assert.equal(vault.account.orders.length, 2, "the sample is not edited");

  const cancel = cancelFor(demoMarkets, { coin: "BTC", oid: 77_000_001 });
  const cancelled = demoExchange(rest.vault, cancel, NOW);
  assert.deepEqual(cancelled.results, [{ kind: "ok" }]);
  assert.equal(cancelled.vault.account.orders.length, 2);
  assert.equal(
    demoExchange(cancelled.vault, cancel, NOW).results[0].kind,
    "error",
  );

  // Long 0.25 at 58000, buying 0.05 at the 60000 mid: size 0.3 at the weighted entry.
  const fill = demoExchange(
    rest.vault,
    buildOrder(btc, ticket({ price: "61000", size: "0.05" }), undefined).action,
    NOW,
  );
  assert.deepEqual(fill.results, [
    { kind: "filled", oid: 77_000_002, size: "0.05", price: "60000" },
  ]);
  assert.deepEqual(fill.vault.account.positions, [
    {
      dex: 0,
      coin: "BTC",
      size: "0.3",
      entryPrice: "58333.33333333",
      value: "18000",
      pnl: "500",
      liquidationPrice: null,
    },
  ]);
  const taker = demoExchange(
    vault,
    buildOrder(
      market("ETH-PERP"),
      ticket({ type: "market", isBuy: false, size: "1.5" }),
      "2500",
    ).action,
    NOW,
  );
  assert.deepEqual(taker.results, [
    { kind: "filled", oid: 77_000_001, size: "1.5", price: "2500" },
  ]);
  assert.deepEqual(taker.vault.account.positions[1], {
    dex: 0,
    coin: "ETH",
    size: "-1.5",
    entryPrice: "2500",
    value: "3750",
    pnl: "0",
    liquidationPrice: null,
  });
});

test("a stop on the whole position is listed without a size and goes with the position", () => {
  const vault = named("Core Multi-Market");
  const stop = vault.account.orders.find((order) => order.triggerPrice)!;
  assert.deepEqual(
    [stop.coin, stop.type, stop.size, stop.reduceOnly],
    ["BTC", "Stop Market", "0.0", true],
  );
  const sell = (size: string) =>
    demoExchange(
      vault,
      buildOrder(
        market("BTC-PERP"),
        ticket({ type: "market", isBuy: false, size, reduceOnly: true }),
        "60000",
      ).action,
      NOW,
    ).vault.account;
  const reduced = sell("0.1");
  assert.equal(reduced.positions[0].size, "0.15");
  assert.ok(reduced.orders.includes(stop), "kept while a position remains");
  const closed = sell("0.25");
  assert.deepEqual(closed.positions, []);
  assert.deepEqual(
    closed.orders.map((order) => order.oid),
    [76_999_114],
    "the resting ETH order stays",
  );
});

test("the simulated exchange refuses what the real one would", () => {
  const vault = named("Core Multi-Market");
  const btc = market("BTC-PERP");
  const send = (change: Partial<Ticket>, mid?: string) =>
    demoExchange(vault, buildOrder(btc, ticket(change), mid).action, NOW);
  const refused = (change: Partial<Ticket>) => {
    const { results, vault: after } = send(change);
    assert.equal(
      after.account,
      vault.account,
      "a refused order changes nothing",
    );
    return results[0].kind === "error" ? results[0].message : "";
  };
  assert.match(
    refused({ type: "post", price: "60000", size: "0.01" }),
    /Post only order would have immediately matched/,
  );
  assert.match(
    refused({ price: "60000", size: "0.01", reduceOnly: true }),
    /Reduce only order would increase position/,
  );
  // A closing order larger than the position only closes it.
  const closed = send({
    isBuy: false,
    price: "59000",
    size: "1",
    reduceOnly: true,
  });
  assert.deepEqual(closed.results, [
    { kind: "filled", oid: 77_000_001, size: "0.25", price: "60000" },
  ]);
  assert.deepEqual(closed.vault.account.positions, []);
  // A reduce-only order under the minimum is the exchange's to judge: here it closes.
  assert.equal(
    send({ isBuy: false, price: "60000", size: "0.0001", reduceOnly: true })
      .results[0].kind,
    "filled",
  );
  assert.match(
    demoExchange(
      vault,
      {
        type: "order",
        orders: [
          {
            a: 0,
            b: true,
            p: "60000",
            s: "0.0001",
            r: false,
            t: { limit: { tif: "Gtc" } },
          },
          {
            a: 424242,
            b: true,
            p: "1",
            s: "100",
            r: false,
            t: { limit: { tif: "Gtc" } },
          },
          {
            a: 0,
            b: true,
            p: "59000",
            s: "0.01",
            r: false,
            t: { limit: { tif: "Ioc" } },
          },
        ],
        grouping: "na",
      },
      NOW,
    )
      .results.map((result) =>
        result.kind === "error" ? result.message : "ok",
      )
      .join(" | "),
    /minimum value of \$10\. \| Invalid asset\. \| Order could not immediately match/,
  );
});

test("simulated spot fills move both balances exactly, and only what is held can be sold", () => {
  const vault = named("Core Multi-Market");
  const hype = market("HYPE/USDC");
  const send = (from: DemoVault, change: Partial<Ticket>) =>
    demoExchange(from, buildOrder(hype, ticket(change), undefined).action, NOW);
  const bought = send(vault, { price: "30.5", size: "10.25" });
  assert.deepEqual(bought.results, [
    { kind: "filled", oid: 77_000_001, size: "10.25", price: "30" },
  ]);
  assert.deepEqual(
    bought.vault.account.balances.map((row) => [row.coin, row.total]),
    [
      ["USDC", "19482"],
      ["HYPE", "510.25"],
    ],
  );
  const sold = send(bought.vault, {
    isBuy: false,
    price: "29",
    size: "510.25",
  });
  assert.deepEqual(
    sold.vault.account.balances.map((row) => [row.coin, row.total]),
    [["USDC", "34789.5"]],
    "an emptied balance is no longer listed",
  );
  const short = send(sold.vault, { isBuy: false, price: "29", size: "1" });
  assert.deepEqual(short.results, [
    { kind: "error", message: "Insufficient spot balance asset=HYPE" },
  ]);
  const poor = send(sold.vault, { price: "30", size: "1200" });
  assert.deepEqual(poor.results, [
    { kind: "error", message: "Insufficient spot balance asset=USDC" },
  ]);
  // A token bought for the first time appears under its own name.
  const purr = demoExchange(
    sold.vault,
    buildOrder(
      market("PURR/USDC"),
      ticket({ price: "0.2", size: "100" }),
      undefined,
    ).action,
    NOW,
  );
  assert.deepEqual(
    purr.vault.account.balances.map((row) => [row.token, row.coin, row.total]),
    [
      [0, "USDC", "34769.5"],
      [1, "PURR", "100"],
    ],
  );
});
