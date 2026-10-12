// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreStrategyFixture} from "./HyperCoreStrategyAccount.t.sol";
import {HyperCoreAccountReader} from "../src/HyperCoreAccountReader.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

contract HyperCoreAccountReaderTest is CoreStrategyFixture {
    HyperCoreAccountReader internal reader;
    HyperCoreAccountReader.Market internal selected;

    function setUp() public override {
        super.setUp();
        reader = new HyperCoreAccountReader();
        selected = HyperCoreAccountReader.Market(HYPE_TOKEN, QUOTE_TOKEN, HYPE_PERP, HYPE_SPOT_INDEX, 0);
        MockReadPrecompile template = new MockReadPrecompile();
        VM.etch(address(0x0806), address(template).code);
        VM.etch(address(0x080f), address(template).code);
        VM.etch(address(0x0812), address(template).code);
        MockReadPrecompile(address(0x0806)).setResponse(abi.encode(HYPE_PERP), abi.encode(uint64(911360)));
        MockReadPrecompile(address(0x080f))
            .setResponse(
                abi.encode(uint32(0), address(strategy)), abi.encode(int64(-50), uint64(20), uint64(100), int64(-60))
            );
        bytes memory reserve =
            abi.encode(uint64(500), uint64(0), uint64(100), uint64(0), uint64(1), uint64(0), uint64(100), uint64(0));
        MockReadPrecompile(address(0x0812)).setResponse(abi.encode(HYPE_TOKEN), reserve);
        MockReadPrecompile(address(0x0812)).setResponse(abi.encode(QUOTE_TOKEN), reserve);
    }

    function testSnapshotPreservesRawSignedFieldsAndMarketScope() public {
        HyperCoreAccountReader.Observation memory o = reader.observe(address(strategy), selected);
        require(o.account == address(strategy) && o.market.baseToken == HYPE_TOKEN && o.market.perpDex == 0);
        require(o.coreBlock == l1Block && o.evmObservedAt == block.timestamp);
        require(o.margin.accountValue == -50 && o.margin.rawUsd == -60 && o.margin.ntlPos == 100);
        require(o.markPrice == 911360 && o.baseSpot.total == CORE_GAS_RESERVE);
        require(o.quoteReserve.oraclePx == 1, "raw quote reserve price rescaled");
    }

    function testLendingReadFailureIsNotZeroDebt() public {
        MockReadPrecompile(LENDING).setRevert(abi.encode(address(strategy), QUOTE_TOKEN), true);
        VM.expectRevert(abi.encodeWithSelector(CoreRead.ReadFailed.selector, LENDING));
        reader.observe(address(strategy), selected);
    }

    function testNoncanonicalSignedMarginIsRejected() public {
        MockReadPrecompile(address(0x080f))
            .setResponse(
                abi.encode(uint32(0), address(strategy)),
                abi.encode(uint256(type(uint64).max), uint256(0), uint256(0), uint256(0))
            );
        VM.expectRevert();
        reader.observe(address(strategy), selected);
    }

    function testMarginAndMarkMalformedDataFailClosed() public {
        MockReadPrecompile(address(0x080f))
            .setResponse(abi.encode(uint32(0), address(strategy)), abi.encode(uint256(0)));
        VM.expectRevert(abi.encodeWithSelector(CoreRead.InvalidReturnLength.selector, address(0x080f), uint256(32)));
        reader.observe(address(strategy), selected);
        MockReadPrecompile(address(0x080f))
            .setResponse(abi.encode(uint32(0), address(strategy)), abi.encode(int64(0), uint64(0), uint64(0), int64(0)));
        MockReadPrecompile(address(0x0806)).setResponse(abi.encode(HYPE_PERP), hex"");
        VM.expectRevert(abi.encodeWithSelector(CoreRead.InvalidReturnLength.selector, address(0x0806), uint256(0)));
        reader.observe(address(strategy), selected);
    }

    function testWrongDexCannotReadDefaultMargin() public {
        selected.perpDex = 1;
        VM.expectRevert(abi.encodeWithSelector(CoreRead.ReadFailed.selector, address(0x080f)));
        reader.observe(address(strategy), selected);
    }

    function testMissingAccountOrDuplicateTokensRejected() public {
        _setExists(false);
        VM.expectRevert(HyperCoreAccountReader.InvalidAccountOrMarket.selector);
        reader.observe(address(strategy), selected);
        _setExists(true);
        selected.quoteToken = selected.baseToken;
        VM.expectRevert(HyperCoreAccountReader.InvalidAccountOrMarket.selector);
        reader.observe(address(strategy), selected);
    }
}
