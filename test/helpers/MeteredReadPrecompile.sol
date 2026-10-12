// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice Read-precompile stand-in that charges gas like a HyperCore read precompile:
///         `base + perByte * (input_len + output_len)` for an answer, and the whole call frame for
///         an error. Etch its runtime code onto a 0x08xx address.
/// @dev The documentation states 2000 and 65; 1000 and 33 matched every measured call on mainnet
///      on 2026-10-04 (docs/reference/managed-precompile-gas-2026-10-04.json). Neither is a
///      protocol constant. Reading the stored answer can cost more than the model for a small
///      output, so totals measured with this stub err on the high side.
contract MeteredReadPrecompile {
    uint256 private immutable _base;
    uint256 private immutable _perByte;
    mapping(bytes32 inputHash => bytes response) private _responses;
    bytes private _default;

    constructor(uint256 base, uint256 perByte) {
        _base = base;
        _perByte = perByte;
    }

    function setResponse(bytes calldata input, bytes calldata response) external {
        _responses[keccak256(input)] = response;
    }

    /// @dev For a precompile that answers every well-formed input, such as `coreUserExists`.
    function setDefaultResponse(bytes calldata response) external {
        _default = response;
    }

    fallback(bytes calldata input) external returns (bytes memory output) {
        uint256 start = gasleft();
        output = _responses[keccak256(input)];
        if (output.length == 0) output = _default;
        uint256 cost = _base + _perByte * (input.length + output.length);
        // An unknown input is an error: it consumes all gas passed into the call frame.
        if (output.length == 0 || start < cost) {
            assembly ("memory-safe") {
                invalid()
            }
        }
        while (start - gasleft() < cost) {}
    }
}
