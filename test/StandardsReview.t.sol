// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncVaultFixture, VmAsync} from "./AsyncHypeVault.t.sol";
import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {EpochRedeem} from "../src/vault/EpochRedeem.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockStrategyAccount} from "./helpers/MockStrategyAccount.sol";

/// @notice Targeted standards review, not a comprehensive compliance certification.
/// @dev Includes regressions for deposit limits and zero-value share transfers.
contract StandardsReviewTest is AsyncVaultFixture {
    function testERC165CanonicalIdsWithinThirtyThousandGas() public view {
        bytes4[6] memory supported = [bytes4(0x01ffc9a7), 0xe3bc4e65, 0x620ee8e4, 0x2f0a18c5, 0xf815c03d, 0x7965db0b];
        for (uint256 i; i < supported.length; ++i) {
            (bool ok, bytes memory data) = address(vault).staticcall{gas: 30_000}(
                abi.encodeWithSignature("supportsInterface(bytes4)", supported[i])
            );
            require(ok && data.length == 32 && abi.decode(data, (bool)), "required interface unavailable");
        }
        bytes4[3] memory unsupported = [bytes4(0xffffffff), 0xce3bbe50, 0x12345678];
        for (uint256 i; i < unsupported.length; ++i) {
            (bool ok, bytes memory data) = address(vault).staticcall{gas: 30_000}(
                abi.encodeWithSignature("supportsInterface(bytes4)", unsupported[i])
            );
            require(ok && data.length == 32 && !abi.decode(data, (bool)), "unsupported interface advertised");
        }
    }

    function testSelfShareLookupAndVaultUpdateEvent() public {
        VM.recordLogs();
        AsyncHypeVault fresh = new AsyncHypeVault(config());
        VmAsync.Log[] memory logs = VM.getRecordedLogs();
        require(fresh.share() == address(fresh));
        require(fresh.asset() == address(whype) && fresh.decimals() == 21);
        require(fresh.vault(address(whype)) == address(fresh));
        require(fresh.vault(address(0x1234)) == address(0));
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(fresh) && logs[i].topics[0] == keccak256("VaultUpdate(address,address)")) {
                require(logs[i].topics.length == 2);
                require(logs[i].topics[1] == bytes32(uint256(uint160(address(whype)))));
                require(abi.decode(logs[i].data, (address)) == address(fresh));
                found = true;
            }
        }
        require(found, "missing VaultUpdate");
    }

    function testOperatorEventReturnValueAndRevocation() public {
        VM.recordLogs();
        VM.prank(ALICE);
        require(vault.setOperator(KEEPER, true));
        VmAsync.Log[] memory logs = VM.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics.length == 3);
        require(logs[0].topics[0] == keccak256("OperatorSet(address,address,bool)"));
        require(logs[0].topics[1] == bytes32(uint256(uint160(ALICE))));
        require(logs[0].topics[2] == bytes32(uint256(uint160(KEEPER))));
        require(abi.decode(logs[0].data, (bool)) && vault.isOperator(ALICE, KEEPER));
        VM.prank(ALICE);
        require(vault.setOperator(KEEPER, false));
        require(!vault.isOperator(ALICE, KEEPER));
    }

    function testRequestEventWithDifferentOwnerControllerAndSender() public {
        uint256 shares = depositFor(ALICE, 1 ether);
        vault.startCycle(1 ether);
        VM.prank(ALICE);
        vault.approve(KEEPER, shares);
        VM.recordLogs();
        VM.prank(KEEPER);
        uint256 id = vault.requestRedeem(shares, BOB, ALICE);
        VmAsync.Log[] memory logs = VM.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(vault)
                    && logs[i].topics[0] == keccak256("RedeemRequest(address,address,uint256,address,uint256)")
            ) {
                require(logs[i].topics.length == 4);
                require(logs[i].topics[1] == bytes32(uint256(uint160(BOB))));
                require(logs[i].topics[2] == bytes32(uint256(uint160(ALICE))));
                require(logs[i].topics[3] == bytes32(id));
                (address sender, uint256 amount) = abi.decode(logs[i].data, (address, uint256));
                require(sender == KEEPER && amount == shares);
                found = true;
            }
        }
        require(found && vault.pendingRedeemRequest(id, BOB) == shares);
        require(vault.pendingRedeemRequest(id, ALICE) == 0);
        require(vault.allowance(ALICE, KEEPER) == 0);
        finish(1 ether);
        VM.prank(ALICE);
        VM.expectRevert(EpochRedeem.UnauthorizedController.selector);
        vault.redeem(shares, ALICE, BOB);
        VM.prank(BOB);
        require(vault.redeem(shares, ALICE, BOB) == 1 ether);
    }

    function testInfiniteRequestAllowanceIsNotConsumed() public {
        uint256 shares = depositFor(ALICE, 1 ether);
        VM.prank(ALICE);
        vault.approve(KEEPER, type(uint256).max);
        VM.prank(KEEPER);
        vault.requestRedeem(shares, ALICE, ALICE);
        require(vault.allowance(ALICE, KEEPER) == type(uint256).max);
    }

    function testClaimEmitsWithdrawWithoutSecondBurn() public {
        uint256 shares = depositFor(ALICE, 1 ether);
        requestFor(ALICE, shares);
        require(vault.totalSupply() == 0 && whype.balanceOf(ALICE) == 0);
        VM.prank(ALICE);
        vault.setOperator(KEEPER, true);
        VM.recordLogs();
        VM.prank(KEEPER);
        require(vault.withdraw(1 ether, BOB, ALICE) == shares);
        VmAsync.Log[] memory logs = VM.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(vault)) continue;
            require(logs[i].topics[0] != keccak256("Transfer(address,address,uint256)"), "second share burn");
            if (logs[i].topics[0] == keccak256("Withdraw(address,address,address,uint256,uint256)")) {
                require(logs[i].topics.length == 4);
                require(logs[i].topics[1] == bytes32(uint256(uint160(KEEPER))));
                require(logs[i].topics[2] == bytes32(uint256(uint160(BOB))));
                require(logs[i].topics[3] == bytes32(uint256(uint160(ALICE))));
                (uint256 assets, uint256 consumed) = abi.decode(logs[i].data, (uint256, uint256));
                require(assets == 1 ether && consumed == shares);
                found = true;
            }
        }
        require(found && whype.balanceOf(BOB) == 1 ether);
        require(vault.maxWithdraw(ALICE) == 0 && vault.maxRedeem(ALICE) == 0);
    }

    function testSynchronousDepositAndMintMatchPreviews() public {
        depositFor(BOB, 7 ether);
        whype.mint(address(vault), 3 ether);
        whype.mint(ALICE, 10 ether);
        VM.startPrank(ALICE);
        whype.approve(address(vault), type(uint256).max);
        uint256 expectedShares = vault.previewDeposit(1 ether);
        require(vault.deposit(1 ether, ALICE) == expectedShares);
        uint256 targetShares = 123456789;
        uint256 expectedAssets = vault.previewMint(targetShares);
        require(vault.mint(targetShares, ALICE) == expectedAssets);
        VM.stopPrank();
    }

    function testFuzzRequestViewsAreCallerIndependent(uint256 id, address controller) public {
        uint256 shares = depositFor(ALICE, 1 ether);
        vault.startCycle(1 ether);
        requestFor(ALICE, shares);
        uint256 pending = vault.pendingRedeemRequest(id, controller);
        uint256 claimable = vault.claimableRedeemRequest(id, controller);
        VM.prank(BOB);
        require(vault.pendingRedeemRequest(id, controller) == pending);
        VM.prank(KEEPER);
        require(vault.claimableRedeemRequest(id, controller) == claimable);
        require(vault.pendingRedeemRequest(0, controller) == 0);
        require(vault.claimableRedeemRequest(0, controller) == 0);
    }

    function testAsyncPreviewsRevertForExtremeInputsAndAfterSettlement() public {
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewRedeem(type(uint256).max);
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewWithdraw(type(uint256).max);
        uint256 shares = depositFor(ALICE, 1 ether);
        requestFor(ALICE, shares);
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewRedeem(shares);
        VM.expectRevert(EpochRedeem.AsyncPreviewUnsupported.selector);
        vault.previewWithdraw(1 ether);
    }

    function testSameEpochBecomesClaimableAtOneSharedRate() public {
        uint256 sa = depositFor(ALICE, 10 ether);
        uint256 sb = depositFor(BOB, 20 ether);
        vault.startCycle(30 ether);
        uint256 id = requestFor(ALICE, sa);
        require(requestFor(BOB, sb) == id && id != 0);
        require(vault.claimableRedeemRequest(id, ALICE) == 0 && vault.claimableRedeemRequest(id, BOB) == 0);
        finish(31 ether);
        require(vault.pendingRedeemRequest(id, ALICE) == 0 && vault.pendingRedeemRequest(id, BOB) == 0);
        require(vault.claimableRedeemRequest(id, ALICE) == sa && vault.claimableRedeemRequest(id, BOB) == sb);
        (,, uint256 numerator, uint256 denominator,,,) = vault.epochs(id);
        require(vault.maxWithdraw(ALICE) == Math.mulDiv(sa, numerator, denominator));
        require(vault.maxWithdraw(BOB) == Math.mulDiv(sb, numerator, denominator));
    }

    /// @dev Regression for STD-F01: no positive deposit can mint shares within the remaining capacity.
    function testMaxDepositIsZeroWhenRemainingCapacityMintsNoShares() public {
        uint256 capacity = vault.maximumTotalAssets();
        whype.mint(address(vault), capacity - 1);
        require(vault.totalSupply() == 0);
        require(vault.previewDeposit(1) == 0);
        require(vault.maxDeposit(ALICE) == 0);
        require(vault.maxMint(ALICE) == 0);
        whype.mint(ALICE, 1);
        VM.startPrank(ALICE);
        whype.approve(address(vault), 1);
        VM.expectRevert(AsyncHypeVault.CapitalClosed.selector);
        vault.deposit(1, ALICE);
        VM.expectRevert(AsyncHypeVault.CapitalClosed.selector);
        vault.mint(1, ALICE);
        VM.stopPrank();
    }

    function testMaxDepositAtOneShareBoundary() public {
        _useAssetCap(2000);
        whype.mint(address(vault), 1998);
        require(vault.previewDeposit(1) == 0 && vault.previewDeposit(2) == 1);
        require(vault.maxDeposit(ALICE) == 2 && vault.maxMint(ALICE) == 1);
        whype.mint(ALICE, 3);
        VM.startPrank(ALICE);
        whype.approve(address(vault), 3);
        VM.expectRevert(EpochRedeem.InvalidAmount.selector);
        vault.deposit(1, ALICE);
        VM.expectRevert(AsyncHypeVault.CapitalClosed.selector);
        vault.deposit(3, ALICE);
        require(vault.deposit(2, ALICE) == 1);
        VM.stopPrank();
        require(vault.maxDeposit(ALICE) == 0 && vault.maxMint(ALICE) == 0);
    }

    function testMaxMintAtOneShareBoundary() public {
        _useAssetCap(2000);
        whype.mint(address(vault), 1998);
        require(vault.maxDeposit(ALICE) == 2 && vault.maxMint(ALICE) == 1);
        require(vault.previewMint(1) == 2);
        whype.mint(ALICE, 4);
        VM.startPrank(ALICE);
        whype.approve(address(vault), 4);
        VM.expectRevert(AsyncHypeVault.CapitalClosed.selector);
        vault.mint(2, ALICE);
        require(vault.mint(1, ALICE) == 2);
        VM.stopPrank();
        require(vault.maxDeposit(ALICE) == 0 && vault.maxMint(ALICE) == 0);
    }

    function testMaxDepositExcludesExistingClaimReserves() public {
        uint256 shares = depositFor(ALICE, 20 ether);
        depositFor(BOB, 10 ether);
        requestFor(ALICE, shares);
        uint256 reserved = vault.reservedClaimAssets();
        require(reserved == 20 ether && vault.availableCash() == 10 ether);
        uint256 limit = vault.maxDeposit(BOB);
        require(limit == vault.maximumTotalAssets() - 10 ether);
        uint256 expected = vault.previewDeposit(limit);
        require(depositFor(BOB, limit) == expected && expected > 0);
        require(vault.reservedClaimAssets() == reserved);
        require(vault.availableCash() == vault.maximumTotalAssets());
        VM.prank(ALICE);
        require(vault.redeem(shares, ALICE, ALICE) == reserved);
        require(vault.maxDeposit(BOB) == 0);
    }

    function testFuzzAdvertisedCapitalLimitsAreExecutable(
        uint128 capSeed,
        uint128 initialSeed,
        uint128 donationSeed,
        bool mintAtLimit
    ) public {
        uint256 cap = capSeed == 0 ? 1 : uint256(capSeed);
        _useAssetCap(cap);
        uint256 initial = uint256(initialSeed) % (cap + 1);
        if (initial > 0) depositFor(BOB, initial);
        whype.mint(address(vault), uint256(donationSeed) % (cap + 1));
        // Query before funding ALICE: limits must not depend on the depositor's balance.
        require(whype.balanceOf(ALICE) == 0);
        uint256 assets = vault.maxDeposit(ALICE);
        uint256 shares = vault.maxMint(ALICE);
        uint256 cash = vault.availableCash();
        if (assets == 0) {
            require(shares == 0);
            if (cash < cap) require(vault.previewDeposit(cap - cash) == 0);
            return;
        }
        require(assets == cap - cash && shares > 0);
        require(vault.previewMint(shares) <= assets);
        require(vault.previewMint(shares + 1) > assets);
        whype.mint(ALICE, assets + 1);
        VM.startPrank(ALICE);
        whype.approve(address(vault), type(uint256).max);
        VM.expectRevert(AsyncHypeVault.CapitalClosed.selector);
        vault.deposit(assets + 1, ALICE);
        VM.expectRevert(AsyncHypeVault.CapitalClosed.selector);
        vault.mint(shares + 1, ALICE);
        if (mintAtLimit) {
            uint256 expectedAssets = vault.previewMint(shares);
            require(vault.mint(shares, ALICE) == expectedAssets);
        } else {
            require(vault.deposit(assets, ALICE) == shares);
        }
        VM.stopPrank();
        require(vault.balanceOf(ALICE) == shares && vault.availableCash() <= cap);
        require(vault.maxDeposit(ALICE) == 0 && vault.maxMint(ALICE) == 0);
    }

    function _useAssetCap(uint256 cap) private {
        AsyncHypeVault.Config memory c = config();
        c.maxAssets = cap;
        c.recapCap = 0;
        vault = new AsyncHypeVault(c);
        strategy = new MockStrategyAccount(address(vault), address(whype));
        vault.bindStrategyOnce(address(strategy));
    }

    function testZeroShareTransfersEmitEventsWithoutChangingAccounting() public {
        _assertZeroTransfer(ALICE, BOB, false);
        _assertZeroTransfer(ALICE, address(vault), false);
        _assertZeroTransfer(ALICE, address(vault), true);
        _assertZeroTransfer(address(vault), BOB, true);
        _assertZeroTransfer(address(vault), address(vault), true);
        _assertZeroTransfer(ALICE, ALICE, false);
        require(vault.controllerEpoch(ALICE) == 0 && vault.nextEpochId() == 1);
        VM.prank(ALICE);
        VM.expectRevert(EpochRedeem.InvalidAmount.selector);
        vault.requestRedeem(0, ALICE, ALICE);
    }

    function testFuzzZeroTransferFromPreservesAllowance(uint256 allowance_) public {
        depositFor(ALICE, 2 ether);
        VM.prank(ALICE);
        vault.approve(KEEPER, allowance_);
        _assertZeroTransfer(ALICE, address(vault), true);
        require(vault.allowance(ALICE, KEEPER) == allowance_);
    }

    function testZeroTransfersPreserveEscrowSettlementAndClaims() public {
        uint256 shares = depositFor(ALICE, 10 ether);
        depositFor(BOB, 1 ether);
        vault.startCycle(11 ether);
        uint256 id = requestFor(ALICE, shares);
        require(vault.balanceOf(address(vault)) == shares);
        _assertZeroTransfer(ALICE, address(vault), false);
        _assertZeroTransfer(address(vault), BOB, true);
        require(vault.pendingRedeemRequest(id, ALICE) == shares);
        require(vault.pendingRedeemRequest(id, BOB) == 0 && vault.controllerEpoch(BOB) == 0);
        VM.prank(BOB);
        VM.expectRevert(EpochRedeem.DirectShareTransferForbidden.selector);
        vault.transfer(address(vault), 1);
        VM.prank(BOB);
        vault.approve(KEEPER, 1);
        VM.prank(KEEPER);
        VM.expectRevert(EpochRedeem.DirectShareTransferForbidden.selector);
        vault.transferFrom(BOB, address(vault), 1);
        require(vault.allowance(BOB, KEEPER) == 1, "revert consumed allowance");
        // Even a call attributed to the Vault cannot move positive escrow shares out.
        VM.prank(address(vault));
        VM.expectRevert(EpochRedeem.DirectShareTransferForbidden.selector);
        vault.transfer(BOB, 1);
        finish(11 ether);
        require(vault.balanceOf(address(vault)) == 0 && vault.totalSupply() == vault.balanceOf(BOB));
        require(vault.claimableRedeemRequest(id, ALICE) == shares);
        uint256 claim = vault.maxWithdraw(ALICE);
        require(claim == 10 ether);
        _assertZeroTransfer(ALICE, address(vault), true);
        _assertZeroTransfer(address(vault), BOB, true);
        require(vault.maxWithdraw(ALICE) == claim && vault.maxRedeem(ALICE) == shares);
        VM.prank(ALICE);
        require(vault.redeem(shares, ALICE, ALICE) == claim);
        require(whype.balanceOf(ALICE) == claim && vault.reservedClaimAssets() == 0);
    }

    function testZeroTransfersRemainAvailableDuringPauseAndShutdown() public {
        depositFor(ALICE, 1 ether);
        vault.setRiskPaused(true);
        _assertZeroTransfer(ALICE, address(vault), false);
        _assertZeroTransfer(ALICE, address(vault), true);
        vault.permanentlyShutdown();
        _assertZeroTransfer(ALICE, address(vault), false);
        _assertZeroTransfer(ALICE, address(vault), true);
        require(vault.maxDeposit(ALICE) == 0);
    }

    function testZeroTransfersRetainOZAddressValidation() public {
        VM.prank(ALICE);
        VM.expectRevert();
        vault.transfer(address(0), 0);
        VM.prank(KEEPER);
        VM.expectRevert();
        vault.transferFrom(ALICE, address(0), 0);
        VM.prank(KEEPER);
        VM.expectRevert();
        vault.transferFrom(address(0), address(vault), 0);
    }

    function _assertZeroTransfer(address from, address to, bool delegated) private {
        bytes32 beforeState = _shareAccountingHash(from, to);
        VM.recordLogs();
        VM.prank(delegated ? KEEPER : from);
        require(delegated ? vault.transferFrom(from, to, 0) : vault.transfer(to, 0));
        VmAsync.Log[] memory logs = VM.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(vault));
        require(logs[0].topics.length == 3 && logs[0].topics[0] == keccak256("Transfer(address,address,uint256)"));
        require(logs[0].topics[1] == bytes32(uint256(uint160(from))));
        require(logs[0].topics[2] == bytes32(uint256(uint160(to))));
        require(abi.decode(logs[0].data, (uint256)) == 0);
        require(_shareAccountingHash(from, to) == beforeState, "zero transfer changed accounting");
    }

    function _shareAccountingHash(address from, address to) private view returns (bytes32) {
        return keccak256(
            abi.encode(
                vault.totalSupply(),
                vault.balanceOf(from),
                vault.balanceOf(to),
                vault.balanceOf(address(vault)),
                vault.availableCash(),
                vault.reservedClaimAssets(),
                vault.roundingReserve(),
                vault.nextEpochId(),
                vault.controllerEpoch(from),
                vault.controllerEpoch(to),
                vault.allowance(from, KEEPER)
            )
        );
    }
}
