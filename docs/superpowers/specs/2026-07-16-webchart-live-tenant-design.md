# Live WebChart Tenant — Design Spec

**Date:** 2026-07-16 · **Status:** Draft — pending owner review · **Executes:** the visualization
half of #262 (E12 finale) · **Depends on:** wave PRs 2–4 (HAPI simulator, live CLI, teatea runbook)

## Goal

When the `webchart` seam is configured (`WORKWELL_WEBCHART_*`), the app gains a **live tenant** —
`wc` / "WebChart (teatea)" — whose subjects are the real patients on the configured WebChart FHIR
endpoint. Population runs fetch their bundles live, evaluate them through the unchanged CQL engine,
persist audited outcomes, and the existing dashboards (`/compliance` roster, `/programs`,
`/programs/hierarchy`, quality-over-time) render them with **no frontend changes** (the System
selector reads `/api/tenants`; roster rows come from the directory). Seam unset ⇒ byte-identical
app; the demo stack stays unconfigured (**no PHI ever** — teatea holds synthetic patients only).

## Model decision: directory-injection (not the mhn aggregate model)

Verified pipeline facts that force the choice (2026-07-16 exploration):

- The roster **iterates the directory** (`EMPLOYEES.map(...)` in `roster-read-model.ts`) — a
  subject existing only as outcome rows never gets a roster row (that is why the `mhn` scale tenant
  is roster-excluded by design).
- Hierarchy/programs resolve subjects via `employeeById(subjectId)` and **skip unknowns**.
- The run pipeline's per-subject loop (`finishManualRun`, `run-pipeline.ts`) already `await`s the
  engine per item — feeding an async-fetched bundle is a **bundle-source swap**, not a rewrite.
- Population outcomes record `item.employee.externalId` as `subjectId` (the engine's bundle-derived
  id is discarded on this path) — so live subjects must exist as `EmployeeProfile`s whose
  `externalId` equals the id we record.

Therefore: live patients are injected as **directory subjects** under a new tenant, and the mhn
aggregate path is left untouched.

## Design

### 1. Identity & tenant modeling

- **Subject id:** `wc|{Patient.id}` (e.g. `wc|WW-0001-…`). The prefix prevents collision with
  `twh`/`ihn` externalIds and makes live subjects greppable (mirrors the `mhn|…` encoding
  precedent). Recorded on outcomes/cases; the directory `externalId` is identical.
- **Tenant:** `wc` / display "WebChart (teatea)" — name suffix from the configured host, e.g.
  `WebChart (teatea.webchartnow.com)`, so a HAPI-pointed dev run reads `WebChart (localhost:8081)`.
  One enterprise (`WebChart`), **one location** (`site: "WebChart"`), **one provider**
  (`wc-provider-1`, "WebChart Clinician") in v1 — hierarchy placement is flat until real
  provider/location attribution lands (B10, unanswered).
- **Profile fields:** `name` from `Patient.name[0]` (given + family), `dateOfBirth` from
  `Patient.birthDate`, `role: "employee"`. No nationalId (E15 identity linking is explicitly out of
  scope — #187 PR-3 follow-up).
- `/api/tenants` (`routes/tenants.ts`) returns `TENANTS` + the `wc` tenant **only when the seam is
  configured**; `tenantById`/`enterpriseForTenant` learn the `wc` entries the same conditional way.
  The static `TENANTS` array is unchanged.

### 2. The live directory (new module: `engine/ingress/webchart/live-directory.ts`)

A per-worker, in-memory **last-known-good registry** of live `EmployeeProfile`s:

- `refreshLiveDirectory(env, client?)` — fetches the population via the existing
  `httpWebChartClient` (payloads → Patient extraction, reusing the live-CLI's tolerant
  `patientOf`), maps to profiles, swaps the registry atomically. Called (a) by every population
  run that includes the live tenant (the run's fetch doubles as the refresh — no second fetch),
  and (b) lazily by read models when the registry is empty/stale (TTL ~10 min, single-flight,
  2s-bounded; on failure keep last-known-good).
- **Restart rehydration (no schema):** when the registry is empty (fresh worker) the read models
  fall back to deriving **minimal profiles** (`name = patient id`, flat placement) from the latest
  population run's `wc|`-prefixed outcome `subjectId`s — so roster/hierarchy rows survive a
  container restart; full names return on the next refresh. This keeps the feature schema-free.
- Read models consume a merged view: `directoryFor(env)` → `{ employees, byId }` = static
  `EMPLOYEES` + live registry. `roster-read-model.ts`, `hierarchy-rollup.ts`,
  `program-read-models.ts` (tenant/site matchers), and `case-detail-read-model.ts` name resolution
  switch from the static imports to the merged view — a mechanical, behavior-preserving change
  when the seam is off (merged view === static directory).

### 3. Run pipeline integration (`run-pipeline.ts`)

- `planManualRun`: when the seam is configured and scope is **ALL_PROGRAMS or MEASURE**, fetch the
  live payloads **once** (`webChartDataSource(cfg).loadBundles()` — normalize/crosswalk applied),
  refresh the live directory from them, and append live `WorkItem`s: one per (live subject ×
  runnable measure), carrying the prefetched bundle (`WorkItem` gains optional
  `liveBundle?: unknown`; `target` is absent for live items — live outcomes are whatever CQL says,
  never seeded). `requestedScope` gains `{ liveTenant: { count, host } }` for observability.
- `finishManualRun` loop: `item.liveBundle` present → `stampEnrollment(bundle, measureId, roster)`
  → `deps.engine.evaluate({ measureId, patientBundle })`; else the synthetic path, unchanged
  byte-for-byte. Outcome recorded with `subjectId = item.employee.externalId` (`wc|…`) — evidence,
  case upsert, cycle rollover, audit events, quality snapshots all flow through the existing code
  with zero special-casing.
- **Failure posture:** a population-fetch failure at plan time logs a run WARN + emits the #264
  alert line and **skips the live tenant** (synthetic tenants evaluate normally; the run never
  fails because teatea is down). Per-patient degradation is already the client's contract
  (Patient-only bundle → MISSING_DATA).
- **Scopes deferred to phase 2:** EMPLOYEE/CASE scope for `wc|` subjects (rerun-to-verify against
  a re-fetched single patient — needs a fetch-one-patient client method). V1: rerun-to-verify on a
  live subject's case re-uses the last fetched bundle if present, else records MISSING_DATA with
  an explanatory evidence note. SITE scope: the `wc` site behaves like any site (matcher works).

### 4. Enrollment roster for app runs

The CLI takes `--roster <file>`; the worker has no filesystem. V1 policy, in order:

1. `WORKWELL_WEBCHART_ENROLLMENT_JSON` env var (the same `{subjectId: [measureIds]}` JSON, raw
   patient ids) — explicit control when set.
2. **Default: enroll-all** — every live subject is enrolled in every `ROSTER_ELIGIBLE_MEASURES`
   member (the fail-closed allowlist in `roster.ts` — cms122 correctly stays diagnosis-gated, and
   cms125's visit stamp only applies to enrolled subjects). Right default for a demo tenant: the
   measures' own clinical gates (age/sex/diagnosis/visit) still decide the population.

The B9 answer ("where does OH enrollment live in production?") replaces this policy later; the
seam is exactly `stampEnrollment`, unchanged.

### 5. Segments interaction (documented behavior, no code change)

Case creation stays applicability-gated. With enabled segments whose cohorts name only `twh`/`ihn`
sites, live subjects (site `WebChart`) match no cohort → outcomes persist, **cases are not
created** (the existing COMPLIANT/EXCLUDED close-only bypasses still apply). On a fresh local DB
the segment seed derives the All-Employees site list from the directory at seed time (which won't
include the live site yet) — so the runbook documents the one-click fix: edit **All Employees** in
`/admin → Groups` to add the `WebChart` site (audited `SEGMENT_UPDATED`, the E13 precedent). This
keeps ADR-016 intact and needs no seed changes.

### 6. Inert-unless-configured + observability

- Selection predicate: the existing `isWebChartConfigured(env)` — no new seam, the boot inventory
  line's `webchart=on|off` already covers it. Seam off ⇒ `directoryFor` returns the static
  directory, `/api/tenants` returns the static list, `planManualRun` plans no live items:
  **byte-identical**.
- One boot-adjacent log line when on: `webchart live tenant: enabled (host …)`. Run logs carry the
  fetch (count, duration, degraded-patient count). No new audit event types — `RUN_COMPLETED` +
  `requestedScope.liveTenant` carry the provenance.

### 7. What stays OUT (follow-ups, not this feature)

- E15 identity linking of `wc|` subjects to `twh`/`ihn` people (#187 PR-3).
- Delta/incremental evaluation (#263 — content-hash design, owner-gated DDL).
- Real provider/location attribution inside the live tenant (needs B10).
- `Group/$export` bulk ingestion (the per-resource composition path is the verified contract).
- Any schema: v1 is deliberately schema-free (in-memory registry + outcome-row rehydration).

## Implementation slicing (PR 6, reviewable halves)

- **PR 6a — backend core:** `live-directory.ts` + `directoryFor` merge + run-pipeline live items +
  tenants route conditional + enrollment policy. Tests: run-pipeline with `fixtureWebChartClient`
  (live items evaluated, `wc|` outcomes recorded, failure-skip posture, seam-off byte-identity),
  live-directory rehydration from outcome rows.
- **PR 6b — read models + e2e:** roster/hierarchy/programs/case-detail on the merged directory;
  self-skipping HAPI live test (app-level: run → roster rows + hierarchy tenant present);
  docs (ARCHITECTURE §3/§7, DEPLOY env, MEASURES note, JOURNAL) + ADR-033.

## Verification

- Unit: full suite green; seam-off paths byte-identical (existing tests are the guard).
- Local e2e: HAPI loaded (`pnpm load:hapi`) → backend `pnpm dev` with
  `WORKWELL_WEBCHART_BASE_URL=http://localhost:8081` + `WORKWELL_WEBCHART_API_KEY=local-dev` →
  frontend `npm run dev` → trigger ALL_PROGRAMS → **"WebChart (localhost:8081)" appears in the
  System selector; 56 `wc|` rows on `/compliance`; the tenant node on `/programs/hierarchy`
  reconciles (All = Σ tenants)**.
- Real-life demo: same with the teatea env (after runbook §§1–4) — live WebChart patients
  visualized in the WorkWell dashboards.

## Hard-rule compliance

Descriptive only (ADR-008): adapters feed data; CQL alone sets `Outcome Status`. Every state
change already audited by the unchanged pipeline. No new deps, no schema, no microservices.
Reconciliation (All = Σ tenants) holds — live subjects belong to exactly one tenant. Reversible:
unset the env vars (outcomes remain as historical runs, like any tenant's).
