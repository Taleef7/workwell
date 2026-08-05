[CmdletBinding()]
param(
  # Multi-argument Join-Path rather than a "..\.cql-tests" literal, for the reason
  # fetch-official-cases.ps1 records: .NET treats only "/" as a separator on Unix, so the literal works
  # on the ubuntu runner only by relying on the PowerShell provider normalizing it first.
  [string]$ContentDir = (Join-Path $PSScriptRoot ".." ".cql-tests"),
  # The commit the committed baseline.json and docs/evidence/CQL_TESTS_*.md were produced against.
  # Pass -Ref master to see what upstream has added; the baseline is only reproducible at this pin,
  # and scripts/cql-tests/report.ts asserts the case count that goes with it.
  [string]$Ref = "727219f492c0c84bf7a9c3589b1214e3b4e60667"
)

$ErrorActionPreference = "Stop"
$repo = "https://github.com/cqframework/cql-tests.git"

# Only the CQL corpus. The repository also carries FHIRPath tests and tooling we do not run, and a
# sparse checkout keeps the cache small and the intent legible.
$paths = @("tests/cql")

$ContentDir = [System.IO.Path]::GetFullPath($ContentDir)

if (Test-Path (Join-Path $ContentDir ".git")) {
  Write-Host "cql-tests already present at $ContentDir"
} else {
  New-Item -ItemType Directory -Force -Path $ContentDir | Out-Null
  git -C $ContentDir init --quiet
  git -C $ContentDir remote add origin $repo
  git -C $ContentDir config core.sparseCheckout true
  git -C $ContentDir sparse-checkout set --no-cone @paths
}

git -C $ContentDir fetch --quiet --depth 1 origin $Ref
git -C $ContentDir checkout --quiet FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw "checkout of $Ref failed" }

# Recorded so a results file is attributable to the content that produced it, without the runner
# shelling out to git.
Set-Content -Path (Join-Path $ContentDir ".pin") -Value $Ref -NoNewline

$xml = @(Get-ChildItem -Path (Join-Path $ContentDir "tests/cql") -Filter *.xml -ErrorAction SilentlyContinue)
if ($xml.Count -eq 0) {
  # An empty checkout that returns success would make the harness report a clean zero-case run. It must
  # not be possible to get that far.
  throw "no test XML found under $ContentDir/tests/cql — the sparse checkout produced nothing"
}
Write-Host "cql-tests at $Ref — $($xml.Count) test files in $ContentDir"
