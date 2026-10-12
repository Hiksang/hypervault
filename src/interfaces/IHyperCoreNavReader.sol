// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IHyperCoreNavReader {
    enum Quality {
        Unavailable,
        CapitalEstimate,
        Realized,
        MarkToMarket
    }

    struct Observation {
        int256 netAssets;
        uint64 asOfCoreBlock;
        uint64 observedAt;
        Quality quality;
        bool inFlight;
        uint256 cycleId;
    }
    function observe(address strategy) external view returns (Observation memory);
}
