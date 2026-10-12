// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncHypeVault} from "./AsyncHypeVault.sol";
import {HyperCoreStrategyAccount} from "./HyperCoreStrategyAccount.sol";

/// @dev Separate deployers keep creation bytecode out of the factory's EIP-170 runtime budget.
contract VaultDeployer {
    function deploy(AsyncHypeVault.Config memory config) external returns (AsyncHypeVault) {
        config.factory = msg.sender;
        return new AsyncHypeVault(config);
    }
}

/// @dev Inert STOP-prefixed bytecode storage. No calls, mutation, ownership or fund-handling methods.
contract CreationCodeChunk {
    constructor(bytes memory data, uint256 offset, uint256 length) {
        require(length <= 24_575 && offset + length <= data.length);
        assembly ("memory-safe") {
            // The preceding byte belongs to this constructor's temporary memory and is no longer needed.
            let start := add(add(data, 0x1f), offset)
            mstore8(start, 0)
            return(start, add(length, 1))
        }
    }
}

contract StrategyDeployer {
    address public immutable firstPart;
    address public immutable secondPart;
    uint256 public immutable firstSize;
    uint256 public immutable creationSize;

    constructor() {
        bytes memory creation = type(HyperCoreStrategyAccount).creationCode;
        uint256 split = creation.length / 2;
        firstPart = address(new CreationCodeChunk(creation, 0, split));
        secondPart = address(new CreationCodeChunk(creation, split, creation.length - split));
        firstSize = split;
        creationSize = creation.length;
    }

    /// @dev The fixed constructor validates Config. The stores are created here, immutable, and never caller supplied.
    function deploy(address vault, bytes calldata encodedConfig) external returns (HyperCoreStrategyAccount deployed) {
        uint256 size = creationSize;
        uint256 split = firstSize;
        address first = firstPart;
        address second = secondPart;
        bytes memory code = new bytes(size + 32 + encodedConfig.length);
        address account;
        assembly ("memory-safe") {
            let start := add(code, 0x20)
            extcodecopy(first, start, 1, split)
            extcodecopy(second, add(start, split), 1, sub(size, split))
            let args := add(start, size)
            mstore(args, and(vault, 0xffffffffffffffffffffffffffffffffffffffff))
            calldatacopy(add(args, 0x20), encodedConfig.offset, encodedConfig.length)
            account := create(0, start, mload(code))
            if iszero(account) { revert(0, 0) }
        }
        return HyperCoreStrategyAccount(payable(account));
    }
}

/// @notice Atomic immutable pair creation; the factory retains no economic authority.
contract VaultFactory {
    VaultDeployer public immutable vaultDeployer;
    StrategyDeployer public immutable strategyDeployer;
    event PairCreated(address indexed vault, address indexed strategy, address indexed creator);
    error InvalidConfiguration();

    constructor(VaultDeployer vaultDeployer_, StrategyDeployer strategyDeployer_) {
        if (address(vaultDeployer_).code.length == 0 || address(strategyDeployer_).code.length == 0) {
            revert InvalidConfiguration();
        }
        vaultDeployer = vaultDeployer_;
        strategyDeployer = strategyDeployer_;
    }

    function createPair(AsyncHypeVault.Config memory vaultConfig, HyperCoreStrategyAccount.Config memory strategyConfig)
        external
        returns (AsyncHypeVault vault, HyperCoreStrategyAccount strategy)
    {
        if (vaultConfig.asset != strategyConfig.wrappedHype) revert InvalidConfiguration();
        vaultConfig.strategyConfigHash = keccak256(abi.encode(strategyConfig));
        vault = vaultDeployer.deploy(vaultConfig);
        strategy = strategyDeployer.deploy(address(vault), abi.encode(strategyConfig));
        vault.bindStrategyOnce(address(strategy));
        emit PairCreated(address(vault), address(strategy), msg.sender);
    }
}
