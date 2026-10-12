"""Metadata preflight keeps partial failures; network is mocked, never signed."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import managed_asset_preflight as p

class AssetPreflightTest(unittest.TestCase):
    def test_wrong_chain_rejected(self):
        with patch.object(p, "rpc", return_value="0x3e6"):
            with self.assertRaises(ValueError):
                p.collect()

    def test_partial_failure_is_retained_not_zeroed(self):
        def rpc(url, method, params):
            if method == "eth_chainId": return hex(999)
            if method == "eth_blockNumber": return "0x123"
            if method == "eth_getBlockByNumber": return {"hash": "0xabc"}
            self.assertEqual(params[-1], "0x123")
            raise ValueError("unavailable")
        with patch.object(p, "rpc", side_effect=rpc):
            result = p.collect()
        self.assertFalse(result["allReadsSucceeded"])
        self.assertEqual(len(result["tokens"]), 3)
        for token in result["tokens"].values():
            self.assertFalse(token["ok"])
            self.assertNotIn("decimals", token)

if __name__ == "__main__": unittest.main()
