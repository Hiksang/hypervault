#!/usr/bin/env python3
"""Read-only measurement of HyperCore read-precompile gas from inside EVM code.

Runs test/mainnet/PrecompileGasProbe.sol as the creation code of an `eth_call` pinned to one
block. Nothing is signed, sent or deployed. Build the artifact first: `forge build --offline`.
"""
import argparse
import datetime
import json
import sys
import time
import urllib.request
from pathlib import Path

ARTIFACT = Path(__file__).resolve().parent.parent / "out/PrecompileGasProbe.sol/PrecompileGasProbe.json"
DOCUMENTED = "2000 + 65 * (input_len + output_len)"
CALL_GAS = 2_900_000  # below the 3M small-block limit; eth_call only
UNKNOWN_ACCOUNT = "0x1234567890abcdef1234567890abcdef12345678"  # arbitrary; expected not to exist on Core


def word(value):
    text = value.lower().replace("0x", "") if isinstance(value, str) else hex(value)[2:]
    return text.rjust(64, "0")


def encode_arguments(target, data_hex, caps):
    """ABI-encode (address target, bytes input, uint256[] caps)."""
    raw = data_hex[2:]
    padded = raw.ljust((len(raw) + 63) // 64 * 64, "0")
    input_part = word(len(raw) // 2) + padded
    caps_part = word(len(caps)) + "".join(word(cap) for cap in caps)
    return word(target) + word(0x60) + word(0x60 + len(input_part) // 2) + input_part + caps_part


def decode_result(result_hex, count):
    """Decode (bool[] succeeded, uint256[] used, uint256[] sizes) of `count` rows each."""
    body = result_hex[2:]
    if len(body) % 64 or len(body) // 64 < 3 * (count + 2):
        raise ValueError("malformed probe result")
    words = [int(body[i:i + 64], 16) for i in range(0, len(body), 64)]
    out = []
    for head in range(3):
        start = words[head] // 32
        if words[start] != count:
            raise ValueError("unexpected array length")
        out.append(words[start + 1:start + 1 + count])
    return [bool(x) for x in out[0]], out[1], out[2]


def minimal_cap(rows):
    """Smallest succeeding cap whose predecessor (cap - 1) was measured and failed, else None."""
    by_cap = {row["gasCap"]: row["ok"] for row in rows}
    exact = [cap for cap, ok in by_cap.items() if ok and by_cap.get(cap - 1) is False]
    return min(exact) if exact else None


def fitted_cost(input_bytes, output_bytes):
    """Cost that matched every measured boundary on 2026-10-04. An observation, not a constant."""
    return 1000 + 33 * (input_bytes + output_bytes)


def post(url, body, retry_errors=True):
    out = None
    for attempt in range(6):
        time.sleep(2 + attempt * 4)  # the public RPC is rate limited
        request = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                out = json.load(response)
        except Exception as error:
            out = {"error": {"message": repr(error)}}
            continue
        if "result" in out or not retry_errors:
            return out
    return out


def cases_for(with_ledger, without_ledger, token):
    def caps(inputs, outputs):
        fit, doc = fitted_cost(inputs, outputs), 2000 + 65 * (inputs + outputs)
        return sorted({fit // 2, fit - 1, fit, fit + 1, doc - 1, doc, 20_000, 50_000})

    lending, margin = "0x" + "0" * 36 + "0811", "0x" + "0" * 36 + "080f"
    return {
        "lending:ledger": (lending, "0x" + word(with_ledger) + word(token), 128, caps(64, 128)),
        "lending:noLedger": (lending, "0x" + word(without_ledger) + word(token), 128, [7_336, 14_480, 20_000, 50_000, 200_000]),
        "accountMarginSummary:dex0": (margin, "0x" + word(0) + word(with_ledger), 128, caps(64, 128)),
        # The source's control read: a margin summary must answer even for an account Core does not know.
        "accountMarginSummary:unknownAccount": (margin, "0x" + word(0) + word(UNKNOWN_ACCOUNT), 128, caps(64, 128)),
        "coreUserExists:unknownAccount": ("0x" + "0" * 36 + "0810", "0x" + word(UNKNOWN_ACCOUNT), 32, caps(32, 32)),
        "spotBalance": ("0x" + "0" * 36 + "0801", "0x" + word(with_ledger) + word(token), 96, caps(64, 96)),
        "l1BlockNumber": ("0x" + "0" * 36 + "0809", "0x", 32, caps(0, 32)),
        "borrowLendReserveState": ("0x" + "0" * 36 + "0812", "0x" + word(token), 256, caps(32, 256)),
    }


def capture(network, with_ledger, without_ledger, token, artifact=ARTIFACT):
    stem = "hyperliquid" if network == "mainnet" else "hyperliquid-testnet"
    url = f"https://rpc.{stem}.xyz/evm"
    code = json.loads(Path(artifact).read_text())["bytecode"]["object"]
    header = post(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": ["latest", False]})
    if "result" not in header:
        raise RuntimeError(f"block header unavailable: {header}")
    header = header["result"]
    tag = header["number"]
    report = {"schema": 1, "observedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "network": network,
              "rpc": url, "evmBlock": tag, "evmBlockHash": header["hash"], "blockGasLimit": int(header["gasLimit"], 16),
              "scope": "read-only eth_call of creation code; nothing was signed, sent or deployed",
              "documentedFormula": DOCUMENTED, "accounts": {"withLedger": with_ledger, "withoutLedger": without_ledger},
              "token": token, "cases": {}}
    for name, (target, data, output_bytes, caps) in cases_for(with_ledger, without_ledger, token).items():
        response = post(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                              "params": [{"data": code + encode_arguments(target, data, caps), "gas": hex(CALL_GAS)}, tag]},
                        retry_errors=False)
        input_bytes = (len(data) - 2) // 2
        entry = {"to": target, "data": data, "inputBytes": input_bytes, "outputBytes": output_bytes,
                 "documentedCost": 2000 + 65 * (input_bytes + output_bytes)}
        if "result" not in response:
            entry["error"] = response.get("error")  # kept as a failure, never as a zero measurement
        else:
            succeeded, used, sizes = decode_result(response["result"], len(caps))
            entry["rows"] = [{"gasCap": cap, "ok": ok, "gasUsedByCaller": gas, "returnBytes": size}
                             for cap, ok, gas, size in zip(caps, succeeded, used, sizes)]
            entry["minimalCap"] = minimal_cap(entry["rows"])
        if name == "coreUserExists:unknownAccount":
            answer = post(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call",
                                "params": [{"to": target, "data": data}, tag]}, retry_errors=False)
            entry["answer"] = answer.get("result", answer.get("error"))
        report["cases"][name] = entry
    end = post(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getBlockByNumber", "params": [tag, False]})
    report["blockHashStable"] = end.get("result", {}).get("hash") == header["hash"]
    report["allMeasured"] = all("rows" in entry for entry in report["cases"].values())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=["mainnet", "testnet"], required=True)
    parser.add_argument("--with-ledger", required=True, help="public account that has a lending ledger for --token")
    parser.add_argument("--without-ledger", required=True, help="public account that has no such ledger")
    parser.add_argument("--token", type=int, default=0)
    parser.add_argument("--output", type=Path, required=True, help="new file; never overwrite prior evidence")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output exists; choose a new file name")
    report = capture(args.network, args.with_ledger, args.without_ledger, args.token)
    args.output.write_text(json.dumps(report, indent=1) + "\n")
    for name, entry in report["cases"].items():
        print(name, "documented", entry["documentedCost"], "minimal cap", entry.get("minimalCap"), entry.get("error", ""))
    if not report["blockHashStable"] or not report["allMeasured"]:
        parser.exit(2, "unstable block or failed measurement; raw evidence saved\n")


if __name__ == "__main__":
    main()
