// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice Stateful raw-calldata responder for an L1Read precompile address.
/// @dev Etch this runtime code onto a 0x08xx address, configure the response on
///      that address, then call production code normally. Responses are returned
///      as raw bytes rather than ABI-encoded `bytes`.
contract MockReadPrecompile {
    error UnconfiguredInput(bytes input);
    error ConfiguredRevert(bytes input);

    mapping(bytes32 inputHash => bytes response) private _responses;
    mapping(bytes32 inputHash => bool configured) private _configured;
    mapping(bytes32 inputHash => bool shouldRevert) private _reverts;

    function setResponse(bytes calldata input, bytes calldata response) external {
        bytes32 inputHash = keccak256(input);
        _responses[inputHash] = response;
        _configured[inputHash] = true;
        _reverts[inputHash] = false;
    }

    function setRevert(bytes calldata input, bool value) external {
        bytes32 inputHash = keccak256(input);
        _configured[inputHash] = true;
        _reverts[inputHash] = value;
    }

    function clear(bytes calldata input) external {
        bytes32 inputHash = keccak256(input);
        delete _responses[inputHash];
        delete _configured[inputHash];
        delete _reverts[inputHash];
    }

    fallback(bytes calldata input) external returns (bytes memory output) {
        bytes32 inputHash = keccak256(input);
        if (!_configured[inputHash]) revert UnconfiguredInput(input);
        if (_reverts[inputHash]) revert ConfiguredRevert(input);
        return _responses[inputHash];
    }
}
