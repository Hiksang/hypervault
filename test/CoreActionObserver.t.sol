// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreStrategyFixture} from "./HyperCoreStrategyAccount.t.sol";
import {HyperCoreStrategyAccount} from "../src/HyperCoreStrategyAccount.sol";
import {ICoreActionObserver} from "../src/interfaces/ICoreActionObserver.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

contract CoreActionObserverTest is CoreStrategyFixture {
    function _supply() private {
        vault.startCycle(DEPOSIT);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        strategy.submitPortfolioMarginActivation();
        vault.confirmPortfolioMargin(1);
        strategy.advance();
    }

    function _opening() private {
        _supply();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        strategy.advance();
    }

    function _evidence() private view returns (ICoreActionObserver.Evidence) {
        return strategy.pendingActionObservation().evidence;
    }

    function _context(uint8 kind, uint64 primary, uint64 secondary, uint64 amount)
        private
        view
        returns (ICoreActionObserver.Context memory c)
    {
        c.account = address(strategy);
        c.hypeToken = HYPE_TOKEN;
        c.quoteToken = QUOTE_TOKEN;
        c.perp = HYPE_PERP;
        c.kind = kind;
        c.submittedCoreBlock = 0;
        c.primaryBefore = primary;
        c.secondaryBefore = secondary;
        c.amount = amount;
        c.riskOracle = address(riskOracle);
    }

    function testSameBlockAndNoEffectNeverAuthorizeRetry() public {
        _supply();
        uint256 count = writer.actionCount();
        require(_evidence() == ICoreActionObserver.Evidence.AwaitingBlock);
        require(!strategy.syncPendingAction());
        _advanceL1();
        VM.warp(block.timestamp + 365 days);
        require(_evidence() == ICoreActionObserver.Evidence.NoEffect);
        require(!strategy.syncPendingAction());
        require(strategy.cycleStatus().pending && writer.actionCount() == count);
        vault.beginExit(1);
        VM.expectRevert();
        strategy.advance();
    }

    function testSupplyRequiresCorroboratingSourceAndDestination() public {
        _supply();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE); // lending changed, source unchanged
        require(_evidence() == ICoreActionObserver.Evidence.Uncorroborated);
        require(!strategy.syncPendingAction());
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0); // only source changed
        require(_evidence() == ICoreActionObserver.Evidence.Uncorroborated);
        require(!strategy.syncPendingAction());
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE / 2);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + STRATEGY_HYPE / 2, 0);
        require(_evidence() == ICoreActionObserver.Evidence.PartialEffect);
        require(!strategy.syncPendingAction(), "partial lending action was retried");
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        require(strategy.syncPendingAction());
        require(!strategy.cycleStatus().pending);
    }

    function testReadFailureIsDistinctFromNoEffect() public {
        _supply();
        _advanceL1();
        MockReadPrecompile(LENDING).setRevert(abi.encode(address(strategy), HYPE_TOKEN), true);
        ICoreActionObserver.Observation memory o = strategy.pendingActionObservation();
        require(o.evidence == ICoreActionObserver.Evidence.ReadUnavailable && o.readErrorHash != bytes32(0));
        require(!strategy.syncPendingAction());
        require(strategy.cycleStatus().pending);
        _setLending(HYPE_TOKEN, 0, 0);
        require(_evidence() == ICoreActionObserver.Evidence.NoEffect);
    }

    function testMalformedReadDoesNotClearPending() public {
        _opening();
        _advanceL1();
        MockReadPrecompile(POSITION).setResponse(abi.encode(address(strategy), HYPE_PERP), hex"01");
        require(_evidence() == ICoreActionObserver.Evidence.ReadUnavailable);
        require(!strategy.syncPendingAction());
    }

    function testWrongDirectionAndOversizeOpenDoNotClearPending() public {
        _opening();
        _advanceL1();
        _setPosition(1e8);
        require(_evidence() == ICoreActionObserver.Evidence.UnexpectedEffect);
        require(!strategy.syncPendingAction());
        _setPosition(-int64(STRATEGY_HYPE + 1e6));
        require(_evidence() == ICoreActionObserver.Evidence.UnexpectedEffect);
        require(!strategy.syncPendingAction());
        require(writer.actionCount() == 3);
    }

    function testObservedIOCProgressSurvivesNextPriceFailureAndKeepsUniqueIds() public {
        _opening();
        (,,,,,,,, uint256 firstId, uint128 firstCloid,, bytes32 firstHash) = strategy.pendingAction();
        (, bytes memory firstAction,) = writer.latestAction();
        require(firstId == 2 && firstCloid == 1 && firstHash == keccak256(firstAction));
        _advanceL1();
        _setPosition(-int64(STRATEGY_HYPE / 2));
        MockReadPrecompile(BBO).setRevert(abi.encode(HYPE_PERP), true);
        VM.expectRevert();
        strategy.advance(); // next order fails, so this transaction also rolls back its observation
        require(strategy.cycleStatus().pending);
        VM.prank(KEEPER);
        require(strategy.syncPendingAction()); // independent commit performs no new risk action
        require(!strategy.cycleStatus().pending && writer.actionCount() == 3);
        VM.expectRevert();
        strategy.advance();
        require(!strategy.cycleStatus().pending);
        _setBbo(HYPE_PERP, PERP_READ_PRICE, PERP_READ_PRICE);
        strategy.advance();
        (,,,,,,,, uint256 secondId, uint128 secondCloid,, bytes32 secondHash) = strategy.pendingAction();
        require(secondId > firstId && secondCloid > firstCloid && secondHash != firstHash);
    }

    function testCloseMustReduceWithoutSignFlip() public {
        ICoreActionObserver.Context memory c = _context(3, 100e6, 0, 100e6);
        c.positionBefore = -100e6;
        _setPosition(-110e6);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.UnexpectedEffect);
        _setPosition(1e6);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.UnexpectedEffect);
        _setPosition(-50e6);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.PartialEffect);
        _setPosition(0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.ExpectedEffect);
    }

    function testRepayNeedsDebtReductionNotJustGasOrHypeDebit() public {
        ICoreActionObserver.Context memory c = _context(5, 100, 200, 50);
        _setSpot(HYPE_TOKEN, 150, 0);
        _setLending(QUOTE_TOKEN, 101, 0); // interest or unchanged debt is not repayment
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.Uncorroborated);
        _setLending(QUOTE_TOKEN, 50, 0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.ExpectedEffect);
        _setSpot(HYPE_TOKEN, 200, 0); // debt reduced externally, no sale evidence
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.Uncorroborated);
        _setSpot(HYPE_TOKEN, 149, 0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.UnexpectedEffect);
    }

    function testQuoteConversionRequiresBothLegsAndBoundedHypeIncrease() public {
        ICoreActionObserver.Context memory c = _context(8, 100, 200, 50);
        _setSpot(QUOTE_TOKEN, 50, 0);
        _setSpot(HYPE_TOKEN, 200, 0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.Uncorroborated);
        _setSpot(QUOTE_TOKEN, 100, 0);
        _setSpot(HYPE_TOKEN, 250, 0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.Uncorroborated);
        _setSpot(QUOTE_TOKEN, 50, 0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.ExpectedEffect);
        _setSpot(HYPE_TOKEN, 251, 0);
        require(observer.observe(c).evidence == ICoreActionObserver.Evidence.UnexpectedEffect);
    }

    function testAllLendingWithdrawalKindsRequireCompletePairedEffects() public {
        uint8[3] memory kinds = [uint8(4), uint8(6), uint8(7)];
        for (uint256 i; i < kinds.length; ++i) {
            uint64 token = kinds[i] == 7 ? QUOTE_TOKEN : HYPE_TOKEN;
            ICoreActionObserver.Context memory c = _context(kinds[i], 100, 200, 100);
            _setLending(token, 0, 0);
            _setSpot(token, 200, 0);
            require(observer.observe(c).evidence == ICoreActionObserver.Evidence.Uncorroborated);
            _setLending(token, 0, 50);
            _setSpot(token, 250, 0);
            require(observer.observe(c).evidence == ICoreActionObserver.Evidence.PartialEffect);
            _setLending(token, 0, 0);
            _setSpot(token, 300, 0);
            require(observer.observe(c).evidence == ICoreActionObserver.Evidence.ExpectedEffect);
        }
    }

    function testRecallNeedsSourceDebitAndReceiptAndIsConsumedOnlyOnce() public {
        _activate();
        _closeAndWithdraw();
        strategy.advance(); // recall submission
        _advanceL1();
        system.deliver(payable(address(strategy)), DEPOSIT);
        require(_evidence() == ICoreActionObserver.Evidence.Uncorroborated, "receipt ignored source");
        require(!strategy.syncPendingAction());
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        _setSpot(QUOTE_TOKEN, 1, 0); // terminal gate intentionally fails AFTER receipt is committed
        require(strategy.syncPendingAction());
        require(!strategy.cycleStatus().pending && whype.balanceOf(address(strategy)) == DEPOSIT);
        VM.expectRevert(HyperCoreStrategyAccount.ResidualExposure.selector);
        strategy.advance();
        require(!strategy.syncPendingAction());
        require(whype.balanceOf(address(strategy)) == DEPOSIT);
        require(writer.actionCount() == 6, "recall was resubmitted");
        _setSpot(QUOTE_TOKEN, 0, 0);
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.ReturnReady);
        vault.settleEpoch(1);
        require(vault.availableCash() == DEPOSIT);
    }

    function testShortRecallReceiptNeverUsesForcedBalanceToMakeUpDifference() public {
        _activate();
        _closeAndWithdraw();
        strategy.advance();
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        system.deliver(payable(address(strategy)), DEPOSIT - 1);
        VM.deal(address(strategy), DEPOSIT);
        require(!strategy.syncPendingAction());
        require(whype.balanceOf(address(strategy)) == 0);
        system.deliver(payable(address(strategy)), 1);
        require(strategy.syncPendingAction());
        require(whype.balanceOf(address(strategy)) == DEPOSIT);
    }

    function testFuzzOpenEvidenceIsDirectionalAndBounded(int64 afterSize, uint64 rawAmount) public {
        afterSize = afterSize / 1e6 * 1e6;
        uint64 amount = rawAmount % uint64(type(int64).max) + 1;
        ICoreActionObserver.Context memory c = _context(2, 0, 0, amount);
        _setPosition(afterSize);
        ICoreActionObserver.Observation memory o = observer.observe(c);
        if (
            o.evidence == ICoreActionObserver.Evidence.ExpectedEffect
                || o.evidence == ICoreActionObserver.Evidence.PartialEffect
        ) {
            require(afterSize < 0);
            require(uint256(-int256(afterSize)) <= amount);
            require(o.effectAmount == uint256(-int256(afterSize)));
        }
    }

    function testRawSizeLotsOpenExactlyOnceAndCloseFullPosition() public {
        _opening();
        _advanceL1();
        _setRawPosition(-10_000); // -100.00 HYPE, not -0.00010000 HYPE
        require(_evidence() == ICoreActionObserver.Evidence.ExpectedEffect);
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.Active);
        require(writer.actionCount() == 3, "full hedge submitted again");
        vault.beginExit(1);
        strategy.advance(); // Active -> Closing
        strategy.advance(); // submit close
        require(writer.actionCount() == 4);
        (, bytes memory action,) = writer.latestAction();
        // The order sz word starts at payload byte 4 + 3 ABI words.
        uint256 size;
        assembly ("memory-safe") { size := mload(add(action, 132)) }
        require(size == 100e8, "close order used raw read lots");
        _advanceL1();
        _setRawPosition(-5_000);
        require(_evidence() == ICoreActionObserver.Evidence.PartialEffect);
        require(strategy.pendingActionObservation().effectAmount == 50e8);
    }
}
