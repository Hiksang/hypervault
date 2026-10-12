// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CoreRead} from "../CoreRead.sol";
import {IWrappedHype} from "../interfaces/IWrappedHype.sol";
import {ManagedCoreActions} from "./ManagedCoreActions.sol";

interface IAssetCircleDeposit {
    function deposit(uint256 amount, uint32 dex) external;
}

/// @notice Immutable, stateless transport module. Delegatecall preserves the Vault's Core identity.
/// @dev Deploy only reviewed USDC/WHYPE/linked UBTC configurations. No arbitrary call entrypoint.
contract ManagedAssetBridge {
    using SafeERC20 for IERC20;
    enum Kind {
        Usdc,
        NativeHype,
        LinkedToken
    }
    address private immutable SELF = address(this);
    address public immutable asset;
    address public immutable activationAsset;
    address public immutable circle;
    address public immutable systemAddress;
    Kind public immutable kind;
    uint32 public immutable coreToken;
    uint32 public immutable spotPair;
    uint8 public immutable assetDecimals;
    uint8 public immutable coreDecimals;
    uint8 public immutable szDecimals;
    error InvalidAsset();
    error OnlyDelegateCall();
    error InvalidAmount();
    error TransferMismatch();
    error PriceUnavailable();

    constructor(address token, address usdc, address circle_, Kind kind_, uint32 index, uint32 pair) {
        if (token.code.length == 0 || usdc.code.length == 0 || circle_.code.length == 0) revert InvalidAsset();
        CoreRead.TokenInfo memory info = CoreRead.tokenInfo(index);
        uint8 d = IERC20Metadata(token).decimals();
        if (d > 18 || info.weiDecimals > 18 || info.szDecimals > 8 || IERC20Metadata(usdc).decimals() != 6) {
            revert InvalidAsset();
        }
        if (kind_ == Kind.Usdc) {
            if (
                token != usdc || d != 6 || index != 0 || info.evmContract != circle_
                    || info.szDecimals != info.weiDecimals
                    || int256(uint256(info.weiDecimals)) + info.evmExtraWeiDecimals != 6
            ) revert InvalidAsset();
        } else {
            CoreRead.SpotInfo memory market = CoreRead.spotInfo(pair);
            if (market.tokens[0] != index || market.tokens[1] != 0) revert InvalidAsset();
            if (kind_ == Kind.NativeHype) {
                if (index != 150 || d != 18 || info.weiDecimals != 8) revert InvalidAsset();
            } else if (
                index != 197 || info.evmContract != token
                    || int256(uint256(d)) - int256(uint256(info.weiDecimals)) != info.evmExtraWeiDecimals
            ) {
                revert InvalidAsset();
            }
        }
        asset = token;
        activationAsset = usdc;
        circle = circle_;
        kind = kind_;
        coreToken = index;
        spotPair = pair;
        assetDecimals = d;
        coreDecimals = info.weiDecimals;
        szDecimals = info.szDecimals;
        systemAddress = kind_ == Kind.NativeHype
            ? 0x2222222222222222222222222222222222222222
            : address(uint160(0x2000000000000000000000000000000000000000) + uint160(index));
    }

    modifier delegated() {
        if (address(this) == SELF) revert OnlyDelegateCall();
        _;
    }

    /// @dev Activation USDC is pulled separately; never minted as HYPE/UBTC principal.
    function activate(uint256 amount) external delegated {
        IERC20 token = IERC20(activationAsset);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        if (token.balanceOf(address(this)) != beforeBalance + amount) revert TransferMismatch();
        token.forceApprove(circle, amount);
        IAssetCircleDeposit(circle).deposit(amount, type(uint32).max);
        token.forceApprove(circle, 0);
        if (token.balanceOf(address(this)) != beforeBalance) revert TransferMismatch();
    }

    function depositCore(uint256 amount) external delegated {
        toCore(amount); // reject decimal dust and uint64 overflow before sending
        IERC20 token = IERC20(asset);
        uint256 beforeBalance = token.balanceOf(address(this));
        if (kind == Kind.Usdc) {
            token.forceApprove(circle, amount);
            IAssetCircleDeposit(circle).deposit(amount, type(uint32).max);
            token.forceApprove(circle, 0);
        } else if (kind == Kind.NativeHype) {
            IWrappedHype(asset).withdraw(amount);
            (bool ok,) = payable(systemAddress).call{value: amount}("");
            if (!ok) revert TransferMismatch();
        } else {
            token.safeTransfer(systemAddress, amount);
        }
        if (beforeBalance - token.balanceOf(address(this)) != amount) revert TransferMismatch();
    }

    function wrapReturnedNative() external delegated {
        if (kind == Kind.NativeHype && address(this).balance != 0) {
            IWrappedHype(asset).deposit{value: address(this).balance}();
        }
    }

    function toCore(uint256 amount) public view returns (uint64) {
        uint256 units;
        if (assetDecimals >= coreDecimals) {
            uint256 scale = 10 ** (assetDecimals - coreDecimals);
            if (amount % scale != 0) revert InvalidAmount();
            units = amount / scale;
        } else {
            units = amount * 10 ** (coreDecimals - assetDecimals);
        }
        if (units == 0 || units > type(uint64).max) revert InvalidAmount();
        return uint64(units);
    }

    function recallPayload(uint32 dex, uint256 amount) external view returns (bytes memory) {
        return ManagedCoreActions.move(systemAddress, coreToken, dex, type(uint32).max, toCore(amount));
    }

    /// @notice Guarded precompile reserve price in USDC18 per whole asset.
    function priceUsdc18() public view returns (uint256) {
        if (kind == Kind.Usdc) return 1e18;
        uint256 mark = CoreRead.spotPx(spotPair);
        uint256 oracle = CoreRead.reserve(coreToken).oraclePx;
        uint256 gap = mark > oracle ? mark - oracle : oracle - mark;
        if (mark == 0 || oracle == 0 || gap * 10_000 > mark * 200) revert PriceUnavailable();
        return oracle * 10 ** (10 + szDecimals);
    }

    function fromUsdc18(uint256 amount) external view returns (uint256) {
        return Math.mulDiv(amount, 10 ** assetDecimals, priceUsdc18());
    }

    /// @notice 100 USDC equivalent of founder principal, rounded up to Core-representable units.
    function minimumFounderAssets() external view returns (uint256) {
        uint256 amount = Math.mulDiv(100e18, 10 ** assetDecimals, priceUsdc18(), Math.Rounding.Ceil);
        uint256 quantum = assetDecimals > coreDecimals ? 10 ** (assetDecimals - coreDecimals) : 1;
        return Math.ceilDiv(amount, quantum) * quantum;
    }
}
