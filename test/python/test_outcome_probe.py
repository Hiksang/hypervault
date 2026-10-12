import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import outcome_probe as p
from nav_probe import decode_token_metadata

class OutcomeProbeTests(unittest.TestCase):
    def test_encoded_side_and_uint32_bounds(self):
        self.assertEqual(p.encoded_asset(42, 1), 100000421)
        for outcome, side in [(-1, 0), (42, 2), (42, -1), (True, 0), (42, True), (2**32, 0)]:
            with self.assertRaises(ValueError): p.encoded_asset(outcome, side)

    def test_saved_mainnet_metadata_identifies_circle_not_usdc_erc20(self):
        root=Path(__file__).resolve().parents[2]
        raw=json.loads((root/'docs/reference/managed-precompile-modes-2026-10-04.json').read_text())
        info=decode_token_metadata(raw['sharedCore']['tokenInfo:0']['value']['raw'])
        self.assertEqual(info['evmContract'], '0x6b9e773128f453f5c2c60935ee2de2cbc5390a24')
        self.assertEqual(info['weiDecimals']+info['evmExtraWeiDecimals'],6)
        self.assertFalse(raw['completePinnedReadSet'])

    def test_saved_outcome_failures_are_retained_and_do_not_authorize_nav(self):
        root=Path(__file__).resolve().parents[2]
        raw=json.loads((root/'docs/reference/managed-outcome-precompile-2026-10-04.json').read_text())
        self.assertTrue(raw['blockHashStable'])
        self.assertFalse(raw['productionNavReady'])
        for side in (0,1):
            asset=p.encoded_asset(1473,side)
            row=raw['core'][f'tokenInfoEncoded:{asset}']
            self.assertFalse(row['ok']); self.assertIn('error',row); self.assertNotIn('value',row)
            self.assertTrue(raw['core'][f'price:{asset}']['ok'])
        self.assertEqual(raw['core']['status:1473']['value']['decoded']['status'],1)

    def test_saved_expiry_changes_status_and_removes_balance_read_support(self):
        root=Path(__file__).resolve().parents[2]/'docs/reference'
        before=json.loads((root/'managed-outcome-precompile-2026-10-04.json').read_text())
        after=json.loads((root/'managed-outcome-after-expiry-2026-10-04.json').read_text())
        self.assertEqual(before['core']['status:8298']['value']['decoded']['status'],1)
        status=after['core']['status:8298']['value']['decoded']
        self.assertEqual(status['status'],2)
        self.assertEqual(status['settledValue'],0) # valid settlement to No, not unknown/never existed
        self.assertTrue(after['blockHashStable'])
        for side in (0,1):
            row=after['core'][f'spot:{p.encoded_asset(8298,side)}']
            self.assertFalse(row['ok']); self.assertNotIn('value',row)

if __name__=='__main__': unittest.main()
