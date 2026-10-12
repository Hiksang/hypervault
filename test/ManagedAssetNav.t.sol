// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {ManagedAssetNavVerifier} from "../src/managed/ManagedAssetNavVerifier.sol";
import {HyperCorePrecompileSource} from "../src/nav/HyperCorePrecompileSource.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {TestUbtc, VmAsset} from "./ManagedAssetVault.t.sol";
import {ManagedTestUsdc, ManagedTestDepositWallet} from "./ManagedUsdcVault.t.sol";

interface VmAssetTime {
    function warp(uint256) external;
}

contract AssetNavState {
    address public owner;
    address public asset;
    uint256 public availableCash = 100000; // .001 UBTC
    uint256 public totalSupply = 200000000;
    uint256 public actionNonce;
    bytes32 public configHash;
    uint8 public phase = 4;

    constructor(address token) {
        owner = msg.sender;
        asset = token;
    }
}

/// @dev Real precompile source + real denomination verifier; raw reads are synthetic fixtures.
contract ManagedAssetNavTest {
    VmAsset constant vm = VmAsset(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestUbtc btc;
    ManagedAssetBridge bridge;
    HyperCorePrecompileSource source;
    ManagedAssetNavVerifier verifier;
    AssetNavState vault;

    function setUp() public {
        btc = new TestUbtc();
        ManagedTestUsdc usd = new ManagedTestUsdc();
        ManagedTestDepositWallet circle = new ManagedTestDepositWallet(usd);
        CoreRead.TokenInfo memory info;
        info.evmContract = address(btc);
        info.szDecimals = 5;
        info.weiDecimals = 10;
        info.evmExtraWeiDecimals = -2;
        vm.mockCall(address(0x080c), abi.encode(uint32(197)), abi.encode(info));
        CoreRead.SpotInfo memory pair;
        pair.tokens[0] = 197;
        vm.mockCall(address(0x080b), abi.encode(uint32(142)), abi.encode(pair));
        _price(100_000e3);
        bridge = new ManagedAssetBridge(
            address(btc), address(usd), address(circle), ManagedAssetBridge.Kind.LinkedToken, 197, 142
        );
        CoreRead.TokenInfo memory usdInfo;
        usdInfo.evmContract = address(circle);
        usdInfo.szDecimals = 8;
        usdInfo.weiDecimals = 8;
        usdInfo.evmExtraWeiDecimals = -2;
        vm.mockCall(address(0x080c), abi.encode(uint32(0)), abi.encode(usdInfo));
        source = new HyperCorePrecompileSource(address(usd), address(circle), 0);
        verifier = new ManagedAssetNavVerifier(bridge, source, 10_000, 100_000, 10 minutes, 500);
        vault = new AssetNavState(address(btc));
        vm.mockCall(address(0x0809), bytes(""), abi.encode(uint64(100)));
        // .002 UBTC spot + .001 supply - .002 debt = .001 UBTC net Core equity.
        vm.mockCall(address(0x0801), bytes(""), abi.encode(uint64(20_000_000), uint64(0), uint64(0)));
        vm.mockCall(
            address(0x0811),
            bytes(""),
            abi.encode(
                CoreRead.UserLending(CoreRead.BasisAndValue(0, 20_000_000), CoreRead.BasisAndValue(0, 10_000_000))
            )
        );
        vm.mockCall(address(0x0801), abi.encode(address(vault), uint64(0)), abi.encode(uint64(0), uint64(0), uint64(0)));
        vm.mockCall(
            address(0x0811),
            abi.encode(address(vault), uint64(0)),
            abi.encode(CoreRead.UserLending(CoreRead.BasisAndValue(0, 0), CoreRead.BasisAndValue(0, 0)))
        );
        HyperCorePrecompileSource.Token[] memory tokens = new HyperCorePrecompileSource.Token[](2);
        tokens[0] = HyperCorePrecompileSource.Token(0, 0, true, false);
        tokens[1] = HyperCorePrecompileSource.Token(197, 142, true, true);
        source.configure(address(vault), tokens, new uint32[](0), new address[](0), true);
    }

    function _price(uint64 raw) private {
        vm.mockCall(address(0x0808), abi.encode(uint32(142)), abi.encode(raw));
        CoreRead.Reserve memory reserve;
        reserve.oraclePx = raw;
        vm.mockCall(address(0x0812), abi.encode(uint64(197)), abi.encode(reserve));
    }

    function testSpotSupplyDebtNetConvertedToUbtc() public view {
        (uint256 assets,) = verifier.nav(address(vault));
        require(assets == 200000, ".002 UBTC with EVM cash");
    }

    function testUnderlyingPriceRiseAloneDoesNotCreateUbtcProfit() public {
        (uint256 beforeAssets,) = verifier.nav(address(vault));
        _price(200_000e3);
        (uint256 afterAssets,) = verifier.nav(address(vault));
        require(beforeAssets == afterAssets, "no USD denomination leak");
    }

    function testPriceHistoryRequiredAndThenAccepts() public {
        vm.expectRevert(ManagedAssetNavVerifier.PriceHistoryTooShort.selector);
        verifier.verifyNav(address(vault), 0, bytes32(0));
        verifier.recordPrice(address(vault));
        VmAssetTime(address(vm)).warp(block.timestamp + 301);
        (uint256 assets,) = verifier.verifyNav(address(vault), 0, bytes32(0));
        require(assets == 200000, "live nav");
    }

    function testPriceReadFailureNeverBecomesZero() public {
        vm.mockCallRevert(address(0x0812), abi.encode(uint64(197)), hex"dead");
        vm.expectRevert();
        verifier.nav(address(vault));
    }

    function testNegativeCoreCannotBeNettedAgainstCash() public {
        vm.mockCall(
            address(0x0811),
            bytes(""),
            abi.encode(
                CoreRead.UserLending(CoreRead.BasisAndValue(0, 40_000_000), CoreRead.BasisAndValue(0, 10_000_000))
            )
        );
        vm.expectRevert(ManagedAssetNavVerifier.NegativeCoreEquity.selector);
        verifier.nav(address(vault));
    }

    function testDenominatorRequiresMatchingScopePricing() public {
        vm.mockCall(address(0x0801), abi.encode(address(vault), uint64(0)), abi.encode(uint64(0), uint64(0), uint64(0)));
        vm.mockCall(
            address(0x0811),
            abi.encode(address(vault), uint64(0)),
            abi.encode(CoreRead.UserLending(CoreRead.BasisAndValue(0, 0), CoreRead.BasisAndValue(0, 0)))
        );
        HyperCorePrecompileSource.Token[] memory tokens = new HyperCorePrecompileSource.Token[](2);
        tokens[0] = HyperCorePrecompileSource.Token(0, 0, true, false);
        tokens[1] = HyperCorePrecompileSource.Token(197, 142, true, false);
        source.configure(address(vault), tokens, new uint32[](0), new address[](0), true);
        vm.expectRevert(ManagedAssetNavVerifier.InvalidContext.selector);
        verifier.nav(address(vault));
    }
}
