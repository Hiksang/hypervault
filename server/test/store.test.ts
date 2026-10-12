import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openStore, type NewMessage } from "../src/store.ts";
import { otherVault, stranger, vault } from "./helpers.ts";
const draft = (text: string, at = vault): NewMessage => ({
  vault: at,
  author: stranger,
  role: "depositor",
  text,
  createdAt: 1_800_000_000,
});
test("a stored message comes back whole, with increasing ids", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  assert.deepEqual(store.add(draft("first")), {
    id: 1,
    vault,
    author: stranger,
    role: "depositor",
    text: "first",
    createdAt: 1_800_000_000,
    hidden: false,
  });
  assert.equal(store.add(draft("second")).id, 2);
});
test("pages are oldest first: forward from `after`, else the newest below `before`", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  for (let i = 1; i <= 7; i++) store.add(draft(`m${i}`));
  const ids = (page: Parameters<typeof store.list>[1]) =>
    store.list(vault, page).map((message) => message.id);
  assert.deepEqual(ids({ limit: 50 }), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ids({ limit: 3 }), [5, 6, 7]);
  assert.deepEqual(ids({ before: 5, limit: 3 }), [2, 3, 4]);
  assert.deepEqual(ids({ before: 1, limit: 3 }), []);
  assert.deepEqual(ids({ after: 2, limit: 3 }), [3, 4, 5]);
  assert.deepEqual(ids({ after: 7, limit: 3 }), []);
  assert.deepEqual(ids({ after: 0, limit: 100 }), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ids({ after: 2, before: 6, limit: 2 }), [3, 4]);
  assert.deepEqual(ids({ after: 2, before: 6, limit: 50 }), [3, 4, 5]);
});
test("rooms do not see each other's messages", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  store.add(draft("here"));
  const there = store.add(draft("there", otherVault));
  assert.deepEqual(
    store.list(vault, { limit: 50 }).map((message) => message.text),
    ["here"],
  );
  assert.equal(store.hiddenBy(vault, there.id), undefined);
  assert.equal(store.setHiddenBy(vault, there.id, "owner"), undefined);
  assert.equal(store.list(otherVault, { limit: 50 })[0]?.hidden, false);
});
test("the text of a hidden message is not read out, and returns when shown again", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const { id } = store.add(draft("regrettable"));
  assert.equal(store.hiddenBy(vault, id), null);
  const hidden = store.setHiddenBy(vault, id, "owner");
  assert.deepEqual([hidden?.hidden, hidden?.text], [true, null]);
  assert.equal(store.hiddenBy(vault, id), "owner");
  for (const page of [{ limit: 50 }, { after: 0, limit: 50 }])
    assert.deepEqual(
      store.list(vault, page).map(({ hidden, text }) => [hidden, text]),
      [[true, null]],
    );
  assert.equal(store.setHiddenBy(vault, id, "admin")?.text, null);
  assert.equal(store.hiddenBy(vault, id), "admin");
  const shown = store.setHiddenBy(vault, id, null);
  assert.deepEqual([shown?.hidden, shown?.text], [false, "regrettable"]);
  assert.equal(store.hiddenBy(vault, 99), undefined);
});
test("values are bound, never spliced into SQL", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const hostile = "'); DROP TABLE messages; --";
  assert.equal(store.add(draft(hostile)).text, hostile);
  assert.equal(store.add(draft('" OR 1=1 --')).id, 2);
  assert.equal(store.list(vault, { limit: 50 }).length, 2);
});
test("the schema refuses a role or moderator it does not know", (t) => {
  const store = openStore(":memory:");
  t.after(() => store.close());
  const { id } = store.add(draft("x"));
  assert.throws(() => store.add({ ...draft("x"), role: "admin" as "owner" }));
  assert.throws(() => store.setHiddenBy(vault, id, "nobody" as "owner"));
  assert.throws(() => store.add({ ...draft("x"), createdAt: 1.5 }));
});
test("messages persist in a database file and ids are never reused", () => {
  const directory = mkdtempSync(join(tmpdir(), "core-vault-chat-"));
  const path = join(directory, "chat.sqlite");
  try {
    const first = openStore(path);
    first.add(draft("kept"));
    first.add(draft("removed"));
    first.close();
    const raw = new DatabaseSync(path);
    raw.prepare("DELETE FROM messages WHERE id = ?").run(2);
    raw.close();
    const second = openStore(path);
    assert.deepEqual(
      second.list(vault, { limit: 50 }).map((message) => message.text),
      ["kept"],
    );
    assert.equal(second.add(draft("later")).id, 3);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
