// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreRead} from "./CoreRead.sol";
import {ICoreActionObserver} from "./interfaces/ICoreActionObserver.sol";
import {IHyperCoreRiskOracle} from "./interfaces/IHyperCoreRiskOracle.sol";

/// @notice Read-only evidence classifier. Never accepts HTTP reports, elapsed time or caller-supplied success.
/// @dev Kind numbers follow HyperCoreStrategyAccount.ActionKind. Effects are not cloid-specific finality proofs.
contract CoreActionObserver is ICoreActionObserver {
    function observe(Context calldata c) external view returns (Observation memory o) {
        if (c.kind == 0) return o;
        o.coreBlock = CoreRead.l1Block();
        if (o.coreBlock <= c.submittedCoreBlock) {
            o.evidence = Evidence.AwaitingBlock;
            return o;
        }
        if (c.kind == 2 || c.kind == 3) return _position(c, o);
        if (c.kind == 9) return _recall(c, o);

        uint64 source;
        uint64 destination;
        if (c.kind == 1) {
            uint64 supplied = CoreRead.lending(c.account, c.hypeToken).supply.value;
            uint64 spot = CoreRead.spotBalance(c.account, c.hypeToken).total;
            if (supplied < c.primaryBefore || spot > c.secondaryBefore) {
                o.evidence = Evidence.UnexpectedEffect;
                return o;
            }
            source = c.secondaryBefore - spot;
            destination = supplied - c.primaryBefore;
        } else if (c.kind == 4 || c.kind == 6 || c.kind == 7) {
            uint64 token = c.kind == 7 ? c.quoteToken : c.hypeToken;
            uint64 supplied = CoreRead.lending(c.account, token).supply.value;
            uint64 spot = CoreRead.spotBalance(c.account, token).total;
            if (supplied > c.primaryBefore || spot < c.secondaryBefore) {
                o.evidence = Evidence.UnexpectedEffect;
                return o;
            }
            source = c.primaryBefore - supplied;
            destination = spot - c.secondaryBefore;
        } else if (c.kind == 5) {
            uint64 debt = CoreRead.lending(c.account, c.quoteToken).borrow.value;
            uint64 spot = CoreRead.spotBalance(c.account, c.hypeToken).total;
            if (spot > c.secondaryBefore) {
                o.evidence = Evidence.UnexpectedEffect;
                return o;
            }
            source = c.secondaryBefore - spot;
            // Debt may accrue interest: no reduction is never evidence of a successful repayment.
            destination = debt < c.primaryBefore ? c.primaryBefore - debt : 0;
        } else if (c.kind == 8) {
            uint64 quote = CoreRead.spotBalance(c.account, c.quoteToken).total;
            uint64 hype = CoreRead.spotBalance(c.account, c.hypeToken).total;
            if (quote > c.primaryBefore || hype < c.secondaryBefore) {
                o.evidence = Evidence.UnexpectedEffect;
                return o;
            }
            source = c.primaryBefore - quote;
            destination = hype - c.secondaryBefore;
        } else {
            o.evidence = Evidence.UnexpectedEffect;
            return o;
        }

        if (source == 0 && destination == 0) {
            o.evidence = Evidence.NoEffect;
            return o;
        }
        if (source == 0 || destination == 0) {
            o.evidence = Evidence.Uncorroborated;
            return o;
        }
        uint64 effect = c.kind == 5 ? source : destination;
        if (c.kind != 5 && c.kind != 8 && source < effect) effect = source;
        if ((c.kind == 5 || c.kind == 8) && effect > c.amount) {
            o.evidence = Evidence.UnexpectedEffect;
            return o;
        }
        o.effectAmount = effect;
        o.evidence = effect >= c.amount ? Evidence.ExpectedEffect : Evidence.PartialEffect;
    }

    function _position(Context calldata c, Observation memory o) private view returns (Observation memory) {
        int64 afterPosition = IHyperCoreRiskOracle(c.riskOracle).positionSize(c.account, c.perp);
        if (afterPosition == c.positionBefore) {
            o.evidence = Evidence.NoEffect;
            return o;
        }
        int256 delta;
        if (c.kind == 2) {
            if (c.positionBefore > 0 || afterPosition > c.positionBefore) {
                o.evidence = Evidence.UnexpectedEffect;
                return o;
            }
            delta = int256(c.positionBefore) - int256(afterPosition);
        } else if (c.positionBefore < 0 && afterPosition <= 0 && afterPosition > c.positionBefore) {
            delta = int256(afterPosition) - int256(c.positionBefore);
        } else if (c.positionBefore > 0 && afterPosition >= 0 && afterPosition < c.positionBefore) {
            delta = int256(c.positionBefore) - int256(afterPosition);
        } else {
            o.evidence = Evidence.UnexpectedEffect;
            return o;
        }
        if (uint256(delta) > c.amount) {
            o.evidence = Evidence.UnexpectedEffect;
            return o;
        }
        // Bounded by the uint64 requested amount above.
        o.effectAmount = uint64(uint256(delta));
        o.evidence = o.effectAmount == c.amount ? Evidence.ExpectedEffect : Evidence.PartialEffect;
        return o;
    }

    function _recall(Context calldata c, Observation memory o) private view returns (Observation memory) {
        uint64 spot = CoreRead.spotBalance(c.account, c.hypeToken).total;
        if (spot > c.primaryBefore || c.received < c.receiptBefore) {
            o.evidence = Evidence.UnexpectedEffect;
            return o;
        }
        uint256 received = c.received - c.receiptBefore;
        uint256 expected = uint256(c.amount) * 1e10;
        if (spot == c.primaryBefore && received == 0) {
            o.evidence = Evidence.NoEffect;
            return o;
        }
        if (uint256(c.primaryBefore - spot) >= c.amount && received >= expected && c.nativeBalance >= expected) {
            o.evidence = Evidence.ExpectedEffect;
            o.effectAmount = c.amount;
        } else {
            o.evidence = Evidence.Uncorroborated;
        }
        return o;
    }
}
