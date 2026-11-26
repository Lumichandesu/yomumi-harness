# Contributing

Small, reproducible changes are welcome. This repo is the Bun evidence layer, not a host for private platform tooling. Keep fixtures synthetic and remove any private filenames, secrets, customer data, or raw production reports from contributions.

## Before asking for review

1. State what a reviewer should be able to decide after the change. Link the existing behavior or add a minimal fixture and the expected verdict.
2. Run `cargo test --locked` and `cargo build --release --locked` from the repository root. Changes that alter output or exits need an explicit compatibility note and a targeted case. For runner behavior, reproduce the [first real Bun run](docs/guide/01-first-run.md) or the [detail-cap regression](docs/guide/10-bounded-summaries.md).
3. For measurement claims, use the [measurement guide](docs/guide/03-measurement.md). Include the scope and denominator. A failing or skipped check is evidence, not permission to loosen the gate.
4. Report what passed, what remains unverified, and whether fixture data or real Bun output produced the result. Keep changes reversible and do not claim production coverage from this repo.

Use an issue or PR to propose changes. Start with the expected outcome and how to test it; a short diff with a useful verification receipt is easier to review than a large rewrite.
