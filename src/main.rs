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

fn bounded(path: impl AsRef<std::path::Path>) -> Checked<Vec<u8>> {
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

fn count_value(n: &str) -> Checked<usize> {
    if n.is_empty() || n.len() > 6 || !n.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    n.parse().map_err(|_| ())
}

fn validate_suite_counts(root: Node<'_, '_>) -> Checked<()> {
    for suite in root.children().filter(|n| tag(*n) == Some("testsuite")) {
        let mut observed = Counts::default();
        for case in suite.children().filter(|n| tag(*n) == Some("testcase")) {
            observed.tests += 1;
            for item in case.children() {
                match tag(item) {
                    Some("failure") => observed.failures += 1,
                    Some("error") => observed.errors += 1,
                    Some("skipped") => observed.skipped += 1,
                    _ => {}
                }
            }
        }
        for (key, count) in [
            ("tests", observed.tests),
            ("failures", observed.failures),
            ("errors", observed.errors),
            ("skipped", observed.skipped),
        ] {
            if let Some(declared) = suite.attribute(key) {
                if count_value(declared)? != count {
                    return Err(());
                }
            }
        }
    }
    Ok(())
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
        count_value(n)
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
        let name = attr(node, "name");
        if name.trim().is_empty() {
            return Err(());
        }
        if node.children().any(|child| matches!(tag(child), Some("flakyFailure" | "rerunFailure"))) {
            return Err(());
        }
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
    validate_suite_counts(root)?;
    Ok(r)
}

fn compact(
    raw: &[u8],
    limit: usize,
    show_files: bool,
    exit: Option<i32>,
    expected: &[String],
    expected_tests: Option<usize>,
) -> Checked<(Value, i32)> {
    if !(1..=12).contains(&limit) || exit.is_some() == expected.is_empty() || expected.len() > 256 {
        return Err(());
    }
    if expected_tests.is_some_and(|n| n == 0 || exit.is_none()) {
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
        if let Some(n) = expected_tests {
            result["expectedTests"] = json!(n);
            if n != c.tests {
                problems.push("test_count_mismatch");
            }
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

type Compared<T> = Result<T, &'static str>;

fn compare(a: &[u8], b: &[u8], ea: i32, eb: i32, summary_only: bool) -> Compared<(Value, i32)> {
    let a_report = parse(a, true).map_err(|_| "before_report_invalid")?;
    let b_report = parse(b, true).map_err(|_| "after_report_invalid")?;
    let af = a_report.counts.errors + a_report.counts.failures;
    let bf = b_report.counts.errors + b_report.counts.failures;
    let check = |r: &Report, failed, exit, reasons: [&'static str; 3]| {
        if r.unknown > 0 || r.files.len() > 256 {
            Err(reasons[0])
        } else if r.counts.skipped > 0 {
            Err(reasons[1])
        } else if exit != i32::from(failed > 0) {
            Err(reasons[2])
        } else {
            Ok(())
        }
    };
    check(
        &a_report, af, ea,
        [
            "before_file_scope_invalid",
            "before_skipped_tests",
            "before_bun_exit_disagrees",
        ],
    )?;
    check(
        &b_report, bf, eb,
        [
            "after_file_scope_invalid",
            "after_skipped_tests",
            "after_bun_exit_disagrees",
        ],
    )?;
    if !a_report.cases.keys().eq(b_report.cases.keys()) {
        return Err("test_identity_mismatch");
    }
    let mut changes = Vec::new();
    let mut totals = [0usize; 3];
    for k in &b_report.order {
        let x = &a_report.cases[k];
        let y = &b_report.cases[k];
        if x.len() != y.len() {
            return Err("test_identity_mismatch");
        }
        if x.len() > 1 {
            let mut sx = x.iter().collect::<Vec<_>>();
            let mut sy = y.iter().collect::<Vec<_>>();
            sx.sort_unstable();
            sy.sort_unstable();
            if sx != sy {
                return Err("ambiguous_test_identity");
            }
        } else if x[0] != y[0] {
            let (idx, label) = if y[0].is_none() {
                (0, "fixed")
            } else if x[0].is_none() {
                (1, "regression")
            } else {
                (2, "changed_failure")
            };
            totals[idx] += 1;
            if !summary_only {
                // Keep report order among retained rows. A late regression can evict
                // the last non-regression, but never an earlier regression.
                let include = if changes.len() < 12 {
                    true
                } else if idx == 1 {
                    changes.iter().rposition(|row: &Value| row["change"] != "regression")
                        .map(|last| changes.remove(last))
                        .is_some()
                } else {
                    false
                };
                if include {
                    changes.push(json!({"file":k[0],"testId":&sha(k.join("\0"))[..16],"change":label}));
                }
            }
        }
    }
    let num = totals.iter().sum::<usize>();
    let mut output = json!({"schemaVersion":1,"kind":"yomumi.matched-test-delta","verdict":"matched","tests":b_report.counts.tests,
        "files":b_report.files.len(),"beforeFailed":af,"afterFailed":bf,"changeCount":num,"beforeSha256":sha(a),"afterSha256":sha(b)});
    if summary_only {
        output["changeCounts"] = json!({"fixed":totals[0],"regression":totals[1],"changed_failure":totals[2]});
        output["omittedChanges"] = json!(num);
    } else {
        output["changes"] = json!(changes);
    }
    Ok((output, 0))
}

fn run(mut args: impl Iterator<Item = String>, mode: &str) -> Checked<(Value, i32)> {
    let first = args.next().ok_or(())?;
    if mode == "compact" {
        let (mut limit, mut files, mut exit, mut expect) = (6, false, None, Vec::new());
        let mut expected_tests = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--limit" => limit = args.next().ok_or(())?.parse().map_err(|_| ())?,
                "--files" => files = true,
                "--bun-exit" if exit.is_none() => {
                    exit = Some(args.next().ok_or(())?.parse().map_err(|_| ())?);
                }
                "--expect-tests" if expected_tests.is_none() => {
                    expected_tests = Some(count_value(&args.next().ok_or(())?)?);
                }
                "--expect-file" => {
                    if expect.len() == 256 {
                        return Err(());
                    }
                    expect.push(args.next().ok_or(())?);
                }
                _ => return Err(()),
            }
        }
        compact(&bounded(&first)?, limit, files, exit, &expect, expected_tests)
    } else {
        Err(())
    }
}

fn run_compare(mut args: impl Iterator<Item = String>, summary_only: bool) -> Compared<(Value, i32)> {
    let first = args.next().ok_or("invalid_arguments")?;
    let second = args.next().ok_or("invalid_arguments")?;
    let (mut ea, mut eb) = (None, None);
    while let Some(arg) = args.next() {
        let dest = match arg.as_str() {
            "--before-exit" => &mut ea,
            "--after-exit" => &mut eb,
            _ => return Err("invalid_arguments"),
        };
        if dest.is_some() {
            return Err("invalid_arguments");
        }
        *dest = Some(
            args.next()
                .ok_or("invalid_arguments")?
                .parse()
                .map_err(|_| "invalid_arguments")?,
        );
    }
    let ea = ea.ok_or("invalid_arguments")?;
    let eb = eb.ok_or("invalid_arguments")?;
    compare(
        &bounded(&first).map_err(|_| "before_report_unavailable")?,
        &bounded(&second).map_err(|_| "after_report_unavailable")?,
        ea,
        eb,
        summary_only,
    )
}

struct ScopedReport(std::path::PathBuf);

impl ScopedReport {
    fn create() -> std::io::Result<Self> {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("yomumi-evidence-{}-{nonce}", std::process::id()));
        std::fs::create_dir(&dir)?;
        Ok(Self(dir))
    }

    fn path(&self) -> std::path::PathBuf {
        self.0.join("run.xml")
    }
}

impl Drop for ScopedReport {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.path());
        let _ = std::fs::remove_dir(&self.0);
    }
}

fn run_scoped(mut args: impl Iterator<Item = String>) -> Compared<(Value, i32)> {
    use std::process::{Command, Stdio};

    let mut count = None;
    let mut files = Vec::new();
    let mut seen = BTreeSet::new();
    while let Some(flag) = args.next() {
        let value = args.next().ok_or("invalid_arguments")?;
        match flag.as_str() {
            "--expect-tests" if count.is_none() => {
                let n = count_value(&value).map_err(|_| "invalid_arguments")?;
                if n == 0 {
                    return Err("invalid_arguments");
                }
                count = Some(n);
            }
            "--expect-file" if files.len() < 256 => {
                let file = relative_file(&value).ok_or("invalid_arguments")?;
                if !seen.insert(file.clone()) {
                    return Err("invalid_arguments");
                }
                files.push(file);
            }
            _ => return Err("invalid_arguments"),
        }
    }
    let count = count.ok_or("invalid_arguments")?;
    if files.is_empty() {
        return Err("invalid_arguments");
    }
    let root = std::env::current_dir().map_err(|_| "project_directory_unavailable")?;
    let root = root.canonicalize().map_err(|_| "project_directory_unavailable")?;
    for file in &files {
        let resolved = root.join(file).canonicalize().map_err(|_| "expected_file_unavailable")?;
        if !resolved.starts_with(&root) || !resolved.is_file() {
            return Err("expected_file_unavailable");
        }
    }
    let temp = ScopedReport::create().map_err(|_| "report_directory_unavailable")?;
    let path = temp.path();
    let mut output = std::ffi::OsString::from("--reporter-outfile=");
    output.push(&path);
    let exit = Command::new("bun")
        .args(["test", "--reporter=junit"])
        .arg(output)
        .args(files.iter().map(|file| format!("./{file}")))
        .current_dir(root)
        .env_remove("BUN_OPTIONS")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "bun_start_failed")?
        .code()
        .ok_or("bun_exit_unavailable")?;
    let bytes = bounded(path).map_err(|_| "bun_report_unavailable")?;
    compact(&bytes, 6, false, Some(exit), &files, Some(count)).map_err(|_| "bun_report_invalid")
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
    let help_flag = |s: &str| matches!(s, "-h" | "--help");
    if help_flag(&mode) && args.len() == 0 {
        println!("yomumi-evidence: verify Bun JUnit test evidence\n\nCommands:\n  compact  Summarize one report and optionally verify its file scope.\n  compare  Find fixes, regressions, and changed failures across matched runs.\n  run-scoped  Run Bun and verify the intended files and test count.\n\nUse a command with --help for usage.\nCompare exit 0 means reports are comparable; it does not certify a pass.");
        return;
    }
    if args.len() == 1 && help_flag(&args.as_slice()[0]) {
        match mode.as_str() {
            "run-scoped" => {
                println!("Usage: yomumi-evidence run-scoped --expect-tests N --expect-file FILE [--expect-file FILE ...]\n\nRun from the project root with Bun on PATH. Supply an exact count from a trusted full run.\nExit 0 scoped pass, 1 scoped failure, 2 unverified or invalid.");
                return;
            }
            "compact" => {
                println!("Usage: yomumi-evidence compact REPORT [--limit N] [--files]\n       [--bun-exit EXIT --expect-file FILE ... [--expect-tests N]]\n\nCapture Bun's actual exit and repeat --expect-file for every intended test file.\nOptionally require an exact test count from a trusted full run.\n--limit: 1-12 clusters (default 6). --files: include per-file counts.\nScoped exits: 0 scoped pass, 1 scoped failure, 2 unverified or invalid.\nWithout a scope, exit 0 only means a summary was produced.");
                return;
            }
            "compare" => {
                println!("Usage: yomumi-evidence compare [--diagnostics] [--summary-only] BEFORE AFTER --before-exit EXIT --after-exit EXIT\n\nCapture actual Bun exits immediately. Use the same test selection in both runs.\nExit 0 means reports are comparable, not that the candidate passed.\nInspect afterFailed, changeCount, and changes. Exit 2 means incomplete or invalid.\nPut optional flags before BEFORE. --diagnostics adds a reason on exit 2.\n--summary-only shows complete category counts without listing individual tests.");
                return;
            }
            _ => {}
        }
    }
    let (output, exit) = if mode == "compare" {
        let (mut diagnostics, mut summary_only) = (false, false);
        while let Some(option) = args.as_slice().first() {
            match option.as_str() {
                "--diagnostics" => diagnostics = true,
                "--summary-only" => summary_only = true,
                _ => break,
            }
            args.next();
        }
        run_compare(args, summary_only).unwrap_or_else(|reason| {
            let mut output = json!({"schemaVersion":1,"kind":"yomumi.matched-test-delta","verdict":"incomplete"});
            if diagnostics {
                output["reason"] = json!(reason);
            }
            (output, 2)
        })
    } else if mode == "run-scoped" {
        run_scoped(args).unwrap_or_else(|reason| (json!({"status":"unverified","reason":reason}), 2))
    } else {
        run(args, &mode).unwrap_or_else(|()| {
            (json!({"status":"unverified","reason":"missing_invalid_or_incomplete_bun_junit"}), 2)
        })
    };
    println!("{output}");
    std::process::exit(exit);
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    fn report(marker: &str) -> Vec<u8> {
        format!(r#"<testsuites name="bun test" tests="1" failures="0" skipped="0"><testcase file="fixture.test.ts" name="retry">{marker}</testcase></testsuites>"#).into_bytes()
    }

    #[test]
    fn retry_markers_cannot_become_clean_evidence() {
        let expected = ["fixture.test.ts".to_owned()];
        for tag in ["flakyFailure", "rerunFailure"] {
            let data = report(&format!("<{tag} message=\"retry\"/>"));
            assert!(compact(&data, 6, false, Some(0), &expected, None).is_err());
            assert!(compare(&report(""), &data, 0, 0, false).is_err());
        }
        assert!(compact(&report(""), 6, false, Some(0), &expected, None).is_ok());
    }
}
#[test]
fn late_regression_survives_the_detail_cap() {
    let xml = |after: bool| {
        let failures = if after { 2 } else { 14 };
        let mut body = format!(r#"<testsuites name="bun test" tests="15" failures="{failures}" skipped="0"><testsuite>"#);
        for i in 0..15 {
            let result = match (i, after) {
                (0..=12, false) | (13, true) => r#"<failure message="broken"/>"#,
                (14, false) => r#"<failure message="earlier"/>"#,
                (14, true) => r#"<failure message="later"/>"#,
                _ => "",
            };
            body.push_str(&format!(r#"<testcase name="case {i}" file="test.ts">{result}</testcase>"#));
        }
        body.push_str("</testsuite></testsuites>");
        body
    };
    let (out, code) = compare(xml(false).as_bytes(), xml(true).as_bytes(), 1, 1, false).unwrap();
    assert_eq!(code, 0);
    assert_eq!(out["changeCount"], 15);
    let rows = out["changes"].as_array().unwrap();
    assert_eq!(rows.len(), 12);
    assert_eq!(rows.iter().filter(|row| row["change"] == "regression").count(), 1);
}

#[test]
fn blank_case_identity_cannot_verify_a_report() {
    for name in ["", "   "] {
        let xml = format!(r#"<testsuites name="bun test" tests="1" failures="0" skipped="0"><testsuite><testcase name="{name}" file="example.test.ts"/></testsuite></testsuites>"#);
        let scope = ["example.test.ts".to_owned()];
        assert!(compact(xml.as_bytes(), 6, false, Some(0), &scope, None).is_err());
        assert!(compare(xml.as_bytes(), xml.as_bytes(), 0, 0, false).is_err());
    }
}

#[test]
fn declared_suite_totals_must_match_even_if_root_totals_match() {
    let report = |alpha: &str, beta: &str| format!(
        r#"<testsuites name="bun test" tests="2" failures="0" skipped="0">
        <testsuite name="alpha" tests="{alpha}" failures="0" skipped="0"><testcase name="one" file="alpha.test.ts"/></testsuite>
        <testsuite name="beta" tests="{beta}" failures="0" skipped="0"><testcase name="two" file="beta.test.ts"/></testsuite>
        </testsuites>"#
    );
    let scope = ["alpha.test.ts".to_owned(), "beta.test.ts".to_owned()];
    let good = report("1", "1");
    let bad = report("2", "0");
    assert_eq!(compact(good.as_bytes(), 6, false, Some(0), &scope, None).unwrap().1, 0);
    assert!(compact(bad.as_bytes(), 6, false, Some(0), &scope, None).is_err());
    assert!(compare(good.as_bytes(), bad.as_bytes(), 0, 0, false).is_err());
}
