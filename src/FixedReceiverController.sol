// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncHypeVault} from "./AsyncHypeVault.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Select this address as request controller to permit anyone to trigger fixed-beneficiary payment.
/// @dev No receiver changes, operator approvals, arbitrary calls or custody of user shares.
contract FixedReceiverController is ReentrancyGuard {
    AsyncHypeVault public immutable vault;
    address public immutable beneficiary;
    error InvalidBeneficiary();

    constructor(AsyncHypeVault vault_, address beneficiary_) {
        if (beneficiary_ == address(0) || beneficiary_ == address(this) || beneficiary_ == address(vault_)) {
            revert InvalidBeneficiary();
        }
        vault = vault_;
        beneficiary = beneficiary_;
    }

    function claim() external nonReentrant returns (uint256 assets) {
        return vault.redeem(vault.maxRedeem(address(this)), beneficiary, address(this));
    }
}
