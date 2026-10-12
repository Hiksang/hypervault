// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ManagedUsdcVault, IManagedCoreDepositWallet} from "../src/ManagedUsdcVault.sol";
import {ManagedUsdcVaultFactory, ManagedVaultDeployer} from "../src/ManagedUsdcVaultFactory.sol";
import {ManagedRedeem} from "../src/managed/ManagedRedeem.sol";
import {CoreActions} from "../src/CoreActions.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {IManagedVaultVerifier} from "../src/interfaces/IManagedVaultVerifier.sol";
import {MockManagedVerifier} from "./helpers/MockManagedVerifier.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {ManagedUpgradeController} from "../src/managed/ManagedUpgradeController.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

interface VmManaged {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function mockCall(address, bytes calldata, bytes calldata) external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function getCode(string calldata) external view returns (bytes memory);
    function computeCreateAddress(address, uint256) external pure returns (address);
    function warp(uint256) external;
    function load(address, bytes32) external view returns (bytes32);
}

contract ManagedUsdcVaultV2Fixture is ManagedUsdcVault {
    uint256 public migrationMarker;
    constructor(Config memory c) ManagedUsdcVault(c) {}

    function version() external pure returns (uint256) {
        return 2;
    }

    function initializeV2(uint256 value) external {
        require(msg.sender == ERC1967Utils.getAdmin() && migrationMarker == 0 && value != 0);
        migrationMarker = value;
    }
}

contract ManagedTestUsdc is ERC20 {
    address public blockedReceiver;
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setBlockedReceiver(address to) external {
        blockedReceiver = to;
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(to != blockedReceiver || to == address(0), "blocked receiver");
        super._update(from, to, amount);
    }
}

contract ManagedTestDepositWallet is IManagedCoreDepositWallet {
    ManagedTestUsdc public immutable token;
    address public lastCaller;
    uint256 public lastAmount;
    uint32 public lastDex;
    bool public skipPull;

    constructor(ManagedTestUsdc token_) {
        token = token_;
    }

    function setSkipPull(bool value) external {
        skipPull = value;
    }

    function deposit(uint256 amount, uint32 dex) external {
        lastCaller = msg.sender;
        lastAmount = amount;
        lastDex = dex;
        if (!skipPull) require(token.transferFrom(msg.sender, address(this), amount));
    }
}

contract ManagedUsdcVaultTest {
    VmManaged private constant VM = VmManaged(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    address private constant AGENT = address(0xA6E17);
    address private constant TREASURY = address(0xFEE);
    address private constant BUILDER = address(0xB017DE);
    uint32 private constant SPOT = type(uint32).max;
    ManagedTestUsdc private token;
    ManagedTestDepositWallet private circle;
    MockCoreWriter private writer;
    MockManagedVerifier private verifier;
    ManagedUsdcVaultFactory private factory;
    ManagedUsdcVault private vault;
    uint64 private coreBlock;

    function setUp() public {
        token = new ManagedTestUsdc();
        circle = new ManagedTestDepositWallet(token);
        writer = new MockCoreWriter();
        verifier = new MockManagedVerifier();
        VM.mockCall(address(0x0810), bytes(""), abi.encode(false));
        VM.mockCall(address(0x0801), bytes(""), abi.encode(uint64(0), uint64(0), uint64(0)));
        _block(100);
        ManagedUsdcVault.Config memory c;
        c.asset = address(token);
        c.coreDepositWallet = address(circle);
        c.coreWriter = address(writer);
        c.verifier = address(verifier);
        c.treasury = TREASURY;
        c.builder = BUILDER;
        c.builderFeeCap = 10;
        c.activationCost = 1e6;
        c.performanceFeeBps = 1000;
        c.minimumDeposit = 10e6;
        c.maximumAssets = 1_000_000e6;
        c.chainId = block.chainid;
        bytes memory creation =
            bytes.concat(VM.getCode("ManagedUsdcVaultFactory.sol:ManagedUsdcVaultFactory"), abi.encode(c));
        address f;
        assembly ("memory-safe") { f := create(0, add(creation, 32), mload(creation)) }
        require(f != address(0), "factory deployment");
        factory = ManagedUsdcVaultFactory(f);
        token.mint(address(this), 100_000e6);
        token.approve(address(factory), type(uint256).max);
        vault = factory.createVaultAndFund(1e6);
        token.mint(ALICE, 100_000e6);
        token.mint(BOB, 100_000e6);
    }

    function _block(uint64 value) private {
        coreBlock = value;
        VM.mockCall(address(0x0809), bytes(""), abi.encode(value));
    }

    function _activate() private {
        VM.mockCall(address(0x0810), abi.encode(address(vault)), abi.encode(true));
        VM.mockCall(
            address(0x0801), abi.encode(address(vault), uint64(0)), abi.encode(uint64(100e8), uint64(0), uint64(0))
        );
        _confirm(true, 100e6);
    }

    function _confirm(bool success, uint256 assets) private {
        (uint256 id, bytes32 hash,,,,) = vault.pendingAction();
        _block(coreBlock + 1);
        verifier.setReceipt(address(vault), id, hash, IManagedVaultVerifier.Receipt(coreBlock, success, assets));
        vault.syncCoreAction(id, "");
    }

    function _recall(uint256 amount) private {
        vault.recallUsdcFromCore(SPOT, amount);
        token.mint(address(vault), amount); // synthetic Core return; not network evidence
        _confirm(true, amount);
    }

    function _settle() private {
        uint256 epoch = vault.activeEpochId();
        verifier.setIdle(address(vault), epoch, vault.actionNonce(), coreBlock);
        vault.settleEpoch(epoch, "");
    }

    function _idle() private {
        _activate();
        _recall(100e6);
        vault.beginExit(vault.activeEpochId());
        _settle();
    }

    function _deposit(address user, uint256 amount) private {
        VM.startPrank(user);
        token.approve(address(vault), amount);
        vault.deposit(amount, user);
        VM.stopPrank();
    }

    function _request(address user, uint256 shares) private returns (uint256 id) {
        VM.prank(user);
        return vault.requestRedeem(shares, user, user);
    }

    function _deployCash(uint256 amount) private {
        vault.depositToCore(amount);
        _confirm(true, amount);
    }

    function _assertPayload(bytes memory expected) private view {
        (address account, bytes memory data,) = writer.latestAction();
        require(account == address(vault), "wrong Core account");
        require(keccak256(data) == keccak256(expected), "wrong action encoding");
    }

    function _removeFounder() private {
        vault.requestRedeem(vault.balanceOf(address(this)), address(this), address(this));
        vault.redeem(vault.maxRedeem(address(this)), address(this), address(this));
    }

    function testFactoryFounderSharesAndCostAreAtomic() public view {
        require(vault.owner() == address(this) && vault.deploymentFactory() == address(factory));
        require(vault.balanceOf(address(this)) == 100e9 && vault.basisUsdc(address(this)) == 100e6);
        require(vault.decimals() == 9 && factory.isVault(address(vault)) && factory.vaultCount() == 1);
        require(circle.lastCaller() == address(vault) && circle.lastAmount() == 101e6 && circle.lastDex() == SPOT);
        require(token.balanceOf(address(factory)) == 0 && token.balanceOf(address(vault)) == 0);
        require(
            token.allowance(address(vault), address(circle)) == 0
                && token.allowance(address(factory), address(vault)) == 0
        );
        require(vault.maxDeposit(ALICE) == 0 && !vault.coreActivated());
    }

    function testRejectedCircleCallRollsBackFactoryMintAndFunds() public {
        circle.setSkipPull(true);
        uint256 beforeBalance = token.balanceOf(address(this));
        VM.expectRevert(ManagedRedeem.BalanceMismatch.selector);
        factory.createVaultAndFund(1e6);
        require(factory.vaultCount() == 1 && token.balanceOf(address(this)) == beforeBalance);
    }

    function testActivationBudgetAndBootstrapCannotBeReused() public {
        VM.expectRevert(ManagedUsdcVaultFactory.ActivationBudgetExceeded.selector);
        factory.createVaultAndFund(999_999);
        VM.expectRevert(ManagedRedeem.Unauthorized.selector);
        vault.bootstrap();
        VM.prank(address(factory));
        VM.expectRevert(ManagedUsdcVault.WrongPhase.selector);
        vault.bootstrap();
    }

    /// @dev The frontend lists Vaults from `vaultCount` and this rule, then checks `isVault`:
    ///      after the deployer's two code chunks, each Vault takes three nonces and its proxy is
    ///      the last of them. The first is its upgrade controller and the second its first
    ///      implementation: the frontend asks that controller whether the Vault still runs that
    ///      code, rather than believing what the Vault says of itself.
    function testVaultAddressesCanBeEnumeratedFromTheDeployerNonce() public {
        address deployer = address(factory.deployer());
        require(factory.vaultCount() == 1 && address(vault) == VM.computeCreateAddress(deployer, 5));
        _madeAt(deployer, 1, vault);
        for (uint256 index = 2; index <= 4; ++index) {
            ManagedUsdcVault created = factory.createVaultAndFund(1e6);
            require(address(created) == VM.computeCreateAddress(deployer, 3 * index + 2), "nonce rule");
            require(factory.isVault(address(created)) && factory.vaultCount() == index);
            _madeAt(deployer, index, created);
        }
        require(!factory.isVault(VM.computeCreateAddress(deployer, 3 * 5 + 2)));
    }

    function _madeAt(address deployer, uint256 index, ManagedUsdcVault made) private view {
        ManagedUpgradeController controller = ManagedUpgradeController(VM.computeCreateAddress(deployer, 3 * index));
        address first = VM.computeCreateAddress(deployer, 3 * index + 1);
        require(made.upgradeController() == controller && controller.vault() == address(made), "controller nonce");
        require(controller.implementation() == first, "implementation nonce");
        require(
            address(uint160(uint256(VM.load(address(made), ERC1967Utils.IMPLEMENTATION_SLOT)))) == first,
            "the proxy runs it"
        );
    }

    function testPredictedCoreAccountAlreadyExistsRejectsCreation() public {
        address predicted = VM.computeCreateAddress(address(factory.deployer()), 8);
        VM.mockCall(address(0x0810), abi.encode(predicted), abi.encode(true));
        VM.expectRevert(ManagedUsdcVault.CoreNotReady.selector);
        factory.createVaultAndFund(1e6);
    }

    function testActivationRequiresEvidenceAndLaterCoreBlockWithoutRemint() public {
        VM.expectRevert(MockManagedVerifier.MissingEvidence.selector);
        vault.finalizeActivation("");
        (uint256 id, bytes32 digest,,,,) = vault.pendingAction();
        verifier.setReceipt(address(vault), id, digest, IManagedVaultVerifier.Receipt(coreBlock, true, 100e6));
        VM.expectRevert(ManagedUsdcVault.EvidenceRejected.selector);
        vault.finalizeActivation("");
        _activate();
        require(vault.totalSupply() == 100e9 && vault.coreActivated());
        VM.expectRevert(ManagedUsdcVault.WrongPhase.selector);
        vault.finalizeActivation("");
    }

    function testMissingOrShortCoreCreditDoesNotActivate() public {
        (uint256 id, bytes32 digest,,,,) = vault.pendingAction();
        _block(coreBlock + 1);
        verifier.setReceipt(address(vault), id, digest, IManagedVaultVerifier.Receipt(coreBlock, true, 99e6));
        VM.expectRevert(ManagedUsdcVault.EvidenceRejected.selector);
        vault.finalizeActivation("");
        require(!vault.coreActivated() && vault.balanceOf(address(this)) == 100e9);
    }

    function testCoreReadRevertIsNotZero() public {
        VM.mockCallRevert(address(0x0809), bytes(""), "read failed");
        VM.expectRevert(abi.encodeWithSelector(CoreRead.ReadFailed.selector, address(0x0809)));
        factory.createVaultAndFund(1e6);
    }

    function testAllOwnerFunctionsRejectInvestorAndApiKey() public {
        bytes[] memory calls = new bytes[](9);
        calls[0] = abi.encodeCall(vault.setApiWallet, (AGENT));
        calls[1] = abi.encodeCall(vault.revokeApiWallet, ());
        calls[2] = abi.encodeCall(vault.depositToCore, (1e6));
        calls[3] = abi.encodeCall(vault.recallUsdcFromCore, (SPOT, 1e6));
        calls[4] = abi.encodeCall(vault.supplyToLending, (0, 1e8));
        calls[5] = abi.encodeCall(vault.withdrawFromLending, (0, 1e8));
        calls[6] = abi.encodeCall(vault.setAbstraction, (CoreActions.Abstraction.Unified));
        calls[7] = abi.encodeCall(vault.approveBuilderFee, (1));
        calls[8] = abi.encodeCall(vault.transferWithinCore, (0, SPOT, 0, 1e8));
        for (uint256 i; i < calls.length; ++i) {
            VM.prank(i % 2 == 0 ? ALICE : AGENT);
            (bool ok, bytes memory reason) = address(vault).call(calls[i]);
            require(!ok && bytes4(reason) == ManagedRedeem.Unauthorized.selector);
        }
    }

    function testVaultOwnsAgentRegistrationAndRevokesBySlotReplacement() public {
        _activate();
        vault.setApiWallet(AGENT);
        _assertPayload(abi.encodePacked(bytes4(0x01000009), abi.encode(AGENT, "")));
        require(vault.apiWallet() == address(0));
        VM.expectRevert(ManagedUsdcVault.PendingCoreAction.selector);
        vault.setAbstraction(CoreActions.Abstraction.Unified);
        _confirm(true, 0);
        require(vault.apiWallet() == AGENT);
        vault.revokeApiWallet();
        _assertPayload(abi.encodePacked(bytes4(0x01000009), abi.encode(vault.disabledAgent(), "")));
        require(vault.apiWallet() == AGENT);
        _confirm(true, 0);
        require(vault.apiWallet() == address(0));
        VM.expectRevert(ManagedUsdcVault.AgentAlreadyUsed.selector);
        vault.setApiWallet(AGENT);
    }

    function testTwoVaultsHaveSeparateOwnersAndEvidence() public {
        VM.startPrank(BOB);
        token.approve(address(factory), 101e6);
        ManagedUsdcVault other = factory.createVaultAndFund(1e6);
        VM.stopPrank();
        require(other.owner() == BOB && vault.owner() == address(this));
        _activate();
        VM.expectRevert(MockManagedVerifier.MissingEvidence.selector);
        other.finalizeActivation("");
        VM.expectRevert(ManagedRedeem.Unauthorized.selector);
        other.setApiWallet(AGENT);
    }

    function testTypedCoreControlsAndRecallReceiverAreFixed() public {
        _activate();
        vault.setAbstraction(CoreActions.Abstraction.PortfolioMargin);
        _assertPayload(abi.encodePacked(bytes4(0x01000010), abi.encode(address(vault), uint8(3))));
        _confirm(true, 0);
        vault.supplyToLending(0, 2e8);
        _assertPayload(abi.encodePacked(bytes4(0x0100000f), abi.encode(uint8(0), uint64(0), uint64(2e8))));
        _confirm(true, 0);
        vault.withdrawAllFromLending(0);
        _assertPayload(abi.encodePacked(bytes4(0x0100000f), abi.encode(uint8(1), uint64(0), uint64(0))));
        _confirm(true, 0);
        vault.recallUsdcFromCore(SPOT, 2e6);
        _assertPayload(
            abi.encodePacked(
                bytes4(0x0100000d),
                abi.encode(
                    address(0x2000000000000000000000000000000000000000), address(0), SPOT, SPOT, uint64(0), uint64(2e8)
                )
            )
        );
    }

    function testZeroLendingAndBuilderFeeCap() public {
        _activate();
        VM.expectRevert(CoreActions.ZeroAmount.selector);
        vault.supplyToLending(0, 0);
        VM.expectRevert(CoreActions.ZeroAmount.selector);
        vault.withdrawFromLending(0, 0);
        VM.expectRevert(ManagedRedeem.InvalidAmount.selector);
        vault.approveBuilderFee(11);
        vault.approveBuilderFee(10);
        _assertPayload(abi.encodePacked(bytes4(0x0100000c), abi.encode(uint64(10), BUILDER)));
    }

    function testRejectedControlReceiptCanClearPendingButReplayCannot() public {
        _activate();
        uint256 id = vault.setApiWallet(AGENT);
        _confirm(false, 0);
        require(vault.apiWallet() == address(0));
        VM.expectRevert(ManagedUsdcVault.EvidenceRejected.selector);
        vault.syncCoreAction(id, "");
    }

    function testDirectDonationDoesNotMintChangePriceOrFundCore() public {
        _idle();
        token.mint(address(vault), 500e6);
        require(vault.unaccountedUsdc() == 500e6 && vault.totalAssets() == 100e6);
        _deposit(ALICE, 100e6);
        require(vault.balanceOf(ALICE) == 100e9 && vault.basisUsdc(ALICE) == 100e6);
        VM.expectRevert(ManagedRedeem.InvalidAmount.selector);
        vault.depositToCore(201e6);
        _deployCash(200e6);
        require(token.balanceOf(address(vault)) == 500e6);
    }

    function testActiveNavAndDepositsAreUnavailableWithoutSource() public {
        _activate();
        VM.expectRevert(MockManagedVerifier.MissingEvidence.selector);
        vault.totalAssets();
        VM.prank(ALICE);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.deposit(1e6, ALICE);
    }

    function _nav(int256 net) private {
        verifier.setNav(address(vault), net, coreBlock, vault.actionNonce(), vault.configHash());
    }

    function testReadyAndActiveDepositAtPreDepositNav() public {
        _activate();
        _nav(120e6);
        uint256 expected = uint256(12e6) * (100e9 + 1000) / (120e6 + 1);
        _deposit(ALICE, 12e6);
        require(vault.balanceOf(ALICE) == expected && vault.totalAssets() == 132e6);
        require(vault.basisUsdc(ALICE) == 12e6);
        vault.setApiWallet(AGENT);
        require(vault.maxDeposit(ALICE) == 0, "pending closes deposits");
        _confirm(true, 0);
        _nav(80e6);
        uint256 supply = vault.totalSupply();
        uint256 bobShares = uint256(20e6) * (supply + 1000) / (92e6 + 1);
        _deposit(BOB, 20e6);
        require(vault.balanceOf(BOB) == bobShares && vault.totalAssets() == 112e6);
        require(vault.phase() == ManagedUsdcVault.Phase.Active && vault.apiWallet() == AGENT);
    }

    function testActiveNavDonationDebtStaleAndReplayGuards() public {
        _idle();
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _nav(-20e6);
        require(vault.totalAssets() == 80e6);
        token.mint(address(vault), 500e6);
        require(vault.totalAssets() == 80e6 && vault.unaccountedUsdc() == 500e6);
        _nav(-100e6);
        require(vault.maxDeposit(BOB) == 0, "zero NAV");
        _nav(-101e6);
        require(vault.maxDeposit(BOB) == 0, "negative NAV");
        _nav(100e6);
        _block(coreBlock + 1);
        require(vault.maxDeposit(BOB) == 0, "old Core block");
        verifier.setNav(address(vault), 100e6, coreBlock, vault.actionNonce() - 1, vault.configHash());
        require(vault.maxDeposit(BOB) == 0, "old action");
        _nav(100e6);
        vault.beginExit(vault.activeEpochId());
        require(vault.maxDeposit(BOB) == 0, "exit");
    }

    function testActiveDepositSlippageRollbackAndSuccessivePrices() public {
        _activate();
        _nav(150e6);
        VM.startPrank(ALICE);
        token.approve(address(vault), 100e6);
        uint256 beforeBalance = token.balanceOf(ALICE);
        VM.expectRevert(ManagedUsdcVault.SlippageOrDeadline.selector);
        vault.depositWithLimit(15e6, ALICE, 15e9, block.timestamp);
        require(token.balanceOf(ALICE) == beforeBalance && vault.accountedCash() == 0);
        uint256 shares = vault.depositWithLimit(15e6, ALICE, 0, block.timestamp);
        require(vault.totalAssets() == 165e6);
        uint256 next = vault.previewDeposit(15e6);
        vault.depositWithLimit(15e6, ALICE, next, block.timestamp);
        require(vault.balanceOf(ALICE) == shares + next && vault.totalAssets() == 180e6);
        VM.stopPrank();
    }

    function testShareTransfersAndControllerMergingCannotLaunderBasis() public {
        _idle();
        _deposit(ALICE, 100e6);
        VM.startPrank(ALICE);
        VM.expectRevert(ManagedRedeem.NonTransferableShares.selector);
        vault.transfer(BOB, 1e9);
        require(vault.transfer(BOB, 0));
        VM.expectRevert(ManagedRedeem.InvalidReceiver.selector);
        vault.requestRedeem(1e9, BOB, ALICE);
        VM.stopPrank();
    }

    function testOperatorCanRequestButCannotManageVault() public {
        _idle();
        _deposit(ALICE, 100e6);
        VM.prank(ALICE);
        vault.setOperator(BOB, true);
        VM.prank(BOB);
        vault.requestRedeem(100e9, ALICE, ALICE);
        uint256 claim = vault.maxRedeem(ALICE);
        VM.prank(BOB);
        vault.redeem(claim, ALICE, ALICE);
        VM.prank(BOB);
        VM.expectRevert(ManagedRedeem.Unauthorized.selector);
        vault.depositToCore(1e6);
    }

    function testProfitFeesUniqueIdsAndFounderExemption() public {
        _idle();
        _deposit(ALICE, 100e6);
        _deployCash(200e6);
        uint256 aliceId = _request(ALICE, 100e9);
        uint256 founderId = _request(address(this), 100e9);
        require(aliceId != founderId);
        vault.beginExit(vault.activeEpochId());
        _recall(240e6);
        _settle();
        require(vault.maxWithdraw(ALICE) == 118e6 && vault.maxWithdraw(address(this)) == 120e6);
        require(vault.reservedClaimAssets() == 240e6);
        uint256 beforeOwner = token.balanceOf(address(this));
        VM.prank(ALICE);
        vault.redeem(100e9, ALICE, ALICE);
        require(token.balanceOf(address(this)) - beforeOwner == 1_600_000);
        require(token.balanceOf(TREASURY) == 400_000 && vault.reservedClaimAssets() == 120e6);
        vault.redeem(100e9, address(this), address(this));
        require(vault.reservedClaimAssets() == 0 && vault.accountedCash() == 0);
    }

    function testClaimReservesCannotBeReinvested() public {
        _idle();
        _deposit(ALICE, 100e6);
        _request(ALICE, 100e9);
        require(vault.reservedClaimAssets() == 100e6);
        VM.expectRevert(ManagedRedeem.InvalidAmount.selector);
        vault.depositToCore(100e6 + 1);
        _deployCash(100e6);
        VM.prank(ALICE);
        vault.redeem(100e9, ALICE, ALICE);
        require(vault.reservedClaimAssets() == 0);
    }

    function testReturnBalanceAloneCannotSettleAndInsufficientCashRejectsProof() public {
        _activate();
        vault.beginExit(vault.activeEpochId());
        token.mint(address(vault), 100e6);
        uint256 epoch = vault.activeEpochId();
        VM.expectRevert(MockManagedVerifier.MissingEvidence.selector);
        vault.settleEpoch(epoch, "");
        require(vault.accountedCash() == 0);
        vault.recallUsdcFromCore(SPOT, 101e6);
        (uint256 id, bytes32 digest,,,,) = vault.pendingAction();
        _block(coreBlock + 1);
        verifier.setReceipt(address(vault), id, digest, IManagedVaultVerifier.Receipt(coreBlock, true, 101e6));
        VM.expectRevert(ManagedRedeem.CashDeficit.selector);
        vault.syncCoreAction(id, "");
    }

    function testSettlementRequiresAgentRemoval() public {
        _activate();
        vault.setApiWallet(AGENT);
        _confirm(true, 0);
        vault.beginExit(vault.activeEpochId());
        uint256 epoch = vault.activeEpochId();
        verifier.setIdle(address(vault), epoch, vault.actionNonce(), coreBlock);
        VM.expectRevert(ManagedUsdcVault.PendingCoreAction.selector);
        vault.settleEpoch(epoch, "");
    }

    function testLossCarryPersistsAcrossFullExitAndRedeposit() public {
        _idle();
        _removeFounder();
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _recall(80e6);
        _settle();
        VM.prank(ALICE);
        vault.redeem(100e9, ALICE, ALICE);
        require(vault.lossCarry(ALICE) == 20e6);
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _recall(130e6);
        _settle();
        require(vault.maxWithdraw(ALICE) == 129e6);
        VM.prank(ALICE);
        vault.redeem(100e9, ALICE, ALICE);
        require(vault.lossCarry(ALICE) == 0 && token.balanceOf(TREASURY) == 200_000);
    }

    function testPayoutFailureRevertsUserAndFeePaymentsTogether() public {
        _idle();
        _removeFounder();
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _recall(120e6);
        _settle();
        uint256 beforeAlice = token.balanceOf(ALICE);
        token.setBlockedReceiver(TREASURY);
        VM.prank(ALICE);
        VM.expectRevert();
        vault.redeem(100e9, ALICE, ALICE);
        require(token.balanceOf(ALICE) == beforeAlice && vault.reservedClaimAssets() == 120e6);
        require(vault.maxWithdraw(ALICE) == 118e6 && vault.maxRedeem(ALICE) == 100e9);
    }

    function testFullLossCanConsumeZeroAssetClaim() public {
        _idle();
        _removeFounder();
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _settle(); // synthetic terminal proof of total loss
        require(vault.maxWithdraw(ALICE) == 0);
        VM.prank(ALICE);
        require(vault.redeem(100e9, ALICE, ALICE) == 0);
        require(vault.lossCarry(ALICE) == 100e6 && vault.controllerRequest(ALICE) == 0);
    }

    function testFuzzPartialClaimConservesExactNetAndFee(uint64 firstPart) public {
        _idle();
        _removeFounder();
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _recall(123_456_789);
        _settle();
        uint256 net = vault.maxWithdraw(ALICE);
        uint256 ownerBefore = token.balanceOf(address(this));
        uint256 aliceBefore = token.balanceOf(ALICE);
        uint256 first = uint256(firstPart) % (net - 1) + 1;
        VM.prank(ALICE);
        vault.withdraw(first, ALICE, ALICE);
        uint256 claim = vault.maxRedeem(ALICE);
        VM.prank(ALICE);
        vault.redeem(claim, ALICE, ALICE);
        uint256 fee = (uint256(23_456_789) * 1000) / 10_000;
        require(token.balanceOf(ALICE) - aliceBefore == net);
        require(token.balanceOf(address(this)) - ownerBefore + token.balanceOf(TREASURY) == fee);
        require(token.balanceOf(TREASURY) == fee * 2000 / 10_000);
        require(vault.accountedCash() == 0 && vault.reservedClaimAssets() == 0);
    }

    function _v2(ManagedUsdcVault.Config memory c) private returns (address deployed) {
        bytes memory code = bytes.concat(VM.getCode("ManagedUsdcVault.t.sol:ManagedUsdcVaultV2Fixture"), abi.encode(c));
        assembly ("memory-safe") { deployed := create(0, add(code, 32), mload(code)) }
        require(deployed != address(0), "V2 fixture deployment");
    }

    function _config() private view returns (ManagedUsdcVault.Config memory c) {
        c = factory.templateConfig();
        c.owner = address(this);
        c.upgradeController = address(vault.upgradeController());
    }

    function testProxyMetadataAndImplementationCannotBootstrap() public {
        require(keccak256(bytes(vault.name())) == keccak256("Managed HyperCore USDC Share"));
        require(keccak256(bytes(vault.symbol())) == keccak256("mvUSDC"));
        ManagedUsdcVault implementation = ManagedUsdcVault(vault.upgradeController().implementation());
        VM.prank(address(factory));
        VM.expectRevert(ManagedRedeem.Unauthorized.selector);
        implementation.bootstrap();
        require(vault.nextRequestId() == 1 && vault.nextEpochId() == 2);
    }

    function testCustomFeeAndMinimumAtCreation() public {
        ManagedUsdcVault custom = factory.createVaultAndFund(1e6, 2500, 25e6);
        require(custom.performanceFeeBps() == 2500 && custom.minimumDeposit() == 25e6);
        require(custom.owner() == address(this) && custom.upgradeController().owner() == address(this));
        VM.expectRevert();
        factory.createVaultAndFund(1e6, 10_001, 10e6);
        VM.expectRevert();
        factory.createVaultAndFund(1e6, 1000, 0);
    }

    function testMinimumDepositAndMintAndTermsProtectExistingHolders() public {
        _idle();
        VM.startPrank(ALICE);
        token.approve(address(vault), 100e6);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.deposit(10e6 - 1, ALICE);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.mint(10e9 - 1000, ALICE);
        vault.deposit(10e6, ALICE);
        VM.stopPrank();
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.setDepositTerms(2000, 10e6);
        vault.setDepositTerms(1000, 20e6);
        VM.prank(ALICE);
        VM.expectRevert(ManagedUsdcVault.CapitalClosed.selector);
        vault.deposit(19e6, ALICE);
        _deposit(ALICE, 20e6);
        VM.prank(ALICE);
        VM.expectRevert(ManagedRedeem.Unauthorized.selector);
        vault.setDepositTerms(1000, 10e6);
    }

    function testFuzzCustomFeeRateAndPlatformSplit(uint16 candidate) public {
        _idle();
        _removeFounder();
        uint16 feeBps = uint16(uint256(candidate) % 10_001);
        vault.setDepositTerms(feeBps, 10e6);
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _recall(120e6);
        _settle();
        uint256 fee = uint256(20e6) * feeBps / 10_000;
        require(vault.maxWithdraw(ALICE) == 120e6 - fee);
        uint256 managerBefore = token.balanceOf(address(this));
        VM.prank(ALICE);
        vault.redeem(100e9, ALICE, ALICE);
        require(token.balanceOf(TREASURY) == fee / 5);
        require(token.balanceOf(address(this)) - managerBefore == fee - fee / 5);
    }

    function testUpgradePreservesAddressAccountingRequestsAndClaims() public {
        _idle();
        _removeFounder();
        _deposit(ALICE, 100e6);
        _deployCash(100e6);
        uint256 id = _request(ALICE, 100e9);
        vault.beginExit(vault.activeEpochId());
        _recall(120e6);
        _settle();
        VM.prank(ALICE);
        vault.setOperator(BOB, true);
        VM.prank(ALICE);
        vault.withdraw(10e6, ALICE, ALICE);
        ManagedUpgradeController controller = vault.upgradeController();
        address next = _v2(_config());
        bytes memory migration = abi.encodeCall(ManagedUsdcVaultV2Fixture.initializeV2, (42));
        vault.setVaultName(unicode"업그레이드 보존 Vault");
        controller.propose(next, migration);
        require(vault.maxDeposit(ALICE) == 0);
        VM.expectRevert(ManagedUsdcVault.UpgradePending.selector);
        vault.depositToCore(1);
        VM.expectRevert(ManagedUpgradeController.UpgradeNotReady.selector);
        controller.execute(migration);
        uint256 net = vault.maxWithdraw(ALICE);
        uint256 claimShares = vault.maxRedeem(ALICE);
        uint256 cash = vault.accountedCash();
        address disabled = vault.disabledAgent();
        bytes32[30] memory slots;
        for (uint256 i; i < slots.length; ++i) {
            slots[i] = VM.load(address(vault), bytes32(i));
        }
        VM.warp(block.timestamp + 48 hours);
        controller.execute(migration);
        for (uint256 i; i < slots.length; ++i) {
            require(slots[i] == VM.load(address(vault), bytes32(i)), "storage changed");
        }
        require(ManagedUsdcVaultV2Fixture(address(vault)).migrationMarker() == 42);
        require(keccak256(bytes(vault.name())) == keccak256(bytes(unicode"업그레이드 보존 Vault")));
        require(vault.disabledAgent() == disabled && vault.owner() == address(this));
        require(vault.accountedCash() == cash && vault.maxWithdraw(ALICE) == net && vault.isOperator(ALICE, BOB));
        require(vault.controllerRequest(ALICE) == id && !controller.pending());
        VM.prank(BOB);
        vault.redeem(claimShares, ALICE, ALICE);
        require(vault.accountedCash() == 0 && vault.reservedClaimAssets() == 0);
        _deposit(ALICE, 10e6);
        require(vault.balanceOf(ALICE) == 10e9);
    }

    function testUpgradeAuthorityDelayActiveGateAndCancellation() public {
        _activate();
        ManagedUpgradeController controller = vault.upgradeController();
        address next = _v2(_config());
        VM.prank(ALICE);
        VM.expectRevert(ManagedUpgradeController.Unauthorized.selector);
        controller.propose(next, "");
        controller.propose(next, "");
        VM.warp(block.timestamp + 48 hours);
        VM.expectRevert(ManagedUpgradeController.UpgradeNotReady.selector);
        controller.execute("");
        // Proposal still permits owner liquidation after entering Exiting.
        vault.beginExit(vault.activeEpochId());
        _recall(100e6);
        _settle();
        VM.expectRevert(ManagedUpgradeController.InvalidUpgrade.selector);
        controller.execute(hex"01");
        controller.cancel();
        require(!controller.pending() && vault.maxDeposit(ALICE) != 0);
        VM.expectRevert(ManagedUpgradeController.UpgradeNotReady.selector);
        controller.execute("");
        ProxyAdmin admin = controller.admin();
        VM.expectRevert();
        admin.upgradeAndCall(ITransparentUpgradeableProxy(address(vault)), next, "");
    }

    function testUpgradeRejectsDifferentImmutableConfig() public {
        ManagedUsdcVault.Config memory c = _config();
        c.owner = BOB;
        address incompatible = _v2(c);
        ManagedUpgradeController controller = vault.upgradeController();
        VM.expectRevert(ManagedUpgradeController.InvalidUpgrade.selector);
        controller.propose(incompatible, "");
    }

    function testNamedVaultCreationRenameAndOwnerBoundary() public {
        ManagedUsdcVault named = factory.createVaultAndFund(unicode"한강 USDC Vault", 1e6, 1000, 10e6);
        require(keccak256(bytes(named.name())) == keccak256(bytes(unicode"한강 USDC Vault")));
        require(named.balanceOf(address(this)) == 100e9);
        named.setVaultName("Han River Income");
        require(keccak256(bytes(named.name())) == keccak256("Han River Income"));
        VM.prank(ALICE);
        VM.expectRevert(ManagedRedeem.Unauthorized.selector);
        named.setVaultName("Impersonated");
    }

    function testInvalidNamesRevertEntireCreation() public {
        uint256 beforeCash = token.balanceOf(address(this));
        uint256 count = factory.vaultCount();
        string[4] memory names = ["", " leading", "trailing ", "new\nline"];
        for (uint256 i; i < names.length; ++i) {
            VM.expectRevert(ManagedUsdcVault.InvalidVaultName.selector);
            factory.createVaultAndFund(names[i], 1e6, 1000, 10e6);
        }
        VM.expectRevert(ManagedUsdcVault.InvalidVaultName.selector);
        vault.setVaultName(string(new bytes(97)));
        require(factory.vaultCount() == count && token.balanceOf(address(this)) == beforeCash);
    }
}
