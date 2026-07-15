[CmdletBinding()]
param(
  [string]$ContentDir = (Join-Path $PSScriptRoot "..\.official-content")
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
  git -C $ContentDir pull --ff-only origin master
  if ($LASTEXITCODE -ne 0) { throw "Unable to fast-forward official content checkout" }
} else {
  git clone -c core.longpaths=true --filter=blob:none --sparse --depth 1 $repo $ContentDir
  if ($LASTEXITCODE -ne 0) { throw "Unable to clone official content" }
}

git -C $ContentDir sparse-checkout set @paths
if ($LASTEXITCODE -ne 0) { throw "Unable to configure sparse checkout" }

$revision = git -C $ContentDir rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw "Unable to resolve official content revision" }
Write-Host "Official CMS122/CMS125 content ready at $ContentDir ($revision)"
