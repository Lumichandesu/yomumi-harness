# Performance and proof

The published performance claim is about **CLI wall time on the same input**, not Bun speed, model latency, or production traffic. The Linux run alternated Python and release Rust after warm-up. The Windows replay verifies behavior, not latency. The larger report was expanded from real report rows to exercise parsing at size; it did not execute 10,000 tests.

## Reproduce and report

~~~sh
cargo build --release --locked
python parity.py --bench
~~~

The parity phase compares JSON structure and exit codes before timings are interpreted. Inspect [the benchmark driver](../../parity.py) and [the recorded measurements](../evidence/linux-latency.csv). Keep same inputs, environment, build mode, and expected verdict across both tools. Attach exact workload sizes and state whether process startup, report generation, and file reads are inside the timing. Include p50 and p95. If parity fails, report the mismatch rather than a speed win. If you claim end-to-end improvement, measure that separately; this receipt does not identify the bottleneck in a full developer workflow.

That separation follows the spirit of [pstack’s benchmark checklist](https://github.com/cursor/plugins/blob/main/pstack/skills/benchmark-checklist/SKILL.md): prove the work happened before interpreting the timing.

## Evidence ledger

| Claim | Evidence or check | Boundary |
| --- | --- | --- |
| Correct scope is required for a scoped pass. | [First run, case 3](01-first-run.md#case-3-a-valid-report-from-the-wrong-scope) and [Windows replay](../evidence/guide-replay-windows.json). | File scope, not a statement about every individual test. |
| One fixed test under identical observed coverage can be identified. | [First run, case 1](01-first-run.md#case-1-a-real-fix-on-the-same-tests) and [fixture smoke](../evidence/windows-smoke.json). | Controlled fixture. |
| A green but filtered run cannot stand in for the baseline. | [First run, case 2](01-first-run.md#case-2-a-green-run-that-ran-less) and [Windows replay](../evidence/guide-replay-windows.json). | Same file; a test identity disappears. |
| Rust preserved the reference outcomes in the measured suite. | [Parity runner](../../parity.py), 284 matched comparisons on Linux. | Tested cases, not equivalence for every XML input. |
| The compact on-disk handoff is smaller for the fixture. | [Windows smoke](../evidence/windows-smoke.json) gives 880 and 513 bytes. | Not measured tokens; other reports differ. |
| Rust reduced subprocess latency in this harness. | [Linux data](../evidence/linux-latency.csv) and [chart](../assets/report-latency.svg). | Not a cross-tool or end-to-end speed ranking. |
