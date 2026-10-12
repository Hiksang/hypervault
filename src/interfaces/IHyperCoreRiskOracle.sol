// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IHyperCoreRiskOracle {
    function perpAsset() external view returns (uint32);
    function spotAsset() external view returns (uint32);
    /// @notice Signed position quantity normalized from read szDecimals to CoreWriter's 1e8 units.
    function positionSize(address account, uint32 asset) external view returns (int64);
    function buyLimit(uint32 asset) external view returns (uint64);
    function sellLimit(uint32 asset) external view returns (uint64);
    function roundSizeDown(uint32 asset, uint64 size) external view returns (uint64);
    function roundSizeUp(uint32 asset, uint64 size) external view returns (uint64);
    function isSizeAligned(uint32 asset, uint64 size) external view returns (bool);
    function repaySize(uint32 asset, uint64 quoteDebt, uint64 sellLimit, uint16 bufferBps)
        external
        view
        returns (uint64);
    function recapitalizationSize(
        address account,
        uint64 hypeToken,
        uint64 quoteToken,
        uint32 spotAsset,
        uint64 gasReserve,
        uint16 bufferBps
    ) external view returns (uint64);
    function accountIsClean(address account, uint64 hypeToken, uint64 quoteToken, uint32 perpAsset)
        external
        view
        returns (bool);
}
