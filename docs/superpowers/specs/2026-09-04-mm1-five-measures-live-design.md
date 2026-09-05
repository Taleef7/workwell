# MM-1 U1 — the five vendored ACO measures run, and go live, on Maui

**Date:** 2026-09-04. **Milestone:** MM-1b (remaining slices) + MM-1c + the MM-1d interim warning
(`docs/ROADMAP_2026-08-30.md` §5). **Driving ADRs:** ADR-070, ADR-071; this unit adds ADR-072.
**Status:** design approved in session; implementation not started.

This is the first of three units. **U2** is the 20,000-patient deterministic corpus with provenance
(separate spec). **U3** is CMS137 (vendor, gate, multi-rate) (separate spec). The pilot's set is the
six computable measures on the ACO's PY2027 sheet; U1 covers the five that are already vendored and
MADiE-gated, U3 the sixth.

## 1. Goal

On the Maui deployment profile, **cms122, cms125, cms2, cms130 and cms165** evaluate through the
official executor over a **calendar-year measurement period**, appear Active in the catalog with
official-aware wording on roster, case and card surfaces, and are **flipped live on the Maui deploy
workflow** once each clears its verification debt. Nothing here touches CMS137, the 20k corpus, the
TWH measure list, or any schema.

## 2. Decisions taken in the design session (owner)

| # | Decision | Consequence |
|---|---|---|
| D1 | All six blue measures are in scope across U1–U3, including CMS137 despite CMS-1848-P's proposed removal of Quality ID 305. | Overrides the "confirm 305 first" sequencing of MM-1a. Recorded in ADR-072; the roadmap's caveat stays as a risk, not a gate. |
| D2 | Artifacts stay the **2026-performance-period QI-Core STU6** content (the only FHIR artifacts CMS has published; PY2027 exists as QDM only, and the 2027 FHIR content repo holds one draft). | The measurement period is 2027 by evaluation date, not by artifact. The manifest and docs record the v15 QDM technical release notes as the known logic delta. Re-vendor when the 2027 FHIR content lands (MM-1d proper). |
| D3 | Official-routed measures use the **calendar year containing the evaluation date** as the measurement period. | Applies to cms122/cms125 on TWH as well. |
| D4 | `hypertension` (authored BP screening) is **dropped from the Maui profile**. | The Maui roster is exactly the ACO set. |
| D5 | Verification debt is **run down first, timeboxed**, then each measure flips (locked decision 4A.5 kept). | MM-1c lives inside U1 as two lanes (§7). |
| D6 | MADiE FHIR test cases from the pinned content repo are the official test set; they are **vendored as fixtures with hash provenance**. | The gate stops depending on a CI-time clone for the five measures. |

## 3. The runnable rule (ADR-072, part 1)

Today `validateRunnableMeasureIds` requires an authored registry entry (`MEASURES`) **and** a synthetic
binding (`MEASURE_BINDINGS`). Official-only measures have neither and never will.

**Rule.** A measure id is runnable on a profile iff the profile lists it and either
- **(a) authored:** `MEASURES[id]` and `MEASURE_BINDINGS[id]` both exist (unchanged); or
- **(b) official-only:** a vendored manifest exists whose `catalogId === id`, `officialMeasureSemantics(id)`
  is defined, `OFFICIAL_GATED_MEASURES` includes it, **and** `WORKWELL_OFFICIAL_MEASURES` names it.

Consequences, all enforced at boot (module load of `deployment-profile.ts` plus the existing router
construction check), never mid-run:
- `MAUI_MEASURE_IDS = ["cms122","cms125","cms2","cms130","cms165"]`.
- An official-only id listed by the profile but **not routed** is *not runnable*: `isRunnableMeasure`
  returns false, the catalog row is Active, and the roster/case/measure surfaces render the row as
  "not yet routed on this deployment" (a new `routing` field on the measure read model:
  `authored | official | official-pending`). It never falls back to the authored engine, because
  there is none.
- The default profile's runnable set is **unchanged** (`Object.keys(MEASURES)`); official-only measures
  do not become runnable on TWH by this change.
- The boot log line that already prints the resolved profile also prints the runnable set and, per
  official-only id, whether it is routed.

Where the rule lives: a pure `classifyRunnable(id, env, deps)` in `deployment-profile.ts` returning
`{ kind: "authored" } | { kind: "official" } | { kind: "official-pending", reason } | { kind: "invalid",
reason }`; `validateRunnableMeasureIds` throws only on `invalid`.

**Module boundaries and load order (spec-review findings 1–5).**
- `config/` must not import `standards/official-cases.ts` — its header declares it diagnostic-only
  (ADR-026) and it must stay off the boot path. The "vendored + gated" test in clause (b) is instead
  answered by a new, tiny `config/official-measure-ids.ts` that lists the directories under
  `backend-ts/measures/official/` (one `readdirSync` at module load, no JSON parsing). This is sound
  because `official-gate.test.ts` already pins `OFFICIAL_GATED_MEASURES === vendored directory
  listing`; the config module relies on that invariant rather than importing the gate.
- Semantics come from `wiring/official-measure-semantics.ts` (pure table); routing from
  `wiring/official-routing.ts`. `config → wiring` already exists (`config/seam-inventory.ts`), so no new
  direction is introduced. `deployment-profile.ts` imports nothing from `run/` or `standards/`.
- `MAUI_MEASURE_IDS` stays a static allowlist literal. **Classification is lazy and memoized**:
  `isRunnableMeasure` / `classifyRunnable` compute on first call, reading `WORKWELL_OFFICIAL_MEASURES`
  through `officialMeasureIds(env)` at that moment (call-time, matching `official-routing.ts`); the
  module-load `validateRunnableMeasureIds` only checks clause (a) or the *vendored + semantics* half of
  (b), never the env. The worker's existing startup hook (where the routing problems are printed) calls
  `classifyRunnable` for every listed id and prints the runnable set and each official-only id's
  routed/pending state — that is the "boot log" referred to above.

## 4. The subject-bundle source seam

`run-pipeline.ts` builds each work item's bundle inline via `MEASURE_BINDINGS[id]` →
`deriveExamConfig` → `buildSyntheticBundle`, and derives the seeded target distribution from the
binding's `rateKey`. Official-only measures have no binding, so both call sites need a seam.

**Interface** (new file `backend-ts/src/engine/synthetic/subject-bundle-source.ts`). `TargetOutcome`
is the **existing** union exported by `exam-config.ts` (`COMPLIANT | DUE_SOON | OVERDUE | MISSING_DATA |
EXCLUDED`), a distribution bucket and never a decision. The bucket proportions for official-only
measures are the **same `seededDistribution` function** the authored measures use, keyed by
`measureId` as its `rateKey`, so the five-way split is identical to cms122's today:
```ts
export interface SubjectBundleSource {
  /** The seeded target bucket for (subject, measure) — a distribution key, never a decision. */
  targetFor(employees: readonly EmployeeProfile[], measureId: string, subjectId: string): TargetOutcome | null;
  distribution(employees: readonly EmployeeProfile[], measureId: string): Array<{ employee: EmployeeProfile; target: TargetOutcome }>;
  bundleFor(employee: EmployeeProfile, measureId: string, target: TargetOutcome, evaluationDate: string): FhirBundle;
}
```
Implementations:
- `bindingBundleSource` — wraps today's `seededDistribution` / `seededTargetFor` /
  `deriveExamConfig` + `buildSyntheticBundle`. Authored measures and cms122/cms125 keep their exact
  bytes (pinned by the existing golden tests).
- `officialOnlyBundleSource` — for cms2, cms130, cms165: `rateKey = measureId` for the seeded
  distribution, and three hand-written QI-Core shapes (§4.1).
- `compositeBundleSource` — dispatches on `classifyRunnable`: `authored` → binding source,
  `official` → official-only source. It is never asked about an `official-pending` or `invalid` id,
  because those are not in the runnable set and `resolveScope` never creates work items for them; it
  throws if asked, rather than guessing. This is what the pipeline calls. U2's corpus-backed source
  replaces the composite on the Maui profile; the interface is designed so that swap is one wiring line.

`resolveScope`, `bundleFor`, `case-rerun.ts`, `backfill-*` and the scale batch call the source, never
`MEASURE_BINDINGS` directly, for target and bundle. The live-WebChart path (`liveBundle`) is untouched.

### 4.1 The three official-only shapes

Each shape emits a QI-Core-profiled Patient (birth date set for the artifact's age gate), one
qualifying office-visit Encounter in the measurement period, and per target:

**The artifact's ELM is the authority for every detail below; where this table and the ELM disagree,
the implementer follows the ELM and corrects the table in the same PR.** Ages are as the ELM computes
them (at the END of the measurement period).

| Measure | COMPLIANT | OVERDUE | EXCLUDED | MISSING_DATA / DUE_SOON |
|---|---|---|---|---|
| **cms2** (12+ at period start) | Depression screening Observation dated on the encounter using the artifact's instrument value set — LOINC **73832-8** (adult, 17+) or **73831-0** (adolescent, 12–16) — with a **negative** result — a direct-reference SNOMED code (428171000124102) in the artifact's CQL, not a value-set member | screening Observation with a **positive** result and **no** follow-up | Condition: bipolar disorder (the artifact's denominator-exclusion set), plus a negative screen | no screening Observation (converges to OVERDUE; DUE_SOON converges to OVERDUE) |
| **cms130** (46–75) | one screening from the artifact's five modalities, dated inside its window: colonoscopy (10 y), CT colonography (5 y), flexible sigmoidoscopy (5 y), stool DNA-FIT (3 y), FOBT (measurement period). The shape uses colonoscopy 3 y before; a test exercises each modality at its window boundary | no screening Procedure/Observation | Condition: colorectal cancer **or** total colectomy Procedure (both artifact exclusion sets) | no screening (converges to OVERDUE) |
| **cms165** (18–85) | essential hypertension Condition (onset before the period start) + a BP Observation **inside the measurement period** (LOINC 85354-9 with components 8480-6 = 128, 8462-4 = 78). The artifact retrieves this Observation by PROFILE alone — `us-core-blood-pressure`, with no code filter at all — and then matches the two component codes, which are direct-reference LOINC codes in its CQL. 85354-9 is neither: it is on the resource because US Core's BP profile requires it. The profile stamp is therefore the only thing making this reading retrievable; the numerator reads the **most recent** reading in the period | same Condition + most recent BP 152/94 | Condition from one of the artifact's exclusion sets (ESRD / dialysis / renal transplant, pregnancy, hospice, and the age-66+ frailty+advanced-illness branch) — the shape uses ESRD; a test covers pregnancy and hospice | Condition, **no** BP Observation (converges to OVERDUE — CMS165's numerator requires a reading) |

Additional shape facts the implementer must honour:
- **cms2 has a denominator-EXCEPTION population** (patient refusal / medical reason, per the artifact);
  the shape emits it for one test subject so the DENEXCEP → EXCLUDED mapping is exercised. cms130 and
  cms165 declare no exception population.
- **cms2 follow-up** for a positive screen is any of the artifact's accepted resources — a
  `ServiceRequest`, `Procedure`, or `MedicationRequest` from the follow-up value sets, dated on the
  screen date. A "positive with follow-up" COMPLIANT variant is pinned by a test alongside the
  negative-screen COMPLIANT.
- Every code is dual-stamped with the artifact's own value-set member (from `terminology.json` through
  `bundled-ecqm-expansions.ts`) so `corpus-membership.test.ts`'s invariant covers the three new shapes.
  Convergences are pinned in tests exactly as cms122/cms125's are. The shapes are the fixture for the
  48-patient roster, the Maui e2e project and the flip gate until U2's corpus replaces them on Maui.

## 5. Measurement period and the effectivePeriod warning (ADR-072, part 2)

- `officialMeasurementPeriod(measureId, evaluationDate)` returns the **calendar year** containing
  `evaluationDate`: `YYYY-01-01T00:00:00Z … YYYY-12-31T23:59:59.999Z` (via `normalizePeriodEnd`).
  The authored path keeps `MEASURES[id].periodMonths`. `flip-snapshot` and `literal-diff` already call
  the shared function, so the shadow stays honest.
- The period is written into `evidence_json.official.measurementPeriod = { start, end }` next to
  `artifactSha256`. Exports that read `evidence_json.official` are untouched (additive key).
- **Run-level period (spec-review finding 14).** `run.measurementPeriodStart/End` is not a label:
  `measure-report.ts` and `qrda1-export.ts` print it as the MeasureReport / QRDA-I period. Rule:
  `planManualRun` records the **calendar year** when every measure in the run is official-routed
  (which is every Maui run, and a TWH `MEASURE`-scoped run of cms122/cms125), and the rolling window
  otherwise; a mixed `ALL_PROGRAMS` run on TWH keeps the rolling window and the outcome-level
  `evidence_json.official.measurementPeriod` remains the per-outcome truth. `DATA_MODEL_CONTRACTS.md`
  §5 gains two sentences stating exactly this.
- **Case-period bucketing.** `bucketPeriodForMeasure` (`compliance-period.ts`) already falls back to an
  ANNUAL, Jan-1-anchored bucket for measures absent from `MEASURE_BINDINGS`, which happens to equal the
  calendar year for the three official-only measures. This slice makes that intentional: the fallback
  is replaced by an explicit `official → calendar year` branch with a test, so a future binding entry
  cannot silently change a case's `evaluation_period` key.
- **effectivePeriod check.** After the period is computed, if the artifact's
  `manifest.effectivePeriod` does not contain it, the run appends a `WARN` log line naming the measure,
  the artifact period and the run period, and the boot-time routing check prints the same warning
  once per routed measure. It **does not refuse** — D2 deliberately runs 2026 logic over 2027. Pinned
  by a test with a 2027 evaluation date against the vendored 2026 manifests. "Boot-time" means the
  worker's existing startup hook that prints the routing problems, not module initialization.

## 6. Catalog, seed, and surfaces

**Catalog.** `cms2`, `cms130`, `cms165` rows: `status: "Active"`, `compileStatus: "COMPILED"`, spec
description rewritten in the shape of cms122's ("CMS165v14 / MIPS 236: …"), `requiredDataElements`
and `exclusions` filled from the artifact's populations. `cms137v14` untouched.

**Seed promotion.** `seedMeasureStore` promotes a persisted Draft row to Active only when the row still
matches the seed fingerprint. The existing private `isUnmodifiedLegacySeed` (`measure-seed.ts`) and the
inline fingerprint comparison in `repairHypertensionSeedRow` are extracted into one exported
`matchesSeedFingerprint(row, catalog, expectedStatus?)` and both callers use it. Each promoted row writes
one **`MEASURE_ACTIVATED`** audit event — a **new** event type (the `event_type` column is a free-form
string; no constraint change) — with `activatedBy: "system"` and a reason string. Edited rows are left
alone and logged, as ADR-071 does for deprecation. The `routing` field on the measure read model is
**computed at read time** from `classifyRunnable`, never persisted, so it cannot go stale against the
environment.

**Official display table.** New `backend-ts/src/compliance/official-display.ts`: per measure id, for
each `OutcomeStatus`, `{ status wording, method line, whyFlagged line, nextAction line }`, e.g.
cms122 OVERDUE → "Most recent HbA1c above 9%", cms2 OVERDUE → "No depression screening this period, or
positive screen without a follow-up plan", every EXCLUDED → "Excluded by measure logic (denominator
exclusion or exception)". `roster-vocabulary.ts`, `deriveWhyFlagged`, `nextActionFor` consult it when
`isOfficialRouted(id)`; authored measures are byte-identical. The CDS card inherits through the same
readers (ADR-067: no new text source). MIPS Quality ID renders beside the CMS id from
`MEASURE_IDENTITY` on the catalog and measure detail (the crosswalk surface MM-0 added).

**Frontend.** Read-only changes: the `routing` field → an "Official (not yet routed here)" badge on the
measure list/detail; no new filters (U2 owns filters).

## 7. Verification debt (MM-1c) and the flips

Two timeboxed lanes, one working day each, before any flip:

- **CMS2:** the seven `NUMER 1→0` disagreements are between our fqm-based executor and HAPI's
  cqf-fhir-cr in the 2026-08 cross-engine sweep; our executor matches MADiE's expected values on all 36
  cases. The lane reproduces the seven on the fresh HAPI container (the harness's "fresh container per
  input" rule), isolates the failing define per case, and writes a finding to `docs/JOURNAL.md`. Outcome
  A: the divergence is HAPI-side or test-case-side (e.g. an omitted element like the CMS122
  `dosageInstruction` case) → CMS2 clears. Outcome B: our executor is wrong → CMS2 does **not** flip;
  the finding goes to the owner with the fix scoped.
- **CMS130 + CMS165:** run the same cross-engine sweep (64 + 68 cases) on completed terminology. Clear
  on full agreement or on disagreements explained the same way; otherwise as Outcome B.

**Flip mechanism** (unchanged from ADR-045): one reviewed edit to
`.github/workflows/deploy-maui-mieweb.yml`'s `WORKWELL_OFFICIAL_MEASURES` per measure that cleared,
each preceded by an `official-flip-gate` report (§8) against the Maui roster. `official-flip-config.test.ts`
already enumerates the Maui workflow; its two sidecar predicates are generalized from
`shippedMeasures("deploy-twh-mieweb.yml")` to every workflow in `WORKFLOWS`.

**Activation prerequisite** already documented in `DEPLOY.md`: the live Maui "All Patients" segment must
cover both clinics and the five measures via the audited `PUT /api/segments/:id`; the seed (#513) does
this on a fresh store, and the deploy runbook step covers an existing one.

## 8. The official-only flip gate

`pnpm flip-gate --measure <id> [--evaluation-date YYYY-MM-DD]` (default: today's date, UTC, the same
default the run pipeline uses; the report records the date it ran with)
(`backend-ts/src/run/cli/official-flip-gate.ts`),
the `flip-snapshot` successor for measures with no authored counterpart. For the measure it:
1. runs the MADiE gate for that measure and reports pass/fail counts;
2. evaluates the loaded profile's evaluable roster through the official executor over the calendar
   period; reports IPP count, denominator, outcome distribution, evaluation-error count;
3. runs the effectivePeriod check;
4. writes `backend-ts/.flip-gate/<id>-<date>.json` (gitignored) and prints a verdict block.

Descriptive only, like `flip-snapshot`: writes no store rows, authors no status. The verdict text
states what ADR-043 says a machine cannot decide: a zero IPP is reported with "either nobody is
eligible or the data lacks an element the IPP reads", never as pass/fail.

## 9. Test-case provenance (D6)

`backend-ts/measures/official/<id>/tests/` gains the MADiE case bundles for the five measures, copied
from the pinned content commit, with `manifest.json` extended by
`tests: { count, sourcePath, sha256 }` (SHA-256 over the sorted concatenation). `official-cases.ts`
reads the vendored directory when present and falls back to the cloned content dir otherwise; CI's
reproducibility gate (`git diff --exit-code measures/official`) covers the new files. Licensed
terminology is not involved (test cases carry codes already public in the bundles CMS publishes).
Measured on the local sparse checkout: the test directories are 120–800 KB per measure, so the five
total under 3 MB uncompressed — committed as plain JSON, no compression, and the manifest hash is the
integrity check.

## 10. Verification

- MADiE gate exact at **410/410** (unchanged size — CMS137 is U3).
- New tests: `classifyRunnable` for all four kinds; official-only-unrouted → not runnable and no
  authored fallback; Maui profile lists exactly the five; calendar-year period incl. Dec 31 and Jan 1
  boundaries; effectivePeriod WARN with a 2027 date and no WARN with a 2026 date; seed promotion with
  and without fingerprint match; three shapes × five targets convergence table; corpus-membership
  invariant over the new shapes; `official-corpus-outcomes` for cms2/cms130/cms165 over the 48-patient
  roster asserts IPP > 0 and a non-degenerate distribution; display table covers every
  (measure, status) pair (exhaustiveness test); flip-config sidecar predicates fire for the Maui file
  (a test that removes a measure from the Maui list and expects failure); flip-gate CLI smoke on the
  SQLite floor.
- Frontend: measure list/detail badge tests; Maui e2e spec expects five measures and the MIPS ids.
- Gates: backend `pnpm typecheck && pnpm test`; frontend `pnpm lint && pnpm test && pnpm build`; CI
  `official-cases` job green; reproducibility gate green.

## 11. Docs (same PRs)

`MEASURES.md` (five rows, calendar period, effectivePeriod note, v15 delta note), `DEPLOY.md` Maui
section (runnable set, `WORKWELL_OFFICIAL_MEASURES` for Maui, flip runbook), `guide/` chapters 3
(engine) and 9 (numbers, dated), `DATA_MODEL_CONTRACTS.md` §5 one sentence, `DECISIONS.md` ADR-072 +
`ADR_INDEX.md`, `CDS_HOOKS.md` (display table is the card text source), `JOURNAL.md` entry per PR,
`LOCKED_DECISIONS.md` §4A.2 SINCE-note for D1.

## 12. PR split

1. **`feat/mm1-official-only-runnable`** — §3, §4, §5, §6 catalog + seed, §9, tests, ADR-072.
2. **`feat/mm1-official-surfaces-flip-gate`** — §6 display table + frontend badge, §8, flip-config
   generalization, docs.
3. **`fix/mm1c-<measure>-flip`** — one per measure that clears §7: the workflow edit, the flip-gate
   report summary in the PR body, JOURNAL finding.

PR 1 and 2 are sequenced (2 builds on 1's `routing` field and seam). §7's investigation lanes run in
parallel with PR 1 from the start; they produce findings, not code, until a flip PR.

## 13. Out of scope, named

CMS137 (U3); the 20k corpus, provider/site filters, retention (U2); the versioned compliance API
(kept, untouched); the TWH runnable set; schema/DDL (owner-owned); any QDM execution path (locked
decision 3); `systemActions`/`critical` on cards (ADR-067); AI surfaces (AI_GUARDRAILS §1).

## 14. Risks

- **PR #516/#517/#518** (open, awaiting merge) touch Maui surfaces and the measure read model; PR 2
  here will conflict if they land after it. Merge them first.
- The three §4.1 shapes are authored against the artifacts' value sets from the vendored sidecar; if a
  set is capped/absent (ADR-041/053) the corpus-membership test fails loudly — that is the intended
  signal, not a flake.
- A CMS2 Outcome B stalls its flip only; the other four proceed.
