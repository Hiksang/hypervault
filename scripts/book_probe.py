#!/usr/bin/env python3
"""Read-only probe of how the spot book precompiles answer for a book with an empty side.

The valuation reads a zero bid as "nothing can be sold" and a failed read as an error. It
therefore matters whether `bbo` (0x080e) answers an empty side with zero or reverts, and whether
`spotPx` (0x0808) keeps a mark when nobody quotes. The HTTP API only picks the pairs to ask
about: it is not pinned to the EVM block, so a book may have changed between the two reads.
Never signs or sends.
"""
import argparse
import json
from pathlib import Path

from equity_probe import paced_post
from nav_probe import utc_now
from probe import rpc


USDC = 0
BBO = "0x000000000000000000000000000000000000080e"
SPOT_PX = "0x0000000000000000000000000000000000000808"
SPOT_ASSET_BASE = 10_000
KINDS = ("empty", "noBid", "noAsk")


def candidates(meta, contexts):
    """USDC-quoted pairs the API shows without a mid price: at least one side of the book is empty."""
    by_coin = {context["coin"]: context for context in contexts if "coin" in context}
    result = []
    for pair in meta["universe"]:
        context = by_coin.get(pair["name"])
        if context is not None and pair["tokens"][1] == USDC and context.get("midPx") is None:
            result.append({"pair": pair["index"], "name": pair["name"], "apiMarkPx": context.get("markPx")})
    return result


def side(book):
    """Which side of an l2Book answer is empty, or None for a two-sided book."""
    bids, asks = book["levels"]
    if not bids and not asks:
        return "empty"
    return "noBid" if not bids else "noAsk" if not asks else None


def words(raw, count):
    if not isinstance(raw, str) or not raw.startswith("0x") or len(raw) != 2 + 64 * count:
        raise ValueError("unexpected precompile answer length")
    return [int(raw[i:i + 64], 16) for i in range(2, len(raw), 64)]


def read(transport, evm, tag, to, argument):
    """One pinned precompile read. A revert is the finding, so it is recorded; anything else is raised."""
    try:
        return {"ok": True, "raw": transport(evm, "eth_call", [{"to": to, "data": f"0x{argument:064x}"}, tag])}
    except RuntimeError as error:
        if "revert" not in str(error).lower():
            raise  # a transport failure is not the precompile's answer
        return {"ok": False, "error": str(error)[:300]}


def capture(network, per_kind=3, transport=rpc, info=None):
    stem = "hyperliquid" if network == "mainnet" else "hyperliquid-testnet"
    api, evm = f"https://api.{stem}.xyz/info", f"https://rpc.{stem}.xyz/evm"
    info = info or (lambda body: paced_post(api, body))
    if int(transport(evm, "eth_chainId", []), 16) != (999 if network == "mainnet" else 998):
        raise ValueError("RPC chain mismatch")
    tag = transport(evm, "eth_blockNumber", [])
    header = transport(evm, "eth_getBlockByNumber", [tag, False])
    if not isinstance(header, dict) or header.get("number") != tag or not header.get("hash"):
        raise ValueError("cannot pin EVM block")
    meta, contexts = info({"type": "spotMetaAndAssetCtxs"})
    listed = candidates(meta, contexts)
    rows, seen = [], dict.fromkeys(KINDS, 0)
    for row in listed:
        if all(count >= per_kind for count in seen.values()):
            break
        kind = side(info({"type": "l2Book", "coin": row["name"]}))
        if kind is None or seen[kind] >= per_kind:
            continue
        seen[kind] += 1
        row["apiBook"] = kind
        bbo = read(transport, evm, tag, BBO, SPOT_ASSET_BASE + row["pair"])
        if bbo["ok"]:
            bbo["bid"], bbo["ask"] = words(bbo["raw"], 2)
        mark = read(transport, evm, tag, SPOT_PX, row["pair"])
        if mark["ok"]:
            mark["price"] = words(mark["raw"], 1)[0]
        row.update(bbo=bbo, spotPx=mark)
        rows.append(row)
    end = transport(evm, "eth_getBlockByNumber", [tag, False])
    return {"kind": "READ_ONLY_BOOK_PROBE", "observedAt": utc_now(), "network": network, "evmBlock": tag,
            "evmBlockHash": header["hash"], "infoBlockPinned": False, "candidates": len(listed), "sampled": seen,
            "rows": rows, "summary": summary(rows),
            "blockHashStable": bool(isinstance(end, dict) and end.get("hash") == header["hash"])}


def summary(rows):
    """Counts only. The API read is unpinned, so a mismatch is something to look at, not a verdict."""
    answered = [row for row in rows if row["bbo"]["ok"]]
    no_bid = [row for row in answered if row["apiBook"] in ("empty", "noBid")]
    no_ask = [row for row in answered if row["apiBook"] in ("empty", "noAsk")]
    return {"bboReverted": len(rows) - len(answered),
            "emptyBidSides": len(no_bid), "emptyBidSidesReadAsZero": sum(row["bbo"]["bid"] == 0 for row in no_bid),
            "emptyAskSides": len(no_ask), "emptyAskSidesReadAsZero": sum(row["bbo"]["ask"] == 0 for row in no_ask),
            "spotPxReverted": sum(not row["spotPx"]["ok"] for row in rows),
            "spotPxNonZero": sum(row["spotPx"]["ok"] and row["spotPx"]["price"] != 0 for row in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("mainnet", "testnet"), required=True)
    parser.add_argument("--per-kind", type=int, default=3, help="pairs to sample per kind of empty side")
    parser.add_argument("--output", type=Path, help="new file; never overwrite a prior observation")
    args = parser.parse_args()
    if args.output and args.output.exists():
        parser.error("output already exists")
    try:
        report = capture(args.network, args.per_kind)
    except (ValueError, OSError, KeyError, RuntimeError) as error:
        parser.exit(1, f"probe failed: {error}\n")
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as output:
            output.write(text + "\n")
    print(text)
    if not report["blockHashStable"]:
        parser.exit(2, "pinned block changed during the probe; rerun\n")


if __name__ == "__main__":
    main()
