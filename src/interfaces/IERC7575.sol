// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @dev The EIP mandates 0x2f0a18c5; Solidity's type().interfaceId excludes inherited selectors.
interface IERC7575 is IERC165, IERC4626 {
    function share() external view returns (address);
}

interface IERC7575Share {
    event VaultUpdate(address indexed asset, address vault);
    function vault(address asset) external view returns (address);
}
