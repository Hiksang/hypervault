import { getAddress, isAddress, type Address } from "viem";
import { boundedName } from "./domain.ts";

export type Recent = { address: Address; name: string };
type Store = Pick<Storage, "getItem" | "setItem">;

const LIMIT = 5;

// Demo vaults are not real addresses: their list is kept apart from every chain's.
export const recentSlot = (demo: boolean, chainId: number) =>
  `corevault:recent:${demo ? "demo" : chainId}`;

/** What this browser stored is not trusted: anything that is not an address and a name is dropped. */
export function loadRecent(store: Store, slot: string): Recent[] {
  try {
    const value: unknown = JSON.parse(store.getItem(slot) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .flatMap((row: { address?: unknown; name?: unknown } | null) =>
        typeof row?.address === "string" &&
        isAddress(row.address, { strict: false }) &&
        typeof row.name === "string"
          ? [
              {
                address: getAddress(row.address),
                name: boundedName(row.name),
              },
            ]
          : [],
      )
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/**
 * Newest first, one entry per Vault. The name is whatever the Vault answered: it is stored cut to
 * the length a name may have. A browser that blocks storage simply keeps no list.
 */
export function remember(store: Store, slot: string, entry: Recent): Recent[] {
  const list = [
    { address: entry.address, name: boundedName(entry.name) },
    ...loadRecent(store, slot).filter(
      (row) => row.address.toLowerCase() !== entry.address.toLowerCase(),
    ),
  ].slice(0, LIMIT);
  try {
    store.setItem(slot, JSON.stringify(list));
  } catch {
    return list;
  }
  return list;
}
