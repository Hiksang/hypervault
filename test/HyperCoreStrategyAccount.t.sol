// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {HyperCoreStrategyAccount} from "../src/HyperCoreStrategyAccount.sol";
import {HyperCoreNavReader} from "../src/HyperCoreNavReader.sol";
import {VaultFactory, VaultDeployer, StrategyDeployer} from "../src/VaultFactory.sol";
import {HyperCoreRiskOracle} from "../src/HyperCoreRiskOracle.sol";
import {CoreActions} from "../src/CoreActions.sol";
import {MockWHYPE} from "./helpers/MockWHYPE.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {MockHypeSystem} from "./helpers/MockHypeSystem.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";
import {EpochRedeem} from "../src/vault/EpochRedeem.sol";
import {CoreActionObserver} from "../src/CoreActionObserver.sol";

interface VmStrategy {
    function deal(address account, uint256 newBalance) external;
    function prank(address caller) external;
    function startPrank(address caller) external;
    function stopPrank() external;
    function warp(uint256 timestamp) external;
    function expectRevert() external;
    function expectRevert(bytes4 revertData) external;
    function expectRevert(bytes calldata revertData) external;
    function etch(address target, bytes calldata code) external;
}

contract CoreStrategyFixture {
    VmStrategy internal constant VM = VmStrategy(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant SPOT_BALANCE = address(0x0801);
    address internal constant ORACLE_PX = address(0x0807);
    address internal constant SPOT_PX = address(0x0808);
    address internal constant L1_BLOCK = address(0x0809);
    address internal constant BBO = address(0x080e);
    address internal constant CORE_USER_EXISTS = address(0x0810);
    address internal constant LENDING = address(0x0811);
    address internal constant POSITION = address(0x0813);

    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant KEEPER = address(0xBEEF);

    uint64 internal constant HYPE_TOKEN = 150;
    uint64 internal constant QUOTE_TOKEN = 0;
    uint32 internal constant HYPE_PERP = 159;
    uint32 internal constant HYPE_SPOT = 10_107;
    uint32 internal constant HYPE_SPOT_INDEX = 107;
    uint64 internal constant CORE_GAS_RESERVE = 1e8;
    uint64 internal constant STRATEGY_HYPE = 100e8;
    uint256 internal constant DEPOSIT = 100 ether;
    uint64 internal constant PERP_READ_PRICE = 10e4;
    uint64 internal constant SPOT_READ_PRICE = 10e6;

    MockWHYPE internal whype;
    MockCoreWriter internal writer;
    MockHypeSystem internal system;
    HyperCoreRiskOracle internal riskOracle;
    AsyncHypeVault internal vault;
    HyperCoreStrategyAccount internal strategy;
    uint64 internal l1Block;
    CoreActionObserver internal observer;

    function setUp() public virtual {
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
        observer = new CoreActionObserver();
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
        HyperCoreStrategyAccount.Config memory sc = strategyConfig();
        AsyncHypeVault.Config memory vc = vaultConfig(sc);
        vault = new AsyncHypeVault(vc);
        strategy = new HyperCoreStrategyAccount(address(vault), sc);
        vault.bindStrategyOnce(address(strategy));

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

        VM.deal(ALICE, DEPOSIT);
        VM.startPrank(ALICE);
        whype.deposit{value: DEPOSIT}();
        whype.approve(address(vault), DEPOSIT);
        vault.deposit(DEPOSIT, ALICE);
        VM.stopPrank();
    }

    function strategyConfig() internal view returns (HyperCoreStrategyAccount.Config memory) {
        return HyperCoreStrategyAccount.Config(
            address(whype),
            address(writer),
            address(system),
            address(riskOracle),
            0,
            HYPE_TOKEN,
            QUOTE_TOKEN,
            HYPE_PERP,
            HYPE_SPOT,
            CORE_GAS_RESERVE,
            10100,
            9900,
            10100,
            address(observer)
        );
    }

    function vaultConfig(HyperCoreStrategyAccount.Config memory sc) internal returns (AsyncHypeVault.Config memory) {
        return AsyncHypeVault.Config(
            address(whype),
            address(this),
            address(this),
            address(this),
            address(this),
            address(this),
            address(new HyperCoreNavReader()),
            address(0xFEE),
            keccak256(abi.encode(sc)),
            1000 ether,
            20 ether,
            1 hours,
            1 days,
            1 days
        );
    }

    function _activate() internal {
        vault.startCycle(DEPOSIT);
        require(system.bridgedToCore(address(strategy)) == DEPOSIT);
        require(system.bridgedToCore(address(vault)) == 0);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        strategy.submitPortfolioMarginActivation();
        vault.confirmPortfolioMargin(1);
        strategy.advance();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        strategy.advance();
        _advanceL1();
        _setPosition(-int64(STRATEGY_HYPE));
        strategy.advance();
        vault.syncPhase();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.Active);
    }

    function _closeAndWithdraw() internal {
        VM.warp(block.timestamp + 1 days);
        VM.prank(KEEPER);
        vault.beginExit(1);
        VM.prank(KEEPER);
        strategy.advance(); // Active -> Closing
        VM.prank(KEEPER);
        strategy.advance(); // submit close
        _advanceL1();
        _setPosition(0);
        strategy.advance(); // debt
        strategy.advance(); // withdraw
        strategy.advance(); // submit withdrawal
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        strategy.advance(); // conversion
        strategy.advance(); // recall phase
    }

    function _advanceL1() internal {
        unchecked {
            ++l1Block;
        }
        _setL1(l1Block);
    }

    function _setL1(uint64 number) internal {
        MockReadPrecompile(L1_BLOCK).setResponse(abi.encode(), abi.encode(number));
    }

    function _setExists(bool exists_) internal {
        MockReadPrecompile(CORE_USER_EXISTS).setResponse(abi.encode(address(strategy)), abi.encode(exists_));
    }

    function _setSpot(uint64 token, uint64 total, uint64 hold) internal {
        MockReadPrecompile(SPOT_BALANCE)
            .setResponse(abi.encode(address(strategy), token), abi.encode(total, hold, uint64(0)));
    }

    function _setLending(uint64 token, uint64 borrowValue, uint64 supplyValue) internal {
        MockReadPrecompile(LENDING)
            .setResponse(
                abi.encode(address(strategy), token), abi.encode(uint64(0), borrowValue, uint64(0), supplyValue)
            );
    }

    function _setPosition(int64 size) internal {
        require(size % 1e6 == 0, "test position is not aligned to HYPE size lots");
        _setRawPosition(size / 1e6);
    }

    function _setRawPosition(int64 size) internal {
        MockReadPrecompile(POSITION)
            .setResponse(
                abi.encode(address(strategy), HYPE_PERP), abi.encode(size, uint64(0), int64(0), uint32(1), false)
            );
    }

    function _setBbo(uint32 asset, uint64 bid, uint64 ask) internal {
        MockReadPrecompile(BBO).setResponse(abi.encode(asset), abi.encode(bid, ask));
    }
}

contract HyperCoreStrategyAccountTest is CoreStrategyFixture {
    function _driveToDebtSettlement() internal {
        _activate();
        vault.beginExit(1);
        strategy.advance();
        strategy.advance();
        _advanceL1();
        _setPosition(0);
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.SettlingDebt);
    }

    function testDebtSettlementReleasesOnlyNeededCollateralThenSells() public {
        _driveToDebtSettlement();
        uint64 debt = 50e8;
        _setLending(QUOTE_TOKEN, debt, 0);
        strategy.advance();

        (address account, bytes memory releaseAction,) = writer.latestAction();
        uint64 sellLimit = 990_000_000;
        uint64 rawNeeded =
            uint64((uint256(debt) * 1e8 * 10_100 + uint256(sellLimit) * 10_000 - 1) / (uint256(sellLimit) * 10_000));
        uint64 needed = uint64((uint256(rawNeeded) + 1e6 - 1) / 1e6 * 1e6);
        bytes memory expectedRelease = CoreActions.lend(CoreActions.LendingOperation.Withdraw, HYPE_TOKEN, needed);
        require(account == address(strategy));
        require(keccak256(releaseAction) == keccak256(expectedRelease), "wrong collateral release");

        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + 1e8, 0);
        VM.expectRevert();
        strategy.advance();
        require(writer.actionCount() == 5, "HYPE donation cleared pending release");

        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE - needed);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + needed, 0);
        strategy.advance();
        (, bytes memory sellAction,) = writer.latestAction();
        bytes memory expectedSell = CoreActions.order(HYPE_SPOT, false, sellLimit, needed, false, 3, 3);
        require(keccak256(sellAction) == keccak256(expectedSell), "wrong debt sale");

        _advanceL1();
        _setLending(QUOTE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.WithdrawingCollateral);
    }

    function testQuoteSupplyIsWithdrawnBeforeProfitConversion() public {
        _driveToDebtSettlement();
        strategy.advance();
        strategy.advance();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        strategy.advance();

        uint64 quoteProfit = 10e8;
        _setLending(QUOTE_TOKEN, 0, quoteProfit);
        strategy.advance();
        (, bytes memory withdrawQuote,) = writer.latestAction();
        require(
            keccak256(withdrawQuote) == keccak256(CoreActions.withdrawAll(QUOTE_TOKEN)), "idle quote supply was ignored"
        );

        _advanceL1();
        _setLending(QUOTE_TOKEN, 0, 0);
        _setSpot(QUOTE_TOKEN, quoteProfit, 0);
        strategy.advance();
        (, bytes memory buyAction,) = writer.latestAction();
        uint64 buyLimit = 1_010_000_000;
        uint64 buySize = uint64(uint256(quoteProfit) * 1e8 / buyLimit / 1e6 * 1e6);
        bytes memory expectedBuy = CoreActions.order(HYPE_SPOT, true, buyLimit, buySize, false, 3, 3);
        require(keccak256(buyAction) == keccak256(expectedBuy), "wrong profit conversion");

        _advanceL1();
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE + 1e8, 0);
        VM.expectRevert();
        strategy.advance();
        require(writer.actionCount() == 7, "HYPE donation cleared pending conversion");
    }

    function testPermissionlessDebtRecapitalizationUsesOnlyFreeWhype() public {
        _driveToDebtSettlement();
        uint64 debt = 1e8;
        _setLending(QUOTE_TOKEN, debt, 0);
        _setLending(HYPE_TOKEN, 0, 0);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        VM.expectRevert();
        strategy.advance();

        VM.deal(address(this), 1 ether);
        whype.depositTo{value: 1 ether}(address(vault));
        uint256 bridgedBefore = system.bridgedToCore(address(strategy));
        VM.prank(KEEPER);
        vault.recapitalize(1);
        require(system.bridgedToCore(address(strategy)) > bridgedBefore, "recapitalization not bridged");

        VM.prank(KEEPER);
        VM.expectRevert();
        vault.recapitalize(1);
        VM.prank(KEEPER);
        VM.expectRevert();
        strategy.advance();

        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE + 1e8, 0);
        VM.prank(KEEPER);
        strategy.advance();
        (address account, bytes memory sellAction,) = writer.latestAction();
        require(account == address(strategy), "recapitalization changed Core account");
        require(bytes4(sellAction) == bytes4(hex"01000001"), "debt sale not submitted");
    }

    function testRealContractsPermissionlessRoundTripAndCallerIdentity() public {
        _activate();
        uint256 shares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE);
        _closeAndWithdraw();
        (address account,,) = writer.latestAction();
        require(account == address(strategy), "Core account was not strategy");
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.RecallPending);
        VM.deal(address(strategy), DEPOSIT); // forced native is not an authenticated receipt
        _advanceL1();
        strategy.advance();
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.RecallPending);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        system.deliver(payable(address(strategy)), DEPOSIT);
        strategy.advance();
        strategy.advance(); // independently validate terminal state after receipt consumption
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.ReturnReady);
        require(whype.balanceOf(address(vault)) == 0, "strategy bypassed settlement");
        VM.prank(KEEPER);
        vault.settleEpoch(1);
        require(vault.reservedClaimAssets() == DEPOSIT);
        VM.prank(KEEPER);
        VM.expectRevert(EpochRedeem.UnauthorizedController.selector);
        vault.redeem(shares, KEEPER, ALICE);
        VM.prank(ALICE);
        vault.redeem(shares, ALICE, ALICE);
        require(whype.balanceOf(ALICE) == DEPOSIT);
        require(strategy.phase() == HyperCoreStrategyAccount.Phase.Idle);
        require(address(strategy).balance == DEPOSIT, "forced native was spent");
    }

    function testBootstrapDeadlineAllowsRecoveryBeforePM() public {
        vault.startCycle(DEPOSIT);
        uint256 shares = vault.balanceOf(ALICE);
        VM.prank(ALICE);
        vault.requestRedeem(shares, ALICE, ALICE);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        VM.expectRevert(HyperCoreStrategyAccount.StrategyNotEnabled.selector);
        strategy.advance();
        VM.warp(block.timestamp + 1 hours);
        VM.prank(KEEPER);
        vault.beginExit(1);
        strategy.advance(); // bridge -> close
        strategy.advance(); // no position -> debt
        strategy.advance(); // no debt -> withdraw
        strategy.advance(); // no supply -> convert
        strategy.advance(); // no quote -> recall
        strategy.advance(); // submit recall
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        system.deliver(payable(address(strategy)), DEPOSIT);
        strategy.advance();
        strategy.advance();
        VM.prank(KEEPER);
        vault.settleEpoch(1);
        require(vault.maxWithdraw(ALICE) == DEPOSIT);
    }

    function testUnknownSupplyCannotBeTimedOutIntoSuccess() public {
        vault.startCycle(DEPOSIT);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        strategy.submitPortfolioMarginActivation();
        vault.confirmPortfolioMargin(1);
        strategy.advance();
        uint256 count = writer.actionCount();
        VM.warp(block.timestamp + 2 days);
        VM.prank(KEEPER);
        vault.beginExit(1);
        _advanceL1();
        VM.expectRevert(HyperCoreStrategyAccount.CoreObservationPending.selector);
        strategy.advance();
        require(writer.actionCount() == count);
        require(strategy.cycleStatus().pending);
        VM.expectRevert();
        vault.settleEpoch(1);
    }

    function testPartialOpeningFillUnwindsAfterPauseWithoutNewRisk() public {
        vault.startCycle(DEPOSIT);
        _setSpot(HYPE_TOKEN, STRATEGY_HYPE + CORE_GAS_RESERVE, 0);
        strategy.submitPortfolioMarginActivation();
        vault.confirmPortfolioMargin(1);
        strategy.advance();
        _advanceL1();
        _setLending(HYPE_TOKEN, 0, STRATEGY_HYPE);
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        strategy.advance();
        _advanceL1();
        _setPosition(-int64(STRATEGY_HYPE / 2));
        vault.setRiskPaused(true);
        VM.expectRevert(HyperCoreStrategyAccount.RiskPaused.selector);
        strategy.advance();
        VM.prank(KEEPER);
        vault.beginExit(1);
        strategy.advance();
        strategy.advance();
        (address account, bytes memory action,) = writer.latestAction();
        require(account == address(strategy));
        require(
            keccak256(action)
                == keccak256(CoreActions.order(HYPE_PERP, true, 1_010_000_000, STRATEGY_HYPE / 2, true, 3, 2))
        );
    }

    function testOnlyVaultCanAllocateAttestOrReceive() public {
        VM.prank(KEEPER);
        VM.expectRevert(HyperCoreStrategyAccount.WrongVault.selector);
        strategy.startCycle(1, DEPOSIT, uint64(block.timestamp + 1 hours), uint64(block.timestamp + 1 days));
        VM.prank(KEEPER);
        VM.expectRevert(HyperCoreStrategyAccount.WrongVault.selector);
        strategy.returnToVault(1);
        VM.prank(KEEPER);
        VM.expectRevert(HyperCoreStrategyAccount.WrongVault.selector);
        strategy.confirmPortfolioMargin(1);
    }

    function testResidualQuoteCannotBeSilentlyGivenToNextCycle() public {
        _activate();
        _closeAndWithdraw();
        _setSpot(QUOTE_TOKEN, 1, 0); // below one executable lot; remains an unresolved integration gate
        strategy.advance(); // recall submits
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        system.deliver(payable(address(strategy)), DEPOSIT);
        strategy.advance(); // consume the observed recall once
        VM.expectRevert(HyperCoreStrategyAccount.ResidualExposure.selector);
        strategy.advance();
        require(!strategy.cycleStatus().pending);
        require(whype.balanceOf(address(strategy)) == DEPOSIT);
        VM.expectRevert();
        vault.settleEpoch(1);
    }

    function testNoRequestCycleStillUnwinds() public {
        _activate();
        _closeAndWithdraw();
        strategy.advance();
        _advanceL1();
        _setSpot(HYPE_TOKEN, CORE_GAS_RESERVE, 0);
        system.deliver(payable(address(strategy)), DEPOSIT);
        strategy.advance();
        strategy.advance();
        vault.settleEpoch(1);
        require(vault.availableCash() == DEPOSIT && vault.reservedClaimAssets() == 0);
        require(vault.maxDeposit(ALICE) > 0);
    }

    function testGasSponsorshipIsCappedAndDoesNotMintShares() public {
        uint256 supply = vault.totalSupply();
        VM.deal(KEEPER, 2 ether);
        VM.prank(KEEPER);
        strategy.sponsorGas{value: 1 ether}();
        require(vault.totalSupply() == supply && strategy.sponsoredGas() == 1 ether);
        VM.prank(KEEPER);
        VM.expectRevert();
        strategy.sponsorGas{value: 1}();
    }
}

contract VaultFactoryTest is CoreStrategyFixture {
    function testAtomicPairHasImmutableLinksAndFactoryHasNoRole() public {
        VaultDeployer vd = new VaultDeployer();
        StrategyDeployer sd = new StrategyDeployer();
        VaultFactory factory = new VaultFactory(vd, sd);
        HyperCoreStrategyAccount.Config memory sc = strategyConfig();
        AsyncHypeVault.Config memory vc = vaultConfig(sc);
        (AsyncHypeVault v, HyperCoreStrategyAccount s) = factory.createPair(vc, sc);
        require(address(v.strategy()) == address(s) && s.vault() == address(v));
        require(v.deploymentFactory() == address(factory));
        require(v.strategyConfigHash() == s.configHash());
        require(!v.hasRole(v.DEFAULT_ADMIN_ROLE(), address(factory)));
        require(!v.hasRole(v.MANAGER_ROLE(), address(factory)));
        require(v.phase() == AsyncHypeVault.Phase.Idle);
        VM.prank(address(factory));
        VM.expectRevert(AsyncHypeVault.AlreadyBound.selector);
        v.bindStrategyOnce(address(strategy));
        require(address(v).code.length < 24576 && address(s).code.length < 24576);
        require(address(vd).code.length < 24576 && address(sd).code.length < 24576);
        require(sd.firstPart().code.length < 24576 && sd.secondPart().code.length < 24576);
        bytes memory first = sd.firstPart().code;
        bytes memory second = sd.secondPart().code;
        require(first[0] == 0 && second[0] == 0, "bytecode stores must be inert");
        bytes memory rebuilt = new bytes(first.length + second.length - 2);
        for (uint256 i = 1; i < first.length; ++i) {
            rebuilt[i - 1] = first[i];
        }
        for (uint256 i = 1; i < second.length; ++i) {
            rebuilt[first.length + i - 2] = second[i];
        }
        require(keccak256(rebuilt) == keccak256(type(HyperCoreStrategyAccount).creationCode));
        require(address(sd).code.length < 2048, "large creation payload leaked into deployer runtime");
    }
}
