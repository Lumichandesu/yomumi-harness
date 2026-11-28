# Node test runner reports

`compact` and `compare` also read JUnit XML from Node's built-in runner. `run-scoped` stays Bun-only. Behaviour here is checked against real reports from Node v22.23.5 on Windows; other releases and platforms are not verified.

~~~sh
node --test --test-reporter=junit --test-reporter-destination=report.xml tests/example.test.mjs
yomumi-evidence compact report.xml --node-exit 0 --node-file tests/example.test.mjs --expect-file tests/example.test.mjs --expect-tests 12
yomumi-evidence compare before.xml after.xml --before-exit 1 --after-exit 0 --node-file tests/example.test.mjs
~~~

Replace the exit values with the ones captured immediately from Node.

## File scope is your declaration

Node 22 does not say which file a testcase came from. It writes no `file` attribute and no properties, and a passing report does not contain the file name at all. So the report cannot prove file coverage, unlike a Bun report.

- Run **one test file per report** and name it with `--node-file`. The tool attributes every result to that file and cannot detect that you ran more files or a different one. The output says `"fileScope": "caller_declared"`.
- Without `--node-file`, the file is unknown (`"fileScope": "unknown"`): a scoped check reports `file_coverage_mismatch` and `compare` reports `before_file_scope_invalid`.
- A scoped verdict requires `--expect-tests` from a trusted full run; otherwise it reports `expected_test_count_required`. A process that exits with status 0 part way can produce a clean-looking report with tests missing.

## What must hold

- The run totals Node writes as comments (`tests`, `suites`, `pass`, `fail`, `cancelled`, `skipped`, `todo`, `duration_ms`) must each appear once and agree with the rows. A diagnostic that imitates one of them invalidates the report.
- Suite totals must agree with each suite's direct children.
- Every testcase and suite needs a `time` attribute.
- A testcase with a `file` attribute invalidates the report. That shape has not been verified against real output.
- Skip and TODO tests make a run unverified, as with Bun. So do cancelled tests.
- A top-level result named like a script file stands for a whole file (it crashed, exited early, or registered no test) and yields `file_level_result`. Such a row can be marked as passing. A real top-level test with a name ending in a script extension such as `.js` is refused too.
- A comparison needs identical test identities: `describe` path, name, class name, and repeat count. A missing test is never reported as fixed. Node records no source line.
- Both reports in a comparison must come from the same runner.

Subtests created with `t.test()`, empty `describe` blocks, and skipped `describe` blocks do not match the totals checked here, so such reports are rejected.

Failure signatures use the failure type and message. A message that contains a checkout path can show `changed_failure` between two different directories.

## Durations

`durationMs` keeps the exact `duration_ms` text from the report. Comparison uses integer units of 0.0001 ms; digits after the fourth place round half up (`1346.53485` becomes `1346.5349`). Each side is rounded before the difference is taken. No floating-point conversion is used. Missing, exponent, signed, or non-numeric durations invalidate the report. Durations are informational and never change a verdict.

## Compare reasons specific to Node

| Reason | What to check |
| --- | --- |
| `runner_mismatch` | Use two Node reports or two Bun reports. |
| `before_file_scope_invalid` | Add `--node-file`. |
| `before_file_level_result` / `after_file_level_result` | Fix the file that crashed, exited early, or ran no test, then rerun. |
| `before_cancelled_tests` / `after_cancelled_tests` | Find the timeout or parent failure that cancelled tests. |
| `before_node_exit_disagrees` / `after_node_exit_disagrees` | Check the exit captured immediately from Node. |

## Fixtures

The synthetic suites are in [tests/fixtures/node](../../tests/fixtures/node). Regenerate their reports with `node tests/fixtures/node/generate.mjs`, then run `cargo test --locked`. The script replaces the project directory and host name before writing; review the XML before committing it. [provenance.json](../../tests/fixtures/node/provenance.json) records how the current reports were produced.
