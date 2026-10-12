// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Boundary for an immutable, independently validated onchain accounting adapter.
/// @dev All values use one quote currency at 1e18 precision, exclude EVM balances, and MUST be disjoint.
///      This interface is not itself a HyperCore adapter or proof of portfolio completeness.
interface IStrategyBalanceSheet {
    struct Balances {
        uint256 spotValue;
        uint256 suppliedValue;
        uint256 perpCollateralValue;
        uint256 debtValue;
        uint256 accruedFees;
        uint256 excludedValue;
        int256 unrealizedPnl;
        int256 unsettledFunding;
    }

    struct Snapshot {
        address account;
        address asset;
        bytes32 strategyConfigHash;
        uint256 cycleId;
        uint64 coreBlock;
        uint64 observedAt;
        bool complete;
        bool inFlight;
        // Quote currency per ONE whole vault asset, at 1e18 precision.
        uint256 assetPrice;
        Balances balances;
    }

    /// @dev Must read authenticated onchain state; no keeper-submitted valuation is accepted by the reader.
    ///      observedAt is the OLDEST timestamp of every input, including the conversion price.
    function snapshot(address strategy) external view returns (Snapshot memory);
}
