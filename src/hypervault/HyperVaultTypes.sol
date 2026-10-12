// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice Types, errors and events shared by HyperVault and its Core-management library
///         (HyperVaultCoreOps). No state: inheriting it does not move any storage slot.
abstract contract HyperVaultTypes {
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
        address share;
        address accountant;
        address bridge;
        address owner;
        address treasury;
        address coreWriter;
        address verifier;
        address builder;
        address upgradeController;
        uint16 performanceFeeBps;
        uint256 minimumDeposit;
        uint64 builderFeeCap;
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

    struct Epoch {
        uint256 requestedShares;
        uint256 unclaimedShares;
        uint256 numerator;
        uint256 denominator;
        uint256 reserve;
        bool isSealed;
        bool settled;
    }

    struct Request {
        address controller;
        uint256 epoch;
        uint256 shares;
        uint256 consumedShares;
        uint256 paidAssets;
    }

    /// @dev The Vault's whole mutable state, one compiler-laid-out struct right after the
    ///      reentrancy guard. HyperVaultCoreOps receives it by storage reference. Append only:
    ///      the struct is the last state variable, so new members go at its end.
    struct Layout {
        Phase phase;
        bool coreActivated;
        address apiWallet;
        uint256 performanceFeeBps;
        uint256 minimumDeposit;
        uint256 queuedAllocation;
        uint256 activeEpochId;
        uint256 actionNonce;
        uint64 lastConfirmedCoreBlock;
        // Deployed capital only, never a deposit price or advertised trading NAV.
        uint256 managedPrincipal;
        uint256 accountedCash;
        uint256 reservedClaimAssets;
        uint256 roundingReserve;
        uint256 nextRequestId;
        uint256 nextEpochId;
        PendingAction pendingAction;
        mapping(address => bool) usedAgents;
        mapping(uint256 => Epoch) epochs;
        mapping(uint256 => Request) requests;
        mapping(address => uint256) controllerRequest;
        mapping(address => mapping(address => bool)) operators;
    }

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
    error Unauthorized();
    error InvalidAmount();
    error InvalidReceiver();
    error OutstandingRequest();
    error NotClaimable();
    error EpochClosed();
    error AsyncPreviewUnsupported();
    error CashDeficit();
    error BalanceMismatch();
    // Raised inside HyperVaultCoreOps by the Core action encoders; declared so the Vault's ABI
    // still decodes them as it did before the split.
    error InvalidAbstraction();
    error InvalidAddress();
    error ZeroAmount();
    error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value);

    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event DepositTermsChanged(uint256 performanceFeeBps, uint256 minimumDeposit);
    event AllocationQueued(uint256 assets);
    event FounderFunded(address indexed founder, uint256 principal, uint256 activationCost, uint256 shares);
    event CoreActionSubmitted(uint256 indexed id, ActionKind kind, bytes32 indexed intentHash, bytes payload);
    event CoreActionConfirmed(uint256 indexed id, bool success, uint64 coreBlock, uint256 receivedAssets);
    event ApiWalletConfirmed(address indexed vault, address indexed agent);
    event ExitStarted(uint256 indexed epoch);
    event CoreActivated(uint64 coreBlock);
    event EpochSettled(uint256 indexed epoch, uint256 shares, uint256 grossAssets);
    event PerformanceFeeMinted(uint256 ownerShares, uint256 platformShares);
    event RoundingDustReleased(uint256 assets);
}
