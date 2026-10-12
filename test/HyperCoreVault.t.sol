// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {HyperCoreVault} from "../src/HyperCoreVault.sol";
import {HyperCoreRiskOracle} from "../src/HyperCoreRiskOracle.sol";
import {CoreActions} from "../src/CoreActions.sol";
import {MockWHYPE} from "./helpers/MockWHYPE.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {MockHypeSystem} from "./helpers/MockHypeSystem.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

interface VmVault {
    function deal(address account, uint256 newBalance) external;
    function prank(address caller) external;
    function startPrank(address caller) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function etch(address target, bytes calldata code) external;
}

contract HyperCoreVaultTest {
    VmVault private constant VM = VmVault(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant SPOT_BALANCE = address(0x0801);
    address private constant ORACLE_PX = address(0x0807);
    address private constant SPOT_PX = address(0x0808);
    address private constant L1_BLOCK = address(0x0809);
    address private constant BBO = address(0x080e);
    address private constant CORE_USER_EXISTS = address(0x0810);
    address private constant LENDING = address(0x0811);
    address private constant POSITION = address(0x0813);

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant KEEPER = address(0xBEEF);

    uint64 private constant HYPE_TOKEN = 150;
    uint64 private constant QUOTE_TOKEN = 0;
    uint32 private constant HYPE_PERP = 159;
    uint32 private constant HYPE_SPOT = 10_107;
    uint32 private constant HYPE_SPOT_INDEX = 107;
    uint64 private constant CORE_GAS_RESERVE = 1e8;
    uint64 private constant STRATEGY_HYPE = 100e8;
    uint256 private constant DEPOSIT = 100 ether;
    uint64 private constant PERP_READ_PRICE = 10e4;
    uint64 private constant SPOT_READ_PRICE = 10e6;

    MockWHYPE private whype;
    MockCoreWriter private writer;
    MockHypeSystem private system;
    HyperCoreRiskOracle private riskOracle;
    HyperCoreVault private vault;
    uint64 private l1Block;

    function setUp() public {
        MockReadPrecompile template = new MockReadPrecompile();
        bytes memory runtime = address(template).code;
        VM.etch(SPOT_BALANCE, runtime);
        VM.etch(ORACLE_PX, runtime);
        VM.etch(SPOT_PX, runtime);
        VM.etch(L1_BLOCK, runtime);
        VM.etch(BBO, runtime);
        VM.etch(CORE_USER_EXISTS, runtime);
        VM.etch(LENDING, runtime);
        VM.etch(POSITION, runtime);

        whype = new MockWHYPE();
        writer = new MockCoreWriter();
        system = new MockHypeSystem();
        riskOracle = new HyperCoreRiskOracle(
            HyperCoreRiskOracle.Config({
                perp: HyperCoreRiskOracle.MarketConfig({
                    actionAsset: HYPE_PERP,
                    referenceIndex: HYPE_PERP,
                    readToOrderMultiplier: 1e4,
                    maxPriceDecimals: 4,
                    orderSizeLot: 1e6
                }),
                spot: HyperCoreRiskOracle.MarketConfig({
                    actionAsset: HYPE_SPOT,
                    referenceIndex: HYPE_SPOT_INDEX,
                    readToOrderMultiplier: 1e2,
                    maxPriceDecimals: 6,
                    orderSizeLot: 1e6
                }),
                maxSlippageBps: 100,
                maxBboDeviationBps: 200
            })
        );
        HyperCoreVault.Config memory config = HyperCoreVault.Config({
            wrappedHype: address(whype),
            coreWriter: address(writer),
            hypeSystem: address(system),
            riskOracle: address(riskOracle),
            initialOwner: address(this),
            expectedChainId: 0,
            minimumDeposit: 1e10,
            maximumTotalAssets: 1_000 ether,
            cycleDuration: 1 days,
            hypeToken: HYPE_TOKEN,
            quoteToken: QUOTE_TOKEN,
            hypePerpAsset: HYPE_PERP,
            hypeSpotAsset: HYPE_SPOT,
            coreGasReserve: CORE_GAS_RESERVE,
            debtDust: 0,
            quoteDust: 100,
            collateralDust: 0,
            repayBufferBps: 10_100,
            minHedgeBps: 9_900,
            maxHedgeBps: 10_100
        });
        vault = new HyperCoreVault(config);

        l1Block = 1;
        _setL1(l1Block);
        _setExists(true);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        _setSpot(QUOTE_TOKEN, 0, 0);
        _setLending(HYPE_TOKEN, 0, 0);
        _setLending(QUOTE_TOKEN, 0, 0);
        _setPosition(0);
        _setBbo(HYPE_PERP, PERP_READ_PRICE, PERP_READ_PRICE);
        _setBbo(HYPE_SPOT, SPOT_READ_PRICE, SPOT_READ_PRICE);
        MockReadPrecompile(ORACLE_PX).setResponse(abi.encode(HYPE_PERP), abi.encode(PERP_READ_PRICE));
        MockReadPrecompile(SPOT_PX).setResponse(abi.encode(HYPE_SPOT_INDEX), abi.encode(SPOT_READ_PRICE));

        vault.submitPortfolioMarginActivation();
        vault.enableLiveStrategy();

        VM.deal(ALICE, DEPOSIT);
        VM.startPrank(ALICE);
        whype.deposit{value: DEPOSIT}();
        whype.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, ALICE, 0);
        VM.stopPrank();
    }

    function testPermissionlessFullExitPaysFixedReceiver() public {
        _activateStrategy();
        uint256 requestedShares = vault.balanceOf(ALICE) / 2;
        VM.prank(ALICE);
        uint256 requestId = vault.requestRedeem(requestedShares, BOB, ALICE, false);

        VM.warp(block.timestamp + 1 days);
        VM.prank(KEEPER);
        vault.beginExit();
        VM.prank(KEEPER);
        vault.processHedgeClose();
        require(writer.actionCount() == 4, "close action missing");

        (address account, bytes memory action,) = writer.latestAction();
        bytes memory expected = CoreActions.order(HYPE_PERP, true, 1_010_000_000, STRATEGY_HYPE, true, 3, 2);
        require(account == address(vault), "writer account must be vault");
        require(keccak256(action) == keccak256(expected), "unsafe close payload");

        _advanceL1();
        _setPosition(0);
        VM.prank(KEEPER);
        vault.processHedgeClose();
        require(vault.phase() == HyperCoreVault.Phase.SettlingDebt);

        VM.prank(KEEPER);
        vault.processDebtSettlement();
        require(vault.phase() == HyperCoreVault.Phase.WithdrawingCollateral);

        VM.prank(KEEPER);
        vault.processCollateralWithdrawal();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        VM.prank(KEEPER);
        vault.processCollateralWithdrawal();
        require(vault.phase() == HyperCoreVault.Phase.ConvertingQuote);

        VM.prank(KEEPER);
        vault.processQuoteConversion();
        require(vault.phase() == HyperCoreVault.Phase.Recalling);
        VM.prank(KEEPER);
        vault.submitRecall();
        require(vault.phase() == HyperCoreVault.Phase.RecallPending);

        // Forced/native donations cannot spoof the authenticated HYPE-system receipt counter.
        VM.deal(address(vault), address(vault).balance + DEPOSIT);
        _advanceL1();
        VM.prank(KEEPER);
        vault.syncCoreState();
        require(vault.phase() == HyperCoreVault.Phase.RecallPending, "donation spoofed recall");

        system.deliver(payable(address(vault)), DEPOSIT);
        VM.prank(KEEPER);
        vault.syncCoreState();
        require(vault.phase() == HyperCoreVault.Phase.Idle);
        require(vault.reservedClaimAssets() == 50 ether, "claim reserve mismatch");

        VM.prank(KEEPER);
        uint256 claimed = vault.claimRedeem(requestId);
        require(claimed == 50 ether, "wrong realized epoch rate");
        require(whype.balanceOf(BOB) == 50 ether, "keeper changed receiver");
        require(vault.reservedClaimAssets() == 0, "claim reserve not released");
    }

    function testActionDoesNotAdvanceWithoutNewObservedState() public {
        vault.startStrategy(DEPOSIT);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        vault.observeBridgeAndSupply();
        uint256 actionCount = writer.actionCount();

        VM.expectRevert();
        vault.processOpeningHedge();
        require(writer.actionCount() == actionCount, "same-block duplicate");

        _advanceL1();
        VM.expectRevert();
        vault.processOpeningHedge();
        require(writer.actionCount() == actionCount, "unobserved duplicate");
    }

    function testCancelReturnsSharesToOwnerRatherThanReceiver() public {
        _activateStrategy();
        uint256 balanceBefore = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        uint256 requestId = vault.requestRedeem(balanceBefore / 2, BOB, ALICE, false);

        VM.prank(BOB);
        VM.expectRevert();
        vault.cancelRedeem(requestId);

        VM.prank(ALICE);
        vault.cancelRedeem(requestId);
        require(vault.balanceOf(ALICE) == balanceBefore, "shares not restored to owner");
        require(vault.balanceOf(BOB) == 0, "receiver stole cancelled shares");
    }

    function testDirectShareTransferToVaultIsRejected() public {
        VM.prank(ALICE);
        VM.expectRevert();
        vault.transfer(address(vault), 1);
    }

    function testShutdownDoesNotBlockIdleRedemption() public {
        vault.permanentlyShutdown();
        uint256 shares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        uint256 assets = vault.redeem(shares, ALICE, ALICE, false, DEPOSIT);
        require(assets == DEPOSIT);
        require(whype.balanceOf(ALICE) == DEPOSIT);
    }

    function testPauseCannotBlockExitRequestOrProcessing() public {
        _activateStrategy();
        vault.pauseNewCapital();
        uint256 shares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE, false);
        VM.warp(block.timestamp + 1 days);
        VM.prank(KEEPER);
        vault.beginExit();
        VM.prank(KEEPER);
        vault.processHedgeClose();
        require(writer.actionCount() == 4);
    }

    function testDepositCapAndCoreDustFailClosed() public {
        VM.deal(BOB, 901 ether);
        VM.startPrank(BOB);
        whype.deposit{value: 901 ether}();
        whype.approve(address(vault), type(uint256).max);
        VM.expectRevert();
        vault.deposit(901 ether, BOB, 0);
        VM.stopPrank();

        uint256 shares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.redeem(shares, ALICE, ALICE, false, 0);
        VM.deal(BOB, 1 ether + 1);
        VM.startPrank(BOB);
        whype.deposit{value: 1 ether + 1}();
        whype.approve(address(vault), type(uint256).max);
        vault.deposit(1 ether + 1, BOB, 0);
        VM.stopPrank();
        VM.expectRevert();
        vault.startStrategy(1 ether + 1);
    }

    function testDebtSettlementReleasesOnlyNeededCollateralThenSells() public {
        _driveToDebtSettlement();
        uint64 debt = 50e8;
        _setLending(QUOTE_TOKEN, debt, 0);
        vault.processDebtSettlement();

        (address account, bytes memory releaseAction,) = writer.latestAction();
        uint64 sellLimit = 990_000_000;
        uint64 rawNeeded =
            uint64((uint256(debt) * 1e8 * 10_100 + uint256(sellLimit) * 10_000 - 1) / (uint256(sellLimit) * 10_000));
        uint64 needed = uint64((uint256(rawNeeded) + 1e6 - 1) / 1e6 * 1e6);
        bytes memory expectedRelease = CoreActions.lend(CoreActions.LendingOperation.Withdraw, HYPE_TOKEN, needed);
        require(account == address(vault));
        require(keccak256(releaseAction) == keccak256(expectedRelease), "wrong collateral release");

        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + 1e8, 0);
        VM.expectRevert();
        vault.processDebtSettlement();
        require(writer.actionCount() == 5, "HYPE donation cleared pending release");

        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE - needed);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + needed, 0);
        vault.processDebtSettlement();
        (, bytes memory sellAction,) = writer.latestAction();
        bytes memory expectedSell = CoreActions.order(HYPE_SPOT, false, sellLimit, needed, false, 3, 3);
        require(keccak256(sellAction) == keccak256(expectedSell), "wrong debt sale");

        _advanceL1();
        _setLending(QUOTE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        vault.processDebtSettlement();
        require(vault.phase() == HyperCoreVault.Phase.WithdrawingCollateral);
    }

    function testQuoteSupplyIsWithdrawnBeforeProfitConversion() public {
        _driveToDebtSettlement();
        vault.processDebtSettlement();
        vault.processCollateralWithdrawal();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        vault.processCollateralWithdrawal();

        uint64 quoteProfit = 10e8;
        _setLending(QUOTE_TOKEN, 0, quoteProfit);
        vault.processQuoteConversion();
        (, bytes memory withdrawQuote,) = writer.latestAction();
        require(
            keccak256(withdrawQuote) == keccak256(CoreActions.withdrawAll(QUOTE_TOKEN)), "idle quote supply was ignored"
        );

        _advanceL1();
        _setLending(QUOTE_TOKEN, 0, 0);
        _setSpot(QUOTE_TOKEN, quoteProfit, 0);
        vault.processQuoteConversion();
        (, bytes memory buyAction,) = writer.latestAction();
        uint64 buyLimit = 1_010_000_000;
        uint64 buySize = uint64(uint256(quoteProfit) * 1e8 / buyLimit / 1e6 * 1e6);
        bytes memory expectedBuy = CoreActions.order(HYPE_SPOT, true, buyLimit, buySize, false, 3, 3);
        require(keccak256(buyAction) == keccak256(expectedBuy), "wrong profit conversion");

        _advanceL1();
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE + 1e8, 0);
        VM.expectRevert();
        vault.processQuoteConversion();
        require(writer.actionCount() == 7, "HYPE donation cleared pending conversion");
    }

    function testSubLotQuoteResidualCannotBlockRecall() public {
        _driveToDebtSettlement();
        vault.processDebtSettlement();
        vault.processCollateralWithdrawal();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        vault.processCollateralWithdrawal();

        _setSpot(QUOTE_TOKEN, 1e6, 0); // Above quoteDust, below one 0.01-HYPE lot at the guarded price.
        uint256 actionsBefore = writer.actionCount();
        vault.processQuoteConversion();
        require(vault.phase() == HyperCoreVault.Phase.Recalling, "sub-lot quote blocked exit");
        require(writer.actionCount() == actionsBefore, "zero-size order submitted");
    }

    function testShutdownCannotStrandAnInFlightOpening() public {
        vault.startStrategy(DEPOSIT);
        VM.expectRevert();
        vault.permanentlyShutdown();
        require(!vault.shutdown(), "invalid shutdown persisted");
    }

    function testFullStrategyLossCanStillSettleEpoch() public {
        _driveToDebtSettlement();
        vault.processDebtSettlement();
        vault.processCollateralWithdrawal();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        vault.processCollateralWithdrawal();
        vault.processQuoteConversion();
        vault.submitRecall();

        require(vault.phase() == HyperCoreVault.Phase.Idle, "zero-asset epoch stuck");
        require(vault.totalSupply() == 0, "lost shares not settled");
        uint256 claimed = vault.claimRedeem(1);
        require(claimed == 0, "loss epoch created assets");
    }

    function testAnyoneCanSponsorCoreExitGas() public {
        VM.deal(KEEPER, 1 ether);
        VM.prank(KEEPER);
        vault.seedCoreAccount{value: 1 ether}();
        require(system.bridgedToCore(address(vault)) == 1 ether, "sponsorship not credited to vault");
    }

    function testStrategyCannotConsumeDepositorPrincipalAsCoreGasReserve() public {
        _setSpot(HYPE_TOKEN, 0, 0);
        VM.expectRevert();
        vault.startStrategy(DEPOSIT);
        require(vault.phase() == HyperCoreVault.Phase.Idle, "failed start changed phase");
        require(whype.balanceOf(address(vault)) == DEPOSIT, "failed start moved principal");
    }

    function testStrategyRejectsStaleCoreExposure() public {
        _setPosition(1e8);
        VM.expectRevert(HyperCoreVault.CoreObservationPending.selector);
        vault.startStrategy(DEPOSIT);
        require(vault.phase() == HyperCoreVault.Phase.Idle, "failed start changed phase");
        require(whype.balanceOf(address(vault)) == DEPOSIT, "failed start moved principal");
        require(system.bridgedToCore(address(vault)) == 0, "failed start bridged principal");
    }

    function testPermissionlessDebtRecapitalizationUsesOnlyFreeWhype() public {
        _driveToDebtSettlement();
        uint64 debt = 1e8;
        _setLending(QUOTE_TOKEN, debt, 0);
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        VM.expectRevert();
        vault.processDebtSettlement();

        VM.deal(address(this), 1 ether);
        whype.depositTo{value: 1 ether}(address(vault));
        uint256 bridgedBefore = system.bridgedToCore(address(vault));
        VM.prank(KEEPER);
        vault.recapitalizeDebt();
        require(system.bridgedToCore(address(vault)) > bridgedBefore, "recapitalization not bridged");

        VM.prank(KEEPER);
        VM.expectRevert(HyperCoreVault.CoreObservationPending.selector);
        vault.recapitalizeDebt();
        VM.prank(KEEPER);
        VM.expectRevert(HyperCoreVault.CoreObservationPending.selector);
        vault.processDebtSettlement();

        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + 1e8, 0);
        VM.prank(KEEPER);
        vault.processDebtSettlement();
        (address account, bytes memory sellAction,) = writer.latestAction();
        require(account == address(vault), "recapitalization changed Core account");
        require(bytes4(sellAction) == bytes4(hex"01000001"), "debt sale not submitted");
    }

    function testActiveConversionViewsFailInsteadOfReportingPartialNav() public {
        _activateStrategy();
        VM.expectRevert();
        vault.convertToAssets(1);
        VM.expectRevert();
        vault.convertToShares(1 ether);
    }

    function _activateStrategy() private {
        vault.startStrategy(DEPOSIT);
        require(system.bridgedToCore(address(vault)) == DEPOSIT, "bridge did not originate from vault");

        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        vault.observeBridgeAndSupply();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        vault.processOpeningHedge();
        _advanceL1();
        _setPosition(-int64(STRATEGY_HYPE));
        vault.activateStrategy();
        require(vault.phase() == HyperCoreVault.Phase.Active);
    }

    function _driveToDebtSettlement() private {
        _activateStrategy();
        uint256 shares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE, false);
        VM.warp(block.timestamp + 1 days);
        vault.beginExit();
        vault.processHedgeClose();
        _advanceL1();
        _setPosition(0);
        vault.processHedgeClose();
        require(vault.phase() == HyperCoreVault.Phase.SettlingDebt);
    }

    function _advanceL1() private {
        unchecked {
            ++l1Block;
        }
        _setL1(l1Block);
    }

    function _setL1(uint64 number) private {
        MockReadPrecompile(L1_BLOCK).setResponse(abi.encode(), abi.encode(number));
    }

    function _setExists(bool exists_) private {
        MockReadPrecompile(CORE_USER_EXISTS).setResponse(abi.encode(address(vault)), abi.encode(exists_));
    }

    function _setSpot(uint64 token, uint64 total, uint64 hold) private {
        MockReadPrecompile(SPOT_BALANCE)
            .setResponse(abi.encode(address(vault), token), abi.encode(total, hold, uint64(0)));
    }

    function _setLending(uint64 token, uint64 borrowValue, uint64 supplyValue) private {
        MockReadPrecompile(LENDING)
            .setResponse(abi.encode(address(vault), token), abi.encode(uint64(0), borrowValue, uint64(0), supplyValue));
    }

    function _setPosition(int64 size) private {
        require(size % 1e6 == 0, "test position is not aligned to HYPE size lots");
        MockReadPrecompile(POSITION)
            .setResponse(
                abi.encode(address(vault), HYPE_PERP), abi.encode(size / 1e6, uint64(0), int64(0), uint32(1), false)
            );
    }

    function _setBbo(uint32 asset, uint64 bid, uint64 ask) private {
        MockReadPrecompile(BBO).setResponse(abi.encode(asset), abi.encode(bid, ask));
    }
}
