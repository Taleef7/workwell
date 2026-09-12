# MM-1 U2 — a 20,000-patient deterministic corpus for Maui, with provenance

**Date:** 2026-09-04. **Depends on:** U1 (`2026-09-04-mm1-five-measures-live-design.md`) for the
`SubjectBundleSource` seam, the runnable rule, and the value sets the shapes are stamped from.
**Feeds:** U3 (CMS137 reads the SUD cohort generated here). **Driving ADR:** ADR-070; this unit adds
ADR-073 (corpus determinism + provenance + retention).

## 1. Goal

The Maui profile evaluates a **20,000-patient all-payer primary-care panel** that is generated
deterministically from a seed, spread across five clinics and forty PCPs, free of duplicate identities,
clinically data-first (CQL alone decides every outcome), and traceable three ways: a FHIR `Provenance`
per clinical resource, a manifest with the generator/seed/parameter/artifact hashes and realized counts,
and the per-outcome official evidence U1 already carries. The roster, cases and exports filter by
clinic, PCP, age band and sex. Nightly runs at this size stay bounded in time and in Neon storage.

## 2. Owner decisions (design session)

| # | Decision |
|---|---|
| D1 | All-payer panel, ages 0–95, skewed older than the US average; 5 clinics, ~40 PCPs, panels ≈ 500. |
| D2 | Clinics are Maui place names: Wailuku, Kihei (existing) + Lahaina, Kahului, Pukalani. Providers pseudonymous. |
| D3 | Deterministic from seed, generated on demand; one export command writes NDJSON + Provenance + manifest. No corpus files in the repo. |
| D4 | Data-first with prevalence targets; the MADiE cases remain the correctness oracle. |
| D5 | ~20 % of screenings carry an external-source Provenance agent (HIE / outside lab / referring specialist). |
| D6 | Retention: keep every run's summary; keep full per-subject outcomes 90 days; then compact to the latest per (subject, measure). |

## 3. The generator (`backend-ts/src/engine/synthetic/corpus/`)

**Determinism.** `patientAt(seed, index) → CorpusPatient` is pure. The PRNG is an in-repo
**SplitMix64 only** (no dependency): `streamKey = splitmix64(first 8 bytes of sha256(seed) as a BigInt
XOR BigInt(index))`, and every draw for a patient comes from that patient's own SplitMix64 stream, so
generation order and batch boundaries never change a record. `seed` is a string (default `"maui-py2027-v1"`); the manifest records it and the generator
version constant `CORPUS_GENERATOR_VERSION = "1.0.0"`. Any change to the parameter table or the
drawing logic bumps the version, and a test pins the SHA-256 of the first 100 patients so a silent
drift fails CI.

**Identity and uniqueness.**
- **The first 48 patients are the existing `MAUI_BASE` rows, verbatim** (ids `pat-001..pat-048`, names,
  DOBs, sites) so every fixture, e2e spec and gate that pins them keeps its identities; they move from
  `employee-catalog.ts` into the corpus module as the fixed prefix and `MAUI_BASE` is deleted (one
  source of truth). Generated patients start at index 49 with `externalId = "pat-" + index.toString().padStart(5, "0")`
  (`pat-00049..pat-20000`); the `employee-catalog.maui.test.ts` regex becomes `/^pat-\d{3,5}$/`.
  **What the prefix does not preserve, stated plainly:** the 48's clinical data is generated data-first
  like everyone else's, so the designed outcome buckets (38/7/3 per measure) that
  `deployment-profile.test.ts:72-88`, the e2e roster spec and the Maui gate evidence pin are replaced by
  the deterministic realized values; those pins are re-recorded in the wiring PR (§9 PR 2) and the
  exact new numbers go into the JOURNAL. Files that pin identities or counts and must be migrated:
  `engine/synthetic/employee-catalog.maui.test.ts`, `config/deployment-profile.test.ts`,
  `compliance/case-outreach.test.ts`, `compliance/case-read-models.test.ts`, `export/export-csv.test.ts`,
  `mcp/tools.maui.test.ts`, `hierarchy/hierarchy-rollup.maui.test.ts`,
  `program/program-read-models.live-directory.test.ts`, `routes/compliance-api.maui.test.ts`,
  `routes/employees.maui.test.ts`, `routes/orders.maui.test.ts`, `routes/runs.maui.test.ts`,
  `run/read-models.test.ts`, `run/run-pipeline.test.ts`; frontend `runs/page.tsx` copy and its
  terminology test, `GlobalSearch.test.tsx` fixtures; e2e `maui/roster.spec.ts` (48 totals, the
  "Hypertension" column — which U1 already replaces with the five-measure set — and the name search),
  `compliance.spec.ts`, `jelly-beans.spec.ts`, `measures.spec.ts`.
- Names: given-name pools by birth decade and sex; surname pool weighted to Maui's demographic mix
  (Native Hawaiian, Filipino, Japanese, Portuguese, Anglo families). The pools and their weights are
  in-repo constants in `corpus-parameters.ts` with a one-line composition comment each. A (surname,
  given, DOB) collision with any lower index is re-drawn from the patient's stream at most **16**
  times; on exhaustion the given name gets a deterministic middle initial derived from the stream
  (never a pool re-draw), so uniqueness is guaranteed and the manifest counts both re-draws and
  fallbacks. Enforced by a test over the full 20,000: zero duplicate (name, DOB) pairs.
- `nationalId` is not emitted (the field exists on `EmployeeProfile`; the pilot does not need it).

**Panel structure.** Clinic weights (Wailuku 0.28, Kahului 0.26, Kihei 0.20, Lahaina 0.16, Pukalani 0.10);
8 PCPs per clinic with pseudonymous names (`maui-prov-001..040`, existing four kept as the first four);
PCP assignment within a clinic is weighted so panels range ≈ 350–650, never empty. Age: a mixture with
mass shifted to 50–79 (median ≈ 52); sex 52 % F. The realized per-clinic / per-PCP / per-age-band /
per-sex counts go into the manifest.

**Clinical model, data-first.** Per patient the generator draws, in this order, from one parameter
table (`corpus-parameters.ts`, each row with a one-line source comment):
1. Visits in the measurement year: 1–4 office visits, dated uniformly, at least one before Nov 14.
2. Conditions by age band: diabetes, essential hypertension, bipolar disorder, colorectal cancer, ESRD,
   pregnancy (F 15–49), hospice, frailty + advanced illness (66+), SUD (new episode in year, 13+).
3. Events the six measures read: HbA1c (diabetics: control distribution, 20 % > 9 %), BP readings
   (hypertensives: 62 % controlled on the most recent), PHQ-9 screens (70 % screened; 12 % positive;
   80 % of positives with follow-up), mammograms (F 42–74: 72 % up to date within 27 months),
   colorectal screening (46–75: 65 % up to date, modality mix colonoscopy/FIT/DNA/sigmoidoscopy/CT),
   SUD initiation (45 % within 14 days) and engagement (35 % of initiators), documented exceptions
   at low rates (cms2 refusal/medical reason 1 %).
4. External sourcing: 20 % of screening events (mammogram, colorectal, HbA1c from outside lab) are
   tagged external and get the external Provenance agent (D5).

The CQL result is never pre-computed. The manifest records the **estimated** cohort per measure from
the parameters (IPP, denominator, expected numerator rate) so the first run's realized numbers can be
compared and a wildly-off number is a finding.

**Resources emitted per patient** (QI-Core profiles, dual-stamped codes from U1's expansions): Patient,
Encounters, Conditions, Observations (HbA1c, BP panel with components, PHQ-9 with result), Procedures
(mammogram, colonoscopy etc.), MedicationRequests / Procedures for SUD treatment, ServiceRequests
for follow-up, and one `Provenance` per clinical resource:
```json
{ "resourceType": "Provenance", "id": "<resourceId>-prov", "target": [{ "reference": "Observation/<id>" }],
  "recorded": "<resource date>T12:00:00Z",
  "agent": [
    { "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/provenance-participant-type", "code": "author" }] },
      "who": { "reference": "Practitioner/maui-prov-012" }, "onBehalfOf": { "reference": "Organization/maui-clinic-kahului" } },
    { "type": { "coding": [{ "system": "http://terminology.hl7.org/CodeSystem/provenance-participant-type", "code": "informant" }] },
      "who": { "display": "Outside laboratory (HIE)" } }   // only when external
  ],
  "entity": [{ "role": "source", "what": { "display": "WorkWell synthetic corpus maui-py2027-v1 #1.0.0" } }] }
```
Practitioner and Organization resources for the 40 PCPs and 5 clinics are emitted once in the export
and referenced by id in every bundle. `preparedForQiCore` passes `Provenance` through untouched
(verified: it branches only on Condition/Encounter); fqm ignores resource types no retrieve names.

## 4. Maui wiring

- **Directory.** `corpusDirectory(seed, size)` returns a `SyntheticDirectoryView` whose `EMPLOYEES`
  is the `size` `EmployeeProfile`s (role `"Patient"`, `site` = clinic, `providerId` = PCP,
  `dateOfBirth`), `PROVIDERS` the 40, one tenant `maui`. `composeDeploymentDirectory` uses it when
  `profile.id === "maui"`. **Size and load order (spec-review findings 2/24):** `WORKWELL_MAUI_CORPUS_SIZE`
  defaults to **48** — the fixture prefix — so every unit test and the Maui e2e job get the 48 with no
  env; the Maui deploy and reconcile workflows set **20000** explicitly, and `official-flip-config.test.ts`'s
  MUST_AGREE pair check is extended to this key so the two workflows cannot drift. The directory is
  composed **lazily on first access** through `getDeploymentDirectory()` (memoized), replacing the
  module-load composition, so a child-process test that sets the size before importing sees it and no
  test pays for 20k profiles by accident. The `DirectorySnapshot` shape is unchanged; the eager array of
  20k profiles on the live instance is ~4 MB and is acceptable.
- **Bundle source.** `corpusBundleSource(seed)` implements U1's `SubjectBundleSource`: `bundleFor`
  returns the patient's full bundle regardless of measure; `distribution`/`targetFor` return every
  employee with target `"COMPLIANT"` — the target is unused by the corpus (data-first) and the pipeline
  only threads it through. The composite source picks it on the Maui profile.
- **One bundle per patient per chunk.** The pipeline's measure-major pre-pass builds a subject's bundle
  once per measure today; with a full-record bundle that is 5× redundant. `SubjectBundleSource` gains
  an optional `bundleForSubject(employee, evaluationDate)` used by the pipeline when present. **The
  bundle cache lives exactly one chunk** (§6): built at the start of a chunk, dropped at its end, never
  carried across chunks — that is what bounds memory.

## 5. Filters (`provider`, `clinic`, `ageBand`, `sex`)

Backend: `RosterFilters` gains `providerId?`, `ageBand?` (`"0-17" | "18-44" | "45-64" | "65+"`),
`sex?` (`"F" | "M"`); `site` already means clinic and stays. **Placement (spec-review finding 13):**
every new filter is a **route-level read-time join against the directory, at the same layer `site`
is filtered today** (`roster-read-model.ts` post-filter, the cases route's post-filter, `export-csv.ts`'s
directory join); `CaseQuery` (the store) does **not** change. `CaseExportFilter` gains `providerId`; the
outcomes CSV gains `providerId` and `site` query params. `providerId` matches
`EmployeeProfile.providerId` (the PCP external id, e.g. `maui-prov-012`), never a display name.
`ageBand` is derived from `dateOfBirth` at query time against today's UTC date. `list_noncompliant`
(MCP) gains optional `providerId` with the same semantics. `DATA_MODEL_CONTRACTS.md` §6.3's
"Supports filters" line gains `providerId`; §6.2 has no such line today and gains one listing
`runId, providerId, site`. Frontend: the roster and cases pages read
`providerId`, `ageBand`, `sex` from the URL with the MM-0 chip mechanism; a PCP select is populated
from `/api/providers` (existing directory route or added as a read-only list); the status chips carry
the active filters. Saved per-staff filters remain MM-2.

## 6. Scale in the production run path

Today `planManualRun`/`finishOrFail` evaluate sequentially with a per-measure `evaluateBatch` pre-pass,
and the worker pool exists only on the scale CLI. Changes, all inside `run-pipeline.ts` and behind the
existing deps interface:
- **Chunked measure-major evaluation:** subjects are processed in chunks of `WORKWELL_RUN_CHUNK_SIZE`
  (default 500); for each chunk, bundles are built once (§4) and every routed measure's `evaluateBatch`
  runs over the chunk; outcomes are persisted per chunk via `recordOutcomes`, so memory is bounded by
  one chunk's bundles (≈ 500 × 8 KB) plus the ELM. **Invariants the chunk loop must preserve, each
  pinned by a test (spec-review findings 4/5/23/27):**
  1. **ADR-043 membership is judged over the COMPLETE roster:** `ippByMeasure` accumulates across every
     chunk and `emptyIppMeasures` is evaluated only after the final chunk; a per-chunk empty-IPP check
     is prohibited.
  2. **Idempotent case upsert** on `(subject, measure, period)`: a re-run or a chunk retry never
     duplicates a case (DATA_MODEL_CONTRACTS §4).
  3. **Exactly one terminal `RUN_COMPLETED`** per run: a chunk failure routes to the existing
     `failPlannedRun` path, never to both.
  4. **Cycle rollover runs at run finish only**, never at a chunk boundary.
  5. **`activeCaseKeys` (the EXCLUDED close-only gate) is loaded once per measure before the chunk
     loop** and consulted per chunk, never re-queried.
  6. **Run counters** (`evaluated`, `compliant`, `nonCompliant`, `failures`, `skippedUnchanged`)
     accumulate across chunks into the one `RUN_COMPLETED` payload; `dataFreshAsOf = MAX(evaluated_at)`
     is read by finalize only after the last chunk's outcomes are persisted.
  7. **Chunk transaction and crash semantics:** each chunk commits its outcomes, its case upserts and
     their audit events together where the store supports a transaction (SQLite does; Pg via the
     existing batch path) and one at a time otherwise; a crash mid-run leaves the run `RUNNING` for the
     existing 30-minute recovery sweep to fail, and the next scheduler tick starts a fresh run whose
     upserts are idempotent over the partial outcomes. No resume-from-chunk.
- **Active-case preload** (`listCases({ limit: 100000 })` per measure) becomes a keyed lookup loaded
  once per measure before the chunk loop — same rows, no per-chunk re-read.
- **Worker pool:** not added to the production path in U2. Measured basis: 11–16 ms/subject batched ⇒
  ≈ 25–35 min for 100k evaluations single-threaded, inside the nightly window; the pool is a follow-up
  if a measured run exceeds 45 min. The performance test (§8) pins the ceiling.
- **Scheduler:** the persisted cadence (`runs.started_at` + the min-gap debounce) is unchanged and needs
  no schema, but the mechanism genuinely changes (spec-review finding 16): `computeNextFireAt`
  (`admin/scheduler.ts:125-136`) switches from *last run + 24 h* to *the next wall-clock occurrence of
  `WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC`* (default 12 = 02:00 HST), with the debounce gap enforced as a
  floor. Tests inject `nowMs` and a fake last run, as `scheduler.test.ts` already does, for before-anchor,
  after-anchor and DST-irrelevant (UTC) cases. Documented in DEPLOY.

## 7. Retention (D6) — ADR-073

A compaction pass, `compactOutcomes(stores, { retentionDays, now })`, runs after each scheduler tick —
**after the quality-history snapshot for that run has been written, never before** — and via
`pnpm outcomes:compact`; it is a hard no-op unless `WORKWELL_OUTCOME_RETENTION_DAYS` is set (the Maui
workflows set 90; TWH unset; no unit or integration test sets it except the compaction contract tests).
**Consequences stated (spec-review findings 8/9):** `backfill-trend-history` reads raw outcome history
and cannot reconstruct anything older than the retention window on a compacted store; the snapshot-
before-compact ordering is what makes the quality-over-time surface the durable history, and the
backfill tool refuses to run (with a message naming this policy) when retention is enabled. A run older
than the window keeps its row and summary counts; its outcomes grid and outcomes CSV list only surviving
rows, and the run detail shows a "compacted under the N-day retention policy" notice when the summary
count exceeds the listed rows. For each `(subject_id, measure_id)` it deletes outcome rows with `evaluated_at` older
than the cutoff **except** the newest row per pair and any row referenced by an open case's
`last_run_id`. Runs rows and their summary counts are never deleted. One `OUTCOMES_COMPACTED` audit
event per pass with `{ cutoff, deleted, kept, durationMs }`. Implemented as a store method
(`OutcomeStore.compactOlderThan(cutoffIso, keepRunIds: string[]): Promise<number>`) on both the SQLite
floor and the Pg ceiling with the contract test; it is a DELETE using the existing
`(subject_id, evaluated_at DESC)` index — no schema change, so it is not an owner-only edit, but the
owner reviews the SQL in the PR. Quality-over-time snapshots (aggregates) are untouched and remain the
history surface; the 90-day per-subject window is what the case timeline and CSV exports see.

## 8. Provenance and verification

- **Manifest** (`pnpm corpus:export --seed maui-py2027-v1 --size 20000 --out <dir>` writes
  `manifest.json`), exact keys and types, pinned by a golden fixture test over the 48-patient prefix:
  `generatorVersion: string`, `seed: string`, `size: number`, `parametersSha256: string` (SHA-256 of
  `JSON.stringify(rows)` with keys in declaration order, comments excluded),
  `artifactHashes: Record<catalogId, sha256>` for every vendored measure (six once CMS137 lands),
  `terminologySha256s: Record<catalogId, sha256>` (the sidecar hash per artifact),
  `realized: { byClinic: Record<clinicName, number>, byProvider: Record<providerId, number>,
  byAgeBand: Record<"0-17"|"18-44"|"45-64"|"65+", number>, bySex: Record<"F"|"M", number>,
  conditions: Record<conditionKey, number>, events: Record<eventKey, number>, externalSourced: number,
  redraws: number, nameFallbacks: number }`, `estimatedCohorts: Record<catalogId, { ipp: number,
  denominator: number, expectedRate: number }>`, `ndjsonSha256: Record<resourceType, sha256>`. The export streams NDJSON per
  resource type plus `practitioners.ndjson` / `organizations.ndjson`; memory flat.
- **HAPI load:** `pnpm load:hapi --file <dir>` accepts an export directory (transaction bundles per
  1,000 patients) for demos of the ingest path; optional.
- **Tests:** determinism (same seed ⇒ same SHA over 100 patients; different seed ⇒ different);
  uniqueness over 20,000; distribution tolerances (each clinic within ±2 pp of its weight, each PCP
  panel 350–650, age median 48–56, female 50–54 %); every emitted code is a member of its artifact's
  expansion (extends `corpus-membership.test.ts`); `Provenance.target` resolves to a resource in the same
  bundle for every clinical resource; official executor over the first 500 patients admits > 0 to each
  measure's IPP and each realized rate lands within ±10 pp of the estimate (sidecar-gated);
  **performance:** a full five-measure run over 20,000 patients on the SQLite floor completes in under
  15 minutes in CI — a dedicated `run-scale-maui` job, a sibling of `e2e-maui` in `ci.yml` with
  `timeout-minutes: 30`, gated on the same sidecar/VSAC secrets as `official-cases`, and excluded from
  the default push/PR matrix (`schedule` + `workflow_dispatch` only); compaction
  contract test on both stores; filter tests (roster/cases/export/MCP) per new param; frontend filter
  tests; Maui e2e sees the PCP filter.
- **Docs:** ADR-073, `DATA_MODEL_CONTRACTS.md` (retention is a new contract; CSV columns unchanged,
  new filter params listed in §6.2/6.3), `DEPLOY.md` (Maui env: corpus size, retention days, anchor
  hour), `guide/` chapters (synthetic data, numbers), `MEASURES.md` (cohort estimates), `JOURNAL.md`.

## 9. PR split

1. `feat/maui-corpus-generator` — §3 generator + parameters + export + manifest + tests (+ Practitioner/Organization). Sequenced after U1 PR 1.
2. `feat/maui-corpus-wiring` — §4 directory + bundle source + §6 chunking + performance job + DEPLOY.
3. `feat/maui-filters` — §5 backend then frontend.
4. `feat/outcome-retention` — §7 + ADR-073.

## 10. Out of scope

Provider attribution *semantics* (ACO answer pending, MM-2); saved filters (MM-2); worker pool on the
production path (follow-up on measurement); CMS137 shapes beyond the SUD cohort data (U3); any schema
DDL; WebChart ingest of the corpus (the HAPI load is a demo aid only).

## 11. Risks

- The 15-minute CI ceiling is an estimate from 11–16 ms/subject; if the SQLite floor is slower under
  the runner, the job's threshold is measured on the first run and pinned then, with the number in
  the JOURNAL.
- Neon: 100k outcome rows/night with 90-day retention ≈ 9M rows steady state; if the plan's storage
  tier objects, retention drops to 30 days by env var, no code change.
- Realism parameters are cited estimates, not the pilot's real prevalence; the manifest makes them
  visible so the quality lead can challenge them.
