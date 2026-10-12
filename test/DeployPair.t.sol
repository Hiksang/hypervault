// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {DeployPair} from "../script/DeployPair.s.sol";
import {CoreStrategyFixture} from "./HyperCoreStrategyAccount.t.sol";
import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {HyperCoreStrategyAccount} from "../src/HyperCoreStrategyAccount.sol";

interface VmDeployTest {
    function setEnv(string calldata, string calldata) external;
    function toString(address) external pure returns (string memory);
    function chainId(uint256) external;
}

contract DeployPairTest is CoreStrategyFixture {
    VmDeployTest private constant ENV = VmDeployTest(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testLocalDeploymentScriptCreatesBoundPair() public {
        ENV.chainId(31337);
        ENV.setEnv("VAULT_ADMIN", ENV.toString(address(this)));
        ENV.setEnv("VAULT_MANAGER", ENV.toString(address(this)));
        ENV.setEnv("VAULT_GUARDIAN", ENV.toString(address(this)));
        ENV.setEnv("VAULT_BOOTSTRAP", ENV.toString(address(this)));
        ENV.setEnv("DUST_RECIPIENT", ENV.toString(BOB));
        ENV.setEnv("WHYPE", ENV.toString(address(whype)));
        ENV.setEnv("CORE_WRITER", ENV.toString(address(writer)));
        ENV.setEnv("HYPE_SYSTEM", ENV.toString(address(system)));
        ENV.setEnv("HYPE_TOKEN", "150");
        ENV.setEnv("QUOTE_TOKEN", "0");
        ENV.setEnv("HYPE_PERP_ASSET", "159");
        ENV.setEnv("HYPE_SPOT_ASSET", "10107");
        ENV.setEnv("HYPE_SPOT_INDEX", "107");
        ENV.setEnv("CORE_GAS_RESERVE", "100000000");
        ENV.setEnv("MAX_ASSETS", "1000000000000000000000");
        ENV.setEnv("RECAP_CAP", "20000000000000000000");
        DeployPair deploy = new DeployPair();
        (AsyncHypeVault v, HyperCoreStrategyAccount s) = deploy.run();
        require(s.vault() == address(v) && address(v.strategy()) == address(s));
        require(v.hasRole(v.DEFAULT_ADMIN_ROLE(), address(this)));
        require(v.asset() == address(whype) && s.asset() == address(whype));
    }

    function testDeploymentScriptRefusesLiveNetwork() public {
        DeployPair deploy = new DeployPair();
        ENV.chainId(999);
        VM.expectRevert();
        deploy.run();
    }
}
