// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IHyperCoreStrategyAccount {
    struct CycleStatus {
        uint256 cycleId;
        uint8 phase;
        bool pending;
        bool exitRequested;
        bool returnReady;
    }
    function vault() external view returns (address);
    function asset() external view returns (address);
    function configHash() external view returns (bytes32);
    function startCycle(uint256 cycleId, uint256 assets, uint64 openDeadline, uint64 cycleEnd) external;
    function confirmPortfolioMargin(uint256 cycleId) external;
    function requestExit(uint256 cycleId) external;
    function setRiskPaused(bool paused) external;
    function recapitalize(uint256 cycleId, uint256 assets) external;
    function returnToVault(uint256 cycleId) external returns (uint256 assets);
    function advance() external;
    function cycleStatus() external view returns (CycleStatus memory);
    function requiredRecapitalization() external view returns (uint256);
    function accountedCapital() external view returns (uint256);
}
