#!/usr/bin/env python3
"""HyperVault controlled mainnet round trip for ONE USDC Vault, one step per invocation.

Every write step: snapshot (EVM + Core) -> one signed transaction -> snapshot, appended to the
evidence ledger (.omc/hypervault/ledger.jsonl). `evidence` compiles the ledger into the FE's
evidence.json. Nothing is sent without `--execute`; without it the step is simulated by eth_call
where possible. Core actions are asynchronous: an EVM receipt is recorded as "submitted", and the
Core effect is recorded only when a later observation shows it.

Funds: owner/demo-user/agent keys in ~/.config/hypervault. This tool never prints a key.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time

import core
from hvlib import (
    CHAIN_ID,
    CIRCLE,
    ROOT,
    rpc_url,
    SPOT_DEX,
    STATE_DIR,
    AGENT,
    USDC,
    addr,
    artifact_bytecode,
    block_number,
    call,
    create,
    encode_args,
    erc20_balance,
    key,
    load_json,
    native_balance,
    save_json,
    send,
    simulate_create,
    utc_now,
)

# HV_VERSION=v2 selects the HyperVault v2 deployment (share token + accountant, HWM fee);
# default v1 is the ManagedAssetVault used for runs 1-3.
# v3 = the v2 contracts with owner-trusted NAV modules (no reports, no drawdown wait; ADR-038).
# v4 = v3 plus instant redemption from the EVM buffer (redeemNow, ADR-039); same modules and flow.
# v5 = v4 with hedged spot and the short valued at the HYPE perp oracle (ADR-040): redeemNow needs
#      no price record. The source's Token tuple gains (perpOracle, perp).
VERSION = os.environ.get("HV_VERSION", "v1")
V2 = VERSION in ("v2", "v3", "v4", "v5", "v6")  # share token + accountant layout
V3 = VERSION in ("v3", "v4", "v5", "v6")
# v6 = v5 split into modules (ADR-041): HyperVaultCoreOps (linked external library) and
#      HyperVaultLens (read-only views). Same oracle scope, cap and Vault ABI as v5.
V5 = VERSION in ("v5", "v6")
V6 = VERSION == "v6"
DEPLOY = STATE_DIR / ("deployment.json" if VERSION == "v1" else f"deployment-{VERSION}.json")
RUN = os.environ.get("HV_RUN", f"{VERSION}-run1" if V2 else "run2")
LEDGER = STATE_DIR / f"ledger-{RUN}.jsonl"
PHASES = ["Uninitialized", "AwaitingActivation", "Ready", "Idle", "Active", "Exiting"]
KINDS = ["None", "Deposit", "Recall", "Agent", "RevokeAgent", "Control"]
ABSTRACTION = {"disabled": 1, "unified": 2, "pm": 3}

# Verifier bounds chosen for the controlled demo (constructor-checked; see docs/hypervault).
VERIFIER_PARAMS = {
    "recallTimeoutBlocks": 10_000,
    "idleDustUsdc6": 2_000_000,
    "priceWindowSeconds": 600,
    "maxDrawdownBps": 300,
}
# v5: cap raised to 100,000 USDC at the user's request (2026-10-12); at that size the Core account
# can reach Portfolio Margin (> $10k). v1-v4 keep their deployed 1,000 USDC cap (immutable).
VAULT_PARAMS = {
    "performanceFeeBps": 1000,
    "minimumDeposit": 10_000_000,
    "maximumAssets": 100_000_000_000 if V5 else 1_000_000_000,  # USDC6 hard cap on NAV
    "builder": "0x0000000000000000000000000000000000000000",
    "builderFeeCap": 0,
}


def dep() -> dict:
    d = load_json(DEPLOY, {})
    return d


def first(x):
    v = x[0] if isinstance(x, list) else x
    return v.split()[0] if isinstance(v, str) else str(v) if isinstance(v, (int, bool)) and not isinstance(v, bool) else v


def vault_state(v: str) -> dict:
    s: dict = {}
    reads = {
        "phase": "phase()(uint8)",
        "availableCash": "availableCash()(uint256)",
        "accountedCash": "accountedCash()(uint256)",
        "reservedClaimAssets": "reservedClaimAssets()(uint256)",
        "totalSupply": "totalSupply()(uint256)",
        "actionNonce": "actionNonce()(uint256)",
        "activeEpochId": "activeEpochId()(uint256)",
        "nextEpochId": "nextEpochId()(uint256)",
        "managedPrincipal": "managedPrincipal()(uint256)",
        "apiWallet": "apiWallet()(address)",
        "coreActivated": "coreActivated()(bool)",
        "queuedAllocation": "queuedAllocation()(uint256)",
        "lastConfirmedCoreBlock": "lastConfirmedCoreBlock()(uint64)",
    }
    for k, sig in reads.items():
        try:
            s[k] = first(call(v, sig))
        except Exception as exc:
            s[k] = f"ERROR: {str(exc)[:160]}"
    if isinstance(s.get("phase"), str) and s["phase"].isdigit():
        s["phaseName"] = PHASES[int(s["phase"])]
    try:
        p = call(v, "pendingAction()(uint256,bytes32,uint64,uint8,uint256,address)")
        s["pendingAction"] = {
            "id": first(p[0]),
            "submittedCoreBlock": first(p[2]),
            "kind": KINDS[int(first(p[3]))],
            "assets": first(p[4]),
            "agent": p[5],
        }
    except Exception as exc:
        s["pendingAction"] = f"ERROR: {str(exc)[:160]}"
    try:
        s["evmUsdc"] = erc20_balance(USDC, v)
    except Exception as exc:
        s["evmUsdc"] = f"ERROR: {exc}"
    d = dep()
    if d.get("accountant"):
        try:
            m = call(d["accountant"], "marks(address)(uint256,uint256,uint256)", v)
            s["accountant"] = {"highWaterMark": first(m[0]), "rate": first(m[1]), "updatedAt": first(m[2])}
        except Exception as exc:
            s["accountant"] = f"ERROR: {str(exc)[:160]}"
    if d.get("verifier"):
        for k, sig in (("totalAssets", "totalAssets()(uint256)"),):
            try:
                s[k] = first(call(v, sig))
            except Exception as exc:
                s[k] = f"BLOCKED: {str(exc)[:200]}"
        try:
            n = call(d["verifier"], "nav(address)(uint256,uint64)", v)
            s["verifierNav"] = {"assets": first(n[0]), "coreBlock": first(n[1])}
        except Exception as exc:
            s["verifierNav"] = f"BLOCKED: {str(exc)[:200]}"
    return s


def share_token() -> str | None:
    d = dep()
    return d.get("share") or d.get("vault")


def holder_state(v: str | None) -> dict:
    out = {}
    tok = share_token()
    for who in ("owner", "demo-user"):
        a = addr(who)
        h = {"address": a}
        try:
            h["evmUsdc"] = erc20_balance(USDC, a)
            h["evmHypeWei"] = native_balance(a)
            if v:
                h["shares"] = first(call(tok, "balanceOf(address)(uint256)", a))
                h["requestId"] = first(call(v, "controllerRequest(address)(uint256)", a))
                if not V2:
                    h["basis"] = first(call(v, "basisUsdc(address)(uint256)", a))
        except Exception as exc:
            h["error"] = str(exc)[:200]
        out[who] = h
    return out


def snapshot() -> dict:
    d = dep()
    v = d.get("vault")
    snap = {"observedAt": utc_now(), "evmBlock": block_number(), "holders": holder_state(v)}
    if v:
        snap["vault"] = vault_state(v)
        snap["core"] = core.snapshot(v)
        try:
            snap["coreBlock"] = first(call(v, "lastConfirmedCoreBlock()(uint64)"))
        except Exception:
            pass
    return snap


def record(step: str, title: str, status: str, layer: str, tx: dict | None, before, after, note: str = "", **extra):
    row = {
        "id": step,
        "title": title,
        "status": status,
        "layer": layer,
        "recordedAt": utc_now(),
        "note": note,
        "before": before,
        "after": after,
        **extra,
    }
    if tx:
        row.update({"txHash": tx["txHash"], "evmBlock": tx["evmBlock"], "gasUsed": tx["gasUsed"]})
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a") as f:
        f.write(json.dumps(row) + "\n")
    print(json.dumps({k: row[k] for k in ("id", "status") if k in row} | ({"tx": row.get("txHash")}), indent=None))


def vault_tx(args, step, title, who, sig, *params, layer="evm", note="", status=None):
    d = dep()
    v = d["vault"]
    before = snapshot()
    if not args.execute:
        out = subprocess.run(
            ["cast", "call", v, sig, *[str(p) for p in params], "--from", addr(who), "--rpc-url", rpc_url()],
            capture_output=True,
            text=True,
        )
        print(json.dumps({"simulate": step, "ok": out.returncode == 0, "out": (out.stdout or out.stderr)[-400:]}))
        return None
    tx = send(who, v, sig, *params)
    time.sleep(3)
    after = snapshot()
    record(step, title, status or ("done" if layer == "evm" else "pending"), layer, tx, before, after, note)
    return tx


# ---------------------------------------------------------------- steps


def cmd_snapshot(args):
    print(json.dumps(snapshot(), indent=2))


def cmd_deploy_modules(args):
    d = dep()
    if d.get("verifier"):
        sys.exit("modules already deployed: " + json.dumps(d))
    owner = addr("owner")
    src = artifact_bytecode("HyperCorePrecompileSource.sol", "HyperCorePrecompileSource") + encode_args(
        "c(address,address,uint32)", USDC, CIRCLE, 0
    )[2:]
    br = artifact_bytecode("ManagedAssetBridge.sol", "ManagedAssetBridge") + encode_args(
        "c(address,address,address,uint8,uint32,uint32)", USDC, USDC, CIRCLE, 0, 0, 0
    )[2:]
    sim = {"source": simulate_create("owner", src), "bridge": simulate_create("owner", br)}
    print(json.dumps({"preflight": sim}))
    if not args.execute:
        return
    before = snapshot()
    s = create("owner", src, gas_limit=int(sim["source"]["estimatedGas"] * 1.3))
    b = create("owner", br, gas_limit=int(sim["bridge"]["estimatedGas"] * 1.3))
    p = VERIFIER_PARAMS
    ver = artifact_bytecode("ManagedAssetNavVerifier.sol", "ManagedAssetNavVerifier") + encode_args(
        "c(address,address,uint64,uint256,uint256,uint256)",
        b["contractAddress"],
        s["contractAddress"],
        p["recallTimeoutBlocks"],
        p["idleDustUsdc6"],
        p["priceWindowSeconds"],
        p["maxDrawdownBps"],
    )[2:]
    vs = simulate_create("owner", ver)
    w = create("owner", ver, gas_limit=int(vs["estimatedGas"] * 1.3))
    d.update(
        {
            "chainId": CHAIN_ID,
            "deployer": owner,
            "owner": owner,
            "source": s["contractAddress"],
            "bridge": b["contractAddress"],
            "verifier": w["contractAddress"],
            "verifierParams": p,
            "moduleTxs": {"source": s["txHash"], "bridge": b["txHash"], "verifier": w["txHash"]},
        }
    )
    save_json(DEPLOY, d)
    record("deploy-modules", "Deploy precompile source, USDC bridge, NAV verifier", "done", "evm", w, before,
           snapshot(), json.dumps(d["moduleTxs"]))


def codehash(a: str) -> str:
    from hvlib import rpc

    code = rpc("eth_getCode", [a, "latest"])
    out = subprocess.run(["cast", "keccak", code], capture_output=True, text=True, check=True)
    return out.stdout.strip()


def cmd_deploy_vault(args):
    if V2:
        return _deploy_v2(args)
    d = dep()
    if d.get("vault"):
        sys.exit("vault already deployed")
    env = dict(os.environ)
    env.update(
        {
            "DIRECT_DEPLOYER": d["deployer"],
            "DIRECT_OWNER": d["owner"],
            "DIRECT_BRIDGE": d["bridge"],
            "DIRECT_VERIFIER": d["verifier"],
            "DIRECT_BRIDGE_CODEHASH": codehash(d["bridge"]),
            "DIRECT_VERIFIER_CODEHASH": codehash(d["verifier"]),
            "DIRECT_TOKEN_CODEHASH": codehash(USDC),
            "MANAGED_TREASURY": d["owner"],
            "MANAGED_BUILDER": VAULT_PARAMS["builder"],
            "MANAGED_BUILDER_FEE_CAP": str(VAULT_PARAMS["builderFeeCap"]),
            "DIRECT_PERFORMANCE_FEE_BPS": str(VAULT_PARAMS["performanceFeeBps"]),
            "DIRECT_MINIMUM_DEPOSIT": str(VAULT_PARAMS["minimumDeposit"]),
            "DIRECT_MAXIMUM_ASSETS": str(VAULT_PARAMS["maximumAssets"]),
        }
    )
    cmd = ["forge", "script", "script/DeployManagedAssetVault.s.sol", "--rpc-url", rpc_url(), "--sender", d["deployer"],
           "--offline", "--json"]
    if args.execute:
        cmd += ["--broadcast", "--slow", "--private-key", key("owner")]
    before = snapshot() if args.execute else None
    res = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    text = (res.stdout + res.stderr).replace(key("owner"), "<redacted>")
    print(text[-3000:])
    if res.returncode != 0:
        sys.exit("forge script failed")
    if not args.execute:
        return
    run = load_json(ROOT / "broadcast" / "DeployManagedAssetVault.s.sol" / str(CHAIN_ID) / "run-latest.json")
    created = [t for t in run["transactions"] if t.get("contractAddress")]
    names = [t.get("contractName") for t in created]
    controller = next(t["contractAddress"] for t in created if t.get("contractName") == "ManagedUpgradeController")
    impl = first(call(controller, "implementation()(address)"))
    d.update(
        {
            "controller": controller,
            "vault": first(call(controller, "vault()(address)")),
            "implementation": impl,
            "deployTxs": [t["hash"] for t in run["transactions"]],
            "createdNames": names,
        }
    )
    save_json(DEPLOY, d)
    receipts = run.get("receipts", [])
    last = receipts[-1] if receipts else None
    tx = {"txHash": last["transactionHash"], "evmBlock": int(last["blockNumber"], 16), "gasUsed": int(last["gasUsed"], 16)} if last else None
    record("deploy-vault", "Deploy upgrade controller, Vault implementation, proxy; bind", "done", "evm", tx,
           before, snapshot(), json.dumps(d["deployTxs"]))


def _deploy_v2(args):
    """HyperVault v2 over the v1 modules (source, bridge, verifier are reused)."""
    d = dep()
    if d.get("vault"):
        sys.exit("v2 vault already deployed")
    if not V3 and not d.get("verifier"):
        v1 = load_json(STATE_DIR / "deployment.json", {})
        d = {k: v1[k] for k in ("chainId", "deployer", "owner", "source", "bridge", "verifier", "verifierParams", "moduleTxs")}
        d["modulesFrom"] = "v1 deployment (reused, unchanged)"
    if V3 and not d.get("bridge"):
        v1 = load_json(STATE_DIR / "deployment.json", {})
        d = {k: v1[k] for k in ("chainId", "deployer", "owner", "bridge")}
        d["verifierParams"] = {k: v for k, v in VERIFIER_PARAMS.items() if k != "maxDrawdownBps"}
        d["modulesFrom"] = "bridge reused from v1; source and verifier deployed with the vault"
    env = dict(os.environ)
    env.update(
        {
            "DIRECT_DEPLOYER": d["deployer"],
            "DIRECT_OWNER": d["owner"],
            "DIRECT_BRIDGE": d["bridge"],
            "DIRECT_BRIDGE_CODEHASH": codehash(d["bridge"]),
            "DIRECT_TOKEN_CODEHASH": codehash(USDC),
            "MANAGED_TREASURY": d["owner"],
            "MANAGED_BUILDER": VAULT_PARAMS["builder"],
            "MANAGED_BUILDER_FEE_CAP": str(VAULT_PARAMS["builderFeeCap"]),
            "DIRECT_PERFORMANCE_FEE_BPS": str(VAULT_PARAMS["performanceFeeBps"]),
            "DIRECT_MINIMUM_DEPOSIT": str(VAULT_PARAMS["minimumDeposit"]),
            "DIRECT_MAXIMUM_ASSETS": str(VAULT_PARAMS["maximumAssets"]),
            "HV_RECALL_TIMEOUT": str(VERIFIER_PARAMS["recallTimeoutBlocks"]),
            "HV_IDLE_DUST": str(VERIFIER_PARAMS["idleDustUsdc6"]),
            "HV_PRICE_WINDOW": str(VERIFIER_PARAMS["priceWindowSeconds"]),
            "HV_SHARE_NAME": "HyperVault USDC",
            "HV_SHARE_SYMBOL": "hvUSDC",
        }
    )
    cmd = ["forge", "script", "script/DeployHyperVault.s.sol", "--rpc-url", rpc_url(), "--sender", d["deployer"], "--json"]
    core_ops = None
    if V6:
        # ADR-041: the implementation links the external library HyperVaultCoreOps. Deploy it first,
        # then compile the script against it. A dry run links the owner's next CREATE address, which
        # the simulation then gives to the script's first contract: the link is only meaningful
        # in a real run, where the library takes that nonce.
        core_ops = _deploy_core_ops(args, d)
        cmd += ["--libraries", f"{CORE_OPS_LINK}:{core_ops['address']}"]
    if args.execute:
        cmd += ["--broadcast", "--slow", "--private-key", key("owner")]
    res = subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True)
    text = (res.stdout + res.stderr).replace(key("owner"), "<redacted>")
    print(text[-3000:])
    if res.returncode != 0:
        sys.exit("forge script failed")
    if not args.execute:
        return
    run = load_json(ROOT / "broadcast" / "DeployHyperVault.s.sol" / str(CHAIN_ID) / "run-latest.json")
    created = {t.get("contractName"): t["contractAddress"] for t in run["transactions"] if t.get("contractAddress")}
    controller = created["ManagedUpgradeController"]
    d.update(
        {
            "version": VERSION,
            "share": created["HyperVaultShare"],
            "accountant": created["HyperVaultAccountant"],
            "controller": controller,
            "vault": first(call(controller, "vault()(address)")),
            "implementation": first(call(controller, "implementation()(address)")),
            "deployTxs": ([core_ops["txHash"]] if core_ops and core_ops.get("txHash") else [])
            + [t["hash"] for t in run["transactions"]],
            "vaultParams": VAULT_PARAMS,
        }
    )
    d["verifier"] = first(call(d["vault"], "verifier()(address)"))
    d["source"] = first(call(d["verifier"], "source()(address)"))
    if V6:
        d["coreOps"] = core_ops["address"]
        d["coreOpsTx"] = core_ops["txHash"]
        d["lens"] = created["HyperVaultLens"]
    save_json(DEPLOY, d)
    receipts = run.get("receipts", [])
    last = receipts[-1] if receipts else None
    tx = {"txHash": last["transactionHash"], "evmBlock": int(last["blockNumber"], 16), "gasUsed": int(last["gasUsed"], 16)} if last else None
    record("deploy-vault", "Deploy share token, accountant, upgrade controller, HyperVault implementation, proxy; bind",
           "done", "evm", tx, None, snapshot(), json.dumps(d["deployTxs"]))


CORE_OPS_LINK = "src/hypervault/HyperVaultCoreOps.sol:HyperVaultCoreOps"


def _deploy_core_ops(args, d) -> dict:
    """Create HyperVaultCoreOps from the owner key (v6). Dry run: simulate it and return the address
    the owner's next CREATE would get, so the script links against the address it would really use
    (in a dry run that address then goes to the script's first contract, the NAV source: harmless,
    the script never calls the library). A library recorded by an earlier, failed run is reused
    when its code still matches the fresh build."""
    if addr("owner").lower() != d["deployer"].lower():
        sys.exit("deployer must be the owner key: the link predicts the owner's next CREATE address")
    # Build first: forge script recompiles the Vault, so the library must come from the same sources.
    build = subprocess.run(["forge", "build"], cwd=ROOT, capture_output=True, text=True)
    if build.returncode != 0:
        sys.exit("forge build failed:\n" + (build.stdout + build.stderr)[-2000:])
    fresh = subprocess.run(["forge", "inspect", "HyperVaultCoreOps", "bytecode"], cwd=ROOT,
                           capture_output=True, text=True, check=True).stdout.strip()
    code = artifact_bytecode("HyperVaultCoreOps.sol", "HyperVaultCoreOps")
    if code.lower() != fresh.lower():
        sys.exit("HyperVaultCoreOps artifact is stale against the sources")
    if d.get("coreOps") and _code_matches_artifact(d["coreOps"], "HyperVaultCoreOps.sol", "HyperVaultCoreOps"):
        print(json.dumps({"coreOpsReused": d["coreOps"]}))
        return {"address": d["coreOps"], "txHash": d.get("coreOpsTx")}
    sim = simulate_create("owner", code)
    print(json.dumps({"coreOpsPreflight": sim}))
    if not args.execute:
        from hvlib import rpc

        nonce = int(rpc("eth_getTransactionCount", [d["deployer"], "pending"]), 16)
        out = subprocess.run(["cast", "compute-address", d["deployer"], "--nonce", str(nonce)],
                             capture_output=True, text=True, check=True).stdout
        return {"address": out.strip().split()[-1], "txHash": None}
    tx = create("owner", code, gas_limit=int(sim["estimatedGas"] * 1.3))
    # Recorded at once: a later failure of the script must not orphan it (a rerun reuses it).
    d.update({"coreOps": tx["contractAddress"], "coreOpsTx": tx["txHash"]})
    save_json(DEPLOY, d)
    record("deploy-core-ops", "Deploy HyperVaultCoreOps (external library the implementation links)", "done", "evm",
           tx, None, None)
    return {"address": tx["contractAddress"], "txHash": tx["txHash"]}


def linked_core_ops(implementation: str) -> str:
    """The HyperVaultCoreOps address linked into a deployed implementation. The link offsets are
    the placeholders of the unlinked runtime code (`forge inspect`, project settings: `out/` may
    hold a linked build after a deploy); every occurrence must hold the same address."""
    from hvlib import rpc

    unlinked = subprocess.run(["forge", "inspect", "HyperVault", "deployedBytecode"], cwd=ROOT,
                              capture_output=True, text=True, check=True).stdout.strip()[2:]
    starts = [i // 2 for i in range(0, len(unlinked), 2) if unlinked.startswith("__$", i)]
    if not starts:
        raise RuntimeError("HyperVault has no library placeholder: not a v6 build")
    code = bytes.fromhex(rpc("eth_getCode", [implementation, "latest"])[2:])
    if len(code) * 2 != len(unlinked):
        raise RuntimeError("implementation runtime size differs from the local build")
    found = {"0x" + code[i:i + 20].hex() for i in starts}
    if len(found) != 1:
        raise RuntimeError(f"implementation links {len(found)} different HyperVaultCoreOps addresses")
    return found.pop()


def cmd_verify(args):
    d = dep()
    v = d["vault"]
    checks = {}
    impl_from_controller = first(call(d["controller"], "implementation()(address)"))
    checks["controller.vault == vault"] = first(call(d["controller"], "vault()(address)")).lower() == v.lower()
    checks["controller.implementation == recorded"] = impl_from_controller.lower() == d["implementation"].lower()
    checks["vault.owner == owner"] = first(call(v, "owner()(address)")).lower() == d["owner"].lower()
    checks["vault.bridge == bridge"] = first(call(v, "bridge()(address)")).lower() == d["bridge"].lower()
    checks["vault.verifier == verifier"] = first(call(v, "verifier()(address)")).lower() == d["verifier"].lower()
    checks["vault.asset == USDC"] = first(call(v, "asset()(address)")).lower() == USDC.lower()
    checks["vault.upgradeController == controller"] = first(call(v, "upgradeController()(address)")).lower() == d["controller"].lower()
    checks["verifier.bridge == bridge"] = first(call(d["verifier"], "bridge()(address)")).lower() == d["bridge"].lower()
    checks["verifier.source == source"] = first(call(d["verifier"], "source()(address)")).lower() == d["source"].lower()
    checks["no upgrade pending"] = str(first(call(d["controller"], "pending()(bool)"))).lower() == "false"
    if V2:
        checks["vault.share == share"] = first(call(v, "share()(address)")).lower() == d["share"].lower()
        checks["share.vault == vault"] = first(call(d["share"], "vault()(address)")).lower() == v.lower()
        checks["vault.accountant == accountant"] = first(call(v, "accountant()(address)")).lower() == d["accountant"].lower()
        checks["accountant.history == verifier"] = first(call(d["accountant"], "history()(address)")).lower() == d["verifier"].lower()
        checks["share.totalSupply == 0 before bootstrap"] = int(first(call(d["share"], "totalSupply()(uint256)"))) == 0 or \
            first(call(v, "phase()(uint8)")) != "0"
    if V6:
        # Fresh unlinked artifacts: a dry run with --libraries may have left a linked build in out/.
        subprocess.run(["forge", "build", "--force"], cwd=ROOT, capture_output=True, text=True, check=True)
        checks["implementation links coreOps"] = linked_core_ops(d["implementation"]).lower() == d["coreOps"].lower()
        checks["coreOps code == local artifact"] = _code_matches_artifact(
            d["coreOps"], "HyperVaultCoreOps.sol", "HyperVaultCoreOps")
        checks["implementation code == local build"] = _code_matches_artifact(
            d["implementation"], "HyperVault.sol", "HyperVault")
        checks["lens code == local artifact"] = _code_matches_artifact(d["lens"], "HyperVaultLens.sol", "HyperVaultLens")
    d["implementationCodehash"] = codehash(d["implementation"])
    d["configHash"] = first(call(v, "configHash()(bytes32)"))
    d["codehashes"] = {k: codehash(d[k]) for k in ("source", "bridge", "verifier", "controller", "vault", "share",
                                                    "accountant", "coreOps", "lens") if d.get(k)}
    save_json(DEPLOY, d)
    ok = all(checks.values())
    print(json.dumps({"checks": checks, "ok": ok, "configHash": d["configHash"],
                      "implementationCodehash": d["implementationCodehash"]}, indent=2))
    record("verify-deployment", "Verify addresses, codehash, config hash and controller bind", "done" if ok else "failed",
           "evm", None, None, {"checks": checks, "codehashes": d["codehashes"], "configHash": d["configHash"]})


def _code_matches_artifact(addr_: str, path: str, name: str) -> bool:
    """Runtime code at `addr_` equals the local artifact's, with immutable slots masked on both
    sides (a library keeps its own address there for the call guard; it must be `addr_`)."""
    from hvlib import rpc

    import re

    art = json.loads((ROOT / "out" / path / f"{name}.json").read_text())
    # An unlinked artifact holds library placeholders: they are masked like immutables (the link
    # itself is checked by `linked_core_ops`).
    obj = re.sub(r"__\$[0-9a-fA-F]{34}\$__", "0" * 40, art["deployedBytecode"]["object"][2:])
    local = bytearray(bytes.fromhex(obj))
    live = bytearray(bytes.fromhex(rpc("eth_getCode", [addr_, "latest"])[2:]))
    if len(local) != len(live):
        return False
    for libs in art["deployedBytecode"].get("linkReferences", {}).values():
        for refs in libs.values():
            for r in refs:
                start, n = r["start"], r["length"]
                local[start:start + n] = live[start:start + n] = bytes(n)
    # The CBOR metadata trailer hashes the compiler settings, which include `--libraries` for a
    # linked deploy: it differs from a plain build while the executable code is the same.
    trailer = int.from_bytes(live[-2:], "big") + 2
    if trailer < len(live) and int.from_bytes(local[-2:], "big") + 2 == trailer:
        local[-trailer:] = live[-trailer:] = bytes(trailer)
    for refs in art["deployedBytecode"].get("immutableReferences", {}).values():
        for r in refs:
            start, n = r["start"], r["length"]
            if name == "HyperVaultCoreOps" and int.from_bytes(live[start:start + n], "big") != int(addr_, 16):
                return False
            local[start:start + n] = live[start:start + n] = bytes(n)
    return local == live


def cmd_bootstrap(args):
    d = dep()
    v = d["vault"]
    seed = int(args.seed)
    cost = 1_000_000
    name = args.name
    if not args.execute:
        print(json.dumps({"plan": {"approve": seed + cost, "bootstrap": [name, seed]}}))
        return
    before = snapshot()
    a = send("owner", USDC, "approve(address,uint256)", v, seed + cost)
    tx = send("owner", v, "bootstrap(uint256)", seed) if V2 else send("owner", v, "bootstrap(string,uint256)", name, seed)
    send("owner", USDC, "approve(address,uint256)", v, 0)
    time.sleep(3)
    record("bootstrap", "Owner bootstrap: seed principal, founder shares, Core activation request", "done", "both", tx,
           before, snapshot(), f"approve tx {a['txHash']}; activation is asynchronous (AwaitingActivation)")


def cmd_sync(args):
    d = dep()
    st = vault_state(d["vault"])
    pa = st["pendingAction"]
    if st.get("phaseName") == "AwaitingActivation":
        return vault_tx(args, args.step or "finalize-activation", "Confirm Core activation in a later Core block",
                        "owner", "finalizeActivation(bytes)", "0x", layer="both", status="done")
    if not isinstance(pa, dict) or int(pa["id"]) == 0:
        sys.exit("no pending action")
    return vault_tx(args, args.step or f"sync-{pa['kind'].lower()}-{pa['id']}",
                    f"Confirm pending {pa['kind']} action #{pa['id']} from a later Core block",
                    "owner", "syncCoreAction(uint256,bytes)", pa["id"], "0x", layer="both", status="done")


def cmd_scope(args):
    # USDC (always) and HYPE token 150 valued on HYPE/USDC pair 107 at the reserve price; perp DEX 0.
    # --usdc-only: the v2 run holds only USDC (gas-reserve HYPE stays outside the scope, ADR-035).
    tokens = "[(0,0,false,false)]" if args.usdc_only else "[(0,0,false,false),(150,107,false,true)]"
    if args.blp:  # count the lending ledgers: HYPE supplied as collateral, USDC borrowed (manual borrow)
        tokens = "[(0,0,true,false),(150,107,true,true)]"
    if V5:  # HYPE at the HYPE perp (159) oracle; the short on DEX 0 is revalued to the same price
        lend = "true" if args.blp else "false"
        tokens = f"[(0,0,{lend},false,false,0)]" if args.usdc_only else \
            f"[(0,0,{lend},false,false,0),(150,107,{lend},false,true,159)]"
    return _source_tx(args, dep(), tokens)


def _oracle_preflight():
    """v5: the perp that prices HYPE must be HYPE, and its oracle must sit near the spot mark."""
    from hvlib import info

    meta, ctx = info({"type": "metaAndAssetCtxs"})
    perp = meta["universe"][159]
    spot = info({"type": "spotMetaAndAssetCtxs"})
    pair = next(u for u in spot[0]["universe"] if u["index"] == 107)
    token = next(t for t in spot[0]["tokens"] if t["index"] == pair["tokens"][0])
    oracle, mid = float(ctx[159]["oraclePx"]), float(spot[1][107]["midPx"] or spot[1][107]["markPx"])
    ok = perp["name"] == token["name"] == "HYPE" and abs(oracle - mid) / mid < 0.02
    print(json.dumps({"oraclePreflight": {"perp159": perp["name"], "token": token["name"], "oracle": oracle,
                                          "spotMid": mid, "ok": ok}}))
    if not ok:
        sys.exit("perp-oracle preflight failed: perp/token mismatch or oracle far from spot")


def _source_tx(args, d, tokens):
    if V5 and "159" in tokens:
        _oracle_preflight()
    before = snapshot()
    sig = "configure(address,(uint32,uint32,bool,bool" + (",bool,uint32" if V5 else "") + ")[],uint32[],address[],bool)"
    params = [d["vault"], tokens, "[0]", "[]", "true"]
    if not args.execute:
        out = subprocess.run(["cast", "call", d["source"], sig, *params, "--from", d["owner"], "--rpc-url", rpc_url()],
                             capture_output=True, text=True)
        print(json.dumps({"simulate": "configure-scope", "ok": out.returncode == 0, "out": (out.stdout + out.stderr)[-400:]}))
        return
    tx = send("owner", d["source"], sig, *params)
    record(args.step if hasattr(args, "step") and args.step else "configure-scope", "Register valuation scope: " + ("USDC" if "150" not in tokens else "USDC, HYPE (pair 107, reserve price)") + (" with lending ledgers" if "true,false)" in tokens else "") + ", perp DEX 0", "done",
           "evm", tx, before, snapshot())


def cmd_record_price(args):
    d = dep()
    if not args.execute:
        out = subprocess.run(["cast", "call", d["verifier"], "recordPrice(address)(uint256)", d["vault"], "--from",
                              addr(args.who), "--rpc-url", rpc_url()], capture_output=True, text=True)
        print(json.dumps({"simulate": "record-price", "ok": out.returncode == 0, "out": (out.stdout + out.stderr)[-300:]}))
        return
    tx = send(args.who, d["verifier"], "recordPrice(address)", d["vault"])
    print(json.dumps({"recordPrice": tx["txHash"], "block": tx["evmBlock"]}))
    if args.ledger:
        record("record-price", "Record share price (anyone may call)", "done", "evm", tx, None, None)


def cmd_user_deposit(args):
    d = dep()
    v = d["vault"]
    who = args.who
    amt = int(args.amount)
    if not args.execute:
        print(json.dumps({"maxDeposit": first(call(v, "maxDeposit(address)(uint256)", addr(who))),
                          "previewDeposit": first(call(v, "previewDeposit(uint256)(uint256)", amt))}))
        return
    before = snapshot()
    send(who, USDC, "approve(address,uint256)", v, amt)
    preview = int(first(call(v, "previewDeposit(uint256)(uint256)", amt)))
    # Record the price the shares were issued at, from the same reads the Vault uses.
    priced = {"totalAssets": first(call(v, "totalAssets()(uint256)")), "totalSupply": first(call(v, "totalSupply()(uint256)")),
              "previewDeposit": str(preview), "phase": vault_state(v).get("phaseName")}
    deadline = int(time.time()) + 600
    tx = send(who, v, "depositWithLimit(uint256,address,uint256,uint256)", amt, addr(who), preview * 995 // 1000, deadline)
    record(args.step or f"deposit-{who}", f"{who} deposits {amt / 1e6} USDC ({priced['phase']}); shares minted at the verified price",
           "done", "evm", tx, before, snapshot(), json.dumps({"pricedAt": priced}))


def cmd_allocate(args):
    d = dep()
    if args.amount == "auto":
        plan = buffer_plan(d["vault"])
        print(json.dumps({"bufferPlan": plan}))
        if plan.get("allocatable", 0) <= 0:
            sys.exit("nothing to allocate above the target buffer")
        args.amount = str(plan["allocatable"])
    amt = int(args.amount)
    if args.execute:
        send("owner", d["vault"], "queueCoreAllocation(uint256)", amt)
    return vault_tx(args, "allocate-to-core", f"Owner executes queued Core allocation of {amt / 1e6} USDC", "owner",
                    "executeCoreAllocation()", layer="both", note="EVM->Core via Circle CoreDepositWallet.deposit")


def cmd_abstraction(args):
    return vault_tx(args, f"set-abstraction-{args.mode}", f"CoreWriter: set account abstraction = {args.mode}", "owner",
                    "setAbstraction(uint8)", ABSTRACTION[args.mode], layer="both",
                    note="Core may reject silently; confirm with userAbstraction API after the next Core block")


def cmd_set_agent(args):
    return vault_tx(args, "set-api-wallet", "CoreWriter: approve Vault API wallet (agent)", "owner",
                    "setApiWallet(address)", addr(AGENT), layer="both")


def cmd_revoke_agent(args):
    return vault_tx(args, "revoke-api-wallet", "CoreWriter: revoke Vault API wallet", "owner", "revokeApiWallet()",
                    layer="both")


def cmd_request_redeem(args):
    d = dep()
    who = args.who
    shares = args.shares or first(call(share_token(), "balanceOf(address)(uint256)", addr(who)))
    return vault_tx(args, f"request-redeem-{who}", f"{who} requests redeem of all shares ({shares})", who,
                    "requestRedeem(uint256,address,address)", shares, addr(who), addr(who))


def cmd_begin_exit(args):
    d = dep()
    epoch = first(call(d["vault"], "activeEpochId()(uint256)"))
    return vault_tx(args, "begin-exit", f"Owner seals epoch {epoch} and begins exit", "owner", "beginExit(uint256)", epoch)


def cmd_recall(args):
    amt = int(args.amount)
    return vault_tx(args, "recall-from-core", f"CoreWriter sendAsset: recall {amt / 1e6} USDC Core->EVM", "owner",
                    "recallFromCore(uint32,uint256)", SPOT_DEX if args.dex == "spot" else 0, amt, layer="both")


def cmd_settle(args):
    d = dep()
    epoch = first(call(d["vault"], "activeEpochId()(uint256)"))
    return vault_tx(args, "settle-epoch", f"Settle epoch {epoch} after flat-Core verification", "owner",
                    "settleEpoch(uint256,bytes)", epoch, "0x")


def cmd_claim(args):
    who = args.who
    d = dep()
    shares = first(call(d["vault"], "maxRedeem(address)(uint256)", addr(who)))
    return vault_tx(args, f"claim-{who}", f"{who} claims settled redeem ({shares} shares)", who,
                    "redeem(uint256,address,address)", shares, addr(who), addr(who))


def cmd_checkpoint(args):
    """v2: anyone charges the high-water-mark fee and refreshes the published rate at verified NAV."""
    return vault_tx(args, args.step or "checkpoint", "Checkpoint: crystallize HWM fee and refresh the rate (anyone)",
                    args.who, "checkpoint()")


def cmd_share_transfer(args):
    """v2: plain ERC-20 transfer of vault shares between holders (no cost basis moves)."""
    d = dep()
    before = snapshot()
    to = addr(args.to)
    if not args.execute:
        out = subprocess.run(["cast", "call", d["share"], "transfer(address,uint256)(bool)", to, args.shares, "--from",
                              addr(args.who), "--rpc-url", rpc_url()], capture_output=True, text=True)
        print(json.dumps({"simulate": "share-transfer", "ok": out.returncode == 0, "out": (out.stdout + out.stderr)[-300:]}))
        return
    tx = send(args.who, d["share"], "transfer(address,uint256)", to, args.shares)
    time.sleep(2)
    record(args.step or "share-transfer", f"{args.who} transfers {args.shares} hvUSDC shares to {args.to} (ERC-20)",
           "done", "evm", tx, before, snapshot())


def cmd_blp(args):
    """API wallet signs a manual borrow/lend L1 action for the Vault's Core account.

    Action shape taken from the official web app (BorrowLendPage): {"type": "borrowLend",
    "operation": supply|withdraw|borrow|repay, "token": <spot token index>, "amount": "<decimal>"|None};
    None means the whole balance (withdraw all / repay all). Not in the public API docs or SDK 0.24.
    """
    import json as _json

    from hyperliquid.utils.signing import get_timestamp_ms, sign_l1_action

    d = dep()
    v = d["vault"]
    action = {"type": "borrowLend", "operation": args.operation, "token": int(args.token),
              "amount": None if args.amount in (None, "max") else str(args.amount)}
    if not args.execute:
        print(_json.dumps({"plan": action, "signer": f"{AGENT} (API wallet of {v})"}))
        return
    before = snapshot()
    ex = _exchange(AGENT, v)
    nonce = get_timestamp_ms()
    sig = sign_l1_action(ex.wallet, action, None, nonce, ex.expires_after, True)
    resp = ex._post_action(action, sig, nonce)
    time.sleep(3)
    after = snapshot()
    try:
        state = core.info({"type": "borrowLendUserState", "user": v})
    except Exception as exc:  # recorded, never replaced by a default
        state = {"error": str(exc)[:200]}
    ok = isinstance(resp, dict) and resp.get("status") == "ok"
    record(args.step or f"blp-{args.operation}-{args.token}",
           f"API wallet borrowLend {args.operation} token {args.token} amount {action['amount'] or 'max'} on the Vault's Core account",
           "done" if ok else "failed", "core", None, before, after,
           _json.dumps({"action": action, "response": resp, "borrowLendUserState": state}, default=str)[:3000])
    print(_json.dumps({"response": resp, "borrowLendUserState": state}, default=str)[:1500])


def cmd_note(args):
    record(args.step, args.title, args.status, args.layer, None, None, snapshot() if args.snapshot else None, args.note)


RUN_TITLES = {
    "run1": "Run 1 — owner seed 11.78 USDC, HYPE spot buy/sell, NAV reconciliation, exit and claim",
    "run2": "Run 2 — separate depositor 25 USDC, spot + perp short hedge (Unified), NAV with an open short, exit and claim",
    "run3": "Run 3 — NAV-priced share issuance while Active, async redeem of the new depositor, instant redeem in Idle",
    "v3-run1": "v3 Run 1 — owner-trusted modules (no reports, no drawdown wait): deposit with no price history, Active deposit and redeem, fee checkpoint",
    "v3-run2": "v3 Run 2 — API wallet manual borrow (BLP): HYPE supplied as collateral, USDC borrowed, NAV reconciled, repaid and withdrawn",
    "v3-run3": "v3 Run 3 — HYPE spot + short hedge with an outside depositor; unwound, settled and retired for v4",
    "v6-run1": "v6 Run 1 — split Vault (Core management library, read-only Lens): oracle-valued hedge",
    "v5-run1": "v5 Run 1 — oracle-valued hedge (ADR-040): instant redemption without a price record",
    "v4-run1": "v4 Run 1 — instant redemption from the EVM buffer while Active (redeemNow, ADR-039), hedge open",
    "v2-run1": "v2 Run 1 — HyperVault v2 (share token + accountant): transferable shares, HWM fee checkpoint, Active deposit, async redeem by a share recipient",
}


def _steps(path) -> list:
    rows = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    steps = []
    for r in rows:
        s = {k: r[k] for k in ("id", "title", "status", "layer") if k in r}
        for k in ("txHash", "evmBlock", "note"):
            if r.get(k):
                s[k] = r[k]
        s["observedAt"] = r["recordedAt"]
        s["unit"] = "USDC raw 6 decimals; shares raw 9 decimals; Core amounts in token units"
        for side in ("before", "after"):
            snap = r.get(side)
            if isinstance(snap, dict):
                s[side] = _compact(snap)
            elif snap is not None:
                s[side] = snap
        after = r.get("after") if isinstance(r.get("after"), dict) else {}
        cb = (after.get("vault") or {}).get("lastConfirmedCoreBlock")
        if cb and str(cb).isdigit() and int(cb) > 0:
            s["coreBlock"] = int(cb)
        steps.append(s)
    return steps


def cmd_evidence(args):
    d = dep()
    runs = []
    for path in sorted(STATE_DIR.glob(f"ledger-{VERSION}-run*.jsonl" if V2 else "ledger-run*.jsonl")):
        rid = path.stem.removeprefix("ledger-")
        runs.append({"id": rid, "title": RUN_TITLES.get(rid, rid), "steps": _steps(path)})
    out = {
        "schema": "hypervault.evidence.v1",
        "contractVersion": VERSION,
        "network": "hyperliquid-mainnet",
        "chainId": CHAIN_ID,
        "generatedAt": utc_now(),
        "vault": {
            "name": f"HyperVault USDC {VERSION} (prototype)" if V2 else "HyperVault USDC (prototype)",
            "share": d.get("share"),
            "accountant": d.get("accountant"),
            "asset": "USDC",
            "address": d.get("vault"),
            "controller": d.get("controller"),
            "implementation": d.get("implementation"),
            "implementationCodehash": d.get("implementationCodehash"),
            "configHash": d.get("configHash"),
            "source": d.get("source"),
            "bridge": d.get("bridge"),
            "verifier": d.get("verifier"),
        },
        # v1 readers show the latest run; `runs` carries every run.
        "steps": runs[-1]["steps"] if runs else [],
        "runs": runs,
        "limitations": LIMITATIONS,
    }
    save_json(ROOT / "frontend" / "public" / "hypervault" / (f"evidence-{VERSION}.json" if V2 else "evidence.json"), out)
    print(f"wrote {len(runs)} runs, {sum(len(r['steps']) for r in runs)} steps")


LIMITATIONS = [
    "Single USDC Vault, owner's own small funds (prototype cap 1,000 USDC). HYPE/UBTC Vaults are not deployed.",
    "Portfolio Margin requires >$10k account value or >$5M weighted volume; this Vault is below that, so the hedge ran in Unified mode without USDC borrowing.",
    "Valuation scope completeness is owner-trusted; holdings outside the registered scope are invisible to NAV.",
    "Core actions are asynchronous; the verifier infers non-recall action success from a later Core block and cannot observe a Core-side rejection of agent/control actions.",
    "Withdrawals need owner cooperation (unwind, recall, revoke agent) before settlement.",
    "No independent security audit. Not a production launch.",
]


def _compact(snap: dict) -> dict:
    out = {"observedAt": snap.get("observedAt"), "evmBlock": snap.get("evmBlock")}
    v = snap.get("vault") or {}
    for k in ("phaseName", "availableCash", "accountedCash", "totalSupply", "evmUsdc", "managedPrincipal",
              "apiWallet", "pendingAction", "totalAssets", "verifierNav", "reservedClaimAssets", "accountant"):
        if k in v:
            out[f"vault.{k}"] = v[k]
    c = snap.get("core") or {}
    if "spot" in c:
        out["core.spot"] = {k: x["total"] for k, x in c["spot"].items()}
    if "perp" in c:
        out["core.perp.accountValue"] = c["perp"]["accountValue"]
        out["core.perp.positions"] = [{"coin": p["coin"], "szi": p["szi"], "entryPx": p["entryPx"]} for p in c["perp"]["positions"]]
    if "abstraction" in c:
        out["core.abstraction"] = c["abstraction"]
    if c.get("errors"):
        out["core.errors"] = c["errors"]
    for who, h in (snap.get("holders") or {}).items():
        for k in ("evmUsdc", "shares", "requestId"):
            if k in h:
                out[f"{who}.{k}"] = h[k]
    return out


# ---------------------------------------------------------------- buffer policy (operator-side, no contract change)
BUFFER_POLICY = {
    "minimumUsdc6": int(os.environ.get("HV_BUFFER_MIN", "1000000")),  # keep at least 1 USDC on EVM
    "navBps": int(os.environ.get("HV_BUFFER_BPS", "1000")),  # and at least 10% of NAV
}


def buffer_plan(v: str) -> dict:
    """How much free EVM cash to keep, and how much may go to Core. Read-only.

    target = max(minimum, NAV x bps, value of shares already requested for redeem in the open epoch).
    The Vault itself does not enforce this: it is the owner's allocation policy.
    """
    free = int(first(call(v, "availableCash()(uint256)")))
    supply = int(first(call(v, "totalSupply()(uint256)")))
    d = dep()
    try:
        nav = int(first(call(d["verifier"], "nav(address)(uint256,uint64)", v)))
    except Exception as exc:
        return {"freeCash": free, "error": f"NAV unreadable: {str(exc)[:120]}", "allocatable": 0}
    epoch = int(first(call(v, "activeEpochId()(uint256)")))
    # In Idle `activeEpochId` still names the last, settled epoch: only an open epoch's requests count.
    e = call(v, "epochs(uint256)(uint256,uint256,uint256,uint256,uint256,bool,bool)", epoch) if epoch else None
    requested = int(first(e[0])) if e and str(e[6]).lower() == "false" else 0
    pending_value = requested * nav // supply if supply else 0
    target = max(BUFFER_POLICY["minimumUsdc6"], nav * BUFFER_POLICY["navBps"] // 10_000, pending_value)
    return {"freeCash": free, "nav": nav, "pendingRedeemValue": pending_value, "targetBuffer": target,
            "allocatable": max(free - target, 0), "policy": BUFFER_POLICY}


def cmd_buffer(args):
    print(json.dumps(buffer_plan(dep()["vault"]), indent=2))


# ---------------------------------------------------------------- owner Core / agent helpers


def _exchange(who: str, account: str | None = None):
    from eth_account import Account
    from hyperliquid.exchange import Exchange
    from hyperliquid.utils import constants

    return Exchange(Account.from_key(key(who)), constants.MAINNET_API_URL, account_address=account,
                    spot_meta=core.sdk_spot_meta())


def cmd_bigblocks(args):
    """Owner's own HyperEVM block lane: big blocks (30M gas, ~1/min) for contract deployment."""
    on = args.state == "on"
    if not args.execute:
        print(json.dumps({"plan": f"evmUserModify usingBigBlocks={on} for {addr('owner')}"}))
        return
    res = _exchange("owner").use_big_blocks(on)
    print(json.dumps({"usingBigBlocks": on, "response": res}))
    if res.get("status") != "ok":
        sys.exit("rejected")


def cmd_fund_evm(args):
    """Owner's own Core spot USDC -> owner's HyperEVM address (Core->EVM system transfer). Not a Vault step."""
    amt = args.amount
    before = erc20_balance(USDC, addr("owner"))
    if not args.execute:
        print(json.dumps({"plan": f"sendAsset {amt} USDC spot -> 0x2000..0000 (owner EVM)", "evmUsdcBefore": before}))
        return
    res = _exchange("owner").send_asset("0x2000000000000000000000000000000000000000", "spot", "spot",
                                         "USDC:0x6d1e7cde53ba9467b783cb7c530ce054", float(amt))
    print(json.dumps({"response": res}))
    for _ in range(20):
        time.sleep(3)
        after = erc20_balance(USDC, addr("owner"))
        if after > before:
            print(json.dumps({"evmUsdcBefore": before, "evmUsdcAfter": after}))
            return
    sys.exit("EVM balance unchanged after 60s; check Core ledger before retrying")


def cmd_agent_order(args):
    """One IOC order signed by the Vault API wallet on the Vault's Core account; outcome classified."""
    import secrets
    from decimal import Decimal as Dm

    import strategy

    d = dep()
    v = d["vault"]
    spot = args.market.startswith("@")
    ctx = core.spot_ctx(args.market) if spot else core.perp_ctx(args.market)
    book = core.info({"type": "l2Book", "coin": args.market})["levels"]
    buy = args.side == "buy"
    touch = Dm(book[1][0]["px"] if buy else book[0][0]["px"])
    slip = Dm(args.slippage_bps) / 10_000
    px = strategy.round_px(touch * (1 + slip if buy else 1 - slip), ctx["szDecimals"], spot)
    size = Dm(args.size) if args.size else strategy.round_size(Dm(args.usd) / touch, ctx["szDecimals"])
    plan = {"market": args.market, "side": args.side, "size": str(size), "limitPx": str(px), "notional": str(size * touch)}
    if not args.execute:
        print(json.dumps({"plan": plan}))
        return
    before = snapshot()
    cloid = "0x" + secrets.token_hex(16)
    from hyperliquid.utils.types import Cloid

    ex = _exchange(AGENT, v)
    try:
        resp = ex.order(args.market, buy, float(size), float(px), {"limit": {"tif": "Ioc"}}, cloid=Cloid.from_str(cloid))
        out = strategy.classify(resp)
    except Exception as exc:
        out = {"state": "unknown", "error": str(exc)[:200]}
    time.sleep(2)
    out["orderStatus"] = core.order_status(v, cloid)
    out["fills"] = core.fills_by_cloid(v, cloid)
    print(json.dumps({"plan": plan, "result": out}, indent=2))
    status = "done" if out["state"] in ("filled", "partial") else "failed"
    record(args.step or f"agent-order-{args.side}", f"API wallet IOC {args.side} {size} on {args.market} for the Vault account",
           status, "core", None, before, snapshot(), json.dumps({"cloid": cloid, **plan, "result": out}, default=str)[:3000])


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--execute", action="store_true", help="sign and send; default is simulation only")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("snapshot")
    sub.add_parser("deploy-modules")
    sub.add_parser("deploy-vault")
    sub.add_parser("verify")
    b = sub.add_parser("bootstrap")
    b.add_argument("--seed", default="15000000")  # user-approved exception to the 100 USD script policy
    b.add_argument("--name", default="HyperVault USDC Carry (prototype)")
    s = sub.add_parser("sync")
    s.add_argument("--step")
    sc = sub.add_parser("scope")
    sc.add_argument("--usdc-only", action="store_true")
    sc.add_argument("--blp", action="store_true")
    sc.add_argument("--step")
    r = sub.add_parser("record-price")
    r.add_argument("--who", default="owner")
    r.add_argument("--ledger", action="store_true")
    u = sub.add_parser("user-deposit")
    u.add_argument("amount")
    u.add_argument("--who", default="demo-user")
    u.add_argument("--step")
    a = sub.add_parser("allocate")
    a.add_argument("amount")
    m = sub.add_parser("abstraction")
    m.add_argument("mode", choices=list(ABSTRACTION))
    sub.add_parser("set-agent")
    sub.add_parser("revoke-agent")
    q = sub.add_parser("request-redeem")
    q.add_argument("--who", default="demo-user")
    q.add_argument("--shares")
    sub.add_parser("begin-exit")
    c = sub.add_parser("recall")
    c.add_argument("amount")
    c.add_argument("--dex", default="spot", choices=["spot", "perp"])
    sub.add_parser("settle")
    cl = sub.add_parser("claim")
    cl.add_argument("--who", default="demo-user")
    ck = sub.add_parser("checkpoint")
    ck.add_argument("--who", default="keeper")
    ck.add_argument("--step")
    st = sub.add_parser("share-transfer")
    st.add_argument("shares")
    st.add_argument("--who", default="owner")
    st.add_argument("--to", default="demo-user")
    st.add_argument("--step")
    bl = sub.add_parser("blp")
    bl.add_argument("operation", choices=["supply", "withdraw", "borrow", "repay"])
    bl.add_argument("token", help="spot token index: 150 HYPE, 0 USDC")
    bl.add_argument("amount", nargs="?", default=None, help="decimal token amount, or 'max'")
    bl.add_argument("--step")
    n = sub.add_parser("note")
    for k in ("step", "title", "status", "layer", "note"):
        n.add_argument(f"--{k}", required=k != "note", default="")
    n.add_argument("--snapshot", action="store_true")
    sub.add_parser("evidence")
    sub.add_parser("buffer")
    bb = sub.add_parser("bigblocks")
    bb.add_argument("state", choices=["on", "off"])
    fe = sub.add_parser("fund-evm")
    fe.add_argument("amount")
    ao = sub.add_parser("agent-order")
    ao.add_argument("--market", default="@107")
    ao.add_argument("--side", choices=["buy", "sell"], required=True)
    ao.add_argument("--usd")
    ao.add_argument("--size")
    ao.add_argument("--slippage-bps", default="30")
    ao.add_argument("--step")
    args = p.parse_args()
    globals()["cmd_" + args.cmd.replace("-", "_")](args)


if __name__ == "__main__":
    main()
