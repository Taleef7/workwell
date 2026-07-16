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

A per-worker, in-memory **last-known-good registry** of live `EmployeeProfile`s. It is a directory
cache, not a clinical-data cache: stale bundles must never be presented as a fresh case verification.

- `replaceLiveDirectory(bundles)` extracts Patients from an already-fetched population, maps them to
  profiles, and atomically swaps the registry. A population run performs the HTTP fetch once in its
  background preparation step (§3); the same normalized bundles feed both this refresh and CQL.
- **Restart rehydration (no schema):** each read model already loads the latest population outcome
  rows. Its merged-directory snapshot is static `EMPLOYEES` + the registry + minimal profiles for
  unknown `wc|` subject ids in those rows (`name = raw Patient.id`, flat `wc` placement). This is an
  explicit `directoryForRows(rows)` input, not a hidden database read from a synchronous lookup.
  Roster/hierarchy rows therefore survive a restart or WebChart outage; full names return after the
  next successful population run. When the seam is configured, a `profileForId("wc|...")` fallback
  provides the same minimal identity to case detail; seam-off lookup remains the static behavior.
- `roster-read-model.ts`, `hierarchy-rollup.ts`, `program-read-models.ts` (tenant/site matchers),
  `case-detail-read-model.ts`, and `quality/materialize-run.ts` consume one injected directory
  snapshot (`employees`, employee/provider/tenant lookups). With the seam off and no `wc|` rows, that
  snapshot is byte-identical to the static catalog.

### 3. Run pipeline integration (`run-pipeline.ts` + `routes/runs.ts`)

- `planManualRun` remains network-free. It creates the run and static work items, and attaches a
  small live-population descriptor for configured **ALL_PROGRAMS or MEASURE** requests. This is
  required by `routes/runs.ts::scheduleAsyncRun`, which awaits planning before registering
  `finishOrFail(...)` with `waitUntil`; putting the population fetch in the planner would move all
  WebChart pagination and per-patient composition onto the foreground HTTP request.
- `scheduleAsyncRun` treats a configured MEASURE population run like ALL_PROGRAMS and returns the
  RUNNING response before any remote fetch. (Without `waitUntil`, the existing synchronous fallback
  remains valid for tests/local tools, but production has the background lifetime.) The initial
  response reports the known static count and says that the live count is pending; run logs and the
  terminal audit payload carry host, fetched count, degraded count, and duration.
- At the start of `finishManualRun`, the background preparation step fetches normalized bundles once,
  refreshes the live directory, and appends live `WorkItem`s: one per applicable (live subject ×
  measure), with `liveBundle?: unknown` and no synthetic target. The loop uses
  `stampEnrollment(bundle, measureId, roster)` then the unchanged engine; only CQL supplies the
  outcome. Synthetic items keep the existing byte-for-byte builder path.
- **Failure posture / last-known-good:** when the seam is configured, failure to fetch the live
  population aborts the population run *before any outcomes are recorded*. `finishOrFail` records
  the failure audit/log/alert and finalizes the run FAILED. Read models ignore FAILED runs, so the
  prior successful run remains authoritative for both synthetic and live subjects. A
  synthetic-only COMPLETED/PARTIAL_FAILURE run is forbidden here because latest-run-per-measure is
  selected as a whole; such a run would otherwise erase all `wc|` rows. Per-patient degradation after
  a successful population fetch retains the existing Patient-only → MISSING_DATA behavior.
- Quality materialization receives the same merged directory snapshot used for the run.
  `quality/materialize-run.ts::resolveScope` must use the injected employee/provider lookups, not the
  static `employeeById`/`providerById`; otherwise all `wc|` rows are silently omitted from the all,
  tenant, site, and provider snapshots.
- **Scopes deferred to phase 2:** EMPLOYEE and CASE require fetch-one-patient support. Until then,
  `case-rerun.ts`/its route reject rerun-to-verify for `wc|` cases with a controlled non-mutating 409;
  they never reuse a stale bundle and never write a fabricated MISSING_DATA result. SITE is also
  explicitly deferred: the current latest-run reducer treats SITE as a population run even though it
  is a partial slice, so enabling a `WebChart` SITE run would supersede other tenants' rows. A
  configured `SITE=WebChart` request returns a controlled unsupported-scope response until that
  general SITE/latest-run contract is corrected.

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
keeps ADR-016 intact and needs no seed changes. If that enables live case creation, the CASE
rerun-to-verify action remains the explicit non-mutating 409 described in §3 until phase 2.

### 6. Inert-unless-configured + observability

- Selection predicate: the existing `isWebChartConfigured(env)` — no new seam, the boot inventory
  line's `webchart=on|off` already covers it. Seam off ⇒ `directoryForRows` returns the static
  directory, `/api/tenants` returns the static list, `planManualRun` plans no live items:
  **byte-identical**.
- One boot-adjacent log line when on: `webchart live tenant: enabled (host …)`. Run logs carry the
  fetch (count, duration, degraded-patient count). The existing terminal `RUN_COMPLETED` audit
  convention gains the same `liveTenant` payload (including `status: FAILED` on preparation failure);
  the fetch count is not put in `requestedScope`, which is persisted before background preparation.

### 7. What stays OUT (follow-ups, not this feature)

- E15 identity linking of `wc|` subjects to `twh`/`ihn` people (#187 PR-3).
- Delta/incremental evaluation (#263 — content-hash design, owner-gated DDL).
- Real provider/location attribution inside the live tenant (needs B10).
- `Group/$export` bulk ingestion (the per-resource composition path is the verified contract).
- Any schema: v1 is deliberately schema-free (in-memory registry + outcome-row rehydration).

## Implementation slicing (PR 6, reviewable halves)

- **PR 6a — backend core:** `live-directory.ts` + injected directory snapshot + network-free planning
  + background live preparation + tenants route conditional + enrollment policy. Tests cover the
  foreground-response boundary, live items and `wc|` outcomes, atomic directory refresh, fetch
  failure producing a FAILED run with zero new outcomes (prior population stays latest), configured
  MEASURE background scheduling, SITE rejection, and seam-off byte identity.
- **PR 6b — read models + safety/e2e:** roster/hierarchy/programs/case-detail and
  `quality/materialize-run.ts` use the same merged directory; minimal-profile rehydration from latest
  outcome rows; `case-rerun.ts` returns a non-mutating unsupported result for `wc|`; app-level
  self-skipping HAPI test proves run → roster/hierarchy/quality snapshot visibility plus restart-style
  minimal names. Docs: ARCHITECTURE §3/§7, DEPLOY env, MEASURES note, JOURNAL, ADR-033.

## Verification

- Unit: full suite green; seam-off paths byte-identical; a blocked WebChart fetch does not delay the
  201 RUNNING response; a failed fetch writes zero outcomes and does not supersede prior live rows;
  quality snapshot totals include `wc`; CASE/SITE deferrals make no state change.
- Local e2e: HAPI loaded (`pnpm load:hapi`) → backend `pnpm dev` with
  `WORKWELL_WEBCHART_BASE_URL=http://localhost:8081` + `WORKWELL_WEBCHART_API_KEY=local-dev` →
  frontend `npm run dev` → trigger ALL_PROGRAMS → **"WebChart (localhost:8081)" appears in the
  System selector; 56 `wc|` rows on `/compliance`; the tenant node on `/programs/hierarchy`
  reconciles (All = Σ tenants)**.
- Real-life demo: same with the teatea env (after runbook §§1–4) — live WebChart patients
  visualized in the WorkWell dashboards.

## Hard-rule compliance

Descriptive only (ADR-008): adapters feed data; CQL alone sets `Outcome Status`. Successful state
changes use the existing run/case/snapshot audit paths; the preparation-failure path writes its
terminal run audit before finalizing FAILED. No new deps, no schema, no microservices.
Reconciliation (All = Σ tenants) holds — live subjects belong to exactly one tenant. Reversible:
unset the env vars (outcomes remain in history but the `wc` tenant is no longer rendered).
