import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import scope_watch as w  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT / "docs/reference/managed-equity-modes-rerun-2026-10-04.json"
VAULT = "0x" + "1" * 40
SOURCE = "0x" + "5" * 40
VERIFIER = "0x" + "6" * 40
HLP = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"
NOW = 1_000_000
WINDOW = 600


def abi(*values):
    return "0x" + "".join(f"{int(v, 16) if isinstance(v, str) else int(v):064x}" for v in values)


def scope_abi(version, enabled, tokens, dexes, vaults):
    """(uint64, bool, TokenState[], uint32[], address[]) as the contract returns it."""
    token_words = [len(tokens)] + [field for token in tokens for field in token]
    dex_words = [len(dexes)] + list(dexes)
    first = 5 * 32
    second = first + 32 * len(token_words)
    return abi(version, enabled, first, second, second + 32 * len(dex_words),
               *token_words, *dex_words, len(vaults), *vaults)


def selectors(name):
    artifact = ROOT / f"out/{name}.sol/{name}.json"
    if not artifact.exists():
        raise AssertionError(f"{artifact} is missing: run `forge build --offline` first")
    return json.loads(artifact.read_text())["methodIdentifiers"]


def saved(prefix):
    report = json.loads(EVIDENCE.read_text())
    account = next(a for a in report["accounts"] if a.startswith(prefix))
    bundle = dict(report["accounts"][account]["infoAfter"])
    bundle["subAccounts"] = {"ok": True, "value": None}  # not part of the saved observation
    return w.holdings(bundle, report["dexes"])


def scope(tokens=(0,), dexes=(), vaults=()):
    return {"tokens": [{"index": token} for token in tokens], "dexes": list(dexes), "coreVaults": list(vaults)}


class ScopeWatchTest(unittest.TestCase):
    def test_routes_use_the_direct_usdc_pair_or_one_quote_hop(self):
        meta = {"universe": [{"index": 107, "tokens": [150, 0]}, {"index": 166, "tokens": [268, 0]},
                             {"index": 302, "tokens": [150, 268]}, {"index": 300, "tokens": [999, 268]},
                             {"index": 301, "tokens": [998, 997]}]}
        route = w.routes(meta)
        self.assertEqual(route[150], [(107, False, 0), (302, True, 166)], "its own USDC pair first, then HYPE/USDT0")
        self.assertEqual(route[268], [(166, False, 0)])
        self.assertEqual(route[999], [(300, True, 166)], "one hop through the quote token's USDC pair")
        self.assertNotIn(998, route, "its quote token has no USDC pair")
        self.assertNotIn(0, route)

    def test_saved_public_account_against_a_narrow_scope(self):
        # Public mainnet account read on 2026-10-04: 13 spot tokens, two perp DEXes and HLP equity.
        held = saved("0xb4968ae8")
        outside = (39, 61, 78, 80, 98, 106, 146, 221, 223, 307, 734)
        route = {token: [(1000 + token, False, 0)] for token in outside if token != 734}
        calls, unreportable, warnings = w.outside_scope(VAULT, scope((0, 150), dexes=(0,)), held, route)
        self.assertEqual([c["id"] for c in calls if c["kind"] == "token"], [t for t in outside if t != 734])
        self.assertEqual(calls[0]["args"], [VAULT, 39, 1039, False, 0])
        self.assertEqual(calls[0]["signature"], w.REPORT_TOKEN)
        dex = next(c for c in calls if c["kind"] == "dex")
        self.assertEqual((dex["signature"], dex["args"], dex["positions"]), (w.REPORT_DEX, [VAULT, 1], 1))
        vault = next(c for c in calls if c["kind"] == "coreVault")
        self.assertEqual((vault["signature"], vault["args"]), (w.REPORT_CORE_VAULT, [VAULT, HLP]))
        self.assertEqual(len(calls), 12)
        self.assertEqual([(u["id"], u["reason"]) for u in unreportable], [(734, "no spot pair leads to USDC")])
        self.assertEqual(warnings, [])
        # Registering everything it holds leaves nothing to report.
        everything = scope((0, 150) + outside, dexes=(0, 1), vaults=(HLP,))
        self.assertEqual(w.outside_scope(VAULT, everything, held, route), ([], [], []))

    def test_saved_portfolio_margin_account_reports_supplied_tokens(self):
        # Portfolio Margin moved UBTC and USDT0 into the lending ledger: still outside a USDC-only scope.
        held = saved("0x6c93e15a")
        self.assertEqual(held["tokens"][197], {"apiTotal": "2.0374436707", "supply": "2.0374436707", "borrow": "0.0"})
        ways = {197: [(142, False, 0)], 268: [(166, False, 0)]}
        calls, unreportable, _ = w.outside_scope(VAULT, scope(dexes=(0,)), held, ways)
        self.assertEqual([c["args"] for c in calls], [[VAULT, 197, 142, False, 0], [VAULT, 268, 166, False, 0]])
        self.assertEqual(unreportable, [])

    def test_debt_outcomes_sub_accounts_and_foreign_collateral(self):
        held = {"tokens": {7: {"apiTotal": "-3", "supply": "0.0", "borrow": "3.0"}, 8: {"apiTotal": "5"},
                           9: {"apiTotal": "-1", "supply": "0.0", "borrow": "1.0"},
                           100_082_981: {"apiTotal": "40"}},
                "dexes": {2: {"name": "flx", "collateralToken": 360, "accountValue": "50", "positions": 0}},
                "coreVaults": {}, "subAccounts": 2}
        calls, unreportable, warnings = w.outside_scope(VAULT, scope(), held, {7: [(70, False, 0)]})
        # The contract checks the pair first, also for a debt: without a route nothing can be reported.
        self.assertEqual([c["args"] for c in calls], [[VAULT, 7, 70, False, 0], [VAULT, 2]])
        self.assertEqual([(u.get("id"), u["reason"]) for u in unreportable],
                         [(8, "no spot pair leads to USDC"), (9, "no spot pair leads to USDC"),
                          (100_082_981, "HIP-4 outcome token"),
                          (None, "sub-accounts are neither valued nor reportable")])
        self.assertEqual(len(warnings), 1)
        self.assertIn("token 360, not USDC", warnings[0])
        # Registering that DEX does not make it valued: the warning stays.
        _, _, warnings = w.outside_scope(VAULT, scope(dexes=(2,)), held, {})
        self.assertEqual(len(warnings), 1)

    def test_every_route_is_offered_and_a_registered_token_only_through_other_pairs(self):
        held = {"tokens": {0: {"apiTotal": "100"}, 150: {"apiTotal": "3.5"}, 999: {"apiTotal": "40"}},
                "dexes": {}, "coreVaults": {}, "subAccounts": 0}
        route = {0: [(500, True, 166)], 150: [(107, False, 0), (302, True, 166)], 999: [(300, True, 166)]}
        # Outside the scope every way it sells is a proof the contract may accept.
        calls, _, _ = w.outside_scope(VAULT, scope(), held, route)
        self.assertEqual([c["args"][1:] for c in calls],
                         [[150, 107, False, 0], [150, 302, True, 166], [999, 300, True, 166]])
        self.assertTrue(all("registered" not in c for c in calls))
        # Registered, HYPE is the scope's to answer for on its own USDC pair. It can still be named
        # through another pair, for the case that its own pair pays nothing. USDC never can.
        calls, unreportable, _ = w.outside_scope(VAULT, scope((0, 150, 999)), held, route)
        self.assertEqual([(c["args"][1:], c["registered"]) for c in calls],
                         [([150, 302, True, 166], True), ([999, 300, True, 166], True)])
        self.assertEqual(unreportable, [])

    def test_failed_http_read_is_never_an_empty_holding(self):
        report = json.loads(EVIDENCE.read_text())
        account = next(iter(report["accounts"]))
        bundle = dict(report["accounts"][account]["infoAfter"])
        with self.assertRaisesRegex(ValueError, "subAccounts"):
            w.holdings(bundle, report["dexes"])
        bundle["subAccounts"] = {"ok": True, "value": None}
        bundle["clearinghouseState:1"] = {"ok": False, "error": "HTTPError: 429"}
        with self.assertRaisesRegex(ValueError, "clearinghouseState:1"):
            w.holdings(bundle, report["dexes"])

    def test_contract_answers_are_decoded_and_malformed_ones_refused(self):
        raw = scope_abi(3, 1, [(0, 0, 1, 0, 8, 8), (150, 107, 0, 1, 8, 2)], [0, 1], [HLP])
        self.assertEqual(w.decode_scope(raw), {
            "version": 3, "enabled": True,
            "tokens": [{"index": 0, "usdcSpot": 0, "lending": 1, "reservePrice": 0, "weiDecimals": 8, "szDecimals": 8},
                       {"index": 150, "usdcSpot": 107, "lending": 0, "reservePrice": 1, "weiDecimals": 8, "szDecimals": 2}],
            "dexes": [0, 1], "coreVaults": [HLP]})
        self.assertEqual(w.decode_scope(scope_abi(0, 0, [], [], []))["tokens"], [])
        with self.assertRaises(ValueError):
            w.decode_scope(raw[:-64])
        with self.assertRaises(ValueError):
            w.decode_scope("0x")
        reports = abi(32, 2, 0, 221, 151, 166, NOW + 5, 0, 1, 8, 2, 2, HLP, 0, 0, 0, NOW - 5, 2, 0, 0, 0, 0)
        self.assertEqual(w.decode_reports(reports), [
            {"coreVault": "0x" + "0" * 40, "id": 221, "pair": 151, "quotePair": 166, "expiresAt": NOW + 5,
             "kind": "token", "viaQuote": True},
            {"coreVault": HLP, "id": 0, "pair": 0, "quotePair": 0, "expiresAt": NOW - 5, "kind": "coreVault",
             "viaQuote": False}])
        self.assertEqual(w.decode_reports(abi(32, 0)), [])
        records = w.decode_records(abi(10**27, NOW, *([0] * 14)))
        self.assertEqual((records[0], records[7]), ((10**27, NOW), (0, 0)))
        with self.assertRaises(ValueError):
            w.decode_records(abi(*([0] * 15)))

    def test_price_record_cadence_and_repair(self):
        def due(*ages):
            return w.record_due([(10**27 + age, NOW - age) for age in ages] + [(0, 0)] * (8 - len(ages)), WINDOW, NOW)

        self.assertEqual(due(), {"last": 0, "lastPrice": 0, "answeredAt": 0, "issuanceHistory": False, "due": True})
        self.assertEqual(due(149), {"last": NOW - 149, "lastPrice": 10**27 + 149, "answeredAt": 0,
                                    "issuanceHistory": False, "due": False})
        self.assertTrue(due(150)["due"], "a record every quarter window")
        self.assertEqual(due(400, 20)["lastPrice"], 10**27 + 20, "the newest record, not the highest")
        # Issuance needs the oldest record inside the window to be at least half a window old.
        self.assertFalse(due(299)["issuanceHistory"])
        self.assertTrue(due(300)["issuanceHistory"])
        self.assertTrue(due(600, 10)["issuanceHistory"])
        self.assertFalse(due(601, 10)["issuanceHistory"], "a record that left the window proves nothing")
        # Records made up to the time a report was answered are no history, as in the verifier.
        def after(answered_ago, *ages):
            records = [(10**27, NOW - age) for age in ages] + [(0, 0)] * (8 - len(ages))
            return w.record_due(records, WINDOW, NOW, NOW - answered_ago)

        self.assertTrue(after(400, 300)["issuanceHistory"], "recorded after the answer and aged")
        self.assertFalse(after(300, 300)["issuanceHistory"], "a record of the answering block is no history")
        self.assertFalse(after(200, 500, 100)["issuanceHistory"], "only the record after the answer counts")
        self.assertTrue(after(350, 500, 300)["issuanceHistory"])
        # Until a record exists after the answer, one is due as soon as it takes a slot of its own:
        # inside the spacing it would only replace the newest record's price and keep its time.
        self.assertFalse(after(10, 75)["due"], "inside the spacing of an eighth of the window")
        self.assertTrue(after(10, 76)["due"])
        self.assertFalse(after(100, 76)["due"], "a record after the answer exists: the usual cadence")
        self.assertEqual(after(10, 76)["answeredAt"], NOW - 10)
        # Between samples the keeper sends only to restore a sample that sits too far below the price.
        self.assertFalse(w.repairs(1_025, 1_000, 500), "half the 5% limit is still noise")
        self.assertTrue(w.repairs(1_026, 1_000, 500))
        self.assertFalse(w.repairs(2_000, 0, 500), "no record to restore")

    def test_signatures_match_the_built_contracts(self):
        source, verifier = selectors("HyperCorePrecompileSource"), selectors("ManagedPortfolioNavVerifier")
        for signature in w.SOURCE_CALLS:
            self.assertIn(signature, source)
        for signature in w.VERIFIER_CALLS:
            self.assertIn(signature, verifier)
        self.assertEqual(w.encode(w.REPORT_TOKEN, VAULT, 221, 151, True, 166),
                         "0x" + source[w.REPORT_TOKEN] + abi(VAULT, 221, 151, 1, 166)[2:])
        self.assertEqual(w.encode(w.RECORD_PRICE, VAULT), "0x" + verifier[w.RECORD_PRICE] + abi(VAULT)[2:])

    def test_one_report_is_kept_so_the_largest_accepted_venue_is_the_one_to_send(self):
        def call(kind, venue, value, accepted=True):
            return {"kind": kind, "id": venue, "hintUsdc": value, "simulation": {"accepted": accepted}}

        def kept(kind, venue, left, stands=True):
            return [{"kind": kind, "id": venue, "coreVault": venue if kind == "coreVault" else "0x" + "0" * 40,
                     "expiresAt": NOW + left, "simulation": {"accepted": not stands}}]

        small, real, refused = call("dex", 3, "10"), call("dex", 2, "100"), call("token", 150, "5000", False)
        self.assertIsNone(w.choose([refused], [], NOW), "what the contract refuses is never sent")
        self.assertIsNone(w.choose([{"kind": "dex", "id": 2, "hintUsdc": "100"}], [], NOW), "nor what was not simulated")
        # The place is free: the largest accepted venue goes there.
        self.assertIs(w.choose([small, real, refused], [], NOW), real)
        self.assertIs(w.choose([small, real], kept("dex", 9, w.RENEW_BEFORE + 1, stands=False), NOW), real)
        # A kept report that stands is left alone until it is about to lapse, then renewed.
        self.assertIsNone(w.choose([real], kept("dex", 2, w.RENEW_BEFORE + 1), NOW))
        self.assertIs(w.choose([real], kept("dex", 2, w.RENEW_BEFORE), NOW), real)
        hlp = call("coreVault", HLP, "50")
        self.assertIsNone(w.choose([hlp], kept("coreVault", HLP, w.RENEW_BEFORE + 1), NOW))
        self.assertIs(w.choose([hlp], kept("coreVault", HLP, 5), NOW), hlp)
        # While another venue's report stands, the contract refuses this one: there is nothing to
        # send for it, whatever it holds. The kept one is renewed whoever made it.
        waiting = call("dex", 2, "100", False)
        self.assertIsNone(w.choose([small, waiting], kept("dex", 3, w.RENEW_BEFORE + 1), NOW))
        self.assertIs(w.choose([small, waiting], kept("dex", 3, w.RENEW_BEFORE), NOW), small)
        # A token and a DEX with the same index are different venues: that is no renewal.
        self.assertIsNone(w.choose([call("dex", 2, "100")], kept("token", 2, 5), NOW))

    def test_hints_rank_venues_and_are_never_summed(self):
        names = {107: "@107", 300: "@300", 166: "@166"}
        mids = {"@107": "30.5", "@300": "2", "@166": "0.5"}
        token = {"kind": "token", "args": [VAULT, 150, 107, False, 0], "apiTotal": "3.5", "supply": "3.5"}
        self.assertEqual(w.hint(token, mids, names), w.Decimal("106.75"), "the API total already holds the supply")
        routed = {"kind": "token", "args": [VAULT, 999, 300, True, 166], "apiTotal": "10"}
        self.assertEqual(w.hint(routed, mids, names), w.Decimal("10"))
        self.assertEqual(w.hint({**routed, "args": [VAULT, 999, 301, True, 166]}, mids, names), 0, "no price, no rank")
        debt = {"kind": "token", "args": [VAULT, 7, 107, False, 0], "apiTotal": "-3", "borrow": "3.0"}
        self.assertEqual(w.hint(debt, mids, names), 0)
        self.assertEqual(w.hint({"kind": "dex", "accountValue": "25.0", "collateralToken": 0}, mids, names), 25)
        self.assertEqual(w.hint({"kind": "dex", "accountValue": "25.0", "collateralToken": 360}, mids, names), 0)
        self.assertEqual(w.hint({"kind": "coreVault", "equity": "12.5"}, mids, names), w.Decimal("12.5"))

    def watch(self, reverted=(), failing=None, last_record=200, price=10**27, listed_for=None, answered_ago=None):
        """One watch of a Vault registered for USDC and DEX 0 that also holds HYPE and DEX 1 equity."""
        source, verifier = selectors("HyperCorePrecompileSource"), selectors("ManagedPortfolioNavVerifier")
        report = [0, 9, 0, 0, NOW - 1, 1, 0, 0, 0, 0]  # a lapsed report of DEX 9
        if listed_for is not None:
            report = [0, 1, 0, 0, NOW + listed_for, 1, 0, 0, 0, 0]  # DEX 1 is already reported
        answers = {source[w.SCOPE]: scope_abi(1, 1, [(0, 0, 1, 0, 8, 8)], [0], []),
                   source[w.REPORTS]: abi(32, 1, *report),
                   source[w.REPORT_ANSWERED_AT]: abi(0 if answered_ago is None else NOW - answered_ago),
                   verifier[w.PRICE_RECORDS_OF]: abi(10**27, NOW - last_record, *([0] * 14)),
                   verifier[w.PRICE_WINDOW]: abi(WINDOW), verifier[w.MAX_DRAWDOWN]: abi(500)}
        writes = {source[name]: name for name in (w.REPORT_TOKEN, w.REPORT_DEX, w.CLEAR_REPORT)}
        writes[verifier[w.RECORD_PRICE]] = w.RECORD_PRICE
        self.simulated = []

        def transport(url, method, params):
            if method == "eth_chainId":
                return "0x3e7"
            if method == "eth_blockNumber":
                return "0x10"
            if method == "eth_getBlockByNumber":
                return {"number": "0x10", "hash": "0xabc", "timestamp": hex(NOW)}
            self.assertEqual((method, params[1]), ("eth_call", "0x10"), "every contract read is pinned")
            selector = params[0]["data"][2:10]
            self.assertEqual(params[0]["to"], SOURCE if selector in source.values() else VERIFIER)
            if selector in answers:
                return answers[selector]
            self.simulated.append(writes[selector])
            if writes[selector] == failing:
                raise RuntimeError({"code": -32005, "message": "rate limited"})
            if writes[selector] in reverted:
                raise RuntimeError({"code": 3, "message": "execution reverted", "data": "0x8baa579f"})
            return abi(price) if writes[selector] == w.RECORD_PRICE else "0x"

        def info(body):
            kind = body["type"]
            if kind == "perpDexs":
                return [None, {"name": "xyz"}]
            if kind == "meta":
                return {"collateralToken": 0}
            if kind == "spotMeta":
                return {"universe": [{"index": 107, "name": "@107", "tokens": [150, 0]}]}
            if kind == "allMids":
                return {"@107": "30.0", "HYPE": "30.1"}
            self.assertEqual(body["user"], VAULT)
            if kind == "spotClearinghouseState":
                return {"balances": [{"token": 0, "total": "100.0"}, {"token": 150, "total": "3.5"}]}
            if kind == "borrowLendUserState":
                return {"tokenToState": []}
            if kind == "clearinghouseState":
                return {"marginSummary": {"accountValue": "25.0" if body["dex"] == "xyz" else "0.0"}, "assetPositions": []}
            return [] if kind == "userVaultEquities" else None

        return w.capture("mainnet", VAULT, SOURCE, VERIFIER, transport=transport, info=info)

    def test_watch_proposes_only_what_the_contract_accepts(self):
        report = self.watch(reverted=(w.REPORT_TOKEN,))
        self.assertEqual(report["scope"]["dexes"], [0])
        self.assertFalse(report["scopeIsAssumed"])
        token, dex = report["reports"]
        self.assertEqual((token["id"], token["args"]), (150, [VAULT, 150, 107, False, 0]))
        # The HYPE holding is below what the contract counts: kept in the record, not sent.
        self.assertFalse(token["simulation"]["accepted"])
        self.assertIn("execution reverted", token["simulation"]["error"])
        self.assertTrue(dex["simulation"]["accepted"])
        self.assertEqual((token["hintUsdc"], dex["hintUsdc"]), ("105.00", "25.0"))
        self.assertEqual((report["clears"][0]["kind"], report["clears"][0]["expired"]), ("dex", True))
        self.assertTrue(report["priceRecord"]["due"])
        # The new report takes the place of the lapsed one, so that is not dropped first.
        self.assertEqual([call["signature"] for call in w.to_send(report)], [w.REPORT_DEX, w.RECORD_PRICE])
        self.assertTrue(report["blockHashStable"])
        # With nothing to report, the lapsed entry is dropped: it costs every valuation a read.
        nothing = self.watch(reverted=(w.REPORT_TOKEN, w.REPORT_DEX))
        self.assertEqual([call["signature"] for call in w.to_send(nothing)], [w.CLEAR_REPORT, w.RECORD_PRICE])
        everything = self.watch(reverted=(w.REPORT_TOKEN, w.REPORT_DEX, w.CLEAR_REPORT, w.RECORD_PRICE))
        self.assertEqual(w.to_send(everything), [])
        # Both venues stand: one report is kept, so only the larger one is sent.
        both = self.watch()
        self.assertEqual([(call["signature"], call["args"][1]) for call in w.to_send(both)[:1]], [(w.REPORT_TOKEN, 150)])
        self.assertEqual([call["signature"] for call in w.to_send(both)], [w.REPORT_TOKEN, w.RECORD_PRICE])

    def test_a_listed_report_is_renewed_only_when_it_is_about_to_lapse(self):
        fresh = self.watch(reverted=(w.REPORT_TOKEN, w.CLEAR_REPORT), listed_for=w.RENEW_BEFORE + 1)
        dex = fresh["reports"][1]
        self.assertEqual(dex["listedUntil"], NOW + w.RENEW_BEFORE + 1)
        self.assertTrue(dex["simulation"]["accepted"])
        self.assertFalse(fresh["clears"][0]["simulation"]["accepted"], "it still stands: nothing to drop")
        self.assertEqual([call["signature"] for call in w.to_send(fresh)], [w.RECORD_PRICE])
        ageing = self.watch(reverted=(w.REPORT_TOKEN, w.CLEAR_REPORT), listed_for=w.RENEW_BEFORE)
        self.assertEqual([call["signature"] for call in w.to_send(ageing)], [w.REPORT_DEX, w.RECORD_PRICE])
        # The kept report names the smaller venue and stands: the contract refuses the larger one,
        # so nothing is sent for it until the place is free.
        taken = self.watch(reverted=(w.REPORT_TOKEN, w.CLEAR_REPORT), listed_for=w.RENEW_BEFORE + 1)
        self.assertEqual((taken["reports"][0]["hintUsdc"], taken["reports"][1]["hintUsdc"]), ("105.00", "25.0"))
        self.assertEqual([call["signature"] for call in w.to_send(taken)], [w.RECORD_PRICE])

    def test_a_price_is_sent_between_samples_only_to_restore_one(self):
        quiet = self.watch(reverted=(w.REPORT_TOKEN, w.RECORD_PRICE), last_record=50)
        self.assertFalse(quiet["priceRecord"]["due"])
        self.assertFalse(quiet["priceRecord"]["simulation"]["accepted"], "the same price is refused by the contract")
        self.assertNotIn(w.RECORD_PRICE, [call["signature"] for call in w.to_send(quiet)])
        # The contract would take a slightly higher price, but that is not worth a transaction.
        noise = self.watch(reverted=(w.REPORT_TOKEN,), last_record=50, price=10**27 * 1025 // 1000)
        self.assertTrue(noise["priceRecord"]["simulation"]["accepted"])
        self.assertFalse(noise["priceRecord"]["due"])
        self.assertNotIn(w.RECORD_PRICE, [call["signature"] for call in w.to_send(noise)])
        # A sample far below the current price was taken in a dip: it is restored at once.
        dip = self.watch(reverted=(w.REPORT_TOKEN,), last_record=50, price=10**27 * 1026 // 1000)
        self.assertTrue(dip["priceRecord"]["due"])
        self.assertIn(w.RECORD_PRICE, [call["signature"] for call in w.to_send(dip)])

    def test_a_price_is_sent_once_a_report_was_answered(self):
        # The newest record is 100 s old and the next sample is not due for another 50 s. The
        # owner registered a reported venue 10 s ago: nothing recorded so far is history, so a
        # record is sent now instead of waiting for the cadence.
        waiting = self.watch(reverted=(w.REPORT_TOKEN,), last_record=100)
        self.assertFalse(waiting["priceRecord"]["due"])
        answered = self.watch(reverted=(w.REPORT_TOKEN,), last_record=100, answered_ago=10)
        self.assertEqual(answered["priceRecord"]["answeredAt"], NOW - 10)
        self.assertTrue(answered["priceRecord"]["due"])
        self.assertFalse(answered["priceRecord"]["issuanceHistory"])
        self.assertIn(w.RECORD_PRICE, [call["signature"] for call in w.to_send(answered)])

    def test_transport_failure_is_not_the_contracts_answer(self):
        with self.assertRaisesRegex(RuntimeError, "rate limited"):
            self.watch(failing=w.REPORT_DEX)

    def test_assumed_scope_is_never_presented_as_verified(self):
        def transport(url, method, params):
            self.assertNotEqual(method, "eth_call", "nothing is deployed to ask")
            return {"eth_chainId": "0x3e7", "eth_blockNumber": "0x10"}.get(
                method, {"number": "0x10", "hash": "0xabc", "timestamp": hex(NOW)})

        def info(body):
            kind = body["type"]
            if kind in ("perpDexs", "userVaultEquities"):
                return [None] if kind == "perpDexs" else []
            if kind == "clearinghouseState":
                return {"marginSummary": {"accountValue": "0.0"}, "assetPositions": []}
            return {"meta": {"collateralToken": 0}, "spotMeta": {"universe": [{"index": 107, "tokens": [150, 0]}]},
                    "allMids": {},
                    "spotClearinghouseState": {"balances": [{"token": 150, "total": "3.5"}]},
                    "borrowLendUserState": {"tokenToState": []}}.get(kind)

        report = w.capture("mainnet", VAULT, assumed=scope(), transport=transport, info=info)
        self.assertTrue(report["scopeIsAssumed"])
        self.assertEqual([entry["id"] for entry in report["reports"]], [150])
        self.assertNotIn("simulation", report["reports"][0])
        self.assertEqual(w.to_send(report), [], "an unsimulated call is not a call to send")
        self.assertNotIn("priceRecord", report)


if __name__ == "__main__":
    unittest.main()
