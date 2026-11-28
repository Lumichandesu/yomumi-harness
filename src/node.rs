//! JUnit XML written by Node's built-in reporter (`node --test --test-reporter=junit`).
//!
//! The format differs from Bun's: the root has no attributes, run totals are root-level
//! comments, suite totals cover direct children only, and testcases carry no source line.

use super::{
    attr, count_value, delta, sha, summarize, tag, xml_text, Checked, Cluster, Compared, Counts,
    Report, Request, Runner,
};
use roxmltree::{Document, Node};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const NODE: Runner = Runner {
    kind: "yomumi.node-test-summary",
    exit_key: "nodeExit",
    exit_problem: "node_exit_disagrees",
};
const SUMMARY: [&str; 8] = [
    "tests",
    "suites",
    "pass",
    "fail",
    "cancelled",
    "skipped",
    "todo",
    "duration_ms",
];
const MAX_DEPTH: usize = 64;

/// Decimal milliseconds, kept as source text plus an integer count of 0.0001 ms.
/// Digits beyond the fourth place round half up. No floating point is involved.
struct Millis {
    source: String,
    ticks: u64,
}

impl Millis {
    fn parse(text: &str) -> Checked<Self> {
        let (whole, fraction) = match text.split_once('.') {
            Some((whole, fraction)) => (whole, Some(fraction)),
            None => (text, None),
        };
        let digits = |s: &str, max: usize| {
            !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit())
        };
        if !digits(whole, 12) || fraction.is_some_and(|f| !digits(f, 24)) {
            return Err(());
        }
        let fraction = fraction.unwrap_or("").as_bytes();
        let mut ticks: u64 = whole.parse().map_err(|_| ())?;
        for place in 0..4 {
            ticks = ticks * 10 + u64::from(fraction.get(place).map_or(0, |b| b - b'0'));
        }
        if fraction.get(4).is_some_and(|b| *b >= b'5') {
            ticks += 1;
        }
        Ok(Self {
            source: text.into(),
            ticks,
        })
    }
}

fn four_places(ticks: u64) -> String {
    format!("{}.{:04}", ticks / 10_000, ticks % 10_000)
}

fn signed_difference(before: u64, after: u64) -> String {
    if after >= before {
        four_places(after - before)
    } else {
        format!("-{}", four_places(before - after))
    }
}

struct NodeReport {
    report: Report,
    todo: usize,
    cancelled: usize,
    /// Results that stand for a whole file (a crash, or a file that registered no test).
    file_level: usize,
    duration: Millis,
}

struct Summary {
    tests: usize,
    suites: usize,
    pass: usize,
    fail: usize,
    cancelled: usize,
    skipped: usize,
    todo: usize,
    duration: Millis,
}

fn read_summary(root: Node<'_, '_>) -> Checked<Summary> {
    let mut found = BTreeMap::new();
    for comment in root.children().filter(|n| n.is_comment()) {
        let Some((key, value)) = comment.text().unwrap_or("").trim().split_once(' ') else {
            continue;
        };
        // A repeated key means a diagnostic is imitating the run totals.
        if SUMMARY.contains(&key) && found.insert(key.to_owned(), value.to_owned()).is_some() {
            return Err(());
        }
    }
    // A missing key reads as empty text, which neither parser accepts.
    let text = |key: &str| found.get(key).map_or("", String::as_str);
    Ok(Summary {
        tests: count_value(text("tests"))?,
        suites: count_value(text("suites"))?,
        pass: count_value(text("pass"))?,
        fail: count_value(text("fail"))?,
        cancelled: count_value(text("cancelled"))?,
        skipped: count_value(text("skipped"))?,
        todo: count_value(text("todo"))?,
        duration: Millis::parse(text("duration_ms"))?,
    })
}

fn is_node_root(root: Node<'_, '_>) -> bool {
    tag(root) == Some("testsuites") && root.attributes().next().is_none()
}

pub(crate) fn detect(raw: &[u8]) -> bool {
    xml_text(raw)
        .ok()
        .and_then(|text| Document::parse(text).ok())
        .is_some_and(|doc| is_node_root(doc.root_element()))
}

/// Suite totals in Node's reporter describe direct children only.
fn check_suite(suite: Node<'_, '_>) -> Checked<()> {
    if attr(suite, "name").trim().is_empty() {
        return Err(());
    }
    Millis::parse(attr(suite, "time"))?;
    let (mut children, mut failing, mut skipped, mut suites) = (0, 0, 0, 0);
    for child in suite.children().filter(|n| n.is_element()) {
        children += 1;
        if tag(child) == Some("testsuite") {
            suites += 1;
            failing += usize::from(count_value(attr(child, "failures"))? > 0);
        } else {
            let has = |name: &str| child.children().any(|n| tag(n) == Some(name));
            failing += usize::from(has("failure"));
            skipped += usize::from(has("skipped"));
        }
    }
    let declared = |key: &str| count_value(attr(suite, key));
    // Some Node releases derive a child suite's "skipped" mark differently, so a child
    // suite may or may not be counted. Direct skipped testcases must always be counted.
    if children == 0
        || declared("tests")? != children
        || declared("failures")? != failing
        || declared("errors")? != 0
        || !(skipped..=skipped + suites).contains(&declared("skipped")?)
    {
        return Err(());
    }
    Ok(())
}

/// Node emits absolute paths. Only the caller-supplied root is stripped.
fn project_file(raw: &str, root: Option<&str>) -> Option<String> {
    let path = raw.replace('\\', "/");
    let inside = root.and_then(|root| path.strip_prefix(root)?.strip_prefix('/'));
    super::relative_file(inside.unwrap_or(&path))
}

/// Node reports a file that crashed (or ran no test) as a top-level case named after it.
fn names_a_file(name: &str, raw_file: &str, file: Option<&str>, root: Option<&str>) -> bool {
    let name = name.replace('\\', "/");
    let raw_file = raw_file.replace('\\', "/");
    if !raw_file.is_empty() && (raw_file == name || raw_file.ends_with(&format!("/{name}"))) {
        return true;
    }
    project_file(&name, root).is_some_and(|path| path.contains('/') || file.is_none())
}

fn parse(raw: &[u8], root_dir: Option<&str>) -> Checked<NodeReport> {
    let doc = Document::parse(xml_text(raw)?).map_err(|_| ())?;
    let root = doc.root_element();
    if !is_node_root(root) {
        return Err(());
    }
    let summary = read_summary(root)?;
    let base = root_dir.map(|dir| dir.replace('\\', "/").trim_end_matches('/').to_owned());
    let base = base.as_deref();
    let mut r = Report {
        counts: Counts::default(),
        files: BTreeMap::new(),
        unknown: 0,
        groups: BTreeMap::new(),
        cases: BTreeMap::new(),
        order: Vec::new(),
    };
    let (mut suites, mut skipped, mut todo, mut file_level) = (0, 0, 0, 0);
    for node in root.descendants().filter(|n| n.is_element() && n.id() != root.id()) {
        let parent = node.parent().and_then(tag).ok_or(())?;
        let in_suite = matches!(parent, "testsuites" | "testsuite");
        match tag(node) {
            Some("testsuite") if in_suite => {
                check_suite(node)?;
                suites += 1;
                continue;
            }
            Some("testcase") if in_suite => {}
            Some("failure" | "skipped") if parent == "testcase" => continue,
            _ => return Err(()),
        }
        let name = attr(node, "name");
        if name.trim().is_empty() {
            return Err(());
        }
        Millis::parse(attr(node, "time"))?;
        let (mut failure, mut skip_mark, mut todo_mark) = (None, false, false);
        for child in node.children().filter(|n| n.is_element()) {
            match (tag(child), attr(child, "type")) {
                (Some("failure"), _) if failure.is_none() => failure = Some(child),
                (Some("skipped"), "skipped") if !skip_mark => skip_mark = true,
                (Some("skipped"), "todo") if !todo_mark => todo_mark = true,
                _ => return Err(()),
            }
        }
        if node.attribute("failure").is_some() && failure.is_none() {
            return Err(());
        }
        // Node's precedence: skip, then todo, then failure. A failing todo is not a failure.
        let signal = if skip_mark {
            skipped += 1;
            None
        } else if todo_mark {
            todo += 1;
            None
        } else {
            failure
        };
        r.counts.tests += 1;
        r.counts.failures += usize::from(signal.is_some());
        let raw_file = attr(node, "file");
        let file = project_file(raw_file, base);
        if parent == "testsuites" && names_a_file(name, raw_file, file.as_deref(), base) {
            file_level += 1;
        }
        if let Some(file) = file.as_ref() {
            let counts = r.files.entry(file.clone()).or_default();
            counts.tests += 1;
            counts.failed += usize::from(signal.is_some());
            counts.skipped += usize::from(skip_mark || todo_mark);
        } else {
            r.unknown += 1;
        }
        let result = signal.map(|item| {
            let kind = attr(item, "type");
            let message = attr(item, "message");
            let key = if message.is_empty() {
                json!(["failure", kind, file, name])
            } else {
                json!(["failure", kind, message])
            };
            let cluster = r
                .groups
                .entry(sha(key.to_string())[..20].to_owned())
                .or_insert_with(|| Cluster {
                    kind: if matches!(
                        kind,
                        "testCodeFailure"
                            | "cancelledByParent"
                            | "testTimeoutFailure"
                            | "hookFailed"
                            | "uncaughtException"
                            | "unhandledRejection"
                    ) {
                        kind.into()
                    } else {
                        "failure".into()
                    },
                    ..Cluster::default()
                });
            cluster.count += 1;
            if let Some(file) = file.as_ref() {
                cluster.files.insert(file.clone());
            } else {
                cluster.unknown += 1;
            }
            sha(["failure", kind, message].join("\0"))
        });
        if let Some(file) = file {
            // No source line is available, so the describe path is part of the identity.
            let mut path: Vec<_> = node
                .ancestors()
                .skip(1)
                .take(MAX_DEPTH + 1)
                .filter(|n| tag(*n) == Some("testsuite"))
                .map(|n| attr(n, "name"))
                .collect();
            if path.len() > MAX_DEPTH {
                return Err(());
            }
            path.reverse();
            let key = [
                file,
                json!(path).to_string(),
                name.into(),
                attr(node, "classname").into(),
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
    r.counts.skipped = skipped + todo;
    let c = &r.counts;
    if c.tests == 0
        || summary.tests != c.tests
        || summary.suites != suites
        || summary.skipped != skipped
        || summary.todo != todo
        || summary.fail + summary.cancelled != c.failures
        || summary.pass + c.failures + c.skipped != c.tests
    {
        return Err(());
    }
    Ok(NodeReport {
        report: r,
        todo,
        cancelled: summary.cancelled,
        file_level,
        duration: summary.duration,
    })
}

pub(crate) fn compact(raw: &[u8], root: Option<&str>, request: &Request) -> Checked<(Value, i32)> {
    let node = parse(raw, root)?;
    let mut problems = Vec::new();
    if node.file_level > 0 {
        problems.push("file_level_result");
    }
    if node.cancelled > 0 {
        problems.push("cancelled_tests");
    }
    let (mut result, code) = summarize(&node.report, &NODE, request, problems);
    result["todo"] = json!(node.todo);
    result["cancelled"] = json!(node.cancelled);
    result["fileLevelResults"] = json!(node.file_level);
    result["durationMs"] = json!({
        "source": node.duration.source,
        "fourPlaces": four_places(node.duration.ticks),
    });
    Ok((result, code))
}

fn comparable(r: &NodeReport, exit: i32, reasons: [&'static str; 5]) -> Compared<()> {
    if r.file_level > 0 {
        Err(reasons[0])
    } else if r.report.unknown > 0 || r.report.files.len() > 256 {
        Err(reasons[1])
    } else if r.report.counts.skipped > 0 {
        Err(reasons[2])
    } else if r.cancelled > 0 {
        Err(reasons[3])
    } else if exit != i32::from(r.report.counts.failures > 0) {
        Err(reasons[4])
    } else {
        Ok(())
    }
}

pub(crate) fn compare(
    raw: [&[u8]; 2],
    roots: [Option<&str>; 2],
    exits: [i32; 2],
    summary_only: bool,
) -> Compared<(Value, i32)> {
    let load = |side: usize, invalid: &'static str| {
        parse(raw[side], roots[side]).map_err(|()| {
            if super::parse(raw[side], false).is_ok() {
                "runner_mismatch"
            } else {
                invalid
            }
        })
    };
    let before = load(0, "before_report_invalid")?;
    let after = load(1, "after_report_invalid")?;
    comparable(
        &before,
        exits[0],
        [
            "before_file_level_result",
            "before_file_scope_invalid",
            "before_skipped_tests",
            "before_cancelled_tests",
            "before_node_exit_disagrees",
        ],
    )?;
    comparable(
        &after,
        exits[1],
        [
            "after_file_level_result",
            "after_file_scope_invalid",
            "after_skipped_tests",
            "after_cancelled_tests",
            "after_node_exit_disagrees",
        ],
    )?;
    let mut output = delta(&before.report, &after.report, raw, summary_only)?;
    let (x, y) = (&before.duration, &after.duration);
    output["runner"] = json!("node");
    // Informational only: duration never changes the verdict.
    output["durationMs"] = json!({
        "before": x.source,
        "after": y.source,
        "beforeFourPlaces": four_places(x.ticks),
        "afterFourPlaces": four_places(y.ticks),
        "differenceFourPlaces": signed_difference(x.ticks, y.ticks),
    });
    Ok((output, 0))
}

/// These reports are hand-written to match the reporter's shape. Reports produced by a
/// real Node run are exercised in `tests/node_junit.rs`.
#[cfg(test)]
mod tests {
    use super::*;

    const FAIL: &str = r#"<failure type="testCodeFailure" message="2 !== 3">trace</failure>"#;
    const ROOT: Option<&str> = Some("/work");

    fn case(name: &str, inner: &str) -> String {
        format!(
            r#"<testcase name="{name}" time="0.000100" classname="test" file="/work/a.test.mjs">{inner}</testcase>"#
        )
    }

    fn suite(name: &str, tests: usize, failures: usize, body: &str) -> String {
        format!(
            r#"<testsuite name="{name}" time="0.000200" disabled="0" errors="0" tests="{tests}" failures="{failures}" skipped="0" hostname="h">{body}</testsuite>"#
        )
    }

    /// Counts: tests, suites, pass, fail, cancelled, skipped, todo.
    fn report(body: &str, counts: [usize; 7], duration: &str) -> String {
        let mut xml = format!("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<testsuites>{body}");
        for (key, count) in SUMMARY.iter().zip(counts) {
            xml.push_str(&format!("<!-- {key} {count} -->"));
        }
        xml.push_str(&format!("<!-- duration_ms {duration} --></testsuites>"));
        xml
    }

    fn pair(first: &str, second: &str, duration: &str) -> String {
        let failures = [first, second].iter().filter(|s| **s == FAIL).count();
        report(
            &(case("one", first) + &case("two", second)),
            [2, 0, 2 - failures, failures, 0, 0, 0],
            duration,
        )
    }

    fn scoped(xml: &str, exit: i32) -> (Value, i32) {
        let request =
            super::super::request(6, false, Some(exit), &["a.test.mjs".to_owned()], None).unwrap();
        compact(xml.as_bytes(), ROOT, &request).unwrap()
    }

    fn diff(before: &str, after: &str, exits: [i32; 2]) -> Compared<(Value, i32)> {
        compare(
            [before.as_bytes(), after.as_bytes()],
            [ROOT, ROOT],
            exits,
            false,
        )
    }

    #[test]
    fn durations_round_at_four_places_using_digits_only() {
        for (source, expected) in [
            ("1346.5348", "1346.5348"),
            ("1346.53484", "1346.5348"),
            ("1346.53485", "1346.5349"),
            ("1346.53475", "1346.5348"),
            ("1346.534849999999999999", "1346.5348"),
            ("9.99995", "10.0000"),
            ("0.00005", "0.0001"),
            ("0.000049999", "0.0000"),
            ("5", "5.0000"),
            ("5.1", "5.1000"),
            ("999999999999.99995", "1000000000000.0000"),
        ] {
            let parsed = Millis::parse(source).unwrap();
            assert_eq!(parsed.source, source);
            assert_eq!(four_places(parsed.ticks), expected, "{source}");
        }
    }

    #[test]
    fn malformed_durations_are_rejected() {
        for source in [
            "", ".", ".5", "5.", "-1", "+1", "1e3", "1E-7", "NaN", "inf", "Infinity", " 1", "1 ",
            "1,5", "1.2.3", "0x10", "١", "1000000000000",
        ] {
            assert!(Millis::parse(source).is_err(), "{source:?}");
        }
        assert!(Millis::parse(&format!("0.{}", "1".repeat(24))).is_ok());
        assert!(Millis::parse(&format!("0.{}", "1".repeat(25))).is_err());
    }

    #[test]
    fn compare_reports_exact_duration_text_and_difference() {
        let before = pair("", "", "1346.5348");
        for (after, rounded, difference) in [
            ("1346.5349", "1346.5349", "0.0001"),
            ("1346.5347", "1346.5347", "-0.0001"),
            ("1346.534800", "1346.5348", "0.0000"),
            ("1346.53484999", "1346.5348", "0.0000"),
        ] {
            let (out, _) = diff(&before, &pair("", "", after), [0, 0]).unwrap();
            assert_eq!(out["durationMs"]["before"], "1346.5348");
            assert_eq!(out["durationMs"]["after"], after);
            assert_eq!(out["durationMs"]["afterFourPlaces"], rounded);
            assert_eq!(out["durationMs"]["differenceFourPlaces"], difference);
        }
    }

    #[test]
    fn an_invalid_duration_invalidates_the_report() {
        let good = pair("", "", "1.5");
        for bad in [
            pair("", "", "1e3"),
            good.replace("time=\"0.000100\"", "time=\"NaN\""),
            good.replace("<!-- duration_ms 1.5 -->", ""),
        ] {
            assert!(parse(bad.as_bytes(), ROOT).is_err());
        }
    }

    #[test]
    fn matched_runs_report_a_fix() {
        let before = pair(FAIL, "", "2.5");
        let after = pair("", "", "2.5");
        assert_eq!(scoped(&before, 1).0["verdict"], "scoped-fail");
        assert_eq!(scoped(&after, 0).0["verdict"], "scoped-pass");
        let (out, code) = diff(&before, &after, [1, 0]).unwrap();
        assert_eq!(code, 0);
        assert_eq!(out["changes"][0]["change"], "fixed");
    }

    #[test]
    fn a_missing_test_is_never_a_fix() {
        let before = pair(FAIL, "", "2.5");
        let after = report(&case("two", ""), [1, 0, 1, 0, 0, 0, 0], "2.5");
        assert_eq!(diff(&before, &after, [1, 0]), Err("test_identity_mismatch"));
    }

    #[test]
    fn a_crashed_file_is_unverified_and_not_comparable() {
        for name in ["a.test.mjs", "/work/a.test.mjs", "sub/other.test.mjs"] {
            let crash = report(&case(name, FAIL), [1, 0, 0, 1, 0, 0, 0], "2.5");
            let (out, code) = scoped(&crash, 1);
            assert_eq!(code, 2, "{name}");
            assert_eq!(out["problems"][0], "file_level_result");
            assert_eq!(
                diff(&pair(FAIL, "", "2.5"), &crash, [1, 1]),
                Err("after_file_level_result")
            );
        }
    }

    #[test]
    fn skip_and_todo_cannot_verify_a_run() {
        for (mark, counts) in [
            (r#"<skipped type="skipped" message="true"/>"#, [1, 0, 0, 0, 0, 1, 0]),
            (r#"<skipped type="todo" message="true"/>"#, [1, 0, 0, 0, 0, 0, 1]),
        ] {
            let xml = report(&case("one", mark), counts, "2.5");
            let (out, code) = scoped(&xml, 0);
            assert_eq!(code, 2);
            assert_eq!(out["skipped"], 1);
            assert_eq!(diff(&xml, &xml, [0, 0]), Err("before_skipped_tests"));
        }
        let failing_todo = report(
            &case("one", &format!(r#"<skipped type="todo" message="true"/>{FAIL}"#)),
            [1, 0, 0, 0, 0, 0, 1],
            "2.5",
        );
        assert_eq!(scoped(&failing_todo, 0).0["failures"], 0);
    }

    #[test]
    fn cancelled_tests_and_wrong_exits_are_refused() {
        let cancelled = report(&case("one", FAIL), [1, 0, 0, 0, 1, 0, 0], "2.5");
        assert_eq!(scoped(&cancelled, 1).1, 2);
        assert_eq!(diff(&cancelled, &cancelled, [1, 1]), Err("before_cancelled_tests"));
        let clean = pair("", "", "2.5");
        assert_eq!(scoped(&clean, 1).1, 2);
        assert_eq!(diff(&clean, &clean, [0, 1]), Err("after_node_exit_disagrees"));
    }

    #[test]
    fn totals_that_disagree_with_rows_are_rejected() {
        let good = pair(FAIL, "", "2.5");
        for bad in [
            good.replace("<!-- tests 2 -->", "<!-- tests 3 -->"),
            good.replace("<!-- pass 1 -->", "<!-- pass 2 -->"),
            good.replace("<!-- fail 1 -->", "<!-- fail 0 -->"),
            good.replace("<!-- suites 0 -->", "<!-- suites 1 -->"),
            good.replace("<!-- todo 0 -->", ""),
            good.replace("<!-- todo 0 -->", "<!-- todo 0 --><!-- todo 0 -->"),
            good.replace("<testsuites>", "<testsuites><properties/>"),
            good.replace(FAIL, &format!("{FAIL}{FAIL}")),
            good.replace(FAIL, "<flakyFailure/>"),
        ] {
            assert!(parse(bad.as_bytes(), ROOT).is_err(), "{bad}");
        }
    }

    #[test]
    fn suite_totals_cover_direct_children() {
        let nested = |outer_failures| {
            let inner = suite("inner", 1, 1, &case("deep", FAIL));
            let body = suite("outer", 2, outer_failures, &(case("shallow", "") + &inner));
            report(&body, [2, 2, 1, 1, 0, 0, 0], "2.5")
        };
        assert!(parse(nested(1).as_bytes(), ROOT).is_ok());
        assert!(parse(nested(0).as_bytes(), ROOT).is_err());
    }

    #[test]
    fn equal_names_in_different_suites_stay_distinct() {
        let xml = |a: &str, b: &str| {
            let body = suite("a", 1, usize::from(a == FAIL), &case("works", a))
                + &suite("b", 1, usize::from(b == FAIL), &case("works", b));
            report(&body, [2, 2, 1, 1, 0, 0, 0], "2.5")
        };
        let (out, _) = diff(&xml(FAIL, ""), &xml("", FAIL), [1, 1]).unwrap();
        assert_eq!(out["changeCount"], 2);
    }

    #[test]
    fn paths_outside_the_supplied_root_are_unknown() {
        let xml = pair("", "", "2.5");
        assert_eq!(
            compare([xml.as_bytes(), xml.as_bytes()], [None, None], [0, 0], false),
            Err("before_file_scope_invalid")
        );
    }

    #[test]
    fn runners_cannot_be_mixed() {
        let node = pair("", "", "2.5");
        let bun = r#"<testsuites name="bun test" tests="1" failures="0" skipped="0"><testcase name="one" file="a.test.mjs"/></testsuites>"#;
        assert_eq!(diff(&node, bun, [0, 0]), Err("runner_mismatch"));
        assert_eq!(diff(bun, &node, [0, 0]), Err("runner_mismatch"));
        assert!(!detect(bun.as_bytes()));
        assert!(super::super::parse(node.as_bytes(), false).is_err());
    }
}
