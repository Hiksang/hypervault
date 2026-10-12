"""USDC Carry risk rules for one Core account, chosen by the account's actual abstraction.

Read-only: HyperCore info API only (not block-pinned). A failed read makes the rule
`unobservable`, never healthy. Rule shape matches monitor.py: id, title, unit, threshold,
observed, status (ok / warn / alert / unobservable), rationale, action.

Unified (spot HYPE is not perp margin; borrowing is explicit borrowLend):
  u-margin      maintenance / USDC collateral            warn > 0.5, alert > 0.8
  u-short-liq   HYPE rally to the short's liquidation    warn < 30%, alert < 15%
  u-borrow      borrowLend usage, fall to liquidation    warn >= 0.70, alert >= 0.85
  u-ltv         debt / collateral vs target and reserve LTV
  carry         funding 24h / 7d vs breakeven q x borrow + cost
  delta         |spot - short| x mark
Portfolio Margin (one margin ratio, liquidatable > 0.95):
  pm-ratio      API portfolioMarginRatio                 warn > 0.60, alert > 0.80
  pm-ltv        debt / (HYPE x borrow oracle) vs 65% factor and target band
  pm-move       price move to ratio 0.95 (anchored on the API ratio)    warn < 30%, alert < 15%
  pm-size       account value >= $10k (PM requirement)
  carry, delta  as above
"""
from __future__ import annotations

import time
from decimal import Decimal as D

import carry_model as cm
import core


def _rule(id_, title, unit, threshold, observed, status, rationale, action):
    return {"id": id_, "title": title, "unit": unit, "threshold": threshold,
            "observed": None if observed is None else str(observed), "status": status,
            "rationale": rationale, "action": action}


def _unobservable(spec, err, errors):
    errors.append(f"{spec[0]}: {err}"[:300])
    return _rule(*spec[:4], None, "unobservable", *spec[4:])


def read(account: str) -> dict:
    """One snapshot of everything the rules use. Raises on any failed read."""
    raw_spot = core.info({"type": "spotClearinghouseState", "user": account})
    ch = core.info({"type": "clearinghouseState", "user": account})
    meta, ctxs = core.info({"type": "metaAndAssetCtxs"})
    i = next(k for k, a in enumerate(meta["universe"]) if a["name"] == "HYPE")
    hist = core.funding_history("HYPE", int(time.time() * 1000) - 7 * 86400 * 1000)
    return {
        "abstraction": core.abstraction(account),
        "spot": {b["coin"]: b for b in raw_spot["balances"]},
        "pmRatio": raw_spot.get("portfolioMarginRatio"),
        "clearinghouse": ch,
        "borrowLend": core.borrow_lend(account),
        "reserves": core.reserves(),
        "hypeCtx": {**ctxs[i], "maxLeverage": meta["universe"][i]["maxLeverage"]},
        "funding": [D(h["fundingRate"]) for h in hist],
    }


def facts_of(s: dict) -> dict:
    """Derived numbers (USD), mode-aware. USDC `total` already carries perp equity in Unified/PM."""
    absn = s["abstraction"]
    ledgers = {int(t): st for t, st in s["borrowLend"].get("tokenToState", [])}
    res = s["reserves"]
    px = D(s["hypeCtx"]["markPx"])
    coll_px = D(res[150]["oraclePx"])
    ltv = D(res[150]["ltv"])
    spot_hype = D(s["spot"].get("HYPE", {}).get("total", "0"))
    supplied = D(ledgers.get(150, {}).get("supply", {}).get("value", "0"))
    debt = D(ledgers.get(0, {}).get("borrow", {}).get("value", "0"))
    hype = spot_hype if absn == "portfolioMargin" else spot_hype + supplied
    pos = next((p["position"] for p in s["clearinghouse"]["assetPositions"] if p["position"]["coin"] == "HYPE"), None)
    short = -D(pos["szi"]) if pos else D(0)
    usdc_total = D(s["spot"].get("USDC", {}).get("total", "0"))
    equity = (usdc_total + hype * px) if absn == "portfolioMargin" else (usdc_total - debt + hype * px)
    def avg(h):
        xs = s["funding"][-h:]
        return sum(xs) / len(xs) * 24 * 365 if xs else None
    return {
        "abstraction": absn, "markPx": px, "borrowOraclePx": coll_px, "ltvFactor": ltv,
        "maintenanceRate": cm.maintenance_rate(s["hypeCtx"]["maxLeverage"]),
        "hype": hype, "short": short, "debt": debt, "equity": equity, "usdcTotal": usdc_total,
        "q": debt / (hype * coll_px) if hype > 0 else D(0),
        "liquidationPx": D(pos["liquidationPx"]) if pos and pos.get("liquidationPx") else None,
        "maint": D(s["clearinghouse"].get("crossMaintenanceMarginUsed") or 0),
        "upnl": D(pos["unrealizedPnl"]) if pos else D(0),
        "pmRatio": D(s["pmRatio"]) if s.get("pmRatio") else None,
        "borrowApr": D(res[0]["borrowYearlyRate"]), "utilization": D(res[0].get("utilization", "0")),
        "fundingNow": D(s["hypeCtx"]["funding"]) * 24 * 365, "funding24h": avg(24), "funding7d": avg(168),
    }


def rules(account: str, target_q: D | None = None, band: D = D("0.05")) -> tuple[list, list, dict]:
    errors: list = []
    try:
        f = facts_of(read(account))
    except Exception as exc:
        spec = ("carry-read", "USDC Carry account reads", "-", "all reads succeed",
                "Every rule below needs the account and market reads.", "Retry; check the API and RPC rotation.")
        return [_unobservable(spec, exc, errors)], errors, {}
    out = []
    pm = f["abstraction"] == "portfolioMargin"
    px, hype, short, debt = f["markPx"], f["hype"], f["short"], f["debt"]

    # Carry spread: funding must beat the borrow on the levered part. Breakeven = q r + cost.
    be = f["q"] * f["borrowApr"] + cm.ROUND_TRIP_COST
    spec = ("carry", "Funding (24h / 7d) vs carry breakeven (q x borrow APR + 0.23%)", "APR",
            "warn: 24h < breakeven; alert: 7d < breakeven (with a short open)",
            "The levered notional earns funding and pays the USDC borrow; below breakeven the carry loses money.",
            "24h below: stop expanding. 7d below: deleverage to q <= (7d funding - 0.23%) / borrow APR (usdc_carry.py).")
    f24, f7 = f["funding24h"], f["funding7d"]
    st = ("alert" if short > 0 and f7 is not None and f7 < be else
          "warn" if short > 0 and f24 is not None and f24 < be else "ok")
    out.append(_rule(*spec[:4], f"24h {f24:.2%} · 7d {f7:.2%} · now {f['fundingNow']:.2%} vs breakeven {be:.2%} "
                     f"(q {f['q']:.3f}, borrow {f['borrowApr']:.2%}, util {f['utilization']:.1%})", st, *spec[4:]))

    # Residual delta.
    spec = ("delta", "Residual delta |spot HYPE - short| x mark", "USD", "warn > max(2, 1% notional), alert > 5%",
            "USDC Carry hedges all spot; any difference is directional exposure.",
            "Rebalance the short to the spot (strategy hedge_size).")
    dev = abs(hype - short) * px
    ntl = max(short * px, D(1))
    out.append(_rule(*spec[:4], f"{dev:.2f} (spot {hype} / short {short})",
                     "alert" if dev > ntl * D("0.05") and dev > 2 else "warn" if dev > max(D(2), ntl * D("0.01")) else "ok",
                     *spec[4:]))

    if pm:
        spec = ("pm-ratio", "Portfolio margin ratio (API)", "ratio", "warn > 0.60, alert > 0.80 (liquidatable > 0.95)",
                "Docs: max over borrowable tokens of maintenance requirement / liquidation value.",
                "Reduce the levered notional or add USDC/HYPE.")
        r = f["pmRatio"]
        out.append(_rule(*spec[:4], r, "unobservable" if r is None else
                         "alert" if r > D("0.80") else "warn" if r > D("0.60") else "ok", *spec[4:])
                   if r is not None else _unobservable(spec, "no portfolioMarginRatio in the API", errors))

        spec = ("pm-ltv", "LTV used: USDC debt / (HYPE x borrow oracle)", "ratio",
                "warn: > target + band or > 0.60; alert: > 0.65 factor",
                "0.65 is the new-borrow factor, not a liquidation line; above it no new auto-borrow.",
                "Deleverage toward the target band (usdc_carry.py --target-q).")
        q = f["q"]
        hi = (target_q + band) if target_q is not None else D("0.60")
        out.append(_rule(*spec[:4], f"{q:.4f} (target {target_q}, band {band})",
                         "alert" if q > f["ltvFactor"] else "warn" if q > min(hi, D("0.60")) else "ok", *spec[4:]))

        spec = ("pm-move", "HYPE move to PM liquidation (ratio 0.95), anchored on the API ratio", "%",
                "warn < 30%, alert < 15% (either direction)",
                "Short losses add to the debt 1:1 while HYPE counts at (1 + LTV)/2: a rally is the usual risk.",
                "Reduce size or rebalance (buy spot / add to short at the new price).")
        if r is not None and hype > 0:
            mv = cm.pm_move_to_liquidation(r, hype * f["borrowOraclePx"], short * px, f["maintenanceRate"], f["ltvFactor"])
            st = "ok" if mv is None else "alert" if abs(mv) < D("0.15") else "warn" if abs(mv) < D("0.30") else "ok"
            out.append(_rule(*spec[:4], "none in model" if mv is None else f"{mv:+.1%} (linear estimate)", st, *spec[4:]))
        else:
            out.append(_unobservable(spec, "no ratio or no HYPE", errors))

        spec = ("pm-size", "Account value for Portfolio Margin", "USD", ">= 10,000",
                "Docs: PM needs master account value > $10k (or > $5M weighted volume) and < $25M.",
                "Below it PM falls back: recheck margin as Unified.")
        out.append(_rule(*spec[:4], f"{f['equity']:.2f}", "warn" if f["equity"] < cm.PM_MIN_ACCOUNT_USD else "ok", *spec[4:]))
    else:
        spec = ("u-margin", "Maintenance / USDC collateral (Unified)", "ratio", "warn > 0.5, alert > 0.8",
                "In Unified the short is margined by the USDC balance only (spot HYPE is not perp margin).",
                "Add USDC or reduce the short.")
        coll = f["usdcTotal"]  # API USDC total carries perp equity in Unified
        ratio = f["maint"] / coll if coll > 0 else (D(0) if f["maint"] == 0 else D(99))
        out.append(_rule(*spec[:4], f"{ratio:.3f} (maint {f['maint']} / USDC {coll:.4f})",
                         "alert" if ratio > D("0.8") else "warn" if ratio > D("0.5") else "ok", *spec[4:]))

        spec = ("u-short-liq", "HYPE rally to the short's liquidation price", "%", "warn < 30%, alert < 15%",
                "A USDC-margined short liquidates on a rally; the spot gain does not margin it in Unified.",
                "Lower the short leverage: add USDC margin or reduce size.")
        lp = f["liquidationPx"]
        if short > 0 and lp:
            up = lp / px - 1
            out.append(_rule(*spec[:4], f"{up:.1%} (liq {lp:.2f} / mark {px})",
                             "alert" if up < D("0.15") else "warn" if up < D("0.30") else "ok", *spec[4:]))
        else:
            out.append(_rule(*spec[:4], "no short", "ok", *spec[4:]))

        spec = ("u-borrow", "borrowLend usage: debt / (collateral x (1 + LTV)/2)", "ratio",
                "warn >= 0.70, alert >= 0.85", "Partial liquidation at 1.0; a HYPE fall raises usage, the short's gain "
                "does not repay the borrow by itself.", "Repay USDC (short gains first) or supply more HYPE.")
        if debt > 0:
            c = hype * f["borrowOraclePx"]
            usage = debt / (c * cm.liq_threshold(f["ltvFactor"])) if c > 0 else D(99)
            fall = cm.borrow_fall(debt, c, f["ltvFactor"])
            out.append(_rule(*spec[:4], f"{usage:.3f} (fall to liquidation {fall:.1%})",
                             "alert" if usage >= D("0.85") else "warn" if usage >= D("0.70") else "ok", *spec[4:]))
        else:
            out.append(_rule(*spec[:4], "no borrow", "ok", *spec[4:]))

        spec = ("u-ltv", "LTV used: USDC debt / HYPE collateral vs target and reserve LTV", "ratio",
                "warn: > target + band or > reserve LTV - 0.05; alert: > reserve LTV",
                "Above the reserve LTV new borrows stop and the position drifts toward liquidation.",
                "Deleverage toward the target (usdc_carry.py).")
        q = f["q"]
        lim = min((target_q + band) if target_q is not None else D(1), f["ltvFactor"] - D("0.05"))
        out.append(_rule(*spec[:4], f"{q:.4f} (target {target_q}, reserve LTV {f['ltvFactor']})",
                         "alert" if q > f["ltvFactor"] else "warn" if q > lim else "ok", *spec[4:]))
    fx = {k: (str(v) if isinstance(v, D) else v) for k, v in f.items()}
    return out, errors, fx
