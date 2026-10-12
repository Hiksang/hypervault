import type { Address } from "viem";
export type DirectVault = {
  name: string;
  vault: Address;
  asset: Address;
  bridge: Address;
  controller: Address;
  implementation: Address;
  router: Address;
  verifier: Address;
  /** v2 (HyperVault): the separate ERC-20 share token and the rate/fee accountant. */
  share?: Address;
  accountant?: Address;
  /** Retired: the strategy is unwound and settled; the FE offers withdrawal only. */
  retired?: boolean;
  /** v6 (ADR-041): read-only HyperVaultLens; the account card reads it in one call. */
  lens?: Address;
  /** EVM block the vault was deployed in: where the activity history scan starts. */
  fromBlock?: number;
};
/** Build-time deployment manifest is the trust anchor; never infer approval targets from a proxy. */
export function parseDirectVaults(raw: string): DirectVault[] {
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 20)
    throw new Error("잘못된 Vault 배포 목록");
  const seen = new Set<string>();
  for (const item of entries) {
    if (!item || typeof item !== "object") throw new Error("잘못된 Vault 항목");
    const e = item as Record<string, unknown>;
    if (typeof e.name !== "string" || !e.name.trim())
      throw new Error("Vault 이름 필요");
    for (const key of [
      "vault",
      "asset",
      "bridge",
      "controller",
      "implementation",
      "router",
      "verifier",
    ]) {
      if (
        typeof e[key] !== "string" ||
        !/^0x[0-9a-fA-F]{40}$/.test(e[key] as string) ||
        (key !== "router" && /^0x0{40}$/.test(e[key] as string))
      )
        throw new Error("잘못된 Vault 주소");
    }
    for (const key of ["share", "accountant", "lens"]) {
      if (
        e[key] !== undefined &&
        (typeof e[key] !== "string" ||
          !/^0x[0-9a-fA-F]{40}$/.test(e[key] as string) ||
          /^0x0{40}$/.test(e[key] as string))
      )
        throw new Error("잘못된 Vault 주소");
    }
    if (
      e.fromBlock !== undefined &&
      (typeof e.fromBlock !== "number" ||
        !Number.isSafeInteger(e.fromBlock) ||
        e.fromBlock < 0)
    )
      throw new Error("잘못된 fromBlock 값");
    if (e.retired !== undefined && typeof e.retired !== "boolean")
      throw new Error("잘못된 retired 값");
    if ((e.share === undefined) !== (e.accountant === undefined))
      throw new Error("v2 Vault needs both share and accountant");
    const id = (e.vault as string).toLowerCase();
    if (seen.has(id)) throw new Error("중복 Vault");
    seen.add(id);
  }
  return entries as DirectVault[];
}
