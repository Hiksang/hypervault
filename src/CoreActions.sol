// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

interface ICoreWriter {
    function sendRawAction(bytes calldata data) external;
}

/// @notice Encoding primitives only. No execution confirmation or risk checks.
/// @dev The contract CALLING CoreWriter owns the resulting HyperCore account.
///      Use internal library calls in the actual custody contract, not an unrelated gateway.
library CoreActions {
    using SafeCast for uint256;

    address internal constant WRITER = 0x3333333333333333333333333333333333333333;
    address internal constant HYPE_SYSTEM = 0x2222222222222222222222222222222222222222;
    uint32 internal constant SPOT_DEX = type(uint32).max;

    enum LendingOperation {
        Supply,
        Withdraw
    }
    enum Abstraction {
        Invalid,
        Disabled,
        Unified,
        PortfolioMargin
    }

    error ZeroAmount();
    error NonRepresentableAmount();
    error InvalidDecimals();
    error InvalidOrder();
    error InvalidAddress();
    error InvalidAbstraction();

    function frame(uint24 action, bytes memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes1(0x01), bytes3(action), payload);
    }

    /// @dev Zero means MAX at protocol level. Kept in a separate, explicit function.
    function lend(LendingOperation operation, uint64 token, uint256 amount) internal pure returns (bytes memory) {
        if (amount == 0) revert ZeroAmount();
        return frame(15, abi.encode(uint8(operation), token, amount.toUint64()));
    }

    function withdrawAll(uint64 token) internal pure returns (bytes memory) {
        return frame(15, abi.encode(uint8(LendingOperation.Withdraw), token, uint64(0)));
    }

    function setAbstraction(address account, Abstraction mode) internal pure returns (bytes memory) {
        if (account == address(0)) revert InvalidAddress();
        if (mode == Abstraction.Invalid) revert InvalidAbstraction();
        return frame(16, abi.encode(account, uint8(mode)));
    }

    /// @notice Bridge back to the CALLER's own EVM address, not to a user-selected receiver.
    /// @dev Native HYPE token index is network-specific. Pre-fund Core HYPE for transfer gas.
    function recallHype(uint64 hypeToken, uint256 coreWei) internal pure returns (bytes memory) {
        if (coreWei == 0) revert ZeroAmount();
        return frame(13, abi.encode(HYPE_SYSTEM, address(0), SPOT_DEX, SPOT_DEX, hypeToken, coreWei.toUint64()));
    }

    function order(
        uint32 asset,
        bool isBuy,
        uint256 limitPx1e8,
        uint256 size1e8,
        bool reduceOnly,
        uint8 tif,
        uint128 cloid
    ) internal pure returns (bytes memory) {
        if (limitPx1e8 == 0 || size1e8 == 0 || tif < 1 || tif > 3) revert InvalidOrder();
        // Tick, lot, oracle deviation, exposure and deadline checks belong in the strategy.
        return frame(1, abi.encode(asset, isBuy, limitPx1e8.toUint64(), size1e8.toUint64(), reduceOnly, tif, cloid));
    }

    /// @dev Exact conversion; rejects dust instead of silently burning it when bridging.
    function evmToCoreWei(uint256 evmWei, uint8 coreDecimals) internal pure returns (uint64) {
        if (coreDecimals > 18) revert InvalidDecimals();
        uint256 factor = 10 ** (18 - coreDecimals);
        if (evmWei % factor != 0) revert NonRepresentableAmount();
        return (evmWei / factor).toUint64();
    }
}
