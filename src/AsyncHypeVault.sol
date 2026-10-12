// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {EpochRedeem} from "./vault/EpochRedeem.sol";
import {IERC7540Operator, IERC7540Redeem} from "./interfaces/IERC7540.sol";
import {IERC7575, IERC7575Share} from "./interfaces/IERC7575.sol";
import {IHyperCoreStrategyAccount} from "./interfaces/IHyperCoreStrategyAccount.sol";
import {IHyperCoreNavReader} from "./interfaces/IHyperCoreNavReader.sol";

/// @notice ERC-7540 redemption accounting with a separately bound Core custody account.
/// @dev Integration-gated prototype: active NAV is explicitly an estimate, not verified PM equity.
contract AsyncHypeVault is EpochRedeem, AccessControlDefaultAdminRules {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant BOOTSTRAP_ROLE = keccak256("BOOTSTRAP_ROLE");
    uint64 public constant MAX_NAV_AGE = 5 minutes;

    enum Phase {
        Unbound,
        Idle,
        Deploying,
        Active,
        Exiting,
        Closed
    }

    struct Config {
        address asset;
        address admin;
        address manager;
        address guardian;
        address bootstrap;
        address factory;
        address navReader;
        address dustRecipient;
        bytes32 strategyConfigHash;
        uint256 maxAssets;
        uint256 recapCap;
        uint64 openingTimeout;
        uint64 cycleDuration;
        uint48 adminDelay;
    }

    struct Cycle {
        uint256 epochId;
        uint256 allocatedAssets;
        uint256 recapitalizedAssets;
        uint64 openDeadline;
        uint64 cycleEnd;
        bool exitRequested;
        bool settled;
    }

    address public immutable deploymentFactory;
    IHyperCoreNavReader public immutable navReader;
    bytes32 public immutable strategyConfigHash;
    uint256 public immutable maximumTotalAssets;
    uint256 public immutable recapitalizationCap;
    uint64 public immutable openingTimeout;
    uint64 public immutable cycleDuration;
    IHyperCoreStrategyAccount public strategy;
    Phase public phase;
    bool public riskPaused;
    bool public shutdown;
    uint256 public currentCycleId;
    mapping(uint256 => Cycle) public cycles;
    int256 public lastStrategyNav;
    IHyperCoreNavReader.Quality public navQuality;
    uint64 public navAsOfCoreBlock;
    uint64 public navObservedAt;
    bool public navInFlight;

    error InvalidConfiguration();
    error NotBound();
    error AlreadyBound();
    error WrongCycle();
    error CapitalClosed();
    error ExitNotReady();
    error StrategyNotReturnReady();
    error ReturnAmountMismatch();
    error RecapitalizationCapExceeded();
    error ClaimReserveViolation();

    event StrategyBound(address indexed strategy);
    event CycleAllocated(uint256 indexed cycleId, uint256 indexed epochId, uint256 assets, uint64 cycleEnd);
    event ExitRequested(uint256 indexed cycleId);
    event StrategyReturned(uint256 indexed cycleId, uint256 assets);
    event NavCheckpointed(int256 strategyAssets, IHyperCoreNavReader.Quality quality, uint64 coreBlock);
    event RiskPaused(bool paused);
    event VaultUpdate(address indexed asset, address vault);

    constructor(Config memory c)
        EpochRedeem(IERC20(c.asset), c.dustRecipient, "HyperCore HYPE Carry Share", "hcHYPE")
        AccessControlDefaultAdminRules(c.adminDelay, c.admin)
    {
        if (
            c.asset.code.length == 0 || c.factory == address(0) || c.navReader.code.length == 0
                || c.manager == address(0) || c.guardian == address(0) || c.bootstrap == address(0) || c.maxAssets == 0
                || c.maxAssets > type(uint128).max || c.recapCap > c.maxAssets || c.openingTimeout == 0
                || c.cycleDuration <= c.openingTimeout || decimals() != 21
        ) {
            revert InvalidConfiguration();
        }
        deploymentFactory = c.factory;
        navReader = IHyperCoreNavReader(c.navReader);
        strategyConfigHash = c.strategyConfigHash;
        maximumTotalAssets = c.maxAssets;
        recapitalizationCap = c.recapCap;
        openingTimeout = c.openingTimeout;
        cycleDuration = c.cycleDuration;
        _grantRole(MANAGER_ROLE, c.manager);
        _grantRole(GUARDIAN_ROLE, c.guardian);
        _grantRole(BOOTSTRAP_ROLE, c.bootstrap);
        emit VaultUpdate(c.asset, address(this));
    }

    function bindStrategyOnce(address account) external {
        if (msg.sender != deploymentFactory) revert UnauthorizedController();
        if (address(strategy) != address(0)) revert AlreadyBound();
        IHyperCoreStrategyAccount candidate = IHyperCoreStrategyAccount(account);
        if (
            candidate.vault() != address(this) || candidate.asset() != asset()
                || candidate.configHash() != strategyConfigHash
        ) revert InvalidConfiguration();
        strategy = candidate;
        phase = Phase.Idle;
        _recordLocalNav(0, IHyperCoreNavReader.Quality.Realized, false);
        emit StrategyBound(account);
    }

    function supportsInterface(bytes4 id) public view override returns (bool) {
        return id == type(IERC7540Operator).interfaceId || id == type(IERC7540Redeem).interfaceId || id == 0x2f0a18c5
            || id == type(IERC7575).interfaceId || id == type(IERC7575Share).interfaceId || super.supportsInterface(id);
    }

    function vault(address underlying) external view returns (address) {
        return underlying == asset() ? address(this) : address(0);
    }

    function availableCash() public view returns (uint256) {
        uint256 balance = IERC20(asset()).balanceOf(address(this));
        if (balance < reservedClaimAssets) revert ClaimReserveViolation();
        return balance - reservedClaimAssets;
    }

    /// @dev Cached estimate while active; never used to price actual deposits or settlements.
    function totalAssets() public view override returns (uint256) {
        uint256 cash = availableCash();
        if (lastStrategyNav >= 0) return cash + uint256(lastStrategyNav);
        uint256 deficit = uint256(-(lastStrategyNav + 1)) + 1;
        return cash > deficit ? cash - deficit : 0;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (!_capitalOpen() || receiver == address(0) || receiver == address(this)) return 0;
        uint256 assets = availableCash();
        if (assets >= maximumTotalAssets) return 0;
        uint256 capacity = maximumTotalAssets - assets;
        // If even the full capacity mints no shares, every permitted positive deposit would revert.
        return previewDeposit(capacity) == 0 ? 0 : capacity;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        return _convertToShares(maxDeposit(receiver), Math.Rounding.Floor);
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
        return _depositAssets(assets, receiver, msg.sender);
    }

    function deposit(uint256 assets, address receiver, address controller) external nonReentrant returns (uint256) {
        _authorizeController(controller);
        return _depositAssets(assets, receiver, controller);
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return _mintShares(shares, receiver, msg.sender);
    }

    function mint(uint256 shares, address receiver, address controller) external nonReentrant returns (uint256) {
        _authorizeController(controller);
        return _mintShares(shares, receiver, controller);
    }

    function _depositAssets(uint256 assets, address receiver, address controller) private returns (uint256 shares) {
        if (assets == 0 || assets > maxDeposit(receiver)) revert CapitalClosed();
        shares = previewDeposit(assets);
        if (shares == 0) revert InvalidAmount();
        _fundDeposit(receiver, controller, assets, shares);
    }

    function _mintShares(uint256 shares, address receiver, address controller) private returns (uint256 assets) {
        if (shares == 0 || shares > maxMint(receiver)) revert CapitalClosed();
        assets = previewMint(shares);
        if (assets > maxDeposit(receiver)) revert CapitalClosed();
        _fundDeposit(receiver, controller, assets, shares);
    }

    function _fundDeposit(address receiver, address controller, uint256 assets, uint256 shares) private {
        // Match OZ's transfer-before-mint ordering while separating funder from event controller.
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(controller, receiver, assets, shares);
    }

    function _capitalOpen() private view returns (bool) {
        return phase == Phase.Idle && !riskPaused && !shutdown;
    }

    function _requestEpoch() internal override returns (uint256 id, bool instant) {
        if (phase == Phase.Unbound) revert NotBound();
        if (phase == Phase.Idle || phase == Phase.Closed) return (nextEpochId++, true);
        if (phase == Phase.Exiting) revert EpochClosed();
        return (cycles[currentCycleId].epochId, false);
    }

    function _settlementCash() internal view override returns (uint256) {
        return availableCash();
    }

    function startCycle(uint256 assets) external onlyRole(MANAGER_ROLE) nonReentrant returns (uint256 id) {
        if (!_capitalOpen()) revert CapitalClosed();
        if (assets == 0 || totalSupply() == 0 || assets > availableCash()) revert InvalidAmount();
        id = ++currentCycleId;
        uint256 epochId = nextEpochId++;
        uint64 end = (block.timestamp + cycleDuration).toUint64();
        uint64 openDeadline = (block.timestamp + openingTimeout).toUint64();
        cycles[id] = Cycle(epochId, assets, 0, openDeadline, end, false, false);
        phase = Phase.Deploying;
        _recordLocalNav(assets.toInt256(), IHyperCoreNavReader.Quality.CapitalEstimate, true);
        IERC20(asset()).forceApprove(address(strategy), assets);
        uint256 beforeBalance = IERC20(asset()).balanceOf(address(this));
        strategy.startCycle(id, assets, openDeadline, end);
        if (
            IERC20(asset()).allowance(address(this), address(strategy)) != 0
                || beforeBalance - IERC20(asset()).balanceOf(address(this)) != assets
        ) revert ReturnAmountMismatch();
        emit CycleAllocated(id, epochId, assets, end);
    }

    /// @notice Explicit bootstrap attestation; Core currently has no PM success readback in this adapter.
    function confirmPortfolioMargin(uint256 id) external onlyRole(BOOTSTRAP_ROLE) nonReentrant {
        _checkCycle(id);
        if (cycles[id].exitRequested || riskPaused || block.timestamp >= cycles[id].openDeadline) {
            revert CapitalClosed();
        }
        strategy.confirmPortfolioMargin(id);
    }

    function syncPhase() external {
        if (phase != Phase.Deploying) return;
        IHyperCoreStrategyAccount.CycleStatus memory status = strategy.cycleStatus();
        if (status.cycleId != currentCycleId) revert WrongCycle();
        // Active phase is exposed as 4 in the strategy interface implementation.
        if (status.phase == 4 && !status.exitRequested) phase = Phase.Active;
    }

    function beginExit(uint256 id) external nonReentrant {
        _checkCycle(id);
        Cycle storage c = cycles[id];
        IHyperCoreStrategyAccount.CycleStatus memory status = strategy.cycleStatus();
        bool openingExpired = status.phase != 4 && block.timestamp >= c.openDeadline;
        if (
            !shutdown && !riskPaused && !hasRole(GUARDIAN_ROLE, msg.sender) && block.timestamp < c.cycleEnd
                && !openingExpired
        ) revert ExitNotReady();
        if (c.exitRequested) revert EpochClosed();
        c.exitRequested = true;
        epochs[c.epochId].isSealed = true;
        phase = Phase.Exiting;
        strategy.requestExit(id);
        emit ExitRequested(id);
    }

    function recapitalize(uint256 id) external nonReentrant {
        _checkCycle(id);
        if (phase != Phase.Exiting) revert ExitNotReady();
        Cycle storage c = cycles[id];
        uint256 amount = strategy.requiredRecapitalization();
        if (amount == 0 || amount > availableCash()) revert InvalidAmount();
        if (c.recapitalizedAssets + amount > recapitalizationCap) revert RecapitalizationCapExceeded();
        c.recapitalizedAssets += amount;
        _recordLocalNav(
            (c.allocatedAssets + c.recapitalizedAssets).toInt256(), IHyperCoreNavReader.Quality.CapitalEstimate, true
        );
        IERC20(asset()).forceApprove(address(strategy), amount);
        uint256 beforeBalance = IERC20(asset()).balanceOf(address(this));
        strategy.recapitalize(id, amount);
        if (
            IERC20(asset()).allowance(address(this), address(strategy)) != 0
                || beforeBalance - IERC20(asset()).balanceOf(address(this)) != amount
        ) revert ReturnAmountMismatch();
    }

    function settleEpoch(uint256 id) external nonReentrant {
        _checkCycle(id);
        if (phase != Phase.Exiting) revert ExitNotReady();
        IHyperCoreStrategyAccount.CycleStatus memory status = strategy.cycleStatus();
        if (status.cycleId != id || !status.returnReady || status.pending) revert StrategyNotReturnReady();
        uint256 beforeBalance = IERC20(asset()).balanceOf(address(this));
        uint256 returned = strategy.returnToVault(id);
        if (IERC20(asset()).balanceOf(address(this)) - beforeBalance != returned) revert ReturnAmountMismatch();
        cycles[id].settled = true;
        _recordLocalNav(0, IHyperCoreNavReader.Quality.Realized, false);
        _settleRedeemEpoch(cycles[id].epochId, availableCash());
        phase = shutdown ? Phase.Closed : Phase.Idle;
        emit StrategyReturned(id, returned);
    }

    function _checkCycle(uint256 id) private view {
        if (id == 0 || id != currentCycleId || cycles[id].settled) revert WrongCycle();
    }

    function setRiskPaused(bool paused) external onlyRole(GUARDIAN_ROLE) nonReentrant {
        if (shutdown && !paused) revert CapitalClosed();
        if (address(strategy) == address(0)) revert NotBound();
        riskPaused = paused;
        strategy.setRiskPaused(paused);
        emit RiskPaused(paused);
    }

    function permanentlyShutdown() external onlyRole(GUARDIAN_ROLE) nonReentrant {
        if (address(strategy) == address(0)) revert NotBound();
        shutdown = true;
        riskPaused = true;
        strategy.setRiskPaused(true);
        if (phase == Phase.Idle) phase = Phase.Closed;
        emit RiskPaused(true);
    }

    function checkpointNav() external nonReentrant {
        if (address(strategy) == address(0)) revert NotBound();
        if (phase == Phase.Idle || phase == Phase.Closed) {
            _recordLocalNav(0, IHyperCoreNavReader.Quality.Realized, false);
        } else {
            try strategy.cycleStatus() returns (IHyperCoreStrategyAccount.CycleStatus memory status) {
                _checkpointStrategyNav(status);
            } catch {
                navQuality = IHyperCoreNavReader.Quality.Unavailable;
            }
        }
        emit NavCheckpointed(lastStrategyNav, navQuality, navAsOfCoreBlock);
    }

    function _checkpointStrategyNav(IHyperCoreStrategyAccount.CycleStatus memory status) private {
        try navReader.observe(address(strategy)) returns (IHyperCoreNavReader.Observation memory o) {
            if (
                o.cycleId != currentCycleId || status.cycleId != currentCycleId || !_fresh(o.observedAt)
                    || o.observedAt < navObservedAt || o.quality == IHyperCoreNavReader.Quality.Unavailable
                    || !_qualityMatchesState(o.quality, status, o.inFlight)
                    || (o.quality == IHyperCoreNavReader.Quality.MarkToMarket && !_matchesCoreBlock(o.asOfCoreBlock))
                    || (o.asOfCoreBlock != 0 && o.asOfCoreBlock < navAsOfCoreBlock)
            ) {
                navQuality = IHyperCoreNavReader.Quality.Unavailable;
                return;
            }
            lastStrategyNav = o.netAssets;
            navQuality = o.quality;
            navAsOfCoreBlock = o.asOfCoreBlock;
            navObservedAt = o.observedAt;
            navInFlight = o.inFlight || status.pending;
        } catch {
            // Keep the last accepted value and its timestamp; do not turn a read failure into zero NAV.
            navQuality = IHyperCoreNavReader.Quality.Unavailable;
        }
    }

    /// @notice Quality after checking cache age and current execution state. Does NOT authorize active deposits.
    function effectiveNavQuality() external view returns (IHyperCoreNavReader.Quality) {
        if (phase == Phase.Unbound) return IHyperCoreNavReader.Quality.Unavailable;
        if (phase == Phase.Idle || phase == Phase.Closed) return IHyperCoreNavReader.Quality.Realized;
        if (!_fresh(navObservedAt)) return IHyperCoreNavReader.Quality.Unavailable;
        if (navQuality == IHyperCoreNavReader.Quality.MarkToMarket && !_matchesCoreBlock(navAsOfCoreBlock)) {
            return IHyperCoreNavReader.Quality.Unavailable;
        }
        try strategy.cycleStatus() returns (IHyperCoreStrategyAccount.CycleStatus memory status) {
            if (status.cycleId == currentCycleId && _qualityMatchesState(navQuality, status, navInFlight)) {
                return navQuality;
            }
        } catch {}
        return IHyperCoreNavReader.Quality.Unavailable;
    }

    function _qualityMatchesState(
        IHyperCoreNavReader.Quality quality,
        IHyperCoreStrategyAccount.CycleStatus memory status,
        bool inFlight
    ) private pure returns (bool) {
        if (quality == IHyperCoreNavReader.Quality.CapitalEstimate) return true;
        if (status.pending || inFlight) return false;
        if (quality == IHyperCoreNavReader.Quality.MarkToMarket) {
            return status.phase == 4 && !status.exitRequested && !status.returnReady;
        }
        return quality == IHyperCoreNavReader.Quality.Realized && status.returnReady && status.phase == 11;
    }

    function _fresh(uint64 observedAt) private view returns (bool) {
        return observedAt != 0 && observedAt <= block.timestamp && block.timestamp - observedAt <= MAX_NAV_AGE;
    }

    function _matchesCoreBlock(uint64 expected) private view returns (bool) {
        (bool ok, bytes memory data) = address(0x0809).staticcall{gas: 50_000}(abi.encode());
        // Read as uint256 so a malformed uint64 encoding is rejected without a decode revert.
        return ok && data.length == 32 && expected != 0 && abi.decode(data, (uint256)) == expected;
    }

    function _recordLocalNav(int256 value, IHyperCoreNavReader.Quality quality, bool inFlight) private {
        lastStrategyNav = value;
        navQuality = quality;
        navAsOfCoreBlock = 0;
        navObservedAt = block.timestamp.toUint64();
        navInFlight = inFlight;
    }
}
