import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import managed_mainnet as m
import managed_agent_smoke as a
import check_managed_storage as layout


class ManagedMainnetToolsTest(unittest.TestCase):
    def transport(self, url, method, params):
        if method == "eth_chainId": return "0x3e7"
        if method == "eth_blockNumber": return "0x123"
        if method == "eth_getBlockByNumber": return {"number": "0x123", "hash": "0xabc"}
        self.assertEqual(params[-1], "0x123")
        if method == "eth_getCode": return "0x6000"
        if method == "eth_call":
            data = params[0]["data"]
            if data == "0x313ce567": return "0x" + format(6, "064x")
            if params[0]["to"].endswith("0801"): return "0x" + "0" * 192
            return "0x" + format(1, "064x")
        raise AssertionError(method)

    def test_pins_all_evm_reads_and_never_certifies_http(self):
        seen = []
        result = m.snapshot(account="0x" + "1" * 40, dexes=["xyz"], transport=self.transport,
                            info=lambda body: seen.append(body) or [])
        self.assertTrue(result["allReadsSucceeded"])
        self.assertFalse(result["httpScope"]["completePortfolio"])
        self.assertFalse(result["httpScope"]["blockPinned"])
        self.assertTrue(all(row["user"] == "0x" + "1" * 40 for row in seen))
        self.assertIn({"type": "openOrders", "user": "0x" + "1" * 40, "dex": "xyz"}, seen)

    def test_failed_read_is_preserved_not_zero(self):
        def broken(url, method, params):
            if method == "eth_call" and params[0]["to"].endswith("0809"):
                raise RuntimeError("private endpoint must not be logged")
            return self.transport(url, method, params)
        result = m.snapshot(transport=broken)
        self.assertFalse(result["allReadsSucceeded"])
        self.assertEqual(result["checks"]["coreBlock"], {"ok": False, "errorType": "RuntimeError"})

    def test_wrong_chain_and_reorg_rejected(self):
        with self.assertRaises(ValueError): m.snapshot(transport=lambda *args: "0x3e6")
        with self.assertRaises(ValueError): m.same_hash({"hash": "a"}, {"hash": "b"})
        with self.assertRaises(ValueError): m.uint_words("0x", 1)

    def test_creation_does_not_assert_core_success(self):
        creator, factory = "0x" + "1" * 40, "0x" + "2" * 40
        state = dict(owner=creator, deploymentFactory=factory, founderShares=100_000_000_000,
                     founderBasis=100_000_000, phase=1, coreActivated=False, isVault=True,
                     activationCost=1_000_000, blockNumber="0x123")
        receipt = {"status": "0x1", "blockNumber": "0x123"}
        self.assertEqual(m.assert_creation(receipt, state, creator, factory, 1_000_000)["coreActivation"], "NOT_ASSERTED")
        state["founderShares"] += 1
        with self.assertRaises(ValueError): m.assert_creation(receipt, state, creator, factory, 1_000_000)

    def test_order_caps_precision_and_mainnet_market(self):
        market = dict(network="mainnet", kind="hip3", asset=100000, symbol="test:TEST",
                      metadataEvidence="fixture-only", maxNotional="20", priceDecimals=2, sizeDecimals=3)
        cloid = "0x" + "a" * 32
        action = a.build_action(market, "buy", "10.12", "1", cloid)
        self.assertEqual(action["orders"][0]["t"], {"limit": {"tif": "Alo"}})
        for price, size in [("30", "1"), ("NaN", "1"), ("1", "0"), ("1.123", "1"), ("1", "0.0001")]:
            with self.assertRaises(ValueError): a.build_action(market, "buy", price, size, cloid)
        self.assertEqual(a.build_action(market, "buy", "0", "0", cloid, cancel=True)["cancels"][0]["asset"], 100000)

    def test_agent_registration_and_nested_order_error(self):
        signer = "0x" + "a" * 40
        self.assertTrue(a.registered([{"address": signer, "validUntil": 101}], signer, 100))
        self.assertFalse(a.registered([{"address": signer, "validUntil": 100}], signer, 100))
        self.assertFalse(a.accepted({"status": "ok", "response": {"data": {"statuses": [{"error": "bad order"}]}}}))
        self.assertTrue(a.accepted({"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": 1}}]}}}))

    def test_storage_gate_rejects_nested_accounting_type_change(self):
        baseline = {"storage": [{"label": "requests", "slot": "0", "offset": 0, "type": "map"}],
                    "types": {"map": {"encoding": "mapping", "numberOfBytes": "32", "label": "mapping(uint256 => uint256)",
                                      "key": "u", "value": "u"},
                              "u": {"encoding": "inplace", "numberOfBytes": "32", "label": "uint256"}}}
        modified = copy.deepcopy(baseline)
        modified["types"]["map"]["value"] = "addr"
        modified["types"]["addr"] = {"encoding": "inplace", "numberOfBytes": "20", "label": "address"}
        with self.assertRaises(ValueError): layout.check(baseline, modified)
        modified = copy.deepcopy(baseline)
        modified["storage"].append({"label": "newField", "slot": "1", "offset": 0, "type": "u"})
        self.assertEqual(layout.check(baseline, modified), 1)


if __name__ == "__main__": unittest.main()
