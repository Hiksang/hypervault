#!/usr/bin/env python3
"""HyperVault rule-based monitor + advisory AI summary. Read-only unless `--keeper` is given.

Rules are deterministic and computed from onchain reads (HyperEVM RPC, read-precompile backed
verifier views) and the HyperCore HTTP API. A read failure makes the affected rule
`unobservable`; it is never treated as healthy.

AI (optional, advisory): the rule results are summarized into causes / impact / response
candidates by Claude. The model receives only the rule table and errors, has no tools, cannot
sign, cannot change limits and cannot move funds. If it fails the rule engine result stands.

--keeper sends the permissionless `recordPrice` when a record is due (the only write).
--loop runs every --interval seconds under a single-instance lock, persisting state, a JSONL log,
deduplicated alerts and the last success time.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from decimal import Decimal as D

import core
from hvlib import ROOT, STATE_DIR, USDC, addr, call, load_json, native_balance, save_json, send, utc_now

STATE = STATE_DIR / "monitor-state.json"
LOG = STATE_DIR / "monitor.jsonl"
ALERTS = STATE_DIR / "alerts.jsonl"
LOCK = STATE_DIR / "monitor.lock"
OUT = ROOT / "frontend" / "public" / "hypervault" / "monitor.json"
REALERT_SECONDS = 3600
AI_MODEL = os.environ.get("HV_AI_MODEL", "claude-haiku-5-5")
VERSION = os.environ.get("HV_VERSION", "v4")  # deployment the monitor watches


def _first(x):
    v = x[0] if isinstance(x, list) else x
    return str(v).split()[0]


def rule(id_, title, unit, threshold, observed, status, rationale, action):
    return {"id": id_, "title": title, "unit": unit, "threshold": threshold,
            "observed": None if observed is None else str(observed), "status": status,
            "rationale": rationale, "action": action}


def unobservable(id_, title, unit, threshold, rationale, action, err, errors):
    errors.append(f"{id_}: {err}"[:300])
    return rule(id_, title, unit, threshold, None, "unobservable", rationale, action)


def evaluate(dep: dict, state: dict, expect: dict) -> tuple[list, list, dict]:
    v, ver, src = dep["vault"], dep["verifier"], dep["source"]
    rules, errors, facts = [], [], {}

    # --- EVM vault state
    try:
        phase = int(_first(call(v, "phase()(uint8)")))
        facts["phase"] = ["Uninitialized", "AwaitingActivation", "Ready", "Idle", "Active", "Exiting"][phase]
        facts["availableCash"] = int(_first(call(v, "availableCash()(uint256)")))
        facts["reserved"] = int(_first(call(v, "reservedClaimAssets()(uint256)")))
        facts["evmUsdc"] = int(_first(call(USDC, "balanceOf(address)(uint256)", v)))
        facts["accountedCash"] = int(_first(call(v, "accountedCash()(uint256)")))
        pa = call(v, "pendingAction()(uint256,bytes32,uint64,uint8,uint256,address)")
        facts["pendingId"] = int(_first(pa[0]))
        facts["pendingKind"] = ["None", "Deposit", "Recall", "Agent", "RevokeAgent", "Control"][int(_first(pa[3]))]
        facts["apiWallet"] = _first(call(v, "apiWallet()(address)"))
        evm_ok = True
    except Exception as exc:
        evm_ok = False
        errors.append(f"evm-read: {exc}"[:300])

    # --- Core API state
    try:
        spot = core.spot_balances(v)
        perp = core.perp_state(v)
        absn = core.abstraction(v)
        bl = core.borrow_lend(v)
        mids = core.mids()
        res = core.reserves()
        core_ok = True
    except Exception as exc:
        core_ok = False
        errors.append(f"core-api: {exc}"[:300])

    # R1 NAV vs Core ledger (API) reconciliation
    t1 = ("nav-ledger", "Verifier NAV vs EVM cash + Core API equity", "USDC", "|diff| <= max(0.50, 0.5%)",
          "Onchain NAV (read precompiles over the registered scope) must match an independent API view; a gap means "
          "unregistered holdings, a stale read or a valuation bug.",
          "Pause deposits (owner) and inspect scope / unregistered holdings before the next allocation.")
    try:
        if not (evm_ok and core_ok):
            raise RuntimeError("inputs unavailable")
        if facts["phase"] in ("Idle", "AwaitingActivation"):
            rules.append(rule(*t1[:4], "Idle: NAV = EVM cash", "ok", *t1[4:]))
        else:
            n = call(ver, "nav(address)(uint256,uint64)", v)
            nav = D(_first(n[0])) / D(10**6)
            api_core = _api_equity_usdc(spot, perp, mids, bl, res)
            api_total = D(facts["availableCash"]) / D(10**6) + api_core
            diff = nav - api_total
            facts.update({"navUsdc": str(nav), "apiEquityUsdc": str(api_total), "navCoreBlock": _first(n[1])})
            lim = max(D("0.5"), api_total * D("0.005"))
            rules.append(rule(*t1[:4], f"nav={nav:.4f} api={api_total:.4f} diff={diff:+.4f}",
                              "ok" if abs(diff) <= lim else "alert", *t1[4:]))
    except Exception as exc:
        rules.append(unobservable(*t1, exc, errors))

    # R2 EVM ledger: real USDC balance must cover accounted cash
    t2 = ("evm-ledger", "EVM USDC balance covers accounted cash + claim reserve", "USDC", "balance >= accountedCash",
          "A shortfall means the Vault's books exceed its real ERC-20 balance.", "Stop all owner actions; investigate.")
    if evm_ok:
        ok = facts["evmUsdc"] >= facts["accountedCash"]
        rules.append(rule(*t2[:4], f"balance={facts['evmUsdc'] / 1e6} accounted={facts['accountedCash'] / 1e6}",
                          "ok" if ok else "alert", *t2[4:]))
    else:
        rules.append(unobservable(*t2, "evm read failed", errors))

    # R3 unregistered holdings
    t3 = ("unregistered", "Core holdings outside the registered scope", "USD", "warn > 1, alert >= 10",
          "Holdings outside the scope are invisible to NAV and can dilute depositors (scope completeness is owner-trusted).",
          "Register the venue via source.configure or bring the holding back into scope.")
    try:
        if not core_ok:
            raise RuntimeError("core api failed")
        # v5+/ADR-040 TokenState adds (perpOracle, perp, perpSzDecimals).
        token_t = "(uint32,uint32,bool,bool,uint8,uint8,bool,uint32,uint8)" if VERSION in ("v5", "v6") else \
            "(uint32,uint32,bool,bool,uint8,uint8)"
        sc = call(src, f"scope(address)(uint64,bool,{token_t}[],uint32[],address[])", v)
        registered = {int(item[0]) for item in sc[2]}
        outside = []
        for coin, b in spot.items():
            if b["token"] not in registered and D(b["total"]) > 0:
                px = D(mids.get(coin, "0")) if coin != "USDC" else D(1)
                outside.append((coin, D(b["total"]) * px))
        worst = max((x[1] for x in outside), default=D(0))
        st = "alert" if worst >= 10 else "warn" if worst > 1 else "ok"
        rules.append(rule(*t3[:4], json.dumps({c: f"{u:.2f}" for c, u in outside}) or "none", st, *t3[4:]))
        facts["registeredTokens"] = sorted(registered)
    except Exception as exc:
        rules.append(unobservable(*t3, exc, errors))

    # R4 account abstraction mode
    t4 = ("abstraction", "Core account abstraction mode", "mode", f"== {expect['abstraction']}",
          "Margin behaviour and borrowing depend on the mode; PM falls back when ineligible or caps hit.",
          "If unexpected, stop new expansion; confirm the CoreWriter action and eligibility.")
    if core_ok:
        rules.append(rule(*t4[:4], absn, "ok" if absn == expect["abstraction"] else "alert", *t4[4:]))
        facts["abstraction"] = absn
    else:
        rules.append(unobservable(*t4, "core api failed", errors))

    # R5 borrowing & interest
    t5 = ("borrow", "USDC borrow and borrow APR", "USDC / APR", "APR <= 12%",
          "Borrow cost above funding makes the carry negative. Borrowing is automatic in PM and manual (borrowLend, "
          "API wallet) in Standard/Unified; both are expected paths.",
          "Stop expansion; reduce the extra leg if borrow APR exceeds funding.")
    try:
        if not core_ok:
            raise RuntimeError("core api failed")
        borrowed = sum(D(s["borrow"]["value"]) for _, s in bl.get("tokenToState", []))
        apr = D(res[0]["borrowYearlyRate"])
        st = "warn" if borrowed > 0 and apr > D("0.12") else "ok"
        rules.append(rule(*t5[:4], f"borrowed={borrowed} usdcBorrowApr={apr}", st, *t5[4:]))
    except Exception as exc:
        rules.append(unobservable(*t5, exc, errors))

    # R14 BLP health: manual borrow against supplied HYPE/BTC (docs: support/faq/manual-borrows)
    t14 = ("blp-health", "Borrow health: borrowed vs supplied collateral", "ratio",
           "liquidation usage warn >= 0.70, alert >= 0.85 (or health factor < 1.05)",
           "Partial liquidation starts when borrowed value exceeds collateral x (1+LTV)/2 (HYPE 82.5%, BTC 75%). "
           "Health factor < 100% only stops new borrows. Price falls, interest and withdrawals move it.",
           "Repay USDC or supply more collateral (API wallet borrowLend); stop new borrows.")
    try:
        if not core_ok:
            raise RuntimeError("core api failed")
        h = blp_health(bl, res)
        facts["blpHealth"] = {k: str(x) for k, x in h.items()}
        if h["borrowedUsd"] == 0:
            rules.append(rule(*t14[:4], "no borrow", "ok", *t14[4:]))
        else:
            st = ("alert" if h["liquidationUsage"] >= D("0.85") else
                  "warn" if h["liquidationUsage"] >= D("0.70") or h["healthFactor"] < D("1.05") else "ok")
            rules.append(rule(*t14[:4], f"usage={h['liquidationUsage']:.3f} healthFactor={h['healthFactor']:.3f} "
                              f"borrowed=${h['borrowedUsd']:.2f} collateralDropToLiquidation={h['dropToLiquidation']:.1%}"
                              + (" (PM: Hyperliquid uses a separate calculation)" if absn == "portfolioMargin" else ""),
                              st, *t14[4:]))
    except Exception as exc:
        rules.append(unobservable(*t14, exc, errors))

    # R6 funding: the carry's income. Hourly rates swing; the regime is what matters.
    t6 = ("funding", "Funding on the hedge perp (now, 24h and 7d average)", "APR",
          "warn: 24h avg < 0 while short; alert: 7d avg < 0 while short",
          "Shorts pay when funding is negative; a negative 7-day average means the carry has inverted, not a blip "
          "(HYPE 90d: ~9% of hours negative).",
          "24h negative: stop adding. 7d negative: unwind the hedge leg (strategy --unwind) or park in USDC.")
    try:
        ctx = core.perp_ctx(expect["perp"])
        now_apr = D(ctx["funding"]) * 24 * 365
        hist = core.funding_history(expect["perp"], int(time.time() * 1000) - 7 * 86400 * 1000)
        def avg(hours):
            xs = [D(h["fundingRate"]) for h in hist[-hours:]]
            return sum(xs) / len(xs) * 24 * 365 if xs else None
        a24, a7 = avg(24), avg(168)
        short = any(p["coin"] == expect["perp"] and D(p["szi"]) < 0 for p in perp["positions"]) if core_ok else False
        facts["funding"] = {"nowApr": str(now_apr), "avg24hApr": str(a24), "avg7dApr": str(a7)}
        st = ("alert" if short and a7 is not None and a7 < 0 else
              "warn" if short and a24 is not None and a24 < 0 else "ok")
        rules.append(rule(*t6[:4], f"now {now_apr:.2%} · 24h {a24:.2%} · 7d {a7:.2%} (short open: {short})", st, *t6[4:]))
    except Exception as exc:
        rules.append(unobservable(*t6, exc, errors))

    # R7 delta deviation (USDC carry: spot base minus gas reserve vs short)
    t7 = ("delta", "Hedge delta |spot - short| x mark", "USD", "<= 2",
          "Unhedged size is directional exposure the product does not intend.",
          "Rebalance with the strategy runner (dry-run first).")
    try:
        if not core_ok:
            raise RuntimeError("core api failed")
        base = D(spot.get(expect["base"], {}).get("total", "0")) - D(expect["gasReserve"])
        sh = -sum(D(p["szi"]) for p in perp["positions"] if p["coin"] == expect["perp"])
        px = D(mids[expect["perp"]])
        dev = abs(max(base, D(0)) - sh) * px
        rules.append(rule(*t7[:4], f"{dev:.2f} (spot {base:+} / short {sh})", "alert" if dev > 2 else "ok", *t7[4:]))
    except Exception as exc:
        rules.append(unobservable(*t7, exc, errors))

    # R8 pending Core action age
    t8 = ("pending", "Pending Core action age", "seconds", "warn > 300, alert > 1800",
          "Core actions are asynchronous; a pending action closes deposits and blocks the next owner action.",
          "Run sync after a later Core block; for a recall that never arrives, abandonRecall + timeout.")
    if evm_ok:
        pid = facts["pendingId"]
        seen = state.setdefault("pendingSeen", {})
        if pid:
            seen.setdefault(str(pid), time.time())
            age = int(time.time() - seen[str(pid)])
            st = "alert" if age > 1800 else "warn" if age > 300 else "ok"
            rules.append(rule(*t8[:4], f"#{pid} {facts['pendingKind']} age>={age}s", st, *t8[4:]))
        else:
            seen.clear()
            rules.append(rule(*t8[:4], "none", "ok", *t8[4:]))
    else:
        rules.append(unobservable(*t8, "evm read failed", errors))

    # R9 gas
    t9 = ("gas", "Gas: owner EVM HYPE and Vault Core HYPE (Core->EVM transfer gas)", "HYPE",
          "owner >= 0.02; vault core >= 0.002", "Without gas the owner cannot sync/recall; Core->EVM transfers pay 200k gas in HYPE on Core.",
          "Top up the owner; keep a HYPE reserve on the Vault's Core spot.")
    try:
        og = D(native_balance(addr("owner"))) / D(10**18)
        cg = D(spot.get("HYPE", {}).get("total", "0")) if core_ok else None
        st = "warn" if og < D("0.02") or (cg is not None and cg < D("0.002") and facts.get("phase") == "Active") else "ok"
        rules.append(rule(*t9[:4], f"owner={og:.4f} vaultCore={cg}", st, *t9[4:]))
    except Exception as exc:
        rules.append(unobservable(*t9, exc, errors))

    # R10 margin health
    t10 = ("margin", "Maintenance margin / collateral (Unified: USDC balance + uPnL)", "ratio", "warn > 0.5, alert > 0.8",
           "Liquidation at 1.0. In Unified mode the perp DEX account value is only the margin assigned to the position; "
           "the collateral is the whole USDC balance, so the ratio uses it.",
           "Reduce the hedge or add USDC margin.")
    if core_ok:
        mm = D(perp.get("crossMaintenanceMarginUsed") or 0)
        upnl = sum(D(p["unrealizedPnl"] or 0) for p in perp["positions"])
        if absn in ("unifiedAccount", "portfolioMargin"):
            collateral = D(spot.get("USDC", {}).get("total", "0")) + upnl
        else:
            collateral = D(perp["accountValue"])
        r = (mm / collateral) if collateral > 0 else (D(0) if mm == 0 else D(99))
        rules.append(rule(*t10[:4], f"{r:.3f} (maint {mm} / collateral {collateral:.4f})",
                          "alert" if r > D("0.8") else "warn" if r > D("0.5") else "ok", *t10[4:]))
    else:
        rules.append(unobservable(*t10, "core api failed", errors))

    # R11 price history (issuance and exit need it)
    t11 = ("price-history", "Latest share-price record age", "seconds", "<= priceWindow/2 (keeper records every priceWindow/8)",
           "Deposits and exit settlement require recent price history (half a window).",
           "Run the keeper (recordPrice is permissionless).")
    try:
        recs = call(ver, "priceRecords(address)((uint192,uint64)[8])", v)[0]
        times = [int(r[1]) for r in recs if int(r[1]) > 0]
        last = max(times) if times else 0
        window = int(_first(call(ver, "priceWindow()(uint256)")))
        age = int(time.time()) - last if last else None
        facts["lastPriceRecordAge"] = age
        facts["priceWindow"] = window
        # v3 (ADR-038): records only tighten the fee price, deposits do not need them.
        # v4 (ADR-039): instant redemption (redeemNow) fails closed without a record in the window.
        # v5 (ADR-040): the oracle-valued NAV needs none; records only tighten the fee price.
        st = "ok" if VERSION in ("v3", "v5", "v6") else "warn" if age is None or age > window // 2 else "ok"
        rules.append(rule(*t11[:4], "never" if age is None else f"{age}s", st, *t11[4:]))
    except Exception as exc:
        rules.append(unobservable(*t11, exc, errors))

    # R13 liquidity buffer (operator policy, ADR-036)
    t13 = ("buffer", "Free EVM cash vs target buffer", "USDC", "free >= max(1, 10% NAV, requested-share value)",
           "Free cash is the only liquidity outside Core; the vault does not enforce a buffer (owner policy).",
           "Allocate less, or recall to restore the buffer before more requests arrive.")
    try:
        import roundtrip as _rt
        plan = _rt.buffer_plan(v)
        if "error" in plan:
            raise RuntimeError(plan["error"])
        st = "ok" if plan["freeCash"] >= plan["targetBuffer"] or facts.get("phase") in ("Idle", "AwaitingActivation") else "warn"
        rules.append(rule(*t13[:4], f"free={plan['freeCash'] / 1e6} target={plan['targetBuffer'] / 1e6}", st, *t13[4:]))
    except Exception as exc:
        rules.append(unobservable(*t13, exc, errors))

    # R15 redemption SLA (operator commitment, docs #/docs): settle Active requests within 72 hours
    t15 = ("redeem-sla", "Oldest unsettled redeem request in the open epoch", "hours", "warn > 24, alert > 72",
           "Active redemptions are paid only after the owner exits; the published commitment is settlement within "
           "72 hours of a request.",
           "Owner: beginExit, unwind, recall and settle the epoch.")
    try:
        if not evm_ok:
            raise RuntimeError("evm read failed")
        epoch = int(_first(call(v, "activeEpochId()(uint256)")))
        e = call(v, "epochs(uint256)(uint256,uint256,uint256,uint256,uint256,bool,bool)", epoch) if epoch else None
        requested = int(_first(e[0])) if e and str(e[6]).lower() == "false" else 0
        seen = state.setdefault("redeemSeen", {})
        if requested and facts["phase"] in ("Active", "Exiting"):
            seen.setdefault(str(epoch), time.time())
            hours = (time.time() - seen[str(epoch)]) / 3600
            st = "alert" if hours > 72 else "warn" if hours > 24 else "ok"
            rules.append(rule(*t15[:4], f"epoch {epoch}: {requested / 1e9:g} shares waiting {hours:.1f}h "
                              "(age counted from first observation)", st, *t15[4:]))
        else:
            seen.clear()
            rules.append(rule(*t15[:4], "no waiting request", "ok", *t15[4:]))
    except Exception as exc:
        rules.append(unobservable(*t15, exc, errors))

    # R12 withdrawal pipeline
    t12 = ("withdrawals", "Redeem queue: reserved claims covered by cash", "USDC", "reserved <= EVM balance",
           "Settled claims must be payable from EVM cash.", "Owner must recall before claims can be paid.")
    if evm_ok:
        rules.append(rule(*t12[:4], f"reserved={facts['reserved'] / 1e6}", "ok" if facts["reserved"] <= facts["evmUsdc"] else "alert", *t12[4:]))
    else:
        rules.append(unobservable(*t12, "evm read failed", errors))
    return rules, errors, facts


def blp_health(bl: dict, res: dict) -> dict:
    """Manual-borrow health from borrowLendUserState and the reserve states (oracle price, LTV).

    healthFactor     = sum(supplied x oracle x LTV) / borrowed           (docs; < 1 stops new borrows)
    liquidationUsage = borrowed / sum(supplied x oracle x (1+LTV)/2)     (partial liquidation at 1)
    dropToLiquidation = 1 - liquidationUsage: uniform collateral price fall that reaches liquidation.
    """
    borrowed = capacity = liq = D(0)
    for token, st in bl.get("tokenToState", []):
        r = res.get(int(token)) or res.get(str(token))
        if r is None:
            raise RuntimeError(f"no reserve state for token {token}")
        px, ltv = D(r["oraclePx"]), D(r["ltv"])
        borrowed += D(st["borrow"]["value"]) * px
        if ltv > 0:
            supplied = D(st["supply"]["value"]) * px
            capacity += supplied * ltv
            liq += supplied * (1 + ltv) / 2
    usage = borrowed / liq if liq > 0 else (D(0) if borrowed == 0 else D(99))
    hf = capacity / borrowed if borrowed > 0 else D(99)
    return {"borrowedUsd": borrowed, "borrowCapacityUsd": capacity, "liquidationCapacityUsd": liq,
            "healthFactor": hf, "liquidationUsage": usage, "dropToLiquidation": max(D(1) - usage, D(0))}


def _api_equity_usdc(spot, perp, mids, bl=None, res=None) -> D:
    total = D(0)
    # Lending ledgers (BLP): supplied collateral counts, borrowed quote is owed; at the reserve oracle.
    for token, st in (bl or {}).get("tokenToState", []):
        px = D((res or {})[int(token)]["oraclePx"])
        total += (D(st["supply"]["value"]) - D(st["borrow"]["value"])) * px
    for coin, b in spot.items():
        px = D(1) if coin == "USDC" else D(mids.get(coin, "0"))
        total += D(b["total"]) * px
    # In Unified mode perp margin/PnL lives in the spot USDC balance; add only unrealized PnL.
    total += sum(D(p["unrealizedPnl"] or 0) for p in perp["positions"])
    return total


HISTORY = STATE_DIR / f"nav-history-{VERSION}.jsonl"
HISTORY_OUT = ROOT / "frontend" / "public" / "hypervault" / "nav-history.json"


def share_price(nav6: int, supply9: int) -> float | None:
    """USDC per whole share with the vault's virtual offset; None when no shares exist."""
    if supply9 == 0:
        return None
    return (nav6 + 1) / (supply9 + 1000) * 1000


def _nav_point(dep: dict, facts: dict) -> None:
    """Append one NAV / share-price point and publish the series for the FE (display only)."""
    try:
        v = dep["vault"]
        supply = int(_first(call(v, "totalSupply()(uint256)")))
        if facts.get("phase") in ("Idle", "AwaitingActivation"):
            nav = int(facts["availableCash"])
        else:
            nav = int(_first(call(dep["verifier"], "nav(address)(uint256,uint64)", v)[0]))
        point = {"t": int(time.time()), "nav": nav / 1e6, "supply": supply / 1e9, "price": share_price(nav, supply),
                 "phase": facts.get("phase"), "source": "monitor"}
    except Exception as exc:
        facts["navHistoryError"] = str(exc)[:200]
        return
    with HISTORY.open("a") as f:
        f.write(json.dumps(point) + "\n")
    publish_history(dep)


def publish_history(dep: dict) -> None:
    points = [json.loads(l) for l in HISTORY.read_text().splitlines() if l.strip()] if HISTORY.exists() else []
    points.sort(key=lambda p: p["t"])
    save_json(HISTORY_OUT, {"schema": "hypervault.navHistory.v1", "vault": dep["vault"], "contractVersion": VERSION,
                            "generatedAt": utc_now(), "unit": "USDC; price = USDC per whole share",
                            "note": "Monitor and ledger snapshots, not continuous. A point with price null means no "
                                    "shares existed; returns are not measured across such gaps.",
                            "points": points[-5000:]})


def backfill_from_ledger(dep: dict) -> int:
    """Seed the series from the round-trip ledgers' after-snapshots (same vault only)."""
    from datetime import datetime

    seen = {json.loads(l)["t"] for l in HISTORY.read_text().splitlines() if l.strip()} if HISTORY.exists() else set()
    added = 0
    for path in sorted(STATE_DIR.glob(f"ledger-{VERSION}-run*.jsonl")):
        for line in path.read_text().splitlines():
            row = json.loads(line)
            snap = row.get("after")
            if not isinstance(snap, dict) or not isinstance(snap.get("vault"), dict):
                continue
            vs = snap["vault"]
            try:
                supply = int(vs["totalSupply"])
                nav = int(vs["availableCash"]) if vs.get("phaseName") in ("Idle", "AwaitingActivation") \
                    else int(vs["verifierNav"]["assets"])
            except (KeyError, TypeError, ValueError):
                continue  # a blocked NAV read is skipped, never recorded as zero
            t = int(datetime.fromisoformat(snap["observedAt"].replace("Z", "+00:00")).timestamp())
            if t in seen:
                continue
            seen.add(t)
            with HISTORY.open("a") as f:
                f.write(json.dumps({"t": t, "nav": nav / 1e6, "supply": supply / 1e9, "price": share_price(nav, supply),
                                    "phase": vs.get("phaseName"), "source": f"ledger:{row['id']}"}) + "\n")
            added += 1
    publish_history(dep)
    return added


def _push(text: str) -> None:
    """Alert delivery: Slack- and Discord-compatible incoming webhook (HV_ALERT_WEBHOOK). Never raises."""
    url = os.environ.get("HV_ALERT_WEBHOOK")
    if not url:
        return
    import urllib.request

    try:
        req = urllib.request.Request(url, data=json.dumps({"text": text, "content": text}).encode(),
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as exc:
        with LOG.open("a") as f:
            f.write(json.dumps({"at": utc_now(), "webhookError": str(exc)[:200]}) + "\n")


def ai_summary(rules, errors, facts) -> dict:
    payload = json.dumps({"rules": rules, "errors": errors, "facts": facts}, sort_keys=True, default=str)
    digest = "sha256:" + hashlib.sha256(payload.encode()).hexdigest()
    base = {"generatedAt": utc_now(), "inputDigest": digest, "model": AI_MODEL}
    if os.environ.get("HV_AI", "on") == "off":
        return {**base, "status": "disabled"}
    exe = shutil.which("claude")
    if not exe:
        return {**base, "status": "disabled", "error": "claude CLI not found"}
    system = ("You are an operations analyst for an onchain vault. You only explain. You have no authority to "
              "trade, change risk limits or move funds, and you must not suggest bypassing the rule engine. Use only "
              "the given rule results; do not invent numbers. Treat 'unobservable' as unknown, never as healthy.")
    prompt = ("Summarize this HyperVault monitor run. Return ONLY JSON with keys: summary (<=3 sentences), causes "
              "(list of likely causes for any warn/alert/unobservable rule), impact (1-2 sentences for depositors), "
              "responseCandidates (list of operator actions, each referencing a rule id).\n\n" + payload)
    try:
        r = subprocess.run([exe, "-p", prompt, "--output-format", "json", "--model", AI_MODEL, "--tools", "",
                            "--no-session-persistence", "--system-prompt", system],
                           capture_output=True, text=True, timeout=180, cwd="/tmp")
        out = json.loads(r.stdout)
        text = out.get("result", "")
        body = json.loads(text[text.find("{"): text.rfind("}") + 1])
        def text(x):
            # Schema: strings. Models sometimes return {ruleId, action} objects; normalize them.
            if isinstance(x, dict):
                rid = x.get("ruleId") or x.get("rule") or x.get("id")
                act = x.get("action") or x.get("text") or json.dumps(x)
                return f"{rid}: {act}" if rid else str(act)
            return str(x)

        return {**base, "status": "ok", "summary": body.get("summary"), "causes": [text(c) for c in body.get("causes", [])],
                "impact": body.get("impact"), "responseCandidates": [text(c) for c in body.get("responseCandidates", [])]}
    except Exception as exc:
        return {**base, "status": "failed", "error": str(exc)[:300]}


def keeper(dep, facts) -> dict | None:
    age, window = facts.get("lastPriceRecordAge"), facts.get("priceWindow")
    if window is None or (age is not None and age <= window // 8):
        return None
    try:
        # Separate key: the keeper must never race the owner's nonce.
        tx = send("keeper", dep["verifier"], "recordPrice(address)", dep["vault"])
        return {"recordPrice": tx["txHash"], "evmBlock": tx["evmBlock"]}
    except Exception as exc:
        return {"recordPriceError": str(exc)[:200]}


def run_once(args) -> dict:
    dep = load_json(STATE_DIR / ("deployment.json" if VERSION == "v1" else f"deployment-{VERSION}.json"))
    if not dep or not dep.get("vault"):
        raise SystemExit("no deployment.json with a vault")
    state = load_json(STATE, {})
    expect = {"abstraction": args.expect_abstraction, "perp": "HYPE", "base": "HYPE", "gasReserve": args.gas_reserve}
    run_id = f"run-{int(time.time())}"
    rules, errors, facts = evaluate(dep, state, expect)
    if args.carry_rules:
        # USDC Carry rules for the vault's Core account, chosen by its abstraction (carry_rules.py).
        import carry_rules

        extra, extra_errors, carry_facts = carry_rules.rules(dep["vault"], D(args.carry_rules))
        rules += [dict(r, id=f"carry-{r['id']}") for r in extra]
        errors += extra_errors
        facts["carry"] = carry_facts
    kept = keeper(dep, facts) if args.keeper else None
    if kept:
        facts["keeper"] = kept
        if "recordPrice" in kept:
            for r in rules:
                if r["id"] == "price-history":
                    r["status"], r["observed"] = "ok", f"recorded now ({kept['recordPrice'][:12]}…)"
    _nav_point(dep, facts)
    sig = {r["id"]: r["status"] for r in rules}
    changed = sig != state.get("lastStatuses")
    ai = state.get("lastAi") if (not changed and state.get("lastAi") and not args.force_ai) else ai_summary(rules, errors, facts)
    now = utc_now()
    healthy_run = not errors
    out = {
        "schema": "hypervault.monitor.v1",
        "generatedAt": now,
        "lastSuccessAt": now if healthy_run else state.get("lastSuccessAt"),
        "runId": run_id,
        "network": "hyperliquid-mainnet",
        "vault": dep["vault"],
        "rules": rules,
        "errors": errors,
        "facts": facts,
        "ai": ai,
    }
    # dedupe alerts: emit on status change or every REALERT_SECONDS
    sent = state.setdefault("alerted", {})
    for r in rules:
        if r["status"] in ("alert", "unobservable"):
            prev = sent.get(r["id"])
            if not prev or prev["status"] != r["status"] or time.time() - prev["t"] > REALERT_SECONDS:
                with ALERTS.open("a") as f:
                    f.write(json.dumps({"at": now, "rule": r["id"], "status": r["status"], "observed": r["observed"]}) + "\n")
                sent[r["id"]] = {"status": r["status"], "t": time.time()}
                print(f"ALERT {r['id']} {r['status']}: {r['observed']}", file=sys.stderr)
                _push(f"HyperVault {r['status'].upper()} {r['id']}: {r['title']} — {r['observed']} → {r['action']}")
        else:
            sent.pop(r["id"], None)
    state.update({"lastStatuses": sig, "lastAi": ai, "lastRunAt": now})
    if healthy_run:
        state["lastSuccessAt"] = now
    save_json(STATE, state)
    save_json(OUT, out)
    with LOG.open("a") as f:
        f.write(json.dumps({"at": now, "runId": run_id, "statuses": sig, "errors": errors, "ai": ai.get("status"),
                            "keeper": kept}) + "\n")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--interval", type=int, default=300)
    ap.add_argument("--keeper", action="store_true", help="send recordPrice when due (keeper key)")
    ap.add_argument("--expect-abstraction", default="unifiedAccount")
    ap.add_argument("--gas-reserve", default="0", help="HYPE held back on spot (after unwind)")
    ap.add_argument("--force-ai", action="store_true")
    ap.add_argument("--carry-rules", default=None, metavar="TARGET_Q",
                    help="append USDC Carry mode rules (Unified/PM) for the vault account, ids prefixed carry-")
    ap.add_argument("--backfill-ledger", action="store_true", help="seed nav-history from the round-trip ledgers")
    args = ap.parse_args()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if args.backfill_ledger:
        dep = load_json(STATE_DIR / ("deployment.json" if VERSION == "v1" else f"deployment-{VERSION}.json"))
        print(json.dumps({"backfilled": backfill_from_ledger(dep)}))
        return
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("another monitor instance holds the lock")
    while True:
        try:
            out = run_once(args)
            print(json.dumps({"at": out["generatedAt"], "statuses": {r["id"]: r["status"] for r in out["rules"]},
                              "ai": out["ai"].get("status"), "errors": len(out["errors"])}))
        except SystemExit:
            raise
        except Exception:
            with LOG.open("a") as f:
                f.write(json.dumps({"at": utc_now(), "crash": traceback.format_exc()[-1500:]}) + "\n")
            traceback.print_exc()
        if not args.loop:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
