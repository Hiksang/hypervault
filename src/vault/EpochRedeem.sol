// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7540Operator, IERC7540Redeem} from "../interfaces/IERC7540.sol";

/// @dev Fixed-rate, whole-epoch fulfillment. Shares burn at fulfillment, never at claim.
abstract contract EpochRedeem is ERC4626, ReentrancyGuard, IERC7540Operator, IERC7540Redeem {
    using SafeERC20 for IERC20;

    struct RedeemEpoch {
        uint256 requestedShares;
        uint256 remainingClaimShares;
        uint256 rateNumerator;
        uint256 rateDenominator;
        uint256 reservedAssetsRemaining;
        bool isSealed;
        bool settled;
    }

    struct Request {
        uint256 requestedShares;
        uint256 consumedShares;
        uint256 paidAssets;
    }

    uint256 public nextEpochId = 1;
    uint256 public reservedClaimAssets;
    // Completed epochs' undistributed rounding dust; excluded from shareholder assets.
    uint256 public roundingReserve;
    address public immutable dustRecipient;
    mapping(uint256 => RedeemEpoch) public epochs;
    mapping(uint256 => mapping(address => Request)) public requests;
    mapping(address => uint256) public controllerEpoch;
    mapping(address => mapping(address => bool)) private _operators;
    bool private _escrowing;

    error InvalidAmount();
    error InvalidReceiver();
    error UnauthorizedController();
    error ControllerEpochOutstanding();
    error NotClaimable();
    error EpochClosed();
    error AsyncPreviewUnsupported();
    error DirectShareTransferForbidden();

    event EpochSettled(uint256 indexed epochId, uint256 shares, uint256 assets);
    event RoundingDustReleased(uint256 assets);

    constructor(IERC20 asset_, address dustRecipient_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
        ERC4626(asset_)
    {
        if (dustRecipient_ == address(0) || dustRecipient_ == address(this)) {
            revert InvalidReceiver();
        }
        dustRecipient = dustRecipient_;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    function share() external view returns (address) {
        return address(this);
    }

    function isOperator(address controller, address operator) public view returns (bool) {
        return _operators[controller][operator];
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        _operators[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    function _authorizeController(address controller) internal view {
        if (msg.sender != controller && !isOperator(controller, msg.sender)) revert UnauthorizedController();
    }

    function requestRedeem(uint256 shares, address controller, address owner)
        external
        nonReentrant
        returns (uint256 requestId)
    {
        if (shares == 0) revert InvalidAmount();
        if (controller == address(0) || controller == address(this) || owner == address(this)) {
            revert InvalidReceiver();
        }
        (uint256 id, bool instant) = _requestEpoch();
        uint256 prior = controllerEpoch[controller];
        if (prior != 0 && prior != id) revert ControllerEpochOutstanding();
        RedeemEpoch storage epoch = epochs[id];
        if (epoch.isSealed || epoch.settled) revert EpochClosed();
        if (msg.sender != owner && !isOperator(owner, msg.sender)) _spendAllowance(owner, msg.sender, shares);
        controllerEpoch[controller] = id;
        requests[id][controller].requestedShares += shares;
        epoch.requestedShares += shares;
        _escrowing = true;
        _transfer(owner, address(this), shares);
        _escrowing = false;
        emit RedeemRequest(controller, owner, id, msg.sender, shares);
        if (instant) {
            epoch.isSealed = true;
            _settleRedeemEpoch(id, _settlementCash());
        }
        return id;
    }

    function pendingRedeemRequest(uint256 id, address controller) public view returns (uint256) {
        return epochs[id].settled ? 0 : requests[id][controller].requestedShares;
    }

    function claimableRedeemRequest(uint256 id, address controller) public view returns (uint256) {
        Request storage r = requests[id][controller];
        return epochs[id].settled ? r.requestedShares - r.consumedShares : 0;
    }

    function maxRedeem(address controller) public view override returns (uint256) {
        return claimableRedeemRequest(controllerEpoch[controller], controller);
    }

    function maxWithdraw(address controller) public view override returns (uint256) {
        uint256 id = controllerEpoch[controller];
        if (!epochs[id].settled) return 0;
        Request storage r = requests[id][controller];
        return Math.mulDiv(r.requestedShares, epochs[id].rateNumerator, epochs[id].rateDenominator) - r.paidAssets;
    }

    function previewRedeem(uint256) public pure override returns (uint256) {
        revert AsyncPreviewUnsupported();
    }

    function previewWithdraw(uint256) public pure override returns (uint256) {
        revert AsyncPreviewUnsupported();
    }

    function redeem(uint256 shares, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 assets)
    {
        _authorizeController(controller);
        uint256 remaining = maxRedeem(controller);
        if (shares == 0 || shares > remaining) revert NotClaimable();
        RedeemEpoch storage epoch = epochs[controllerEpoch[controller]];
        uint256 maxAssets = maxWithdraw(controller);
        assets = shares == remaining ? maxAssets : Math.mulDiv(shares, epoch.rateNumerator, epoch.rateDenominator);
        if (assets > maxAssets) revert InvalidAmount();
        _claim(controller, receiver, shares, assets);
    }

    function withdraw(uint256 assets, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _authorizeController(controller);
        uint256 limit = maxWithdraw(controller);
        if (assets == 0 || assets > limit) revert NotClaimable();
        RedeemEpoch storage epoch = epochs[controllerEpoch[controller]];
        shares = assets == limit
            ? maxRedeem(controller)
            : Math.mulDiv(assets, epoch.rateDenominator, epoch.rateNumerator, Math.Rounding.Ceil);
        if (shares == 0 || shares > maxRedeem(controller)) revert InvalidAmount();
        if (shares == maxRedeem(controller) && assets != limit) revert InvalidAmount();
        _claim(controller, receiver, shares, assets);
    }

    function _claim(address controller, address receiver, uint256 shares, uint256 assets) private {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        uint256 id = controllerEpoch[controller];
        Request storage r = requests[id][controller];
        RedeemEpoch storage epoch = epochs[id];
        r.consumedShares += shares;
        r.paidAssets += assets;
        epoch.remainingClaimShares -= shares;
        epoch.reservedAssetsRemaining -= assets;
        reservedClaimAssets -= assets;
        if (r.consumedShares == r.requestedShares) delete controllerEpoch[controller];
        if (epoch.remainingClaimShares == 0) {
            roundingReserve += epoch.reservedAssetsRemaining;
            epoch.reservedAssetsRemaining = 0;
        }
        _beforeAssetPayout(assets);
        IERC20(asset()).safeTransfer(receiver, assets);
        emit Withdraw(msg.sender, receiver, controller, assets, shares);
    }

    /// @notice Pays completed-epoch dust only to the immutable protocol recipient.
    function releaseRoundingDust() external nonReentrant {
        uint256 amount = roundingReserve;
        roundingReserve = 0;
        reservedClaimAssets -= amount;
        _beforeAssetPayout(amount);
        IERC20(asset()).safeTransfer(dustRecipient, amount);
        emit RoundingDustReleased(amount);
    }

    function _settleRedeemEpoch(uint256 id, uint256 cash) internal {
        RedeemEpoch storage epoch = epochs[id];
        if (!epoch.isSealed || epoch.settled) revert EpochClosed();
        uint256 q = epoch.requestedShares;
        uint256 supply = totalSupply();
        epoch.settled = true;
        uint256 numerator = cash == 0 ? 0 : (q == supply ? cash : cash + 1);
        uint256 denominator = q == supply && supply != 0 ? supply : supply + 1000;
        uint256 reserve = Math.mulDiv(q, numerator, denominator);
        epoch.rateNumerator = numerator;
        epoch.rateDenominator = denominator;
        epoch.remainingClaimShares = q;
        epoch.reservedAssetsRemaining = reserve;
        reservedClaimAssets += reserve;
        if (q != 0) _burn(address(this), q);
        emit EpochSettled(id, q, reserve);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Zero-value transfers still follow ERC20 validation and emit Transfer without moving escrow.
        if (value != 0 && (to == address(this) || from == address(this)) && !_escrowing && to != address(0)) {
            revert DirectShareTransferForbidden();
        }
        super._update(from, to, value);
    }
    function _requestEpoch() internal virtual returns (uint256 id, bool instant);
    function _settlementCash() internal view virtual returns (uint256);
    function _beforeAssetPayout(uint256) internal virtual {}
}
