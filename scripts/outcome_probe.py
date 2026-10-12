#!/usr/bin/env python3
"""Pinned, read-only HIP-4 precompile evidence. Does not value a portfolio or authorize deposits."""
import argparse
import json
from pathlib import Path

from action_status import validated_hex
from nav_probe import SPOT, calldata, decode_fixed, decode_token_metadata, observed, parallel, utc_now
from probe import post, rpc

STATUS = [("status", "uint8"), ("settledValue", "uint64"), ("question", "uint32")]


def encoded_asset(outcome, side):
    if type(outcome) is not int or type(side) is not int or outcome < 0 or side not in (0, 1):
        raise ValueError("invalid outcome or binary side")
    value = 100_000_000 + outcome * 10 + side
    if value >= 2**32:
        raise ValueError("encoded outcome does not fit spotPx uint32")
    return value


def capture(network, outcomes, account):
    account = validated_hex(account, 20)
    outcomes = sorted(set(outcomes))
    if not 1 <= len(outcomes) <= 8:
        raise ValueError("select one to eight outcome ids")
    for outcome in outcomes:
        encoded_asset(outcome, 1)
    stem = "hyperliquid" if network == "mainnet" else "hyperliquid-testnet"
    evm, api = f"https://rpc.{stem}.xyz/evm", f"https://api.{stem}.xyz/info"
    if int(rpc(evm, "eth_chainId", []), 16) != (999 if network == "mainnet" else 998):
        raise ValueError("chain mismatch")
    info = observed(lambda: post(api, {"type": "outcomeMeta"}))
    tag = rpc(evm, "eth_blockNumber", [])
    header = rpc(evm, "eth_getBlockByNumber", [tag, False])
    if not isinstance(header, dict) or header.get("number") != tag or not header.get("hash"):
        raise ValueError("invalid pinned header")

    def read(target, data, fields=None, decoder=None):
        raw = rpc(evm, "eth_call", [{"to": f"0x{target:040x}", "data": data}, tag])
        value = {"to": f"0x{target:040x}", "input": data, "raw": raw}
        if fields is not None or decoder is not None:
            try:
                value["decoded"] = decoder(raw) if decoder else decode_fixed(raw, fields)
            except ValueError as error:
                value["decodeError"] = str(error)
        return value

    jobs = {"coreBlock": lambda: read(0x0809, calldata(), [("number", "uint64")])}
    for outcome in outcomes:
        jobs[f"status:{outcome}"] = lambda o=outcome: read(0x0814, calldata(o), STATUS)
        for side in (0, 1):
            asset = encoded_asset(outcome, side)
            jobs[f"spot:{asset}"] = lambda a=asset: read(0x0801, calldata(account, a), SPOT)
            jobs[f"price:{asset}"] = lambda a=asset: read(0x0808, calldata(a), [("price", "uint64")])
            # ABI explicitly documents encoded support only for balance/price.
            # Probe metadata support as a hypothesis and retain any failure.
            jobs[f"tokenInfoEncoded:{asset}"] = lambda a=asset: read(0x080c, calldata(a), decoder=decode_token_metadata)
            jobs[f"spotInfoEncoded:{asset}"] = lambda a=asset: read(0x080b, calldata(a))
    core = parallel(jobs)
    end = observed(lambda: rpc(evm, "eth_getBlockByNumber", [tag, False]))
    stable = end.get("ok") and isinstance(end.get("value"), dict) and end["value"].get("hash") == header["hash"]
    return {"schema": 1, "observedAt": utc_now(), "network": network, "rpc": evm, "info": api,
            "account": account, "outcomes": outcomes, "evmBlock": tag, "evmBlockHash": header["hash"],
            "blockHashStable": bool(stable), "endHeader": end, "infoBlockPinned": False,
            "outcomeMeta": info, "core": core, "productionNavReady": False,
            "notice": "Raw HIP-4 capability evidence. Unknown metadata/failed reads are not zero; no trading or settlement execution."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("mainnet", "testnet"), required=True)
    parser.add_argument("--outcome", action="append", type=int, required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output exists; preserve raw evidence")
    report = capture(args.network, args.outcome, args.account)
    with args.output.open("x") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
    print(json.dumps({"evmBlock": report["evmBlock"], "blockHashStable": report["blockHashStable"],
                      "failedReads": [k for k, v in report["core"].items() if not v["ok"]]}))
    if not report["blockHashStable"] or any(not v["ok"] or "decodeError" in v.get("value", {}) for v in report["core"].values()):
        parser.exit(2, "incomplete reads; raw evidence saved\n")


if __name__ == "__main__":
    main()
