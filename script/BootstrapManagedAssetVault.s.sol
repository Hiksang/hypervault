// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;
import {ManagedAssetVault} from "../src/ManagedAssetVault.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {CoreRead} from "../src/CoreRead.sol";

interface VmBootstrapAsset {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function envString(string calldata) external returns (string memory);
    function envBytes32(string calldata) external returns (bytes32);
    function startBroadcast(address) external;
    function stopBroadcast() external;
}

/// @notice Owner funds an already deployed, verified proxy. No Factory or deployment intermediary holds funds.
/// @dev Seed is ERC20: USDC, WHYPE or UBTC; users can subsequently deposit native HYPE through the Router.
contract BootstrapManagedAssetVault {
    using SafeERC20 for IERC20;
    VmBootstrapAsset constant VM = VmBootstrapAsset(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external {
        require(block.chainid == 999, "mainnet required");
        ManagedAssetVault v = ManagedAssetVault(payable(VM.envAddress("DIRECT_VAULT")));
        address owner = VM.envAddress("DIRECT_OWNER");
        require(v.configHash() == VM.envBytes32("DIRECT_CONFIG_HASH"), "configuration mismatch");
        require(
            v.upgradeController().implementation().codehash == VM.envBytes32("DIRECT_IMPLEMENTATION_CODEHASH"),
            "code mismatch"
        );
        require(v.owner() == owner && v.deploymentFactory() == owner, "bootstrap authority");
        require(v.phase() == ManagedAssetVault.Phase.Uninitialized && !v.upgradeController().pending(), "phase");
        require(v.upgradeController().vault() == address(v), "unbound");
        ManagedAssetBridge b = v.bridge();
        uint256 seed = VM.envUint("DIRECT_SEED_ASSETS");
        require(seed >= b.minimumFounderAssets(), "100 USDC equivalent seed required");
        b.toCore(seed);
        uint256 cost = CoreRead.userExists(address(v)) ? 0 : v.activationCost();
        require(cost <= VM.envUint("DIRECT_MAX_ACTIVATION_COST"), "activation budget");
        IERC20 token = IERC20(v.asset());
        IERC20 usd = IERC20(b.activationAsset());
        string memory name = VM.envString("DIRECT_VAULT_NAME");
        VM.startBroadcast(owner);
        token.forceApprove(address(v), seed + (address(token) == address(usd) ? cost : 0));
        if (address(token) != address(usd)) usd.forceApprove(address(v), cost);
        v.bootstrap(name, seed);
        token.forceApprove(address(v), 0);
        if (address(token) != address(usd)) usd.forceApprove(address(v), 0);
        VM.stopBroadcast();
    }
}
