// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ManagedUsdcVault} from "../src/ManagedUsdcVault.sol";
import {ManagedUsdcVaultFactory} from "../src/ManagedUsdcVaultFactory.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface VmDeployManaged {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function envBytes32(string calldata) external returns (bytes32);
    function getCode(string calldata) external view returns (bytes memory);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @dev Factory deployment only. Requires an already deployed, reviewed verifier.
///      ManagedPortfolioNavVerifier is the candidate; it is not validated by controlled Core
///      round trips yet. Do not substitute MockManagedVerifier.
contract DeployManagedVault {
    using SafeCast for uint256;
    VmDeployManaged private constant VM = VmDeployManaged(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (ManagedUsdcVaultFactory factory) {
        require(block.chainid == 999, "HyperEVM mainnet required");
        ManagedUsdcVault.Config memory c;
        c.asset = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
        c.coreDepositWallet = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
        c.coreWriter = 0x3333333333333333333333333333333333333333;
        c.verifier = VM.envAddress("MANAGED_VERIFIER");
        require(c.verifier.code.length != 0, "verifier missing");
        require(c.verifier.codehash == VM.envBytes32("MANAGED_VERIFIER_CODEHASH"), "verifier hash mismatch");
        require(c.asset.codehash == VM.envBytes32("MANAGED_USDC_CODEHASH"), "USDC hash mismatch");
        require(c.coreDepositWallet.codehash == VM.envBytes32("MANAGED_CIRCLE_CODEHASH"), "Circle hash mismatch");
        require(c.coreWriter.codehash == VM.envBytes32("MANAGED_WRITER_CODEHASH"), "CoreWriter hash mismatch");
        c.treasury = VM.envAddress("MANAGED_TREASURY");
        c.builder = VM.envAddress("MANAGED_BUILDER");
        c.builderFeeCap = VM.envUint("MANAGED_BUILDER_FEE_CAP").toUint64();
        c.activationCost = VM.envUint("MANAGED_ACTIVATION_COST");
        c.maximumAssets = VM.envUint("MANAGED_MAX_ASSETS");
        c.chainId = 999;
        c.performanceFeeBps = 1000;
        c.minimumDeposit = 10e6;
        require(c.treasury != address(0) && c.maximumAssets >= 100e6 && c.activationCost <= 100e6, "invalid config");
        bytes memory code =
            bytes.concat(VM.getCode("ManagedUsdcVaultFactory.sol:ManagedUsdcVaultFactory"), abi.encode(c));
        VM.startBroadcast();
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "factory creation failed");
        VM.stopBroadcast();
        return ManagedUsdcVaultFactory(deployed);
    }
}
