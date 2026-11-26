<p align="center">
  <img src="docs/assets/yomumi-brand.svg" alt="Yomumi logo and wordmark" width="256">
</p>

<h1 align="center">Yomumi Harness</h1>
<p align="center"><strong>Compact evidence from Bun test runs, without handing an agent the raw log.</strong></p>
<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="docs/guide/README.md">Field guide</a> ·
  <a href="#choose-a-workflow">Workflows</a> ·
  <a href="#results">Results</a> ·
  <a href="#how-it-compares">Comparison</a> ·
  <a href="AGENT-START.md">Agent quick reference</a>
</p>

## Start here

Already have Bun and Rust? Run this from the checkout:

~~~sh
cargo build --release --locked
python example_smoke.py
~~~

The example requires Python to drive the demo; the Rust CLI itself does not. Expect **two matched tests, one fix, and a wrong-scope result of `unverified`**. [Follow the full walkthrough](docs/guide/01-first-run.md) to see what the CLI does when a test disappears but Bun still exits successfully.

[For people: field guide](docs/guide/README.md) · [For agents: short entry point](AGENT-START.md) · [For maintainers: verification checklist](CONTRIBUTING.md)

## Why we built it

Yomumi needed an agent to answer two questions after a change: **Did we rerun the intended tests? What actually changed?** A long report is expensive to pass around, and a smaller failure count by itself can hide the fact that a file stopped running.

We open-sourced only the Bun test-evidence layer. The Yomumi application, private tool registry, production reports, and customer data are not part of this repository.

| What we built | Why it matters |
| --- | --- |
| `compact`: verify declared counts, runner exit, and the expected file set; group failures and bound the output. | Invalid XML, inconsistent counts, or a wrong file set cannot produce a scoped pass. An unscoped summary makes no pass claim. |
| `compare`: require the same observed test identities and execution counts before reporting fixes, regressions, or changed failures. | Fewer failures are not counted as an improvement if a test disappears or a duplicate result makes the change ambiguous. |
| Local Rust CLI with an explicit Python reference. | Reading reports doesn't need an API, cloud upload, or Python at runtime. The reference gives us a second implementation to check the migration against. |

## Quick start

1. **Build once.** From this checkout, run `cargo build --release --locked`. This creates `target/release/yomumi-evidence` (add `.exe` on Windows). Cargo needs access to the locked dependencies on the first build; the resulting CLI reads reports offline.
2. **Run Bun and capture its exit immediately.** Run from the project under test, using a repo-relative path. This example is POSIX shell. On PowerShell, capture `$LASTEXITCODE` in place of `$?`.

~~~sh
bun_rc=0
bun test ./tests/example.test.ts --reporter=junit --reporter-outfile=run.xml || bun_rc=$?
/path/to/yomumi-harness/target/release/yomumi-evidence compact run.xml \
  --bun-exit "$bun_rc" --expect-file tests/example.test.ts
~~~

3. **Read the verdict.** With an explicit exit and expected file set, `0` means `scoped-pass`, `1` means `scoped-fail`, and `2` means unverified or invalid evidence. Repeat `--expect-file` for each intended file. Without scope arguments, the result is only a summary.
4. **Compare like with like.** Rerun the same selection on the candidate revision. Pass each invocation’s actual exit; the values below describe one failing baseline and one passing candidate.

~~~sh
target/release/yomumi-evidence compare before.xml after.xml --before-exit 1 --after-exit 0
~~~

A `matched` verdict means the observed runs can be compared. It does **not** mean there are no regressions. Read `changeCount` and `changes`; the list shows at most 12 changes.

## Choose a workflow

| What you want to know | Start here | What to keep |
| --- | --- | --- |
| Did this invocation run the right files? | [Check one report](docs/guide/02-review-recipes.md#check-one-run) | JSON verdict, actual Bun exit, and intended paths. |
| Did this patch fix a test or just run fewer tests? | [Compare a change](docs/guide/02-review-recipes.md#review-a-change) | Before/after exits, matching selection, and the delta. |
| Is a new engine faster without dropping work? | [Check a performance claim](docs/guide/03-measurement.md) | Parity result, timed workload, sample count, and latency distribution. |
| Why did the CLI refuse to compare? | [Troubleshoot the verdict](docs/guide/04-reference.md#troubleshooting) | The first missing fact, not a new run with weaker checks. |

~~~mermaid
flowchart LR
    A["Bun report + actual exit + intended paths"] --> B["Compact and check one run"]
    B -->|Missing or inconsistent evidence| C["Unverified: check the input"]
    B -->|Scoped result| D["Pass or fail for this run"]
    E["Two reports + both actual exits"] --> F["Compare observed tests"]
    F -->|Tests disappeared or evidence is ambiguous| G["Incomplete: no improvement claim"]
    F -->|Matched| H["Inspect fixes, regressions, and changed failures"]
~~~

## Cases we contribute

| Public case | What it demonstrates |
| --- | --- |
| [Order quantity and empty cart](examples/fixture.test.ts) | Two actual Bun executions with controlled inputs. One assertion fails on the baseline; the same two tests pass on the candidate. The delta reports one fix. |
| [Wrong file scope](example_smoke.py) | The candidate report still says zero failures. Changing the expected file alone correctly flips the verdict to `unverified`. |
| [Green run with a missing test](docs/guide/01-first-run.md#case-2-a-green-run-that-ran-less) | Both candidate invocations exit 0, but filtering out a test makes the delta `incomplete`. |
| [Parity and negative cases](parity.py) | The Rust CLI is checked against the Python reference on real Bun reports, generated Unicode cases, malformed reports, skips, invalid paths, and ambiguous duplicates. |

These are shareable reproductions of the kinds of review Yomumi needs, not copies of customer data or claims about production coverage.

## Results

![Bar chart of median Linux CLI latency: Python 30.6, 32.1, and 76.5 ms; Rust 1.3, 1.3, and 12.7 ms.](docs/assets/report-latency.svg)

| Linux x86-64 workload | Python p50 / p95 | Rust p50 / p95 | p50 ratio |
| --- | ---: | ---: | ---: |
| Compact actual Bun report (2 tests) | 30.644 / 36.601 ms | 1.301 / 1.626 ms | 23.6× |
| Compare actual Bun reports (2 tests each) | 32.114 / 41.805 ms | 1.302 / 1.623 ms | 24.7× |
| Compact expanded fixture (10,000 rows) | 76.475 / 105.210 ms | 12.732 / 16.563 ms | 6.0× |

**Measurement:** Bun 1.4.5, Python 3.12, Rust 1.100.0 release build. Same host and inputs, 80 measured calls per engine and workload after five warm-up pairs, alternating run order. Timings include process launch, file reads and output, not the Bun test run. The 10,000-row fixture was expanded from Bun output; it was not a run of 10,000 tests. The full Linux parity suite matched **284/284** JSON outcomes and exit codes.

**Windows:** Bun 1.4.5, Python 3.12.10, Rust 1.100.0. The Rust smoke replayed the two tests, found one fix, and rejected the wrong file scope. The baseline went from **880 bytes of XML to 513 bytes of summary JSON** (41.7% smaller on this fixture). This is byte size, not token savings. See the [captured smoke output](docs/evidence/windows-smoke.json). No Windows latency claim.

Reproduce locally with Bun, Rust, and Python 3.10+:

~~~sh
cargo build --release --locked
python -m unittest -q
python example_smoke.py
python parity.py --bench
~~~

The smoke example defaults to Rust. `python example_smoke.py --engine python` explicitly selects the fallback. Existing Python CLI commands remain available; there is no silent fallback on a failed or unverified run.

For a claim-by-claim map from docs to checks, see [Evidence ledger](docs/guide/03-measurement.md#evidence-ledger).

## How it compares

| Pick this when you need… | Tool |
| --- | --- |
| A full machine-readable report to feed into another tool. | [Bun’s JUnit reporter](https://bun.sh/docs/test/reporters) generates the input we read. |
| Failure annotations on PRs and GitHub job summaries. | [mikepenz/action-junit-report](https://github.com/mikepenz/action-junit-report) and [dorny/test-reporter](https://github.com/dorny/test-reporter) are designed for GitHub checks and team visibility. |
| A broader playbook suite for an agent’s engineering workflow. | [Lauren “poteto” Tan’s pstack](https://github.com/cursor/plugins/tree/main/pstack) routes and verifies whole tasks; it is a different layer. |
| A compact local handoff that checks the intended Bun file set and refuses unmatched before/after evidence. | **Yomumi Harness** adds that check and delta without requiring GitHub or uploading the report. |

Use the Harness alongside CI reporters, not in place of them. We measured Rust against our own Python implementation, not against those tools. This project is Bun-specific and does not create GitHub checks or claim full test coverage.

## Upstream credit

- [Bun](https://bun.sh/docs/test/reporters) provides the JUnit format and runner. We consume its reports; we don't fork the runner.
- [roxmltree](https://github.com/RazrFalcon/roxmltree) parses XML, [serde_json](https://github.com/serde-rs/json) writes JSON, and [RustCrypto SHA-2](https://github.com/RustCrypto/hashes/tree/master/sha2) computes fingerprints. Resolved dependency versions are in [Cargo.lock](Cargo.lock).
- [pstack’s guide](https://github.com/cursor/plugins/tree/main/pstack/docs/guide) inspired the short entry point, task recipes, and separation of verification from the write-up. No pstack skills or code are bundled.
- The two GitHub reporters above are comparison references, not dependencies. The scope checks, compact schema, matched-test delta, and fixtures live here.

## Sharing and scope

Raw assertion messages, test names, and logs are not printed in normal summary output. Relative paths and deterministic hashes may still be sensitive; review before sharing and never treat fingerprints as anonymization. Keep original reports, revisions, exit codes, and run settings with your local evidence. Each report is capped at 8 MiB. See [MIT license](LICENSE) for the code; the header uses Yomumi’s existing project mark and wordmark.
