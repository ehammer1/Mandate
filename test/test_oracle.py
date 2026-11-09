"""Oracle tests with a stubbed Claude client (no API key or network needed).

Run: python3 -m unittest discover -s test -p 'test_*.py'
"""

import asyncio
import json
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from oracle import redact, review  # noqa: E402
from oracle.claude_call import OracleError  # noqa: E402


class _Msg:
    def __init__(self, text, stop="end_turn"):
        self.content = [types.SimpleNamespace(type="text", text=text)]
        self.stop_reason = stop
        self.stop_details = None
        self._request_id = "req_test"


class _Stream:
    def __init__(self, fn, kwargs):
        self.fn, self.kwargs = fn, kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get_final_message(self):
        return self.fn(self.kwargs)


def stub_client(fn):
    """fn(request_kwargs) -> _Msg"""
    calls = []

    def stream(**kw):
        calls.append(kw)
        return _Stream(fn, kw)

    async def close():
        pass

    c = types.SimpleNamespace(beta=types.SimpleNamespace(messages=types.SimpleNamespace(stream=stream)), close=close)
    c.calls = calls
    return c


def run(coro):
    return asyncio.run(coro)


# ---------------------------------------------------------------- review.py

SPEC = {
    "title": "Publish the 2027 city budget",
    "description": "Line-item budget must be public.",
    "criteria": [
        {"id": "c1", "text": "All line items above $10k are listed"},
        {"id": "c2", "text": "Published as CSV"},
        {"id": "c3", "text": "Has a plain-language summary", "required": False},
    ],
}
EVIDENCE = "City of Example, FY2027.\nEvery line item above $10,000 is listed below.\nFormat: budget.csv (CSV)\n"


def verdicts(**by_id):
    def fn(_kw):
        items = [
            {"id": cid, "met": v[0], "evidence_quote": v[1], "reasoning": "r"} for cid, v in by_id.items()
        ]
        return _Msg(json.dumps({"criteria": items, "summary": "s"}))

    return fn


class ReviewTests(unittest.TestCase):
    def test_approves_when_required_criteria_grounded(self):
        client = stub_client(
            verdicts(
                c1=("yes", "Every line item above $10,000 is listed below."),
                c2=("yes", "Format: budget.csv (CSV)"),
                c3=("no", ""),
            )
        )
        r = run(review.review_evidence(SPEC, EVIDENCE, client))
        self.assertTrue(r.approve, r.failures)
        req = client.calls[0]
        self.assertEqual(req["output_config"]["format"]["type"], "json_schema")
        self.assertIn("<evidence>", req["messages"][0]["content"])

    def test_hallucinated_quote_downgrades_yes(self):
        client = stub_client(
            verdicts(c1=("yes", "All items over ten thousand are listed"), c2=("yes", "Format: budget.csv (CSV)"))
        )
        r = run(review.review_evidence(SPEC, EVIDENCE, client))
        self.assertFalse(r.approve)
        c1 = r.criteria[0]
        self.assertEqual((c1.model_verdict, c1.verdict, c1.quote_found), ("yes", "unclear", False))
        self.assertIn("c1: supporting quote not found in evidence", r.failures)

    def test_missing_and_negative_verdicts_reject(self):
        r = run(review.review_evidence(SPEC, EVIDENCE, stub_client(verdicts(c1=("no", "")))))
        self.assertFalse(r.approve)
        self.assertEqual(r.failures, ["c1: no", "c2: model returned no verdict"])

    def test_quote_match_ignores_whitespace_and_case(self):
        client = stub_client(
            verdicts(
                c1=("yes", "every  line item above $10,000\nis listed below."),
                c2=("yes", "FORMAT: budget.csv (CSV)"),
            )
        )
        self.assertTrue(run(review.review_evidence(SPEC, EVIDENCE, client)).approve)

    def test_malformed_json_and_refusal_raise_oracle_error(self):
        with self.assertRaises(OracleError):
            run(review.review_evidence(SPEC, EVIDENCE, stub_client(lambda kw: _Msg("not json"))))
        with self.assertRaises(OracleError):
            run(review.review_evidence(SPEC, EVIDENCE, stub_client(lambda kw: _Msg("", "refusal"))))

    def test_bad_inputs(self):
        ok = stub_client(verdicts())
        for bad in ({}, {"title": "t"}, {"title": "t", "criteria": [{"id": "a", "text": ""}]},
                    {"title": "t", "criteria": [{"id": "a", "text": "x"}, {"id": "a", "text": "y"}]}):
            with self.assertRaises(ValueError):
                run(review.review_evidence(bad, EVIDENCE, ok))
        with self.assertRaises(ValueError):
            run(review.review_evidence(SPEC, "   ", ok))


# ---------------------------------------------------------------- redact.py

DOC = "MEMO 1963-11-22\n\nAgent John Doe met source at 0900.\nCipher key: ALPHA-7.\n" * 3


def echo(transform=lambda d: d):
    def fn(kw):
        doc = kw["messages"][0]["content"].split("<document>\n", 1)[1].rsplit("\n</document>", 1)[0]
        return _Msg(transform(doc))

    return fn


class RedactTests(unittest.TestCase):
    def test_clean_document_verifies(self):
        r = run(redact.process_and_redact_document(DOC, stub_client(echo())))
        self.assertEqual(r.text, DOC)
        self.assertTrue(r.verification.verified)

    def test_new_redactions_fail_idempotence_but_keep_layout(self):
        r = run(redact.process_and_redact_document(
            DOC, stub_client(echo(lambda d: d.replace("John Doe", redact.REDACTION_MARKER)))))
        v = r.verification
        self.assertEqual((v.verified, v.layout_preserved, v.redactions_added), (False, True, 3))

    def test_rewording_fails_layout(self):
        r = run(redact.process_and_redact_document(
            DOC, stub_client(echo(lambda d: d.replace("met source", "briefed an asset")))))
        self.assertFalse(r.verification.layout_preserved)
        self.assertIn("unexplained", r.verification.failures[0])

    def test_chunking_round_trips(self):
        big = ("para line\n" * 50 + "\n") * 400
        chunks = redact._split_chunks(big, 10_000)
        self.assertEqual("".join(chunks), big)
        self.assertTrue(len(chunks) > 1 and all(len(c) <= 10_000 for c in chunks))
        self.assertEqual(run(redact.process_and_redact_document(big, stub_client(echo()))).text, big)

    def test_refusal_raises(self):
        with self.assertRaises(OracleError):
            run(redact.process_and_redact_document(DOC, stub_client(lambda kw: _Msg("", "refusal"))))


if __name__ == "__main__":
    unittest.main()
