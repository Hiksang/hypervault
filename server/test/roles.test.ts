import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { VaultFault, type Chain } from "../src/chain.ts";
import { Busy, canPost, createRoles } from "../src/roles.ts";
import { otherVault, stranger, stubChain, vault } from "./helpers.ts";
import type { Ledger } from "./helpers.ts";
const owner = `0x${"01".repeat(20)}` as Address;
const depositor = `0x${"02".repeat(20)}` as Address;
const account = (i: number) =>
  `0x${i.toString(16).padStart(40, "0")}` as Address;
// What a vault that will not answer makes the chain reject with.
const fault = () => new VaultFault(new Error("execution reverted"));
function setup() {
  const ledger: Ledger = {
    vaults: new Map([[vault, { owner, depositors: new Set([depositor]) }]]),
    failing: false,
    reads: 0,
  };
  const clock = { ms: 0 };
  const logs: string[] = [];
  return {
    ledger,
    clock,
    logs,
    roles: createRoles(
      stubChain(ledger),
      () => clock.ms,
      (line) => logs.push(line),
    ),
  };
}
test("visitors may post only when posting is open", () => {
  assert.equal(canPost("owner", "members"), true);
  assert.equal(canPost("depositor", "members"), true);
  assert.equal(canPost("visitor", "members"), false);
  assert.equal(canPost("visitor", "open"), true);
});
test("the role follows the chain: owner, depositor, otherwise visitor", async () => {
  const { roles } = setup();
  assert.equal(await roles.roleOf(vault, owner), "owner");
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  assert.equal(await roles.roleOf(vault, stranger), "visitor");
});
test("an owner address in any letter case from the chain still matches", async () => {
  const { ledger, roles } = setup();
  const mixed = `0x${"aB".repeat(20)}` as Address;
  ledger.vaults.set(otherVault, { owner: mixed, depositors: new Set() });
  assert.equal(await roles.ownerOf(otherVault), mixed.toLowerCase());
  assert.equal(
    await roles.roleOf(otherVault, mixed.toLowerCase() as Address),
    "owner",
  );
});
test("a vault is remembered once seen; a non-vault is asked about again", async () => {
  const { ledger, roles } = setup();
  assert.equal(await roles.isVault(vault), true);
  assert.equal(await roles.isVault(vault), true);
  assert.equal(ledger.reads, 1);
  assert.equal(await roles.isVault(otherVault), false);
  ledger.vaults.set(otherVault, { owner, depositors: new Set() });
  assert.equal(await roles.isVault(otherVault), true);
  assert.equal(ledger.reads, 3);
});
test("a failed read is never remembered as an answer", async () => {
  for (const failure of [undefined, fault()]) {
    const { ledger, clock, roles } = setup();
    ledger.failure = failure;
    ledger.failing = true;
    await assert.rejects(roles.isVault(vault));
    await assert.rejects(roles.roleOf(vault, depositor));
    await assert.rejects(roles.ownerOf(vault));
    ledger.failing = false;
    clock.ms += 5_000;
    assert.equal(await roles.isVault(vault), true);
    assert.equal(await roles.roleOf(vault, depositor), "depositor");
    assert.equal(await roles.ownerOf(vault), owner);
    // A vault already seen stays a vault while the chain is down.
    ledger.failing = true;
    assert.equal(await roles.isVault(vault), true);
  }
});
test("an RPC failure is not held against the vault", async () => {
  const { ledger, logs, roles } = setup();
  ledger.failing = true;
  for (let i = 0; i < 3; i++) await assert.rejects(roles.ownerOf(vault));
  // Each attempt reached the RPC, and the failure was reported.
  assert.equal(ledger.reads, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /^chain read failed \(0x[0-9a-f]{40}\): "/);
  // The moment the RPC is back the vault is read, with no pause.
  ledger.failing = false;
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
});
test("a vault that will not answer is left alone for five seconds", async () => {
  const { ledger, clock, logs, roles } = setup();
  ledger.vaults.set(otherVault, { owner, depositors: new Set() });
  ledger.failure = fault();
  ledger.failing = true;
  await assert.rejects(roles.ownerOf(vault));
  assert.equal(ledger.reads, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /^vault read failed \(0x[0-9a-f]{40}\): "/);
  // It would answer now, but nothing is asked of it meanwhile: every read
  // fails without a call and without another line.
  ledger.failing = false;
  for (const at of [0, 1, 4_999]) {
    clock.ms = at;
    await assert.rejects(roles.ownerOf(vault));
    await assert.rejects(roles.roleOf(vault, depositor));
    await assert.rejects(roles.roleOf(vault, stranger));
  }
  assert.equal(ledger.reads, 1);
  assert.equal(logs.length, 1);
  // Other vaults are read as usual.
  assert.equal(await roles.ownerOf(otherVault), owner);
  clock.ms = 5_000;
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  assert.equal(logs.length, 1);
});
test("after the pause one read tests the vault, and a burst costs that one read while it keeps failing", async () => {
  const state = { faulty: true, inFlight: 0, peak: 0, reads: 0 };
  // A chain that takes a moment to answer and notes how many reads overlap.
  const slow = async <T>(answer: T): Promise<T> => {
    state.reads += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    await new Promise((done) => setImmediate(done));
    state.inFlight -= 1;
    if (state.faulty) throw fault();
    return answer;
  };
  const chain: Chain = {
    isVault: () => slow(true),
    ownerOf: () => slow(owner),
    isDepositor: (_, wallet) => slow(wallet === depositor),
  };
  const clock = { ms: 0 };
  const logs: string[] = [];
  const roles = createRoles(
    chain,
    () => clock.ms,
    (line) => logs.push(line),
  );
  const burst = (first = 0) =>
    Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        roles.roleOf(vault, account(first + i)),
      ),
    );
  const failures = (results: PromiseSettledResult<unknown>[]) =>
    results.filter((result) => result.status === "rejected").length;
  // The first burst shares the owner read, which fails.
  assert.equal(failures(await burst()), 6);
  assert.deepEqual([state.reads, logs.length], [1, 1]);
  // During the pause nothing is read at all.
  clock.ms = 4_999;
  assert.equal(failures(await burst()), 6);
  assert.equal(state.reads, 1);
  // After it, a burst costs one read however many callers there are.
  clock.ms = 5_000;
  assert.equal(failures(await burst()), 6);
  assert.deepEqual([state.reads, logs.length], [2, 2]);
  // The owner read answers, which ends the pause, and the balance reads of
  // the next burst then fail: that burst is read in full, as it would be
  // from any vault that had not failed before.
  state.faulty = false;
  clock.ms = 10_000;
  assert.equal(await roles.ownerOf(vault), owner);
  state.faulty = true;
  state.peak = 0;
  assert.equal(failures(await burst()), 6);
  assert.deepEqual([state.reads, state.peak, logs.length], [9, 6, 3]);
  // From then on it is one balance read per pause again.
  for (const [at, reads, lines] of [
    [15_000, 10, 4],
    [20_000, 11, 5],
  ] as const) {
    clock.ms = at;
    state.peak = 0;
    assert.equal(failures(await burst()), 6);
    assert.deepEqual([state.reads, state.peak, logs.length], [reads, 1, lines]);
  }
  // Once the test read is answered, those who waited for it are read too,
  // all at once, and the vault is read freely from there on.
  state.faulty = false;
  clock.ms = 25_000;
  state.peak = 0;
  assert.equal(failures(await burst()), 0);
  assert.deepEqual([state.reads, state.peak], [17, 5]);
  assert.equal(failures(await burst(100)), 0);
  assert.deepEqual([state.reads, state.peak, logs.length], [23, 6, 5]);
});
test("requests that come while a vault is tested wait for that one read and no longer", async () => {
  // A vault that failed once, and whose later reads end when the test says.
  const answers: ((held: boolean) => void)[] = [];
  const failures: ((error: unknown) => void)[] = [];
  let faulty = true;
  const chain: Chain = {
    isVault: async () => true,
    ownerOf: async () => owner,
    isDepositor: () =>
      faulty
        ? Promise.reject(fault())
        : new Promise((resolve, reject) => {
            answers.push(resolve);
            failures.push(reject);
          }),
  };
  const clock = { ms: 0 };
  const logs: string[] = [];
  const roles = createRoles(
    chain,
    () => clock.ms,
    (line) => logs.push(line),
  );
  const tick = () => new Promise((done) => setImmediate(done));
  const ask = (first: number, count: number) =>
    Array.from({ length: count }, (_, i) =>
      roles.roleOf(vault, account(first + i)),
    );
  await assert.rejects(roles.roleOf(vault, account(0)));
  faulty = false;
  clock.ms = 5_000;
  // One read goes out to test the vault. Six more requests send nothing.
  const first = roles.roleOf(vault, account(1));
  const behind = ask(100, 6);
  await tick();
  assert.equal(answers.length, 1);
  // It is answered: the six are read at once, none behind another.
  answers[0]?.(true);
  assert.equal(await first, "depositor");
  await tick();
  assert.equal(answers.length, 7);
  for (const answer of answers.slice(1)) answer(false);
  assert.deepEqual(new Set(await Promise.all(behind)), new Set(["visitor"]));
  // When the test read fails at the vault, those waiting fail with it and
  // are never sent.
  faulty = true;
  await assert.rejects(roles.roleOf(vault, account(2)));
  faulty = false;
  clock.ms = 10_000;
  const second = roles.roleOf(vault, account(3));
  const refused = ask(200, 6);
  await tick();
  assert.equal(answers.length, 8);
  failures[7]?.(fault());
  await assert.rejects(second, /vault read failed/);
  for (const lookup of refused) await assert.rejects(lookup, /left alone/);
  assert.equal(answers.length, 8);
  // When the RPC fails the test read, nothing is held against the vault:
  // those waiting are read, and no pause starts.
  clock.ms = 15_000;
  const third = roles.roleOf(vault, account(4));
  const waiting = ask(300, 5);
  await tick();
  assert.equal(answers.length, 9);
  failures[8]?.(new Error("the RPC answered HTTP 429"));
  await assert.rejects(third, /chain read failed/);
  await tick();
  assert.equal(answers.length, 14);
  for (const answer of answers.slice(9)) answer(false);
  assert.deepEqual(new Set(await Promise.all(waiting)), new Set(["visitor"]));
  assert.equal(logs.length, 4);
});
test("a vault has eight reads in flight at most, six of them for requests without a token", async () => {
  // A vault that answers owner() and leaves its balance reads unanswered.
  const pending: ((held: boolean) => void)[] = [];
  const chain: Chain = {
    isVault: async () => true,
    ownerOf: async () => owner,
    isDepositor: () => new Promise((resolve) => pending.push(resolve)),
  };
  const logs: string[] = [];
  const roles = createRoles(
    chain,
    () => 0,
    (line) => logs.push(line),
  );
  const tick = () => new Promise((done) => setImmediate(done));
  const open = Array.from({ length: 6 }, (_, i) =>
    roles.roleOf(vault, account(i)),
  );
  await tick();
  assert.equal(pending.length, 6);
  // More requests that anyone could send reach nothing, wait for nothing
  // and log nothing.
  for (let i = 6; i < 100; i++)
    await assert.rejects(roles.roleOf(vault, account(i)), Busy);
  assert.equal(pending.length, 6);
  assert.equal(logs.length, 0);
  // Two requests with a token are still read, and a third is not.
  const signed = [6, 7].map((i) => roles.roleOf(vault, account(i), true));
  await tick();
  assert.equal(pending.length, 8);
  await assert.rejects(roles.roleOf(vault, account(8), true), Busy);
  // A wallet already being read is not one more read, and another vault is
  // read as usual.
  const shared = roles.roleOf(vault, account(0));
  const elsewhere = roles.roleOf(otherVault, account(0));
  await tick();
  assert.equal(pending.length, 9);
  // An answer to a signed read leaves seven out: room for a signed one, and
  // none for one without a token.
  pending[6]?.(true);
  assert.equal(await signed[0], "depositor");
  await assert.rejects(roles.roleOf(vault, account(9)), Busy);
  const next = roles.roleOf(vault, account(9), true);
  await tick();
  assert.equal(pending.length, 10);
  // Only with fewer than six out is one without a token read again: that
  // takes three answers more.
  pending[0]?.(true);
  pending[1]?.(true);
  assert.equal(await open[0], "depositor");
  assert.equal(await shared, "depositor");
  assert.equal(await open[1], "depositor");
  await assert.rejects(roles.roleOf(vault, account(10)), Busy);
  pending[2]?.(true);
  assert.equal(await open[2], "depositor");
  const later = roles.roleOf(vault, account(10));
  await tick();
  assert.equal(pending.length, 11);
  await assert.rejects(roles.roleOf(vault, account(11)), Busy);
  for (const answer of pending) answer(false);
  assert.deepEqual(
    new Set(
      await Promise.all([...open.slice(3), signed[1], next, later, elsewhere]),
    ),
    new Set(["visitor"]),
  );
});
test("lookups at the Factory share one allowance of eight, apart from every vault's", async () => {
  const pending: ((found: boolean) => void)[] = [];
  const chain: Chain = {
    isVault: () => new Promise((resolve) => pending.push(resolve)),
    ownerOf: async () => owner,
    isDepositor: async () => false,
  };
  const roles = createRoles(
    chain,
    () => 0,
    () => {},
  );
  const tick = () => new Promise((done) => setImmediate(done));
  // Six addresses nobody has asked about before, asked about without a
  // token, and two more with one.
  const open = Array.from({ length: 6 }, (_, i) => roles.isVault(account(i)));
  await tick();
  assert.equal(pending.length, 6);
  await assert.rejects(roles.isVault(account(6)), Busy);
  const signed = [6, 7].map((i) => roles.isVault(account(i), true));
  await tick();
  assert.equal(pending.length, 8);
  await assert.rejects(roles.isVault(account(8), true), Busy);
  // One of them asked about again is the same lookup.
  const shared = roles.isVault(account(0));
  // The reads of a vault have their own allowance.
  assert.equal(await roles.roleOf(vault, stranger), "visitor");
  assert.equal(pending.length, 8);
  pending[0]?.(true);
  pending[1]?.(true);
  pending[2]?.(true);
  assert.equal(await open[0], true);
  assert.equal(await shared, true);
  const next = roles.isVault(account(8));
  await tick();
  assert.equal(pending.length, 9);
  for (const answer of pending) answer(false);
  assert.deepEqual(await Promise.all([...open.slice(3), ...signed, next]), [
    ...Array<boolean>(6).fill(false),
  ]);
});
test("thirty-two reads are in flight in all, twenty-four of them for requests without a token", async () => {
  const pending: ((held: boolean) => void)[] = [];
  const chain: Chain = {
    isVault: async () => true,
    ownerOf: async () => owner,
    isDepositor: () => new Promise((resolve) => pending.push(resolve)),
  };
  const logs: string[] = [];
  const roles = createRoles(
    chain,
    () => 0,
    (line) => logs.push(line),
  );
  const tick = () => new Promise((done) => setImmediate(done));
  const room = (i: number) => account(1_000 + i);
  // Four vaults with six reads out each, none of them with a token.
  const open = [1, 2, 3, 4].flatMap((at) =>
    Array.from({ length: 6 }, (_, i) => roles.roleOf(room(at), account(i))),
  );
  await tick();
  assert.equal(pending.length, 24);
  // A fifth vault has none of its own out and is refused all the same, and
  // so is a lookup at the Factory.
  await assert.rejects(roles.roleOf(room(5), account(0)), Busy);
  await assert.rejects(roles.ownerOf(room(5)), Busy);
  await assert.rejects(roles.isVault(account(2_000)), Busy);
  assert.equal(pending.length, 24);
  assert.equal(logs.length, 0);
  // Requests with a token are read: eight more, wherever they are for.
  const signed = [
    ...Array.from({ length: 6 }, (_, i) =>
      roles.roleOf(room(5), account(i), true),
    ),
    roles.roleOf(room(1), account(6), true),
    roles.roleOf(room(2), account(6), true),
  ];
  await tick();
  assert.equal(pending.length, 32);
  // Then nothing more is, with a token or without, for any vault.
  await assert.rejects(roles.roleOf(room(6), account(0), true), Busy);
  await assert.rejects(roles.roleOf(room(5), account(6), true), Busy);
  await assert.rejects(roles.isVault(account(2_000), true), Busy);
  assert.equal(pending.length, 32);
  // One answer, for any vault, makes room for one signed read of any vault.
  pending[0]?.(false);
  assert.equal(await open[0], "visitor");
  await assert.rejects(roles.roleOf(room(6), account(0)), Busy);
  const sixth = roles.roleOf(room(6), account(0), true);
  await tick();
  assert.equal(pending.length, 33);
  for (const answer of pending) answer(false);
  assert.deepEqual(
    new Set(await Promise.all([...open, ...signed, sixth])),
    new Set(["visitor"]),
  );
});
test("a vault's failed reads are written down once in five seconds, and leave the log to the other vaults", async () => {
  const { ledger, clock, logs, roles } = setup();
  ledger.vaults.set(otherVault, { owner, depositors: new Set() });
  // The RPC fails every read. A hundred requests for one vault are a
  // hundred reads and one line.
  ledger.failing = true;
  for (let i = 0; i < 100; i++) await assert.rejects(roles.ownerOf(vault));
  assert.deepEqual([ledger.reads, logs.length], [100, 1]);
  // The first failure of another vault is written at once.
  await assert.rejects(roles.ownerOf(otherVault));
  assert.equal(logs.length, 2);
  assert.ok(logs[1]?.startsWith(`chain read failed (${otherVault}): "`));
  // Five seconds after its line a vault gets another.
  clock.ms = 4_999;
  await assert.rejects(roles.ownerOf(vault));
  assert.equal(logs.length, 2);
  clock.ms = 5_000;
  await assert.rejects(roles.ownerOf(vault));
  await assert.rejects(roles.ownerOf(vault));
  assert.equal(logs.length, 3);
  // A failure at the vault within those five seconds is not a line of its
  // own either, though the pause it starts is real.
  ledger.failure = fault();
  const reads = ledger.reads;
  await assert.rejects(roles.ownerOf(vault), /vault read failed/);
  await assert.rejects(roles.ownerOf(vault), /left alone/);
  assert.deepEqual([ledger.reads, logs.length], [reads + 1, 3]);
  // Lookups at the Factory share one line, whichever address each is for.
  ledger.failure = undefined;
  for (let i = 0; i < 50; i++) await assert.rejects(roles.isVault(account(i)));
  assert.equal(logs.length, 4);
  assert.ok(logs[3]?.startsWith(`chain read failed (${account(0)}): "`));
  clock.ms = 10_000;
  await assert.rejects(roles.isVault(account(50)));
  assert.equal(logs.length, 5);
});
test("answers already held are still given while a vault is left alone", async () => {
  const { ledger, clock, logs, roles } = setup();
  assert.equal(await roles.isVault(vault), true);
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  ledger.failure = fault();
  ledger.failing = true;
  clock.ms = 10_000;
  await assert.rejects(roles.roleOf(vault, stranger));
  assert.equal(logs.length, 1);
  const reads = ledger.reads;
  // No answer is made up for the wallet whose read failed, but the owner and
  // the depositor read ten seconds ago are still known.
  await assert.rejects(roles.roleOf(vault, stranger));
  assert.equal(await roles.isVault(vault), true);
  assert.equal(await roles.ownerOf(vault), owner);
  assert.equal(await roles.roleOf(vault, owner), "owner");
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  assert.equal(ledger.reads, reads);
  assert.equal(logs.length, 1);
  // They are held for thirty seconds from their own read and no longer:
  // then the owner has to be read again, and that read is refused too.
  clock.ms = 14_999;
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  clock.ms = 30_000;
  ledger.failing = true;
  await assert.rejects(roles.roleOf(vault, depositor));
  await assert.rejects(roles.roleOf(vault, owner));
});
test("reads that fail together are logged as one failure", async () => {
  const { ledger, logs, roles } = setup();
  assert.equal(await roles.ownerOf(vault), owner);
  ledger.failure = fault();
  ledger.failing = true;
  const lookups = Array.from({ length: 20 }, (_, i) =>
    roles.roleOf(vault, account(i)),
  );
  for (const lookup of lookups) await assert.rejects(lookup);
  assert.equal(logs.length, 1);
});
test("a failure that lands later starts the pause again", async () => {
  // Two reads are in flight when the vault begins to fail; they fail at
  // different times.
  const pending: ((error: unknown) => void)[] = [];
  const chain: Chain = {
    isVault: async () => true,
    ownerOf: async () => owner,
    isDepositor: () =>
      new Promise((_, reject) => {
        pending.push(reject);
      }),
  };
  const clock = { ms: 0 };
  const logs: string[] = [];
  const roles = createRoles(
    chain,
    () => clock.ms,
    (line) => logs.push(line),
  );
  const first = roles.roleOf(vault, account(1));
  const second = roles.roleOf(vault, account(2));
  await new Promise((done) => setImmediate(done));
  assert.equal(pending.length, 2);
  pending[0]?.(fault());
  await assert.rejects(first);
  clock.ms = 3_000;
  pending[1]?.(fault());
  await assert.rejects(second);
  assert.equal(logs.length, 1);
  // Five seconds after the first failure the vault is still left alone.
  clock.ms = 7_999;
  await assert.rejects(roles.roleOf(vault, account(3)));
  assert.equal(pending.length, 2);
  clock.ms = 8_000;
  const third = roles.roleOf(vault, account(3));
  await new Promise((done) => setImmediate(done));
  assert.equal(pending.length, 3);
  pending[2]?.(fault());
  await assert.rejects(third);
});
test("what a failure logs is one bounded quoted line, whatever the chain said", async () => {
  const { ledger, clock, logs, roles } = setup();
  const reasons = [
    "x\n2026-10-05T00:00:00Z chat: admin 0xattacker signed in\n\u001b[2J\u001b[31mALERT",
    "A".repeat(1_000_000),
    "\u202e\u0000\r\n\t한글 😀",
    `paused" (4096 left out) vault read failed (${otherVault}): "ok`,
  ];
  for (const reason of reasons) {
    // Shaped like viem's errors: a short message with the reason in it, and
    // a long one with the RPC URL.
    const revert = Object.assign(
      new Error(
        `reverted. URL: https://rpc.example/v1/SECRET-API-KEY ${reason}`,
      ),
      {
        shortMessage: `The contract function "owner" reverted with the following reason:\n${reason}`,
      },
    );
    for (const failure of [revert, new VaultFault(revert)]) {
      ledger.failure = failure;
      ledger.failing = true;
      await assert.rejects(
        roles.ownerOf(vault),
        /^Error: (chain|vault) read failed$/,
      );
      clock.ms += 5_000;
    }
  }
  assert.equal(logs.length, 2 * reasons.length);
  for (const line of logs) {
    const match =
      /^(chain|vault) read failed \(0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1\): (".*")$/.exec(
        line,
      );
    assert.ok(match, line.slice(0, 120));
    assert.match(line, /^[\x20-\x7e]+$/);
    // The quoted part is one JSON string, so nothing in it ends the quotes.
    const said = JSON.parse(match[2] ?? "") as string;
    assert.match(said, /^The contract function "owner" reverted with the/);
    assert.ok(said.length <= 200);
    assert.equal(line.includes("SECRET-API-KEY"), false);
  }
  // Something that is not an error at all, or that cannot be printed.
  ledger.failure = { toString: null };
  await assert.rejects(roles.ownerOf(vault));
  clock.ms += 5_000;
  ledger.failure = undefined;
  await assert.rejects(roles.ownerOf(vault));
  assert.match(logs.at(-2) ?? "", /: "an error that cannot be printed"$/);
  assert.match(logs.at(-1) ?? "", /: "Error: stub RPC down /);
});
test("a former owner is the owner only while the owner read is fresh", async () => {
  const { ledger, clock, roles } = setup();
  const next = `0x${"03".repeat(20)}` as Address;
  // The owner is read, then the vault names another one.
  assert.equal(await roles.ownerOf(vault), owner);
  clock.ms = 1;
  const room = ledger.vaults.get(vault);
  assert.ok(room);
  room.owner = next;
  // Just before the owner read expires the former owner is still seen as
  // owner, and that answer is not kept for another thirty seconds.
  clock.ms = 29_999;
  assert.equal(await roles.roleOf(vault, owner), "owner");
  assert.equal(await roles.roleOf(vault, next), "visitor");
  clock.ms = 30_000;
  assert.equal(await roles.roleOf(vault, owner), "visitor");
  assert.equal(await roles.roleOf(vault, next), "owner");
  assert.equal(await roles.ownerOf(vault), next);
});
test("a member's role is reused for at most thirty seconds", async () => {
  const { ledger, clock, roles } = setup();
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  const reads = ledger.reads;
  ledger.vaults.get(vault)?.depositors.clear();
  clock.ms = 29_999;
  assert.equal(await roles.roleOf(vault, depositor), "depositor");
  assert.equal(ledger.reads, reads);
  clock.ms = 30_000;
  assert.equal(await roles.roleOf(vault, depositor), "visitor");
  assert.ok(ledger.reads > reads);
});
test("an answer is held from when it was asked for, not from when it arrived", async () => {
  const answers: ((value: Address) => void)[] = [];
  const chain: Chain = {
    isVault: async () => true,
    ownerOf: () => new Promise((resolve) => answers.push(resolve)),
    isDepositor: async () => false,
  };
  const clock = { ms: 0 };
  const roles = createRoles(
    chain,
    () => clock.ms,
    () => {},
  );
  // Asked at 0, answered at 4 s: the chain's state is from about then at the
  // latest, so the answer is good until 30 s, not until 34 s.
  const asked = roles.ownerOf(vault);
  clock.ms = 4_000;
  answers[0]?.(owner);
  assert.equal(await asked, owner);
  clock.ms = 29_999;
  assert.equal(await roles.ownerOf(vault), owner);
  assert.equal(answers.length, 1);
  clock.ms = 30_000;
  const again = roles.ownerOf(vault);
  assert.equal(answers.length, 2);
  answers[1]?.(owner);
  await again;
});
test("a visitor is looked up again after five seconds", async () => {
  const { ledger, clock, roles } = setup();
  assert.equal(await roles.roleOf(vault, stranger), "visitor");
  ledger.vaults.get(vault)?.depositors.add(stranger);
  clock.ms = 4_999;
  assert.equal(await roles.roleOf(vault, stranger), "visitor");
  clock.ms = 5_000;
  assert.equal(await roles.roleOf(vault, stranger), "depositor");
});
test("concurrent lookups of one vault share a single chain read", async () => {
  const { ledger, roles } = setup();
  const known = Array.from({ length: 20 }, () => roles.isVault(vault));
  const unknown = Array.from({ length: 20 }, () => roles.isVault(otherVault));
  assert.deepEqual(new Set(await Promise.all(known)), new Set([true]));
  assert.deepEqual(new Set(await Promise.all(unknown)), new Set([false]));
  assert.equal(ledger.reads, 2);
  // Sharing ends with the lookup: "no" is asked again, a failure is not kept.
  assert.equal(await roles.isVault(otherVault), false);
  assert.equal(ledger.reads, 3);
  ledger.failing = true;
  const failed = Array.from({ length: 5 }, () => roles.isVault(otherVault));
  for (const lookup of failed) await assert.rejects(lookup);
  assert.equal(ledger.reads, 4);
  ledger.failing = false;
  assert.equal(await roles.isVault(otherVault), false);
});
test("concurrent lookups of one wallet share a single chain read", async () => {
  const { ledger, roles } = setup();
  const found = await Promise.all(
    Array.from({ length: 20 }, () => roles.roleOf(vault, stranger)),
  );
  assert.deepEqual(new Set(found), new Set(["visitor"]));
  // owner() once, then the depositor check once.
  assert.equal(ledger.reads, 2);
});
test("what is remembered is bounded: past ten thousand entries the oldest goes", async () => {
  const { ledger, roles } = setup();
  // Answers: the first wallet's is dropped to make room, and is read again.
  for (let i = 0; i <= 10_000; i++) await roles.roleOf(vault, account(i));
  const reads = ledger.reads;
  await roles.roleOf(vault, account(10_000));
  assert.equal(ledger.reads, reads);
  await roles.roleOf(vault, account(0));
  assert.equal(ledger.reads, reads + 1);
  // Faults: the same for vaults that would not answer.
  ledger.failure = fault();
  ledger.failing = true;
  for (let i = 0; i <= 10_000; i++)
    await assert.rejects(roles.ownerOf(account(i)));
  const failedReads = ledger.reads;
  await assert.rejects(roles.ownerOf(account(10_000)));
  assert.equal(ledger.reads, failedReads);
  await assert.rejects(roles.ownerOf(account(0)));
  assert.equal(ledger.reads, failedReads + 1);
});
