# First real run

Use the public [order and cart fixture](../../examples/fixture.test.ts). No personal data, tokens, model calls, or repository changes are involved. Want to try the outcomes first? Use [the saved reports](../../examples/replay/README.md) without Bun. Run commands from the repository root with Bun and Rust installed. `cargo build --release --locked` is required once.

## Case 1: a real fix on the same tests

The fixture expects quantity 2. Generate a failing baseline with 3, then run the same file using 2. Keep the **actual** runner exits beside the two files.

**Bash**

~~~bash
before_rc=0; after_rc=0
HARNESS_EXAMPLE_QUANTITY=3 bun test ./examples/fixture.test.ts --reporter=junit --reporter-outfile=before.xml || before_rc=$?
HARNESS_EXAMPLE_QUANTITY=2 bun test ./examples/fixture.test.ts --reporter=junit --reporter-outfile=after.xml || after_rc=$?
target/release/yomumi-evidence compare before.xml after.xml --before-exit "$before_rc" --after-exit "$after_rc"
~~~

**PowerShell**

~~~powershell
$oldQuantity = [Environment]::GetEnvironmentVariable('HARNESS_EXAMPLE_QUANTITY')
try {
    $env:HARNESS_EXAMPLE_QUANTITY = '3'
    bun test ./examples/fixture.test.ts --reporter=junit --reporter-outfile=before.xml
    $beforeRc = $LASTEXITCODE
    $env:HARNESS_EXAMPLE_QUANTITY = '2'
    bun test ./examples/fixture.test.ts --reporter=junit --reporter-outfile=after.xml
    $afterRc = $LASTEXITCODE
} finally {
    [Environment]::SetEnvironmentVariable('HARNESS_EXAMPLE_QUANTITY', $oldQuantity)
}
.\target\release\yomumi-evidence.exe compare before.xml after.xml --before-exit $beforeRc --after-exit $afterRc
~~~

Read the delta: `matched`, two tests, one fixed. In real work, the comparison should differ by code revision or a declared input change, not by a hidden selection change.

## Case 2: a green run that ran less

Keep the failing baseline. Now run only the empty-cart test in the same file. Bun passes, but **the original quantity assertion did not run**.

~~~bash
filtered_rc=0
bun test ./examples/fixture.test.ts --test-name-pattern 'empty cart' --reporter=junit --reporter-outfile=filtered.xml || filtered_rc=$?
target/release/yomumi-evidence compare before.xml filtered.xml --before-exit "$before_rc" --after-exit "$filtered_rc"
~~~

On PowerShell, run the same Bun command, assign `$filteredRc = $LASTEXITCODE`, and run the `.exe` with `$beforeRc` and `$filteredRc`. The comparator returns **2 / `incomplete`**. It does not report a fix. Bun still records the quantity test in the XML as `skipped`. The Harness refuses this report even though the file is present and Bun's exit is 0. If a runner omits a test row entirely instead, the matched identity check guards against that separately.

## Case 3: a valid report from the wrong scope

~~~bash
target/release/yomumi-evidence compact after.xml --bun-exit "$after_rc" --expect-file examples/missing.test.ts
~~~

PowerShell uses `.\target\release\yomumi-evidence.exe` and `$afterRc`. The result is **2 / `unverified`**, with the expected and observed file mismatch. Changing an expected path just to get a pass defeats the check.

[Observed Windows results](../evidence/guide-replay-windows.json) are a small projection of the CLI JSON, not raw reports. The test reports stay on disk and are ignored by Git. Next: [review recipes](02-review-recipes.md).
