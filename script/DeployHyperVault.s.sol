// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {HyperVault} from "../src/hypervault/HyperVault.sol";
import {HyperVaultTypes} from "../src/hypervault/HyperVaultTypes.sol";
import {HyperVaultShare} from "../src/hypervault/HyperVaultShare.sol";
import {HyperVaultLens} from "../src/hypervault/HyperVaultLens.sol";
import {HyperVaultAccountant, IHyperVaultPriceHistory} from "../src/hypervault/HyperVaultAccountant.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {HyperVaultNavSource} from "../src/hypervault/HyperVaultNavSource.sol";
import {ManagedUpgradeController} from "../src/managed/ManagedUpgradeController.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface VmHyperVault {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function envBytes32(string calldata) external returns (bytes32);
    function envString(string calldata) external returns (string memory);
    function getCode(string calldata) external view returns (bytes memory);
    function startBroadcast(address) external;
    function stopBroadcast() external;
}

/// @notice Deploy one HyperVault (share token, accountant, upgrade controller, implementation,
///         proxy) over a reviewed bridge; bind share and controller. The NAV source and verifier
///         are deployed here too (owner-trusted modules without reports or drawdown wait,
///         ADR-038), with the verifier bounds taken from HV_RECALL_TIMEOUT, HV_IDLE_DUST and
///         HV_PRICE_WINDOW.
/// @dev No precompile is called here. The owner bootstraps (seed + Core activation) separately.
///      HyperVault links the external library HyperVaultCoreOps (ADR-041). `roundtrip.py` deploys
///      the library first from the owner key and passes its address with `--libraries`, so the
///      implementation's creation code here is already linked to it.
contract DeployHyperVault {
    using SafeCast for uint256;
    VmHyperVault constant VM = VmHyperVault(address(uint160(uint256(keccak256("hevm cheat code")))));

    event HyperVaultDeployed(
        address vault, address share, address accountant, address controller, address implementation, address owner
    );
    event HyperVaultLensDeployed(address lens);

    function run() external returns (HyperVault vault) {
        require(block.chainid == 999, "mainnet required");
        address signer = VM.envAddress("DIRECT_DEPLOYER");
        HyperVaultTypes.Config memory c;
        c.owner = VM.envAddress("DIRECT_OWNER");
        c.bridge = VM.envAddress("DIRECT_BRIDGE");
        require(c.bridge.codehash == VM.envBytes32("DIRECT_BRIDGE_CODEHASH"), "bridge code");
        ManagedAssetBridge bridge = ManagedAssetBridge(c.bridge);
        c.asset = bridge.asset();
        require(c.asset.codehash == VM.envBytes32("DIRECT_TOKEN_CODEHASH"), "token code");
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
        HyperVaultNavSource source = HyperVaultNavSource(
            _create(
                bytes.concat(
                    VM.getCode("HyperVaultNavSource.sol:HyperVaultNavSource"),
                    abi.encode(bridge.activationAsset(), bridge.circle(), uint32(0))
                )
            )
        );
        c.verifier = _create(
            bytes.concat(
                VM.getCode("HyperVaultNavVerifier.sol:HyperVaultNavVerifier"),
                abi.encode(
                    bridge,
                    source,
                    VM.envUint("HV_RECALL_TIMEOUT").toUint64(),
                    VM.envUint("HV_IDLE_DUST"),
                    VM.envUint("HV_PRICE_WINDOW")
                )
            )
        );
        HyperVaultShare share = new HyperVaultShare(
            VM.envString("HV_SHARE_NAME"), VM.envString("HV_SHARE_SYMBOL"), IERC20Metadata(c.asset).decimals() + 3
        );
        c.share = address(share);
        c.accountant = address(new HyperVaultAccountant(IHyperVaultPriceHistory(c.verifier)));
        ManagedUpgradeController controller = new ManagedUpgradeController(c.owner);
        c.upgradeController = address(controller);
        address implementation = _create(bytes.concat(VM.getCode("HyperVault.sol:HyperVault"), abi.encode(c)));
        vault = HyperVault(payable(address(new TransparentUpgradeableProxy(implementation, address(controller), ""))));
        controller.bind(address(vault), implementation);
        share.bind(address(vault));
        // Read-only views (ADR-041); no privilege, replaceable without touching the Vault.
        HyperVaultLens lens = new HyperVaultLens();
        VM.stopBroadcast();
        emit HyperVaultDeployed(address(vault), c.share, c.accountant, address(controller), implementation, c.owner);
        emit HyperVaultLensDeployed(address(lens));
    }

    /// @dev Creation code by artifact, so this script's own bytecode stays under the size limit.
    function _create(bytes memory code) private returns (address created) {
        assembly ("memory-safe") { created := create(0, add(code, 32), mload(code)) }
        require(created != address(0), "create failed");
    }
}
