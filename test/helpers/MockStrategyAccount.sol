// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHyperCoreStrategyAccount} from "../../src/interfaces/IHyperCoreStrategyAccount.sol";
import {IHyperCoreNavReader} from "../../src/interfaces/IHyperCoreNavReader.sol";
import {MockWHYPE} from "./MockWHYPE.sol";

contract MockStrategyAccount is IHyperCoreStrategyAccount {
    address public immutable vault;
    address public immutable asset;
    bytes32 public constant configHash = keccak256("mock strategy");
    CycleStatus private _status;
    uint256 public accountedCapital;
    uint256 public requiredRecapitalization;
    bool public riskPaused;
    bool public lieAboutReturn;
    modifier onlyVault() {
        require(msg.sender == vault);
        _;
    }

    constructor(address vault_, address asset_) {
        vault = vault_;
        asset = asset_;
    }

    function cycleStatus() external view returns (CycleStatus memory) {
        return _status;
    }

    function startCycle(uint256 id, uint256 amount, uint64, uint64) external onlyVault {
        require(!riskPaused);
        _status = CycleStatus(id, 4, false, false, false);
        accountedCapital = amount;
        IERC20(asset).transferFrom(vault, address(0xdead), amount);
    }
    function confirmPortfolioMargin(uint256) external onlyVault {}

    function setRiskPaused(bool paused) external onlyVault {
        riskPaused = paused;
    }

    function requestExit(uint256 id) external onlyVault {
        require(id == _status.cycleId);
        _status.exitRequested = true;
        _status.phase = 5;
    }

    function recapitalize(uint256, uint256 amount) external onlyVault {
        require(amount == requiredRecapitalization);
        accountedCapital += amount;
        requiredRecapitalization = 0;
        IERC20(asset).transferFrom(vault, address(0xdead), amount);
    }
    function advance() external {}

    function complete(uint256 amount) external {
        require(_status.exitRequested);
        MockWHYPE(payable(asset)).mint(address(this), amount);
        _status.returnReady = true;
        _status.phase = 11;
    }

    function setRequiredRecapitalization(uint256 amount) external {
        requiredRecapitalization = amount;
    }

    function setLieAboutReturn(bool value) external {
        lieAboutReturn = value;
    }

    function setPending(bool value) external {
        _status.pending = value;
    }

    function returnToVault(uint256 id) external onlyVault returns (uint256 amount) {
        require(_status.returnReady && id == _status.cycleId);
        amount = IERC20(asset).balanceOf(address(this));
        _status.returnReady = false;
        _status.phase = 0;
        accountedCapital = 0;
        IERC20(asset).transfer(vault, amount);
        if (lieAboutReturn) return amount + 1;
    }
}

contract MockNavReader is IHyperCoreNavReader {
    bool public fail;
    int256 public value;
    bool public useCustom;
    Observation private _custom;

    function set(bool fail_, int256 value_) external {
        fail = fail_;
        value = value_;
    }

    function setObservation(Observation memory o) external {
        _custom = o;
        useCustom = true;
    }

    function observe(address account) external view returns (Observation memory) {
        require(!fail, "read failed");
        if (useCustom) return _custom;
        return Observation(
            value,
            7,
            uint64(block.timestamp),
            Quality.CapitalEstimate,
            false,
            IHyperCoreStrategyAccount(account).cycleStatus().cycleId
        );
    }
}
