# Official MADiE Test-Case Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a DB-less CLI that evaluates the official CMS122 and CMS125 MADiE patient fixtures with the pinned `fqm-execution` 1.8.5 literal path, compares four population memberships to expected MeasureReports, and commits reproducible evidence without committing the source fixtures.

**Architecture:** A pure standards module owns fixture loading, expected-result normalization, one-batch-per-measure calculation, discrepancy classification, and Markdown rendering. A side-effect-free CLI module supplies argument parsing and file output, while a tiny bin wrapper owns process exit. The official sparse clone stays under ignored `backend-ts/.official-content`; the 2025 AU bundles supply their own expanded ValueSets, while the optional v0.5.000 CMS122 drift pass receives those ValueSets as `valueSetCache`.

**Tech Stack:** Node 24, TypeScript, `node:test`, `fqm-execution` 1.8.5, PowerShell/Git sparse checkout, pnpm.

## Global Constraints

- No new dependencies and no schema changes.
- Never touch `worker.ts`, request handling, engine ingress, or the live run pipeline.
- `fqm-execution` remains diagnostic-only under ADR-026; only `standards/literal-diff.ts` and the new standards harness may import it.
- Run `Calculator.calculate` once per selected measure over every patient bundle.
- Compare raw `initial-population`, `denominator`, `denominator-exclusion`, and `numerator` membership only; CMS122 is inverse and must not be translated to compliance.
- Treat only the six named CMS122 expected-vs-reference numerator discrepancies as adjusted passes, and classify loader/calculation failures separately.
- Do not commit any downloaded dQM content.

---

### Task 1: Pure official-case fixture loader and comparison model

**Files:**
- Create: `backend-ts/src/standards/official-cases.ts`
- Create: `backend-ts/src/standards/official-cases.test.ts`

**Interfaces:**
- Consumes: a content root containing `bundles/measure/<name>` and `input/tests/measure/<name>`.
- Produces: `loadOfficialMeasureCases(contentDir, measure)`, `compareCaseResults(...)`, `renderOfficialCaseReport(...)`, and typed measure/case/summary records.

- [ ] **Step 1: Write failing loader tests**

Create temporary miniature MADiE directories with `.madie`, one expected MeasureReport, and loose Patient/Observation JSON. Assert that the loader excludes the MeasureReport from a collection Bundle, finds the Patient id, reads the 2026 period, maps all four population counts, and uses `.madie` series/title metadata.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd backend-ts; node --import tsx --test src/standards/official-cases.test.ts`

Expected: FAIL because `official-cases.ts` does not exist.

- [ ] **Step 3: Implement the minimal loader and comparison functions**

Use `node:fs`/`node:path` only. Validate one MeasureReport and one Patient per case, normalize missing population codes to zero, enforce a common measurement period per measure, and return per-case loader errors rather than losing the batch. Encode the six full CMS122 UUIDs in an exported constant and recognize an adjusted reference agreement only when the sole difference is expected numerator `0` versus actual `1`.

- [ ] **Step 4: Add failing rendering/classification tests, then implement Markdown rendering**

Assert per-case columns `Case`, `UUID`, `IPP E/A`, `DENOM E/A`, `DENEX E/A`, `NUMER E/A`, and `Result`, plus raw and reference-adjusted summary counts and explicit value-set-cap notes.

- [ ] **Step 5: Re-run the focused tests and verify GREEN**

Run: `cd backend-ts; node --import tsx --test src/standards/official-cases.test.ts`

Expected: all focused tests pass.

### Task 2: Literal batch calculator and ADR-026 isolation

**Files:**
- Modify: `backend-ts/src/standards/official-cases.ts`
- Modify: `backend-ts/src/standards/official-cases.test.ts`
- Modify: `backend-ts/src/standards/fqm-isolation.test.ts`

**Interfaces:**
- Consumes: official measure Bundle, all loaded patient Bundles, calculation seam compatible with `Calculator.calculate`, and optional old CMS122 bundle.
- Produces: `runOfficialMeasureCases(...)` with calculation mode, trustMetaProfile used, ValueSet provenance/cap statistics, per-case actual populations, errors, and optional draft drift deltas.

- [ ] **Step 1: Write a failing injected-calculator batch test**

Assert exactly one calculator call for multiple patients, exact options (`calculateSDEs/HTML/ClauseCoverage/RAVs:false`, `verboseCalculationResults:true`, 2026 period), default `trustMetaProfile:false`, patientId-based result matching, and raw Boolean-to-0/1 conversion.

- [ ] **Step 2: Verify RED, then implement the minimal calculator seam**

Run the focused test and confirm the new runner is missing; implement a lazy `import("fqm-execution")` default while preserving injection for unit tests.

- [ ] **Step 3: Test and implement ValueSet/trust behavior**

Inspect bundled `ValueSet` resources and report their expansion/truncation counts. Use no fourth argument for v1.0.000 because 1.8.5 automatically reads Bundle ValueSets; retry once with `trustMetaProfile:true` only when the false-profile run returns no non-Patient evaluated resources/population signal. For draft drift, pass the v1.0.000 ValueSets as the fourth argument.

- [ ] **Step 4: Extend the isolation allowlist explicitly**

Change the architecture test from a one-file assertion to an exact set containing `standards/literal-diff.ts` and `standards/official-cases.ts`, while separately retaining the invariant that no request pipeline, ingress module, `worker.ts`, or unrelated run module imports `fqm-execution`.

- [ ] **Step 5: Verify the focused and isolation tests GREEN**

Run: `cd backend-ts; node --import tsx --test src/standards/official-cases.test.ts src/standards/fqm-isolation.test.ts`

Expected: all tests pass.

### Task 3: CLI, fetch script, and ignored content workflow

**Files:**
- Create: `backend-ts/src/run/cli/official-cases.ts`
- Create: `backend-ts/src/run/cli/official-cases-bin.ts`
- Create: `backend-ts/src/run/cli/official-cases.test.ts`
- Create: `backend-ts/scripts/fetch-official-cases.ps1`
- Modify: `backend-ts/package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `pnpm test:official-cases [--measure cms122|cms125] [--content-dir <path>]`.
- Produces: exit 0 for reference-adjusted agreement, exit 1 for unexpected mismatches/loader errors, exit 2 for usage/content errors, and `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md`.

- [ ] **Step 1: Write failing parser/main tests**

Cover default both-measure selection, each valid measure, absolute/relative content paths, unknown/missing arguments, injected report writing, and exit-code policy.

- [ ] **Step 2: Verify RED, implement parser/main/bin, then verify GREEN**

Keep the library module side-effect-free and the bin wrapper limited to calling `main(process.argv.slice(2))`.

- [ ] **Step 3: Add fetch workflow and ignore rule**

The PowerShell script must use `git clone -c core.longpaths=true --filter=blob:none --sparse --depth 1`, set exactly the two bundle and two test-case directories, and refuse to overwrite a non-empty unrelated target. Ignore `/backend-ts/.official-content/`.

- [ ] **Step 4: Add the package script and manually verify help/fetch idempotence**

Add `"test:official-cases": "tsx src/run/cli/official-cases-bin.ts"`. Run the fetch script against the existing fresh clone and confirm it reports the current checkout rather than recloning or deleting it.

### Task 4: Execute official cases and the CMS122 draft drift stretch

**Files:**
- Generate: `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md`

- [ ] **Step 1: Run CMS122 v1.0.000 over all 55 patients**

Run: `cd backend-ts; pnpm test:official-cases --measure cms122`

Investigate every unexpected mismatch, loader error, or result omission. Confirm whether the only raw mismatches are the six reference-reported numerator cases.

- [ ] **Step 2: Run CMS125 v1.0.000 over all 66 patients**

Run: `cd backend-ts; pnpm test:official-cases --measure cms125`

Investigate every mismatch because the source comparison report lists CMS125 under zero discrepancies.

- [ ] **Step 3: Run the combined report**

Run: `cd backend-ts; pnpm test:official-cases`

Confirm the Markdown contains 121 case rows, content commit provenance, trustMetaProfile mode, ValueSet-cap caveat, raw agreement, adjusted agreement, and error categories.

- [ ] **Step 4: Run the stretch drift comparison**

Evaluate the same 55 CMS122 patient bundles against `measures/official/cms122v14/CMS122FHIR-v0.5.000-FHIR.json`, passing official v1.0.000 ValueSets as `valueSetCache`. Record changed population vectors/case count separately from agreement claims.

### Task 5: Documentation, full verification, commit, and PR

**Files:**
- Modify: `HL7 Connectathon/RESEARCH_FINDINGS_2026-07-15.md`
- Modify: `docs/STANDARDS_CONFORMANCE.md`
- Modify: `docs/JOURNAL.md`
- Modify: `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md`

- [ ] **Step 1: Append research section 7 and standards summary**

Report exact CMS122/CMS125 raw and adjusted case counts, mismatched UUIDs/populations, errors, trustMetaProfile setting, bundled ValueSet behavior/caps, and v0.5.000 drift results. Keep engine defects, known-bad expected values, harness errors, and possible cap effects distinct.

- [ ] **Step 2: Add the newest-on-top journal entry**

Document branch scope, no-request-path/no-schema/no-dependency facts, source commit, commands, exact results, and drift finding.

- [ ] **Step 3: Run fresh verification**

Run: `cd backend-ts; pnpm typecheck; pnpm test`

Then rerun `pnpm test:official-cases` so the committed report is generated by the verified final code. Inspect `git diff --check`, `git status`, and the report row/count totals.

- [ ] **Step 4: Commit logical units with conventional messages**

Use focused commits such as `feat(standards): add official MADiE test-case harness` and `docs(standards): record official eCQM case results`. Stage only task-owned files.

- [ ] **Step 5: Push and open a review PR without auto-merge**

The PR description must explicitly state the ADR-026 allowlist extension and preserved prohibition on request pipeline, engine ingress, and `worker.ts` imports. Wait for CI and report its actual result; never auto-merge.

## Self-Review

- Spec coverage: loader, one-call batch execution, embedded expansions, trust retry, four raw populations, known-bad calibration, report, research §7, STANDARDS, JOURNAL, drift stretch, isolation, and verification are each assigned above.
- Placeholder scan: no implementation placeholder or unassigned acceptance criterion remains.
- Type consistency: the pure loader feeds the batch runner; the batch runner feeds the renderer; the CLI only orchestrates those public interfaces.
