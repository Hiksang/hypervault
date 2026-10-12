// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC7540Operator, IERC7540Redeem} from "../interfaces/IERC7540.sol";

/// @notice Unique ERC-7540 request IDs sharing an internal settlement epoch.
/// @dev Fees are charged on realized gains, with address-local loss/rounding carry.
abstract contract ManagedRedeem is ERC4626, ReentrancyGuard, IERC7540Operator, IERC7540Redeem {
    using SafeERC20 for IERC20;

    struct Epoch {
        uint256 requestedShares;
        uint256 unclaimedShares;
        uint256 numerator;
        uint256 denominator;
        uint256 reserve;
        bool isSealed;
        bool settled;
    }

    struct Request {
        address controller;
        uint256 epoch;
        uint256 shares;
        uint256 basis;
        uint256 consumedShares;
        uint256 paidNet;
        uint256 paidFee;
        uint256 paidPlatform;
        uint256 gross;
        uint256 fee;
        uint256 platformFee;
        bool priced;
        uint16 feeBps;
    }

    struct FeeQuote {
        uint256 gross;
        uint256 fee;
        uint256 platformFee;
        uint256 nextLoss;
        uint256 feeFraction;
        uint256 platformFraction;
    }

    address public immutable owner;
    address public immutable treasury;
    uint256 public performanceFeeBps;
    uint256 public constant PLATFORM_SHARE_BPS = 2000;
    uint256 public accountedCash;
    uint256 public reservedClaimAssets;
    uint256 public roundingReserve;
    uint256 public nextRequestId = 1;
    uint256 public nextEpochId = 1;
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => Request) public requests;
    mapping(address => uint256) public controllerRequest;
    mapping(address => uint256) public basisUsdc;
    mapping(address => uint256) public lossCarry;
    mapping(address => uint256) public feeRemainder;
    uint256 public platformRemainder;
    mapping(address => mapping(address => bool)) private _operators;
    bool private _escrowing;

    error Unauthorized();
    error InvalidAmount();
    error InvalidReceiver();
    error OutstandingRequest();
    error NotClaimable();
    error EpochClosed();
    error AsyncPreviewUnsupported();
    error NonTransferableShares();
    error CashDeficit();
    error BalanceMismatch();

    event EpochSettled(uint256 indexed epoch, uint256 shares, uint256 grossAssets);
    event PerformanceFeePaid(uint256 indexed requestId, uint256 userAssets, uint256 managerFee, uint256 platformFee);
    event RequestPriced(uint256 indexed requestId, uint256 gross, uint256 fee, uint256 platformFee);
    event RoundingDustReleased(uint256 assets);

    constructor(IERC20 usdc_, address owner_, address treasury_)
        ERC20("Managed HyperCore USDC Share", "mvUSDC")
        ERC4626(usdc_)
    {
        if (owner_ == address(0) || treasury_ == address(0) || treasury_ == address(this)) revert InvalidReceiver();
        owner = owner_;
        treasury = treasury_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function name() public view virtual override(ERC20, IERC20Metadata) returns (string memory) {
        return "Managed HyperCore USDC Share";
    }

    function symbol() public view virtual override(ERC20, IERC20Metadata) returns (string memory) {
        return "mvUSDC";
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    function share() external view returns (address) {
        return address(this);
    }

    function vault(address underlying) external view returns (address) {
        return underlying == asset() ? address(this) : address(0);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x2f0a18c5 || id == bytes4(keccak256("vault(address)"))
            || id == type(IERC7540Operator).interfaceId || id == type(IERC7540Redeem).interfaceId;
    }

    function availableCash() public view returns (uint256) {
        if (IERC20(asset()).balanceOf(address(this)) < accountedCash || accountedCash < reservedClaimAssets) {
            revert CashDeficit();
        }
        return accountedCash - reservedClaimAssets;
    }

    function unaccountedUsdc() external view returns (uint256) {
        uint256 actual = IERC20(asset()).balanceOf(address(this));
        if (actual < accountedCash) revert CashDeficit();
        return actual - accountedCash;
    }

    function isOperator(address controller, address operator) public view returns (bool) {
        return _operators[controller][operator];
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        _operators[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    function _authorize(address controller) internal view {
        if (msg.sender != controller && !isOperator(controller, msg.sender)) revert Unauthorized();
    }

    function requestRedeem(uint256 shares, address controller, address shareOwner)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (shares == 0 || shares > balanceOf(shareOwner)) revert InvalidAmount();
        if (controller != shareOwner || controller == address(0) || controller == address(this)) {
            revert InvalidReceiver();
        }
        if (controllerRequest[controller] != 0) revert OutstandingRequest();
        (uint256 epochId, bool instant) = _requestEpoch();
        Epoch storage e = epochs[epochId];
        if (e.isSealed || e.settled) revert EpochClosed();
        if (msg.sender != shareOwner && !isOperator(shareOwner, msg.sender)) {
            _spendAllowance(shareOwner, msg.sender, shares);
        }
        uint256 basis = Math.mulDiv(basisUsdc[shareOwner], shares, balanceOf(shareOwner));
        basisUsdc[shareOwner] -= basis;
        id = nextRequestId++;
        Request storage r = requests[id];
        r.controller = controller;
        r.epoch = epochId;
        r.shares = shares;
        r.basis = basis;
        r.feeBps = uint16(performanceFeeBps);
        controllerRequest[controller] = id;
        e.requestedShares += shares;
        _escrowing = true;
        _transfer(shareOwner, address(this), shares);
        _escrowing = false;
        emit RedeemRequest(controller, shareOwner, id, msg.sender, shares);
        if (instant) {
            e.isSealed = true;
            _settle(epochId);
        }
    }

    function pendingRedeemRequest(uint256 id, address controller) public view returns (uint256) {
        Request storage r = requests[id];
        return r.controller == controller && !epochs[r.epoch].settled ? r.shares : 0;
    }

    function claimableRedeemRequest(uint256 id, address controller) public view returns (uint256) {
        Request storage r = requests[id];
        return r.controller == controller && epochs[r.epoch].settled ? r.shares - r.consumedShares : 0;
    }

    function maxRedeem(address controller) public view override returns (uint256) {
        return claimableRedeemRequest(controllerRequest[controller], controller);
    }

    function maxWithdraw(address controller) public view override returns (uint256) {
        Request storage r = requests[controllerRequest[controller]];
        if (r.controller != controller || !epochs[r.epoch].settled) return 0;
        FeeQuote memory q = _quote(r);
        return q.gross - q.fee - r.paidNet;
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
        _authorize(controller);
        uint256 id = controllerRequest[controller];
        Request storage r = requests[id];
        if (shares == 0 || shares > maxRedeem(controller)) revert NotClaimable();
        _price(id);
        uint256 cumulative = r.consumedShares + shares;
        assets = Math.mulDiv(r.gross - r.fee, cumulative, r.shares) - r.paidNet;
        _claim(id, receiver, shares, assets);
    }

    function withdraw(uint256 assets, address receiver, address controller)
        public
        override
        nonReentrant
        returns (uint256 shares)
    {
        _authorize(controller);
        uint256 id = controllerRequest[controller];
        Request storage r = requests[id];
        if (assets == 0 || assets > maxWithdraw(controller)) revert NotClaimable();
        _price(id);
        uint256 net = r.gross - r.fee;
        uint256 cumulative = Math.mulDiv(r.paidNet + assets, r.shares, net, Math.Rounding.Ceil);
        if (cumulative <= r.consumedShares || (cumulative == r.shares && r.paidNet + assets != net)) {
            revert InvalidAmount();
        }
        shares = cumulative - r.consumedShares;
        _claim(id, receiver, shares, assets);
    }

    function _quote(Request storage r) private view returns (FeeQuote memory q) {
        if (r.priced) {
            q.gross = r.gross;
            q.fee = r.fee;
            q.platformFee = r.platformFee;
            return q;
        }
        Epoch storage e = epochs[r.epoch];
        q.gross = Math.mulDiv(r.shares, e.numerator, e.denominator);
        if (r.controller == owner) return q;
        uint256 prior = lossCarry[r.controller];
        uint256 profit = q.gross > r.basis ? q.gross - r.basis : 0;
        uint256 loss = r.basis > q.gross ? r.basis - q.gross : 0;
        uint256 offset = Math.min(profit, prior);
        q.nextLoss = prior + loss - offset;
        uint256 feeUnits = (profit - offset) * r.feeBps + feeRemainder[r.controller];
        q.fee = feeUnits / 10_000;
        q.feeFraction = feeUnits % 10_000;
        uint256 platformUnits = q.fee * PLATFORM_SHARE_BPS + platformRemainder;
        q.platformFee = platformUnits / 10_000;
        q.platformFraction = platformUnits % 10_000;
    }

    function _price(uint256 id) private {
        Request storage r = requests[id];
        if (r.priced) return;
        FeeQuote memory q = _quote(r);
        r.priced = true;
        r.gross = q.gross;
        r.fee = q.fee;
        r.platformFee = q.platformFee;
        if (r.controller != owner) {
            lossCarry[r.controller] = q.nextLoss;
            feeRemainder[r.controller] = q.feeFraction;
            platformRemainder = q.platformFraction;
        }
        emit RequestPriced(id, q.gross, q.fee, q.platformFee);
    }

    function _claim(uint256 id, address receiver, uint256 shares, uint256 net) private {
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        Request storage r = requests[id];
        Epoch storage e = epochs[r.epoch];
        uint256 cumulative = r.consumedShares + shares;
        uint256 cumulativeFee = Math.mulDiv(r.fee, cumulative, r.shares);
        uint256 cumulativePlatform = r.fee == 0 ? 0 : Math.mulDiv(r.platformFee, cumulativeFee, r.fee);
        uint256 fee = cumulativeFee - r.paidFee;
        uint256 platform = cumulativePlatform - r.paidPlatform;
        uint256 gross = net + fee;
        r.consumedShares = cumulative;
        r.paidNet += net;
        r.paidFee = cumulativeFee;
        r.paidPlatform = cumulativePlatform;
        e.unclaimedShares -= shares;
        e.reserve -= gross;
        reservedClaimAssets -= gross;
        if (cumulative == r.shares) delete controllerRequest[r.controller];
        if (e.unclaimedShares == 0) {
            roundingReserve += e.reserve;
            e.reserve = 0;
        }
        _pay(receiver, net);
        _pay(owner, fee - platform);
        _pay(treasury, platform);
        emit Withdraw(msg.sender, receiver, r.controller, net, shares);
        emit PerformanceFeePaid(id, net, fee - platform, platform);
    }

    function _pay(address receiver, uint256 amount) private {
        if (IERC20(asset()).balanceOf(address(this)) < accountedCash) revert CashDeficit();
        accountedCash -= amount;
        if (amount != 0) IERC20(asset()).safeTransfer(receiver, amount);
    }

    function releaseRoundingDust() external nonReentrant {
        uint256 amount = roundingReserve;
        roundingReserve = 0;
        reservedClaimAssets -= amount;
        _pay(treasury, amount);
        emit RoundingDustReleased(amount);
    }

    function _settle(uint256 epochId) internal {
        Epoch storage e = epochs[epochId];
        if (!e.isSealed || e.settled) revert EpochClosed();
        uint256 cash = availableCash();
        uint256 supply = totalSupply();
        uint256 q = e.requestedShares;
        e.settled = true;
        e.numerator = cash == 0 ? 0 : (q == supply ? cash : cash + 1);
        e.denominator = q == supply && supply != 0 ? supply : supply + 1000;
        e.reserve = Math.mulDiv(q, e.numerator, e.denominator);
        e.unclaimedShares = q;
        reservedClaimAssets += e.reserve;
        if (q != 0) _burn(address(this), q);
        emit EpochSettled(epochId, q, e.reserve);
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (amount != 0 && from != address(0) && to != address(0) && !(_escrowing && to == address(this))) {
            revert NonTransferableShares();
        }
        super._update(from, to, amount);
    }

    function _requestEpoch() internal virtual returns (uint256 epochId, bool instant);
}
