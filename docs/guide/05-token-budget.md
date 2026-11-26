# Why reduce evidence tokens?

An agent should get enough evidence to decide what to inspect next, not every repetition of the same stack trace. Keep the raw report locally. Send the compact verdict, scoped counts, and the largest relevant clusters first. If the evidence is inconclusive or a cluster needs explanation, read the relevant local excerpt next. Never trade away coverage or correctness to hit a token target.

## Measured input size

We generated actual JUnit reports with Bun 1.4.5 on Windows using two **controlled public fixtures**. The same-run XML was passed to Rust `compact` in its scoped mode and to the tokenizer. We counted the XML text as read and the JSON output with trailing whitespace trimmed, using [gpt-tokenizer](https://github.com/niieani/gpt-tokenizer) version 2.9.0, `o200k_base`.

| Fixture | Executed tests / failures / clusters | Raw XML | Compact JSON | Fewer tokens |
| --- | ---: | ---: | ---: | ---: |
| First-run fixture | 2 / 1 / 1 | 266 tokens | 159 tokens | 40.2% |
| Repeated failure fixture | 100 / 10 / 1 | 4,794 tokens | 157 tokens | 96.7% |

The 100-test fixture deliberately repeats one failure signal ten times when the benchmark asks for it. This is a demonstration of a workload compaction is designed for, not a typical-project estimate. Distinct failures and extra `--files` output can make JSON larger. Different tokenizers, prompt formatting, metadata, and follow-up requests will change what a model actually sees. We did not send an API request, measure cost, or test whether a model answers better.

[Raw counts, including bytes](../evidence/token-bench-windows.json) · [Benchmark driver](../../scripts/token-bench/run.ts)

## Reproduce it

~~~sh
cargo build --release --locked
cd scripts/token-bench
bun install --frozen-lockfile --ignore-scripts
bun run.ts
~~~

Build from the repository root. The tokenizer is a benchmark-only dependency, not needed by the Rust CLI. Installation can fetch the pinned package; the measurement runs locally. Bun report timing text can vary, so byte and token totals may move slightly from run to run.
