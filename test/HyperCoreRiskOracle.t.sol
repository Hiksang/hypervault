// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {HyperCoreRiskOracle} from "../src/HyperCoreRiskOracle.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

interface VmRiskOracle {
    function etch(address target, bytes calldata code) external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
}

contract HyperCoreRiskOracleTest {
    VmRiskOracle private constant VM = VmRiskOracle(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant ORACLE_PX = address(0x0807);
    address private constant SPOT_PX = address(0x0808);
    address private constant BBO = address(0x080e);

    uint32 private constant HYPE_PERP = 159;
    uint32 private constant HYPE_SPOT = 10_107;
    uint32 private constant HYPE_SPOT_INDEX = 107;
    uint32 private constant UNKNOWN_ASSET = 42;

    uint64 private constant PERP_MULTIPLIER = 1e4;
    uint64 private constant SPOT_MULTIPLIER = 1e2;
    uint8 private constant PERP_MAX_PRICE_DECIMALS = 4;
    uint8 private constant SPOT_MAX_PRICE_DECIMALS = 6;
    uint64 private constant PERP_SIZE_LOT = 1e6;
    uint64 private constant SPOT_SIZE_LOT = 1e6;

    HyperCoreRiskOracle private oracle;

    function setUp() public {
        MockReadPrecompile template = new MockReadPrecompile();
        bytes memory runtime = address(template).code;
        VM.etch(ORACLE_PX, runtime);
        VM.etch(SPOT_PX, runtime);
        VM.etch(BBO, runtime);
        VM.etch(address(0x0813), runtime);

        oracle = new HyperCoreRiskOracle(
            HyperCoreRiskOracle.Config({
                perp: HyperCoreRiskOracle.MarketConfig({
                    actionAsset: HYPE_PERP,
                    referenceIndex: HYPE_PERP,
                    readToOrderMultiplier: PERP_MULTIPLIER,
                    maxPriceDecimals: PERP_MAX_PRICE_DECIMALS,
                    orderSizeLot: PERP_SIZE_LOT
                }),
                spot: HyperCoreRiskOracle.MarketConfig({
                    actionAsset: HYPE_SPOT,
                    referenceIndex: HYPE_SPOT_INDEX,
                    readToOrderMultiplier: SPOT_MULTIPLIER,
                    maxPriceDecimals: SPOT_MAX_PRICE_DECIMALS,
                    orderSizeLot: SPOT_SIZE_LOT
                }),
                maxSlippageBps: 100,
                maxBboDeviationBps: 200
            })
        );
    }

    function testRecordedHypePositionUsesSizeDecimalsNotFixedEightDecimals() public {
        address account = address(123);
        // Mainnet PM sample: API -1416.43 HYPE, precompile szi -141643, szDecimals=2.
        MockReadPrecompile(address(0x0813))
            .setResponse(
                abi.encode(account, HYPE_PERP),
                abi.encode(int64(-141643), uint64(109552995500), int64(0), uint32(3), false)
            );
        require(oracle.positionSize(account, HYPE_PERP) == -141643000000);
    }

    function testPositionNormalizationCannotTruncateOnOverflow() public {
        MockReadPrecompile(address(0x0813))
            .setResponse(
                abi.encode(address(123), HYPE_PERP), abi.encode(type(int64).max, uint64(0), int64(0), uint32(3), false)
            );
        VM.expectRevert(
            abi.encodeWithSignature(
                "SafeCastOverflowedIntDowncast(uint8,int256)", uint8(64), int256(type(int64).max) * 1e6
            )
        );
        oracle.positionSize(address(123), HYPE_PERP);
    }

    function testPerpReadUnitsAreScaledByOneE4BeforeSlippageAndTickRounding() public {
        _setPerpReference(100_000);
        _setBook(HYPE_PERP, 99_997, 100_003);

        // bid: 99_997 * 1e4, minus 1%, rounded down to five significant figures.
        require(oracle.sellLimit(HYPE_PERP) == 989_970_000, "wrong perp sell limit");
        // ask: 100_003 * 1e4, plus 1%, rounded up to five significant figures.
        require(oracle.buyLimit(HYPE_PERP) == 1_010_100_000, "wrong perp buy limit");

        HyperCoreRiskOracle.Market memory marketConfig = oracle.market(HYPE_PERP);
        require(marketConfig.readToOrderMultiplier == 1e4, "wrong perp multiplier");
        require(marketConfig.maxPriceDecimals == 4, "wrong perp price decimals");
        require(!marketConfig.isSpot, "perp marked as spot");
    }

    function testSpotReadUnitsAreScaledByOneE2BeforeSlippageAndTickRounding() public {
        _setSpotReference(10_000_000);
        _setBook(HYPE_SPOT, 9_999_997, 10_000_003);

        // bid: 9_999_997 * 1e2, minus 1%, rounded down to five significant figures.
        require(oracle.sellLimit(HYPE_SPOT) == 989_990_000, "wrong spot sell limit");
        // ask: 10_000_003 * 1e2, plus 1%, rounded up to five significant figures.
        require(oracle.buyLimit(HYPE_SPOT) == 1_010_100_000, "wrong spot buy limit");

        HyperCoreRiskOracle.Market memory marketConfig = oracle.market(HYPE_SPOT);
        require(marketConfig.referenceIndex == HYPE_SPOT_INDEX, "wrong spot reference index");
        require(marketConfig.readToOrderMultiplier == 1e2, "wrong spot multiplier");
        require(marketConfig.maxPriceDecimals == 6, "wrong spot price decimals");
        require(marketConfig.isSpot, "spot marked as perp");
    }

    function testDeviationBoundaryIsAcceptedAndOneUnitBeyondIsRejected() public {
        _setPerpReference(100_000);

        // Exactly +2% is allowed because the guard rejects only values beyond the configured bound.
        _setBook(HYPE_PERP, 100_000, 102_000);
        require(oracle.buyLimit(HYPE_PERP) == 1_030_200_000, "boundary price rejected");

        _setBook(HYPE_PERP, 100_000, 102_001);
        VM.expectRevert(
            abi.encodeWithSelector(HyperCoreRiskOracle.OracleDeviation.selector, uint256(1_020_010_000), uint256(1e9))
        );
        oracle.buyLimit(HYPE_PERP);
    }

    function testDynamicSignificantFigureTickChangesAtOneHundredDollars() public {
        _setPerpReference(1_000_000); // $100 in the perp read-precompile scale.

        // After the 1% sell slippage this is $99.9999. Five significant figures use a $0.001 tick.
        _setBook(HYPE_PERP, 1_010_100, 1_010_100);
        require(oracle.sellLimit(HYPE_PERP) == 9_999_900_000, "wrong sub-$100 tick");

        // After slippage this is just above $100. Five significant figures now use a $0.01 tick.
        _setBook(HYPE_PERP, 1_010_102, 1_010_102);
        require(oracle.sellLimit(HYPE_PERP) == 10_000_000_000, "wrong $100 tick");
    }

    function testDeviationGuardChecksBothSidesOfBook() public {
        _setSpotReference(10_000_000);

        _setBook(HYPE_SPOT, 9_799_999, 10_000_000);
        VM.expectRevert(
            abi.encodeWithSelector(HyperCoreRiskOracle.OracleDeviation.selector, uint256(979_999_900), uint256(1e9))
        );
        oracle.sellLimit(HYPE_SPOT);

        _setBook(HYPE_SPOT, 10_000_000, 10_200_001);
        VM.expectRevert(
            abi.encodeWithSelector(HyperCoreRiskOracle.OracleDeviation.selector, uint256(1_020_000_100), uint256(1e9))
        );
        oracle.sellLimit(HYPE_SPOT);
    }

    function testZeroAndCrossedBooksFailClosed() public {
        _setPerpReference(100_000);

        _setBook(HYPE_PERP, 0, 100_000);
        VM.expectRevert(HyperCoreRiskOracle.NoLiquidity.selector);
        oracle.buyLimit(HYPE_PERP);

        _setBook(HYPE_PERP, 100_000, 0);
        VM.expectRevert(HyperCoreRiskOracle.NoLiquidity.selector);
        oracle.sellLimit(HYPE_PERP);

        _setBook(HYPE_PERP, 100_001, 100_000);
        VM.expectRevert(
            abi.encodeWithSelector(HyperCoreRiskOracle.InvalidBook.selector, uint64(100_001), uint64(100_000))
        );
        oracle.buyLimit(HYPE_PERP);
    }

    function testZeroReferencePriceFailsClosed() public {
        _setPerpReference(0);
        _setBook(HYPE_PERP, 100_000, 100_000);

        VM.expectRevert(HyperCoreRiskOracle.NoLiquidity.selector);
        oracle.buyLimit(HYPE_PERP);
    }

    function testSizeRoundingUsesEachMarketsConfiguredLot() public view {
        require(oracle.roundSizeDown(HYPE_PERP, 2_999_999) == 2_000_000, "wrong perp down round");
        require(oracle.roundSizeUp(HYPE_PERP, 2_000_001) == 3_000_000, "wrong perp up round");
        require(oracle.isSizeAligned(HYPE_PERP, 3_000_000), "aligned perp rejected");
        require(!oracle.isSizeAligned(HYPE_PERP, 3_000_001), "unaligned perp accepted");

        require(oracle.roundSizeDown(HYPE_SPOT, 2_999_999) == 2_000_000, "wrong spot down round");
        require(oracle.roundSizeUp(HYPE_SPOT, 2_000_001) == 3_000_000, "wrong spot up round");
        require(oracle.isSizeAligned(HYPE_SPOT, 3_000_000), "aligned spot rejected");
        require(!oracle.isSizeAligned(HYPE_SPOT, 3_000_001), "unaligned spot accepted");
    }

    function testUnsupportedAssetFailsBeforeAnyPrecompileRead() public {
        bytes memory expected = abi.encodeWithSelector(HyperCoreRiskOracle.UnsupportedAsset.selector, UNKNOWN_ASSET);

        VM.expectRevert(expected);
        oracle.buyLimit(UNKNOWN_ASSET);
        VM.expectRevert(expected);
        oracle.sellLimit(UNKNOWN_ASSET);
        VM.expectRevert(expected);
        oracle.roundSizeDown(UNKNOWN_ASSET, 1);
        VM.expectRevert(expected);
        oracle.roundSizeUp(UNKNOWN_ASSET, 1);
        VM.expectRevert(expected);
        oracle.isSizeAligned(UNKNOWN_ASSET, 1);
        VM.expectRevert(expected);
        oracle.market(UNKNOWN_ASSET);
    }

    function _setBook(uint32 asset, uint64 bid, uint64 ask) private {
        MockReadPrecompile(BBO).setResponse(abi.encode(asset), abi.encode(bid, ask));
    }

    function _setPerpReference(uint64 price) private {
        MockReadPrecompile(ORACLE_PX).setResponse(abi.encode(HYPE_PERP), abi.encode(price));
    }

    function _setSpotReference(uint64 price) private {
        MockReadPrecompile(SPOT_PX).setResponse(abi.encode(HYPE_SPOT_INDEX), abi.encode(price));
    }
}
