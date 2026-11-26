# Catch a Bun .only run that looks green

Bun 1.4.5 may entirely omit the other tests in a file when `test.only` is present. In this example both runs return 0 and both JUnit reports show zero skipped; only the recorded test count changes.

## PowerShell reproduction

Run at the repository root. Reports go into a fresh temporary directory.

~~~powershell
cargo build --release --locked
$dir = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $dir | Out-Null
$file = "examples/focused-run.test.ts"
$exe = ".\target\release\yomumi-evidence.exe"
$previousFocus = $env:HARNESS_DEMO_FOCUS
try {
  foreach ($focus in '0','1') {
    $env:HARNESS_DEMO_FOCUS = $focus
    $report = Join-Path $dir "$focus.xml"
    bun test --reporter=junit "--reporter-outfile=$report" $file
    $bunExit = $LASTEXITCODE
    & $exe compact $report --bun-exit $bunExit --expect-file $file --expect-tests 2
    Write-Host "Harness exit: $LASTEXITCODE"
  }
} finally {
  $env:HARNESS_DEMO_FOCUS = $previousFocus
}
~~~

| Windows x64 / Bun 1.4.5 | Bun exit | JUnit rows | Reported skipped | Harness exit |
| --- | ---: | ---: | ---: | ---: |
| Full run | 0 | 2 | 0 | 0 |
| Focused run | 0 | 1 | 0 | 2, `test_count_mismatch` |

Use a count established from a known full run so changing the fixture intentionally requires updating its expectation. Count equality does not prove identity equality: keep a trusted baseline and use `compare` when substitutions matter. See the [reference](04-reference.md#focused-tests-and-omitted-rows).
