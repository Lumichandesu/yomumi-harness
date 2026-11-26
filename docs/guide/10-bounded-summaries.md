# A regression can disappear from a short change list

[pytest's short test summary](https://docs.pytest.org/en/stable/how-to/output.html#producing-a-detailed-summary-report) groups outcomes by category, while [Playwright's reporters](https://playwright.dev/docs/test-reporters#multiple-reporters) let you separate a concise view from detailed evidence. Yomumi applies both ideas to paired Bun runs: count every change, and let the reviewer choose whether to receive individual rows. This is a design reference, not a comparison of test runners.

## Reproduce with Bun

Run this from the repository root in Bash. The fixture is public and both named scenarios intentionally exit 1. The ordinary fixture run without an environment setting passes all 15 tests.

```bash
cargo build --release --locked
tmp=$(mktemp -d)
trap 'rm -f -- "$tmp/before.xml" "$tmp/after.xml"; rmdir -- "$tmp"' EXIT

before_exit=0
HARNESS_SUMMARY_SIDE=before bun test --reporter=junit --reporter-outfile="$tmp/before.xml" examples/summary-overflow.test.ts || before_exit=$?
after_exit=0
HARNESS_SUMMARY_SIDE=after bun test --reporter=junit --reporter-outfile="$tmp/after.xml" examples/summary-overflow.test.ts || after_exit=$?

target/release/yomumi-evidence compare "$tmp/before.xml" "$tmp/after.xml" \
  --before-exit "$before_exit" --after-exit "$after_exit"
target/release/yomumi-evidence compare --summary-only "$tmp/before.xml" "$tmp/after.xml" \
  --before-exit "$before_exit" --after-exit "$after_exit"
```

## Observed with Bun 1.4.5 on Windows

| Evidence | Result |
| --- | ---: |
| Failed before → after | 14 → 2 |
| Fixed / new regression / changed failure | 13 / 1 / 1 |
| Rows in default output | 12 of 15 |
| New regressions visible in those 12 rows | 0 |
| Default → summary-only JSON (UTF-8, excluding newline) | 1,401 → 392 bytes |

A falling failure count and a list of fixes do not imply zero regressions. The Rust `--summary-only` view reports complete per-category counts without showing test IDs or paths. Both report hashes remain so the reviewer can identify the source files later. Use default mode for sample rows, not as an exhaustive list. Exit 0 still means the reports are comparable, not that the candidate passed. On exit 2, use `--diagnostics` alongside `--summary-only` for a reason code.

The byte reduction is a result for this specific fixture, not a prompt-token or API cost measurement.
