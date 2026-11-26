"""Run the published Bun fixture twice and verify the evidence locally."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile

from compact_bun_failures import MAX_BYTES, snap
from compare_bun_runs import compare

ROOT = Path(__file__).resolve().parent
RUST = ROOT / "target" / "release" / ("yomumi-evidence.exe" if os.name == "nt" else "yomumi-evidence")
FIXTURE = "examples/fixture.test.ts"

def summarize(before, after, before_exit, after_exit):
    baseline = snap(before, bun_exit=before_exit, expected_files=[FIXTURE])
    candidate = snap(after, bun_exit=after_exit, expected_files=[FIXTURE])
    wrong_scope = snap(after, bun_exit=after_exit, expected_files=["examples/missing.test.ts"])
    delta = compare(before, after, before_exit, after_exit)
    return verify(before, baseline, candidate, wrong_scope, delta)


def verify(before, baseline, candidate, wrong_scope, delta):
    changes = delta["changes"]
    if (baseline["verdict"], candidate["verdict"], wrong_scope["verdict"]) != ("scoped-fail", "scoped-pass", "unverified"):
        raise ValueError("Unexpected coverage or fixture verdict")
    if delta["tests"] != 2 or delta["changeCount"] != 1 or changes[0]["change"] != "fixed":
        raise ValueError("Expected two matched tests and exactly one fix")
    return {
        "test_count": delta["tests"], "fixes": 1,
        "baseline": baseline["verdict"], "candidate": candidate["verdict"],
        "wrong_scope": wrong_scope["verdict"],
        "baseline_junit_bytes": len(before),
        "baseline_summary_bytes": len(json.dumps(baseline, separators=(",", ":")).encode("utf-8")),
    }

def summarize_rust(before_path, after_path, before, before_exit, after_exit):
    def call(expected, *argv):
        run = subprocess.run([str(RUST), *map(str, argv)], stdin=subprocess.DEVNULL,
                             capture_output=True, timeout=15, check=False)
        if run.returncode != expected:
            raise ValueError("Unexpected Rust exit")
        return json.loads(run.stdout)

    baseline = call(1, "compact", before_path, "--bun-exit", before_exit, "--expect-file", FIXTURE)
    candidate = call(0, "compact", after_path, "--bun-exit", after_exit, "--expect-file", FIXTURE)
    wrong_scope = call(2, "compact", after_path, "--bun-exit", after_exit, "--expect-file", "examples/missing.test.ts")
    delta = call(0, "compare", before_path, after_path, "--before-exit", before_exit, "--after-exit", after_exit)
    return verify(before, baseline, candidate, wrong_scope, delta)


def run_fixture(bun, report, quantity):
    env = {**os.environ, "HARNESS_EXAMPLE_QUANTITY": str(quantity)}
    env.pop("BUN_OPTIONS", None)
    run = subprocess.run(
        [bun, "test", "./" + FIXTURE, "--reporter=junit", f"--reporter-outfile={report}"],
        cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, timeout=20, check=False,
    )
    with report.open("rb") as stream:
        return stream.read(MAX_BYTES + 1), run.returncode

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bun", default="bun", help="Bun executable (default: bun on PATH)")
    parser.add_argument("--engine", choices=("rust", "python"), default="rust")
    args = parser.parse_args()
    if args.engine == "rust" and not RUST.is_file():
        parser.exit(2, "Build Rust with cargo build --release --locked, or select --engine python.\n")
    try:
        with tempfile.TemporaryDirectory(prefix="yomumi-harness-") as work:
            before_path, after_path = Path(work) / "baseline.xml", Path(work) / "candidate.xml"
            base, base_exit = run_fixture(args.bun, before_path, 1)
            next_report, next_exit = run_fixture(args.bun, after_path, 2)
            result = (summarize_rust(before_path, after_path, base, base_exit, next_exit)
                      if args.engine == "rust" else summarize(base, next_report, base_exit, next_exit))
        result["engine"] = args.engine
    except (ValueError, OSError, subprocess.TimeoutExpired, SyntaxError):
        parser.exit(2, "Could not verify the example. Check Bun and rerun the fixture locally.\n")
    print(json.dumps(result, separators=(",", ":")))

if __name__ == "__main__":
    main()
