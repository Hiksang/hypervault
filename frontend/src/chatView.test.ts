import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composerState,
  liveSession,
  loadSession,
  mergeMessages,
  refreshMessages,
  roleOf,
  saveSession,
} from "./chatView.ts";

const VAULT = "0x1111111111111111111111111111111111111111";
const OWNER = "0xAbCd000000000000000000000000000000000001";
const USER = "0x2222222222222222222222222222222222222222";

const message = (id: number, text: string | null = `m${id}`) => ({
  id,
  vault: VAULT,
  author: USER,
  role: "depositor",
  text,
  createdAt: 1_700_000_000 + id,
  hidden: text === null,
});

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("pages of messages fold into one list by id, oldest first", () => {
  const shown = [message(3), message(4)];
  const older = mergeMessages(shown, [message(1), message(2)]);
  assert.deepEqual(
    older.map((row) => row.id),
    [1, 2, 3, 4],
  );
  const newer = mergeMessages(older, [message(4, null), message(5)]);
  assert.deepEqual(
    newer.map((row) => [row.id, row.hidden]),
    [
      [1, false],
      [2, false],
      [3, false],
      [4, true],
      [5, false],
    ],
    "a repeated id replaces the row instead of doubling it",
  );
  assert.deepEqual(
    shown.map((row) => row.id),
    [3, 4],
    "inputs are not edited",
  );
});

test("a later read updates the rows already shown and adds none", () => {
  const shown = [message(3), message(4)];
  const refreshed = refreshMessages(shown, [
    message(4, null),
    message(5),
    message(9),
  ]);
  assert.deepEqual(
    refreshed.map((row) => [row.id, row.text]),
    [
      [3, "m3"],
      [4, null],
    ],
  );
});

test("a chat session counts only for its own account and until it expires", () => {
  const session = { token: "t", address: OWNER, expiresAt: 2000 };
  assert.deepEqual(liveSession(session, OWNER, 1999), session);
  assert.deepEqual(
    liveSession(session, OWNER.toLowerCase(), 1999),
    session,
    "addresses compare without case",
  );
  assert.equal(liveSession(session, OWNER, 2000), null, "expired");
  assert.equal(liveSession(session, USER, 1999), null, "another account");
  assert.equal(liveSession(session, null, 1999), null, "no wallet");
  for (const junk of [
    null,
    "token",
    7,
    {},
    { ...session, token: "" },
    { ...session, token: 5 },
    { ...session, address: undefined },
    { ...session, expiresAt: "2000" },
  ])
    assert.equal(liveSession(junk, OWNER, 1), null);
  assert.deepEqual(
    Object.keys(liveSession({ ...session, extra: "x" }, OWNER, 1)!),
    ["token", "address", "expiresAt"],
    "nothing else is carried along",
  );
});

test("the session survives a reload through storage, and a blocked store is not an error", () => {
  const store = memory();
  const session = { token: "t", address: OWNER, expiresAt: 2000 } as const;
  assert.equal(loadSession(store, OWNER, 1), null);
  saveSession(store, session);
  assert.deepEqual(loadSession(store, OWNER, 1), session);
  assert.equal(loadSession(store, USER, 1), null);
  assert.equal(loadSession(store, OWNER, 2001), null);
  saveSession(store, null);
  assert.equal(loadSession(store, OWNER, 1), null);
  store.setItem("corevault:chat:session", "{broken");
  assert.equal(loadSession(store, OWNER, 1), null);
  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(loadSession(blocked, OWNER, 1), null);
  saveSession(blocked, session);
  saveSession(blocked, null);
});

test("roles follow the Vault: its owner, anyone with shares or a redeem request, or a visitor", () => {
  const vault = { owner: OWNER, shares: 0n, request: 0n, claimShares: 0n };
  assert.equal(roleOf(vault, OWNER.toLowerCase()), "owner");
  assert.equal(roleOf(vault, USER), "visitor");
  assert.equal(roleOf(vault, null), "visitor");
  assert.equal(roleOf({ ...vault, shares: 1n }, USER), "depositor");
  assert.equal(roleOf({ ...vault, request: 3n }, USER), "depositor");
  assert.equal(roleOf({ ...vault, claimShares: 1n }, USER), "depositor");
  assert.equal(roleOf({ ...vault, shares: 1n }, null), "visitor");
});

test("someone with a session writes without waiting for the role: the server decides the post", () => {
  const yes = { canPost: true },
    no = { canPost: false };
  assert.equal(composerState(false, null, false), "connect");
  assert.equal(composerState(false, yes, true), "connect");
  // The role is asked without the session, and a busy server turns that request away first.
  assert.equal(composerState(true, null, true), "write");
  assert.equal(composerState(true, null, false), "checking");
  assert.equal(composerState(true, yes, false), "join");
  assert.equal(composerState(true, yes, true), "write");
  // What the server did answer stands, session or not.
  assert.equal(composerState(true, no, false), "refused");
  assert.equal(composerState(true, no, true), "refused");
});
