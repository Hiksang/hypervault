// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Backed wrapped-native-token test double with optional withdrawal failure.
contract MockWHYPE is ERC20 {
    error WithdrawalReverted();

    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    bool public revertWithdrawals;

    constructor() ERC20("Wrapped HYPE", "WHYPE") {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function depositTo(address receiver) external payable {
        _mint(receiver, msg.value);
        emit Deposit(receiver, msg.value);
    }

    function withdraw(uint256 amount) external {
        if (revertWithdrawals) revert WithdrawalReverted();

        _burn(msg.sender, amount);
        payable(msg.sender).transfer(amount);

        emit Withdrawal(msg.sender, amount);
    }

    function setRevertWithdrawals(bool value) external {
        revertWithdrawals = value;
    }

    /// @dev Convenience for transfer/accounting tests that do not unwrap.
    function mint(address receiver, uint256 amount) external {
        _mint(receiver, amount);
    }
}
