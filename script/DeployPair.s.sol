// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {HyperCoreStrategyAccount} from "../src/HyperCoreStrategyAccount.sol";
import {VaultFactory, VaultDeployer, StrategyDeployer} from "../src/VaultFactory.sol";
import {HyperCoreNavReader} from "../src/HyperCoreNavReader.sol";
import {HyperCoreRiskOracle} from "../src/HyperCoreRiskOracle.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CoreActionObserver} from "../src/CoreActionObserver.sol";

interface VmDeployPair {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function startBroadcast() external;
    function stopBroadcast() external;
    function getCode(string calldata artifactPath) external view returns (bytes memory);
}

/// @notice Local/fork deployment rehearsal only; no live broadcast until the documented integration gates are resolved.
contract DeployPair {
    using SafeCast for uint256;
    VmDeployPair private constant VM = VmDeployPair(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (AsyncHypeVault vault, HyperCoreStrategyAccount strategy) {
        require(block.chainid == 31337, "Local rehearsal only; see docs/split-implementation.ko.md");
        address admin = VM.envAddress("VAULT_ADMIN");
        HyperCoreStrategyAccount.Config memory sc;
        sc.wrappedHype = VM.envAddress("WHYPE");
        sc.coreWriter = VM.envAddress("CORE_WRITER");
        sc.hypeSystem = VM.envAddress("HYPE_SYSTEM");
        sc.hypeToken = VM.envUint("HYPE_TOKEN").toUint64();
        sc.quoteToken = VM.envUint("QUOTE_TOKEN").toUint64();
        sc.hypePerpAsset = VM.envUint("HYPE_PERP_ASSET").toUint32();
        sc.hypeSpotAsset = VM.envUint("HYPE_SPOT_ASSET").toUint32();
        sc.expectedChainId = block.chainid;
        sc.coreGasReserve = VM.envUint("CORE_GAS_RESERVE").toUint64();
        sc.repayBufferBps = 10100;
        sc.minHedgeBps = 9900;
        sc.maxHedgeBps = 10100;
        uint32 spotIndex = VM.envUint("HYPE_SPOT_INDEX").toUint32();
        AsyncHypeVault.Config memory vc;
        vc.asset = sc.wrappedHype;
        vc.admin = admin;
        vc.manager = VM.envAddress("VAULT_MANAGER");
        vc.guardian = VM.envAddress("VAULT_GUARDIAN");
        vc.bootstrap = VM.envAddress("VAULT_BOOTSTRAP");
        vc.dustRecipient = VM.envAddress("DUST_RECIPIENT");
        vc.maxAssets = VM.envUint("MAX_ASSETS");
        vc.recapCap = VM.envUint("RECAP_CAP");
        vc.openingTimeout = 1 hours;
        vc.cycleDuration = 1 days;
        vc.adminDelay = 1 days;
        VM.startBroadcast();
        sc.actionObserver = address(new CoreActionObserver());
        sc.riskOracle = address(
            new HyperCoreRiskOracle(
                HyperCoreRiskOracle.Config(
                    HyperCoreRiskOracle.MarketConfig(sc.hypePerpAsset, sc.hypePerpAsset, 1e4, 4, 1e6),
                    HyperCoreRiskOracle.MarketConfig(sc.hypeSpotAsset, spotIndex, 1e2, 6, 1e6),
                    100,
                    200
                )
            )
        );
        vc.navReader = address(new HyperCoreNavReader());
        VaultDeployer vd = VaultDeployer(_deployArtifact("VaultFactory.sol:VaultDeployer"));
        StrategyDeployer sd = StrategyDeployer(_deployArtifact("VaultFactory.sol:StrategyDeployer"));
        VaultFactory factory = new VaultFactory(vd, sd);
        (vault, strategy) = factory.createPair(vc, sc);
        VM.stopBroadcast();
    }

    // Load local build artifacts rather than embedding both large creation payloads in this script.
    function _deployArtifact(string memory artifact) private returns (address deployed) {
        bytes memory code = VM.getCode(artifact);
        assembly ("memory-safe") {
            deployed := create(0, add(code, 0x20), mload(code))
        }
        require(deployed != address(0), "deployer creation failed");
    }
}
