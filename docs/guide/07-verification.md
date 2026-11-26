# What the tests prove

| Layer | Question | How to rerun |
| --- | --- | --- |
| Rust CLI replay | Can the built tool correctly process saved, actual Bun reports without installing Bun? | `cargo test --locked --test replay`: one fix, green with a skipped case, wrong file scope, a moved failure, and a changed failure signal. |
| Rust parser and cap tests | Do ambiguous or truncated outcomes stay safe? | `cargo test --locked`; verifies retry-marker rejection and retention of a late regression. |
| Real Bun workflow | Does the result survive an actual runner rather than a hand-built XML example? | [First real run](01-first-run.md) with Bun; observed outcomes are in the [Windows receipt](../evidence/guide-replay-windows.json). |
| Performance | Is the CLI faster for the same work, not just returning earlier? | [Measurement guide](03-measurement.md); compare outputs before comparing time. |
| Token size | Is the data sent to the reviewer smaller under a named tokenizer? | [Token measurement](05-token-budget.md); it measures a text payload, not response costs or answer quality. |

The safety-critical review case is a green runner with a missing test. The runner did nothing wrong; it passed what it was asked to execute. A diff reviewer is answering a different question: did we see the same tests before and after? That is why the before/after command checks observed identities instead of simply subtracting failures.

A scoped file verdict by itself does not tell you that every individual test in that file ran. Conversely, even matched identities cannot prove that the two invocations used the same settings or revision. Preserve your run command, code revisions, and raw reports locally.

## What would be useful to test next?

- Capture awkward cases from your own workflows as public-safe reproductions: missing reports, early exit, duplicate IDs, or filter mistakes. Keep private logs private.
- Add a fixture with many **different** failures as well as repeated failures. See the [existing case with a late regression](10-bounded-summaries.md); a detail cap still cannot show everything.
- If speed or token use is the reason for adopting the tool, benchmark it on representative inputs from your own project, including the full review path if you want an end-to-end claim.
