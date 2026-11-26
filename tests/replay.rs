use std::{path::PathBuf, process::Command};
use serde_json::Value;

fn report(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("examples").join("replay").join(name)
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

fn compare(candidate: &str) -> (i32, Value) {
    let before = report("before.xml");
    let after = report(candidate);
    run(&["compare", before.to_str().unwrap(), after.to_str().unwrap(),
          "--before-exit", "1", "--after-exit", "0"])
}

#[test]
fn same_tests_report_one_fix() {
    let (code, delta) = compare("after.xml");
    assert_eq!(code, 0);
    assert_eq!(delta["verdict"], "matched");
    assert_eq!(delta["tests"], 2);
    assert_eq!(delta["afterFailed"], 0);
    assert_eq!(delta["changeCount"], 1);
    assert_eq!(delta["changes"][0]["change"], "fixed");
}

#[test]
fn green_but_skipped_is_not_comparable() {
    let (code, delta) = compare("filtered.xml");
    assert_eq!(code, 2);
    assert_eq!(delta["verdict"], "incomplete");
    let filtered = report("filtered.xml");
    let (code, evidence) = run(&["compact", filtered.to_str().unwrap(), "--bun-exit",
                                 "0", "--expect-file", "examples/fixture.test.ts"]);
    assert_eq!(code, 2);
    assert_eq!(evidence["verdict"], "unverified");
    assert_eq!(evidence["skipped"], 1);
    assert_eq!(evidence["problems"][0], "skipped_tests");
}

#[test]
fn green_but_wrong_expected_file_is_not_verified() {
    let after = report("after.xml");
    let (code, evidence) = run(&["compact", after.to_str().unwrap(), "--bun-exit",
                                 "0", "--expect-file", "examples/missing.test.ts"]);
    assert_eq!(code, 2);
    assert_eq!(evidence["verdict"], "unverified");
    assert_eq!(evidence["problems"][0], "file_coverage_mismatch");
}

fn compare_regression_fixture(candidate: &str) -> (i32, Value) {
    let before = report("baseline.xml");
    let after = report(candidate);
    run(&["compare", before.to_str().unwrap(), after.to_str().unwrap(),
          "--before-exit", "1", "--after-exit", "1"])
}

#[test]
fn equal_failure_totals_can_hide_a_new_regression() {
    let (code, delta) = compare_regression_fixture("moved-failure.xml");
    assert_eq!(code, 0);
    assert_eq!(delta["verdict"], "matched");
    assert_eq!(delta["beforeFailed"], 1);
    assert_eq!(delta["afterFailed"], 1);
    assert_eq!(delta["changeCount"], 2);
    let mut changes: Vec<_> = delta["changes"].as_array().unwrap().iter()
        .map(|x| x["change"].as_str().unwrap()).collect();
    changes.sort_unstable();
    assert_eq!(changes, vec!["fixed", "regression"]);
}

#[test]
fn same_failing_test_with_a_different_signal_is_not_a_fix() {
    let (code, delta) = compare_regression_fixture("different-failure.xml");
    assert_eq!(code, 0);
    assert_eq!(delta["verdict"], "matched");
    assert_eq!(delta["beforeFailed"], 1);
    assert_eq!(delta["afterFailed"], 1);
    assert_eq!(delta["changeCount"], 1);
    assert_eq!(delta["changes"][0]["change"], "changed_failure");
}

#[test]
fn help_is_explicit_and_explains_compare_exit() {
    for args in [&["--help"][..], &["compare", "--help"][..]] {
        let out = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence")).args(args).output().unwrap();
        assert_eq!(out.status.code(), Some(0));
        assert!(out.stderr.is_empty());
        assert!(String::from_utf8(out.stdout).unwrap().contains("0 means reports are comparable"));
    }
    let (code, delta) = run(&["compare", "missing.xml", "--help"]);
    assert_eq!(code, 2);
    assert_eq!(delta["verdict"], "incomplete");
}

#[test]
fn compact_help_distinguishes_scoped_failure_and_incomplete() {
    let out = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
        .args(["compact", "--help"]).output().unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stderr.is_empty());
    let help = String::from_utf8(out.stdout).unwrap();
    assert!(help.contains("1 scoped failure"));
    assert!(help.contains("2 unverified"));
}
#[test]
fn compare_diagnostics_point_to_the_problem_without_echoing_paths() {
    let before = report("before.xml");
    let clean = report("after.xml");
    let filtered = report("filtered.xml");
    let scope = |after: &str, exit: &str| run(&[
        "compare", "--diagnostics", before.to_str().unwrap(), after,
        "--before-exit", "1", "--after-exit", exit,
    ]);
    let (code, value) = scope(filtered.to_str().unwrap(), "0");
    assert_eq!(code, 2);
    assert_eq!(value["verdict"], "incomplete");
    assert_eq!(value["reason"], "after_skipped_tests");
    let (code, value) = scope(clean.to_str().unwrap(), "1");
    assert_eq!(code, 2);
    assert_eq!(value["reason"], "after_bun_exit_disagrees");
    let (code, value) = scope("private-missing-report.xml", "0");
    assert_eq!(code, 2);
    assert_eq!(value["reason"], "after_report_unavailable");
    assert!(!value.to_string().contains("private-missing"));
    let (code, value) = scope(clean.to_str().unwrap(), "0");
    assert_eq!(code, 0);
    assert_eq!(value["verdict"], "matched");
    assert!(value.get("reason").is_none());
    assert!(compare("filtered.xml").1.get("reason").is_none());
}

#[test]
fn compare_diagnostics_distinguish_bad_args_from_changed_test_identity() {
    let (code, value) = run(&["compare", "--diagnostics"]);
    assert_eq!(code, 2);
    assert_eq!(value["reason"], "invalid_arguments");
    let before = report("before.xml");
    let other = report("baseline.xml");
    let (code, value) = run(&[
        "compare", "--diagnostics", before.to_str().unwrap(), other.to_str().unwrap(),
        "--before-exit", "1", "--after-exit", "1",
    ]);
    assert_eq!(code, 2);
    assert_eq!(value["reason"], "test_identity_mismatch");
}
#[test]
fn summary_only_keeps_all_totals_without_listing_tests() {
    let before = report("baseline.xml");
    let after = report("moved-failure.xml");
    let (code, result) = run(&[
        "compare", "--summary-only", before.to_str().unwrap(), after.to_str().unwrap(),
        "--before-exit", "1", "--after-exit", "1",
    ]);
    assert_eq!(code, 0);
    assert_eq!(result["verdict"], "matched");
    assert_eq!(result["changeCount"], 2);
    assert_eq!(result["changeCounts"], serde_json::json!({"fixed":1,"regression":1,"changed_failure":0}));
    assert!(result.get("changes").is_none());
    assert_eq!(result["omittedChanges"], 2);
    assert!(result.get("beforeSha256").is_some());
    let (code, failed) = run(&["compare", "--summary-only", "--diagnostics"]);
    assert_eq!(code, 2);
    assert_eq!(failed["reason"], "invalid_arguments");
    assert!(failed.get("changeCounts").is_none());
}

#[test]
fn duplicate_compact_exit_cannot_override_the_observed_exit() {
    let after = report("after.xml");
    for first in ["0", "1"] {
        let (code, result) = run(&[
            "compact", after.to_str().unwrap(), "--bun-exit", first,
            "--bun-exit", "0", "--expect-file", "examples/fixture.test.ts",
        ]);
        assert_eq!(code, 2);
        assert_eq!(result["status"], "unverified");
    }
}

#[test]
fn duplicate_compare_exits_cannot_override_observed_exits() {
    let before = report("before.xml");
    let after = report("after.xml");
    for (flag, value) in [("--before-exit", "1"), ("--before-exit", "0"), ("--after-exit", "0"), ("--after-exit", "1")] {
        let (code, result) = run(&[
            "compare", "--diagnostics", before.to_str().unwrap(), after.to_str().unwrap(),
            flag, value, "--before-exit", "1", "--after-exit", "0",
        ]);
        assert_eq!(code, 2);
        assert_eq!(result["verdict"], "incomplete");
        assert_eq!(result["reason"], "invalid_arguments");
    }
}

#[test]
fn scoped_compact_rejects_a_smaller_observed_count() {
    let after = report("after.xml");
    let path = after.to_str().unwrap();
    let check = |count: &str| run(&["compact", path, "--bun-exit", "0",
        "--expect-file", "examples/fixture.test.ts", "--expect-tests", count]);
    assert_eq!(check("2").0, 0);
    let (code, result) = check("3");
    assert_eq!(code, 2);
    assert_eq!(result["problems"][0], "test_count_mismatch");
    assert_eq!(result["expectedTests"], 3);
    assert_eq!(result["tests"], 2);
    assert_eq!(check("0").0, 2);
    assert_eq!(run(&["compact", path, "--expect-tests", "2"]).0, 2);
}
