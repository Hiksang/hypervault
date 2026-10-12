#!/usr/bin/env python3
"""Block-pinned, read-only metadata for asset Vault transport. No signing or transactions."""
import argparse
import json
from pathlib import Path
from managed_mainnet import RPC, USDC, CIRCLE, rpc, same_hash
from nav_probe import calldata, decode_token_metadata, decode_fixed, RESERVE, utc_now

WHYPE = "0x5555555555555555555555555555555555555555"


def collect(url=RPC):
    if int(rpc(url, "eth_chainId", []), 16) != 999:
        raise ValueError("mainnet only")
    block = rpc(url, "eth_blockNumber", [])
    header = rpc(url, "eth_getBlockByNumber", [block, False])
    result = {"kind": "READ_ONLY_METADATA_NOT_ROUND_TRIP", "recordedAt": utc_now(),
              "block": block, "blockHash": header["hash"], "tokens": {}}
    def call(to, data):
        return rpc(url, "eth_call", [{"to": to, "data": data}, block])
    for index, label in ((0, "USDC"), (150, "HYPE"), (197, "UBTC")):
        item = {}
        result["tokens"][label] = item
        try:
            raw = call("0x" + "80c".zfill(40), calldata(index))
            item["tokenInfoRaw"] = raw
            meta = decode_token_metadata(raw)
            item["metadata"] = meta
            token = USDC if index == 0 else WHYPE if index == 150 else meta["evmContract"]
            item["evmAsset"] = token
            raw = call(token, "0x313ce567")
            item["decimalsRaw"] = raw
            decimals = decode_fixed(raw, [("decimals", "uint8")])["decimals"]
            item["decimals"] = decimals
            if index == 150:
                if decimals != 18 or meta["weiDecimals"] != 8:
                    raise ValueError("native HYPE precision mismatch")
            elif decimals != meta["weiDecimals"] + meta["evmExtraWeiDecimals"]:
                raise ValueError("decimal link mismatch")
            if index == 0 and meta["evmContract"].lower() != CIRCLE:
                raise ValueError("Circle link mismatch")
            if index:
                raw = call("0x" + "812".zfill(40), calldata(index))
                item["reserveRaw"] = raw
                item["reserve"] = decode_fixed(raw, RESERVE)
                if item["reserve"]["oraclePx"] == 0:
                    raise ValueError("no reserve price")
            item["ok"] = True
        except Exception as exc:
            item["ok"] = False
            item["errorType"] = type(exc).__name__
    result["sameBlockHash"] = same_hash(header, rpc(url, "eth_getBlockByNumber", [block, False]))
    result["allReadsSucceeded"] = all(x["ok"] for x in result["tokens"].values())
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    evidence = collect()
    with Path(args.output).open("x") as dest:
        json.dump(evidence, dest, indent=2)
        dest.write("\n")
    print(json.dumps({"block": evidence["block"], "allReadsSucceeded": evidence["allReadsSucceeded"]}))
    raise SystemExit(0 if evidence["allReadsSucceeded"] else 2)
