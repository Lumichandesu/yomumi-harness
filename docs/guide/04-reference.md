# Reference and recovery

| Command | Meaning of 0 | Meaning of 1 | Meaning of 2 |
| --- | --- | --- | --- |
| `compact` with scope | `scoped-pass` | `scoped-fail` | `unverified`, or the report/arguments couldn't be validated. |
| `compact` without scope | Summary only; no verdict | Not a scoped invocation | Report or arguments couldn't be validated. |
| `compare` | `matched`; inspect changes | Not used | `incomplete`, or inputs couldn't be validated. |

**Inputs:** Bun JUnit XML, at most 8 MiB per file. Use UTF-8 and repo-relative JS/TS test paths. Declared top-level suite counts must agree with their testcase rows. Each testcase must have a non-blank name; unnamed rows cannot be accepted as complete evidence. A scoped summary requires an actual Bun exit and at least one explicit expected file; repeated `--expect-file` entries select up to 256 files. `--files` emits capped per-file counts; `--limit` selects 1–12 failure clusters (default 6).

Supply each runner exit flag exactly once. Duplicate exit flags are invalid even when their values agree; capture each Bun exit immediately.

**Comparison:** Test identity includes file, class, name, and line as emitted in the reports. It refuses ambiguous changes in duplicate identities, skip cases, inconsistent counts or exits, and differences in observed identities. Moving a test so that its recorded line changes can also make the pair incomparable. This is conservative by design. The detailed list is capped at 12 rows and prioritizes new regressions while preserving report order among retained rows. Use summary-only for complete category totals.

## Compare without individual rows

Use `compare --summary-only BEFORE AFTER --before-exit EXIT --after-exit EXIT`. On a matched comparison, `changeCounts` counts every `fixed`, `regression`, and `changed_failure`. It replaces the capped `changes` array with counts and `omittedChanges`; both report hashes are still included. Combine it with `--diagnostics` before the paths to get reason codes on exit 2. See the [worked overflow example](10-bounded-summaries.md).

## Explain an incomplete comparison

Put `--diagnostics` before the report paths in the Rust CLI. On exit 2, `reason` contains the first blocker detected. No raw path, test name, or report text is added. Successful output and default JSON are unchanged.

| Reason | What to check |
| --- | --- |
| `invalid_arguments` | Check argument order and supply both actual Bun exits. |
| `before_report_unavailable` / `after_report_unavailable` | Check that the file can be read and its size is between 1 byte and 8 MiB. |
| `before_report_invalid` / `after_report_invalid` | Check that the file is genuine, complete Bun JUnit XML with valid case metadata and counts, and no explicit retry markers. |
| `before_file_scope_invalid` / `after_file_scope_invalid` | Check that the comparison covers no more than 256 files and uses valid relative paths. |
| `before_skipped_tests` / `after_skipped_tests` | Rerun the same selection without filters or skips. |
| `before_bun_exit_disagrees` / `after_bun_exit_disagrees` | Check the exit captured immediately from Bun for that report. |
| `test_identity_mismatch` | Check test selection, recorded line numbers, and counts of repeated identities. |
| `ambiguous_test_identity` | Give duplicate cases distinct identities before comparing their changed outcomes. |

## Run scoped

`run-scoped --expect-tests N --expect-file FILE [--expect-file FILE ...]` runs the local Bun executable from your project root. It requires a positive count and a non-empty list of distinct repository-relative test files. The verifier clears `BUN_OPTIONS`, checks observed paths and count against the supplied values, and emits the same JSON and exit codes as scoped `compact`. It uses a fresh temporary report and keeps standard output reserved for JSON. The default Bun deadline is 300 seconds. Set `--timeout-seconds N` (1–3600) for a different budget. On expiry the command stops Bun itself, ignores its partial report, and returns exit 2 with `bun_timeout`. Independently spawned subprocesses are not managed by this deadline. If you need runner logs or custom options, run Bun yourself and use `compact` with the actual exit and the fresh report.

To require the same tests as a trusted full run, add `--baseline full.xml`. The baseline must have matching files and count and no skipped tests. The verifier checks each observed file, class, name, source line and repeat count. When the identities differ it returns exit 2 with `baseline_test_identity_mismatch`, even if Bun returned 0 and the total count matches. A test move or rename can require a refreshed baseline; verify the full intended run before refreshing it. Baseline failures are not compared here; use `compare` to review failure transitions.

~~~sh
bun test --reporter=junit --reporter-outfile=full.xml ./tests/example.test.ts
yomumi-evidence run-scoped --expect-tests 2 --expect-file tests/example.test.ts --baseline full.xml
~~~

Keep the baseline XML local. In this example `2` is the trusted full-run count.

## Focused tests and omitted rows

Bun 1.4.5 may omit tests outside a `test.only` selection completely: a real two-case example produced one JUnit row, zero skipped, and exit 0. File coverage alone cannot detect that. Run `compact REPORT --bun-exit EXIT --expect-file FILE --expect-tests N` with an exact count established from a trusted full run. A different count yields exit 2 and `test_count_mismatch`; the flag requires a scoped invocation and a positive count.

A count does not verify test identities or detect a replacement with the same count. For matched identities, keep a full baseline and use `compare`. A regular skip or TODO that Bun records as skipped is already rejected in scoped and matched verification.

## Retries

Reports that explicitly include Bun's `flakyFailure` or `rerunFailure` markers are not accepted as clean evidence. Compact and compare return exit 2. For a first-attempt result, rerun without retries and investigate the original failure.

We observed Bun 1.4.5 pass a test on retry while its JUnit output contained **no retry marker**. A report that omits retry history is indistinguishable from a first-attempt pass to this CLI. Disable per-test retries in strict verification runs or keep separate runner-log evidence. See [the Bun reporter specification](https://bun.sh/docs/test/reporters#retried-tests).

## Troubleshooting

| Symptom | Check next |
| --- | --- |
| `file_coverage_mismatch` | Compare the original Bun selection with missing/unexpected paths. Check you ran from the project root and used relative paths. |
| `bun_exit_disagrees` | Capture the exit from the Bun process, not a later echo, pipe, or CLI call. |
| `skipped_tests` | Find why the report contains skipped tests. Don't mark them as executed in the XML. |
| `incomplete` with both reports readable | Look for filters, skipped tests, line changes, repeated identities, and different runs or environments. Don't edit XML to make them match. |
| Rust executable not found | Build with `cargo build --release --locked` and use the path under `target/release/`. |
| Need to attach something to a review | Share the smallest necessary JSON only after reviewing paths and hashes; keep raw logs local. |
