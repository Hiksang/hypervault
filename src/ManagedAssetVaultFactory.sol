// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ManagedUpgradeController} from "./managed/ManagedUpgradeController.sol";
import {ManagedHypeRouter} from "./ManagedHypeRouter.sol";
import {ManagedAssetBridge} from "./managed/ManagedAssetBridge.sol";
import {IWrappedHype} from "./interfaces/IWrappedHype.sol";
import {CoreRead} from "./CoreRead.sol";
import {ManagedAssetVault} from "./ManagedAssetVault.sol";

/// @dev Inert creation-code storage: STOP followed by constructor bytecode.
contract ManagedAssetCodeChunk {
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
contract ManagedAssetDeployer {
    address public immutable factory;
    address public immutable firstPart;
    address public immutable secondPart;
    uint256 public immutable split;
    uint256 public immutable length;

    constructor() {
        factory = msg.sender;
        bytes memory code = type(ManagedAssetVault).creationCode;
        split = code.length / 2;
        length = code.length;
        firstPart = address(new ManagedAssetCodeChunk(code, 0, split));
        secondPart = address(new ManagedAssetCodeChunk(code, split, code.length - split));
    }

    function deployNativeRouter(ManagedAssetVault vault) external returns (address) {
        require(msg.sender == factory);
        return address(new ManagedHypeRouter(vault));
    }

    function deploy(ManagedAssetVault.Config memory c) external returns (ManagedAssetVault vault) {
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
        vault = ManagedAssetVault(payable(address(new TransparentUpgradeableProxy(deployed, address(controller), ""))));
        controller.bind(address(vault), deployed);
    }
}

/// @notice Permissionless creation; each caller owns only their resulting Vault.
contract ManagedAssetVaultFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;
    ManagedAssetDeployer public immutable deployer;
    mapping(address => ManagedAssetVault.Config) private _templates;
    address[] public assets;
    mapping(address => bool) public isVault;
    address[] public vaults;
    mapping(address => address) public vaultAsset;
    mapping(address => address) public vaultController;
    mapping(address => address) public initialImplementation;
    mapping(address => address) public nativeRouter;
    event VaultCreated(address indexed vault, address indexed owner, address indexed asset, bytes32 configHash);
    error InvalidTemplate();
    error InvalidFunding();

    constructor(ManagedAssetVault.Config[] memory templates) {
        if (templates.length == 0 || templates.length > 3) revert InvalidTemplate();
        for (uint256 i; i < templates.length; ++i) {
            ManagedAssetVault.Config memory c = templates[i];
            if (
                c.owner != address(0) || c.factory != address(0) || c.upgradeController != address(0)
                    || c.chainId != block.chainid || _templates[c.asset].asset != address(0)
            ) revert InvalidTemplate();
            ManagedAssetBridge b = ManagedAssetBridge(c.bridge);
            if (b.asset() != c.asset || b.circle() != c.coreDepositWallet || c.activationCost == 0) {
                revert InvalidTemplate();
            }
            c.factory = address(this);
            _templates[c.asset] = c;
            assets.push(c.asset);
        }
        deployer = new ManagedAssetDeployer();
    }

    function templateConfig(address asset) external view returns (ManagedAssetVault.Config memory) {
        if (_templates[asset].asset == address(0)) revert InvalidTemplate();
        return _templates[asset];
    }

    function assetCount() external view returns (uint256) {
        return assets.length;
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice The native HYPE option wraps msg.value. Activation is always separately approved USDC.
    /// @dev Founder amount is explicit, bounded by the caller and checked against the live 100-USDC floor.
    function createVaultAndFund(
        address asset,
        string calldata name,
        uint256 founderAssets,
        uint256 maxActivationCost,
        uint16 feeBps,
        uint256 minimumDeposit
    ) external payable nonReentrant returns (ManagedAssetVault vault) {
        ManagedAssetVault.Config memory c = _templates[asset];
        if (c.asset == address(0)) revert InvalidTemplate();
        ManagedAssetBridge b = ManagedAssetBridge(c.bridge);
        if (founderAssets < b.minimumFounderAssets() || c.activationCost > maxActivationCost) revert InvalidFunding();
        b.toCore(founderAssets);
        c.owner = msg.sender;
        c.performanceFeeBps = feeBps;
        c.minimumDeposit = minimumDeposit;
        vault = deployer.deploy(c);
        uint256 activation = CoreRead.userExists(address(vault)) ? 0 : c.activationCost;
        IERC20 token = IERC20(asset);
        IERC20 usd = IERC20(b.activationAsset());
        uint256 beforeAsset = token.balanceOf(address(this));
        uint256 beforeUsd = usd.balanceOf(address(this));
        if (msg.value != 0) {
            if (b.kind() != ManagedAssetBridge.Kind.NativeHype || msg.value != founderAssets) revert InvalidFunding();
            IWrappedHype(asset).deposit{value: msg.value}();
        } else {
            token.safeTransferFrom(msg.sender, address(this), founderAssets);
        }
        if (token.balanceOf(address(this)) != beforeAsset + founderAssets) revert InvalidFunding();
        if (activation != 0) usd.safeTransferFrom(msg.sender, address(this), activation);
        if (usd.balanceOf(address(this)) != beforeUsd + activation + (asset == address(usd) ? founderAssets : 0)) {
            revert InvalidFunding();
        }
        token.forceApprove(address(vault), founderAssets + (asset == address(usd) ? activation : 0));
        if (asset != address(usd)) usd.forceApprove(address(vault), activation);
        vault.bootstrap(name, founderAssets);
        token.forceApprove(address(vault), 0);
        if (asset != address(usd)) usd.forceApprove(address(vault), 0);
        if (token.balanceOf(address(this)) != beforeAsset || usd.balanceOf(address(this)) != beforeUsd) {
            revert InvalidFunding();
        }
        vaultAsset[address(vault)] = asset;
        vaultController[address(vault)] = address(vault.upgradeController());
        initialImplementation[address(vault)] = vault.upgradeController().implementation();
        if (b.kind() == ManagedAssetBridge.Kind.NativeHype) {
            nativeRouter[address(vault)] = deployer.deployNativeRouter(vault);
        }
        isVault[address(vault)] = true;
        vaults.push(address(vault));
        emit VaultCreated(address(vault), msg.sender, asset, vault.configHash());
    }
}
