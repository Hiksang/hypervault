// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ICoreWriter} from "../../src/CoreActions.sol";

/// @notice Test double for CoreWriter's asynchronous acceptance model.
/// @dev A successful sendRawAction only queues an action. Tests must explicitly
///      execute or reject it later; neither transition calls back into the vault.
contract MockCoreWriter is ICoreWriter {
    enum Status {
        Pending,
        Executed,
        Rejected
    }

    struct QueuedAction {
        address account;
        bytes data;
        Status status;
    }

    error SubmissionReverted();
    error InvalidActionId(uint256 actionId);
    error ActionNotPending(uint256 actionId);

    event ActionQueued(uint256 indexed actionId, address indexed account, bytes data);
    event ActionExecuted(uint256 indexed actionId);
    event ActionRejected(uint256 indexed actionId);

    QueuedAction[] private _actions;
    mapping(bytes32 actionKey => uint256 count) private _submissionCounts;

    bool public revertSubmissions;

    function setRevertSubmissions(bool value) external {
        revertSubmissions = value;
    }

    function sendRawAction(bytes calldata data) external {
        if (revertSubmissions) revert SubmissionReverted();

        uint256 actionId = _actions.length;
        _actions.push(QueuedAction({account: msg.sender, data: data, status: Status.Pending}));
        unchecked {
            ++_submissionCounts[_key(msg.sender, data)];
        }

        emit ActionQueued(actionId, msg.sender, data);
    }

    function execute(uint256 actionId) external {
        QueuedAction storage queued = _pending(actionId);
        queued.status = Status.Executed;
        emit ActionExecuted(actionId);
    }

    function reject(uint256 actionId) external {
        QueuedAction storage queued = _pending(actionId);
        queued.status = Status.Rejected;
        emit ActionRejected(actionId);
    }

    function actionCount() external view returns (uint256) {
        return _actions.length;
    }

    function action(uint256 actionId) external view returns (address account, bytes memory data, Status status) {
        if (actionId >= _actions.length) revert InvalidActionId(actionId);
        QueuedAction storage queued = _actions[actionId];
        return (queued.account, queued.data, queued.status);
    }

    function latestAction() external view returns (address account, bytes memory data, Status status) {
        uint256 length = _actions.length;
        if (length == 0) revert InvalidActionId(0);
        QueuedAction storage queued = _actions[length - 1];
        return (queued.account, queued.data, queued.status);
    }

    function submissionCount(address account, bytes calldata data) external view returns (uint256) {
        return _submissionCounts[_key(account, data)];
    }

    function _pending(uint256 actionId) private view returns (QueuedAction storage queued) {
        if (actionId >= _actions.length) revert InvalidActionId(actionId);
        queued = _actions[actionId];
        if (queued.status != Status.Pending) revert ActionNotPending(actionId);
    }

    function _key(address account, bytes calldata data) private pure returns (bytes32) {
        return keccak256(abi.encode(account, data));
    }
}
