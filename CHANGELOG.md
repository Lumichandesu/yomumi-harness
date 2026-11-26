# Changelog

## Unreleased

### Fixed

- Bound `run-scoped` to a 300-second default Bun deadline. An expired run is unverified and never uses the partial report.

- Reject reports whose declared top-level suite counts disagree with their testcase rows, even when the overall totals match.

- Treat missing or blank testcase names as incomplete evidence in both commands, rather than allowing a scoped pass for unidentifiable rows.

- Reject repeated runner exit flags in Rust compact and compare instead of silently using the last value.

- Keep new regressions in the capped default comparison list ahead of fixes and changed failures. Retained rows stay in report order; totals, verdicts, and exit codes are unchanged.

- Treat explicit Bun JUnit retry markers (`flakyFailure`, `rerunFailure`) as incomplete evidence instead of ignoring them. Both commands stop with exit 2 even when the runner's final exit is 0. Plain reports keep their existing behavior.
- Reports from a runner that discards retry history cannot be checked for retries from XML alone. See [Retry limitations](docs/guide/04-reference.md#retries).

### Changed

- Rust is the sole supported CLI and verification path; the old comparator is accessible in Git history for the recorded benchmark.

### Added
- `run-scoped` invokes local Bun, captures its exit and a fresh JUnit report, and verifies the explicitly expected files and test count in one Rust command.
- Scoped `compact --expect-tests N` can reject missing rows (such as a Bun `.only` run) when a trusted full-run count is known.
- Rust `compare --summary-only` emits complete category counts and report hashes without per-test rows. Default output and exit codes are unchanged.
- Rust `compare --diagnostics` adds a fixed reason code to incomplete comparisons without exposing report paths or changing default output.
- Built-in help for `compact` and `compare`, including scope inputs and exit meanings. Normal invocations still return JSON.

- [No-Bun replay](examples/replay/README.md), [local review integration](docs/guide/08-integrate.md), and [examples where the failure total doesn't move](docs/guide/09-equal-counts.md).
