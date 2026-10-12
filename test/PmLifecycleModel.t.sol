// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreStrategyFixture} from "./HyperCoreStrategyAccount.t.sol";
import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {HyperCoreStrategyAccount} from "../src/HyperCoreStrategyAccount.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

/// @notice Characterization of CORE-001 hypotheses against the current production state machine.
/// @dev These are local models, not observations of HyperCore PM behavior. Tests directly replace raw read
///      responses to assume principal moved from spot to lending, with no fees, interest, hold or debt.
///      Bridge/deadline/pause cases preserve evidence of unresolved limitations. The external-spot case
///      checks the guard against resupplying when lending exposure already exists. Neither kind of passing
///      test certifies PM integration, network behavior or a working automatic-supply recovery path.
contract PmLifecycleModelTest is CoreStrategyFixture {
    function testModelFullAutoSupplyAfterAttestationBlocksAdvance() public {
        _startAndAttest();
        _modelAutoSupply(STRATEGY_HYPE);

        // The model conserves 101 HYPE: spot 1 + lending supply 100, but the raw target remains 101.
        _expectBridgeBlocked(1);
        require(strategy.portfolioMarginAttested(), "attestation was unexpectedly lost");
        require(strategy.accountedCapital() == DEPOSIT, "principal changed");
    }

    function testModelPartialAutoSupplyAfterAttestationBlocksAdvance() public {
        _startAndAttest();
        _modelAutoSupply(25e8);

        // Even partial movement blocks: spot 76 + supply 25 is conserved, while 76 < raw target 101.
        _expectBridgeBlocked(1);
    }

    function testModelAutoSupplyIncludingGasReserveBlocksAdvance() public {
        _startAndAttest();
        _advanceL1();
        // Separate hypothesis: the full 101 HYPE, including the assumed 1 HYPE gas reserve, is supplied.
        // The principal-only helper intentionally does not encode this additional reserve assumption.
        _setSpot(HYPE_TOKEN, 0, 0);
        _setLending(HYPE_TOKEN, 0, CORE_GAS_RESERVE + STRATEGY_HYPE);
        require(CoreRead.spotBalance(address(strategy), HYPE_TOKEN).total == 0, "raw gas reserve remained");
        require(
            CoreRead.lending(address(strategy), HYPE_TOKEN).supply.value == CORE_GAS_RESERVE + STRATEGY_HYPE,
            "model did not conserve principal and reserve"
        );
        _expectBridgeBlocked(1);
    }

    function testModelOpeningDeadlineExitStillRequiresOldRawBridgeTarget() public {
        _startAndAttest();
        _modelAutoSupply(STRATEGY_HYPE);
        VM.warp(strategy.openDeadline());
        VM.prank(KEEPER);
        vault.beginExit(1);

        require(vault.phase() == AsyncHypeVault.Phase.Exiting, "exit request was not accepted");
        require(strategy.exitRequested(), "strategy exit was not requested");
        _expectBridgeBlocked(1);
        VM.expectRevert(AsyncHypeVault.StrategyNotReturnReady.selector);
        vault.settleEpoch(1);
    }

    function testModelPausedExitStillRequiresOldRawBridgeTarget() public {
        _startAndAttest();
        _modelAutoSupply(STRATEGY_HYPE);
        vault.setRiskPaused(true);
        VM.prank(KEEPER);
        vault.beginExit(1);

        require(strategy.riskPaused(), "pause was not propagated");
        require(strategy.exitRequested(), "strategy exit was not requested");
        _expectBridgeBlocked(1);
        VM.expectRevert(AsyncHypeVault.StrategyNotReturnReady.selector);
        vault.settleEpoch(1);
    }

    function testModelNextCycleAutoSupplyBeforePMSubmissionBlocksSubmission() public {
        // Complete one explicit-supply mock cycle without redeeming the existing shareholder's capital.
        // This is a fixture-driven round trip, not evidence of a network PM mode or successful Core writes.
        _activate();
        _closeAndWithdraw();
        strategy.advance(); // submit recall
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        system.deliver(payable(address(strategy)), DEPOSIT);
        strategy.advance(); // consume the modeled receipt
        strategy.advance(); // terminal checks
        vault.settleEpoch(1);
        require(vault.phase() == AsyncHypeVault.Phase.Idle, "first cycle did not settle");
        require(whype.balanceOf(address(vault)) == DEPOSIT, "capital was not returned");

        uint256 actionsBefore = writer.actionCount();
        vault.startCycle(DEPOSIT);
        require(strategy.cycleId() == 2, "not the next cycle");
        require(!strategy.portfolioMarginActionSubmitted(), "PM submission flag was not reset");
        require(!strategy.portfolioMarginAttested(), "PM attestation flag was not reset");

        // Hypothesis: PM persists on Core and the next bridge is auto-supplied before this EVM caller runs.
        // There is no PM mode read in this fixture; the assumed effect is represented only by raw balances.
        _modelAutoSupply(STRATEGY_HYPE);
        VM.expectRevert(HyperCoreStrategyAccount.CoreObservationPending.selector);
        strategy.submitPortfolioMarginActivation();
        require(!strategy.portfolioMarginActionSubmitted(), "failed submission changed the flag");
        _expectBridgeBlocked(actionsBefore);
        require(system.bridgedToCore(address(strategy)) == 2 * DEPOSIT, "second bridge was not submitted");
    }

    function testModelMissingInitialHypeLendingReadRevertsStartAndPreservesEvmFunds() public {
        _expectInitialLendingReadFailure(HYPE_TOKEN);
    }

    function testModelMissingInitialQuoteLendingReadRevertsStartAndPreservesEvmFunds() public {
        _expectInitialLendingReadFailure(QUOTE_TOKEN);
    }

    function testModelExternalSpotAfterAutoSupplyCannotResubmitFullSupply() public {
        _startAndAttest();
        _modelAutoSupply(STRATEGY_HYPE);
        _expectBridgeBlocked(1);

        // Additional hypothesis: a third party adds 100 HYPE that remains raw spot long enough to read.
        // Whether PM permits this exact timing/balance split must be tested on a controlled network account.
        // Lending already holds the 100 HYPE principal; the unrelated spot increase restores raw target 101.
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + STRATEGY_HYPE, 0);
        uint256 actionsBefore = writer.actionCount();
        uint256 nextActionBefore = strategy.nextActionId();
        VM.expectRevert(HyperCoreStrategyAccount.ResidualExposure.selector);
        strategy.advance();

        require(writer.actionCount() == actionsBefore, "existing supply caused another writer action");
        require(strategy.nextActionId() == nextActionBefore, "blocked supply consumed an action id");
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.BridgePending, "phase advanced");
        (HyperCoreStrategyAccount.ActionKind kind,,,,,,,,,,,) = strategy.pendingAction();
        require(kind == HyperCoreStrategyAccount.ActionKind.None, "financial pending was created");
        require(strategy.cycleStatus().pending, "bridge target was cleared");
        require(!strategy.syncPendingAction(), "financial pending unexpectedly consumed");
        require(strategy.cycleStatus().pending, "sync bypassed the bridge target");
        require(strategy.accountedCapital() == DEPOSIT, "unrelated spot changed EVM accounted principal");
        // Safe rejection prevents the extra submission but does not provide an automatic-supply exit path.
    }

    function _startAndAttest() private {
        vault.startCycle(DEPOSIT);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + STRATEGY_HYPE, 0);
        strategy.submitPortfolioMarginActivation();
        vault.confirmPortfolioMargin(1);
        require(writer.actionCount() == 1, "unexpected writes before automatic supply model");
    }

    function _modelAutoSupply(uint64 supplied) private {
        require(supplied > 0 && supplied <= STRATEGY_HYPE, "invalid model amount");
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + STRATEGY_HYPE - supplied, 0);
        _setLending(HYPE_TOKEN, 0, supplied);
        uint64 rawSpot = CoreRead.spotBalance(address(strategy), HYPE_TOKEN).total;
        uint64 rawSupply = CoreRead.lending(address(strategy), HYPE_TOKEN).supply.value;
        require(rawSpot + rawSupply == CORE_GAS_RESERVE + STRATEGY_HYPE, "model did not conserve HYPE");
    }

    function _expectBridgeBlocked(uint256 expectedActions) private {
        VM.prank(KEEPER);
        VM.expectRevert(HyperCoreStrategyAccount.CoreObservationPending.selector);
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.BridgePending, "phase advanced");
        require(strategy.cycleStatus().pending, "bridge target was cleared");
        require(writer.actionCount() == expectedActions, "blocked advance submitted another action");
        require(!strategy.syncPendingAction(), "financial pending unexpectedly consumed");
        require(strategy.cycleStatus().pending, "sync bypassed the bridge target");
    }

    function _expectInitialLendingReadFailure(uint64 token) private {
        // Existing Core account + no readable initial lending ledger. The mock cannot prove why a live read fails.
        MockReadPrecompile(LENDING).setRevert(abi.encode(address(strategy), token), true);
        uint256 vaultBalance = whype.balanceOf(address(vault));
        uint256 shares = vault.totalSupply();
        uint256 nextEpoch = vault.nextEpochId();
        VM.expectRevert(abi.encodeWithSelector(CoreRead.ReadFailed.selector, LENDING));
        vault.startCycle(DEPOSIT);

        require(vault.phase() == AsyncHypeVault.Phase.Idle, "vault phase was not rolled back");
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.Idle, "strategy phase changed");
        require(vault.currentCycleId() == 0 && strategy.cycleId() == 0, "cycle id was consumed");
        require(vault.nextEpochId() == nextEpoch, "epoch id was consumed");
        require(whype.balanceOf(address(vault)) == vaultBalance, "vault WHYPE moved");
        require(whype.balanceOf(address(strategy)) == 0, "strategy received WHYPE");
        require(whype.allowance(address(vault), address(strategy)) == 0, "approval did not roll back");
        require(vault.totalSupply() == shares, "share supply changed");
        require(system.bridgedToCore(address(strategy)) == 0, "bridge was submitted");
        require(address(system).balance == 0 && address(strategy).balance == 0, "native funds moved");
        require(strategy.accountedCapital() == 0, "capital was allocated");
        require(writer.actionCount() == 0, "CoreWriter action was submitted");

        // A configured zero ledger is a separate, explicit successful-read assumption, never a failure fallback.
        _setLending(token, 0, 0);
        vault.startCycle(DEPOSIT);
        require(system.bridgedToCore(address(strategy)) == DEPOSIT, "read failure was not the blocking input");
    }
}
