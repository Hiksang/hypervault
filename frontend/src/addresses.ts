import { getAddress, getContractAddress, isAddress, type Address } from "viem";
import { nameAllowed } from "./domain.ts";

const same = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase();

/**
 * The three contracts the Factory's deployer creates for Vault `index` (from 1), in that order,
 * after its own two code chunks: the upgrade controller, the first implementation and the proxy.
 * Callers confirm the proxy with `isVault`.
 */
export function vaultContractsAt(deployer: Address, index: bigint) {
  const at = (offset: bigint) =>
    getContractAddress({ from: deployer, nonce: 3n * index + offset });
  return { controller: at(0n), implementation: at(1n), vault: at(2n) };
}
export function vaultAddressAt(deployer: Address, index: bigint): Address {
  return vaultContractsAt(deployer, index).vault;
}
const indexes = new Map<string, bigint>();
/** The creation index of a Vault of this Factory, or null when none of its Vaults has that address. */
export function vaultIndexOf(
  deployer: Address,
  vault: Address,
  count: bigint,
): bigint | null {
  const key = `${deployer}:${vault}`.toLowerCase();
  const known = indexes.get(key);
  if (known !== undefined) return known <= count ? known : null;
  for (let index = count; index >= 1n; index--)
    if (same(vaultAddressAt(deployer, index), vault)) {
      indexes.set(key, index);
      return index;
    }
  return null;
}

/**
 * Whether a Vault is something other than the code it was created with. `implementation` is
 * what its controller records now and `first` what the deployer created for it. Template code
 * also answers with the Factory's asset, with the controller made for it and with a name its own
 * rule allows, so an answer that differs is other code too.
 */
export function codeDiffers(read: {
  implementation: Address;
  first: Address;
  asset?: Address;
  templateAsset?: Address;
  controller?: Address;
  madeController?: Address;
  name?: string;
}): boolean {
  const differs = (a?: Address, b?: Address) =>
    a !== undefined && b !== undefined && !same(a, b);
  return (
    !same(read.implementation, read.first) ||
    differs(read.asset, read.templateAsset) ||
    differs(read.controller, read.madeController) ||
    (read.name !== undefined && !nameAllowed(read.name))
  );
}

/**
 * The Factory a build names in `VITE_FACTORY_ADDRESS`. Everything the page trusts comes from the
 * Factory's answers: which addresses are Vaults, which code they were made with, and the token a
 * wallet is asked to approve. A build that names one therefore fixes it, and the page offers no
 * way to replace it. A build that names none leaves it to the visitor.
 */
export function builtFactory(configured?: string): {
  address: string;
  fixed: boolean;
  problem: string;
} {
  if (!configured) return { address: "", fixed: false, problem: "" };
  return isAddress(configured)
    ? { address: getAddress(configured), fixed: true, problem: "" }
    : {
        address: "",
        fixed: true,
        problem:
          "이 빌드의 Factory 주소 설정(VITE_FACTORY_ADDRESS)이 올바른 주소가 아닙니다. 계약을 조회할 수 없습니다.",
      };
}
