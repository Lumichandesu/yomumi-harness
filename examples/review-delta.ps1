param(
  [Parameter(Mandatory)][string]$EvidenceExe,
  [Parameter(Mandatory)][string]$Before,
  [Parameter(Mandatory)][string]$After,
  [Parameter(Mandatory)][int]$BeforeExit,
  [Parameter(Mandatory)][int]$AfterExit
)
$ErrorActionPreference = 'Stop'
# PS 7+ otherwise can throw on the tool's deliberate exit 2.
$PSNativeCommandUseErrorActionPreference = $false
$output = & $EvidenceExe compare $Before $After --before-exit $BeforeExit --after-exit $AfterExit
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Output 'STOP: reports are not comparable.'; exit 2 }
$delta = ($output -join "`n") | ConvertFrom-Json
if ($delta.verdict -ne 'matched' -or $null -eq $delta.changeCount -or
    $delta.changeCount -ne @($delta.changes).Count) {
  Write-Output 'STOP: incomplete change list; inspect the reports.'
  exit 2
}
if ($delta.afterFailed -ne 0) {
  Write-Output 'STOP: candidate still has failing tests.'
  exit 1
}
[PSCustomObject]@{
  verdict = 'evidence-ready'
  matchedTests = $delta.tests
  fixes = @($delta.changes | Where-Object { $_.change -eq 'fixed' }).Count
} | ConvertTo-Json -Compress
