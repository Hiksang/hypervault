// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The USDC Vault's custody and terminal-evidence boundary.
/// @dev A production implementation must account for every enabled Core market, pending action,
///      liability and in-flight USDC before reporting returnReady. This interface alone is no proof.
interface IUsdcCycleStrategy {
    function vault() external view returns (address);
    function asset() external view returns (address);
    function configHash() external view returns (bytes32);
    function startCycle(uint256 cycleId, uint256 assets) external;
    function requestExit(uint256 cycleId) external;
    function setRiskPaused(bool paused) external;
    function returnReady(uint256 cycleId) external view returns (bool);
    function returnToVault(uint256 cycleId) external returns (uint256 assets);
}
