# Issue #150 — Demo Readiness Fixes + #96 Parity Plan

Date: 2026-06-15
Owner: Taleef
Status: In progress

## Context

A live end-to-end QA pass (2026-06-15) on `twh.os.mieweb.org` surfaced 21 findings
(4 Critical, 4 High, 13 Medium) — see issue #150. The demo is **done**; there is no
hard date pressure. The goal now:

> Land **#150** (demo-readiness) **and** **#96** (de-Java re-platform / #109 cutover),
> while keeping the MIE OS stack functional and demoable the entire way through.

## Strategy

The live stack is still the **Java** backend. #96/#109 swaps it for `backend-ts`.
Therefore **#150 doubles as the functional-parity / acceptance checklist for the
#96 cutover** — the "known-good behavior" `backend-ts` must reproduce. This protects
the "don't break anything / functionality not compromised" requirement.

### Fix-location policy

- **Docs / narrative** — persist regardless. Fix now.
- **Frontend-only** — the Next.js app is **shared & unchanged** across the migration
  (strangler-fig behind the same fetch contract). Fixes carry over; not throwaway. Fix now.
- **Backend** — the part being swapped. For each item: **audit `backend/` (Java) vs
  `backend-ts/`**, then fix in the right place **once**. Where the demo must stay correct
  on the current Java stack in the interim, fix Java too and require `backend-ts` parity.
- **Migration-entangled** (C1, C2) — doc-correct now; real feature/state lands with #96.

## Triage matrix

| ID | Sev | Area | Fix location | Root cause (confirmed ✓ / hypothesis ?) | Batch |
|----|-----|------|--------------|------------------------------------------|-------|
| C1 | 🔴 | ELM Explorer not live | docs now; feature via #96 (#106) | ✓ exists only in backend-ts; not wired into live Java UI | 1 (docs) / 3 |
| C2 | 🔴 | Catalog 8/0/800 not 10/2/1000 | docs now; promotion optional | ✓ 8 Active, CMS125/CMS122 Draft; copy says "4"/"Eight" | 1 (docs) / opt |
| C3 | 🔴 | ALL_PROGRAMS ~3.7min | docs now; perf optional | ✓ measured 209–241s; docs claim ~58s | 1 (docs) / opt |
| C4 | 🔴 | Rerun corrupts program dashboard | backend (rollup) — parity | ? latest-run rollup ignores scope_type, picks CASE rerun | 2 |
| H1 | 🟠 | Worklist flood 4,703 open | backend (aging/period) + FE default | ? daily cron makes new period cohort; old never closes | 2 |
| H2 | 🟠 | "Employees tracked: 800" mislabel | frontend | ✓ `programs.tsx:159/188` sums totalEvaluated | 1 |
| H3 | 🟠 | Trend axis >100% | frontend | ? overview chart domain `["auto",100]`; verify detail page | 1 |
| H4 | 🟠 | Top Sites/Roles "—" on overview | backend (top-drivers) — parity | ? overview `/top-drivers` returns empty (FE renders if present) | 2 |
| M1 | 🟡 | Outreach template ignores outcome | backend (+FE default) — parity | ? template auto-select not outcome-bucket aware | 2 |
| M2 | 🟡 | Send disabled until Preview | frontend | ? gating on preview state | 1 |
| M3 | 🟡 | `vv1.0` double-v | frontend | ✓ UI prepends `v` to already-`v` string (waivers, run picker) | 1 |
| M4 | 🟡 | Run picker defaults to Draft measure | frontend | ? picker default not filtered to runnable Active | 1 |
| M5 | 🟡 | Run-detail outcomes not scoped to run | backend (+FE) — parity | ? outcomes grid not filtered by run_id | 2 |
| M6 | 🟡 | Evidence ref-date inconsistency | cql-engine/backend — parity | ? CQL define uses today, why_flagged period-anchored | 2 |
| M7 | 🟡 | `Patient: not found` shown as define | frontend (filter internals) | ? engine-internal defines not suppressed in explorer | 1 |
| M8 | 🟡 | Heatmap predicted == current | backend (+FE relabel) — parity | ? predicted column is passthrough of current rate | 2 |
| M9 | 🟡 | Audit CSV unbounded ~12MB | backend — parity | ✓ export returns full ledger | 2 (post-demo) |
| M10 | 🟡 | `/api/cases` silent 200 cap | backend — parity | ? cap with no total/pagination metadata | 2 (post-demo) |
| M11 | 🟡 | Audit log defaults to weak tab | frontend | ? default tab = case-views | 1 |
| M12 | 🟡 | Copy/credential inconsistency | frontend + docs | ✓ demo-login `cm@`, login "Four OSHA", landing "Eight" | 1 |
| M13 | 🟡 | Outreach due date in past | backend — parity | ? due date computed in past | 2 (post-demo) |

## Execution batches

**Batch 1 — safe, carries over (frontend + docs):**
H2, H3, M2, M3, M4, M7, M11, M12 + docs corrections for C1, C2, C3.
No backend risk; shared frontend + docs persist across the migration.

**Batch 2 — backend parity (audit Java vs backend-ts, fix once):**
C4, H1, H4, M1, M5, M6, M8, M9, M10, M13. Each produces a parity-matrix row the
#109 cutover must satisfy.

**Batch 3 — #96 closeout:**
Verify #106/#107/#108 surfaces, then #109 deploy cutover (binding selection + JVM
retirement) gated on the Batch-2 parity matrix.

**Optional / needs product call:**
- C2 promote CMS125v14 + CMS122v14 to Active (full CQL + fixtures) vs doc-correct only.
- C3 reduce per-employee eval cost to bring ALL_PROGRAMS under ~1min.

## Protect against regressions (from #150 "Verified working")

Case Why-Flagged evidence explorer; AI Explain; audit trail (Mutations Only);
value-set governance + terminology mappings + data-readiness; outreach send
(Preview→Send→SIMULATED + delivery log + audit); run logs; SQL Analogy; risk
outlook/heatmap; deterministic ~78%; MCP `/sse` 403; integration health green.
Every Batch must re-verify these.

## Progress log

### 2026-06-15 — Batch 1 (frontend + docs), session 1

**Frontend — DONE, verified (lint ✓, `tsc --noEmit` ✓, vitest 55/55 ✓):**
- **H2** `programs/page.tsx` — "Employees tracked" → "Evaluations (latest runs)" (var renamed `totalEvaluations`).
- **H3** `programs/page.tsx` — overview mini-chart `domain={["auto",100]}` → `[0,100]` (matches the detail page; stops recharts nice-padding above 100).
- **M2** `cases/[id]/page.tsx` — Send-outreach button now has a `title` explaining the preview prerequisite when disabled.
- **M3** double-`v` removed in `runs/page.tsx` (picker), `admin/page.tsx` (waivers), `employees/[externalId]/page.tsx`. Version field is already `v`-prefixed; UI no longer prepends.
- **M4** `runs/page.tsx` — measure picker defaults to first **Active** measure (was `data[0]`, a Draft) and filters options to Active-only.
- **M7** `cases/[id]/page.tsx` — `INTERNAL_DEFINES` filter hides engine-scaffolding defines (`Patient`, `Initial Population`, `Numerator(/Exclusion)`, `Denominator(/Exclusion/Exception)`) from the human-readable evidence list; raw JSON view keeps them. *(Judgment call flagged to maintainer; can narrow to just Patient + Initial Population.)*
- **M11** `admin/page.tsx` — audit-log default tab `access` → `all`.
- **M12** login hero copy de-numbered ("OSHA safety and clinical wellness measures"); run-confirm dialog "all 4 active measures" → dynamic `${programs.length}`; `DEMO_EMAIL` split → login demo `admin@workwell.dev`, new `SANDBOX_EMAIL` keeps the public sandbox on the lower-privilege `cm@workwell.dev` (confirmed: sandbox must NOT have admin).

**Docs:**
- **C1** `README.md` — clarified the no-JVM ELM Explorer is a `backend-ts` feature that surfaces post-#109; the live Java CQL tab has compile + SQL-analogy, not ELM/AST.

**Decisions:**
- **C2 = promote (maintainer chose).** Root cause: `MeasureService.ensureCms125Seed/122Seed` only INSERT as Active on a fresh DB; the `existing>0` branch refreshes CQL but never sets `status='Active'`, so the live Neon DB is stuck Draft. CMS125/122 are genuinely runnable (covered by `EngineGoldenParityTest` + `CqlEvaluationServiceTest`; synthetic builder emits mammogram/HbA1c). **Landmine:** the YAML engine binding keys CMS122 by measure name `"Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)"`, but live/catalog name is `"Glycemic Status Assessment Greater Than 9%"`. The fix must reconcile the name **without breaking CQL→measure binding**, in Java + `backend-ts`, with tests. → Batch 2.

**Deferred into Batch 2 (with their code):**
- C2 seed promote + CMS122 name reconciliation + `MEASURES.md` 3b.2 heading (doc+code in same change).
- C3 timing: mostly local demo materials; consider a runbook note (pre-run / MEASURE-scope) — committed "~58s" lives only in the #96 plan doc (historical).

### 2026-06-15 — Batch 2 (backend parity), session 1

On branch `fix/issue-150-demo-readiness`.

**C2 — promote CMS125/CMS122 to Active (DONE, Java verified):**
- Root fix in `MeasureService.ensureCms125Seed`/`ensureCms122Seed`: the `existing>0` branch now
  sets `status='Active'`, `activated_at=COALESCE(...)`, refreshes CQL, **and** normalizes
  `measures.name` to the exact YAML binding key. Fresh-insert path already seeded Active.
- **CMS122 name landmine resolved.** The evaluator binds CQL by measure *name*
  (`CqlEvaluationService.seededInputsFor → measureDefinitionProvider.forMeasure(name)`, exact
  `byName.get`). Standardized the title to the modern CMS122v14 name
  **"Diabetes: Glycemic Status Assessment Greater Than 9%"** across: `cms122.yaml` `name:`,
  `MeasureService` fresh-insert name, `EngineGoldenParityTest`, `YamlMeasureDefinitionProviderTest`,
  `CqlEvaluationServiceTest`, and `backend-ts/measure-registry.ts`. Left untouched: the CQL define
  `HbA1c Poor Control`, the `cms122` slug, golden-JSON define names.
- **Verified:** `gradlew test --tests *CqlEvaluationServiceTest --tests *EngineGoldenParityTest
  --tests *YamlMeasureDefinitionProviderTest` → BUILD SUCCESSFUL. CMS122 still evaluates 100
  outcomes with COMPLIANT/OVERDUE/MISSING_DATA/EXCLUDED spread; golden parity holds.
- **backend-ts parity:** binds by slug→ELM library (not name), so robust. Generated
  `measure-catalog.ts` already carries the modern name + Active status (from Java catalog line 84);
  only the hand-written `measure-registry.ts` `name` needed updating. (backend-ts suite re-run pending.)
- **Docs:** `MEASURES.md` 3b.2 heading → modern name + binding note. README "10 runnable / 2 active
  CMS" claims are now *true* once this seed fix deploys.
- **Cosmetic follow-ups (noted, low priority):** Java seeder `description`/`change_summary` and
  backend-ts `CMS_ACTIVE_SPEC.cms122` still say "HbA1c Poor Control" (clinical synonym, not the
  binding key). The promote branch keeps the catalog's lean `spec_json` rather than the authored
  one — eval is unaffected (CQL-driven); Studio Spec tab shows the catalog spec.

**C4 — rerun corrupts the program dashboard (DONE, both stacks, verified):**
- Root cause: all three rollups in `ProgramService` (`listPrograms` latest_run CTE, `trend`
  outcome_based, `topDrivers` latest-run pick) selected the latest run by `started_at` regardless
  of `scope_type`, so a single-subject CASE/EMPLOYEE rerun-to-verify became the measure's "latest
  run" and crashed the rate to 0%/100%. Added `AND r.scope_type NOT IN ('CASE','EMPLOYEE')` to all
  three (Java).
- **backend-ts parity:** threaded `runScopeType` through `OutcomeWithRun` + both store
  `listOutcomesWithRun` impls (sqlite/pg), and filter `isPopulationRun` in `program-read-models`
  (`programOverview` rows + `runsWithOutcomes` → covers overview/trend/top-drivers). Added a
  DB-backed regression test in `programs.test.ts`.
- **Verified:** backend-ts typecheck + 404 tests; Java DB-backed regression test
  `ProgramRollupRerunIntegrationTest` (Testcontainers Postgres) — seeds a population run + a
  lowercase `"case"` rerun and asserts the rollup isn't skewed; **proven to fail without the fix
  and pass with it**.
- **Codex P1 (resolved):** the first cut used uppercase `NOT IN ('CASE','EMPLOYEE')`, but the Java
  backend persists these scope types **lowercase** (`CaseFlowService` writes `"case"`; manual runs
  `.name().toLowerCase()`), so the filter matched nothing — C4 wasn't actually fixed. Corrected to
  `UPPER(r.scope_type)` in all three Java predicates and `.toUpperCase()` in backend-ts'
  `isPopulationRun`. The new DB integration test is the regression guard that was missing (it's why
  the casing slipped). backend-ts stores scope types uppercase (type-enforced), so it was already
  correct; the normalization is defensive there.

**Commits on `fix/issue-150-demo-readiness` (PR #151):**
- `45024bc` fix(web): #150 demo-readiness frontend papercuts + ELM-explorer doc (C1)
- `b41d374` fix(measure): #150 C2 — promote CMS125/CMS122 to Active + reconcile CMS122 name
- `0baa0ff` fix(program): #150 C4 — exclude single-subject reruns from program rollups
- (this commit) fix(program): #150 C4 — normalize scope_type case (Codex P1) + DB regression test

**Remaining Batch 2:** H1, H4, M1, M5, M6, M8, M9, M10, M13.
