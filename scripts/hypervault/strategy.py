#!/usr/bin/env python3
"""HyperVault strategy runner (v0). Dry-run by default; `--execute` signs with the Vault API wallet.

Authority: orders are signed by the Vault's approved agent key and land on the Vault's own Core
account. The runner never moves funds between EVM and Core, never changes risk limits, and never
touches owner-only functions (allocation, recall, agent changes stay in roundtrip.py / the owner).

Strategies
  HYPE / BTC vault  keep the depositor's base exposure; under Portfolio Margin borrow USDC against it,
                    buy EXTRA base spot and short only that extra size on the perp. Requires PM.
  USDC vault        delta-neutral carry: buy base spot with USDC and short the same size on the perp.
                    Without PM the short is margined by the remaining USDC (Unified account).

Every order is IOC with a price cap. The hedge leg is sized from the FILLED size of the first leg,
never from the requested size. An order whose outcome is unknown (timeout) is looked up by cloid
before anything else is sent; it is never blindly resent.
"""
from __future__ import annotations

import argparse
import json
import secrets
import sys
import time
from dataclasses import asdict, dataclass, field
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

import core
from hvlib import AGENT, ROOT, STATE_DIR, addr, key, load_json, save_json, utc_now

D = Decimal


@dataclass
class Limits:
    max_notional_usd: D = D("25")  # hard cap on the hedged notional of the prototype
    reserve_usdc: D = D("3")  # USDC left untouched on Core (fees, rounding)
    gas_reserve_base: D = D("0.02")  # base kept on spot for Core->EVM transfer gas (HYPE only)
    short_leverage: int = 2  # perp leverage setting for the hedge leg; not a Vault leverage
    max_slippage_bps: int = 30
    min_order_usd: D = D("11")  # Core minimum order is 10 USDC
    max_delta_usd: D = D("2")  # rebalance threshold for |spot - short| * px
    min_funding_apr: D = D("0.0")  # do not open when funding is negative (shorts pay)
    max_borrow_apr: D = D("0.12")  # PM only: stop expanding above this USDC borrow APR
    max_pm_ltv_use: D = D("0.30")  # PM only: use at most 30% of the protocol LTV allowance
    book_depth_mult: D = D("5")  # the touch must hold this multiple of the order size


MARKETS = {
    "USDC": {"perp": "HYPE", "spot": "@107", "base": "HYPE", "baseToken": 150},
    "HYPE": {"perp": "HYPE", "spot": "@107", "base": "HYPE", "baseToken": 150},
    "BTC": {"perp": "BTC", "spot": "@142", "base": "UBTC", "baseToken": 197},
}


@dataclass
class Plan:
    vault: str
    mode: str
    account: str | None
    observedAt: str
    hypothetical: bool = False
    baseExposure: dict = field(default_factory=dict)
    extraHedge: dict = field(default_factory=dict)
    actions: list = field(default_factory=list)
    blocked: list = field(default_factory=list)
    risk: dict = field(default_factory=dict)
    market: dict = field(default_factory=dict)
    results: list = field(default_factory=list)


def round_size(x: D, sz_dec: int) -> D:
    return x.quantize(D(1).scaleb(-sz_dec), rounding=ROUND_DOWN)


def hedge_size(spot_after: D, base_keep: D, short_now: D, sz_dec: int) -> D:
    """Short to ADD so the short equals the spot base actually held (after the fill, the fee taken in
    base and any balance already there), minus the base kept unhedged by design, rounded to the
    nearest size step. Sizing from the order's filled size instead leaves the fee and prior dust
    unhedged, and a correction later is usually impossible (perp orders need 10 USDC notional)."""
    target = (spot_after - base_keep).quantize(D(1).scaleb(-sz_dec), rounding=ROUND_HALF_UP)
    return max(target - short_now, D(0))


def round_px(px: D, sz_dec: int, spot: bool) -> D:
    max_dec = (8 if spot else 6) - sz_dec
    sig = D(f"{px:.5g}")
    return sig.quantize(D(1).scaleb(-max_dec)) if sig.as_tuple().exponent < -max_dec else sig


def market_view(vault_kind: str) -> dict:
    m = MARKETS[vault_kind]
    perp = core.perp_ctx(m["perp"])
    spot = core.spot_ctx(m["spot"])
    book_p = core.info({"type": "l2Book", "coin": m["perp"]})["levels"]
    book_s = core.info({"type": "l2Book", "coin": m["spot"]})["levels"]
    res = core.reserves()
    return {
        "perpCoin": m["perp"],
        "spotPair": m["spot"],
        "perpSzDecimals": perp["szDecimals"],
        "spotSzDecimals": spot["szDecimals"],
        "perpMark": perp["markPx"],
        "perpOracle": perp["oraclePx"],
        "spotMark": spot["markPx"],
        "fundingHourly": perp["funding"],
        "fundingApr": str(D(perp["funding"]) * 24 * 365),
        "perpBid": book_p[0][0]["px"], "perpBidSz": book_p[0][0]["sz"],
        "perpAsk": book_p[1][0]["px"], "perpAskSz": book_p[1][0]["sz"],
        "spotBid": book_s[0][0]["px"], "spotBidSz": book_s[0][0]["sz"],
        "spotAsk": book_s[1][0]["px"], "spotAskSz": book_s[1][0]["sz"],
        "usdcBorrowApr": res[0]["borrowYearlyRate"],
        "baseLtv": res.get(m["baseToken"], {}).get("ltv"),
        "baseBorrowOracle": res.get(m["baseToken"], {}).get("oraclePx"),
        "maxLeverage": perp["maxLeverage"],
    }


def account_view(account: str, vault_kind: str) -> dict:
    m = MARKETS[vault_kind]
    spot = core.spot_balances(account)
    perp = core.perp_state(account)
    pos = next((p for p in perp["positions"] if p["coin"] == m["perp"]), None)
    return {
        "abstraction": core.abstraction(account),
        "spotUsdc": spot.get("USDC", {}).get("total", "0.0"),
        "spotUsdcHold": spot.get("USDC", {}).get("hold", "0.0"),
        "spotBase": spot.get(m["base"], {}).get("total", "0.0"),
        "perpAccountValue": perp["accountValue"],
        "perpSzi": pos["szi"] if pos else "0.0",
        "perpEntry": pos["entryPx"] if pos else None,
        "perpLeverage": pos["leverage"] if pos else None,
        "borrowLend": core.borrow_lend(account),
    }


def plan(vault_kind: str, account: str | None, lim: Limits, hypo: dict | None, unwind: bool) -> Plan:
    mk = market_view(vault_kind)
    p = Plan(vault=vault_kind, mode="dry-run", account=account, observedAt=utc_now(), market=mk)
    px = D(mk["perpMark"])
    if account:
        acct = account_view(account, vault_kind)
    else:
        p.hypothetical = True
        acct = hypo
    p.risk = {"limits": {k: str(v) for k, v in asdict(lim).items()}, "abstraction": acct["abstraction"]}
    spot_base = D(acct["spotBase"])
    short = -D(acct["perpSzi"])  # positive = short size
    usdc = D(acct["spotUsdc"])
    funding_apr = D(mk["fundingApr"])
    pm = acct["abstraction"] == "portfolioMargin"
    sz_p, sz_s = mk["perpSzDecimals"], mk["spotSzDecimals"]

    if vault_kind == "USDC":
        # Base exposure of a USDC vault is USDC; the HYPE spot leg exists only as the hedged pair.
        hedged_spot = spot_base  # the gas reserve is kept back only when unwinding
        p.baseExposure = {"asset": "USDC", "usdc": str(usdc), "note": "depositor exposure is USDC; spot HYPE is fully paired"}
        p.risk["baseKeep"] = "0"
        p.extraHedge = {"spot": str(hedged_spot), "short": str(short), "delta": str(hedged_spot - short),
                        "deltaUsd": str(((hedged_spot - short) * px).quantize(D("0.01")))}
        if unwind:
            _unwind_actions(p, short, max(spot_base - lim.gas_reserve_base, D(0)), sz_p, sz_s, lim, mk)
            return p
        if funding_apr < lim.min_funding_apr:
            p.blocked.append(f"funding APR {funding_apr:.4f} below floor {lim.min_funding_apr}: no new carry")
        equity_free = usdc - lim.reserve_usdc
        # Unified account: spot buy N and short margin N/lev both come from USDC.
        cap_unified = equity_free / (1 + D(1) / lim.short_leverage) if equity_free > 0 else D(0)
        target = min(cap_unified, lim.max_notional_usd) if not pm else min(equity_free, lim.max_notional_usd)
        add_usd = target - short * px
        if add_usd < lim.min_order_usd:
            p.blocked.append(f"additional notional {add_usd:.2f} USD below minimum order {lim.min_order_usd}")
        _open_actions(p, add_usd, px, sz_p, sz_s, lim, mk, "carry pair: spot buy then short the filled size")
    else:
        # HYPE/BTC: deposit stays as base exposure; only EXTRA spot bought with borrowed USDC is hedged.
        extra = short
        base_exposure = spot_base - extra
        p.baseExposure = {"asset": MARKETS[vault_kind]["base"], "size": str(base_exposure),
                          "usd": str((base_exposure * px).quantize(D("0.01"))), "note": "kept unhedged by design"}
        p.extraHedge = {"spotExtra": str(extra), "short": str(short), "delta": "0 by construction (extra==short)"}
        p.risk["baseKeep"] = str(base_exposure)
        if unwind:
            _unwind_actions(p, short, short, sz_p, sz_s, lim, mk)
            return p
        if not pm:
            p.blocked.append(
                f"abstraction is '{acct['abstraction']}', not portfolioMargin: no USDC borrowing, extra leg not opened. "
                "PM needs master account value >$10k or >$5M weighted volume.")
        if D(mk["usdcBorrowApr"]) > lim.max_borrow_apr:
            p.blocked.append(f"USDC borrow APR {mk['usdcBorrowApr']} above cap {lim.max_borrow_apr}")
        if funding_apr - D(mk["usdcBorrowApr"]) <= 0:
            p.blocked.append(f"funding APR {funding_apr:.4f} does not exceed borrow APR {mk['usdcBorrowApr']}: carry negative")
        ltv = D(mk["baseLtv"] or 0)
        allowance = base_exposure * D(mk["baseBorrowOracle"] or px) * ltv * lim.max_pm_ltv_use
        target = min(allowance, lim.max_notional_usd)
        add_usd = target - extra * px
        p.risk.update({"pmBorrowAllowanceUsd": str(allowance.quantize(D("0.01"))), "protocolLtv": str(ltv)})
        if add_usd < lim.min_order_usd:
            p.blocked.append(f"additional extra leg {add_usd:.2f} USD below minimum order {lim.min_order_usd}")
        _open_actions(p, add_usd, px, sz_p, sz_s, lim, mk, "extra leg: borrow USDC (PM), buy extra spot, short filled size")
    return p


def _depth_ok(p: Plan, side_sz: str, size: D, lim: Limits, label: str):
    if D(side_sz) < size * lim.book_depth_mult:
        p.blocked.append(f"{label} touch size {side_sz} < {lim.book_depth_mult}x order {size}")


def _open_actions(p, add_usd, px, sz_p, sz_s, lim, mk, reason):
    size = round_size(min(add_usd, lim.max_notional_usd) / px, min(sz_p, sz_s)) if add_usd > 0 else D(0)
    if size <= 0:
        return
    _depth_ok(p, mk["spotAskSz"], size, lim, "spot ask")
    _depth_ok(p, mk["perpBidSz"], size, lim, "perp bid")
    slip = D(lim.max_slippage_bps) / 10_000
    p.actions += [
        {"kind": "order", "market": mk["spotPair"], "side": "buy", "size": str(size), "unit": "base",
         "limitPx": str(round_px(D(mk["spotAsk"]) * (1 + slip), sz_s, True)), "tif": "Ioc", "reduceOnly": False,
         "reason": reason},
        {"kind": "order", "market": mk["perpCoin"], "side": "sell", "size": "MATCH_SPOT_BALANCE", "unit": "base",
         "limitPx": str(round_px(D(mk["perpBid"]) * (1 - slip), sz_p, False)), "tif": "Ioc", "reduceOnly": False,
         "reason": "short = spot base held after the fill (fee and prior balance included), nearest size step",
         "leverage": lim.short_leverage},
    ]


def _unwind_actions(p, short, spot_hedged, sz_p, sz_s, lim, mk):
    slip = D(lim.max_slippage_bps) / 10_000
    if short > 0:
        p.actions.append({"kind": "order", "market": mk["perpCoin"], "side": "buy", "size": str(short), "unit": "base",
                          "limitPx": str(round_px(D(mk["perpAsk"]) * (1 + slip), sz_p, False)), "tif": "Ioc",
                          "reduceOnly": True, "reason": "close hedge first"})
    sell = round_size(spot_hedged, sz_s)
    if sell * D(mk["spotBid"]) >= D(10):
        p.actions.append({"kind": "order", "market": mk["spotPair"], "side": "sell", "size": str(sell), "unit": "base",
                          "limitPx": str(round_px(D(mk["spotBid"]) * (1 - slip), sz_s, True)), "tif": "Ioc",
                          "reduceOnly": False, "reason": "sell paired spot, keep gas reserve"})
    elif sell > 0:
        p.blocked.append(f"spot remainder {sell} below 10 USDC minimum order: left as dust")


# ------------------------------------------------------------------------------------ execution


def classify(resp) -> dict:
    """Map an exchange response to filled / partial / resting / unfilled / rejected / unknown."""
    if not isinstance(resp, dict) or resp.get("status") != "ok":
        return {"state": "rejected", "raw": resp}
    st = resp["response"]["data"]["statuses"][0]
    if "filled" in st:
        return {"state": "filled", "totalSz": st["filled"]["totalSz"], "avgPx": st["filled"]["avgPx"],
                "oid": st["filled"]["oid"]}
    if "resting" in st:
        return {"state": "resting", "oid": st["resting"]["oid"]}
    err = st.get("error", "")
    if "could not immediately match" in err:
        return {"state": "unfilled", "error": err}
    return {"state": "rejected", "error": err}


def _send(ex, account, a, size: D, cloid_hex: str):
    from hyperliquid.utils.types import Cloid

    try:
        resp = ex.order(a["market"], a["side"] == "buy", float(size), float(a["limitPx"]),
                        {"limit": {"tif": "Ioc"}}, reduce_only=a["reduceOnly"], cloid=Cloid.from_str(cloid_hex))
    except Exception as exc:  # outcome unknown: look it up, never resend blindly
        time.sleep(2)
        try:
            st = core.order_status(account, cloid_hex)
            return {"state": "unknown-then-queried", "error": str(exc)[:200], "orderStatus": st}
        except Exception as exc2:
            return {"state": "unknown", "error": f"{exc}; lookup failed: {exc2}"[:300]}
    out = classify(resp)
    if out["state"] == "filled" and D(out["totalSz"]) < size:
        out["state"] = "partial"
    out["requested"] = str(size)
    out["cloid"] = cloid_hex
    return out


def execute(p: Plan, account: str, sz_p: int) -> None:
    from eth_account import Account
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils import constants

    agent = Account.from_key(key(AGENT))
    ex = Exchange(agent, constants.MAINNET_API_URL, account_address=account, spot_meta=core.sdk_spot_meta())
    p.mode = "executed"
    filled_prev = None
    for a in p.actions:
        if a.get("leverage"):
            r = ex.update_leverage(int(a["leverage"]), a["market"], is_cross=True)
            p.results.append({"kind": "updateLeverage", "market": a["market"], "leverage": a["leverage"], "response": r})
        if a["size"] == "MATCH_SPOT_BALANCE":
            if not filled_prev:
                p.results.append({"action": a, "state": "skipped", "reason": "previous leg filled nothing"})
                break
            time.sleep(2)  # let the spot fill and its fee settle in the balance
            view = account_view(account, p.vault)
            spot_after, short_now = D(view["spotBase"]), -D(view["perpSzi"])
            size = hedge_size(spot_after, D(p.risk.get("baseKeep", "0")), short_now, sz_p)
            p.results.append({"kind": "hedgeSizing", "spotAfter": str(spot_after), "shortBefore": str(short_now),
                              "baseKeep": p.risk.get("baseKeep", "0"), "add": str(size)})
            if size <= 0:
                p.results.append({"action": a, "state": "skipped", "reason": "spot already matched by the short"})
                break
        else:
            size = D(a["size"])
        size = round_size(size, sz_p if a["market"] == p.market["perpCoin"] else p.market["spotSzDecimals"])
        cloid = "0x" + secrets.token_hex(16)
        res = _send(ex, account, a, size, cloid)
        p.results.append({"action": a, **res, "at": utc_now()})
        print(json.dumps(p.results[-1]))
        if res["state"] in ("filled", "partial"):
            filled_prev = D(res["totalSz"])
        else:
            # Unfilled/rejected/unknown: stop. A dangling unhedged leg is reported, not chased.
            if filled_prev is not None:
                p.blocked.append(f"hedge leg {res['state']}: {filled_prev} base unhedged — operator action needed")
            break
        time.sleep(1)
    if len(p.results) and p.results[-1].get("state") == "partial":
        p.blocked.append("hedge leg partially filled — residual delta remains; rerun plan to rebalance")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vault", choices=list(MARKETS))
    ap.add_argument("--account", help="Vault proxy (= Core account). Omit for a hypothetical dry run")
    ap.add_argument("--hypo-base", default="0", help="hypothetical spot base size when no account")
    ap.add_argument("--hypo-usdc", default="0", help="hypothetical USDC when no account")
    ap.add_argument("--hypo-abstraction", default="portfolioMargin")
    ap.add_argument("--unwind", action="store_true")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--max-notional", default=None)
    ap.add_argument("--gas-reserve", default=None, help="base kept on spot when unwinding")
    ap.add_argument("--reserve-usdc", default=None, help="USDC left untouched on Core (default 3)")
    ap.add_argument("--out", default=str(ROOT / "frontend" / "public" / "hypervault" / "strategy.json"))
    args = ap.parse_args()
    lim = Limits()
    if args.max_notional:
        lim.max_notional_usd = D(args.max_notional)
    if args.gas_reserve:
        lim.gas_reserve_base = D(args.gas_reserve)
    if args.reserve_usdc:
        lim.reserve_usdc = D(args.reserve_usdc)
    hypo = None
    if not args.account:
        hypo = {"abstraction": args.hypo_abstraction, "spotUsdc": args.hypo_usdc, "spotBase": args.hypo_base,
                "perpSzi": "0", "spotUsdcHold": "0"}
    p = plan(args.vault, args.account, lim, hypo, args.unwind)
    if args.execute:
        if not args.account:
            sys.exit("--execute requires --account")
        if p.blocked:
            print(json.dumps({"blocked": p.blocked}, indent=2))
            sys.exit("plan blocked: nothing sent")
        execute(p, args.account, p.market["perpSzDecimals"])
        time.sleep(2)
        p.risk["after"] = account_view(args.account, args.vault)
        # Report the exposure split as it stands after execution, not the pre-trade plan input.
        post = plan(args.vault, args.account, lim, None, False)
        p.baseExposure, p.extraHedge, p.observedAt = post.baseExposure, post.extraHedge, post.observedAt
    out = load_json(__import__("pathlib").Path(args.out), {"schema": "hypervault.strategy.v1", "plans": []})
    out["generatedAt"] = utc_now()
    key_ = (p.vault, p.mode, p.hypothetical)
    out["plans"] = [x for x in out.get("plans", []) if (x["vault"], x["mode"], x.get("hypothetical", False)) != key_
                    or p.mode == "executed"] + [json.loads(json.dumps(asdict(p), default=str))]
    save_json(__import__("pathlib").Path(args.out), out)
    hist = STATE_DIR / "strategy-runs.jsonl"
    hist.parent.mkdir(parents=True, exist_ok=True)
    with hist.open("a") as f:
        f.write(json.dumps(asdict(p), default=str) + "\n")
    print(json.dumps({"vault": p.vault, "mode": p.mode, "actions": p.actions, "blocked": p.blocked,
                      "results": p.results}, indent=2, default=str))


if __name__ == "__main__":
    main()
