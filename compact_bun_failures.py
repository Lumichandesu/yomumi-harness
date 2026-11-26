"""Compact a local Bun JUnit report into bounded, redacted failure clusters."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

MAX_BYTES = 8 * 1024 * 1024
FILE = re.compile(r"(?:(?:[A-Za-z0-9_.@+-]+/)*[A-Za-z0-9_.@+-]+\.(?:[cm]?[jt]sx?))\Z")
KINDS = frozenset(("AssertionError", "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "TimeoutError"))

def relative_file(value: str) -> str | None:
    f = value.replace("\\", "/").removeprefix("./")
    if len(f) <= 240 and FILE.fullmatch(f) and not {"..", ".", "node_modules"}.intersection(f.split("/")):
        return f
    return None

def snap(raw: bytes, limit: int = 8, include_files: bool = False, *,
         bun_exit: int | None = None, expected_files: list[str] | None = None) -> dict:
    expected = None
    if bun_exit is not None or expected_files is not None:
        if type(bun_exit) is not int or expected_files is None or not 1 <= len(expected_files) <= 256:
            raise ValueError("Bun exit and explicit file coverage are both required")
        expected = {relative_file(f) for f in expected_files}
        if None in expected or len(expected) != len(expected_files):
            raise ValueError("Invalid or repeated expected path")
    if not 1 <= limit <= 12 or not 0 < len(raw) <= MAX_BYTES:
        raise ValueError("Invalid size/limit")
    text = raw.decode("utf-8-sig")
    if "\x00" in text or re.search(r"<!\s*(?:DOCTYPE|ENTITY)", text, re.I):
        raise ValueError("Unsupported report")
    r = ET.fromstring(text)
    if r.tag != "testsuites" or r.get("name") != "bun test":
        raise ValueError("Not Bun JUnit")
    def read_number(name):
        val = r.get(name, "0" if name == "errors" else "")
        if not re.fullmatch(r"[0-9]{1,6}", val):
            raise ValueError("Missing count")
        return int(val)
    declared = {k:read_number(k) for k in ("tests", "failures", "errors", "skipped") }
    rows = list(r.iter("testcase"))
    actual = {"tests": len(rows), "failures": 0, "errors": 0, "skipped": 0}
    groups = {}
    by_file = {}
    unknown_file = 0
    for case in rows:
        if any(child.tag in ("flakyFailure", "rerunFailure") for child in case):
            raise ValueError("Retry evidence is not comparable")
        file = relative_file(case.get("file", ""))
        if file:
            counters = by_file.setdefault(file, {"tests": 0, "failed": 0, "skipped": 0})
            counters["tests"] += 1
        else:
            unknown_file += 1
        recognized = [child for child in case if child.tag in ("failure", "error", "skipped")]
        if len(recognized) > 1:
            raise ValueError("Ambiguous test")
        if not recognized:
            continue
        item = recognized[0]
        if item.tag == "skipped":
            actual["skipped"] += 1
            if file:
                counters["skipped"] += 1
            continue
        actual["failures" if item.tag == "failure" else "errors"] += 1
        if file:
            counters["failed"] += 1
        kind = item.get("type", "")
        msg = item.get("message", "").strip()
        # No lossy normalization: distinct assertions are not grouped by accident.
        # Body, stack, log streams, names, and raw message never leave the process.
        fp = hashlib.sha256(json.dumps([item.tag,kind,msg] if msg else [item.tag,kind,file,case.get("name","")],ensure_ascii=False).encode()).hexdigest()[:20]
        g = groups.setdefault(fp,{"id":fp,"kind":kind if kind in KINDS else item.tag,"count":0,"files":set(),"unknownFile":0})
        g["count"] += 1
        if file:
            g["files"].add(file)
        else:
            g["unknownFile"] += 1
    if actual != declared or not rows:
        raise ValueError("Incomplete or inconsistent report")
    ranked=sorted(groups.values(),key=lambda g:(-g["count"],g["id"]))
    selected=[]
    for g in ranked[:limit]:
        files=sorted(g["files"])
        selected.append({**g,"files":files[:2],"otherFiles":max(0,len(files)-2)})
    result = {"schemaVersion":1,"kind":"yomumi.bun-test-summary","tests":actual["tests"],"failures":actual["failures"],"errors":actual["errors"],
            "skipped":actual["skipped"],"clusterCount":len(ranked),"clusters":selected,
            "omittedClusters":max(0,len(ranked)-limit),"omittedFailedTests":sum(g["count"] for g in ranked[limit:])}
    if include_files:
        result["fileCount"] = len(by_file)
        result["unknownFileCases"] = unknown_file
        result["files"] = [{"file":k,**by_file[k]} for k in sorted(by_file)[:256]]
    if expected is not None:
        missing = sorted(expected - by_file.keys())
        extra = sorted(by_file.keys() - expected)
        problems = []
        if missing or extra or unknown_file:
            problems.append("file_coverage_mismatch")
        if actual["skipped"]:
            problems.append("skipped_tests")
        failed = actual["failures"] + actual["errors"]
        if bun_exit != int(failed > 0):
            problems.append("bun_exit_disagrees")
        result.update(verdict="unverified" if problems else ("scoped-fail" if failed else "scoped-pass"),
                      bunExit=bun_exit, problems=problems,
                      coverage={"expectedCount":len(expected), "observedCount":len(by_file),
                                "missingFiles":missing[:8], "unexpectedFiles":extra[:8],
                                "omittedMissingFiles":max(0,len(missing)-8),
                                "omittedUnexpectedFiles":max(0,len(extra)-8),
                                "unknownFileCases":unknown_file})
    return result

def main() -> int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("junit",type=Path)
    p.add_argument("--limit",type=int,default=6)
    p.add_argument("--files",action="store_true")
    p.add_argument("--bun-exit", type=int, help="Exit code from the matching Bun invocation")
    p.add_argument("--expect-file", action="append", help="Exact repo-relative test file from the original command (repeatable)")
    a=p.parse_args()
    try:
        with a.junit.open("rb") as f:
            result=snap(f.read(MAX_BYTES+1),a.limit,a.files,bun_exit=a.bun_exit,expected_files=a.expect_file)
        print(json.dumps(result,separators=(",",":")))
        return {"scoped-pass":0,"scoped-fail":1,"unverified":2}[result["verdict"]] if "verdict" in result else 0
    except (ValueError, ET.ParseError, UnicodeError, OSError):
        print('{"status":"unverified","reason":"missing_invalid_or_incomplete_bun_junit"}')
        return 2
if __name__ == "__main__":
    sys.exit(main())
