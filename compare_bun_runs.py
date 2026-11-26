"""Read two locally generated Bun reports, require matched executed tests, and return a compact delta."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from compact_bun_failures import MAX_BYTES, relative_file, snap

def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()

def parse(raw, expected_exit):
    coverage=snap(raw,include_files=True)
    if coverage["unknownFileCases"] or coverage["fileCount"]>256 or coverage["skipped"]:
        raise ValueError("Incomplete file evidence")
    if expected_exit != int(bool(coverage["failures"]+coverage["errors"])):
        raise ValueError("Runner/report disagree")
    cases={}
    for c in ET.fromstring(raw.decode("utf-8-sig")).iter("testcase"):
        f=relative_file(c.get("file",""))
        name=c.get("name","")
        if f is None or not name:
            raise ValueError("No stable identity")
        key=(f,c.get("classname",""),name,c.get("line",""))
        signal=next((x for x in c if x.tag in ("failure","error")),None)
        cases.setdefault(key,[]).append(None if signal is None else sha(signal.tag+"\0"+signal.get("type","")+"\0"+signal.get("message","")))
    return coverage,cases

def compare(before, after, before_exit, after_exit):
    a,ac=parse(before,before_exit)
    b,bc=parse(after,after_exit)
    if ac.keys()!=bc.keys():
        raise ValueError("Coverage changed")
    deltas=[]
    for k,results in bc.items():
        earlier=ac[k]
        if len(earlier)!=len(results):
            raise ValueError("Repeated execution count changed")
        if len(results)>1:
            if sorted(str(x) for x in earlier)!=sorted(str(x) for x in results):
                raise ValueError("Duplicate test name makes the change ambiguous")
            continue
        prior,result=earlier[0],results[0]
        if prior!=result:
            deltas.append({"file":k[0],"testId":sha("\0".join(k))[:16],
                           "change":"fixed" if result is None else "regression" if prior is None else "changed_failure"})
    return {"schemaVersion":1,"kind":"yomumi.matched-test-delta","verdict":"matched",
            "tests":b["tests"],"files":b["fileCount"],"beforeFailed":a["errors"]+a["failures"],
            "afterFailed":b["errors"]+b["failures"],"changeCount":len(deltas),"changes":deltas[:12],
            "beforeSha256":hashlib.sha256(before).hexdigest(),"afterSha256":hashlib.sha256(after).hexdigest()}

def main():
    arg=argparse.ArgumentParser(description=__doc__)
    arg.add_argument("before",type=Path)
    arg.add_argument("after",type=Path)
    arg.add_argument("--before-exit",type=int,choices=(0,1),required=True)
    arg.add_argument("--after-exit",type=int,choices=(0,1),required=True)
    args=arg.parse_args()
    try:
        with args.before.open("rb") as h: a=h.read(MAX_BYTES+1)
        with args.after.open("rb") as h: b=h.read(MAX_BYTES+1)
        print(json.dumps(compare(a,b,args.before_exit,args.after_exit),separators=(",",":")))
        return 0
    except (ValueError,UnicodeError,OSError,ET.ParseError):
        print('{"schemaVersion":1,"kind":"yomumi.matched-test-delta","verdict":"incomplete"}')
        return 2

if __name__=="__main__":
    raise SystemExit(main())
