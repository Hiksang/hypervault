// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

/// @notice Test double for the native HYPE Core/EVM system address.
/// @dev Etch the runtime code onto 0x2222...2222. A vault's EVM-to-Core
///      transfer arrives through receive(); deliver() simulates a later,
///      independent Core-to-EVM receipt.
contract MockHypeSystem {
    error DeliveryFailed();

    event BridgedToCore(address indexed account, uint256 amount);
    event DeliveredFromCore(address indexed receiver, uint256 amount);

    mapping(address account => uint256 amount) public bridgedToCore;

    receive() external payable {
        bridgedToCore[msg.sender] += msg.value;
        emit BridgedToCore(msg.sender, msg.value);
    }

    function deliver(address payable receiver, uint256 amount) external {
        (bool ok,) = receiver.call{value: amount}("");
        if (!ok) revert DeliveryFailed();
        emit DeliveredFromCore(receiver, amount);
    }
}
