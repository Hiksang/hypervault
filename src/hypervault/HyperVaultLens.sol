// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {HyperVault, IHyperVaultOracleGate} from "./HyperVault.sol";
import {HyperVaultTypes} from "./HyperVaultTypes.sol";
import {HyperVaultAccountant} from "./HyperVaultAccountant.sol";

/// @notice Read-only views over a HyperVault for wallets and the FE (ADR-041): instant-exit
///         previews that follow `redeemNow` step by step, the controller's redeem request, the
///         fee due now and the deposit room, in one call. Holds no state and no privilege;
///         replacing it never touches a Vault.
/// @dev Every Vault, accountant and verifier read happens once per call (`_state`); share counts
///      are then solved in memory, so a view costs about one NAV verification whatever the size.
contract HyperVaultLens {
    uint256 private constant PRICE_SCALE = 1e30;

    /// @dev Why `redeemNow` would refuse: the first check that fails, in the Vault's order.
    enum Block {
        None,
        WrongPhase, // not Active/Ready: Idle pays through requestRedeem, Exiting through the epoch
        InvalidAmount, // zero shares, or the whole supply (the last holder takes the epoch path)
        NavUnavailable, // NAV read failed, a Core action is pending, or the record gate could not be read
        NeedsRecord, // no record in the window and the scope is not oracle-only (ADR-040)
        ZeroAssets, // rounds to nothing
        OverFreeCash, // more than the free EVM cash
        CashDeficit // the Vault's cash accounting does not hold: every exit reverts
    }

    struct Account {
        HyperVaultTypes.Phase phase;
        bool navOk;
        uint256 nav; // live shareholder assets (0 when !navOk)
        bool realized;
        uint256 totalSupply;
        uint256 price; // post-fee share price at 1e30, what a crystallization now would set
        uint256 feeShares; // fee a crystallization now would mint
        uint256 feeAssets;
        uint256 windowLow; // type(uint256).max without records (or when unreadable)
        bool oracleOnly;
        uint256 availableCash;
        uint256 maxDeposit;
        uint256 minimumDeposit;
        uint256 maximumAssets;
        uint256 shares; // the account's share balance
        uint256 value; // shares at `price`
        uint256 redeemNowShares; // most shares `redeemNow` would take from this account now
        uint256 redeemNowAssets; // and what they would pay
        Block redeemNowBlock; // why no instant exit is possible, when redeemNowShares is 0
        uint256 requestId;
        uint256 pendingShares;
        uint256 claimableShares;
        uint256 claimableAssets;
    }

    /// @dev One snapshot of everything `redeemNow` reads before paying.
    struct State {
        HyperVaultTypes.Phase phase;
        uint256 supply;
        bool navOk;
        uint256 nav;
        bool realized;
        uint256 windowLow;
        bool oracleOnly;
        Block gate; // None, NeedsRecord or NavUnavailable (gate unreadable)
        uint256 price;
        uint256 feeShares;
        uint256 feeAssets;
        uint256 exitFeeBps;
        bool cashOk;
        uint256 cash;
    }

    /// @notice Everything an account card needs, read in one call. Never reverts on a Vault
    ///         read that fails: the dependent fields are zero and `navOk` says whether NAV was read.
    function account(address vault, address user) external view returns (Account memory a) {
        HyperVault v = HyperVault(payable(vault));
        State memory st = _state(v);
        a.phase = st.phase;
        (a.navOk, a.nav, a.realized, a.totalSupply) = (st.navOk, st.nav, st.realized, st.supply);
        (a.price, a.feeShares, a.feeAssets) = (st.price, st.feeShares, st.feeAssets);
        (a.windowLow, a.oracleOnly, a.availableCash) = (st.windowLow, st.oracleOnly, st.cash);
        try v.maxDeposit(user) returns (uint256 room) {
            a.maxDeposit = room;
        } catch {}
        a.minimumDeposit = v.minimumDeposit();
        a.maximumAssets = v.maximumAssets();
        a.shares = IERC20(v.share()).balanceOf(user);
        a.value = Math.mulDiv(a.shares, a.price, PRICE_SCALE);
        (a.redeemNowShares, a.redeemNowAssets, a.redeemNowBlock) = _max(st, a.shares);
        a.requestId = v.controllerRequest(user);
        a.pendingShares = v.pendingRedeemRequest(a.requestId, user);
        a.claimableShares = v.claimableRedeemRequest(a.requestId, user);
        a.claimableAssets = v.maxWithdraw(user);
    }

    /// @notice What `redeemNow(shares, …)` would pay now, or why it would revert. Same state,
    ///         same arithmetic: the fee is quoted as the call would crystallize it first.
    function previewRedeemNow(address vault, uint256 shares) external view returns (uint256 assets, Block reason) {
        return _preview(_state(HyperVault(payable(vault))), shares);
    }

    /// @notice The most of `holder`'s shares `redeemNow` would take now (free cash, last holder),
    ///         what they pay, and the refusal reason when it is zero.
    function maxRedeemNow(address vault, address holder)
        external
        view
        returns (uint256 shares, uint256 assets, Block reason)
    {
        HyperVault v = HyperVault(payable(vault));
        return _max(_state(v), IERC20(v.share()).balanceOf(holder));
    }

    function _state(HyperVault v) private view returns (State memory st) {
        st.phase = v.phase();
        st.supply = v.totalSupply();
        st.exitFeeBps = v.INSTANT_EXIT_FEE_BPS();
        HyperVaultAccountant acc = v.accountant();
        st.windowLow = type(uint256).max;
        bool lowOk;
        try acc.windowLow(address(v)) returns (uint256 low) {
            (st.windowLow, lowOk) = (low, true);
        } catch {}
        try v.availableCash() returns (uint256 cash) {
            (st.cash, st.cashOk) = (cash, true);
        } catch {}
        try v.liveNav() returns (uint256 nav, bool realized) {
            (st.nav, st.realized) = (nav, realized);
        } catch {
            return st;
        }
        try acc.quote(address(v), st.nav, st.realized) returns (uint256 feeShares, uint256 feeAssets, uint256 price) {
            (st.feeShares, st.feeAssets, st.price) = (feeShares, feeAssets, price);
        } catch {
            return st; // the Vault's crystallization would revert as well
        }
        st.navOk = true;
        if (!st.realized && (!lowOk || st.windowLow == type(uint256).max)) {
            // The Vault asks the verifier only here; a failed read there reverts the exit too.
            try IHyperVaultOracleGate(address(v.verifier())).oracleOnly(address(v)) returns (bool on) {
                st.oracleOnly = on;
                if (!on) st.gate = Block.NeedsRecord;
            } catch {
                st.gate = Block.NavUnavailable;
            }
            if (!lowOk) st.gate = Block.NavUnavailable; // the Vault's own windowLow read would revert
        } else {
            try IHyperVaultOracleGate(address(v.verifier())).oracleOnly(address(v)) returns (bool on) {
                st.oracleOnly = on;
            } catch {}
        }
    }

    /// @dev The checks `redeemNow` makes before it pays, in its order, on one snapshot.
    function _refusal(State memory st, uint256 shares) private pure returns (Block) {
        if (st.phase != HyperVaultTypes.Phase.Active && st.phase != HyperVaultTypes.Phase.Ready) {
            return Block.WrongPhase;
        }
        if (shares == 0 || shares >= st.supply) return Block.InvalidAmount;
        if (!st.navOk) return Block.NavUnavailable;
        return st.gate;
    }

    function _assets(State memory st, uint256 shares) private pure returns (uint256) {
        return Math.mulDiv(shares, st.price, PRICE_SCALE) * (10_000 - st.exitFeeBps) / 10_000;
    }

    function _preview(State memory st, uint256 shares) private pure returns (uint256 assets, Block) {
        Block why = _refusal(st, shares);
        if (why != Block.None) return (0, why);
        assets = _assets(st, shares);
        if (assets == 0) return (0, Block.ZeroAssets);
        if (!st.cashOk) return (assets, Block.CashDeficit);
        if (assets > st.cash) return (assets, Block.OverFreeCash);
        return (assets, Block.None);
    }

    /// @dev Largest s ≤ min(balance, supply − 1) whose payout fits the free cash. The payout
    ///      floor(floor(s·p/1e30)·(1e4−f)/1e4) is monotonic in s and differs from s·p·(1e4−f)/1e34
    ///      by less than 2, so the answer lies in [s0, s0 + 2·1e34/(p·(1e4−f)) + 1] with
    ///      s0 = floor(cash·1e34/(p·(1e4−f))): a bounded search in memory, no further reads.
    function _max(State memory st, uint256 balance) private pure returns (uint256 shares, uint256 assets, Block) {
        uint256 cap = st.supply == 0 ? 0 : Math.min(balance, st.supply - 1);
        Block why = _refusal(st, cap);
        if (why != Block.None) return (0, 0, why);
        (assets, why) = _preview(st, cap);
        if (why == Block.None) return (cap, assets, why);
        if (why != Block.OverFreeCash) return (0, 0, why);
        uint256 unit = st.price * (10_000 - st.exitFeeBps); // payout per share at 1e34 scale
        uint256 lo = Math.mulDiv(st.cash, PRICE_SCALE * 10_000, unit);
        uint256 hi = Math.min(cap, lo + Math.mulDiv(2, PRICE_SCALE * 10_000, unit) + 1);
        lo = Math.min(lo, hi);
        // lo fits (its payout is at most cash) unless it is zero; find the last share count that fits.
        while (lo < hi) {
            uint256 mid = lo + (hi - lo + 1) / 2;
            if (_assets(st, mid) <= st.cash) lo = mid;
            else hi = mid - 1;
        }
        if (lo == 0) return (0, 0, Block.OverFreeCash);
        (assets, why) = _preview(st, lo);
        return why == Block.None ? (lo, assets, why) : (0, 0, why);
    }
}
