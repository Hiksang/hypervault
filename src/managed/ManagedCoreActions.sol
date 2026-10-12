// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {CoreActions} from "../CoreActions.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev Typed payloads; the custody Vault must call CoreWriter itself.
library ManagedCoreActions {
    using SafeCast for uint256;
    uint32 internal constant SPOT = type(uint32).max;
    address internal constant USDC_SYSTEM = 0x2000000000000000000000000000000000000000;

    function agent(address signer) internal pure returns (bytes memory) {
        if (signer == address(0)) revert CoreActions.InvalidAddress();
        return CoreActions.frame(9, abi.encode(signer, ""));
    }

    function builderFee(address builder, uint64 maxFeeRate) internal pure returns (bytes memory) {
        if (builder == address(0)) revert CoreActions.InvalidAddress();
        return CoreActions.frame(12, abi.encode(maxFeeRate, builder));
    }

    function move(address destination, uint64 token, uint32 sourceDex, uint32 destinationDex, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        if (destination == address(0)) revert CoreActions.InvalidAddress();
        if (amount == 0) revert CoreActions.ZeroAmount();
        return
            CoreActions.frame(
                13, abi.encode(destination, address(0), sourceDex, destinationDex, token, amount.toUint64())
            );
    }

    function recall(uint64 usdcToken, uint32 sourceDex, uint256 evmAmount) internal pure returns (bytes memory) {
        return move(USDC_SYSTEM, usdcToken, sourceDex, SPOT, evmAmount * 100);
    }
}
