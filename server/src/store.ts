import { DatabaseSync } from "node:sqlite";
import type { Address } from "viem";
import type { Role } from "./roles.ts";
import type { Page } from "./rules.ts";
export type Moderator = "owner" | "admin";
export type Message = {
  id: number;
  vault: Address;
  author: Address;
  role: Role;
  text: string | null;
  createdAt: number;
  hidden: boolean;
};
export type NewMessage = {
  vault: Address;
  author: Address;
  role: Role;
  text: string;
  createdAt: number;
};
export type Store = {
  add(message: NewMessage): Message;
  list(vault: Address, page: Page): Message[];
  // undefined: no such message in this room. null: visible.
  hiddenBy(vault: Address, id: number): Moderator | null | undefined;
  setHiddenBy(
    vault: Address,
    id: number,
    by: Moderator | null,
  ): Message | undefined;
  close(): void;
};
const schema = `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vault TEXT NOT NULL,
    author TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'depositor', 'visitor')),
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    hidden_by TEXT CHECK (hidden_by IN ('owner', 'admin'))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS messages_by_vault ON messages (vault, id);
`;
// Every read goes through these columns, so the text of a hidden message
// never leaves the database. The list is a constant; all values are bound.
const columns = `id, vault, author, role,
  CASE WHEN hidden_by IS NULL THEN text END AS text,
  created_at, hidden_by IS NOT NULL AS hidden`;
type Row = {
  id: number;
  vault: Address;
  author: Address;
  role: Role;
  text: string | null;
  created_at: number;
  hidden: number;
};
function message(row: unknown): Message {
  const { id, vault, author, role, text, created_at, hidden } = row as Row;
  return {
    id,
    vault,
    author,
    role,
    text,
    createdAt: created_at,
    hidden: hidden === 1,
  };
}
export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(schema);
  const insert = db.prepare(
    `INSERT INTO messages (vault, author, role, text, created_at)
     VALUES (?, ?, ?, ?, ?) RETURNING ${columns}`,
  );
  const newest = db.prepare(
    `SELECT * FROM (
       SELECT ${columns} FROM messages WHERE vault = ? AND id < ?
       ORDER BY id DESC LIMIT ?
     ) ORDER BY id`,
  );
  const forward = db.prepare(
    `SELECT ${columns} FROM messages WHERE vault = ? AND id > ? AND id < ?
     ORDER BY id LIMIT ?`,
  );
  const moderator = db.prepare(
    "SELECT hidden_by FROM messages WHERE id = ? AND vault = ?",
  );
  const moderate = db.prepare(
    `UPDATE messages SET hidden_by = ? WHERE id = ? AND vault = ?
     RETURNING ${columns}`,
  );
  return {
    add({ vault, author, role, text, createdAt }) {
      return message(insert.get(vault, author, role, text, createdAt));
    },
    // With `after` the page runs forward from the cursor; otherwise it is the
    // newest page below `before`. Either way it is returned oldest first.
    list(vault, { after, before = Number.MAX_SAFE_INTEGER, limit }) {
      const rows =
        after === undefined
          ? newest.all(vault, before, limit)
          : forward.all(vault, after, before, limit);
      return rows.map(message);
    },
    hiddenBy(vault, id) {
      const row = moderator.get(id, vault);
      return row && (row.hidden_by as Moderator | null);
    },
    setHiddenBy(vault, id, by) {
      const row = moderate.get(by, id, vault);
      return row && message(row);
    },
    close() {
      db.close();
    },
  };
}
