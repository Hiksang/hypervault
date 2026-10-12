import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRateLimit,
  decodeHistory,
  fetchRange,
  isRangeError,
  sortHistory,
  windowsBackward,
  withdrawKind,
  type DecodedLog,
} from "./history.ts";

const me = "0x3e22D0Bc27dB631742B54Fb0Fa356Cbcad3842e0";
const other = "0x1111111111111111111111111111111111111111";
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
const log = (
  eventName: string,
  args: Record<string, unknown>,
  block: number,
  i = 0,
): DecodedLog => ({
  eventName,
  args,
  blockNumber: BigInt(block),
  transactionHash: tx(block * 10 + i),
  logIndex: i,
});

test("decodes only the holder's deposits, withdrawals and requests", () => {
  const items = decodeHistory(
    [
      log(
        "Deposit",
        {
          sender: me,
          owner: me.toLowerCase(),
          assets: 20_000_000n,
          shares: 20_000_000_000n,
        },
        1,
      ),
      log(
        "Deposit",
        { sender: other, owner: other, assets: 5n, shares: 5n },
        2,
      ),
      log(
        "Withdraw",
        {
          sender: me,
          receiver: me,
          owner: me,
          assets: 499_128n,
          shares: 500_000_000n,
        },
        3,
      ),
      log(
        "RedeemRequest",
        { controller: me, owner: me, requestId: 1n, sender: me, shares: 7n },
        4,
      ),
      log(
        "RedeemRequest",
        { controller: other, owner: me, requestId: 2n, sender: me, shares: 9n },
        5,
      ),
      {
        ...log("Deposit", { owner: me, assets: 1n, shares: 1n }, 6),
        blockNumber: null,
      },
    ],
    me,
  );
  assert.deepEqual(
    items.map((i) => [i.kind, i.assets, i.shares, i.block]),
    [
      ["Deposit", 20_000_000n, 20_000_000_000n, 1n],
      ["Claim", 499_128n, 500_000_000n, 3n],
      ["Request", null, 7n, 4n],
    ],
  );
});

test("a withdrawal through redeemNow is instant; any other is a claim", () => {
  assert.equal(
    withdrawKind("0x782500e1" + "00".repeat(32)),
    "Instant withdraw",
  );
  assert.equal(withdrawKind("0xba087652" + "00".repeat(32)), "Claim");
});

test("newest first, then by log position", () => {
  const s = sortHistory([
    {
      kind: "Deposit",
      assets: 1n,
      shares: 1n,
      block: 1n,
      tx: tx(1),
      logIndex: 0,
    },
    {
      kind: "Claim",
      assets: 1n,
      shares: 1n,
      block: 3n,
      tx: tx(3),
      logIndex: 0,
    },
    {
      kind: "Request",
      assets: null,
      shares: 1n,
      block: 3n,
      tx: tx(4),
      logIndex: 2,
    },
  ]);
  assert.deepEqual(
    s.map((i) => [i.block, i.logIndex]),
    [
      [3n, 2],
      [3n, 0],
      [1n, 0],
    ],
  );
});

test("windows cover the range exactly, newest first, never wider than the cap", () => {
  assert.deepEqual(windowsBackward(100n, 2599n, 1000n), [
    [1600n, 2599n],
    [600n, 1599n],
    [100n, 599n],
  ]);
  assert.deepEqual(windowsBackward(5n, 5n, 1000n), [[5n, 5n]]);
  assert.deepEqual(windowsBackward(10n, 9n, 1000n), []);
});

test("a refused range is halved until the node accepts it", async () => {
  const asked: [bigint, bigint][] = [];
  const fetch = async (lo: bigint, hi: bigint) => {
    asked.push([lo, hi]);
    if (hi - lo + 1n > 250n)
      throw new Error("query exceeds max block range 250");
    return [log("Deposit", { owner: me, assets: 1n, shares: 1n }, Number(lo))];
  };
  const logs = await fetchRange(fetch, 0n, 999n, 1000n);
  const accepted = asked.filter(([lo, hi]) => hi - lo + 1n <= 250n);
  assert.equal(
    accepted.reduce((n, [lo, hi]) => n + (hi - lo + 1n), 0n),
    1000n,
  );
  assert.equal(logs.length, accepted.length);
  assert.ok(isRangeError({ details: "query exceeds max block range 1000" }));
  assert.ok(!isRangeError(new Error("rate limited")));
  await assert.rejects(
    fetchRange(
      async () => {
        throw new Error("boom");
      },
      0n,
      10n,
    ),
  );
});

test("a rate-limited window is retried after a wait, then the error stands", async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3)
      throw Object.assign(new Error("rate limited"), { code: -32005 });
    return [];
  };
  assert.deepEqual(await fetchRange(flaky, 0n, 10n, 1000n, [1, 1, 1]), []);
  assert.equal(calls, 3);
  await assert.rejects(
    fetchRange(
      async () => {
        throw Object.assign(new Error("rate limited"), { code: -32005 });
      },
      0n,
      10n,
      1000n,
      [1],
    ),
  );
  assert.ok(isRateLimit({ cause: { code: -32005 } }));
  assert.ok(
    isRateLimit({
      code: -1,
      message: "An unknown RPC error occurred.",
      cause: { code: -32005 },
    }),
  );
});
