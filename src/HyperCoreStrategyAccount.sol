// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoreActions, ICoreWriter} from "./CoreActions.sol";
import {CoreRead} from "./CoreRead.sol";
import {IHyperCoreRiskOracle} from "./interfaces/IHyperCoreRiskOracle.sol";
import {IWrappedHype} from "./interfaces/IWrappedHype.sol";
import {IHyperCoreStrategyAccount} from "./interfaces/IHyperCoreStrategyAccount.sol";
import {ICoreActionObserver} from "./interfaces/ICoreActionObserver.sol";

/// @notice Core custody account. Only its immutable Vault may allocate or recall EVM capital.
/// @dev Research adapter: PM attestation, unknown action outcomes, NAV and recall units remain integration gates.
contract HyperCoreStrategyAccount is IHyperCoreStrategyAccount, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    uint256 public constant CORE_CONVERSION = 1e10;
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
        RecallPending,
        ReturnReady
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

    struct Config {
        address wrappedHype;
        address coreWriter;
        address hypeSystem;
        address riskOracle;
        uint256 expectedChainId;
        uint64 hypeToken;
        uint64 quoteToken;
        uint32 hypePerpAsset;
        uint32 hypeSpotAsset;
        uint64 coreGasReserve;
        uint16 repayBufferBps;
        uint16 minHedgeBps;
        uint16 maxHedgeBps;
        address actionObserver;
    }

    struct PendingAction {
        ActionKind kind;
        uint64 submittedL1Block;
        int64 positionBefore;
        uint64 primaryBefore;
        uint64 secondaryBefore;
        uint64 amount;
        uint256 receiptBefore;
        uint256 cycleId;
        uint256 actionId;
        uint128 cloid;
        uint64 submittedAt;
        bytes32 actionHash;
    }
    address public immutable vault;
    bytes32 public immutable configHash;
    IWrappedHype public immutable wrappedHype;
    ICoreWriter public immutable coreWriter;
    IHyperCoreRiskOracle public immutable riskOracle;
    ICoreActionObserver public immutable actionObserver;
    address payable public immutable hypeSystem;
    uint64 public immutable hypeToken;
    uint64 public immutable quoteToken;
    uint32 public immutable hypePerpAsset;
    uint32 public immutable hypeSpotAsset;
    uint64 private immutable _coreGasReserve;
    uint16 private immutable _repayBufferBps;
    uint16 private immutable _minHedgeBps;
    uint16 private immutable _maxHedgeBps;
    uint64 private constant _quoteDust = 0;
    Phase public phase;
    PendingAction public pendingAction;
    uint256 public cycleId;
    uint64 public openDeadline;
    uint64 public cycleEnd;
    bool public exitRequested;
    bool public riskPaused;
    bool public portfolioMarginActionSubmitted;
    bool public portfolioMarginAttested;
    uint256 public accountedCapital;
    uint256 public sponsoredGas;
    uint256 public totalCoreHypeReceived;
    uint64 private _bridgeTarget;
    uint64 private _strategyHype;
    uint64 private _supplyBefore;
    uint128 private _nextCloid = 1;
    uint256 public nextActionId = 1;

    error InvalidConfiguration();
    error InvalidPhase(Phase expected, Phase actual);
    error InvalidAmount();
    error WrongVault();
    error WrongCycle();
    error CoreAccountMissing();
    error CoreObservationPending();
    error ActionOutstanding(ActionKind kind);
    error NativeTransferFailed();
    error SystemTransferFailed();
    error StrategyNotEnabled();
    error RiskPaused();
    error UnexpectedPosition(int64 size);
    error HedgeRatioOutOfBounds(uint256 ratio);
    error UnsupportedDebtState();
    error ResidualExposure();
    event CoreActionSubmitted(ActionKind indexed kind, uint64 indexed l1Block, bytes action);
    event CoreActionObserved(ActionKind indexed kind, uint64 indexed l1Block);
    event PhaseChanged(Phase indexed previousPhase, Phase indexed newPhase);
    event CoreHypeReceived(uint256 amount, uint256 cumulativeAmount);
    event QuoteResidualCarried(uint64 amount);
    event DebtRecapitalized(uint256 assets);
    event PortfolioMarginAttested(uint256 indexed cycleId);
    event ReturnedToVault(uint256 indexed cycleId, uint256 assets);
    event GasSponsored(address indexed sponsor, uint256 assets);
    event CoreActionIdentified(
        uint256 indexed actionId, uint256 indexed cycleId, uint128 indexed cloid, bytes32 actionHash
    );
    event CoreActionEvidence(
        uint256 indexed actionId,
        ICoreActionObserver.Evidence evidence,
        uint64 coreBlock,
        uint64 effectAmount,
        bytes32 readErrorHash
    );

    modifier onlyVault() {
        if (msg.sender != vault) revert WrongVault();
        _;
    }

    constructor(address vault_, Config memory c) {
        if (
            vault_ == address(0) || c.wrappedHype.code.length == 0 || c.coreWriter.code.length == 0
                || c.hypeSystem == address(0) || c.riskOracle.code.length == 0 || c.coreGasReserve == 0
                || c.hypeToken == c.quoteToken || c.repayBufferBps < BPS || c.minHedgeBps == 0 || c.minHedgeBps > BPS
                || c.maxHedgeBps < BPS || c.actionObserver.code.length == 0
        ) revert InvalidConfiguration();
        if (c.expectedChainId != 0 && c.expectedChainId != block.chainid) revert InvalidConfiguration();
        _validateLiveNetworkConfig(c);
        vault = vault_;
        configHash = keccak256(abi.encode(c));
        wrappedHype = IWrappedHype(c.wrappedHype);
        coreWriter = ICoreWriter(c.coreWriter);
        hypeSystem = payable(c.hypeSystem);
        riskOracle = IHyperCoreRiskOracle(c.riskOracle);
        actionObserver = ICoreActionObserver(c.actionObserver);
        if (riskOracle.perpAsset() != c.hypePerpAsset || riskOracle.spotAsset() != c.hypeSpotAsset) {
            revert InvalidConfiguration();
        }
        hypeToken = c.hypeToken;
        quoteToken = c.quoteToken;
        hypePerpAsset = c.hypePerpAsset;
        hypeSpotAsset = c.hypeSpotAsset;
        _coreGasReserve = c.coreGasReserve;
        _repayBufferBps = c.repayBufferBps;
        _minHedgeBps = c.minHedgeBps;
        _maxHedgeBps = c.maxHedgeBps;
    }

    // Keep canonical WHYPE's 2,300-gas unwrap branch free of storage writes.
    receive() external payable {
        if (msg.sender == address(wrappedHype)) return;
        if (msg.sender != hypeSystem) revert NativeTransferFailed();
        totalCoreHypeReceived += msg.value;
        emit CoreHypeReceived(msg.value, totalCoreHypeReceived);
    }

    function asset() external view returns (address) {
        return address(wrappedHype);
    }

    function cycleStatus() external view returns (CycleStatus memory) {
        return CycleStatus(
            cycleId,
            uint8(phase),
            pendingAction.kind != ActionKind.None || _bridgeTarget != 0,
            exitRequested,
            phase == Phase.ReturnReady
        );
    }

    function sponsorGas() external payable nonReentrant {
        if (
            phase != Phase.Idle || msg.value == 0
                || sponsoredGas + msg.value > uint256(_coreGasReserve) * CORE_CONVERSION
        ) revert InvalidAmount();
        sponsoredGas += msg.value;
        (bool ok,) = hypeSystem.call{value: msg.value}("");
        if (!ok) revert SystemTransferFailed();
        emit GasSponsored(msg.sender, msg.value);
    }

    function setRiskPaused(bool paused) external onlyVault {
        riskPaused = paused;
    }

    function startCycle(uint256 id, uint256 assets, uint64 deadline, uint64 end) external onlyVault nonReentrant {
        if (phase != Phase.Idle) revert InvalidPhase(Phase.Idle, phase);
        if (riskPaused) revert RiskPaused();
        if (id <= cycleId || assets == 0 || deadline <= block.timestamp || end <= deadline) revert InvalidAmount();
        if (assets % CORE_CONVERSION != 0) revert CoreActions.NonRepresentableAmount();
        if (!CoreRead.userExists(address(this))) revert CoreAccountMissing();
        if (!riskOracle.accountIsClean(address(this), hypeToken, quoteToken, hypePerpAsset)) revert ResidualExposure();
        CoreRead.SpotBalance memory balance = CoreRead.spotBalance(address(this), hypeToken);
        if (balance.hold != 0 || balance.total < _coreGasReserve) revert CoreObservationPending();
        _strategyHype = (assets / CORE_CONVERSION).toUint64();
        if (
            !riskOracle.isSizeAligned(hypePerpAsset, _strategyHype)
                || !riskOracle.isSizeAligned(hypeSpotAsset, _strategyHype)
        ) revert InvalidAmount();
        cycleId = id;
        openDeadline = deadline;
        cycleEnd = end;
        exitRequested = false;
        portfolioMarginActionSubmitted = false;
        portfolioMarginAttested = false;
        accountedCapital = assets;
        _bridgeTarget = balance.total + _strategyHype;
        _setPhase(Phase.BridgePending);
        IERC20(address(wrappedHype)).safeTransferFrom(vault, address(this), assets);
        _bridge(assets);
    }

    function _bridge(uint256 assets) private {
        wrappedHype.withdraw(assets);
        (bool ok,) = hypeSystem.call{value: assets}("");
        if (!ok) revert SystemTransferFailed();
    }

    function submitPortfolioMarginActivation() external nonReentrant {
        if (phase != Phase.BridgePending || exitRequested || riskPaused || block.timestamp >= openDeadline) {
            revert StrategyNotEnabled();
        }
        if (portfolioMarginActionSubmitted) revert StrategyNotEnabled();
        if (CoreRead.spotBalance(address(this), hypeToken).total < _bridgeTarget) revert CoreObservationPending();
        if (!CoreRead.userExists(address(this))) revert CoreAccountMissing();
        portfolioMarginActionSubmitted = true;
        bytes memory action = CoreActions.setAbstraction(address(this), CoreActions.Abstraction.PortfolioMargin);
        coreWriter.sendRawAction(action);
        emit CoreActionSubmitted(ActionKind.None, CoreRead.l1Block(), action);
    }

    /// @dev A named attestation, not a claim that Core supplied an on-chain PM receipt.
    function confirmPortfolioMargin(uint256 id) external onlyVault {
        if (id != cycleId) revert WrongCycle();
        if (
            phase != Phase.BridgePending || !portfolioMarginActionSubmitted || exitRequested || riskPaused
                || block.timestamp >= openDeadline
        ) revert StrategyNotEnabled();
        portfolioMarginAttested = true;
        emit PortfolioMarginAttested(id);
    }

    function requestExit(uint256 id) external onlyVault {
        if (id != cycleId || phase == Phase.Idle || phase == Phase.ReturnReady) revert WrongCycle();
        exitRequested = true;
    }

    function requiredRecapitalization() public view returns (uint256) {
        if (phase != Phase.SettlingDebt || pendingAction.kind != ActionKind.None || _bridgeTarget != 0) return 0;
        return uint256(
            riskOracle.recapitalizationSize(
            address(this), hypeToken, quoteToken, hypeSpotAsset, _coreGasReserve, _repayBufferBps
        )
        ) * CORE_CONVERSION;
    }

    function recapitalize(uint256 id, uint256 assets) external onlyVault nonReentrant {
        if (id != cycleId) revert WrongCycle();
        if (assets == 0 || assets != requiredRecapitalization()) revert InvalidAmount();
        uint64 missing = (assets / CORE_CONVERSION).toUint64();
        _bridgeTarget = CoreRead.spotBalance(address(this), hypeToken).total + missing;
        accountedCapital += assets;
        IERC20(address(wrappedHype)).safeTransferFrom(vault, address(this), assets);
        _bridge(assets);
        emit DebtRecapitalized(assets);
    }

    function advance() external nonReentrant {
        if (phase == Phase.BridgePending) {
            if (CoreRead.spotBalance(address(this), hypeToken).total < _bridgeTarget) revert CoreObservationPending();
            if (exitRequested) {
                _bridgeTarget = 0;
                _setPhase(Phase.ClosingHedge);
            } else {
                _requireNewRisk();
                if (!portfolioMarginAttested) revert StrategyNotEnabled();
                _observeBridgeAndSupply();
            }
            return;
        }
        if (phase == Phase.SupplyingCollateral || phase == Phase.OpeningHedge) {
            if (exitRequested) {
                _syncPendingAction();
                if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
                _setPhase(Phase.ClosingHedge);
            } else {
                _requireNewRisk();
                _processOpeningHedge();
            }
        } else if (phase == Phase.Active) {
            if (!exitRequested) revert StrategyNotEnabled();
            _setPhase(Phase.ClosingHedge);
        } else if (phase == Phase.ClosingHedge) {
            _processHedgeClose();
        } else if (phase == Phase.SettlingDebt) {
            _processDebtSettlement();
        } else if (phase == Phase.WithdrawingCollateral) {
            _processCollateralWithdrawal();
        } else if (phase == Phase.ConvertingQuote) {
            _processQuoteConversion();
        } else if (phase == Phase.Recalling) {
            _submitRecall();
        } else if (phase == Phase.RecallPending) {
            _syncPendingAction();
        } else {
            revert InvalidPhase(Phase.Active, phase);
        }
    }

    function _requireNewRisk() private view {
        if (riskPaused || block.timestamp >= openDeadline || exitRequested) revert RiskPaused();
    }

    function returnToVault(uint256 id) external onlyVault nonReentrant returns (uint256 assets) {
        if (id != cycleId) revert WrongCycle();
        if (phase != Phase.ReturnReady) revert InvalidPhase(Phase.ReturnReady, phase);
        _verifyTerminal();
        assets = wrappedHype.balanceOf(address(this));
        accountedCapital = 0;
        _strategyHype = 0;
        _supplyBefore = 0;
        _setPhase(Phase.Idle);
        IERC20(address(wrappedHype)).safeTransfer(vault, assets);
        emit ReturnedToVault(id, assets);
    }

    function _verifyTerminal() private view {
        if (pendingAction.kind != ActionKind.None || _bridgeTarget != 0) revert CoreObservationPending();
        if (!riskOracle.accountIsClean(address(this), hypeToken, quoteToken, hypePerpAsset)) revert ResidualExposure();
        CoreRead.SpotBalance memory h = CoreRead.spotBalance(address(this), hypeToken);
        CoreRead.SpotBalance memory q = CoreRead.spotBalance(address(this), quoteToken);
        if (h.hold != 0 || h.total > _coreGasReserve || q.total != 0 || q.hold != 0) revert ResidualExposure();
    }

    function _finishReturn() private {
        _verifyTerminal();
        _setPhase(Phase.ReturnReady);
    }

    function _activateIfHedged(uint64 shortSize) internal {
        uint256 ratio = Math.mulDiv(shortSize, BPS, _strategyHype, Math.Rounding.Floor);
        if (ratio < _minHedgeBps || ratio > _maxHedgeBps) revert HedgeRatioOutOfBounds(ratio);
        _setPhase(Phase.Active);
    }

    function _observeBridgeAndSupply() internal {
        if (phase != Phase.BridgePending) revert InvalidPhase(Phase.BridgePending, phase);
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.SpotBalance memory balance = CoreRead.spotBalance(address(this), hypeToken);
        if (balance.total < _bridgeTarget) revert CoreObservationPending();
        CoreRead.UserLending memory lending = CoreRead.lending(address(this), hypeToken);
        // The initial supply assumes the clean lending baseline checked at cycle start still holds.
        if (lending.supply.value != 0 || lending.borrow.value != 0) revert ResidualExposure();
        _bridgeTarget = 0;
        _supplyBefore = lending.supply.value;
        bytes memory action = CoreActions.lend(CoreActions.LendingOperation.Supply, hypeToken, _strategyHype);
        _submit(ActionKind.SupplyCollateral, action, 0, _supplyBefore, balance.total, _strategyHype, 0);
        _setPhase(Phase.SupplyingCollateral);
    }

    function _processOpeningHedge() internal {
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
        uint128 cloid = _consumeCloid();
        bytes memory action =
            CoreActions.order(hypePerpAsset, false, _sellLimit(hypePerpAsset), remaining, false, 3, cloid);
        _submit(ActionKind.OpenHedge, action, position, shortSize, 0, remaining, cloid);
        _setPhase(Phase.OpeningHedge);
    }

    function _processHedgeClose() internal {
        if (phase != Phase.ClosingHedge) revert InvalidPhase(Phase.ClosingHedge, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        int64 position = riskOracle.positionSize(address(this), hypePerpAsset);
        if (position == 0) {
            _setPhase(Phase.SettlingDebt);
            return;
        }
        bool isBuy = position < 0;
        uint128 cloid = _consumeCloid();
        bytes memory action = CoreActions.order(
            hypePerpAsset,
            isBuy,
            isBuy ? _buyLimit(hypePerpAsset) : _sellLimit(hypePerpAsset),
            _abs(position),
            true,
            3,
            cloid
        );
        _submit(ActionKind.CloseHedge, action, position, _abs(position), 0, _abs(position), cloid);
    }

    function _processDebtSettlement() internal {
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
                ActionKind.ReleaseCollateral, releaseAction, 0, hypeLending.supply.value, hypeBalance.total, release, 0
            );
            return;
        }
        uint64 sellSize = needed;
        uint128 cloid = _consumeCloid();
        bytes memory sellAction = CoreActions.order(hypeSpotAsset, false, sellLimit, sellSize, false, 3, cloid);
        _submit(ActionKind.RepayDebt, sellAction, 0, quoteLending.borrow.value, hypeBalance.total, sellSize, cloid);
    }

    function _processCollateralWithdrawal() internal {
        if (phase != Phase.WithdrawingCollateral) revert InvalidPhase(Phase.WithdrawingCollateral, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory quoteLending = CoreRead.lending(address(this), quoteToken);
        if (quoteLending.borrow.value != 0) revert UnsupportedDebtState();
        if (quoteLending.supply.value != 0) {
            bytes memory withdrawQuote = CoreActions.withdrawAll(quoteToken);
            _submit(
                ActionKind.WithdrawQuote,
                withdrawQuote,
                0,
                quoteLending.supply.value,
                CoreRead.spotBalance(address(this), quoteToken).total,
                quoteLending.supply.value,
                0
            );
            return;
        }
        CoreRead.UserLending memory hypeLending = CoreRead.lending(address(this), hypeToken);
        if (hypeLending.supply.value == 0) {
            _setPhase(Phase.ConvertingQuote);
            return;
        }
        bytes memory action = CoreActions.withdrawAll(hypeToken);
        _submit(
            ActionKind.WithdrawCollateral,
            action,
            0,
            hypeLending.supply.value,
            CoreRead.spotBalance(address(this), hypeToken).total,
            hypeLending.supply.value,
            0
        );
    }

    function _processQuoteConversion() internal {
        if (phase != Phase.ConvertingQuote) revert InvalidPhase(Phase.ConvertingQuote, phase);
        _syncPendingAction();
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory quoteLending = CoreRead.lending(address(this), quoteToken);
        if (quoteLending.borrow.value != 0) revert UnsupportedDebtState();
        if (quoteLending.supply.value != 0) {
            bytes memory withdrawQuote = CoreActions.withdrawAll(quoteToken);
            _submit(
                ActionKind.WithdrawQuote,
                withdrawQuote,
                0,
                quoteLending.supply.value,
                CoreRead.spotBalance(address(this), quoteToken).total,
                quoteLending.supply.value,
                0
            );
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
        uint128 cloid = _consumeCloid();
        bytes memory action = CoreActions.order(hypeSpotAsset, true, buyLimit, buySize, false, 3, cloid);
        _submit(ActionKind.ConvertQuote, action, 0, quoteBalance.total, hypeBalance.total, buySize, cloid);
    }

    function _submitRecall() internal {
        if (phase != Phase.Recalling) revert InvalidPhase(Phase.Recalling, phase);
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        CoreRead.UserLending memory debt = CoreRead.lending(address(this), quoteToken);
        if (debt.borrow.value != 0) revert UnsupportedDebtState();
        int64 position = riskOracle.positionSize(address(this), hypePerpAsset);
        if (position != 0) revert UnexpectedPosition(position);
        CoreRead.SpotBalance memory balance = CoreRead.spotBalance(address(this), hypeToken);
        if (balance.hold != 0) revert CoreObservationPending();
        if (balance.total <= _coreGasReserve) {
            _finishReturn();
            return;
        }
        uint64 amount = balance.total - _coreGasReserve;
        bytes memory action = CoreActions.recallHype(hypeToken, amount);
        _submit(ActionKind.Recall, action, 0, balance.total, 0, amount, 0);
        pendingAction.receiptBefore = totalCoreHypeReceived;
        _setPhase(Phase.RecallPending);
    }

    /// @notice Account effects only. NoEffect/ReadUnavailable never authorize a retry.
    function pendingActionObservation() public view returns (ICoreActionObserver.Observation memory o) {
        PendingAction memory p = pendingAction;
        if (p.kind == ActionKind.None) return o;
        if (p.cycleId != cycleId) {
            o.evidence = ICoreActionObserver.Evidence.UnexpectedEffect;
            return o;
        }
        ICoreActionObserver.Context memory c = ICoreActionObserver.Context({
            account: address(this),
            hypeToken: hypeToken,
            quoteToken: quoteToken,
            perp: hypePerpAsset,
            kind: uint8(p.kind),
            submittedCoreBlock: p.submittedL1Block,
            positionBefore: p.positionBefore,
            primaryBefore: p.primaryBefore,
            secondaryBefore: p.secondaryBefore,
            amount: p.amount,
            receiptBefore: p.receiptBefore,
            received: totalCoreHypeReceived,
            nativeBalance: address(this).balance,
            riskOracle: address(riskOracle)
        });
        try actionObserver.observe(c) returns (ICoreActionObserver.Observation memory result) {
            return result;
        } catch (bytes memory reason) {
            o.evidence = ICoreActionObserver.Evidence.ReadUnavailable;
            o.readErrorHash = keccak256(reason);
        }
    }

    /// @notice Commit observed effects independently of the next order's price/read checks.
    /// @dev Partial IOC effects retain the existing one-writer/account-effects assumption, not receipt finality.
    function syncPendingAction() external nonReentrant returns (bool consumed) {
        if (pendingAction.kind == ActionKind.None) return false;
        ICoreActionObserver.Observation memory o = pendingActionObservation();
        _emitEvidence(o);
        if (!_canConsume(pendingAction.kind, o.evidence)) return false;
        _consumeObserved(o);
        return true;
    }

    function _canConsume(ActionKind kind, ICoreActionObserver.Evidence evidence) private pure returns (bool) {
        if (evidence == ICoreActionObserver.Evidence.ExpectedEffect) return true;
        return evidence == ICoreActionObserver.Evidence.PartialEffect
            && (kind == ActionKind.OpenHedge
                || kind == ActionKind.CloseHedge
                || kind == ActionKind.RepayDebt
                || kind == ActionKind.ConvertQuote);
    }

    function _emitEvidence(ICoreActionObserver.Observation memory o) private {
        emit CoreActionEvidence(pendingAction.actionId, o.evidence, o.coreBlock, o.effectAmount, o.readErrorHash);
    }

    function _syncPendingAction() internal {
        if (pendingAction.kind == ActionKind.None) return;
        ICoreActionObserver.Observation memory o = pendingActionObservation();
        if (!_canConsume(pendingAction.kind, o.evidence)) {
            if (pendingAction.kind == ActionKind.Recall) return;
            revert CoreObservationPending();
        }
        _emitEvidence(o);
        _consumeObserved(o);
    }

    function _consumeObserved(ICoreActionObserver.Observation memory o) private {
        PendingAction memory p = pendingAction;
        delete pendingAction;
        emit CoreActionObserved(p.kind, o.coreBlock);
        if (p.kind == ActionKind.Recall) {
            wrappedHype.deposit{value: uint256(p.amount) * CORE_CONVERSION}();
            // Receipt consumption must survive an unrelated terminal check (e.g. residual quote).
            _setPhase(Phase.Recalling);
        }
    }

    function _submit(
        ActionKind kind,
        bytes memory action,
        int64 positionBefore,
        uint64 primaryBefore,
        uint64 secondaryBefore,
        uint64 amount,
        uint128 cloid
    ) internal {
        if (pendingAction.kind != ActionKind.None) revert ActionOutstanding(pendingAction.kind);
        uint64 l1Block = CoreRead.l1Block();
        pendingAction = PendingAction({
            kind: kind,
            submittedL1Block: l1Block,
            positionBefore: positionBefore,
            primaryBefore: primaryBefore,
            secondaryBefore: secondaryBefore,
            amount: amount,
            receiptBefore: 0,
            cycleId: cycleId,
            actionId: nextActionId++,
            cloid: cloid,
            submittedAt: block.timestamp.toUint64(),
            actionHash: keccak256(action)
        });
        coreWriter.sendRawAction(action);
        emit CoreActionSubmitted(kind, l1Block, action);
        emit CoreActionIdentified(pendingAction.actionId, cycleId, cloid, pendingAction.actionHash);
    }

    function _buyLimit(uint32 market) internal view returns (uint64) {
        return riskOracle.buyLimit(market);
    }

    function _sellLimit(uint32 market) internal view returns (uint64) {
        return riskOracle.sellLimit(market);
    }

    function _consumeCloid() internal returns (uint128 cloid) {
        cloid = _nextCloid++;
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
}
