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

#[test]
#[ignore = "needs a local Bun executable"]
fn baseline_catches_replacement_with_the_same_test_count() {
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("yomumi-baseline-test-{}-{nonce}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    let report = dir.join("baseline.xml");
    struct Cleanup(std::path::PathBuf, std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
            let _ = fs::remove_dir(&self.1);
        }
    }
    let _cleanup = Cleanup(report.clone(), dir);
    let fixture = "examples/focused-run.test.ts";
    let mut outfile = std::ffi::OsString::from("--reporter-outfile=");
    outfile.push(&report);
    let baseline = Command::new("bun").current_dir(env!("CARGO_MANIFEST_DIR"))
        .args(["test", "--reporter=junit", fixture]).arg(outfile)
        .env_remove("BUN_OPTIONS").env("HARNESS_DEMO_COVERAGE_RENAME", "0")
        .env("HARNESS_DEMO_FOCUS", "0").env("HARNESS_DEMO_SLOW", "0")
        .output().unwrap();
    assert_eq!(baseline.status.code(), Some(0));
    for (rename, expected) in [("0", 0), ("1", 2)] {
        let run = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .args(["run-scoped", "--expect-tests", "2", "--expect-file", fixture, "--baseline"])
            .arg(&report).env("HARNESS_DEMO_COVERAGE_RENAME", rename)
            .env("HARNESS_DEMO_FOCUS", "0").env("HARNESS_DEMO_SLOW", "0")
            .output().unwrap();
        let json: Value = serde_json::from_slice(&run.stdout).unwrap();
        assert_eq!(run.status.code(), Some(expected), "{json}");
        assert_eq!(json["tests"], 2);
        assert_eq!(json["bunExit"], 0);
        if rename == "1" {
            assert_eq!(json["problems"], serde_json::json!(["baseline_test_identity_mismatch"]));
        }
    }
}

#[test]
#[ignore = "needs a local Bun executable"]
fn scoped_runner_does_not_load_project_dotenv() {
    use std::{fs, time::{SystemTime, UNIX_EPOCH}};
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("yomumi-dotenv-test-{}-{nonce}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            for file in [".env", "fixture.test.ts"] {
                let _ = fs::remove_file(self.0.join(file));
            }
            let _ = fs::remove_dir(&self.0);
        }
    }
    let _cleanup = Cleanup(dir.clone());
    fs::write(dir.join(".env"), "YOMUMI_EVIDENCE_SYNTHETIC_DOTENV=loaded\n").unwrap();
    fs::write(
        dir.join("fixture.test.ts"),
        r#"import { test, expect } from "bun:test";
test("keeps project dotenv disabled", () => expect(process.env.YOMUMI_EVIDENCE_SYNTHETIC_DOTENV).toBeUndefined());"#,
    ).unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_yomumi-evidence"))
        .current_dir(&dir)
        .args(["run-scoped", "--expect-tests", "1", "--expect-file", "fixture.test.ts"])
        .env_remove("YOMUMI_EVIDENCE_SYNTHETIC_DOTENV")
        .output().unwrap();
    let json: Value = serde_json::from_slice(&run.stdout).unwrap();
    assert_eq!(run.status.code(), Some(0), "{json}");
    assert_eq!(json["verdict"], "scoped-pass");
}
