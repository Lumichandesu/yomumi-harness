# Node test runner reports

`compact` and `compare` also read JUnit XML from Node's built-in runner. `run-scoped` stays Bun-only.

~~~sh
node --test --test-reporter=junit --test-reporter-destination=report.xml tests/example.test.mjs
yomumi-evidence compact report.xml --node-exit 0 --node-root "$PWD" --expect-file tests/example.test.mjs
yomumi-evidence compare before.xml after.xml --before-exit 1 --after-exit 0 --before-root "$PWD" --after-root "$PWD"
~~~

Replace the exit values with the ones captured immediately from Node.

## What must hold

- Your Node release must emit a `file` attribute on each testcase. Without it, files are unknown and nothing is verified.
- Paths in the report are absolute. `--node-root` (compact) and `--before-root` / `--after-root` (compare) name the project directory to strip.
- The run totals Node writes as comments (`tests`, `suites`, `pass`, `fail`, `cancelled`, `skipped`, `todo`, `duration_ms`) must each appear once and agree with the rows. A diagnostic that imitates one of them invalidates the report.
- Suite totals must agree with each suite's direct children.
- Skip and TODO tests make a run unverified, as with Bun. So do cancelled tests.
- A result that stands for a whole file (it crashed, or registered no test) yields `file_level_result`.
- A comparison needs identical test identities: file, `describe` path, name, class name, and repeat count. A missing test is never reported as fixed. Node records no source line.
- Both reports in a comparison must come from the same runner.

Subtests created with `t.test()`, empty `describe` blocks, and skipped `describe` blocks do not match the totals checked here, so such reports are rejected.

Failure signatures use the failure type and message. A message that contains a checkout path can show `changed_failure` between two different directories.

## Durations

`durationMs` keeps the exact `duration_ms` text from the report. Comparison uses integer units of 0.0001 ms; digits after the fourth place round half up (`1346.53485` becomes `1346.5349`). No floating-point conversion is used. Exponent, signed, or non-numeric durations invalidate the report. Durations are informational and never change a verdict.

## Compare reasons specific to Node

| Reason | What to check |
| --- | --- |
| `runner_mismatch` | Use two Node reports or two Bun reports. |
| `before_file_level_result` / `after_file_level_result` | Fix the file that crashed or ran no test, then rerun. |
| `before_cancelled_tests` / `after_cancelled_tests` | Find the timeout or parent failure that cancelled tests. |
| `before_node_exit_disagrees` / `after_node_exit_disagrees` | Check the exit captured immediately from Node. |

## Fixtures

The synthetic suites are in [tests/fixtures/node](../../tests/fixtures/node). Regenerate their reports with `node tests/fixtures/node/generate.mjs`, then run `cargo test --locked`. The script replaces the project directory and host name before writing; review the XML before committing it.
