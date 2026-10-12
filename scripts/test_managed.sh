#!/usr/bin/env bash
# Repeatable local gate. No network, signing, deployment or funds are used.
set -euo pipefail
cd "$(dirname "$0")/.."
forge fmt --check
forge build --offline --force --sizes
forge test --offline
python3 -m unittest discover -s test/python -v
managed_test_dir="$(mktemp -d)"
trap 'rm -f "$managed_test_dir/v1.json" "$managed_test_dir/v2.json" "$managed_test_dir/asset-v1.json" "$managed_test_dir/asset-v2.json" "$managed_test_dir/hv.json"; rmdir "$managed_test_dir"' EXIT
forge inspect ManagedUsdcVault storage-layout --json > "$managed_test_dir/v1.json"
forge inspect ManagedUsdcVaultV2Fixture storage-layout --json > "$managed_test_dir/v2.json"
python3 scripts/check_managed_storage.py test/fixtures/managed-storage-v1.json "$managed_test_dir/v1.json"
python3 scripts/check_managed_storage.py "$managed_test_dir/v1.json" "$managed_test_dir/v2.json"

forge inspect ManagedAssetVault storage-layout --json > "$managed_test_dir/asset-v1.json"
forge inspect ManagedAssetVaultV2Fixture storage-layout --json > "$managed_test_dir/asset-v2.json"
python3 scripts/check_managed_storage.py test/fixtures/managed-asset-storage-v1.json "$managed_test_dir/asset-v1.json"
python3 scripts/check_managed_storage.py "$managed_test_dir/asset-v1.json" "$managed_test_dir/asset-v2.json"

forge inspect HyperVault storage-layout --json > "$managed_test_dir/hv.json"
python3 scripts/check_hypervault_storage.py test/fixtures/hypervault-storage-v6.json "$managed_test_dir/hv.json"
