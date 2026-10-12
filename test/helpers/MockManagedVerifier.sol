// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IManagedVaultVerifier} from "../../src/interfaces/IManagedVaultVerifier.sol";
import {IManagedNavCash} from "../../src/managed/ManagedPortfolioNavVerifier.sol";
import {CoreRead} from "../../src/CoreRead.sol";

/// @dev TEST ONLY. Anyone can insert synthetic evidence. Never deploy with real funds.
contract MockManagedVerifier is IManagedVaultVerifier {
    mapping(bytes32 => Receipt) private _receipts;
    mapping(bytes32 => uint64) private _idle;
    error MissingEvidence();

    struct Nav {
        int256 net;
        uint64 atBlock;
        uint256 nonce;
        bytes32 config;
    }
    mapping(address => Nav) private _nav;

    function setNav(address vault, int256 net, uint64 atBlock, uint256 nonce, bytes32 config) external {
        _nav[vault] = Nav(net, atBlock, nonce, config);
    }

    function verifyNav(address vault, uint256 nonce, bytes32 config) external view returns (uint256, uint64) {
        Nav memory n = _nav[vault];
        if (n.atBlock == 0 || n.atBlock != CoreRead.l1Block() || n.nonce != nonce || n.config != config) {
            revert MissingEvidence();
        }
        int256 total = int256(IManagedNavCash(vault).availableCash()) + n.net;
        if (total < 0) revert MissingEvidence();
        return (uint256(total), n.atBlock);
    }

    function setReceipt(address vault, uint256 id, bytes32 digest, Receipt calldata receipt) external {
        _receipts[keccak256(abi.encode(block.chainid, vault, id, digest))] = receipt;
    }

    function verifyAction(address vault, uint256 id, bytes32 digest, bytes calldata)
        external
        view
        returns (Receipt memory r)
    {
        r = _receipts[keccak256(abi.encode(block.chainid, vault, id, digest))];
        if (r.coreBlock == 0) revert MissingEvidence();
    }

    function setIdle(address vault, uint256 epoch, uint256 nonce, uint64 coreBlock) external {
        _idle[keccak256(abi.encode(block.chainid, vault, epoch, nonce))] = coreBlock;
    }

    function verifyIdle(address vault, uint256 epoch, uint256 nonce, bytes calldata)
        external
        view
        returns (uint64 result)
    {
        result = _idle[keccak256(abi.encode(block.chainid, vault, epoch, nonce))];
        if (result == 0) revert MissingEvidence();
    }
}
