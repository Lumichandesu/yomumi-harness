# Changelog

## Unreleased

### Added

- `compact` and `compare` read JUnit XML from Node's built-in test runner, with `--node-exit` and `--node-file`. Node 22 reports name no test file, so scope is the caller's declaration of one file per report, and a scoped verdict also requires `--expect-tests`. Run durations keep their source text and compare at 0.0001 ms without floating point. Bun checks and Bun output are unchanged. See [Node test runner reports](docs/guide/13-node-junit.md).

### Documentation

- Source snapshots of the harness [task dispatcher](harness/agent-dispatch/README.md) and [free-tier offload](harness/free-llm/README.md) under `harness/` (Bun/TypeScript, as of 2026-11-27, cleaned of machine paths and private test data). They are separate from the Rust CLI and do not change it.
- [Harness system docs](docs/system/README.md): how the wider Yomumi Harness runs several AI coding agents on one PC (task dispatch, model routing, weekly token budget, free-tier offload, agent channel, code-mode MCP gateway, evidence-first verification, machine load, crash recovery), with a glossary, FAQ, category comparison and an architecture diagram. Documentation only; no CLI behavior changed.
- Thai and Japanese landing pages ([README.th.md](README.th.md), [README.ja.md](README.ja.md)) and a social preview image ([docs/assets/social-preview.png](docs/assets/social-preview.png)).

### Fixed

- Validate nested Bun `describe` suite totals bottom-up, avoiding false rejections on valid nested reports.

- Disable Bun's automatic `.env` loading in `run-scoped`; the command also continues to clear `BUN_OPTIONS`.
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
- `run-scoped --baseline REPORT` requires the same test identities and execution counts as the trusted full Bun JUnit report.
- `run-scoped` invokes local Bun, captures its exit and a fresh JUnit report, and verifies the explicitly expected files and test count in one Rust command.
- Scoped `compact --expect-tests N` can reject missing rows (such as a Bun `.only` run) when a trusted full-run count is known.
- Rust `compare --summary-only` emits complete category counts and report hashes without per-test rows. Default output and exit codes are unchanged.
- Rust `compare --diagnostics` adds a fixed reason code to incomplete comparisons without exposing report paths or changing default output.
- Built-in help for `compact` and `compare`, including scope inputs and exit meanings. Normal invocations still return JSON.

- [No-Bun replay](examples/replay/README.md), [local review integration](docs/guide/08-integrate.md), and [examples where the failure total doesn't move](docs/guide/09-equal-counts.md).
