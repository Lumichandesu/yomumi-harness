# Fork and make it yours

Start from the [first-run guide](01-first-run.md). Run the unmodified sample first. Then change one layer at a time, keeping the original failure and false-green cases as regression tests.

| Your work | What to change or add | What must still be true |
| --- | --- | --- |
| Bun monorepo, same reporter | Replace the example file list with the exact selection for the package. Set the working directory consistently and give each run its own report path. | A missing or unexpected file is not a pass. |
| Smaller handoffs to agents | Consume `verdict`, counts, and the top clusters from `compact`; tune `--limit` between 1 and 12. Add an authorized local drill-down only when the summary isn't enough. | Changes to the cap do not change observed failure counts or the verdict. Don't publish original logs or private fingerprints. |
| PR regression checks | Wrap `compare` with **your own** policy: block incomplete evidence, then decide whether to block regressions or unresolved failures. Keep normal CI and code review. | Exit 0 only means matched. To block regressions, inspect `changes` and handle a truncated list conservatively; do not assume all changes are shown. |
| Vitest, pytest, Go, or another reporter | Add a dedicated adapter rather than renaming the XML root. Replace assumptions about file paths, skips, worker failures, exit conventions and test identity. Add reports from that runner to the fixtures. | Missing identity, skipped or partially executed jobs, and ambiguous duplicates cannot look like improvements. No support for those runners is bundled. |
| Cross-platform repeatability | Keep report output and working directories deterministic. On another OS, rebuild the Rust binary and repeat the sample and parity checks before adopting it. | Same verdicts and codes. Speed claims from a different machine don't carry over. |

## Which files to work on

- [Rust CLI](../../src/main.rs): input checks, path normalization, failure grouping, matched-test delta, and CLI exits.
- [Python reference](../../compact_bun_failures.py) and [delta reference](../../compare_bun_runs.py): update deliberately when the contract changes, not just to make parity green.
- [Examples](../../examples/fixture.test.ts), [smoke](../../example_smoke.py), and [parity suite](../../parity.py): add a real report and at least one negative case for every new runner rule.
- [Agent entry point](../../AGENT-START.md): teach the one or two commands people actually need. Put edge cases in guides, not into every agent's prompt.

Keep the scope and exit checks even when optimizing. If you add fields to the public JSON, decide whether old consumers can ignore them. Version intentional breaking changes. For a new runner, test at least: complete pass, scoped failure, a missing test, skipped/aborted work, duplicate names, and runner/report disagreement.

## Good fit, bad fit

Good fit: small teams using Bun, an agent inspecting repetitive failures, or reviewers who need a quick before/after comparison offline. Not a fit: replacing the test runner, proving full code coverage, handling flaky retries automatically, running penetration tests, or replacing a CI dashboard. Use a reporter for team visibility and this CLI for the evidence handoff.

The [MIT license](../../LICENSE) covers the code. Use your own project branding for your fork. See [contributing](../../CONTRIBUTING.md) for the verification loop.
