# Integrate with a local review

Yomumi Harness reports **what the evidence says**. Your project decides **what to block**. It does not merge branches, post comments, or change CI on its own.

## Pick a policy

| Goal | Use | Safe default |
| --- | --- | --- |
| Inspect a single run | `compact` | Keep the original runner exit and intended file list. Stop if unverified. |
| Inspect what changed | `compare` | Check the verdict, failure totals, and whether any change rows were omitted. |
| Require all observed candidate tests to pass | [PowerShell example](../../examples/review-delta.ps1) | Stop on incomparable reports, a truncated list, or any candidate failure. |
| Keep accepting known failures but block new ones | Write a separate policy on the matched delta | Stop if the change list is truncated. Define how changed failure signatures are handled before accepting one. |

## A copyable review check

Generate `before.xml` and `after.xml` and capture `$beforeRc` and `$afterRc` exactly as shown in [First real run](01-first-run.md#case-1-a-real-fix-on-the-same-tests). Then run this from the checkout:

~~~powershell
.\examples\review-delta.ps1 `
  -EvidenceExe .\target\release\yomumi-evidence.exe `
  -Before before.xml -After after.xml `
  -BeforeExit $beforeRc -AfterExit $afterRc
~~~

| Observed on Windows using Bun 1.4.5 | Script result | Exit |
| --- | --- | ---: |
| Same two tests, one fixed, no candidate failures | `evidence-ready` | 0 |
| A passing candidate report contains one skipped test | Reports not comparable | 2 |
| The same tests match but a failure remains | Candidate still has failing tests | 1 |

[Captured verification outputs](../evidence/review-recipe-windows.json). `evidence-ready` describes the two reports, not permission to merge or a claim of full coverage.

## Use with your existing tools

The output is versioned JSON. Pretty-print or select fields using your existing JSON tooling, such as [jq](https://github.com/jqlang/jq) or PowerShell's `ConvertFrom-Json`. Capture the Harness exit **before** pretty-printing; a successful formatter does not turn an unverified run into a pass. Keep raw reports local and use your existing runner and CI permissions.

Project changes belong in the [fork guide](06-fork-and-adapt.md), not in the integration wrapper. If a team wants a stricter rule, add its negative cases before adopting it.
