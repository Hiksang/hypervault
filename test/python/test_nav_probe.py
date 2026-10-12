import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import nav_probe as p


ACCOUNT = "0x" + "1" * 40


def words(*values):
    return "0x" + "".join(f"{v % 2**256:064x}" for v in values)


class NavProbeTest(unittest.TestCase):
    def test_signed_abi_requires_canonical_sign_extension(self):
        fields = [("value", "int64")]
        self.assertEqual(p.decode_fixed(words(-5), fields), {"value": -5})
        for raw in (words(2**64 - 5), words(2**63), words(-2**63 - 1)):
            with self.assertRaises(ValueError):
                p.decode_fixed(raw, fields)

    def test_malformed_lengths_bool_and_uint_rejected(self):
        for raw in ("0x", "0xgg", words(1, 2), words(2**64)):
            with self.assertRaises(ValueError):
                p.decode_fixed(raw, [("n", "uint64")])
        with self.assertRaises(ValueError):
            p.decode_fixed(words(2), [("flag", "bool")])

    def test_token_metadata_extra_decimals_are_signed(self):
        raw = words(32, 256, 320, 0, 0, 0, 8, 8, -2, 0, 0)
        self.assertEqual(p.decode_token_metadata(raw), {"szDecimals": 8, "weiDecimals": 8, "evmExtraWeiDecimals": -2,
                                                       "evmContract": "0x" + "0" * 40})
        with self.assertRaises(ValueError):
            p.decode_token_metadata(words(64) + raw[66:])

    def test_zero_and_missing_api_are_not_scale_evidence(self):
        self.assertEqual(p.compare_units(0, "0", "0")["classification"], "ZeroHasNoScaleEvidence")
        self.assertEqual(p.compare_units(1, None, "1")["classification"], "MissingEvidence")
        for invalid in ("NaN", "Infinity", "bad"):
            self.assertEqual(p.compare_units(1, invalid, "1")["classification"], "MalformedApiAmount")

    def test_large_integer_comparison_does_not_round_through_float(self):
        r = p.compare_units(18446744073709551615, "184467440737.09551615", "184467440737.09551615")
        self.assertEqual(r["candidateDecimals"], [8])
        self.assertFalse(r["provesUnits"])
        self.assertEqual(p.compare_units(12345, "123.44", "123.46")["classification"], "BracketCompatibleNotProof")

    def test_wrong_address_or_calldata_never_reaches_network(self):
        with patch.object(p, "rpc") as rpc:
            with self.assertRaises(ValueError):
                p.capture("mainnet", ["0x123"])
            rpc.assert_not_called()
        for value in (-1, 2**256, True, "not-an-address"):
            with self.assertRaises(ValueError):
                p.calldata(value)

    def test_malformed_api_token_arrays_are_missing_not_zero(self):
        for value in ({}, {"balances": None}, {"balances": [None]}):
            self.assertIsNone(p.api_token({"spotClearinghouseState": {"ok": True, "value": value}}, "spotClearinghouseState", 0))
        self.assertIsNone(p.api_token({"borrowLendUserState": {"ok": True, "value": {"tokenToState": [[], [0], [0, None]]}}}, "borrowLendUserState", 0))


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.header_calls = 0
        self.reorg = False
        self.fail_lending = False
        self.fail_pin = False
        self.chain = "0x3e7"
        self.tags = []

    def fake_post(self, url, body):
        kind = body["type"]
        if kind == "spotMeta":
            return {"tokens": [{"name": "HYPE", "index": 150}, {"name": "USDC", "index": 0}],
                    "universe": [{"index": 107, "tokens": [150, 0]}]}
        if kind == "meta":
            return {"universe": [{"name": "HYPE", "szDecimals": 2}]}
        if kind == "userAbstraction":
            return "portfolioMargin"
        return {}

    def fake_rpc(self, url, method, params):
        if method == "eth_chainId":
            return self.chain
        if method == "eth_blockNumber":
            return None if self.fail_pin else "0x10"
        if method == "eth_getBlockByNumber":
            self.header_calls += 1
            return {"number": "0x10", "timestamp": "0x100", "hash": "0xb" if self.reorg and self.header_calls > 1 else "0xa"}
        if method != "eth_call":
            raise AssertionError("unexpected method")
        self.tags.append(params[1])
        target = int(params[0]["to"], 16)
        if target == 0x0811 and self.fail_lending:
            raise RuntimeError("PrecompileError")
        if target == 0x080c:
            return words(32, 256, 320, 0, 0, 0, 8, 8, -2, 0, 0)
        if target == 0x080a:
            return words(32, 160, 1, 2, 10, 0, 0)
        lengths = {0x0801: 3, 0x0811: 4, 0x0812: 8, 0x0813: 5, 0x080f: 4}
        return words(*([1] if target in (0x0809, 0x0810) else [0] * lengths.get(target, 1)))

    def capture(self):
        with patch.object(p, "rpc", side_effect=self.fake_rpc), patch.object(p, "post", side_effect=self.fake_post):
            return p.capture("mainnet", [ACCOUNT])

    def test_all_reads_pinned_even_if_api_says_pm_no_mint_authority(self):
        result = self.capture()
        self.assertTrue(result["completePinnedReadSet"])
        self.assertTrue(result["accounts"][ACCOUNT]["pmObservedInBothApiReads"])
        self.assertFalse(result["productionNavReady"])
        self.assertFalse(result["activeDepositsAuthorized"])
        self.assertEqual(set(self.tags), {"0x10"})

    def test_changed_block_hash_invalidates_read_set(self):
        self.reorg = True
        result = self.capture()
        self.assertFalse(result["blockHashStable"])
        self.assertFalse(result["completePinnedReadSet"])

    def test_missing_lending_state_preserves_failure_not_zero(self):
        self.fail_lending = True
        result = self.capture()
        self.assertFalse(result["completePinnedReadSet"])
        account = result["accounts"][ACCOUNT]
        self.assertFalse(account["core"]["lending:0"]["ok"])
        self.assertIsNone(account["unitComparisons"]["lending:0:borrowValue"]["raw"])

    def test_pin_failure_has_no_latest_fallback(self):
        self.fail_pin = True
        with self.assertRaises(ValueError):
            self.capture()
        self.assertEqual(self.tags, [])

    def test_wrong_chain_fails_before_reads(self):
        self.chain = "0x3e6"
        with self.assertRaises(ValueError):
            self.capture()
        self.assertEqual(self.tags, [])


class RecordedEvidenceTest(unittest.TestCase):
    def test_mainnet_fixture_nonzero_lending_and_failed_reads_remain_distinct(self):
        path = Path(__file__).resolve().parents[2] / "docs/reference/nav-mainnet-2026-09-20.json"
        report = json.loads(path.read_text())
        for token, expected in ((150, 8), (0, 8)):
            self.assertEqual(report["sharedCore"][f"tokenInfo:{token}"]["value"]["decoded"]["weiDecimals"], expected)
        system = report["accounts"]["0x" + "b" * 40]
        check = system["unitComparisons"]["lending:150:supplyValue"]
        self.assertEqual(check["candidateDecimals"], [8])
        self.assertGreater(check["raw"], 0)
        self.assertFalse(check["provesUnits"])
        self.assertFalse(report["completePinnedReadSet"])
        self.assertFalse(report["activeDepositsAuthorized"])


if __name__ == "__main__":
    unittest.main()
