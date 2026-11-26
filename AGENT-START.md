# First read for agents

- Summarize a Bun report: run `compact_bun_failures.py` with the actual runner exit and expected files. Treat `unverified` or an absent verdict as incomplete evidence.
- Compare two runs: run `compare_bun_runs.py` with both exit codes. Verify revisions and run settings separately. A matched verdict alone is not a pass.
- Prefer the compact JSON over raw logs. Inspect an individual failure only when needed and authorized. Do not send raw reports to a provider.
