# Reference and recovery

| Command | Meaning of 0 | Meaning of 1 | Meaning of 2 |
| --- | --- | --- | --- |
| `compact` with scope | `scoped-pass` | `scoped-fail` | `unverified`, or the report/arguments couldn't be validated. |
| `compact` without scope | Summary only; no verdict | Not a scoped invocation | Report or arguments couldn't be validated. |
| `compare` | `matched`; inspect changes | Not used | `incomplete`, or inputs couldn't be validated. |

**Inputs:** Bun JUnit XML, at most 8 MiB per file. Use UTF-8 and repo-relative JS/TS test paths. A scoped summary requires an actual Bun exit and at least one explicit expected file; repeated `--expect-file` entries select up to 256 files. `--files` emits capped per-file counts; `--limit` selects 1–12 failure clusters (default 6).

**Comparison:** Test identity includes file, class, name, and line as emitted in the reports. It refuses ambiguous changes in duplicate identities, skip cases, inconsistent counts or exits, and differences in observed identities. Moving a test so that its recorded line changes can also make the pair incomparable. This is conservative by design.

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
| Rust executable not found | Build with `cargo build --release --locked` and use the path under `target/release/`. The original Python commands are an explicit fallback. |
| Need to attach something to a review | Share the smallest necessary JSON only after reviewing paths and hashes; keep raw logs local. |
