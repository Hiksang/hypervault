#!/usr/bin/env python3
"""Read-only watcher for the two issuance guards of a Managed Vault. Never signs or sends.

The read precompiles cannot enumerate what a Core account holds; the HTTP API can. This lists
what a Vault's Core account holds outside its registered scope with the report call for each
venue, the listed report that could be dropped, and whether a share-price record should be sent.
A registered token is offered for a report too, through the pairs it is not registered on: the
source lets it be named while its registered pair would pay nothing for the holding.
The HTTP API only says where to look: whether a report stands is the contract's decision, so
with a deployed source every proposed call is simulated by eth_call at one pinned block.
The source keeps one report, and one that stands keeps its place. So at most one report is
proposed for sending: the renewal of the kept one when it is about to lapse, or, when the place
is free, the largest venue the contract accepts.
Without a deployed source, `--assume-token` describes a hypothetical scope and nothing is simulated.
Needs `cast` (Foundry) to encode calls.
"""
import argparse
from decimal import Decimal
import json
from pathlib import Path
import subprocess

from action_status import validated_hex
from equity_probe import paced_post
from nav_probe import parallel, utc_now
from probe import rpc


USDC = 0
OUTCOME_BASE = 100_000_000  # the source refuses reports of HIP-4 outcome tokens
PRICE_RECORDS = 8
RENEW_BEFORE = 12 * 3600  # a listed report is renewed when it has less than this left of its day
REPORT_TOKEN = "reportToken(address,uint32,uint32,bool,uint32)"
REPORT_DEX = "reportDex(address,uint32)"
REPORT_CORE_VAULT = "reportCoreVault(address,address)"
CLEAR_REPORT = "clearReport(address,uint256)"
RECORD_PRICE = "recordPrice(address)"
SCOPE = "scope(address)"
REPORTS = "reports(address)"
REPORT_ANSWERED_AT = "reportAnsweredAt(address)"
PRICE_RECORDS_OF = "priceRecords(address)"
PRICE_WINDOW = "priceWindow()"
MAX_DRAWDOWN = "maxDrawdownBps()"
SOURCE_CALLS = (REPORT_TOKEN, REPORT_DEX, REPORT_CORE_VAULT, CLEAR_REPORT, SCOPE, REPORTS, REPORT_ANSWERED_AT)
VERIFIER_CALLS = (RECORD_PRICE, PRICE_RECORDS_OF, PRICE_WINDOW, MAX_DRAWDOWN)
REPORT_KINDS = ("token", "dex", "coreVault")


def encode(signature, *args):
    text = [str(a).lower() if isinstance(a, bool) else str(a) for a in args]
    result = subprocess.run(["cast", "calldata", signature, *text], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def words(raw):
    if not isinstance(raw, str) or not raw.startswith("0x") or len(raw) == 2 or (len(raw) - 2) % 64:
        raise ValueError("malformed ABI response")
    return [int(raw[i:i + 64], 16) for i in range(2, len(raw), 64)]


def rows(data, head, width):
    """The dynamic array of `width`-word entries whose offset is head word `head`."""
    if head >= len(data) or data[head] % 32 or data[head] // 32 >= len(data):
        raise ValueError("malformed ABI array offset")
    start = data[head] // 32
    body = data[start + 1:start + 1 + data[start] * width]
    if len(body) != data[start] * width:
        raise ValueError("truncated ABI array")
    return [body[i:i + width] for i in range(0, len(body), width)]


def decode_scope(raw):
    """HyperCorePrecompileSource.scope(vault)."""
    data = words(raw)
    names = ("index", "usdcSpot", "lending", "reservePrice", "weiDecimals", "szDecimals")
    return {"version": data[0], "enabled": bool(data[1]),
            "tokens": [dict(zip(names, row)) for row in rows(data, 2, 6)],
            "dexes": [row[0] for row in rows(data, 3, 1)],
            "coreVaults": [f"0x{row[0]:040x}" for row in rows(data, 4, 1)]}


def decode_reports(raw):
    """HyperCorePrecompileSource.reports(vault)."""
    return [{"coreVault": f"0x{row[0]:040x}", "id": row[1], "pair": row[2], "quotePair": row[3],
             "expiresAt": row[4], "kind": REPORT_KINDS[row[5]], "viaQuote": bool(row[6])}
            for row in rows(words(raw), 0, 10)]  # three decimals fields follow, unused here


def decode_records(raw):
    """ManagedPortfolioNavVerifier.priceRecords(vault): (price, time) pairs, zero when unused."""
    data = words(raw)
    if len(data) != 2 * PRICE_RECORDS:
        raise ValueError("unexpected price record count")
    return [(data[i], data[i + 1]) for i in range(0, len(data), 2)]


def routes(spot_meta):
    """token -> [(pair, viaQuote, quotePair)]: every way a holding of it sells for USDC in one or
    two hops, its own USDC pair first. Any one of them can prove a report."""
    direct = {pair["tokens"][0]: pair["index"] for pair in spot_meta["universe"] if pair["tokens"][1] == USDC}
    result = {token: [(pair, False, 0)] for token, pair in direct.items()}
    for pair in spot_meta["universe"]:
        base, quote = pair["tokens"]
        if quote != USDC and quote in direct:
            result.setdefault(base, []).append((pair["index"], True, direct[quote]))
    return result


def read(bundle, key):
    record = bundle.get(key)
    if not isinstance(record, dict) or not record.get("ok"):
        raise ValueError(f"HTTP read failed: {key}")  # a failed read is never an empty holding
    return record["value"]


def holdings(bundle, dexes):
    """What the HTTP API says the account holds. Unpinned and unverified: a list of places to check.

    `apiTotal` is the API's combined balance (in Unified and Portfolio Margin it already includes
    other ledgers), so the amounts are hints and must not be added up.
    """
    tokens = {}
    for row in read(bundle, "spotClearinghouseState")["balances"]:
        if Decimal(row["total"]) != 0:
            tokens[row["token"]] = {"apiTotal": row["total"]}
    for token, state in read(bundle, "borrowLendUserState").get("tokenToState", []):
        supply, borrow = state["supply"]["value"], state["borrow"]["value"]
        if Decimal(supply) != 0 or Decimal(borrow) != 0:
            tokens.setdefault(token, {}).update(supply=supply, borrow=borrow)
    perp = {}
    for dex in dexes:
        state = read(bundle, f"clearinghouseState:{dex['index']}")
        equity, positions = state["marginSummary"]["accountValue"], len(state["assetPositions"])
        if Decimal(equity) != 0 or positions:
            perp[dex["index"]] = {"name": dex["name"], "collateralToken": dex["collateralToken"],
                                  "accountValue": equity, "positions": positions}
    vaults = {str(row["vaultAddress"]).lower(): row["equity"] for row in read(bundle, "userVaultEquities")
              if Decimal(row["equity"]) != 0}
    sub_accounts = read(bundle, "subAccounts") or []
    if not isinstance(sub_accounts, list):
        raise ValueError("unexpected subAccounts response")
    return {"tokens": tokens, "dexes": perp, "coreVaults": vaults, "subAccounts": len(sub_accounts)}


def outside_scope(vault, scope, held, route):
    """Report calls for what the account holds outside `scope`, and what no report can cover."""
    calls, unreportable, warnings = [], [], []
    registered = {token["index"] for token in scope["tokens"]}
    for token, amounts in sorted(held["tokens"].items()):
        ways = route.get(token, [])
        if token in registered:
            # The scope answers for it while its own USDC pair would pay for the holding. While
            # that pair pays nothing, a holding that sells on another pair can still be named:
            # offer those pairs and let the contract decide. USDC itself is never reportable.
            calls += [{"kind": "token", "id": token, "registered": True, "signature": REPORT_TOKEN,
                       "args": [vault, token, pair, via_quote, quote_pair], **amounts}
                      for pair, via_quote, quote_pair in ways if via_quote and token != USDC]
        elif token >= OUTCOME_BASE:
            unreportable.append({"kind": "token", "id": token, "reason": "HIP-4 outcome token", **amounts})
        elif not ways:
            # The contract checks the pair before anything else, also for a debt.
            unreportable.append({"kind": "token", "id": token, "reason": "no spot pair leads to USDC", **amounts})
        else:
            calls += [{"kind": "token", "id": token, "signature": REPORT_TOKEN,
                       "args": [vault, token, pair, via_quote, quote_pair], **amounts}
                      for pair, via_quote, quote_pair in ways]
    for dex, state in sorted(held["dexes"].items()):
        if state["collateralToken"] != USDC:
            warnings.append(f"DEX {dex} is collateralized in token {state['collateralToken']}, not USDC: "
                            "the source reads its equity as USDC and cannot value it")
        if dex not in scope["dexes"]:
            calls.append({"kind": "dex", "id": dex, "signature": REPORT_DEX, "args": [vault, dex], **state})
    for address, equity in sorted(held["coreVaults"].items()):
        if address not in scope["coreVaults"]:
            calls.append({"kind": "coreVault", "id": address, "signature": REPORT_CORE_VAULT,
                          "args": [vault, address], "equity": equity})
    if held["subAccounts"]:
        unreportable.append({"kind": "subAccounts", "count": held["subAccounts"],
                             "reason": "sub-accounts are neither valued nor reportable"})
    return calls, unreportable, warnings


def listed(entry, reports):
    """The listed report of the same venue as a proposed report call, if any."""
    for report in reports:
        venue = report["coreVault"] if report["kind"] == "coreVault" else report["id"]
        if report["kind"] == entry["kind"] and venue == entry["id"]:
            return report
    return None


def hint(entry, mids, pair_names):
    """Rough USDC value of a venue, from unpinned API numbers. It only ranks venues: never a NAV."""
    if entry["kind"] == "dex":
        return Decimal(entry["accountValue"]) if entry["collateralToken"] == USDC else Decimal(0)
    if entry["kind"] == "coreVault":
        return Decimal(entry["equity"])
    _, _, pair, via_quote, quote_pair = entry["args"]
    price = Decimal(mids.get(pair_names.get(pair), 0))
    if via_quote:
        price *= Decimal(mids.get(pair_names.get(quote_pair), 0))
    # In Unified and Portfolio Margin the API total already includes the supply.
    return max(Decimal(entry.get("apiTotal", entry.get("supply", 0))), Decimal(0)) * price


def choose(calls, clears, now):
    """The one report worth sending, or None.

    The source keeps a single report. While it stands the contract refuses every other venue,
    so the only call it can have accepted is the renewal of that report: it is sent when the
    report is about to lapse, whoever made it, because a lapsed report closes nothing and its
    expiry is a moment everybody can see coming. When the place is free it goes to the first
    proof that arrives, and a report closes the Vault only while its venue holds what was proven.
    So the venue to put there is the largest one the contract accepts: a small holding would
    open the Vault again the moment it is emptied.
    """
    accepted = [entry for entry in calls if entry.get("simulation", {}).get("accepted")]
    if not accepted:
        return None
    kept = clears[0] if clears and not clears[0]["simulation"]["accepted"] else None  # it still stands
    if kept is None:
        return max(accepted, key=lambda entry: Decimal(entry["hintUsdc"]))
    renewal = next((entry for entry in accepted if listed(entry, [kept])), None)
    return renewal if renewal is not None and kept["expiresAt"] - now <= RENEW_BEFORE else None


def record_due(records, window, now, since=0):
    """Whether a share-price sample is due, by the verifier's spacing rule.

    A record every quarter window keeps two inside the older half of the window, which is what
    issuance needs, so one missed run does not close deposits. Only records made after `since`
    are history: that is when the owner last answered a report by a scope change. Until one
    exists a record is due as soon as it gets a slot of its own: inside the spacing a record only
    replaces the price of the newest one and keeps its time.
    """
    newest = max(((time, price) for price, time in records if time), default=(0, 0))
    history = [time for _, time in records if time > since and now - time <= window]
    return {"last": newest[0], "lastPrice": newest[1], "answeredAt": since,
            "issuanceHistory": bool(history) and now - min(history) >= window // 2,
            "due": now - newest[0] >= window // 4
            or (newest[0] <= since and now - newest[0] > window // PRICE_RECORDS)}


def repairs(price, last_price, drawdown_bps):
    """Whether the current price is so far above the newest record that it must be recorded now.

    The verifier lets a higher price replace the newest sample. A sample taken while value was
    momentarily outside the scope sits below the fair price by more than the drawdown limit:
    left alone it would let a later deposit at that low price pass.
    """
    return last_price != 0 and price * 10_000 > last_price * (10_000 + drawdown_bps // 2)


def simulate(transport, evm, tag, to, data):
    """eth_call of a state-changing function at the pinned block: would the contract accept it?"""
    try:
        result = transport(evm, "eth_call", [{"to": to, "data": data}, tag])
    except RuntimeError as error:
        if "revert" not in str(error).lower():
            raise  # a transport failure is not the contract's answer
        return {"accepted": False, "error": str(error)[:300]}
    return {"accepted": True, "result": result}


def perp_dexes(info):
    dexes = []
    for index, entry in enumerate(info({"type": "perpDexs"})):
        name = "" if entry is None else entry["name"]
        dexes.append({"index": index, "name": name,
                      "collateralToken": info({"type": "meta", "dex": name}).get("collateralToken")})
    if any(type(dex["collateralToken"]) is not int for dex in dexes):
        raise ValueError("perp DEX collateral metadata unavailable; refusing a guessed quote token")
    return dexes


def account_info(info, account, dexes):
    kinds = ("spotClearinghouseState", "borrowLendUserState", "userVaultEquities", "subAccounts")
    jobs = {kind: {"type": kind, "user": account} for kind in kinds}
    for dex in dexes:
        jobs[f"clearinghouseState:{dex['index']}"] = {"type": "clearinghouseState", "user": account, "dex": dex["name"]}
    return parallel({key: (lambda body=body: info(body)) for key, body in jobs.items()})


def capture(network, vault, source=None, verifier=None, assumed=None, transport=rpc, info=None):
    vault = validated_hex(vault, 20)
    stem = "hyperliquid" if network == "mainnet" else "hyperliquid-testnet"
    api, evm = f"https://api.{stem}.xyz/info", f"https://rpc.{stem}.xyz/evm"
    info = info or (lambda body: paced_post(api, body))
    if int(transport(evm, "eth_chainId", []), 16) != (999 if network == "mainnet" else 998):
        raise ValueError("RPC chain mismatch")
    tag = transport(evm, "eth_blockNumber", [])
    header = transport(evm, "eth_getBlockByNumber", [tag, False])
    if not isinstance(header, dict) or header.get("number") != tag or not header.get("hash"):
        raise ValueError("cannot pin EVM block")
    now = int(header["timestamp"], 16)

    def call(to, signature, *args):
        return transport(evm, "eth_call", [{"to": to, "data": encode(signature, *args)}, tag])

    report = {"kind": "READ_ONLY_WATCH_NOT_A_NAV", "observedAt": utc_now(), "network": network, "vault": vault,
              "evmBlock": tag, "evmBlockHash": header["hash"], "evmTimestamp": now, "infoBlockPinned": False,
              "source": source, "verifier": verifier}
    if source:
        source = report["source"] = validated_hex(source, 20)
        scope = decode_scope(call(source, SCOPE, vault))
        if scope["version"] == 0:
            raise ValueError("the Vault has no registered scope")
        standing = decode_reports(call(source, REPORTS, vault))
    else:
        scope, standing = assumed, []
    dexes = perp_dexes(info)
    held = holdings(account_info(info, vault, dexes), dexes)
    spot_meta = info({"type": "spotMeta"})
    calls, unreportable, warnings = outside_scope(vault, scope, held, routes(spot_meta))
    mids = info({"type": "allMids"}) if calls else {}
    pair_names = {pair["index"]: pair.get("name", f"@{pair['index']}") for pair in spot_meta["universe"]}
    for entry in calls:
        entry["data"] = encode(entry["signature"], *entry["args"])
        entry["hintUsdc"] = str(hint(entry, mids, pair_names))
        known = listed(entry, standing)
        if known:
            entry["listedUntil"] = known["expiresAt"]
        if source:
            entry["simulation"] = simulate(transport, evm, tag, source, entry["data"])
    clears = []
    for index, entry in enumerate(standing):
        data = encode(CLEAR_REPORT, vault, index)
        clears.append({**entry, "index": index, "expired": now >= entry["expiresAt"], "signature": CLEAR_REPORT,
                       "args": [vault, index], "data": data,
                       "simulation": simulate(transport, evm, tag, source, data)})
    report.update(scope=scope, scopeIsAssumed=not source, held=held, reports=calls, clears=clears,
                  unreportable=unreportable, warnings=warnings)
    if verifier:
        verifier = report["verifier"] = validated_hex(verifier, 20)
        price = record_due(decode_records(call(verifier, PRICE_RECORDS_OF, vault)),
                           words(call(verifier, PRICE_WINDOW))[0], now,
                           words(call(source, REPORT_ANSWERED_AT, vault))[0] if source else 0)
        price.update(signature=RECORD_PRICE, args=[vault], data=encode(RECORD_PRICE, vault))
        # The call returns the price it would record, and inside the spacing it is accepted
        # only for a higher price than the newest record.
        price["simulation"] = simulate(transport, evm, tag, verifier, price["data"])
        if price["simulation"]["accepted"] and not price["due"]:
            price["due"] = repairs(words(price["simulation"]["result"])[0], price["lastPrice"],
                                   words(call(verifier, MAX_DRAWDOWN))[0])
        report["priceRecord"] = price
    end = transport(evm, "eth_getBlockByNumber", [tag, False])
    report["blockHashStable"] = bool(isinstance(end, dict) and end.get("hash") == header["hash"])
    return report


def to_send(report):
    """Calls the contract accepted in simulation. Without a deployed source nothing was simulated."""
    chosen = choose(report["reports"], report["clears"], report["evmTimestamp"])
    # A new report takes the place of one that no longer stands: dropping that first would be a
    # wasted call.
    accepted = [chosen] if chosen else [entry for entry in report["clears"] if entry["simulation"]["accepted"]]
    price = report.get("priceRecord")
    if price and price["due"] and price["simulation"]["accepted"]:
        accepted.append(price)
    return [{"signature": entry["signature"], "args": entry["args"], "data": entry["data"]} for entry in accepted]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--network", choices=("mainnet", "testnet"), required=True)
    parser.add_argument("--vault", required=True, help="Vault address: it is its own Core account")
    parser.add_argument("--source", help="deployed HyperCorePrecompileSource")
    parser.add_argument("--verifier", help="deployed ManagedPortfolioNavVerifier")
    parser.add_argument("--assume-token", type=int, action="append", default=[], help="hypothetical scope token")
    parser.add_argument("--assume-dex", type=int, action="append", default=[], help="hypothetical scope DEX")
    parser.add_argument("--assume-core-vault", action="append", default=[], help="hypothetical scope vault")
    parser.add_argument("--output", type=Path, help="new file; never overwrite a prior observation")
    args = parser.parse_args()
    assumed = None
    if not args.source:
        if USDC not in args.assume_token:
            parser.error("give --source, or a hypothetical scope that includes --assume-token 0 (USDC)")
        assumed = {"version": 0, "enabled": False, "tokens": [{"index": token} for token in args.assume_token],
                   "dexes": args.assume_dex,
                   "coreVaults": [validated_hex(address, 20) for address in args.assume_core_vault]}
    elif args.assume_token or args.assume_dex or args.assume_core_vault:
        parser.error("a deployed source has its own scope: do not assume one")
    if args.output and args.output.exists():
        parser.error("output already exists")
    try:
        report = capture(args.network, args.vault, args.source, args.verifier, assumed)
    except (ValueError, OSError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"watch failed: {error}\n")
    report["toSend"] = to_send(report)
    text = json.dumps(report, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open("x") as output:
            output.write(text + "\n")
    print(text)
    if not report["blockHashStable"]:
        parser.exit(2, "pinned block changed during the watch; rerun\n")


if __name__ == "__main__":
    main()
