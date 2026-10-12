import { createHmac, timingSafeEqual } from "node:crypto";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
export const statement =
  "Sign in to Core Vault chat. This does not send a transaction.";
const signInWindow = 5 * 60;
// A client clock running a little fast is tolerated. A signature dated
// further ahead would stay exchangeable for that much longer.
const clockSkew = 30;
export const sessionSeconds = 12 * 60 * 60;
// What a sign-in is bound to. The audience is this server's public URL as its
// clients configure it, so a signature another site collected for itself
// cannot be exchanged for a token here.
export type Realm = { chainId: number; audience: string };
export type TokenKey = Realm & { secret: string };
export function sessionTypedData(
  realm: Realm,
  wallet: Address,
  issuedAt: bigint,
) {
  return {
    domain: { name: "Core Vault Chat", version: "1", chainId: realm.chainId },
    types: {
      Session: [
        { name: "wallet", type: "address" },
        { name: "issuedAt", type: "uint256" },
        { name: "audience", type: "string" },
        { name: "statement", type: "string" },
      ],
    },
    primaryType: "Session",
    message: { wallet, issuedAt, audience: realm.audience, statement },
  } as const;
}
export function fresh(issuedAt: number, now: number): boolean {
  return issuedAt <= now + clockSkew && issuedAt >= now - signInWindow;
}
export async function signedBy(
  realm: Realm,
  wallet: Address,
  issuedAt: number,
  signature: Hex,
): Promise<boolean> {
  try {
    const signer = await recoverTypedDataAddress({
      ...sessionTypedData(realm, wallet, BigInt(issuedAt)),
      signature,
    });
    return signer.toLowerCase() === wallet.toLowerCase();
  } catch {
    // A signature that cannot be recovered was not made by this wallet.
    return false;
  }
}
// The chain id and the audience are part of the MAC, so a token only works
// on the deployment that issued it even if another one was given the same
// secret. No field can contain the line break that separates them.
function mac(key: TokenKey, address: Address, expiresAt: number): string {
  return createHmac("sha256", key.secret)
    .update(
      [
        "core-vault-chat session",
        key.chainId,
        key.audience,
        address,
        expiresAt,
      ].join("\n"),
    )
    .digest("base64url");
}
export function issueToken(
  key: TokenKey,
  address: Address,
  expiresAt: number,
): string {
  return `${address}.${expiresAt}.${mac(key, address, expiresAt)}`;
}
// 43 characters is a SHA-256 digest in base64url. The encoded forms are
// compared, so exactly one token is valid for a given payload.
const tokenShape =
  /^(0x[0-9a-f]{40})\.([1-9][0-9]{0,14})\.([A-Za-z0-9_-]{43})$/;
export function readToken(
  key: TokenKey,
  token: string,
  now: number,
): Address | null {
  const match = tokenShape.exec(token);
  if (!match) return null;
  const address = match[1] as Address;
  const expiresAt = Number(match[2]);
  const given = Buffer.from(match[3] ?? "");
  const expected = Buffer.from(mac(key, address, expiresAt));
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  return expiresAt > now ? address : null;
}
