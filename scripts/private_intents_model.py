"""Offline accounting model for the proposed Zcash -> HyperCore intent flow.

Every ``mock_*`` method consumes a *scenario assertion*, not chain evidence.
This module never connects to Zcash, a solver, or Hyperliquid and must not be
used to custody funds or authorize orders or withdrawals.
"""

from copy import deepcopy
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation


class InvalidTransition(ValueError):
    pass


def amount(value, name: str, *, allow_zero: bool = False) -> Decimal:
    if isinstance(value, (float, bool)):
        raise InvalidTransition(f"{name}: use an exact decimal string")
    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError):
        raise InvalidTransition(f"{name}: invalid decimal") from None
    if not result.is_finite() or result < 0 or (result == 0 and not allow_zero):
        raise InvalidTransition(f"{name}: expected finite positive amount")
    return result


@dataclass
class Order:
    order_id: str
    quantity: Decimal
    limit_price: Decimal
    filled: Decimal = Decimal(0)
    terminal: bool = False


@dataclass
class Account:
    owner_commitment: str
    nonce: str
    market: str
    side: str
    quantity: Decimal
    open_limit: Decimal
    min_usdc_out: Decimal
    leverage: int
    deadline: int
    deposit_receipt: str | None = None
    deposit_zec: Decimal = Decimal(0)
    conversion_receipt: str | None = None
    core_credit_receipt: str | None = None
    cash: Decimal = Decimal(0)
    locked_margin: Decimal = Decimal(0)
    open_order: Order | None = None
    close_order: Order | None = None
    position_quantity: Decimal = Decimal(0)
    entry_notional: Decimal = Decimal(0)
    pending_payout: Decimal = Decimal(0)
    pending_min_zec: Decimal = Decimal(0)
    core_return_receipt: str | None = None
    completed: bool = False

    @property
    def equity_at_cost(self) -> Decimal:
        """Book value only; excludes unrealized PnL and is not a NAV quote."""
        return self.cash + self.locked_margin


@dataclass
class PrivateIntentsModel:
    accounts: dict[str, Account] = field(default_factory=dict)
    used_nonces: set[tuple[str, str]] = field(default_factory=set)
    used_receipts: set[str] = field(default_factory=set)
    used_orders: set[str] = field(default_factory=set)
    used_fills: set[str] = field(default_factory=set)
    batches: dict[str, tuple[object, Decimal]] = field(default_factory=dict)
    batched_order_ids: dict[str, str] = field(default_factory=dict)
    pool_certified: bool = False

    def register(self, intent_id: str, owner_commitment: str, nonce: str,
                 market: str, side: str, quantity, open_limit, min_usdc_out,
                 leverage: int, deadline: int, now: int) -> None:
        if not all((intent_id, owner_commitment, nonce, market)):
            raise InvalidTransition("missing intent identifier")
        if self.pool_certified:
            raise InvalidTransition("settlement epoch is closed")
        if intent_id in self.accounts or (owner_commitment, nonce) in self.used_nonces:
            raise InvalidTransition("replayed intent or nonce")
        if side not in ("long", "short") or type(leverage) is not int or leverage <= 0:
            raise InvalidTransition("invalid side or leverage")
        if deadline <= now:
            raise InvalidTransition("expired intent")
        self.accounts[intent_id] = Account(
            owner_commitment, nonce, market, side, amount(quantity, "quantity"),
            amount(open_limit, "open limit"), amount(min_usdc_out, "min USDC out"),
            leverage, deadline,
        )
        self.used_nonces.add((owner_commitment, nonce))

    def mock_confirm_deposit(self, intent_id: str, receipt_id: str, zec_amount) -> None:
        account = self.accounts[intent_id]
        self._ensure_open_epoch()
        self._new_receipt(receipt_id)
        if account.deposit_receipt is not None:
            raise InvalidTransition("deposit already attributed")
        account.deposit_zec = amount(zec_amount, "ZEC deposit")
        account.deposit_receipt = receipt_id
        self.used_receipts.add(receipt_id)

    def mock_settle_conversion(self, intent_id: str, receipt_id: str,
                               zec_spent, usdc_received) -> None:
        account = self.accounts[intent_id]
        self._ensure_open_epoch()
        self._new_receipt(receipt_id)
        zec_spent = amount(zec_spent, "ZEC spent")
        usdc_received = amount(usdc_received, "USDC received")
        if account.deposit_receipt is None or account.conversion_receipt is not None:
            raise InvalidTransition("conversion has no unspent deposit")
        if zec_spent != account.deposit_zec or usdc_received < account.min_usdc_out:
            raise InvalidTransition("conversion violates deposit or minimum output")
        account.cash = usdc_received
        account.conversion_receipt = receipt_id
        self.used_receipts.add(receipt_id)

    def submit_open(self, intent_id: str, order_id: str, now: int) -> None:
        account = self.accounts[intent_id]
        self._ensure_open_epoch()
        self._new_order(order_id)
        if account.core_credit_receipt is None or account.open_order is not None:
            raise InvalidTransition("open order is not ready")
        if now > account.deadline:
            raise InvalidTransition("intent expired before order submission")
        if account.cash < account.quantity * account.open_limit / account.leverage:
            raise InvalidTransition("insufficient margin at limit price")
        account.open_order = Order(order_id, account.quantity, account.open_limit)
        self.used_orders.add(order_id)

    def mock_confirm_core_credit(self, intent_id: str, receipt_id: str,
                                 usdc_received) -> None:
        account = self.accounts[intent_id]
        self._ensure_open_epoch()
        self._new_receipt(receipt_id)
        if account.conversion_receipt is None or account.core_credit_receipt is not None:
            raise InvalidTransition("Core credit has no pending conversion")
        if amount(usdc_received, "Core USDC credit") != account.cash:
            raise InvalidTransition("Core credit differs from attributed USDC")
        account.core_credit_receipt = receipt_id
        self.used_receipts.add(receipt_id)

    def submit_open_batch(self, batch, lot_size, now: int) -> None:
        """Prepare one pooled opening order and bind its private allocation."""
        from scripts.private_intents_batch import PooledOrderBatch

        self._ensure_open_epoch()
        if not isinstance(batch, PooledOrderBatch) or batch.batch_id in self.batches:
            raise InvalidTransition("invalid or replayed pooled batch")
        if batch.filled_lots or batch.seen_fills or batch.terminal:
            raise InvalidTransition("batch already has execution history")
        lot_size = amount(lot_size, "lot size")
        for member in batch.members:
            if member.intent_id not in self.accounts:
                raise InvalidTransition("unknown batch member")
            account = self.accounts[member.intent_id]
            internal_order_id = f"{batch.batch_id}:{member.intent_id}"
            if internal_order_id in self.used_orders or account.open_order is not None:
                raise InvalidTransition("member already has an opening order")
            if account.core_credit_receipt is None or now > account.deadline:
                raise InvalidTransition("member is unfunded or expired")
            if account.market != batch.market or account.side != batch.side or (
                account.quantity != member.lots * lot_size
            ):
                raise InvalidTransition("member does not match batch market or lots")
            if (account.side == "long" and batch.limit_price > account.open_limit) or (
                account.side == "short" and batch.limit_price < account.open_limit
            ):
                raise InvalidTransition("batch violates signed intent limit")
            if account.cash < account.quantity * batch.limit_price / account.leverage:
                raise InvalidTransition("member margin is insufficient")
        for member in batch.members:
            internal_order_id = f"{batch.batch_id}:{member.intent_id}"
            account = self.accounts[member.intent_id]
            account.open_order = Order(internal_order_id, account.quantity,
                                       batch.limit_price)
            self.used_orders.add(internal_order_id)
            self.batched_order_ids[internal_order_id] = batch.batch_id
        self.batches[batch.batch_id] = (deepcopy(batch), lot_size)

    def mock_batch_open_fill(self, batch_id: str, fill_id: str, lots: int,
                             price, fee) -> dict[str, tuple[int, Decimal]]:
        """Atomically apply one asserted public fill to every private member."""
        if batch_id not in self.batches:
            raise InvalidTransition("unknown pooled batch")
        proposal = deepcopy(self)
        batch, lot_size = proposal.batches[batch_id]
        allocated = batch.allocate_fill(fill_id, lots, price, fee)
        for intent_id, (member_lots, member_fee) in allocated.items():
            proposal._record_open_fill(intent_id, f"{batch_id}:{intent_id}",
                                       f"{batch_id}:{fill_id}:{intent_id}",
                                       member_lots * lot_size, price, member_fee,
                                       from_batch=True)
        self.__dict__.update(proposal.__dict__)
        return allocated

    def mock_terminal_batch(self, batch_id: str, receipt_id: str) -> None:
        """Assert the public order's unfilled remainder can no longer fill."""
        if batch_id not in self.batches:
            raise InvalidTransition("unknown pooled batch")
        self._new_receipt(receipt_id)
        batch, _ = self.batches[batch_id]
        if batch.terminal:
            raise InvalidTransition("pooled order is already terminal")
        batch.terminal = True
        for member in batch.members:
            self.accounts[member.intent_id].open_order.terminal = True
        self.used_receipts.add(receipt_id)

    def mock_open_fill(self, intent_id: str, order_id: str, fill_id: str,
                       quantity, price, fee) -> None:
        self._record_open_fill(intent_id, order_id, fill_id, quantity, price, fee,
                               from_batch=False)

    def _record_open_fill(self, intent_id: str, order_id: str, fill_id: str,
                          quantity, price, fee, *, from_batch: bool) -> None:
        account = self.accounts[intent_id]
        if order_id in self.batched_order_ids and not from_batch:
            raise InvalidTransition("batched order requires pooled fill")
        order = self._active_order(account.open_order, order_id, fill_id)
        quantity = amount(quantity, "fill quantity")
        price = amount(price, "fill price")
        fee = amount(fee, "fee", allow_zero=True)
        if quantity > order.quantity - order.filled:
            raise InvalidTransition("overfill")
        if (account.side == "long" and price > order.limit_price) or (
            account.side == "short" and price < order.limit_price
        ):
            raise InvalidTransition("fill outside open price limit")
        margin = quantity * price / account.leverage
        # A real fill cannot be discarded because fees exceeded the estimate.
        # A negative cash balance is retained as a visible deficit and freezes
        # all payouts at settlement certification.
        account.cash -= margin + fee
        account.locked_margin += margin
        account.position_quantity += quantity
        account.entry_notional += quantity * price
        order.filled += quantity
        order.terminal = order.filled == order.quantity
        self.used_fills.add(fill_id)

    def mock_terminal_order(self, intent_id: str, order_id: str,
                            receipt_id: str) -> None:
        """Assert authoritative cancellation/finality of any unfilled remainder."""
        account = self.accounts[intent_id]
        self._new_receipt(receipt_id)
        order = self._order(account, order_id)
        if order_id in self.batched_order_ids:
            raise InvalidTransition("batched order requires pooled finality")
        if order.terminal:
            raise InvalidTransition("order is already terminal")
        order.terminal = True
        self.used_receipts.add(receipt_id)

    def submit_close(self, intent_id: str, order_id: str, limit_price) -> None:
        account = self.accounts[intent_id]
        self._new_order(order_id)
        if account.open_order is not None and account.open_order.order_id in self.batched_order_ids:
            batch_id = self.batched_order_ids[account.open_order.order_id]
            if not self.batches[batch_id][0].terminal:
                raise InvalidTransition("pooled opening order may still fill")
        if account.open_order is None or not account.open_order.terminal:
            raise InvalidTransition("opening order may still fill")
        if account.position_quantity <= 0 or (
            account.close_order is not None and not account.close_order.terminal
        ):
            raise InvalidTransition("no closable position or close already pending")
        account.close_order = Order(order_id, account.position_quantity,
                                    amount(limit_price, "close limit"))
        self.used_orders.add(order_id)

    def mock_close_fill(self, intent_id: str, order_id: str, fill_id: str,
                        quantity, price, fee) -> None:
        account = self.accounts[intent_id]
        order = self._active_order(account.close_order, order_id, fill_id)
        quantity = amount(quantity, "fill quantity")
        price = amount(price, "fill price")
        fee = amount(fee, "fee", allow_zero=True)
        if quantity > order.quantity - order.filled or quantity > account.position_quantity:
            raise InvalidTransition("close exceeds position or order")
        if (account.side == "long" and price < order.limit_price) or (
            account.side == "short" and price > order.limit_price
        ):
            raise InvalidTransition("fill outside close price limit")
        old_quantity = account.position_quantity
        closed_entry = account.entry_notional * quantity / old_quantity
        released = account.locked_margin * quantity / old_quantity
        pnl = (quantity * price - closed_entry) * (1 if account.side == "long" else -1)
        account.cash += released + pnl - fee
        account.locked_margin -= released
        account.entry_notional -= closed_entry
        account.position_quantity -= quantity
        order.filled += quantity
        order.terminal = order.filled == order.quantity
        self.used_fills.add(fill_id)

    def mock_funding(self, intent_id: str, receipt_id: str, signed_usdc) -> None:
        account = self.accounts[intent_id]
        self._new_receipt(receipt_id)
        if account.position_quantity == 0:
            raise InvalidTransition("funding requires an open position")
        if isinstance(signed_usdc, (float, bool)):
            raise InvalidTransition("funding must be exact decimal")
        try:
            funding = Decimal(signed_usdc)
        except (InvalidOperation, TypeError):
            raise InvalidTransition("invalid funding") from None
        if not funding.is_finite():
            raise InvalidTransition("invalid funding")
        account.cash += funding
        self.used_receipts.add(receipt_id)

    def request_payout(self, intent_id: str, usdc_amount, min_zec_out) -> None:
        account = self.accounts[intent_id]
        usdc_amount = amount(usdc_amount, "payout amount")
        min_zec_out = amount(min_zec_out, "minimum ZEC out")
        if not self.pool_certified:
            raise InvalidTransition("pool equity is not certified")
        if account.core_credit_receipt is None or (
            account.open_order is not None and not account.open_order.terminal
        ) or (
            account.close_order is not None and not account.close_order.terminal
        ) or account.position_quantity != 0 or account.pending_payout != 0:
            raise InvalidTransition("position or order is unresolved")
        if usdc_amount > account.cash:
            raise InvalidTransition("payout exceeds settled claim")
        account.pending_payout = usdc_amount
        account.pending_min_zec = min_zec_out
        account.core_return_receipt = None

    def mock_confirm_core_return(self, intent_id: str, receipt_id: str,
                                 usdc_received) -> None:
        account = self.accounts[intent_id]
        self._new_receipt(receipt_id)
        if account.pending_payout == 0 or account.core_return_receipt is not None:
            raise InvalidTransition("no pending Core return")
        if amount(usdc_received, "returned USDC") != account.pending_payout:
            raise InvalidTransition("Core return differs from reserved payout")
        account.core_return_receipt = receipt_id
        self.used_receipts.add(receipt_id)

    def mock_complete_payout(self, intent_id: str, receipt_id: str, zec_received) -> None:
        account = self.accounts[intent_id]
        self._new_receipt(receipt_id)
        if account.pending_payout == 0 or account.core_return_receipt is None:
            raise InvalidTransition("no confirmed payout liquidity")
        if amount(zec_received, "ZEC received") < account.pending_min_zec:
            raise InvalidTransition("payout below minimum ZEC out")
        account.cash -= account.pending_payout
        account.pending_payout = Decimal(0)
        account.pending_min_zec = Decimal(0)
        account.core_return_receipt = None
        account.completed = account.cash == 0
        self.used_receipts.add(receipt_id)

    def reconcile_closed_pool(self, observed_usdc) -> bool:
        """Compare a supplied mock cash observation after every order is terminal."""
        for account in self.accounts.values():
            if (account.deposit_receipt is not None and account.conversion_receipt is None) or (
                account.conversion_receipt is not None and account.core_credit_receipt is None
            ) or (
                account.open_order is not None and not account.open_order.terminal
            ) or (account.close_order is not None and not account.close_order.terminal) or (
                account.position_quantity != 0 or account.pending_payout != 0
            ):
                raise InvalidTransition("pool is not fully settled")
        return sum((a.cash for a in self.accounts.values()), Decimal(0)) == amount(
            observed_usdc, "observed USDC", allow_zero=True
        )

    def mock_certify_pool_equity(self, receipt_id: str, observed_usdc) -> None:
        """Assert an externally evidenced flat pool balance for this one epoch."""
        self._new_receipt(receipt_id)
        if self.pool_certified or any(a.cash < 0 for a in self.accounts.values()):
            raise InvalidTransition("epoch already certified or has a user deficit")
        if not self.reconcile_closed_pool(observed_usdc):
            raise InvalidTransition("pooled USDC differs from user claims")
        self.pool_certified = True
        self.used_receipts.add(receipt_id)

    def _new_receipt(self, receipt_id: str) -> None:
        if not receipt_id or receipt_id in self.used_receipts:
            raise InvalidTransition("missing or replayed receipt")

    def _ensure_open_epoch(self) -> None:
        if self.pool_certified:
            raise InvalidTransition("settlement epoch is closed")

    def _new_order(self, order_id: str) -> None:
        if not order_id or order_id in self.used_orders:
            raise InvalidTransition("missing or replayed order")

    @staticmethod
    def _order(account: Account, order_id: str) -> Order:
        for order in (account.open_order, account.close_order):
            if order is not None and order.order_id == order_id:
                return order
        raise InvalidTransition("unknown order")

    def _active_order(self, order: Order | None, order_id: str, fill_id: str) -> Order:
        if not fill_id or fill_id in self.used_fills:
            raise InvalidTransition("missing or replayed fill")
        if order is None or order.order_id != order_id or order.terminal:
            raise InvalidTransition("order is unknown or terminal")
        return order
