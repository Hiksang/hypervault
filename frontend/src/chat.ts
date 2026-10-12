import { createWalletClient, custom } from "viem";
import { chain, connected, type Address, type EIP1193Provider } from "./chain";
import {
  chatApi,
  chatError,
  signError,
  signInTime,
  validText,
  type ChatMessage,
  type ChatRole,
  type ChatSession,
} from "./chatRules";
export { validText };
export type { ChatMessage, ChatRole, ChatSession };
// Empty means the chat is not configured.
export const chatUrl: string = import.meta.env.VITE_CHAT_URL || "";
const api = chatApi(chatUrl);
// The exact typed data the server verifies. Its audience is chatUrl without a
// trailing slash, which is what the server is configured to expect.
export function sessionTypedData(wallet: Address, issuedAt: bigint) {
  return api.sessionTypedData(chain.id, wallet, issuedAt);
}
// Asks the wallet for one signature. It sends no transaction and costs no gas.
export async function signIn(
  provider: EIP1193Provider,
  account: Address,
): Promise<ChatSession> {
  if (!chatUrl) throw chatError("NOT_CONFIGURED");
  const wallet = await connected(provider, account);
  const issuedAt = signInTime(Date.now());
  const signature = await createWalletClient({
    chain,
    transport: custom(provider),
  })
    .signTypedData({ account: wallet, ...sessionTypedData(wallet, issuedAt) })
    .catch((cause: unknown) => {
      throw signError(cause);
    });
  return api.openSession(wallet, issuedAt, signature);
}
export async function fetchRole(
  vault: Address,
  account: Address,
): Promise<{ role: ChatRole; canPost: boolean }> {
  return api.fetchRole(vault, account);
}
export async function fetchMessages(
  vault: Address,
  cursor?: { after?: number; before?: number; limit?: number },
): Promise<ChatMessage[]> {
  return api.fetchMessages(vault, cursor);
}
export async function postMessage(
  session: ChatSession,
  vault: Address,
  text: string,
): Promise<ChatMessage> {
  return api.postMessage(session, vault, text);
}
export async function setHidden(
  session: ChatSession,
  vault: Address,
  id: number,
  hidden: boolean,
): Promise<ChatMessage> {
  return api.setHidden(session, vault, id, hidden);
}
