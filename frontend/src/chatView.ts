import type { Address } from "viem";
import type { ChatMessage, ChatRole, ChatSession } from "./chat.ts";

export const ROLES: Record<ChatRole, string> = {
  owner: "운용자",
  depositor: "예치자",
  visitor: "방문자",
};
/** Messages asked for at a time; a shorter answer means there is no older history. */
export const PAGE = 50;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const SLOT = "corevault:chat:session";

/** New rows folded into the list by id, oldest first. */
export function mergeMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Rows already shown, replaced by a later read of them. It adds nothing, so a hidden or restored
 * message shows up without opening a gap in the forward history.
 */
export function refreshMessages(
  current: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  const byId = new Map(incoming.map((message) => [message.id, message]));
  return current.map((message) => byId.get(message.id) ?? message);
}

/** A session counts only for the connected account and until it expires (unix seconds). */
export function liveSession(
  value: unknown,
  account: Address | null,
  now: number,
): ChatSession | null {
  const row = value as Partial<ChatSession> | null;
  if (
    !account ||
    !row ||
    typeof row.token !== "string" ||
    !row.token ||
    typeof row.address !== "string" ||
    typeof row.expiresAt !== "number" ||
    row.address.toLowerCase() !== account.toLowerCase() ||
    row.expiresAt <= now
  )
    return null;
  return { token: row.token, address: row.address, expiresAt: row.expiresAt };
}

export function loadSession(
  store: Store,
  account: Address | null,
  now: number,
): ChatSession | null {
  try {
    return liveSession(JSON.parse(store.getItem(SLOT) || "null"), account, now);
  } catch {
    return null;
  }
}

/** Kept for this browser tab only. Where storage is blocked the session lives in memory alone. */
export function saveSession(store: Store, session: ChatSession | null): void {
  try {
    if (session) store.setItem(SLOT, JSON.stringify(session));
    else store.removeItem(SLOT);
  } catch {
    return;
  }
}

/**
 * What the panel offers under the messages. `answer` is the server's word on the role, null
 * while it has not come: that request carries no session, and it is the kind a busy server
 * turns away first. Someone who has a session is not kept waiting for it, because the server
 * decides the role again on the post itself, which the session signs.
 */
export function composerState(
  connected: boolean,
  answer: { canPost: boolean } | null,
  signed: boolean,
): "connect" | "checking" | "refused" | "join" | "write" {
  if (!connected) return "connect";
  if (!answer) return signed ? "write" : "checking";
  if (!answer.canPost) return "refused";
  return signed ? "write" : "join";
}

/**
 * The role the chat server would give `viewer`, from the same Vault reads: shares held, or
 * escrowed in an open or claimable redeem request, make a depositor.
 */
export function roleOf(
  vault: {
    owner: Address;
    shares: bigint;
    request: bigint;
    claimShares: bigint;
  },
  viewer: Address | null,
): ChatRole {
  if (!viewer) return "visitor";
  if (viewer.toLowerCase() === vault.owner.toLowerCase()) return "owner";
  return vault.shares > 0n || vault.request > 0n || vault.claimShares > 0n
    ? "depositor"
    : "visitor";
}
