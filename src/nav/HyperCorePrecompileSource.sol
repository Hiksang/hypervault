// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CoreRead} from "../CoreRead.sol";
import {IManagedCoreNavSource} from "../interfaces/IManagedCoreNavSource.sol";

interface IManagedScopeOwner {
    function owner() external view returns (address);
}

/// @notice Values the HyperCore venues a Vault owner registered, from live read precompiles.
/// @dev No offchain prices, signatures or owner-reported amounts. The precompiles expose raw,
///      disjoint ledgers in every abstraction mode (Standard, Unified, Portfolio Margin):
///
///        equity(token) = spot total + lending supply - lending debt
///                        + for USDC: every registered perp DEX equity + HyperCore vault equity
///
///      so one formula serves all modes and no account-mode read is needed. The ABI cannot
///      enumerate an account's tokens, DEXes or outcomes: completeness of the registered scope is
///      the owner's responsibility, and an unregistered venue is simply not counted. What the
///      contract can do is check a venue someone names, so anyone may report one (`reportToken`):
///      while the named venue provably holds something, the Vault neither issues nor settles.
///      Unsupported: HIP-4 outcomes, non-USDC collateral DEXes, staking, sub-accounts.
contract HyperCorePrecompileSource is IManagedCoreNavSource {
    // A deposit runs two valuations and a mint four. By the documented precompile cost the
    // largest scope, with a report to re-read, keeps even a mint inside a 3M-gas small block
    // (test/ManagedNavGas.t.sol).
    uint256 public constant MAX_TOKENS = 6;
    uint256 public constant MAX_DEXES = 8;
    uint256 public constant MAX_CORE_VAULTS = 2;
    /// @dev Every valuation re-reads the reported venue, so only one is kept. It keeps its place
    ///      for as long as it stands: a report that could be displaced could be lifted by anyone
    ///      with a proof that holds for a single block.
    uint256 public constant MAX_REPORTS = 1;
    /// @dev Widest spot book, in bps of the ask, that may price a balance.
    uint256 public constant MAX_SPREAD_BPS = 100;
    /// @dev Largest gap, in bps of the spot mark, between the borrow oracle and that mark.
    uint256 public constant MAX_ORACLE_DEVIATION_BPS = 200;
    /// @dev Core rejects an order worth less than 10 of its pair's quote token: a smaller holding
    ///      cannot be sold. It bounds what an exit may leave behind and what a report has to prove.
    uint256 public constant MIN_ORDER_USDC18 = 10e18;
    /// @dev A report lapses unless it is renewed, so a venue that can no longer be read does not
    ///      close a Vault for longer than this.
    uint256 public constant REPORT_TTL = 1 days;
    int64 private constant MIN_ORDER_USDC6 = 10e6;
    /// @dev A read of this shape is documented at 14,480 gas and cost 7,336 on mainnet when
    ///      measured. A failing precompile burns everything it is given.
    uint256 private constant LEDGER_PROBE_GAS = 20_000;
    uint32 private constant OUTCOME_BASE = 100_000_000;
    uint32 private constant SPOT_ASSET_BASE = 10_000;

    enum ReportKind {
        Token,
        Dex,
        CoreVault
    }

    struct Token {
        uint32 index;
        uint32 usdcSpot; // direct token/USDC pair; ignored for USDC itself
        bool lending; // count the borrow/lend ledger: its read must succeed. Otherwise it must be empty
        bool reservePrice; // value at the protocol's borrow oracle, which must agree with the spot mark
    }

    struct TokenState {
        uint32 index;
        uint32 usdcSpot;
        bool lending;
        bool reservePrice;
        uint8 weiDecimals;
        uint8 szDecimals;
    }

    /// @dev A venue outside the scope that someone proved the Vault's Core account holds. It is
    ///      read again in every valuation and counts only while that proof still holds.
    struct Report {
        address coreVault; // CoreVault reports
        uint32 id; // token or DEX index
        uint32 pair; // Token reports: a spot pair of the token
        uint32 quotePair; // Token reports: quote token/USDC pair when `pair` is not quoted in USDC
        uint64 expiresAt;
        ReportKind kind;
        bool viaQuote;
        uint8 weiDecimals; // Token reports: metadata checked against Core when reported
        uint8 szDecimals;
        uint8 quoteSzDecimals;
    }

    struct Scope {
        uint64 version;
        uint64 answeredAt;
        bool enabled;
        TokenState[] tokens;
        uint32[] dexes;
        address[] coreVaults;
        Report[] reports;
    }

    struct TokenObservation {
        uint32 index;
        uint8 weiDecimals;
        uint8 szDecimals;
        CoreRead.SpotBalance spot;
        CoreRead.UserLending lending;
        bool lendingQueried;
        uint256 usdcPrice18;
    }

    struct OutcomeObservation {
        uint64 encodedAsset;
        CoreRead.SpotBalance balance;
        bool balanceQueried;
        CoreRead.OutcomeStatus status;
        uint64 activeRawSpotPrice;
    }

    address public immutable asset;
    address public immutable usdcCoreBridge;
    uint32 public immutable usdcToken;
    mapping(address vault => Scope) private _scopes;

    error InvalidConfiguration();
    error InvalidObservation();
    error Unauthorized();
    error ScopeUnavailable();
    error ScopeInUse();
    error ScopeIncomplete();
    error NegativeDexEquity();
    error PriceGuard();
    error OpenReport();
    error NotReportable();
    error ReportStands();

    event ScopeConfigured(
        address indexed vault,
        uint64 indexed version,
        bool enabled,
        Token[] tokens,
        uint32[] dexes,
        address[] coreVaults
    );
    event ScopeEnabled(address indexed vault, uint64 indexed version, bool enabled);
    event ScopeReported(address indexed vault, ReportKind kind, uint32 id, address coreVault, address indexed reporter);
    event ReportCleared(address indexed vault, ReportKind kind, uint32 id, address coreVault);

    constructor(address asset_, address usdcCoreBridge_, uint32 usdcToken_) {
        if (asset_.code.length == 0 || usdcCoreBridge_.code.length == 0 || usdcToken_ >= OUTCOME_BASE) {
            revert InvalidConfiguration();
        }
        if (IERC20Metadata(asset_).decimals() != 6) revert InvalidConfiguration();
        asset = asset_;
        usdcCoreBridge = usdcCoreBridge_;
        usdcToken = usdcToken_;
    }

    modifier onlyVaultOwner(address vault) {
        if (msg.sender != IManagedScopeOwner(vault).owner()) revert Unauthorized();
        _;
    }

    /// @notice Replace the Vault's whole scope. Lists are strictly ascending.
    /// @dev Metadata is checked against Core, never taken from the caller. An entry can leave the
    ///      scope only once it holds nothing. For a token that means no debt and nothing that
    ///      could be sold at the best bid now: with no bid, a holding of any size can leave, and
    ///      is from then on a holding outside the scope like any other. Registering a reported
    ///      venue answers the report, and what was recorded while it was listed stops being
    ///      price history (`reportAnsweredAt`): a report on a small holding of the owner's own
    ///      could otherwise be lifted in the block of a deposit while more is held elsewhere.
    ///      Only a report that stood until this call is answered by it: one that had already
    ///      stopped standing is merely dropped. A reported token registered on a pair that bids
    ///      nothing for it stays reported while it could still be named as a registered token
    ///      (no debt, and twice the minimum order on the reported pair).
    function configure(
        address vault,
        Token[] calldata tokens,
        uint32[] calldata dexes,
        address[] calldata coreVaults,
        bool enabled
    ) external onlyVaultOwner(vault) {
        if (
            tokens.length == 0 || tokens.length > MAX_TOKENS || dexes.length > MAX_DEXES
                || coreVaults.length > MAX_CORE_VAULTS
        ) revert InvalidConfiguration();
        bool hasUsdc;
        for (uint256 i; i < tokens.length; ++i) {
            if ((i != 0 && tokens[i - 1].index >= tokens[i].index) || tokens[i].index >= OUTCOME_BASE) {
                revert InvalidConfiguration();
            }
            if (tokens[i].index == usdcToken) hasUsdc = true;
        }
        if (!hasUsdc) revert InvalidConfiguration();
        for (uint256 i = 1; i < dexes.length; ++i) {
            if (dexes[i - 1] >= dexes[i]) revert InvalidConfiguration();
        }
        for (uint256 i; i < coreVaults.length; ++i) {
            if (coreVaults[i] == address(0) || (i != 0 && coreVaults[i - 1] >= coreVaults[i])) {
                revert InvalidConfiguration();
            }
        }
        Scope storage s = _scopes[vault];
        _release(s, vault, tokens, dexes, coreVaults);
        // Whether a report closes the Vault now: only then can this call be what lifts it.
        bool stood;
        if (s.reports.length != 0 && block.timestamp < s.reports[0].expiresAt) {
            (stood,) = _stands(s, vault, s.reports[0], false);
        }
        delete s.tokens;
        delete s.dexes;
        delete s.coreVaults;
        for (uint256 i; i < tokens.length; ++i) {
            Token calldata t = tokens[i];
            CoreRead.TokenInfo memory info = _tokenInfo(t.index);
            if (t.index == usdcToken) {
                // Native EVM USDC is bridged through Circle CoreDepositWallet. Core
                // tokenInfo.evmContract points to that bridge, NOT the ERC20 asset. Its lot must
                // be one wei, so that no unit of USDC is ever treated as dust.
                if (
                    info.evmContract != usdcCoreBridge || info.weiDecimals < 6 || info.szDecimals != info.weiDecimals
                        || int256(uint256(info.weiDecimals)) + info.evmExtraWeiDecimals != 6
                ) revert InvalidObservation();
            } else {
                CoreRead.SpotInfo memory pair = CoreRead.spotInfo(t.usdcSpot);
                if (pair.tokens[0] != t.index || pair.tokens[1] != usdcToken) revert InvalidObservation();
                if (t.reservePrice) CoreRead.reserve(t.index); // a token without a reserve is an error
            }
            s.tokens.push(TokenState(t.index, t.usdcSpot, t.lending, t.reservePrice, info.weiDecimals, info.szDecimals));
        }
        for (uint256 i; i < dexes.length; ++i) {
            CoreRead.accountMarginSummary(dexes[i], vault); // an unknown DEX index is an error, not zero
            s.dexes.push(dexes[i]);
        }
        for (uint256 i; i < coreVaults.length; ++i) {
            CoreRead.userVaultEquity(vault, coreVaults[i]);
            s.coreVaults.push(coreVaults[i]);
        }
        uint64 version = ++s.version;
        s.enabled = enabled;
        if (s.reports.length != 0 && _registered(s, s.reports[0])) {
            Report memory kept = s.reports[0];
            bool stands;
            if (block.timestamp < kept.expiresAt) (stands,) = _stands(s, vault, kept, false);
            if (!stands) {
                s.reports.pop();
                if (stood) s.answeredAt = uint64(block.timestamp);
                emit ReportCleared(vault, kept.kind, kept.id, kept.coreVault);
            }
        }
        emit ScopeConfigured(vault, version, enabled, tokens, dexes, coreVaults);
    }

    /// @notice The owner's deposit switch: a disabled scope cannot price share issuance.
    function setEnabled(address vault, bool enabled) external onlyVaultOwner(vault) {
        Scope storage s = _scopes[vault];
        if (s.version == 0) revert ScopeUnavailable();
        s.enabled = enabled;
        emit ScopeEnabled(vault, s.version, enabled);
    }

    /// @notice Prove that the Vault's Core account holds a token its scope does not count.
    /// @dev Anyone may call: the holding is read here and the caller is not trusted. `pair` is a
    ///      spot pair of the token; when it is not quoted in USDC, `quotePair` is the quote
    ///      token's USDC pair. A report stands for a holding that could be sold (whole lots worth
    ///      at least the minimum order at the best bid, at every hop) or for any debt. While it
    ///      stands the Vault can neither issue shares nor settle an exit, and no other venue can
    ///      take its place. Reporting the same venue again renews it. A registered token can be
    ///      named too, while its registered pair would pay nothing for the holding.
    function reportToken(address vault, uint32 token, uint32 pair, bool viaQuote, uint32 quotePair) external {
        if (token >= OUTCOME_BASE) revert NotReportable();
        Report memory r = Report(address(0), token, pair, 0, 0, ReportKind.Token, viaQuote, 0, 0, 0);
        CoreRead.TokenInfo memory info = _tokenInfo(token);
        (r.weiDecimals, r.szDecimals) = (info.weiDecimals, info.szDecimals);
        CoreRead.SpotInfo memory traded = CoreRead.spotInfo(pair);
        if (traded.tokens[0] != token) revert NotReportable();
        if (viaQuote) {
            CoreRead.SpotInfo memory quote = CoreRead.spotInfo(quotePair);
            if (quote.tokens[0] != traded.tokens[1] || quote.tokens[1] != usdcToken || quote.tokens[0] >= OUTCOME_BASE)
            {
                revert NotReportable();
            }
            r.quotePair = quotePair;
            r.quoteSzDecimals = _tokenInfo(uint32(quote.tokens[0])).szDecimals;
        } else if (traded.tokens[1] != usdcToken) {
            revert NotReportable();
        }
        _report(vault, r);
    }

    /// @notice Prove that the Vault holds equity or a position on a perp DEX outside its scope.
    function reportDex(address vault, uint32 dex) external {
        _report(vault, Report(address(0), dex, 0, 0, 0, ReportKind.Dex, false, 0, 0, 0));
    }

    /// @notice Prove that the Vault holds equity in a HyperCore vault outside its scope.
    function reportCoreVault(address vault, address coreVault) external {
        _report(vault, Report(coreVault, 0, 0, 0, 0, ReportKind.CoreVault, false, 0, 0, 0));
    }

    /// @notice Drop a report that cannot be proven any more: its venue was registered or emptied,
    ///         or the report lapsed. Housekeeping: such a report closes nothing.
    function clearReport(address vault, uint256 index) external {
        Scope storage s = _scopes[vault];
        Report memory r = s.reports[index];
        if (block.timestamp < r.expiresAt) {
            (bool stands,) = _stands(s, vault, r, false);
            if (stands) revert ReportStands();
        }
        _dropReport(s, index);
        emit ReportCleared(vault, r.kind, r.id, r.coreVault);
    }

    function reports(address vault) external view returns (Report[] memory) {
        return _scopes[vault].reports;
    }

    function scope(address vault)
        external
        view
        returns (
            uint64 version,
            bool enabled,
            TokenState[] memory tokens,
            uint32[] memory dexes,
            address[] memory coreVaults
        )
    {
        Scope storage s = _scopes[vault];
        return (s.version, s.enabled, s.tokens, s.dexes, s.coreVaults);
    }

    function evaluate(address vault) external view returns (int256 netUsdc18, uint64 coreBlock) {
        Scope storage s = _scopes[vault];
        if (!s.enabled) revert ScopeUnavailable();
        (netUsdc18,) = _value(s, vault, false, _unreported(s, vault));
        coreBlock = _coreBlock();
    }

    function scopeValue(address vault) external view returns (int256 netUsdc18, uint64 coreBlock) {
        Scope storage s = _scopes[vault];
        if (s.version == 0) revert ScopeUnavailable();
        (netUsdc18,) = _value(s, vault, false, false);
        coreBlock = _coreBlock();
    }

    function reportAnsweredAt(address vault) external view returns (uint64) {
        return _scopes[vault].answeredAt;
    }

    function exposure(address vault) external view returns (int256 netUsdc18, bool liabilities, uint64 coreBlock) {
        Scope storage s = _scopes[vault];
        if (s.version == 0) revert ScopeUnavailable();
        (netUsdc18, liabilities) = _value(s, vault, true, _unreported(s, vault));
        coreBlock = _coreBlock();
    }

    function observeTokens(address vault) external view returns (uint64 coreBlock, TokenObservation[] memory values) {
        Scope storage s = _scopes[vault];
        coreBlock = _coreBlock();
        values = new TokenObservation[](s.tokens.length);
        for (uint256 i; i < values.length; ++i) {
            TokenState memory t = s.tokens[i];
            TokenObservation memory o = values[i];
            o.index = t.index;
            o.weiDecimals = t.weiDecimals;
            o.szDecimals = t.szDecimals;
            o.spot = CoreRead.spotBalance(vault, t.index);
            if (t.lending) {
                o.lending = CoreRead.lending(vault, t.index);
                o.lendingQueried = true;
            }
            // Like the valuation, a token with no net holding is not priced. Zero also means a
            // price guard refused the price: this view reports that instead of reverting.
            if (uint256(o.spot.total) + o.lending.supply.value != o.lending.borrow.value) {
                o.usdcPrice18 = t.index == usdcToken ? 1e18 : _tryPrice(t);
            }
        }
    }

    /// @notice Raw equity of each registered DEX. Margin summaries are disjoint per DEX.
    function observeDexes(address vault)
        external
        view
        returns (uint64 coreBlock, CoreRead.AccountMarginSummary[] memory values)
    {
        Scope storage s = _scopes[vault];
        coreBlock = _coreBlock();
        values = new CoreRead.AccountMarginSummary[](s.dexes.length);
        for (uint256 i; i < values.length; ++i) {
            values[i] = CoreRead.accountMarginSummary(s.dexes[i], vault);
        }
    }

    /// @notice Uses position2 (uint32) so HIP-3 IDs cannot be truncated to uint16.
    function observePosition(address account, uint32 perp)
        external
        view
        returns (uint64 coreBlock, CoreRead.Position memory position, uint64 mark, uint64 oracle)
    {
        return (_coreBlock(), CoreRead.position(account, perp), CoreRead.markPx(perp), CoreRead.oraclePx(perp));
    }

    /// @notice HIP-4 observations stay raw: outcome balances are NOT part of the valuation.
    ///         Settled/pruned outcomes do not silently receive an active spot quote or zero value.
    function observeOutcome(address account, uint32 outcome, uint8 side)
        external
        view
        returns (uint64 coreBlock, OutcomeObservation memory o)
    {
        uint256 encoded = uint256(OUTCOME_BASE) + uint256(outcome) * 10 + side;
        if (side > 1 || encoded > type(uint32).max) revert InvalidConfiguration();
        coreBlock = _coreBlock();
        o.encodedAsset = uint64(encoded);
        o.status = CoreRead.outcomeStatus(outcome);
        if (o.status.status == 0 || o.status.status > 3 || o.status.settledValue > 1e8) revert InvalidObservation();
        if (o.status.status == 1) {
            o.balance = CoreRead.spotBalance(account, uint64(encoded));
            o.balanceQueried = true;
            o.activeRawSpotPrice = CoreRead.spotPx(uint32(encoded));
            if (o.activeRawSpotPrice == 0) revert InvalidObservation();
        }
        // Mainnet settled outcome token reads may revert after automatic conversion
        // to quote currency. A status-only observation is NOT a known zero balance.
    }

    function _coreBlock() private view returns (uint64 coreBlock) {
        coreBlock = CoreRead.l1Block();
        if (coreBlock == 0) revert InvalidObservation();
    }

    function _tokenInfo(uint32 token) private view returns (CoreRead.TokenInfo memory info) {
        info = CoreRead.tokenInfo(token);
        if (info.szDecimals > 8 || info.weiDecimals > 18 || info.weiDecimals < info.szDecimals) {
            revert InvalidObservation();
        }
    }

    /// @param exit Value what an exit could still bring home instead of pricing for issuance:
    ///        the USDC ledgers plus every token holding that can be sold. A holding below one lot,
    ///        or worth less than the minimum order at the best bid, cannot be sold: neither its
    ///        value nor the state of its book may hold this valuation hostage. The price records
    ///        an exit also needs are made with `exit` false, and a refused price does stop those.
    /// @param calibrated Whether the ledger probe's control read already ran in this valuation.
    function _value(Scope storage s, address account, bool exit, bool calibrated)
        private
        view
        returns (int256 net, bool liabilities)
    {
        uint256 count = s.tokens.length;
        for (uint256 i; i < count; ++i) {
            TokenState memory t = s.tokens[i];
            uint256 assets;
            uint256 debt;
            (assets, debt, calibrated) = _balances(t, account, calibrated);
            if (debt != 0) liabilities = true;
            if (t.index == usdcToken) {
                int256 venues;
                (venues, liabilities) = _usdcVenues(s, account, exit, liabilities);
                // USDC is the unit of account, not a USD peg claim.
                net += _scaled(
                    int256(assets) - int256(debt) + venues * int256(10 ** (t.weiDecimals - 6)), 1e18, t.weiDecimals
                );
            } else if (exit) {
                // A token debt is a liability whatever it is worth: it is flagged, not priced.
                net += int256(_sellable(t.usdcSpot, t.weiDecimals, t.szDecimals, assets));
            } else {
                int256 units = int256(assets) - int256(debt);
                if (units == 0) continue; // nothing to value: its price cannot close the NAV
                uint256 price = _tryPrice(t);
                if (price == 0) {
                    // Dust nobody can sell must not let a stranger's transfer close issuance.
                    if (debt == 0 && assets < _lot(t.weiDecimals, t.szDecimals)) continue;
                    revert PriceGuard();
                }
                net += _scaled(units, price, t.weiDecimals);
            }
        }
    }

    /// @dev Spot total already includes held tokens: `hold` and entry notional are not ledgers.
    ///      Lending is the interest-bearing value, never the principal basis.
    function _balances(TokenState memory t, address account, bool calibrated)
        private
        view
        returns (uint256 assets, uint256 debt, bool)
    {
        assets = CoreRead.spotBalance(account, t.index).total;
        if (t.lending) {
            CoreRead.UserLending memory l = CoreRead.lending(account, t.index);
            assets += l.supply.value;
            debt = l.borrow.value;
        } else {
            // E.g. Portfolio Margin moved the balance into its supply ledger. Close the valuation
            // rather than silently drop that value or debt.
            uint256 supplied;
            uint256 borrowed;
            (supplied, borrowed, calibrated) = _ledger(account, t.index, calibrated);
            if (borrowed != 0 || supplied >= _lot(t.weiDecimals, t.szDecimals)) revert ScopeIncomplete();
            assets += supplied; // too small to need registering, still part of the holding
        }
        return (assets, debt, calibrated);
    }

    /// @dev Assets round down and debts round up, so rounding never overstates the Vault.
    function _scaled(int256 units, uint256 price, uint8 weiDecimals) private pure returns (int256) {
        uint256 scale = 10 ** weiDecimals;
        return units >= 0
            ? int256(Math.mulDiv(uint256(units), price, scale))
            : -int256(Math.mulDiv(uint256(-units), price, scale, Math.Rounding.Ceil));
    }

    /// @dev Smallest tradeable spot size in wei: order sizes are multiples of 10^-szDecimals.
    function _lot(uint8 weiDecimals, uint8 szDecimals) private pure returns (uint256) {
        return 10 ** (weiDecimals - szDecimals);
    }

    /// @dev USDC (1e18) a market sale of `amount` on the token's USDC pair could raise now, or
    ///      zero when Core would reject the order: whole lots only, at the best bid, and at least
    ///      the minimum order.
    function _sellable(uint32 pair, uint8 weiDecimals, uint8 szDecimals, uint256 amount)
        private
        view
        returns (uint256 value)
    {
        amount -= amount % _lot(weiDecimals, szDecimals);
        if (amount == 0) return 0;
        uint256 bid = uint256(CoreRead.bbo(SPOT_ASSET_BASE + pair).bid) * 10 ** (10 + szDecimals);
        value = Math.mulDiv(amount, bid, 10 ** weiDecimals);
        if (value < MIN_ORDER_USDC18) return 0;
    }

    /// @dev USDC6 held outside the spot ledger. Equity already includes PnL and paid funding:
    ///      never add position PnL a second time. A DEX ledger has no claim on the others, so a
    ///      negative one is not netted into an issuance price; for an exit it is a liability.
    function _usdcVenues(Scope storage s, address account, bool exit, bool liabilities)
        private
        view
        returns (int256 usdc6, bool)
    {
        uint256 count = s.dexes.length;
        for (uint256 i; i < count; ++i) {
            CoreRead.AccountMarginSummary memory m = CoreRead.accountMarginSummary(s.dexes[i], account);
            if (m.accountValue < 0 && !exit) revert NegativeDexEquity();
            usdc6 += m.accountValue;
            if (m.ntlPos != 0 || m.accountValue < 0) liabilities = true;
        }
        count = s.coreVaults.length;
        for (uint256 i; i < count; ++i) {
            usdc6 += int256(uint256(CoreRead.userVaultEquity(account, s.coreVaults[i]).equity));
        }
        return (usdc6, liabilities);
    }

    /// @dev USDC per whole token at 1e18, or zero when a guard refuses the price. Raw prices
    ///      carry 8 - szDecimals decimals. A failed read is an error, never a refused price.
    function _tryPrice(TokenState memory t) private view returns (uint256) {
        uint64 raw = CoreRead.spotPx(t.usdcSpot);
        if (raw == 0) return 0;
        if (t.reservePrice) {
            // Borrow oracle: the protocol's median of spot, perp mark and perp oracle. It can be
            // pinned or follow the book for a token without a perp, so it must agree with the mark.
            uint64 oracle = CoreRead.reserve(t.index).oraclePx;
            uint256 gap = oracle > raw ? oracle - raw : raw - oracle;
            if (oracle == 0 || gap * 10_000 > uint256(raw) * MAX_ORACLE_DEVIATION_BPS) return 0;
            raw = oracle;
        } else {
            CoreRead.Bbo memory book = CoreRead.bbo(SPOT_ASSET_BASE + t.usdcSpot);
            // A one-sided, crossed or wide book, or a price outside it, cannot price issuance.
            if (
                book.bid == 0 || book.ask < book.bid || raw < book.bid || raw > book.ask
                    || uint256(book.ask - book.bid) * 10_000 > uint256(book.ask) * MAX_SPREAD_BPS
            ) return 0;
        }
        return uint256(raw) * 10 ** (10 + t.szDecimals);
    }

    /// @dev Every entry leaving the scope, or losing its lending read, must hold nothing. What
    ///      nobody could sell (less than one lot, or less than the minimum order at the best bid)
    ///      may be left behind: a stranger's transfer must not pin a token to the scope.
    function _release(
        Scope storage s,
        address vault,
        Token[] calldata tokens,
        uint32[] calldata dexes,
        address[] calldata coreVaults
    ) private view {
        uint256 count = s.tokens.length;
        for (uint256 i; i < count; ++i) {
            TokenState memory old = s.tokens[i];
            bool kept;
            bool lending;
            for (uint256 j; j < tokens.length; ++j) {
                if (tokens[j].index == old.index) (kept, lending) = (true, tokens[j].lending);
            }
            if (kept && (lending || !old.lending)) continue;
            (uint256 held, uint256 borrowed,) = _ledger(vault, old.index, false);
            if (borrowed != 0) revert ScopeInUse();
            if (kept) {
                // Still in the scope, but its supply would no longer be counted.
                if (held >= _lot(old.weiDecimals, old.szDecimals)) revert ScopeInUse();
            } else {
                // USDC never leaves the scope, so the token has a USDC pair to be sold on.
                held += CoreRead.spotBalance(vault, old.index).total;
                if (_sellable(old.usdcSpot, old.weiDecimals, old.szDecimals, held) != 0) revert ScopeInUse();
            }
        }
        count = s.dexes.length;
        for (uint256 i; i < count; ++i) {
            uint32 dex = s.dexes[i];
            bool kept;
            for (uint256 j; j < dexes.length; ++j) {
                if (dexes[j] == dex) kept = true;
            }
            if (kept) continue;
            CoreRead.AccountMarginSummary memory m = CoreRead.accountMarginSummary(dex, vault);
            if (m.accountValue != 0 || m.marginUsed != 0 || m.ntlPos != 0 || m.rawUsd != 0) revert ScopeInUse();
        }
        count = s.coreVaults.length;
        for (uint256 i; i < count; ++i) {
            address coreVault = s.coreVaults[i];
            bool kept;
            for (uint256 j; j < coreVaults.length; ++j) {
                if (coreVaults[j] == coreVault) kept = true;
            }
            if (!kept && CoreRead.userVaultEquity(vault, coreVault).equity != 0) revert ScopeInUse();
        }
    }

    /// @dev Lending ledger of a token whose ledger is not counted, or is being dropped. The
    ///      precompile errors for an account without a ledger for the token. Only here is that
    ///      error read as "nothing supplied or borrowed", and only when it can have no other cause:
    ///      - a caller that starved the probe keeps at most 1/63 of the allowance (EIP-150);
    ///      - a read of the same shape that answers for every account must still fit the
    ///        allowance. `calibrated` says this was already checked in the current valuation.
    function _ledger(address account, uint32 token, bool calibrated)
        private
        view
        returns (uint256 supplied, uint256 borrowed, bool)
    {
        (bool ok, bytes memory data) =
            address(0x0811).staticcall{gas: LEDGER_PROBE_GAS}(abi.encode(account, uint64(token)));
        if (ok) {
            if (data.length != 128) revert InvalidObservation();
            CoreRead.UserLending memory l = abi.decode(data, (CoreRead.UserLending));
            // An answer within the allowance is itself the proof that the allowance suffices.
            return (l.supply.value, l.borrow.value, true);
        }
        if (gasleft() <= LEDGER_PROBE_GAS / 63) revert InvalidObservation();
        if (!calibrated) {
            // The validator DEX margin summary answers even for an account Core does not know.
            // It shows that a read of this shape still fits the allowance, not that the lending
            // precompile itself still answers.
            (ok, data) = address(0x080f).staticcall{gas: LEDGER_PROBE_GAS}(abi.encode(uint32(0), account));
            if (!ok || data.length != 128) revert InvalidObservation();
        }
        return (0, 0, true);
    }

    /// @dev Reverts while a reported venue still holds what was proven. Returns whether the
    ///      ledger probe's control read ran, so the valuation does not repeat it.
    function _unreported(Scope storage s, address vault) private view returns (bool calibrated) {
        uint256 count = s.reports.length;
        for (uint256 i; i < count; ++i) {
            Report memory r = s.reports[i];
            if (block.timestamp >= r.expiresAt) continue;
            bool stands;
            (stands, calibrated) = _stands(s, vault, r, calibrated);
            if (stands) revert OpenReport();
        }
    }

    function _report(address vault, Report memory r) private {
        Scope storage s = _scopes[vault];
        if (s.version == 0) revert ScopeUnavailable();
        bool stands;
        bool listed = s.reports.length != 0;
        if (listed) {
            Report memory kept = s.reports[0];
            if (block.timestamp < kept.expiresAt) (stands,) = _stands(s, vault, kept, false);
            if (stands) {
                // It keeps its place and its proof. Another venue's report could otherwise lift
                // it for the price of a bid that lasts one block, and a renewal could swap its
                // route for one the sender can switch off.
                if (kept.kind != r.kind || kept.id != r.id || kept.coreVault != r.coreVault) revert NotReportable();
                s.reports[0].expiresAt = uint64(block.timestamp + REPORT_TTL);
                emit ScopeReported(vault, r.kind, r.id, r.coreVault, msg.sender);
                return;
            }
        }
        (stands,) = _stands(s, vault, r, false);
        if (!stands) revert NotReportable();
        r.expiresAt = uint64(block.timestamp + REPORT_TTL);
        if (listed) s.reports[0] = r;
        else s.reports.push(r);
        emit ScopeReported(vault, r.kind, r.id, r.coreVault, msg.sender);
    }

    function _dropReport(Scope storage s, uint256 index) private {
        uint256 last = s.reports.length - 1;
        if (index != last) s.reports[index] = s.reports[last];
        s.reports.pop();
    }

    /// @dev Whether the scope counts the venue a report names.
    function _registered(Scope storage s, Report memory r) private view returns (bool) {
        if (r.kind == ReportKind.Dex) {
            uint256 dexes = s.dexes.length;
            for (uint256 i; i < dexes; ++i) {
                if (s.dexes[i] == r.id) return true;
            }
        } else if (r.kind == ReportKind.CoreVault) {
            uint256 coreVaults = s.coreVaults.length;
            for (uint256 i; i < coreVaults; ++i) {
                if (s.coreVaults[i] == r.coreVault) return true;
            }
        } else {
            uint256 count = s.tokens.length;
            for (uint256 i; i < count; ++i) {
                if (s.tokens[i].index == r.id) return true;
            }
        }
        return false;
    }

    /// @dev Whether the reported venue holds something material now that the scope does not
    ///      answer for. A registered DEX or HyperCore vault is counted in full. A registered
    ///      token is counted in an exit only for what its own USDC pair would pay: while that is
    ///      nothing, a holding that sells on another pair is as unseen as one outside the scope,
    ///      so registering a token puts it beyond reports only while the scope counts it. Such a
    ///      holding must be worth twice the minimum order elsewhere: a remainder its own pair
    ///      values just under the minimum is not hidden because another pair bids a little more.
    function _stands(Scope storage s, address vault, Report memory r, bool calibrated)
        private
        view
        returns (bool, bool)
    {
        if (r.kind != ReportKind.Token) {
            if (_registered(s, r)) return (false, calibrated);
        } else if (r.id == usdcToken) {
            return (false, calibrated); // always in the scope, and counted in full
        }
        if (r.kind == ReportKind.Dex) {
            CoreRead.AccountMarginSummary memory m = CoreRead.accountMarginSummary(r.id, vault);
            return (m.ntlPos != 0 || m.accountValue >= MIN_ORDER_USDC6, calibrated);
        }
        if (r.kind == ReportKind.CoreVault) {
            return (CoreRead.userVaultEquity(vault, r.coreVault).equity >= uint64(MIN_ORDER_USDC6), calibrated);
        }
        uint256 held;
        uint256 borrowed;
        (held, borrowed, calibrated) = _ledger(vault, r.id, calibrated);
        held += CoreRead.spotBalance(vault, r.id).total;
        uint256 least = MIN_ORDER_USDC18;
        uint256 count = s.tokens.length;
        for (uint256 i; i < count; ++i) {
            TokenState memory t = s.tokens[i];
            if (t.index != r.id) continue;
            // Registered: the scope answers for its debt, and for what its pair can sell.
            if (borrowed != 0 || _sellable(t.usdcSpot, t.weiDecimals, t.szDecimals, held) != 0) {
                return (false, calibrated);
            }
            least = 2 * MIN_ORDER_USDC18;
            break;
        }
        if (borrowed != 0) return (true, calibrated);
        held -= held % _lot(r.weiDecimals, r.szDecimals);
        if (held == 0) return (false, calibrated);
        // Raw prices carry 8 - szDecimals of their own base token. Core's minimum order is 10 of
        // the pair's quote token, so a routed holding must clear it at both hops to be sold.
        uint256 value = Math.mulDiv(
            held, uint256(CoreRead.bbo(SPOT_ASSET_BASE + r.pair).bid) * 10 ** (10 + r.szDecimals), 10 ** r.weiDecimals
        );
        if (value < MIN_ORDER_USDC18 || !r.viaQuote) return (value >= least, calibrated);
        value = Math.mulDiv(
            value, uint256(CoreRead.bbo(SPOT_ASSET_BASE + r.quotePair).bid) * 10 ** (10 + r.quoteSzDecimals), 1e18
        );
        return (value >= least, calibrated);
    }
}
