# Yomumi Harness

Small, local utilities that turn Bun test runs into compact evidence an AI agent or human can review. This extraction includes the test-evidence layer, not Yomumi's application code or its internal tool registry.

## Quick start

Requires Python 3.10+. No Python packages, API keys, or accounts are needed. Bun is only needed to generate a report.

From your project root, run Bun with a relative test path and record its actual exit status:

~~~sh
bun test ./tests/example.test.ts --reporter=junit --reporter-outfile=run.xml
python /path/to/yomumi-harness/compact_bun_failures.py run.xml --bun-exit 0 --expect-file tests/example.test.ts
~~~

Replace `0` with the status from that invocation. Repeat `--expect-file` for each expected file. The compactor exits 0 for a scoped pass, 1 for a scoped failure, and 2 for unverified evidence. Without the exit and file arguments, it only summarizes and makes no pass claim.

To compare baseline and candidate reports:

~~~sh
python compare_bun_runs.py before.xml after.xml --before-exit 1 --after-exit 0
~~~

The comparison requires the same observed test identities and counts, no skips, and consistent exit codes. Its exit status indicates whether the comparison was possible, not whether it found a regression. Check `changeCount` and the change labels; the visible list is capped at 12.

## Privacy and verification

Run locally. Raw assertion text, test names, and logs are not emitted. Summaries can still include project-relative file paths and deterministic hashes derived from reports or assertions; review them before sharing. Never publish raw reports or treat hashes as anonymization. Matching summaries do not prove that the runs came from the same source, full intended test scope, or equivalent environments. Keep the invocation, revision, environment, and original reports with your local evidence.

~~~sh
python -m unittest discover -v
~~~
