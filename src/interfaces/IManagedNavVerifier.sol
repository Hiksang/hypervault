// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Optional extension of the Vault's immutable evidence verifier.
/// @dev MUST value the Vault's Core account from onchain state read in the same call, over the
///      scope its owner registered; that scope's completeness is the owner's responsibility.
///      Add only Vault.availableCash() to Core NAV: exclude EVM donations and claims.
///      No signer/owner NAV reports. An unavailable valuation MUST revert, never return zero.
interface IManagedNavVerifier {
    function verifyNav(address vault, uint256 actionNonce, bytes32 configHash)
        external
        view
        returns (uint256 shareholderAssets, uint64 coreBlock);
}
