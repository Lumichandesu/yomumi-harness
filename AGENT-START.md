# First read for agents

| Need | Route |
| --- | --- |
| Check a single Bun run | `yomumi-evidence compact REPORT --bun-exit EXIT --expect-file FILE` |
| Check what changed | `yomumi-evidence compare BEFORE AFTER --before-exit EXIT --after-exit EXIT` |
| Need an example or stuck on a verdict | [Field guide](docs/guide/README.md) |

Build with `cargo build --release --locked`; use the binary in `target/release/` (with `.exe` on Windows). Capture exits from the actual invocations. Never turn `unverified`, `incomplete`, or a missing verdict into a pass. `matched` only means comparable: inspect the change list. Don't send raw reports to a provider. No automatic engine fallback.
