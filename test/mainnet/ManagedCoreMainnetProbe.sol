// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CoreRead} from "../../src/CoreRead.sol";
import {CoreActions, ICoreWriter} from "../../src/CoreActions.sol";
import {ManagedCoreActions} from "../../src/managed/ManagedCoreActions.sol";
import {IManagedCoreDepositWallet} from "../../src/ManagedUsdcVault.sol";

/// @notice Isolated, owner-funded MAINNET integration experiment, NOT an investor Vault.
/// @dev No shares, verifier, NAV or claim accounting. Submission never proves Core execution.
contract ManagedCoreMainnetProbe is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant USDC = 0xb88339CB7199b77E23DB6E890353E22632Ba630f;
    address public constant CIRCLE = 0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24;
    address public constant WRITER = 0x3333333333333333333333333333333333333333;
    address public immutable owner;
    address public immutable disabledAgent;
    mapping(address => bool) public usedAgents;
    uint256 public sequence;
    event Submitted(uint256 indexed sequence, uint64 coreBlock, bytes payload);
    event DepositSubmitted(uint256 assets, uint64 coreBlock);

    constructor(address owner_) {
        require(block.chainid == 999 && owner_ != address(0), "mainnet owner required");
        owner = owner_;
        disabledAgent =
            address(uint160(uint256(keccak256(abi.encode("PROBE_DISABLED_AGENT", block.chainid, address(this))))));
    }
    modifier onlyOwner() {
        require(msg.sender == owner, "owner only");
        _;
    }

    function fundCore(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "amount");
        IERC20 token = IERC20(USDC);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(owner, address(this), amount);
        require(token.balanceOf(address(this)) - beforeBalance == amount, "funding delta");
        token.forceApprove(CIRCLE, amount);
        IManagedCoreDepositWallet(CIRCLE).deposit(amount, type(uint32).max);
        token.forceApprove(CIRCLE, 0);
        require(token.balanceOf(address(this)) == beforeBalance, "deposit delta");
        emit DepositSubmitted(amount, CoreRead.l1Block());
    }

    function setApiWallet(address agent) external onlyOwner nonReentrant {
        require(
            agent != owner && agent != address(this) && agent != disabledAgent && !usedAgents[agent],
            "new dedicated key"
        );
        usedAgents[agent] = true;
        _submit(ManagedCoreActions.agent(agent));
    }

    function revokeApiWallet() external onlyOwner nonReentrant {
        _submit(ManagedCoreActions.agent(disabledAgent));
    }

    function recallUsdcFromCore(uint32 dex, uint256 amount) external onlyOwner nonReentrant {
        _submit(ManagedCoreActions.recall(0, dex, amount));
    }

    function transferWithinCore(uint64 token, uint32 fromDex, uint32 toDex, uint64 amount)
        external
        onlyOwner
        nonReentrant
    {
        require(fromDex != toDex, "same dex");
        _submit(ManagedCoreActions.move(address(this), token, fromDex, toDex, amount));
    }

    function supplyToLending(uint64 token, uint64 amount) external onlyOwner nonReentrant {
        _submit(CoreActions.lend(CoreActions.LendingOperation.Supply, token, amount));
    }

    function withdrawFromLending(uint64 token, uint64 amount) external onlyOwner nonReentrant {
        _submit(CoreActions.lend(CoreActions.LendingOperation.Withdraw, token, amount));
    }

    function withdrawAllFromLending(uint64 token) external onlyOwner nonReentrant {
        _submit(CoreActions.withdrawAll(token));
    }

    function setAbstraction(CoreActions.Abstraction mode) external onlyOwner nonReentrant {
        _submit(CoreActions.setAbstraction(address(this), mode));
    }

    function approveBuilderFee(address builder, uint64 rate) external onlyOwner nonReentrant {
        _submit(ManagedCoreActions.builderFee(builder, rate));
    }

    function recoverEvmUsdc(uint256 amount) external onlyOwner nonReentrant {
        IERC20(USDC).safeTransfer(owner, amount);
    }

    function _submit(bytes memory payload) private {
        require(CoreRead.userExists(address(this)), "wait for Core activation");
        emit Submitted(++sequence, CoreRead.l1Block(), payload);
        ICoreWriter(WRITER).sendRawAction(payload);
    }
}
