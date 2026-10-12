// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IHyperVaultPriceHistory {
    struct PriceRecord {
        uint192 price;
        uint64 time;
    }

    function priceWindow() external view returns (uint256);
    function priceRecords(address vault) external view returns (PriceRecord[8] memory);
}

interface IHyperVaultFeeState {
    function totalSupply() external view returns (uint256);
    function performanceFeeBps() external view returns (uint256);
}

/// @notice Exchange rate and high-water-mark performance fee of HyperVaults, like kHYPE's
///         StakingAccountant beside its StakingManager. Shared by Vaults; each Vault writes only
///         its own entry (msg.sender).
/// @dev Prices are assets per share at 1e30 with the Vault's virtual offset (+1 asset, +1000
///      shares), the convention of the NAV verifier's price records. The fee is charged only on
///      the share price rising above its high-water mark, so a loss is recovered fee-free. A Core
///      valuation is capped by the lowest price the verifier recorded in its window: a spike
///      shorter than the window is neither charged nor published. EVM cash (an Idle Vault or an
///      exit) is realized and taken as is. The Vault mints the returned fee shares.
contract HyperVaultAccountant {
    uint256 public constant PRICE_SCALE = 1e30;
    /// @dev Keeps the fee below half of the assets, so fee shares are always finite.
    uint256 public constant MAX_FEE_BPS = 5_000;

    struct Mark {
        uint256 highWaterMark; // post-fee share price above which the next fee is charged
        uint256 rate; // last verified, conservative post-fee share price
        uint256 updatedAt;
    }

    IHyperVaultPriceHistory public immutable history;
    mapping(address vault => Mark) public marks;

    event Crystallized(
        address indexed vault, uint256 rate, uint256 highWaterMark, uint256 feeAssets, uint256 feeShares
    );

    error InvalidConfiguration();

    constructor(IHyperVaultPriceHistory history_) {
        if (address(history_).code.length == 0) revert InvalidConfiguration();
        history = history_;
    }

    /// @notice Fee shares due at `assets`, the fee in assets, and the post-fee share price.
    function quote(address vault, uint256 assets, bool realized)
        public
        view
        returns (uint256 feeShares, uint256 feeAssets, uint256 price)
    {
        IHyperVaultFeeState v = IHyperVaultFeeState(vault);
        uint256 supply = v.totalSupply() + 1000;
        price = Math.mulDiv(assets + 1, PRICE_SCALE, supply);
        if (supply == 1000) return (0, 0, price);
        if (!realized) price = Math.min(price, windowLow(vault));
        uint256 mark = marks[vault].highWaterMark;
        uint256 bps = Math.min(v.performanceFeeBps(), MAX_FEE_BPS);
        if (price > mark && bps != 0) {
            feeAssets = Math.mulDiv(price - mark, supply * bps, PRICE_SCALE * 10_000);
            feeShares = Math.mulDiv(feeAssets, supply, assets + 1 - feeAssets);
            price = Math.mulDiv(price, supply, supply + feeShares);
        }
    }

    /// @notice Called by a Vault at its live NAV `assets` right before it mints fee shares
    ///         (and before any deposit or settlement at that NAV). An empty Vault restarts its
    ///         mark at the price new holders enter at.
    function crystallize(uint256 assets, bool realized) external returns (uint256 feeShares) {
        uint256 feeAssets;
        uint256 price;
        (feeShares, feeAssets, price) = quote(msg.sender, assets, realized);
        Mark storage m = marks[msg.sender];
        if (feeShares != 0 || IHyperVaultFeeState(msg.sender).totalSupply() == 0) m.highWaterMark = price;
        m.rate = price;
        m.updatedAt = block.timestamp;
        emit Crystallized(msg.sender, price, m.highWaterMark, feeAssets, feeShares);
    }

    /// @notice Lowest share price the verifier recorded for `vault` inside its window
    ///         (type(uint256).max without records).
    function windowLow(address vault) public view returns (uint256 low) {
        IHyperVaultPriceHistory.PriceRecord[8] memory records = history.priceRecords(vault);
        uint256 window = history.priceWindow();
        low = type(uint256).max;
        for (uint256 i; i < 8; ++i) {
            if (records[i].time != 0 && block.timestamp - records[i].time <= window && records[i].price < low) {
                low = records[i].price;
            }
        }
    }

    function convertToAssets(address vault, uint256 shares) external view returns (uint256) {
        return Math.mulDiv(shares, marks[vault].rate, PRICE_SCALE);
    }

    function convertToShares(address vault, uint256 assets) external view returns (uint256) {
        uint256 rate = marks[vault].rate;
        return rate == 0 ? 0 : Math.mulDiv(assets, PRICE_SCALE, rate);
    }
}
