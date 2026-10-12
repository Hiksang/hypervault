import { readFileSync, writeFileSync } from "node:fs";
for (const name of [
  "ManagedUsdcVault",
  "ManagedAssetVault",
  "ManagedAssetVaultFactory",
  "ManagedAssetBridge",
  "ManagedAssetNavVerifier",
  "ManagedHypeRouter",
  "ManagedUsdcVaultFactory",
  "ManagedUpgradeController",
  "HyperCorePrecompileSource",
  "ManagedPortfolioNavVerifier",
  "HyperVault",
  "HyperVaultAccountant",
  "HyperVaultShare",
  "HyperVaultLens",
]) {
  const artifact = JSON.parse(
    readFileSync(
      new URL(`../../out/${name}.sol/${name}.json`, import.meta.url),
    ),
  );
  const path = new URL(`../src/abi/${name}.json`, import.meta.url);
  const output = JSON.stringify(artifact.abi, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== output) {
      throw new Error(`${name} ABI drift: run npm run abi after forge build`);
    }
  } else {
    writeFileSync(path, output);
  }
}
