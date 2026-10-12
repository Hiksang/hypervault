import sys
import unittest
from decimal import Decimal as D
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "hypervault"))
import pm_compare  # noqa: E402
import strategy  # noqa: E402

MARKET = {
    "perpCoin": "HYPE", "spotPair": "@107", "perpSzDecimals": 2, "spotSzDecimals": 2,
    "perpMark": "86.0", "perpOracle": "86.0", "spotMark": "86.0", "fundingHourly": "0.0000125",
    "fundingApr": "0.1095", "perpBid": "85.99", "perpBidSz": "500", "perpAsk": "86.01", "perpAskSz": "500",
    "spotBid": "85.98", "spotBidSz": "500", "spotAsk": "86.02", "spotAskSz": "500",
    "usdcBorrowApr": "0.05", "baseLtv": "0.65", "baseBorrowOracle": "86.0", "maxLeverage": 10,
}


def ok(status):
    return {"status": "ok", "response": {"type": "order", "data": {"statuses": [status]}}}


class HedgeSizeTest(unittest.TestCase):
    def test_run3_balance_dust_and_fee(self):
        # v3 run 3: 0.00177246 prior HYPE + 0.12 bought - 0.00008399 fee = 0.12168847 held
        self.assertEqual(strategy.hedge_size(D("0.12168847"), D(0), D(0), 2), D("0.12"))

    def test_fee_in_base_still_rounds_to_the_bought_size(self):
        self.assertEqual(strategy.hedge_size(D("0.11991601"), D(0), D(0), 2), D("0.12"))

    def test_rounds_to_nearest_step_not_down(self):
        self.assertEqual(strategy.hedge_size(D("0.1251"), D(0), D(0), 2), D("0.13"))
        self.assertEqual(strategy.hedge_size(D("0.1249"), D(0), D(0), 2), D("0.12"))

    def test_existing_short_is_subtracted(self):
        self.assertEqual(strategy.hedge_size(D("0.25"), D(0), D("0.12"), 2), D("0.13"))
        self.assertEqual(strategy.hedge_size(D("0.10"), D(0), D("0.12"), 2), D(0))

    def test_hype_vault_keeps_the_deposit_unhedged(self):
        self.assertEqual(strategy.hedge_size(D("1.11991601"), D("1"), D(0), 2), D("0.12"))


class ClassifyTest(unittest.TestCase):
    def test_states_are_distinct(self):
        self.assertEqual(strategy.classify(ok({"filled": {"totalSz": "0.3", "avgPx": "86", "oid": 1}}))["state"], "filled")
        self.assertEqual(strategy.classify(ok({"resting": {"oid": 2}}))["state"], "resting")
        unfilled = ok({"error": "Order could not immediately match against any resting orders. asset=159"})
        self.assertEqual(strategy.classify(unfilled)["state"], "unfilled")
        self.assertEqual(strategy.classify(ok({"error": "Insufficient margin to place order."}))["state"], "rejected")
        self.assertEqual(strategy.classify({"status": "err", "response": "User or API Wallet does not exist."})["state"],
                         "rejected")
        self.assertEqual(strategy.classify(None)["state"], "rejected")


class RoundingTest(unittest.TestCase):
    def test_size_rounds_down(self):
        self.assertEqual(strategy.round_size(D("0.2999"), 2), D("0.29"))

    def test_price_respects_significant_figures_and_decimals(self):
        self.assertEqual(strategy.round_px(D("86.24812"), 2, True), D("86.248"))
        self.assertEqual(strategy.round_px(D("83389.57"), 5, False), D("83390"))
        self.assertEqual(strategy.round_px(D("86.24812"), 2, False), D("86.248"))


class PlanTest(unittest.TestCase):
    def run_plan(self, kind, hypo, unwind=False, market=None):
        with mock.patch.object(strategy, "market_view", return_value=dict(market or MARKET)):
            return strategy.plan(kind, None, strategy.Limits(), hypo, unwind)

    def hypo(self, **kw):
        base = {"abstraction": "unifiedAccount", "spotUsdc": "0", "spotBase": "0", "perpSzi": "0", "spotUsdcHold": "0"}
        base.update(kw)
        return base

    def test_usdc_carry_hedges_filled_size_and_respects_cap(self):
        p = self.run_plan("USDC", self.hypo(spotUsdc="110"))
        self.assertEqual(p.blocked, [])
        self.assertEqual([a["side"] for a in p.actions], ["buy", "sell"])
        self.assertEqual(p.actions[1]["size"], "MATCH_SPOT_BALANCE")
        self.assertLessEqual(D(p.actions[0]["size"]) * D("86.02"), D("25") * D("1.01"))

    def test_usdc_carry_blocks_below_minimum_order(self):
        p = self.run_plan("USDC", self.hypo(spotUsdc="12"))
        self.assertTrue(any("below minimum order" in b for b in p.blocked))

    def test_negative_funding_blocks_new_carry(self):
        m = dict(MARKET, fundingApr="-0.02")
        p = self.run_plan("USDC", self.hypo(spotUsdc="110"), market=m)
        self.assertTrue(any("funding APR" in b for b in p.blocked))

    def test_hype_vault_keeps_base_exposure_and_needs_pm(self):
        p = self.run_plan("HYPE", self.hypo(spotBase="10"))
        self.assertTrue(any("not portfolioMargin" in b for b in p.blocked))
        self.assertEqual(p.baseExposure["size"], "10")

    def test_hype_vault_extra_leg_is_bounded_by_ltv_share(self):
        p = self.run_plan("HYPE", self.hypo(spotBase="1", abstraction="portfolioMargin"))
        # allowance = 1 * 86 * 0.65 * 0.30 = 16.77 USD; extra leg never exceeds it
        self.assertEqual(p.blocked, [])
        self.assertLessEqual(D(p.actions[0]["size"]) * D(86), D("16.77"))

    def test_hype_vault_blocks_when_borrow_exceeds_funding(self):
        m = dict(MARKET, fundingApr="0.03")
        p = self.run_plan("HYPE", self.hypo(spotBase="10", abstraction="portfolioMargin"), market=m)
        self.assertTrue(any("carry negative" in b for b in p.blocked))

    def test_unwind_closes_short_first_and_keeps_gas_reserve(self):
        p = self.run_plan("USDC", self.hypo(spotUsdc="80", spotBase="0.31", perpSzi="-0.29"), unwind=True)
        self.assertEqual(p.actions[0]["side"], "buy")
        self.assertTrue(p.actions[0]["reduceOnly"])
        self.assertEqual(p.actions[1]["size"], "0.29")  # 0.31 spot - 0.02 gas reserve


class PmHeadroomTest(unittest.TestCase):
    def test_ltv_borrow_cap_binds_like_the_docs_example(self):
        # docs: 1 BTC spot + 1 BTC short, LTV 0.5 -> must reduce before price doubles
        r = pm_compare.pm_headroom(D(1), D(100000), D(0), D("0.5"), D("0.0125"))
        self.assertAlmostEqual(float(r), 1.0, delta=0.01)


if __name__ == "__main__":
    unittest.main()


class BlpHealthTest(unittest.TestCase):
    """Manual-borrow health (monitor rule blp-health) against the documented formulas."""

    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "hypervault"))
        import monitor

        self.health = monitor.blp_health
        self.res = {0: {"oraclePx": "1.0", "ltv": "0.0"}, 150: {"oraclePx": "40", "ltv": "0.65"}}

    def state(self, hype_supply, usdc_borrow):
        return {"tokenToState": [[0, {"borrow": {"value": usdc_borrow}, "supply": {"value": "0"}}],
                                 [150, {"borrow": {"value": "0"}, "supply": {"value": hype_supply}}]]}

    def test_docs_example(self):
        # docs: 100 HYPE at $40, 2,000 USDC borrowed -> health factor 130%; liquidation price ~$24.24
        h = self.health(self.state("100", "2000"), self.res)
        self.assertAlmostEqual(float(h["healthFactor"]), 1.30, places=6)
        self.assertAlmostEqual(float(h["liquidationUsage"]), 2000 / (100 * 40 * 0.825), places=6)
        self.assertAlmostEqual(40 * (1 - float(h["dropToLiquidation"])), 24.2424, places=3)

    def test_no_borrow(self):
        h = self.health(self.state("1", "0"), self.res)
        self.assertEqual(h["borrowedUsd"], 0)
        self.assertEqual(h["liquidationUsage"], 0)

    def test_missing_reserve_is_an_error_not_healthy(self):
        with self.assertRaises(RuntimeError):
            self.health(self.state("1", "1"), {0: self.res[0]})


class MonitorOpsTest(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "hypervault"))
        import monitor

        self.m = monitor

    def test_share_price_offset_and_empty_vault(self):
        self.assertAlmostEqual(self.m.share_price(15_000_000, 15_000_000_000), 1.0, places=6)
        self.assertIsNone(self.m.share_price(850, 0))

    def test_alert_webhook_posts_slack_and_discord_fields(self):
        import http.server
        import json as _json
        import threading

        got = []

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                got.append(_json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.handle_request, daemon=True).start()
        with mock.patch.dict("os.environ", {"HV_ALERT_WEBHOOK": f"http://127.0.0.1:{srv.server_port}/hook"}):
            self.m._push("HyperVault ALERT blp-health")
        srv.server_close()
        self.assertEqual(got, [{"text": "HyperVault ALERT blp-health", "content": "HyperVault ALERT blp-health"}])

    def test_webhook_failure_never_raises(self):
        with mock.patch.dict("os.environ", {"HV_ALERT_WEBHOOK": "http://127.0.0.1:9/none"}):
            self.m._push("x")
