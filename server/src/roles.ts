import type { Address } from "viem";
import { VaultFault, type Chain } from "./chain.ts";
import type { Posting } from "./config.ts";
import { describe } from "./log.ts";
export type Role = "owner" | "depositor" | "visitor";
const memberTtl = 30_000;
// A wallet that has just deposited should not wait half a minute to speak.
const visitorTtl = 5_000;
// How long a vault is left alone after a read failed there.
const faultPause = 5_000;
// How many reads are in flight at most: of one vault, and in all. A read is
// one to three calls, so the node never has more than 96 of them open. A
// vault can leave its reads unanswered until they time out, which nothing
// tells apart from a slow RPC and so is not remembered, and anyone may ask
// for the role of any address: without a limit each such request would hold
// calls open at the node. The limit per vault keeps one room, however it is
// asked about, from using up what the others need.
const readsPerVault = 8;
const readsAtOnce = 32;
// Requests that carry no token get three quarters of each allowance. Anyone
// at all may ask for a role, and may ask often enough to keep every read
// taken: the quarter kept back is for the post or the hide of a wallet that
// has signed in.
const openShare = 0.75;
// What a read is refused with when that many are out already.
export class Busy extends Error {}
// Lookups at the Factory share one allowance, as the reads of a vault do.
const factoryReads = "factory";
const cacheLimit = 10_000;
export function canPost(role: Role, posting: Posting): boolean {
  return role !== "visitor" || posting === "open";
}
// Maps keep insertion order, so the first key is the oldest.
function bound(map: Map<string, unknown>): void {
  if (map.size > cacheLimit)
    for (const oldest of map.keys()) {
      map.delete(oldest);
      break;
    }
}
type Entry<T> = { value: Promise<T>; expires: number };
// Concurrent callers share one read and its result is kept for a time that
// depends on the result, counted from when the read was asked for. A failed
// read is never kept as a result.
function cache<T>(now: () => number, ttl: (value: T) => number) {
  const entries = new Map<string, Entry<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit && hit.expires > now()) return hit.value;
    const started = now();
    const entry: Entry<T> = { value: load(), expires: Infinity };
    entry.value.then(
      (value) => {
        entry.expires = started + ttl(value);
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    entries.delete(key);
    entries.set(key, entry);
    bound(entries);
    return entry.value;
  };
}
// A vault whose read failed at the vault. Until `until` it is not read at
// all. The first read after that tests it: `test` is that read, and whoever
// else needs one meanwhile waits to see how it ends.
type Fault = { until: number; test: Promise<void> | null };
// `now` must be a clock that never goes back: a corrected wall clock would
// otherwise keep a stale role alive, or expire every answer at once.
export function createRoles(
  chain: Chain,
  now: () => number,
  log: (line: string) => void,
) {
  const vaults = new Set<Address>();
  const owners = cache<Address>(now, () => memberTtl);
  const deposits = cache<boolean>(now, (held) =>
    held ? memberTtl : visitorTtl,
  );
  const faults = new Map<Address, Fault>();
  const reading = new Map<string, number>();
  let readingInAll = 0;
  // When a failed read of each vault was last written to the log: once a
  // pause at most. A vault that fails without a pause and is asked about
  // many times a second would otherwise use up the log's allowance, and the
  // failures of every other vault would only be counted.
  const noted = new Map<string, number>();
  function note(group: string, line: string): void {
    const last = noted.get(group);
    if (last !== undefined && last + faultPause > now()) return;
    noted.delete(group);
    noted.set(group, now());
    bound(noted);
    log(line);
  }
  // Every chain read goes through here, so each failure is logged, as one
  // bounded line. A vault's owner can replace its code and make its reads
  // fail on demand, each one costing RPC calls and a log line. So a vault
  // whose read failed there is left alone for a few seconds, and then tested
  // with a single read: if that fails there too the pause starts again, and
  // the requests that came meanwhile fail with it, so a burst costs one read
  // and not one each. Once a read does not fail at the vault it is read like
  // any other: nobody waits longer than that one read. The failure is
  // remembered as a failure, never as an answer. A failure of the RPC is not
  // held against the vault: a slow or rate-limited RPC would otherwise close
  // every healthy room, and an outsider can bring that about. `signed` says
  // the request carries a token, and `group` whose allowance of reads in
  // flight, and of log lines, this one counts against.
  async function read<T>(
    vault: Address,
    signed: boolean,
    load: () => Promise<T>,
    group: string = vault,
  ): Promise<T> {
    let fault = faults.get(vault);
    while (fault) {
      if (fault.until > now()) throw new Error("vault left alone for now");
      if (!fault.test) break;
      await fault.test;
      fault = faults.get(vault);
    }
    const share = signed ? 1 : openShare;
    const others = reading.get(group) ?? 0;
    if (others >= readsPerVault * share || readingInAll >= readsAtOnce * share)
      throw new Busy("enough reads out");
    reading.set(group, others + 1);
    readingInAll += 1;
    let tested = () => {};
    if (fault)
      fault.test = new Promise((done) => {
        tested = done;
      });
    // The vault is taken off the list unless it has failed again since.
    const passed = () => {
      if (fault && faults.get(vault) === fault) faults.delete(vault);
    };
    try {
      const answer = await load();
      passed();
      return answer;
    } catch (error) {
      if (!(error instanceof VaultFault)) {
        passed();
        note(group, `chain read failed (${vault}): ${describe(error, 200)}`);
        throw new Error("chain read failed");
      }
      faults.delete(vault);
      faults.set(vault, { until: now() + faultPause, test: null });
      bound(faults);
      note(
        group,
        `vault read failed (${vault}): ${describe(error.cause, 200)}`,
      );
      throw new Error("vault read failed");
    } finally {
      readingInAll -= 1;
      const left = (reading.get(group) ?? 1) - 1;
      if (left > 0) reading.set(group, left);
      else reading.delete(group);
      // The entry is off the list by now or has been replaced. Were it ever
      // left there, a test that has ended must not be waited for again.
      if (fault) fault.test = null;
      tested();
    }
  }
  // Only "yes" is kept: the Factory never unregisters a vault, while "no"
  // can become "yes" with the next created vault. Callers that arrive while a
  // lookup is in flight share it, so a restart does not send one per client.
  const lookups = new Map<Address, Promise<boolean>>();
  function isVault(vault: Address, signed = false): Promise<boolean> {
    if (vaults.has(vault)) return Promise.resolve(true);
    const pending = lookups.get(vault);
    if (pending) return pending;
    const lookup = read(vault, signed, () => chain.isVault(vault), factoryReads)
      .then((found) => {
        if (found) vaults.add(vault);
        return found;
      })
      .finally(() => lookups.delete(vault));
    lookups.set(vault, lookup);
    return lookup;
  }
  function ownerOf(vault: Address, signed = false): Promise<Address> {
    return owners(vault, () =>
      read(
        vault,
        signed,
        async () => (await chain.ownerOf(vault)).toLowerCase() as Address,
      ),
    );
  }
  // The owner is compared on every call and only the deposit answer is kept
  // per wallet, so no role outlives its own read by more than memberTtl.
  async function roleOf(
    vault: Address,
    account: Address,
    signed = false,
  ): Promise<Role> {
    if ((await ownerOf(vault, signed)) === account) return "owner";
    const held = await deposits(`${vault}:${account}`, () =>
      read(vault, signed, () => chain.isDepositor(vault, account)),
    );
    return held ? "depositor" : "visitor";
  }
  return { isVault, ownerOf, roleOf };
}
