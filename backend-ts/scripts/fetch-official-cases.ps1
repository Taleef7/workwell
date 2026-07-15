[CmdletBinding()]
param(
  [string]$ContentDir = (Join-Path $PSScriptRoot "..\.official-content"),
  # Upstream revision the committed docs/OFFICIAL_TESTCASE_REPORT_2026-07.md was generated against.
  # Pass -Ref master (or another SHA) to test newer content; the committed report is only
  # reproducible at this pin.
  [string]$Ref = "ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab"
)

$ErrorActionPreference = "Stop"
$repo = "https://github.com/cqframework/dqm-content-qicore-2025.git"
$paths = @(
  "bundles/measure/CMS122FHIRDiabetesAssessGT9Pct",
  "bundles/measure/CMS125FHIRBreastCancerScreen",
  "input/tests/measure/CMS122FHIRDiabetesAssessGT9Pct",
  "input/tests/measure/CMS125FHIRBreastCancerScreen"
)
$ContentDir = [System.IO.Path]::GetFullPath($ContentDir)

if (Test-Path -LiteralPath $ContentDir) {
  $entries = @(Get-ChildItem -Force -LiteralPath $ContentDir)
  if ($entries.Count -gt 0 -and -not (Test-Path -LiteralPath (Join-Path $ContentDir ".git"))) {
    throw "Refusing to overwrite non-Git directory: $ContentDir"
  }
}

if (Test-Path -LiteralPath (Join-Path $ContentDir ".git")) {
  $dirty = git -C $ContentDir status --porcelain
  if ($LASTEXITCODE -ne 0) { throw "Unable to inspect existing checkout: $ContentDir" }
  if ($dirty) { throw "Official content checkout has local changes; refusing to update: $ContentDir" }
  git -C $ContentDir config core.longpaths true
} else {
  git clone -c core.longpaths=true --filter=blob:none --sparse --no-checkout $repo $ContentDir
  if ($LASTEXITCODE -ne 0) { throw "Unable to clone official content" }
}

git -C $ContentDir sparse-checkout set @paths
if ($LASTEXITCODE -ne 0) { throw "Unable to configure sparse checkout" }

git -C $ContentDir fetch --depth 1 origin $Ref
if ($LASTEXITCODE -ne 0) { throw "Unable to fetch pinned revision ${Ref}" }
git -C $ContentDir -c advice.detachedHead=false checkout --detach FETCH_HEAD
if ($LASTEXITCODE -ne 0) { throw "Unable to checkout pinned revision ${Ref}" }

$revision = git -C $ContentDir rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve official content revision" }
Write-Host "Official CMS122/CMS125 content ready at $ContentDir ($revision)"
