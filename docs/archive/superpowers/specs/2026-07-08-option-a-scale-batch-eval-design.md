# Option A at scale — batch live-evaluation of a realistic WebChart population (design)

Date: 2026-07-08
Epic: E9 (#78) Option A (FHIR-native) scale story — follows ADR-025 (the `MeasureExecutor` seam)
Status: Draft design — pending owner review
Relates to: ADR-020 (population scale via generated outcomes — this supersedes its *fabricated* path),
ADR-017/ADR-025 (FHIR-native execution), #246 (WebChart dev-DB patterns), `docs/TERMINOLOGY_AUDIT_2026-07-08.md`

## 1. Problem

We committed to **Option A** (FHIR-native: adapt data → FHIR → the CQL engine) as WorkWell's execution
path (ADR-025). Option A's one real weakness is **scale**: E13 PR-2 could not live-evaluate the ~120k `mhn`
tenant (120k × 14 measures ≈ 1.68M CQL evaluations per run is infeasible interactively), so it **fabricated**
the outcomes with a seeded distribution (`backfill-scale.ts`, `statusForIndex`) and reads them via a SQL
`GROUP BY`. That proves the *rollup* scales, but not that *Option A evaluation* scales — the outcomes are
not real.

This design makes Option A genuinely evaluate a large population, reflecting how the system runs in the real
world (batch eCQM evaluation), with **no dependency on MIE's live WebChart API** (we use the dev-DB *patterns*
from #246, not the live transport).

## 2. Decision (owner-approved 2026-07-08)

- **Include a real batch/chunked live-evaluation engine** — reflect real-world eCQM batch operation; performant;
  iterated over time.
- **N-configurable, proven at a tractable N** (e.g. 5–10k, minutes) with 120k as a dial (not forced day one).
- **Replace the fabricated `seed:scale` path (option a):** `mhn` is repointed from fabricated outcomes to a
  real, batch-evaluated, WebChart-realistic population. `mhn` keeps its identity, hierarchy encoding, and
  per-measure runs, so the rollup is untouched.
- Terminology is verified current/active (the audit doc) — the generator stamps verified-active codes.

## 3. Key structural insight (why option a is clean)

`OutcomeStore.aggregateScaleRun(runId)` is a pure `GROUP BY split_part(subject_id,'|',2), split_part(...,'|',3),
status WHERE run_id = $1 AND subject_id LIKE 'mhn|%'` (`outcome-store-postgres.ts:305`). **It never reads
`evidence_json`** — it is entirely content-agnostic. Therefore, if the batch engine writes *real* outcome rows
using the **same `mhn|Lxx|Pxx|n` encoding** (`encodeScaleSubject`, `scale-structure.ts`) and
`triggered_by='seed:scale'`, the whole read path — the hierarchy rollup, programs overview, `?tenant=mhn`,
reconciliation (All = Σ tenants), the `aggregateScaleRun` memo — keeps working **unchanged**. Only the
outcomes' provenance changes: seeded distribution → actual CQL evaluation of a realistic bundle.

## 4. Architecture

Three components above the unchanged engine. All are offline/owner-run (not on the request path or deploy).

### 4.1 The generator — `engine/synthetic/scale/webchart-population.ts`
`generateWebChartSubject(locationIndex, providerIndex, seq): FhirBundle` — deterministic on the subject index
(no randomness; stable across runs, mirroring the existing scale determinism). For each subject it builds a
**WebChart-shaped FHIR bundle** following the #246 dev-DB patterns:
- **Labs/vitals as `Observation`s** with verified-active LOINC codes (`4548-4` HbA1c, `2089-1` LDL, `8480-6`
  systolic, `39156-5` BMI) + realistic numeric values and effective dates.
- **Immunizations** with verified-active CVX (flu/Tdap/Td/MMR/varicella/Hep B — the audit-confirmed active
  sets), for the immunization-panel + flu + adult_immunization measures.
- **A diabetes diagnosis `Condition`** (SNOMED `44054006` / the `urn:workwell:vs:cms122-diabetes` the CQL
  matches) for the diabetic cohort — so `cms122` has a real denominator. (This is generated *clinical* data,
  the legitimate source of the dx — distinct from `stampEnrollment`, which must never fabricate the cms122
  diabetes fact.)
- **Enrollment `Condition`s** for the OSHA/wellness/immunization programs via the existing `stampEnrollment`
  roster path (OH program membership is WorkWell-side, not WebChart clinical data).
- **A realistic outcome spread**: the generator deterministically varies data per subject (lab recency/presence,
  waivers, refusals, series completeness) so the population evaluates to a realistic mix of COMPLIANT / DUE_SOON
  / OVERDUE / MISSING_DATA / EXCLUDED — not a uniform result. The per-provider compliance rates from
  `compliance-rates.ts` are the *target* the variation is tuned to (so the realistic population's aggregate
  is comparable to today's fabricated one).

The bundle is fed through the **real Option-A ingress** — `normalizeWebChartBundle` + terminology
`reconcileCodings` (+ `stampEnrollment`) — so this genuinely exercises the WebChart→FHIR adapter end-to-end,
not a shortcut.

### 4.2 The batch engine — `run/batch-evaluate-scale.ts`
Mirrors the proven `backfill-scale.ts` skeleton, swapping the fabricated status for real evaluation:
- **Subject-major evaluation:** generate each subject's bundle **once**, evaluate it against **all 14 measures**
  (`evaluateBatch` / the `MeasureExecutor` from ADR-025), and fan the 14 outcomes out to the 14 per-measure runs.
  (Measure-major — the current structure — would rebuild each bundle 14×; subject-major builds it once.)
- **Per-measure runs preserved:** create one `RUNNING` `MEASURE` run per runnable measure up front
  (`triggered_by='seed:scale'`), stream subjects writing outcomes to each, then `finalizeRun(COMPLETED)` all —
  so the rollup's "latest COMPLETED run per measure" contract holds.
- **Bounded memory (chunked/streaming):** process subjects in chunks of ~500; per chunk, evaluate and
  `recordOutcomes(batch)` (the existing chunked multi-row insert). Memory is O(chunk), never O(N).
- **Resumable + idempotent:** per-measure idempotency as today (skip measures with an existing COMPLETED
  `seed:scale` run); RUNNING-until-finalize so a crash re-seeds. (Refinement to explore in the plan:
  chunk-level resume within a measure for very large N.)
- **Audited:** one `SCALE_POPULATION_EVALUATED` audit event per run (analogue of `SCALE_POPULATION_SEEDED`).
- **N-configurable:** `--subjects` (default a tractable proof N, e.g. 5000).
- **Concurrency — sequential-chunked first.** Simple, bounded, correct, and lets us actually profile per-eval
  cost. `worker_threads` parallelism is a documented follow-up optimization (the engine is stateless per
  subject, so it parallelizes cleanly later). This matches "build it right, keep improving it."

### 4.3 Integration / retire the fabricated path
- The new CLI **`pnpm evaluate:scale`** (or repoint `seed:scale`) replaces `backfillScalePopulation`.
  `backfill-scale.ts`'s fabricated `statusForIndex` path is retired (kept in git history; ADR-020's rollback
  SQL still applies — same `triggered_by='seed:scale'` tag).
- **Rollup untouched** (§3). The `aggregateScaleRun` memo, hierarchy, programs, roster-exclusion, and
  reconciliation all keep working over the real rows.

## 5. Evidence / storage policy

Real evaluation produces real `evidence_json` (~1–3 KB/outcome). At the proof N (5–10k → tens–hundreds of MB)
we store **full** evidence. For a true 120k run (~1.68M rows, GB-scale) we apply an **evidence-trim policy**:
full evidence for a small deterministic sample (e.g. 1%), minimal `{scale:true}` for the rest — bounding Neon
storage under the <$25/mo target. N being a dial means we never store more than we choose. (The exact trim
knob is a plan detail; the rollup needs only `status`, not evidence, so trimming is safe for aggregation.)

## 6. Verification / testing

- **Parity:** a batch-evaluated subject's outcome equals a direct `evaluateBundle` of the same generated bundle
  (the batch engine adds no evaluation semantics — it orchestrates).
- **Ingress-real:** generated bundles carry *real* codes and only evaluate correctly *through* the terminology
  crosswalk (a control bundle without reconciliation reads MISSING_DATA) — proving Option A is genuinely exercised.
- **Reconciliation guard:** All = Σ tenants (and mhn = Σ locations = Σ providers) still holds after repoint.
- **Bounded memory:** a test asserting peak resident set / that the engine never materializes all N (chunk
  boundary honored).
- **Resume/idempotency:** re-running skips COMPLETED measures; a simulated mid-run crash re-seeds cleanly.
- **Outcome spread:** the generated population yields a realistic multi-bucket distribution (not uniform).

## 7. Staging (one spec → phased plan)

1. **Generator** — `generateWebChartSubject` + realistic-spread variation, unit-tested to produce each outcome
   bucket, evaluated through the real ingress.
2. **Batch engine** — subject-major, chunked, resumable, audited; sequential-chunked concurrency; parity +
   bounded-memory tests.
3. **Repoint + retire** — `evaluate:scale` CLI replaces the fabricated `seed:scale`; verify the rollup/hierarchy
   read paths unchanged; reconciliation guard.
4. **Prove at a tractable N** — run locally at N=5–10k, profile per-eval cost, confirm the outcome spread and
   reconciliation; document the 120k dial + evidence-trim policy.

## 8. Non-goals / out of scope

- Live WebChart HTTP transport (E12 PR-2c — still blocked on MIE's API contract). This uses dev-DB *patterns*.
- `worker_threads` parallelism (documented follow-up; sequential-chunked ships first).
- Incremental/delta evaluation (re-evaluate only changed subjects) — a later optimization once the batch path exists.
- Option B (CQL→SQL) — the separate research epic (ADR-025).

## 9. Constraints honored

- **No schema change** (reuses `runs`/`outcomes` + the `mhn|Lxx|Pxx|n` encoding; owner-gated DDL rule respected).
- **No new dependencies.**
- **Descriptive/authoritative (ADR-008):** outcomes come from the CQL engine; nothing else sets `Outcome Status`.
- **Every state change audited** (`SCALE_POPULATION_EVALUATED`).
- **Reversible** (same `triggered_by='seed:scale'` rollback SQL as ADR-020).
- **Offline/owner-run** — not on the request path or deploy (like `seed:scale`/`seed:quality-history`).

## 10. Open questions for the plan

- Exact chunk size + whether to add chunk-level (intra-measure) resume for very large N.
- The evidence-trim sample rate for a real 120k run.
- Whether to keep the CLI name `seed:scale` (least churn) or introduce `evaluate:scale` (clearer intent) with
  `seed:scale` as a deprecated alias.
