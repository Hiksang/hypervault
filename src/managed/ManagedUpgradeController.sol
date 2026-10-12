// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

interface IManagedUpgradeState {
    function configHash() external view returns (bytes32);
    function proxyAdmin() external view returns (address);
    function upgradeReady() external view returns (bool);
}

/// @notice Per-Vault immutable upgrade authority with published code/data and a delay.
/// @dev Compatibility getter checks cannot prove future code honesty or storage safety.
contract ManagedUpgradeController {
    uint256 public constant DELAY = 48 hours;
    address public immutable owner;
    address private immutable _binder;
    address public vault;
    ProxyAdmin public admin;
    bytes32 public configuration;
    address public implementation;
    address public proposedImplementation;
    bytes32 public proposedCodeHash;
    bytes32 public proposedCallHash;
    uint256 public executeAfter;
    event UpgradeProposed(address indexed implementation, bytes32 codeHash, bytes32 callHash, uint256 executeAfter);
    event UpgradeCancelled();
    event UpgradeExecuted(address indexed implementation);
    error Unauthorized();
    error InvalidUpgrade();
    error UpgradeNotReady();

    constructor(address owner_) {
        require(owner_ != address(0));
        owner = owner_;
        _binder = msg.sender;
    }
    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function bind(address vault_, address implementation_) external {
        if (msg.sender != _binder || vault != address(0)) revert Unauthorized();
        vault = vault_;
        implementation = implementation_;
        configuration = IManagedUpgradeState(vault_).configHash();
        admin = ProxyAdmin(IManagedUpgradeState(vault_).proxyAdmin());
        if (admin.owner() != address(this)) revert InvalidUpgrade();
    }

    function pending() external view returns (bool) {
        return proposedImplementation != address(0);
    }

    function propose(address next, bytes calldata migration) external onlyOwner {
        if (vault == address(0) || next == vault || next == implementation || next.code.length == 0) {
            revert InvalidUpgrade();
        }
        if (IManagedUpgradeState(next).configHash() != configuration) revert InvalidUpgrade();
        proposedImplementation = next;
        proposedCodeHash = next.codehash;
        proposedCallHash = keccak256(migration);
        executeAfter = block.timestamp + DELAY;
        emit UpgradeProposed(next, proposedCodeHash, proposedCallHash, executeAfter);
    }

    function cancel() external onlyOwner {
        _clear();
        emit UpgradeCancelled();
    }

    function execute(bytes calldata migration) external onlyOwner {
        address next = proposedImplementation;
        if (next == address(0) || block.timestamp < executeAfter || !IManagedUpgradeState(vault).upgradeReady()) {
            revert UpgradeNotReady();
        }
        if (
            next.codehash != proposedCodeHash || keccak256(migration) != proposedCallHash
                || IManagedUpgradeState(next).configHash() != configuration
        ) revert InvalidUpgrade();
        _clear();
        implementation = next;
        admin.upgradeAndCall(ITransparentUpgradeableProxy(vault), next, migration);
        emit UpgradeExecuted(next);
    }

    function _clear() private {
        proposedImplementation = address(0);
        proposedCodeHash = 0;
        proposedCallHash = 0;
        executeAfter = 0;
    }
}
