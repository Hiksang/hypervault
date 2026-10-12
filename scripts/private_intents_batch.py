"""Offline, auditable allocation of one pooled order's fills.

No order is sent. The salted commitment is a local audit aid, not a proof
that the allocation was published before execution or hidden from an operator.
"""

import hashlib
import json
from dataclasses import dataclass, field
from decimal import Decimal

from scripts.private_intents_model import InvalidTransition, amount


MAX_MODEL_LOTS = 10_000


def canonical_decimal(value: Decimal) -> str:
    return format(value.normalize(), "f")


@dataclass(frozen=True)
class BatchMember:
    intent_id: str
    lots: int
    open_limit: Decimal


@dataclass
class PooledOrderBatch:
    batch_id: str
    market: str
    side: str
    limit_price: Decimal
    members: tuple[BatchMember, ...]
    salt: bytes = field(repr=False)
    allocated: dict[str, int] = field(init=False)
    scores: dict[str, int] = field(init=False)
    seen_fills: set[str] = field(default_factory=set)
    filled_lots: int = 0
    terminal: bool = False
    commitment: str = field(init=False)

    def __post_init__(self) -> None:
        if not self.batch_id or not self.market or self.side not in ("long", "short"):
            raise InvalidTransition("invalid batch identity or side")
        self.limit_price = amount(self.limit_price, "batch limit")
        if not isinstance(self.salt, bytes) or len(self.salt) < 16:
            raise InvalidTransition("batch commitment needs a private random salt")
        if len(self.members) < 2:
            raise InvalidTransition("private batch model requires at least two members")
        self.members = tuple(sorted(self.members, key=lambda m: m.intent_id))
        if len({m.intent_id for m in self.members}) != len(self.members):
            raise InvalidTransition("duplicate member")
        total = 0
        canonical_members = []
        for member in self.members:
            if not member.intent_id or type(member.lots) is not int or member.lots <= 0:
                raise InvalidTransition("invalid member lots")
            member_limit = amount(member.open_limit, "member limit")
            if (self.side == "long" and self.limit_price > member_limit) or (
                self.side == "short" and self.limit_price < member_limit
            ):
                raise InvalidTransition("batch price violates a member limit")
            total += member.lots
            canonical_members.append([member.intent_id, member.lots,
                                      canonical_decimal(member_limit)])
        if total > MAX_MODEL_LOTS:
            raise InvalidTransition("offline batch exceeds model lot bound")
        self.allocated = {m.intent_id: 0 for m in self.members}
        self.scores = {m.intent_id: 0 for m in self.members}
        payload = json.dumps(
            ["zcash-intent-batch-v1", self.batch_id, self.market, self.side,
             canonical_decimal(self.limit_price), canonical_members],
            separators=(",", ":"), ensure_ascii=True,
        ).encode()
        self.commitment = hashlib.sha256(
            b"zcash-intent-batch-v1\0" + self.salt + payload
        ).hexdigest()

    @property
    def total_lots(self) -> int:
        return sum(m.lots for m in self.members)

    def allocate_fill(self, fill_id: str, lots: int, price, fee) -> dict[str, tuple[int, Decimal]]:
        """Return (filled lots, USDC fee) for each member touched by this fill."""
        if not fill_id or fill_id in self.seen_fills:
            raise InvalidTransition("missing or replayed pooled fill")
        if self.terminal:
            raise InvalidTransition("pooled order is terminal")
        if type(lots) is not int or lots <= 0 or lots > self.total_lots - self.filled_lots:
            raise InvalidTransition("invalid pooled fill lots")
        price = amount(price, "pooled fill price")
        fee = amount(fee, "pooled fill fee", allow_zero=True)
        if (self.side == "long" and price > self.limit_price) or (
            self.side == "short" and price < self.limit_price
        ):
            raise InvalidTransition("pooled fill violates batch price")

        by_member = {m.intent_id: 0 for m in self.members}
        total_weight = self.total_lots
        for _ in range(lots):
            for member in self.members:
                if self.allocated[member.intent_id] < member.lots:
                    self.scores[member.intent_id] += member.lots
            eligible = [m.intent_id for m in self.members
                        if self.allocated[m.intent_id] < m.lots]
            winner = max(eligible, key=lambda key: self.scores[key])
            self.scores[winner] -= total_weight
            self.allocated[winner] += 1
            by_member[winner] += 1

        recipients = [m.intent_id for m in self.members if by_member[m.intent_id]]
        result = {}
        remaining_fee = fee
        for key in recipients[:-1]:
            share = fee * by_member[key] / lots
            result[key] = (by_member[key], share)
            remaining_fee -= share
        result[recipients[-1]] = (by_member[recipients[-1]], remaining_fee)
        self.filled_lots += lots
        self.seen_fills.add(fill_id)
        self.terminal = self.filled_lots == self.total_lots
        return result
