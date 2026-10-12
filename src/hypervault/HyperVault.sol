// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ManagedUpgradeController} from "../managed/ManagedUpgradeController.sol";
import {CoreActions, ICoreWriter} from "../CoreActions.sol";
import {CoreRead} from "../CoreRead.sol";
import {ManagedCoreActions} from "../managed/ManagedCoreActions.sol";
import {ManagedAssetBridge} from "../managed/ManagedAssetBridge.sol";
import {IManagedVaultVerifier} from "../interfaces/IManagedVaultVerifier.sol";
import {IManagedNavVerifier} from "../interfaces/IManagedNavVerifier.sol";
import {IERC7540Operator, IERC7540Redeem} from "../interfaces/IERC7540.sol";
import {HyperVaultShare} from "./HyperVaultShare.sol";
import {HyperVaultAccountant} from "./HyperVaultAccountant.sol";
import {HyperVaultTypes} from "./HyperVaultTypes.sol";
import {HyperVaultCoreOps} from "./HyperVaultCoreOps.sol";

interface IHyperVaultOracleGate {
    function oracleOnly(address vault) external view returns (bool);
}

/// @notice HyperVault manager (ERC-7575 vault, ERC-7540 async redeem). Laid out like kHYPE:
///         this contract takes deposits, queues redemptions and runs the strategy account; the
///         share is a separate, freely transferable ERC-20 (`share()`); the exchange rate and the
///         high-water-mark fee live in the Accountant.
/// @dev The proxy address is the Vault's own HyperCore account. Core management, NAV evidence
///      and exits are those of ManagedAssetVault (v1); this is a fresh deployment, not an upgrade.
///      Every share of an epoch is paid the same price: there is no per-holder cost basis.
contract HyperVault is HyperVaultTypes, ReentrancyGuard, IERC7540Operator, IERC7540Redeem {
    using SafeERC20 for IERC20;

    uint32 public constant SPOT_DEX = type(uint32).max;

    uint256 public constant PLATFORM_SHARE_BPS = 2000;
    uint256 public constant DEPOSIT_PRICE_TOLERANCE_BPS = 20;
    /// @dev Kept in the Vault on `redeemNow`: about the spot + perp taker cost of the unwind a
    ///      leaver at the mark skips, so the holders who stay do not pay it.
    uint256 public constant INSTANT_EXIT_FEE_BPS = 10;
    IERC20 private immutable _asset;
    HyperVaultShare private immutable _share;
    HyperVaultAccountant public immutable accountant;
    ManagedAssetBridge public immutable bridge;
    address public immutable owner;
    address public immutable treasury;
    ICoreWriter public immutable coreWriter;
    IManagedVaultVerifier public immutable verifier;
    address public immutable builder;
    uint64 public immutable builderFeeCap;
    ManagedUpgradeController public immutable upgradeController;
    uint256 public immutable activationCost;
    uint256 public immutable maximumAssets;
    bytes32 public immutable configHash;
    address private immutable _implementationSelf = address(this);
    uint16 private immutable _initialFeeBps;
    uint256 private immutable _initialMinimumDeposit;

    // Proxy storage: the whole mutable state is one struct (HyperVaultTypes.Layout), passed by
    // storage reference to HyperVaultCoreOps. Append only, at the struct's end.
    Layout private $;

    constructor(Config memory c) {
        if (
            c.asset.code.length == 0 || c.coreWriter.code.length == 0 || c.verifier.code.length == 0
                || c.chainId != block.chainid || c.maximumAssets == 0 || c.maximumAssets > type(uint128).max
                || c.activationCost > 100e6 || (c.builder == address(0) && c.builderFeeCap != 0)
                || c.bridge.code.length == 0 || c.upgradeController.code.length == 0 || c.performanceFeeBps > 5_000
                || c.minimumDeposit == 0 || c.minimumDeposit > c.maximumAssets || c.owner == address(0)
                || c.treasury == address(0) || c.share.code.length == 0 || c.accountant.code.length == 0
        ) revert InvalidConfiguration();
        bridge = ManagedAssetBridge(c.bridge);
        _share = HyperVaultShare(c.share);
        accountant = HyperVaultAccountant(c.accountant);
        if (
            bridge.asset() != c.asset || _share.decimals() != IERC20Metadata(c.asset).decimals() + 3
                || address(accountant.history()) != c.verifier
        ) revert InvalidConfiguration();
        _asset = IERC20(c.asset);
        owner = c.owner;
        treasury = c.treasury;
        coreWriter = ICoreWriter(c.coreWriter);
        verifier = IManagedVaultVerifier(c.verifier);
        builder = c.builder;
        builderFeeCap = c.builderFeeCap;
        activationCost = c.activationCost;
        maximumAssets = c.maximumAssets;
        upgradeController = ManagedUpgradeController(c.upgradeController);
        _initialFeeBps = c.performanceFeeBps;
        _initialMinimumDeposit = c.minimumDeposit;
        configHash = keccak256(abi.encode(c));
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------- ERC-7575 / views

    function asset() external view returns (address) {
        return address(_asset);
    }

    function share() external view returns (address) {
        return address(_share);
    }

    /// @notice Share supply, including shares escrowed for pending redemptions (the verifier's
    ///         share-price denominator).
    function totalSupply() public view returns (uint256) {
        return _share.totalSupply();
    }

    /// @dev Read-only conveniences for v1 readers; the share token is `share()`.
    function name() external view returns (string memory) {
        return _share.name();
    }

    function decimals() external view returns (uint8) {
        return _share.decimals();
    }

    function balanceOf(address account) external view returns (uint256) {
        return _share.balanceOf(account);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x2f0a18c5 || id == type(IERC7540Operator).interfaceId
            || id == type(IERC7540Redeem).interfaceId;
    }

    function proxyAdmin() external view returns (address) {
        return ERC1967Utils.getAdmin();
    }

    function upgradeReady() external view returns (bool) {
        return $.phase == Phase.Idle && $.pendingAction.id == 0 && $.apiWallet == address(0);
    }

    function disabledAgent() external view returns (address) {
        return HyperVaultCoreOps.disabledAgent();
    }

    function availableCash() public view returns (uint256) {
        if (_asset.balanceOf(address(this)) < $.accountedCash || $.accountedCash < $.reservedClaimAssets) {
            revert CashDeficit();
        }
        return $.accountedCash - $.reservedClaimAssets;
    }

    function unaccountedUsdc() external view returns (uint256) {
        uint256 actual = _asset.balanceOf(address(this));
        if (actual < $.accountedCash) revert CashDeficit();
        return actual - $.accountedCash;
    }

    // ---------------------------------------------------------------- NAV, rate and fee

    /// @notice Live shareholder assets, and whether they are realized EVM cash. Reverts when the
    ///         NAV cannot be verified (Core action pending, a failed or refused read, exit).
    function liveNav() public view returns (uint256 assets, bool realized) {
        if ($.phase == Phase.Idle || $.phase == Phase.AwaitingActivation) return (availableCash(), true);
        if (($.phase != Phase.Ready && $.phase != Phase.Active) || $.pendingAction.id != 0) revert NavUnavailable();
        (assets,) = IManagedNavVerifier(address(verifier)).verifyNav(address(this), $.actionNonce, configHash);
    }

    /// @notice Cash when Idle; otherwise at the Accountant's last verified rate. Never reverts on
    ///         an unverifiable NAV (ERC-4626); see `HyperVaultAccountant.marks` for its age.
    function totalAssets() external view returns (uint256) {
        if ($.phase == Phase.Idle || $.phase == Phase.AwaitingActivation) return availableCash();
        uint256 value = accountant.convertToAssets(address(this), totalSupply() + 1000);
        return value == 0 ? 0 : value - 1;
    }

    /// @notice At the last verified, conservative rate: never reverts, may be stale.
    function convertToShares(uint256 assets) external view returns (uint256) {
        return accountant.convertToShares(address(this), assets);
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return accountant.convertToAssets(address(this), shares);
    }

    /// @notice Charge the high-water-mark fee and refresh the rate at the verified NAV. Anyone.
    function checkpoint() external nonReentrant {
        (uint256 nav, bool realized) = liveNav();
        _crystallize(nav, realized);
    }

    function _crystallize(uint256 nav, bool realized) private {
        uint256 feeShares = accountant.crystallize(nav, realized);
        if (feeShares != 0) {
            uint256 platform = feeShares * PLATFORM_SHARE_BPS / 10_000;
            _share.mint(treasury, platform);
            _share.mint(owner, feeShares - platform);
            emit PerformanceFeeMinted(feeShares - platform, platform);
        }
    }

    // ---------------------------------------------------------------- deposits

    function maxDeposit(address receiver) public view returns (uint256) {
        try this.liveNav() returns (uint256 nav, bool realized) {
            return _room(receiver, nav, realized);
        } catch {
            return 0;
        }
    }

    function maxMint(address receiver) external view returns (uint256) {
        uint256 room = maxDeposit(receiver);
        return room == 0 ? 0 : _toShares(room, Math.Rounding.Floor);
    }

    /// @dev Previews price at the live NAV after the fee the same call would charge.
    function previewDeposit(uint256 assets) external view returns (uint256) {
        return _toShares(assets, Math.Rounding.Floor);
    }

    function previewMint(uint256 shares) external view returns (uint256) {
        (uint256 nav, uint256 supply) = _postFee();
        return Math.mulDiv(shares, nav + 1, supply, Math.Rounding.Ceil);
    }

    function _toShares(uint256 assets, Math.Rounding rounding) private view returns (uint256) {
        (uint256 nav, uint256 supply) = _postFee();
        return Math.mulDiv(assets, supply, nav + 1, rounding);
    }

    function _postFee() private view returns (uint256 nav, uint256 supply) {
        bool realized;
        (nav, realized) = liveNav();
        (uint256 feeShares,,) = accountant.quote(address(this), nav, realized);
        supply = totalSupply() + feeShares + 1000;
    }

    /// @dev While a Core valuation is above the window's lowest record, the fee on that rise is
    ///      not charged yet (see HyperVaultAccountant): a depositor priced at the live NAV would
    ///      pay it later. Deposits wait for the records to catch up, within a small tolerance.
    function _room(address receiver, uint256 nav, bool realized) private view returns (uint256) {
        if (!realized) {
            uint256 low = accountant.windowLow(address(this)); // max without records: no cap
            if (
                low != type(uint256).max
                    && Math.mulDiv(nav + 1, 1e30, totalSupply() + 1000) * 10_000
                        > low * (10_000 + DEPOSIT_PRICE_TOLERANCE_BPS)
            ) return 0;
        }
        if (
            ($.phase != Phase.Idle
                    && $.phase != Phase.Ready
                    && $.phase != Phase.Active
                    && $.phase != Phase.AwaitingActivation)
                || ($.pendingAction.id != 0 && $.phase != Phase.AwaitingActivation) || upgradeController.pending()
                || receiver == address(0) || receiver == address(this) || (nav == 0 && totalSupply() != 0)
                || nav >= maximumAssets
        ) return 0;
        uint256 room = maximumAssets - nav;
        return room < $.minimumDeposit ? 0 : room;
    }

    function deposit(uint256 assets, address receiver) external nonReentrant returns (uint256 shares) {
        (, shares) = _fund(assets, 0, receiver);
    }

    function depositWithLimit(uint256 assets, address receiver, uint256 minShares, uint256 deadline)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert SlippageOrDeadline();
        (, shares) = _fund(assets, 0, receiver);
        if (shares < minShares) revert SlippageOrDeadline();
    }

    function mint(uint256 shares, address receiver) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert CapitalClosed();
        (assets,) = _fund(0, shares, receiver);
    }

    /// @dev One live valuation: the fee is charged first, then the deposit is priced after it.
    function _fund(uint256 amount, uint256 shares, address receiver) private returns (uint256, uint256) {
        (uint256 nav, bool realized) = liveNav();
        uint256 room = _room(receiver, nav, realized);
        _crystallize(nav, realized);
        uint256 supply = totalSupply() + 1000;
        if (shares == 0) shares = Math.mulDiv(amount, supply, nav + 1);
        else amount = Math.mulDiv(shares, nav + 1, supply, Math.Rounding.Ceil);
        if (amount < $.minimumDeposit || amount > room || shares == 0) revert CapitalClosed();
        _receive(amount);
        _share.mint(receiver, shares);
        emit Deposit(msg.sender, receiver, amount, shares);
        return (amount, shares);
    }

    function _receive(uint256 amount) private {
        uint256 beforeBalance = _asset.balanceOf(address(this));
        _asset.safeTransferFrom(msg.sender, address(this), amount);
        if (_asset.balanceOf(address(this)) - beforeBalance != amount) revert BalanceMismatch();
        $.accountedCash += amount;
    }

    /// @notice Only an empty, fully claimed Vault can reprice the performance fee.
    function setDepositTerms(uint16 feeBps, uint256 minimum) external onlyOwner nonReentrant {
        if ($.phase != Phase.Idle || upgradeController.pending()) revert WrongPhase();
        if (feeBps > 5_000 || minimum == 0 || minimum > maximumAssets) revert InvalidAmount();
        if (feeBps != $.performanceFeeBps && (totalSupply() != 0 || $.reservedClaimAssets != 0)) {
            revert CapitalClosed();
        }
        $.performanceFeeBps = feeBps;
        $.minimumDeposit = minimum;
        emit DepositTermsChanged(feeBps, minimum);
    }

    /// @notice The owner seeds the Vault (founder shares at once) and pays Core activation apart.
    function bootstrap(uint256 founderAssets) external onlyOwner nonReentrant {
        if (
            address(this) == _implementationSelf || _share.vault() != address(this) || treasury == address(this)
                || owner == address(this)
        ) revert Unauthorized();
        if ($.phase != Phase.Uninitialized || founderAssets == 0 || founderAssets > maximumAssets) revert WrongPhase();
        $.nextRequestId = 1;
        $.nextEpochId = 1;
        $.performanceFeeBps = _initialFeeBps;
        $.minimumDeposit = _initialMinimumDeposit;
        _crystallize(0, true); // empty: starts the high-water mark at the founder's price
        _receive(founderAssets);
        _share.mint(owner, founderAssets * 1000);
        emit Deposit(owner, owner, founderAssets, founderAssets * 1000);
        if (CoreRead.userExists(address(this))) {
            $.coreActivated = true;
            $.phase = Phase.Idle;
        } else {
            $.phase = Phase.AwaitingActivation;
            HyperVaultCoreOps.activate($, _env(), activationCost);
        }
        emit FounderFunded(owner, founderAssets, $.coreActivated ? 0 : activationCost, founderAssets * 1000);
    }

    receive() external payable {
        if (msg.sender != address(_asset) && msg.sender != bridge.systemAddress()) revert Unauthorized();
    }

    // ---------------------------------------------------------------- ERC-7540 redeem

    function isOperator(address controller, address operator) public view returns (bool) {
        return $.operators[controller][operator];
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        $.operators[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    /// @notice One request per controller at a time; more shares in the same open epoch join it.
    ///         Idle: settled in this call at cash. Active: paid after the owner's exit settles.
    function requestRedeem(uint256 shares, address controller, address shareOwner)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (shares == 0) revert InvalidAmount();
        if (controller == address(0) || controller == address(this)) revert InvalidReceiver();
        // Only a controller (or its operator) opens or joins its own request: nobody can park a
        // dust request on someone else's controller and block their redemptions.
        if (msg.sender != controller && !isOperator(controller, msg.sender)) revert Unauthorized();
        if ($.phase == Phase.Uninitialized || $.phase == Phase.Exiting) revert WrongPhase();
        bool instant = $.phase == Phase.Idle || $.phase == Phase.AwaitingActivation;
        uint256 epochId = instant ? $.nextEpochId++ : $.activeEpochId;
        Epoch storage e = $.epochs[epochId];
        if (e.isSealed || e.settled) revert EpochClosed();
        id = $.controllerRequest[controller];
        if (id == 0) {
            id = $.nextRequestId++;
            $.requests[id] = Request(controller, epochId, 0, 0, 0);
            $.controllerRequest[controller] = id;
        } else if ($.requests[id].epoch != epochId) {
            revert OutstandingRequest();
        }
        $.requests[id].shares += shares;
        e.requestedShares += shares;
        _share.escrow(shareOwner, isOperator(shareOwner, msg.sender) ? shareOwner : msg.sender, shares);
        emit RedeemRequest(controller, shareOwner, id, msg.sender, shares);
        if (instant) {
            e.isSealed = true;
            _settle(epochId);
        }
    }

    /// @notice While the strategy runs, pays shares at once from the free EVM cash (the buffer) at
    ///         the conservative post-fee rate (the lower of the live NAV price and the window's
    ///         lowest record, when there is one), less INSTANT_EXIT_FEE_BPS kept for the holders
    ///         who stay (it covers the unwind the leaver skips). Without a record it needs an
    ///         oracle-only scope (ADR-040). The last holder and amounts above the free cash take
    ///         the epoch path (`requestRedeem`).
    ///         Preview: `shares * quote(vault, nav, realized).price / 1e30 * (1 - fee)`.
    function redeemNow(uint256 shares, address receiver, address shareOwner, uint256 minAssets, uint256 deadline)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (block.timestamp > deadline) revert SlippageOrDeadline();
        if ($.phase != Phase.Active && $.phase != Phase.Ready) revert WrongPhase();
        if (shares == 0 || shares >= totalSupply()) revert InvalidAmount();
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        (uint256 nav, bool realized) = liveNav();
        // Without a record the rate is the live NAV: allowed only when nothing in it follows a book
        // or a mark (hedged spot and short at one perp oracle, ADR-040). Otherwise fail closed.
        if (
            !realized && accountant.windowLow(address(this)) == type(uint256).max
                && !IHyperVaultOracleGate(address(verifier)).oracleOnly(address(this))
        ) revert NavUnavailable();
        _crystallize(nav, realized);
        assets = accountant.convertToAssets(address(this), shares) * (10_000 - INSTANT_EXIT_FEE_BPS) / 10_000;
        if (assets == 0 || assets < minAssets) revert SlippageOrDeadline();
        if (assets > availableCash()) revert InvalidAmount();
        _share.escrow(shareOwner, isOperator(shareOwner, msg.sender) ? shareOwner : msg.sender, shares);
        _share.burn(shares);
        _pay(receiver, assets);
        emit Withdraw(msg.sender, receiver, shareOwner, assets, shares);
    }

    function pendingRedeemRequest(uint256 id, address controller) public view returns (uint256) {
        Request storage r = $.requests[id];
        return r.controller == controller && !$.epochs[r.epoch].settled ? r.shares : 0;
    }

    function claimableRedeemRequest(uint256 id, address controller) public view returns (uint256) {
        Request storage r = $.requests[id];
        return r.controller == controller && $.epochs[r.epoch].settled ? r.shares - r.consumedShares : 0;
    }

    function maxRedeem(address controller) public view returns (uint256) {
        return claimableRedeemRequest($.controllerRequest[controller], controller);
    }

    function maxWithdraw(address controller) public view returns (uint256) {
        Request storage r = $.requests[$.controllerRequest[controller]];
        if (r.controller != controller || !$.epochs[r.epoch].settled) return 0;
        return _gross(r) - r.paidAssets;
    }

    function previewRedeem(uint256) external pure returns (uint256) {
        revert AsyncPreviewUnsupported();
    }

    function previewWithdraw(uint256) external pure returns (uint256) {
        revert AsyncPreviewUnsupported();
    }

    function redeem(uint256 shares, address receiver, address controller)
        external
        nonReentrant
        returns (uint256 assets)
    {
        _authorize(controller);
        uint256 id = $.controllerRequest[controller];
        Request storage r = $.requests[id];
        if (shares == 0 || shares > maxRedeem(controller)) revert NotClaimable();
        assets = Math.mulDiv(_gross(r), r.consumedShares + shares, r.shares) - r.paidAssets;
        _claim(id, receiver, shares, assets);
    }

    function withdraw(uint256 assets, address receiver, address controller)
        external
        nonReentrant
        returns (uint256 shares)
    {
        _authorize(controller);
        uint256 id = $.controllerRequest[controller];
        Request storage r = $.requests[id];
        if (assets == 0 || assets > maxWithdraw(controller)) revert NotClaimable();
        uint256 gross = _gross(r);
        uint256 cumulative = Math.mulDiv(r.paidAssets + assets, r.shares, gross, Math.Rounding.Ceil);
        if (cumulative <= r.consumedShares || (cumulative == r.shares && r.paidAssets + assets != gross)) {
            revert InvalidAmount();
        }
        shares = cumulative - r.consumedShares;
        _claim(id, receiver, shares, assets);
    }

    function _authorize(address controller) private view {
        if (msg.sender != controller && !isOperator(controller, msg.sender)) revert Unauthorized();
    }

    function _gross(Request storage r) private view returns (uint256) {
        Epoch storage e = $.epochs[r.epoch];
        return Math.mulDiv(r.shares, e.numerator, e.denominator);
    }

    function _claim(uint256 id, address receiver, uint256 shares, uint256 assets) private {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        Request storage r = $.requests[id];
        Epoch storage e = $.epochs[r.epoch];
        r.consumedShares += shares;
        r.paidAssets += assets;
        e.unclaimedShares -= shares;
        e.reserve -= assets;
        $.reservedClaimAssets -= assets;
        if (r.consumedShares == r.shares) delete $.controllerRequest[r.controller];
        if (e.unclaimedShares == 0) {
            $.roundingReserve += e.reserve;
            e.reserve = 0;
        }
        _pay(receiver, assets);
        emit Withdraw(msg.sender, receiver, r.controller, assets, shares);
    }

    function _pay(address receiver, uint256 amount) private {
        if (_asset.balanceOf(address(this)) < $.accountedCash) revert CashDeficit();
        $.accountedCash -= amount;
        if (amount != 0) _asset.safeTransfer(receiver, amount);
    }

    function releaseRoundingDust() external nonReentrant {
        uint256 amount = $.roundingReserve;
        $.roundingReserve = 0;
        $.reservedClaimAssets -= amount;
        _pay(treasury, amount);
        emit RoundingDustReleased(amount);
    }

    /// @dev Prices the epoch at realized EVM cash, after charging the fee at that cash.
    function _settle(uint256 epochId) private {
        Epoch storage e = $.epochs[epochId];
        if (!e.isSealed || e.settled) revert EpochClosed();
        uint256 cash = availableCash();
        _crystallize(cash, true);
        uint256 supply = totalSupply();
        uint256 q = e.requestedShares;
        e.settled = true;
        e.numerator = cash == 0 ? 0 : (q == supply ? cash : cash + 1);
        e.denominator = q == supply && supply != 0 ? supply : supply + 1000;
        e.reserve = Math.mulDiv(q, e.numerator, e.denominator);
        e.unclaimedShares = q;
        $.reservedClaimAssets += e.reserve;
        if (q != 0) _share.burn(q);
        emit EpochSettled(epochId, q, e.reserve);
    }

    // ---------------------------------------------------------------- Core management (HyperVaultCoreOps)

    /// @dev Bodies run in HyperVaultCoreOps by DELEGATECALL, on this storage; the owner check and
    ///      the reentrancy guard stay here (ADR-041).
    function _env() private view returns (HyperVaultCoreOps.Env memory) {
        return
            HyperVaultCoreOps.Env(
                _asset, bridge, coreWriter, verifier, upgradeController, owner, builder, builderFeeCap
            );
    }

    /// @notice Queue a target amount of free cash; zero cancels. No assets leave in this call.
    function queueCoreAllocation(uint256 amount) external onlyOwner nonReentrant {
        HyperVaultCoreOps.queueAllocation($, _env(), amount);
    }

    /// @notice The owner authorizes both the queued amount and its execution time.
    function executeCoreAllocation() external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.executeAllocation($, _env());
    }

    function finalizeActivation(bytes calldata proof) external nonReentrant {
        if ($.phase != Phase.AwaitingActivation) revert WrongPhase();
        HyperVaultCoreOps.sync($, _env(), proof);
    }

    function syncCoreAction(uint256 id, bytes calldata proof) external nonReentrant {
        if (id == 0 || id != $.pendingAction.id) revert EvidenceRejected();
        HyperVaultCoreOps.sync($, _env(), proof);
    }

    function setApiWallet(address agent) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.setApiWallet($, _env(), agent);
    }

    function revokeApiWallet() external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.revokeApiWallet($, _env());
    }

    function recallFromCore(uint32 sourceDex, uint256 amount) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.recall($, _env(), sourceDex, amount);
    }

    function transferWithinCore(uint64 token, uint32 sourceDex, uint32 destinationDex, uint64 coreAmount)
        external
        onlyOwner
        nonReentrant
        returns (uint256)
    {
        return HyperVaultCoreOps.transferWithinCore($, _env(), token, sourceDex, destinationDex, coreAmount);
    }

    function supplyToLending(uint64 token, uint64 coreAmount) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.lending($, _env(), 0, token, coreAmount);
    }

    function withdrawFromLending(uint64 token, uint64 coreAmount) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.lending($, _env(), 1, token, coreAmount);
    }

    function withdrawAllFromLending(uint64 token) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.lending($, _env(), 2, token, 0);
    }

    function setAbstraction(CoreActions.Abstraction mode) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.setAbstraction($, _env(), mode);
    }

    function approveBuilderFee(uint64 maxFeeRate) external onlyOwner nonReentrant returns (uint256) {
        return HyperVaultCoreOps.approveBuilderFee($, _env(), maxFeeRate);
    }

    function beginExit(uint256 epoch) external onlyOwner nonReentrant {
        if (
            $.phase == Phase.Uninitialized || $.phase == Phase.Idle || $.phase == Phase.Exiting
                || epoch != $.activeEpochId
        ) {
            revert WrongPhase();
        }
        if ($.phase == Phase.AwaitingActivation && $.pendingAction.id != 0) revert PendingCoreAction();
        $.queuedAllocation = 0;
        $.phase = Phase.Exiting;
        $.epochs[epoch].isSealed = true;
        emit ExitStarted(epoch);
    }

    function settleEpoch(uint256 epoch, bytes calldata proof) external nonReentrant {
        if ($.phase != Phase.Exiting || epoch != $.activeEpochId) revert WrongPhase();
        if ($.pendingAction.id != 0 || $.apiWallet != address(0)) revert PendingCoreAction();
        uint64 observed = verifier.verifyIdle(address(this), epoch, $.actionNonce, proof);
        if (observed < $.lastConfirmedCoreBlock || observed > CoreRead.l1Block()) revert EvidenceRejected();
        _settle(epoch);
        $.managedPrincipal = 0;
        $.phase = Phase.Idle;
    }

    // ---------------------------------------------------------------- state getters

    function phase() external view returns (Phase) {
        return $.phase;
    }

    function coreActivated() external view returns (bool) {
        return $.coreActivated;
    }

    function apiWallet() external view returns (address) {
        return $.apiWallet;
    }

    function performanceFeeBps() external view returns (uint256) {
        return $.performanceFeeBps;
    }

    function minimumDeposit() external view returns (uint256) {
        return $.minimumDeposit;
    }

    function queuedAllocation() external view returns (uint256) {
        return $.queuedAllocation;
    }

    function activeEpochId() external view returns (uint256) {
        return $.activeEpochId;
    }

    function actionNonce() external view returns (uint256) {
        return $.actionNonce;
    }

    function lastConfirmedCoreBlock() external view returns (uint64) {
        return $.lastConfirmedCoreBlock;
    }

    function managedPrincipal() external view returns (uint256) {
        return $.managedPrincipal;
    }

    function accountedCash() external view returns (uint256) {
        return $.accountedCash;
    }

    function reservedClaimAssets() external view returns (uint256) {
        return $.reservedClaimAssets;
    }

    function roundingReserve() external view returns (uint256) {
        return $.roundingReserve;
    }

    function nextRequestId() external view returns (uint256) {
        return $.nextRequestId;
    }

    function nextEpochId() external view returns (uint256) {
        return $.nextEpochId;
    }

    function pendingAction() external view returns (uint256, bytes32, uint64, ActionKind, uint256, address) {
        PendingAction storage a = $.pendingAction;
        return (a.id, a.intentHash, a.submittedCoreBlock, a.kind, a.assets, a.agent);
    }

    function usedAgents(address agent) external view returns (bool) {
        return $.usedAgents[agent];
    }

    function epochs(uint256 id) external view returns (uint256, uint256, uint256, uint256, uint256, bool, bool) {
        Epoch storage e = $.epochs[id];
        return (e.requestedShares, e.unclaimedShares, e.numerator, e.denominator, e.reserve, e.isSealed, e.settled);
    }

    function requests(uint256 id) external view returns (address, uint256, uint256, uint256, uint256) {
        Request storage r = $.requests[id];
        return (r.controller, r.epoch, r.shares, r.consumedShares, r.paidAssets);
    }

    function controllerRequest(address controller) external view returns (uint256) {
        return $.controllerRequest[controller];
    }
}
