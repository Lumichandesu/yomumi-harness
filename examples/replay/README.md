# Try it without running Bun

These files were captured from Bun 1.4.5 on Windows using the [public replay fixture](../fixture.test.ts). They contain only data from that example. They are checked-in inputs to the CLI, not a new test run on your machine.

| Report | Bun exit when captured | Contents |
| --- | ---: | --- |
| [before.xml](before.xml) | 1 | Two tests executed; one failed. |
| [after.xml](after.xml) | 0 | The same two tests executed and passed. |
| [filtered.xml](filtered.xml) | 0 | One test executed and passed. Bun marked the other as skipped. |

From the repository root, with Cargo:

~~~sh
cargo run --release --locked -- compare examples/replay/before.xml examples/replay/after.xml --before-exit 1 --after-exit 0
~~~

Expect `matched`, two tests, and one `fixed` change. Compare the same baseline against the filtered result:

~~~sh
cargo run --release --locked -- compare examples/replay/before.xml examples/replay/filtered.xml --before-exit 1 --after-exit 0
~~~

Expect `incomplete` and exit 2 even though the captured Bun exit was 0. Verify the same case as a standalone report:

~~~sh
cargo run --release --locked -- compact examples/replay/filtered.xml --bun-exit 0 --expect-file examples/fixture.test.ts
~~~

Expect `unverified`, `skipped: 1`, and `skipped_tests`. The Rust-only [integration tests](../../tests/replay.rs) exercise those verdicts and a wrong-expected-file case:

~~~sh
cargo test --locked --test replay
~~~

Cargo may need network access to fetch dependencies for the first build. Run with `--offline` after they are cached; the commands do not install or invoke Bun, Python, or a model. To recreate fresh reports with the Bun runner, follow [First real run](../../docs/guide/01-first-run.md).
