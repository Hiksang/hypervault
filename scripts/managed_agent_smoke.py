#!/usr/bin/env python3
"""Vault-dedicated agent order/cancel smoke test; unsigned dry-run by default.

Live execution needs an encrypted Ethereum keystore and the official
hyperliquid-python-sdk / eth-account installed in a separate environment.
Numeric market IDs and precision must be independently checked against CURRENT
mainnet metadata. A successful API response is not a fill or settlement proof.
"""
import argparse
from decimal import Decimal
import fcntl
import getpass
import json
import os
import re
import sys
import time
from managed_mainnet import address, post, API


def build_action(market, side, price, size, cloid, cancel=False, reduce_only=False):
    asset = market["asset"]
    if type(asset) is not int or not 0 <= asset < 2**32:
        raise ValueError("explicit uint32 asset ID required")
    if not re.fullmatch(r"0x[0-9a-fA-F]{32}", cloid):
        raise ValueError("16-byte cloid required")
    if cancel:
        return {"type": "cancelByCloid", "cancels": [{"asset": asset, "cloid": cloid}]}
    if market.get("network") != "mainnet" or market.get("kind") not in ("perp", "spot", "hip3", "hip4"):
        raise ValueError("reviewed mainnet market manifest required")
    if not market.get("symbol") or not market.get("metadataEvidence"):
        raise ValueError("symbol and metadataEvidence required")
    if market["kind"] in ("spot", "hip4") and reduce_only:
        raise ValueError("reduce-only is not assumed for spot/outcomes")
    for key in ("priceDecimals", "sizeDecimals"):
        if type(market[key]) is not int or not 0 <= market[key] <= 18:
            raise ValueError("invalid market precision")
    p, s, cap = Decimal(price), Decimal(size), Decimal(str(market["maxNotional"]))
    if not all(x.is_finite() and x > 0 for x in (p, s, cap)) or p * s > cap:
        raise ValueError("invalid amount or notional cap exceeded")
    if p != p.quantize(Decimal(1).scaleb(-market["priceDecimals"])) or s != s.quantize(Decimal(1).scaleb(-market["sizeDecimals"])):
        raise ValueError("market tick/lot precision exceeded")
    if side not in ("buy", "sell"):
        raise ValueError("side required")
    # Fixed Alo limits accidental taker fills, but a resting order CAN later fill.
    return {"type": "order", "orders": [{"a": asset, "b": side == "buy", "p": format(p, "f"),
            "s": format(s, "f"), "r": reduce_only, "t": {"limit": {"tif": "Alo"}}, "c": cloid}], "grouping": "na"}


def registered(agents, signer, now_ms):
    if not isinstance(agents, list):
        raise ValueError("unexpected extraAgents response")
    return any(address(a["address"]) == address(signer) and int(a["validUntil"]) > now_ms for a in agents)


def accepted(response):
    if not isinstance(response, dict) or response.get("status") != "ok":
        return False
    statuses = response.get("response", {}).get("data", {}).get("statuses")
    if not isinstance(statuses, list) or len(statuses) != 1:
        return False
    value = statuses[0]
    return value == "success" or (isinstance(value, dict) and ("resting" in value or "filled" in value) and "error" not in value)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, type=address)
    parser.add_argument("--market", required=True, help="reviewed market manifest JSON")
    parser.add_argument("--cloid", required=True)
    parser.add_argument("--side", choices=["buy", "sell"], default="buy")
    parser.add_argument("--price", default="0")
    parser.add_argument("--size", default="0")
    parser.add_argument("--reduce-only", action="store_true")
    parser.add_argument("--cancel", action="store_true")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--keystore")
    parser.add_argument("--nonce-file", help="unique per signer; retained across runs, do not share the key with another process")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    with open(args.market) as source:
        action = build_action(json.load(source), args.side, args.price, args.size, args.cloid, args.cancel, args.reduce_only)
    with open(args.output, "x") as output:
        evidence = {"account": args.vault, "action": action, "vaultAddress": None, "mode": "UNSIGNED_DRY_RUN"}
        if not args.execute:
            json.dump(evidence, output, indent=2)
            return 0
        if not args.keystore or not args.nonce_file:
            raise ValueError("execution requires keystore and per-signer nonce-file")
        from eth_account import Account
        from hyperliquid.utils.signing import sign_l1_action
        with open(args.keystore) as keyfile:
            wallet = Account.from_key(Account.decrypt(json.load(keyfile), getpass.getpass("Agent keystore password: ")))
        if address(wallet.address) == args.vault:
            raise ValueError("dedicated agent required")
        agents = post(API, {"type": "extraAgents", "user": args.vault})
        now = int(time.time() * 1000)
        if not registered(agents, wallet.address, now):
            raise ValueError("signer is not a currently registered agent of THIS Vault")
        # Serialize this signer, persist nonce BEFORE POST (also on network failure).
        fd = os.open(args.nonce_file, os.O_RDWR | os.O_CREAT, 0o600)
        with os.fdopen(fd, "r+") as nonce_file:
            fcntl.flock(nonce_file, fcntl.LOCK_EX)
            prior = nonce_file.read().strip()
            saved = json.loads(prior) if prior else {"signer": address(wallet.address), "nonce": 0}
            if saved["signer"] != address(wallet.address):
                raise ValueError("nonce file belongs to another signer")
            nonce = max(now, saved["nonce"] + 1)
            expiry = now + 60_000
            if nonce >= expiry:
                raise ValueError("local nonce clock is ahead; inspect before sending")
            nonce_file.seek(0)
            json.dump({"signer": address(wallet.address), "nonce": nonce}, nonce_file)
            nonce_file.truncate()
            nonce_file.flush()
            os.fsync(nonce_file.fileno())
            # This is a normal contract-owned Core master account, not a native HL Vault.
            signature = sign_l1_action(wallet, action, None, nonce, expiry, True)
            evidence.update(mode="LIVE_SUBMISSION", signer=wallet.address, nonce=nonce, expiresAfter=expiry)
            try:
                response = post("https://api.hyperliquid.xyz/exchange", {"action": action, "nonce": nonce,
                    "signature": signature, "vaultAddress": None, "expiresAfter": expiry})
                evidence.update(response=response, apiAccepted=accepted(response))
            except Exception as exc:
                evidence.update(apiAccepted=False, outcome="UNKNOWN_DO_NOT_RESUBMIT_BLINDLY", errorType=type(exc).__name__)
            json.dump(evidence, output, indent=2)  # no private key, password or signed payload
        return 0 if evidence["apiAccepted"] else 2


if __name__ == "__main__":
    sys.exit(main())
