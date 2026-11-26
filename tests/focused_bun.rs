use serde_json::Value;
use std::process::Command;

#[test]
#[ignore = "needs a local Bun executable"]
fn real_bun_run_enforces_exit_file_and_test_count() {
    let fixture = "examples/focused-run.test.ts";
    for (file, focus, quantity, tests, expected_exit, verdict, problem) in [
        (fixture, "0", "2", 2, 0, "scoped-pass", ""),
        (fixture, "1", "2", 1, 2, "unverified", "test_count_mismatch"),
        ("examples/fixture.test.ts", "0", "3", 2, 1, "scoped-fail", ""),
    ] {
        let checked = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args(["run-scoped", "--expect-tests", "2", "--expect-file", file])
            .env("HARNESS_DEMO_FOCUS", focus)
            .env("HARNESS_EXAMPLE_QUANTITY", quantity)
            .output()
            .expect("run Rust verifier");
        let json: Value = serde_json::from_slice(&checked.stdout).expect("valid evidence JSON");
        assert_eq!(checked.status.code(), Some(expected_exit), "{json}");
        assert_eq!(json["tests"], tests);
        assert_eq!(json["expectedTests"], 2);
        assert_eq!(json["bunExit"], i32::from(expected_exit == 1));
        assert_eq!(json["verdict"], verdict);
        if problem.is_empty() {
            assert_eq!(json["problems"], serde_json::json!([]));
        } else {
            assert_eq!(json["problems"], serde_json::json!([problem]));
        }
        println!("{file} focus={focus}: Bun={}, tests={tests}/2, Harness={expected_exit}", json["bunExit"]);
    }
}

#[test]
fn missing_expected_count_is_rejected_before_running_bun() {
    let checked = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
        .args(["run-scoped", "--expect-file", "examples/focused-run.test.ts"])
        .output()
        .expect("run Rust verifier");
    assert_eq!(checked.status.code(), Some(2));
    let json: Value = serde_json::from_slice(&checked.stdout).expect("valid evidence JSON");
    assert_eq!(json["reason"], "invalid_arguments");
}

#[test]
#[ignore = "needs a local Bun executable"]
fn timed_out_bun_returns_unverified_not_a_partial_pass() {
    let checked = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .args([
            "run-scoped", "--timeout-seconds", "1", "--expect-tests", "2",
            "--expect-file", "examples/focused-run.test.ts",
        ])
        .env("HARNESS_DEMO_FOCUS", "0")
        .env("HARNESS_DEMO_SLOW", "1")
        .output()
        .expect("run Rust verifier");
    assert_eq!(checked.status.code(), Some(2));
    let json: Value = serde_json::from_slice(&checked.stdout).expect("valid evidence JSON");
    assert_eq!(json["reason"], "bun_timeout");
    assert!(json.get("tests").is_none());
}
