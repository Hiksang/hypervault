import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import precompile_gas_probe as probe  # noqa: E402

EVIDENCE = Path(__file__).resolve().parents[2] / "docs/reference/managed-precompile-gas-2026-10-04.json"


class PrecompileGasProbeTest(unittest.TestCase):
    def test_arguments_are_abi_encoded_with_dynamic_offsets(self):
        encoded = probe.encode_arguments("0x" + "0" * 36 + "0811", "0x" + "ab" * 64, [7, 20_000])
        words = [encoded[i:i + 64] for i in range(0, len(encoded), 64)]
        self.assertEqual(int(words[0], 16), 0x0811)
        self.assertEqual(int(words[1], 16), 0x60)
        self.assertEqual(int(words[2], 16), 0x60 + 32 + 64)  # after the length word and two data words
        self.assertEqual(int(words[3], 16), 64)
        self.assertEqual(words[4] + words[5], "ab" * 64)
        self.assertEqual([int(w, 16) for w in words[6:]], [2, 7, 20_000])
        empty = probe.encode_arguments("0x" + "0" * 36 + "0809", "0x", [1])
        self.assertEqual(int(empty[128:192], 16), 0x60 + 32)  # empty input still has its length word

    def test_result_decoding_rejects_a_short_or_mismatched_answer(self):
        def array(values):
            return probe.word(len(values)) + "".join(probe.word(v) for v in values)

        body = probe.word(0x60) + probe.word(0x60 + 96) + probe.word(0x60 + 192)
        body += array([1, 0]) + array([7796, 20365]) + array([128, 0])
        self.assertEqual(probe.decode_result("0x" + body, 2), ([True, False], [7796, 20365], [128, 0]))
        with self.assertRaises(ValueError):
            probe.decode_result("0x" + body, 3)
        with self.assertRaises(ValueError):
            probe.decode_result("0x" + body[:-64], 2)

    def test_minimal_cap_needs_the_failing_neighbour(self):
        rows = [{"gasCap": 7335, "ok": False}, {"gasCap": 7336, "ok": True}, {"gasCap": 20000, "ok": True}]
        self.assertEqual(probe.minimal_cap(rows), 7336)
        self.assertIsNone(probe.minimal_cap(rows[1:]), "a success alone does not locate the boundary")
        self.assertIsNone(probe.minimal_cap([{"gasCap": 20000, "ok": False}]))

    def test_saved_mainnet_measurement(self):
        report = json.loads(EVIDENCE.read_text())
        self.assertTrue(report["blockHashStable"] and report["allMeasured"])
        self.assertEqual(report["blockGasLimit"], 3_000_000)
        cases = report["cases"]
        for name, entry in cases.items():
            if name == "lending:noLedger":
                continue
            # Every boundary sat at 1000 + 33 * (input + output), about half the documented cost.
            self.assertEqual(entry["minimalCap"], probe.fitted_cost(entry["inputBytes"], entry["outputBytes"]), name)
            self.assertLess(entry["minimalCap"], entry["documentedCost"], name)
            spent = {row["gasUsedByCaller"] for row in entry["rows"] if row["ok"] and row["gasCap"] > entry["minimalCap"] + 1}
            self.assertLessEqual(max(spent) - min(spent), 16, "a successful read costs the same under any larger cap")
        # The source's 20,000-gas ledger probe: an existing ledger answers, a missing one burns the allowance.
        ledger = {row["gasCap"]: row for row in cases["lending:ledger"]["rows"]}
        self.assertTrue(ledger[20_000]["ok"] and ledger[20_000]["returnBytes"] == 128)
        for row in cases["lending:noLedger"]["rows"]:
            self.assertFalse(row["ok"])
            self.assertEqual(row["returnBytes"], 0)
            self.assertGreaterEqual(row["gasUsedByCaller"], row["gasCap"], "an error consumes the whole call frame")
            self.assertLess(row["gasUsedByCaller"], row["gasCap"] + 1_000)


if __name__ == "__main__":
    unittest.main()
