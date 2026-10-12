// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AsyncVaultFixture} from "./AsyncHypeVault.t.sol";
import {AsyncHypeVault} from "../src/AsyncHypeVault.sol";
import {MockStrategyAccount} from "./helpers/MockStrategyAccount.sol";
import {MockWHYPE} from "./helpers/MockWHYPE.sol";

contract InvariantActor {
    AsyncHypeVault public immutable vault;
    MockWHYPE public immutable whype;

    constructor(AsyncHypeVault v, MockWHYPE w) {
        vault = v;
        whype = w;
    }

    function deposit(uint256 amount) external {
        whype.mint(address(this), amount);
        whype.approve(address(vault), amount);
        vault.deposit(amount, address(this));
    }

    function request(uint256 shares) external {
        vault.requestRedeem(shares, address(this), address(this));
    }

    function claim(uint256 shares) external {
        vault.redeem(shares, address(this), address(this));
    }

    function withdraw(uint256 assets) external {
        vault.withdraw(assets, address(this), address(this));
    }

    function transfer(InvariantActor to, uint256 shares) external {
        vault.transfer(address(to), shares);
    }
}

contract VaultHandler {
    AsyncHypeVault public immutable vault;
    MockStrategyAccount public immutable strategy;
    MockWHYPE public immutable whype;
    InvariantActor[2] public actors;
    uint256 public completedCycles;

    constructor(AsyncHypeVault v, MockStrategyAccount s, MockWHYPE w) {
        vault = v;
        strategy = s;
        whype = w;
        actors[0] = new InvariantActor(v, w);
        actors[1] = new InvariantActor(v, w);
    }

    function deposit(uint256 actor, uint96 raw) external {
        address who = address(actors[actor % 2]);
        uint256 limit = vault.maxDeposit(who);
        if (limit == 0) return;
        uint256 amount = uint256(raw) % (limit < 10 ether ? limit : 10 ether) + 1;
        actors[actor % 2].deposit(amount);
    }

    function request(uint256 actor, uint96 raw) external {
        InvariantActor who = actors[actor % 2];
        if (vault.phase() == AsyncHypeVault.Phase.Exiting) return;
        uint256 balance = vault.balanceOf(address(who));
        if (balance == 0 || vault.controllerEpoch(address(who)) != 0) return;
        who.request(uint256(raw) % balance + 1);
    }

    function claim(uint256 actor, uint96 raw, bool byAssets) external {
        InvariantActor who = actors[actor % 2];
        uint256 shares = vault.maxRedeem(address(who));
        if (shares == 0) return;
        uint256 assets = vault.maxWithdraw(address(who));
        if (byAssets && assets != 0) who.withdraw(assets);
        else who.claim(uint256(raw) % shares + 1);
    }

    function transfer(uint256 actor, uint96 raw) external {
        uint256 i = actor % 2;
        uint256 balance = vault.balanceOf(address(actors[i]));
        if (balance == 0) return;
        actors[i].transfer(actors[1 - i], uint256(raw) % balance + 1);
    }

    function start(uint96 raw) external {
        if (vault.phase() != AsyncHypeVault.Phase.Idle || vault.totalSupply() == 0 || vault.availableCash() == 0) {
            return;
        }
        vault.startCycle(uint256(raw) % vault.availableCash() + 1);
    }

    function finish(uint96 raw) external {
        if (vault.phase() != AsyncHypeVault.Phase.Deploying && vault.phase() != AsyncHypeVault.Phase.Active) return;
        uint256 id = vault.currentCycleId();
        vault.beginExit(id); // handler has guardian role
        uint256 capital = strategy.accountedCapital();
        strategy.complete(uint256(raw) % (capital + capital / 2 + 1));
        vault.settleEpoch(id);
        ++completedCycles;
    }

    function releaseDust() external {
        vault.releaseRoundingDust();
    }
}

contract VaultInvariantsTest is AsyncVaultFixture {
    VaultHandler private handler;

    function setUp() public override {
        super.setUp();
        handler = new VaultHandler(vault, strategy, whype);
        vault.grantRole(vault.MANAGER_ROLE(), address(handler));
        vault.grantRole(vault.GUARDIAN_ROLE(), address(handler));
    }

    // Foundry invariant discovery without a forge-std dependency.
    function targetContracts() external view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function invariantClaimReservesAndEscrowAreConserved() public view {
        uint256 reserved = vault.reservedClaimAssets();
        require(whype.balanceOf(address(vault)) >= reserved, "underfunded claims");
        uint256 pending;
        uint256 individualClaims;
        uint256 walletShares;
        for (uint256 i; i < 2; ++i) {
            address actor = address(handler.actors(i));
            uint256 epoch = vault.controllerEpoch(actor);
            pending += vault.pendingRedeemRequest(epoch, actor);
            individualClaims += vault.maxWithdraw(actor);
            walletShares += vault.balanceOf(actor);
        }
        require(individualClaims + vault.roundingReserve() <= reserved, "claims exceed reserves");
        require(vault.balanceOf(address(vault)) == pending, "escrow mismatch");
        require(vault.totalSupply() == walletShares + pending, "share conservation");
        require(vault.availableCash() + reserved == whype.balanceOf(address(vault)), "cash mismatch");
        require(vault.totalAssets() == vault.availableCash() + strategy.accountedCapital(), "capital counted twice");
    }

    function testHandlerCanCompleteMultipleCycles() public {
        handler.deposit(0, uint96(4 ether));
        handler.deposit(1, uint96(5 ether));
        handler.start(uint96(2 ether));
        handler.request(0, 1000);
        handler.finish(uint96(1 ether));
        handler.claim(0, type(uint96).max, true);
        handler.start(uint96(1 ether));
        handler.finish(uint96(1 ether));
        require(handler.completedCycles() == 2);
        invariantClaimReservesAndEscrowAreConserved();
    }
}
