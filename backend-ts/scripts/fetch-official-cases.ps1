[CmdletBinding()]
param(
  # Multi-argument Join-Path rather than a "..\.official-content" literal. The literal DID work on the
  # ubuntu runner (PowerShell's filesystem provider normalizes the backslash, then GetFullPath collapses
  # the ".."), but it worked by relying on that normalization: .NET itself treats only "/" as a separator
  # on Unix, so the string is one segment as far as System.IO is concerned. This form does not depend on
  # which layer normalizes it.
  [string]$ContentDir = (Join-Path $PSScriptRoot ".." ".official-content"),
  # Upstream revision the committed docs/OFFICIAL_TESTCASE_REPORT_2026-07.md was generated against.
  # Pass -Ref master (or another SHA) to test newer content; the committed report is only
  # reproducible at this pin.
  [string]$Ref = "ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab"
)

$ErrorActionPreference = "Stop"
$repo = "https://github.com/cqframework/dqm-content-qicore-2025.git"
# The five GATED measures, plus three CANDIDATES. A candidate is checked out but is deliberately NOT in
# `OFFICIAL_GATED_MEASURES` — its artifact is not vendored yet, so adding it to the gate would fail the
# deck. Checking them out is what lets `pnpm official:terminology-audit` and the credentialed
# `vendor-official-measure.yml` workflow read their bundles at the pinned commit without a 17 MB pull
# (ADR-053: that audit is how CMS138's absent value set was found).
$paths = @(
  "bundles/measure/CMS122FHIRDiabetesAssessGT9Pct",
  "bundles/measure/CMS125FHIRBreastCancerScreen",
  "bundles/measure/CMS2FHIRPCSDepScreenAndFollowUp",
  "bundles/measure/CMS68FHIRDocumentationCurrentMeds",
  "bundles/measure/CMS951FHIRKidneyHealthEval",
  "bundles/measure/CMS130FHIRColorectalCancerScrn",
  "bundles/measure/CMS138FHIRTobaccoScrnCessation",
  "bundles/measure/CMS165FHIRControllingHighBP",
  "input/tests/measure/CMS122FHIRDiabetesAssessGT9Pct",
  "input/tests/measure/CMS125FHIRBreastCancerScreen",
  "input/tests/measure/CMS2FHIRPCSDepScreenAndFollowUp",
  "input/tests/measure/CMS68FHIRDocumentationCurrentMeds",
  "input/tests/measure/CMS951FHIRKidneyHealthEval",
  "input/tests/measure/CMS130FHIRColorectalCancerScrn",
  "input/tests/measure/CMS138FHIRTobaccoScrnCessation",
  "input/tests/measure/CMS165FHIRControllingHighBP"
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
Write-Host "Official measure content ready at $ContentDir ($revision) — $($paths.Count / 2) measures"
