import argparse, json, os, random, subprocess, sys, tempfile, time
from pathlib import Path
from statistics import median
from xml.etree import ElementTree as ET
from xml.sax.saxutils import quoteattr
from test_compact_bunfailures import case, report

ROOT = Path(__file__).resolve().parent
RUST = ROOT / ('target/release/yomumi-evidence.exe' if os.name == 'nt' else 'target/release/yomumi-evidence')

def run(cmd, measure=False):
    start = time.perf_counter_ns()
    r = subprocess.run(cmd, capture_output=True, timeout=15)
    duration = (time.perf_counter_ns()-start)/1e6
    if measure:
        return r.returncode, duration
    return r.returncode, json.loads(r.stdout)

def checked(py, rs):
    want = run(py)
    assert RUST.is_file(), "Rust evidence binary has not been built"
    got = run(rs)
    assert want == got, (py, want, got)

def test(bun, bench):
    count = 0
    with tempfile.TemporaryDirectory() as temp:
        tmp=Path(temp)
        before,after=tmp/'before.xml',tmp/'after.xml'
        def args(mode,*rest):
            return ([sys.executable,str(ROOT/('compact_bun_failures.py' if mode=='compact' else 'compare_bun_runs.py')),*map(str,rest)],
                    [str(RUST),mode,*map(str,rest)])
        def check(mode,*rest):
            nonlocal count
            checked(*args(mode,*rest)); count+=1
        def make(file,n):
            r=subprocess.run([bun,'test','--reporter=junit',f'--reporter-outfile={file}','examples/fixture.test.ts'],cwd=ROOT,env={**os.environ,'HARNESS_EXAMPLE_QUANTITY':str(n)},capture_output=True,timeout=30)
            assert r.returncode == (n != 2), r.stderr
        make(before,3); make(after,2)
        trace=ET.parse(before); template=trace.getroot(); rows=list(template.iter('testcase')); fail=next(x for x in rows if x.find('failure') is not None)
        full='examples/fixture.test.ts'
        for path,code in [(before,1),(after,0)]:
            check('compact',path,'--files','--bun-exit',code,'--expect-file',full)
            check('compact',path,'--bun-exit',code,'--expect-file','wrong.test.ts')
            check('compact',path,'--bun-exit',1-code,'--expect-file',full)
        check('compare',before,after,'--before-exit',1,'--after-exit',0)
        check('compare',after,before,'--before-exit',0,'--after-exit',1)
        check('compare',before,before,'--before-exit',1,'--after-exit',1)
        malformed=[b'',b'\xff',b'<bad/>',b'<!DOCTYPE x><x/>',b'<x>&bogus;</x>',b'<testsuites/>',
          report(case('../b.ts','x'),failures=0),report('<testcase file="x.ts"><failure/><skipped/></testcase>'),
          b'\0',b'a'*(8*1024*1024+1)]
        path=tmp/'variant.xml'
        for data in malformed:
            path.write_bytes(data); check('compact',path,'--files')
        def special(text, case_count=1, failures=0, errors=0, skipped=0, prefix="", root_ns=""):
            return (prefix+f'<testsuites {root_ns} name="bun test" tests="{case_count}" failures="{failures}" errors="{errors}" skipped="{skipped}">'+text+'</testsuites>').encode()
        a='<testcase file="a.test.ts" name="one"/>'
        failure='<testcase file="a.test.ts" name="one"><failure type="Error" message="private"/></testcase>'
        error='<testcase file="a.test.ts" name="one"><error type="unknown" message="private"/></testcase>'
        skip='<testcase file="a.test.ts" name="one"><skipped/></testcase>'
        for data,code in [
            (special(skip,skipped=1),0), (special(error,errors=1),1),
            (special(a.replace("/>", "><flakyFailure/></testcase>")),0),
            (special(a.replace("/>", "><rerunFailure/></testcase>")),0),
            (special(a,prefix="\ufeff"),0),(special(a,prefix="\ufeff\ufeff"),0),
            (special(a,root_ns='xmlns="urn:other"'),0),
            (special(a.replace("one","bad\x01")),0),
            (special(a.replace("one","bad&#1;")),0),
            (special(a.replace("one","bad&#0;")),0),
            (special(a+failure,case_count=2,failures=1),1),
            (special(a.replace("a.test.ts",".ts")),0),
            (special(a.replace("a.test.ts","some/folder/.ts")),0),
        ]:
            path.write_bytes(data)
            check('compact',path,'--files','--bun-exit',code,'--expect-file','a.test.ts')
            check('compare',path,path,'--before-exit',code,'--after-exit',code)
        path.write_bytes(special(a+failure,case_count=2,failures=1))
        other=tmp/'changed-duplicates.xml'; other.write_bytes(special(a+a,case_count=2))
        check('compare',path,other,'--before-exit',1,'--after-exit',0)
        rng=random.Random(93723)
        for i in range(80):
            def sheet():
                items=[]; fails=0
                for j in range(1+i%13):
                    f=['folder/a.test.ts','./b.test.ts','C:/a.ts','a.test.ts'][j%4 if i%5==0 else j%2]
                    name=f'name {j}' if i%11 else 'duplicate'
                    msg=[' same ','ไทย 🎧','日本語','"q"&x','a\tZ','', 'uni\u00a0 ', 'abc', 'a\u2028b'][rng.randrange(9)]
                    bad=rng.random()<.5
                    items.append('<testcase file=%s name=%s>%s</testcase>'%(quoteattr(f),quoteattr(name),('<failure type="AssertionError" message=%s>private stack</failure>'%quoteattr(msg)) if bad else ''))
                    fails+=bad
                return report(*items,failures=fails),int(bool(fails))
            a,ea=sheet(); b,eb=sheet()
            path.write_bytes(a)
            second=tmp/'second.xml'; second.write_bytes(b)
            check('compact',path,'--files','--limit',1+i%12)
            check('compact',path,'--bun-exit',ea,'--expect-file','folder/a.test.ts','--expect-file','b.test.ts')
            check('compare',path,second,'--before-exit',ea,'--after-exit',eb)
        for i in [1000,10000]:
            name=f'expanded-{i}.xml'; path=tmp/name
            import copy
            root=ET.Element('testsuites',{'name':'bun test','tests':str(i),'failures':str(i//10),'skipped':'0'}); suite=ET.SubElement(root,'testsuite')
            for j in range(i):
                c=copy.deepcopy(fail if j<i//10 else rows[-1]); c.set('name',f'expanded-{j}'); suite.append(c)
            ET.ElementTree(root).write(path,encoding='utf-8')
            check('compact',path,'--files','--bun-exit',1,'--expect-file',full)
        if bench:
            for name,cmds in [('Bun report, 2 tests',args('compact',before,'--files','--bun-exit',1,'--expect-file',full)),
                              ('Bun pair, 2 tests each',args('compare',before,after,'--before-exit',1,'--after-exit',0)),
                              ('Expanded Bun report, 10k tests',args('compact',tmp/'expanded-10000.xml','--files','--bun-exit',1,'--expect-file',full))]:
                samples=[[],[]]
                for k in range(85):
                    for lane in (range(2) if k%2==0 else (1,0)):
                        code,elapsed=run(cmds[lane],True)
                        assert code==(0 if 'pair' in name else 1)
                        if k>=5: samples[lane].append(elapsed)
                print(name,[(round(median(s),3),round(sorted(s)[75],3)) for s in samples])
        print(f'{count} matched CLI outcomes')

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--bun',default='bun')
    p.add_argument('--bench',action='store_true')
    a=p.parse_args()
    test(a.bun,a.bench)
