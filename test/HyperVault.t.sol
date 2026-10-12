// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ManagedUpgradeController} from "../src/managed/ManagedUpgradeController.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {HyperVault} from "../src/hypervault/HyperVault.sol";
import {HyperVaultTypes} from "../src/hypervault/HyperVaultTypes.sol";
import {HyperVaultLens} from "../src/hypervault/HyperVaultLens.sol";
import {HyperVaultShare} from "../src/hypervault/HyperVaultShare.sol";
import {HyperVaultAccountant, IHyperVaultPriceHistory} from "../src/hypervault/HyperVaultAccountant.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {IManagedVaultVerifier} from "../src/interfaces/IManagedVaultVerifier.sol";
import {MockManagedVerifier} from "./helpers/MockManagedVerifier.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {ManagedTestUsdc, ManagedTestDepositWallet} from "./ManagedUsdcVault.t.sol";

interface VmHv {
    function warp(uint256) external;
    function mockCall(address, bytes calldata, bytes calldata) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function prank(address) external;
    function toString(uint256) external pure returns (string memory);
}

/// @dev TEST ONLY: the mock verifier plus a settable price history (the real verifier's ABI).
contract MockHistoryVerifier is MockManagedVerifier {
    IHyperVaultPriceHistory.PriceRecord[8] private _records;
    uint256 public priceWindow = 600;
    bool public oracleOnly_;

    function setOracleOnly(bool on) external {
        oracleOnly_ = on;
    }

    function oracleOnly(address) external view returns (bool) {
        return oracleOnly_;
    }

    function setRecord(uint256 i, uint192 price, uint64 time) external {
        _records[i] = IHyperVaultPriceHistory.PriceRecord(price, time);
    }

    function priceRecords(address) external view returns (IHyperVaultPriceHistory.PriceRecord[8] memory) {
        return _records;
    }
}

/// @dev Local synthetic Core effects only; not a live bridge round trip.
contract HyperVaultTest {
    VmHv constant vm = VmHv(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant TREASURY = address(0xFEE);
    uint32 constant SPOT = type(uint32).max;
    ManagedTestUsdc usd;
    ManagedTestDepositWallet circle;
    MockHistoryVerifier verifier;
    MockCoreWriter writer;
    ManagedAssetBridge bridge;
    HyperVaultAccountant accountant;
    HyperVaultShare share;
    HyperVault v;
    uint64 blockNo = 100;

    function setUp() public {
        vm.warp(1_000_000);
        usd = new ManagedTestUsdc();
        circle = new ManagedTestDepositWallet(usd);
        verifier = new MockHistoryVerifier();
        writer = new MockCoreWriter();
        vm.mockCall(address(0x0810), bytes(""), abi.encode(true));
        vm.mockCall(address(0x0809), bytes(""), abi.encode(blockNo));
        CoreRead.TokenInfo memory info;
        info.evmContract = address(circle);
        info.szDecimals = 8;
        info.weiDecimals = 8;
        info.evmExtraWeiDecimals = -2;
        vm.mockCall(address(0x080c), abi.encode(uint32(0)), abi.encode(info));
        bridge = new ManagedAssetBridge(address(usd), address(usd), address(circle), ManagedAssetBridge.Kind.Usdc, 0, 0);
        accountant = new HyperVaultAccountant(IHyperVaultPriceHistory(address(verifier)));
        v = _deploy(1000);
        usd.mint(address(this), 1_000e6);
        usd.mint(ALICE, 1_000e6);
        usd.mint(BOB, 1_000e6);
        usd.approve(address(v), type(uint256).max);
        vm.prank(ALICE);
        usd.approve(address(v), type(uint256).max);
        vm.prank(BOB);
        usd.approve(address(v), type(uint256).max);
        v.bootstrap(100e6);
    }

    function _config(uint16 feeBps) private returns (HyperVaultTypes.Config memory c) {
        share = new HyperVaultShare("HyperVault USDC", "hvUSDC", 9);
        c.asset = address(usd);
        c.share = address(share);
        c.accountant = address(accountant);
        c.bridge = address(bridge);
        c.owner = address(this);
        c.treasury = TREASURY;
        c.coreWriter = address(writer);
        c.verifier = address(verifier);
        c.upgradeController = address(new ManagedUpgradeController(address(this)));
        c.performanceFeeBps = feeBps;
        c.minimumDeposit = 1e6;
        c.activationCost = 1e6;
        c.maximumAssets = 10_000e6;
        c.chainId = block.chainid;
    }

    function _deploy(uint16 feeBps) private returns (HyperVault vault) {
        HyperVaultTypes.Config memory c = _config(feeBps);
        HyperVault implementation = new HyperVault(c);
        ManagedUpgradeController controller = ManagedUpgradeController(c.upgradeController);
        vault = HyperVault(
            payable(address(new TransparentUpgradeableProxy(address(implementation), address(controller), "")))
        );
        controller.bind(address(vault), address(implementation));
        share.bind(address(vault));
    }

    function _confirm(uint256 amount) private {
        (uint256 id, bytes32 hash,,,,) = v.pendingAction();
        vm.mockCall(address(0x0809), bytes(""), abi.encode(++blockNo));
        verifier.setReceipt(address(v), id, hash, IManagedVaultVerifier.Receipt(blockNo, true, amount));
        v.syncCoreAction(id, "");
    }

    /// Core value `net` (USDC6) is live; the window's records are all at `low` (0: none).
    function _core(int256 net, uint192 low) private {
        verifier.setNav(address(v), net, blockNo, v.actionNonce(), v.configHash());
        verifier.setRecord(0, low, low == 0 ? 0 : uint64(block.timestamp));
    }

    function _allocate(uint256 amount) private {
        v.queueCoreAllocation(amount);
        v.executeCoreAllocation();
        _confirm(amount);
    }

    function _live() private view returns (uint256 a) {
        (a,) = v.liveNav();
    }

    function _price() private view returns (uint256) {
        return (_live() + 1) * 1e30 / (v.totalSupply() + 1000);
    }

    // ------------------------------------------------------------------ structure

    function testShareIsSeparateTransferableTokenMintedOnlyByVault() public {
        require(v.share() == address(share) && share.vault() == address(v), "ERC-7575 share");
        require(share.balanceOf(address(this)) == 100e9 && v.totalSupply() == 100e9, "founder shares");
        require(share.decimals() == 9 && v.asset() == address(usd), "decimals");
        share.transfer(ALICE, 10e9);
        require(share.balanceOf(ALICE) == 10e9, "free transfer");
        vm.expectRevert(HyperVaultShare.Unauthorized.selector);
        share.mint(address(this), 1);
        vm.expectRevert(HyperVaultShare.InvalidReceiver.selector);
        share.transfer(address(v), 1);
        share.transfer(address(v), 0);
        vm.expectRevert(HyperVaultShare.Unauthorized.selector);
        share.bind(address(this));
    }

    function testRecipientOfTransferredSharesRedeemsWithoutCostBasis() public {
        vm.prank(ALICE);
        uint256 shares = v.deposit(50e6, ALICE);
        vm.prank(ALICE);
        share.transfer(BOB, shares);
        vm.prank(BOB);
        uint256 id = v.requestRedeem(shares, BOB, BOB);
        require(v.claimableRedeemRequest(id, BOB) == shares, "Idle settles at once");
        vm.prank(BOB);
        uint256 paid = v.redeem(shares, BOB, BOB);
        require(paid == 50e6 - 1 || paid == 50e6, "same price for every holder");
    }

    function testBootstrapOnlyOwnerOnceAndConfigBounds() public {
        HyperVault fresh = _deploy(1000);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.Unauthorized.selector);
        fresh.bootstrap(1e6);
        HyperVaultTypes.Config memory c = _config(5001);
        vm.expectRevert(HyperVaultTypes.InvalidConfiguration.selector);
        new HyperVault(c);
        vm.expectRevert(HyperVaultTypes.WrongPhase.selector);
        v.bootstrap(1e6);
        (uint256 mark, uint256 rate,) = accountant.marks(address(v));
        require(mark == 1e27 && rate == 1e27, "mark starts at founder price");
    }

    // ------------------------------------------------------------------ high-water mark

    function testFeeOnGainAboveMarkSplit80to20() public {
        _allocate(100e6);
        _core(110e6, type(uint192).max);
        uint256 supply = v.totalSupply();
        v.checkpoint();
        uint256 feeShares = v.totalSupply() - supply;
        uint256 ownerValue = (share.balanceOf(address(this)) - 100e9) * (_live() + 1) / (v.totalSupply() + 1000);
        uint256 platformValue = share.balanceOf(TREASURY) * (_live() + 1) / (v.totalSupply() + 1000);
        // 10% of the 10 USDC gain is 1 USDC of value, 80/20.
        require(ownerValue + platformValue > 0.999e6 && ownerValue + platformValue <= 1e6, "fee value");
        require(share.balanceOf(TREASURY) == feeShares / 5, "platform 20%");
        (uint256 mark, uint256 rate,) = accountant.marks(address(v));
        require(mark == rate && rate == _price(), "mark moves to post-fee price");
        require(rate > 1.0899e27 && rate < 1.0901e27, "holders keep 9 of 10");
        v.checkpoint();
        require(v.totalSupply() == supply + feeShares, "no fee twice on the same gain");
    }

    function testLossRecoveryIsFeeFree() public {
        _allocate(100e6);
        _core(90e6, type(uint192).max);
        v.checkpoint();
        require(share.balanceOf(TREASURY) == 0, "no fee on loss");
        _core(100e6, type(uint192).max);
        v.checkpoint();
        require(share.balanceOf(TREASURY) == 0, "no fee on recovery up to the mark");
        _core(120e6, type(uint192).max);
        v.checkpoint();
        require(share.balanceOf(TREASURY) > 0, "fee above the mark");
    }

    function testSpikeShorterThanWindowIsNotCharged() public {
        _allocate(100e6);
        // Live NAV spikes to 150, but the window's lowest record is at 1.05.
        _core(150e6, 1.05e27);
        v.checkpoint();
        (, uint256 rate,) = accountant.marks(address(v));
        require(rate < 1.05e27 && rate > 1.0449e27, "fee and rate at window low");
        uint256 fee = share.balanceOf(TREASURY) * 5;
        // 10% of a 5 USDC gain = 0.5 USDC of value after the fee shares exist.
        uint256 value = fee * (_live() + 1) / (v.totalSupply() + 1000);
        require(value > 0.499e6 && value <= 0.5e6, "charged on 5, not 50");
    }

    function testActiveDepositPaysNoPastFeeAndPreviewMatches() public {
        _allocate(100e6);
        _core(110e6, type(uint192).max);
        uint256 preview = v.previewDeposit(11e6);
        vm.prank(ALICE);
        uint256 shares = v.deposit(11e6, ALICE);
        require(shares == preview, "preview includes the fee");
        uint256 value = shares * (_live() + 1) / (v.totalSupply() + 1000);
        require(value >= 10.99e6 && value <= 11e6, "depositor value whole");
        require(share.balanceOf(TREASURY) > 0, "fee charged before the deposit");
    }

    function testExitChargesFeeAtCashAndOwnerRedeemsFeeShares() public {
        vm.prank(ALICE);
        uint256 shares = v.deposit(100e6, ALICE);
        _allocate(200e6);
        vm.prank(ALICE);
        uint256 id = v.requestRedeem(shares, ALICE, ALICE);
        require(v.pendingRedeemRequest(id, ALICE) == shares, "pending while Active");
        v.beginExit(v.activeEpochId());
        v.recallFromCore(SPOT, 240e6);
        usd.mint(address(v), 240e6);
        _confirm(240e6);
        verifier.setIdle(address(v), v.activeEpochId(), v.actionNonce(), blockNo);
        v.settleEpoch(v.activeEpochId(), "");
        vm.prank(ALICE);
        uint256 paid = v.redeem(shares, ALICE, ALICE);
        // 20% gain: 20 USDC on Alice's 100, 10% fee = 2 USDC.
        require(paid > 117.99e6 && paid <= 118e6, "net of HWM fee");
        uint256 feeShares = share.balanceOf(address(this)) - 100e9;
        require(feeShares > 0 && share.balanceOf(TREASURY) > 0, "fee shares minted");
        v.requestRedeem(share.balanceOf(address(this)), address(this), address(this));
        uint256 owned = v.redeem(v.maxRedeem(address(this)), address(this), address(this));
        // Vault-wide gain 40 USDC, fee 4: the owner pays 2 on its own 120 and receives 80% of 4.
        require(owned > 121.19e6 && owned <= 121.2e6, "owner 120 - 2 + 3.2");
        require(share.balanceOf(TREASURY) * 1201 / 1e6 > 0.79e6, "treasury holds 0.8 of value");
    }

    // ------------------------------------------------------------------ never-reverting rate

    function testRateViewsNeverRevertWhileNavUnavailable() public {
        v.queueCoreAllocation(50e6);
        v.executeCoreAllocation(); // Core action pending: live NAV closed
        vm.expectRevert(HyperVaultTypes.NavUnavailable.selector);
        v.liveNav();
        require(v.maxDeposit(ALICE) == 0, "deposits closed");
        require(v.convertToAssets(1e9) == 1e6 && v.convertToShares(1e6) == 1e9, "last rate");
        require(v.totalAssets() == 100e6, "last verified value");
    }

    // ------------------------------------------------------------------ requests

    function testRequestsJoinInOpenEpochAndAllowanceOrOperator() public {
        share.transfer(ALICE, 20e9);
        _allocate(50e6);
        vm.prank(ALICE);
        uint256 id = v.requestRedeem(5e9, ALICE, ALICE);
        vm.prank(ALICE);
        require(v.requestRedeem(5e9, ALICE, ALICE) == id, "same epoch joins");
        require(v.pendingRedeemRequest(id, ALICE) == 10e9, "joined");
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, BOB, 0, 1e9));
        v.requestRedeem(1e9, BOB, ALICE);
        vm.prank(ALICE);
        share.approve(BOB, 1e9);
        vm.prank(BOB);
        v.requestRedeem(1e9, BOB, ALICE);
        require(share.allowance(ALICE, BOB) == 0, "allowance spent");
        vm.prank(ALICE);
        v.setOperator(BOB, true);
        vm.prank(BOB);
        v.requestRedeem(1e9, ALICE, ALICE);
        require(v.pendingRedeemRequest(id, ALICE) == 11e9, "operator joins controller");
        vm.expectRevert(HyperVaultTypes.AsyncPreviewUnsupported.selector);
        v.previewRedeem(1);
    }

    function testSettledUnclaimedRequestBlocksNewOne() public {
        v.requestRedeem(10e9, address(this), address(this));
        vm.expectRevert(HyperVaultTypes.OutstandingRequest.selector);
        v.requestRedeem(10e9, address(this), address(this));
        v.redeem(10e9, address(this), address(this));
        v.requestRedeem(10e9, address(this), address(this));
    }

    // ------------------------------------------------------------------ review follow-ups

    function testNobodyParksARequestOnAnotherController() public {
        share.transfer(ALICE, 1e9);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.Unauthorized.selector);
        v.requestRedeem(1, address(this), ALICE);
        v.requestRedeem(10e9, address(this), address(this));
        require(v.maxRedeem(address(this)) == 10e9, "own request unaffected");
    }

    function testDepositsWaitWhileLivePriceRunsAheadOfRecords() public {
        _allocate(100e6);
        _core(110e6, 1e27); // live 1.10, window low 1.00: the rise is not charged yet
        require(v.maxDeposit(ALICE) == 0, "closed while the fee lags");
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.CapitalClosed.selector);
        v.deposit(11e6, ALICE);
        _core(110e6, 1.0999e27); // records caught up within 20 bps
        require(v.maxDeposit(ALICE) > 0, "open again");
        vm.prank(ALICE);
        uint256 shares = v.deposit(11e6, ALICE);
        v.checkpoint();
        uint256 value = shares * (_live() + 1) / (v.totalSupply() + 1000);
        require(value > 10.998e6, "depositor keeps value after the fee catches up");
    }

    function testMintPreviewAndMaxMint() public {
        uint256 assets = v.previewMint(20e9);
        require(v.maxMint(ALICE) > 20e9, "room");
        vm.prank(ALICE);
        require(v.mint(20e9, ALICE) == assets && assets == 20e6, "mint at cash price");
        require(share.balanceOf(ALICE) == 20e9, "shares");
    }

    function testWithdrawAndRedeemMixedByOperatorAndDust() public {
        vm.prank(ALICE);
        uint256 shares = v.deposit(30e6, ALICE);
        _allocate(130e6);
        vm.prank(ALICE);
        uint256 id = v.requestRedeem(shares, ALICE, ALICE);
        v.requestRedeem(50e9, address(this), address(this));
        v.beginExit(v.activeEpochId());
        v.recallFromCore(SPOT, 133333333);
        usd.mint(address(v), 133333333);
        _confirm(133333333);
        verifier.setIdle(address(v), v.activeEpochId(), v.actionNonce(), blockNo);
        v.settleEpoch(v.activeEpochId(), "");
        require(v.claimableRedeemRequest(id, ALICE) == shares, "claimable");
        uint256 total = v.maxWithdraw(ALICE);
        vm.prank(ALICE);
        v.setOperator(BOB, true);
        vm.prank(BOB);
        v.withdraw(1e6, BOB, ALICE);
        vm.prank(ALICE);
        v.redeem(shares / 3, ALICE, ALICE);
        uint256 rest = v.maxWithdraw(ALICE);
        vm.prank(BOB);
        v.withdraw(rest, ALICE, ALICE);
        require(v.maxRedeem(ALICE) == 0 && v.controllerRequest(ALICE) == 0, "fully claimed");
        require(usd.balanceOf(BOB) - 1_000e6 + usd.balanceOf(ALICE) - 970e6 == total, "paid exactly the gross");
        v.redeem(v.maxRedeem(address(this)), address(this), address(this));
        uint256 reserved = v.reservedClaimAssets();
        require(reserved == v.roundingReserve(), "only rounding dust stays reserved");
        v.releaseRoundingDust();
        require(v.reservedClaimAssets() == 0 && usd.balanceOf(address(v)) >= v.accountedCash(), "books balance");
    }

    function testFullExitResetsMarkForTheNextHolders() public {
        _allocate(100e6);
        _core(150e6, type(uint192).max);
        v.checkpoint();
        v.requestRedeem(share.balanceOf(address(this)), address(this), address(this));
        uint256 platform = share.balanceOf(TREASURY);
        vm.prank(TREASURY);
        v.requestRedeem(platform, TREASURY, TREASURY);
        v.beginExit(v.activeEpochId());
        v.recallFromCore(SPOT, 150e6);
        usd.mint(address(v), 150e6);
        _confirm(150e6);
        verifier.setIdle(address(v), v.activeEpochId(), v.actionNonce(), blockNo);
        v.settleEpoch(v.activeEpochId(), "");
        require(v.totalSupply() == 0, "empty");
        vm.prank(ALICE);
        uint256 shares = v.deposit(10e6, ALICE);
        (uint256 mark,,) = accountant.marks(address(v));
        require(mark < 1.01e27 && shares > 9.9e9, "new holders start at their own price");
    }

    function testFuzzFeeNeverExceedsItsShareOfTheGain(uint64 coreValue, uint16 lowBps) public {
        _allocate(100e6);
        uint256 net = bound(coreValue, 1e6, 5_000e6);
        uint256 live = (net + 1) * 1e30 / (v.totalSupply() + 1000);
        uint256 low = live * bound(lowBps, 5_000, 20_000) / 10_000;
        _core(int256(net), uint192(low));
        v.checkpoint();
        uint256 conservative = live < low ? live : low;
        uint256 gain = conservative > 1e27 ? (conservative - 1e27) * (100e9 + 1000) / 1e30 : 0;
        uint256 feeValue = (v.totalSupply() - 100e9) * (net + 1) / (v.totalSupply() + 1000);
        require(feeValue <= gain / 10 + 1, "fee <= 10% of the conservative gain");
        (uint256 mark, uint256 rate,) = accountant.marks(address(v));
        require(mark >= 1e27 && rate <= live, "mark never falls, rate never above live");
    }

    function bound(uint256 x, uint256 lo, uint256 hi) private pure returns (uint256) {
        return lo + x % (hi - lo + 1);
    }

    // ------------------------------------------------------------------ donations

    function testEvmDonationIsNotNavAndCannotInflateTheFirstShare() public {
        usd.mint(address(v), 1_000e6); // direct transfer, outside the books
        require(v.availableCash() == 100e6 && v.totalAssets() == 100e6, "donation excluded");
        require(v.unaccountedUsdc() == 1_000e6, "visible as unaccounted only");
        vm.prank(ALICE);
        require(v.deposit(10e6, ALICE) == 10e9, "price unchanged by the donation");
        // Empty the Vault, then donate again: the next first depositor is still priced at cash.
        v.requestRedeem(share.balanceOf(address(this)), address(this), address(this));
        v.redeem(v.maxRedeem(address(this)), address(this), address(this));
        vm.prank(ALICE);
        v.requestRedeem(10e9, ALICE, ALICE);
        vm.prank(ALICE);
        v.redeem(10e9, ALICE, ALICE);
        v.releaseRoundingDust();
        require(v.totalSupply() == 0, "empty");
        usd.mint(address(v), 500e6);
        vm.prank(BOB);
        uint256 shares = v.deposit(10e6, BOB);
        require(shares >= 9.99e9, "first depositor after a donation is not diluted");
        vm.prank(BOB);
        v.requestRedeem(shares, BOB, BOB);
        vm.prank(BOB);
        require(v.redeem(shares, BOB, BOB) >= 9.99e6, "and redeems what it paid");
    }

    function testCoreDonationOnlyEnrichesExistingHoldersAndPaysTheFee() public {
        _allocate(100e6);
        _core(150e6, type(uint192).max); // someone sends 50 USDC to the Vault's Core account
        vm.prank(ALICE);
        uint256 shares = v.deposit(15e6, ALICE);
        uint256 value = shares * (_live() + 1) / (v.totalSupply() + 1000);
        require(value > 14.99e6 && value <= 15e6, "a later depositor neither gains nor loses");
        require(share.balanceOf(TREASURY) > 0, "the donation was charged as gain before the deposit");
    }

    function testSharesCannotBeDonatedToTheVault() public {
        vm.expectRevert(HyperVaultShare.InvalidReceiver.selector);
        share.transfer(address(v), 1);
        share.approve(ALICE, 1);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultShare.InvalidReceiver.selector);
        share.transferFrom(address(this), address(v), 1);
    }

    // ------------------------------------------------------------------ instant redeem from the buffer

    /// Owner 100 + Alice 100; 150 to Core, 50 stays as the EVM buffer; Core value `core`.
    function _running(int256 core, uint192 low) private {
        vm.prank(ALICE);
        v.deposit(100e6, ALICE);
        _allocate(150e6);
        _core(core, low);
    }

    function testRedeemNowPaysFromTheBufferAtTheLivePrice() public {
        _running(150e6, 1e27);
        uint256 before = usd.balanceOf(ALICE);
        uint256 supply = v.totalSupply();
        vm.prank(ALICE);
        uint256 assets = v.redeemNow(10e9, ALICE, ALICE, 9.9e6, block.timestamp);
        require(assets > 9.989e6 && assets <= 9.99e6, "price 1.0 less the 0.1% exit fee");
        require(usd.balanceOf(ALICE) - before == assets, "paid in the same call");
        require(v.totalSupply() == supply - 10e9 && share.balanceOf(ALICE) == 90e9, "shares burned");
        require(
            v.availableCash() == 50e6 - assets && v.phase() == HyperVaultTypes.Phase.Active, "strategy keeps running"
        );
        require(_live() == 200e6 - assets, "NAV down by the payout only");
    }

    function testRedeemNowIsCappedByFreeCash() public {
        _running(150e6, 1e27);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.InvalidAmount.selector);
        v.redeemNow(60e9, ALICE, ALICE, 0, block.timestamp);
        vm.prank(ALICE);
        v.redeemNow(49e9, ALICE, ALICE, 0, block.timestamp);
    }

    function testRedeemNowPaysTheLowerOfLiveAndWindowLowAndKeepsHoldersWhole() public {
        // Live 50 + 170 = 220 (1.10 a share), but the window's lowest record is 1.05.
        _running(170e6, 1.05e27);
        v.checkpoint();
        uint256 held = _price();
        vm.prank(ALICE);
        uint256 assets = v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp);
        require(assets > 10.43e6 && assets < 10.5e6, "paid at the window low, after both fees");
        require(_price() >= held, "remaining holders do not lose to the leaver");
    }

    function testRedeemNowChargesTheFeeFirst() public {
        _running(170e6, 1.1e27); // 10% gain, recorded: price 1.10
        vm.prank(ALICE);
        uint256 assets = v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp);
        require(share.balanceOf(TREASURY) > 0, "fee crystallized before pricing");
        require(assets > 10.87e6 && assets < 10.9e6, "1.10 less 10% of the 0.10 gain, less 0.1%");
    }

    function testRedeemNowOnlyWhileRunningWithAValidNav() public {
        vm.prank(ALICE);
        v.deposit(100e6, ALICE);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.WrongPhase.selector);
        v.redeemNow(1e9, ALICE, ALICE, 0, block.timestamp); // Idle: requestRedeem pays at once
        v.queueCoreAllocation(150e6);
        v.executeCoreAllocation();
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.NavUnavailable.selector);
        v.redeemNow(1e9, ALICE, ALICE, 0, block.timestamp); // Core action pending
        _confirm(150e6);
        _core(150e6, type(uint192).max);
        v.beginExit(v.activeEpochId());
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.WrongPhase.selector);
        v.redeemNow(1e9, ALICE, ALICE, 0, block.timestamp); // exiting: the epoch path settles
    }

    function testRedeemNowSlippageDeadlineAndReceiver() public {
        _running(150e6, 1e27);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.SlippageOrDeadline.selector);
        v.redeemNow(10e9, ALICE, ALICE, 9.991e6, block.timestamp);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.SlippageOrDeadline.selector);
        v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp - 1);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.InvalidReceiver.selector);
        v.redeemNow(10e9, address(v), ALICE, 0, block.timestamp);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.SlippageOrDeadline.selector);
        v.redeemNow(1, ALICE, ALICE, 0, block.timestamp); // rounds to zero assets
    }

    function testRedeemNowForAnotherOwnerNeedsAllowanceOrOperator() public {
        _running(150e6, 1e27);
        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, BOB, 0, 5e9));
        v.redeemNow(5e9, BOB, ALICE, 0, block.timestamp);
        vm.prank(ALICE);
        share.approve(BOB, 5e9);
        uint256 before = usd.balanceOf(BOB);
        vm.prank(BOB);
        uint256 assets = v.redeemNow(5e9, BOB, ALICE, 0, block.timestamp);
        require(usd.balanceOf(BOB) - before == assets && share.allowance(ALICE, BOB) == 0, "spender redeems");
        vm.prank(ALICE);
        v.setOperator(BOB, true);
        vm.prank(BOB);
        v.redeemNow(5e9, BOB, ALICE, 0, block.timestamp);
        require(share.balanceOf(ALICE) == 90e9, "operator redeems without allowance, like requestRedeem");
    }

    function testRedeemNowLeavesQueuedRequestsWhole() public {
        _running(150e6, 1e27);
        uint256 id = v.requestRedeem(10e9, address(this), address(this));
        vm.prank(ALICE);
        v.redeemNow(40e9, ALICE, ALICE, 0, block.timestamp);
        require(v.pendingRedeemRequest(id, address(this)) == 10e9, "queued request untouched");
        v.beginExit(v.activeEpochId());
        v.recallFromCore(SPOT, 150e6);
        usd.mint(address(v), 150e6);
        _confirm(150e6);
        verifier.setIdle(address(v), v.activeEpochId(), v.actionNonce(), blockNo);
        v.settleEpoch(v.activeEpochId(), "");
        uint256 paid = v.redeem(10e9, address(this), address(this));
        require(paid >= 10e6 && paid < 10.01e6, "queued request paid at 1.0 plus its share of the exit fee");
    }

    function testRedeemNowWithoutARecordNeedsAnOracleOnlyScope() public {
        // Live 1.10 with nothing recorded: a scope a book or mark can move must fail closed.
        _running(170e6, 0);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.NavUnavailable.selector);
        v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp);
    }

    function testRedeemNowNeedsNoPriceRecord() public {
        // Nothing recorded in the window: the oracle-valued live NAV (1.10) prices the exit,
        // after the fee on the gain and the 0.1% exit fee (ADR-040).
        _running(170e6, 0);
        verifier.setOracleOnly(true);
        vm.prank(ALICE);
        uint256 assets = v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp);
        require(assets > 10.87e6 && assets < 10.9e6, "live price, fee first, exit fee kept");
    }

    function testRedeemNowKeepsTheExitFeeForTheHoldersWhoStay() public {
        _running(150e6, 1e27);
        uint256 held = _price();
        vm.prank(ALICE);
        v.redeemNow(40e9, ALICE, ALICE, 0, block.timestamp);
        require(_price() > held, "remaining holders gain the fee");
    }

    function testRedeemNowRefusesTheWholeSupply() public {
        _running(150e6, 1e27);
        share.transfer(ALICE, 100e9);
        vm.prank(ALICE);
        vm.expectRevert(HyperVaultTypes.InvalidAmount.selector);
        v.redeemNow(200e9, ALICE, ALICE, 0, block.timestamp); // the last holder takes the epoch path
    }
    // ------------------------------------------------------------------ lens (ADR-041)

    function testLensPreviewEqualsRedeemNow() public {
        HyperVaultLens lens = new HyperVaultLens();
        _running(170e6, 1.05e27); // live 1.10 above the window low 1.05; a fee is due
        (uint256 preview, HyperVaultLens.Block why) = lens.previewRedeemNow(address(v), 10e9);
        require(why == HyperVaultLens.Block.None, "payable");
        vm.prank(ALICE);
        require(v.redeemNow(10e9, ALICE, ALICE, 0, block.timestamp) == preview, "preview == paid, fee first");
    }

    function testFuzzLensPreviewEqualsRedeemNow(uint64 shares, uint64 core) public {
        HyperVaultLens lens = new HyperVaultLens();
        _running(int256(uint256(bound(core, 100e6, 300e6))), 1e27);
        shares = uint64(bound(shares, 1, 100e9));
        (uint256 preview, HyperVaultLens.Block why) = lens.previewRedeemNow(address(v), shares);
        vm.prank(ALICE);
        if (why == HyperVaultLens.Block.None) {
            require(v.redeemNow(shares, ALICE, ALICE, 0, block.timestamp) == preview, "same payout");
        } else {
            vm.expectRevert();
            v.redeemNow(shares, ALICE, ALICE, 0, block.timestamp);
        }
    }

    function testLensMaxRedeemNowIsTheFreeCashEdge() public {
        HyperVaultLens lens = new HyperVaultLens();
        _running(150e6, 1e27); // 50 free cash, Alice holds 100e9 shares at 1.0
        (uint256 shares, uint256 assets, HyperVaultLens.Block why) = lens.maxRedeemNow(address(v), ALICE);
        require(why == HyperVaultLens.Block.None && assets <= 50e6 && shares > 49e9, "largest that fits");
        (, HyperVaultLens.Block next) = lens.previewRedeemNow(address(v), shares + 1);
        require(next == HyperVaultLens.Block.OverFreeCash, "one more share does not fit");
        vm.prank(ALICE);
        require(v.redeemNow(shares, ALICE, ALICE, 0, block.timestamp) == assets, "and it pays");
    }

    function testLensReasonsAndAccount() public {
        HyperVaultLens lens = new HyperVaultLens();
        vm.prank(ALICE);
        v.deposit(100e6, ALICE);
        (, HyperVaultLens.Block idle) = lens.previewRedeemNow(address(v), 1e9);
        require(idle == HyperVaultLens.Block.WrongPhase, "Idle pays through requestRedeem");
        _allocate(150e6);
        _core(170e6, 0); // no record, mock scope not oracle-only
        (, HyperVaultLens.Block rec) = lens.previewRedeemNow(address(v), 1e9);
        require(rec == HyperVaultLens.Block.NeedsRecord, "fail closed like the Vault");
        (, HyperVaultLens.Block all) = lens.previewRedeemNow(address(v), v.totalSupply());
        require(all == HyperVaultLens.Block.InvalidAmount, "the last holder takes the epoch path");
        _core(170e6, 1.1e27);
        uint256 id = v.requestRedeem(10e9, address(this), address(this));
        HyperVaultLens.Account memory a = lens.account(address(v), address(this));
        require(a.navOk && !a.realized && a.nav == 220e6, "live NAV");
        require(a.requestId == id && a.pendingShares == 10e9 && a.claimableShares == 0, "pending request");
        require(a.feeShares > 0 && a.price > 1.09e27 && a.price < 1.1e27, "fee quoted as a crystallization would");
        require(a.shares == 90e9 && a.availableCash == 50e6, "balance and free cash");
        require(a.redeemNowShares > 0 && a.redeemNowAssets <= 50e6, "instant exit room");
        require(a.maximumAssets == v.maximumAssets() && a.minimumDeposit == v.minimumDeposit(), "terms");
    }

    function testFuzzLensMaxRedeemNowIsMaximalAndPays(uint64 core, uint64 cashCut) public {
        HyperVaultLens lens = new HyperVaultLens();
        _running(int256(uint256(bound(core, 100e6, 400e6))), 1e27);
        // Spend part of the free cash so the edge falls anywhere in it.
        uint256 spend = bound(cashCut, 0, 40) * 1e9 + bound(cashCut >> 8, 0, 1e9 - 1) * (cashCut & 1);
        if (spend >= 1e6) {
            vm.prank(ALICE);
            v.redeemNow(spend, BOB, ALICE, 0, block.timestamp);
        }
        (uint256 shares, uint256 assets, HyperVaultLens.Block why) = lens.maxRedeemNow(address(v), ALICE);
        require(why == HyperVaultLens.Block.None, "free cash remains after the spend: an instant exit is open");
        uint256 balance = share.balanceOf(ALICE);
        if (shares < balance && shares + 1 < v.totalSupply()) {
            (, HyperVaultLens.Block next) = lens.previewRedeemNow(address(v), shares + 1);
            require(next != HyperVaultLens.Block.None, "maximal: one more share is refused");
        }
        vm.prank(ALICE);
        require(v.redeemNow(shares, ALICE, ALICE, 0, block.timestamp) == assets, "the maximum pays as previewed");
    }

    function testLensAccountGasIsOneNavRead() public {
        HyperVaultLens lens = new HyperVaultLens();
        _running(150e6, 1e27);
        uint256 before = gasleft();
        lens.account(address(v), ALICE);
        require(before - gasleft() < 600_000, "no per-step re-reads (was ~2M with the binary search)");
    }
}
