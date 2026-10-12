// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ManagedUpgradeController} from "../managed/ManagedUpgradeController.sol";
import {CoreActions, ICoreWriter} from "../CoreActions.sol";
import {CoreRead} from "../CoreRead.sol";
import {ManagedCoreActions} from "../managed/ManagedCoreActions.sol";
import {ManagedAssetBridge} from "../managed/ManagedAssetBridge.sol";
import {IManagedVaultVerifier} from "../interfaces/IManagedVaultVerifier.sol";
import {HyperVaultTypes as T} from "./HyperVaultTypes.sol";

/// @notice HyperVault's HyperCore management (ADR-041): allocation, recall, API wallet, lending,
///         account mode, builder fee, and the confirmation of each pending Core action.
/// @dev External library: Solidity reaches every function below by DELEGATECALL from HyperVault,
///      so it runs on the Vault's storage (`T.Layout`), as the Vault's address and with the
///      Vault's balance. State-changing library functions revert when CALLed directly. Access
///      control and the reentrancy guard stay on HyperVault's entry points; nothing here checks
///      the caller. Errors and events are HyperVaultTypes', so selectors and topics are those
///      the Vault always had.
library HyperVaultCoreOps {
    /// @dev The Vault's immutables a delegatecalled library cannot read itself.
    struct Env {
        IERC20 asset;
        ManagedAssetBridge bridge;
        ICoreWriter coreWriter;
        IManagedVaultVerifier verifier;
        ManagedUpgradeController upgradeController;
        address owner;
        address builder;
        uint64 builderFeeCap;
    }

    /// @notice Queue a target amount of free cash; zero cancels. No assets leave in this call.
    function queueAllocation(T.Layout storage $, Env memory env, uint256 amount) external {
        if (amount > _cash($, env) || $.phase == T.Phase.Exiting) revert T.InvalidAmount();
        $.queuedAllocation = amount;
        emit T.AllocationQueued(amount);
    }

    /// @notice The owner authorizes both the queued amount and its execution time.
    function executeAllocation(T.Layout storage $, Env memory env) external returns (uint256 id) {
        _ready($, env);
        uint256 amount = $.queuedAllocation;
        if ($.phase == T.Phase.Exiting || amount == 0 || amount > _cash($, env)) revert T.InvalidAmount();
        $.queuedAllocation = 0;
        _enterActive($);
        $.accountedCash -= amount;
        $.managedPrincipal += amount;
        bytes memory payload = abi.encodeCall(ManagedAssetBridge.depositCore, (amount));
        id = _record($, T.ActionKind.Deposit, amount, address(0), payload);
        _bridgeCall(env, payload);
    }

    /// @notice Bootstrap's Core activation: records the action, then pays the activation cost.
    function activate(T.Layout storage $, Env memory env, uint256 activationCost) external {
        _record($, T.ActionKind.Control, 0, address(0), abi.encode(activationCost));
        _bridgeCall(env, abi.encodeCall(ManagedAssetBridge.activate, (activationCost)));
    }

    /// @notice Confirms the pending action from a later Core block (anyone; the evidence decides).
    function sync(T.Layout storage $, Env memory env, bytes calldata proof) external {
        _bridgeCall(env, abi.encodeCall(ManagedAssetBridge.wrapReturnedNative, ()));
        T.PendingAction memory p = $.pendingAction;
        if (p.id == 0) revert T.EvidenceRejected();
        IManagedVaultVerifier.Receipt memory r = env.verifier.verifyAction(address(this), p.id, p.intentHash, proof);
        if (r.coreBlock <= p.submittedCoreBlock || r.coreBlock > CoreRead.l1Block()) revert T.EvidenceRejected();
        if (!r.success && r.receivedAssets != 0) revert T.EvidenceRejected();
        if (p.kind == T.ActionKind.Deposit) {
            if (r.success && r.receivedAssets != p.assets) revert T.EvidenceRejected();
            if (!r.success) $.managedPrincipal -= p.assets;
        } else if (p.kind == T.ActionKind.Recall) {
            if (r.receivedAssets > p.assets) revert T.EvidenceRejected();
            if (r.success) {
                $.accountedCash += r.receivedAssets;
                if (env.asset.balanceOf(address(this)) < $.accountedCash) revert T.CashDeficit();
            }
        } else {
            if (r.receivedAssets != 0) revert T.EvidenceRejected();
            if (r.success && (p.kind == T.ActionKind.Agent || p.kind == T.ActionKind.RevokeAgent)) {
                $.apiWallet = p.agent;
                emit T.ApiWalletConfirmed(address(this), p.agent);
            }
        }
        if ($.phase == T.Phase.AwaitingActivation) {
            if (!r.success || !CoreRead.userExists(address(this))) revert T.CoreNotReady();
            $.coreActivated = true;
            $.phase = T.Phase.Idle;
            emit T.CoreActivated(r.coreBlock);
        }
        $.lastConfirmedCoreBlock = r.coreBlock;
        delete $.pendingAction;
        emit T.CoreActionConfirmed(p.id, r.success, r.coreBlock, r.receivedAssets);
    }

    function setApiWallet(T.Layout storage $, Env memory env, address agent) external returns (uint256) {
        _ready($, env);
        if (agent == address(0) || agent == env.owner || agent == address(this) || agent == disabledAgent()) {
            revert T.InvalidReceiver();
        }
        if ($.usedAgents[agent]) revert T.AgentAlreadyUsed();
        $.usedAgents[agent] = true;
        _enterActive($);
        return _write($, env, T.ActionKind.Agent, 0, agent, ManagedCoreActions.agent(agent));
    }

    function revokeApiWallet(T.Layout storage $, Env memory env) external returns (uint256) {
        _ready($, env);
        if ($.apiWallet == address(0)) revert T.InvalidReceiver();
        return _write($, env, T.ActionKind.RevokeAgent, 0, address(0), ManagedCoreActions.agent(disabledAgent()));
    }

    function recall(T.Layout storage $, Env memory env, uint32 sourceDex, uint256 amount) external returns (uint256) {
        _ready($, env);
        _enterActive($);
        return _write($, env, T.ActionKind.Recall, amount, address(0), env.bridge.recallPayload(sourceDex, amount));
    }

    function transferWithinCore(
        T.Layout storage $,
        Env memory env,
        uint64 token,
        uint32 sourceDex,
        uint32 destinationDex,
        uint64 coreAmount
    ) external returns (uint256) {
        _ready($, env);
        if (sourceDex == destinationDex) revert T.InvalidAmount();
        _enterActive($);
        return _write(
            $,
            env,
            T.ActionKind.Control,
            0,
            address(0),
            ManagedCoreActions.move(address(this), token, sourceDex, destinationDex, coreAmount)
        );
    }

    /// @param op 0 supply, 1 withdraw `coreAmount`, 2 withdraw all of `token`.
    function lending(T.Layout storage $, Env memory env, uint8 op, uint64 token, uint64 coreAmount)
        external
        returns (uint256)
    {
        _ready($, env);
        if (op == 0 && $.phase == T.Phase.Exiting) revert T.WrongPhase();
        _enterActive($);
        bytes memory payload = op == 2
            ? CoreActions.withdrawAll(token)
            : CoreActions.lend(
                op == 0 ? CoreActions.LendingOperation.Supply : CoreActions.LendingOperation.Withdraw, token, coreAmount
            );
        return _write($, env, T.ActionKind.Control, 0, address(0), payload);
    }

    function setAbstraction(T.Layout storage $, Env memory env, CoreActions.Abstraction mode)
        external
        returns (uint256)
    {
        _ready($, env);
        _enterActive($);
        return _write($, env, T.ActionKind.Control, 0, address(0), CoreActions.setAbstraction(address(this), mode));
    }

    function approveBuilderFee(T.Layout storage $, Env memory env, uint64 maxFeeRate) external returns (uint256) {
        _ready($, env);
        if (maxFeeRate > env.builderFeeCap || env.builder == address(0)) revert T.InvalidAmount();
        return
            _write($, env, T.ActionKind.Control, 0, address(0), ManagedCoreActions.builderFee(env.builder, maxFeeRate));
    }

    /// @notice The agent a revoke installs: an address nobody holds a key for.
    function disabledAgent() public view returns (address) {
        return
            address(
                uint160(uint256(keccak256(abi.encode("MANAGED_VAULT_DISABLED_AGENT", block.chainid, address(this)))))
            );
    }

    function _cash(T.Layout storage $, Env memory env) private view returns (uint256) {
        if (env.asset.balanceOf(address(this)) < $.accountedCash || $.accountedCash < $.reservedClaimAssets) {
            revert T.CashDeficit();
        }
        return $.accountedCash - $.reservedClaimAssets;
    }

    function _ready(T.Layout storage $, Env memory env) private view {
        if (env.upgradeController.pending() && $.phase != T.Phase.Exiting) revert T.UpgradePending();
        if (!$.coreActivated) revert T.CoreNotReady();
        if ($.pendingAction.id != 0) revert T.PendingCoreAction();
    }

    function _enterActive(T.Layout storage $) private {
        if ($.phase == T.Phase.Idle) {
            $.phase = T.Phase.Active;
            $.activeEpochId = $.nextEpochId++;
        } else if ($.phase == T.Phase.Ready) {
            $.phase = T.Phase.Active;
        }
    }

    function _bridgeCall(Env memory env, bytes memory data) private {
        (bool ok, bytes memory result) = address(env.bridge).delegatecall(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }

    function _write(
        T.Layout storage $,
        Env memory env,
        T.ActionKind kind,
        uint256 assets,
        address agent,
        bytes memory payload
    ) private returns (uint256 id) {
        id = _record($, kind, assets, agent, payload);
        env.coreWriter.sendRawAction(payload);
    }

    function _record(T.Layout storage $, T.ActionKind kind, uint256 assets, address agent, bytes memory payload)
        private
        returns (uint256 id)
    {
        if ($.pendingAction.id != 0) revert T.PendingCoreAction();
        id = ++$.actionNonce;
        uint64 coreBlock = CoreRead.l1Block();
        bytes32 digest =
            keccak256(abi.encode(block.chainid, address(this), id, kind, assets, agent, coreBlock, keccak256(payload)));
        $.pendingAction = T.PendingAction(id, digest, coreBlock, kind, assets, agent);
        emit T.CoreActionSubmitted(id, kind, digest, payload);
    }
}
