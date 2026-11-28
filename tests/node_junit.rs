//! CLI checks against reports written by a real `node --test` run.
//! Generate them with `node tests/fixtures/node/generate.mjs`.
use serde_json::Value;
use std::{path::PathBuf, process::Command};

const PAIR: &str = "tests/fixtures/node/pair.fixture.mjs";
const MIXED: &str = "tests/fixtures/node/mixed.fixture.mjs";
const CRASH: &str = "tests/fixtures/node/crash.fixture.mjs";

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

fn run(args: &[&str]) -> (i32, Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
        .args(args)
        .output()
        .expect("start the CLI");
    assert!(output.stderr.is_empty(), "{:?}", output.stderr);
    let json = serde_json::from_slice(&output.stdout).expect("valid CLI JSON");
    (output.status.code().expect("normal exit"), json)
}

fn compact(name: &str, exit: &str, files: &[&str]) -> (i32, Value) {
    let path = report(name);
    let mut args = vec![
        "compact",
        &path,
        "--node-exit",
        exit,
        "--node-root",
        "/fixture-root",
    ];
    for file in files {
        args.extend(["--expect-file", *file]);
    }
    run(&args)
}

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
        "--before-root",
        "/fixture-root",
        "--after-root",
        "/fixture-root",
    ])
}

fn source_duration(name: &str) -> String {
    let xml = std::fs::read_to_string(report(name)).unwrap();
    let (_, tail) = xml.split_once("<!-- duration_ms ").expect("duration comment");
    tail.split_once(" -->").expect("comment end").0.to_owned()
}

#[test]
fn real_clean_run_is_a_scoped_pass_with_source_duration() {
    let (code, result) = compact("clean", "0", &[PAIR]);
    assert_eq!(code, 0, "{result}");
    assert_eq!(result["verdict"], "scoped-pass");
    assert_eq!(result["kind"], "yomumi.node-test-summary");
    assert_eq!(result["tests"], 2);
    assert_eq!(result["durationMs"]["source"], source_duration("clean"));
}

#[test]
fn real_failure_then_pass_is_one_fix() {
    let (code, result) = compare("broken", "clean", "1", "0");
    assert_eq!(code, 0, "{result}");
    assert_eq!(result["changeCount"], 1);
    assert_eq!(result["changes"][0]["change"], "fixed");
    assert_eq!(result["durationMs"]["before"], source_duration("broken"));
    assert_eq!(result["durationMs"]["after"], source_duration("clean"));
}

#[test]
fn real_run_with_a_missing_test_is_never_a_fix() {
    let (code, result) = compare("broken", "missing", "1", "0");
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["reason"], "test_identity_mismatch");
    assert!(result.get("changes").is_none());
}

#[test]
fn real_skip_and_todo_are_unverified() {
    let (code, result) = compact("mixed", "1", &[MIXED]);
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["tests"], 5);
    assert_eq!(result["failures"], 1);
    assert_eq!(result["skipped"], 2);
    assert_eq!(result["todo"], 1);
    assert_eq!(result["problems"], serde_json::json!(["skipped_tests"]));
    assert_eq!(compare("mixed", "mixed", "1", "1").1["reason"], "before_skipped_tests");
}

#[test]
fn real_crashed_file_is_unverified_and_not_comparable() {
    let (code, result) = compact("crash", "1", &[PAIR, CRASH]);
    assert_eq!(code, 2, "{result}");
    assert_eq!(result["verdict"], "unverified");
    assert_eq!(result["problems"][0], "file_level_result");
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
