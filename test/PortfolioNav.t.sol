// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncVaultFixture} from "./AsyncHypeVault.t.sol";
import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {MockStrategyAccount} from "./helpers/MockStrategyAccount.sol";
import {IHyperCoreNavReader} from "../src/interfaces/IHyperCoreNavReader.sol";
import {IStrategyBalanceSheet} from "../src/interfaces/IStrategyBalanceSheet.sol";
import {PortfolioNavReader} from "../src/PortfolioNavReader.sol";
import {PortfolioNavMath} from "../src/nav/PortfolioNavMath.sol";
import {HyperCoreNavReader} from "../src/HyperCoreNavReader.sol";
import {MockReadPrecompile} from "./helpers/MockReadPrecompile.sol";

contract MockBalanceSheet is IStrategyBalanceSheet {
    Snapshot private _snapshot;
    bool public fail;

    function set(Snapshot memory s) external {
        _snapshot = s;
    }

    function setFailure(bool f) external {
        fail = f;
    }

    function snapshot(address) external view returns (Snapshot memory) {
        require(!fail, "source unavailable");
        return _snapshot;
    }
}

contract NavMathHarness {
    function net(IStrategyBalanceSheet.Balances memory b) external pure returns (int256) {
        return PortfolioNavMath.netQuote(b);
    }

    function convert(int256 value, uint256 price, uint8 decimals) external pure returns (int256) {
        return PortfolioNavMath.toAssets(value, price, decimals);
    }
}

contract PortfolioNavReaderTest is AsyncVaultFixture {
    MockBalanceSheet internal source;
    PortfolioNavReader internal reader;
    IStrategyBalanceSheet.Snapshot internal sample;

    function setUp() public override {
        super.setUp();
        VM.warp(10_000);
        MockReadPrecompile template = new MockReadPrecompile();
        VM.etch(address(0x0809), address(template).code);
        MockReadPrecompile(address(0x0809)).setResponse(abi.encode(), abi.encode(uint64(20)));
        source = new MockBalanceSheet();
        reader = new PortfolioNavReader(address(whype), source, 60);
        depositFor(ALICE, 100 ether);
        vault.startCycle(100 ether);
        sample.account = address(strategy);
        sample.asset = address(whype);
        sample.strategyConfigHash = strategy.configHash();
        sample.cycleId = 1;
        sample.coreBlock = 20;
        sample.observedAt = uint64(block.timestamp);
        sample.complete = true;
        sample.assetPrice = 50e18;
        sample.balances = IStrategyBalanceSheet.Balances(50e18, 4950e18, 300e18, 500e18, 10e18, 50e18, 100e18, 10e18);
        source.set(sample);
    }

    function testMarkedNavAccountsForDebtFundingFeesReserveAndEvmCash() public {
        whype.mint(address(strategy), 2 ether);
        IHyperCoreNavReader.Observation memory o = reader.observe(address(strategy));
        require(o.netAssets == 99 ether); // 4,850 quote / 50 + 2 EVM WHYPE
        require(o.quality == IHyperCoreNavReader.Quality.MarkToMarket);
        require(o.asOfCoreBlock == 20 && o.cycleId == 1 && o.observedAt == block.timestamp && !o.inFlight);
    }

    function testNegativeEquityIsPreserved() public {
        sample.balances.debtValue += 5000e18;
        source.set(sample);
        require(reader.observe(address(strategy)).netAssets == -3 ether);
    }

    function testFuzzRejectsWrongScope(uint8 raw) public {
        uint8 kind = raw % 8;
        if (kind == 0) sample.account = BOB;
        if (kind == 1) sample.asset = BOB;
        if (kind == 2) sample.strategyConfigHash = bytes32(uint256(1));
        if (kind == 3) sample.cycleId = 2;
        if (kind == 4) sample.complete = false;
        if (kind == 5) sample.inFlight = true;
        if (kind == 6) sample.coreBlock = 19;
        if (kind == 7) sample.coreBlock = 21;
        source.set(sample);
        VM.expectRevert(PortfolioNavReader.InvalidSnapshot.selector);
        reader.observe(address(strategy));
    }

    function testStaleFutureAndZeroTimestampsFailClosed() public {
        sample.observedAt = uint64(block.timestamp - 61);
        _expectInvalid();
        sample.observedAt = uint64(block.timestamp + 1);
        _expectInvalid();
        sample.observedAt = 0;
        _expectInvalid();
        sample.observedAt = uint64(block.timestamp - 60);
        source.set(sample);
        require(reader.observe(address(strategy)).quality == IHyperCoreNavReader.Quality.MarkToMarket);
    }

    function _expectInvalid() private {
        source.set(sample);
        VM.expectRevert(PortfolioNavReader.InvalidSnapshot.selector);
        reader.observe(address(strategy));
    }

    function testMissingSourceCoreReadAndZeroPriceDoNotProduceZeroNav() public {
        source.setFailure(true);
        VM.expectRevert();
        reader.observe(address(strategy));
        source.setFailure(false);
        MockReadPrecompile(address(0x0809)).setRevert(abi.encode(), true);
        VM.expectRevert();
        reader.observe(address(strategy));
        MockReadPrecompile(address(0x0809)).setResponse(abi.encode(), abi.encode(uint64(20)));
        sample.assetPrice = 0;
        source.set(sample);
        VM.expectRevert(PortfolioNavMath.InvalidAssetPrice.selector);
        reader.observe(address(strategy));
    }

    function testInFlightAndExitFallBackToExplicitEstimate() public {
        source.setFailure(true);
        strategy.setPending(true);
        IHyperCoreNavReader.Observation memory o = reader.observe(address(strategy));
        require(o.quality == IHyperCoreNavReader.Quality.CapitalEstimate && o.inFlight && o.netAssets == 100 ether);
        strategy.setPending(false);
        vault.beginExit(1);
        require(reader.observe(address(strategy)).quality == IHyperCoreNavReader.Quality.CapitalEstimate);
    }

    function testRealizedReturnUsesCashEvenWhenSourceFailsButNotWhilePending() public {
        source.setFailure(true);
        vault.beginExit(1);
        strategy.complete(80 ether);
        IHyperCoreNavReader.Observation memory o = reader.observe(address(strategy));
        require(o.quality == IHyperCoreNavReader.Quality.Realized && o.netAssets == 80 ether);
        strategy.setPending(true);
        require(reader.observe(address(strategy)).quality == IHyperCoreNavReader.Quality.Unavailable);
        HyperCoreNavReader defaultReader = new HyperCoreNavReader();
        require(defaultReader.observe(address(strategy)).quality == IHyperCoreNavReader.Quality.Unavailable);
    }

    function testConfiguredReaderFeedsVaultAndPreservesEstablishedClaims() public {
        AsyncHypeVault.Config memory c = config();
        c.navReader = address(reader);
        vault = new AsyncHypeVault(c);
        strategy = new MockStrategyAccount(address(vault), address(whype));
        vault.bindStrategyOnce(address(strategy));
        uint256 shares = depositFor(ALICE, 100 ether);
        requestFor(ALICE, shares / 2);
        vault.startCycle(40 ether);
        sample.account = address(strategy);
        delete sample.balances;
        sample.balances.suppliedValue = 1900e18; // 38 HYPE + 10 idle shareholder cash
        source.set(sample);
        vault.checkpointNav();
        require(vault.totalAssets() == 48 ether && vault.reservedClaimAssets() == 50 ether);
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.MarkToMarket);
        source.setFailure(true);
        vault.checkpointNav();
        require(vault.navQuality() == IHyperCoreNavReader.Quality.Unavailable && vault.totalAssets() == 48 ether);
        VM.prank(ALICE);
        vault.redeem(shares / 2, ALICE, ALICE);
        require(whype.balanceOf(ALICE) == 50 ether && vault.reservedClaimAssets() == 0);
        finish(35 ether);
        require(vault.totalAssets() == 45 ether && vault.lastStrategyNav() == 0);
    }
}

contract NavMathTest {
    NavMathHarness internal math = new NavMathHarness();

    function testDollarHedgeIsNotHypeUnitProtection() public view {
        require(math.convert(5000e18, 50e18, 18) == 100 ether);
        require(math.convert(5000e18, 100e18, 18) == 50 ether);
        require(math.convert(5000e18, 1e18, 6) == 5000e6);
    }

    function testFuzzSignedConversionRoundsDown(int96 raw, uint64 rawPrice, uint8 rawDecimals) public view {
        int256 value = int256(raw);
        uint256 price = uint256(rawPrice) + 1;
        uint8 decimals = rawDecimals % 19;
        int256 scale = int256(10 ** decimals);
        int256 result = math.convert(value, price, decimals);
        // Independent bound: output * price <= exact numerator < (output + 1) * price.
        require(result * int256(price) <= value * scale);
        require((result + 1) * int256(price) > value * scale);
    }

    function testIntMinAndFractionalDebt() public view {
        require(math.convert(type(int256).min, 1e18, 18) == type(int256).min);
        require(math.convert(-1, 3e18, 18) == -1);
        require(math.convert(1, 3e18, 18) == 0);
    }

    function testFuzzLiabilitiesCannotIncreaseEquity(uint96 debt, uint96 fee) public view {
        IStrategyBalanceSheet.Balances memory b;
        b.spotValue = 5000e18;
        int256 beforeValue = math.net(b);
        b.debtValue = debt;
        b.accruedFees = fee;
        require(math.net(b) == beforeValue - int256(uint256(debt)) - int256(uint256(fee)));
    }
}

contract VaultNavValidationTest is AsyncVaultFixture {
    IHyperCoreNavReader.Observation internal sample;

    function setUp() public override {
        super.setUp();
        VM.warp(10_000);
        MockReadPrecompile template = new MockReadPrecompile();
        VM.etch(address(0x0809), address(template).code);
        MockReadPrecompile(address(0x0809)).setResponse(abi.encode(), abi.encode(uint64(20)));
        depositFor(ALICE, 100 ether);
        vault.startCycle(80 ether);
        vault.syncPhase();
        sample = IHyperCoreNavReader.Observation(
            70 ether, 20, uint64(block.timestamp), IHyperCoreNavReader.Quality.MarkToMarket, false, 1
        );
    }

    function _checkpoint() private {
        nav.setObservation(sample);
        vault.checkpointNav();
    }

    function testFreshMarkDoesNotOpenActiveDeposits() public {
        _checkpoint();
        require(vault.totalAssets() == 90 ether);
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.MarkToMarket);
        require(vault.maxDeposit(BOB) == 0 && vault.maxMint(BOB) == 0);
        VM.warp(block.timestamp + vault.MAX_NAV_AGE() + 1);
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Unavailable);
        require(vault.totalAssets() == 90 ether, "stale cache zeroed");
    }

    function testCoreAdvanceOrReadFailureInvalidatesMarkWithoutKeeper() public {
        _checkpoint();
        MockReadPrecompile(address(0x0809)).setResponse(abi.encode(), abi.encode(uint64(21)));
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Unavailable);
        MockReadPrecompile(address(0x0809)).setRevert(abi.encode(), true);
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Unavailable);
        MockReadPrecompile(address(0x0809)).setResponse(abi.encode(), hex"01");
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Unavailable);
    }

    function testFuzzBadObservationPreservesPreviousValue(uint8 raw) public {
        _checkpoint();
        uint64 previousTime = vault.navObservedAt();
        sample.netAssets = 999 ether;
        uint8 kind = raw % 8;
        if (kind == 0) sample.cycleId = 2;
        if (kind == 1) sample.observedAt = uint64(block.timestamp + 1);
        if (kind == 2) sample.observedAt = uint64(block.timestamp - 301);
        if (kind == 3) sample.quality = IHyperCoreNavReader.Quality.Realized;
        if (kind == 4) sample.inFlight = true;
        if (kind == 5) sample.asOfCoreBlock = 19;
        if (kind == 6) sample.asOfCoreBlock = 21;
        if (kind == 7) sample.quality = IHyperCoreNavReader.Quality.Unavailable;
        _checkpoint();
        require(vault.navQuality() == IHyperCoreNavReader.Quality.Unavailable);
        require(vault.lastStrategyNav() == 70 ether && vault.navObservedAt() == previousTime);
    }

    function testPendingOrExitInvalidatesCachedMarkImmediately() public {
        _checkpoint();
        strategy.setPending(true);
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Unavailable);
        _checkpoint();
        require(vault.lastStrategyNav() == 70 ether && vault.navQuality() == IHyperCoreNavReader.Quality.Unavailable);
        strategy.setPending(false);
        _checkpoint();
        vault.beginExit(1);
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Unavailable);
    }

    function testRecapitalizationResetsMarkedBasisAndMetadata() public {
        _checkpoint();
        vault.beginExit(1);
        strategy.setRequiredRecapitalization(10 ether);
        vault.recapitalize(1);
        require(vault.lastStrategyNav() == 90 ether, "mixed market value with principal");
        require(vault.navAsOfCoreBlock() == 0 && vault.navInFlight());
        require(vault.navQuality() == IHyperCoreNavReader.Quality.CapitalEstimate);
    }

    function testSettlementDiscardsMarkAndPaysActualReturn() public {
        _checkpoint();
        uint256 shares = vault.balanceOf(ALICE);
        requestFor(ALICE, shares);
        finish(60 ether);
        require(vault.maxWithdraw(ALICE) == 80 ether); // 20 idle + 60 actually returned
        require(vault.lastStrategyNav() == 0 && vault.navAsOfCoreBlock() == 0 && !vault.navInFlight());
        require(vault.effectiveNavQuality() == IHyperCoreNavReader.Quality.Realized);
        VM.prank(ALICE);
        vault.redeem(shares, ALICE, ALICE);
        require(whype.balanceOf(ALICE) == 80 ether);
    }
}
