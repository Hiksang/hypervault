// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AsyncHypeVault} from "./AsyncHypeVault.sol";
import {IWrappedHype} from "./interfaces/IWrappedHype.sol";

/// @notice Native UX only. The caller always controls the claim; no arbitrary controller input.
contract HypeRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;
    AsyncHypeVault public immutable vault;
    IWrappedHype public immutable wrappedHype;
    error SlippageOrDeadline();
    error InvalidReceiver();
    error NativeTransferFailed();

    constructor(AsyncHypeVault vault_) {
        vault = vault_;
        wrappedHype = IWrappedHype(vault_.asset());
    }

    receive() external payable {
        if (msg.sender != address(wrappedHype)) revert NativeTransferFailed();
    }

    function depositHype(address receiver, uint256 minShares, uint256 deadline)
        external
        payable
        nonReentrant
        returns (uint256 shares)
    {
        if (block.timestamp > deadline) revert SlippageOrDeadline();
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        wrappedHype.deposit{value: msg.value}();
        IERC20(address(wrappedHype)).forceApprove(address(vault), msg.value);
        shares = vault.deposit(msg.value, receiver);
        if (shares < minShares) revert SlippageOrDeadline();
    }

    /// @dev The caller must approve this router as operator or share spender on the Vault first.
    function requestRedeem(uint256 shares) external nonReentrant returns (uint256) {
        return vault.requestRedeem(shares, msg.sender, msg.sender);
    }

    /// @dev The caller must setOperator(router,true). Approval from some other user confers no rights here.
    function redeemHype(uint256 shares, address payable receiver, uint256 minAssets, uint256 deadline)
        external
        nonReentrant
        returns (uint256 assets)
    {
        if (block.timestamp > deadline) revert SlippageOrDeadline();
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        assets = vault.redeem(shares, address(this), msg.sender);
        if (assets < minAssets) revert SlippageOrDeadline();
        wrappedHype.withdraw(assets);
        (bool ok,) = receiver.call{value: assets}("");
        if (!ok) revert NativeTransferFailed();
    }
}
