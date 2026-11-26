import json
import unittest
from compact_bun_failures import snap

def report(*rows, failures=None):
    n=len(rows)
    f=n if failures is None else failures
    return (f'<testsuites name="bun test" tests="{n}" failures="{f}" errors="0" skipped="0"><testsuite>'+''.join(rows)+'</testsuite></testsuites>').encode()

def case(path,msg):
    return f'<testcase file="{path}" name="assertion secret-name"><failure type="AssertionError" message="{msg}">secret-body</failure><system-out>private logs</system-out></testcase>'

class FailureTests(unittest.TestCase):
    def test_group_and_redact(self):
        r=snap(report(case("apps/api/alpha.test.ts","private-token"),case("apps/web/beta.test.ts","private-token")))
        self.assertEqual((r["clusterCount"],r["clusters"][0]["count"]),(1,2))
        self.assertNotIn("secret",json.dumps(r))
        self.assertNotIn("private",json.dumps(r))
    def test_distinct_limit(self):
        r=snap(report(case("a.test.ts","m1"),case("a.test.ts","m2")),1)
        self.assertEqual((r["clusterCount"],r["omittedFailedTests"]),(2,1))
    def test_paths(self):
        r=snap(report(*[case(x,"m") for x in ["../a.test.ts","C:/a.test.ts","/a.test.ts","apps/a.test.ts"]]))
        self.assertEqual(r["clusters"][0]["unknownFile"],3)
        self.assertEqual(r["clusters"][0]["files"],["apps/a.test.ts"])
    def test_fail_closed(self):
        for bad in [report(case("a.test.ts","m"),failures=0),b'<!DOCTYPE x [<!ENTITY a "test">]><x/>',b"<testsuites/>"]:
            with self.assertRaises(ValueError):
                snap(bad)
    def test_pass_clean(self):
        clean=b'<testsuites name="bun test" tests="1" failures="0" skipped="0"><testsuite><testcase file="a.test.ts"/></testsuite></testsuites>'
        self.assertEqual(snap(clean)["clusters"],[])
    def test_per_file_coverage_keeps_counts(self):
        result=snap(report(case("a.test.ts","m"),case("sub/b.test.js","m")),include_files=True)
        self.assertEqual(result["schemaVersion"],1)
        self.assertEqual(result["fileCount"],2)
        self.assertEqual(result["files"][1],{"file":"sub/b.test.js","tests":1,"failed":1,"skipped":0})

    def test_verified_scope_rejects_omitted_import_failure(self):
        clean=report('<testcase file="a.test.ts"/>',failures=0)
        result=snap(clean,bun_exit=1,expected_files=['a.test.ts','missing.test.ts'])
        self.assertEqual(result['verdict'],'unverified')
        self.assertEqual(result['coverage']['missingFiles'],['missing.test.ts'])

    def test_verified_scope_rejects_nonzero_bun_even_when_files_match(self):
        clean=report('<testcase file="a.test.ts"/>',failures=0)
        self.assertEqual(snap(clean,bun_exit=1,expected_files=['a.test.ts'])['verdict'],'unverified')

    def test_verified_scope_only_marks_matching_clean_run(self):
        clean=report('<testcase file="src/a.test.ts"/>',failures=0)
        result=snap(clean,bun_exit=0,expected_files=['src/a.test.ts'])
        self.assertEqual((result['verdict'],result['coverage']['expectedCount']),('scoped-pass',1))
        self.assertEqual(snap(clean,bun_exit=0,expected_files=['b.test.ts'])['verdict'],'unverified')
        self.assertEqual(snap(clean,bun_exit=124,expected_files=['src/a.test.ts'])['verdict'],'unverified')
        self.assertNotIn('verdict',snap(clean))

    def test_verified_scope_preserves_real_failures(self):
        bad=report(case('a.test.ts','synthetic test text'))
        self.assertEqual(snap(bad,bun_exit=1,expected_files=['a.test.ts'])['verdict'],'scoped-fail')
        self.assertEqual(snap(bad,bun_exit=0,expected_files=['a.test.ts'])['verdict'],'unverified')

    def test_verified_scope_rejects_skipped_unattributed_or_bad_input(self):
        skip=report('<testcase file="a.test.ts"><skipped/></testcase>',failures=0).replace(b'skipped="0"',b'skipped="1"')
        self.assertEqual(snap(skip,bun_exit=0,expected_files=['a.test.ts'])['verdict'],'unverified')
        unknown=report('<testcase file="a.test.ts"/>','<testcase/>',failures=0)
        self.assertEqual(snap(unknown,bun_exit=0,expected_files=['a.test.ts'])['verdict'],'unverified')
        for files in ([],['../a.test.ts'],['a.test.ts','a.test.ts']):
            with self.assertRaises(ValueError):
                snap(unknown,bun_exit=0,expected_files=files)
