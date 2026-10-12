import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from nav_reconcile import analyze


class ReconciliationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[2] / "docs/reference/nav-pm-hype-carry-2026-09-21.json"
        cls.sample = json.loads(path.read_text())

    def test_live_pm_size_and_quote_identity_match_without_double_pnl(self):
        report = analyze(self.sample)
        account = next(iter(report["accounts"].values()))
        self.assertTrue(account["pmObservedInBothApiReads"])
        self.assertEqual(account["position"]["rawSzi"], -141643)
        self.assertEqual(account["position"]["humanSize"], "-1416.43")
        self.assertTrue(account["position"]["matchesApiAfter"])
        self.assertEqual(account["identities"]["USDC"]["candidate"], "-30934.88378434")
        self.assertEqual(account["identities"]["USDC"]["classification"], "BracketCompatibleNotProof")
        self.assertFalse(report["productionNavReady"])
        self.assertFalse(report["activeDepositsAuthorized"])

    def test_missing_lending_never_becomes_a_zero_liability(self):
        sample = copy.deepcopy(self.sample)
        account = next(iter(sample["accounts"].values()))
        account["core"]["lending:0"] = {"ok": False, "error": "PrecompileError"}
        result = next(iter(analyze(sample)["accounts"].values()))
        self.assertIn("USDC", result["missingReads"])
        self.assertNotIn("USDC", result["identities"])

    def test_unexpected_equity_cannot_be_reconciled_as_matching(self):
        sample = copy.deepcopy(self.sample)
        account = next(iter(sample["accounts"].values()))
        account["core"]["margin"]["value"]["decoded"]["accountValue"] += 10**9
        result = next(iter(analyze(sample)["accounts"].values()))
        self.assertEqual(result["identities"]["USDC"]["classification"], "MismatchOrOtherExposure")


if __name__ == "__main__":
    unittest.main()
