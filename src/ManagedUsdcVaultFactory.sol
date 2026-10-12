// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ManagedUpgradeController} from "./managed/ManagedUpgradeController.sol";
import {ManagedUsdcVault} from "./ManagedUsdcVault.sol";

/// @dev Inert creation-code storage: STOP followed by constructor bytecode.
contract ManagedVaultCodeChunk {
    constructor(bytes memory code, uint256 offset, uint256 length) {
        require(length <= 24_575 && offset + length <= code.length);
        assembly ("memory-safe") {
            let start := add(add(code, 0x1f), offset)
            mstore8(start, 0)
            return(start, add(length, 1))
        }
    }
}

/// @dev Created by its factory; template and code stores are not caller-supplied.
contract ManagedVaultDeployer {
    address public immutable factory;
    address public immutable firstPart;
    address public immutable secondPart;
    uint256 public immutable split;
    uint256 public immutable length;

    constructor() {
        factory = msg.sender;
        bytes memory code = type(ManagedUsdcVault).creationCode;
        split = code.length / 2;
        length = code.length;
        firstPart = address(new ManagedVaultCodeChunk(code, 0, split));
        secondPart = address(new ManagedVaultCodeChunk(code, split, code.length - split));
    }

    function deploy(ManagedUsdcVault.Config memory c) external returns (ManagedUsdcVault vault) {
        require(msg.sender == factory && c.factory == factory);
        ManagedUpgradeController controller = new ManagedUpgradeController(c.owner);
        c.upgradeController = address(controller);
        bytes memory code = new bytes(length);
        address a = firstPart;
        address b = secondPart;
        uint256 n = split;
        uint256 size = length;
        assembly ("memory-safe") {
            extcodecopy(a, add(code, 32), 1, n)
            extcodecopy(b, add(add(code, 32), n), 1, sub(size, n))
        }
        code = bytes.concat(code, abi.encode(c));
        address deployed;
        assembly ("memory-safe") {
            deployed := create(0, add(code, 32), mload(code))
            if iszero(deployed) { revert(0, 0) }
        }
        vault = ManagedUsdcVault(address(new TransparentUpgradeableProxy(deployed, address(controller), "")));
        controller.bind(address(vault), deployed);
    }
}

/// @notice Permissionless creation; each caller owns only their resulting Vault.
contract ManagedUsdcVaultFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant FOUNDER_ASSETS = 100e6;
    ManagedVaultDeployer public immutable deployer;
    ManagedUsdcVault.Config private _template;
    mapping(address => bool) public isVault;
    uint256 public vaultCount;

    error ActivationBudgetExceeded();
    error InvalidTemplate();
    error BalanceMismatch();
    event VaultCreated(address indexed vault, address indexed owner, uint256 indexed index, bytes32 configHash);

    constructor(ManagedUsdcVault.Config memory template) {
        if (
            template.upgradeController != address(0) || template.owner != address(0) || template.factory != address(0)
                || template.chainId != block.chainid
        ) revert InvalidTemplate();
        template.factory = address(this);
        _template = template;
        deployer = new ManagedVaultDeployer();
    }

    function templateConfig() external view returns (ManagedUsdcVault.Config memory) {
        return _template;
    }

    function createVaultAndFund(uint256 maxActivationCost) external nonReentrant returns (ManagedUsdcVault vault) {
        return _create(
            "Managed HyperCore USDC Share", maxActivationCost, _template.performanceFeeBps, _template.minimumDeposit
        );
    }

    function createVaultAndFund(uint256 maxActivationCost, uint16 feeBps, uint256 minimumDeposit)
        external
        nonReentrant
        returns (ManagedUsdcVault vault)
    {
        return _create("Managed HyperCore USDC Share", maxActivationCost, feeBps, minimumDeposit);
    }

    function createVaultAndFund(
        string calldata vaultName,
        uint256 maxActivationCost,
        uint16 feeBps,
        uint256 minimumDeposit
    ) external nonReentrant returns (ManagedUsdcVault vault) {
        return _create(vaultName, maxActivationCost, feeBps, minimumDeposit);
    }

    function _create(string memory vaultName, uint256 maxActivationCost, uint16 feeBps, uint256 minimumDeposit)
        private
        returns (ManagedUsdcVault vault)
    {
        ManagedUsdcVault.Config memory c = _template;
        c.performanceFeeBps = feeBps;
        c.minimumDeposit = minimumDeposit;
        if (c.activationCost > maxActivationCost) revert ActivationBudgetExceeded();
        c.owner = msg.sender;
        vault = deployer.deploy(c);
        IERC20 usdc = IERC20(c.asset);
        uint256 gross = FOUNDER_ASSETS + c.activationCost;
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), gross);
        if (usdc.balanceOf(address(this)) - beforeBalance != gross) revert BalanceMismatch();
        usdc.forceApprove(address(vault), gross);
        vault.bootstrap(vaultName);
        usdc.forceApprove(address(vault), 0);
        if (usdc.balanceOf(address(this)) != beforeBalance) revert BalanceMismatch();
        isVault[address(vault)] = true;
        emit VaultCreated(address(vault), msg.sender, ++vaultCount, vault.configHash());
    }
}
