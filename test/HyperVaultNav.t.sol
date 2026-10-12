// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ManagedUpgradeController} from "../src/managed/ManagedUpgradeController.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {HyperVault} from "../src/hypervault/HyperVault.sol";
import {HyperVaultTypes} from "../src/hypervault/HyperVaultTypes.sol";
import {HyperVaultShare} from "../src/hypervault/HyperVaultShare.sol";
import {HyperVaultAccountant, IHyperVaultPriceHistory} from "../src/hypervault/HyperVaultAccountant.sol";
import {HyperVaultNavSource} from "../src/hypervault/HyperVaultNavSource.sol";
import {HyperVaultNavVerifier} from "../src/hypervault/HyperVaultNavVerifier.sol";
import {HyperVaultLens} from "../src/hypervault/HyperVaultLens.sol";
import {HyperVaultCoreOps} from "../src/hypervault/HyperVaultCoreOps.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {ManagedTestUsdc, ManagedTestDepositWallet} from "./ManagedUsdcVault.t.sol";

interface VmNav {
    function warp(uint256) external;
    function mockCall(address, bytes calldata, bytes calldata) external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function prank(address) external;
    function expectEmit(bool, bool, bool, bool, address) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (VmLog[] memory);
}

struct VmLog {
    bytes32[] topics;
    bytes data;
    address emitter;
}

/// @dev HyperVault with the REAL verifier, source and accountant (no mock verifier). Only the raw
///      HyperCore precompile reads are synthetic fixtures; not a live bridge round trip.
contract HyperVaultNavTest {
    VmNav constant vm = VmNav(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ALICE = address(0xA11CE);
    address constant TREASURY = address(0xFEE);
    uint32 constant SPOT = type(uint32).max;
    ManagedTestUsdc usd;
    ManagedTestDepositWallet circle;
    HyperVaultNavSource source;
    HyperVaultNavVerifier verifier;
    HyperVaultAccountant accountant;
    HyperVaultShare share;
    HyperVault v;
    uint64 coreBlock = 100;

    function setUp() public {
        vm.warp(1_000_000);
        usd = new ManagedTestUsdc();
        circle = new ManagedTestDepositWallet(usd);
        CoreRead.TokenInfo memory info;
        info.evmContract = address(circle);
        info.szDecimals = 8;
        info.weiDecimals = 8;
        info.evmExtraWeiDecimals = -2;
        vm.mockCall(address(0x080c), abi.encode(uint32(0)), abi.encode(info));
        vm.mockCall(address(0x0810), bytes(""), abi.encode(true));
        _block();
        ManagedAssetBridge bridge =
            new ManagedAssetBridge(address(usd), address(usd), address(circle), ManagedAssetBridge.Kind.Usdc, 0, 0);
        source = new HyperVaultNavSource(address(usd), address(circle), 0);
        verifier = new HyperVaultNavVerifier(bridge, source, 10_000, 2e6, 10 minutes);
        accountant = new HyperVaultAccountant(IHyperVaultPriceHistory(address(verifier)));
        share = new HyperVaultShare("HyperVault USDC", "hvUSDC", 9);
        HyperVaultTypes.Config memory c;
        c.asset = address(usd);
        c.share = address(share);
        c.accountant = address(accountant);
        c.bridge = address(bridge);
        c.owner = address(this);
        c.treasury = TREASURY;
        c.coreWriter = address(new MockCoreWriter());
        c.verifier = address(verifier);
        c.upgradeController = address(new ManagedUpgradeController(address(this)));
        c.performanceFeeBps = 1000;
        c.minimumDeposit = 1e6;
        c.activationCost = 1e6;
        c.maximumAssets = 10_000e6;
        c.chainId = block.chainid;
        HyperVault implementation = new HyperVault(c);
        v = HyperVault(
            payable(address(new TransparentUpgradeableProxy(address(implementation), c.upgradeController, "")))
        );
        ManagedUpgradeController(c.upgradeController).bind(address(v), address(implementation));
        share.bind(address(v));
        _core(0);
        HyperVaultNavSource.Token[] memory tokens = new HyperVaultNavSource.Token[](1);
        tokens[0] = HyperVaultNavSource.Token(0, 0, true, false, false, 0);
        source.configure(address(v), tokens, new uint32[](0), new address[](0), true);
        usd.mint(address(this), 1_000e6);
        usd.mint(ALICE, 1_000e6);
        usd.approve(address(v), type(uint256).max);
        vm.prank(ALICE);
        usd.approve(address(v), type(uint256).max);
        v.bootstrap(100e6);
    }

    function _block() private {
        vm.mockCall(address(0x0809), bytes(""), abi.encode(coreBlock));
    }

    /// The Vault's Core USDC spot balance, in USDC6 (Core keeps 8 decimals).
    function _core(uint256 usdc6) private {
        vm.mockCall(
            address(0x0801), abi.encode(address(v), uint64(0)), abi.encode(uint64(usdc6 * 100), uint64(0), uint64(0))
        );
        vm.mockCall(
            address(0x0811),
            abi.encode(address(v), uint64(0)),
            abi.encode(CoreRead.UserLending(CoreRead.BasisAndValue(0, 0), CoreRead.BasisAndValue(0, 0)))
        );
    }

    function _sync() private {
        (uint256 id, bytes32 hash,,,,) = v.pendingAction();
        ++coreBlock;
        _block();
        v.syncCoreAction(id, "");
        hash;
    }

    function _allocate(uint256 amount) private {
        v.queueCoreAllocation(amount);
        v.executeCoreAllocation();
        _core(amount);
        _sync();
    }

    function testNoHistoryNeededAndNoDrawdownWait() public {
        _allocate(100e6);
        (uint256 nav,) = v.liveNav();
        require(nav == 100e6, "live NAV without any price record");
        vm.prank(ALICE);
        require(v.deposit(10e6, ALICE) == 10e9, "Active deposit without history");
        // A 50% loss right after a record: deposits stay open (no drawdown wait).
        verifier.recordPrice(address(v));
        _core(50e6);
        require(v.maxDeposit(ALICE) > 0, "no drawdown wait");
        vm.prank(ALICE);
        uint256 shares = v.deposit(10e6, ALICE);
        require(shares > 18e9, "priced at the fallen NAV");
    }

    function testExitSettlesAtCashWhateverTheRecords() public {
        _allocate(100e6);
        verifier.recordPrice(address(v));
        v.requestRedeem(100e9, address(this), address(this));
        v.beginExit(v.activeEpochId());
        v.recallFromCore(SPOT, 60e6);
        usd.mint(address(v), 60e6); // only 60 came home
        _core(0);
        _sync();
        v.settleEpoch(v.activeEpochId(), "");
        require(v.maxWithdraw(address(this)) == 60e6, "settled at cash, no drawdown wait");
    }

    function testExitStillNeedsAFlatCore() public {
        _allocate(100e6);
        // The exit valuation prices spot at what it could be sold for: the best bid.
        vm.mockCall(
            address(0x080e), abi.encode(uint32(10_000 + HYPE_PAIR)), abi.encode(uint64(499_900), uint64(500_100))
        );
        v.requestRedeem(100e9, address(this), address(this));
        uint256 epoch = v.activeEpochId();
        v.beginExit(epoch);
        vm.expectRevert(HyperVaultNavVerifier.CoreNotFlat.selector);
        v.settleEpoch(epoch, "");
    }

    function testRealVerifierFeeAtWindowLowThenCaughtUp() public {
        _allocate(100e6);
        verifier.recordPrice(address(v)); // 1.00
        _core(110e6); // +10%
        v.checkpoint();
        require(share.balanceOf(TREASURY) == 0, "fee waits for the window");
        require(v.maxDeposit(ALICE) == 0, "deposits wait while the fee lags");
        vm.warp(block.timestamp + 11 minutes); // the 1.00 record leaves the window
        verifier.recordPrice(address(v)); // 1.10
        v.checkpoint();
        uint256 fee = share.balanceOf(address(this)) + share.balanceOf(TREASURY) - 100e9;
        (uint256 nav,) = v.liveNav();
        uint256 value = fee * (nav + 1) / (v.totalSupply() + 1000);
        require(value > 0.999e6 && value <= 1e6, "10% of the 10 USDC gain");
        require(v.maxDeposit(ALICE) > 0, "deposits open again");
    }

    function testCoreReadFailureNeverBecomesZero() public {
        _allocate(100e6);
        vm.mockCallRevert(address(0x0801), abi.encode(address(v), uint64(0)), hex"dead");
        vm.expectRevert();
        v.liveNav();
        require(v.maxDeposit(ALICE) == 0, "closed, not priced at zero");
        require(v.convertToAssets(1e9) == 1e6, "rate view still answers");
    }
    // ------------------------------------------------------------------ perp-oracle valuation (ADR-040)

    uint32 constant HYPE = 150;
    uint32 constant HYPE_PAIR = 107;
    uint32 constant HYPE_PERP = 159;

    /// Registers USDC + HYPE (perp-oracle priced) + DEX 0, with HYPE metadata like mainnet:
    /// spot wei 8 / sz 2, perp sz 2 (prices with 4 decimals).
    function _oracleScope() private {
        CoreRead.TokenInfo memory hype;
        hype.name = "HYPE";
        hype.evmContract = address(0x5555);
        hype.szDecimals = 2;
        hype.weiDecimals = 8;
        vm.mockCall(address(0x080c), abi.encode(HYPE), abi.encode(hype));
        uint64[2] memory pair = [uint64(HYPE), uint64(0)];
        vm.mockCall(address(0x080b), abi.encode(HYPE_PAIR), abi.encode(CoreRead.SpotInfo("@107", pair)));
        vm.mockCall(
            address(0x080a), abi.encode(HYPE_PERP), abi.encode(CoreRead.PerpAssetInfo("HYPE", 52, 2, 10, false))
        );
        // HYPE is not lent: the probe answers with an empty ledger.
        vm.mockCall(
            address(0x0811),
            abi.encode(address(v), uint64(HYPE)),
            abi.encode(CoreRead.UserLending(CoreRead.BasisAndValue(0, 0), CoreRead.BasisAndValue(0, 0)))
        );
        _hedge(100e6, 0, 0, 0, 500_000, 500_000);
        HyperVaultNavSource.Token[] memory tokens = new HyperVaultNavSource.Token[](2);
        tokens[0] = HyperVaultNavSource.Token(0, 0, true, false, false, 0);
        tokens[1] = HyperVaultNavSource.Token(HYPE, HYPE_PAIR, false, false, true, HYPE_PERP);
        uint32[] memory dexes = new uint32[](1);
        source.configure(address(v), tokens, dexes, new address[](0), true);
    }

    /// Core state: spot USDC (USDC6), spot HYPE (wei), short size (szDecimals 2), DEX 0 raw USD,
    /// and perp oracle / mark (4 decimals). accountValue = rawUsd + szi x mark, as Core reports it.
    function _hedge(uint256 usdc6, uint64 hypeWei, int64 szi, int64 rawUsd6, uint64 oracle, uint64 mark) private {
        _core(usdc6);
        vm.mockCall(address(0x0801), abi.encode(address(v), uint64(HYPE)), abi.encode(hypeWei, uint64(0), uint64(0)));
        CoreRead.Position memory p;
        p.szi = szi;
        vm.mockCall(address(0x0813), abi.encode(address(v), HYPE_PERP), abi.encode(p));
        vm.mockCall(address(0x0807), abi.encode(HYPE_PERP), abi.encode(oracle));
        vm.mockCall(address(0x0806), abi.encode(HYPE_PERP), abi.encode(mark));
        int64 value = rawUsd6 + szi * int64(mark);
        uint64 ntl = uint64(szi < 0 ? -szi : szi) * mark;
        vm.mockCall(
            address(0x080f),
            abi.encode(uint32(0), address(v)),
            abi.encode(CoreRead.AccountMarginSummary(value, 0, ntl, rawUsd6))
        );
    }

    /// 100 USDC on Core: 25 spot USDC, 1 HYPE bought at 50, 1 HYPE short at 50 with 25 margin
    /// (raw USD 75 = margin + short proceeds). NAV 100 whatever the books say.
    function _hedged(uint64 oracle, uint64 mark) private {
        _hedge(25e6, 1e8, -100, 75e6, oracle, mark);
    }

    function testOracleNavIgnoresTheSpotBookAndThePerpMark() public {
        _allocate(100e6);
        _oracleScope();
        _hedged(500_000, 500_000);
        require(_nav() == 100e6, "hedged pair at the oracle");
        // No spot price or book is mocked: the valuation never reads them.
        _hedged(500_000, 550_000); // mark 10% above the oracle
        require(_nav() == 100e6, "a mark spike does not move NAV");
        _hedged(500_000, 450_000);
        require(_nav() == 100e6, "nor a mark dip");
    }

    function testOracleMoveNetsOutAcrossTheHedgedPair() public {
        _allocate(100e6);
        _oracleScope();
        _hedged(600_000, 600_000); // HYPE +20%: spot +10, short -10
        require(_nav() == 100e6, "delta neutral at one price");
        _hedged(600_000, 500_000); // oracle moved, mark lagging
        require(_nav() == 100e6, "still one price for both legs");
    }

    function testRedeemNowWithoutAnyPriceRecord() public {
        vm.prank(ALICE);
        v.deposit(20e6, ALICE); // Idle: 120 cash
        _allocate(100e6); // 20 stays as the buffer
        _oracleScope();
        _hedged(500_000, 560_000);
        require(accountant.windowLow(address(v)) == type(uint256).max, "no record");
        uint256 before = usd.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 assets = v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp);
        require(assets > 9.989e6 && assets <= 9.99e6, "price 1.0 at the oracle (mark ignored), less 0.1%");
        require(usd.balanceOf(ALICE) - before == assets, "paid at once");
    }

    function testOracleScopeChecks() public {
        _allocate(100e6);
        _oracleScope();
        HyperVaultNavSource.Token[] memory tokens = new HyperVaultNavSource.Token[](2);
        tokens[0] = HyperVaultNavSource.Token(0, 0, true, false, false, 0);
        tokens[1] = HyperVaultNavSource.Token(HYPE, HYPE_PAIR, false, false, true, HYPE_PERP);
        vm.expectRevert(HyperVaultNavSource.InvalidConfiguration.selector);
        source.configure(address(v), tokens, new uint32[](0), new address[](0), true); // DEX 0 not counted
        tokens[1].reservePrice = true;
        vm.expectRevert(HyperVaultNavSource.InvalidConfiguration.selector);
        source.configure(address(v), tokens, new uint32[](1), new address[](0), true); // two price modes
        tokens[1].reservePrice = false;
        vm.mockCall(address(0x0807), abi.encode(HYPE_PERP), abi.encode(uint64(0)));
        vm.expectRevert(HyperVaultNavSource.InvalidObservation.selector);
        source.configure(address(v), tokens, new uint32[](1), new address[](0), true); // no oracle
    }

    function _nav() private view returns (uint256 a) {
        (a,) = v.liveNav();
        a -= v.availableCash();
    }

    function testOracleOnlyGatesTheRecordlessExit() public {
        vm.prank(ALICE);
        v.deposit(20e6, ALICE);
        _allocate(100e6);
        require(!verifier.oracleOnly(address(v)), "USDC-only scope without DEX 0 is not oracle-only");
        _oracleScope();
        _hedged(500_000, 500_000);
        require(verifier.oracleOnly(address(v)), "hedged HYPE at the oracle, DEX 0 alone");
        // Another position on DEX 0 (its notional is not the revalued perp's): back to records.
        vm.mockCall(
            address(0x080f),
            abi.encode(uint32(0), address(v)),
            abi.encode(CoreRead.AccountMarginSummary(25e6, 0, 100 * 500_000 + 1e6, 75e6))
        );
        require(!verifier.oracleOnly(address(v)), "an unregistered mark-priced position");
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.NavUnavailable.selector);
        v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp);
    }

    function testIsolatedLegFailsClosed() public {
        _allocate(100e6);
        _oracleScope();
        _hedged(500_000, 500_000);
        CoreRead.Position memory p;
        p.szi = -100;
        p.isIsolated = true;
        vm.mockCall(address(0x0813), abi.encode(address(v), HYPE_PERP), abi.encode(p));
        vm.expectRevert();
        v.liveNav();
    }

    function testUnhedgedDeltaFollowsTheOracleOnly() public {
        _allocate(100e6);
        _oracleScope();
        _hedge(25e6, 2e8, -100, 125e6, 500_000, 500_000); // 2 HYPE spot, 1 short: +1 HYPE delta
        uint256 base = _nav();
        _hedge(25e6, 2e8, -100, 125e6, 550_000, 500_000); // oracle +10%, mark still
        require(_nav() == base + 5e6, "the open HYPE moves with the oracle, not the mark");
    }

    function testOpenShortIsNotFlatForAnExit() public {
        _allocate(100e6);
        _oracleScope();
        _hedged(500_000, 500_000);
        // The exit valuation prices spot at what it could be sold for: the best bid.
        vm.mockCall(
            address(0x080e), abi.encode(uint32(10_000 + HYPE_PAIR)), abi.encode(uint64(499_900), uint64(500_100))
        );
        v.requestRedeem(100e9, address(this), address(this));
        uint256 epoch = v.activeEpochId();
        v.beginExit(epoch);
        vm.expectRevert(HyperVaultNavVerifier.CoreNotFlat.selector);
        v.settleEpoch(epoch, "");
    }

    function testOracleConfigRejections() public {
        _allocate(100e6);
        _oracleScope();
        HyperVaultNavSource.Token[] memory tokens = new HyperVaultNavSource.Token[](2);
        tokens[0] = HyperVaultNavSource.Token(0, 0, true, false, true, HYPE_PERP); // USDC
        tokens[1] = HyperVaultNavSource.Token(HYPE, HYPE_PAIR, false, false, true, HYPE_PERP);
        vm.expectRevert(HyperVaultNavSource.InvalidConfiguration.selector);
        source.configure(address(v), tokens, new uint32[](1), new address[](0), true);
        tokens[0].perpOracle = false;
        tokens[1].perp = 10_000; // not a main-DEX perp
        vm.expectRevert(HyperVaultNavSource.InvalidConfiguration.selector);
        source.configure(address(v), tokens, new uint32[](1), new address[](0), true);
    }

    function testLensMatchesTheVaultOnTheRealOracleScope() public {
        HyperVaultLens lens = new HyperVaultLens();
        vm.prank(ALICE);
        v.deposit(20e6, ALICE);
        _allocate(100e6);
        _oracleScope();
        _hedged(500_000, 560_000); // mark off the oracle; no record anywhere
        HyperVaultLens.Account memory a = lens.account(address(v), ALICE);
        require(a.navOk && a.oracleOnly && a.windowLow == type(uint256).max, "oracle scope, no record");
        require(a.redeemNowBlock == HyperVaultLens.Block.None && a.redeemNowAssets <= 20e6, "instant exit open");
        (uint256 preview,) = lens.previewRedeemNow(address(v), 10e9);
        vm.prank(ALICE);
        require(v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp) == preview, "lens == vault");
    }

    function testCoreOpsCannotBeCalledDirectly() public {
        // The library's state-changing entry points refuse a plain CALL (Solidity's call guard):
        // only HyperVault's own DELEGATECALL reaches them.
        (bool ok,) = address(HyperVaultCoreOps).call(abi.encodeWithSignature("disabledAgent()"));
        require(ok, "a view answers");
        // queueAllocation(0) on an empty layout would pass every check of its own (0 <= cash 0, not
        // Exiting) and write the library's slot: only the call guard can make it revert, and it
        // reverts before any external call, with no data.
        HyperVaultCoreOps.Env memory env;
        env.asset = IERC20(address(usd)); // a real token: the cash read itself succeeds
        bytes memory ret;
        (ok, ret) = address(HyperVaultCoreOps)
            .call(abi.encodeWithSelector(HyperVaultCoreOps.queueAllocation.selector, uint256(1), env, uint256(0)));
        require(!ok && ret.length == 0, "state-changing entry point reverts on CALL, by the guard");
        // The same payload succeeds by DELEGATECALL (as from the Vault): the guard is the only refusal.
        (ok,) = new CoreOpsDelegator()
            .run(
                address(HyperVaultCoreOps),
                abi.encodeWithSelector(HyperVaultCoreOps.queueAllocation.selector, uint256(1), env, uint256(0))
            );
        require(ok, "delegatecalled, the same call passes");
    }

    function testSplitKeepsVaultIdentityEventsAndAccess() public {
        // disabledAgent is computed in the library under DELEGATECALL: still the Vault's address.
        require(
            v.disabledAgent()
                == address(
                    uint160(uint256(keccak256(abi.encode("MANAGED_VAULT_DISABLED_AGENT", block.chainid, address(v)))))
                ),
            "revoke target unchanged"
        );
        // Core events come from the Vault's address with the topics they always had.
        v.queueCoreAllocation(50e6);
        vm.recordLogs();
        uint256 id = v.executeCoreAllocation();
        VmLog[] memory logs = vm.getRecordedLogs();
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].topics[0] == keccak256("CoreActionSubmitted(uint256,uint8,bytes32,bytes)")
                    && logs[i].emitter == address(v) && uint256(logs[i].topics[1]) == id
            ) seen = true;
        }
        require(seen, "CoreActionSubmitted emitted by the Vault");
        // Owner-only entry points still refuse anyone else, before any library code runs.
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.Unauthorized.selector);
        v.recallFromCore(SPOT, 1);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.Unauthorized.selector);
        v.setApiWallet(address(0xBEEF));
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.Unauthorized.selector);
        v.queueCoreAllocation(0);
        // A second Core action while one is pending is refused inside the library, same selector.
        vm.expectRevert(HyperVaultTypes.PendingCoreAction.selector);
        v.recallFromCore(SPOT, 1);
    }
}

/// @dev Stands in for the Vault: runs a library payload by DELEGATECALL on its own storage.
contract CoreOpsDelegator {
    function run(address lib, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = lib.delegatecall(data);
    }
}
