// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ManagedUpgradeController} from "./managed/ManagedUpgradeController.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CoreActions, ICoreWriter} from "./CoreActions.sol";
import {CoreRead} from "./CoreRead.sol";
import {ManagedCoreActions} from "./managed/ManagedCoreActions.sol";
import {ManagedAssetBridge} from "./managed/ManagedAssetBridge.sol";
import {ManagedRedeem} from "./managed/ManagedRedeem.sol";
import {IManagedVaultVerifier} from "./interfaces/IManagedVaultVerifier.sol";
import {IManagedNavVerifier} from "./interfaces/IManagedNavVerifier.sol";

interface IManagedCoreDepositWallet {
    function deposit(uint256 amount, uint32 destinationDex) external;
}

/// @notice Immutable owner-managed Vault whose own address owns the HyperCore account.
/// @dev Fresh deployments only; not a storage-compatible upgrade of ManagedUsdcVault.
///      Amounts are in asset units, including inherited basisUsdc (legacy ABI name).
contract ManagedAssetVault is ManagedRedeem {
    using SafeERC20 for IERC20;
    ManagedAssetBridge public immutable bridge;
    uint256 public queuedAllocation;
    uint32 public constant SPOT_DEX = type(uint32).max;

    enum Phase {
        Uninitialized,
        AwaitingActivation,
        Ready,
        Idle,
        Active,
        Exiting
    }
    enum ActionKind {
        None,
        Deposit,
        Recall,
        Agent,
        RevokeAgent,
        Control
    }

    struct Config {
        address asset;
        address bridge;
        address factory;
        address owner;
        address treasury;
        address coreDepositWallet;
        address coreWriter;
        address verifier;
        address builder;
        address upgradeController;
        uint16 performanceFeeBps;
        uint256 minimumDeposit;
        uint64 builderFeeCap;
        uint64 usdcCoreToken;
        uint256 activationCost;
        uint256 maximumAssets;
        uint256 chainId;
    }

    struct PendingAction {
        uint256 id;
        bytes32 intentHash;
        uint64 submittedCoreBlock;
        ActionKind kind;
        uint256 assets;
        address agent;
    }

    IERC20 public immutable usdc;
    address public immutable deploymentFactory;
    IManagedCoreDepositWallet public immutable coreDepositWallet;
    ICoreWriter public immutable coreWriter;
    IManagedVaultVerifier public immutable verifier;
    address public immutable builder;
    address private immutable _implementationSelf = address(this);
    ManagedUpgradeController public immutable upgradeController;
    uint16 private immutable _initialFeeBps;
    uint256 private immutable _initialMinimumDeposit;
    uint256 public minimumDeposit;
    uint64 public immutable builderFeeCap;
    uint64 public immutable usdcCoreToken;
    uint256 public immutable activationCost;
    uint256 public immutable maximumAssets;
    bytes32 public immutable configHash;
    Phase public phase;
    bool public coreActivated;
    address public apiWallet;
    uint256 public activeEpochId;
    uint256 public actionNonce;
    uint64 public lastConfirmedCoreBlock;
    // Original deployed capital only, never a deposit price or advertised trading NAV.
    uint256 public managedPrincipal;
    PendingAction public pendingAction;
    mapping(address => bool) public usedAgents;
    // Append-only proxy storage: do not insert fields into parent contracts.
    string private _vaultName;

    error InvalidConfiguration();
    error WrongPhase();
    error PendingCoreAction();
    error CoreNotReady();
    error EvidenceRejected();
    error CapitalClosed();
    error NavUnavailable();
    error SlippageOrDeadline();
    error AgentAlreadyUsed();
    error UpgradePending();
    error InvalidVaultName();
    event VaultNameChanged(string name);
    event DepositTermsChanged(uint256 performanceFeeBps, uint256 minimumDeposit);

    event VaultUpdate(address indexed asset, address vault);
    event FounderFunded(address indexed founder, uint256 principal, uint256 activationCost, uint256 shares);
    event CoreActionSubmitted(uint256 indexed id, ActionKind kind, bytes32 indexed intentHash, bytes payload);
    event CoreActionConfirmed(uint256 indexed id, bool success, uint64 coreBlock, uint256 receivedAssets);
    event ApiWalletConfirmed(address indexed vault, address indexed agent);
    event ExitStarted(uint256 indexed epoch);
    event CoreActivated(uint64 coreBlock);

    constructor(Config memory c) ManagedRedeem(IERC20(c.asset), c.owner, c.treasury) {
        if (
            c.asset.code.length == 0 || c.factory == address(0) || c.coreDepositWallet.code.length == 0
                || c.coreWriter.code.length == 0 || c.verifier.code.length == 0 || c.chainId != block.chainid
                || c.maximumAssets == 0 || c.maximumAssets > type(uint128).max || c.activationCost > 100e6
                || (c.builder == address(0) && c.builderFeeCap != 0) || c.bridge.code.length == 0
                || c.upgradeController.code.length == 0 || c.performanceFeeBps > 10_000 || c.minimumDeposit == 0
                || c.minimumDeposit > c.maximumAssets
        ) revert InvalidConfiguration();
        bridge = ManagedAssetBridge(c.bridge);
        if (bridge.asset() != c.asset) revert InvalidConfiguration();
        usdc = IERC20(c.asset);
        deploymentFactory = c.factory;
        coreDepositWallet = IManagedCoreDepositWallet(c.coreDepositWallet);
        coreWriter = ICoreWriter(c.coreWriter);
        verifier = IManagedVaultVerifier(c.verifier);
        builder = c.builder;
        builderFeeCap = c.builderFeeCap;
        usdcCoreToken = c.usdcCoreToken;
        activationCost = c.activationCost;
        maximumAssets = c.maximumAssets;
        configHash = keccak256(abi.encode(c));
        upgradeController = ManagedUpgradeController(c.upgradeController);
        _initialFeeBps = c.performanceFeeBps;
        _initialMinimumDeposit = c.minimumDeposit;
        emit VaultUpdate(c.asset, address(this));
    }

    function symbol() public view override returns (string memory) {
        ManagedAssetBridge.Kind k = bridge.kind();
        return
            k == ManagedAssetBridge.Kind.Usdc ? "mvUSDC" : k == ManagedAssetBridge.Kind.NativeHype ? "mvHYPE" : "mvUBTC";
    }

    function disabledAgent() public view returns (address) {
        return
            address(
                uint160(uint256(keccak256(abi.encode("MANAGED_VAULT_DISABLED_AGENT", block.chainid, address(this)))))
            );
    }

    function proxyAdmin() external view returns (address) {
        return ERC1967Utils.getAdmin();
    }

    function upgradeReady() external view returns (bool) {
        return phase == Phase.Idle && pendingAction.id == 0 && apiWallet == address(0);
    }

    /// @notice Only an empty, fully claimed Vault can reprice performance fees.
    ///         Existing investors' accrued profits and requests retain their agreed rate.
    function setDepositTerms(uint16 feeBps, uint256 minimum) external onlyOwner nonReentrant {
        if (phase != Phase.Idle || upgradeController.pending()) revert WrongPhase();
        if (feeBps > 10_000 || minimum == 0 || minimum > maximumAssets) revert InvalidAmount();
        if (feeBps != performanceFeeBps && (totalSupply() != 0 || reservedClaimAssets != 0)) revert CapitalClosed();
        performanceFeeBps = feeBps;
        minimumDeposit = minimum;
        emit DepositTermsChanged(feeBps, minimum);
    }

    function name() public view override returns (string memory) {
        return bytes(_vaultName).length == 0 ? super.name() : _vaultName;
    }

    function setVaultName(string calldata value) external onlyOwner nonReentrant {
        _setVaultName(value);
    }

    function _setVaultName(string memory value) private {
        bytes memory raw = bytes(value);
        if (raw.length == 0 || raw.length > 96 || raw[0] == 0x20 || raw[raw.length - 1] == 0x20) {
            revert InvalidVaultName();
        }
        for (uint256 i; i < raw.length; ++i) {
            if (uint8(raw[i]) < 32 || raw[i] == 0x7f) revert InvalidVaultName();
        }
        _vaultName = value;
        emit VaultNameChanged(value);
    }

    /// @notice EVM receipt issues founder shares immediately. Activation spends separate USDC.
    function bootstrap(string calldata vaultName, uint256 founderAssets) external nonReentrant {
        if (msg.sender != deploymentFactory || address(this) == _implementationSelf) revert Unauthorized();
        if (phase != Phase.Uninitialized || founderAssets == 0 || founderAssets > maximumAssets) revert WrongPhase();
        nextRequestId = 1;
        nextEpochId = 1;
        performanceFeeBps = _initialFeeBps;
        minimumDeposit = _initialMinimumDeposit;
        _setVaultName(vaultName);
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), founderAssets);
        if (usdc.balanceOf(address(this)) - beforeBalance != founderAssets) revert BalanceMismatch();
        accountedCash = founderAssets;
        basisUsdc[owner] = founderAssets;
        _mint(owner, founderAssets * 1000);
        emit Deposit(owner, owner, founderAssets, founderAssets * 1000);
        if (CoreRead.userExists(address(this))) {
            coreActivated = true;
            phase = Phase.Idle;
        } else {
            phase = Phase.AwaitingActivation;
            _record(ActionKind.Control, 0, address(0), abi.encode(activationCost));
            _bridgeCall(abi.encodeCall(ManagedAssetBridge.activate, (activationCost)));
        }
        emit FounderFunded(owner, founderAssets, coreActivated ? 0 : activationCost, founderAssets * 1000);
    }

    receive() external payable {
        if (msg.sender != address(usdc) && msg.sender != bridge.systemAddress()) revert Unauthorized();
    }

    /// @notice Queue a target amount of free cash; zero cancels. No assets leave in this call.
    function queueCoreAllocation(uint256 amount) external onlyOwner {
        if (amount > availableCash() || phase == Phase.Exiting) revert InvalidAmount();
        queuedAllocation = amount;
        emit AllocationQueued(amount);
    }

    /// @notice The owner authorizes both the queued amount and its execution time.
    function executeCoreAllocation() external onlyOwner nonReentrant returns (uint256) {
        _ready();
        uint256 amount = queuedAllocation;
        if (phase == Phase.Exiting || amount == 0 || amount > availableCash()) revert InvalidAmount();
        queuedAllocation = 0;
        _enterActive();
        accountedCash -= amount;
        managedPrincipal += amount;
        return _depositCore(amount, amount);
    }

    event AllocationQueued(uint256 assets);

    function finalizeActivation(bytes calldata proof) external nonReentrant {
        if (phase != Phase.AwaitingActivation) revert WrongPhase();
        _sync(proof);
    }

    function syncCoreAction(uint256 id, bytes calldata proof) external nonReentrant {
        if (id == 0 || id != pendingAction.id) revert EvidenceRejected();
        _sync(proof);
    }

    function _sync(bytes calldata proof) private {
        _bridgeCall(abi.encodeCall(ManagedAssetBridge.wrapReturnedNative, ()));
        PendingAction memory p = pendingAction;
        if (p.id == 0) revert EvidenceRejected();
        IManagedVaultVerifier.Receipt memory r = verifier.verifyAction(address(this), p.id, p.intentHash, proof);
        if (r.coreBlock <= p.submittedCoreBlock || r.coreBlock > CoreRead.l1Block()) revert EvidenceRejected();
        if (!r.success && r.receivedAssets != 0) revert EvidenceRejected();
        if (p.kind == ActionKind.Deposit) {
            if (r.success && r.receivedAssets != p.assets) revert EvidenceRejected();
            if (!r.success) managedPrincipal -= p.assets;
        } else if (p.kind == ActionKind.Recall) {
            if (r.receivedAssets > p.assets) revert EvidenceRejected();
            if (r.success) {
                accountedCash += r.receivedAssets;
                if (usdc.balanceOf(address(this)) < accountedCash) revert CashDeficit();
            }
        } else {
            if (r.receivedAssets != 0) revert EvidenceRejected();
            if (r.success && (p.kind == ActionKind.Agent || p.kind == ActionKind.RevokeAgent)) {
                apiWallet = p.agent;
                emit ApiWalletConfirmed(address(this), apiWallet);
            }
        }
        if (phase == Phase.AwaitingActivation) {
            if (!r.success || !CoreRead.userExists(address(this))) revert CoreNotReady();
            coreActivated = true;
            phase = Phase.Idle;
            emit CoreActivated(r.coreBlock);
        }
        lastConfirmedCoreBlock = r.coreBlock;
        delete pendingAction;
        emit CoreActionConfirmed(p.id, r.success, r.coreBlock, r.receivedAssets);
    }

    function setApiWallet(address agent) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        if (agent == address(0) || agent == owner || agent == address(this) || agent == disabledAgent()) {
            revert InvalidReceiver();
        }
        if (usedAgents[agent]) revert AgentAlreadyUsed();
        usedAgents[agent] = true;
        _enterActive();
        return _write(ActionKind.Agent, 0, agent, ManagedCoreActions.agent(agent));
    }

    function revokeApiWallet() external onlyOwner nonReentrant returns (uint256) {
        _ready();
        if (apiWallet == address(0)) revert InvalidReceiver();
        return _write(ActionKind.RevokeAgent, 0, address(0), ManagedCoreActions.agent(disabledAgent()));
    }

    function depositToCore(uint256 amount) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        if (phase == Phase.Exiting || amount == 0 || amount > availableCash()) revert InvalidAmount();
        _enterActive();
        accountedCash -= amount;
        managedPrincipal += amount;
        return _depositCore(amount, amount);
    }

    function recallFromCore(uint32 sourceDex, uint256 amount) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        _enterActive();
        return _write(ActionKind.Recall, amount, address(0), bridge.recallPayload(sourceDex, amount));
    }

    function transferWithinCore(uint64 token, uint32 sourceDex, uint32 destinationDex, uint64 coreAmount)
        external
        onlyOwner
        nonReentrant
        returns (uint256)
    {
        _ready();
        if (sourceDex == destinationDex) revert InvalidAmount();
        _enterActive();
        return _write(
            ActionKind.Control,
            0,
            address(0),
            ManagedCoreActions.move(address(this), token, sourceDex, destinationDex, coreAmount)
        );
    }

    function supplyToLending(uint64 token, uint64 coreAmount) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        if (phase == Phase.Exiting) revert WrongPhase();
        _enterActive();
        return _write(
            ActionKind.Control, 0, address(0), CoreActions.lend(CoreActions.LendingOperation.Supply, token, coreAmount)
        );
    }

    function withdrawFromLending(uint64 token, uint64 coreAmount) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        _enterActive();
        return _write(
            ActionKind.Control,
            0,
            address(0),
            CoreActions.lend(CoreActions.LendingOperation.Withdraw, token, coreAmount)
        );
    }

    function withdrawAllFromLending(uint64 token) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        _enterActive();
        return _write(ActionKind.Control, 0, address(0), CoreActions.withdrawAll(token));
    }

    function setAbstraction(CoreActions.Abstraction mode) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        _enterActive();
        return _write(ActionKind.Control, 0, address(0), CoreActions.setAbstraction(address(this), mode));
    }

    function approveBuilderFee(uint64 maxFeeRate) external onlyOwner nonReentrant returns (uint256) {
        _ready();
        if (maxFeeRate > builderFeeCap || builder == address(0)) revert InvalidAmount();
        return _write(ActionKind.Control, 0, address(0), ManagedCoreActions.builderFee(builder, maxFeeRate));
    }

    function beginExit(uint256 epoch) external onlyOwner nonReentrant {
        if (phase == Phase.Uninitialized || phase == Phase.Idle || phase == Phase.Exiting || epoch != activeEpochId) {
            revert WrongPhase();
        }
        if (phase == Phase.AwaitingActivation && pendingAction.id != 0) revert PendingCoreAction();
        queuedAllocation = 0;
        phase = Phase.Exiting;
        epochs[epoch].isSealed = true;
        emit ExitStarted(epoch);
    }

    function settleEpoch(uint256 epoch, bytes calldata proof) external nonReentrant {
        if (phase != Phase.Exiting || epoch != activeEpochId) revert WrongPhase();
        if (pendingAction.id != 0 || apiWallet != address(0)) revert PendingCoreAction();
        uint64 observed = verifier.verifyIdle(address(this), epoch, actionNonce, proof);
        if (observed < lastConfirmedCoreBlock || observed > CoreRead.l1Block()) revert EvidenceRejected();
        _settle(epoch);
        managedPrincipal = 0;
        phase = Phase.Idle;
    }

    /// @dev The immutable verifier must implement complete, current onchain NAV.
    ///      No production HyperCore source ships yet; unavailable evidence closes deposits.
    function totalAssets() public view override returns (uint256) {
        if (phase == Phase.Idle || phase == Phase.AwaitingActivation) return availableCash();
        if ((phase != Phase.Ready && phase != Phase.Active) || pendingAction.id != 0) revert NavUnavailable();
        (uint256 assets,) = IManagedNavVerifier(address(verifier)).verifyNav(address(this), actionNonce, configHash);
        return assets;
    }

    function maxDeposit(address receiver) public view override returns (uint256) {
        if (
            (phase != Phase.Idle && phase != Phase.Ready && phase != Phase.Active && phase != Phase.AwaitingActivation)
                || (pendingAction.id != 0 && phase != Phase.AwaitingActivation) || upgradeController.pending()
                || receiver == address(0) || receiver == address(this)
        ) return 0;
        uint256 cash;
        try this.totalAssets() returns (uint256 assets) {
            cash = assets;
        } catch {
            return 0;
        }
        if ((cash == 0 && totalSupply() != 0) || cash >= maximumAssets) return 0;
        uint256 room = maximumAssets - cash;
        return room < minimumDeposit || Math.mulDiv(room, totalSupply() + 1000, cash + 1) == 0 ? 0 : room;
    }

    function maxMint(address receiver) public view override returns (uint256) {
        uint256 room = maxDeposit(receiver);
        return room == 0 ? 0 : _convertToShares(room, Math.Rounding.Floor);
    }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256 shares) {
        return _depositAssets(assets, receiver, msg.sender);
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

    function _depositAssets(uint256 amount, address receiver, address controller) private returns (uint256 shares) {
        if (amount < minimumDeposit || amount > maxDeposit(receiver)) revert CapitalClosed();
        shares = previewDeposit(amount);
        if (shares == 0) revert InvalidAmount();
        _fund(amount, receiver, controller, shares);
    }

    function _mintShares(uint256 shares, address receiver, address controller) private returns (uint256 assets) {
        if (shares == 0 || shares > maxMint(receiver)) revert CapitalClosed();
        assets = previewMint(shares);
        if (assets < minimumDeposit || assets > maxDeposit(receiver)) revert CapitalClosed();
        _fund(assets, receiver, controller, shares);
    }

    function _fund(uint256 amount, address receiver, address controller, uint256 shares) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert BalanceMismatch();
        accountedCash += amount;
        basisUsdc[receiver] += amount;
        _mint(receiver, shares);
        emit Deposit(controller, receiver, amount, shares);
    }

    function _requestEpoch() internal override returns (uint256 epoch, bool instant) {
        if (phase == Phase.Uninitialized || phase == Phase.Exiting) {
            revert WrongPhase();
        }
        if (phase == Phase.Idle || phase == Phase.AwaitingActivation) return (nextEpochId++, true);
        return (activeEpochId, false);
    }

    function _ready() private view {
        if (upgradeController.pending() && phase != Phase.Exiting) revert UpgradePending();
        if (!coreActivated) revert CoreNotReady();
        if (pendingAction.id != 0) revert PendingCoreAction();
    }

    function _enterActive() private {
        if (phase == Phase.Idle) {
            phase = Phase.Active;
            activeEpochId = nextEpochId++;
        } else if (phase == Phase.Ready) {
            phase = Phase.Active;
        }
    }

    function _depositCore(uint256 gross, uint256 principal) private returns (uint256 id) {
        bytes memory payload = abi.encodeCall(ManagedAssetBridge.depositCore, (gross));
        id = _record(ActionKind.Deposit, principal, address(0), payload);
        _bridgeCall(payload);
    }

    function _bridgeCall(bytes memory data) private {
        (bool ok, bytes memory result) = address(bridge).delegatecall(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    function _write(ActionKind kind, uint256 assets, address agent, bytes memory payload) private returns (uint256 id) {
        id = _record(kind, assets, agent, payload);
        coreWriter.sendRawAction(payload);
    }

    function _record(ActionKind kind, uint256 assets, address agent, bytes memory payload)
        private
        returns (uint256 id)
    {
        if (pendingAction.id != 0) revert PendingCoreAction();
        id = ++actionNonce;
        uint64 coreBlock = CoreRead.l1Block();
        bytes32 digest =
            keccak256(abi.encode(block.chainid, address(this), id, kind, assets, agent, coreBlock, keccak256(payload)));
        pendingAction = PendingAction(id, digest, coreBlock, kind, assets, agent);
        emit CoreActionSubmitted(id, kind, digest, payload);
    }
}
