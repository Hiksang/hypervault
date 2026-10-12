#!/usr/bin/env python3
"""Read-only, block-pinned evidence for per-venue Core equity in every account mode.

Tests the hypothesis used by the Managed NAV adapter: precompiles expose raw, disjoint ledgers
(spot, lending, one margin account per perp DEX, HyperCore vault equity) regardless of the
abstraction mode, and the unified balances shown by the HTTP API are their sum.
Never produces a mint-authorizing NAV.
"""
import argparse
from decimal import Decimal, localcontext
import json
from pathlib import Path
import re
import time
import urllib.error

from action_status import validated_hex
from nav_probe import LENDING, MARGIN, RESERVE, SPOT, calldata, decode_fixed, observed, parallel, utc_now
from probe import post, rpc


MAX_TOKENS = 4
MAX_VAULTS = 3
MAX_BATCH = 20  # the public EVM RPC rejects larger JSON-RPC batches
PRICE_TOKENS = (150, 197, 235, 268, 360)  # HYPE, UBTC and the non-USDC quote tokens seen in metadata
HLP = {"mainnet": "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"}
BBO = [("bid", "uint64"), ("ask", "uint64")]
PRICE = [("price", "uint64")]
VAULT_EQUITY = [("equity", "uint64"), ("lockedUntilTimestamp", "uint64")]
# API total(token) per mode, expressed with the raw precompile ledgers.
EXPECTED = {"disabled": "rawSpot", "default": "rawSpot", "unifiedAccount": "rawSpotPlusPerp",
            "portfolioMargin": "rawSpotPlusPerpPlusLending"}


class RateLimited(RuntimeError):
    pass


def paced_post(url, body, attempts=5):
    for attempt in range(attempts):
        try:
            return post(url, body)
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == attempts - 1:
                raise
            time.sleep(2.0 * (attempt + 1))


def batch_calls(evm, tag, jobs):
    """JSON-RPC batches pinned to `tag`. A failed call stays a failure, never a zero value."""
    keys, responses = list(jobs), {}
    started = utc_now()
    for offset in range(0, len(keys), MAX_BATCH):
        chunk = keys[offset:offset + MAX_BATCH]
        body = [{"jsonrpc": "2.0", "id": offset + i, "method": "eth_call",
                 "params": [{"to": f"0x{jobs[key][0]:040x}", "data": jobs[key][1]}, tag]} for i, key in enumerate(chunk)]
        try:
            reply = post(evm, body)
        except urllib.error.HTTPError as error:
            if error.code != 429:
                raise
            raise RateLimited("EVM RPC rate limited") from error
        if "rate limited" in json.dumps(reply):
            raise RateLimited("EVM RPC rate limited")
        if not isinstance(reply, list) or len(reply) != len(body):
            raise ValueError(f"malformed batch response: {json.dumps(reply)[:200]}")
        responses.update({r.get("id"): r for r in reply if isinstance(r, dict)})
    finished, result = utc_now(), {}
    for i, key in enumerate(keys):
        address, data, fields = jobs[key]
        response, record = responses.get(i), {"startedAt": started, "finishedAt": finished}
        if not response or "result" not in response:
            record.update(ok=False, error=f"RuntimeError: {response.get('error') if response else 'missing response'}")
        else:
            value = {"to": f"0x{address:040x}", "input": data, "raw": response["result"]}
            try:
                value["decoded"] = decode_fixed(response["result"], fields)
            except ValueError as error:
                value["decodeError"] = str(error)
            record.update(ok=True, value=value)
        result[key] = record
    return result


def value_of(record):
    return record.get("value") if isinstance(record, dict) and record.get("ok") else None


def decoded(record):
    value = value_of(record)
    return value.get("decoded") if isinstance(value, dict) else None


def classify(candidate, before, after, unit=None):
    """Exact at one unpinned HTTP read, bracketed by both, one raw unit away, or a mismatch.

    The API truncates interest-bearing values after combining them, so a sum of truncated raw
    ledgers can differ by one raw unit. Missing evidence is never zero.
    """
    if candidate is None or before is None or after is None:
        return "MissingEvidence"
    first, last = Decimal(before), Decimal(after)
    if candidate in (first, last):
        return "ExactAtApiRead"
    if min(first, last) <= candidate <= max(first, last):
        return "BracketCompatibleNotProof"
    if unit is not None and min(abs(candidate - first), abs(candidate - last)) <= unit:
        return "WithinOneRawUnit"
    return "Mismatch"


def api_total(bundle, token):
    state = value_of(bundle.get("spotClearinghouseState"))
    if not isinstance(state, dict) or not isinstance(state.get("balances"), list):
        return None
    row = next((b for b in state["balances"] if isinstance(b, dict) and b.get("token") == token), None)
    return row.get("total") if row else None


def api_account_value(bundle, dex_index):
    state = value_of(bundle.get(f"clearinghouseState:{dex_index}"))
    summary = state.get("marginSummary") if isinstance(state, dict) else None
    return summary.get("accountValue") if isinstance(summary, dict) else None


def api_lending_tokens(bundle):
    state = value_of(bundle.get("borrowLendUserState"))
    rows = state.get("tokenToState") if isinstance(state, dict) else None
    return sorted(pair[0] for pair in rows if isinstance(pair, list) and len(pair) == 2) if isinstance(rows, list) else None


def api_vault_equity(bundle, vault):
    """None when the HTTP read failed; "0" when it succeeded without this vault."""
    rows = value_of(bundle.get("userVaultEquities"))
    if not isinstance(rows, list):
        return None
    row = next((r for r in rows if isinstance(r, dict) and str(r.get("vaultAddress")).lower() == vault), None)
    return row.get("equity") if row else "0"


def reconcile(record, dexes):
    """Pure diagnostic over one saved account record. HTTP is unpinned: exactness is per component."""
    before, after, core = record["infoBefore"], record["infoAfter"], record["core"]
    wei_decimals = {int(token): value for token, value in record["weiDecimals"].items()}
    modes = {value_of(before.get("userAbstraction")), value_of(after.get("userAbstraction"))}
    mode = modes.pop() if len(modes) == 1 else None
    result = {"mode": mode, "expectedApiTotal": EXPECTED.get(mode), "tokens": {}, "dexes": {}, "vaults": {},
              "consistent": True}
    with localcontext() as context:
        context.prec = 100
        perp = {}
        for dex in dexes:
            margin = decoded(core.get(f"margin:{dex['index']}"))
            if margin is None:
                result["dexes"][str(dex["index"])] = {"classification": "MissingEvidence"}
                result["consistent"] = False
                continue
            # Margin summaries use 6 decimals for USDC DEXes; other collateral units are unverified.
            value = Decimal(margin["accountValue"]) / Decimal(10**6)
            check = classify(value, api_account_value(before, dex["index"]), api_account_value(after, dex["index"]))
            result["dexes"][str(dex["index"])] = {"name": dex["name"], "collateralToken": dex["collateralToken"],
                                                  "accountValue": str(value), "classification": check}
            result["consistent"] &= check != "Mismatch"
            perp[dex["collateralToken"]] = perp.get(dex["collateralToken"], Decimal(0)) + value
        for token in record["tokens"]:
            spot, lending = decoded(core.get(f"spot:{token}")), decoded(core.get(f"lending:{token}"))
            if spot is None or token not in wei_decimals:
                result["tokens"][str(token)] = {"classification": "MissingEvidence"}
                result["consistent"] = False
                continue
            scale = Decimal(10) ** wei_decimals[token]
            raw = Decimal(spot["total"]) / scale
            candidates = {"rawSpot": raw, "rawSpotPlusPerp": raw + perp.get(token, Decimal(0))}
            if lending is not None:
                net = Decimal(lending["supplyValue"] - lending["borrowValue"]) / scale
                candidates["rawSpotPlusPerpPlusLending"] = candidates["rawSpotPlusPerp"] + net
            totals = api_total(before, token), api_total(after, token)
            checks = {name: classify(value, *totals, unit=1 / scale) for name, value in candidates.items()}
            expected = checks.get(EXPECTED.get(mode), "MissingEvidence")
            # Equity never depends on the mode: every raw ledger is counted exactly once.
            equity = candidates.get("rawSpotPlusPerpPlusLending", candidates["rawSpotPlusPerp"])
            result["tokens"][str(token)] = {
                "candidates": {k: str(v) for k, v in candidates.items()}, "apiTotalBefore": totals[0],
                "apiTotalAfter": totals[1], "checks": checks, "classification": expected,
                "lendingState": "read" if lending is not None else "precompileError", "equity": str(equity)}
            # An omitted API balance is absent evidence for that token, not a contradiction.
            result["consistent"] &= expected != "Mismatch"
        for vault in record.get("vaults", []):
            equity = decoded(core.get(f"vaultEquity:{vault}"))
            if equity is None:
                # Recorded as evidence about the precompile for an account without this equity.
                result["vaults"][vault] = {"classification": "PrecompileError",
                                           "apiEquityAfter": api_vault_equity(after, vault)}
                continue
            value = Decimal(equity["equity"]) / Decimal(10**6)
            check = classify(value, api_vault_equity(before, vault), api_vault_equity(after, vault),
                             unit=Decimal(1) / Decimal(10**6))
            result["vaults"][vault] = {"equity": str(value), "classification": check}
            result["consistent"] &= check != "Mismatch"
    api_lending = api_lending_tokens(after)
    if api_lending is not None:
        read = sorted(t for t in record["tokens"] if decoded(core.get(f"lending:{t}")) is not None)
        result["lendingReadsMatchApiState"] = read == sorted(t for t in api_lending if t in record["tokens"])
    return result


def capture(network, accounts, pause=15.0, attempts=4):
    accounts = list(dict.fromkeys(validated_hex(a, 20) for a in accounts))
    if not 1 <= len(accounts) <= 16:
        raise ValueError("provide between one and sixteen accounts")
    stem = "hyperliquid" if network == "mainnet" else "hyperliquid-testnet"
    api, evm = f"https://api.{stem}.xyz/info", f"https://rpc.{stem}.xyz/evm"
    if int(rpc(evm, "eth_chainId", []), 16) != (999 if network == "mainnet" else 998):
        raise ValueError("RPC chain mismatch")
    spot_meta = paced_post(api, {"type": "spotMeta"})
    wei_decimals = {t["index"]: t["weiDecimals"] for t in spot_meta["tokens"]}
    usdc_pairs = {p["tokens"][0]: p["index"] for p in spot_meta["universe"] if p["tokens"][1] == 0}
    dexes = []
    for index, entry in enumerate(paced_post(api, {"type": "perpDexs"})):
        name = "" if entry is None else entry["name"]
        dexes.append({"index": index, "name": name,
                      "collateralToken": paced_post(api, {"type": "meta", "dex": name}).get("collateralToken")})
    if any(type(d["collateralToken"]) is not int for d in dexes):
        raise ValueError("perp DEX collateral metadata unavailable; refusing a guessed quote token")

    def info(account):
        kinds = ("userAbstraction", "spotClearinghouseState", "borrowLendUserState", "userVaultEquities")
        jobs = {kind: {"type": kind, "user": account} for kind in kinds}
        for dex in dexes:
            jobs[f"clearinghouseState:{dex['index']}"] = {"type": "clearinghouseState", "user": account, "dex": dex["name"]}
        return parallel({key: (lambda body=body: paced_post(api, body)) for key, body in jobs.items()})

    def limited_rpc(method, params):
        try:
            return rpc(evm, method, params)
        except RuntimeError as error:
            if "rate limited" in str(error):
                raise RateLimited(str(error)) from error
            raise

    def pin():
        tag = limited_rpc("eth_blockNumber", [])
        if not isinstance(tag, str) or not re.fullmatch(r"0x[0-9a-fA-F]+", tag):
            raise ValueError("cannot pin EVM block")
        header = limited_rpc("eth_getBlockByNumber", [tag, False])
        if not isinstance(header, dict) or header.get("number") != tag or not header.get("hash"):
            raise ValueError("invalid pinned header")
        return tag, header

    def unchanged(tag, header):
        end = limited_rpc("eth_getBlockByNumber", [tag, False])
        return bool(isinstance(end, dict) and end.get("hash") == header["hash"])

    def retried(step):
        # A throttled attempt is repeated from its first HTTP read so the bracket stays tight.
        for attempt in range(attempts):
            try:
                return step()
            except RateLimited:
                if attempt == attempts - 1:
                    raise
                time.sleep(60.0 * (attempt + 1))

    # Price inputs at one block: precompile spot price and book against the unpinned HTTP contexts.
    def price_step():
        jobs = {}
        for token in (t for t in PRICE_TOKENS if t in usdc_pairs):
            jobs[f"spotPx:{token}"] = (0x0808, calldata(usdc_pairs[token]), PRICE)
            jobs[f"bbo:{token}"] = (0x080e, calldata(10000 + usdc_pairs[token]), BBO)
            jobs[f"reserve:{token}"] = (0x0812, calldata(token), RESERVE)
        before = observed(lambda: paced_post(api, {"type": "spotMetaAndAssetCtxs"}))
        tag, header = pin()
        reads = batch_calls(evm, tag, jobs)
        after = observed(lambda: paced_post(api, {"type": "spotMetaAndAssetCtxs"}))
        return tag, header, before, reads, after, unchanged(tag, header)

    def account_step(account):
        before = info(account)
        held = [b["token"] for b in (value_of(before["spotClearinghouseState"]) or {}).get("balances", [])
                if isinstance(b, dict) and Decimal(b.get("total", "0")) != 0]
        lending_tokens = api_lending_tokens(before) or []
        tokens = list(dict.fromkeys([0] + lending_tokens + [t for t in held if t in usdc_pairs]))[:MAX_TOKENS]
        listed = [str(v.get("vaultAddress")).lower() for v in value_of(before["userVaultEquities"]) or []
                  if isinstance(v, dict)]
        # HLP is read for every account: evidence for the zero-equity result as well.
        vaults = list(dict.fromkeys(([HLP[network]] if network in HLP else []) + listed))[:MAX_VAULTS]
        tag, header = pin()
        jobs = {"coreBlock": (0x0809, calldata(), [("number", "uint64")]),
                "exists": (0x0810, calldata(account), [("exists", "bool")]),
                # Expected to fail: evidence that an unknown DEX index is an error, never a zero summary.
                f"marginOutOfRange:{len(dexes)}": (0x080f, calldata(len(dexes), account), MARGIN)}
        for dex in dexes:
            jobs[f"margin:{dex['index']}"] = (0x080f, calldata(dex["index"], account), MARGIN)
        for token in tokens:
            jobs[f"spot:{token}"] = (0x0801, calldata(account, token), SPOT)
            jobs[f"lending:{token}"] = (0x0811, calldata(account, token), LENDING)
        for vault in vaults:
            jobs[f"vaultEquity:{vault}"] = (0x0802, calldata(account, vault), VAULT_EQUITY)
        core = batch_calls(evm, tag, jobs)
        after = info(account)
        record = {"evmBlock": tag, "evmBlockHash": header["hash"], "evmTimestamp": int(header["timestamp"], 16),
                  "blockHashStable": unchanged(tag, header), "tokens": tokens, "vaults": vaults,
                  "weiDecimals": {str(t): wei_decimals[t] for t in tokens if t in wei_decimals},
                  "infoBefore": before, "infoAfter": after, "core": core}
        record["reconciliation"] = reconcile(record, dexes)
        return record

    report = {"schema": 2, "observedAt": utc_now(), "network": network, "rpc": evm, "info": api,
              "scope": "read-only public accounts; registered-scope identity evidence, NOT whole-account completeness",
              "infoBlockPinned": False, "productionNavReady": False, "activeDepositsAuthorized": False,
              "dexes": dexes, "accounts": {}}
    tag, header, ctx_before, price_reads, ctx_after, stable = retried(price_step)
    names = {f"@{usdc_pairs[t]}": t for t in PRICE_TOKENS if t in usdc_pairs}

    def contexts(record):
        value = value_of(record)
        rows = value[1] if isinstance(value, list) and len(value) == 2 else []
        return {str(names[c["coin"]]): {k: c.get(k) for k in ("markPx", "midPx")}
                for c in rows if isinstance(c, dict) and c.get("coin") in names}

    report["prices"] = {"evmBlock": tag, "evmBlockHash": header["hash"], "blockHashStable": stable,
                        "usdcPairs": {str(t): usdc_pairs[t] for t in PRICE_TOKENS if t in usdc_pairs},
                        "szDecimals": {str(t["index"]): t["szDecimals"] for t in spot_meta["tokens"] if t["index"] in PRICE_TOKENS},
                        "core": price_reads, "apiBefore": contexts(ctx_before), "apiAfter": contexts(ctx_after)}
    for account in accounts:
        time.sleep(pause)
        report["accounts"][account] = retried(lambda: account_step(account))
    report["allBlockHashesStable"] = stable and all(r["blockHashStable"] for r in report["accounts"].values())
    report["allConsistent"] = all(r["reconciliation"]["consistent"] for r in report["accounts"].values())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("mainnet", "testnet"), required=True)
    parser.add_argument("--account", action="append", required=True, help="public Core account, not an API agent wallet")
    parser.add_argument("--output", type=Path, required=True, help="new file; never overwrite prior evidence")
    parser.add_argument("--pause", type=float, default=15.0, help="seconds between accounts; the public RPC is rate limited")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists")
    try:
        report = capture(args.network, args.account, pause=args.pause)
    except (ValueError, OSError, KeyError, RuntimeError) as error:
        parser.exit(1, f"probe failed: {error}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    for account, record in report["accounts"].items():
        summary = record["reconciliation"]
        print(json.dumps({"account": account, "mode": summary["mode"], "consistent": summary["consistent"],
                          "tokens": {t: v.get("classification") for t, v in summary["tokens"].items()},
                          "dexes": {d: v["classification"] for d, v in summary["dexes"].items()
                                    if v.get("accountValue") not in (None, "0")},
                          "vaults": {v: c["classification"] for v, c in summary["vaults"].items()}}))
    if not (report["allBlockHashesStable"] and report["allConsistent"]):
        parser.exit(2, "unstable block or inconsistent identity; raw evidence saved\n")


if __name__ == "__main__":
    main()
