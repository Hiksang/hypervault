#!/usr/bin/env python3
"""Read-only USDC Carry monitor for any Core account, rules chosen by its abstraction (carry_rules).

Never signs, never records prices, never pushes to the public FE file. Each instance writes its own
output and log, so it can run beside monitor.py's keeper loop:

  # operated vault (Unified today)
  python3 mode_monitor.py --account 0xf9c0…6b4F --label "v4 vault" --name unified-v4 --loop --interval 180
  # someone else's Portfolio Margin account: an observation, not our position
  python3 mode_monitor.py --account 0x760a…0266 --label "third-party PM carry" --name pm-observed \
      --observe --loop --interval 240
"""
from __future__ import annotations

import argparse
import fcntl
import json
import sys
import time
import traceback
from decimal import Decimal as D

import carry_rules
from hvlib import STATE_DIR, save_json, utc_now


def run_once(args) -> dict:
    rules, errors, facts = carry_rules.rules(args.account, D(args.target_q) if args.target_q else None)
    now = utc_now()
    out = {
        "schema": "hypervault.carryMonitor.v1",
        "generatedAt": now,
        "account": args.account,
        "label": args.label,
        "observation": ("third-party account, read-only observation: not a HyperVault position" if args.observe
                        else "operated account (read-only monitor; no keeper)"),
        "mode": facts.get("abstraction"),
        "targetQ": args.target_q,
        "rules": rules,
        "errors": errors,
        "facts": facts,
        "source": "HyperCore info API (not block-pinned)",
    }
    save_json(STATE_DIR / f"monitor-{args.name}.json", out)
    with (STATE_DIR / f"monitor-{args.name}.jsonl").open("a") as f:
        f.write(json.dumps({"at": now, "mode": out["mode"], "statuses": {r["id"]: r["status"] for r in rules},
                            "errors": errors}) + "\n")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--account", required=True)
    ap.add_argument("--label", required=True)
    ap.add_argument("--name", required=True, help="output: .omc/hypervault/monitor-<name>.json(l)")
    ap.add_argument("--observe", action="store_true", help="third-party account (labelled as an observation)")
    ap.add_argument("--target-q", default=None)
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--interval", type=int, default=180)
    args = ap.parse_args()
    if args.interval < 120:
        sys.exit("interval must be >= 120 s (API rate limits)")
    lock = open(STATE_DIR / f"monitor-{args.name}.lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(f"another '{args.name}' monitor holds the lock")
    while True:
        try:
            out = run_once(args)
            print(json.dumps({"at": out["generatedAt"], "mode": out["mode"],
                              "statuses": {r["id"]: r["status"] for r in out["rules"]}, "errors": len(out["errors"])}),
                  flush=True)
        except Exception:
            traceback.print_exc()
        if not args.loop:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
