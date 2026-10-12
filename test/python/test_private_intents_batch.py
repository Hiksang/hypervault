import unittest
from decimal import Decimal

from scripts.private_intents_batch import BatchMember, PooledOrderBatch
from scripts.private_intents_model import InvalidTransition


SALT = b"offline-example-salt-not-a-key"


class PooledOrderBatchTest(unittest.TestCase):
    def batch(self, members=None, side="long", limit="100"):
        return PooledOrderBatch(
            "batch-1", "BTC-USD", side, limit,
            tuple(members or [BatchMember("a", 3, Decimal("100")),
                              BatchMember("b", 1, Decimal("105"))]), SALT,
        )

    def test_partial_fills_allocate_monotonically_and_fees_conserve(self):
        batch = self.batch()
        first = batch.allocate_fill("fill-1", 2, "100", "2")
        self.assertEqual(first, {"a": (2, Decimal("2"))})
        second = batch.allocate_fill("fill-2", 2, "99", "2")
        self.assertEqual(second, {"a": (1, Decimal("1")),
                                  "b": (1, Decimal("1"))})
        self.assertEqual(batch.allocated, {"a": 3, "b": 1})
        self.assertEqual(batch.filled_lots, 4)
        with self.assertRaisesRegex(InvalidTransition, "replayed"):
            batch.allocate_fill("fill-2", 1, "99", "0")
        with self.assertRaisesRegex(InvalidTransition, "terminal"):
            batch.allocate_fill("fill-3", 1, "99", "0")

    def test_commitment_binds_members_and_is_order_canonical(self):
        a = self.batch([BatchMember("b", 1, Decimal("105.0")),
                        BatchMember("a", 3, Decimal("100.0"))])
        b = self.batch()
        self.assertEqual(a.commitment, b.commitment)
        tampered = self.batch([BatchMember("a", 2, Decimal("100")),
                               BatchMember("b", 2, Decimal("105"))])
        self.assertNotEqual(a.commitment, tampered.commitment)
        self.assertNotIn("offline-example-salt", repr(a))

    def test_price_limits_and_bad_inputs_fail_before_allocation(self):
        batch = self.batch()
        with self.assertRaisesRegex(InvalidTransition, "violates batch price"):
            batch.allocate_fill("bad-price", 1, "101", "0")
        self.assertEqual(batch.filled_lots, 0)
        with self.assertRaisesRegex(InvalidTransition, "member limit"):
            self.batch([BatchMember("a", 1, Decimal("99")),
                        BatchMember("b", 1, Decimal("105"))])
        with self.assertRaisesRegex(InvalidTransition, "duplicate"):
            self.batch([BatchMember("a", 1, Decimal("100")),
                        BatchMember("a", 1, Decimal("100"))])
        with self.assertRaisesRegex(InvalidTransition, "random salt"):
            PooledOrderBatch("b", "BTC-USD", "long", Decimal("100"),
                             (BatchMember("a", 1, Decimal("100")),
                              BatchMember("b", 1, Decimal("100"))), b"short")

    def test_short_batch_respects_minimum_sell_price(self):
        batch = self.batch([BatchMember("a", 1, Decimal("90")),
                            BatchMember("b", 1, Decimal("95"))],
                           side="short", limit="95")
        with self.assertRaisesRegex(InvalidTransition, "violates batch price"):
            batch.allocate_fill("bad-short", 1, "94", "0")
        allocated = batch.allocate_fill("short-fill", 2, "96", "0.2")
        self.assertEqual(sum(lots for lots, _ in allocated.values()), 2)
        self.assertEqual(sum(fee for _, fee in allocated.values()), Decimal("0.2"))


if __name__ == "__main__":
    unittest.main()
