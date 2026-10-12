// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ICoreActionObserver {
    // These describe account effects, NOT an authenticated action execution receipt.
    enum Evidence {
        None,
        AwaitingBlock,
        NoEffect,
        PartialEffect,
        ExpectedEffect,
        Uncorroborated,
        UnexpectedEffect,
        ReadUnavailable
    }

    struct Context {
        address account;
        uint64 hypeToken;
        uint64 quoteToken;
        uint32 perp;
        uint8 kind;
        uint64 submittedCoreBlock;
        int64 positionBefore;
        uint64 primaryBefore;
        uint64 secondaryBefore;
        uint64 amount;
        uint256 receiptBefore;
        uint256 received;
        uint256 nativeBalance;
        address riskOracle;
    }

    struct Observation {
        Evidence evidence;
        uint64 coreBlock;
        uint64 effectAmount;
        bytes32 readErrorHash;
    }
    function observe(Context calldata context) external view returns (Observation memory);
}
