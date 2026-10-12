// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IStrategyBalanceSheet} from "../interfaces/IStrategyBalanceSheet.sol";

/// @notice Values a disjoint balance sheet. Normalization and completeness belong to the source adapter.
library PortfolioNavMath {
    using SafeCast for uint256;

    error InvalidAssetPrice();
    error UnsupportedDecimals();

    function netQuote(IStrategyBalanceSheet.Balances memory b) internal pure returns (int256) {
        return b.spotValue.toInt256() + b.suppliedValue.toInt256() + b.perpCollateralValue.toInt256() + b.unrealizedPnl
            + b.unsettledFunding - b.debtValue.toInt256() - b.accruedFees.toInt256() - b.excludedValue.toInt256();
    }

    /// @dev Round signed NAV towards negative infinity, including a sub-wei debt. Never clamp losses here.
    function toAssets(int256 quoteValue, uint256 assetPrice, uint8 assetDecimals) internal pure returns (int256) {
        if (assetPrice == 0) revert InvalidAssetPrice();
        if (assetDecimals > 18) revert UnsupportedDecimals();
        uint256 scale = 10 ** assetDecimals;
        if (quoteValue >= 0) {
            return Math.mulDiv(uint256(quoteValue), scale, assetPrice, Math.Rounding.Floor).toInt256();
        }
        uint256 magnitude = uint256(-(quoteValue + 1)) + 1;
        uint256 converted = Math.mulDiv(magnitude, scale, assetPrice, Math.Rounding.Ceil);
        if (converted == uint256(1) << 255) return type(int256).min;
        return -converted.toInt256();
    }
}
