#!/usr/bin/env python3
"""Read-only cloid diagnostics. An HTTP response never authorizes an on-chain retry."""
import argparse
import datetime
import json
import re
import urllib.request
from pathlib import Path


TERMINAL = frozenset({
    "filled", "canceled", "rejected", "marginCanceled", "vaultWithdrawalCanceled",
    "openInterestCapCanceled", "selfTradeCanceled", "reduceOnlyCanceled",
    "siblingFilledCanceled", "delistedCanceled", "liquidatedCanceled", "scheduledCancel",
    "tickRejected", "minTradeNtlRejected", "perpMarginRejected", "reduceOnlyRejected",
    "badAloPxRejected", "iocCancelRejected", "badTriggerPxRejected",
    "marketOrderNoLiquidityRejected", "positionIncreaseAtOpenInterestCapRejected",
    "positionFlipAtOpenInterestCapRejected", "tooAggressiveAtOpenInterestCapRejected",
    "openInterestIncreaseRejected", "insufficientSpotBalanceRejected", "oracleRejected",
    "perpMaxPositionRejected",
})


def validated_hex(value, byte_count):
    if not re.fullmatch(r"0x[0-9a-fA-F]{%d}" % (2 * byte_count), value):
        raise ValueError(f"expected 0x-prefixed {byte_count}-byte hex value")
    return value.lower()


def classify_response(account, cloid, response):
    account = validated_hex(account, 20)
    cloid = validated_hex(cloid, 16)
    report = {
        "account": account, "cloid": cloid, "classification": "Unrecognized",
        "onchainRetryAuthorized": False, "blockPinned": False,
        "raw": response,
        "notice": "Diagnostic HTTP data only; cancellation may follow partial fills. No contract proof.",
    }
    if not isinstance(response, dict):
        return report
    if response.get("status") == "unknownOid":
        report["classification"] = "NotFoundNotFailure"
        return report
    order = response.get("order")
    if response.get("status") != "order" or not isinstance(order, dict):
        return report
    payload = order.get("order")
    if not isinstance(payload, dict) or str(payload.get("cloid", "")).lower() != cloid:
        report["classification"] = "Uncorrelated"
        return report
    status = order.get("status")
    report["apiStatus"] = status
    if isinstance(status, str) and status in TERMINAL:
        report["classification"] = "TerminalApiReport"
    elif status in ("open", "triggered"):
        report["classification"] = "NonterminalApiReport"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("testnet", "mainnet"), default="testnet")
    parser.add_argument("--account", required=True, help="StrategyAccount address, not accounting Vault")
    parser.add_argument("--cloid", required=True, help="nonzero order cloid, padded to 16-byte hex")
    parser.add_argument("--output", type=Path, help="optional new JSON file; existing files are not overwritten")
    args = parser.parse_args()
    try:
        account, cloid = validated_hex(args.account, 20), validated_hex(args.cloid, 16)
        if int(cloid, 16) == 0:
            raise ValueError("cloid 0 cannot identify an order")
    except ValueError as error:
        parser.error(str(error))
    stem = "hyperliquid" if args.network == "mainnet" else "hyperliquid-testnet"
    endpoint = f"https://api.{stem}.xyz/info"
    request = urllib.request.Request(endpoint, json.dumps({
        "type": "orderStatus", "user": account, "oid": cloid,
    }).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            report = classify_response(account, cloid, json.load(response))
    except (OSError, ValueError) as error:
        report = classify_response(account, cloid, None)
        report.update(classification="ReadUnavailable", error=str(error))
    report.update(network=args.network, endpoint=endpoint,
                  observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    encoded = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as output:
            output.write(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
