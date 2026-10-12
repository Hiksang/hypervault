from decimal import Decimal
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import equity_probe as p


ACCOUNT = "0x" + "1" * 40
DEXES = [{"index": 0, "name": "", "collateralToken": 0}, {"index": 1, "name": "xyz", "collateralToken": 0}]
HLP = "0x" + "d" * 40


def ok(decoded):
    return {"ok": True, "value": {"decoded": decoded}}


def info(mode, totals, values, lending=(), vaults=None):
    bundle = {"userAbstraction": {"ok": True, "value": mode},
              "userVaultEquities": {"ok": True, "value": [{"vaultAddress": a, "equity": e}
                                                          for a, e in (vaults or {}).items()]},
              "spotClearinghouseState": {"ok": True, "value": {
                  "balances": [{"token": t, "total": v} for t, v in totals.items()]}},
              "borrowLendUserState": {"ok": True, "value": {"tokenToState": [[t, {}] for t in lending]}}}
    for index, value in values.items():
        bundle[f"clearinghouseState:{index}"] = {"ok": True, "value": {"marginSummary": {"accountValue": value}}}
    return bundle


def record(mode, core, totals, values, tokens=(0,), lending=(), vaults=None):
    api = info(mode, totals, values, lending, vaults)
    return {"tokens": list(tokens), "vaults": list(vaults or {}), "weiDecimals": {"0": 8, "150": 8},
            "infoBefore": api, "infoAfter": api, "core": core}


def margin(value):
    return ok({"accountValue": value, "marginUsed": 0, "ntlPos": 0, "rawUsd": value})


class EquityProbeTest(unittest.TestCase):
    def test_classification_keeps_missing_and_mismatch_apart(self):
        self.assertEqual(p.classify(Decimal("1.5"), "1.5", "1.7"), "ExactAtApiRead")
        self.assertEqual(p.classify(Decimal("1.6"), "1.5", "1.7"), "BracketCompatibleNotProof")
        self.assertEqual(p.classify(Decimal("1.8"), "1.5", "1.7"), "Mismatch")
        self.assertEqual(p.classify(Decimal("0"), None, "0"), "MissingEvidence")
        self.assertEqual(p.classify(None, "0", "0"), "MissingEvidence")
        # The API truncates after combining interest-bearing values: one raw unit, never more.
        unit = Decimal("0.00000001")
        self.assertEqual(p.classify(Decimal("5649.36223386"), "5649.36223385", "5649.36223385", unit), "WithinOneRawUnit")
        self.assertEqual(p.classify(Decimal("5649.36223387"), "5649.36223385", "5649.36223385", unit), "Mismatch")

    def test_unified_total_is_raw_spot_plus_every_dex_equity(self):
        # Public mainnet account at EVM block 0x2d6edd0; lending read failed and is not zero evidence.
        core = {"spot:0": ok({"total": 9311046256200, "hold": 0, "entryNtl": 0}),
                "lending:0": {"ok": False, "error": "PrecompileError"},
                "margin:0": margin(5596630612), "margin:1": margin(401498746)}
        row = record("unifiedAccount", core, {0: "99108.59192"}, {0: "5596.630612", 1: "401.498746"})
        result = p.reconcile(row, DEXES)
        token = result["tokens"]["0"]
        self.assertTrue(result["consistent"])
        self.assertEqual(token["classification"], "ExactAtApiRead")
        self.assertEqual(token["checks"]["rawSpot"], "Mismatch")
        self.assertEqual(token["lendingState"], "precompileError")
        self.assertEqual(Decimal(token["equity"]), Decimal("99108.59192"))
        self.assertTrue(result["lendingReadsMatchApiState"])

    def test_portfolio_margin_total_adds_lending_and_equity_is_mode_free(self):
        core = {"spot:0": ok({"total": 0, "hold": 0, "entryNtl": 0}),
                "lending:0": ok({"borrowBasis": 1, "borrowValue": 8937185103020, "supplyBasis": 0, "supplyValue": 0}),
                "spot:150": ok({"total": 0, "hold": 0, "entryNtl": 0}),
                "lending:150": ok({"borrowBasis": 0, "borrowValue": 0, "supplyBasis": 1, "supplyValue": 195934874775}),
                "margin:0": margin(35473443945), "margin:1": margin(0)}
        row = record("portfolioMargin", core, {0: "-53898.4070852", 150: "1959.34874775"},
                     {0: "35473.443945", 1: "0.0"}, tokens=(0, 150), lending=(0, 150))
        result = p.reconcile(row, DEXES)
        self.assertTrue(result["consistent"])
        self.assertEqual(Decimal(result["tokens"]["0"]["equity"]), Decimal("-53898.4070852"))
        self.assertEqual(result["tokens"]["150"]["classification"], "ExactAtApiRead")
        row["infoBefore"]["userAbstraction"]["value"] = row["infoAfter"]["userAbstraction"]["value"] = "disabled"
        # Standard accounts show raw spot in the API, yet the equity formula does not change.
        standard = p.reconcile(row, DEXES)
        self.assertFalse(standard["consistent"])
        self.assertEqual(Decimal(standard["tokens"]["0"]["equity"]), Decimal("-53898.4070852"))

    def test_saved_mainnet_evidence_reconciles_in_every_mode(self):
        path = Path(__file__).resolve().parents[2] / "docs/reference/managed-equity-modes-rerun-2026-10-04.json"
        report = json.loads(path.read_text())
        modes, tokens, dexes = set(), [], []
        for row in report["accounts"].values():
            result = p.reconcile(row, report["dexes"])
            self.assertEqual(result, row["reconciliation"])
            modes.add(result["mode"])
            tokens += [t["classification"] for t in result["tokens"].values()]
            dexes += [d["classification"] for d in result["dexes"].values() if d.get("accountValue") != "0"]
            # An unknown DEX index and a missing lending ledger are precompile errors, never zeros.
            self.assertFalse(row["core"][f"marginOutOfRange:{len(report['dexes'])}"]["ok"])
            self.assertTrue(result["lendingReadsMatchApiState"])
        self.assertEqual(modes, {"disabled", "default", "unifiedAccount", "portfolioMargin"})
        self.assertNotIn("Mismatch", tokens)
        self.assertNotIn("MissingEvidence", tokens)
        self.assertEqual(set(dexes), {"ExactAtApiRead"})
        self.assertGreaterEqual(len(dexes), 20)
        self.assertFalse(report["productionNavReady"] or report["activeDepositsAuthorized"])

    def test_missing_margin_or_spot_is_never_zero(self):
        core = {"spot:0": ok({"total": 5, "hold": 0, "entryNtl": 0}), "margin:0": margin(0),
                "margin:1": {"ok": False, "error": "PrecompileError"}}
        result = p.reconcile(record("unifiedAccount", core, {0: "0.00000005"}, {0: "0.0"}), DEXES)
        self.assertFalse(result["consistent"])
        self.assertEqual(result["dexes"]["1"]["classification"], "MissingEvidence")
        core = {"margin:0": margin(0), "margin:1": margin(0)}
        result = p.reconcile(record("unifiedAccount", core, {0: "0"}, {0: "0.0", 1: "0.0"}), DEXES)
        self.assertFalse(result["consistent"])
        self.assertEqual(result["tokens"]["0"]["classification"], "MissingEvidence")

    def test_vault_equity_is_six_decimals_and_a_failed_read_is_not_zero(self):
        core = {"spot:0": ok({"total": 0, "hold": 0, "entryNtl": 0}), "margin:0": margin(0), "margin:1": margin(0),
                f"vaultEquity:{HLP}": ok({"equity": 252808968643, "lockedUntilTimestamp": 1})}
        row = record("default", core, {0: "0"}, {0: "0.0", 1: "0.0"}, vaults={HLP: "252808.968643"})
        result = p.reconcile(row, DEXES)
        self.assertTrue(result["consistent"])
        self.assertEqual(result["vaults"][HLP], {"equity": "252808.968643", "classification": "ExactAtApiRead"})
        row["core"][f"vaultEquity:{HLP}"] = {"ok": False, "error": "PrecompileError"}
        self.assertEqual(p.reconcile(row, DEXES)["vaults"][HLP]["classification"], "PrecompileError")
        row["core"][f"vaultEquity:{HLP}"] = ok({"equity": 1, "lockedUntilTimestamp": 1})
        self.assertFalse(p.reconcile(row, DEXES)["consistent"])

    def test_batches_respect_rpc_limit_and_keep_failed_calls(self):
        jobs = {f"spot:{i}": (0x0801, "0x", [("total", "uint64")]) for i in range(p.MAX_BATCH + 3)}
        sizes = []

        def reply(_url, body):
            sizes.append(len(body))
            return [{"id": call["id"], "error": {"code": -32003}} if call["id"] == 1
                    else {"id": call["id"], "result": "0x" + f"{call['id']:064x}"} for call in body]

        with patch.object(p, "post", side_effect=reply):
            result = p.batch_calls("rpc", "0x1", jobs)
        self.assertEqual(sizes, [p.MAX_BATCH, 3])
        self.assertFalse(result["spot:1"]["ok"])
        self.assertEqual(result[f"spot:{p.MAX_BATCH + 2}"]["value"]["decoded"], {"total": p.MAX_BATCH + 2})
        with patch.object(p, "post", return_value={"error": {"message": "rate limited"}}):
            with self.assertRaises(p.RateLimited):
                p.batch_calls("rpc", "0x1", jobs)
        with patch.object(p, "post", return_value={"error": {"message": "The batch request was too large"}}):
            with self.assertRaises(ValueError):
                p.batch_calls("rpc", "0x1", jobs)

    def test_invalid_account_never_reaches_network(self):
        with patch.object(p, "rpc") as rpc, patch.object(p, "post") as post:
            with self.assertRaises(ValueError):
                p.capture("mainnet", ["0x123"])
            with self.assertRaises(ValueError):
                p.capture("mainnet", [ACCOUNT] * 0)
            rpc.assert_not_called()
            post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
