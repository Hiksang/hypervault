// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice HyperVault share token (ERC-7575 `share()`), like kHYPE beside its StakingManager:
///         a plain, freely transferable ERC-20 whose supply only its Vault mints and burns.
/// @dev Not upgradeable. Its Vault is fixed once by the deployer (`bind`), before any supply.
///      Decimals are the asset's plus the Vault's virtual offset of 3.
contract HyperVaultShare is ERC20 {
    address private immutable _deployer;
    uint8 private immutable _decimals;
    address public vault;

    error Unauthorized();
    error InvalidReceiver();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _deployer = msg.sender;
        _decimals = decimals_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert Unauthorized();
        _;
    }

    function bind(address vault_) external {
        if (msg.sender != _deployer || vault != address(0) || vault_.code.length == 0) revert Unauthorized();
        vault = vault_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    /// @notice Burns the Vault's own escrowed shares.
    function burn(uint256 amount) external onlyVault {
        _burn(msg.sender, amount);
    }

    /// @notice Moves `amount` of `owner_`'s shares into the Vault's redeem escrow.
    /// @dev The Vault has already authorized its caller as owner or ERC-7540 operator; any other
    ///      `spender` spends its ERC-20 allowance here, as a transferFrom would.
    function escrow(address owner_, address spender, uint256 amount) external onlyVault {
        if (spender != owner_) _spendAllowance(owner_, spender, amount);
        _transfer(owner_, msg.sender, amount);
    }

    /// @dev Shares sent to the Vault outside a redeem request would be stranded there.
    function _update(address from, address to, uint256 amount) internal override {
        if (amount != 0 && from != address(0) && to == vault && msg.sender != vault) revert InvalidReceiver();
        super._update(from, to, amount);
    }
}
