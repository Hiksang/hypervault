import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import book_probe as b  # noqa: E402


def word(*values):
    return "0x" + "".join(f"{value:064x}" for value in values)


META = {"universe": [{"index": 107, "name": "@107", "tokens": [150, 0]},
                     {"index": 141, "name": "@141", "tokens": [200, 0]},
                     {"index": 189, "name": "@189", "tokens": [201, 0]},
                     {"index": 200, "name": "@200", "tokens": [202, 0]},
                     {"index": 300, "name": "@300", "tokens": [203, 268]},
                     {"index": 301, "name": "@301", "tokens": [204, 0]}]}
CONTEXTS = [{"coin": "@107", "midPx": "30.0", "markPx": "30.0"}, {"coin": "@141", "midPx": None, "markPx": "0.01"},
            {"coin": "@189", "midPx": None, "markPx": "620.0"}, {"coin": "@200", "midPx": None, "markPx": "1.7"},
            {"coin": "@300", "midPx": None, "markPx": "2.0"}, {"coin": "@301", "midPx": None, "markPx": "5.0"},
            {"prevDayPx": "1"}]
BOOKS = {"@141": [[], [{"px": "0.02"}]], "@189": [[], []], "@200": [[{"px": "1.6"}], []],
         "@301": [[{"px": "4.9"}], [{"px": "5.1"}]]}


class BookProbeTest(unittest.TestCase):
    def test_only_usdc_pairs_without_a_mid_are_candidates(self):
        self.assertEqual([row["pair"] for row in b.candidates(META, CONTEXTS)], [141, 189, 200, 301])
        self.assertEqual(b.candidates(META, CONTEXTS)[1], {"pair": 189, "name": "@189", "apiMarkPx": "620.0"})

    def test_the_empty_side_is_named(self):
        self.assertEqual([b.side({"levels": BOOKS[name]}) for name in ("@141", "@189", "@200", "@301")],
                         ["noBid", "empty", "noAsk", None])

    def test_answers_of_another_length_are_refused(self):
        self.assertEqual(b.words(word(1, 2), 2), [1, 2])
        for raw in ("0x", word(1), word(1, 2, 3), None):
            with self.assertRaises(ValueError):
                b.words(raw, 2)

    def probe(self, reverting=(), failing=None, per_kind=3):
        answers = {b.BBO: {10_141: word(0, 2_000_000), 10_189: word(0, 0), 10_200: word(160_000_000, 0)},
                   b.SPOT_PX: {141: word(1_000_000), 189: word(620_000_000), 200: word(170_000_000)}}
        self.calls = []

        def transport(url, method, params):
            if method == "eth_chainId":
                return "0x3e7"
            if method == "eth_blockNumber":
                return "0x10"
            if method == "eth_getBlockByNumber":
                return {"number": "0x10", "hash": "0xabc"}
            self.assertEqual((method, params[1]), ("eth_call", "0x10"), "every precompile read is pinned")
            to, argument = params[0]["to"], int(params[0]["data"], 16)
            self.calls.append((to, argument))
            if (to, argument) == failing:
                raise RuntimeError({"code": -32005, "message": "rate limited"})
            if (to, argument) in reverting:
                raise RuntimeError({"code": 3, "message": "execution reverted"})
            return answers[to][argument]

        def info(body):
            if body["type"] == "spotMetaAndAssetCtxs":
                return [META, CONTEXTS]
            self.assertEqual(body["type"], "l2Book")
            return {"levels": BOOKS[body["coin"]]}

        return b.capture("mainnet", per_kind, transport=transport, info=info)

    def test_an_empty_side_answered_with_zero_and_a_mark_that_stays(self):
        report = self.probe()
        self.assertEqual((report["kind"], report["evmBlock"], report["infoBlockPinned"]),
                         ("READ_ONLY_BOOK_PROBE", "0x10", False))
        self.assertEqual([(row["pair"], row["apiBook"]) for row in report["rows"]],
                         [(141, "noBid"), (189, "empty"), (200, "noAsk")], "a two-sided book is not sampled")
        self.assertEqual([(row["bbo"]["bid"], row["bbo"]["ask"]) for row in report["rows"]],
                         [(0, 2_000_000), (0, 0), (160_000_000, 0)])
        self.assertEqual(report["rows"][1]["spotPx"]["price"], 620_000_000)
        self.assertEqual(report["summary"], {"bboReverted": 0, "emptyBidSides": 2, "emptyBidSidesReadAsZero": 2,
                                             "emptyAskSides": 2, "emptyAskSidesReadAsZero": 2, "spotPxReverted": 0,
                                             "spotPxNonZero": 3})
        self.assertEqual(report["sampled"], {"empty": 1, "noBid": 1, "noAsk": 1})
        self.assertTrue(report["blockHashStable"])

    def test_a_revert_is_recorded_and_a_transport_failure_is_not_an_answer(self):
        report = self.probe(reverting={(b.BBO, 10_189), (b.SPOT_PX, 200)})
        self.assertEqual(report["rows"][1]["bbo"]["ok"], False)
        self.assertIn("execution reverted", report["rows"][1]["bbo"]["error"])
        self.assertEqual((report["summary"]["bboReverted"], report["summary"]["spotPxReverted"]), (1, 1))
        self.assertEqual((report["summary"]["emptyBidSides"], report["summary"]["emptyBidSidesReadAsZero"]), (1, 1))
        with self.assertRaisesRegex(RuntimeError, "rate limited"):
            self.probe(failing=(b.BBO, 10_141))

    def test_sampling_stops_at_the_limit_per_kind(self):
        report = self.probe(per_kind=0)
        self.assertEqual((report["rows"], self.calls, report["candidates"]), ([], [], 4))


if __name__ == "__main__":
    unittest.main()
