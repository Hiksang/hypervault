// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ManagedUsdcVault} from "../src/ManagedUsdcVault.sol";
import {ManagedUsdcVaultFactory} from "../src/ManagedUsdcVaultFactory.sol";
import {ManagedPortfolioNavVerifier} from "../src/managed/ManagedPortfolioNavVerifier.sol";
import {HyperCorePrecompileSource} from "../src/nav/HyperCorePrecompileSource.sol";
import {CoreRead} from "../src/CoreRead.sol";
import {MockCoreWriter} from "./helpers/MockCoreWriter.sol";
import {MeteredReadPrecompile} from "./helpers/MeteredReadPrecompile.sol";
import {ManagedTestUsdc, ManagedTestDepositWallet} from "./ManagedUsdcVault.t.sol";

interface VmNavGas {
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function getCode(string calldata) external view returns (bytes memory);
    function warp(uint256) external;
}

/// @dev Gas behaviour of the live valuation under a precompile cost model. A local model: the
///      numbers are not network measurements.
contract ManagedNavGasTest {
    VmNavGas private constant VM = VmNavGas(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant ALICE = address(0xA11CE);
    address private constant SPOT_BALANCE = address(0x0801);
    address private constant VAULT_EQUITY = address(0x0802);
    address private constant SPOT_PX = address(0x0808);
    address private constant L1_BLOCK = address(0x0809);
    address private constant SPOT_INFO = address(0x080b);
    address private constant TOKEN_INFO = address(0x080c);
    address private constant BBO = address(0x080e);
    address private constant MARGIN = address(0x080f);
    address private constant USER_EXISTS = address(0x0810);
    address private constant LENDING = address(0x0811);
    address private constant RESERVE = address(0x0812);
    uint256 private constant SMALL_BLOCK_GAS = 3_000_000;
    uint256 private constant WINDOW = 10 minutes;
    ManagedTestUsdc private token;
    HyperCorePrecompileSource private source;
    ManagedPortfolioNavVerifier private verifier;
    ManagedUsdcVault private vault;

    function setUp() public {
        _stub(2000, 65); // the documented cost
        token = new ManagedTestUsdc();
        ManagedTestDepositWallet circle = new ManagedTestDepositWallet(token);
        source = new HyperCorePrecompileSource(address(token), address(circle), 0);
        verifier = new ManagedPortfolioNavVerifier(address(token), source, 10_000, 100_000, WINDOW, 500);
        _answer(L1_BLOCK, "", abi.encode(uint64(100)));
        MeteredReadPrecompile(USER_EXISTS).setDefaultResponse(abi.encode(false));
        MeteredReadPrecompile(SPOT_BALANCE).setDefaultResponse(abi.encode(uint64(0), uint64(0), uint64(0)));
        ManagedUsdcVault.Config memory c;
        c.asset = address(token);
        c.coreDepositWallet = address(circle);
        c.coreWriter = address(new MockCoreWriter());
        c.verifier = address(verifier);
        c.treasury = address(0xFEE);
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
        token.mint(address(this), 1_000e6);
        token.approve(f, type(uint256).max);
        vault = ManagedUsdcVaultFactory(f).createVaultAndFund(1e6);
        token.mint(ALICE, 1_000e6);
        _answer(USER_EXISTS, abi.encode(address(vault)), abi.encode(true));
        _spot(0, 100e8);
        _margin(0, 0, 0);
        _answer(L1_BLOCK, "", abi.encode(uint64(101)));
        vault.finalizeActivation("");
        _tokenInfo(0, address(circle), 8, 8, -2);
    }

    /// @dev Put a metered stand-in on every read precompile. Answers already set are kept.
    function _stub(uint256 base, uint256 perByte) private {
        bytes memory code = address(new MeteredReadPrecompile(base, perByte)).code;
        address[11] memory targets = [
            SPOT_BALANCE,
            VAULT_EQUITY,
            SPOT_PX,
            L1_BLOCK,
            SPOT_INFO,
            TOKEN_INFO,
            BBO,
            MARGIN,
            USER_EXISTS,
            LENDING,
            RESERVE
        ];
        for (uint256 i; i < targets.length; ++i) {
            VM.etch(targets[i], code);
        }
    }

    function _answer(address target, bytes memory input, bytes memory output) private {
        MeteredReadPrecompile(target).setResponse(input, output);
    }

    function _spot(uint32 tokenIndex, uint64 total) private {
        _answer(SPOT_BALANCE, abi.encode(address(vault), uint64(tokenIndex)), abi.encode(total, uint64(0), uint64(0)));
    }

    function _ledger(uint32 tokenIndex, uint64 supplied) private {
        _answer(
            LENDING,
            abi.encode(address(vault), uint64(tokenIndex)),
            abi.encode(uint64(0), uint64(0), supplied, supplied)
        );
    }

    function _margin(uint32 dex, int64 equity, uint64 notional) private {
        _answer(MARGIN, abi.encode(dex, address(vault)), abi.encode(equity, uint64(0), notional, equity));
    }

    function _tokenInfo(uint32 tokenIndex, address evm, uint8 sz, uint8 wei_, int8 extra) private {
        CoreRead.TokenInfo memory info;
        info.name = "TOKEN";
        info.evmContract = evm;
        info.szDecimals = sz;
        info.weiDecimals = wei_;
        info.evmExtraWeiDecimals = extra;
        _answer(TOKEN_INFO, abi.encode(tokenIndex), abi.encode(info));
    }

    function _pair(uint32 pair, uint32 base) private {
        _answer(SPOT_INFO, abi.encode(pair), abi.encode(CoreRead.SpotInfo("PAIR", [uint64(base), uint64(0)])));
    }

    function _usdcOnly() private pure returns (HyperCorePrecompileSource.Token[] memory) {
        return new HyperCorePrecompileSource.Token[](1);
    }

    /// @dev Largest scope, every entry on its most expensive path: all tokens held, no lending
    ///      ledger (a failing probe burns its whole allowance) and priced at the borrow oracle.
    ///      `_measure` adds a report that no longer stands.
    function _largestScope() private {
        HyperCorePrecompileSource.Token[] memory tokens = new HyperCorePrecompileSource.Token[](source.MAX_TOKENS());
        for (uint32 i = 1; i < tokens.length; ++i) {
            uint32 pair = 100 + i;
            tokens[i] = HyperCorePrecompileSource.Token(i, pair, false, true);
            _tokenInfo(i, address(0), 2, 8, 0);
            _pair(pair, i);
            _answer(SPOT_PX, abi.encode(pair), abi.encode(uint64(30e6)));
            uint64 zero;
            _answer(RESERVE, abi.encode(uint64(i)), abi.encode(zero, zero, zero, zero, uint64(30e6), zero, zero, zero));
            _spot(i, 1e8);
        }
        uint32[] memory dexes = new uint32[](source.MAX_DEXES());
        for (uint32 i; i < dexes.length; ++i) {
            dexes[i] = i;
            _margin(i, 1e6, 5e6);
        }
        address[] memory coreVaults = new address[](source.MAX_CORE_VAULTS());
        for (uint160 i; i < coreVaults.length; ++i) {
            coreVaults[i] = address(0x1000 + i);
            _answer(VAULT_EQUITY, abi.encode(address(vault), coreVaults[i]), abi.encode(uint64(1e6), uint64(0)));
        }
        source.configure(address(vault), tokens, dexes, coreVaults, true);
    }

    /// @dev The dearest report a valuation can carry: a token of the scope, named through its
    ///      quote token while its own pair bid nothing for it, that was provable when reported and
    ///      is not any more. Every valuation reads its venue again: no lending ledger, its own
    ///      pair and both pairs of the route.
    function _staleReport() private {
        _tokenInfo(51, address(0), 2, 8, 0);
        _answer(SPOT_INFO, abi.encode(uint32(150)), abi.encode(CoreRead.SpotInfo("PAIR", [uint64(5), uint64(51)])));
        _pair(151, 51);
        _answer(BBO, abi.encode(uint32(10_105)), abi.encode(uint64(0), uint64(1)));
        _answer(BBO, abi.encode(uint32(10_150)), abi.encode(uint64(25e6), uint64(26e6)));
        _answer(BBO, abi.encode(uint32(10_151)), abi.encode(uint64(1e6), uint64(1e6)));
        source.reportToken(address(vault), 5, 150, true, 151); // 25 quote tokens, worth 25 USDC
        _answer(BBO, abi.encode(uint32(10_151)), abi.encode(uint64(7e5), uint64(1e6))); // now 17.5 USDC
    }

    /// @dev Valuation twice, then a deposit and a mint through the real Vault.
    function _measure() private returns (uint256 first, uint256 repeated, uint256 depositGas, uint256 mintGas) {
        _largestScope();
        _staleReport();
        require(source.reports(address(vault)).length == 1, "the stale report is listed");
        verifier.recordPrice(address(vault));
        VM.warp(1 + WINDOW / 2);
        uint256 before = gasleft();
        (int256 net,) = source.evaluate(address(vault));
        first = before - gasleft();
        before = gasleft();
        source.evaluate(address(vault));
        repeated = before - gasleft();
        // 100 USDC, every other token worth 30, and 1 USDC in each DEX and HyperCore vault.
        uint256 expected = 100 + (source.MAX_TOKENS() - 1) * 30 + source.MAX_DEXES() + source.MAX_CORE_VAULTS();
        require(net == int256(expected * 1e18));

        VM.startPrank(ALICE);
        token.approve(address(vault), type(uint256).max);
        before = gasleft();
        uint256 shares = vault.deposit(50e6, ALICE); // two valuations
        depositGas = before - gasleft();
        before = gasleft();
        vault.mint(shares, ALICE); // four valuations: the most expensive entry
        mintGas = before - gasleft();
        VM.stopPrank();
    }

    function testMissingLedgerCostsItsProbeAllowanceAndOneControlRead() public {
        source.configure(address(vault), _usdcOnly(), new uint32[](0), new address[](0), true);
        source.evaluate(address(vault)); // warm the scope and the precompile addresses
        uint256 before = gasleft();
        (int256 net,) = source.evaluate(address(vault));
        uint256 withoutLedger = before - gasleft();
        require(net == 100e18);
        _ledger(0, 0); // an empty ledger: the probe answers
        before = gasleft();
        (net,) = source.evaluate(address(vault));
        uint256 withLedger = before - gasleft();
        require(net == 100e18);
        // The failing probe burns its 20,000 allowance, not the 50,000 of an ordinary read, and is
        // believed only after one control read of the same shape (14,480 by the documented cost).
        require(withoutLedger > withLedger + 17_000 && withoutLedger < withLedger + 23_000, "probe cost");
    }

    function testGasStarvedProbeCannotHideAnUncountedLedger() public {
        // The scope ends with a token whose spot ledger is empty while Core holds one unit of it
        // (30 USDC at the bid) in a lending ledger the scope does not count. USDC's own ledger
        // answers first, so no control read is pending either: after the last probe almost nothing
        // is left to do, the cheapest way a valuation could finish on a probe starved of gas.
        HyperCorePrecompileSource.Token[] memory tokens = new HyperCorePrecompileSource.Token[](2);
        tokens[1] = HyperCorePrecompileSource.Token(1, 101, false, false);
        _tokenInfo(1, address(0), 2, 8, 0);
        _pair(101, 1);
        _ledger(0, 0);
        source.configure(address(vault), tokens, new uint32[](0), new address[](0), true);
        _ledger(1, 1e8);
        _answer(BBO, abi.encode(uint32(10_101)), abi.encode(uint64(30e6), uint64(30e6)));
        // Warm every slot and address the valuation touches, as the second valuation of a deposit
        // finds them.
        source.scope(address(vault));
        source.observeTokens(address(vault));
        (bool warmed,) = LENDING.staticcall(abi.encode(address(vault), uint64(1)));
        require(warmed);

        bytes memory evaluate = abi.encodeCall(source.evaluate, (address(vault)));
        bytes memory exposure = abi.encodeCall(source.exposure, (address(vault)));
        bytes32 incomplete = keccak256(abi.encodeWithSelector(HyperCorePrecompileSource.ScopeIncomplete.selector));
        // Coarse pass over the whole range: never a value, and the correct refusal appears.
        uint256 boundary;
        for (uint256 gas = 1_000; gas < 150_000; gas += 97) {
            (bool ok, bytes memory data) = address(source).staticcall{gas: gas}(evaluate);
            require(!ok, "an uncounted ledger was priced as empty");
            if (boundary == 0 && keccak256(data) == incomplete) boundary = gas;
            (ok,) = address(source).staticcall{gas: gas}(exposure);
            require(!ok, "an exit ignored an uncounted ledger");
        }
        require(boundary != 0, "the sweep must reach the correct refusal");
        // Every gas value in the band where a starved probe leaves its caller the most gas (the
        // top of the range below the boundary): still never a value, and one clean switch to the
        // correct refusal.
        bool refused;
        for (uint256 gas = boundary - 6_000; gas < boundary + 100; ++gas) {
            (bool ok, bytes memory data) = address(source).staticcall{gas: gas}(evaluate);
            require(!ok, "an uncounted ledger was priced as empty");
            bool isRefusal = keccak256(data) == incomplete;
            require(isRefusal || !refused, "more gas must not turn the refusal back into something else");
            refused = isRefusal;
        }
        require(refused);
        // A scope edit ends in storage writes: starving its probe must not let the token leave.
        bytes memory drop =
            abi.encodeCall(source.configure, (address(vault), _usdcOnly(), new uint32[](0), new address[](0), true));
        bytes32 inUse = keccak256(abi.encodeWithSelector(HyperCorePrecompileSource.ScopeInUse.selector));
        bytes memory last;
        for (uint256 gas = 1_000; gas < 300_000; gas += 311) {
            bool ok;
            (ok, last) = address(source).call{gas: gas}(drop);
            require(!ok, "a token left the scope while its ledger held what could be sold");
        }
        require(keccak256(last) == inUse);
    }

    function testLargestScopeEntriesFitASmallBlock() public {
        (uint256 first, uint256 repeated, uint256 depositGas, uint256 mintGas) = _measure();
        // By the documented cost: about 0.63M per valuation, 1.43M for the deposit and 2.60M for
        // the mint. A small block carries 3M. A caller that also previews in the same transaction
        // adds one valuation per preview: at this size a preview and a mint together do not fit.
        require(first < 680_000 && repeated <= first, "valuation gas");
        require(depositGas < SMALL_BLOCK_GAS / 2, "deposit gas");
        require(mintGas > depositGas && mintGas < SMALL_BLOCK_GAS * 9 / 10, "mint gas");
    }

    function testLargestScopeAtTheCostMeasuredOnMainnet() public {
        // Every boundary measured on 2026-10-04 sat at 1000 + 33 * (input + output): about half
        // the documented cost. An observation of one day, so the limits above do not rely on it.
        _stub(1000, 33);
        (uint256 first,, uint256 depositGas, uint256 mintGas) = _measure();
        // About 0.43M per valuation, 1.03M for the deposit and 1.81M for the mint.
        require(first < 460_000 && depositGas < SMALL_BLOCK_GAS * 2 / 5 && mintGas < SMALL_BLOCK_GAS * 2 / 3);
    }
}
