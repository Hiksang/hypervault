#!/usr/bin/env python3
"""Reconcile saved observations; hypotheses here never authorize onchain accounting or deposits."""
import argparse
from decimal import Decimal, localcontext
import json
from pathlib import Path

from nav_probe import api_token, info_value


def decoded(records, key):
    record = records.get(key, {})
    return record.get("value", {}).get("decoded") if record.get("ok") else None


def bracket(candidate, before, after):
    result = {"candidate": str(candidate), "apiBefore": before, "apiAfter": after,
              "classification": "MissingEvidence"}
    if before is not None and after is not None:
        first, last = Decimal(before), Decimal(after)
        if first.is_finite() and last.is_finite():
            result["classification"] = "BracketCompatibleNotProof" if min(first, last) <= candidate <= max(first, last) else "MismatchOrOtherExposure"
            result["differenceToApiAfter"] = str(candidate - last)
    return result


def analyze(report):
    result = {"sourceEvmBlock": report["evmBlock"], "sourceEvmBlockHash": report["evmBlockHash"],
              "productionNavReady": False, "activeDepositsAuthorized": False,
              "notice": "Diagnostic identities only. HTTP is unpinned; other tokens/DEXs, funding timing and transition semantics remain unverified.",
              "accounts": {}}
    tokens = {t["name"]: t["index"] for t in report["metadata"]["tokens"]}
    with localcontext() as context:
        context.prec = 100
        for account, row in report["accounts"].items():
            entry = {"pmObservedInBothApiReads": row["pmObservedInBothApiReads"], "identities": {}, "missingReads": []}
            for name in ("HYPE", "USDC"):
                token = tokens[name]
                spot = decoded(row["core"], f"spot:{token}")
                lending = decoded(row["core"], f"lending:{token}")
                meta = decoded(report["sharedCore"], f"tokenInfo:{token}")
                margin = decoded(row["core"], "margin")
                if spot is None or lending is None or meta is None or (name == "USDC" and margin is None):
                    entry["missingReads"].append(name)
                    continue
                # Lending scaling is a tested sample hypothesis, not implied by TokenInfo alone.
                candidate = Decimal(spot["total"] + lending["supplyValue"] - lending["borrowValue"]) / (Decimal(10) ** meta["weiDecimals"])
                if name == "USDC":
                    candidate += Decimal(margin["accountValue"]) / Decimal(10**6)
                def total(bundle):
                    balance = api_token(bundle, "spotClearinghouseState", token)
                    return balance.get("total") if balance else None
                check = bracket(candidate, total(row["infoBefore"]), total(row["infoAfter"]))
                check["formula"] = "rawSpot + lendingSupply - lendingDebt" + (" + defaultDexAccountValue" if name == "USDC" else "")
                entry["identities"][name] = check
            position = decoded(row["core"], "position")
            meta = decoded(report["sharedCore"], "perpInfo")
            if position is not None and meta is not None:
                size = Decimal(position["szi"]) / (Decimal(10) ** meta["szDecimals"])
                entry["position"] = {"rawSzi": position["szi"], "pinnedSzDecimals": meta["szDecimals"],
                                     "humanSize": str(size), "coreWriterSize1e8": str(size * Decimal(10**8))}
                state = info_value(row["infoAfter"], "clearinghouseState")
                positions = state.get("assetPositions", []) if isinstance(state, dict) else []
                target = next((item["position"] for item in positions if item.get("position", {}).get("coin") == "HYPE"), None)
                if target:
                    entry["position"]["apiSziAfter"] = target.get("szi")
                    entry["position"]["matchesApiAfter"] = size == Decimal(target["szi"])
                    # cumulative historical funding is retained as evidence, never treated as an unpaid receivable.
                    entry["position"]["apiCumFundingNotAddedToNav"] = target.get("cumFunding")
                    entry["position"]["apiUnrealizedPnlNotAddedAgain"] = target.get("unrealizedPnl")
            result["accounts"][account] = entry
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = analyze(json.loads(args.snapshot.read_text()))
    with args.output.open("x") as output:
        json.dump(report, output, indent=2)
        output.write("\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
