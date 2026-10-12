// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice Bounded-gas reads from the official L1Read ABI snapshot in docs/reference.
/// @dev Raw ABI arguments without function selectors. No fallback to zero on failed reads.
library CoreRead {
    struct TokenInfo {
        string name;
        uint64[] spots;
        uint64 deployerTradingFeeShare;
        address deployer;
        address evmContract;
        uint8 szDecimals;
        uint8 weiDecimals;
        int8 evmExtraWeiDecimals;
    }

    struct SpotInfo {
        string name;
        uint64[2] tokens;
    }

    struct PerpAssetInfo {
        string coin;
        uint32 marginTableId;
        uint8 szDecimals;
        uint8 maxLeverage;
        bool onlyIsolated;
    }

    struct OutcomeStatus {
        uint8 status;
        uint64 settledValue;
        uint32 question;
    }

    struct Position {
        int64 szi;
        uint64 entryNtl;
        int64 isolatedRawUsd;
        uint32 leverage;
        bool isIsolated;
    }

    struct SpotBalance {
        uint64 total;
        uint64 hold;
        uint64 entryNtl;
    }

    struct Bbo {
        uint64 bid;
        uint64 ask;
    }

    struct AccountMarginSummary {
        int64 accountValue;
        uint64 marginUsed;
        uint64 ntlPos;
        int64 rawUsd;
    }

    struct BasisAndValue {
        uint64 basis;
        uint64 value;
    }

    struct UserLending {
        BasisAndValue borrow;
        BasisAndValue supply;
    }

    struct UserVaultEquity {
        uint64 equity;
        uint64 lockedUntilTimestamp;
    }

    struct Reserve {
        uint64 borrowYearlyRateBps;
        uint64 supplyYearlyRateBps;
        uint64 balance;
        uint64 utilizationBps;
        uint64 oraclePx;
        uint64 ltvBps;
        uint64 totalSupplied;
        uint64 totalBorrowed;
    }
    error ReadFailed(address target);
    error InvalidReturnLength(address target, uint256 actual);

    function read(address target, bytes memory input, uint256 size) private view returns (bytes memory data) {
        bool ok;
        (ok, data) = target.staticcall{gas: 50_000}(input);
        if (!ok) revert ReadFailed(target);
        if (data.length != size) revert InvalidReturnLength(target, data.length);
    }

    function userExists(address user) internal view returns (bool) {
        return abi.decode(read(address(0x0810), abi.encode(user), 32), (bool));
    }

    function l1Block() internal view returns (uint64) {
        return abi.decode(read(address(0x0809), abi.encode(), 32), (uint64));
    }

    function spotBalance(address user, uint64 token) internal view returns (SpotBalance memory) {
        return abi.decode(read(address(0x0801), abi.encode(user, token), 96), (SpotBalance));
    }

    function bbo(uint32 asset) internal view returns (Bbo memory) {
        return abi.decode(read(address(0x080e), abi.encode(asset), 64), (Bbo));
    }

    function oraclePx(uint32 asset) internal view returns (uint64) {
        return abi.decode(read(address(0x0807), abi.encode(asset), 32), (uint64));
    }

    function markPx(uint32 asset) internal view returns (uint64) {
        return abi.decode(read(address(0x0806), abi.encode(asset), 32), (uint64));
    }

    function accountMarginSummary(uint32 dex, address user) internal view returns (AccountMarginSummary memory) {
        return abi.decode(read(address(0x080f), abi.encode(dex, user), 128), (AccountMarginSummary));
    }

    function spotPx(uint32 spotIndex) internal view returns (uint64) {
        return abi.decode(read(address(0x0808), abi.encode(spotIndex), 32), (uint64));
    }

    function position(address user, uint32 perp) internal view returns (Position memory) {
        return abi.decode(read(address(0x0813), abi.encode(user, perp), 160), (Position));
    }

    function lending(address user, uint64 token) internal view returns (UserLending memory) {
        return abi.decode(read(address(0x0811), abi.encode(user, token), 128), (UserLending));
    }

    /// @dev Equity `user` holds in a HyperCore (legacy) vault such as HLP.
    function userVaultEquity(address user, address vault) internal view returns (UserVaultEquity memory) {
        return abi.decode(read(address(0x0802), abi.encode(user, vault), 64), (UserVaultEquity));
    }

    function reserve(uint64 token) internal view returns (Reserve memory) {
        return abi.decode(read(address(0x0812), abi.encode(token), 256), (Reserve));
    }

    // Dynamic metadata can contain a list of markets. Bound gas and returndata;
    // malformed/truncated output is a failure, never an absent/zero asset.
    function metadata(address target, bytes memory input) private view returns (bytes memory data) {
        bool ok;
        (ok, data) = target.staticcall{gas: 150_000}(input);
        if (!ok) revert ReadFailed(target);
        if (data.length == 0 || data.length > 32_768) revert InvalidReturnLength(target, data.length);
    }

    function tokenInfo(uint32 token) internal view returns (TokenInfo memory) {
        return abi.decode(metadata(address(0x080c), abi.encode(token)), (TokenInfo));
    }

    function perpAssetInfo(uint32 perp) internal view returns (PerpAssetInfo memory) {
        return abi.decode(metadata(address(0x080a), abi.encode(perp)), (PerpAssetInfo));
    }

    function spotInfo(uint32 spot) internal view returns (SpotInfo memory) {
        return abi.decode(metadata(address(0x080b), abi.encode(spot)), (SpotInfo));
    }

    function outcomeStatus(uint32 outcome) internal view returns (OutcomeStatus memory) {
        return abi.decode(read(address(0x0814), abi.encode(outcome), 96), (OutcomeStatus));
    }
}
