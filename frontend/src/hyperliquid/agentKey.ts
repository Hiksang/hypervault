import {
  bytesToHex,
  hexToBytes,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// The agent key signs orders for the Vault's Core account. It cannot withdraw, but it can trade,
// so it is kept only in this browser and only encrypted under the operator's passphrase.
const ITERATIONS = 600_000;
/**
 * The sealed record can be copied out of this browser and guessed at offline, so the passphrase
 * is the whole protection of the key. The length is the one rule that can be checked here.
 */
export const MIN_PASSPHRASE = 12;
const DAY_MS = 86_400_000;
// What `seal` writes: a 16-byte salt, a 12-byte IV, and the 32-byte key with its 16-byte tag.
const SALT_BYTES = 16,
  IV_BYTES = 12,
  DATA_BYTES = 48;
const DAMAGED = "저장된 서명 키 기록이 손상되었습니다.";

export type SealedAgent = {
  address: Address;
  salt: Hex;
  iv: Hex;
  data: Hex;
  iterations: number;
  createdAt: number;
};

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function newAgent(): { privateKey: Hex; address: Address } {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

const bytes = (value: unknown, length: number) =>
  isHex(value) && value.length === 2 + 2 * length;

/**
 * Whether a record is one `seal` could have written. What is stored is read back as untrusted: a
 * record edited to a huge iteration count would freeze the tab on unlock, one edited to a small
 * count would be a weaker seal than this page ever writes, and one of another length cannot be
 * opened by any passphrase.
 */
function sound(value: SealedAgent): boolean {
  return (
    isAddress(value.address) &&
    bytes(value.salt, SALT_BYTES) &&
    bytes(value.iv, IV_BYTES) &&
    bytes(value.data, DATA_BYTES) &&
    Number.isSafeInteger(value.iterations) &&
    value.iterations >= ITERATIONS &&
    value.iterations <= 10 * ITERATIONS
  );
}

// WebCrypto takes views over a plain ArrayBuffer: viem's byte arrays are copied into one.
const buffer = (hex: Hex) => Uint8Array.from(hexToBytes(hex));

async function key(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(
  privateKey: Hex,
  passphrase: string,
  now = Date.now(),
): Promise<SealedAgent> {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new Error(`암호는 ${MIN_PASSPHRASE}자 이상이어야 합니다.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(passphrase, salt, ITERATIONS),
    buffer(privateKey),
  );
  return {
    address: privateKeyToAccount(privateKey).address,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    data: bytesToHex(new Uint8Array(data)),
    iterations: ITERATIONS,
    createdAt: now,
  };
}

/** The decrypted key, checked against the address it was sealed for. */
export async function open(
  sealed: SealedAgent,
  passphrase: string,
): Promise<Hex> {
  // A record of another shape fails to decrypt whatever the passphrase: that is not a wrong one.
  if (!sound(sealed)) throw new Error(DAMAGED);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(sealed.iv) },
      await key(passphrase, buffer(sealed.salt), sealed.iterations),
      buffer(sealed.data),
    );
  } catch {
    throw new Error("암호가 올바르지 않습니다.");
  }
  const privateKey = bytesToHex(new Uint8Array(plain));
  if (
    privateKeyToAccount(privateKey).address.toLowerCase() !==
    sealed.address.toLowerCase()
  )
    throw new Error(DAMAGED);
  return privateKey;
}

const slot = (chainId: number, vault: Address) =>
  `corevault:agent:${chainId}:${vault.toLowerCase()}`;

export function saveAgent(
  store: Store,
  chainId: number,
  vault: Address,
  sealed: SealedAgent,
): void {
  store.setItem(slot(chainId, vault), JSON.stringify(sealed));
}

/**
 * What this browser holds for a Vault: the sealed key, or nothing. `damaged` says that something
 * is stored there which is not a sealed key: it is neither used nor silently written over.
 */
export function readAgent(
  store: Store,
  chainId: number,
  vault: Address,
): { sealed: SealedAgent | null; damaged: boolean } {
  const text = store.getItem(slot(chainId, vault));
  if (!text) return { sealed: null, damaged: false };
  try {
    const value = JSON.parse(text) as SealedAgent;
    if (sound(value)) return { sealed: value, damaged: false };
  } catch {
    // Not JSON at all: damaged like any other record that is not a seal.
  }
  return { sealed: null, damaged: true };
}

export function loadAgent(
  store: Store,
  chainId: number,
  vault: Address,
): SealedAgent | null {
  return readAgent(store, chainId, vault).sealed;
}

export function removeAgent(store: Store, chainId: number, vault: Address) {
  store.removeItem(slot(chainId, vault));
}

/**
 * Nonces are tracked per signer and must never repeat: the last one is stored before it is used,
 * so a reload or a second tab cannot reuse it.
 */
export function nextNonce(
  store: Store,
  signer: Address,
  now = Date.now(),
): number {
  const slotName = `corevault:nonce:${signer.toLowerCase()}`;
  const last = Number(store.getItem(slotName) || 0);
  // The exchange refuses a nonce more than a day ahead of its clock. A stored value beyond that
  // was written while this clock was wrong, or by someone else: following it would stop every
  // later action from this signer.
  const usable = Number.isSafeInteger(last) && last <= now + DAY_MS;
  const nonce = Math.max(now, usable ? last + 1 : now);
  store.setItem(slotName, String(nonce));
  return nonce;
}
