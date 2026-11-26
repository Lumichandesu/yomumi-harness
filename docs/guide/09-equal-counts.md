# Same failure count, different outcome

A test run can report the same number of failures after a patch even though the patch introduced a new bug. That is why the Harness compares observed test identities and their outcomes, not just totals.

## Try the saved reports

These reports were captured from Bun 1.4.5 on Windows with the [public regression fixture](../../examples/review-regression.test.ts). The baseline and both candidates ran the same two tests and exited 1 with **one failure each**.

| Compare baseline with… | What actually happened | Harness result |
| --- | --- | --- |
| [Moved failure](../../examples/replay/moved-failure.xml) | Order quantity now passes, but the empty cart assertion fails. | `fixed` and `regression` |
| [Different failure](../../examples/replay/different-failure.xml) | Order quantity still fails, but the received value changed. | `changed_failure`, not a fix |

From the repository root:

~~~sh
cargo run --release --locked -- compare examples/replay/baseline.xml examples/replay/moved-failure.xml --before-exit 1 --after-exit 1
cargo run --release --locked -- compare examples/replay/baseline.xml examples/replay/different-failure.xml --before-exit 1 --after-exit 1
~~~

Both commands return exit 0 because the reports are **comparable**, not because the candidate passes. Check `afterFailed` and each change label before you make a review decision.

## Recreate with Bun

The fixture passes without special settings. For these controlled failures, run:

~~~bash
YOMUMI_REVIEW_SCENARIO=baseline bun test ./examples/review-regression.test.ts --reporter=junit --reporter-outfile=baseline.xml
YOMUMI_REVIEW_SCENARIO=moved-failure bun test ./examples/review-regression.test.ts --reporter=junit --reporter-outfile=moved-failure.xml
YOMUMI_REVIEW_SCENARIO=different-failure bun test ./examples/review-regression.test.ts --reporter=junit --reporter-outfile=different-failure.xml
~~~

These three Bun commands are expected to exit 1. Run them separately or capture the exits before doing anything with the reports. In PowerShell set `$env:YOMUMI_REVIEW_SCENARIO` before each command, capture `$LASTEXITCODE` immediately, then remove the temporary environment variable or restore its prior value.

[Captured delta JSON](../evidence/equal-count-windows.json) · [Rust replay tests](../../tests/replay.rs) · [Integration recipes](08-integrate.md)
