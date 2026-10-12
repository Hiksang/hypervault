// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IManagedNavVerifier} from "../interfaces/IManagedNavVerifier.sol";
import {HyperVaultNavSource} from "./HyperVaultNavSource.sol";
import {IManagedVaultVerifier} from "../interfaces/IManagedVaultVerifier.sol";
import {CoreRead} from "../CoreRead.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IManagedVaultState} from "../managed/ManagedPortfolioNavVerifier.sol";
import {ManagedAssetBridge} from "../managed/ManagedAssetBridge.sol";

/// @notice Onchain-only verifier for a HyperVault: live NAV, action finality and exit flatness.
/// @dev No signer, keeper report or caller-supplied amount is trusted; `proof` is unused.
///      NAV covers the scope the Vault owner registered in `source` and nothing else. The owner
///      is trusted with that scope (ADR-038): unlike ManagedAssetNavVerifier (v1) there is no
///      drawdown wait and no required price history. Share prices are still recorded (anyone,
///      `recordPrice`) for the Accountant's conservative fee price.
///      Finality relies on HyperEVM's documented ordering: an EVM -> Core transfer and a
///      non-delayed CoreWriter action are processed right after their EVM block, so a LATER Core
///      block already reflects them. Core never reports an action receipt to the EVM: a Core-side
///      rejection of an agent or control action is not observable here and is reported as applied.
contract HyperVaultNavVerifier is IManagedNavVerifier, IManagedVaultVerifier {
    using SafeCast for uint256;

    uint8 private constant KIND_DEPOSIT = 1;
    uint8 private constant KIND_RECALL = 2;
    /// @dev ManagedUsdcVault.Phase.Idle: the Vault holds cash only and issues at that cash.
    uint8 private constant PHASE_IDLE = 3;
    /// @dev Core blocks, not seconds: about 14 per second were observed on mainnet, so the
    ///      bounds are roughly 12 minutes and 40 hours. The rate is not a protocol constant.
    uint64 public constant MIN_RECALL_TIMEOUT_BLOCKS = 10_000;
    uint64 public constant MAX_RECALL_TIMEOUT_BLOCKS = 2_000_000;
    /// @dev Below Core's minimum order of 10 USDC: what an exit may leave on a registered venue
    ///      is then never of the size a report would take.
    uint256 public constant MAX_IDLE_DUST = 10e6 - 1;
    /// @dev Share prices kept per Vault. Their spacing makes them span one whole price window.
    uint256 public constant PRICE_RECORDS = 8;
    uint256 public constant MIN_PRICE_WINDOW = 10 minutes;
    uint256 public constant MAX_PRICE_WINDOW = 1 days;

    struct Abandonment {
        uint256 actionId;
        uint64 coreBlock;
    }

    struct PriceRecord {
        uint192 price; // assets per share at 1e30
        uint64 time;
    }

    struct PriceHistory {
        PriceRecord[PRICE_RECORDS] records;
        uint8 next;
    }

    HyperVaultNavSource public immutable source;
    address public immutable asset;
    ManagedAssetBridge public immutable bridge;
    /// @dev Core blocks between the owner giving up on a recall and that recall being closed.
    uint64 public immutable recallTimeoutBlocks;
    /// @dev Largest registered Core value (USDC6) an exit may leave behind.
    uint256 public immutable idleDustLimit;
    /// @dev Seconds of share-price history the Accountant takes its lowest price from.
    uint256 public immutable priceWindow;
    /// @dev Pending recall the Vault owner gave up on. Never a claim that USDC arrived.
    mapping(address vault => Abandonment) public abandonedRecall;
    mapping(address vault => PriceHistory) private _history;

    error InvalidConfiguration();
    error InvalidContext();
    error NegativeCoreEquity();
    error UnknownAction();
    error ActionNotFinal();
    error CoreNotFlat();
    error Unauthorized();
    error PriceRecordTooSoon();
    error NoShares();

    event RecallAbandoned(address indexed vault, uint256 indexed actionId);
    event PriceRecorded(address indexed vault, uint256 price);

    constructor(
        ManagedAssetBridge bridge_,
        HyperVaultNavSource source_,
        uint64 recallTimeoutBlocks_,
        uint256 idleDustLimit_,
        uint256 priceWindow_
    ) {
        if (
            address(bridge_).code.length == 0 || address(source_).code.length == 0
                || recallTimeoutBlocks_ < MIN_RECALL_TIMEOUT_BLOCKS || recallTimeoutBlocks_ > MAX_RECALL_TIMEOUT_BLOCKS
                || idleDustLimit_ == 0 || idleDustLimit_ > MAX_IDLE_DUST || priceWindow_ < MIN_PRICE_WINDOW
                || priceWindow_ > MAX_PRICE_WINDOW
        ) revert InvalidConfiguration();
        bridge = bridge_;
        asset = bridge_.asset();
        source = source_;
        recallTimeoutBlocks = recallTimeoutBlocks_;
        idleDustLimit = idleDustLimit_;
        priceWindow = priceWindow_;
    }

    /// @notice Shareholder assets = Vault.availableCash() + registered Core equity, both read now.
    /// @dev Core debt has no recourse to EVM cash, so a negative Core equity is not netted against
    ///      it: that would understate NAV and overissue shares. It closes issuance instead.
    function verifyNav(address vault, uint256 actionNonce, bytes32 configHash)
        external
        view
        returns (uint256 shareholderAssets, uint64 coreBlock)
    {
        IManagedVaultState v = IManagedVaultState(vault);
        if (v.asset() != asset) revert InvalidContext();
        if (v.asset() != asset || v.actionNonce() != actionNonce || v.configHash() != configHash) {
            revert InvalidContext();
        }
        (shareholderAssets, coreBlock) = _assets(v, vault);
    }

    /// @notice The same assets without the context checks, for display and for record keepers.
    /// @dev Everything else that closes a valuation closes this read too.
    function nav(address vault) external view returns (uint256 shareholderAssets, uint64 coreBlock) {
        return _assets(IManagedVaultState(vault), vault);
    }

    function priceRecords(address vault) external view returns (PriceRecord[PRICE_RECORDS] memory) {
        return _history[vault].records;
    }

    /// @notice Record the Vault's current share price. Anyone may call.
    /// @dev The Accountant charges fees and publishes the rate at the lowest record of the window,
    ///      so a price spike shorter than the window is never charged. Records are spaced so that
    ///      the oldest is overwritten only once it has left the window; within a slot a higher
    ///      price replaces a lower one. The price is that of the registered scope whether or not
    ///      it is enabled and whether or not a management action is pending. Funds in flight are
    ///      in neither ledger, which makes such a record too low, never too high. An Idle Vault
    ///      issues at its cash alone, and that is the price recorded.
    /// @notice Pass-through of `HyperVaultNavSource.oracleOnly` for the Vault (ADR-040).
    function oracleOnly(address vault) external view returns (bool) {
        return source.oracleOnly(vault);
    }

    function recordPrice(address vault) external returns (uint256 price) {
        IManagedVaultState v = IManagedVaultState(vault);
        if (v.asset() != asset) revert InvalidContext();
        // Without shares the ratio is only the virtual offset: not a price anyone was issued at.
        if (v.totalSupply() == 0) revert NoShares();
        uint256 assets = v.availableCash();
        if (v.phase() != PHASE_IDLE && v.phase() != 1) {
            _denominationScope(vault);
            (int256 netUsdc18,) = source.scopeValue(vault);
            assets += _coreAssets(netUsdc18);
        }
        price = _sharePrice(v, assets);
        PriceHistory storage history = _history[vault];
        uint256 next = history.next;
        uint256 newest = (next + PRICE_RECORDS - 1) % PRICE_RECORDS;
        PriceRecord memory last = history.records[newest];
        if (last.time != 0 && block.timestamp - last.time <= priceWindow / PRICE_RECORDS) {
            if (price <= last.price) revert PriceRecordTooSoon();
            history.records[newest].price = price.toUint192();
        } else {
            history.records[next] = PriceRecord(price.toUint192(), uint64(block.timestamp));
            history.next = uint8((next + 1) % PRICE_RECORDS);
        }
        emit PriceRecorded(vault, price);
    }

    /// @notice The owner gives up on the pending recall `id`: Core rejected it or it never came.
    /// @dev Only this lets `verifyAction` close a recall whose USDC is not fully in the Vault, and
    ///      only `recallTimeoutBlocks` later. A third party must not be able to reopen issuance,
    ///      or let an exit settle, while that USDC may still be in flight.
    function abandonRecall(address vault, uint256 id) external {
        IManagedVaultState v = IManagedVaultState(vault);
        if (v.asset() != asset) revert InvalidContext();
        if (msg.sender != v.owner()) revert Unauthorized();
        (uint256 pending,, uint64 submitted, uint8 kind,,) = v.pendingAction();
        if (id == 0 || pending != id || kind != KIND_RECALL || abandonedRecall[vault].actionId == id) {
            revert UnknownAction();
        }
        uint64 coreBlock = CoreRead.l1Block();
        if (coreBlock <= submitted) revert ActionNotFinal(); // Core has not processed the recall yet
        abandonedRecall[vault] = Abandonment(id, coreBlock);
        emit RecallAbandoned(vault, id);
    }

    function verifyAction(address vault, uint256 id, bytes32 intentHash, bytes calldata)
        external
        view
        returns (Receipt memory r)
    {
        IManagedVaultState v = IManagedVaultState(vault);
        if (v.asset() != asset) revert InvalidContext();
        (uint256 pending, bytes32 digest, uint64 submitted, uint8 kind, uint256 assets,) = v.pendingAction();
        if (id == 0 || pending != id || digest != intentHash) revert UnknownAction();
        r.coreBlock = CoreRead.l1Block();
        if (r.coreBlock <= submitted) revert ActionNotFinal();
        if (kind == KIND_RECALL) {
            // Core -> EVM USDC is queued for the next EVM block. Only USDC that really sits in
            // the Vault outside its ledger is booked; it cannot be created by this receipt.
            uint256 arrived = v.unaccountedUsdc();
            if (arrived >= assets) {
                r.success = true;
                r.receivedAssets = assets;
            } else {
                Abandonment memory given = abandonedRecall[vault];
                if (given.actionId != id || r.coreBlock - given.coreBlock <= recallTimeoutBlocks) {
                    revert ActionNotFinal();
                }
                // Whatever did arrive is booked, so a short arrival is a visible loss, not a
                // balance stranded outside the NAV.
                r.receivedAssets = arrived;
                r.success = arrived != 0;
            }
        } else {
            r.success = true;
            if (kind == KIND_DEPOSIT) r.receivedAssets = assets;
        }
    }

    /// @dev Flat means: no registered debt, perp position or deficit, and at most `idleDustLimit`
    ///      of value that could still be brought home. An exit pays out the cash it brought home;
    ///      what the owner left outside the scope is the owner's responsibility (ADR-038).
    function verifyIdle(address vault, uint256, uint256 actionNonce, bytes calldata)
        external
        view
        returns (uint64 coreBlock)
    {
        IManagedVaultState v = IManagedVaultState(vault);
        if (v.asset() != asset) revert InvalidContext();
        if (v.actionNonce() != actionNonce) revert InvalidContext();
        int256 netUsdc18;
        bool liabilities;
        (netUsdc18, liabilities, coreBlock) = source.exposure(vault);
        if (liabilities || netUsdc18 < 0 || uint256(netUsdc18) > idleDustLimit * 1e12) revert CoreNotFlat();
    }

    function _assets(IManagedVaultState v, address vault) private view returns (uint256 assets, uint64 coreBlock) {
        if (v.asset() != asset) revert InvalidContext();
        int256 netUsdc18;
        _denominationScope(vault);
        (netUsdc18, coreBlock) = source.evaluate(vault);
        // Raw EVM balance, direct transfers and claim reserves are excluded by availableCash().
        assets = v.availableCash() + _coreAssets(netUsdc18);
    }

    /// @dev The numerator must price the base asset with the very same reserve/pair as the denominator.
    function _denominationScope(address vault) private view {
        (,, HyperVaultNavSource.TokenState[] memory tokens,,) = source.scope(vault);
        for (uint256 i; i < tokens.length; ++i) {
            if (tokens[i].index == bridge.coreToken()) {
                if (
                    bridge.kind() != ManagedAssetBridge.Kind.Usdc
                        && (!tokens[i].reservePrice || tokens[i].usdcSpot != bridge.spotPair())
                ) revert InvalidContext();
                return;
            }
        }
        revert InvalidContext();
    }

    function _coreAssets(int256 netUsdc18) private view returns (uint256) {
        if (netUsdc18 < 0) revert NegativeCoreEquity();
        return bridge.fromUsdc18(uint256(netUsdc18));
    }

    /// @dev The Vault's own conversion ratio (virtual shares, offset 3), at 1e30.
    function _sharePrice(IManagedVaultState v, uint256 assets) private view returns (uint256) {
        return Math.mulDiv(assets + 1, 1e30, v.totalSupply() + 1000);
    }
}
