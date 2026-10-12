#!/usr/bin/env python3
"""USDC Carry planner (dry-run only): from the account's current state to a target LTV q.

Product (user's APR/LTV doc, 2026-10-12): the vault holds USDC; all spot HYPE is hedged by an equal
short; the spot is re-used as collateral and USDC is borrowed against it to grow the hedged
notional (see carry_model.py for the formulas). This tool only PLANS: it prints the ordered actions
an operator (owner + API wallet) would take, with guards. It never signs and has no --execute.

Modes
  unifiedAccount   borrowing is explicit: the API wallet signs the `borrowLend` L1 action
                   ({"type":"borrowLend","operation":supply|withdraw|borrow|repay,"token":i,
                   "amount":"x"|null}; verified on mainnet, v3 run 2). Spot HYPE is NOT perp margin
                   here, so the short is margined by USDC alone: keep its leverage low (default 2).
  portfolioMargin  borrowing is automatic against collateral when an order needs more USDC than
                   the balance, up to HYPE x borrow oracle x LTV; spot and short offset in one
                   margin ratio (liquidatable > 0.95). Needs account value > $10k. Default L = 10.

Order of operations (each round is bounded by the borrow capacity of the collateral already held):
  expand    (Unified) supply unsupplied HYPE -> borrow USDC -> buy spot -> short the filled size
            (PM)      buy spot (auto-borrow) -> short the filled size
  reduce    (Unified) close short x -> repay with freed margin -> withdraw x HYPE (health-checked)
                      -> sell x -> repay the proceeds
            (PM)      close short x -> sell x (the USDC balance repays automatically)
  unwind    reduce to zero, then repay all / withdraw all (amount null), sell what is left (>= $10).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass
from decimal import ROUND_DOWN, Decimal as D

import carry_model as cm
import core
from hvlib import STATE_DIR, load_json, utc_now
from strategy import Plan, round_px, round_size

HYPE, USDC = 150, 0


@dataclass
class CarryLimits:
    target_q: D = D("0.40")
    q_max: D = D("0.60")  # calculation scenario ceiling; not an approved default
    ltv_margin: D = D("0.05")  # q <= reserve LTV - margin
    band: D = D("0.05")  # rebalance when |q - target| exceeds this
    buffer: D = D("0.10")  # hypothetical capital only; a vault keeps its buffer on EVM
    max_notional_usd: D = D("25")  # prototype cap on the hedged notional (CLI override)
    min_order_usd: D = D("11")  # Core minimum is 10 USDC
    max_slippage_bps: int = 30
    book_depth_mult: D = D("5")
    max_delta_usd: D = D("2")
    min_rally_to_liq: D = D("0.25")  # short leg must survive a 25% HYPE rally unrebalanced
    min_fall_to_liq: D = D("0.25")  # Unified borrow must survive a 25% HYPE fall unrebalanced
    max_borrow_usage: D = D("0.70")  # Unified borrowLend: debt / (collateral x (1+LTV)/2)
    max_pm_ratio: D = D("0.50")  # PM ratio estimate x safety
    pm_ratio_safety: D = D("1.15")  # the docs formula read 9% low on a live PM account
    capacity_use: D = D("0.95")  # borrow at most this share of the remaining capacity per round
    max_rounds: int = 12
    reserve_usdc: D = D("1")  # USDC left free on Core (fees, rounding)


def market() -> dict:
    """strategy.market_view('USDC') plus funding regime and the USDC reserve state."""
    from strategy import market_view

    mk = market_view("USDC")
    hist = core.funding_history("HYPE", int(time.time() * 1000) - 7 * 86400 * 1000)

    def avg(hours):
        xs = [D(h["fundingRate"]) for h in hist[-hours:]]
        return str(sum(xs) / len(xs) * 24 * 365) if xs else None

    res = core.reserves()
    mk.update({
        "funding24hApr": avg(24), "funding7dApr": avg(168),
        "usdcUtilization": res[0].get("utilization"),
        "usdcBorrowAprByFormula": str(cm.stablecoin_borrow_apr(res[0].get("utilization", "0"))),
        "hypeReserveOracle": res[HYPE]["oraclePx"], "hypeLtv": res[HYPE]["ltv"],
    })
    return mk


def account_state(account: str) -> dict:
    """Core state in USD terms. USDC `total` from the API already carries perp equity (Unified/PM)."""
    absn = core.abstraction(account)
    raw = core.info({"type": "spotClearinghouseState", "user": account})
    bal = {b["coin"]: b for b in raw["balances"]}
    bl = core.borrow_lend(account)
    ledgers = {int(t): s for t, s in bl.get("tokenToState", [])}
    perp = core.perp_state(account)
    pos = next((p for p in perp["positions"] if p["coin"] == "HYPE"), None)
    usdc_total = D(bal.get("USDC", {}).get("total", "0"))
    hype_spot = D(bal.get("HYPE", {}).get("total", "0"))
    debt = D(ledgers.get(USDC, {}).get("borrow", {}).get("value", "0"))
    supplied = D(ledgers.get(HYPE, {}).get("supply", {}).get("value", "0"))
    if absn == "portfolioMargin":
        # PM: HYPE total is the collateral (tagged supplied); USDC total is net of the borrow.
        hype, unsupplied = hype_spot, D(0)
        usdc_gross = usdc_total + debt
    else:
        # Unified/Standard: supplied HYPE leaves the spot total; the borrowed USDC sits in it.
        hype, unsupplied = hype_spot + supplied, hype_spot
        usdc_gross = usdc_total
    return {
        "abstraction": absn, "usdcTotal": usdc_total, "usdcGross": usdc_gross, "debt": debt,
        "hype": hype, "hypeSupplied": supplied, "hypeUnsupplied": unsupplied,
        "short": -D(pos["szi"]) if pos else D(0),
        "liquidationPx": D(pos["liquidationPx"]) if pos and pos.get("liquidationPx") else None,
        "pmRatio": D(raw["portfolioMarginRatio"]) if raw.get("portfolioMarginRatio") else None,
        "healthFactor": bl.get("healthFactor"),
    }


def plan(st: dict, mk: dict, mode: str, lim: CarryLimits, leverage: D, unwind: bool, label: str,
         hypothetical: bool, vault_scope_note: bool) -> Plan:
    px = D(mk["perpMark"])
    coll_px = D(mk["hypeReserveOracle"])
    ltv = D(mk["hypeLtv"])
    mm = cm.maintenance_rate(mk["maxLeverage"])
    borrow = D(mk["usdcBorrowApr"])
    f_now, f24, f7 = D(mk["fundingApr"]), D(mk["funding24hApr"] or 0), D(mk["funding7dApr"] or 0)
    sz = min(mk["perpSzDecimals"], mk["spotSzDecimals"])
    pm = mode == "portfolioMargin"

    equity = st["usdcGross"] - st["debt"] + st["hype"] * px
    p = Plan(vault="USDC-carry", mode="dry-run", account=label, observedAt=utc_now(), hypothetical=hypothetical,
             market={k: mk[k] for k in ("perpMark", "perpOracle", "spotMark", "fundingApr", "funding24hApr",
                                        "funding7dApr", "usdcBorrowApr", "usdcUtilization", "hypeLtv",
                                        "hypeReserveOracle", "maxLeverage", "spotAsk", "spotAskSz", "perpBid",
                                        "perpBidSz")})
    q_now = st["debt"] / (st["hype"] * coll_px) if st["hype"] > 0 else D(0)
    q_cap = min(lim.q_max, ltv - lim.ltv_margin)
    target_q = D(0) if unwind else min(lim.target_q, q_cap)
    if not unwind and lim.target_q > q_cap:
        p.blocked.append(f"target q {lim.target_q} above cap {q_cap} (min of scenario max {lim.q_max} and LTV {ltv} - "
                         f"{lim.ltv_margin}); planning at {q_cap}")

    # Funding regime: the borrowed notional earns funding f and costs r; per unit LTV the breakeven
    # funding is q r + c, so the highest q that still carries is (f - c) / r.
    shape_t = cm.usdc_shape(target_q, leverage, D(0))  # per unit of Core capital (buffer off Core)
    be_t = cm.breakeven_funding(shape_t.spot, shape_t.debt, borrow)
    q_fund = (min(f24, f7) - cm.ROUND_TRIP_COST) / borrow if borrow > 0 else D(9)
    if not unwind and target_q > 0 and min(f24, f7) < be_t:
        p.blocked.append(f"funding 24h {f24:.2%} / 7d {f7:.2%} below breakeven {be_t:.2%} at q={target_q}: "
                         f"do not expand; carry holds only up to q={max(q_fund, D(0)):.2f}")
        target_q = min(target_q, max(q_fund, D(0)), q_now)
        shape_t = cm.usdc_shape(target_q, leverage, D(0))
    if not unwind and min(f24, f7) <= 0:
        p.blocked.append(f"funding 24h {f24:.2%} / 7d {f7:.2%} not positive: no new carry")

    spot_t = D(0) if unwind else min(equity * shape_t.spot, lim.max_notional_usd)
    if not unwind and equity * shape_t.spot > lim.max_notional_usd:
        p.blocked.append(f"target spot {equity * shape_t.spot:.2f} USD capped at max notional {lim.max_notional_usd}")
    debt_t = max(spot_t * (1 + 1 / leverage) - equity, D(0))

    # Risk at the target, unrebalanced.
    risk: dict = {"equityCoreUsd": str(equity.quantize(D("0.01"))), "qNow": str(q_now.quantize(D("0.0001"))),
                  "qTarget": str(target_q), "shortLeverage": str(leverage), "maintenanceRate": str(mm),
                  "spotTargetUsd": str(spot_t.quantize(D("0.01"))), "debtTargetUsd": str(debt_t.quantize(D("0.01"))),
                  "breakevenFundingAtTarget": str(be_t.quantize(D("0.0001"))),
                  "netAprAtTarget": {
                      "funding7d": str(cm.net_apr(shape_t.spot, shape_t.debt, f7, borrow).quantize(D("0.0001"))),
                      "funding24h": str(cm.net_apr(shape_t.spot, shape_t.debt, f24, borrow).quantize(D("0.0001"))),
                      "fundingNow": str(cm.net_apr(shape_t.spot, shape_t.debt, f_now, borrow).quantize(D("0.0001"))),
                      "basis": "per unit of Core capital (the EVM buffer is outside), after 10% fee, 1 round trip"}}
    if pm:
        # The short's margin stays in the USDC balance and nets the borrow (USDC total = -borrowed +
        # perp equity on a live PM account), so the ratio sees the net debt.
        margin_t = equity + debt_t - spot_t
        ratio = cm.pm_ratio(debt_t - margin_t, spot_t, spot_t, mm, ltv) * lim.pm_ratio_safety
        move = cm.pm_move_to_liquidation(ratio, spot_t, spot_t, mm, ltv)
        risk.update({"pmRatioEstimate": str(ratio.quantize(D("0.0001"))),
                     "pmMoveToLiquidation": None if move is None else str(move.quantize(D("0.0001"))),
                     "pmNote": "docs formula x 1.15 safety (read 9% low vs the API on a live PM account)"})
        if ratio > lim.max_pm_ratio:
            p.blocked.append(f"estimated PM ratio {ratio:.3f} above {lim.max_pm_ratio}")
        if move is not None and 0 < move < lim.min_rally_to_liq:
            p.blocked.append(f"PM liquidation on a {move:.1%} HYPE rally (< {lim.min_rally_to_liq:.0%})")
        if equity < cm.PM_MIN_ACCOUNT_USD:
            p.blocked.append(f"Core equity {equity:.2f} USD below the $10k Portfolio Margin requirement: PM is not "
                             "available (or falls back); plan is hypothetical")
    else:
        margin_t = equity + debt_t - spot_t
        rally = cm.unified_short_rally(margin_t, spot_t, mm)
        fall = cm.borrow_fall(debt_t, spot_t * coll_px / px, ltv)
        usage = debt_t / (spot_t * coll_px / px * cm.liq_threshold(ltv)) if debt_t > 0 and spot_t > 0 else D(0)
        risk.update({"shortRallyToLiquidation": None if rally is None else str(rally.quantize(D("0.0001"))),
                     "borrowFallToLiquidation": None if fall is None else str(fall.quantize(D("0.0001"))),
                     "borrowUsage": str(usage.quantize(D("0.0001"))),
                     "unifiedNote": "spot HYPE is not perp margin in Unified; the short is margined by USDC only"})
        if rally is not None and rally < lim.min_rally_to_liq:
            safe_l = 1 / (lim.min_rally_to_liq * (1 + mm) + mm)
            p.blocked.append(f"short liquidates on a {rally:.1%} HYPE rally (< {lim.min_rally_to_liq:.0%}); "
                             f"Unified short leverage must be <= {safe_l:.2f}")
        if fall is not None and fall < lim.min_fall_to_liq:
            p.blocked.append(f"borrow liquidates on a {fall:.1%} HYPE fall (< {lim.min_fall_to_liq:.0%})")
        if usage > lim.max_borrow_usage:
            p.blocked.append(f"borrow usage {usage:.2f} above {lim.max_borrow_usage}")
    if st["abstraction"] != mode:
        p.blocked.append(f"account abstraction is '{st['abstraction']}', plan is for '{mode}'"
                         + (" (hypothetical)" if hypothetical else ": switch mode first (owner setAbstraction)"))

    # Residual delta first.
    delta = st["hype"] - st["short"]
    risk["residualDeltaUsd"] = str((delta * px).quantize(D("0.01")))
    p.risk = risk
    p.baseExposure = {"asset": "USDC", "note": "depositor exposure is USDC; all spot HYPE is paired with the short"}
    p.extraHedge = {"spotNow": str(st["hype"]), "shortNow": str(st["short"]), "debtNow": str(st["debt"]),
                    "spotTarget": str((spot_t / px).quantize(D("0.0001"))), "debtTarget": str(debt_t.quantize(D("0.01")))}
    if abs(delta * px) > lim.max_delta_usd:
        p.actions.append(_order("HYPE", "sell" if delta > 0 else "buy", abs(delta), mk, lim, sz, reduce=delta < 0,
                                reason="residual delta: match the short to the spot first"))

    s = dict(spot=st["hype"] * px, short=st["short"] * px, debt=st["debt"], unsupplied=st["hypeUnsupplied"] * px,
             usdc=st["usdcGross"])
    if spot_t > s["spot"] + lim.min_order_usd / 2:
        _expand(p, s, spot_t, debt_t, leverage, ltv, coll_px / px, pm, mk, lim, sz)
    elif spot_t < s["spot"] - lim.min_order_usd / 2 or unwind:
        _reduce(p, s, spot_t, leverage, ltv, coll_px / px, pm, mk, lim, sz, unwind)
    else:
        p.blocked.append(f"already within {lim.min_order_usd / 2} USD of the target spot: nothing to do")
    if vault_scope_note and any(a["kind"] == "borrowLend" for a in p.actions):
        p.actions.insert(0, {"kind": "owner", "step": "roundtrip.py --execute scope --blp",
                             "reason": "count the lending ledgers in the NAV scope BEFORE any supply/borrow: with "
                                       "lending=false a supplied HYPE balance makes the NAV source revert "
                                       "(ScopeIncomplete), which closes deposits and instant redemption"})
    return p


def _order(market, side, size_base, mk, lim, sz, reduce=False, reason=""):
    slip = D(lim.max_slippage_bps) / 10_000
    spot = market.startswith("@")
    ref = D(mk["spotAsk"] if (spot and side == "buy") else mk["spotBid"] if spot else
            mk["perpAsk"] if side == "buy" else mk["perpBid"])
    px = ref * (1 + slip) if side == "buy" else ref * (1 - slip)
    return {"kind": "order", "market": market, "side": side, "size": str(round_size(D(size_base), sz)),
            "limitPx": str(round_px(px, mk["perpSzDecimals"] if not spot else mk["spotSzDecimals"], spot)),
            "tif": "Ioc", "reduceOnly": reduce, "reason": reason}


def _blp(op, token, amount, reason):
    return {"kind": "borrowLend", "signer": "API wallet",
            "action": {"type": "borrowLend", "operation": op, "token": token,
                       "amount": None if amount is None else str(D(amount).quantize(D("0.000001"), ROUND_DOWN))},
            "reason": reason}


def _depth(p, mk, base, lim):
    """One warning per book side, for the largest order of the plan."""
    for side, label in ((mk["spotAskSz"], "spot ask"), (mk["perpBidSz"], "perp bid")):
        if D(side) < base * lim.book_depth_mult:
            msg = (f"{label} touch {side} < {lim.book_depth_mult}x the largest order: split into IOC chunks of "
                   f"<= {(D(side) / lim.book_depth_mult):.2f} HYPE")
            if not any(b.startswith(f"{label} touch") for b in p.blocked):
                p.blocked.append(msg)


def _expand(p, s, spot_t, debt_t, lev, ltv, coll_ratio, pm, mk, lim, sz):
    px = D(mk["perpMark"])
    for rnd in range(1, lim.max_rounds + 1):
        need = spot_t - s["spot"]
        if need < lim.min_order_usd:
            if need > lim.min_order_usd / 2:
                p.blocked.append(f"remaining {need:.2f} USD to the target is below the {lim.min_order_usd} USD "
                                 "minimum order: left as is")
            break
        free = s["usdc"] - s["short"] / lev - lim.reserve_usdc  # USDC not tied up as short margin
        # Collateral already counted: Unified only after it is supplied; PM counts the balance.
        coll = (s["spot"] - (0 if pm else s["unsupplied"])) * coll_ratio
        if not pm and s["unsupplied"] * coll_ratio >= lim.min_order_usd / 10:
            p.actions.append(_blp("supply", HYPE, s["unsupplied"] / px, f"round {rnd}: HYPE spot becomes collateral"))
            coll = s["spot"] * coll_ratio
            s["unsupplied"] = D(0)
        capacity = max(coll * ltv - s["debt"], D(0)) * lim.capacity_use
        # x of spot (and short) costs x (1 + 1/L) USDC; borrow what free USDC does not cover.
        x = min(need, (free + min(capacity, max(debt_t - s["debt"], D(0)))) / (1 + 1 / lev))
        x = (x / px).quantize(D(1).scaleb(-sz), ROUND_DOWN) * px
        if x < lim.min_order_usd:
            p.blocked.append(f"round {rnd}: only {x:.2f} USD fundable (free {free:.2f}, capacity {capacity:.2f}); "
                             "below the minimum order")
            break
        borrow_amt = max(x * (1 + 1 / lev) - free, D(0))
        if borrow_amt > 0 and not pm:
            p.actions.append(_blp("borrow", USDC, borrow_amt, f"round {rnd}: USDC for spot + short margin"))
        _depth(p, mk, x / px, lim)
        p.actions.append(_order(mk["spotPair"], "buy", x / px, mk, lim, sz,
                                reason=f"round {rnd}: buy spot" + (" (PM auto-borrows the shortfall)" if pm else "")))
        p.actions.append(_order("HYPE", "sell", x / px, mk, lim, sz,
                                reason=f"round {rnd}: short the FILLED spot size (strategy.hedge_size)") |
                         {"size": "MATCH_SPOT_BALANCE", "leverage": int(lev)})
        s["debt"] += borrow_amt
        s["usdc"] += borrow_amt - x  # spot paid; the short's margin stays in the USDC balance
        s["spot"] += x
        s["short"] += x
        if not pm:
            s["unsupplied"] += x
    if not any(a["kind"] == "order" for a in p.actions):
        p.actions = [a for a in p.actions if a["kind"] != "borrowLend"]  # nothing fundable: no lone supply
    elif not pm and s["unsupplied"] * coll_ratio >= lim.min_order_usd / 10:
        p.actions.append(_blp("supply", HYPE, s["unsupplied"] / px, "final: last bought spot becomes collateral"))
        s["unsupplied"] = D(0)
    p.risk["afterPlan"] = {k: str(v.quantize(D("0.01"))) for k, v in s.items()}


def _reduce(p, s, spot_t, lev, ltv, coll_ratio, pm, mk, lim, sz, unwind):
    px = D(mk["perpMark"])
    usage_cap = lim.max_borrow_usage
    for rnd in range(1, lim.max_rounds + 1):
        x = s["spot"] - spot_t
        if x < lim.min_order_usd:
            break
        x = (min(x, s["short"]) / px).quantize(D(1).scaleb(-sz), ROUND_DOWN) * px
        if x < lim.min_order_usd:
            break
        p.actions.append(_order("HYPE", "buy", x / px, mk, lim, sz, reduce=True, reason=f"round {rnd}: close short first"))
        s["short"] -= x
        if not pm:
            freed = x / lev  # margin released by the closed short
            repay1 = min(freed, s["debt"])
            if repay1 > 0:
                p.actions.append(_blp("repay", USDC, repay1, f"round {rnd}: repay with the freed short margin"))
                s["debt"] -= repay1
                s["usdc"] -= repay1
            # Withdraw only as much collateral as keeps the borrow usage under the cap.
            keep = s["debt"] / (coll_ratio * cm.liq_threshold(ltv) * usage_cap) if s["debt"] > 0 else D(0)
            supplied = s["spot"] - s["unsupplied"]
            wd = min(x - s["unsupplied"], max(supplied - keep, D(0))) if x > s["unsupplied"] else D(0)
            if wd > 0:
                p.actions.append(_blp("withdraw", HYPE, wd / px, f"round {rnd}: release collateral to sell"))
                s["unsupplied"] += wd
            x = min(x, s["unsupplied"])
            x = (x / px).quantize(D(1).scaleb(-sz), ROUND_DOWN) * px
            if x < lim.min_order_usd:
                p.blocked.append(f"round {rnd}: collateral cannot be released without breaching usage {usage_cap}: "
                                 "repay from other USDC first")
                break
        p.actions.append(_order(mk["spotPair"], "sell", x / px, mk, lim, sz, reason=f"round {rnd}: sell the paired spot"))
        s["spot"] -= x
        s["usdc"] += x
        if not pm:
            s["unsupplied"] -= x
            repay2 = min(x, s["debt"])
            if repay2 > 0:
                p.actions.append(_blp("repay", USDC, repay2, f"round {rnd}: repay with the sale proceeds"))
                s["debt"] -= repay2
                s["usdc"] -= repay2
        else:
            s["debt"] = max(s["debt"] - x, D(0))  # PM: the USDC balance nets the borrow
    if unwind:
        if not pm and s["debt"] > 0:
            p.actions.append(_blp("repay", USDC, None, "unwind: repay all (null = whole debt)"))
            s["debt"] = D(0)
        if not pm and s["spot"] - s["unsupplied"] > 0:
            p.actions.append(_blp("withdraw", HYPE, None, "unwind: withdraw all collateral"))
            s["unsupplied"] = s["spot"]
        rest = s["spot"] / px
        if s["short"] > 0:
            p.actions.append(_order("HYPE", "buy", s["short"] / px, mk, lim, sz, reduce=True,
                                    reason="unwind: close the remaining short"))
        lot = round_size(rest, mk["spotSzDecimals"])
        if lot * D(mk["spotBid"]) >= D(10):  # the ROUNDED size must clear the minimum, not the balance
            p.actions.append(_order(mk["spotPair"], "sell", lot, mk, lim, sz, reason="unwind: sell the remaining spot"))
        if rest - (lot if lot * D(mk["spotBid"]) >= D(10) else D(0)) > 0:
            left = rest - (lot if lot * D(mk["spotBid"]) >= D(10) else D(0))
            p.blocked.append(f"unwind: {left:.8f} HYPE stays unsold (a {lot} lot is below the 10 USDC minimum "
                             "order or below one lot); it stays unhedged once the short is closed")
    p.risk["afterPlan"] = {k: str(v.quantize(D("0.01"))) for k, v in s.items()}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", help="Core account (default: the live v4 vault)")
    ap.add_argument("--hypo-capital", help="hypothetical USDC capital instead of an account (buffer applied)")
    ap.add_argument("--mode", choices=["unifiedAccount", "portfolioMargin"], default=None,
                    help="default: the account's abstraction (hypothetical: portfolioMargin)")
    ap.add_argument("--target-q", default="0.40")
    ap.add_argument("--leverage", default=None, help="short leverage (default Unified 2, PM 10)")
    ap.add_argument("--buffer", default="0.10")
    ap.add_argument("--max-notional", default=None)
    ap.add_argument("--unwind", action="store_true")
    ap.add_argument("--out", default=None, help="write the plan JSON here")
    args = ap.parse_args()
    lim = CarryLimits(target_q=D(args.target_q), buffer=D(args.buffer))
    if args.max_notional:
        lim.max_notional_usd = D(args.max_notional)
    mk = market()
    if args.hypo_capital:
        cap = D(args.hypo_capital) * (1 - lim.buffer)
        mode = args.mode or "portfolioMargin"
        st = {"abstraction": mode, "usdcTotal": cap, "usdcGross": cap, "debt": D(0), "hype": D(0),
              "hypeSupplied": D(0), "hypeUnsupplied": D(0), "short": D(0), "liquidationPx": None, "pmRatio": None,
              "healthFactor": None}
        label, hypo, vault_note = f"hypothetical {args.hypo_capital} USDC ({lim.buffer:.0%} buffer kept off Core)", True, False
    else:
        account = args.account or load_json(STATE_DIR / "deployment-v4.json", {}).get("vault")
        if not account:
            sys.exit("no --account and no deployment-v4.json")
        st = account_state(account)
        mode = args.mode or st["abstraction"]
        label, hypo = account, False
        vault_note = account.lower() in {load_json(STATE_DIR / f"deployment-{v}.json", {}).get("vault", "").lower()
                                         for v in ("v3", "v4", "v5")}
    lev = D(args.leverage) if args.leverage else (D(10) if mode == "portfolioMargin" else D(2))
    p = plan(st, mk, mode, lim, lev, args.unwind, label, hypo, vault_note)
    out = json.loads(json.dumps(asdict(p), default=str))
    out["limits"] = {k: str(v) for k, v in asdict(lim).items()}
    out["executes"] = False
    if args.out:
        from pathlib import Path

        from hvlib import save_json

        save_json(Path(args.out), out)
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
