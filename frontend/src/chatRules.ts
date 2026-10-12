// Everything about the chat that does not depend on the Vite environment, so
// it runs under node --test: the wire rules shared with server/, and the HTTP
// calls with the server URL passed in. chat.ts binds these to the app.
import type { Address } from "viem";
export type ChatRole = "owner" | "depositor" | "visitor";
export type ChatMessage = {
  id: number;
  vault: Address;
  author: Address;
  role: ChatRole;
  text: string | null;
  createdAt: number;
  hidden: boolean;
};
export type ChatSession = {
  token: string;
  address: Address;
  expiresAt: number;
};
export type ChatCursor = { after?: number; before?: number; limit?: number };
export const statement =
  "Sign in to Core Vault chat. This does not send a transaction.";
const textLimit = 1000;
const lineBreakLimit = 20;
const markLimit = 4;
// The time a sign-in is dated. The server takes one from five minutes before
// its own clock to thirty seconds after it, so dating the signature thirty
// seconds back lets the browser's clock be a minute fast or four and a half
// minutes slow.
export function signInTime(nowMs: number): bigint {
  return BigInt(Math.floor(nowMs / 1000) - 30);
}
// `audience` names the chat server the sign-in is for. The server verifies
// the signature against its own URL, so one collected for another site, or
// for another deployment, is refused.
export function sessionTypedDataFor(
  chainId: number,
  audience: string,
  wallet: Address,
  issuedAt: bigint,
) {
  return {
    domain: { name: "Core Vault Chat", version: "1", chainId },
    types: {
      Session: [
        { name: "wallet", type: "address" },
        { name: "issuedAt", type: "uint256" },
        { name: "audience", type: "string" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "Session",
    message: { wallet, issuedAt, audience, statement },
  } as const;
}
// C0, DEL and C1 controls except line feed.
const control = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/;
// With the u flag a surrogate matches only when it is unpaired.
const loneSurrogate = /\p{Cs}/u;
// Characters that draw nothing or change the direction text is drawn in:
// zero-width characters and directional marks, line and paragraph separators,
// directional embeddings, overrides and isolates, invisible operators and
// format controls, and the byte order mark. With them a message can read as
// other text than it holds.
const invisible = /[\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
// The zero-width joiner is also what builds one emoji out of several, so it
// is allowed exactly there: between two pictographs.
const emojiJoiner =
  /(\p{Extended_Pictographic}[\ufe0f\p{Emoji_Modifier}]?)\u200d(?=\p{Extended_Pictographic})/gu;
// What is left of a message that draws nothing: characters a renderer skips
// (fillers, variation selectors, tags), format characters, which only act on
// their neighbours, combining marks, spaces and the blank braille pattern. A
// message made only of these would look empty.
const blank = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{M}\p{Z}\u2800\n]/gu;
// Nonspacing and enclosing marks pile up on the character before them, and
// past what writing needs they run over the lines above and below and the
// messages there. Four in a row is the limit Unicode's security guidance
// gives (UTS #39, 5.4). Spacing marks sit beside the character and are not
// counted. A format character or a filler between two groups of marks draws
// nothing and leaves both groups on the one character, so the marks are
// counted with those taken out.
const stacked = new RegExp(`[\\p{Mn}\\p{Me}]{${markLimit + 1},}`, "u");
const unseen = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
// Says which rule failed; the server only answers INVALID_TEXT.
const textError = (message: string) =>
  Object.assign(new Error(message), { code: "INVALID_TEXT" });
export function validText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw textError("메시지를 입력하세요.");
  if (control.test(trimmed) || loneSurrogate.test(trimmed))
    throw textError("메시지에 줄바꿈 외의 제어문자를 쓸 수 없습니다.");
  if (invisible.test(trimmed.replace(emojiJoiner, "$1")))
    throw textError(
      "메시지에 보이지 않는 문자나 글자 방향을 바꾸는 문자를 쓸 수 없습니다.",
    );
  if (!trimmed.replace(blank, "")) throw textError("메시지를 입력하세요.");
  if (stacked.test(trimmed.replace(unseen, "")))
    throw textError(
      `한 글자에 겹쳐 쓰는 부호는 ${markLimit}개까지 쓸 수 있습니다.`,
    );
  if (trimmed.split("\n").length - 1 > lineBreakLimit)
    throw textError(`줄바꿈은 ${lineBreakLimit}개까지 쓸 수 있습니다.`);
  if ([...trimmed].length > textLimit)
    throw textError(`메시지는 ${textLimit}자 이하여야 합니다.`);
  return trimmed;
}
const messages: Record<string, string> = {
  // Answered by the server; the codes are listed in server/src/errors.ts.
  INVALID_JSON: "대화 요청 형식이 올바르지 않습니다.",
  INVALID_REQUEST: "대화 요청 형식이 올바르지 않습니다.",
  INVALID_ADDRESS: "올바른 EVM 주소가 아닙니다.",
  INVALID_TEXT:
    "메시지는 1~1000자, 줄바꿈 20개·겹친 부호 4개 이하이며 제어·숨은 문자를 쓸 수 없습니다.",
  SIGNATURE_EXPIRED:
    "서명 시각이 서버 시각과 맞지 않습니다. 기기 시계를 확인하고 다시 서명하세요.",
  BAD_SIGNATURE: "서명이 이 지갑·대화 서버와 맞지 않습니다. 다시 서명하세요.",
  UNAUTHORIZED: "대화 세션이 만료되었습니다. 지갑 서명으로 다시 참여하세요.",
  POSTING_NOT_ALLOWED: "이 볼트의 운용자와 예치자만 글을 쓸 수 있습니다.",
  NOT_MODERATOR: "이 볼트의 운용자만 메시지를 숨길 수 있습니다.",
  HIDDEN_BY_ADMIN: "관리자가 숨긴 메시지는 운용자가 바꿀 수 없습니다.",
  NOT_A_VAULT: "이 Factory에 등록된 Vault가 아닙니다.",
  MESSAGE_NOT_FOUND: "메시지를 찾을 수 없습니다.",
  NOT_FOUND: "대화 서버 주소를 확인하세요.",
  METHOD_NOT_ALLOWED: "대화 서버 주소를 확인하세요.",
  BODY_TOO_LARGE: "메시지가 너무 큽니다.",
  UNSUPPORTED_MEDIA_TYPE: "대화 요청 형식이 올바르지 않습니다.",
  RATE_LIMITED: "메시지를 너무 자주 보냈습니다. 잠시 후 다시 시도하세요.",
  INTERNAL: "대화 서버 오류입니다. 잠시 후 다시 시도하세요.",
  BUSY: "지금 로그인 요청이 많습니다. 잠시 후 다시 시도하세요.",
  CHAIN_BUSY: "지금 체인 조회가 많습니다. 잠시 후 다시 시도하세요.",
  CHAIN_UNAVAILABLE:
    "체인 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.",
  // Raised by this client.
  NOT_CONFIGURED: "대화 서버가 설정되지 않았습니다.",
  UNREACHABLE: "대화 서버에 연결할 수 없습니다.",
  BAD_RESPONSE: "대화 서버 응답을 이해할 수 없습니다.",
  SIGN_REJECTED: "지갑에서 서명을 취소했습니다.",
  SIGN_FAILED: "지갑 서명에 실패했습니다.",
};
const fallback = "대화 요청을 처리하지 못했습니다.";
// The message is for the user; `code` lets the UI react, for example by
// asking for a new sign-in on UNAUTHORIZED.
export function chatError(code: unknown, cause?: unknown) {
  const known = typeof code === "string" && Object.hasOwn(messages, code);
  const text = known ? messages[code] : fallback;
  return Object.assign(
    cause === undefined ? new Error(text) : new Error(text, { cause }),
    { code: known ? code : "UNKNOWN" },
  );
}
// EIP-1193 reports a request the user declined as code 4001; viem wraps it.
export function signError(cause: unknown) {
  for (let error = cause; error instanceof Error; error = error.cause)
    if ((error as { code?: unknown }).code === 4001)
      return chatError("SIGN_REJECTED", cause);
  return chatError("SIGN_FAILED", cause);
}
function bad(): never {
  throw chatError("BAD_RESPONSE");
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isAddress = (value: unknown): value is Address =>
  typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isRole = (value: unknown): value is ChatRole =>
  value === "owner" || value === "depositor" || value === "visitor";
// A message is rendered, so its shape is checked rather than trusted.
export function toMessage(value: unknown): ChatMessage {
  if (!isObject(value)) return bad();
  const { id, vault, author, role, text, createdAt, hidden } = value;
  if (
    !isCount(id) ||
    !isAddress(vault) ||
    !isAddress(author) ||
    !isRole(role) ||
    (text !== null && typeof text !== "string") ||
    !isCount(createdAt) ||
    typeof hidden !== "boolean"
  )
    return bad();
  return { id, vault, author, role, text, createdAt, hidden };
}
function toSession(value: unknown): ChatSession {
  if (!isObject(value)) return bad();
  const { token, address, expiresAt } = value;
  if (typeof token !== "string" || !isAddress(address) || !isCount(expiresAt))
    return bad();
  return { token, address, expiresAt };
}
function room(vault: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(vault)) throw chatError("INVALID_ADDRESS");
  return `/vaults/${vault.toLowerCase()}`;
}
async function call(
  url: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<unknown> {
  if (!url) throw chatError("NOT_CONFIGURED");
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.token !== undefined) {
    // Anything else could not have come from the server, and fetch would
    // refuse it as a header before the server could say so.
    if (!/^[\w.-]+$/.test(options.token)) throw chatError("UNAUTHORIZED");
    headers.Authorization = `Bearer ${options.token}`;
  }
  let response: Response;
  try {
    response = await fetch(url + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    throw chatError("UNREACHABLE", cause);
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) throw chatError(isObject(data) ? data.error : undefined);
  return data;
}
// How long to wait before offering the same signature again when the server
// is too busy to check it.
const busyWaits = [300, 1_000];
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
export function chatApi(base: string, pause = sleep) {
  // Without its trailing slash this is where requests go and also the
  // audience a sign-in names: the server's CHAT_AUDIENCE is the same string.
  const url = base.replace(/\/+$/, "");
  return {
    sessionTypedData(chainId: number, wallet: Address, issuedAt: bigint) {
      return sessionTypedDataFor(chainId, url, wallet, issuedAt);
    },
    async openSession(
      wallet: Address,
      issuedAt: bigint,
      signature: string,
    ): Promise<ChatSession> {
      const body = { address: wallet, issuedAt: Number(issuedAt), signature };
      // The server checks a limited number of signatures a second. The same
      // signature is good a moment later, so the wallet is not asked again.
      let data: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          data = await call(url, "/session", { body });
          break;
        } catch (error) {
          const busy = (error as { code?: unknown }).code === "BUSY";
          if (!busy || attempt >= busyWaits.length) throw error;
          await pause(busyWaits[attempt]);
        }
      }
      const session = toSession(data);
      // The token must belong to the wallet that signed.
      if (session.address !== wallet.toLowerCase()) return bad();
      return session;
    },
    async fetchRole(
      vault: Address,
      account: Address,
    ): Promise<{ role: ChatRole; canPost: boolean }> {
      const query = new URLSearchParams({ address: account });
      const data = await call(url, `${room(vault)}/role?${query}`);
      if (!isObject(data) || !isRole(data.role)) return bad();
      if (typeof data.canPost !== "boolean") return bad();
      return { role: data.role, canPost: data.canPost };
    },
    async fetchMessages(
      vault: Address,
      cursor: ChatCursor = {},
    ): Promise<ChatMessage[]> {
      const query = new URLSearchParams();
      for (const name of ["after", "before", "limit"] as const)
        if (cursor[name] !== undefined) query.set(name, String(cursor[name]));
      const search = query.toString();
      const data = await call(
        url,
        `${room(vault)}/messages${search && `?${search}`}`,
      );
      if (!isObject(data) || !Array.isArray(data.messages)) return bad();
      return data.messages.map(toMessage);
    },
    async postMessage(
      session: ChatSession,
      vault: Address,
      text: string,
    ): Promise<ChatMessage> {
      const data = await call(url, `${room(vault)}/messages`, {
        token: session.token,
        body: { text: validText(text) },
      });
      return toMessage(isObject(data) ? data.message : undefined);
    },
    async setHidden(
      session: ChatSession,
      vault: Address,
      id: number,
      hidden: boolean,
    ): Promise<ChatMessage> {
      if (!isCount(id)) throw chatError("MESSAGE_NOT_FOUND");
      const data = await call(url, `${room(vault)}/messages/${id}/hide`, {
        token: session.token,
        body: { hidden },
      });
      return toMessage(isObject(data) ? data.message : undefined);
    },
  };
}
