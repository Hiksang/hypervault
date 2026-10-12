#!/usr/bin/env python3
"""Read-only HyperEVM mainnet preflight / contract-account snapshots. Never signs.

RPC reads share an explicit EVM block. HTTP Core observations are NOT block-pinned
or verifier proofs. Preserve failures and raw results; never turn them into zero.
"""
import argparse
import datetime
import json
import re
import subprocess
import sys
import urllib.request

USDC = "0xb88339cb7199b77e23db6e890353e22632ba630f"
CIRCLE = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24"
WRITER = "0x3333333333333333333333333333333333333333"
RPC = "https://rpc.hyperliquid.xyz/evm"
API = "https://api.hyperliquid.xyz/info"


def address(value):
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", value) or int(value, 16) == 0:
        raise ValueError("nonzero 20-byte address required")
    return value.lower()


def post(url, body):
    request = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def rpc(url, method, params):
    result = post(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in result or "result" not in result:
        raise ValueError(f"RPC {method} returned error: {result.get('error', 'missing result')}")
    return result["result"]


def uint_words(data, count):
    if not isinstance(data, str) or not re.fullmatch(r"0x[0-9a-fA-F]*", data) or len(data) != 2 + 64 * count:
        raise ValueError("invalid ABI word count")
    return [int(data[2 + 64 * i:2 + 64 * (i + 1)], 16) for i in range(count)]


def calldata(signature, *args):
    result = subprocess.run(["cast", "calldata", signature, *map(str, args)], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def snapshot(url=RPC, account=None, dexes=(), transport=rpc, info=lambda body: post(API, body)):
    chain = int(transport(url, "eth_chainId", []), 16)
    if chain != 999:
        raise ValueError(f"expected mainnet chain 999, received {chain}")
    block = transport(url, "eth_blockNumber", [])
    header = transport(url, "eth_getBlockByNumber", [block, False])
    if not header or header.get("number") != block or not header.get("hash"):
        raise ValueError("missing pinned block header")
    result = {"chainId": chain, "evmBlock": block, "evmBlockHash": header["hash"],
              "recordedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "kind": "READ_ONLY_OBSERVATION_NOT_VERIFIER_PROOF", "checks": {}}

    def check(name, fn):
        try:
            result["checks"][name] = {"ok": True, "raw": fn()}
        except Exception as exc:
            # Do not print request URLs: custom RPC URLs can contain credentials.
            result["checks"][name] = {"ok": False, "errorType": type(exc).__name__}

    def code(target):
        raw = transport(url, "eth_getCode", [target, block])
        if not re.fullmatch(r"0x(?:[0-9a-fA-F]{2})+", raw):
            raise ValueError("missing bytecode")
        return raw

    def call(target, data):
        return transport(url, "eth_call", [{"to": target, "data": data}, block])

    for name, target in [("usdcCode", USDC), ("circleCode", CIRCLE), ("writerCode", WRITER)]:
        check(name, lambda target=target: code(target))

    def decimals():
        raw = call(USDC, "0x313ce567")
        if uint_words(raw, 1) != [6]:
            raise ValueError("USDC decimals mismatch")
        return raw

    check("usdcDecimals", decimals)
    check("coreBlock", lambda: {"raw": (raw := call("0x" + "809".zfill(40), "0x")), "decoded": uint_words(raw, 1)})
    if account:
        account = address(account)
        result["account"] = account
        encoded = account[2:].zfill(64)
        check("accountCode", lambda: code(account))
        check("evmUsdc", lambda: {"raw": (raw := call(USDC, "0x70a08231" + encoded)), "decoded": uint_words(raw, 1)})
        check("coreExists", lambda: {"raw": (raw := call("0x" + "810".zfill(40), "0x" + encoded)), "decoded": uint_words(raw, 1)})
        check("coreSpotUsdc", lambda: {"raw": (raw := call("0x" + "801".zfill(40), "0x" + encoded + "0" * 64)), "decoded": uint_words(raw, 3)})
        for kind in ("extraAgents", "spotClearinghouseState", "userFills"):
            check("http:" + kind, lambda kind=kind: info({"type": kind, "user": account}))
        for dex in dict.fromkeys(["", *dexes]):
            for kind in ("clearinghouseState", "openOrders"):
                check("http:" + kind + ":" + dex, lambda kind=kind, dex=dex: info({"type": kind, "user": account, "dex": dex}))
        result["httpScope"] = {"blockPinned": False, "dexes": list(dict.fromkeys(["", *dexes])),
                               "completePortfolio": False, "fillsMayBeTruncated": True}
    # A reorg during collection makes the whole snapshot unusable, even if calls succeeded.
    check("sameBlockHash", lambda: same_hash(header, transport(url, "eth_getBlockByNumber", [block, False])))
    result["allReadsSucceeded"] = all(x["ok"] for x in result["checks"].values())
    return result


def same_hash(before, after):
    if not after or before["hash"] != after.get("hash"):
        raise ValueError("pinned block reorg")
    return before["hash"]


def assert_creation(receipt, state, creator, factory, activation_cost):
    """Validate collected EVM facts only, never assert Core activation from this.

    state is decoded at receipt.blockNumber by the experiment runner/operator.
    It includes the factory's registry result and the Vault's public getters.
    """
    status = receipt.get("status")
    if status not in (1, "0x1"):
        raise ValueError("EVM creation reverted or unknown")
    expected = {"owner": address(creator), "deploymentFactory": address(factory),
                "founderShares": 100_000_000_000, "founderBasis": 100_000_000,
                "phase": 1, "coreActivated": False, "isVault": True,
                "activationCost": activation_cost}
    if state.get("blockNumber") != receipt.get("blockNumber"):
        raise ValueError("state must be pinned to creation receipt block")
    for key, value in expected.items():
        if state.get(key) != value:
            raise ValueError("creation invariant failed: " + key)
    return {"evmCreation": "PASS", "coreActivation": "NOT_ASSERTED"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", default=RPC)
    parser.add_argument("--account", type=address)
    parser.add_argument("--dex", action="append", default=[])
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    # Reserve the output before any network call; never overwrite prior evidence.
    with open(args.output, "x") as output:
        try:
            result = snapshot(args.rpc_url, args.account, args.dex)
        except Exception as exc:
            json.dump({"allReadsSucceeded": False, "fatalErrorType": type(exc).__name__}, output, indent=2)
            return 2
        json.dump(result, output, indent=2)
    print("Read-only snapshot saved; Core execution and production NAV are not certified.")
    return 0 if result["allReadsSucceeded"] else 2


if __name__ == "__main__":
    sys.exit(main())
