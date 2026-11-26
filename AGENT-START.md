# First read for agents

- Use the local Rust `yomumi-evidence` binary (`.exe` on Windows), built with `cargo build --release --locked`.
- Summarize with `yomumi-evidence compact REPORT --bun-exit EXIT --expect-file FILE`. Treat `unverified` or an absent verdict as incomplete.
- Compare with `yomumi-evidence compare BEFORE AFTER --before-exit EXIT --after-exit EXIT`. A matched verdict alone is not a pass.
- Prefer compact JSON. Don't send raw reports to a provider. Python scripts are an explicit fallback; never silently retry a failed or unverified run with a different engine.
