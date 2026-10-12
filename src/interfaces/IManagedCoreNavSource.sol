// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Live HyperCore valuation of the scope an owner registered for their Vault.
/// @dev Quantities and prices come from read precompiles in the calling EVM block. The scope's
///      completeness is the owner's responsibility: an unregistered venue is invisible here.
///      Values are USDC at 1e18 precision and exclude every HyperEVM balance.
interface IManagedCoreNavSource {
    /// @notice Net value of the enabled scope. Reverts when the scope is missing or disabled,
    ///         a registered read fails, a price guard trips, or someone proved a holding outside
    ///         the scope. A failure is never a zero value.
    function evaluate(address vault) external view returns (int256 netUsdc18, uint64 coreBlock);

    /// @notice The registered scope priced like `evaluate`, whatever the enabled flag and the
    ///         reports say. A share-price history is made of this value, so that neither the
    ///         owner's switch nor a report can stop the history.
    function scopeValue(address vault) external view returns (int256 netUsdc18, uint64 coreBlock);

    /// @notice When the owner last answered a report by registering the reported venue. Whether
    ///         anything else is held outside the scope cannot be known, so a price recorded up to
    ///         then is no history for issuing shares or settling an exit afterwards.
    function reportAnsweredAt(address vault) external view returns (uint64);

    /// @notice What an exit could still bring home, regardless of the enabled flag: the USDC
    ///         ledgers plus every token holding that can be sold now. `liabilities` is true when
    ///         a registered debt, perp position or negative DEX equity exists.
    function exposure(address vault) external view returns (int256 netUsdc18, bool liabilities, uint64 coreBlock);
}
