#!/usr/bin/env python3
"""Read-only Hyperliquid feature probe. Never signs or submits transactions."""
import argparse
import datetime
import json
import urllib.request
from pathlib import Path


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=25) as response:
        return json.load(response)


def rpc(url, method, params):
    response = post(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in response:
        raise RuntimeError(response["error"])
    return response["result"]


def attempt(fn):
    try:
        return fn()
    except Exception as exc:
        return {"error": str(exc)}


def words(value):
    if not isinstance(value, str) or not value.startswith("0x"):
        return value
    data = value[2:]
    if not data or len(data) % 64:
        return {"raw": value, "error": "empty or non-word-aligned response"}
    return [int(data[i:i + 64], 16) for i in range(0, len(data), 64)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--network", choices=["mainnet", "testnet"], default="testnet")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    stem = "hyperliquid" if args.network == "mainnet" else "hyperliquid-testnet"
    api, evm = f"https://api.{stem}.xyz/info", f"https://rpc.{stem}.xyz/evm"
    result = {"network": args.network, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "rpc": evm, "info": api, "scope": "read-only; no CoreWriter execution validated"}
    result["chainId"] = attempt(lambda: rpc(evm, "eth_chainId", []))
    block = attempt(lambda: rpc(evm, "eth_blockNumber", []))
    result["evmBlock"] = block
    # All EVM reads use the same block. HTTP info metadata has no pinned-block guarantee.
    tag = block if isinstance(block, str) else "latest"
    for label, addr in [("coreWriterCode", "0x" + "3" * 40), ("canonicalWhypeCode", "0x" + "5" * 40)]:
        result[label] = attempt(lambda addr=addr: rpc(evm, "eth_getCode", [addr, tag]))
    metadata = attempt(lambda: post(api, {"type": "spotMeta"}))
    if isinstance(metadata, dict) and "tokens" in metadata:
        tokens = [t for t in metadata["tokens"] if t["name"] in ("HYPE", "USDC")]
        result["tokens"] = tokens
        indices = {t["index"] for t in tokens}
        result["spotPairs"] = [p for p in metadata["universe"] if set(p["tokens"]) == indices]
        reserve_keys = ["borrowYearlyRateBps", "supplyYearlyRateBps", "balance", "utilizationBps", "oraclePx", "ltvBps", "totalSupplied", "totalBorrowed"]
        for token in tokens:
            data = "0x" + format(token["index"], "064x")
            raw = attempt(lambda data=data: rpc(evm, "eth_call", [{"to": "0x0000000000000000000000000000000000000812", "data": data}, tag]))
            decoded = words(raw)
            result[token["name"] + "Reserve"] = dict(zip(reserve_keys, decoded)) if isinstance(decoded, list) and len(decoded) == 8 else {"raw": raw, "decoded": decoded}
    else:
        result["metadataError"] = metadata
    perps = attempt(lambda: post(api, {"type": "meta"}))
    if isinstance(perps, dict) and "universe" in perps:
        result["hypePerp"] = [{"asset": i, **p} for i, p in enumerate(perps["universe"]) if p["name"] == "HYPE"]
    else:
        result["perpMetadataError"] = perps
    result["l1Block"] = words(attempt(lambda: rpc(evm, "eth_call", [{"to": "0x0000000000000000000000000000000000000809", "data": "0x"}, tag])))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if not k.endswith("Code")}, indent=2))


if __name__ == "__main__":
    main()
