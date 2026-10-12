#!/usr/bin/env python3
"""Compare compiler layouts recursively; existing slots/types must be preserved.

This mechanical check is necessary, not a semantic audit of an upgrade.
Usage: check_managed_storage.py BASELINE.json CANDIDATE.json
Both files are unmodified JSON outputs of forge inspect ... storage-layout --json.
"""
import json
import sys


def shape(type_id, types):
    item = types[type_id]
    result = {key: item[key] for key in ("encoding", "numberOfBytes")}
    for key in ("key", "value", "base"):
        if key in item:
            result[key] = shape(item[key], types)
    if "members" in item:
        result["members"] = [field(member, types) for member in item["members"]]
    else:
        # Distinguish uint/address/bool and semantic type names as well as byte widths.
        result["label"] = item["label"]
    return result


def field(item, types):
    return {"label": item["label"], "slot": item["slot"], "offset": item["offset"], "type": shape(item["type"], types)}


def check(before, after):
    old = [field(x, before["types"]) for x in before["storage"]]
    new = [field(x, after["types"]) for x in after["storage"]]
    if new[:len(old)] != old:
        raise ValueError("existing storage prefix changed (slot, offset, label or recursive type)")
    return len(old)


if __name__ == "__main__":
    with open(sys.argv[1]) as source: before = json.load(source)
    with open(sys.argv[2]) as source: after = json.load(source)
    print(f"Preserved {check(before, after)} existing storage fields; review new code and migrations separately.")
