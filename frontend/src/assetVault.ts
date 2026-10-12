import { type Abi, type Address } from "viem";
import factoryJson from "./abi/ManagedAssetVaultFactory.json";
import vaultJson from "./abi/ManagedAssetVault.json";
import bridgeJson from "./abi/ManagedAssetBridge.json";
import routerJson from "./abi/ManagedHypeRouter.json";
import controllerJson from "./abi/ManagedUpgradeController.json";
import { read } from "./chain";
export const assetFactoryAbi = factoryJson as Abi;
export const assetVaultAbi = vaultJson as Abi;
export const assetBridgeAbi = bridgeJson as Abi;
export const nativeRouterAbi = routerJson as Abi;
export const controllerAbi = controllerJson as Abi;
export { assetUnits, assetAmount } from "./assetAmounts";
export type AssetTemplate = {
  asset: Address;
  bridge: Address;
  minimumDeposit: bigint;
  maximumAssets: bigint;
  activationCost: bigint;
  performanceFeeBps: number;
  verifier: Address;
};
export type AssetOption = {
  asset: Address;
  bridge: Address;
  symbol: string;
  kind: number;
  decimals: number;
  activationAsset: Address;
  founder: bigint;
  template: AssetTemplate;
};
export { parseDirectVaults } from "./directVaultManifest";
import { parseDirectVaults, type DirectVault } from "./directVaultManifest";
export function directVaults(): DirectVault[] {
  return parseDirectVaults(String(import.meta.env.VITE_DIRECT_VAULTS ?? "[]"));
}
export async function directVaultOption(e: DirectVault): Promise<AssetOption> {
  const [
    kind,
    decimals,
    activationAsset,
    asset,
    verifier,
    bridge,
    minimumDeposit,
    maximumAssets,
    activationCost,
    performanceFeeBps,
  ] = await Promise.all([
    read<number>(e.bridge, "kind", [], assetBridgeAbi),
    read<number>(e.bridge, "assetDecimals", [], assetBridgeAbi),
    read<Address>(e.bridge, "activationAsset", [], assetBridgeAbi),
    read<Address>(e.vault, "asset", [], assetVaultAbi),
    read<Address>(e.vault, "verifier", [], assetVaultAbi),
    read<Address>(e.vault, "bridge", [], assetVaultAbi),
    read<bigint>(e.vault, "minimumDeposit", [], assetVaultAbi),
    read<bigint>(e.vault, "maximumAssets", [], assetVaultAbi),
    read<bigint>(e.vault, "activationCost", [], assetVaultAbi),
    read<number>(e.vault, "performanceFeeBps", [], assetVaultAbi),
  ]);
  if (
    ![0, 1, 2].includes(Number(kind)) ||
    asset.toLowerCase() !== e.asset.toLowerCase() ||
    bridge.toLowerCase() !== e.bridge.toLowerCase() ||
    verifier.toLowerCase() !== e.verifier.toLowerCase()
  )
    throw new Error("배포 목록과 Vault 설정이 다릅니다.");
  return {
    asset: e.asset,
    bridge: e.bridge,
    kind: Number(kind),
    decimals: Number(decimals),
    symbol: ["USDC", "HYPE", "UBTC"][Number(kind)]!,
    activationAsset,
    founder: 0n,
    template: {
      asset: e.asset,
      bridge: e.bridge,
      verifier: e.verifier,
      minimumDeposit,
      maximumAssets,
      activationCost,
      performanceFeeBps,
    },
  };
}
export async function assetVaultIdentity(e: DirectVault) {
  const [current, pending, bound] = await Promise.all([
    read<Address>(e.controller, "implementation", [], controllerAbi),
    read<boolean>(e.controller, "pending", [], controllerAbi),
    read<Address>(e.controller, "vault", [], controllerAbi),
  ]);
  if (bound.toLowerCase() !== e.vault.toLowerCase())
    throw new Error("Vault 업그레이드 권한이 일치하지 않습니다.");
  return {
    asset: e.asset,
    controller: e.controller,
    router: e.router,
    changed: current.toLowerCase() !== e.implementation.toLowerCase(),
    pending,
  };
}
