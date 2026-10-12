import type { LocalAccount } from "viem";
import type { Fetcher } from "./info.ts";
import { results, type OrderResult } from "./orders.ts";
import { signL1Action } from "./signing.ts";

/** How long a signed action stays acceptable: a delayed request must not execute later. */
export const ACTION_TTL_MS = 60_000;
/** How long a request may stay unanswered before the page stops waiting for it. */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Sign an action with the Vault's agent key and send it. A thrown error after the request left
 * means the outcome is unknown: the caller must look at the open orders before trying again.
 */
export async function exchange(
  base: string,
  agent: LocalAccount,
  action: unknown,
  nonce: number,
  mainnet: boolean,
  fetcher: Fetcher = fetch,
  now = Date.now(),
): Promise<OrderResult[]> {
  // Counted from the clock, not from the nonce: a nonce follows the last one used and can run
  // ahead of the clock, which would keep a delayed request alive for that much longer.
  const expiresAfter = now + ACTION_TTL_MS;
  const signature = await signL1Action(
    agent,
    action,
    nonce,
    mainnet,
    null,
    expiresAfter,
  );
  const response = await fetcher(`${base}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The Vault is an ordinary master account: no vaultAddress routing.
    body: JSON.stringify({
      action,
      nonce,
      signature,
      vaultAddress: null,
      expiresAfter,
    }),
    // Without this a request that is never answered would hold the page's write lock for good.
    // Giving up is not a refusal: the caller treats it as an unknown outcome.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`거래소가 요청을 받지 않았습니다 (${response.status}).`);
  return results(await response.json());
}
