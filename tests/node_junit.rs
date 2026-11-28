//! CLI checks against reports written by a real `node --test` run.
//! Generate them with `node tests/fixtures/node/generate.mjs`.
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command};

const PAIR: &str = "tests/fixtures/node/pair.fixture.mjs";
const MIXED: &str = "tests/fixtures/node/mixed.fixture.mjs";

fn report(name: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/node")
        .join(format!("{name}.xml"));
    assert!(
        path.is_file(),
        "missing {name}.xml: run `node tests/fixtures/node/generate.mjs` first"
    );
    path.to_str().unwrap().to_owned()
}

fn xml(name: &str) -> String {
    std::fs::read_to_string(report(name)).unwrap()
}

fn run(args: &[&str]) -> (i32, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
        .args(args)
        .output()
        .expect("start the CLI");
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
    let json = serde_json::from_slice(&output.stdout).expect("valid CLI JSON");
    (output.status.code().expect("normal exit"), json)
}

/// A report produced from one file, declared and expected as `file`.
fn compact(name: &str, exit: &str, file: &str, tests: &str) -> (i32, Value) {
    let path = report(name);
    run(&[
        "compact",
        &path,
        "--node-exit",
        exit,
        "--node-file",
        file,
        "--expect-file",
        file,
        "--expect-tests",
        tests,
    ])
}

/// All states of the pair suite are declared as the same file under test.
fn compare(before: &str, after: &str, before_exit: &str, after_exit: &str) -> (i32, Value) {
    let (before, after) = (report(before), report(after));
    run(&[
        "compare",
        "--diagnostics",
        &before,
        &after,
        "--before-exit",
        before_exit,
        "--after-exit",
        after_exit,
        "--node-file",
        PAIR,
    ])
}

fn source_duration(name: &str) -> String {
    let xml = xml(name);
    let (_, tail) = xml.split_once("<!-- duration_ms ").expect("duration comment");
    tail.split_once(" -->").expect("comment end").0.to_owned()
}

#[test]
fn real_reports_name_no_source_file_for_a_testcase() {
    // The premise of caller-declared scope. If a Node release changes this, revisit it.
    for name in ["clean", "broken", "gone", "mixed", "crash", "exit", "late-exit", "empty"] {
        let xml = xml(name);
        assert!(!xml.contains("file=\""), "{name}");
        assert!(!xml.contains("<properties"), "{name}");
    }
    assert!(!xml("clean").contains(".mjs"));
}

#[test]
fn real_clean_run_is_a_scoped_pass_with_source_duration() {
    let (code, result) = compact("clean", "0", PAIR, "2");
    assert_eq!(code, 0, "{result}");
    assert_eq!(result["verdict"], "scoped-pass");
    assert_eq!(result["kind"], "yomumi.node-test-summary");
    assert_eq!(result["fileScope"], "caller_declared");
    assert_eq!(result["tests"], 2);
    assert_eq!(result["durationMs"]["source"], source_duration("clean"));
}

#[test]
fn real_failing_run_is_a_scoped_fail() {
    let (code, result) = compact("broken", "1", PAIR, "2");
    assert_eq!(code, 1, "{result}");
    assert_eq!(result["verdict"], "scoped-fail");
    assert_eq!(result["failures"], 1);
}

#[test]
fn real_report_without_a_declared_file_is_unverified() {
    let path = report("clean");
    let (code, result) = run(&[
        "compact",
        &path,
        "--node-exit",
        "0",
        "--expect-file",
        PAIR,
        "--expect-tests",
        "2",
    ]);
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["fileScope"], "unknown");
    assert_eq!(result["problems"], json!(["file_coverage_mismatch"]));
    let (code, result) = run(&[
        "compare",
        "--diagnostics",
        &path,
        &path,
        "--before-exit",
        "0",
        "--after-exit",
        "0",
    ]);
    assert_eq!(code, 2);
    assert_eq!(result["reason"], "before_file_scope_invalid");
}

#[test]
fn real_failure_then_pass_is_one_fix() {
    let (code, result) = compare("broken", "clean", "1", "0");
    assert_eq!(code, 0, "{result}");
    assert_eq!(result["changeCount"], 1);
    assert_eq!(result["changes"][0]["change"], "fixed");
    assert_eq!(result["fileScope"], "caller_declared");
    assert_eq!(result["durationMs"]["before"], source_duration("broken"));
    assert_eq!(result["durationMs"]["after"], source_duration("clean"));
}

#[test]
fn real_run_with_a_missing_test_is_never_a_fix() {
    // "gone" deleted the failing test; "late-exit" and "exit" never reached tests.
    for (after, reason) in [
        ("gone", "test_identity_mismatch"),
        ("late-exit", "test_identity_mismatch"),
        ("exit", "after_file_level_result"),
        ("empty", "after_file_level_result"),
    ] {
        let (code, result) = compare("broken", after, "1", "0");
        assert_eq!(code, 2, "{after}: {result}");
        assert_eq!(result["verdict"], "incomplete");
        assert_eq!(result["reason"], reason, "{after}");
        assert!(result.get("changes").is_none());
        assert!(result.get("changeCounts").is_none());
    }
}

#[test]
fn real_early_exit_that_looks_clean_needs_the_trusted_count() {
    // Exit 0, no failure, no file-level row: only the count shows two tests are gone.
    let (code, result) = compact("late-exit", "0", PAIR, "3");
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["problems"], json!(["test_count_mismatch"]));
    let path = report("late-exit");
    let (code, result) = run(&[
        "compact",
        &path,
        "--node-exit",
        "0",
        "--node-file",
        PAIR,
        "--expect-file",
        PAIR,
    ]);
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["problems"], json!(["expected_test_count_required"]));
}

#[test]
fn real_exit_inside_a_test_and_empty_file_are_file_level_results() {
    for name in ["exit", "empty"] {
        // Even with a matching count, a row that stands for a whole file is no pass.
        let (code, result) = compact(name, "0", PAIR, "1");
        assert_eq!(code, 2, "{name}: {result}");
        assert_eq!(result["problems"], json!(["file_level_result"]), "{name}");
    }
}

#[test]
fn real_skip_and_todo_are_unverified() {
    let (code, result) = compact("mixed", "1", MIXED, "5");
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["tests"], 5);
    assert_eq!(result["failures"], 1);
    assert_eq!(result["skipped"], 2);
    assert_eq!(result["todo"], 1);
    assert_eq!(result["problems"], json!(["skipped_tests"]));
    assert_eq!(compare("mixed", "mixed", "1", "1").1["reason"], "before_skipped_tests");
}

#[test]
fn real_crashed_file_is_unverified_and_not_comparable() {
    let (code, result) = compact("crash", "1", PAIR, "3");
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["verdict"], "unverified");
    assert_eq!(result["problems"], json!(["file_level_result"]));
    let (code, result) = compare("broken", "crash", "1", "1");
    assert_eq!(code, 2);
    assert_eq!(result["reason"], "after_file_level_result");
}

#[test]
fn real_node_report_cannot_pass_as_bun_evidence() {
    let path = report("clean");
    let (code, result) = run(&["compact", &path, "--bun-exit", "0", "--expect-file", PAIR]);
    assert_eq!(code, 2);
    assert_eq!(result["status"], "unverified");
}
