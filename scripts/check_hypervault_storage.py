#!/usr/bin/env python3
"""HyperVault (v6, ADR-041) keeps all mutable state in one struct `$` after the reentrancy flag.

Checks a candidate `forge inspect HyperVault storage-layout --json` against the baseline fixture:
- the top level is exactly [_status, $]: a variable declared after `$` would take the slot a
  later `Layout` member needs;
- `Layout` members keep their slot, offset, label and type, in order; new members only at the end.
Usage: check_hypervault_storage.py BASELINE.json CANDIDATE.json
"""
import json
import sys

from check_managed_storage import shape


def members(layout):
    top = [x["label"] for x in layout["storage"]]
    if top != ["_status", "$"]:
        raise ValueError(f"top-level state must be exactly ['_status', '$'], found {top}")
    struct = layout["types"][layout["storage"][1]["type"]]
    return [{"label": m["label"], "slot": m["slot"], "offset": m["offset"], "type": shape(m["type"], layout["types"])}
            for m in struct["members"]]


if __name__ == "__main__":
    with open(sys.argv[1]) as f:
        old = members(json.load(f))
    with open(sys.argv[2]) as f:
        new = members(json.load(f))
    if new[:len(old)] != old:
        raise SystemExit("HyperVault Layout changed: existing members must keep slot, offset, label and type")
    print(f"HyperVault storage ok: {len(old)} members kept, {len(new) - len(old)} appended")
