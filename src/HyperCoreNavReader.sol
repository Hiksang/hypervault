// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IHyperCoreNavReader} from "./interfaces/IHyperCoreNavReader.sol";
import {IHyperCoreStrategyAccount} from "./interfaces/IHyperCoreStrategyAccount.sol";

/// @notice Honest observation boundary until PM spot/lending/equity units are verified.
/// @dev CapitalEstimate is NOT current PM equity. No user-supplied NAV setter and no double counting.
contract HyperCoreNavReader is IHyperCoreNavReader {
    using SafeCast for uint256;

    function observe(address account) public view virtual returns (Observation memory o) {
        IHyperCoreStrategyAccount strategy = IHyperCoreStrategyAccount(account);
        IHyperCoreStrategyAccount.CycleStatus memory s = strategy.cycleStatus();
        o.observedAt = block.timestamp.toUint64();
        o.inFlight = s.pending;
        o.cycleId = s.cycleId;
        if (s.returnReady || s.phase == 0) {
            if (s.pending) return o;
            o.netAssets = IERC20(strategy.asset()).balanceOf(account).toInt256();
            o.quality = Quality.Realized;
        } else {
            o.netAssets = strategy.accountedCapital().toInt256();
            o.quality = Quality.CapitalEstimate;
        }
        // asOfCoreBlock stays zero: the reader has not observed verified PM equity.
    }
}
