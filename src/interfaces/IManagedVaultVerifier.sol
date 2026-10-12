// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Evidence boundary for Core effects which HyperEVM receipts do not prove.
/// @dev Implementations MUST bind the result to the Vault's pending action ID/hash and a later
///      Core block, and MUST NOT accept an RPC status, a caller-supplied amount or anyone's claim
///      that an action succeeded. An owner may at most give up on an action. Booked USDC must be
///      backed by USDC the Vault actually holds outside its ledger.
interface IManagedVaultVerifier {
    struct Receipt {
        uint64 coreBlock;
        bool success;
        // Final attributable USDC (EVM 6 decimals) for deposits/recalls; zero for controls.
        uint256 receivedAssets;
    }

    function verifyAction(address vault, uint256 id, bytes32 intentHash, bytes calldata proof)
        external
        view
        returns (Receipt memory);

    /// @dev Certifies that the Vault's registered Core scope holds no debt, no perp position and
    ///      at most dust for this action nonce. The caller additionally checks its EVM cash,
    ///      registered agent and confirmed local action state.
    function verifyIdle(address vault, uint256 epoch, uint256 actionNonce, bytes calldata proof)
        external
        view
        returns (uint64 coreBlock);
}
