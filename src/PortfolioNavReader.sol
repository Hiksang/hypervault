// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {HyperCoreNavReader} from "./HyperCoreNavReader.sol";
import {CoreRead} from "./CoreRead.sol";
import {IHyperCoreStrategyAccount} from "./interfaces/IHyperCoreStrategyAccount.sol";
import {IStrategyBalanceSheet} from "./interfaces/IStrategyBalanceSheet.sol";
import {PortfolioNavMath} from "./nav/PortfolioNavMath.sol";

/// @notice Optional NAV reader for a validated, immutable balance-sheet source.
/// @dev No production HyperCore balance-sheet source ships yet. Default deployments keep CapitalEstimate.
///      MarkToMarket is an adapter valuation, NOT a guarantee of liquidation proceeds or permission to mint.
contract PortfolioNavReader is HyperCoreNavReader {
    using SafeCast for uint256;

    address public immutable accountingAsset;
    uint8 public immutable assetDecimals;
    IStrategyBalanceSheet public immutable source;
    uint64 public immutable maxAge;

    error InvalidConfiguration();
    error InvalidSnapshot();

    constructor(address asset_, IStrategyBalanceSheet source_, uint64 maxAge_) {
        if (asset_.code.length == 0 || address(source_).code.length == 0 || maxAge_ == 0 || maxAge_ > 5 minutes) {
            revert InvalidConfiguration();
        }
        uint8 decimals_ = IERC20Metadata(asset_).decimals();
        if (decimals_ > 18) revert InvalidConfiguration();
        accountingAsset = asset_;
        assetDecimals = decimals_;
        source = source_;
        maxAge = maxAge_;
    }

    function observe(address account) public view override returns (Observation memory o) {
        IHyperCoreStrategyAccount strategy = IHyperCoreStrategyAccount(account);
        if (strategy.asset() != accountingAsset) revert InvalidSnapshot();
        IHyperCoreStrategyAccount.CycleStatus memory status = strategy.cycleStatus();
        // Cross-domain transitions are not priced as a settled portfolio.
        if (status.phase != 4 || status.pending || status.exitRequested || status.returnReady) {
            return super.observe(account);
        }
        IStrategyBalanceSheet.Snapshot memory s = source.snapshot(account);
        if (
            s.account != account || s.asset != accountingAsset || s.strategyConfigHash != strategy.configHash()
                || s.cycleId != status.cycleId || !s.complete || s.inFlight || s.coreBlock == 0
                || s.coreBlock != CoreRead.l1Block() || s.observedAt == 0 || s.observedAt > block.timestamp
                || block.timestamp - s.observedAt > maxAge
        ) revert InvalidSnapshot();
        o.netAssets = PortfolioNavMath.toAssets(PortfolioNavMath.netQuote(s.balances), s.assetPrice, assetDecimals)
            + IERC20Metadata(accountingAsset).balanceOf(account).toInt256();
        o.asOfCoreBlock = s.coreBlock;
        o.observedAt = s.observedAt;
        o.quality = Quality.MarkToMarket;
        o.cycleId = status.cycleId;
    }
}
