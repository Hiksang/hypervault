"""Shared helpers for the HyperVault operator tools (mainnet chain 999 / HyperCore mainnet).

Keys live outside the repository in ~/.config/hypervault/<name>.key (mode 600). They are passed
to `cast` as process arguments only and are never printed, logged or written to evidence.
HTTP API reads are not block-pinned. A failed read raises; callers must not turn it into zero.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

CHAIN_ID = 999
# Operator tools rotate over the fastest HyperEVM endpoints measured on 2026-10-13 (hypurrscan ~0 s,
# drpc ~1 s, public ~0.1 s, thirdweb ~1 s); rotation keeps the public node under its ~100/min burst
# limit, which is per IP, so it does not touch FE users. HV_RPC_URL pins one endpoint; HV_RPC_URLS overrides
# the list (comma-separated). All were checked to answer chain 999 and HyperCore precompile reads
# (verifier.nav while Active). hyperevm.rpc.sentio.xyz is left out: it returns a malformed reply
# ("result and error are mutually exclusive") for precompile-backed calls; lb.routeme.sh is left
# out after it answered in 13 s and hung `cast call`, and stakely after 7 s answers (2026-10-13).
DEFAULT_RPCS = (
    "https://rpc.hypurrscan.io",
    "https://hyperliquid.drpc.org",
    "https://rpc.hyperliquid.xyz/evm",
    "https://999.rpc.thirdweb.com",
)
RPCS = [u.strip() for u in (os.environ.get("HV_RPC_URL") or os.environ.get("HV_RPC_URLS") or ",".join(DEFAULT_RPCS)).split(",") if u.strip()]
_rpc_at = int.from_bytes(os.urandom(2), "big") % len(RPCS)
# Errors that say nothing about the request itself: ask the next endpoint.
TRANSIENT = ("-32005", "rate limit", "-32602", "invalid block range", "429", "502", "503", "504", "timed out",
             "timeout", "connection", "error sending request", "temporarily unavailable",
             "mutually exclusive", "deserialization error")


def rpc_url() -> str:
    return RPCS[_rpc_at]


def rotate_rpc() -> str:
    global _rpc_at
    _rpc_at = (_rpc_at + 1) % len(RPCS)
    return RPCS[_rpc_at]


def _transient(msg: str) -> bool:
    m = msg.lower()
    return any(t in m for t in TRANSIENT)


RPC = rpc_url()  # the endpoint this process starts on; prefer rpc_url() for the current one
API = "https://api.hyperliquid.xyz"
USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f"
CIRCLE = "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24"
CORE_WRITER = "0x3333333333333333333333333333333333333333"
EXPLORER_TX = "https://hyperevmscan.io/tx/"
KEY_DIR = Path(os.environ.get("HV_KEY_DIR", Path.home() / ".config" / "hypervault"))
ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = ROOT / ".omc" / "hypervault"
SPOT_DEX = 2**32 - 1
# Agent keys are never reused once revoked (the Vault rejects reuse; Hyperliquid advises against it).
AGENT = os.environ.get("HV_AGENT", "agent")


def utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def key(name: str) -> str:
    path = KEY_DIR / f"{name}.key"
    if path.stat().st_mode & 0o077:
        raise PermissionError(f"{path} must not be group/world readable")
    return path.read_text().strip()


def addr(name: str) -> str:
    return (KEY_DIR / f"{name}.addr").read_text().strip()


def post(url: str, body: dict, retries: int = 3, timeout: int = 20):
    data = json.dumps(body).encode()
    last = None
    for attempt in range(retries):
        try:
            # Several RPC providers sit behind a WAF that rejects the default Python-urllib agent (403).
            req = urllib.request.Request(url, data, {"Content-Type": "application/json", "User-Agent": "hypervault-ops/1"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.load(resp)
        except Exception as exc:  # network error: retry, then raise; never return a default
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"POST {url} failed after {retries} attempts: {last}")


def info(body: dict):
    return post(f"{API}/info", body)


def rpc(method: str, params: list):
    # A rate-limited or failing endpoint hands over to the next one; a failed read raises, never defaults.
    res: dict = {}
    for attempt in range(2 * len(RPCS)):
        try:
            res = post(rotate_rpc(), {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, retries=1)
        except RuntimeError as exc:
            res = {"error": str(exc)}
            continue
        if "error" not in res or not _transient(json.dumps(res["error"])):
            break
        time.sleep(min(1 + attempt, 5))
    if "error" in res or "result" not in res:
        raise RuntimeError(f"RPC {method}: {res.get('error', 'missing result')}")
    return res["result"]


def block_number() -> int:
    return int(rpc("eth_blockNumber", []), 16)


def _cast(args: list[str], secret: str | None = None) -> str:
    """Run cast against the endpoint rotation. Reads move to the next endpoint on transient errors.
    A send is pinned to one nonce for every attempt, so a retry on another endpoint can replace a
    stuck transaction but can never execute the same step twice."""
    uses_rpc = args[0] in ("call", "send", "estimate")
    pinned: list[str] = []
    if args[0] == "send" and secret is not None and "--nonce" not in args:
        from eth_account import Account

        pinned = ["--nonce", str(int(rpc("eth_getTransactionCount", [Account.from_key(secret).address, "pending"]), 16))]
    msg = ""
    for attempt in range(len(RPCS) if uses_rpc else 1):
        # Flags go right after the subcommand: `cast send --create <code>` treats anything after the code as args.
        flags = (["--rpc-url", rotate_rpc()] if uses_rpc else []) + pinned
        if secret is not None:
            flags += ["--private-key", secret]
        try:
            # A silent endpoint must not hang the tool: time out and move to the next one. A
            # timed-out send may still have been broadcast; the pinned nonce keeps a resend single.
            res = subprocess.run(["cast", args[0], *flags, *args[1:]], capture_output=True, text=True,
                                 timeout=60)
        except subprocess.TimeoutExpired:
            msg = f"cast {args[0]} timed out on {flags[1] if uses_rpc else 'local'}"
            continue
        if res.returncode == 0:
            return res.stdout.strip()
        msg = res.stderr.strip() or res.stdout.strip()
        if secret:
            msg = msg.replace(secret, "<redacted>")
        if not _transient(msg) or "nonce too low" in msg.lower():
            break
        time.sleep(min(2 + attempt, 6))
    raise RuntimeError(f"cast {args[0]} failed: {msg[-1500:]}")


def _first_json(text: str):
    """cast --json sometimes prints more than one JSON document (seen on mainnet); the receipt is first."""
    obj, _ = json.JSONDecoder().raw_decode(text.lstrip())
    return obj


def call(to: str, sig: str, *args, block: int | str = "latest") -> list:
    """eth_call with ABI decoding. `sig` must include return types, e.g. 'phase()(uint8)'."""
    out = _cast(["call", to, sig, *[str(a) for a in args], "--block", str(block), "--json"])
    return json.loads(out)


def call_raw(to: str, data: str, block: int | str = "latest") -> str:
    return rpc("eth_call", [{"to": to, "data": data}, hex(block) if isinstance(block, int) else block])


def send(who: str, to: str, sig: str, *args, value: str | None = None, gas_limit: int | None = None) -> dict:
    """Sign with ~/.config/hypervault/<who>.key and wait for the receipt. Raises on revert."""
    cmd = ["send", to, sig, *[str(a) for a in args], "--json", "--chain", str(CHAIN_ID)]
    if value:
        cmd += ["--value", value]
    if gas_limit:
        cmd += ["--gas-limit", str(gas_limit)]
    return _summ(_broadcast(cmd, key(who)))


def create(who: str, bytecode: str, gas_limit: int | None = None) -> dict:
    cmd = ["send", "--json", "--chain", str(CHAIN_ID)]
    if gas_limit:
        cmd += ["--gas-limit", str(gas_limit)]
    cmd += ["--create", bytecode]
    return _summ(_broadcast(cmd, key(who)))


def _broadcast(cmd: list[str], secret: str, wait_s: int = 240) -> dict:
    """Broadcast without waiting in cast (`--async` prints the hash), then poll the receipt over the
    endpoint rotation: some endpoints never return receipts, which left `cast send` waiting out its
    timeout on every retry. The nonce stays pinned by `_cast`, so a resend cannot run twice."""
    out = _cast([cmd[0], "--async", *[c for c in cmd[1:] if c != "--json"]], secret)
    tx_hash = out.strip().split()[-1]
    if not (tx_hash.startswith("0x") and len(tx_hash) == 66):
        raise RuntimeError(f"cast send --async gave no hash: {out[-200:]}")
    deadline = time.time() + wait_s
    while time.time() < deadline:
        try:
            receipt = rpc("eth_getTransactionReceipt", [tx_hash])
        except RuntimeError:
            receipt = None
        if receipt:
            return receipt
        time.sleep(2)
    raise RuntimeError(f"transaction {tx_hash} not confirmed within {wait_s}s (it may still land)")


def simulate_create(who: str, bytecode: str) -> dict:
    """Run the constructor against live mainnet state (precompiles included); nothing is sent."""
    sender = addr(who)
    code = rpc("eth_call", [{"from": sender, "data": bytecode}, "latest"])
    gas = int(rpc("eth_estimateGas", [{"from": sender, "data": bytecode}]), 16)
    return {"runtimeBytes": (len(code) - 2) // 2, "estimatedGas": gas}


def _summ(r: dict) -> dict:
    status = int(r["status"], 16) if isinstance(r.get("status"), str) else r.get("status")
    out = {
        "txHash": r["transactionHash"],
        "evmBlock": int(r["blockNumber"], 16),
        "status": status,
        "gasUsed": int(r["gasUsed"], 16),
        "contractAddress": r.get("contractAddress"),
        "logs": r.get("logs", []),
    }
    if status != 1:
        raise RuntimeError(f"transaction reverted: {out['txHash']}")
    return out


def encode_args(sig: str, *args) -> str:
    return _cast(["abi-encode", sig, *[str(a) for a in args]])


def artifact_bytecode(contract_path: str, name: str) -> str:
    art = json.loads((ROOT / "out" / contract_path / f"{name}.json").read_text())
    return art["bytecode"]["object"]


def erc20_balance(token: str, who: str) -> int:
    v = call(token, "balanceOf(address)(uint256)", who)[0]
    return int(str(v).split()[0])


def native_balance(who: str) -> int:
    return int(rpc("eth_getBalance", [who, "latest"]), 16)


def load_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")
    tmp.replace(path)
