import unittest
from example_smoke import summarize

def junit(failed=False):
    rows = '<testcase file="examples/fixture.test.ts" name="one">'
    if failed:
        rows += '<failure type="AssertionError" message="fixture only"/>'
    rows += '</testcase><testcase file="examples/fixture.test.ts" name="two"/>'
    return f'<testsuites name="bun test" tests="2" failures="{int(failed)}" errors="0" skipped="0"><testsuite>{rows}</testsuite></testsuites>'.encode()

class ExampleSmokeTests(unittest.TestCase):
    def test_reports_exact_fix_and_missing_file(self):
        result = summarize(junit(True), junit(), 1, 0)
        self.assertEqual(result["test_count"], 2)
        self.assertEqual(result["fixes"], 1)
        self.assertEqual(result["wrong_scope"], "unverified")
        self.assertNotIn("fixture only", str(result))
    def test_rejects_exit_mismatch(self):
        with self.assertRaises(ValueError):
            summarize(junit(True), junit(), 0, 0)
    def test_rejects_unexpected_still_passing_baseline(self):
        with self.assertRaises(ValueError):
            summarize(junit(), junit(), 0, 0)
