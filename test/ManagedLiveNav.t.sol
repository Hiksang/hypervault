// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ManagedUsdcVault} from "../src/ManagedUsdcVault.sol";
import {ManagedUsdcVaultFactory} from "../src/ManagedUsdcVaultFactory.sol";
import {ManagedPortfolioNavVerifier} from "../src/managed/ManagedPortfolioNavVerifier.sol";
import {HyperCorePrecompileSource} from "../src/nav/HyperCorePrecompileSource.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {ManagedTestUsdc, ManagedTestDepositWallet} from "./ManagedUsdcVault.t.sol";

interface VmLiveNav {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function mockCall(address, bytes calldata, bytes calldata) external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function getCode(string calldata) external view returns (bytes memory);
    function warp(uint256) external;
}

/// @dev The real Vault wired to the real source and verifier. Only the Core precompiles and the
///      Circle/CoreWriter effects are injected; this is a local model, not network evidence.
contract ManagedLiveNavTest {
    VmLiveNav private constant VM = VmLiveNav(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant KEEPER = address(0xCAFE);
    uint32 private constant SPOT = type(uint32).max;
    uint32 private constant HYPE = 150;
    uint32 private constant HYPE_PAIR = 107;
    uint32 private constant JUNK = 777; // nobody trades it: the bid on its USDC pair is the owner's own
    uint32 private constant JUNK_PAIR = 888;
    uint32 private constant HELD = 778; // trades against USDH; nobody bids USDC for it
    uint32 private constant HELD_USDH_PAIR = 898;
    uint32 private constant HELD_USDC_PAIR = 899;
    uint32 private constant USDH = 360;
    uint32 private constant USDH_PAIR = 890;
    uint64 private constant RECALL_TIMEOUT = 10_000;
    uint256 private constant WINDOW = 10 minutes;
    uint256 private constant DRAWDOWN = 500;
    ManagedTestUsdc private token;
    ManagedTestDepositWallet private circle;
    HyperCorePrecompileSource private source;
    ManagedPortfolioNavVerifier private verifier;
    ManagedUsdcVaultFactory private factory;
    ManagedUsdcVault private vault;
    uint64 private coreBlock;
    uint256 private clock = 1; // block.timestamp is not re-read after a warp under via-IR

    function setUp() public {
        token = new ManagedTestUsdc();
        circle = new ManagedTestDepositWallet(token);
        source = new HyperCorePrecompileSource(address(token), address(circle), 0);
        verifier = new ManagedPortfolioNavVerifier(address(token), source, RECALL_TIMEOUT, 100_000, WINDOW, DRAWDOWN);
        VM.mockCall(address(0x0810), bytes(""), abi.encode(false));
        VM.mockCall(address(0x0801), bytes(""), abi.encode(uint64(0), uint64(0), uint64(0)));
        VM.mockCallRevert(address(0x0811), bytes(""), hex"dead"); // a Unified account without a lending ledger
        _block(100);
        ManagedUsdcVault.Config memory c;
        c.asset = address(token);
        c.coreDepositWallet = address(circle);
        c.coreWriter = address(new MockCoreWriter());
        c.verifier = address(verifier);
        c.treasury = address(0xFEE);
        c.activationCost = 1e6;
        c.performanceFeeBps = 1000;
        c.minimumDeposit = 10e6;
        c.maximumAssets = 1_000_000e6;
        c.chainId = block.chainid;
        bytes memory creation =
            bytes.concat(VM.getCode("ManagedUsdcVaultFactory.sol:ManagedUsdcVaultFactory"), abi.encode(c));
        address f;
        assembly ("memory-safe") { f := create(0, add(creation, 32), mload(creation)) }
        require(f != address(0), "factory deployment");
        factory = ManagedUsdcVaultFactory(f);
        token.mint(address(this), 1_000e6);
        token.approve(f, type(uint256).max);
        vault = factory.createVaultAndFund(1e6);
        token.mint(ALICE, 1_000e6);
        token.mint(BOB, 1_000e6);
        CoreRead.TokenInfo memory usdc;
        usdc.name = "USDC";
        usdc.evmContract = address(circle);
        usdc.szDecimals = 8;
        usdc.weiDecimals = 8;
        usdc.evmExtraWeiDecimals = -2;
        VM.mockCall(address(0x080c), abi.encode(uint32(0)), abi.encode(usdc));
    }

    function _wait(uint256 secs) private {
        clock += secs;
        VM.warp(clock);
    }

    /// @dev Let the old share price leave the window and a new one age into it.
    function _reprice() private {
        _wait(WINDOW + 1);
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
    }

    function _block(uint64 value) private {
        coreBlock = value;
        VM.mockCall(address(0x0809), bytes(""), abi.encode(value));
    }

    /// @dev Raw ledgers of a Unified account: spot USDC (8 decimals) and two USDC DEX equities.
    function _coreOf(address account, uint64 spotUsdc, int64 mainDex, int64 hip3Dex) private {
        VM.mockCall(address(0x0801), abi.encode(account, uint64(0)), abi.encode(spotUsdc, uint64(0), uint64(0)));
        _margin(account, 0, mainDex);
        _margin(account, 1, hip3Dex);
    }

    function _core(uint64 spotUsdc, int64 mainDex, int64 hip3Dex) private {
        _coreOf(address(vault), spotUsdc, mainDex, hip3Dex);
    }

    /// @dev Positive equity backs an open position; zero and negative equity have none.
    function _margin(address account, uint32 dex, int64 equity) private {
        uint64 notional = equity > 0 ? 1_000e6 : 0;
        VM.mockCall(address(0x080f), abi.encode(dex, account), abi.encode(equity, uint64(0), notional, equity));
    }

    function _usdc() private pure returns (HyperCorePrecompileSource.Token[] memory tokens) {
        tokens = new HyperCorePrecompileSource.Token[](1); // token 0, no lending ledger
    }

    function _withHype() private returns (HyperCorePrecompileSource.Token[] memory tokens) {
        CoreRead.TokenInfo memory info;
        info.name = "HYPE";
        info.szDecimals = 2;
        info.weiDecimals = 8;
        VM.mockCall(address(0x080c), abi.encode(HYPE), abi.encode(info));
        VM.mockCall(
            address(0x080b), abi.encode(HYPE_PAIR), abi.encode(CoreRead.SpotInfo("@107", [uint64(HYPE), uint64(0)]))
        );
        tokens = new HyperCorePrecompileSource.Token[](2);
        tokens[1] = HyperCorePrecompileSource.Token(HYPE, HYPE_PAIR, false, false);
    }

    function _dexes(uint256 count) private pure returns (uint32[] memory dexes) {
        dexes = new uint32[](count);
        for (uint256 i; i < count; ++i) {
            dexes[i] = uint32(i);
        }
    }

    function _configure(bool enabled) private {
        source.configure(address(vault), _usdc(), _dexes(2), new address[](0), enabled);
    }

    /// @dev HYPE balance of the Vault and the HYPE/USDC market. Prices carry 6 decimals.
    function _hype(uint64 balance, uint64 price, uint64 bid, uint64 ask) private {
        VM.mockCall(
            address(0x0801), abi.encode(address(vault), uint64(HYPE)), abi.encode(balance, uint64(0), uint64(0))
        );
        VM.mockCall(address(0x0808), abi.encode(HYPE_PAIR), abi.encode(price));
        VM.mockCall(address(0x080e), abi.encode(uint32(10_000) + HYPE_PAIR), abi.encode(bid, ask));
    }

    /// @dev A token with 8 wei decimals, its pair against `quote`, and the Vault's balance of it.
    function _token(uint32 index, uint32 pair, uint32 quote, uint8 szDecimals, uint64 balance) private {
        CoreRead.TokenInfo memory info;
        info.name = "T";
        info.szDecimals = szDecimals;
        info.weiDecimals = 8;
        VM.mockCall(address(0x080c), abi.encode(index), abi.encode(info));
        VM.mockCall(
            address(0x080b), abi.encode(pair), abi.encode(CoreRead.SpotInfo("@", [uint64(index), uint64(quote)]))
        );
        VM.mockCall(
            address(0x0801), abi.encode(address(vault), uint64(index)), abi.encode(balance, uint64(0), uint64(0))
        );
    }

    function _book(uint32 pair, uint64 bid, uint64 ask) private {
        VM.mockCall(address(0x080e), abi.encode(uint32(10_000) + pair), abi.encode(bid, ask));
    }

    /// @dev HELD sells for 1 USDH, and USDH for 0.999 USDC. Its own USDC pair has a mark left over
    ///      and no bid.
    function _heldMarket(uint64 balance) private {
        _token(USDH, USDH_PAIR, 0, 2, 0);
        _token(HELD, HELD_USDH_PAIR, USDH, 0, balance);
        VM.mockCall(
            address(0x080b), abi.encode(HELD_USDC_PAIR), abi.encode(CoreRead.SpotInfo("@", [uint64(HELD), uint64(0)]))
        );
        _book(HELD_USDH_PAIR, 1e8, 0);
        _book(USDH_PAIR, 999_000, 1_001_000);
        _book(HELD_USDC_PAIR, 0, 0);
        VM.mockCall(address(0x0808), abi.encode(HELD_USDC_PAIR), abi.encode(uint64(1e8)));
    }

    function _withHeld() private pure returns (HyperCorePrecompileSource.Token[] memory tokens) {
        tokens = new HyperCorePrecompileSource.Token[](2);
        tokens[1] = HyperCorePrecompileSource.Token(HELD, HELD_USDC_PAIR, false, false);
    }

    /// @dev The watcher's proof of 100 HELD, sold through USDH.
    function _nameHeld() private {
        VM.prank(KEEPER);
        source.reportToken(address(vault), HELD, HELD_USDH_PAIR, true, USDH_PAIR);
    }

    function _usdh(uint64 balance) private {
        VM.mockCall(
            address(0x0801), abi.encode(address(vault), uint64(USDH)), abi.encode(balance, uint64(0), uint64(0))
        );
    }

    function _nameUsdh() private {
        VM.prank(KEEPER);
        source.reportToken(address(vault), USDH, USDH_PAIR, false, 0);
    }

    /// @dev Activated, scope registered, and a share price recorded half a window ago.
    function _activate() private {
        VM.mockCall(address(0x0810), abi.encode(address(vault)), abi.encode(true));
        _core(100e8, 0, 0);
        _block(coreBlock + 1);
        VM.prank(KEEPER);
        vault.finalizeActivation("");
        _configure(true);
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
    }

    /// @dev Activated, 100 USDC deposited by Alice, and all 200 USDC allocated to Core.
    function _allocated() private {
        _activate();
        _deposit(ALICE, 100e6);
        vault.depositToCore(100e6);
        _core(200e8, 0, 0);
        _sync();
    }

    function _sync() private {
        (uint256 id,,,,,) = vault.pendingAction();
        _block(coreBlock + 1);
        VM.prank(KEEPER);
        vault.syncCoreAction(id, "");
    }

    function _deposit(address user, uint256 amount) private returns (uint256 shares) {
        VM.startPrank(user);
        token.approve(address(vault), amount);
        shares = vault.deposit(amount, user);
        VM.stopPrank();
    }

    function _assets() private view returns (uint256 assets) {
        (assets,) = verifier.nav(address(vault));
    }

    /// @dev No entry path may price shares while the valuation reverts with `reason`.
    function _closed(bytes4 reason) private {
        _closed(abi.encodeWithSelector(reason));
    }

    function _closed(bytes memory reason) private {
        VM.expectRevert(reason);
        vault.totalAssets();
        require(vault.maxDeposit(BOB) == 0 && vault.maxMint(BOB) == 0, "open while unpriceable");
        VM.startPrank(BOB);
        token.approve(address(vault), 50e6);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.deposit(50e6, BOB);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.deposit(50e6, BOB, BOB);
        // 30e9 shares cost more than the minimum deposit at any price these tests reach.
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.mint(30e9, BOB);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.mint(30e9, BOB, BOB);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.depositWithLimit(50e6, BOB, 0, block.timestamp);
        VM.stopPrank();
    }

    /// @dev The calls `_closed` expects to fail all go through on an open Vault, at both ends of
    ///      the price range the tests use: none of its assertions passes for another reason.
    function testEveryEntryPathOfTheClosedHelperWorksOnAnOpenVault() public {
        _allocated();
        _core(100e8, 0, 0); // half the price
        _reprice();
        VM.startPrank(BOB);
        token.approve(address(vault), type(uint256).max);
        require(vault.deposit(50e6, BOB) != 0 && vault.deposit(50e6, BOB, BOB) != 0);
        require(vault.mint(30e9, BOB) >= 10e6 && vault.mint(30e9, BOB, BOB) >= 10e6);
        require(vault.depositWithLimit(50e6, BOB, 0, block.timestamp) != 0);
        VM.stopPrank();
        _core(500e8, 0, 0); // and above the recorded price
        VM.startPrank(BOB);
        require(vault.mint(30e9, BOB) <= 50e6 && vault.mint(30e9, BOB, BOB) <= 50e6);
        VM.stopPrank();
    }

    function testActivationNeedsALaterCoreBlockARegisteredScopeAndPriceHistory() public {
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.finalizeActivation("");
        VM.mockCall(address(0x0810), abi.encode(address(vault)), abi.encode(true));
        _core(100e8, 0, 0);
        _block(101);
        VM.prank(KEEPER);
        vault.finalizeActivation("");
        require(vault.coreActivated() && vault.phase() == ManagedUsdcVault.Phase.Ready);
        // Without a scope the Vault cannot be priced: deposits stay closed, NAV is not zero.
        require(vault.maxDeposit(ALICE) == 0);
        VM.expectRevert(HyperCorePrecompileSource.ScopeUnavailable.selector);
        vault.totalAssets();
        VM.prank(ALICE);
        VM.expectRevert(HyperCorePrecompileSource.Unauthorized.selector);
        source.configure(address(vault), _usdc(), new uint32[](0), new address[](0), true);
        _configure(true);
        // Valued now, but shares are not issued against a price nobody recorded before.
        require(_assets() == 100e6 && vault.maxDeposit(ALICE) == 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        vault.totalAssets();
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
        require(vault.totalAssets() == 100e6 && vault.maxDeposit(ALICE) == 1_000_000e6 - 100e6);
    }

    function testDepositsMintAtLiveNavWhileTheOwnerTrades() public {
        _activate();
        uint256 quoted = vault.previewDeposit(100e6);
        require(_deposit(ALICE, 100e6) == quoted && vault.totalAssets() == 200e6, "cash and Core counted once");

        // EVM -> Core: priced again only after a later Core block shows the credit.
        uint256 id = vault.depositToCore(100e6);
        require(vault.maxDeposit(BOB) == 0, "in-flight cash must not be priced as a loss");
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, "");
        _core(200e8, 0, 0);
        _sync();
        require(vault.totalAssets() == 200e6 && vault.availableCash() == 0);

        // Margin moved to two DEXes and a profit on the validator DEX: 150 + 60 + 10 = 220.
        _core(150e8, 60e6, 10e6);
        require(vault.totalAssets() == 220e6);
        uint256 aliceValue = vault.convertToAssets(vault.balanceOf(ALICE));
        uint256 bobShares = _deposit(BOB, 110e6);
        require(vault.totalAssets() == 330e6);
        uint256 bobValue = vault.convertToAssets(bobShares);
        require(bobValue <= 110e6 && bobValue >= 110e6 - 2, "entry at pre-deposit NAV");
        require(vault.convertToAssets(vault.balanceOf(ALICE)) >= aliceValue, "existing holder diluted");

        // A later loss is shared by everyone holding at that time. To the contract a loss and
        // value moved out of the scope look the same, so issuance pauses until the price settles.
        _core(150e8, 4e6, 0);
        require(_assets() == 264e6);
        _closed(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        _reprice();
        require(vault.totalAssets() == 264e6);
        require(vault.convertToAssets(bobShares) <= 88e6 && vault.convertToAssets(bobShares) >= 88e6 - 2);

        // Share-denominated and slippage-protected entries use the same live price.
        uint256 shares = vault.totalSupply() / 10;
        uint256 cost = vault.previewMint(shares);
        require(cost >= 26_400_000 && cost <= 26_400_001, "a tenth of the supply costs a tenth of the NAV");
        VM.startPrank(ALICE);
        token.approve(address(vault), cost + 50e6);
        require(vault.mint(shares, ALICE) == cost && vault.totalAssets() == 264e6 + cost);
        uint256 minShares = vault.previewDeposit(50e6);
        VM.expectRevert(ManagedUsdcVault.SlippageOrDeadline.selector);
        vault.depositWithLimit(50e6, ALICE, minShares + 1, block.timestamp);
        require(vault.depositWithLimit(50e6, ALICE, minShares, block.timestamp) == minShares);
        VM.stopPrank();
    }

    function testSpotHoldingIsPricedLiveAndAGuardedPriceClosesIssuance() public {
        _allocated();
        source.configure(address(vault), _withHype(), _dexes(2), new address[](0), true);

        // The owner buys 2 HYPE at the mark: a trade moves value between ledgers, not the NAV.
        _core(140e8, 0, 0);
        _hype(2e8, 30e6, 29_990_000, 30_010_000);
        require(vault.totalAssets() == 200e6);
        // HYPE trades at 45: holders have the gain before anyone can enter at the old price.
        _hype(2e8, 45e6, 44_990_000, 45_010_000);
        require(vault.totalAssets() == 230e6);
        uint256 bobShares = _deposit(BOB, 115e6);
        uint256 bobValue = vault.convertToAssets(bobShares);
        require(vault.totalAssets() == 345e6 && bobValue <= 115e6 && bobValue >= 115e6 - 2, "entry at the live price");

        // A wide book cannot price issuance: every entry path closes, nothing is mispriced.
        _hype(2e8, 45e6, 40e6, 45e6);
        _closed(HyperCorePrecompileSource.PriceGuard.selector);
        // A redemption request is never priced at request time, so it stays open.
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        _hype(2e8, 45e6, 44_990_000, 45_010_000);
        require(vault.totalAssets() == 345e6 && vault.maxDeposit(BOB) != 0, "reopens with a healthy book");
    }

    function testUnpriceableCoreStateClosesEveryEntryPathAndReopensWhenItClears() public {
        _activate();
        _deposit(ALICE, 100e6);
        // A DEX ledger in deficit has no claim on the other ledgers: it is not netted into a price.
        _core(100e8, 50e6, -10e6);
        _closed(HyperCorePrecompileSource.NegativeDexEquity.selector);
        // Core moved USDC into a lending ledger the registered scope does not count.
        _core(100e8, 0, 0);
        bytes memory ledger = abi.encode(address(vault), uint64(0));
        VM.mockCall(address(0x0811), ledger, abi.encode(uint64(0), uint64(0), uint64(1), uint64(1)));
        _closed(HyperCorePrecompileSource.ScopeIncomplete.selector);
        VM.mockCallRevert(address(0x0811), ledger, hex"dead");
        // A registered read fails: never read as an empty venue.
        VM.mockCallRevert(address(0x080f), abi.encode(uint32(1), address(vault)), hex"dead");
        _closed(abi.encodeWithSelector(CoreRead.ReadFailed.selector, address(0x080f)));
        _core(100e8, 0, 0);
        require(vault.totalAssets() == 200e6 && _deposit(BOB, 50e6) == vault.balanceOf(BOB));
    }

    function testScopeIsWhatTheOwnerRegisteredUntilSomeoneProvesOtherwise() public {
        _activate();
        _deposit(ALICE, 100e6);
        // A third party's Core transfer accrues to holders; it cannot mint or be withdrawn by them.
        _core(150e8, 0, 0);
        require(vault.totalAssets() == 250e6);
        uint256 shares = _deposit(BOB, 125e6);
        require(shares * 2 <= vault.totalSupply() - shares + 1_000, "donation priced in before the mint");
        source.setEnabled(address(vault), false);
        require(vault.maxDeposit(ALICE) == 0);
        VM.startPrank(ALICE);
        token.approve(address(vault), 50e6);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.deposit(50e6, ALICE);
        VM.stopPrank();
        // EVM USDC sent straight to the Vault stays outside the price as before.
        source.setEnabled(address(vault), true);
        uint256 beforeAssets = vault.totalAssets();
        token.mint(address(vault), 500e6);
        require(vault.totalAssets() == beforeAssets && vault.unaccountedUsdc() == 500e6);
        // The valuation cannot see a venue nobody registered: the ABI does not enumerate them.
        _margin(address(vault), 2, 70e6);
        require(vault.totalAssets() == beforeAssets, "an unregistered DEX is not counted");
        // But anyone can name it, and the contract reads it. Until the owner answers, no share is
        // issued and no exit settles.
        VM.prank(KEEPER);
        source.reportDex(address(vault), 2);
        _closed(HyperCorePrecompileSource.OpenReport.selector);
        // The owner registers it: the report is answered and the venue counted. Nobody can tell
        // whether that was all there was outside the scope, so the price history starts again.
        source.configure(address(vault), _usdc(), _dexes(3), new address[](0), true);
        require(source.reports(address(vault)).length == 0 && _assets() == beforeAssets + 70e6);
        _closed(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        _wait(1);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
        require(vault.totalAssets() == beforeAssets + 70e6 && vault.maxDeposit(BOB) != 0);
    }

    function testValueMovedOutOfTheScopeCannotBuyCheapShares() public {
        _allocated();
        // The owner moves half the Vault to a DEX the scope does not count. To the contract that
        // is a 50% loss: a deposit priced now would own half of what is really a 300 USDC Vault.
        _core(100e8, 0, 0);
        _margin(address(vault), 2, 100e6);
        require(_assets() == 100e6);
        _closed(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        // The pause gives a watcher time. The holding is provable, and once reported no amount of
        // waiting reopens issuance.
        VM.prank(KEEPER);
        source.reportDex(address(vault), 2);
        _wait(WINDOW + 1);
        // The history goes on meanwhile, at the price of what the scope counts. It opens nothing.
        uint256 low = verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
        _closed(HyperCorePrecompileSource.OpenReport.selector);
        VM.expectRevert(HyperCorePrecompileSource.ReportStands.selector);
        source.clearReport(address(vault), 0);
        // The owner brings the value back. Issuance resumes at the price of the whole Vault.
        _core(200e8, 0, 0);
        _margin(address(vault), 2, 0);
        source.clearReport(address(vault), 0);
        require(vault.totalAssets() == 200e6 && verifier.recordPrice(address(vault)) > low);
        uint256 value = vault.convertToAssets(_deposit(BOB, 100e6));
        require(vault.totalAssets() == 300e6 && value <= 100e6 && value >= 100e6 - 2, "priced on the whole Vault");
    }

    /// @dev Value that is outside the scope only in the blocks where a price is recorded: the
    ///      low records must not push the fair price out of the history.
    function testMomentaryExcursionsCannotOwnThePriceHistory() public {
        _allocated(); // t = 301. One record at t = 1 at the fair price. Founder 100 + Alice 100.
        uint256 fair = verifier.priceRecords(address(vault))[0].price;
        for (uint256 i; i < 5; ++i) {
            if (i != 0) _wait(WINDOW / 8 + 1); // the first second the next sample is allowed
            // One block with 100 of the 200 USDC on DEX 2, and the price recorded in it.
            _core(100e8, 0, 0);
            _margin(address(vault), 2, 100e6);
            uint256 low = verifier.recordPrice(address(vault));
            require(low * 2 <= fair + fair / 1e6 && low * 2 >= fair, "half the fair price");
            if (i == 4) {
                // t = 605: the fair record of t = 1 has left the window and the one of t = 301 is
                // half a window old. A deposit in this block would be priced against the history.
                _closed(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
            }
            _core(200e8, 0, 0);
            _margin(address(vault), 2, 0);
            // The block after, the value is back: nothing to report. But anyone restores the sample.
            VM.prank(KEEPER);
            VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
            source.reportDex(address(vault), 2);
            if (i != 4) {
                VM.prank(KEEPER);
                require(verifier.recordPrice(address(vault)) == fair);
            }
        }
        require(vault.convertToAssets(_deposit(BOB, 100e6)) >= 100e6 - 2, "issued at the price of the whole Vault");
    }

    /// @dev An exit pays out the cash it brought home: value left outside the scope would be
    ///      kept from the redeemer. Settlement waits like issuance, and a report holds it.
    function testAnExitDoesNotSettleRightAfterValueLeftTheScope() public {
        _allocated(); // 200 USDC on Core: founder 100, Alice 100
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        // The owner's agent moves 150 to DEX 2 (not in the scope); the owner recalls the other 50.
        _core(50e8, 0, 0);
        _margin(address(vault), 2, 150e6);
        vault.recallUsdcFromCore(SPOT, 50e6);
        _core(0, 0, 0);
        token.mint(address(vault), 50e6);
        _sync();
        vault.beginExit(epoch);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        vault.settleEpoch(epoch, ""); // 50 USDC for shares recorded at 200
        // The pause is the time a watcher needs. Once the holding is proven no waiting settles it.
        VM.prank(KEEPER);
        source.reportDex(address(vault), 2);
        _wait(WINDOW / 2 + 1);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault)); // the keeper keeps recording through the report
        _wait(WINDOW / 2);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        vault.settleEpoch(epoch, "");
        // The owner brings it home: the redeemer is paid from the whole Vault.
        _core(150e8, 0, 0);
        _margin(address(vault), 2, 0);
        vault.recallUsdcFromCore(SPOT, 150e6);
        _core(0, 0, 0);
        token.mint(address(vault), 150e6);
        _sync();
        VM.prank(KEEPER);
        vault.settleEpoch(epoch, "");
        uint256 beforeBalance = token.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.redeem(aliceShares, ALICE, ALICE);
        uint256 paid = token.balanceOf(ALICE) - beforeBalance;
        require(paid >= 100e6 - 2 && paid <= 100e6, "half of the 200 USDC Vault");
    }

    /// @dev The same pause without a report: a known limit, like the one for issuance below.
    function testWithoutAReportTheExitPauseOnlyBuysTime() public {
        _allocated();
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        _core(50e8, 0, 0);
        _margin(address(vault), 2, 150e6);
        vault.recallUsdcFromCore(SPOT, 50e6);
        _core(0, 0, 0);
        token.mint(address(vault), 50e6);
        _sync();
        vault.beginExit(epoch);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault)); // t = 301: the price of what is left in the scope
        _wait(WINDOW - WINDOW / 2); // t = 601: the record of t = 1 is exactly one window old
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        vault.settleEpoch(epoch, "");
        _wait(1);
        vault.settleEpoch(epoch, "");
        uint256 beforeBalance = token.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.redeem(aliceShares, ALICE, ALICE);
        uint256 paid = token.balanceOf(ALICE) - beforeBalance;
        require(paid >= 25e6 - 2 && paid <= 25e6, "nobody reported it: paid a quarter of her claim");
    }

    /// @dev The owner cannot empty the window to skip that pause. His deposit switch does not
    ///      stop the records, and where nothing was recorded an exit does not settle at all.
    function testAnExitDoesNotSettleWhereThePriceHistoryStopped() public {
        _allocated(); // t = 301, 200 USDC on Core: founder 100, Alice 100
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        source.setEnabled(address(vault), false); // "deposits paused"
        VM.prank(KEEPER);
        uint256 fair = verifier.recordPrice(address(vault)); // recorded all the same
        // Nobody records for a whole window. Then the value leaves the scope and the exit follows.
        _wait(WINDOW + 1);
        _core(50e8, 0, 0);
        _margin(address(vault), 2, 150e6);
        vault.recallUsdcFromCore(SPOT, 50e6);
        _core(0, 0, 0);
        token.mint(address(vault), 50e6);
        _sync();
        vault.beginExit(epoch);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        vault.settleEpoch(epoch, "");
        // The record that reopens it is made with the value already gone, and has to age half a
        // window: the time a watcher has to prove the holding.
        require(verifier.recordPrice(address(vault)) * 4 <= fair + fair / 1e6);
        _wait(WINDOW / 2 - 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        vault.settleEpoch(epoch, "");
        VM.prank(KEEPER);
        source.reportDex(address(vault), 2);
        _wait(WINDOW);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        vault.settleEpoch(epoch, "");
    }

    /// @dev The owner reports 10 USDC of his own to take the one place a report has: while it
    ///      stands, nobody can list the venue the real value went to. It buys him nothing. The
    ///      Vault stays closed, the keeper keeps recording, and lifting the report by registering
    ///      its venue, which needs no Core action and so no block in between, restarts the history.
    function testADecoyReportBuysNothingAndRegisteringItRestartsTheHistory() public {
        _allocated(); // t = 301. Fair record at t = 1. 200 USDC on Core.
        uint256 fair = verifier.priceRecords(address(vault))[0].price;
        _margin(address(vault), 3, 10e6);
        VM.prank(BOB);
        source.reportDex(address(vault), 3);
        // The real move: 100 of the 200 USDC go to unregistered DEX 2.
        _core(100e8, 0, 0);
        _margin(address(vault), 2, 100e6);
        VM.prank(KEEPER);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(vault), 2);
        // The keeper is not silenced: for more than a window every record is the low price.
        for (uint256 i; i < 8; ++i) {
            _wait(WINDOW / 8 + 1);
            VM.prank(KEEPER);
            require(verifier.recordPrice(address(vault)) * 2 <= fair + fair / 1e6);
            _closed(HyperCorePrecompileSource.OpenReport.selector);
        }
        // The fair record has left the window. One call lifts the decoy: it used to open the
        // Vault for a deposit in the same block, at half the price.
        uint32[] memory dexes = new uint32[](3);
        (dexes[0], dexes[1], dexes[2]) = (0, 1, 3);
        source.configure(address(vault), _usdc(), dexes, new address[](0), true);
        require(source.reports(address(vault)).length == 0 && _assets() == 110e6);
        _closed(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        // The new history takes half a window, and the place is free: the watcher names DEX 2.
        _wait(1);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault));
        VM.prank(KEEPER);
        source.reportDex(address(vault), 2);
        _wait(WINDOW / 2);
        _closed(HyperCorePrecompileSource.OpenReport.selector);
    }

    /// @dev What is left, pinned as a limit: a report closes the Vault only while its venue holds
    ///      what was proven. An owner who empties the reported venue on Core, and gets his deposit
    ///      into the first block that shows it empty ahead of the watcher's next report, buys
    ///      cheap shares.
    function testEmptyingTheReportedVenueIsARaceTheWatcherHasToWin() public {
        _allocated();
        _margin(address(vault), 3, 10e6); // the owner's decoy holds the place
        VM.prank(BOB);
        source.reportDex(address(vault), 3);
        _core(100e8, 0, 0);
        _margin(address(vault), 2, 100e6); // 100 of 200 USDC outside the scope
        for (uint256 i; i < 8; ++i) {
            _wait(WINDOW / 8 + 1);
            VM.prank(KEEPER);
            verifier.recordPrice(address(vault)); // low records; the fair one leaves the window
        }
        _closed(HyperCorePrecompileSource.OpenReport.selector);
        // The decoy's 10 USDC go back to spot on Core. In the first block that shows it, the
        // owner's deposit is ahead of the watcher's report of DEX 2.
        _core(110e8, 0, 0);
        _margin(address(vault), 3, 0);
        uint256 shares = _deposit(BOB, 100e6);
        VM.prank(KEEPER);
        source.reportDex(address(vault), 2); // too late by one transaction
        _core(210e8, 0, 0);
        _margin(address(vault), 2, 0);
        uint256 value = vault.convertToAssets(shares);
        require(value >= 147e6 && value <= 148e6, "100 USDC bought 147.6 of a 310 USDC Vault");
    }

    /// @dev A registered token counts in an exit only for what its USDC pair bids. While nobody
    ///      could report a registered token, the owner could hide value in a token that sells on
    ///      another pair, keep the watcher out with a report on a holding of his own, and then
    ///      register the hidden token on a pair without a bid: beyond any report and counted as
    ///      nothing. A registered token now stays reportable for as long as the scope counts
    ///      nothing for it.
    function testAHiddenTokenCannotBeRegisteredOutOfReachBehindADecoy() public {
        _allocated(); // t = 301: founder 100 + Alice 100, 200 USDC on Core
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        // The decoy: one lot of JUNK and a 10 USDC bid for it from another account of the owner's.
        _token(JUNK, JUNK_PAIR, 0, 0, 1e8);
        _book(JUNK_PAIR, 10e8, 0);
        source.reportToken(address(vault), JUNK, JUNK_PAIR, false, 0);
        // 100 USDC become 100 HELD on its USDH pair. The other 100 come home and the exit begins.
        _heldMarket(100e8);
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        // The watcher can prove the holding, but the place is taken. The records are the low price.
        for (uint256 i; i < 8; ++i) {
            VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
            _nameHeld();
            VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
            vault.settleEpoch(epoch, "");
            _wait(WINDOW / 8 + 1);
            VM.prank(KEEPER);
            verifier.recordPrice(address(vault));
        }
        // HELD joins the scope on its USDC pair. No report is answered and the history stays.
        source.configure(address(vault), _withHeld(), _dexes(2), new address[](0), true);
        require(source.reportAnsweredAt(address(vault)) == 0 && source.reports(address(vault))[0].id == JUNK);
        // The bid for JUNK is cancelled. This is where the exit used to settle, paying Alice 50
        // of her 100, with nothing the watcher could name. Now it names HELD, registered or not.
        _wait(1);
        _book(JUNK_PAIR, 0, 0);
        _nameHeld();
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        vault.settleEpoch(epoch, "");
        // A USDC bid for HELD makes the scope count it: the report no longer stands, and the
        // exit is not flat. Counted or reportable, the holding has to come home either way.
        _book(HELD_USDC_PAIR, 1e8, 0);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        _nameHeld();
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        vault.settleEpoch(epoch, "");
    }

    /// @dev The same without a decoy: the token is registered while empty, the value waits in
    ///      another token outside the scope while the low prices are recorded under the watcher's
    ///      own report, and is then sold into the registered token. That report has nothing left
    ///      to stand on, and no price can be recorded any more. The watcher still has to be first
    ///      in that block, as in `testEmptyingTheReportedVenueIsARaceTheWatcherHasToWin`, but it
    ///      has something to name.
    function testATokenRegisteredEmptyAndFilledLaterCanStillBeNamed() public {
        _allocated(); // t = 301
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        _heldMarket(0);
        source.configure(address(vault), _withHeld(), _dexes(2), new address[](0), true);
        // 100 USDC become 100 USDH, which the scope does not count. The watcher names them.
        _usdh(100e8);
        _nameUsdh();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        for (uint256 i; i < 8; ++i) {
            _nameUsdh(); // renewed
            VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
            vault.settleEpoch(epoch, "");
            _wait(WINDOW / 8 + 1);
            VM.prank(KEEPER);
            verifier.recordPrice(address(vault)); // the low price
        }
        // The 100 USDH are sold for 100 HELD.
        _wait(1);
        _usdh(0);
        _heldMarket(100e8);
        VM.prank(KEEPER);
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportToken(address(vault), USDH, USDH_PAIR, false, 0);
        VM.prank(KEEPER);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        verifier.recordPrice(address(vault));
        // The exit used to settle here on the low records, paying Alice 50 of her 100.
        _nameHeld();
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        vault.settleEpoch(epoch, "");
        require(source.reportAnsweredAt(address(vault)) == 0);
    }

    /// @dev A recall Core cannot serve stays pending until the owner gives up on it and waits. If
    ///      that stopped the records, the fair ones would leave the window while the value never
    ///      left the scope, and a single block with the value outside would set the new price.
    function testAnUnservedRecallDoesNotStopThePriceRecords() public {
        _allocated(); // 200 USDC on Core: founder 100, Alice 100
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        VM.prank(KEEPER);
        uint256 fair = verifier.recordPrice(address(vault));
        vault.beginExit(epoch);
        uint256 unserved = vault.recallUsdcFromCore(SPOT, 1_000_000e6); // Core holds nothing like it
        _block(coreBlock + 1);
        verifier.abandonRecall(address(vault), unserved);
        // More than a window passes with the recall pending. The keeper records all the same.
        for (uint256 i; i < 9; ++i) {
            _wait(WINDOW / 8 + 1);
            VM.prank(KEEPER);
            require(verifier.recordPrice(address(vault)) == fair);
        }
        // The owner's block: 150 USDC are on DEX 2, the recall is closed as failed, 50 come home.
        _core(50e8, 0, 0);
        _margin(address(vault), 2, 150e6);
        _block(coreBlock + RECALL_TIMEOUT);
        _sync();
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceRecordTooSoon.selector);
        verifier.recordPrice(address(vault)); // his low price does not replace the keeper's sample
        vault.recallUsdcFromCore(SPOT, 50e6);
        _core(0, 0, 0);
        token.mint(address(vault), 50e6);
        _sync();
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        vault.settleEpoch(epoch, ""); // 50 USDC for shares recorded at 200, all window long
    }

    /// @dev Without shares no price can be recorded in any phase. A management action in such a
    ///      Vault leaves Idle, and the exit that brings it back pays nobody: it needs no history.
    function testAnEmptyVaultThatLeftIdleComesBack() public {
        _activate(); // founder only: 100e9 shares, 100 USDC on Core
        vault.requestRedeem(100e9, address(this), address(this));
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        vault.settleEpoch(epoch, "");
        require(vault.totalSupply() == 0 && vault.phase() == ManagedUsdcVault.Phase.Idle);
        // Before anyone deposits, the owner registers an API wallet: the Vault is Active and empty.
        vault.setApiWallet(address(0xA6E17));
        _sync();
        require(vault.phase() == ManagedUsdcVault.Phase.Active);
        // Once the last period's records have left the window there is no price history, and
        // none can be made: no deposit, in a phase that only an exit leaves.
        _wait(WINDOW + 1);
        VM.prank(KEEPER);
        VM.expectRevert(ManagedPortfolioNavVerifier.NoShares.selector);
        verifier.recordPrice(address(vault));
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        vault.totalAssets();
        require(vault.maxDeposit(ALICE) == 0);
        // The way back to the only phase that takes the next deposit.
        vault.revokeApiWallet();
        _sync();
        epoch = vault.activeEpochId();
        vault.beginExit(epoch);
        VM.prank(KEEPER);
        vault.settleEpoch(epoch, "");
        require(vault.phase() == ManagedUsdcVault.Phase.Idle);
        require(_deposit(ALICE, 100e6) == 100e9 && vault.totalAssets() == 100e6);
    }

    /// @dev A remainder nobody can sell is valued in the records but not paid out by an exit. In
    ///      a small Vault that alone can be more than the limit: the exit then waits for as long
    ///      as the token stays registered, and one window after the owner drops it.
    function testAnUnsellableRemainderDelaysASmallExitUntilItLeavesTheScope() public {
        _activate(); // founder only: 100 USDC on Core. Record at t = 1, now t = 301.
        _hype(0, 30e6, 29_990_000, 30_010_000);
        source.configure(address(vault), _withHype(), _dexes(2), new address[](0), true);
        // A stranger sends 0.33 HYPE: 9.90 USDC at the mark, less than Core lets anyone sell.
        _hype(33e6, 30e6, 29_990_000, 30_010_000);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault));
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        for (uint256 i; i < 6; ++i) {
            VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
            vault.settleEpoch(epoch, "");
            _wait(WINDOW / 4);
            VM.prank(KEEPER);
            verifier.recordPrice(address(vault));
        }
        source.configure(address(vault), _usdc(), _dexes(2), new address[](0), true);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        vault.settleEpoch(epoch, "");
        _wait(WINDOW / 2);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault)); // the cash alone from here on
        _wait(WINDOW / 2 + 1);
        vault.settleEpoch(epoch, "");
    }

    /// @dev With no share outstanding there is no price: nothing recorded then may close the
    ///      next period.
    function testAFullyRedeemedVaultRecordsNoPriceAndReopensCleanly() public {
        _activate(); // founder only: 100e9 shares, 100 USDC on Core
        vault.requestRedeem(100e9, address(this), address(this));
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 99_950_000);
        _core(5_000_000, 0, 0); // 0.05 USDC of dust stays on Core, inside the 0.1 USDC limit
        token.mint(address(vault), 99_950_000);
        _sync();
        vault.beginExit(epoch);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault)); // in an exit a price can still be recorded
        vault.settleEpoch(epoch, "");
        require(vault.totalSupply() == 0 && vault.phase() == ManagedUsdcVault.Phase.Idle);
        _wait(WINDOW / 8 + 1);
        VM.prank(BOB);
        VM.expectRevert(ManagedPortfolioNavVerifier.NoShares.selector);
        verifier.recordPrice(address(vault));
        // Next period: Alice enters at the Idle cash price, the owner allocates to Core.
        _deposit(ALICE, 100e6);
        VM.prank(BOB);
        verifier.recordPrice(address(vault)); // with shares again, also while Idle
        vault.depositToCore(100e6);
        _core(100e8 + 5_000_000, 0, 0);
        _sync();
        require(vault.phase() == ManagedUsdcVault.Phase.Active && vault.totalAssets() == 100_050_000);
        require(vault.maxDeposit(BOB) != 0, "the new period starts open");
    }

    /// @dev One share unit left behind over the dust an exit may leave on Core would be a price
    ///      tens of thousands of times the fair one. An Idle Vault records what it issues at.
    function testDustLeftOnCoreIsNotInTheIdlePrice() public {
        _activate(); // founder only: 100e9 shares, 100 USDC on Core
        uint256 fair = verifier.priceRecords(address(vault))[0].price;
        vault.requestRedeem(100e9 - 1, address(this), address(this));
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 99_950_000);
        _core(5_000_000, 0, 0); // 0.05 USDC of dust stays on Core, inside the 0.1 USDC limit
        token.mint(address(vault), 99_950_000);
        _sync();
        vault.beginExit(epoch);
        vault.settleEpoch(epoch, "");
        require(vault.totalSupply() == 1 && vault.phase() == ManagedUsdcVault.Phase.Idle);
        VM.prank(BOB);
        uint256 idle = verifier.recordPrice(address(vault));
        require(idle == (vault.totalAssets() + 1) * 1e30 / 1001 && idle <= 2 * fair, "the Vault's own ratio");
        // Next period: Alice enters at that ratio and the owner allocates. Nothing is closed.
        _deposit(ALICE, 100e6);
        vault.depositToCore(100e6);
        _core(100e8 + 5_000_000, 0, 0);
        _sync();
        require(vault.phase() == ManagedUsdcVault.Phase.Active && vault.maxDeposit(BOB) != 0);
        require(_deposit(BOB, 50e6) != 0);
    }

    /// @dev A known limit, pinned so that it is not mistaken for a guarantee.
    function testWithoutAReportTheDrawdownPauseOnlyBuysTime() public {
        _allocated();
        _core(100e8, 0, 0);
        _margin(address(vault), 2, 100e6);
        _closed(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        // Nobody reports the holding. When the old price has left the window the lower one becomes
        // the record, and shares are issued against half of what the Vault really holds.
        _reprice();
        uint256 shares = _deposit(BOB, 100e6);
        _core(200e8, 0, 0);
        _margin(address(vault), 2, 0);
        uint256 value = vault.convertToAssets(shares);
        require(value >= 150e6 - 10 && value <= 150e6, "100 USDC bought half of a 300 USDC Vault");
    }

    function testRecallKeepsNavAndBooksOnlyArrivedUsdc() public {
        _activate();
        _deposit(ALICE, 100e6);
        vault.depositToCore(100e6);
        _core(150e8, 40e6, 10e6);
        _sync();
        uint256 beforeAssets = vault.totalAssets();
        require(beforeAssets == 200e6);

        uint256 id = vault.recallUsdcFromCore(SPOT, 150e6);
        _core(0, 40e6, 10e6); // Core debited; the EVM credit is queued for the next EVM block
        _block(coreBlock + 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, "");
        token.mint(address(vault), 150e6); // synthetic system transfer; not network evidence
        VM.prank(KEEPER);
        vault.syncCoreAction(id, "");
        require(vault.availableCash() == 150e6 && vault.totalAssets() == beforeAssets, "recall changed the NAV");

        // More USDC in the Vault than was recalled (a direct transfer): only the request is booked.
        _core(40e8, 0, 10e6);
        vault.recallUsdcFromCore(SPOT, 40e6);
        _core(0, 0, 10e6);
        token.mint(address(vault), 45e6);
        _sync();
        require(vault.availableCash() == 190e6 && vault.unaccountedUsdc() == 5e6);
        require(vault.totalAssets() == beforeAssets);
    }

    function testRejectedRecallClosesOnlyAfterTheOwnerGivesUpAndWaits() public {
        _activate();
        _deposit(ALICE, 100e6);
        // More than the Core spot balance: Core rejects it, debits nothing and sends nothing.
        uint64 submitted = coreBlock;
        uint256 id = vault.recallUsdcFromCore(SPOT, 400e6);
        require(vault.maxDeposit(BOB) == 0, "no issuance while the outcome is unknown");
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        verifier.abandonRecall(address(vault), id); // Core has not even processed it yet
        _block(submitted + 1);
        VM.prank(ALICE);
        VM.expectRevert(ManagedPortfolioNavVerifier.Unauthorized.selector);
        verifier.abandonRecall(address(vault), id);
        verifier.abandonRecall(address(vault), id);
        _block(submitted + 1 + RECALL_TIMEOUT);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, ""); // the waiting period protects USDC that is still in flight
        _block(submitted + 2 + RECALL_TIMEOUT);
        VM.prank(KEEPER);
        vault.syncCoreAction(id, "");
        (uint256 pending,,,,,) = vault.pendingAction();
        require(pending == 0 && vault.availableCash() == 100e6 && vault.totalAssets() == 200e6, "nothing changed");

        // The next recall is a new action. Time alone does not close it, the earlier decision does
        // not carry over, and a decision made long after submission still waits its full period.
        submitted = coreBlock;
        id = vault.recallUsdcFromCore(SPOT, 400e6);
        _block(submitted + RECALL_TIMEOUT + 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, "");
        verifier.abandonRecall(address(vault), id);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, "");
        _block(coreBlock + RECALL_TIMEOUT + 1);
        vault.syncCoreAction(id, "");
        require(vault.totalAssets() == 200e6);
    }

    function testShortAndLateRecallArrivalsAreBookedNotStranded() public {
        _allocated();
        // Hypothetical bridge shortfall: Core debits 150 and one unit less arrives.
        uint256 id = vault.recallUsdcFromCore(SPOT, 150e6);
        _core(50e8, 0, 0);
        token.mint(address(vault), 150e6 - 1);
        _block(coreBlock + 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, "");
        verifier.abandonRecall(address(vault), id);
        _block(coreBlock + RECALL_TIMEOUT + 1);
        vault.syncCoreAction(id, "");
        require(vault.availableCash() == 150e6 - 1 && vault.unaccountedUsdc() == 0);
        require(vault.totalAssets() == 200e6 - 1, "the shortfall is a visible loss, not stranded cash");

        // The owner gives up on a recall that Core did debit; its USDC lands afterwards.
        id = vault.recallUsdcFromCore(SPOT, 40e6);
        _core(10e8, 0, 0);
        _block(coreBlock + 1);
        verifier.abandonRecall(address(vault), id);
        _block(coreBlock + RECALL_TIMEOUT + 1);
        vault.syncCoreAction(id, "");
        require(_assets() == 160e6 - 1, "USDC in flight is in neither ledger");
        // A fifth of the Vault is missing from the price: no share is issued against it.
        _closed(ManagedPortfolioNavVerifier.PriceDropCooldown.selector);
        token.mint(address(vault), 40e6);
        require(vault.unaccountedUsdc() == 40e6 && _assets() == 160e6 - 1);
        // Only a recall books it, and only one Core rejects (here 40 against the 10 left on
        // Core): an executed recall would put new USDC in flight in its place.
        vault.recallUsdcFromCore(SPOT, 40e6);
        _sync();
        require(vault.unaccountedUsdc() == 0 && vault.totalAssets() == 200e6 - 1);
    }

    function testAgentRegistrationUsesTheSameFinalityRuleAndBlocksSettlement() public {
        _activate();
        address agent = address(0xA6E17);
        uint256 id = vault.setApiWallet(agent);
        require(vault.apiWallet() == address(0) && vault.maxDeposit(ALICE) == 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        vault.syncCoreAction(id, "");
        VM.expectRevert(ManagedPortfolioNavVerifier.UnknownAction.selector);
        verifier.abandonRecall(address(vault), id); // only a recall can be given up
        _sync();
        // Core gives no receipt: this means "submitted and a later Core block passed".
        require(vault.apiWallet() == agent && vault.totalAssets() == 100e6);
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        VM.expectRevert(ManagedUsdcVault.PendingCoreAction.selector);
        vault.settleEpoch(epoch, "");
        vault.revokeApiWallet();
        _sync();
        vault.settleEpoch(epoch, "");
        require(vault.apiWallet() == address(0) && vault.phase() == ManagedUsdcVault.Phase.Idle);
    }

    function testExitSettlesOnlyOnceTheRegisteredScopeIsFlat() public {
        _allocated();
        _core(120e8, 110e6, 0); // 30 USDC profit, 110 held as perp equity
        uint256 aliceShares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        uint256 epoch = vault.activeEpochId();
        vault.beginExit(epoch);
        require(vault.maxDeposit(BOB) == 0);

        vault.recallUsdcFromCore(SPOT, 120e6);
        _core(0, 110e6, 0);
        token.mint(address(vault), 120e6);
        _sync();
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        vault.settleEpoch(epoch, "");

        // The owner closes the position and brings the rest home; 0.05 USDC of dust remains.
        _core(110e8, 0, 0);
        vault.recallUsdcFromCore(SPOT, 109_950_000);
        _core(5_000_000, 0, 0);
        token.mint(address(vault), 109_950_000);
        _sync();
        // A deficit left on a DEX is a liability, even with no position and spot dust that covers it.
        _core(5_000_000, 0, -1);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        vault.settleEpoch(epoch, "");
        _core(5_000_000, 0, 0);
        VM.prank(KEEPER);
        vault.settleEpoch(epoch, "");
        require(vault.phase() == ManagedUsdcVault.Phase.Idle && vault.totalAssets() == vault.availableCash());

        uint256 beforeBalance = token.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.redeem(aliceShares, ALICE, ALICE);
        uint256 paid = token.balanceOf(ALICE) - beforeBalance;
        // Half of 229.95 realized, less a 10% fee on the gain over the 100 USDC basis.
        require(paid >= 113_470_000 && paid <= 113_480_000, "net claim");
    }

    function testAStrangersLotIsNothingAnExitHasToBringHome() public {
        _activate();
        _hype(0, 30e6, 29_990_000, 30_010_000);
        source.configure(address(vault), _withHype(), _dexes(2), new address[](0), true);
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        // HYPE worth more than the minimum order can be sold, so it has to be brought home.
        _hype(40e6, 30e6, 29_990_000, 30_010_000);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        vault.settleEpoch(epoch, "");
        // One lot (0.3 USDC) sent by anyone is below what Core lets the owner sell. Neither it
        // nor the state of the book counts as something left on Core.
        _hype(1e6, 30e6, 20e6, 40e6);
        VM.prank(KEEPER);
        vault.settleEpoch(epoch, "");
        require(vault.phase() == ManagedUsdcVault.Phase.Idle && vault.totalAssets() == 100e6);
    }

    /// @dev The exit valuation ignores the state of a book; the price records do not. While a
    ///      registered token's price is refused and the Vault holds a lot of it, nothing can be
    ///      recorded, and an exit that outlasts its recorded history waits for the owner: he
    ///      drops the token, which cannot be sold anyway, and the records go on without it.
    function testARefusedPriceStopsTheRecordsUntilTheOwnerDropsTheToken() public {
        _activate(); // record at t = 1, now t = 301
        _hype(0, 30e6, 29_990_000, 30_010_000);
        source.configure(address(vault), _withHype(), _dexes(2), new address[](0), true);
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        _hype(1e6, 30e6, 20e6, 40e6); // a stranger's lot, and a book too wide to price it
        VM.prank(KEEPER);
        VM.expectRevert(HyperCorePrecompileSource.PriceGuard.selector);
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2 + 1); // t = 602: the last record has left the window
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        vault.settleEpoch(epoch, "");
        source.configure(address(vault), _usdc(), _dexes(2), new address[](0), true);
        VM.prank(KEEPER);
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2 - 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        vault.settleEpoch(epoch, "");
        _wait(1);
        vault.settleEpoch(epoch, "");
        require(vault.phase() == ManagedUsdcVault.Phase.Idle && vault.totalAssets() == 100e6);
    }

    function testCoreTransferDuringAnExitMustBeRecalledBeforeSettlement() public {
        _activate();
        uint256 epoch = vault.activeEpochId();
        vault.recallUsdcFromCore(SPOT, 100e6);
        _core(0, 0, 0);
        token.mint(address(vault), 100e6);
        _sync();
        vault.beginExit(epoch);
        // Someone sends 1 USDC to the Vault's Core account: above the dust limit, so it is value
        // the exit must bring home rather than leave behind.
        _core(1e8, 0, 0);
        VM.expectRevert(ManagedPortfolioNavVerifier.CoreNotFlat.selector);
        vault.settleEpoch(epoch, "");
        vault.recallUsdcFromCore(SPOT, 1e6);
        _core(0, 0, 0);
        token.mint(address(vault), 1e6);
        _sync();
        vault.settleEpoch(epoch, "");
        require(vault.phase() == ManagedUsdcVault.Phase.Idle && vault.totalAssets() == 101e6, "accrues to holders");
    }

    function testTwoVaultsShareTheSourceAndVerifierWithoutSharingState() public {
        _activate();
        VM.startPrank(BOB);
        token.approve(address(factory), type(uint256).max);
        ManagedUsdcVault other = factory.createVaultAndFund(1e6);
        VM.stopPrank();
        VM.mockCall(address(0x0810), abi.encode(address(other)), abi.encode(true));
        _coreOf(address(other), 100e8, 0, 0);
        _block(coreBlock + 1);
        other.finalizeActivation("");
        // Each owner registers only their own Vault's scope: here Bob counts the validator DEX only.
        VM.expectRevert(HyperCorePrecompileSource.Unauthorized.selector);
        source.configure(address(other), _usdc(), _dexes(1), new address[](0), true);
        VM.prank(BOB);
        source.configure(address(other), _usdc(), _dexes(1), new address[](0), true);
        require(vault.maxDeposit(ALICE) != 0 && other.maxDeposit(ALICE) == 0, "price history is per Vault");
        verifier.recordPrice(address(other));
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
        _coreOf(address(other), 100e8, 25e6, 40e6);
        _core(100e8, 0, 7e6);
        require(other.totalAssets() == 125e6 && vault.totalAssets() == 107e6, "ledgers or scopes mixed");

        // A report closes the Vault it names. DEX 1 is outside Bob's scope and inside this one.
        VM.expectRevert(HyperCorePrecompileSource.NotReportable.selector);
        source.reportDex(address(vault), 1);
        VM.prank(KEEPER);
        source.reportDex(address(other), 1);
        VM.expectRevert(HyperCorePrecompileSource.OpenReport.selector);
        other.totalAssets();
        require(vault.totalAssets() == 107e6);
        VM.prank(BOB);
        source.configure(address(other), _usdc(), _dexes(2), new address[](0), true);
        // Answering the report restarts that Vault's price history, and only that Vault's.
        VM.expectRevert(ManagedPortfolioNavVerifier.PriceHistoryTooShort.selector);
        other.totalAssets();
        require(vault.totalAssets() == 107e6 && source.reportAnsweredAt(address(vault)) == 0);
        _wait(1);
        verifier.recordPrice(address(other));
        verifier.recordPrice(address(vault));
        _wait(WINDOW / 2);
        require(other.totalAssets() == 165e6 && vault.totalAssets() == 107e6);
        VM.prank(BOB);
        source.setEnabled(address(other), false);
        require(other.maxDeposit(ALICE) == 0 && vault.maxDeposit(ALICE) != 0, "one switch per Vault");

        // The same action id is pending in both Vaults; giving up is per Vault and per owner.
        uint256 id = vault.recallUsdcFromCore(SPOT, 400e6);
        VM.prank(BOB);
        require(other.recallUsdcFromCore(SPOT, 400e6) == id);
        _block(coreBlock + 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.Unauthorized.selector);
        verifier.abandonRecall(address(other), id);
        verifier.abandonRecall(address(vault), id);
        _block(coreBlock + RECALL_TIMEOUT + 1);
        VM.expectRevert(ManagedPortfolioNavVerifier.ActionNotFinal.selector);
        other.syncCoreAction(id, "");
        vault.syncCoreAction(id, "");
        (uint256 pending,,,,,) = vault.pendingAction();
        (uint256 otherPending,,,,,) = other.pendingAction();
        require(pending == 0 && otherPending == id);
    }
}
