#!/usr/bin/env python3
"""Read-only, block-pinned Core accounting evidence. Never produces a mint-authorizing NAV."""
import argparse
import concurrent.futures
import datetime
from decimal import Decimal, localcontext
import json
from pathlib import Path
import re

from action_status import validated_hex
from probe import post, rpc


SPOT = [("total", "uint64"), ("hold", "uint64"), ("entryNtl", "uint64")]
LENDING = [(k, "uint64") for k in ("borrowBasis", "borrowValue", "supplyBasis", "supplyValue")]
POSITION = [("szi", "int64"), ("entryNtl", "uint64"), ("isolatedRawUsd", "int64"),
            ("leverage", "uint32"), ("isIsolated", "bool")]
MARGIN = [("accountValue", "int64"), ("marginUsed", "uint64"), ("ntlPos", "uint64"), ("rawUsd", "int64")]
RESERVE = [(k, "uint64") for k in ("borrowYearlyRateBps", "supplyYearlyRateBps", "balance",
                                   "utilizationBps", "oraclePx", "ltvBps", "totalSupplied", "totalBorrowed")]
INFO_KINDS = ("userAbstraction", "spotClearinghouseState", "borrowLendUserState", "clearinghouseState")


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def calldata(*values):
    encoded = []
    for value in values:
        if isinstance(value, str):
            value = int(validated_hex(value, 20), 16)
        if type(value) is not int or not 0 <= value < 2**256:
            raise ValueError("invalid ABI input word")
        encoded.append(f"{value:064x}")
    return "0x" + "".join(encoded)


def decode_fixed(raw, fields):
    if not isinstance(raw, str) or not re.fullmatch(r"0x[0-9a-fA-F]*", raw) or len(raw) != 2 + 64 * len(fields):
        raise ValueError("unexpected ABI response length or encoding")
    result = {}
    for i, (name, kind) in enumerate(fields):
        word = int(raw[2 + 64 * i:2 + 64 * (i + 1)], 16)
        if kind == "bool":
            if word not in (0, 1):
                raise ValueError("noncanonical bool")
            result[name] = bool(word)
            continue
        signed = kind.startswith("int")
        bits = int(kind[3:] if signed else kind[4:])
        value = word - 2**256 if signed and word >= 2**255 else word
        lower, upper = (-2**(bits - 1), 2**(bits - 1)) if signed else (0, 2**bits)
        if not lower <= value < upper:
            raise ValueError(f"noncanonical {kind}")
        result[name] = value
    return result


def decode_token_metadata(raw):
    # L1Read.TokenInfo returns one dynamic tuple. Decode its fixed header only, retaining all raw bytes.
    if not isinstance(raw, str) or not re.fullmatch(r"0x[0-9a-fA-F]+", raw) or (len(raw) - 2) % 64:
        raise ValueError("malformed tokenInfo")
    if len(raw) < 2 + 9 * 64 or int(raw[2:66], 16) != 32:
        raise ValueError("unexpected tokenInfo tuple offset")
    head = decode_fixed("0x" + raw[66:66 + 8 * 64], [
        ("nameOffset", "uint256"), ("spotsOffset", "uint256"), ("deployerTradingFeeShare", "uint64"),
        ("deployer", "uint160"), ("evmContract", "uint160"), ("szDecimals", "uint8"),
        ("weiDecimals", "uint8"), ("evmExtraWeiDecimals", "int8")])
    return {**{k: head[k] for k in ("szDecimals", "weiDecimals", "evmExtraWeiDecimals")},
            "evmContract": f"0x{head['evmContract']:040x}"}


def decode_perp_metadata(raw):
    if not isinstance(raw, str) or not re.fullmatch(r"0x[0-9a-fA-F]+", raw) or (len(raw) - 2) % 64:
        raise ValueError("malformed perpAssetInfo")
    if len(raw) < 2 + 6 * 64 or int(raw[2:66], 16) != 32:
        raise ValueError("unexpected perpAssetInfo tuple offset")
    head = decode_fixed("0x" + raw[66:66 + 5 * 64], [
        ("coinOffset", "uint256"), ("marginTableId", "uint32"), ("szDecimals", "uint8"),
        ("maxLeverage", "uint8"), ("onlyIsolated", "bool")])
    return {k: v for k, v in head.items() if k != "coinOffset"}


def observed(fn):
    record = {"startedAt": utc_now()}
    try:
        record.update(ok=True, value=fn())
    except Exception as error:
        record.update(ok=False, error=f"{type(error).__name__}: {error}")
    record["finishedAt"] = utc_now()
    return record


def parallel(jobs):
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {key: pool.submit(observed, fn) for key, fn in jobs.items()}
        return {key: future.result() for key, future in futures.items()}


def compare_units(raw_value, before, after):
    """Scale candidates only. Separate HTTP observations are never an onchain accounting proof."""
    result = {"raw": raw_value, "apiBefore": before, "apiAfter": after,
              "classification": "MissingEvidence", "candidateDecimals": [], "provesUnits": False}
    if raw_value is None or before is None or after is None:
        return result
    try:
        # No float: exact source decimal strings and uint64/int64 values are preserved.
        with localcontext() as ctx:
            ctx.prec = 100
            a, b = Decimal(str(before)), Decimal(str(after))
            if not a.is_finite() or not b.is_finite():
                raise ValueError("nonfinite amount")
            if raw_value == 0 and a == 0 and b == 0:
                result["classification"] = "ZeroHasNoScaleEvidence"
                return result
            for decimals in range(19):
                scaled = Decimal(raw_value) / Decimal(10)**decimals
                if min(a, b) <= scaled <= max(a, b):
                    result["candidateDecimals"].append(decimals)
            result["classification"] = ("ExactNonzeroMatch" if a == b else "BracketCompatibleNotProof") \
                if result["candidateDecimals"] else "NoCandidateMatch"
    except (ValueError, ArithmeticError):
        result["classification"] = "MalformedApiAmount"
    return result


def info_value(bundle, kind):
    entry = bundle.get(kind, {})
    return entry.get("value") if entry.get("ok") else None


def api_token(bundle, kind, token):
    value = info_value(bundle, kind)
    if not isinstance(value, dict):
        return None
    if kind == "spotClearinghouseState":
        balances = value.get("balances")
        if not isinstance(balances, list):
            return None
        return next((b for b in balances if isinstance(b, dict) and b.get("token") == token), None)
    states = value.get("tokenToState")
    if not isinstance(states, list):
        return None
    return next((pair[1] for pair in states if isinstance(pair, list) and len(pair) == 2
                 and pair[0] == token and isinstance(pair[1], dict)), None)


def compare_account(account_record, tokens):
    comparisons = {}
    before, after, core = (account_record[k] for k in ("infoBefore", "infoAfter", "core"))
    for token in tokens:
        index = token["index"]
        for kind, api_kind, fields in [("spot", "spotClearinghouseState", SPOT),
                                      ("lending", "borrowLendUserState", LENDING)]:
            first, last = api_token(before, api_kind, index), api_token(after, api_kind, index)
            entry = core[f"{kind}:{index}"]
            raw = entry.get("value", {}).get("decoded", {}) if entry.get("ok") else {}
            for field, _ in fields:
                def value(state):
                    if state is None:
                        return None  # An omitted token is not positive evidence of zero.
                    if kind == "spot":
                        return state.get(field)
                    side = "borrow" if field.startswith("borrow") else "supply"
                    values = state.get(side)
                    return values.get("basis" if field.endswith("Basis") else "value") if isinstance(values, dict) else None
                comparisons[f"{kind}:{index}:{field}"] = compare_units(raw.get(field), value(first), value(last))
    for field, api_field in [("accountValue", "accountValue"), ("marginUsed", "totalMarginUsed"),
                             ("ntlPos", "totalNtlPos"), ("rawUsd", "totalRawUsd")]:
        def margin(bundle):
            value = info_value(bundle, "clearinghouseState")
            summary = value.get("marginSummary") if isinstance(value, dict) else None
            return summary.get(api_field) if isinstance(summary, dict) else None
        raw = core["margin"].get("value", {}).get("decoded", {})
        comparisons[f"margin:{field}"] = compare_units(raw.get(field), margin(before), margin(after))
    return comparisons


def discover(spot, perps):
    tokens = []
    for name in ("HYPE", "USDC"):
        matches = [t for t in spot["tokens"] if t["name"] == name]
        if len(matches) != 1:
            raise ValueError(f"ambiguous {name} metadata")
        tokens.append(matches[0])
    pairs = [p for p in spot["universe"] if p["tokens"] == [tokens[0]["index"], tokens[1]["index"]]]
    markets = [(i, p) for i, p in enumerate(perps["universe"]) if p["name"] == "HYPE"]
    if len(pairs) != 1 or len(markets) != 1:
        raise ValueError("ambiguous HYPE market")
    return tokens, pairs[0], {"asset": markets[0][0], **markets[0][1]}


def capture(network, accounts):
    accounts = list(dict.fromkeys(validated_hex(a, 20) for a in accounts))
    if not 1 <= len(accounts) <= 8:
        raise ValueError("provide between one and eight accounts")
    stem = "hyperliquid" if network == "mainnet" else "hyperliquid-testnet"
    api, evm = f"https://api.{stem}.xyz/info", f"https://rpc.{stem}.xyz/evm"
    expected_chain = 999 if network == "mainnet" else 998
    if int(rpc(evm, "eth_chainId", []), 16) != expected_chain:
        raise ValueError("RPC chain mismatch")
    metadata = parallel({"spot": lambda: post(api, {"type": "spotMeta"}),
                         "perp": lambda: post(api, {"type": "meta"})})
    if not all(v["ok"] for v in metadata.values()):
        raise ValueError("metadata unavailable; refusing guessed indices or latest-block fallback")
    tokens, pair, perp = discover(metadata["spot"]["value"], metadata["perp"]["value"])

    def info_jobs():
        jobs = {f"{a}:{kind}": lambda a=a, kind=kind: post(api, {"type": kind, "user": a})
                for a in accounts for kind in INFO_KINDS}
        for token in tokens:
            i = token["index"]
            jobs[f"reserve:{i}"] = lambda i=i: post(api, {"type": "borrowLendReserveState", "token": i})
        return jobs

    before = parallel(info_jobs())
    tag = rpc(evm, "eth_blockNumber", [])
    if not isinstance(tag, str) or not re.fullmatch(r"0x[0-9a-fA-F]+", tag):
        raise ValueError("cannot pin EVM block")
    header = rpc(evm, "eth_getBlockByNumber", [tag, False])
    if not isinstance(header, dict) or header.get("number") != tag or not header.get("hash"):
        raise ValueError("invalid pinned header")

    def read(address, data, fields=None, decoder=None):
        raw = rpc(evm, "eth_call", [{"to": f"0x{address:040x}", "data": data}, tag])
        value = {"to": f"0x{address:040x}", "input": data, "raw": raw}
        try:
            value["decoded"] = decoder(raw) if decoder else decode_fixed(raw, fields)
        except ValueError as error:
            value["decodeError"] = str(error)
        return value

    jobs = {"coreBlock": lambda: read(0x0809, calldata(), [("number", "uint64")]),
            "perpInfo": lambda: read(0x080a, calldata(perp["asset"]), decoder=decode_perp_metadata),
            "mark": lambda: read(0x0806, calldata(perp["asset"]), [("price", "uint64")]),
            "oracle": lambda: read(0x0807, calldata(perp["asset"]), [("price", "uint64")]),
            "spotPrice": lambda: read(0x0808, calldata(pair["index"]), [("price", "uint64")])}
    for token in tokens:
        i = token["index"]
        jobs[f"tokenInfo:{i}"] = lambda i=i: read(0x080c, calldata(i), decoder=decode_token_metadata)
        jobs[f"reserve:{i}"] = lambda i=i: read(0x0812, calldata(i), RESERVE)
    for a in accounts:
        jobs[f"{a}:exists"] = lambda a=a: read(0x0810, calldata(a), [("exists", "bool")])
        jobs[f"{a}:position"] = lambda a=a: read(0x0813, calldata(a, perp["asset"]), POSITION)
        jobs[f"{a}:margin"] = lambda a=a: read(0x080f, calldata(0, a), MARGIN)
        for token in tokens:
            i = token["index"]
            jobs[f"{a}:spot:{i}"] = lambda a=a, i=i: read(0x0801, calldata(a, i), SPOT)
            jobs[f"{a}:lending:{i}"] = lambda a=a, i=i: read(0x0811, calldata(a, i), LENDING)
    core = parallel(jobs)
    after = parallel(info_jobs())
    end_header = observed(lambda: rpc(evm, "eth_getBlockByNumber", [tag, False]))
    same_hash = end_header.get("ok") and isinstance(end_header.get("value"), dict) \
        and end_header["value"].get("hash") == header["hash"]
    report = {"schema": 1, "observedAt": utc_now(), "network": network, "rpc": evm, "info": api,
              "scope": "read-only evidence; selected HYPE/USDC and default perp DEX, NOT full account coverage",
              "evmBlock": tag, "evmBlockHash": header["hash"], "evmTimestamp": int(header["timestamp"], 16),
              "blockHashStable": bool(same_hash), "endHeader": end_header,
              "infoBlockPinned": False, "productionNavReady": False, "activeDepositsAuthorized": False,
              "metadata": {"blockPinned": False, "tokens": tokens, "spotPair": pair, "perp": perp},
              "sharedCore": {k: v for k, v in core.items() if not k.startswith("0x")}, "accounts": {}}
    report["reserveInfoBefore"] = {k: v for k, v in before.items() if k.startswith("reserve:")}
    report["reserveInfoAfter"] = {k: v for k, v in after.items() if k.startswith("reserve:")}
    for a in accounts:
        record = {"infoBefore": {k: before[f"{a}:{k}"] for k in INFO_KINDS},
                  "infoAfter": {k: after[f"{a}:{k}"] for k in INFO_KINDS},
                  "core": {k[len(a) + 1:]: v for k, v in core.items() if k.startswith(a + ":")}}
        record["unitComparisons"] = compare_account(record, tokens)
        record["pmObservedInBothApiReads"] = all(
            info_value(record[k], "userAbstraction") == "portfolioMargin" for k in ("infoBefore", "infoAfter"))
        report["accounts"][a] = record
    reads_ok = all(r.get("ok") and "decoded" in r.get("value", {}) for r in core.values())
    report["completePinnedReadSet"] = bool(same_hash and reads_ok)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("mainnet", "testnet"), required=True)
    parser.add_argument("--account", action="append", required=True, help="Core owner address, not API agent wallet")
    parser.add_argument("--output", type=Path, required=True, help="new file; never overwrite prior evidence")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists")
    try:
        report = capture(args.network, args.account)
    except (ValueError, OSError, KeyError, RuntimeError) as error:
        parser.exit(1, f"probe failed: {error}\n")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(json.dumps({k: report[k] for k in ("network", "evmBlock", "blockHashStable", "completePinnedReadSet",
                                            "productionNavReady", "activeDepositsAuthorized")}))
    if not report["completePinnedReadSet"]:
        parser.exit(2, "incomplete or inconsistent pinned reads; raw evidence saved\n")


if __name__ == "__main__":
    main()
