# Evidence-first verification: how to stop AI agents from claiming tests passed

Evidence-first verification is the rule in the Yomumi Harness that an AI coding agent's "tests pass" is a claim, not a result, until something checks what actually ran. Never turn "unverified" into "pass", never treat "comparable" as "passed", and never let a test that used an in-memory stand-in count as proof of the real database path. The public [`yomumi-evidence`](../../README.md) Rust CLI in this repository applies the rule mechanically to Bun JUnit XML.

[Back to the system overview](README.md)

## Contents

- [Why agents report false green](#why-agents-report-false-green)
- [Three outcomes, never two](#three-outcomes-never-two)
- [What each kind of check proves](#what-each-kind-of-check-proves)
- [How the harness applies the rule](#how-the-harness-applies-the-rule)
- [The Bun test harness in this repository](#the-bun-test-harness-in-this-repository)
- [A review brief you can copy](#a-review-brief-you-can-copy)

## Why agents report false green

None of these needs a dishonest agent; each is an easy mistake under token or time pressure:

- **Fewer tests ran.** A filter, a focused test (`.only`) or a moved file shrinks the run, and the runner still exits 0. This repository reproduces both cases: a filtered run with a skipped test ([case 2](../guide/01-first-run.md#case-2-a-green-run-that-ran-less)) and a `.only` run that reported zero skips ([focused tests](../guide/11-focused-tests.md)).
- **The wrong files ran.** The agent tested a neighbor of the file it changed.
- **The count stayed the same but the failures changed.** One fix and one new regression look like "no change" ([equal counts](../guide/09-equal-counts.md)).
- **The test never reached the real path.** A test backed by an in-memory store passes while the SQL behind it is broken. A memory-backed test proves the logic around storage, not the query, the migration or the constraint.
- **The exit code was lost.** A second command overwrote the runner's exit status before it was recorded.
- **Local proof was taken as production proof.** Local code and tests alone do not close a production risk; that needs evidence from the deployed system, which is the owner's call to gather.

## Three outcomes, never two

| Outcome | Meaning | Allowed next step |
| --- | --- | --- |
| Verified pass | The intended scope ran, the counts and identities check out, and nothing failed. | Report it as a pass *for that scope*. |
| Verified failure | The intended scope ran and something failed. | Fix or report the failure. |
| Unverified | The evidence is missing, inconsistent, or does not show that the intended scope ran. | Fix the input or rerun. Never report a pass. |

"Matched" in a before/after comparison means only that the two runs are comparable. Read the change list (fixes, regressions, changed failures) before saying anything improved.

## What each kind of check proves

| Check | Proves | Does not prove |
| --- | --- | --- |
| Runner exit 0 | The command did not report failure. | That the intended tests ran. |
| Scoped count and file check | The expected files and number of tests ran. | Source-code coverage. |
| Identity comparison against a trusted baseline | The same tests ran as in a reviewed full run. | That the baseline itself was complete. |
| In-memory or mock-backed test | Logic around the dependency. | The real query, schema or network path. |
| Type check and build | The code compiles and bundles. | Behavior. |
| Local test suite | Behavior on this machine. | Behavior in production. |

See also [Verification](../guide/07-verification.md) for what each test layer of this repository proves.

## How the harness applies the rule

- **Agent results are summaries, not verdicts.** The dispatcher stores each agent's `RESULT SUMMARY:` as data. The calling session reviews the diff and reruns the checks itself before reporting anything to the owner.
- **Reports say what was not checked.** Every receipt lists what passed, what remains unverified, and whether fixture data or real output produced the result.
- **No fake data.** Missing data is shown as missing ("not recorded"), never filled in with plausible numbers.
- **Measured claims link to evidence.** A number in a report or a README must come from a saved output file, with its scope and denominator; otherwise it is left out.
- **A failing or skipped check is evidence, not permission to loosen the gate.**
- **Review by a second, independent agent** for high-risk changes: an implementing agent, then reviewers with different lenses (for example correctness and security), then only confirmed findings get fixed, then the main session verifies.

## The Bun test harness in this repository

`yomumi-evidence` is the verification layer as code:

- `compact` checks one Bun JUnit report against the expected files, an optional pinned test count, and the runner's actual exit.
- `compare` checks two reports by test identity and execution count before describing fixes, regressions and changed failures.
- `run-scoped` runs Bun itself, captures its exit and a fresh report, and verifies the scope in one command, with a deadline and with automatic `.env` loading disabled.

Exit `0` is a verified pass for that scope, `1` a verified failure, `2` unverified. Start with [Try it](../../README.md#try-it) or the [field guide](../guide/README.md).

## A review brief you can copy

> Run the intended tests yourself and keep the runner's actual exit code. Verify that the expected files and test count ran; if a trusted full-run baseline exists, compare test identities too. Report one of: verified pass for this scope, verified failure, or unverified with the reason. If any test used an in-memory or mocked dependency, say which real path remains untested. Do not call a comparable run a pass, and do not claim production coverage from local tests.

Next: [Machine load](machine-load.md)
