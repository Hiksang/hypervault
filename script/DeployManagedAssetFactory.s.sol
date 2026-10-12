// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;
import {ManagedAssetVault} from "../src/ManagedAssetVault.sol";
import {ManagedAssetVaultFactory} from "../src/ManagedAssetVaultFactory.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {ManagedAssetNavVerifier} from "../src/managed/ManagedAssetNavVerifier.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface VmDeployAsset {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function envBytes32(string calldata) external returns (bytes32);
    function getCode(string calldata) external view returns (bytes memory);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @dev Deploys a new Factory; does not create/fund investor Vaults or migrate existing Vaults.
///      Requires reviewed, already deployed bridge and verifier modules. No keys are read here.
contract DeployManagedAssetFactory {
    using SafeCast for uint256;
    VmDeployAsset constant VM = VmDeployAsset(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (ManagedAssetVaultFactory factory) {
        require(block.chainid == 999, "mainnet required");
        ManagedAssetVault.Config[] memory configs = new ManagedAssetVault.Config[](3);
        string[3] memory labels = [string("ASSET_USDC"), "ASSET_HYPE", "ASSET_UBTC"];
        for (uint256 i; i < 3; ++i) {
            string memory prefix = labels[i];
            address b = VM.envAddress(string.concat(prefix, "_BRIDGE"));
            address v = VM.envAddress(string.concat(prefix, "_VERIFIER"));
            require(b.codehash == VM.envBytes32(string.concat(prefix, "_BRIDGE_CODEHASH")), "bridge code");
            require(v.codehash == VM.envBytes32(string.concat(prefix, "_VERIFIER_CODEHASH")), "verifier code");
            ManagedAssetBridge bridge = ManagedAssetBridge(b);
            require(uint8(bridge.kind()) == i && address(ManagedAssetNavVerifier(v).bridge()) == b, "module mismatch");
            ManagedAssetVault.Config memory c;
            c.asset = bridge.asset();
            c.bridge = b;
            c.verifier = v;
            c.coreDepositWallet = bridge.circle();
            c.coreWriter = 0x3333333333333333333333333333333333333333;
            require(c.asset.codehash == VM.envBytes32(string.concat(prefix, "_TOKEN_CODEHASH")), "token code");
            c.treasury = VM.envAddress("MANAGED_TREASURY");
            c.builder = VM.envAddress("MANAGED_BUILDER");
            c.builderFeeCap = VM.envUint("MANAGED_BUILDER_FEE_CAP").toUint64();
            c.activationCost = 1e6;
            c.performanceFeeBps = 1000;
            c.minimumDeposit = bridge.fromUsdc18(10e18);
            c.maximumAssets = VM.envUint(string.concat(prefix, "_MAX_ASSETS"));
            c.chainId = 999;
            configs[i] = c;
        }
        bytes memory code =
            bytes.concat(VM.getCode("ManagedAssetVaultFactory.sol:ManagedAssetVaultFactory"), abi.encode(configs));
        VM.startBroadcast();
        address made;
        assembly ("memory-safe") { made := create(0, add(code, 32), mload(code)) }
        require(made != address(0), "factory failed");
        VM.stopBroadcast();
        factory = ManagedAssetVaultFactory(made);
    }
}
