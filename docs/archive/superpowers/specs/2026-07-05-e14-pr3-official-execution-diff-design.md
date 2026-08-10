# E14 PR-3 — Official-subset CMS122 execution outcome diff (design)

Date: 2026-07-05
Status: Approved (brainstorm) — pending spec review
Epic: E14 standards fidelity (#186); depends on ADR-023 (live VSAC value-set resolution, merged PR #242)
Scope owner: Taleef

## 1. Goal

Turn `GET /api/measures/:id/fidelity/diff` from a **criteria-impact estimate** into a **real,
subject-by-subject execution outcome diff** for **CMS122**. Today (PR-2) the diff can only verify the
age gate (synthetic patients have deterministic birth years) and reports every other official criterion
(qualifying visit, hospice, frailty, palliative, LTC) as *"unverifiable — synthetic bundles lack these
resources."* PR-3 executes an **official-subset CMS122 measure** — one that adds the gates WorkWell's
authored measure omits/simplifies, driven by the now-live **VSAC value sets** — against each subject and
diffs the resulting official outcome against WorkWell's authored outcome.

**Descriptive only (ADR-008):** the diff never writes an outcome and never touches any measure's
`Outcome Status`. It is an analysis surface, not a compliance decision.

## 2. Why a "subset", not the literal official CQL

A compile feasibility spike (2026-07-05) proved the **literal official CMS122v14 QICore CQL cannot be
compiled** with the repo's pinned JVM-free translator `@cqframework/cql` 4.0.0-beta.1:

- The real measure is authored `using QICore version '6.0.0'` and chains 8 libraries
  (FHIRHelpers, QICoreCommon, SupplementalDataElements, Status, AdvancedIllnessandFrailty, Hospice,
  PalliativeCare, CumulativeMedicationDuration).
- The beta translator's modelinfo loader **cannot resolve cross-model type references**: any
  `baseType="FHIR.Patient"` / `elementType="FHIR.date"` in the QICore/US Core modelinfo makes the whole
  model fail to load (isolated to a one-attribute minimal repro). Real QICore has 1,300+ `FHIR.*` refs,
  so it cascades to 804 errors / 0 retrieves emitted. A hand-crafted minimal QICore modelinfo *did* load
  and type-check — proving the wiring is correct and the blocker is specifically the real cross-model
  modelinfo.
- Second blocker behind it: the runtime `cql-execution-engine.ts` only links `FHIRHelpers`, not an
  8-library include graph, and uses a plain-FHIR (not QICore-profile) data source.

Neither escape route is bounded effort (wait for a stable `@cqframework/cql` with multi-model modelinfo
loading; or mechanically flatten QICore+USCore+FHIR into one namespace). **Revisit the literal path when
the translator ships a stable multi-model release** — all artifacts + wiring are identified in the spike
record. Until then, the faithful self-contained subset is the tractable, honest deliverable.

The subset is authored `using FHIR '4.0.1'` in the repo's **existing, proven value-set-retrieve style**
(`measures/audiogram_vs.cql` already ships a VSAC-style retrieve variant, cross-mode golden-parity
tested against the inline path). It is documented in-code and in MEASURES.md as a **faithful-but-
simplified transcription**, not the literal CMS artifact.

## 3. Components

### 3.1 Official-subset CQL — `measures/cms122_official.cql` (+ committed ELM)

Authored `using FHIR '4.0.1'`, value-set-retrieve style, one **VSAC OID value-set retrieve** per gate:

| Gate | Population | How | VSAC OID(s) |
|------|-----------|-----|-------------|
| Age 18–75 at MP end | IPP | `Patient.birthDate` arithmetic | — |
| Qualifying visit | IPP | `[Encounter: "Qualifying Visits"]` | the 7 encounter OIDs (Office Visit, AWV, Preventive 18+, Home Health, Telephone, Nutrition) |
| Diabetes diagnosis | IPP | `[Condition: "Diabetes"]` | `2.16.840.1.113883.3.464.1003.103.12.1001` |
| Hospice | DENEX | `[Encounter/Condition: "Hospice"]` | 3 hospice OIDs |
| Advanced illness + frailty (66+) | DENEX | frailty + advanced-illness retrieves + age | 6 OIDs |
| Palliative care | DENEX | palliative retrieves | 3 OIDs |
| Long-term care (66+) | DENEX | housing-status assessment | (direct-reference; may be modeled as a coded Observation) |
| HbA1c > 9% **or missing** | NUMER | most-recent `[Observation: "HbA1c Laboratory Test"]` value > 9, missing counts as NUMER | `2.16.840.1.113883.3.464.1003.198.12.1013` |

The OIDs are exactly those already enumerated in `src/standards/references/cms122v14.ts` and imported by
`pnpm resolve-valuesets`. The library emits population membership (IPP / DENOM / DENEX / NUMER), mapped to
the 5 WorkWell buckets (COMPLIANT / OVERDUE / MISSING_DATA / EXCLUDED / — DUE_SOON n/a) for a like-for-like
compare with WorkWell's authored outcome.

> **GMI numerator alternative** (glucose-management-indicator as an HbA1c substitute) is **out of scope**
> and documented as a remaining gap — same simplification already noted in the CMS122 fidelity report.

### 3.2 VSAC resolution for the diff — imported store rows, not live HTTP

The official-subset execution resolves its OID value sets from the **imported `value_sets` rows**
(`source='VSAC'`, already loaded into prod Neon by `pnpm resolve-valuesets`) via a **store-backed
resolver** — **not** a live VSAC `$expand` at read time. Rationale: (a) closes the loop on the import CLI
(the imported rows are exactly what the diff consumes), (b) offline/robust — no per-request network
dependency or VSAC-uptime coupling on a read path, (c) still exercises the real imported expansions.

Confirmed during design: `StoreValueSetResolver.expand(ref)` already matches a **bare-OID** reference
(`'2.16.840…'`) to the imported row's `oid` column (`v.oid === valueSetUrl || v.canonicalUrl === valueSetUrl`),
so **no resolver change is needed** — the official CQL's `valueset "Diabetes": '2.16.840…'` resolves directly
from the imported row. Because the resolver is store-backed, the diff needs **no VSAC API key at runtime** —
only the imported `value_sets` rows (`source='VSAC'`). The key was only ever needed by the one-time
`pnpm resolve-valuesets` import.

### 3.3 Synthetic enrichment — a diff-harness-local transform (cms122 cohort only)

Enrichment is a **standards-module-local transform** applied to an already-built synthetic bundle inside
the diff harness — **not** a change to the shared `engine/synthetic/fhir-bundle-builder.ts`. This keeps
enrichment entirely out of the live run path: live cms122 runs keep evaluating the un-enriched bundle, so
WorkWell's authored outcomes are structurally untouched (the ADR-008 guarantee holds by construction, not
only by test). The harness builds the normal bundle via `buildSyntheticBundle`, then applies
`enrichForOfficialCms122(bundle, employee, expansions)` which additively adds **real VSAC-member codes
sampled from the imported expansions** so the official gates fire and a deterministic set of subjects
diverges:

- **Encounter** resources coded from the qualifying-visit expansions (most subjects get one; a
  deterministic few get none → age/visit divergence).
- **birthDate** spread so a deterministic handful age out of 18–75 (already deterministic per
  `externalId`; widen the range for the cms122 cohort only if needed).
- **Hospice / frailty / palliative / LTC** Conditions/Encounters for a deterministic handful, coded from
  the respective VSAC expansions → DENEX divergence.
- Diabetes `Condition` and HbA1c `Observation` **dual-coded**: keep the existing `urn:workwell:*` coding,
  **append** a real VSAC-member coding (option-B crosswalk, exactly as E12 PR-2b did for WebChart).

**Additive-only invariant:** WorkWell's `cms122.cql` matches `urn:workwell:*` codes only, so appended
codings and added resources leave **WorkWell's authored outcomes byte-identical**. Guarded by a golden
test (§5). Sampling from the imported expansions is deterministic (stable pick per OID) so the corpus is
reproducible.

### 3.4 Execution diff harness — `standards/outcome-diff.ts`

Add a real-execution path alongside the preserved PR-2 estimate:

1. Resolve the subjects of the **latest cms122 population run** (reuse the existing latest-run lookup;
   provides the cohort + `asOf`).
2. For each subject: build the enriched bundle (§3.3), evaluate the **official-subset ELM** with the
   VSAC store-backed engine (§3.2) → official outcome; evaluate WorkWell's `cms122` ELM → authored
   outcome. **Execute both fresh** against the same enriched bundle (apples-to-apples; the cohort is the
   small diabetes subset).
3. Emit per-subject rows `{subjectId, workwellOutcome, officialOutcome, diverged, divergenceGate}` +
   aggregate `totalDivergent` + per-criterion breakdown (which gate flipped each divergent subject) +
   headline.
4. **Memoize** the whole report per latest-run-id (terminal runs are immutable; roster-cell-cache
   pattern), so repeated Standards-tab loads don't re-execute the cohort.

Bounded, read-path compute: only the diabetes cohort, only on the Standards tab / `/fidelity/diff` GET.

### 3.5 Route + UI

- `/api/measures/:id/fidelity/diff` returns the richer report. **Additive** to PR-2's response shape
  (existing `criterionImpacts` retained; new per-subject execution fields added), so no client breakage.
- The Studio **Standards** tab renders real per-subject divergence (subject, WorkWell outcome, official
  outcome, which gate) instead of the "unverifiable" placeholders, with the disclaimer that this is the
  official-subset transcription.

## 4. Safety / degrade path

- **ADR-008** — enrichment cannot change WorkWell outcomes (golden guard); the diff writes nothing
  (no runs/outcomes/cases/audit rows from the diff itself; reads only).
- **Degrade signal = imported rows present** (not the key). Because resolution is store-backed, the diff
  needs **no VSAC key at runtime** — real execution runs when the official OID value sets resolve non-empty
  from the store (probe a representative OID, e.g. Diabetes). When absent (local dev / CI with no
  `resolve-valuesets` import), the harness **degrades to the PR-2 criteria-impact estimate** — that code
  path is preserved, not deleted. Prod Neon already has the 21 imported OIDs, so it runs the real diff.
- **No schema change, no new dependency.** All read-time; VSAC value sets already imported; enrichment is
  synthetic app data; committed ELM is a build artifact.

## 5. Testing

- **ADR-008 enrichment guard** — golden: WorkWell `cms122` outcomes for the synthetic cohort are
  byte-identical before/after enrichment.
- **Official-subset ELM golden** — hand-built bundles → expected official outcomes across the buckets
  (age-out, no-visit, hospice-excluded, HbA1c>9, missing).
- **Diff correctness** — a known, deterministic set of subjects diverges on the expected gates;
  `totalDivergent` and the per-criterion breakdown match.
- **Degrade path** — unkeyed / unseeded store → the PR-2 estimate report (existing behavior preserved).
- **VSAC store-resolution parity** — the official measure's OID retrieves expand from the imported
  `value_sets` rows (bare-OID match).

## 6. Explicitly out of scope

- Literal multi-library QICore CQL (spike-proven blocked on the pinned translator).
- GMI numerator alternative (documented gap).
- Generalizing the diff beyond CMS122 (only vendored official reference; YAGNI).
- Live VSAC `$expand` on the diff read path (use imported store rows instead).

## 7. File-level change map

- `measures/cms122_official.cql` (new) — auto-compiled by `pnpm compile-measures` into
  `src/engine/cql/elm/DiabetesHbA1cPoorControlOfficialCQL-1.0.0.elm.json` + auto-added to the generated
  `elm/index.ts` (no hand edit; the compiler throws on error-severity, guaranteeing a clean compile).
- `src/engine/cql/cql-execution-engine.ts` — add a backward-compatible `metaOverride?: MeasureMeta` to
  `evaluate()` so the official measure evaluates with an inline meta **without** being added to the
  `MEASURES` registry (which is iterated by seed:scale, quality backfill, segment/order tests — must not
  be polluted). No change to `StoreValueSetResolver` (bare-OID match already works).
- `src/standards/cms122-official.ts` (new) — the official measure's inline `MeasureMeta` (value-set OID
  list + `DiabetesHbA1cPoorControlOfficialCQL-1.0.0` library) + `enrichForOfficialCms122(...)` transform.
- `src/standards/execution-diff.ts` (new, + `.test.ts`) — the real-execution harness (build → enrich →
  evaluate both fresh → diff), memoized per run-id; the route falls back to `outcome-diff.ts`'s PR-2
  estimate when the store lacks the imported OIDs.
- `src/routes/measures.ts` — richer `/fidelity/diff` response: execution diff when imported rows present,
  else the existing PR-2 estimate (additive shape).
- `frontend/…/Standards` tab — render per-subject execution divergence.
- Docs: `MEASURES.md` (subset transcription note), `ARCHITECTURE.md` (standards module), `DATA_MODEL.md`
  (no schema — note the read-time diff), `DECISIONS.md` (ADR entry if non-obvious), `JOURNAL.md`.

## 8. Staging (task order for the plan)

1. **Official-subset CQL + ELM + `metaOverride` engine seam + golden** — author `cms122_official.cql`,
   compile, add the backward-compatible `metaOverride` to `evaluate()`, and prove the official measure
   evaluates against hand-built bundles via a store resolver. De-risks the CQL authoring + engine seam first.
2. **`enrichForOfficialCms122` transform + ADR-008 guard** — the harness-local enrichment; prove WorkWell's
   cms122 outcomes are byte-identical on enriched vs un-enriched bundles.
3. **Execution diff harness** (`execution-diff.ts`) — build → enrich → evaluate both fresh → diff;
   per-subject rows + per-gate attribution; memoized per run-id; diff-correctness test.
4. **Route wiring + degrade fallback** — `/fidelity/diff` runs the execution diff when the imported OIDs
   resolve, else the PR-2 estimate; degrade-path test.
5. **Standards-tab UI** — surface the richer per-subject report.
6. **Docs + verification pass.**
