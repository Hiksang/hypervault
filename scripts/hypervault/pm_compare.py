#!/usr/bin/env python3
"""Same-notional comparison: separate (stablecoin) margin vs HyperVault Portfolio Margin.

Both sides hold the SAME spot notional and SAME perp short notional over the SAME period with the
same funding, fees, borrow rate, haircut and reserve. What differs is the self-capital each
structure needs, and therefore return on equity and risk headroom. PM does not change the
carry itself; it changes how much capital the carry ties up. Inputs are read live from the
HyperCore API at generation time and listed as assumptions; the headroom of PM is a numerical
approximation of the documented portfolio-margin-ratio formula, not an exchange computation.
"""
from __future__ import annotations

import argparse
import time
from decimal import Decimal as D

import core
from hvlib import ROOT, save_json, utc_now

PERP_TAKER = D("0.00045")  # tier 0, validator-operated perps (docs fee schedule)
SPOT_TAKER = D("0.00070")  # tier 0 spot
MIN_BORROW_OFFSET = D(20)


def funding_avg_apr(coin: str, days: int) -> D:
    start = int((time.time() - days * 86400) * 1000)
    rows, cursor = [], start
    while True:
        batch = core.info({"type": "fundingHistory", "coin": coin, "startTime": cursor})
        if not batch:
            break
        rows += batch
        if len(batch) < 500:
            break
        cursor = batch[-1]["time"] + 1
    rates = [D(r["fundingRate"]) for r in rows]
    return (sum(rates) / len(rates)) * 24 * 365, len(rates)


def pm_headroom(q: D, p0: D, usdc0: D, ltv: D, mm_frac: D) -> D:
    """Smallest price rise (fraction) at which the approximated PM ratio exceeds 0.95."""
    liq_th = D("0.5") + D("0.5") * ltv
    for step in range(1, 5001):
        r = D(step) / 1000
        p = p0 * (1 + r)
        usdc = usdc0 - q * (p - p0)  # perp loss settles into USDC; negative = borrowed
        borrowed = max(-usdc, D(0))
        maint = MIN_BORROW_OFFSET + q * p * mm_frac + borrowed  # borrowed_size_for_maintenance ~ borrowed
        liq_value = max(usdc, D(0)) + q * p * liq_th
        # Auto-borrow is capped at balance x oracle x LTV (docs); beyond it perp losses are unbacked.
        if maint / liq_value > D("0.95") or borrowed > q * p * ltv:
            return r
    return D(5)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--coin", default="HYPE")
    ap.add_argument("--notional", default="10000")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--separate-leverage", default="2")
    ap.add_argument("--reserve", default="0.05")
    ap.add_argument("--out", default=str(ROOT / "frontend" / "public" / "hypervault" / "pm-comparison.json"))
    a = ap.parse_args()
    n, days, lev, reserve = D(a.notional), a.days, D(a.separate_leverage), D(a.reserve)
    ctx = core.perp_ctx(a.coin)
    px = D(ctx["markPx"])
    res = core.reserves()
    token = {"HYPE": 150, "BTC": 197}[a.coin]
    ltv = D(res[token]["ltv"])
    borrow_apr = D(res[0]["borrowYearlyRate"])
    f_apr, samples = funding_avg_apr(a.coin, days)
    mm = D(1) / (2 * D(ctx["maxLeverage"]))
    q = n / px
    t = D(days) / 365

    fees = n * (SPOT_TAKER + PERP_TAKER) * 2  # open and close both legs, taker
    funding = n * f_apr * t
    # separate margin: spot bought with USDC; perp short margined by USDC at `lev`
    sep_margin = n / lev
    sep_equity = (n + sep_margin) * (1 + reserve)
    sep_net = funding - fees
    sep_head = (D(1) / lev - mm) / (1 + mm)
    # PM: spot HYPE is collateral for the short; no stablecoin margin pool is set aside
    pm_equity = n * (1 + reserve)
    pm_collateral = n * ltv
    pm_interest = D(0)  # no USDC borrowed at entry; perp losses would be borrowed later
    pm_net = funding - fees - pm_interest
    pm_head = pm_headroom(q, px, n * reserve, ltv, mm)

    def r2(x):
        return float(x.quantize(D("0.01")))

    rows = [
        {"metric": "Spot notional", "unit": "USD", "separate-margin": r2(n), "hypervault-pm": r2(n)},
        {"metric": "Perp short notional", "unit": "USD", "separate-margin": r2(n), "hypervault-pm": r2(n)},
        {"metric": "USDC borrowed at entry", "unit": "USD", "separate-margin": 0.0, "hypervault-pm": 0.0,
         "note": "PM borrows only if perp losses exceed the USDC reserve"},
        {"metric": "Collateral recognized for the short", "unit": "USD", "separate-margin": r2(sep_margin),
         "hypervault-pm": r2(pm_collateral), "note": f"PM: spot x LTV {ltv}; separate: USDC margin at {lev}x"},
        {"metric": "Required self-capital (incl. reserve)", "unit": "USD", "separate-margin": r2(sep_equity),
         "hypervault-pm": r2(pm_equity)},
        {"metric": f"Funding income over {days}d", "unit": "USD", "separate-margin": r2(funding), "hypervault-pm": r2(funding),
         "note": f"{days}d average funding, past data, not a forecast"},
        {"metric": "Borrow interest", "unit": "USD", "separate-margin": 0.0, "hypervault-pm": r2(pm_interest)},
        {"metric": "Trading fees (open+close, taker)", "unit": "USD", "separate-margin": r2(fees), "hypervault-pm": r2(fees)},
        {"metric": f"Carry after costs over {days}d", "unit": "USD", "separate-margin": r2(sep_net), "hypervault-pm": r2(pm_net)},
        {"metric": "Carry / self-capital, annualized", "unit": "%",
         "separate-margin": r2(sep_net / sep_equity / t * 100), "hypervault-pm": r2(pm_net / pm_equity / t * 100),
         "note": "historical-input illustration only; not an APR offer"},
        {"metric": "Price rise until liquidation (approx.)", "unit": "%", "separate-margin": r2(sep_head * 100),
         "hypervault-pm": r2(pm_head * 100),
         "note": "separate: short leg alone; PM: numerical approximation of the documented PM ratio"},
    ]
    out = {
        "schema": "hypervault.pm-comparison.v1",
        "generatedAt": utc_now(),
        "asset": a.coin,
        "assumptions": [
            {"name": "Mark price", "value": str(px), "unit": "USD", "source": "HyperCore metaAndAssetCtxs (live)"},
            {"name": f"Average funding ({days}d)", "value": f"{f_apr * 100:.2f}", "unit": "% APR",
             "source": f"fundingHistory, {samples} hourly samples"},
            {"name": "USDC borrow rate", "value": f"{borrow_apr * 100:.2f}", "unit": "% APY",
             "source": "allBorrowLendReserveStates (live)"},
            {"name": f"{a.coin} LTV (PM)", "value": str(ltv), "unit": "ratio", "source": "allBorrowLendReserveStates"},
            {"name": "Perp maintenance margin", "value": str(mm), "unit": "fraction",
             "source": f"half of initial margin at max leverage {ctx['maxLeverage']}x"},
            {"name": "Separate-margin short leverage", "value": str(lev), "unit": "x", "source": "assumption"},
            {"name": "Reserve", "value": str(reserve * 100), "unit": "% of notional", "source": "assumption"},
            {"name": "Fees", "value": f"spot {SPOT_TAKER * 100}% / perp {PERP_TAKER * 100}%", "unit": "taker, tier 0",
             "source": "Hyperliquid fee schedule"},
            {"name": "Holding period", "value": str(days), "unit": "days", "source": "assumption"},
        ],
        "columns": ["separate-margin", "hypervault-pm"],
        "rows": rows,
        "caveats": [
            "PM eligibility: master account value > $10k or > $5M weighted volume; below that PM falls back to non-PM behaviour.",
            "The carry in USD is identical in both columns: PM changes the capital tied up, not the funding earned.",
            "Funding is historical and can turn negative; borrow rates rise with utilization (0.05 + 4.75 x max(0, u - 0.8)).",
            "Ignores spot/perp basis drift, slippage beyond taker fees, and supply yield on idle PM assets.",
            "No comparison with a specific competing vault is made here.",
        ],
    }
    save_json(__import__("pathlib").Path(a.out), out)
    for r in rows:
        print(f"{r['metric']:<42} {r['separate-margin']:>12} {r['hypervault-pm']:>12} {r['unit']}")


if __name__ == "__main__":
    main()
