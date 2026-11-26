#![forbid(unsafe_code)]
use roxmltree::{Document, Node};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
};

const MAX: usize = 8 * 1024 * 1024;
type Checked<T> = Result<T, ()>;

fn bounded(path: &str) -> Checked<Vec<u8>> {
    let mut data = Vec::new();
    File::open(path)
        .map_err(|_| ())?
        .take((MAX + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| ())?;
    if data.is_empty() || data.len() > MAX {
        return Err(());
    }
    Ok(data)
}

fn relative_file(s: &str) -> Option<String> {
    let s = s.replace('\\', "/");
    let s = s.strip_prefix("./").unwrap_or(&s);
    if s.len() > 240
        || !s.split('/').all(|p| {
            !p.is_empty()
                && !matches!(p, "." | ".." | "node_modules")
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.@+-".contains(&b))
        })
    {
        return None;
    }
    let (base, ext) = s.rsplit_once('.')?;
    if base.rsplit('/').next()?.is_empty()
        || !matches!(
            ext,
            "js" | "ts"
                | "jsx"
                | "tsx"
                | "mjs"
                | "mts"
                | "mjsx"
                | "mtsx"
                | "cjs"
                | "cts"
                | "cjsx"
                | "ctsx"
        )
    {
        return None;
    }
    Some(s.into())
}

fn sha(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}

fn tag<'a>(n: Node<'a, '_>) -> Option<&'a str> {
    if n.is_element() && n.tag_name().namespace().is_none() {
        Some(n.tag_name().name())
    } else {
        None
    }
}

fn attr<'a>(n: Node<'a, '_>, k: &str) -> &'a str {
    n.attribute(k).unwrap_or("")
}

#[derive(Default, PartialEq, Eq)]
struct Counts {
    tests: usize,
    failures: usize,
    errors: usize,
    skipped: usize,
}
#[derive(Default)]
struct FileCounts {
    tests: usize,
    failed: usize,
    skipped: usize,
}
#[derive(Default)]
struct Cluster {
    kind: String,
    count: usize,
    files: BTreeSet<String>,
    unknown: usize,
}
type CaseKey = [String; 4];
type Cases = BTreeMap<CaseKey, Vec<Option<String>>>;
struct Report {
    counts: Counts,
    files: BTreeMap<String, FileCounts>,
    unknown: usize,
    groups: BTreeMap<String, Cluster>,
    cases: Cases,
    order: Vec<CaseKey>,
}

fn parse(raw: &[u8], delta: bool) -> Checked<Report> {
    let input = std::str::from_utf8(raw)
        .map_err(|_| ())?
        .trim_start_matches('\u{feff}');
    if input.contains('\0')
        || input.match_indices("<!").any(|(i, _)| {
            let tail = input[i + 2..].trim_start();
            ["DOCTYPE", "ENTITY"].iter().any(|k| {
                tail.get(..k.len())
                    .is_some_and(|s| s.eq_ignore_ascii_case(k))
            })
        })
    {
        return Err(());
    }
    let doc = Document::parse(input).map_err(|_| ())?;
    let root = doc.root_element();
    if tag(root) != Some("testsuites") || attr(root, "name") != "bun test" {
        return Err(());
    }
    let number = |key| -> Checked<usize> {
        let n = root
            .attribute(key)
            .unwrap_or(if key == "errors" { "0" } else { "" });
        if n.is_empty() || n.len() > 6 || !n.bytes().all(|b| b.is_ascii_digit()) {
            return Err(());
        }
        n.parse().map_err(|_| ())
    };
    let expected = Counts {
        tests: number("tests")?,
        failures: number("failures")?,
        errors: number("errors")?,
        skipped: number("skipped")?,
    };
    let mut r = Report {
        counts: Counts::default(),
        files: BTreeMap::new(),
        unknown: 0,
        groups: BTreeMap::new(),
        cases: BTreeMap::new(),
        order: Vec::new(),
    };
    for node in root.descendants().filter(|n| tag(*n) == Some("testcase")) {
        r.counts.tests += 1;
        let file = relative_file(attr(node, "file"));
        let fc = file
            .as_ref()
            .map(|file| r.files.entry(file.clone()).or_default());
        if file.is_none() {
            r.unknown += 1;
        }
        let mut items = node
            .children()
            .filter(|n| matches!(tag(*n), Some("failure" | "error" | "skipped")));
        let item = items.next();
        if items.next().is_some() {
            return Err(());
        }
        let name = attr(node, "name");
        let signal = match item.and_then(tag) {
            Some("failure") => {
                r.counts.failures += 1;
                true
            }
            Some("error") => {
                r.counts.errors += 1;
                true
            }
            Some("skipped") => {
                r.counts.skipped += 1;
                false
            }
            _ => false,
        };
        if let Some(fc) = fc {
            fc.tests += 1;
            fc.failed += usize::from(signal);
            fc.skipped += usize::from(item.and_then(tag) == Some("skipped"));
        }
        let result = if signal {
            let item = item.ok_or(())?;
            let typ = tag(item).ok_or(())?;
            let kind = attr(item, "type");
            let message = attr(item, "message");
            if delta {
                Some(sha([typ, kind, message].join("\0")))
            } else {
                let message = message.trim_matches(|c: char| {
                    c.is_whitespace() || ('\u{1c}'..='\u{1f}').contains(&c)
                });
                let key = if message.is_empty() {
                    vec![json!(typ), json!(kind), json!(file), json!(name)]
                } else {
                    vec![json!(typ), json!(kind), json!(message)]
                };
                // Python's original fingerprint uses a space after each JSON separator.
                let canonical = format!(
                    "[{}]",
                    key.iter()
                        .map(Value::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                let id = sha(canonical)[..20].to_owned();
                let cluster = r.groups.entry(id).or_insert_with(|| Cluster {
                    kind: if matches!(
                        kind,
                        "AssertionError"
                            | "Error"
                            | "TypeError"
                            | "RangeError"
                            | "SyntaxError"
                            | "ReferenceError"
                            | "TimeoutError"
                    ) {
                        kind.into()
                    } else {
                        typ.into()
                    },
                    ..Cluster::default()
                });
                cluster.count += 1;
                if let Some(f) = file.as_ref() {
                    cluster.files.insert(f.clone());
                } else {
                    cluster.unknown += 1;
                }
                None
            }
        } else {
            None
        };
        if delta {
            let key = [
                file.ok_or(())?,
                attr(node, "classname").into(),
                name.into(),
                attr(node, "line").into(),
            ];
            if name.is_empty() {
                return Err(());
            }
            r.cases
                .entry(key.clone())
                .or_insert_with(|| {
                    r.order.push(key);
                    Vec::new()
                })
                .push(result);
        }
    }
    if r.counts != expected || r.counts.tests == 0 {
        return Err(());
    }
    Ok(r)
}

fn compact(
    raw: &[u8],
    limit: usize,
    show_files: bool,
    exit: Option<i32>,
    expected: &[String],
) -> Checked<(Value, i32)> {
    if !(1..=12).contains(&limit) || exit.is_some() == expected.is_empty() || expected.len() > 256 {
        return Err(());
    }
    let scope: BTreeSet<String> = expected
        .iter()
        .map(|f| relative_file(f).ok_or(()))
        .collect::<Checked<_>>()?;
    if scope.len() != expected.len() {
        return Err(());
    }
    let r = parse(raw, false)?;
    let c = r.counts;
    let mut groups: Vec<_> = r.groups.iter().collect();
    groups.sort_unstable_by(|(a, x), (b, y)| y.count.cmp(&x.count).then_with(|| a.cmp(b)));
    let clusters:Vec<_> = groups.iter().take(limit).map(|(id,g)| json!({
        "id":id,"kind":g.kind,"count":g.count,"unknownFile":g.unknown,
        "files":g.files.iter().take(2).collect::<Vec<_>>(),"otherFiles":g.files.len().saturating_sub(2)
    })).collect();
    let mut result = json!({"schemaVersion":1,"kind":"yomumi.bun-test-summary","tests":c.tests,"failures":c.failures,
        "errors":c.errors,"skipped":c.skipped,"clusterCount":groups.len(),"clusters":clusters,
        "omittedClusters":groups.len().saturating_sub(limit),"omittedFailedTests":groups.iter().skip(limit).map(|(_,g)|g.count).sum::<usize>()});
    if show_files {
        result["fileCount"] = json!(r.files.len());
        result["unknownFileCases"] = json!(r.unknown);
        result["files"] = json!(r
            .files
            .iter()
            .take(256)
            .map(|(f, n)| json!({"file":f,"tests":n.tests,"failed":n.failed,"skipped":n.skipped}))
            .collect::<Vec<_>>());
    }
    let mut code = 0;
    if let Some(exit) = exit {
        let missing: Vec<_> = scope.iter().filter(|f| !r.files.contains_key(*f)).collect();
        let extra: Vec<_> = r.files.keys().filter(|f| !scope.contains(*f)).collect();
        let mut problems = Vec::new();
        if !missing.is_empty() || !extra.is_empty() || r.unknown > 0 {
            problems.push("file_coverage_mismatch");
        }
        if c.skipped > 0 {
            problems.push("skipped_tests");
        }
        let failed = c.failures + c.errors > 0;
        if exit != i32::from(failed) {
            problems.push("bun_exit_disagrees");
        }
        let verdict = if !problems.is_empty() {
            code = 2;
            "unverified"
        } else if failed {
            code = 1;
            "scoped-fail"
        } else {
            "scoped-pass"
        };
        result["verdict"] = json!(verdict);
        result["bunExit"] = json!(exit);
        result["problems"] = json!(problems);
        result["coverage"] = json!({"expectedCount":scope.len(),"observedCount":r.files.len(),
            "missingFiles":missing.iter().take(8).collect::<Vec<_>>(),"unexpectedFiles":extra.iter().take(8).collect::<Vec<_>>(),
            "omittedMissingFiles":missing.len().saturating_sub(8),"omittedUnexpectedFiles":extra.len().saturating_sub(8),"unknownFileCases":r.unknown});
    }
    Ok((result, code))
}

fn compare(a: &[u8], b: &[u8], ea: i32, eb: i32) -> Checked<(Value, i32)> {
    let a_report = parse(a, true)?;
    let b_report = parse(b, true)?;
    let af = a_report.counts.errors + a_report.counts.failures;
    let bf = b_report.counts.errors + b_report.counts.failures;
    for (r, failed, exit) in [(&a_report, af, ea), (&b_report, bf, eb)] {
        if r.unknown > 0
            || r.files.len() > 256
            || r.counts.skipped > 0
            || exit != i32::from(failed > 0)
        {
            return Err(());
        }
    }
    if !a_report.cases.keys().eq(b_report.cases.keys()) {
        return Err(());
    }
    let mut changes = Vec::new();
    let mut num = 0;
    for k in &b_report.order {
        let x = &a_report.cases[k];
        let y = &b_report.cases[k];
        if x.len() != y.len() {
            return Err(());
        }
        if x.len() > 1 {
            let mut sx = x.iter().collect::<Vec<_>>();
            let mut sy = y.iter().collect::<Vec<_>>();
            sx.sort_unstable();
            sy.sort_unstable();
            if sx != sy {
                return Err(());
            }
        } else if x[0] != y[0] {
            num += 1;
            if changes.len() < 12 {
                changes.push(json!({"file":k[0],"testId":&sha(k.join("\0"))[..16],
                    "change":if y[0].is_none() {"fixed"} else if x[0].is_none() {"regression"} else {"changed_failure"}}));
            }
        }
    }
    Ok((
        json!({"schemaVersion":1,"kind":"yomumi.matched-test-delta","verdict":"matched","tests":b_report.counts.tests,
        "files":b_report.files.len(),"beforeFailed":af,"afterFailed":bf,"changeCount":num,"changes":changes,"beforeSha256":sha(a),"afterSha256":sha(b)}),
        0,
    ))
}

fn run(mut args: impl Iterator<Item = String>, mode: &str) -> Checked<(Value, i32)> {
    let first = args.next().ok_or(())?;
    if mode == "compact" {
        let (mut limit, mut files, mut exit, mut expect) = (6, false, None, Vec::new());
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--limit" => limit = args.next().ok_or(())?.parse().map_err(|_| ())?,
                "--files" => files = true,
                "--bun-exit" => exit = Some(args.next().ok_or(())?.parse().map_err(|_| ())?),
                "--expect-file" => {
                    if expect.len() == 256 {
                        return Err(());
                    }
                    expect.push(args.next().ok_or(())?);
                }
                _ => return Err(()),
            }
        }
        compact(&bounded(&first)?, limit, files, exit, &expect)
    } else if mode == "compare" {
        let second = args.next().ok_or(())?;
        let (mut ea, mut eb) = (None, None);
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--before-exit" => ea = Some(args.next().ok_or(())?.parse().map_err(|_| ())?),
                "--after-exit" => eb = Some(args.next().ok_or(())?.parse().map_err(|_| ())?),
                _ => return Err(()),
            }
        }
        compare(
            &bounded(&first)?,
            &bounded(&second)?,
            ea.ok_or(())?,
            eb.ok_or(())?,
        )
    } else {
        Err(())
    }
}

fn main() {
    let Ok(mut args) = std::env::args_os()
        .skip(1)
        .map(|s| s.into_string().map_err(|_| ()))
        .collect::<Checked<Vec<_>>>()
        .map(|v| v.into_iter())
    else {
        println!(
            "{}",
            json!({"status":"unverified","reason":"missing_invalid_or_incomplete_bun_junit"})
        );
        std::process::exit(2);
    };
    let mode = args.next().unwrap_or_default();
    match run(args, &mode) {
        Ok((output, exit)) => {
            println!("{output}");
            std::process::exit(exit);
        }
        Err(()) => {
            if mode == "compare" {
                println!(
                    "{}",
                    json!({"schemaVersion":1,"kind":"yomumi.matched-test-delta","verdict":"incomplete"})
                );
            } else {
                println!(
                    "{}",
                    json!({"status":"unverified","reason":"missing_invalid_or_incomplete_bun_junit"})
                );
            }
            std::process::exit(2);
        }
    }
}
