// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {CoreRead} from "./CoreRead.sol";

/// @notice Raw, coherent account observations for developing and validating the PM accounting adapter.
/// @dev NOT IStrategyBalanceSheet: does not assert complete coverage, normalize amounts, or authorize minting.
///      A missing lending state may revert on Core; that failure must not be interpreted as zero debt.
contract HyperCoreAccountReader {
    using SafeCast for uint256;

    struct Market {
        uint64 baseToken;
        uint64 quoteToken;
        uint32 perpAsset;
        uint32 spotIndex;
        uint32 perpDex;
    }

    struct Observation {
        address account;
        Market market;
        uint64 coreBlock;
        uint64 evmObservedAt;
        CoreRead.SpotBalance baseSpot;
        CoreRead.SpotBalance quoteSpot;
        CoreRead.UserLending baseLending;
        CoreRead.UserLending quoteLending;
        CoreRead.Position position;
        CoreRead.AccountMarginSummary margin;
        uint64 markPrice;
        uint64 oraclePrice;
        uint64 spotPrice;
        CoreRead.Reserve baseReserve;
        CoreRead.Reserve quoteReserve;
    }

    error InvalidAccountOrMarket();
    error InconsistentCoreBlock();

    function observe(address account, Market calldata market) external view returns (Observation memory o) {
        if (account == address(0) || market.baseToken == market.quoteToken || !CoreRead.userExists(account)) {
            revert InvalidAccountOrMarket();
        }
        o.account = account;
        o.market = market;
        o.coreBlock = CoreRead.l1Block();
        o.evmObservedAt = block.timestamp.toUint64();
        o.baseSpot = CoreRead.spotBalance(account, market.baseToken);
        o.quoteSpot = CoreRead.spotBalance(account, market.quoteToken);
        o.baseLending = CoreRead.lending(account, market.baseToken);
        o.quoteLending = CoreRead.lending(account, market.quoteToken);
        o.position = CoreRead.position(account, market.perpAsset);
        o.margin = CoreRead.accountMarginSummary(market.perpDex, account);
        o.markPrice = CoreRead.markPx(market.perpAsset);
        o.oraclePrice = CoreRead.oraclePx(market.perpAsset);
        o.spotPrice = CoreRead.spotPx(market.spotIndex);
        o.baseReserve = CoreRead.reserve(market.baseToken);
        o.quoteReserve = CoreRead.reserve(market.quoteToken);
        if (o.coreBlock == 0 || o.coreBlock != CoreRead.l1Block()) revert InconsistentCoreBlock();
    }
}
