// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {CoreRead} from "./CoreRead.sol";
import {IHyperCoreRiskOracle} from "./interfaces/IHyperCoreRiskOracle.sol";

/// @notice Converts HyperCore read-precompile units into CoreWriter order units and applies risk bounds.
/// @dev The immutable market configuration must be derived from the target network metadata and verified
///      with a small live order. This contract deliberately supports exactly one perp and one spot market.
contract HyperCoreRiskOracle is IHyperCoreRiskOracle {
    using SafeCast for uint256;

    uint16 private constant BPS = 10_000;

    struct MarketConfig {
        uint32 actionAsset;
        uint32 referenceIndex;
        uint64 readToOrderMultiplier;
        uint8 maxPriceDecimals;
        uint64 orderSizeLot;
    }

    struct Config {
        MarketConfig perp;
        MarketConfig spot;
        uint16 maxSlippageBps;
        uint16 maxBboDeviationBps;
    }

    struct Market {
        uint32 referenceIndex;
        uint64 readToOrderMultiplier;
        uint8 maxPriceDecimals;
        uint64 orderSizeLot;
        bool isSpot;
    }

    uint16 public immutable maxSlippageBps;
    uint16 public immutable maxBboDeviationBps;
    uint32 public immutable perpAsset;
    uint32 public immutable spotAsset;
    Market private _perp;
    Market private _spot;

    error InvalidConfiguration();
    error UnsupportedAsset(uint32 asset);
    error NoLiquidity();
    error InvalidBook(uint64 bid, uint64 ask);
    error OracleDeviation(uint256 bookPrice, uint256 oraclePrice);

    constructor(Config memory config) {
        if (
            config.perp.actionAsset == config.spot.actionAsset || config.perp.readToOrderMultiplier == 0
                || config.spot.readToOrderMultiplier == 0 || config.perp.maxPriceDecimals > 8
                || config.spot.maxPriceDecimals > 8 || config.perp.orderSizeLot == 0 || config.spot.orderSizeLot == 0
                || config.maxSlippageBps == 0 || config.maxSlippageBps >= BPS || config.maxBboDeviationBps == 0
                || config.maxBboDeviationBps >= BPS
        ) revert InvalidConfiguration();

        maxSlippageBps = config.maxSlippageBps;
        maxBboDeviationBps = config.maxBboDeviationBps;
        perpAsset = config.perp.actionAsset;
        spotAsset = config.spot.actionAsset;
        _perp = Market({
            referenceIndex: config.perp.referenceIndex,
            readToOrderMultiplier: config.perp.readToOrderMultiplier,
            maxPriceDecimals: config.perp.maxPriceDecimals,
            orderSizeLot: config.perp.orderSizeLot,
            isSpot: false
        });
        _spot = Market({
            referenceIndex: config.spot.referenceIndex,
            readToOrderMultiplier: config.spot.readToOrderMultiplier,
            maxPriceDecimals: config.spot.maxPriceDecimals,
            orderSizeLot: config.spot.orderSizeLot,
            isSpot: true
        });
    }

    function buyLimit(uint32 asset) external view returns (uint64) {
        (Market memory selectedMarket,, uint256 ask) = _validatedBook(asset);
        uint256 slipped = Math.mulDiv(ask, BPS + maxSlippageBps, BPS, Math.Rounding.Ceil);
        uint256 tick = _priceTick(slipped, selectedMarket.maxPriceDecimals);
        return (Math.ceilDiv(slipped, tick) * tick).toUint64();
    }

    function positionSize(address account, uint32 asset) external view returns (int64) {
        if (asset != perpAsset) revert UnsupportedAsset(asset);
        // Raw szi is measured in the market's size lots, NOT CoreWriter's fixed 1e8 scale.
        // orderSizeLot must be configured as 10 ** (8 - perp szDecimals), verified against metadata.
        return SafeCast.toInt64(int256(CoreRead.position(account, asset).szi) * int256(uint256(_perp.orderSizeLot)));
    }

    function sellLimit(uint32 asset) external view returns (uint64) {
        return _sellLimit(asset);
    }

    function _sellLimit(uint32 asset) private view returns (uint64) {
        (Market memory selectedMarket, uint256 bid,) = _validatedBook(asset);
        uint256 slipped = Math.mulDiv(bid, BPS - maxSlippageBps, BPS, Math.Rounding.Floor);
        uint256 tick = _priceTick(slipped, selectedMarket.maxPriceDecimals);
        return (slipped / tick * tick).toUint64();
    }

    function roundSizeDown(uint32 asset, uint64 size) external view returns (uint64) {
        uint64 lot = _market(asset).orderSizeLot;
        return size / lot * lot;
    }

    function roundSizeUp(uint32 asset, uint64 size) external view returns (uint64) {
        uint64 lot = _market(asset).orderSizeLot;
        return (Math.ceilDiv(size, lot) * lot).toUint64();
    }

    function isSizeAligned(uint32 asset, uint64 size) external view returns (bool) {
        return size % _market(asset).orderSizeLot == 0;
    }

    function repaySize(uint32 asset, uint64 quoteDebt, uint64 limitPrice, uint16 bufferBps)
        external
        view
        returns (uint64)
    {
        return _repaySize(asset, quoteDebt, limitPrice, bufferBps);
    }

    function recapitalizationSize(
        address account,
        uint64 hypeToken,
        uint64 quoteToken,
        uint32 spotActionAsset,
        uint64 gasReserve,
        uint16 bufferBps
    ) external view returns (uint64) {
        uint64 debt = CoreRead.lending(account, quoteToken).borrow.value;
        if (debt == 0 || CoreRead.lending(account, hypeToken).supply.value != 0) revert InvalidConfiguration();
        uint64 needed = _repaySize(spotActionAsset, debt, _sellLimit(spotActionAsset), bufferBps);
        CoreRead.SpotBalance memory balance = CoreRead.spotBalance(account, hypeToken);
        uint64 available = balance.total > balance.hold ? balance.total - balance.hold : 0;
        uint64 usable = available > gasReserve ? available - gasReserve : 0;
        if (usable >= needed) revert InvalidConfiguration();
        return needed - usable;
    }

    function accountIsClean(address account, uint64 hypeToken, uint64 quoteToken, uint32 checkedPerpAsset)
        external
        view
        returns (bool)
    {
        CoreRead.UserLending memory hypeLending = CoreRead.lending(account, hypeToken);
        CoreRead.UserLending memory quoteLending = CoreRead.lending(account, quoteToken);
        return CoreRead.position(account, checkedPerpAsset).szi == 0 && hypeLending.supply.value == 0
            && hypeLending.borrow.value == 0 && quoteLending.supply.value == 0 && quoteLending.borrow.value == 0
            && CoreRead.spotBalance(account, hypeToken).hold == 0 && CoreRead.spotBalance(account, quoteToken).hold == 0;
    }

    function _repaySize(uint32 asset, uint64 quoteDebt, uint64 limitPrice, uint16 bufferBps)
        private
        view
        returns (uint64)
    {
        if (limitPrice == 0 || bufferBps < BPS) revert InvalidConfiguration();
        uint64 lot = _market(asset).orderSizeLot;
        uint256 raw = Math.mulDiv(quoteDebt, uint256(1e8) * bufferBps, uint256(limitPrice) * BPS, Math.Rounding.Ceil);
        return (Math.ceilDiv(raw, lot) * lot).toUint64();
    }

    function market(uint32 asset) external view returns (Market memory) {
        return _market(asset);
    }

    function _validatedBook(uint32 asset)
        private
        view
        returns (Market memory selectedMarket, uint256 bid, uint256 ask)
    {
        selectedMarket = _market(asset);
        CoreRead.Bbo memory book = CoreRead.bbo(asset);
        if (book.bid == 0 || book.ask == 0) revert NoLiquidity();
        if (book.bid > book.ask) revert InvalidBook(book.bid, book.ask);

        uint256 multiplier = selectedMarket.readToOrderMultiplier;
        bid = uint256(book.bid) * multiplier;
        ask = uint256(book.ask) * multiplier;
        uint64 rawReference = selectedMarket.isSpot
            ? CoreRead.spotPx(selectedMarket.referenceIndex)
            : CoreRead.oraclePx(selectedMarket.referenceIndex);
        if (rawReference == 0) revert NoLiquidity();
        uint256 oraclePrice = uint256(rawReference) * multiplier;
        _checkDeviation(bid, oraclePrice);
        _checkDeviation(ask, oraclePrice);
    }

    function _checkDeviation(uint256 price, uint256 oraclePrice) private view {
        uint256 difference = price > oraclePrice ? price - oraclePrice : oraclePrice - price;
        if (difference * BPS > oraclePrice * maxBboDeviationBps) revert OracleDeviation(price, oraclePrice);
    }

    /// @dev HyperCore prices allow at most five significant figures and a market-specific decimal cap.
    ///      Values use CoreWriter's 1e8 order-price scale.
    function _priceTick(uint256 price, uint8 maxDecimals) private pure returns (uint256) {
        uint256 digits;
        uint256 cursor = price;
        while (cursor != 0) {
            unchecked {
                ++digits;
            }
            cursor /= 10;
        }
        uint256 significantFigureTick = digits > 5 ? 10 ** (digits - 5) : 1;
        uint256 decimalTick = 10 ** (8 - maxDecimals);
        return significantFigureTick > decimalTick ? significantFigureTick : decimalTick;
    }

    function _market(uint32 asset) private view returns (Market memory) {
        if (asset == perpAsset) return _perp;
        if (asset == spotAsset) return _spot;
        revert UnsupportedAsset(asset);
    }
}
