import unittest
from compare_bun_runs import compare
from test_compact_bunfailures import report,case

class TestMatchedRuns(unittest.TestCase):
    def test_repeated_names_fail_only_if_change_ambiguous(self):
        failed=case("a.test.ts","same assertion")
        self.assertEqual(compare(report(failed,failed),report(failed,failed),1,1)["changeCount"],0)
        with self.assertRaises(ValueError):
            compare(report(failed,failed),report(failed,case("a.test.ts","changed")),1,1)
    def test_exact_transition(self):
        before=report(case("a.test.ts","literal failure"))
        after=report('<testcase file="a.test.ts" name="assertion secret-name"/>',failures=0)
        r=compare(before,after,1,0)
        self.assertEqual(r["changes"][0]["change"],"fixed")
        self.assertEqual(r["tests"],1)
        self.assertNotIn("literal failure",str(r))
    def test_partial_file_list_does_not_compare(self):
        a=report(case("a.test.ts","literal failure"),case("b.test.ts","other"))
        with self.assertRaises(ValueError):
            compare(a,report(case("a.test.ts","literal failure")),1,1)
    def test_runner_and_xml_must_agree(self):
        a=report(case("a.test.ts","literal failure"))
        with self.assertRaises(ValueError):
            compare(a,a,0,1)
