// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreRead} from "../src/CoreRead.sol";
import {HyperCorePrecompileSource} from "../src/nav/HyperCorePrecompileSource.sol";
import {IManagedCoreNavSource} from "../src/interfaces/IManagedCoreNavSource.sol";
import {IManagedVaultVerifier} from "../src/interfaces/IManagedVaultVerifier.sol";
import {ManagedPortfolioNavVerifier} from "../src/managed/ManagedPortfolioNavVerifier.sol";

interface VmPrecompileNav {
    function mockCall(address, bytes calldata, bytes calldata) external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit() external;
    function prank(address) external;
    function warp(uint256) external;
}

contract NavAssetFixture {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}

contract NavWrongDecimalsFixture {
    function decimals() external pure returns (uint8) {
        return 18;
    }
}

/// @dev Minimal Vault surface read by the source and verifier. Not a Vault model.
contract NavVaultFixture {
    address public owner;
    address public asset;
    bytes32 public configHash = bytes32(uint256(123));
    uint256 public actionNonce = 7;
    uint256 public availableCash = 5e6;
    uint256 public totalSupply = 190e9;
    uint256 public unaccountedUsdc;
    uint8 public phase = 4; // Active
    uint256 private _id;
    bytes32 private _digest;
    uint64 private _submitted;
    uint8 private _kind;
    uint256 private _assets;

    constructor(address owner_, address asset_) {
        owner = owner_;
        asset = asset_;
    }

    function setAvailableCash(uint256 value) external {
        availableCash = value;
    }

    function setTotalSupply(uint256 value) external {
        totalSupply = value;
    }

    function setUnaccounted(uint256 value) external {
        unaccountedUsdc = value;
    }

    function setPhase(uint8 value) external {
        phase = value;
    }

    function setContext(address asset_, uint256 nonce, bytes32 config) external {
        asset = asset_;
        actionNonce = nonce;
        configHash = config;
    }

    function setPending(uint256 id, bytes32 digest, uint64 submitted, uint8 kind, uint256 assets) external {
        (_id, _digest, _submitted, _kind, _assets) = (id, digest, submitted, kind, assets);
    }

    function pendingAction() external view returns (uint256, bytes32, uint64, uint8, uint256, address) {
        return (_id, _digest, _submitted, _kind, _assets, address(0));
    }
}

contract ManagedPrecompileNavTest {
    VmPrecompileNav private constant VM = VmPrecompileNav(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant STRANGER = address(0xBAD);
    address private constant HLP = address(0x4117);
    bytes32 private constant CONFIG = bytes32(uint256(123));
    uint32 private constant USDC = 0;
    uint32 private constant HYPE = 150;
    uint32 private constant HYPE_PAIR = 107;
    uint32 private constant FINE = 200; // 18 wei decimals, whole-token lots: conversions are inexact
    uint32 private constant FINE_PAIR = 300;
    uint32 private constant OTHER = 77; // a token the scope does not register
    uint32 private constant OTHER_PAIR = 88;
    uint32 private constant QUOTE = 90; // a quote token that is not USDC
    uint32 private constant QUOTE_PAIR = 93; // QUOTE/USDC
    uint32 private constant QUOTED = 91; // traded only against QUOTE
    uint32 private constant QUOTED_PAIR = 92;
    uint64 private constant HYPE_LOT = 1e6; // 0.01 HYPE
    uint64 private constant TIMEOUT = 10_000;
    uint256 private constant WINDOW = 10 minutes;
    uint256 private constant DRAWDOWN = 500;
    uint8 private constant DEPOSIT = 1;
    uint8 private constant RECALL = 2;
    uint8 private constant AGENT = 3;
    uint8 private constant CONTROL = 5;
    NavAssetFixture private asset;
    NavVaultFixture private account;
    address private bridge;
    HyperCorePrecompileSource private source;
    ManagedPortfolioNavVerifier private reader;
    uint256 private clock = 1; // block.timestamp is not re-read after a warp under via-IR

    function setUp() public {
        asset = new NavAssetFixture();
        bridge = address(new NavAssetFixture());
        account = new NavVaultFixture(address(this), address(asset));
        source = new HyperCorePrecompileSource(address(asset), bridge, USDC);
        reader = new ManagedPortfolioNavVerifier(address(asset), source, TIMEOUT, 100_000, WINDOW, DRAWDOWN);
        _block(123);
        _tokenInfo(USDC, "USDC", bridge, 8, 8, -2);
        _tokenInfo(HYPE, "HYPE", address(0x999), 2, 8, 10);
        _pair(HYPE_PAIR, HYPE, USDC);
        _spotPrice(HYPE_PAIR, 30e6, 30e6, 30e6);
        _reserve(HYPE, 30e6);
        // Standard-mode sample: 100 USDC spot (20 held by orders), 2 HYPE, 20 USDC perp equity.
        _spot(USDC, 100e8, 20e8);
        _spot(HYPE, 2e8, 1e8);
        _lending(USDC, 4e8, 5e8, 9e8, 10e8);
        _noLedger(HYPE);
        _margin(0, 20e6, 2e6, 40e6, 19e6);
        _configure(_tokens(true, false), _dexes(0));
        // 190 USDC for 190e9 shares, recorded and aged: issuance is open.
        reader.recordPrice(address(account));
        _wait(WINDOW / 2);
    }

    function _wait(uint256 secs) private {
        clock += secs;
        VM.warp(clock);
    }

    /// @dev Let the old share price leave the window and a new one age into it.
    function _reprice() private {
        _wait(WINDOW + 1);
        reader.recordPrice(address(account));
        _wait(WINDOW / 2);
    }

    function _block(uint64 value) private {
        VM.mockCall(address(0x0809), abi.encode(), abi.encode(value));
    }

    function _tokenInfo(uint32 token, string memory name, address evm, uint8 sz, uint8 wei_, int8 extra) private {
        CoreRead.TokenInfo memory info;
        info.name = name;
        info.evmContract = evm;
        info.szDecimals = sz;
        info.weiDecimals = wei_;
        info.evmExtraWeiDecimals = extra;
        VM.mockCall(address(0x080c), abi.encode(token), abi.encode(info));
    }

    function _pair(uint32 pair, uint32 base, uint32 quote) private {
        VM.mockCall(
            address(0x080b), abi.encode(pair), abi.encode(CoreRead.SpotInfo("pair", [uint64(base), uint64(quote)]))
        );
    }

    function _spot(uint32 token, uint64 total, uint64 hold) private {
        VM.mockCall(address(0x0801), abi.encode(address(account), uint64(token)), abi.encode(total, hold, uint64(999)));
    }

    function _lending(uint32 token, uint64 borrowBasis, uint64 borrowValue, uint64 supplyBasis, uint64 supplyValue)
        private
    {
        VM.mockCall(
            address(0x0811),
            abi.encode(address(account), uint64(token)),
            abi.encode(borrowBasis, borrowValue, supplyBasis, supplyValue)
        );
    }

    /// @dev The lending precompile errors when the account has no ledger for the token.
    function _noLedger(uint32 token) private {
        VM.mockCallRevert(address(0x0811), abi.encode(address(account), uint64(token)), hex"dead");
    }

    function _margin(uint32 dex, int64 accountValue, uint64 marginUsed, uint64 ntlPos, int64 rawUsd) private {
        VM.mockCall(
            address(0x080f), abi.encode(dex, address(account)), abi.encode(accountValue, marginUsed, ntlPos, rawUsd)
        );
    }

    function _book(uint32 pair, uint64 bid, uint64 ask) private {
        VM.mockCall(address(0x080e), abi.encode(uint32(10_000) + pair), abi.encode(bid, ask));
    }

    function _spotPrice(uint32 pair, uint64 price, uint64 bid, uint64 ask) private {
        VM.mockCall(address(0x0808), abi.encode(pair), abi.encode(price));
        _book(pair, bid, ask);
    }

    function _reserve(uint32 token, uint64 oracle) private {
        uint64 zero;
        VM.mockCall(
            address(0x0812), abi.encode(uint64(token)), abi.encode(zero, zero, zero, zero, oracle, zero, zero, zero)
        );
    }

    function _coreVault(uint64 equity) private {
        VM.mockCall(address(0x0802), abi.encode(address(account), HLP), abi.encode(equity, uint64(0)));
    }

    /// @dev A token outside the scope: two-decimal lots, a direct USDC pair, no lending ledger.
    function _other(uint64 balance, uint64 bid) private {
        _tokenInfo(OTHER, "OTHER", address(0x997), 2, 8, 0);
        _pair(OTHER_PAIR, OTHER, USDC);
        _book(OTHER_PAIR, bid, bid + 1);
        _spot(OTHER, balance, 0);
        _noLedger(OTHER);
    }

    /// @dev QUOTED trades only against QUOTE, and QUOTE against USDC.
    function _quoted(uint8 quoteSz, uint64 quotedBid, uint64 quoteBid) private {
        _tokenInfo(QUOTED, "QUOTED", address(0x996), 2, 8, 0);
        _tokenInfo(QUOTE, "QUOTE", address(0x995), quoteSz, 8, 0);
        _pair(QUOTED_PAIR, QUOTED, QUOTE);
        _pair(QUOTE_PAIR, QUOTE, USDC);
        _book(QUOTED_PAIR, quotedBid, quotedBid + 1);
        _book(QUOTE_PAIR, quoteBid, quoteBid + 1);
        _noLedger(QUOTED);
    }

    function _tokens(bool usdcLending, bool hypeReservePrice)
        private
        pure
        returns (HyperCorePrecompileSource.Token[] memory list)
    {
        list = new HyperCorePrecompileSource.Token[](2);
        list[0] = HyperCorePrecompileSource.Token(USDC, 0, usdcLending, false);
        list[1] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, hypeReservePrice);
    }

    function _usdcOnly(bool lending) private pure returns (HyperCorePrecompileSource.Token[] memory list) {
        list = new HyperCorePrecompileSource.Token[](1);
        list[0] = HyperCorePrecompileSource.Token(USDC, 0, lending, false);
    }

    function _dexes(uint32 only) private pure returns (uint32[] memory list) {
        list = new uint32[](1);
        list[0] = only;
    }

    function _twoDexes(uint32 second) private pure returns (uint32[] memory list) {
        list = new uint32[](2);
        (list[0], list[1]) = (0, second);
    }

    function _hlp() private pure returns (address[] memory list) {
        list = new address[](1);
        list[0] = HLP;
    }

    function _configure(HyperCorePrecompileSource.Token[] memory tokens, uint32[] memory dexes) private {
        source.configure(address(account), tokens, dexes, new address[](0), true);
    }

    function _net() private view returns (int256 net) {
        (net,) = source.evaluate(address(account));
    }

    function _exit() private view returns (int256 net, bool liabilities) {
        (net, liabilities,) = source.exposure(address(account));
    }

    /// @dev Nothing left on Core: no balance, ledger value, margin or position.
    function _flat() private {
        _spot(USDC, 0, 0);
        _spot(HYPE, 0, 0);
        _lending(USDC, 0, 0, 0, 0);
        _margin(0, 0, 0, 0, 0);
    }

    function _expectReadFailed(uint160 target) private {
        VM.expectRevert(abi.encodeWithSelector(CoreRead.ReadFailed.selector, address(target)));
    }

    function _expectEmptyAnswer(uint160 target) private {
        VM.expectRevert(abi.encodeWithSelector(CoreRead.InvalidReturnLength.selector, address(target), uint256(0)));
    }

    function testSpotLendingPerpAndPriceDecimalsAreCountedOnce() public {
        (uint64 b, HyperCorePrecompileSource.TokenObservation[] memory values) = source.observeTokens(address(account));
        require(b == 123 && values[0].spot.hold == 20e8 && values[1].usdcPrice18 == 30e18);
        require(values[0].lending.supply.value == 10e8 && values[0].lendingQueried && !values[1].lendingQueried);
        (, CoreRead.AccountMarginSummary[] memory dexes) = source.observeDexes(address(account));
        require(dexes.length == 1 && dexes[0].accountValue == 20e6 && dexes[0].rawUsd == 19e6);
        // 100 spot (hold not added) + 10 supplied value - 5 debt value + 20 perp equity + 2 HYPE * 30.
        (int256 net, uint64 coreBlock) = source.evaluate(address(account));
        require(net == 185e18 && coreBlock == 123, "hold, basis, entry notional or PnL counted twice");
        // `hold` is not a ledger and is never compared with the total.
        _spot(USDC, 100e8, 500e8);
        require(_net() == 185e18);
    }

    // Raw precompile values of public mainnet accounts, saved with their pinned blocks in
    // docs/reference/managed-equity-modes-rerun-2026-10-04.json (see managed-precompile-evidence.ko.md).
    function testUnifiedAccountSumsRawSpotAndEveryDexEquity() public {
        // Block 0x2d6edd0: cross positions on the validator DEX and one HIP-3 DEX share the USDC
        // balance. The account has no borrow/lend ledger: that precompile read fails.
        _noLedger(USDC);
        _spot(USDC, 9311046256200, 0);
        _spot(HYPE, 0, 0);
        _margin(0, 5596630612, 5504487720, 27522438604, 33119069216);
        _margin(1, 401498746, 402899685, 4376977350, -2421634304);
        _configure(_tokens(false, false), _twoDexes(1));
        require(_net() == 99108591920 * 1e12, "API unified USDC total was 99108.59192");
    }

    function testPortfolioMarginNetsDebtAgainstAutoSuppliedCollateral() public {
        // Block 0x2d6ee6d: raw spot is empty, HYPE is auto-supplied and USDC is borrowed against it.
        _spot(USDC, 0, 0);
        _spot(HYPE, 0, 0);
        _lending(USDC, 8880260110139, 8880271552683, 0, 0);
        _lending(HYPE, 0, 0, 195934874775, 195934874775);
        _margin(0, 35440330930, 35387428480, 176937142400, 212377473330);
        // HYPE spot mark, book and borrow oracle read at block 0x2d6edc1 of the same file.
        _spotPrice(HYPE_PAIR, 90298000, 90298000, 90299000);
        _reserve(HYPE, 90300518);
        HyperCorePrecompileSource.Token[] memory list = _tokens(true, true);
        list[1].lending = true;
        _configure(list, _dexes(0));
        // USDC -53362.38459683 (inside the API's unified total bracket) + 1959.34874775 HYPE.
        require(_net() == 123567822267646334500000, "debt, supply or perp equity missing");
        (, bool liabilities) = _exit();
        require(liabilities, "debt and an open position are liabilities");
    }

    function testFuzzUsdcLedgersAreSummedExactlyOnce(uint64 spot, uint64 supply, uint64 debt, int64 dexA, int64 dexB)
        public
    {
        _spot(USDC, spot, 0);
        _spot(HYPE, 0, 0);
        _lending(USDC, 1, debt, 2, supply);
        _margin(0, dexA, 0, 0, dexA);
        _margin(1, dexB, 0, 0, dexB);
        _configure(_tokens(true, false), _twoDexes(1));
        if (dexA < 0 || dexB < 0) {
            VM.expectRevert(HyperCorePrecompileSource.NegativeDexEquity.selector);
            source.evaluate(address(account));
            return;
        }
        // USDC wei (8 decimals) to 1e18 is exact; margin summaries carry 6 decimals.
        int256 expected = (int256(uint256(spot)) + int256(uint256(supply)) - int256(uint256(debt))) * 1e10
            + (int256(dexA) + int256(dexB)) * 1e12;
        require(_net() == expected);
    }

    function testNegativeDexEquityClosesIssuanceAndIsALiabilityForAnExit() public {
        // No debt and no position here: the deficit alone must count.
        _lending(USDC, 0, 0, 0, 10e8);
        // A DEX ledger has no claim on spot or on another DEX: netting it would understate NAV.
        _margin(0, -30e6, 0, 0, -30e6);
        VM.expectRevert(HyperCorePrecompileSource.NegativeDexEquity.selector);
        source.evaluate(address(account));
        (int256 net, bool liabilities) = _exit();
        require(net == 140e18 && liabilities, "an exit sees the loss, never a value clamped to zero");
        _margin(0, 0, 0, 0, 0);
        (net, liabilities) = _exit();
        require(net == 170e18 && !liabilities);
    }

    function testInexactValuesFloorAssetsCeilDebtsAndFloorToUsdcUnits() public {
        _tokenInfo(FINE, "FINE", address(0x998), 0, 18, 0);
        _pair(FINE_PAIR, FINE, USDC);
        _spotPrice(FINE_PAIR, 3, 3, 3); // 3e-8 USDC per token: 3e10 at 1e18
        _flat();
        HyperCorePrecompileSource.Token[] memory list = new HyperCorePrecompileSource.Token[](3);
        list[0] = HyperCorePrecompileSource.Token(USDC, 0, true, false);
        list[1] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, false);
        list[2] = HyperCorePrecompileSource.Token(FINE, FINE_PAIR, true, false);
        _spot(FINE, 5e17, 0);
        _lending(FINE, 0, 0, 0, 0);
        _configure(list, _dexes(0));
        require(_net() == 15_000_000_000, "0.5 token at 3e-8");
        _spot(FINE, 5e17 + 1, 0); // one more wei is worth 3e-8 of a 1e18 unit
        require(_net() == 15_000_000_000, "asset value rounds down");
        _spot(FINE, 0, 0);
        _lending(FINE, 0, 5e17 + 1, 0, 0);
        require(_net() == -15_000_000_001, "debt value rounds up");
        // 1.50000001 HYPE at 30 is 45.0000003 USDC: the Vault books 45.000000.
        _lending(FINE, 0, 0, 0, 0);
        _spot(HYPE, 150_000_001, 0);
        account.setAvailableCash(0);
        _reprice();
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(_net() == 45_000_000_300_000_000_000 && nav == 45_000_000, "USDC6 conversion rounds down");
    }

    function testCoreVaultEquityIsUsdcSixDecimals() public {
        _coreVault(7e6);
        source.configure(address(account), _tokens(true, false), _dexes(0), _hlp(), true);
        require(_net() == 192e18);
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_tokens(true, false), _dexes(0));
        _coreVault(0);
        _configure(_tokens(true, false), _dexes(0));
    }

    function testOnlyTheVaultOwnerEditsItsOwnScope() public {
        VM.prank(STRANGER);
        VM.expectRevert(HyperCorePrecompileSource.Unauthorized.selector);
        source.configure(address(account), _tokens(true, false), _dexes(0), new address[](0), true);
        VM.prank(STRANGER);
        VM.expectRevert(HyperCorePrecompileSource.Unauthorized.selector);
        source.setEnabled(address(account), false);
        NavVaultFixture other = new NavVaultFixture(STRANGER, address(asset));
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        source.evaluate(address(other));
        VM.prank(STRANGER);
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        source.setEnabled(address(other), true);
        (uint64 version, bool enabled, HyperCorePrecompileSource.TokenState[] memory tokens,,) =
            source.scope(address(account));
        require(version == 1 && enabled && tokens.length == 2 && tokens[1].szDecimals == 2);
    }

    function testScopeOrderIsEnforced() public {
        HyperCorePrecompileSource.Token[] memory list = _tokens(true, false);
        list[1].index = USDC; // duplicate
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(list, _dexes(0));
        list[1].index = 100_000_000; // an encoded outcome is not a token
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(list, _dexes(0));
        list = new HyperCorePrecompileSource.Token[](1);
        list[0] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, false); // USDC is mandatory
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(list, _dexes(0));
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(new HyperCorePrecompileSource.Token[](0), _dexes(0));
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(_tokens(true, false), _twoDexes(0)); // duplicate
        address[] memory vaults = new address[](2);
        (vaults[0], vaults[1]) = (HLP, HLP);
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        source.configure(address(account), _tokens(true, false), _dexes(0), vaults, true);
        vaults[0] = address(0);
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        source.configure(address(account), _tokens(true, false), _dexes(0), vaults, true);
    }

    function testScopeLimitsAreEnforcedOnOtherwiseValidLists() public {
        (uint256 maxTokens, uint256 maxDexes, uint256 maxVaults) =
            (source.MAX_TOKENS(), source.MAX_DEXES(), source.MAX_CORE_VAULTS());
        require(maxTokens == 6 && maxDexes == 8 && maxVaults == 2, "limits sized by test/ManagedNavGas.t.sol");
        // Ascending and valid, so only the length can be refused. One fewer passes that check and
        // goes on to read Core, where the first unknown entry is an error.
        HyperCorePrecompileSource.Token[] memory tokens = new HyperCorePrecompileSource.Token[](maxTokens + 1);
        tokens[0] = HyperCorePrecompileSource.Token(USDC, 0, true, false);
        tokens[1] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, false);
        for (uint256 i = 2; i <= maxTokens; ++i) {
            tokens[i] = HyperCorePrecompileSource.Token(uint32(HYPE + i), 0, false, false);
        }
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(tokens, _dexes(0));
        assembly ("memory-safe") {
            mstore(tokens, sub(mload(tokens), 1))
        }
        _expectEmptyAnswer(0x080c);
        _configure(tokens, _dexes(0));

        uint32[] memory dexes = new uint32[](maxDexes + 1);
        for (uint32 i; i <= maxDexes; ++i) {
            dexes[i] = i;
        }
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        _configure(_tokens(true, false), dexes);
        assembly ("memory-safe") {
            mstore(dexes, sub(mload(dexes), 1))
        }
        _expectEmptyAnswer(0x080f);
        _configure(_tokens(true, false), dexes);

        address[] memory vaults = new address[](maxVaults + 1);
        for (uint160 i; i <= maxVaults; ++i) {
            vaults[i] = address(0x5000 + i);
        }
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        source.configure(address(account), _tokens(true, false), _dexes(0), vaults, true);
        assembly ("memory-safe") {
            mstore(vaults, sub(mload(vaults), 1))
        }
        _expectEmptyAnswer(0x0802);
        source.configure(address(account), _tokens(true, false), _dexes(0), vaults, true);
    }

    function testScopeMetadataComesFromCoreNotFromTheCaller() public {
        // An unknown DEX index or a non-vault address is a precompile error, never an empty entry.
        VM.mockCallRevert(address(0x080f), abi.encode(uint32(9), address(account)), hex"dead");
        _expectReadFailed(0x080f);
        _configure(_tokens(true, false), _twoDexes(9));
        VM.mockCallRevert(address(0x0802), abi.encode(address(account), HLP), hex"dead");
        _expectReadFailed(0x0802);
        source.configure(address(account), _tokens(true, false), _dexes(0), _hlp(), true);
        VM.mockCallRevert(address(0x0812), abi.encode(uint64(HYPE)), hex"dead"); // no reserve for the token
        _expectReadFailed(0x0812);
        _configure(_tokens(true, true), _dexes(0));
        _pair(HYPE_PAIR, HYPE, 1);
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_tokens(true, false), _dexes(0)); // the pair does not quote in USDC
        _pair(HYPE_PAIR, USDC, USDC);
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_tokens(true, false), _dexes(0)); // the pair is another token's
        _pair(HYPE_PAIR, HYPE, USDC);
        // szDecimals > 8, weiDecimals > 18, and a lot finer than one wei.
        uint8[2][3] memory bad = [[uint8(9), 9], [uint8(2), 19], [uint8(8), 6]];
        for (uint256 i; i < bad.length; ++i) {
            _tokenInfo(HYPE, "HYPE", address(0x999), bad[i][0], bad[i][1], 0);
            VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
            _configure(_tokens(true, false), _dexes(0));
        }
        (uint64 version,,,,) = source.scope(address(account));
        require(version == 1, "a rejected edit leaves the scope untouched");
    }

    function testUsdcMetadataMustPointToCircleBridgeNotErc20() public {
        require(source.usdcCoreBridge() != source.asset());
        _tokenInfo(USDC, "USDC", address(asset), 8, 8, -2); // wrong: mainnet points to CoreDepositWallet
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_tokens(true, false), _dexes(0));
        _tokenInfo(USDC, "USDC", bridge, 8, 8, 0); // EVM units would not be USDC6
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_tokens(true, false), _dexes(0));
        _tokenInfo(USDC, "USDC", bridge, 5, 5, 1); // coarser than the Vault's own unit
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_tokens(true, false), _dexes(0));
        _tokenInfo(USDC, "USDC", bridge, 6, 8, -2); // a USDC lot above one wei could hide dust
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_tokens(true, false), _dexes(0));
    }

    function testEntryCannotLeaveTheScopeWhileItHoldsValue() public {
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_usdcOnly(true), _dexes(0)); // 2 HYPE held
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_tokens(false, false), _dexes(0)); // USDC supplied and borrowed
        _margin(1, 0, 0, 0, 0);
        _lending(USDC, 0, 0, 0, 0);
        // Any one non-zero field keeps a DEX in use: equity, margin, position or raw USD.
        int64[4][4] memory used = [[int64(1), 0, 0, 0], [int64(0), 1, 0, 0], [int64(0), 0, 1, 0], [int64(0), 0, 0, 1]];
        for (uint256 i; i < used.length; ++i) {
            _margin(0, used[i][0], uint64(used[i][1]), uint64(used[i][2]), used[i][3]);
            VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
            _configure(_tokens(true, false), _dexes(1));
        }
        _margin(0, 0, 0, 0, 0);
        _spot(HYPE, 34 * HYPE_LOT, 0); // 10.2 USDC at the bid can still be sold: it is a holding
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_usdcOnly(false), _dexes(1));
        _spot(HYPE, 34 * HYPE_LOT - 1, 0); // 9.9 USDC in whole lots: nobody can sell it, it may be left behind
        _configure(_usdcOnly(false), _dexes(1));
        (uint64 version,,,,) = source.scope(address(account));
        require(version == 2 && _net() == 100e18);
        // Without a bid nothing can be sold whatever the size: a dead market must not pin a token
        // to the scope. The bid has to be read, though: a failed read is not "nothing to sell".
        _configure(_tokens(false, false), _dexes(1));
        _spot(HYPE, 2e8, 0);
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_usdcOnly(false), _dexes(1));
        VM.mockCallRevert(address(0x080e), abi.encode(uint32(10_000) + HYPE_PAIR), hex"dead");
        _expectReadFailed(0x080e);
        _configure(_usdcOnly(false), _dexes(1));
        _book(HYPE_PAIR, 0, 30e6);
        _configure(_usdcOnly(false), _dexes(1));
        require(_net() == 100e18);
    }

    function testLendingSupplyCountsWithSpotAndDebtIsNeverDust() public {
        // In Portfolio Margin the raw spot ledger empties and a remainder sits in the supply ledger.
        HyperCorePrecompileSource.Token[] memory list = _tokens(true, false);
        list[1].lending = true;
        _spot(HYPE, 0, 0);
        _lending(HYPE, 0, 0, 0, 0);
        _configure(list, _dexes(0));
        _lending(HYPE, 0, 0, 34 * HYPE_LOT - 1, 34 * HYPE_LOT - 1);
        _spot(HYPE, 1, 0); // spot and supply are one holding: together 0.34 HYPE, 10.2 USDC at the bid
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_usdcOnly(true), _dexes(0));
        _spot(HYPE, 0, 0);
        _configure(_usdcOnly(true), _dexes(0)); // 9.9 USDC in whole lots cannot be sold: left behind
        _configure(list, _dexes(0));
        _lending(HYPE, 0, 0, HYPE_LOT, HYPE_LOT);
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_tokens(true, false), _dexes(0)); // the token stays but its ledger read would go
        _lending(HYPE, 0, 1, 0, 0); // one wei of debt is a liability, however small
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_usdcOnly(true), _dexes(0));
        VM.expectRevert(HyperCorePrecompileSource.ScopeInUse.selector);
        _configure(_tokens(true, false), _dexes(0));
        require(_net() == 125e18 - 300_000_000_000, "one wei of HYPE debt, rounded up");
        (int256 net, bool liabilities) = _exit();
        require(net == 125e18 && liabilities, "an exit flags the debt instead of pricing it");
        _spotPrice(HYPE_PAIR, 0, 0, 0);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.evaluate(address(account)); // a debt always needs a price for issuance
    }

    function testDustClosesNothingAndAnExitCountsOnlyWhatCouldBeSold() public {
        _spotPrice(HYPE_PAIR, 0, 0, 0); // no book at all
        _spot(HYPE, 0, 0);
        require(_net() == 125e18, "a token the Vault does not hold must not close the NAV");
        (, HyperCorePrecompileSource.TokenObservation[] memory values) = source.observeTokens(address(account));
        require(values[1].usdcPrice18 == 0 && values[0].usdcPrice18 == 1e18, "diagnostics follow the valuation");
        // Anyone can send dust to the Vault's Core account. Below one lot nobody can sell it.
        _spot(HYPE, HYPE_LOT - 1, 0);
        require(_net() == 125e18, "unpriceable dust must not close issuance");
        (, values) = source.observeTokens(address(account));
        require(values[1].usdcPrice18 == 0, "a refused price is reported, not reverted");
        _spot(HYPE, HYPE_LOT, 0);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.evaluate(address(account)); // a whole lot needs a price, even one too small to sell
        (int256 net,) = _exit();
        require(net == 125e18, "a dead market cannot hold an exit hostage");
        // The owner's way out: what nobody can sell may leave the scope, and issuance reopens.
        _configure(_usdcOnly(true), _dexes(0));
        require(_net() == 125e18);
        _configure(_tokens(true, false), _dexes(0));

        // With a healthy book issuance prices every unit, dust included.
        _spotPrice(HYPE_PAIR, 25e6, 25e6, 25e6);
        _spot(HYPE, HYPE_LOT - 1, 0);
        require(_net() == 125e18 + 249_999_750_000_000_000);
        // An exit counts only what Core would let the owner sell: whole lots worth 10 USDC at the bid.
        _spot(HYPE, 39 * HYPE_LOT + HYPE_LOT - 1, 0); // 0.39 HYPE and dust: 9.75 USDC
        (net,) = _exit();
        require(net == 125e18, "below the minimum order");
        _spot(HYPE, 40 * HYPE_LOT + HYPE_LOT - 1, 0); // 0.40 HYPE and dust: exactly 10 USDC
        (net,) = _exit();
        require(net == 135e18, "sellable: the exit must bring it home");
        _book(HYPE_PAIR, 24_999_999, 30e6); // a wide book still has a bid to sell into
        (net,) = _exit();
        require(net == 125e18, "valued at the bid, and no price guard on the way out");
    }

    function testLendingReadCanBeDroppedWhenCoreHasNoLedgerForTheToken() public {
        // Unified accounts without a borrow/lend ledger make the precompile fail: fail closed.
        _noLedger(USDC);
        _expectReadFailed(0x0811);
        source.evaluate(address(account));
        _configure(_tokens(false, false), _dexes(0));
        require(_net() == 180e18);
    }

    function testUncountedLendingLedgerClosesTheValuationInsteadOfDroppingValue() public {
        // Portfolio Margin auto-supplies HYPE: raw spot empties and the supply ledger appears.
        _spot(HYPE, 0, 0);
        _lending(HYPE, 0, 0, 2e8, 2e8);
        VM.expectRevert(HyperCorePrecompileSource.ScopeIncomplete.selector);
        source.evaluate(address(account));
        VM.expectRevert(HyperCorePrecompileSource.ScopeIncomplete.selector);
        source.exposure(address(account));
        _lending(HYPE, 0, 0, HYPE_LOT, HYPE_LOT); // one tradeable lot
        VM.expectRevert(HyperCorePrecompileSource.ScopeIncomplete.selector);
        source.evaluate(address(account));
        _lending(HYPE, 0, 1, 0, 0); // an uncounted debt is just as invisible
        VM.expectRevert(HyperCorePrecompileSource.ScopeIncomplete.selector);
        source.evaluate(address(account));
        // Dust in the ledger is too small to need registering, but it is still part of the holding.
        _lending(HYPE, 7, 0, 7, HYPE_LOT - 1);
        require(_net() == 125e18 + 299_999_700_000_000_000);
        _spot(HYPE, 1, 0); // spot and supply are one holding: together a lot
        require(_net() == 125e18 + 300_000_000_000_000_000);
        VM.mockCall(address(0x0811), abi.encode(address(account), uint64(HYPE)), abi.encode(uint64(1)));
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        source.evaluate(address(account)); // a malformed answer is not "no ledger"
        _spot(HYPE, 0, 0);
        _lending(HYPE, 0, 0, 2e8, 2e8);
        HyperCorePrecompileSource.Token[] memory list = _tokens(true, false);
        list[1].lending = true;
        _configure(list, _dexes(0));
        require(_net() == 185e18, "counted once the owner registers the ledger");
    }

    function testMissingLedgerIsBelievedOnlyWhileASameShapedReadStillAnswers() public {
        // Without a registered DEX nothing else reads the margin summary: the control read stands alone.
        _margin(0, 0, 0, 0, 0);
        _configure(_tokens(true, false), new uint32[](0));
        require(_net() == 165e18);
        VM.mockCallRevert(address(0x080f), abi.encode(uint32(0), address(account)), hex"dead");
        // If even that read fails inside the probe's allowance, "no ledger" cannot be told apart
        // from a precompile that became too expensive to answer.
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        source.evaluate(address(account));
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        source.exposure(address(account));
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        _configure(_usdcOnly(true), new uint32[](0)); // dropping HYPE probes its ledger too
        // An answer of the wrong size is no answer either.
        VM.mockCall(address(0x080f), abi.encode(uint32(0), address(account)), abi.encode(uint64(0)));
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        source.evaluate(address(account));
        // A ledger probe that answered within the allowance is the better proof: after the USDC
        // ledger answers, the missing HYPE ledger is believed without the control read.
        VM.mockCallRevert(address(0x080f), abi.encode(uint32(0), address(account)), hex"dead");
        _lending(USDC, 0, 0, 0, 0);
        _configure(_tokens(false, false), new uint32[](0));
        require(_net() == 160e18);
    }

    function testReadFailureAndMalformedDataAreNotZero() public {
        VM.mockCall(address(0x0811), abi.encode(address(account), uint64(USDC)), abi.encode(uint64(1)));
        VM.expectRevert(abi.encodeWithSelector(CoreRead.InvalidReturnLength.selector, address(0x0811), uint256(32)));
        source.evaluate(address(account));
        _lending(USDC, 4e8, 5e8, 9e8, 10e8);
        VM.mockCallRevert(address(0x080f), abi.encode(uint32(0), address(account)), hex"dead");
        _expectReadFailed(0x080f);
        source.evaluate(address(account));
        _margin(0, 20e6, 2e6, 40e6, 19e6);
        VM.mockCallRevert(address(0x0801), abi.encode(address(account), uint64(HYPE)), hex"dead");
        _expectReadFailed(0x0801);
        source.evaluate(address(account));
        _expectReadFailed(0x0801);
        source.exposure(address(account));
        _spot(HYPE, 2e8, 0);
        VM.mockCallRevert(address(0x0808), abi.encode(HYPE_PAIR), hex"dead");
        _expectReadFailed(0x0808);
        source.evaluate(address(account)); // a failed price read is an error, not a refused price
        VM.mockCallRevert(address(0x080e), abi.encode(uint32(10_000) + HYPE_PAIR), hex"dead");
        _expectReadFailed(0x080e);
        source.exposure(address(account)); // an exit needs the bid of anything it could sell
        _spotPrice(HYPE_PAIR, 30e6, 30e6, 30e6);
        _block(0);
        VM.expectRevert(HyperCorePrecompileSource.InvalidObservation.selector);
        source.evaluate(address(account));
    }

    function testSpotBookGuardsTheIssuancePrice() public {
        uint64[3][6] memory bad = [
            [uint64(0), 0, 0], // no price, empty book
            [uint64(30e6), 0, 31e6], // one-sided
            [uint64(30e6), 31e6, 29e6], // crossed
            [uint64(30e6), 29_699_999, 30e6], // a hair wider than 1% of the ask
            [uint64(31e6), 29_900_000, 30e6], // price above the book
            [uint64(29e6), 29_900_000, 30e6] // price below the book
        ];
        for (uint256 i; i < bad.length; ++i) {
            _spotPrice(HYPE_PAIR, bad[i][0], bad[i][1], bad[i][2]);
            VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
            source.evaluate(address(account));
        }
        _spotPrice(HYPE_PAIR, 29_700_000, 29_700_000, 30e6); // exactly 1% wide, mark on the bid
        require(_net() == 184_400_000_000_000_000_000);
    }

    function testReservePriceMustAgreeWithTheSpotMark() public {
        _configure(_tokens(true, true), _dexes(0));
        _spotPrice(HYPE_PAIR, 30e6, 0, 0); // the book itself is not read for a reserve price
        _reserve(HYPE, 30_600_000); // exactly 2% above the mark
        require(_net() == 186_200_000_000_000_000_000, "valued at the borrow oracle");
        _reserve(HYPE, 29_400_000); // exactly 2% below
        require(_net() == 183_800_000_000_000_000_000);
        _reserve(HYPE, 30_600_001); // an oracle pinned above the market
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.evaluate(address(account));
        _reserve(HYPE, 29_399_999); // or below it
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.evaluate(address(account));
        _reserve(HYPE, 0);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.evaluate(address(account));
        _reserve(HYPE, 30e6);
        _spotPrice(HYPE_PAIR, 0, 0, 0);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.evaluate(address(account));
    }

    function testDisabledScopeClosesIssuanceButStillServesAnExit() public {
        source.setEnabled(address(account), false);
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        source.evaluate(address(account));
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        (int256 net, bool liabilities, uint64 coreBlock) = source.exposure(address(account));
        require(net == 185e18 && liabilities && coreBlock == 123);
        source.setEnabled(address(account), true);
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 190e6);
    }

    function testAnyoneCanProveAHoldingOutsideTheScopeAndItClosesIssuanceAndExit() public {
        _other(3e8, 5e6); // 3 tokens with a 5 USDC bid: more than the minimum order
        require(_net() == 185e18, "the valuation cannot see a token nobody registered");
        VM.prank(STRANGER);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open.length == 1 && open[0].id == OTHER && open[0].kind == HyperCorePrecompileSource.ReportKind.Token);
        require(open[0].expiresAt == clock + 1 days && open[0].weiDecimals == 8 && open[0].szDecimals == 2);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.exposure(address(account));
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        reader.nav(address(account));
        VM.expectRevert(HyperCorePrecompileSource.ReportStands.selector);
        source.clearReport(address(account), 0);
        // Reporting the same venue again renews the report instead of adding a second one.
        _wait(100);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        open = source.reports(address(account));
        require(open.length == 1 && open[0].expiresAt == clock + 1 days);

        // Sold down to less than the minimum order: from that moment it closes nothing, cleared or not.
        _spot(OTHER, 199 * HYPE_LOT, 0); // 1.99 tokens: 9.95 USDC
        require(_net() == 185e18 && source.reports(address(account)).length == 1);
        VM.prank(STRANGER);
        source.clearReport(address(account), 0);
        require(source.reports(address(account)).length == 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);

        // Or the owner registers it: the token is counted and the report has nothing left to prove.
        _spot(OTHER, 3e8, 0);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        _spotPrice(OTHER_PAIR, 5e6, 5e6, 5e6);
        HyperCorePrecompileSource.Token[] memory list = new HyperCorePrecompileSource.Token[](3);
        list[0] = HyperCorePrecompileSource.Token(USDC, 0, true, false);
        list[1] = HyperCorePrecompileSource.Token(OTHER, OTHER_PAIR, false, false);
        list[2] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, false);
        _configure(list, _dexes(0));
        require(_net() == 200e18 && source.reports(address(account)).length == 0, "answered and dropped");
    }

    /// @dev A proof that held for one block must not close the Vault afterwards.
    function testAReportCountsOnlyWhileItCanStillBeProven() public {
        // A stranger sends 3 units of a token nobody bids for and posts a 5 USDC bid himself.
        _other(3e8, 5e6);
        VM.prank(STRANGER);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        _book(OTHER_PAIR, 0, 1); // he cancels the bid: the holding cannot be sold after all
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        (int256 net,) = _exit();
        require(nav == 190e6 && net == 185e18, "the report is still listed and closes nothing");
        _wait(WINDOW / 8 + 1);
        reader.recordPrice(address(account));
        // While his bid stays, the owner can sell into it: keeping the Vault closed costs him the 15 USDC.
        _book(OTHER_PAIR, 5e6, 5e6 + 1);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account)); // the same entry counts again, without a new report
        // A venue that can no longer be read is not taken for empty: it closes the Vault, but only
        // until the report lapses.
        VM.mockCallRevert(address(0x080e), abi.encode(uint32(10_000) + OTHER_PAIR), hex"dead");
        _expectReadFailed(0x080e);
        source.evaluate(address(account));
        _expectReadFailed(0x080e);
        source.clearReport(address(account), 0);
        _wait(1 days);
        require(_net() == 185e18);
        source.clearReport(address(account), 0);
    }

    function testAReportNeedsProofOfSomethingSellableOutsideTheScope() public {
        // Registered venues are counted already.
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), HYPE, HYPE_PAIR, false, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), USDC, HYPE_PAIR, false, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(account), 0);
        // Too little to sell: below one lot whatever the price, below the minimum order, or no bid.
        _other(HYPE_LOT - 1, 5_000e6);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        _other(199 * HYPE_LOT + HYPE_LOT - 1, 5e6);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        _other(3e8, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        // The pair must be the token's own, and quoted in USDC unless routed through its quote token.
        _other(3e8, 5e6);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, HYPE_PAIR, false, 0);
        _pair(OTHER_PAIR, OTHER, QUOTE);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), 100_000_000, OTHER_PAIR, false, 0); // an outcome is not a token
        // A read that fails proves nothing, and an unconfigured Vault has no scope to be outside of.
        VM.mockCallRevert(address(0x080f), abi.encode(uint32(9), address(account)), hex"dead");
        _expectReadFailed(0x080f);
        source.reportDex(address(account), 9);
        NavVaultFixture other = new NavVaultFixture(STRANGER, address(asset));
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        source.reportDex(address(other), 3);
        require(source.reports(address(account)).length == 0 && _net() == 185e18);
    }

    function testUnregisteredDebtSupplyAndQuoteRoutedTokensCanBeReported() public {
        // One wei borrowed of a token outside the scope stands without any price.
        _other(0, 0);
        _lending(OTHER, 0, 1, 0, 0);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        VM.expectRevert(HyperCorePrecompileSource.ReportStands.selector);
        source.clearReport(address(account), 0);
        _lending(OTHER, 0, 0, 0, 0);
        source.clearReport(address(account), 0);
        // What Portfolio Margin moved into the supply ledger is still the Vault's holding.
        _other(0, 5e6);
        _lending(OTHER, 0, 0, 3e8, 3e8);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        _lending(OTHER, 0, 0, 0, 0);
        source.clearReport(address(account), 0);

        // QUOTED trades only against QUOTE: 2 QUOTE each, and QUOTE is worth 0.5 USDC.
        _quoted(2, 2e6, 5e5);
        _spot(QUOTED, 10e8, 0); // 20 QUOTE, exactly 10 USDC through both bids
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, false, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, HYPE_PAIR); // not the quote token's pair
        _pair(QUOTE_PAIR, QUOTE, OTHER); // the quote token's pair must itself be quoted in USDC
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, QUOTE_PAIR);
        _pair(QUOTE_PAIR, QUOTE, USDC);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, QUOTE_PAIR);
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open[0].viaQuote && open[0].quotePair == QUOTE_PAIR && open[0].quoteSzDecimals == 2);
        _spot(QUOTED, 10e8 - HYPE_LOT, 0); // 9.99 USDC
        source.clearReport(address(account), 0);

        // Core's minimum order is 10 of the pair's own quote token. With QUOTE at 1.25 USDC, 8 QUOTED
        // on a 1 QUOTE bid are worth 10 USDC but would be an 8 QUOTE order, which Core rejects.
        _quoted(2, 1e6, 125e4);
        _spot(QUOTED, 8e8, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, QUOTE_PAIR);
        _spot(QUOTED, 10e8, 0); // a 10 QUOTE order, worth 12.5 USDC
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, QUOTE_PAIR);
        _book(QUOTE_PAIR, 999_999, 1e6); // and the 10 QUOTE it brings must be a 10 USDC order in turn
        require(_net() == 185e18);
        source.clearReport(address(account), 0);

        // The quote token's price is scaled by its own size decimals, not the reported token's.
        _quoted(0, 2e6, 5e7); // QUOTE in whole-token lots: its raw price has 8 decimals, 5e7 is 0.5 USDC
        _spot(QUOTED, 10e8 - HYPE_LOT, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, QUOTE_PAIR);
        _spot(QUOTED, 10e8, 0);
        source.reportToken(address(account), QUOTED, QUOTED_PAIR, true, QUOTE_PAIR);
        require(source.reports(address(account))[0].quoteSzDecimals == 0);
    }

    function testUnregisteredDexAndHyperCoreVaultReports() public {
        _margin(3, 10e6 - 1, 0, 0, 10e6 - 1);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(account), 3);
        _margin(3, 10e6, 0, 0, 10e6);
        source.reportDex(address(account), 3);
        VM.expectRevert(HyperCorePrecompileSource.ReportStands.selector);
        source.clearReport(address(account), 0);
        _margin(3, 0, 0, 0, 0);
        source.clearReport(address(account), 0);
        _margin(3, 0, 0, 1, 0); // a position without equity is still exposure
        source.reportDex(address(account), 3);
        _configure(_tokens(true, false), _twoDexes(3)); // registering it answers the report
        require(_net() == 185e18 && source.reports(address(account)).length == 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(account), 3);

        _coreVault(10e6 - 1);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportCoreVault(address(account), HLP);
        _coreVault(10e6);
        source.reportCoreVault(address(account), HLP);
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open[0].coreVault == HLP && open[0].kind == HyperCorePrecompileSource.ReportKind.CoreVault);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        _coreVault(0);
        require(_net() == 185e18);
        source.clearReport(address(account), 0);
        // A registered HyperCore vault is counted already.
        _coreVault(50e6);
        source.configure(address(account), _tokens(true, false), _twoDexes(3), _hlp(), true);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportCoreVault(address(account), HLP);
        require(_net() == 235e18);
    }

    function testReportsLapseUnlessRenewed() public {
        _margin(3, 10e6, 0, 0, 10e6);
        source.reportDex(address(account), 3);
        _wait(1 days - 1);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        // Renewed while it can still be proven, it keeps counting past its first expiry.
        VM.prank(STRANGER);
        source.reportDex(address(account), 3);
        _wait(1 days - 1);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        _wait(1);
        require(_net() == 185e18, "a lapsed report no longer closes the Vault");
        source.clearReport(address(account), 0); // lapsed: dropped although the holding is still there
        require(source.reports(address(account)).length == 0);
    }

    /// @dev A report that could be displaced could be lifted by anyone: a proof that holds for one
    ///      block would take its place and leave the Vault open in the next.
    function testAStandingReportKeepsItsPlaceAndItsProof() public {
        require(source.MAX_REPORTS() == 1);
        _margin(30, 100e6, 0, 0, 100e6); // 100 USDC on a DEX the scope does not count
        source.reportDex(address(account), 30);
        // A stranger sends three tokens nobody trades and bids for them for a block.
        _other(3e8, 5e6);
        VM.prank(STRANGER);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        // Nor does another DEX take the place, whatever it holds. A token and a DEX with the same
        // index are different venues.
        _margin(OTHER, 500e6, 0, 0, 500e6);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(account), OTHER);
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open.length == 1 && open[0].id == 30 && open[0].expiresAt == clock + 1 days);
        // The same venue again renews it, by anyone.
        _wait(100);
        VM.expectEmit();
        emit HyperCorePrecompileSource.ScopeReported(
            address(account), HyperCorePrecompileSource.ReportKind.Dex, 30, address(0), STRANGER
        );
        VM.prank(STRANGER);
        source.reportDex(address(account), 30);
        open = source.reports(address(account));
        require(open.length == 1 && open[0].id == 30 && open[0].expiresAt == clock + 1 days);
        // Once it no longer stands it gives way to whatever can be proven. The limit of keeping
        // one: until someone names the other venue, the Vault is valued without it.
        _margin(30, 0, 0, 0, 0);
        require(_net() == 185e18);
        source.reportDex(address(account), OTHER);
        open = source.reports(address(account));
        require(open.length == 1 && open[0].kind == HyperCorePrecompileSource.ReportKind.Dex && open[0].id == OTHER);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        // What cannot be proven takes nobody's place, standing report or not.
        _margin(OTHER, 0, 0, 0, 0);
        _margin(30, 10e6 - 1, 0, 0, 10e6 - 1);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(account), 30);
        // A lapsed report gives way too, even while its holding is still there.
        _margin(OTHER, 10e6, 0, 0, 10e6);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        _wait(1 days);
        require(_net() == 185e18);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        open = source.reports(address(account));
        require(open.length == 1 && open[0].kind == HyperCorePrecompileSource.ReportKind.Token);
    }

    /// @dev A renewal must not swap a proof that stands for one its sender can switch off.
    function testARenewalKeepsTheRouteThatStillStands() public {
        uint32 thinPair = 89; // OTHER also trades against QUOTE, on a book with a single bidder
        _other(3e8, 5e6); // 15 USDC on the USDC pair
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0);
        _tokenInfo(QUOTE, "QUOTE", address(0x995), 2, 8, 0);
        _pair(thinPair, OTHER, QUOTE);
        _pair(QUOTE_PAIR, QUOTE, USDC);
        _book(thinPair, 5e6, 5e6 + 1);
        _book(QUOTE_PAIR, 1e6, 1e6 + 1);
        _wait(100);
        VM.prank(STRANGER);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open.length == 1 && open[0].pair == OTHER_PAIR && !open[0].viaQuote, "the proof that stands is kept");
        require(open[0].expiresAt == clock + 1 days, "and renewed");
        // The single bidder leaves the thin book: the report still stands on the USDC pair.
        _book(thinPair, 0, 5e6 + 1);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        // A renewal does not need its own route to stand, only the kept one.
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        // Once the kept route no longer proves anything, a route that does takes its place.
        _book(OTHER_PAIR, 0, 1);
        _book(thinPair, 5e6, 5e6 + 1);
        require(_net() == 185e18);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        open = source.reports(address(account));
        require(open.length == 1 && open[0].pair == thinPair && open[0].viaQuote);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
    }

    function testSellableValueFollowsTheTokensOwnDecimals() public {
        uint32 coarse = 201;
        uint32 coarsePair = 301;
        _tokenInfo(coarse, "COARSE", address(0x994), 1, 6, 0); // lots of 0.1, prices with 7 decimals
        _pair(coarsePair, coarse, USDC);
        _spotPrice(coarsePair, 2e7, 2e7, 2e7); // 2 USDC
        _flat();
        _spot(coarse, 5e6, 0); // 5 tokens: exactly 10 USDC
        _noLedger(coarse);
        VM.prank(STRANGER);
        source.reportToken(address(account), coarse, coarsePair, false, 0); // outside the scope: reportable
        HyperCorePrecompileSource.Token[] memory list = new HyperCorePrecompileSource.Token[](3);
        list[0] = HyperCorePrecompileSource.Token(USDC, 0, true, false);
        list[1] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, false);
        list[2] = HyperCorePrecompileSource.Token(coarse, coarsePair, false, false);
        _configure(list, _dexes(0));
        (int256 net,) = _exit();
        require(net == 10e18, "5 tokens at a 2 USDC bid");
        _spot(coarse, 5e6 - 1, 0); // 4.9 whole lots: 9.8 USDC
        (net,) = _exit();
        require(net == 0);
    }

    function testAFailingPriceReadOfAnUnheldTokenDoesNotCloseTheNav() public {
        _spot(HYPE, 0, 0);
        VM.mockCallRevert(address(0x0808), abi.encode(HYPE_PAIR), hex"dead");
        require(_net() == 125e18, "the price of a token with no net holding is not read at all");
    }

    function testEventsCarryTheScopeTheReportsAndThePrices() public {
        HyperCorePrecompileSource.Token[] memory tokens = _tokens(true, true);
        _margin(1, 0, 0, 0, 0);
        _coreVault(0);
        VM.expectEmit();
        emit HyperCorePrecompileSource.ScopeConfigured(address(account), 2, false, tokens, _twoDexes(1), _hlp());
        source.configure(address(account), tokens, _twoDexes(1), _hlp(), false);
        VM.expectEmit();
        emit HyperCorePrecompileSource.ScopeEnabled(address(account), 2, true);
        source.setEnabled(address(account), true);
        _margin(3, 10e6, 0, 0, 10e6);
        VM.expectEmit();
        emit HyperCorePrecompileSource.ScopeReported(
            address(account), HyperCorePrecompileSource.ReportKind.Dex, 3, address(0), STRANGER
        );
        VM.prank(STRANGER);
        source.reportDex(address(account), 3);
        _margin(3, 0, 0, 0, 0);
        VM.expectEmit();
        emit HyperCorePrecompileSource.ReportCleared(
            address(account), HyperCorePrecompileSource.ReportKind.Dex, 3, address(0)
        );
        source.clearReport(address(account), 0);
        _wait(WINDOW / 8 + 1);
        VM.expectEmit();
        emit ManagedPortfolioNavVerifier.PriceRecorded(address(account), uint256(190e6 + 1) * 1e30 / (190e9 + 1000));
        reader.recordPrice(address(account));
        account.setPending(9, keccak256("recall"), 123, RECALL, 40e6);
        _block(124);
        VM.expectEmit();
        emit ManagedPortfolioNavVerifier.RecallAbandoned(address(account), 9);
        reader.abandonRecall(address(account), 9);
    }

    function testPosition2KeepsHip3AssetId() public {
        VM.mockCall(
            address(0x0813),
            abi.encode(address(account), uint32(110123)),
            abi.encode(int64(-200), uint64(100), int64(0), uint32(3), false)
        );
        VM.mockCall(address(0x0806), abi.encode(uint32(110123)), abi.encode(uint64(40)));
        VM.mockCall(address(0x0807), abi.encode(uint32(110123)), abi.encode(uint64(39)));
        (uint64 blockNumber, CoreRead.Position memory p, uint64 mark, uint64 oracle) =
            source.observePosition(address(account), 110123);
        require(blockNumber == 123 && p.szi == -200 && mark == 40 && oracle == 39);
    }

    function testHip4ActiveSettledAndPrunedRemainDistinct() public {
        uint32 encoded = 100000421;
        VM.mockCall(
            address(0x0801),
            abi.encode(address(account), uint64(encoded)),
            abi.encode(uint64(200), uint64(0), uint64(0))
        );
        VM.mockCall(address(0x0814), abi.encode(uint32(42)), abi.encode(uint8(1), uint64(0), uint32(2)));
        VM.mockCall(address(0x0808), abi.encode(encoded), abi.encode(uint64(30)));
        (, HyperCorePrecompileSource.OutcomeObservation memory o) = source.observeOutcome(address(account), 42, 1);
        require(o.encodedAsset == encoded && o.activeRawSpotPrice == 30 && o.balance.total == 200 && o.balanceQueried);
        VM.mockCall(address(0x0814), abi.encode(uint32(42)), abi.encode(uint8(2), uint64(70e6), uint32(2)));
        VM.mockCallRevert(address(0x0808), abi.encode(encoded), hex"dead");
        VM.mockCallRevert(address(0x0801), abi.encode(address(account), uint64(encoded)), hex"dead");
        (, o) = source.observeOutcome(address(account), 42, 1);
        require(o.status.settledValue == 70e6 && o.activeRawSpotPrice == 0 && !o.balanceQueried);
        VM.mockCall(address(0x0814), abi.encode(uint32(42)), abi.encode(uint8(3), uint64(0), uint32(2)));
        (, o) = source.observeOutcome(address(account), 42, 1);
        require(o.status.status == 3, "pruned is unknown settlement value, not a worthless asset");
        // Outcome balances are diagnostics only: the valuation above never included them.
        require(_net() == 185e18);
    }

    function testVerifierAddsVaultCashOnce() public view {
        (uint256 nav, uint64 b) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 190e6 && b == 123);
        (nav, b) = reader.nav(address(account));
        require(nav == 190e6 && b == 123);
    }

    function testNegativeCoreEquityClosesIssuanceInsteadOfConsumingEvmCash() public {
        // Portfolio Margin debt larger than everything registered on Core.
        _lending(USDC, 0, 400e8, 0, 0);
        account.setAvailableCash(1_000e6);
        require(_net() == -220e18);
        VM.expectRevert(ManagedPortfolioNavVerifier.NegativeCoreEquity.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        VM.expectRevert(ManagedPortfolioNavVerifier.NegativeCoreEquity.selector);
        reader.recordPrice(address(account));
    }

    function testFuzzVerifierRejectsAnotherVaultContext(uint8 seed) public {
        uint8 kind = seed % 3;
        if (kind == 0) account.setContext(address(1), 7, CONFIG);
        if (kind == 1) account.setContext(address(asset), 6, CONFIG);
        if (kind == 2) account.setContext(address(asset), 7, bytes32(uint256(1)));
        VM.expectRevert(ManagedPortfolioNavVerifier.InvalidContext.selector);
        reader.verifyNav(address(account), 7, CONFIG);
    }

    function testIssuanceNeedsHalfAWindowOfRecordedPrices() public {
        ManagedPortfolioNavVerifier fresh =
            new ManagedPortfolioNavVerifier(address(asset), source, TIMEOUT, 100_000, WINDOW, DRAWDOWN);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        fresh.verifyNav(address(account), 7, CONFIG);
        VM.prank(STRANGER);
        fresh.recordPrice(address(account));
        // A price recorded a moment ago proves nothing about what the Vault was worth before.
        _wait(WINDOW / 2 - 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        fresh.verifyNav(address(account), 7, CONFIG);
        _wait(1);
        (uint256 nav,) = fresh.verifyNav(address(account), 7, CONFIG);
        require(nav == 190e6);
        // Records are spaced: eight of them span the whole window.
        fresh.recordPrice(address(account));
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceRecordTooSoon.selector);
        fresh.recordPrice(address(account));
        _wait(WINDOW / 8);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceRecordTooSoon.selector);
        fresh.recordPrice(address(account));
        _wait(1);
        fresh.recordPrice(address(account));
        // History older than the window is no history.
        _wait(WINDOW + 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        fresh.verifyNav(address(account), 7, CONFIG);
    }

    function testIssuanceStopsAfterTheSharePriceFallsAndReopensWithNewHistory() public {
        account.setAvailableCash(0);
        _margin(0, 15_500_000, 2e6, 40e6, 15_500_000); // 180.5 USDC: exactly 5% below the record
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 180_500_000);
        _margin(0, 15_499_999, 2e6, 40e6, 15_499_999); // one unit more: a loss, or value out of scope
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        (nav,) = reader.nav(address(account));
        require(nav == 180_499_999, "the value itself stays readable");
        // Recording the lower price does not lower the bar while the higher record is in the window.
        _wait(WINDOW / 8 + 1);
        reader.recordPrice(address(account));
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        // The high record leaves the window, then the low one has to age like any other.
        _wait(WINDOW / 2 - WINDOW / 8);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        _wait(WINDOW / 8);
        (nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 180_499_999);
    }

    /// @dev With 1e12 virtual-adjusted shares the price is the assets plus one, so the limit can
    ///      be met to the unit: a price of exactly 95% of the highest record still issues.
    function testAPriceExactlyAtTheLimitStillIssues() public {
        ManagedPortfolioNavVerifier fresh =
            new ManagedPortfolioNavVerifier(address(asset), source, TIMEOUT, 100_000, WINDOW, DRAWDOWN);
        account.setTotalSupply(1e12 - 1000);
        account.setAvailableCash(14_999_999); // with 185 USDC on Core: 199.999999 USDC
        require(fresh.recordPrice(address(account)) == 200e6 * 1e18);
        _wait(WINDOW / 2);
        account.setAvailableCash(4_999_999); // 189.999999 USDC: a price of exactly 190e6 * 1e18
        (uint256 nav,) = fresh.verifyNav(address(account), 7, CONFIG);
        require(nav == 189_999_999);
        account.setAvailableCash(4_999_998);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        fresh.verifyNav(address(account), 7, CONFIG);
    }

    function testSharePriceNotAssetsIsWhatMustHold() public {
        // Twice the assets for twice the shares is the same price.
        account.setTotalSupply(380e9);
        account.setAvailableCash(195e6);
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 380e6);
        // The same assets for twice the shares is half the price.
        account.setAvailableCash(5e6);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        // A rise never trips it.
        account.setAvailableCash(10_000e6);
        (nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 10_185e6);
    }

    function testPriceRecordsSpanTheWindowBeforeTheOldestIsOverwritten() public {
        // setUp recorded at t = 1. Eight more records, each as early as allowed, fill the ring.
        for (uint256 i; i < reader.PRICE_RECORDS(); ++i) {
            _wait(WINDOW / 8 + 1);
            reader.recordPrice(address(account));
        }
        ManagedPortfolioNavVerifier.PriceRecord[8] memory records = reader.priceRecords(address(account));
        uint256 oldest = type(uint256).max;
        for (uint256 i; i < records.length; ++i) {
            if (records[i].time < oldest) oldest = records[i].time;
        }
        require(oldest > 1 && clock - 1 > WINDOW, "the first record was overwritten only after leaving the window");
        require(clock - oldest <= WINDOW, "everything kept is inside the window");
        // The record seven steps back still holds the bar.
        account.setAvailableCash(0);
        _margin(0, 15_499_999, 2e6, 40e6, 15_499_999);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
    }

    function testNoPriceIsRecordedWithoutSharesOrWithoutAScope() public {
        // With no share outstanding the ratio is what is left over the virtual shares: a spike that
        // would hold the next period's issuance below the bar for a whole window.
        account.setTotalSupply(0);
        VM.expectRevert(ManagedPortfolioNavVerifier.NoShares.selector);
        reader.recordPrice(address(account));
        account.setTotalSupply(190e9);
        // A Vault whose owner never registered a scope has no price to record.
        NavVaultFixture unconfigured = new NavVaultFixture(address(this), address(asset));
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        reader.recordPrice(address(unconfigured));
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        source.scopeValue(address(unconfigured));
        require(source.reportAnsweredAt(address(unconfigured)) == 0 && source.reportAnsweredAt(address(account)) == 0);
    }

    /// @dev The owner can keep an action pending for as long as he likes: a recall Core cannot
    ///      serve stays open until he gives up on it. If that stopped the records, the fair ones
    ///      would leave the window while the value never left the scope.
    function testAPendingActionDoesNotStopThePriceHistory() public {
        uint256 fair = reader.priceRecords(address(account))[0].price;
        account.setPending(9, keccak256("recall"), 123, RECALL, 1_000_000e6);
        VM.prank(STRANGER);
        require(reader.recordPrice(address(account)) == fair);
        // Funds really in flight are in neither ledger: that record is low, never high, and a low
        // record does not lower the bar.
        _spot(USDC, 60e8, 20e8); // 40 USDC left Core and are not booked on the EVM side yet
        _wait(WINDOW / 8 + 1);
        require(reader.recordPrice(address(account)) < fair);
        account.setPending(0, bytes32(0), 0, 0, 0);
        account.setAvailableCash(45e6);
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 190e6, "booked: the fair price, measured against the fair record");
    }

    /// @dev Issuance and exits both need the history. If the owner's switch or a report could stop
    ///      it, stopping it would be a way to empty the window.
    function testNeitherTheSwitchNorAReportStopsThePriceHistory() public {
        uint256 fair = reader.priceRecords(address(account))[0].price;
        source.setEnabled(address(account), false);
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        reader.nav(address(account));
        (int256 net, uint64 coreBlock) = source.scopeValue(address(account));
        require(net == 185e18 && coreBlock == 123);
        VM.prank(STRANGER);
        require(reader.recordPrice(address(account)) == fair);
        source.setEnabled(address(account), true);
        _margin(3, 10e6, 0, 0, 10e6);
        source.reportDex(address(account), 3);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        reader.nav(address(account));
        (net,) = source.scopeValue(address(account));
        require(net == 185e18, "the registered scope, whatever is reported outside it");
        _wait(WINDOW / 8 + 1);
        VM.prank(STRANGER);
        require(reader.recordPrice(address(account)) == fair);
        ManagedPortfolioNavVerifier.PriceRecord[8] memory records = reader.priceRecords(address(account));
        require(records[1].time == clock - WINDOW / 8 - 1 && records[2].time == clock);
        // It is priced like issuance: what closes that valuation for another reason closes this one.
        _book(HYPE_PAIR, 29e6, 30e6);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        source.scopeValue(address(account));
        _wait(WINDOW / 8 + 1);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        reader.recordPrice(address(account));
    }

    /// @dev An Idle Vault issues at its cash alone, so that is its price. What an exit left on
    ///      Core is not in it: over a handful of remaining shares it would be a spike.
    function testAnIdleVaultRecordsThePriceItIssuesAt() public {
        _flat();
        _spot(USDC, 5_000_000, 0); // 0.05 USDC of dust left on Core
        account.setTotalSupply(1); // everything redeemed but one share unit
        account.setAvailableCash(0);
        account.setPhase(3); // Idle
        _wait(WINDOW / 8 + 1);
        uint256 price = reader.recordPrice(address(account));
        require(price == uint256(1e30) / 1001, "one unit of cash over the virtual shares, as the Vault converts");
        // The same state in a running Vault is priced with what is on Core.
        account.setPhase(4);
        _wait(WINDOW / 8 + 1);
        require(reader.recordPrice(address(account)) == uint256(50_001) * 1e30 / 1001);
        // And an Idle Vault needs no valuation at all: its record cannot be stopped from Core.
        account.setPhase(3);
        VM.mockCallRevert(address(0x0801), abi.encode(address(account), uint64(USDC)), hex"dead");
        account.setAvailableCash(1_000);
        _wait(WINDOW / 8 + 1);
        require(reader.recordPrice(address(account)) == uint256(1_001) * 1e30 / 1001);
    }

    /// @dev Whoever records first in a slot must not own that sample.
    function testAHigherPriceReplacesTheNewestRecordSoADipCannotOwnTheSample() public {
        uint256 fair = reader.priceRecords(address(account))[0].price;
        _margin(0, 0, 0, 0, 0); // 20 USDC leave the scope for a moment, and that price is recorded
        require(reader.recordPrice(address(account)) < fair);
        _margin(0, 20e6, 2e6, 40e6, 19e6); // they are back a few blocks later
        _wait(10);
        VM.prank(STRANGER);
        require(reader.recordPrice(address(account)) == fair);
        ManagedPortfolioNavVerifier.PriceRecord[8] memory records = reader.priceRecords(address(account));
        require(records[1].price == fair && records[1].time == clock - 10, "the price is replaced, its time kept");
        require(records[2].time == 0, "no second sample was taken");
        // Only a higher price replaces it: the same or a lower one waits for the next sample.
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceRecordTooSoon.selector);
        reader.recordPrice(address(account));
        _margin(0, 0, 0, 0, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceRecordTooSoon.selector);
        reader.recordPrice(address(account));
        // So once the first record has left the window, the dip is still measured against a fair price.
        _wait(WINDOW / 2 - 9); // t = 602
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        _margin(0, 20e6, 2e6, 40e6, 19e6);
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 190e6);
    }

    function testARecordExactlyOneWindowOldStillHoldsTheBar() public {
        account.setAvailableCash(0);
        _margin(0, 15_499_999, 2e6, 40e6, 15_499_999); // one unit beyond a 5% fall
        _wait(WINDOW - WINDOW / 2); // t = 601: the record of t = 1 is exactly one window old
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        _wait(1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyNav(address(account), 7, CONFIG);
    }

    function testActionIsFinalOnlyInALaterCoreBlockAndForThePendingDigest() public {
        bytes32 digest = keccak256("intent");
        account.setPending(9, digest, 123, DEPOSIT, 40e6);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        reader.verifyAction(address(account), 9, digest, "");
        _block(124);
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.verifyAction(address(account), 8, digest, "");
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.verifyAction(address(account), 9, bytes32(0), "");
        IManagedVaultVerifier.Receipt memory r = reader.verifyAction(address(account), 9, digest, "ignored");
        require(r.coreBlock == 124 && r.success && r.receivedAssets == 40e6);
        account.setPending(9, digest, 123, CONTROL, 0);
        r = reader.verifyAction(address(account), 9, digest, "");
        require(r.success && r.receivedAssets == 0);
        account.setPending(9, digest, 123, AGENT, 0);
        r = reader.verifyAction(address(account), 9, digest, "");
        require(r.success && r.receivedAssets == 0);
        account.setPending(0, bytes32(0), 0, 0, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.verifyAction(address(account), 0, bytes32(0), "");
    }

    function testRecallBooksOnlyArrivedUsdcAndOnlyTheOwnerCanGiveUpOnIt() public {
        bytes32 digest = keccak256("recall");
        account.setPending(9, digest, 123, RECALL, 40e6);
        account.setUnaccounted(40e6 - 1);
        // Not in the Core block of the recall itself: nothing can be known about it yet.
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        reader.abandonRecall(address(account), 9);
        uint64 late = 123 + TIMEOUT + 1;
        _block(late);
        // Time alone never fails a recall: its USDC may still be in flight.
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        reader.verifyAction(address(account), 9, digest, "");
        VM.prank(STRANGER);
        VM.expectRevert(ManagedPortfolioNavVerifier.Unauthorized.selector);
        reader.abandonRecall(address(account), 9);
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.abandonRecall(address(account), 8);
        reader.abandonRecall(address(account), 9);
        (uint256 given, uint64 declared) = reader.abandonedRecall(address(account));
        require(given == 9 && declared == late);
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.abandonRecall(address(account), 9); // declaring again must not move the clock
        // The wait runs from the declaration, however long ago the recall was submitted.
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        reader.verifyAction(address(account), 9, digest, "");
        _block(late + TIMEOUT);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        reader.verifyAction(address(account), 9, digest, "");
        _block(late + TIMEOUT + 1);
        IManagedVaultVerifier.Receipt memory r = reader.verifyAction(address(account), 9, digest, "");
        require(r.success && r.receivedAssets == 40e6 - 1, "a short arrival is booked, not stranded");
        account.setUnaccounted(0);
        r = reader.verifyAction(address(account), 9, digest, "");
        require(!r.success && r.receivedAssets == 0, "nothing arrived: nothing is booked");
        account.setUnaccounted(90e6);
        _block(124);
        r = reader.verifyAction(address(account), 9, digest, "");
        require(r.success && r.receivedAssets == 40e6 && r.coreBlock == 124, "never books more than requested");
        // Giving up is bound to that action: the next recall starts over.
        account.setPending(10, digest, 123, RECALL, 40e6);
        account.setUnaccounted(0);
        _block(late + 3 * TIMEOUT);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        reader.verifyAction(address(account), 10, digest, "");
        account.setPending(11, digest, 123, DEPOSIT, 40e6);
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.abandonRecall(address(account), 11); // only a recall can be given up
        account.setPending(0, bytes32(0), 0, 0, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        reader.abandonRecall(address(account), 0);
    }

    function testAnExitWaitsAfterTheSharePriceFell() public {
        _flat();
        account.setAvailableCash(190e6); // everything came home: 190 USDC for 190e9 shares, as recorded
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        account.setAvailableCash(180_500_000); // exactly 5% below the record
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        // One unit less. A loss and value left outside the scope look the same, so the exit is not
        // settled at once: a watcher gets the window to prove the latter.
        account.setAvailableCash(180_499_999);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        // What is compared is the cash an exit pays out: dust left on Core does not count towards it.
        _spot(USDC, 10_000_000, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        // Half the shares for the same cash is twice the price.
        account.setTotalSupply(95e9);
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        account.setTotalSupply(190e9);
        _wait(WINDOW / 2); // t = 601: the record of t = 1 is exactly one window old and still counts
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        // Without records in the window nothing settles: stopping the records must not be a way
        // to skip the wait. A new record has to age like it does for issuance.
        _wait(1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        VM.prank(STRANGER);
        reader.recordPrice(address(account));
        _wait(WINDOW / 2 - 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _wait(1);
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
    }

    /// @dev The owner reports a small holding of his own, which takes the one place a report has,
    ///      and moves the real value to another venue nobody can list meanwhile. Registering the
    ///      small one lifts the report in a block of his choosing.
    function testAnsweringAReportByRegisteringItsVenueRestartsThePriceHistory() public {
        reader.recordPrice(address(account)); // t = 301, the fair price again
        // An ordinary change of the scope keeps the history.
        _margin(3, 0, 0, 0, 0);
        _configure(_tokens(true, false), _twoDexes(3));
        _configure(_tokens(true, false), _dexes(0));
        (uint256 nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 190e6 && source.reportAnsweredAt(address(account)) == 0);

        _margin(3, 10e6, 0, 0, 10e6);
        VM.prank(STRANGER);
        source.reportDex(address(account), 3);
        // Registering another venue answers nothing: the report stays and so does the history.
        _margin(4, 0, 0, 0, 0);
        _configure(_tokens(true, false), _twoDexes(4));
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open.length == 1 && open[0].id == 3 && source.reportAnsweredAt(address(account)) == 0);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        // Nor does such a change tidy the list: a report whose venue it does not register stays
        // listed after it stopped standing, until someone clears it or it lapses.
        _margin(3, 0, 0, 0, 0);
        _configure(_tokens(true, false), _dexes(0));
        require(source.reports(address(account)).length == 1 && source.reportAnsweredAt(address(account)) == 0);
        _margin(3, 10e6, 0, 0, 10e6);
        _wait(WINDOW / 8 + 1); // t = 377
        reader.recordPrice(address(account)); // the records go on while it is listed
        VM.expectEmit();
        emit HyperCorePrecompileSource.ReportCleared(
            address(account), HyperCorePrecompileSource.ReportKind.Dex, 3, address(0)
        );
        _configure(_tokens(true, false), _twoDexes(3));
        require(source.reports(address(account)).length == 0, "answered: no longer listed");
        require(source.reportAnsweredAt(address(account)) == clock);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        // A price recorded in that block is no history either. It replaces the newest record,
        // being higher by the 10 USDC now counted, and keeps that record's time.
        require(reader.recordPrice(address(account)) > reader.priceRecords(address(account))[0].price);
        _wait(WINDOW / 2); // t = 677
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        // One recorded after it is, once it has aged. The price fell meanwhile: the records from
        // before are no history, but they still hold the bar while they are in the window.
        _margin(3, 0, 0, 0, 0);
        account.setAvailableCash(4_999_999); // 189.999999 USDC: one unit beyond 5% below 200
        uint256 low = reader.recordPrice(address(account));
        _wait(WINDOW / 2 - 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        _wait(1); // t = 977: the record of t = 377 is exactly one window old
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        reader.verifyNav(address(account), 7, CONFIG);
        _wait(1);
        (nav,) = reader.verifyNav(address(account), 7, CONFIG);
        require(nav == 189_999_999 && low < reader.priceRecords(address(account))[2].price);

        // An exit is held to the same history.
        _flat();
        account.setAvailableCash(189_999_999);
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        _coreVault(10e6);
        source.reportCoreVault(address(account), HLP);
        source.configure(address(account), _tokens(true, false), _twoDexes(3), _hlp(), true);
        _coreVault(0);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyIdle(address(account), 1, 7, "");

        // A report that lapsed lifts nothing any more: registering its venue only drops it.
        uint256 answered = source.reportAnsweredAt(address(account));
        _margin(9, 10e6, 0, 0, 10e6);
        source.reportDex(address(account), 9);
        _wait(1 days);
        uint32[] memory three = new uint32[](3);
        (three[0], three[1], three[2]) = (0, 3, 9);
        source.configure(address(account), _tokens(true, false), three, _hlp(), true);
        require(source.reports(address(account)).length == 0 && source.reportAnsweredAt(address(account)) == answered);
    }

    /// @dev A registered token counts in an exit only for what its own USDC pair would pay. It used
    ///      to be beyond reports whatever that was, so value moved into a token registered on a pair
    ///      nobody bids on was neither counted nor reportable. Now every holding is one or the
    ///      other: the scope answers for it, or anyone can name it.
    function testARegisteredTokenTheScopeCountsNothingForCanStillBeNamed() public {
        uint32 thinPair = 89; // OTHER also sells for QUOTE
        HyperCorePrecompileSource.Token[] memory three = new HyperCorePrecompileSource.Token[](3);
        (three[0], three[2]) = (_tokens(true, false)[0], _tokens(true, false)[1]);
        three[1] = HyperCorePrecompileSource.Token(OTHER, OTHER_PAIR, false, false);
        _other(0, 0); // registered while empty, on a USDC pair without a bid
        _configure(three, _dexes(0));
        _tokenInfo(QUOTE, "QUOTE", address(0x995), 2, 8, 0);
        _pair(thinPair, OTHER, QUOTE);
        _pair(QUOTE_PAIR, QUOTE, USDC);
        _book(thinPair, 5e6, 5e6 + 1);
        _book(QUOTE_PAIR, 1e6, 1e6 + 1);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR); // nothing held
        // 4 OTHER arrive: worth 20 QUOTE on the other pair and nothing on the registered one.
        _spot(OTHER, 4e8, 0);
        (int256 without,) = _exit();
        require(without == 185e18, "the exit counts nothing for it");
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, OTHER_PAIR, false, 0); // not provable where nobody bids
        // A registered token must be worth twice the minimum order elsewhere: a remainder its own
        // pair values just under the minimum is not hidden because another pair bids a little more.
        // That holds for a second USDC pair of its own as well.
        _pair(95, OTHER, USDC);
        _book(95, 4_999_999, 5e6); // 19.999996 USDC
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, 95, false, 0);
        _book(95, 5e6, 5e6 + 1); // 20 USDC
        source.reportToken(address(account), OTHER, 95, false, 0);
        _book(95, 0, 1);
        source.clearReport(address(account), 0);
        // The first hop only has to be an order Core accepts: 15 QUOTE, here worth 30 USDC.
        _book(thinPair, 3_750_000, 3_750_001);
        _book(QUOTE_PAIR, 2e6, 2e6 + 1);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        _book(QUOTE_PAIR, 1e6, 1e6 + 1); // 15 USDC: not enough any more
        source.clearReport(address(account), 0);
        _book(thinPair, 5e6, 5e6 + 1);
        _book(QUOTE_PAIR, 999_999, 1e6 + 1); // 19.99998 USDC
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        _book(QUOTE_PAIR, 1e6, 1e6 + 1); // 20 USDC
        VM.prank(STRANGER);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.exposure(address(account));
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.evaluate(address(account));
        // Registering it again answers nothing while its pair pays nothing: the report stays.
        _margin(3, 0, 0, 0, 0);
        _configure(three, _twoDexes(3));
        HyperCorePrecompileSource.Report[] memory open = source.reports(address(account));
        require(open.length == 1 && open[0].id == OTHER && source.reportAnsweredAt(address(account)) == 0);
        // A bid below the minimum order still pays nothing: 4 OTHER at 2.499999 USDC.
        _book(OTHER_PAIR, 2_499_999, 2_500_000);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        source.exposure(address(account));
        VM.expectRevert(HyperCorePrecompileSource.ReportStands.selector);
        source.clearReport(address(account), 0);
        // At 2.5 USDC the scope counts the holding, and from then on answers for it.
        _book(OTHER_PAIR, 2_500_000, 2_500_001);
        (int256 counted,) = _exit();
        require(counted == without + 10e18, "counted at its own bid");
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        // The report stopped standing by itself. A later scope change only drops it: that change
        // lifted nothing, so the price history stays.
        _wait(1);
        _configure(three, _dexes(0));
        require(source.reports(address(account)).length == 0 && source.reportAnsweredAt(address(account)) == 0);
        // A scope change that itself makes the scope count a reported holding does answer the
        // report: here the token moves to a pair that pays for it.
        _book(OTHER_PAIR, 0, 1);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        _pair(94, OTHER, USDC);
        _book(94, 5e6, 5e6 + 1);
        three[1].usdcSpot = 94;
        _wait(1);
        _configure(three, _dexes(0));
        require(source.reports(address(account)).length == 0 && source.reportAnsweredAt(address(account)) == clock);
        // A registered token's debt is the scope's to answer for too: its valuations refuse it.
        three[1].usdcSpot = OTHER_PAIR;
        _configure(three, _dexes(0));
        _lending(OTHER, 0, 1, 0, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        VM.expectRevert(HyperCorePrecompileSource.ScopeIncomplete.selector);
        source.exposure(address(account));
        // What is supplied is part of the holding the scope answers for.
        _spot(OTHER, 0, 0);
        _lending(OTHER, 0, 0, 0, 4e8);
        _book(OTHER_PAIR, 2_500_000, 2_500_001);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        // USDC is always in the scope and counted in full: it cannot be named even with no debt,
        // no bid on the pair its empty pair field happens to name, and a pair that would pay.
        _lending(USDC, 0, 0, 9e8, 10e8);
        _book(0, 0, 1);
        _pair(500, USDC, QUOTE);
        _book(500, 1e6, 1e6 + 1);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), USDC, 500, true, QUOTE_PAIR);
        // A lapsed report leaves the list at the next scope change without its venue being read:
        // read, it would still stand.
        _noLedger(OTHER);
        _spot(OTHER, 4e8, 0);
        _book(OTHER_PAIR, 0, 1);
        source.reportToken(address(account), OTHER, thinPair, true, QUOTE_PAIR);
        uint256 answered = source.reportAnsweredAt(address(account));
        _wait(1 days);
        _configure(three, _dexes(0));
        require(source.reports(address(account)).length == 0 && source.reportAnsweredAt(address(account)) == answered);
    }

    /// @dev Kind, index and HyperCore vault address together name a venue. A report that shares
    ///      only some of them with the kept one is another venue's, not a renewal.
    function testOnlyTheSameVenueRenewsAStandingReport() public {
        _margin(30, 100e6, 0, 0, 100e6);
        source.reportDex(address(account), 30);
        uint256 expiry = source.reports(address(account))[0].expiresAt;
        // Token 30 is not DEX 30.
        _tokenInfo(30, "THIRTY", address(0x993), 2, 8, 0);
        _pair(130, 30, USDC);
        _book(130, 5e6, 5e6 + 1);
        _spot(30, 3e8, 0);
        _noLedger(30);
        _wait(100);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(account), 30, 130, false, 0);
        require(source.reports(address(account))[0].expiresAt == expiry, "not renewed by another venue");
        // It was refused for the standing report alone: once DEX 30 is empty it takes the place.
        _margin(30, 0, 0, 0, 0);
        source.reportToken(address(account), 30, 130, false, 0);
        require(source.reports(address(account))[0].kind == HyperCorePrecompileSource.ReportKind.Token);
        _book(130, 0, 1);
        source.clearReport(address(account), 0);
        // One HyperCore vault is not another.
        address second = address(0x4118);
        _coreVault(10e6);
        VM.mockCall(address(0x0802), abi.encode(address(account), second), abi.encode(uint64(50e6), uint64(0)));
        source.reportCoreVault(address(account), HLP);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportCoreVault(address(account), second);
        _coreVault(0);
        source.reportCoreVault(address(account), second);
        require(source.reports(address(account))[0].coreVault == second);
    }

    /// @dev Without shares nothing can be recorded. An exit of such a Vault pays nobody, and it
    ///      must still be able to end: Idle is the only phase that takes the next deposit.
    function testAnExitThatPaysNobodyNeedsNoPriceHistory() public {
        _flat();
        account.setAvailableCash(0);
        account.setTotalSupply(0);
        _wait(WINDOW + 1); // the window is empty, and stays so
        VM.expectRevert(ManagedPortfolioNavVerifier.NoShares.selector);
        reader.recordPrice(address(account));
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        // The Core state still has to be flat.
        _spot(USDC, 10_000_001, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        // One share unit makes it an exit like any other.
        _spot(USDC, 0, 0);
        account.setTotalSupply(1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        reader.verifyIdle(address(account), 1, 7, "");
    }

    function testIdleNeedsNothingLeftThatCouldBeBroughtHome() public {
        account.setAvailableCash(190e6); // the recorded price, so that only the Core state decides here
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _flat();
        _spot(USDC, 10_000_000, 0); // 0.1 USDC: exactly the dust limit
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        VM.expectRevert(ManagedPortfolioNavVerifier.InvalidContext.selector);
        reader.verifyIdle(address(account), 1, 6, "");
        _spot(USDC, 10_000_001, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _spot(USDC, 0, 0);
        // Anyone can send a registered token to the Vault's Core account. One lot (0.3 USDC) is
        // below the minimum order: it cannot be sold, so it cannot keep the exit open.
        _spot(HYPE, HYPE_LOT, 0);
        require(reader.verifyIdle(address(account), 1, 7, "") == 123, "blocked by a holding nobody can sell");
        _spot(HYPE, 34 * HYPE_LOT, 0); // 10.2 USDC can be sold, so it has to be
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _book(HYPE_PAIR, 0, 30e6); // nobody bids: nothing can be sold whatever the size
        require(reader.verifyIdle(address(account), 1, 7, "") == 123);
        _spot(HYPE, 0, 0);
        _lending(USDC, 0, 1, 0, 1); // debt offset by supply is still a liability
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _lending(USDC, 0, 1, 0, 0); // and a net debt is never dust
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _lending(USDC, 0, 0, 0, 0);
        _margin(0, 0, 0, 1, 0); // an open position with zero equity
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        // A deficit with no position, with spot left over that covers it and stays inside the
        // dust limit: only the deficit itself can refuse this.
        _margin(0, -1, 0, 0, -1);
        _spot(USDC, 5_000_000, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, "");
        _margin(0, 0, 0, 0, 0);
        source.setEnabled(address(account), false);
        require(reader.verifyIdle(address(account), 1, 7, "") == 123, "a paused scope must not block exits");
        _coreVault(1e6);
        source.configure(address(account), _tokens(true, false), _dexes(0), _hlp(), false);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        reader.verifyIdle(address(account), 1, 7, ""); // equity left in a HyperCore vault
        NavVaultFixture unconfigured = new NavVaultFixture(address(this), address(asset));
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        reader.verifyIdle(address(unconfigured), 1, 7, "");
    }

    function testVerifierConfigurationBounds() public {
        uint64[2] memory timeouts = [uint64(9_999), 2_000_001];
        for (uint256 i; i < timeouts.length; ++i) {
            VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
            new ManagedPortfolioNavVerifier(address(asset), source, timeouts[i], 100_000, WINDOW, DRAWDOWN);
        }
        // Zero would let a sub-unit USDC residue, which no recall can move, block every exit.
        // Ten USDC or more could be a holding of the size a report takes, left behind as dust.
        uint256[2] memory limits = [uint256(0), 10e6];
        for (uint256 i; i < limits.length; ++i) {
            VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
            new ManagedPortfolioNavVerifier(address(asset), source, TIMEOUT, limits[i], WINDOW, DRAWDOWN);
        }
        uint256[2] memory windows = [uint256(10 minutes - 1), 1 days + 1];
        for (uint256 i; i < windows.length; ++i) {
            VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
            new ManagedPortfolioNavVerifier(address(asset), source, TIMEOUT, 100_000, windows[i], DRAWDOWN);
        }
        uint256[2] memory drawdowns = [uint256(9), 2_001];
        for (uint256 i; i < drawdowns.length; ++i) {
            VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
            new ManagedPortfolioNavVerifier(address(asset), source, TIMEOUT, 100_000, WINDOW, drawdowns[i]);
        }
        ManagedPortfolioNavVerifier widest =
            new ManagedPortfolioNavVerifier(address(asset), source, 2_000_000, 10e6 - 1, 1 days, 2_000);
        require(widest.recallTimeoutBlocks() == 2_000_000 && widest.idleDustLimit() == 10e6 - 1);
        require(widest.priceWindow() == 1 days && widest.maxDrawdownBps() == 2_000);
        // The asset must be a 6-decimal token and the source a contract.
        address wrongDecimals = address(new NavWrongDecimalsFixture());
        VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
        new ManagedPortfolioNavVerifier(address(0x1234), source, TIMEOUT, 100_000, WINDOW, DRAWDOWN);
        VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
        new ManagedPortfolioNavVerifier(wrongDecimals, source, TIMEOUT, 100_000, WINDOW, DRAWDOWN);
        VM.expectRevert(ManagedPortfolioNavVerifier.InvalidConfiguration.selector);
        new ManagedPortfolioNavVerifier(
            address(asset), IManagedCoreNavSource(address(0x1234)), TIMEOUT, 100_000, WINDOW, DRAWDOWN
        );
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        new HyperCorePrecompileSource(wrongDecimals, bridge, USDC);
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        new HyperCorePrecompileSource(address(asset), address(0x1234), USDC);
        VM.expectRevert(HyperCorePrecompileSource.InvalidConfiguration.selector);
        new HyperCorePrecompileSource(address(asset), bridge, 100_000_000);
    }
}
