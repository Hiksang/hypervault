// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice Read-only measurement of what a HyperCore read precompile charges. NEVER deployed.
/// @dev Run as the creation code of an `eth_call`: the constructor makes gas-capped static calls
///      against live state and returns the measurements in place of runtime code, so nothing is
///      signed, sent or stored. See scripts/precompile_gas_probe.py.
contract PrecompileGasProbe {
    constructor(address target, bytes memory input, uint256[] memory caps) {
        uint256 count = caps.length;
        bool[] memory succeeded = new bool[](count);
        uint256[] memory used = new uint256[](count);
        uint256[] memory sizes = new uint256[](count);
        // Warm the target so every measured call pays the same access cost.
        (bool warm,) = target.staticcall{gas: 100_000}(input);
        warm;
        for (uint256 i; i < count; ++i) {
            uint256 before = gasleft();
            (bool ok, bytes memory output) = target.staticcall{gas: caps[i]}(input);
            used[i] = before - gasleft();
            succeeded[i] = ok;
            sizes[i] = output.length;
        }
        bytes memory result = abi.encode(succeeded, used, sizes);
        assembly ("memory-safe") {
            return(add(result, 32), mload(result))
        }
    }
}
