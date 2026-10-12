// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AsyncUsdcVault, ICoreDepositWallet} from "../src/AsyncUsdcVault.sol";
import {EpochRedeem} from "../src/vault/EpochRedeem.sol";
import {IUsdcCycleStrategy} from "../src/interfaces/IUsdcCycleStrategy.sol";

interface VmUsdc {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

contract MockUsdc is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

contract MockDepositWallet is ICoreDepositWallet {
    IERC20 public immutable usdc;
    mapping(address => uint256) public coreCredit;
    bool public skipPull;
    uint32 public lastDestination;
    address public lastRecipient;

    constructor(IERC20 asset_) {
        usdc = asset_;
    }

    function setSkipPull(bool value) external {
        skipPull = value;
    }

    function depositFor(address recipient, uint256 amount, uint32 destinationId) external {
        lastRecipient = recipient;
        lastDestination = destinationId;
        if (skipPull) return;
        require(usdc.transferFrom(msg.sender, address(this), amount));
        coreCredit[recipient] += amount;
    }
}

/// @dev Simulates terminal verification and Core->EVM return; not a HyperCore implementation.
contract MockUsdcCycleStrategy is IUsdcCycleStrategy {
    address public immutable vault;
    address public immutable asset;
    bytes32 public constant configHash = keccak256("mock-usdc-strategy");
    uint256 public cycleId;
    bool public exiting;
    bool public ready;
    bool public lieAboutReturn;
    bool public riskPaused;

    constructor(address vault_, address asset_) {
        vault = vault_;
        asset = asset_;
    }
    modifier onlyVault() {
        require(msg.sender == vault);
        _;
    }

    function startCycle(uint256 id, uint256) external onlyVault {
        require(!exiting && !ready && !riskPaused);
        cycleId = id;
    }

    function setRiskPaused(bool paused) external onlyVault {
        riskPaused = paused;
    }

    function requestExit(uint256 id) external onlyVault {
        require(id == cycleId);
        exiting = true;
    }

    function returnReady(uint256 id) external view returns (bool) {
        return id == cycleId && exiting && ready;
    }

    function complete(uint256 returned) external {
        require(exiting);
        MockUsdc(asset).mint(address(this), returned);
        ready = true;
    }

    function setLieAboutReturn(bool value) external {
        lieAboutReturn = value;
    }

    function returnToVault(uint256 id) external onlyVault returns (uint256 amount) {
        require(id == cycleId && exiting && ready);
        amount = IERC20(asset).balanceOf(address(this));
        ready = false;
        exiting = false;
        require(IERC20(asset).transfer(vault, amount));
        if (lieAboutReturn) return amount + 1;
    }
}

contract AsyncUsdcVaultTest {
    VmUsdc private constant VM = VmUsdc(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    MockUsdc private usdc;
    MockDepositWallet private wallet;
    MockUsdcCycleStrategy private strategy;
    AsyncUsdcVault private vault;

    function setUp() public {
        usdc = new MockUsdc();
        wallet = new MockDepositWallet(usdc);
        vault = new AsyncUsdcVault(
            AsyncUsdcVault.Config({
                asset: address(usdc),
                coreDepositWallet: address(wallet),
                factory: address(this),
                admin: address(this),
                manager: address(this),
                guardian: address(this),
                dustRecipient: address(0xFEE),
                strategyConfigHash: keccak256("mock-usdc-strategy"),
                destinationDex: type(uint32).max,
                adminDelay: 1 days,
                cycleDuration: 1 days,
                maxAssets: 1_000_000e6
            })
        );
        strategy = new MockUsdcCycleStrategy(address(vault), address(usdc));
        vault.bindStrategyOnce(address(strategy));
    }

    function _deposit(address account, uint256 amount) private returns (uint256 shares) {
        usdc.mint(account, amount);
        VM.startPrank(account);
        usdc.approve(address(vault), amount);
        shares = vault.deposit(amount, account);
        VM.stopPrank();
    }

    function testUsdcDecimalsAndErc7540IdleClaim() public {
        require(vault.decimals() == 9 && vault.asset() == address(usdc));
        require(vault.share() == address(vault));
        require(vault.supportsInterface(0xe3bc4e65) && vault.supportsInterface(0x620ee8e4));
        require(vault.supportsInterface(0x2f0a18c5));
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewRedeem(1);
        uint256 shares = _deposit(ALICE, 100e6);
        VM.prank(ALICE);
        uint256 epoch = vault.requestRedeem(shares, ALICE, ALICE);
        require(vault.pendingRedeemRequest(epoch, ALICE) == 0);
        require(vault.claimableRedeemRequest(epoch, ALICE) == shares);
        require(vault.reservedClaimAssets() == 100e6);
        VM.prank(ALICE);
        uint256 received = vault.redeem(shares, ALICE, ALICE);
        require(received == 100e6 && usdc.balanceOf(ALICE) == received);
        require(vault.reservedClaimAssets() == 0 && vault.totalSupply() == 0);
    }

    function testCoreFundingAndLossSettlement() public {
        uint256 aliceShares = _deposit(ALICE, 100e6);
        uint256 bobShares = _deposit(BOB, 100e6);
        uint256 cycle = vault.startCycle(200e6);
        require(wallet.coreCredit(address(strategy)) == 200e6);
        require(wallet.lastRecipient() == address(strategy));
        require(wallet.lastDestination() == type(uint32).max);
        require(usdc.allowance(address(vault), address(wallet)) == 0);
        require(vault.maxDeposit(ALICE) == 0);
        VM.prank(ALICE);
        uint256 id = vault.requestRedeem(aliceShares, ALICE, ALICE);
        VM.prank(BOB);
        require(vault.requestRedeem(bobShares, BOB, BOB) == id);
        require(vault.pendingRedeemRequest(id, ALICE) == aliceShares);
        VM.warp(block.timestamp + 1 days);
        vault.beginExit(cycle);
        VM.expectRevert(AsyncUsdcVault.ReturnNotReady.selector);
        vault.settleEpoch(cycle);
        strategy.complete(160e6);
        vault.settleEpoch(cycle);
        require(vault.reservedClaimAssets() == 160e6);
        VM.prank(ALICE);
        require(vault.redeem(aliceShares, ALICE, ALICE) == 80e6);
        VM.prank(BOB);
        require(vault.redeem(bobShares, BOB, BOB) == 80e6);
        require(vault.reservedClaimAssets() == 0 && vault.totalSupply() == 0);
    }

    function testClaimReserveCannotBeInvestedAgain() public {
        uint256 shares = _deposit(ALICE, 100e6);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE);
        _deposit(BOB, 50e6);
        require(vault.availableCash() == 50e6);
        VM.expectRevert(EpochRedeem.InvalidAmount.selector);
        vault.startCycle(51e6);
        vault.startCycle(50e6);
        require(wallet.coreCredit(address(strategy)) == 50e6);
        require(vault.reservedClaimAssets() == 100e6);
    }

    function testDirectUsdcTransferDoesNotBuySharesOrRaiseClaim() public {
        usdc.mint(BOB, 500e6);
        VM.prank(BOB);
        require(usdc.transfer(address(vault), 500e6));
        require(vault.unaccountedUsdc() == 500e6);
        require(vault.availableCash() == 0 && vault.totalAssets() == 0);
        require(vault.maxDeposit(ALICE) == 1_000_000e6);

        uint256 shares = _deposit(ALICE, 100e6);
        require(shares == 100e9 && vault.accountedCash() == 100e6);
        require(vault.totalAssets() == 100e6 && vault.unaccountedUsdc() == 500e6);
        VM.expectRevert(EpochRedeem.InvalidAmount.selector);
        vault.startCycle(100e6 + 1);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE);
        VM.prank(ALICE);
        require(vault.redeem(shares, ALICE, ALICE) == 100e6);
        require(vault.accountedCash() == 0 && vault.unaccountedUsdc() == 500e6);
        require(usdc.balanceOf(address(vault)) == 500e6);
    }

    function testDirectUsdcTransferDuringCycleDoesNotAffectReturnSettlement() public {
        uint256 shares = _deposit(ALICE, 100e6);
        uint256 cycle = vault.startCycle(100e6);
        usdc.mint(BOB, 50e6);
        VM.prank(BOB);
        require(usdc.transfer(address(vault), 50e6));
        require(vault.accountedCash() == 0 && vault.unaccountedUsdc() == 50e6);
        require(vault.totalAssets() == 100e6);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE);
        VM.warp(block.timestamp + 1 days);
        vault.beginExit(cycle);
        strategy.complete(80e6);
        vault.settleEpoch(cycle);
        require(vault.accountedCash() == 80e6 && vault.reservedClaimAssets() == 80e6);
        require(vault.unaccountedUsdc() == 50e6);
        VM.prank(ALICE);
        require(vault.redeem(shares, ALICE, ALICE) == 80e6);
        require(vault.accountedCash() == 0 && vault.unaccountedUsdc() == 50e6);
    }

    function testAccountedCashDeficitFailsClosed() public {
        _deposit(ALICE, 100e6);
        usdc.burn(address(vault), 1);
        VM.expectRevert(AsyncUsdcVault.AccountedCashDeficit.selector);
        vault.availableCash();
    }

    function testRoundingDustPayoutDecrementsAccountedCash() public {
        uint256 aliceShares = _deposit(ALICE, 1);
        uint256 bobShares = _deposit(BOB, 1);
        uint256 cycle = vault.startCycle(2);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        VM.prank(BOB);
        vault.requestRedeem(bobShares, BOB, BOB);
        VM.warp(block.timestamp + 1 days);
        vault.beginExit(cycle);
        strategy.complete(1);
        vault.settleEpoch(cycle);
        VM.prank(ALICE);
        require(vault.redeem(aliceShares, ALICE, ALICE) == 0);
        VM.prank(BOB);
        require(vault.redeem(bobShares, BOB, BOB) == 0);
        require(vault.roundingReserve() == 1 && vault.accountedCash() == 1);
        vault.releaseRoundingDust();
        require(vault.accountedCash() == 0 && vault.reservedClaimAssets() == 0);
        require(usdc.balanceOf(address(0xFEE)) == 1);
    }

    function testDepositForMustPullExactAmount() public {
        _deposit(ALICE, 100e6);
        wallet.setSkipPull(true);
        VM.expectRevert(AsyncUsdcVault.BalanceMismatch.selector);
        vault.startCycle(100e6);
        require(vault.currentCycleId() == 0 && vault.availableCash() == 100e6);
        require(usdc.allowance(address(vault), address(wallet)) == 0);
    }

    function testReturnAmountMustMatchActualUsdc() public {
        _deposit(ALICE, 100e6);
        uint256 cycle = vault.startCycle(100e6);
        VM.warp(block.timestamp + 1 days);
        vault.beginExit(cycle);
        strategy.complete(95e6);
        strategy.setLieAboutReturn(true);
        VM.expectRevert(AsyncUsdcVault.BalanceMismatch.selector);
        vault.settleEpoch(cycle);
        require(vault.capitalEstimate() == 100e6 && vault.reservedClaimAssets() == 0);
    }

    function testTotalLossBlocksNewDepositsWhileOldSharesRemain() public {
        uint256 aliceShares = _deposit(ALICE, 100e6);
        _deposit(BOB, 100e6);
        uint256 cycle = vault.startCycle(200e6);
        VM.prank(ALICE);
        vault.requestRedeem(aliceShares, ALICE, ALICE);
        VM.warp(block.timestamp + 1 days);
        vault.beginExit(cycle);
        strategy.complete(0);
        vault.settleEpoch(cycle);
        require(vault.totalAssets() == 0 && vault.totalSupply() > 0);
        require(vault.maxDeposit(ALICE) == 0);
        usdc.mint(ALICE, 10e6);
        VM.startPrank(ALICE);
        usdc.approve(address(vault), 10e6);
        VM.expectRevert(AsyncUsdcVault.CapitalClosed.selector);
        vault.deposit(10e6, ALICE);
        VM.stopPrank();
    }

    function testSlippageProtectedDepositRevertsAtomically() public {
        usdc.mint(ALICE, 100e6);
        VM.startPrank(ALICE);
        usdc.approve(address(vault), 100e6);
        VM.expectRevert(AsyncUsdcVault.SlippageOrDeadline.selector);
        vault.depositWithLimit(100e6, ALICE, type(uint256).max, block.timestamp);
        require(usdc.balanceOf(ALICE) == 100e6 && vault.totalSupply() == 0);
        uint256 shares = vault.depositWithLimit(100e6, ALICE, 100e9, block.timestamp);
        require(shares == 100e9);
        VM.stopPrank();
    }

    function testGuardianPauseStopsCapitalAndAllowsExit() public {
        _deposit(ALICE, 100e6);
        uint256 cycle = vault.startCycle(100e6);
        vault.setRiskPaused(true);
        require(strategy.riskPaused());
        vault.beginExit(cycle);
        require(uint8(vault.phase()) == uint8(AsyncUsdcVault.Phase.Exiting));
        strategy.complete(100e6);
        vault.settleEpoch(cycle);
        require(vault.maxDeposit(ALICE) == 0);
    }
}
