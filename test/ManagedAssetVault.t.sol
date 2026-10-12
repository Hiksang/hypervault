// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ManagedUpgradeController} from "../src/managed/ManagedUpgradeController.sol";
import {ManagedAssetVault} from "../src/ManagedAssetVault.sol";
import {ManagedAssetVaultFactory} from "../src/ManagedAssetVaultFactory.sol";
import {ManagedAssetBridge} from "../src/managed/ManagedAssetBridge.sol";
import {ManagedHypeRouter} from "../src/ManagedHypeRouter.sol";
import {ManagedRedeem} from "../src/managed/ManagedRedeem.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockWHYPE} from "./helpers/MockWHYPE.sol";
import {MockHypeSystem} from "./helpers/MockHypeSystem.sol";
import {MockManagedVerifier} from "./helpers/MockManagedVerifier.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {IManagedVaultVerifier} from "../src/interfaces/IManagedVaultVerifier.sol";
import {ManagedTestUsdc, ManagedTestDepositWallet} from "./ManagedUsdcVault.t.sol";

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

interface VmAsset {
    function warp(uint256) external;
    function mockCall(address, bytes calldata, bytes calldata) external;
    function mockCallRevert(address, bytes calldata, bytes calldata) external;
    function getCode(string calldata) external view returns (bytes memory);
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function deal(address, uint256) external;
    function etch(address, bytes calldata) external;
    function prank(address) external;
}

contract TestUbtc is ERC20 {
    constructor() ERC20("Test UBTC", "UBTC") {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract ManagedAssetVaultV2Fixture is ManagedAssetVault {
    uint256 public migrationMarker;
    constructor(Config memory c) ManagedAssetVault(c) {}

    function initializeV2(uint256 marker) external {
        require(msg.sender == ERC1967Utils.getAdmin() && migrationMarker == 0);
        migrationMarker = marker;
    }
}

/// @dev Local synthetic Core effects only. These are not live bridge round-trip tests.
contract ManagedAssetVaultTest {
    VmAsset constant vm = VmAsset(address(uint160(uint256(keccak256("hevm cheat code")))));
    ManagedTestUsdc usd;
    MockWHYPE hype;
    TestUbtc btc;
    ManagedTestDepositWallet circle;
    MockManagedVerifier verifier;
    MockCoreWriter writer;
    ManagedAssetVaultFactory factory;
    ManagedAssetBridge[3] bridges;
    address constant HYPE_SYSTEM = 0x2222222222222222222222222222222222222222;
    uint64 blockNo = 100;
    receive() external payable {}

    function setUp() public {
        usd = new ManagedTestUsdc();
        hype = new MockWHYPE();
        btc = new TestUbtc();
        circle = new ManagedTestDepositWallet(usd);
        verifier = new MockManagedVerifier();
        writer = new MockCoreWriter();
        vm.mockCall(address(0x0810), bytes(""), abi.encode(true));
        vm.mockCall(address(0x0809), bytes(""), abi.encode(blockNo));
        _metadata(0, address(circle), 8, 8, -2);
        _metadata(150, address(0), 2, 8, 0);
        _metadata(197, address(btc), 5, 10, -2);
        _price(150, 107, 50e6);
        _price(197, 142, 100_000e3);
        bridges[0] =
            new ManagedAssetBridge(address(usd), address(usd), address(circle), ManagedAssetBridge.Kind.Usdc, 0, 0);
        bridges[1] = new ManagedAssetBridge(
            address(hype), address(usd), address(circle), ManagedAssetBridge.Kind.NativeHype, 150, 107
        );
        bridges[2] = new ManagedAssetBridge(
            address(btc), address(usd), address(circle), ManagedAssetBridge.Kind.LinkedToken, 197, 142
        );
        ManagedAssetVault.Config[] memory configs = new ManagedAssetVault.Config[](3);
        for (uint256 i; i < 3; ++i) {
            configs[i].asset = bridges[i].asset();
            configs[i].bridge = address(bridges[i]);
            configs[i].coreDepositWallet = address(circle);
            configs[i].coreWriter = address(writer);
            configs[i].verifier = address(verifier);
            configs[i].treasury = address(0xfee);
            configs[i].activationCost = 1e6;
            configs[i].performanceFeeBps = 1000;
            configs[i].minimumDeposit = 1;
            configs[i].maximumAssets = type(uint128).max;
            configs[i].chainId = block.chainid;
        }
        bytes memory code =
            bytes.concat(vm.getCode("ManagedAssetVaultFactory.sol:ManagedAssetVaultFactory"), abi.encode(configs));
        address f;
        assembly ("memory-safe") { f := create(0, add(code, 32), mload(code)) }
        require(f != address(0), "factory");
        factory = ManagedAssetVaultFactory(f);
        usd.mint(address(this), 10000e6);
        usd.approve(f, type(uint256).max);
        btc.mint(address(this), 100e8);
        btc.approve(f, type(uint256).max);
        vm.deal(address(this), 1000 ether);
        hype.deposit{value: 100 ether}();
        hype.approve(f, type(uint256).max);
        vm.etch(HYPE_SYSTEM, type(MockHypeSystem).runtimeCode);
    }

    function _direct(uint256 kind) private returns (ManagedAssetVault v) {
        ManagedAssetVault.Config memory c = factory.templateConfig(bridges[kind].asset());
        c.factory = address(this);
        c.owner = address(this);
        ManagedUpgradeController controller = new ManagedUpgradeController(address(this));
        c.upgradeController = address(controller);
        bytes memory code = bytes.concat(vm.getCode("ManagedAssetVault.sol:ManagedAssetVault"), abi.encode(c));
        address implementation;
        assembly ("memory-safe") { implementation := create(0, add(code, 32), mload(code)) }
        require(implementation != address(0));
        v = ManagedAssetVault(
            payable(address(new TransparentUpgradeableProxy(implementation, address(controller), "")))
        );
        controller.bind(address(v), implementation);
        require(v.deploymentFactory() == address(this) && controller.vault() == address(v));
        require(v.maxDeposit(address(this)) == 0, "uninitialized closed");
    }

    function testDirectOwnerBootstrapAllAssetsWithoutFactoryFunding() public {
        for (uint256 i; i < 3; ++i) {
            ManagedAssetVault v = _direct(i);
            vm.prank(address(0xbad));
            vm.expectRevert();
            v.bootstrap("Hijacked", 1);
            uint256 seed = bridges[i].minimumFounderAssets();
            IERC20(bridges[i].asset()).approve(address(v), seed);
            v.bootstrap("Direct Vault", seed);
            require(v.balanceOf(address(this)) == seed * 1000 && v.availableCash() == seed);
            require(!factory.isVault(address(v)), "no factory registration");
            vm.expectRevert();
            v.bootstrap("Twice", seed);
        }
    }

    function testDirectActivationFailureRollsBackSeedAndCanRetry() public {
        ManagedAssetVault v = _direct(2);
        vm.mockCall(address(0x0810), bytes(""), abi.encode(false));
        uint256 seed = bridges[2].minimumFounderAssets();
        btc.approve(address(v), seed);
        // No separate activation USDC approval: entire bootstrap, including mint, reverts.
        vm.expectRevert();
        v.bootstrap("Direct BTC", seed);
        require(v.totalSupply() == 0 && btc.balanceOf(address(v)) == 0);
        usd.approve(address(v), 1e6);
        v.bootstrap("Direct BTC", seed);
        require(v.balanceOf(address(this)) == seed * 1000);
        require(v.phase() == ManagedAssetVault.Phase.AwaitingActivation);
    }

    function _metadata(uint32 index, address linked, uint8 sz, uint8 weiD, int8 extra) private {
        CoreRead.TokenInfo memory info;
        info.evmContract = linked;
        info.szDecimals = sz;
        info.weiDecimals = weiD;
        info.evmExtraWeiDecimals = extra;
        vm.mockCall(address(0x080c), abi.encode(index), abi.encode(info));
    }

    function _price(uint32 index, uint32 pair, uint64 raw) private {
        CoreRead.SpotInfo memory info;
        info.tokens[0] = index;
        vm.mockCall(address(0x080b), abi.encode(pair), abi.encode(info));
        vm.mockCall(address(0x0808), abi.encode(pair), abi.encode(raw));
        CoreRead.Reserve memory r;
        r.oraclePx = raw;
        vm.mockCall(address(0x0812), abi.encode(uint64(index)), abi.encode(r));
    }

    function _create(uint256 kind) private returns (ManagedAssetVault v) {
        v = factory.createVaultAndFund(
            bridges[kind].asset(), "Asset Vault", bridges[kind].minimumFounderAssets(), 1e6, 1000, 1
        );
    }

    function _confirm(ManagedAssetVault v, uint256 amount) private {
        (uint256 id, bytes32 hash,,,,) = v.pendingAction();
        vm.mockCall(address(0x0809), bytes(""), abi.encode(++blockNo));
        verifier.setReceipt(address(v), id, hash, IManagedVaultVerifier.Receipt(blockNo, true, amount));
        v.syncCoreAction(id, "");
    }

    function testThreeAssetsMintBeforeCoreAllocation() public {
        for (uint256 i; i < 3; ++i) {
            ManagedAssetVault v = _create(i);
            uint256 principal = bridges[i].minimumFounderAssets();
            require(v.totalAssets() == principal && v.balanceOf(address(this)) == principal * 1000, "immediate shares");
            require(v.managedPrincipal() == 0 && v.owner() == address(this), "cash only");
            require(factory.isVault(address(v)), "registered");
        }
        require(factory.vaultCount() == 3, "enumeration");
    }

    function testActivationUsesSeparateUsdcAndDoesNotBlockCashDeposits() public {
        vm.mockCall(address(0x0810), bytes(""), abi.encode(false));
        uint256 beforeUsd = usd.balanceOf(address(this));
        ManagedAssetVault v = _create(2);
        require(beforeUsd - usd.balanceOf(address(this)) == 1e6, "activation cost");
        require(v.totalAssets() == 100000, "btc principal");
        require(circle.lastCaller() == address(v), "core account identity");
        btc.approve(address(v), 100000);
        v.deposit(100000, address(this));
        require(v.totalAssets() == 200000, "deposit while activation pending");
        vm.mockCall(address(0x0810), bytes(""), abi.encode(true));
        _confirm(v, 0);
        require(v.coreActivated() && uint8(v.phase()) == 3, "activation finalized");
    }

    function testExistingCoreAccountSkipsActivationFee() public {
        uint256 beforeUsd = usd.balanceOf(address(this));
        _create(2);
        require(usd.balanceOf(address(this)) == beforeUsd, "no duplicate fee");
    }

    function testUbtcAllocationAndActiveDepositAtNav() public {
        ManagedAssetVault v = _create(2);
        v.queueCoreAllocation(100000);
        require(v.availableCash() == 100000 && btc.balanceOf(address(v)) == 100000, "queue keeps cash");
        v.executeCoreAllocation();
        require(btc.balanceOf(bridges[2].systemAddress()) == 100000, "linked transfer");
        require(v.queuedAllocation() == 0 && v.maxDeposit(address(this)) == 0, "in-flight gate");
        _confirm(v, 100000);
        verifier.setNav(address(v), 200000, blockNo, v.actionNonce(), v.configHash());
        btc.approve(address(v), 100000);
        uint256 shares = v.deposit(100000, address(0xbeef));
        require(shares < 100000 * 1000 && shares > 49999 * 1000, "gains dilute new units correctly");
    }

    function testHypeFactoryNativeFundingAllocationAndRecall() public {
        ManagedAssetVault v = factory.createVaultAndFund{value: 2 ether}(address(hype), "HYPE", 2 ether, 1e6, 1000, 1);
        v.queueCoreAllocation(1 ether);
        v.executeCoreAllocation();
        require(MockHypeSystem(payable(HYPE_SYSTEM)).bridgedToCore(address(v)) == 1 ether, "vault sender");
        _confirm(v, 1 ether);
        v.recallFromCore(type(uint32).max, 1 ether);
        MockHypeSystem(payable(HYPE_SYSTEM)).deliver(payable(address(v)), 1 ether);
        _confirm(v, 1 ether);
        require(hype.balanceOf(address(v)) == 2 ether && address(v).balance == 0, "wrap actual return");
    }

    function testNativeRouterDepositAndRedeem() public {
        ManagedAssetVault v = _create(1);
        ManagedHypeRouter router = new ManagedHypeRouter(v);
        uint256 shares = router.depositHype{value: 1 ether}(address(this), 1, block.timestamp);
        v.setOperator(address(router), true);
        router.requestRedeem(shares);
        uint256 beforeNative = address(this).balance;
        router.redeemHype(shares, payable(address(this)), 1 ether, block.timestamp);
        require(address(this).balance == beforeNative + 1 ether, "native claim");
    }

    function testQueuedAllocationCannotSpendClaimReserves() public {
        ManagedAssetVault v = _create(2);
        v.queueCoreAllocation(100000);
        v.requestRedeem(v.balanceOf(address(this)), address(this), address(this));
        vm.expectRevert();
        v.executeCoreAllocation();
        require(v.reservedClaimAssets() == 100000, "reserved");
    }

    function testPrecisionDustRejectedWithoutBurningAssets() public {
        ManagedAssetVault v = _create(1);
        v.queueCoreAllocation(1 ether + 1);
        vm.expectRevert(ManagedAssetBridge.InvalidAmount.selector);
        v.executeCoreAllocation();
        require(v.availableCash() == 2 ether && v.queuedAllocation() == 1 ether + 1, "atomic rollback");
    }

    function testBridgeDirectCallsAndNonOwnerQueueRejected() public {
        vm.expectRevert(ManagedAssetBridge.OnlyDelegateCall.selector);
        bridges[2].depositCore(100000);
        ManagedAssetVault v = _create(2);
        vm.prank(address(0xbad));
        vm.expectRevert(ManagedRedeem.Unauthorized.selector);
        v.queueCoreAllocation(1);
    }

    function testFounderPriceGuardAndMinimum() public {
        vm.expectRevert(ManagedAssetVaultFactory.InvalidFunding.selector);
        factory.createVaultAndFund(address(btc), "BTC", 99999, 1e6, 1000, 1);
        vm.mockCall(address(0x0808), abi.encode(uint32(142)), abi.encode(uint64(0)));
        vm.expectRevert(ManagedAssetBridge.PriceUnavailable.selector);
        bridges[2].minimumFounderAssets();
    }

    function testActivationFailureRollsBackCreationAndFounderShares() public {
        vm.mockCall(address(0x0810), bytes(""), abi.encode(false));
        circle.setSkipPull(true);
        uint256 beforeBtc = btc.balanceOf(address(this));
        uint256 beforeUsd = usd.balanceOf(address(this));
        vm.expectRevert(ManagedAssetBridge.TransferMismatch.selector);
        factory.createVaultAndFund(address(btc), "BTC", 100000, 1e6, 1000, 1);
        require(
            factory.vaultCount() == 0 && btc.balanceOf(address(this)) == beforeBtc
                && usd.balanceOf(address(this)) == beforeUsd,
            "atomic create"
        );
    }

    function testApiWalletBelongsToVaultAndUpgradeAuthorityIsRecorded() public {
        ManagedAssetVault v = _create(2);
        v.setApiWallet(address(0xa6e17));
        (address account,,) = writer.latestAction();
        require(account == address(v), "Core identity");
        _confirm(v, 0);
        require(v.apiWallet() == address(0xa6e17), "agent recorded");
        require(factory.vaultController(address(v)) == address(v.upgradeController()), "controller");
        require(factory.initialImplementation(address(v)) == v.upgradeController().implementation(), "original code");
    }

    function testUbtcProfitFeeAndPlatformSharePaidInUbtc() public {
        ManagedAssetVault v = _create(2);
        btc.approve(address(v), 100000);
        uint256 shares = v.deposit(100000, address(0xbeef));
        v.queueCoreAllocation(200000);
        v.executeCoreAllocation();
        _confirm(v, 200000);
        vm.prank(address(0xbeef));
        v.requestRedeem(shares, address(0xbeef), address(0xbeef));
        v.beginExit(v.activeEpochId());
        v.recallFromCore(type(uint32).max, 400000);
        btc.mint(address(v), 400000);
        _confirm(v, 400000);
        verifier.setIdle(address(v), v.activeEpochId(), v.actionNonce(), blockNo);
        v.settleEpoch(v.activeEpochId(), "");
        uint256 beforeOwner = btc.balanceOf(address(this));
        vm.prank(address(0xbeef));
        v.redeem(shares, address(0xbeef), address(0xbeef));
        // Virtual-share rounding may remove one unit. Test economic bounds and exact 80/20 split.
        uint256 manager = btc.balanceOf(address(this)) - beforeOwner;
        uint256 platform = btc.balanceOf(address(0xfee));
        require(platform > 1990 && platform <= 2000 && platform == (manager + platform) / 5, "80/20 in UBTC");
        require(
            btc.balanceOf(address(0xbeef)) > 189990 && btc.balanceOf(address(0xbeef)) <= 190000,
            "net gain after 10 percent fee"
        );
    }

    function testAssetUpgradeKeepsSharesAssetAndCashAfterDelay() public {
        ManagedAssetVault v = _create(2);
        ManagedAssetVault.Config memory c = factory.templateConfig(address(btc));
        c.owner = address(this);
        c.upgradeController = address(v.upgradeController());
        bytes memory code =
            bytes.concat(vm.getCode("ManagedAssetVault.t.sol:ManagedAssetVaultV2Fixture"), abi.encode(c));
        address next;
        assembly ("memory-safe") { next := create(0, add(code, 32), mload(code)) }
        require(next != address(0), "implementation");
        bytes memory migration = abi.encodeCall(ManagedAssetVaultV2Fixture.initializeV2, (42));
        ManagedUpgradeController controller = v.upgradeController();
        controller.propose(next, migration);
        vm.expectRevert();
        controller.execute(migration);
        vm.warp(block.timestamp + 48 hours);
        v.upgradeController().execute(migration);
        require(
            v.balanceOf(address(this)) == 100000000 && v.availableCash() == 100000 && v.asset() == address(btc),
            "preserved"
        );
        require(ManagedAssetVaultV2Fixture(payable(address(v))).migrationMarker() == 42, "migration");
    }

    function testUsdcUsesCircleFromVault() public {
        ManagedAssetVault v = _create(0);
        v.queueCoreAllocation(100e6);
        v.executeCoreAllocation();
        require(circle.lastCaller() == address(v) && circle.lastAmount() == 100e6, "circle path");
    }
}
