import unittest
from decimal import Decimal

from scripts.private_intents_model import InvalidTransition, PrivateIntentsModel


class PrivateIntentsModelTest(unittest.TestCase):
    def setUp(self):
        self.model = PrivateIntentsModel()

    def register(self, intent="alice", side="long", quantity="1"):
        self.model.register(intent, f"commit-{intent}", "nonce-1", "BTC-USD",
                            side, quantity, "100", "95", 2, 200, 100)

    def fund(self, intent="alice", usdc="100"):
        self.model.mock_confirm_deposit(intent, f"zec-{intent}", "2")
        self.model.mock_settle_conversion(intent, f"swap-{intent}", "2", usdc)
        self.model.mock_confirm_core_credit(intent, f"core-{intent}", usdc)

    def test_two_users_close_and_reconcile_without_cross_user_pnl(self):
        self.register()
        self.register("bob", "short")
        self.fund()
        self.fund("bob")
        self.model.submit_open("alice", "open-a", 110)
        self.model.mock_open_fill("alice", "open-a", "fill-a", "1", "100", "1")
        self.model.mock_funding("alice", "fund-a", "-2")
        self.model.submit_open("bob", "open-b", 110)
        self.model.mock_open_fill("bob", "open-b", "fill-b", "1", "100", "0")
        self.model.submit_close("alice", "close-a", "105")
        self.model.mock_close_fill("alice", "close-a", "exit-a", "1", "110", "1")
        self.model.submit_close("bob", "close-b", "115")
        self.model.mock_close_fill("bob", "close-b", "exit-b", "1", "110", "0")
        self.assertEqual(self.model.accounts["alice"].cash, Decimal("106"))
        self.assertEqual(self.model.accounts["bob"].cash, Decimal("90"))
        self.assertTrue(self.model.reconcile_closed_pool("196"))
        self.assertFalse(self.model.reconcile_closed_pool("195"))
        with self.assertRaisesRegex(InvalidTransition, "not certified"):
            self.model.request_payout("alice", "106", "1.8")
        self.model.mock_certify_pool_equity("equity-1", "196")
        self.model.request_payout("alice", "106", "1.8")
        with self.assertRaisesRegex(InvalidTransition, "no confirmed payout liquidity"):
            self.model.mock_complete_payout("alice", "payout-a", "2")
        self.model.mock_confirm_core_return("alice", "return-a", "106")
        self.model.mock_complete_payout("alice", "payout-a", "2")
        self.assertTrue(self.model.reconcile_closed_pool("90"))
        self.assertTrue(self.model.accounts["alice"].completed)

    def test_each_cross_chain_stage_requires_distinct_confirmation(self):
        self.register()
        with self.assertRaises(InvalidTransition):
            self.model.submit_open("alice", "open-a", 110)
        self.model.mock_confirm_deposit("alice", "zec-a", "2")
        with self.assertRaises(InvalidTransition):
            self.model.submit_open("alice", "open-a", 110)
        with self.assertRaises(InvalidTransition):
            self.model.mock_settle_conversion("alice", "bad-swap", "2", "94")
        self.model.mock_settle_conversion("alice", "swap-a", "2", "100")
        with self.assertRaises(InvalidTransition):
            self.model.submit_open("alice", "open-a", 110)
        with self.assertRaises(InvalidTransition):
            self.model.mock_confirm_core_credit("alice", "bad-core", "99")
        self.model.mock_confirm_core_credit("alice", "core-a", "100")
        self.model.submit_open("alice", "open-a", 110)
        with self.assertRaisesRegex(InvalidTransition, "expired"):
            self.model.register("late", "commit-late", "n", "BTC-USD", "long",
                                "1", "100", "95", 2, 100, 100)

    def test_replay_and_partial_order_finality(self):
        self.register()
        self.fund()
        with self.assertRaisesRegex(InvalidTransition, "replayed"):
            self.model.mock_confirm_deposit("alice", "zec-alice", "2")
        self.model.submit_open("alice", "open-a", 110)
        self.model.mock_open_fill("alice", "open-a", "fill-1", "0.4", "100", "0")
        with self.assertRaises(InvalidTransition):
            self.model.submit_close("alice", "close-a", "90")
        with self.assertRaises(InvalidTransition):
            self.model.mock_open_fill("alice", "open-a", "fill-1", "0.1", "100", "0")
        with self.assertRaises(InvalidTransition):
            self.model.mock_open_fill("alice", "open-a", "overfill", "0.7", "100", "0")
        self.model.mock_terminal_order("alice", "open-a", "cancel-a")
        with self.assertRaises(InvalidTransition):
            self.model.mock_open_fill("alice", "open-a", "late-fill", "0.1", "100", "0")
        self.model.submit_close("alice", "close-a", "90")
        self.model.mock_close_fill("alice", "close-a", "exit-1", "0.2", "100", "0")
        with self.assertRaises(InvalidTransition):
            self.model.request_payout("alice", "1", "0.01")
        self.model.mock_terminal_order("alice", "close-a", "cancel-close")
        self.model.submit_close("alice", "close-b", "90")
        self.model.mock_close_fill("alice", "close-b", "exit-2", "0.2", "100", "0")
        self.assertEqual(self.model.accounts["alice"].cash, Decimal("100"))
        self.assertTrue(self.model.reconcile_closed_pool("100"))
        self.model.mock_certify_pool_equity("equity-a", "100")

    def test_limits_and_loss_cannot_be_hidden_by_withdrawal(self):
        self.register()
        self.fund()
        self.model.submit_open("alice", "open-a", 110)
        with self.assertRaises(InvalidTransition):
            self.model.mock_open_fill("alice", "open-a", "bad-price", "1", "101", "0")
        self.model.mock_open_fill("alice", "open-a", "fill-a", "1", "100", "0")
        self.model.submit_close("alice", "close-a", "10")
        self.model.mock_close_fill("alice", "close-a", "exit-a", "1", "10", "0")
        self.assertEqual(self.model.accounts["alice"].cash, Decimal("10"))
        self.model.mock_certify_pool_equity("equity-a", "10")
        with self.assertRaises(InvalidTransition):
            self.model.request_payout("alice", "11", "1")
        self.model.request_payout("alice", "10", "1")
        with self.assertRaises(InvalidTransition):
            self.model.mock_confirm_core_return("alice", "bad-return", "9")
        self.model.mock_confirm_core_return("alice", "return-a", "10")
        with self.assertRaises(InvalidTransition):
            self.model.mock_complete_payout("alice", "bad-payout", "0.9")
        self.model.mock_complete_payout("alice", "payout-a", "1")
        with self.assertRaisesRegex(InvalidTransition, "replayed"):
            self.model.mock_complete_payout("alice", "payout-a", "1")

    def test_fee_overrun_is_recorded_as_deficit_and_blocks_pool_payout(self):
        self.register()
        self.fund()
        self.model.submit_open("alice", "open-a", 110)
        self.model.mock_open_fill("alice", "open-a", "fill-a", "1", "100", "150")
        self.assertEqual(self.model.accounts["alice"].cash, Decimal("-100"))
        self.model.submit_close("alice", "close-a", "90")
        self.model.mock_close_fill("alice", "close-a", "exit-a", "1", "100", "0")
        self.assertEqual(self.model.accounts["alice"].cash, Decimal("-50"))
        with self.assertRaisesRegex(InvalidTransition, "user deficit"):
            self.model.mock_certify_pool_equity("equity-a", "0")

    def test_exact_amounts_and_nonce_are_required(self):
        self.register()
        with self.assertRaisesRegex(InvalidTransition, "replayed"):
            self.model.register("another", "commit-alice", "nonce-1", "BTC-USD",
                                "long", "1", "100", "95", 2, 200, 100)
        with self.assertRaisesRegex(InvalidTransition, "exact decimal"):
            self.model.mock_confirm_deposit("alice", "zec-a", 0.1)
        self.model.mock_confirm_deposit("alice", "zec-a", "2")
        with self.assertRaises(InvalidTransition):
            self.model.mock_settle_conversion("alice", "swap-a", "1", "100")

    def test_no_trade_refund_and_epoch_freeze(self):
        self.register()
        self.fund()
        self.model.mock_certify_pool_equity("equity-a", "100")
        with self.assertRaisesRegex(InvalidTransition, "epoch is closed"):
            self.model.mock_confirm_deposit("alice", "later-zec", "1")
        with self.assertRaisesRegex(InvalidTransition, "epoch is closed"):
            self.model.register("bob", "commit-bob", "n", "BTC-USD", "long",
                                "1", "100", "95", 2, 200, 100)
        self.model.request_payout("alice", "100", "1.5")
        self.model.mock_confirm_core_return("alice", "return-a", "100")
        self.model.mock_complete_payout("alice", "payout-a", "1.5")
        self.assertTrue(self.model.accounts["alice"].completed)
        self.assertTrue(self.model.reconcile_closed_pool("0"))


if __name__ == "__main__":
    unittest.main()
