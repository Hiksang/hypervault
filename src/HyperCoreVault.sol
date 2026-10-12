// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

import {CoreActions, ICoreWriter} from "./CoreActions.sol";
import {CoreRead} from "./CoreRead.sol";
import {IHyperCoreRiskOracle} from "./interfaces/IHyperCoreRiskOracle.sol";
import {IWrappedHype} from "./interfaces/IWrappedHype.sol";

/// @title Legacy HyperCore HYPE Carry Vault (regression reference; new deployments use AsyncHypeVault)
/// @notice WHYPE share vault with realized-asset epochs and permissionless exits.
/// @dev This is intentionally not ERC-4626/7540: live HyperCore NAV and synchronous exits
///      cannot currently satisfy those interfaces. New capital enters only while fully idle.
contract HyperCoreVault is ERC20, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    uint256 public constant CORE_CONVERSION = 1e10; // 18 EVM decimals -> 8 Core decimals
    uint256 private constant VIRTUAL_SHARES = 1_000;
    uint16 private constant BPS = 10_000;

    enum Phase {
        Idle,
        BridgePending,
        SupplyingCollateral,
        OpeningHedge,
        Active,
        ClosingHedge,
        SettlingDebt,
        WithdrawingCollateral,
        ConvertingQuote,
        Recalling,
        RecallPending
    }

    enum ActionKind {
        None,
        SupplyCollateral,
        OpenHedge,
        CloseHedge,
        ReleaseCollateral,
        RepayDebt,
        WithdrawCollateral,
        WithdrawQuote,
        ConvertQuote,
        Recall
    }

    enum RequestStatus {
        None,
        Pending,
        Claimable,
        Claimed,
        Cancelled
    }

    struct Config {
        address wrappedHype;
        address coreWriter;
        address hypeSystem;
        address riskOracle;
        address initialOwner;
        uint256 expectedChainId;
        uint256 minimumDeposit;
        uint256 maximumTotalAssets;
        uint64 cycleDuration;
        uint64 hypeToken;
        uint64 quoteToken;
        uint32 hypePerpAsset;
        uint32 hypeSpotAsset;
        uint64 coreGasReserve;
        uint64 debtDust;
        uint64 quoteDust;
        uint64 collateralDust;
        uint16 repayBufferBps;
        uint16 minHedgeBps;
        uint16 maxHedgeBps;
    }

    struct PendingAction {
        ActionKind kind;
        uint64 submittedL1Block;
        int64 positionBefore;
        uint64 primaryBefore;
        uint64 secondaryBefore;
        uint64 amount;
        uint256 receiptBefore;
    }

    struct Epoch {
        uint256 requestedShares;
        uint256 allocatedAssets;
        uint256 remainingShares;
        uint256 remainingAssets;
        uint64 cycleEnd;
        bool exitStarted;
        bool settled;
    }

    struct RedeemRequest {
        uint64 epochId;
        address receiver;
        address owner;
        uint256 shares;
        RequestStatus status;
        bool unwrapNative;
    }

    IWrappedHype public immutable wrappedHype;
    ICoreWriter public immutable coreWriter;
    IHyperCoreRiskOracle public immutable riskOracle;
    address payable public immutable hypeSystem;
    uint256 public immutable minimumDeposit;
    uint256 public immutable maximumTotalAssets;
    uint64 public immutable cycleDuration;
    uint64 public immutable hypeToken;
    uint64 public immutable quoteToken;
    uint32 public immutable hypePerpAsset;
    uint32 public immutable hypeSpotAsset;
    uint64 private immutable _coreGasReserve;
    uint64 private immutable _quoteDust;
    uint16 private immutable _repayBufferBps;
    uint16 private immutable _minHedgeBps;
    uint16 private immutable _maxHedgeBps;

    Phase public phase;
    PendingAction public pendingAction;
    uint256 public reservedClaimAssets;
    uint64 private _strategyHype;
    uint64 private _bridgeTarget;
    uint64 private _supplyBefore;
    uint64 public epochCount;
    uint256 public nextRequestId = 1;
    uint128 private _nextCloid = 1;
    uint256 public totalCoreHypeReceived;
    bool public portfolioMarginActionSubmitted;
    bool public liveStrategyEnabled;
    bool public shutdown;
    bool private _lockingShares;

    mapping(uint256 epochId => Epoch) public epochs;
    mapping(uint256 requestId => RedeemRequest) public redeemRequests;

    error InvalidConfiguration();
    error InvalidPhase(Phase expected, Phase actual);
    error InvalidReceiver();
    error InvalidAmount();
    error SlippageExceeded(uint256 actual, uint256 minimum);
    error VaultNotIdle();
    error VaultNotActive();
    error CoreAccountMissing();
    error CoreObservationPending();
    error ActionOutstanding(ActionKind kind);
    error ExitNotReady(uint256 readyAt);
    error ExitAlreadyStarted();
    error RequestNotPending();
    error RequestNotClaimable();
    error DirectShareTransferForbidden();
    error NativeTransferFailed();
    error SystemTransferFailed();
    error StrategyNotEnabled();
    error StrategyShutdown();
    error UnexpectedPosition(int64 size);
    error HedgeRatioOutOfBounds(uint256 ratio);
    error UnsupportedDebtState();

    event Deposited(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Redeemed(
        address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event RedeemRequested(
        uint256 indexed requestId,
        uint256 indexed epochId,
        address indexed owner,
        address receiver,
        uint256 shares,
        bool unwrapNative
    );
    event RedeemCancelled(uint256 indexed requestId, address indexed owner, uint256 shares);
    event RedeemClaimed(uint256 indexed requestId, address indexed receiver, uint256 shares, uint256 assets);
    event EpochStarted(uint256 indexed epochId, uint256 cycleEnd);
    event ExitStarted(uint256 indexed epochId, uint256 requestedShares);
    event EpochSettled(uint256 indexed epochId, uint256 shares, uint256 assets);
    event CoreActionSubmitted(ActionKind indexed kind, uint64 indexed l1Block, bytes action);
    event CoreActionObserved(ActionKind indexed kind, uint64 indexed l1Block);
    event PhaseChanged(Phase indexed previousPhase, Phase indexed newPhase);
    event StrategyEnabled();
    event Shutdown();
    event CoreHypeReceived(uint256 amount, uint256 cumulativeAmount);
    event QuoteResidualCarried(uint64 amount);
    event DebtRecapitalized(uint256 assets);

    constructor(Config memory config) ERC20("HyperCore HYPE Carry Share", "hcHYPE") Ownable(config.initialOwner) {
        if (
            config.wrappedHype == address(0) || config.coreWriter == address(0) || config.hypeSystem == address(0)
                || config.riskOracle == address(0) || config.initialOwner == address(0) || config.minimumDeposit == 0
                || config.cycleDuration == 0 || config.maximumTotalAssets < config.minimumDeposit
                || config.maximumTotalAssets > uint256(uint64(type(int64).max)) * CORE_CONVERSION
                || config.coreGasReserve == 0 || config.repayBufferBps < BPS || config.minHedgeBps == 0
                || config.minHedgeBps > BPS || config.maxHedgeBps < BPS || config.debtDust != 0
                || config.collateralDust != 0 || config.quoteDust > 1e6
        ) revert InvalidConfiguration();
        if (config.expectedChainId != 0 && block.chainid != config.expectedChainId) revert InvalidConfiguration();
        _validateLiveNetworkConfig(config);

        wrappedHype = IWrappedHype(config.wrappedHype);
        coreWriter = ICoreWriter(config.coreWriter);
        riskOracle = IHyperCoreRiskOracle(config.riskOracle);
        if (
            IHyperCoreRiskOracle(config.riskOracle).perpAsset() != config.hypePerpAsset
                || IHyperCoreRiskOracle(config.riskOracle).spotAsset() != config.hypeSpotAsset
        ) revert InvalidConfiguration();
        hypeSystem = payable(config.hypeSystem);
        minimumDeposit = config.minimumDeposit;
        maximumTotalAssets = config.maximumTotalAssets;
        cycleDuration = config.cycleDuration;
        hypeToken = config.hypeToken;
        quoteToken = config.quoteToken;
        hypePerpAsset = config.hypePerpAsset;
        hypeSpotAsset = config.hypeSpotAsset;
        _coreGasReserve = config.coreGasReserve;
        _quoteDust = config.quoteDust;
        _repayBufferBps = config.repayBufferBps;
        _minHedgeBps = config.minHedgeBps;
        _maxHedgeBps = config.maxHedgeBps;
    }

    /// @dev The WHYPE branch must remain storage-free for canonical WHYPE's 2300-gas unwrap transfer.
    receive() external payable {
        if (msg.sender == address(wrappedHype)) return;
        if (msg.sender != hypeSystem) revert NativeTransferFailed();
        totalCoreHypeReceived += msg.value;
        emit CoreHypeReceived(msg.value, totalCoreHypeReceived);
    }

    function decimals() public pure override returns (uint8) {
        return 21;
    }

    function freeAssets() public view returns (uint256) {
        uint256 balance = wrappedHype.balanceOf(address(this));
        return balance - reservedClaimAssets;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        _requireIdle();
        return Math.mulDiv(assets, totalSupply() + VIRTUAL_SHARES, freeAssets() + 1, Math.Rounding.Floor);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        _requireIdle();
        if (shares == totalSupply()) return freeAssets();
        return Math.mulDiv(shares, freeAssets() + 1, totalSupply() + VIRTUAL_SHARES, Math.Rounding.Floor);
    }

    function deposit(uint256 assets, address receiver, uint256 minShares)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        _requireIdle();
        if (assets < minimumDeposit || receiver == address(0)) revert InvalidAmount();
        if (freeAssets() + assets > maximumTotalAssets) revert InvalidAmount();
        shares = convertToShares(assets);
        if (shares == 0 || shares < minShares) revert SlippageExceeded(shares, minShares);
        IERC20(address(wrappedHype)).safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposited(msg.sender, receiver, assets, shares);
    }

    function depositHype(address receiver, uint256 minShares)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 shares)
    {
        _requireIdle();
        if (msg.value < minimumDeposit || receiver == address(0)) revert InvalidAmount();
        if (freeAssets() + msg.value > maximumTotalAssets) revert InvalidAmount();
        shares = convertToShares(msg.value);
        if (shares == 0 || shares < minShares) revert SlippageExceeded(shares, minShares);
        wrappedHype.deposit{value: msg.value}();
        _mint(receiver, shares);
        emit Deposited(msg.sender, receiver, msg.value, shares);
    }

    function redeem(uint256 shares, address receiver, address shareOwner, bool unwrapNative, uint256 minAssets)
        external
        nonReentrant
        returns (uint256 assets)
    {
        _requireIdle();
        if (shares == 0 || receiver == address(0)) revert InvalidAmount();
        if (msg.sender != shareOwner) _spendAllowance(shareOwner, msg.sender, shares);
        assets = convertToAssets(shares);
        if (assets == 0 || assets < minAssets) revert SlippageExceeded(assets, minAssets);
        _burn(shareOwner, shares);
        _pay(receiver, assets, unwrapNative);
        emit Redeemed(msg.sender, receiver, shareOwner, assets, shares);
    }

    function requestRedeem(uint256 shares, address receiver, address shareOwner, bool unwrapNative)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (phase != Phase.Active) revert VaultNotActive();
        if (shares == 0 || receiver == address(0)) revert InvalidAmount();
        if (msg.sender != shareOwner) _spendAllowance(shareOwner, msg.sender, shares);

        uint256 epochId = epochCount;
        Epoch storage epoch = epochs[epochId];
        if (epoch.exitStarted) revert ExitAlreadyStarted();
        _lockingShares = true;
        _transfer(shareOwner, address(this), shares);
        _lockingShares = false;
        epoch.requestedShares += shares;

        requestId = nextRequestId++;
        redeemRequests[requestId] = RedeemRequest({
            epochId: epochId.toUint64(),
            receiver: receiver,
            owner: shareOwner,
            shares: shares,
            status: RequestStatus.Pending,
            unwrapNative: unwrapNative
        });
        emit RedeemRequested(requestId, epochId, shareOwner, receiver, shares, unwrapNative);
    }

    function cancelRedeem(uint256 requestId) external nonReentrant {
        RedeemRequest storage request = redeemRequests[requestId];
        if (request.status != RequestStatus.Pending) revert RequestNotPending();
        Epoch storage epoch = epochs[request.epochId];
        if (phase != Phase.Active || epoch.exitStarted) revert ExitAlreadyStarted();
        if (msg.sender != request.owner) revert InvalidReceiver();
        request.status = RequestStatus.Cancelled;
        epoch.requestedShares -= request.shares;
        _lockingShares = true;
        _transfer(address(this), request.owner, request.shares);
        _lockingShares = false;
        emit RedeemCancelled(requestId, msg.sender, request.shares);
    }

    function claimRedeem(uint256 requestId) external nonReentrant returns (uint256 assets) {
        RedeemRequest storage request = redeemRequests[requestId];
        Epoch storage epoch = epochs[request.epochId];
        if (request.status == RequestStatus.Pending && epoch.settled) request.status = RequestStatus.Claimable;
        if (request.status != RequestStatus.Claimable) revert RequestNotClaimable();
        if (request.shares == epoch.remainingShares) {
            assets = epoch.remainingAssets;
        } else {
            assets = Math.mulDiv(request.shares, epoch.allocatedAssets, epoch.requestedShares, Math.Rounding.Floor);
        }
        request.status = RequestStatus.Claimed;
        epoch.remainingShares -= request.shares;
        epoch.remainingAssets -= assets;
        reservedClaimAssets -= assets;
        _pay(request.receiver, assets, request.unwrapNative);
        emit RedeemClaimed(requestId, request.receiver, request.shares, assets);
    }

    function pauseNewCapital() external onlyOwner {
        _pause();
    }

    function unpauseNewCapital() external onlyOwner {
        if (shutdown) revert StrategyShutdown();
        _unpause();
    }

    function permanentlyShutdown() external onlyOwner {
        if (phase != Phase.Idle && phase != Phase.Active) revert VaultNotIdle();
        shutdown = true;
        if (!paused()) _pause();
        emit Shutdown();
    }

    /// @notice Sponsor the contract's Core account. This amount never mints vault shares.
    function seedCoreAccount() external payable {
        if (msg.value == 0) revert InvalidAmount();
        (bool ok,) = hypeSystem.call{value: msg.value}("");
        if (!ok) revert SystemTransferFailed();
    }

    /// @notice Moves unreserved EVM WHYPE to Core when strategy assets alone cannot clear quote debt.
    function recapitalizeDebt() external nonReentrant {
        if (phase != Phase.SettlingDebt) revert InvalidPhase(Phase.SettlingDebt, phase);
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        if (_bridgeTarget != 0) revert CoreObservationPending();
        uint64 missing = riskOracle.recapitalizationSize(
            address(this), hypeToken, quoteToken, hypeSpotAsset, _coreGasReserve, _repayBufferBps
        );
        uint256 assets = uint256(missing) * CORE_CONVERSION;
        if (assets > freeAssets()) revert InvalidAmount();
        _bridgeTarget = CoreRead.spotBalance(address(this), hypeToken).total + missing;
        wrappedHype.withdraw(assets);
        (bool ok,) = hypeSystem.call{value: assets}("");
        if (!ok) revert SystemTransferFailed();
        emit DebtRecapitalized(assets);
    }

    /// @notice Submit PM activation. There is currently no official on-chain readback for success.
    function submitPortfolioMarginActivation() external onlyOwner {
        if (!CoreRead.userExists(address(this))) revert CoreAccountMissing();
        bytes memory action = CoreActions.setAbstraction(address(this), CoreActions.Abstraction.PortfolioMargin);
        coreWriter.sendRawAction(action);
        portfolioMarginActionSubmitted = true;
        emit CoreActionSubmitted(ActionKind.None, CoreRead.l1Block(), action);
    }

    /// @notice One-way integration gate after an operator verifies PM activation out of band.
    function enableLiveStrategy() external onlyOwner {
        if (!portfolioMarginActionSubmitted || !CoreRead.userExists(address(this))) revert CoreAccountMissing();
        liveStrategyEnabled = true;
        emit StrategyEnabled();
    }

    function startStrategy(uint256 assets) external onlyOwner nonReentrant whenNotPaused {
        _requireIdle();
        if (shutdown) revert StrategyShutdown();
        if (!liveStrategyEnabled) revert StrategyNotEnabled();
        if (totalSupply() == 0 || assets == 0 || assets > freeAssets()) revert InvalidAmount();
        if (assets % CORE_CONVERSION != 0) revert CoreActions.NonRepresentableAmount();
        if (!CoreRead.userExists(address(this))) revert CoreAccountMissing();
        if (!riskOracle.accountIsClean(address(this), hypeToken, quoteToken, hypePerpAsset)) {
            revert CoreObservationPending();
        }

        CoreRead.SpotBalance memory beforeBalance = CoreRead.spotBalance(address(this), hypeToken);
        if (uint256(beforeBalance.total) < uint256(beforeBalance.hold) + _coreGasReserve) {
            revert CoreObservationPending();
        }
        _strategyHype = (assets / CORE_CONVERSION).toUint64();
        if (
            !riskOracle.isSizeAligned(hypePerpAsset, _strategyHype)
                || !riskOracle.isSizeAligned(hypeSpotAsset, _strategyHype)
        ) revert InvalidAmount();
        _bridgeTarget = beforeBalance.total + _strategyHype;
        wrappedHype.withdraw(assets);
        (bool ok,) = hypeSystem.call{value: assets}("");
        if (!ok) revert SystemTransferFailed();
        _setPhase(Phase.BridgePending);
    }

    function observeBridgeAndSupply() external {
        if (phase != Phase.BridgePending) revert InvalidPhase(Phase.BridgePending, phase);
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.SpotBalance memory balance = CoreRead.spotBalance(address(this), hypeToken);
        if (balance.total < _bridgeTarget) revert CoreObservationPending();
        _bridgeTarget = 0;
        CoreRead.UserLending memory lending = CoreRead.lending(address(this), hypeToken);
        _supplyBefore = lending.supply.value;
        bytes memory action = CoreActions.lend(CoreActions.LendingOperation.Supply, hypeToken, _strategyHype);
        _submit(ActionKind.SupplyCollateral, action, 0, _supplyBefore, balance.total, _strategyHype);
        _setPhase(Phase.SupplyingCollateral);
    }

    function processOpeningHedge() external {
        if (phase != Phase.SupplyingCollateral && phase != Phase.OpeningHedge) {
            revert InvalidPhase(Phase.OpeningHedge, phase);
        }
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory lending = CoreRead.lending(address(this), hypeToken);
        if (lending.supply.value <= _supplyBefore) revert CoreObservationPending();
        int64 position = riskOracle.positionSize(address(this), hypePerpAsset);
        if (position > 0) revert UnexpectedPosition(position);
        uint64 shortSize = _abs(position);
        if (shortSize >= _strategyHype) {
            _activateIfHedged(shortSize);
            return;
        }
        uint64 remaining = _strategyHype - shortSize;
        bytes memory action =
            CoreActions.order(hypePerpAsset, false, _sellLimit(hypePerpAsset), remaining, false, 3, _consumeCloid());
        _submit(ActionKind.OpenHedge, action, position, shortSize, 0, remaining);
        _setPhase(Phase.OpeningHedge);
    }

    function activateStrategy() external {
        if (phase != Phase.OpeningHedge) revert InvalidPhase(Phase.OpeningHedge, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        int64 position = riskOracle.positionSize(address(this), hypePerpAsset);
        if (position >= 0) revert UnexpectedPosition(position);
        _activateIfHedged(_abs(position));
    }

    function beginExit() external {
        if (phase != Phase.Active) revert VaultNotActive();
        Epoch storage epoch = epochs[epochCount];
        if (epoch.requestedShares == 0 && !shutdown) revert InvalidAmount();
        if (block.timestamp < epoch.cycleEnd && !shutdown) revert ExitNotReady(epoch.cycleEnd);
        epoch.exitStarted = true;
        emit ExitStarted(epochCount, epoch.requestedShares);
        _setPhase(Phase.ClosingHedge);
    }

    /// @notice Permissionless, deterministic reduce-only IOC close. No caller-provided size/price.
    function processHedgeClose() external {
        if (phase != Phase.ClosingHedge) revert InvalidPhase(Phase.ClosingHedge, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        int64 position = riskOracle.positionSize(address(this), hypePerpAsset);
        if (position == 0) {
            _setPhase(Phase.SettlingDebt);
            return;
        }
        bool isBuy = position < 0;
        bytes memory action = CoreActions.order(
            hypePerpAsset,
            isBuy,
            isBuy ? _buyLimit(hypePerpAsset) : _sellLimit(hypePerpAsset),
            _abs(position),
            true,
            3,
            _consumeCloid()
        );
        _submit(ActionKind.CloseHedge, action, position, _abs(position), 0, _abs(position));
    }

    /// @notice Repays observed USDC debt by releasing and selling only the needed HYPE.
    function processDebtSettlement() external {
        if (phase != Phase.SettlingDebt) revert InvalidPhase(Phase.SettlingDebt, phase);
        if (_bridgeTarget != 0) {
            if (CoreRead.spotBalance(address(this), hypeToken).total < _bridgeTarget) revert CoreObservationPending();
            _bridgeTarget = 0;
        }
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory quoteLending = CoreRead.lending(address(this), quoteToken);
        if (quoteLending.borrow.value == 0) {
            _setPhase(Phase.WithdrawingCollateral);
            return;
        }
        uint64 sellLimit = _sellLimit(hypeSpotAsset);
        uint64 needed = riskOracle.repaySize(hypeSpotAsset, quoteLending.borrow.value, sellLimit, _repayBufferBps);
        CoreRead.SpotBalance memory hypeBalance = CoreRead.spotBalance(address(this), hypeToken);
        uint64 available = hypeBalance.total > hypeBalance.hold ? hypeBalance.total - hypeBalance.hold : 0;
        uint64 usable = available > _coreGasReserve ? available - _coreGasReserve : 0;
        if (usable < needed) {
            CoreRead.UserLending memory hypeLending = CoreRead.lending(address(this), hypeToken);
            uint64 missing = needed - usable;
            uint64 release = missing > hypeLending.supply.value ? hypeLending.supply.value : missing;
            if (release == 0) revert UnsupportedDebtState();
            bytes memory releaseAction = CoreActions.lend(CoreActions.LendingOperation.Withdraw, hypeToken, release);
            _submit(
                ActionKind.ReleaseCollateral, releaseAction, 0, hypeLending.supply.value, hypeBalance.total, release
            );
            return;
        }
        uint64 sellSize = needed;
        bytes memory sellAction =
            CoreActions.order(hypeSpotAsset, false, sellLimit, sellSize, false, 3, _consumeCloid());
        _submit(ActionKind.RepayDebt, sellAction, 0, quoteLending.borrow.value, hypeBalance.total, sellSize);
    }

    function processCollateralWithdrawal() external {
        if (phase != Phase.WithdrawingCollateral) revert InvalidPhase(Phase.WithdrawingCollateral, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory quoteLending = CoreRead.lending(address(this), quoteToken);
        if (quoteLending.borrow.value != 0) revert UnsupportedDebtState();
        if (quoteLending.supply.value != 0) {
            bytes memory withdrawQuote = CoreActions.withdrawAll(quoteToken);
            _submit(ActionKind.WithdrawQuote, withdrawQuote, 0, quoteLending.supply.value, 0, 0);
            return;
        }
        CoreRead.UserLending memory hypeLending = CoreRead.lending(address(this), hypeToken);
        if (hypeLending.supply.value == 0) {
            _setPhase(Phase.ConvertingQuote);
            return;
        }
        bytes memory action = CoreActions.withdrawAll(hypeToken);
        _submit(ActionKind.WithdrawCollateral, action, 0, hypeLending.supply.value, 0, 0);
    }

    /// @notice Converts realized quote profit to HYPE before HYPE-denominated settlement.
    function processQuoteConversion() external {
        if (phase != Phase.ConvertingQuote) revert InvalidPhase(Phase.ConvertingQuote, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory quoteLending = CoreRead.lending(address(this), quoteToken);
        if (quoteLending.borrow.value != 0) revert UnsupportedDebtState();
        if (quoteLending.supply.value != 0) {
            bytes memory withdrawQuote = CoreActions.withdrawAll(quoteToken);
            _submit(ActionKind.WithdrawQuote, withdrawQuote, 0, quoteLending.supply.value, 0, 0);
            return;
        }
        CoreRead.SpotBalance memory quoteBalance = CoreRead.spotBalance(address(this), quoteToken);
        uint64 availableQuote = quoteBalance.total > quoteBalance.hold ? quoteBalance.total - quoteBalance.hold : 0;
        if (availableQuote <= _quoteDust) {
            _setPhase(Phase.Recalling);
            return;
        }
        uint64 buyLimit = _buyLimit(hypeSpotAsset);
        uint64 rawBuySize = Math.mulDiv(availableQuote, 1e8, buyLimit, Math.Rounding.Floor).toUint64();
        uint64 buySize = riskOracle.roundSizeDown(hypeSpotAsset, rawBuySize);
        if (buySize == 0) {
            emit QuoteResidualCarried(availableQuote);
            _setPhase(Phase.Recalling);
            return;
        }
        CoreRead.SpotBalance memory hypeBalance = CoreRead.spotBalance(address(this), hypeToken);
        bytes memory action = CoreActions.order(hypeSpotAsset, true, buyLimit, buySize, false, 3, _consumeCloid());
        _submit(ActionKind.ConvertQuote, action, 0, quoteBalance.total, hypeBalance.total, buySize);
    }

    function submitRecall() external {
        if (phase != Phase.Recalling) revert InvalidPhase(Phase.Recalling, phase);
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory debt = CoreRead.lending(address(this), quoteToken);
        if (debt.borrow.value != 0) revert UnsupportedDebtState();
        int64 position = riskOracle.positionSize(address(this), hypePerpAsset);
        if (position != 0) revert UnexpectedPosition(position);
        CoreRead.SpotBalance memory balance = CoreRead.spotBalance(address(this), hypeToken);
        if (balance.hold != 0) revert CoreObservationPending();
        if (balance.total <= _coreGasReserve) {
            _settleEpoch();
            return;
        }
        uint64 amount = balance.total - _coreGasReserve;
        bytes memory action = CoreActions.recallHype(hypeToken, amount);
        _submit(ActionKind.Recall, action, 0, balance.total, 0, amount);
        pendingAction.receiptBefore = totalCoreHypeReceived;
        _setPhase(Phase.RecallPending);
    }

    /// @notice Observes a single outstanding action. It never assumes CoreWriter call success.
    function syncCoreState() external nonReentrant {
        _syncPendingAction();
    }

    function _syncPendingAction() internal {
        PendingAction memory pending = pendingAction;
        if (pending.kind == ActionKind.None) return;
        uint64 observedL1Block = CoreRead.l1Block();
        if (observedL1Block <= pending.submittedL1Block) revert CoreObservationPending();
        bool observed;

        if (pending.kind == ActionKind.SupplyCollateral) {
            observed = uint256(CoreRead.lending(address(this), hypeToken).supply.value)
                >= uint256(pending.primaryBefore) + pending.amount;
        } else if (pending.kind == ActionKind.OpenHedge) {
            observed = riskOracle.positionSize(address(this), hypePerpAsset) != pending.positionBefore;
        } else if (pending.kind == ActionKind.CloseHedge) {
            observed = _abs(riskOracle.positionSize(address(this), hypePerpAsset)) < pending.primaryBefore;
        } else if (pending.kind == ActionKind.ReleaseCollateral) {
            CoreRead.UserLending memory lending = CoreRead.lending(address(this), hypeToken);
            observed = lending.supply.value < pending.primaryBefore;
        } else if (pending.kind == ActionKind.RepayDebt) {
            CoreRead.SpotBalance memory spot = CoreRead.spotBalance(address(this), hypeToken);
            observed = spot.total < pending.secondaryBefore;
        } else if (pending.kind == ActionKind.WithdrawCollateral) {
            observed = CoreRead.lending(address(this), hypeToken).supply.value < pending.primaryBefore;
        } else if (pending.kind == ActionKind.WithdrawQuote) {
            observed = CoreRead.lending(address(this), quoteToken).supply.value < pending.primaryBefore;
        } else if (pending.kind == ActionKind.ConvertQuote) {
            CoreRead.SpotBalance memory quote = CoreRead.spotBalance(address(this), quoteToken);
            observed = quote.total < pending.primaryBefore;
        } else if (pending.kind == ActionKind.Recall) {
            uint256 expected = uint256(pending.amount) * CORE_CONVERSION;
            bool authenticatedReceipt = totalCoreHypeReceived >= pending.receiptBefore + expected;
            if (authenticatedReceipt && address(this).balance >= expected) {
                wrappedHype.deposit{value: expected}();
                delete pendingAction;
                emit CoreActionObserved(pending.kind, observedL1Block);
                _settleEpoch();
                return;
            }
            return; // recall is never resubmitted without an authenticated protocol receipt
        }

        if (!observed) revert CoreObservationPending();
        delete pendingAction;
        emit CoreActionObserved(pending.kind, observedL1Block);
    }

    function _activateIfHedged(uint64 shortSize) internal {
        uint256 ratio = Math.mulDiv(shortSize, BPS, _strategyHype, Math.Rounding.Floor);
        if (ratio < _minHedgeBps || ratio > _maxHedgeBps) revert HedgeRatioOutOfBounds(ratio);
        uint256 epochId = ++epochCount;
        epochs[epochId].cycleEnd = (block.timestamp + cycleDuration).toUint64();
        _setPhase(Phase.Active);
        emit EpochStarted(epochId, epochs[epochId].cycleEnd);
    }

    function _settleEpoch() internal {
        Epoch storage epoch = epochs[epochCount];
        uint256 queued = epoch.requestedShares;
        if (queued != 0) {
            uint256 supply = totalSupply();
            uint256 assets = queued == supply
                ? freeAssets()
                : Math.mulDiv(queued, freeAssets() + 1, supply + VIRTUAL_SHARES, Math.Rounding.Floor);
            epoch.allocatedAssets = assets;
            epoch.remainingShares = queued;
            epoch.remainingAssets = assets;
            epoch.settled = true;
            reservedClaimAssets += assets;
            _burn(address(this), queued);
            emit EpochSettled(epochCount, queued, assets);
        }
        _strategyHype = 0;
        _bridgeTarget = 0;
        _supplyBefore = 0;
        _setPhase(Phase.Idle);
    }

    function _submit(
        ActionKind kind,
        bytes memory action,
        int64 positionBefore,
        uint64 primaryBefore,
        uint64 secondaryBefore,
        uint64 amount
    ) internal {
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        uint64 l1Block = CoreRead.l1Block();
        coreWriter.sendRawAction(action);
        pendingAction = PendingAction({
            kind: kind,
            submittedL1Block: l1Block,
            positionBefore: positionBefore,
            primaryBefore: primaryBefore,
            secondaryBefore: secondaryBefore,
            amount: amount,
            receiptBefore: 0
        });
        emit CoreActionSubmitted(kind, l1Block, action);
    }

    function _buyLimit(uint32 asset) internal view returns (uint64) {
        return riskOracle.buyLimit(asset);
    }

    function _sellLimit(uint32 asset) internal view returns (uint64) {
        return riskOracle.sellLimit(asset);
    }

    function _consumeCloid() internal returns (uint128 cloid) {
        cloid = _nextCloid++;
    }

    function _pay(address receiver, uint256 assets, bool unwrapNative) internal {
        if (!unwrapNative) {
            IERC20(address(wrappedHype)).safeTransfer(receiver, assets);
            return;
        }
        wrappedHype.withdraw(assets);
        (bool ok,) = payable(receiver).call{value: assets}("");
        if (!ok) revert NativeTransferFailed();
    }

    function _requireIdle() internal view {
        if (phase != Phase.Idle) revert VaultNotIdle();
    }

    function _abs(int64 value) internal pure returns (uint64) {
        return value >= 0 ? uint256(int256(value)).toUint64() : uint256(-int256(value)).toUint64();
    }

    function _setPhase(Phase next) internal {
        Phase previous = phase;
        phase = next;
        emit PhaseChanged(previous, next);
    }

    function _validateLiveNetworkConfig(Config memory config) private view {
        if (block.chainid != 999 && block.chainid != 998) return;
        if (
            config.expectedChainId != block.chainid || config.wrappedHype != 0x5555555555555555555555555555555555555555
                || config.coreWriter != 0x3333333333333333333333333333333333333333
                || config.hypeSystem != 0x2222222222222222222222222222222222222222 || config.quoteToken != 0
        ) revert InvalidConfiguration();
        if (
            block.chainid == 999
                && (config.hypeToken != 150 || config.hypePerpAsset != 159 || config.hypeSpotAsset != 10_107)
        ) revert InvalidConfiguration();
        if (
            block.chainid == 998
                && (config.hypeToken != 1105 || config.hypePerpAsset != 135 || config.hypeSpotAsset != 11_035)
        ) revert InvalidConfiguration();
    }

    function _update(address from, address to, uint256 value) internal override {
        if ((to == address(this) || from == address(this)) && !_lockingShares && to != address(0)) {
            revert DirectShareTransferForbidden();
        }
        super._update(from, to, value);
    }
}
