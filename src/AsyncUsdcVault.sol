// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {
    AccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {EpochRedeem} from "./vault/EpochRedeem.sol";
import {IUsdcCycleStrategy} from "./interfaces/IUsdcCycleStrategy.sol";
import {IERC7540Operator, IERC7540Redeem} from "./interfaces/IERC7540.sol";
import {IERC7575, IERC7575Share} from "./interfaces/IERC7575.sol";

interface ICoreDepositWallet {
    function depositFor(address recipient, uint256 amount, uint32 destinationId) external;
}

/// @notice USDC-share accounting and ERC-7540 redemption for a future multi-market Core strategy.
/// @dev Core funding is functional, but this contract has no production strategy/terminal verifier yet.
///      Never bind an unverified strategy or use this as a live-funds deployment.
contract AsyncUsdcVault is EpochRedeem, AccessControlDefaultAdminRules {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint32 public constant SPOT_DEX = type(uint32).max;

    enum Phase {
        Unbound,
        Idle,
        Active,
        Exiting,
        Closed
    }

    struct Config {
        address asset;
        address coreDepositWallet;
        address factory;
        address admin;
        address manager;
        address guardian;
        address dustRecipient;
        bytes32 strategyConfigHash;
        uint32 destinationDex;
        uint48 adminDelay;
        uint64 cycleDuration;
        uint256 maxAssets;
    }

    IERC20 public immutable usdc;
    ICoreDepositWallet public immutable coreDepositWallet;
    address public immutable deploymentFactory;
    bytes32 public immutable strategyConfigHash;
    uint32 public immutable destinationDex;
    uint64 public immutable cycleDuration;
    uint256 public immutable maximumTotalAssets;
    IUsdcCycleStrategy public strategy;
    Phase public phase;
    bool public riskPaused;
    uint256 public currentCycleId;
    uint256 public activeEpochId;
    uint64 public cycleEnd;
    uint256 public capitalEstimate;
    uint256 public accountedCash;

    error InvalidConfiguration();
    error NotBound();
    error AlreadyBound();
    error CapitalClosed();
    error WrongCycle();
    error ExitNotReady();
    error ReturnNotReady();
    error BalanceMismatch();
    error ClaimReserveViolation();
    error SlippageOrDeadline();
    error AccountedCashDeficit();

    event StrategyBound(address indexed strategy);
    event CycleAllocated(uint256 indexed cycleId, uint256 indexed epochId, uint256 assets);
    event ExitRequested(uint256 indexed cycleId);
    event StrategyReturned(uint256 indexed cycleId, uint256 assets);
    event RiskPaused(bool paused);
    event VaultUpdate(address indexed asset, address vault);

    constructor(Config memory c)
        EpochRedeem(IERC20(c.asset), c.dustRecipient, "HyperCore USDC Vault Share", "hcUSDC")
        AccessControlDefaultAdminRules(c.adminDelay, c.admin)
    {
        if (
            c.asset.code.length == 0 || c.coreDepositWallet.code.length == 0 || c.factory == address(0)
                || c.manager == address(0) || c.guardian == address(0) || c.strategyConfigHash == bytes32(0)
                || c.maxAssets == 0 || c.maxAssets > type(uint128).max || c.cycleDuration == 0
                || (c.destinationDex != 0 && c.destinationDex != SPOT_DEX) || IERC20Metadata(c.asset).decimals() != 6
                || decimals() != 9
        ) revert InvalidConfiguration();
        usdc = IERC20(c.asset);
        coreDepositWallet = ICoreDepositWallet(c.coreDepositWallet);
        deploymentFactory = c.factory;
        strategyConfigHash = c.strategyConfigHash;
        destinationDex = c.destinationDex;
        cycleDuration = c.cycleDuration;
        maximumTotalAssets = c.maxAssets;
        _grantRole(MANAGER_ROLE, c.manager);
        _grantRole(GUARDIAN_ROLE, c.guardian);
        emit VaultUpdate(c.asset, address(this));
    }

    function bindStrategyOnce(address account) external {
        if (msg.sender != deploymentFactory) revert UnauthorizedController();
        if (address(strategy) != address(0)) revert AlreadyBound();
        if (account.code.length == 0) revert InvalidConfiguration();
        IUsdcCycleStrategy candidate = IUsdcCycleStrategy(account);
        if (
            candidate.vault() != address(this) || candidate.asset() != asset()
                || candidate.configHash() != strategyConfigHash
        ) revert InvalidConfiguration();
        strategy = candidate;
        phase = Phase.Idle;
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
        uint256 balance = usdc.balanceOf(address(this));
        if (balance < accountedCash) revert AccountedCashDeficit();
        if (accountedCash < reservedClaimAssets) revert ClaimReserveViolation();
        return accountedCash - reservedClaimAssets;
    }

    function unaccountedUsdc() external view returns (uint256) {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance < accountedCash) revert AccountedCashDeficit();
        return balance - accountedCash;
    }

    /// @dev During Active/Exiting this includes unverified original capital, not a trading NAV.
    ///      It is never used for a deposit or an epoch settlement while capital is in Core.
    function totalAssets() public view override returns (uint256) {
        return availableCash() + capitalEstimate;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (phase != Phase.Idle || riskPaused || receiver == address(0) || receiver == address(this)) return 0;
        uint256 cash = availableCash();
        // Do not recapitalize outstanding zero-value shares with a new user's deposit.
        if (cash == 0 && totalSupply() != 0) return 0;
        if (cash >= maximumTotalAssets) return 0;
        uint256 capacity = maximumTotalAssets - cash;
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

    function depositWithLimit(uint256 assets, address receiver, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert SlippageOrDeadline();
        shares = _depositAssets(assets, receiver, msg.sender);
        if (shares < minShares) revert SlippageOrDeadline();
    }

    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
        return _mintShares(shares, receiver, msg.sender);
    }

    function mint(uint256 shares, address receiver, address controller) external nonReentrant returns (uint256) {
        _authorizeController(controller);
        return _mintShares(shares, receiver, controller);
    }

    function mintWithLimit(uint256 shares, address receiver, uint256 maxAssets, uint256 deadline)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (block.timestamp > deadline) revert SlippageOrDeadline();
        assets = _mintShares(shares, receiver, msg.sender);
        if (assets > maxAssets) revert SlippageOrDeadline();
    }

    function _depositAssets(uint256 assets, address receiver, address controller) private returns (uint256 shares) {
        if (assets == 0 || assets > maxDeposit(receiver)) revert CapitalClosed();
        shares = previewDeposit(assets);
        if (shares == 0) revert InvalidAmount();
        _fundDeposit(assets, receiver, controller, shares);
    }

    function _mintShares(uint256 shares, address receiver, address controller) private returns (uint256 assets) {
        if (shares == 0 || shares > maxMint(receiver)) revert CapitalClosed();
        assets = previewMint(shares);
        if (assets > maxDeposit(receiver)) revert CapitalClosed();
        _fundDeposit(assets, receiver, controller, shares);
    }

    function _fundDeposit(uint256 assets, address receiver, address controller, uint256 shares) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        if (usdc.balanceOf(address(this)) - beforeBalance != assets) revert BalanceMismatch();
        accountedCash += assets;
        _mint(receiver, shares);
        emit Deposit(controller, receiver, assets, shares);
    }

    function startCycle(uint256 assets) external onlyRole(MANAGER_ROLE) nonReentrant returns (uint256 id) {
        if (phase != Phase.Idle || riskPaused) revert CapitalClosed();
        if (assets == 0 || totalSupply() == 0 || assets > availableCash()) revert InvalidAmount();
        id = ++currentCycleId;
        activeEpochId = nextEpochId++;
        cycleEnd = (block.timestamp + cycleDuration).toUint64();
        capitalEstimate = assets;
        accountedCash -= assets;
        phase = Phase.Active;
        strategy.startCycle(id, assets);
        usdc.forceApprove(address(coreDepositWallet), assets);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        coreDepositWallet.depositFor(address(strategy), assets, destinationDex);
        if (beforeBalance - usdc.balanceOf(address(this)) != assets) revert BalanceMismatch();
        usdc.forceApprove(address(coreDepositWallet), 0);
        emit CycleAllocated(id, activeEpochId, assets);
    }

    function beginExit(uint256 id) external nonReentrant {
        if (id != currentCycleId || phase != Phase.Active) revert WrongCycle();
        if (!riskPaused && !hasRole(GUARDIAN_ROLE, msg.sender) && block.timestamp < cycleEnd) {
            revert ExitNotReady();
        }
        phase = Phase.Exiting;
        epochs[activeEpochId].isSealed = true;
        strategy.requestExit(id);
        emit ExitRequested(id);
    }

    function settleEpoch(uint256 id) external nonReentrant {
        if (id != currentCycleId || phase != Phase.Exiting) revert WrongCycle();
        if (!strategy.returnReady(id)) revert ReturnNotReady();
        uint256 beforeBalance = usdc.balanceOf(address(this));
        uint256 returned = strategy.returnToVault(id);
        if (usdc.balanceOf(address(this)) - beforeBalance != returned) revert BalanceMismatch();
        accountedCash += returned;
        capitalEstimate = 0;
        _settleRedeemEpoch(activeEpochId, availableCash());
        phase = Phase.Idle;
        emit StrategyReturned(id, returned);
    }

    function setRiskPaused(bool paused) external onlyRole(GUARDIAN_ROLE) {
        if (phase == Phase.Unbound || phase == Phase.Closed) revert CapitalClosed();
        riskPaused = paused;
        strategy.setRiskPaused(paused);
        emit RiskPaused(paused);
    }

    function closeWhenIdle() external onlyRole(GUARDIAN_ROLE) {
        if (phase != Phase.Idle) revert CapitalClosed();
        riskPaused = true;
        strategy.setRiskPaused(true);
        phase = Phase.Closed;
    }

    function _requestEpoch() internal override returns (uint256 id, bool instant) {
        if (phase == Phase.Unbound) revert NotBound();
        if (phase == Phase.Exiting) revert EpochClosed();
        if (phase == Phase.Idle || phase == Phase.Closed) return (nextEpochId++, true);
        return (activeEpochId, false);
    }

    function _settlementCash() internal view override returns (uint256) {
        return availableCash();
    }

    function _beforeAssetPayout(uint256 assets) internal override {
        if (usdc.balanceOf(address(this)) < accountedCash) revert AccountedCashDeficit();
        accountedCash -= assets;
    }
}
