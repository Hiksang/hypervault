// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreStrategyFixture} from "./HyperCoreStrategyAccount.t.sol";
import {HyperCoreStrategyAccount} from "../src/HyperCoreStrategyAccount.sol";
import {CoreActions} from "../src/CoreActions.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

/// @notice Admission guard regressions using injected Core reads, not observed PM transitions.
contract CollateralAdmissionTest is CoreStrategyFixture {
    function testExistingSupplyBlocksInitialSupply() public {
        _assertChangedLendingBlocksInitialSupply(STRATEGY_HYPE, 0);
    }

    function testExistingBorrowBlocksInitialSupply() public {
        _assertChangedLendingBlocksInitialSupply(0, 1);
    }

    function testFuzzChangedLendingBlocksInitialSupply(uint64 supply, uint64 borrow) public {
        if (supply == 0 && borrow == 0) borrow = 1;
        _assertChangedLendingBlocksInitialSupply(supply, borrow);
    }

    function _assertChangedLendingBlocksInitialSupply(uint64 supply, uint64 borrow) private {
        _prepareInitialSupply();
        _setLending(HYPE_TOKEN, borrow, supply);
        VM.expectRevert(HyperCoreStrategyAccount.ResidualExposure.selector);
        strategy.advance();
        _assertNoSupplySubmitted();

        // A subsequent successful clean read admits the existing explicit-supply path.
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        strategy.advance();
        require(writer.actionCount() == 2 && strategy.nextActionId() == 2);
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.SupplyingCollateral);
        (, bytes memory action,) = writer.latestAction();
        require(
            keccak256(action)
                == keccak256(CoreActions.lend(CoreActions.LendingOperation.Supply, HYPE_TOKEN, STRATEGY_HYPE))
        );
    }

    function testUnavailableLendingBeforeSupplyIsNotTreatedAsZero() public {
        _prepareInitialSupply();
        MockReadPrecompile(LENDING).setRevert(abi.encode(address(strategy), HYPE_TOKEN), true);
        VM.expectRevert(abi.encodeWithSelector(CoreRead.ReadFailed.selector, LENDING));
        strategy.advance();
        _assertNoSupplySubmitted();
    }

    function _prepareInitialSupply() private {
        vault.startCycle(DEPOSIT);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + STRATEGY_HYPE, 0);
        strategy.submitPortfolioMarginActivation();
        vault.confirmPortfolioMargin(1);
        _advanceL1();
    }

    function _assertNoSupplySubmitted() private view {
        require(writer.actionCount() == 1 && strategy.nextActionId() == 1);
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.BridgePending);
        require(strategy.cycleStatus().pending);
        (HyperCoreStrategyAccount.ActionKind kind,,,,,,,,,,,) = strategy.pendingAction();
        require(kind == HyperCoreStrategyAccount.ActionKind.None);
    }
}
