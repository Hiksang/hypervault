import {
  concat,
  hexToBytes,
  keccak256,
  numberToBytes,
  parseSignature,
  zeroAddress,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { pack } from "./msgpack.ts";

export type L1Signature = { r: Hex; s: Hex; v: number };

/** The hash an agent signs for an order, cancel or other "L1 action" (official SDK: action_hash). */
export function actionHash(
  action: unknown,
  nonce: number,
  vaultAddress: Address | null = null,
  expiresAfter?: number,
): Hex {
  const parts: Uint8Array[] = [
    pack(action),
    numberToBytes(BigInt(nonce), { size: 8 }),
    vaultAddress === null
      ? Uint8Array.of(0)
      : concat([Uint8Array.of(1), hexToBytes(vaultAddress)]),
  ];
  if (expiresAfter !== undefined)
    parts.push(
      Uint8Array.of(0),
      numberToBytes(BigInt(expiresAfter), { size: 8 }),
    );
  return keccak256(concat(parts));
}

/**
 * Sign an L1 action with an agent key. The typed-data domain is fixed to chain 1337, which is why
 * a browser wallet cannot produce this signature and a dedicated agent key is needed.
 * `vaultAddress` is for native Hyperliquid vaults and sub-accounts only: a Managed Vault is an
 * ordinary master account, so its agent passes null.
 */
export async function signL1Action(
  account: LocalAccount,
  action: unknown,
  nonce: number,
  mainnet: boolean,
  vaultAddress: Address | null = null,
  expiresAfter?: number,
): Promise<L1Signature> {
  const signature = await account.signTypedData({
    domain: {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: zeroAddress,
    },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: {
      source: mainnet ? "a" : "b",
      connectionId: actionHash(action, nonce, vaultAddress, expiresAfter),
    },
  });
  const { r, s, yParity } = parseSignature(signature);
  return { r, s, v: 27 + yParity };
}
