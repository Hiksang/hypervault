// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ManagedAssetVault} from "../src/ManagedAssetVault.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {ManagedAssetNavVerifier} from "../src/managed/ManagedAssetNavVerifier.sol";
import {ManagedUpgradeController} from "../src/managed/ManagedUpgradeController.sol";
import {ManagedHypeRouter} from "../src/ManagedHypeRouter.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface VmDirectVault {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function envBytes32(string calldata) external returns (bytes32);
    function getCode(string calldata) external view returns (bytes memory);
    function startBroadcast(address) external;
    function stopBroadcast() external;
}

/// @notice Deploy exactly one Vault directly from the configured deployment signer; no factory contract.
/// @dev Deployment is staged. Owner later approves the proxy and calls bootstrap atomically with seed/activation.
///      Do not publish the Vault before bind/bootstrap/activation and deployment verification complete.
contract DeployManagedAssetVault {
    using SafeCast for uint256;
    VmDirectVault constant VM = VmDirectVault(address(uint160(uint256(keccak256("hevm cheat code")))));
    event DirectVaultDeployed(address vault, address controller, address implementation, address router, address owner);

    function run() external returns (ManagedAssetVault vault, address router) {
        require(block.chainid == 999, "mainnet required");
        address signer = VM.envAddress("DIRECT_DEPLOYER");
        ManagedAssetVault.Config memory c;
        c.owner = VM.envAddress("DIRECT_OWNER");
        // Legacy Config field names the one-shot bootstrap authority; this is the owner, not a contract factory.
        c.factory = c.owner;
        c.bridge = VM.envAddress("DIRECT_BRIDGE");
        c.verifier = VM.envAddress("DIRECT_VERIFIER");
        require(c.bridge.codehash == VM.envBytes32("DIRECT_BRIDGE_CODEHASH"), "bridge code");
        require(c.verifier.codehash == VM.envBytes32("DIRECT_VERIFIER_CODEHASH"), "verifier code");
        ManagedAssetBridge b = ManagedAssetBridge(c.bridge);
        require(address(ManagedAssetNavVerifier(c.verifier).bridge()) == c.bridge, "module mismatch");
        c.asset = b.asset();
        require(c.asset.codehash == VM.envBytes32("DIRECT_TOKEN_CODEHASH"), "token code");
        c.coreDepositWallet = b.circle();
        c.coreWriter = 0x3333333333333333333333333333333333333333;
        c.treasury = VM.envAddress("MANAGED_TREASURY");
        c.builder = VM.envAddress("MANAGED_BUILDER");
        c.builderFeeCap = VM.envUint("MANAGED_BUILDER_FEE_CAP").toUint64();
        c.activationCost = 1e6;
        c.performanceFeeBps = VM.envUint("DIRECT_PERFORMANCE_FEE_BPS").toUint16();
        c.minimumDeposit = VM.envUint("DIRECT_MINIMUM_DEPOSIT");
        c.maximumAssets = VM.envUint("DIRECT_MAXIMUM_ASSETS");
        c.chainId = 999;
        VM.startBroadcast(signer);
        ManagedUpgradeController controller = new ManagedUpgradeController(c.owner);
        c.upgradeController = address(controller);
        bytes memory code = bytes.concat(VM.getCode("ManagedAssetVault.sol:ManagedAssetVault"), abi.encode(c));
        address implementation;
        assembly ("memory-safe") { implementation := create(0, add(code, 32), mload(code)) }
        require(implementation != address(0), "implementation failed");
        vault = ManagedAssetVault(
            payable(address(new TransparentUpgradeableProxy(implementation, address(controller), "")))
        );
        controller.bind(address(vault), implementation);
        if (b.kind() == ManagedAssetBridge.Kind.NativeHype) router = address(new ManagedHypeRouter(vault));
        VM.stopBroadcast();
        emit DirectVaultDeployed(address(vault), address(controller), implementation, router, c.owner);
    }
}
