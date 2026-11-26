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
