import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from action_status import classify_response, validated_hex


ACCOUNT = "0x" + "a" * 40
CLOID = "0x" + "0" * 31 + "1"


class ActionStatusTest(unittest.TestCase):
    def response(self, status, cloid=CLOID):
        return {"status": "order", "order": {"status": status, "order": {"cloid": cloid}}}

    def test_terminal_http_reports_never_authorize_retry(self):
        for status in ("filled", "canceled", "rejected", "iocCancelRejected", "marginCanceled"):
            report = classify_response(ACCOUNT, CLOID, self.response(status))
            self.assertEqual(report["classification"], "TerminalApiReport")
            self.assertFalse(report["onchainRetryAuthorized"])
            self.assertFalse(report["blockPinned"])

    def test_unknown_oid_is_not_rejection_or_zero_fill(self):
        report = classify_response(ACCOUNT, CLOID, {"status": "unknownOid"})
        self.assertEqual(report["classification"], "NotFoundNotFailure")
        self.assertFalse(report["onchainRetryAuthorized"])

    def test_wrong_cloid_cannot_be_correlated(self):
        report = classify_response(ACCOUNT, CLOID, self.response("filled", "0x" + "2" * 32))
        self.assertEqual(report["classification"], "Uncorrelated")

    def test_new_status_is_not_implicitly_terminal(self):
        self.assertEqual(classify_response(ACCOUNT, CLOID, self.response("futureRejected"))["classification"], "Unrecognized")

    def test_malformed_and_nonterminal_responses(self):
        for raw in (None, [], {}, {"status": "order", "order": None}, self.response([])):
            self.assertEqual(classify_response(ACCOUNT, CLOID, raw)["classification"], "Unrecognized")
        self.assertEqual(classify_response(ACCOUNT, CLOID, self.response("open"))["classification"], "NonterminalApiReport")

    def test_bad_address_and_cloid_are_rejected(self):
        for value, count in (("0x1", 16), (ACCOUNT, 16), ("0x" + "g" * 40, 20)):
            with self.assertRaises(ValueError):
                validated_hex(value, count)


if __name__ == "__main__":
    unittest.main()
