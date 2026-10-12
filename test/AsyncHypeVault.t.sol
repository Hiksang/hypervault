// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {EpochRedeem} from "../src/vault/EpochRedeem.sol";
import {IERC7540Operator, IERC7540Redeem} from "../src/interfaces/IERC7540.sol";
import {IERC7575} from "../src/interfaces/IERC7575.sol";
import {IHyperCoreNavReader} from "../src/interfaces/IHyperCoreNavReader.sol";
import {HyperCoreNavReader} from "../src/HyperCoreNavReader.sol";
import {HypeRouter} from "../src/HypeRouter.sol";
import {FixedReceiverController} from "../src/FixedReceiverController.sol";
import {MockWHYPE} from "./helpers/MockWHYPE.sol";
import {MockStrategyAccount, MockNavReader} from "./helpers/MockStrategyAccount.sol";

interface VmAsync {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract AsyncVaultFixture {
    VmAsync internal constant VM = VmAsync(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant KEEPER = address(0xBEEF);
    address internal constant TREASURY = address(0xFEE);
    MockWHYPE internal whype;
    AsyncHypeVault internal vault;
    MockStrategyAccount internal strategy;
    MockNavReader internal nav;

    function setUp() public virtual {
        whype = new MockWHYPE();
        nav = new MockNavReader();
        vault = new AsyncHypeVault(config());
        strategy = new MockStrategyAccount(address(vault), address(whype));
        vault.bindStrategyOnce(address(strategy));
    }

    function config() internal view returns (AsyncHypeVault.Config memory) {
        return AsyncHypeVault.Config(
            address(whype),
            address(this),
            address(this),
            address(this),
            address(this),
            address(this),
            address(nav),
            TREASURY,
            keccak256("mock strategy"),
            1000 ether,
            20 ether,
            1 hours,
            1 days,
            1 days
        );
    }

    function depositFor(address who, uint256 amount) internal returns (uint256 shares) {
        whype.mint(who, amount);
        VM.startPrank(who);
        whype.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        VM.stopPrank();
    }

    function requestFor(address who, uint256 shares) internal returns (uint256 id) {
        VM.prank(who);
        return vault.requestRedeem(shares, who, who);
    }

    function finish(uint256 returned) internal {
        VM.warp(block.timestamp + 1 days);
        VM.prank(KEEPER);
        vault.beginExit(vault.currentCycleId());
        strategy.complete(returned);
        VM.prank(KEEPER);
        vault.settleEpoch(vault.currentCycleId());
    }
}

contract AsyncHypeVaultTest is AsyncVaultFixture {
    function testInterfacesAndPreviewRules() public {
        require(type(IERC7540Operator).interfaceId == 0xe3bc4e65);
        require(type(IERC7540Redeem).interfaceId == 0x620ee8e4);
        require(type(IERC7575).interfaceId == bytes4(keccak256("share()")));
        require(vault.supportsInterface(0xe3bc4e65) && vault.supportsInterface(0x620ee8e4));
        require(vault.supportsInterface(0x2f0a18c5) && vault.supportsInterface(0x01ffc9a7));
        require(vault.supportsInterface(0x7965db0b));
        require(!vault.supportsInterface(0xce3bbe50) && !vault.supportsInterface(0xffffffff));
        require(vault.share() == address(vault) && vault.decimals() == 21);
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewRedeem(0);
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewWithdraw(0);
        depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        require(vault.maxDeposit(ALICE) == 0 && vault.maxMint(ALICE) == 0);
        require(vault.previewDeposit(1 ether) > 0 && vault.previewMint(1000) > 0);
        require(vault.convertToAssets(1000) > 0 && vault.convertToShares(1) > 0);
        VM.prank(ALICE);
        VM.expectRevert();
        vault.deposit(1, ALICE);
    }

    function testIdleRequestHasSeparateClaimAndFullSupplyBurn() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        uint256 id = requestFor(ALICE, shares);
        require(vault.pendingRedeemRequest(id, ALICE) == 0);
        require(vault.claimableRedeemRequest(id, ALICE) == shares);
        require(vault.totalSupply() == 0 && vault.balanceOf(ALICE) == 0);
        require(whype.balanceOf(ALICE) == 0 && vault.reservedClaimAssets() == 100 ether);
        VM.prank(ALICE);
        require(vault.redeem(shares, ALICE, ALICE) == 100 ether);
        require(vault.reservedClaimAssets() == 0 && vault.controllerEpoch(ALICE) == 0);
        VM.prank(ALICE);
        VM.expectRevert();
        vault.redeem(shares, ALICE, ALICE);
    }

    function testOperatorAndAllowanceHaveDifferentClaimRights() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        VM.prank(ALICE);
        vault.approve(KEEPER, shares);
        VM.prank(KEEPER);
        vault.requestRedeem(shares / 2, ALICE, ALICE);
        require(vault.allowance(ALICE, KEEPER) == shares / 2);
        VM.prank(KEEPER);
        VM.expectRevert(EpochRedeem.UnauthorizedController.selector);
        vault.redeem(shares / 2, KEEPER, ALICE);
        VM.prank(ALICE);
        vault.setOperator(KEEPER, true);
        VM.prank(KEEPER);
        vault.redeem(shares / 2, BOB, ALICE);
        VM.prank(KEEPER);
        vault.requestRedeem(shares / 2, ALICE, ALICE);
        require(vault.allowance(ALICE, KEEPER) == shares / 2, "operator spent allowance");
        VM.prank(ALICE);
        vault.setOperator(KEEPER, false);
        VM.prank(KEEPER);
        VM.expectRevert();
        vault.redeem(shares / 2, BOB, ALICE);
    }

    function testControllerOverloadUsesCallerFundsAndControllerEvent() public {
        VM.prank(ALICE);
        vault.setOperator(KEEPER, true);
        whype.mint(KEEPER, 2 ether);
        VM.startPrank(KEEPER);
        whype.approve(address(vault), 2 ether);
        VM.recordLogs();
        vault.deposit(1 ether, BOB, ALICE);
        VmAsync.Log[] memory logs = VM.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(vault)
                    && logs[i].topics[0] == keccak256("Deposit(address,address,uint256,uint256)")
            ) {
                require(logs[i].topics[1] == bytes32(uint256(uint160(ALICE))));
                found = true;
            }
        }
        require(found && whype.balanceOf(KEEPER) == 1 ether);
        uint256 assets = vault.mint(1000, BOB, ALICE);
        require(assets == 1 && vault.balanceOf(BOB) == 1000 ether + 1000);
        VM.stopPrank();
        VM.prank(BOB);
        VM.expectRevert();
        vault.deposit(1, BOB, ALICE);
    }

    function testSameEpochAggregatesAndOldClaimBlocksNewEpoch() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        vault.startCycle(80 ether);
        uint256 id = requestFor(ALICE, shares / 4);
        require(requestFor(ALICE, shares / 4) == id);
        require(vault.pendingRedeemRequest(id, ALICE) == shares / 2);
        finish(80 ether);
        require(vault.maxWithdraw(ALICE) == 50 ether);
        VM.prank(ALICE);
        VM.expectRevert(EpochRedeem.ControllerEpochOutstanding.selector);
        vault.requestRedeem(shares / 4, ALICE, ALICE);
        uint256 limit = vault.maxWithdraw(ALICE);
        VM.prank(ALICE);
        vault.withdraw(limit, ALICE, ALICE);
        requestFor(ALICE, shares / 2);
    }

    function testSettlementIncludesUnallocatedCashAndReservesSurviveNextCycle() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        depositFor(BOB, 100 ether);
        vault.startCycle(100 ether);
        requestFor(ALICE, shares);
        finish(120 ether);
        uint256 claim = vault.maxWithdraw(ALICE);
        require(claim > 109 ether && claim <= 110 ether);
        uint256 reserved = vault.reservedClaimAssets();
        uint256 cash = vault.availableCash();
        vault.startCycle(cash);
        require(whype.balanceOf(address(vault)) == reserved);
        VM.prank(ALICE);
        vault.redeem(shares, ALICE, ALICE);
        require(whype.balanceOf(ALICE) == claim && vault.reservedClaimAssets() == 0);
    }

    function testFullLossCanBeClaimedWithoutAssetsOrDivisionByZero() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        requestFor(ALICE, shares);
        finish(0);
        require(vault.maxWithdraw(ALICE) == 0 && vault.maxRedeem(ALICE) == shares);
        VM.prank(ALICE);
        require(vault.redeem(shares, ALICE, ALICE) == 0);
        require(vault.controllerEpoch(ALICE) == 0);
    }

    function testNoRequestCycleCanUnwindAndPauseDoesNotBlockClaims() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        finish(100 ether);
        require(vault.phase() == AsyncHypeVault.Phase.Idle);
        vault.permanentlyShutdown();
        require(vault.maxDeposit(ALICE) == 0);
        requestFor(ALICE, shares);
        VM.prank(ALICE);
        vault.redeem(shares, ALICE, ALICE);
        require(whype.balanceOf(ALICE) == 100 ether);
    }

    function testPendingAndLyingStrategyCannotSettle() public {
        depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        vault.beginExit(1); // guardian may exit early
        strategy.complete(100 ether);
        strategy.setPending(true);
        VM.expectRevert(AsyncHypeVault.StrategyNotReturnReady.selector);
        vault.settleEpoch(1);
        strategy.setPending(false);
        strategy.setLieAboutReturn(true);
        VM.expectRevert(AsyncHypeVault.ReturnAmountMismatch.selector);
        vault.settleEpoch(1);
        require(whype.balanceOf(address(strategy)) == 100 ether, "return did not roll back");
        strategy.setLieAboutReturn(false);
        vault.settleEpoch(1);
        VM.expectRevert();
        vault.settleEpoch(1);
    }

    function testDeadlineAndExitSealsRequests() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        VM.prank(KEEPER);
        VM.expectRevert(AsyncHypeVault.ExitNotReady.selector);
        vault.beginExit(1);
        vault.syncPhase();
        require(vault.phase() == AsyncHypeVault.Phase.Active);
        VM.warp(block.timestamp + 1 days);
        VM.prank(KEEPER);
        vault.beginExit(1);
        VM.prank(ALICE);
        VM.expectRevert(EpochRedeem.EpochClosed.selector);
        vault.requestRedeem(shares, ALICE, ALICE);
    }

    function testRecapitalizationCannotUseClaimsOrExceedCap() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        requestFor(ALICE, shares / 2);
        depositFor(BOB, 100 ether);
        vault.startCycle(100 ether);
        vault.beginExit(1);
        strategy.setRequiredRecapitalization(21 ether);
        VM.expectRevert(AsyncHypeVault.RecapitalizationCapExceeded.selector);
        vault.recapitalize(1);
        strategy.setRequiredRecapitalization(20 ether);
        vault.recapitalize(1);
        require(vault.availableCash() == 30 ether && vault.reservedClaimAssets() == 50 ether);
        strategy.setRequiredRecapitalization(1 ether);
        VM.expectRevert();
        vault.recapitalize(1);
        strategy.setRequiredRecapitalization(31 ether);
        VM.expectRevert();
        vault.recapitalize(1);
    }

    function testNavFailuresDoNotBlockEstablishedClaims() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        requestFor(ALICE, shares / 2);
        vault.startCycle(50 ether);
        require(vault.totalAssets() == 50 ether);
        nav.set(false, -60 ether);
        vault.checkpointNav();
        require(vault.totalAssets() == 0);
        nav.set(true, 0);
        vault.checkpointNav();
        require(vault.navQuality() == IHyperCoreNavReader.Quality.Unavailable);
        require(vault.convertToShares(1) > 0);
        VM.prank(ALICE);
        vault.redeem(shares / 2, ALICE, ALICE);
        require(whype.balanceOf(ALICE) == 50 ether);
    }

    function testNavReaderExplicitlyMarksActiveEstimate() public {
        HyperCoreNavReader reader = new HyperCoreNavReader();
        depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        IHyperCoreNavReader.Observation memory o = reader.observe(address(strategy));
        require(o.netAssets == 100 ether && o.quality == IHyperCoreNavReader.Quality.CapitalEstimate);
        require(o.asOfCoreBlock == 0);
    }

    function testBindingAndDirectShareTransferGuards() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        VM.prank(ALICE);
        VM.expectRevert(EpochRedeem.DirectShareTransferForbidden.selector);
        vault.transfer(address(vault), shares);
        VM.expectRevert(AsyncHypeVault.AlreadyBound.selector);
        vault.bindStrategyOnce(address(strategy));
        AsyncHypeVault unbound = new AsyncHypeVault(config());
        require(unbound.maxDeposit(ALICE) == 0);
        VM.expectRevert(AsyncHypeVault.InvalidConfiguration.selector);
        unbound.bindStrategyOnce(address(strategy));
    }
}

contract EpochAccountingTest is AsyncVaultFixture {
    function testFuzzMixedClaimsPreserveOwnEntitlement(uint96 a, uint96 b, uint96 gain, uint16 part) public {
        uint256 amountA = uint256(a) % 100 ether + 1;
        uint256 amountB = uint256(b) % 100 ether + 1;
        uint256 sa = depositFor(ALICE, amountA);
        uint256 sb = depositFor(BOB, amountB);
        vault.startCycle(amountA + amountB);
        requestFor(ALICE, sa);
        requestFor(BOB, sb);
        uint256 returned = uint256(gain) % 200 ether;
        finish(returned);
        uint256 owedA = vault.maxWithdraw(ALICE);
        uint256 owedB = vault.maxWithdraw(BOB);
        uint256 first = 1 + uint256(part) % sa;
        VM.prank(ALICE);
        vault.redeem(first, ALICE, ALICE);
        uint256 mid = vault.maxWithdraw(ALICE) / 2;
        if (mid > 0) {
            VM.prank(ALICE);
            vault.withdraw(mid, ALICE, ALICE);
        }
        uint256 remaining = vault.maxRedeem(ALICE);
        if (remaining > 0) {
            VM.prank(ALICE);
            vault.redeem(remaining, ALICE, ALICE);
        }
        uint256 remainingB = vault.maxRedeem(BOB);
        VM.prank(BOB);
        vault.redeem(remainingB, BOB, BOB);
        require(whype.balanceOf(ALICE) == owedA && whype.balanceOf(BOB) == owedB);
        require(owedA + owedB + vault.roundingReserve() == returned);
        vault.releaseRoundingDust();
        require(whype.balanceOf(TREASURY) == returned - owedA - owedB);
        require(vault.reservedClaimAssets() == 0 && whype.balanceOf(address(vault)) == 0);
    }

    function testDonationBeforeFirstDepositCannotMintZeroShares() public {
        whype.mint(address(vault), 1 ether);
        whype.mint(ALICE, 1);
        VM.startPrank(ALICE);
        whype.approve(address(vault), 1);
        VM.expectRevert(EpochRedeem.InvalidAmount.selector);
        vault.deposit(1, ALICE);
        VM.stopPrank();
    }
}

contract HypeRouterTest is AsyncVaultFixture {
    function testNativeRoundTripAndRouterCannotStealOtherController() public {
        HypeRouter router = new HypeRouter(vault);
        VM.deal(ALICE, 1 ether);
        VM.prank(ALICE);
        uint256 shares = router.depositHype{value: 1 ether}(ALICE, 1000 ether, block.timestamp);
        VM.prank(ALICE);
        vault.setOperator(address(router), true);
        VM.prank(ALICE);
        router.requestRedeem(shares);
        VM.prank(KEEPER);
        VM.expectRevert();
        router.redeemHype(shares, payable(KEEPER), 0, block.timestamp);
        VM.prank(ALICE);
        VM.expectRevert(HypeRouter.SlippageOrDeadline.selector);
        router.redeemHype(shares, payable(ALICE), 2 ether, block.timestamp);
        require(vault.maxRedeem(ALICE) == shares);
        whype.setRevertWithdrawals(true);
        VM.prank(ALICE);
        VM.expectRevert();
        router.redeemHype(shares, payable(ALICE), 0, block.timestamp);
        require(vault.maxRedeem(ALICE) == shares, "failed unwrap consumed claim");
        whype.setRevertWithdrawals(false);
        VM.prank(ALICE);
        router.redeemHype(shares, payable(ALICE), 1 ether, block.timestamp);
        require(ALICE.balance == 1 ether && whype.balanceOf(address(router)) == 0);
    }

    function testAnyoneCanPayFixedBeneficiary() public {
        uint256 shares = depositFor(ALICE, 100 ether);
        FixedReceiverController controller = new FixedReceiverController(vault, BOB);
        VM.prank(ALICE);
        vault.requestRedeem(shares, address(controller), ALICE);
        VM.prank(KEEPER);
        controller.claim();
        require(whype.balanceOf(BOB) == 100 ether && whype.balanceOf(KEEPER) == 0);
    }
}
