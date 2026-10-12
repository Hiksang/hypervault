"""HyperCore HTTP API reads for a Vault's Core account. Not block-pinned; failures raise."""
from __future__ import annotations

from decimal import Decimal

from hvlib import info

USDC_TOKEN = 0
HYPE_TOKEN = 150
UBTC_TOKEN = 197


def spot_balances(user: str) -> dict[str, dict]:
    res = info({"type": "spotClearinghouseState", "user": user})
    # Outcome (HIP-4) balances carry no "token" index; keep them, keyed by coin.
    return {b["coin"]: {"token": b.get("token"), "total": b["total"], "hold": b["hold"]} for b in res["balances"]}


def perp_state(user: str, dex: str = "") -> dict:
    res = info({"type": "clearinghouseState", "user": user, "dex": dex})
    positions = []
    for p in res.get("assetPositions", []):
        pos = p["position"]
        positions.append(
            {
                "coin": pos["coin"],
                "szi": pos["szi"],
                "entryPx": pos.get("entryPx"),
                "positionValue": pos.get("positionValue"),
                "unrealizedPnl": pos.get("unrealizedPnl"),
                "leverage": pos.get("leverage"),
                "liquidationPx": pos.get("liquidationPx"),
                "cumFunding": pos.get("cumFunding"),
            }
        )
    return {
        "accountValue": res["marginSummary"]["accountValue"],
        "totalMarginUsed": res["marginSummary"]["totalMarginUsed"],
        "withdrawable": res.get("withdrawable"),
        "crossMaintenanceMarginUsed": res.get("crossMaintenanceMarginUsed", "0"),
        "positions": positions,
    }


def abstraction(user: str) -> str:
    return info({"type": "userAbstraction", "user": user})


def borrow_lend(user: str) -> dict:
    return info({"type": "borrowLendUserState", "user": user})


def reserves() -> dict[int, dict]:
    return {t: s for t, s in info({"type": "allBorrowLendReserveStates"})}


def agents(user: str):
    return info({"type": "extraAgents", "user": user})


def user_role(user: str):
    return info({"type": "userRole", "user": user})


def order_status(user: str, cloid: str):
    return info({"type": "orderStatus", "user": user, "oid": cloid})


def open_orders(user: str):
    return info({"type": "openOrders", "user": user})


def fills_by_cloid(user: str, cloid: str) -> list[dict]:
    return [f for f in info({"type": "userFills", "user": user}) if f.get("cloid") == cloid]


def mids() -> dict[str, str]:
    return info({"type": "allMids"})


def perp_ctx(coin: str) -> dict:
    meta, ctxs = info({"type": "metaAndAssetCtxs"})
    for i, a in enumerate(meta["universe"]):
        if a["name"] == coin:
            return {"asset": i, "szDecimals": a["szDecimals"], "maxLeverage": a["maxLeverage"], **ctxs[i]}
    raise KeyError(coin)


def funding_history(coin: str, start_ms: int) -> list[dict]:
    """Hourly funding records since start_ms (paged; the API returns at most 500 per call)."""
    rows: list[dict] = []
    while True:
        page = info({"type": "fundingHistory", "coin": coin, "startTime": start_ms})
        if not page:
            return rows
        rows += page
        start_ms = page[-1]["time"] + 1
        if len(page) < 500:
            return rows


def spot_ctx(pair_name: str) -> dict:
    meta, ctxs = info({"type": "spotMetaAndAssetCtxs"})
    tokens = {t["index"]: t for t in meta["tokens"]}
    for u in meta["universe"]:
        if u["name"] == pair_name:
            base = tokens[u["tokens"][0]]
            ctx = next(c for c in ctxs if c["coin"] == pair_name)
            return {
                "asset": 10_000 + u["index"],
                "pair": u["index"],
                "baseToken": base["index"],
                "szDecimals": base["szDecimals"],
                "weiDecimals": base["weiDecimals"],
                **ctx,
            }
    raise KeyError(pair_name)


def snapshot(user: str) -> dict:
    """Everything the API says about a Core account. Keys missing on failure are recorded as errors."""
    out: dict = {"account": user, "errors": []}
    for name, fn in (
        ("spot", lambda: spot_balances(user)),
        ("perp", lambda: perp_state(user)),
        ("abstraction", lambda: abstraction(user)),
        ("borrowLend", lambda: borrow_lend(user)),
        ("agents", lambda: agents(user)),
        ("role", lambda: user_role(user)),
    ):
        try:
            out[name] = fn()
        except Exception as exc:  # keep the failure visible; never substitute an empty value
            out["errors"].append(f"{name}: {exc}")
    return out


def dec(x) -> Decimal:
    return Decimal(str(x))


def sdk_spot_meta() -> dict:
    """spotMeta re-indexed so tokens[i] has index i (SDK 0.21 assumes that; mainnet indices have gaps)."""
    meta = info({"type": "spotMeta"})
    tokens: list = [None] * (max(t["index"] for t in meta["tokens"]) + 1)
    for t in meta["tokens"]:
        tokens[t["index"]] = t
    universe = [u for u in meta["universe"] if all(tokens[i] is not None for i in u["tokens"])]
    return {"tokens": tokens, "universe": universe}
