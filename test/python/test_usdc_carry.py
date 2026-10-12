import sys
import unittest
from decimal import Decimal as D
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "hypervault"))
import carry_model as cm  # noqa: E402
import usdc_carry as uc  # noqa: E402

F, R = D("0.101"), D("0.05")  # 90-day HYPE funding and USDC borrow in the user's doc

MARKET = {
    "perpCoin": "HYPE", "spotPair": "@107", "perpMark": "85.0", "perpOracle": "85.0", "spotMark": "85.0", "fundingApr": "0.10", "funding24hApr": "0.10",
    "funding7dApr": "0.10", "usdcBorrowApr": "0.05", "usdcUtilization": "0.75", "hypeLtv": "0.65",
    "hypeReserveOracle": "85.0", "maxLeverage": 10, "perpSzDecimals": 2, "spotSzDecimals": 2,
    "spotAsk": "85.01", "spotAskSz": "100000", "spotBid": "84.99", "spotBidSz": "100000",
    "perpBid": "84.99", "perpBidSz": "100000", "perpAsk": "85.01", "perpAskSz": "100000",
}


def state(usdc, mode, hype=D(0), short=D(0), debt=D(0), supplied=D(0)):
    return {"abstraction": mode, "usdcTotal": D(usdc), "usdcGross": D(usdc), "debt": D(debt), "hype": D(hype),
            "hypeSupplied": D(supplied), "hypeUnsupplied": D(hype) - D(supplied), "short": D(short),
            "liquidationPx": None, "pmRatio": None, "healthFactor": None}


class DocTableTest(unittest.TestCase):
    """User's APR/LTV doc, USDC Carry: b = 10%, L = 10x, funding 10.1%, borrow 5%."""

    def test_usdc_table(self):
        rows = {"0.30": ("112.50", "33.75", "8.47"), "0.40": ("128.57", "51.43", "9.11"),
                "0.50": ("150.00", "75.00", "9.95"), "0.55": ("163.64", "90.00", "10.49"),
                "0.60": ("180.00", "108.00", "11.13")}
        for q, (spot, debt, apr) in rows.items():
            s = cm.usdc_shape(q, 10, "0.1")
            self.assertEqual(f"{s.spot * 100:.2f}", spot, q)
            self.assertEqual(f"{s.debt * 100:.2f}", debt, q)
            self.assertEqual(f"{cm.net_apr(s.spot, s.debt, F, R) * 100:.2f}", apr, q)
            self.assertAlmostEqual(float(s.ltv), float(q), places=12)

    def test_q_zero_is_the_unlevered_carry(self):
        s = cm.usdc_shape(0, 2, "0.1")  # live v4 today: 2x short, no borrow
        self.assertEqual(s.debt, 0)
        self.assertEqual(f"{s.spot:.4f}", "0.6000")
        self.assertEqual(f"{s.margin:.4f}", "0.3000")

    def test_breakeven_is_q_times_borrow_plus_cost(self):
        s = cm.usdc_shape("0.6", 10, "0.1")
        self.assertEqual(cm.breakeven_funding(s.spot, s.debt, R), D("0.6") * R + cm.ROUND_TRIP_COST)
        self.assertLess(cm.net_apr(s.spot, s.debt, D("0.0323"), R), D("0.0001"))

    def test_no_fee_on_a_loss(self):
        s = cm.usdc_shape("0.6", 10, "0.1")
        loss = cm.net_apr(s.spot, s.debt, 0, R)
        self.assertEqual(loss, -(s.debt * R + s.spot * cm.ROUND_TRIP_COST))

    def test_stablecoin_borrow_curve(self):
        self.assertEqual(cm.stablecoin_borrow_apr("0.75"), D("0.05"))
        self.assertEqual(cm.stablecoin_borrow_apr("0.85"), D("0.2875"))


class LiquidationTest(unittest.TestCase):
    def test_unified_short_at_10x_dies_on_a_small_rally(self):
        # USDC-margined short at 10x with 5% maintenance: (0.10 - 0.05) / 1.05
        self.assertEqual(f"{cm.unified_short_rally(10, 100, '0.05'):.4f}", "0.0476")
        self.assertEqual(f"{cm.unified_short_rally(50, 100, '0.05'):.4f}", "0.4286")

    def test_borrow_fall(self):
        # debt 60 on 100 of HYPE, LTV 0.65 -> partial liquidation at 82.5 of collateral value
        self.assertEqual(f"{cm.borrow_fall(60, 100, '0.65'):.4f}", "0.2727")
        self.assertIsNone(cm.borrow_fall(0, 100, "0.65"))

    def test_pm_rally_is_the_risk_a_fall_is_not(self):
        ratio = cm.pm_ratio(90, 180, 180, "0.05", "0.65", offset=0)  # q = 0.6 per 100 of capital, net debt 90
        up = cm.pm_move_to_liquidation(ratio, 180, 180, "0.05", "0.65")
        self.assertGreater(up, 0)
        self.assertLess(cm.pm_ratio(90 - 180 * D("0.2"), 180 * D("0.8"), 180 * D("0.8"), "0.05", "0.65", 0), ratio)


class PlannerTest(unittest.TestCase):
    def plan(self, st, mode, q, lev, **kw):
        lim = uc.CarryLimits(target_q=D(q), max_notional_usd=D("1e9"), **kw)
        return uc.plan(st, MARKET, mode, lim, D(lev), False, "test", True, kw.pop("vault", False))

    def test_pm_reaches_the_doc_shape(self):
        p = self.plan(state(9000, "portfolioMargin"), "portfolioMargin", "0.40", 10)
        after = p.risk["afterPlan"]
        self.assertAlmostEqual(float(after["spot"]), 12857.14, delta=15)
        self.assertAlmostEqual(float(after["debt"]), 5142.86, delta=15)
        self.assertFalse([a for a in p.actions if a["kind"] == "borrowLend"], "PM borrows automatically")
        self.assertIn("$10k", " ".join(p.blocked))  # 9,000 of Core capital is below the PM requirement

    def test_unified_supplies_before_it_borrows(self):
        p = self.plan(state(9000, "unifiedAccount"), "unifiedAccount", "0.30", 2)
        kinds = [(a["kind"], a.get("action", {}).get("operation")) for a in p.actions]
        first_borrow = kinds.index(("borrowLend", "borrow"))
        self.assertIn(("borrowLend", "supply"), kinds[:first_borrow])
        self.assertEqual(kinds[-1], ("borrowLend", "supply"), "the last bought spot becomes collateral too")
        self.assertAlmostEqual(float(p.risk["afterPlan"]["debt"]), 2250, delta=5)

    def test_unified_high_leverage_is_blocked(self):
        p = self.plan(state(9000, "unifiedAccount"), "unifiedAccount", "0.30", 10)
        self.assertTrue(any("rally" in b for b in p.blocked))

    def test_funding_below_breakeven_does_not_expand(self):
        mk = dict(MARKET, funding24hApr="0.02", funding7dApr="0.02")
        lim = uc.CarryLimits(target_q=D("0.60"), max_notional_usd=D("1e9"))
        p = uc.plan(state(9000, "portfolioMargin"), mk, "portfolioMargin", lim, D(10), False, "t", True, False)
        self.assertTrue(any("breakeven" in b for b in p.blocked))
        self.assertEqual(p.risk["qTarget"], "0")

    def test_q_capped_below_reserve_ltv(self):
        lim = uc.CarryLimits(target_q=D("0.64"), max_notional_usd=D("1e9"))
        p = uc.plan(state(9000, "portfolioMargin"), MARKET, "portfolioMargin", lim, D(10), False, "t", True, False)
        self.assertEqual(p.risk["qTarget"], "0.60")

    def test_unified_deleverage_order_and_health(self):
        # 150 of spot/short, 50 borrowed, everything supplied; target q = 0
        st = state(100, "unifiedAccount", hype=D(150) / 85, short=D(150) / 85, debt=50, supplied=D(150) / 85)
        st["usdcGross"] = D(100)
        p = self.plan(st, "unifiedAccount", "0", 2)
        seq = [(a["kind"], a.get("side") or a["action"]["operation"]) for a in p.actions]
        close = seq.index(("order", "buy"))
        sell = seq.index(("order", "sell"))
        self.assertLess(close, sell, "close the short before selling the spot")
        self.assertIn(("borrowLend", "withdraw"), seq[close:sell])

    def test_unwind_dust_lot_is_reported_not_sent(self):
        st = state(9, "unifiedAccount", hype=D("0.11991601"), short=D("0.12"))
        lim = uc.CarryLimits()
        p = uc.plan(st, MARKET, "unifiedAccount", lim, D(2), True, "v4", False, True)
        self.assertFalse([a for a in p.actions if a.get("market") == "@107"])
        self.assertTrue(any("stays unsold" in b for b in p.blocked))
        self.assertFalse([a for a in p.actions if a["kind"] in ("owner", "borrowLend")], "nothing borrowed")

    def test_vault_scope_prerequisite_only_when_lending(self):
        p = uc.plan(state(9000, "unifiedAccount"), MARKET, "unifiedAccount",
                    uc.CarryLimits(target_q=D("0.30"), max_notional_usd=D("1e9")), D(2), False, "v", False, True)
        self.assertEqual(p.actions[0]["kind"], "owner")
        self.assertIn("scope --blp", p.actions[0]["step"])


if __name__ == "__main__":
    unittest.main()
