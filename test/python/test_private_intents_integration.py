import unittest
from decimal import Decimal

from scripts.private_intents_batch import BatchMember, PooledOrderBatch
from scripts.private_intents_model import InvalidTransition, PrivateIntentsModel


class PrivateIntentsIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.model = PrivateIntentsModel()
        for name, lots, limit in (("alice", 3, "100"), ("bob", 1, "105")):
            self.model.register(name, f"commit-{name}", "nonce-1", "BTC-USD",
                                "long", str(Decimal(lots) / 10), limit,
                                "95", 2, 200, 100)
            self.model.mock_confirm_deposit(name, f"zec-{name}", "2")
            self.model.mock_settle_conversion(name, f"swap-{name}", "2", "100")
            self.model.mock_confirm_core_credit(name, f"core-{name}", "100")

    def batch(self, bob_lots=1):
        return PooledOrderBatch(
            "batch-1", "BTC-USD", "long", Decimal("100"),
            (BatchMember("alice", 3, Decimal("100")),
             BatchMember("bob", bob_lots, Decimal("105"))),
            b"offline-batch-salt-for-tests",
        )

    def test_one_public_batch_reconciles_two_private_claims(self):
        self.model.submit_open_batch(self.batch(), "0.1", 110)
        self.assertEqual(self.model.mock_batch_open_fill(
            "batch-1", "fill-1", 2, "100", "2"),
            {"alice": (2, Decimal("2"))})
        self.assertEqual(self.model.mock_batch_open_fill(
            "batch-1", "fill-2", 2, "99", "2"),
            {"alice": (1, Decimal("1")), "bob": (1, Decimal("1"))})
        self.assertEqual(self.model.accounts["alice"].position_quantity, Decimal("0.3"))
        self.assertEqual(self.model.accounts["bob"].position_quantity, Decimal("0.1"))
        for name, quantity in (("alice", "0.3"), ("bob", "0.1")):
            self.model.submit_close(name, f"close-{name}", "90")
            self.model.mock_close_fill(name, f"close-{name}", f"exit-{name}",
                                       quantity, "100", "0")
        self.assertEqual(self.model.accounts["alice"].cash, Decimal("97.1"))
        self.assertEqual(self.model.accounts["bob"].cash, Decimal("99.1"))
        self.model.mock_certify_pool_equity("equity-1", "196.2")

    def test_public_cancel_stops_late_fill_and_unfilled_member_can_refund(self):
        self.model.submit_open_batch(self.batch(), "0.1", 110)
        self.model.mock_batch_open_fill("batch-1", "fill-1", 1, "100", "0")
        with self.assertRaisesRegex(InvalidTransition, "pooled fill"):
            self.model.mock_open_fill("alice", "batch-1:alice", "private-fill",
                                      "0.1", "100", "0")
        with self.assertRaisesRegex(InvalidTransition, "pooled finality"):
            self.model.mock_terminal_order("alice", "batch-1:alice", "private-cancel")
        self.model.mock_terminal_batch("batch-1", "cancel-1")
        with self.assertRaisesRegex(InvalidTransition, "terminal"):
            self.model.mock_batch_open_fill("batch-1", "late", 1, "100", "0")
        self.model.submit_close("alice", "close-a", "90")
        self.model.mock_close_fill("alice", "close-a", "exit-a", "0.1", "100", "0")
        self.model.mock_certify_pool_equity("equity-1", "200")
        self.model.request_payout("bob", "100", "1.5")

    def test_invalid_batch_or_fill_does_not_partially_mutate_accounts(self):
        with self.assertRaisesRegex(InvalidTransition, "market or lots"):
            self.model.submit_open_batch(self.batch(bob_lots=2), "0.1", 110)
        self.assertIsNone(self.model.accounts["alice"].open_order)
        self.assertIsNone(self.model.accounts["bob"].open_order)
        self.model.submit_open_batch(self.batch(), "0.1", 110)
        with self.assertRaisesRegex(InvalidTransition, "price"):
            self.model.mock_batch_open_fill("batch-1", "bad-fill", 1, "101", "0")
        self.assertEqual(self.model.batches["batch-1"][0].filled_lots, 0)
        self.assertEqual(self.model.accounts["alice"].position_quantity, 0)
        self.assertEqual(self.model.accounts["bob"].position_quantity, 0)


if __name__ == "__main__":
    unittest.main()
