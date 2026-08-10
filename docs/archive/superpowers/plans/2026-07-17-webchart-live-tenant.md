# Live WebChart Tenant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inert-unless-configured, production-faithful `wc` WebChart tenant whose live FHIR population is evaluated through the existing CQL pipeline and appears in existing read models.

**Architecture:** `planManualRun` remains network-free and records a live-population descriptor only when `isWebChartConfigured(env)` selects the existing seam. `finishManualRun` performs one background load through `webChartDataSource(cfg, httpWebChartClient(cfg, { pageSize }))`, atomically refreshes a directory registry, appends live work items, stamps roster enrollment, and then uses the unchanged engine. Read models receive one merged directory snapshot built from static employees, the last-known-good registry, and minimal `wc|` profiles rehydrated from latest outcome rows.

**Tech Stack:** TypeScript, Node test runner, `@mieweb/cloud` worker, existing FHIR/CQL ingress modules, SQLite floor/Postgres ceiling stores, Next.js frontend verification only.

## Global Constraints

- ADR-008: CQL is the sole compliance authority; adapters only feed data and never set Outcome Status.
- No new dependencies; use global fetch, WebCrypto, and existing modules only.
- No schema or DDL changes. V1 state is per-worker memory plus rehydration from existing outcome rows.
- No PHI and no tests against teatea. HAPI is reached only through `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL`.
- Selection is always `isWebChartConfigured(env)` and transport is always `webChartDataSource(cfg, httpWebChartClient(cfg, { pageSize }))` using `webChartConfigFromEnv(env)`.
- Seam unset must preserve byte-identical behavior, guarded by tests.
- Configured population-fetch failure records zero outcomes for the new run, finalizes FAILED, emits log/audit/alert metadata, and leaves the prior successful population authoritative.
- The branch contains exactly two logical commits: PR 6a backend core, then PR 6b read models/safety/e2e/docs.
- Do not edit `backend-ts/src/stores/postgres/schema-pg.ts` or `backend-ts/src/stores/sqlite/schema.ts`.

---

### Task 1: PR 6a — backend core, scheduling, and failure safety

**Files:**
- Create: `backend-ts/src/engine/ingress/webchart/live-directory.ts`
- Create: `backend-ts/src/engine/ingress/webchart/live-directory.test.ts`
- Modify: `backend-ts/src/engine/synthetic/employee-catalog.ts`
- Modify: `backend-ts/src/engine/synthetic/employee-catalog.test.ts`
- Modify: `backend-ts/src/engine/ingress/enrollment/roster.ts`
- Modify: `backend-ts/src/run/run-pipeline.ts`
- Modify: `backend-ts/src/run/run-pipeline.test.ts`
- Modify: `backend-ts/src/routes/runs.ts`
- Modify: `backend-ts/src/routes/runs.test.ts`
- Modify: `backend-ts/src/routes/tenants.ts`
- Modify: `backend-ts/src/routes/tenants.test.ts`
- Modify: `backend-ts/src/worker.ts`
- Modify: `docs/superpowers/plans/2026-07-17-webchart-live-tenant.md`

**Interfaces:**
- `replaceLiveDirectory(bundles: readonly unknown[]): readonly EmployeeProfile[]` atomically replaces full live profiles extracted from normalized Patient resources.
- `directoryForRows(rows: readonly { subjectId: string }[]): DirectorySnapshot` returns `{ employees, employeeById, providerById, tenantById, enterpriseForTenant }` without mutating static catalogs.
- `profileForId(externalId: string): EmployeeProfile | null` returns a full cached profile or a minimal `wc|` fallback.
- `webChartTenant(env: DataSourceEnv): Tenant | null`, `tenantById(id, env?)`, and `enterpriseForTenant(id, env?)` expose `wc` only when the existing seam is configured; `TENANTS` remains unchanged.
- `PlannedRun.livePopulation?` carries configuration/enrollment metadata only; it never carries fetched bundles.
- `WorkItem.target` becomes optional and `WorkItem.liveBundle?` identifies the live path; the synthetic path continues calling `deriveExamConfig` and `buildSyntheticBundle` exactly as before.

- [x] **Step 1: Write failing live-directory and conditional-tenant tests**

  Cover Patient name/DOB mapping, `wc|` ids, atomic replacement, minimal-row fallback, static-array identity when seam is off, conditional tenant lookup, and host-derived display names.

- [x] **Step 2: Run the focused tests and confirm RED**

  Run: `corepack pnpm test -- src/engine/ingress/webchart/live-directory.test.ts src/engine/synthetic/employee-catalog.test.ts src/routes/tenants.test.ts`

  Expected: failure because live-directory exports and conditional route/catalog behavior do not exist.

- [x] **Step 3: Implement the directory registry and conditional tenant model**

  Parse only the first Patient in each normalized bundle; format `given.join(" ") + family`, preserve `birthDate`, set fixed placement (`role:"employee"`, `site:"WebChart"`, `providerId:"wc-provider-1"`, `tenantId:"wc"`), construct the replacement array before one assignment, and derive the route display suffix from `new URL(cfg.baseUrl).host`.

- [x] **Step 4: Run focused tests and confirm GREEN**

  Run the Step 2 command and require zero failures.

- [x] **Step 5: Write failing pipeline/route tests**

  Cover: network-free planning; configured MEASURE uses `waitUntil`; a blocked fetch does not delay the 201 response; live bundles produce `wc|` outcomes through the real engine path; explicit enrollment JSON and default enroll-all; configured `SITE=WebChart` returns controlled unsupported scope; prep failure finalizes FAILED before any outcome, writes failure metadata, and does not supersede prior completed population rows; seam-off response/outcomes remain deep-equal to the pre-feature path.

- [x] **Step 6: Run focused pipeline tests and confirm RED**

  Run: `corepack pnpm test -- src/run/run-pipeline.test.ts src/routes/runs.test.ts`

  Expected: new assertions fail because no live descriptor/preparation path exists and configured MEASURE is still synchronous.

- [x] **Step 7: Implement background live preparation**

  Add the WebChart env to `RunPipelineDeps`; make planning attach a descriptor only for configured ALL_PROGRAMS/MEASURE; have route scheduling treat that descriptor as async; in `finishManualRun`, load normalized bundles exactly once with the verified client/source path, refresh the directory, create one live item for each Patient × applicable requested measure, stamp enrollment using explicit JSON or default roster, and evaluate the stamped bundle through `deps.engine`. Catch prep failure before the active-case read or outcome loop, attach `liveTenant` host/count/duration/status metadata to logs and terminal audit, then let `finishOrFail` finalize FAILED and alert. Never put dynamic fetch counts in `requestedScope`.

- [x] **Step 8: Run focused pipeline tests and confirm GREEN**

  Run the Step 6 command and require zero failures.

- [x] **Step 9: Verify 6a and commit**

  Run: `corepack pnpm typecheck`

  Run: `corepack pnpm test -- src/engine/ingress/webchart/live-directory.test.ts src/engine/synthetic/employee-catalog.test.ts src/routes/tenants.test.ts src/run/run-pipeline.test.ts src/routes/runs.test.ts`

  Commit: `feat(webchart): add live tenant run pipeline`

---

### Task 2: PR 6b — injected read models, safety deferrals, HAPI e2e, and docs

**Files:**
- Modify: `backend-ts/src/compliance/roster-read-model.ts`
- Modify: `backend-ts/src/compliance/roster-read-model.test.ts`
- Modify: `backend-ts/src/program/hierarchy-rollup.ts`
- Modify: `backend-ts/src/program/hierarchy-rollup.test.ts`
- Modify: `backend-ts/src/program/program-read-models.ts`
- Modify/add focused tests for `program-read-models.ts`
- Modify: `backend-ts/src/case/case-detail-read-model.ts`
- Modify: `backend-ts/src/case/case-detail-read-model.test.ts`
- Modify: `backend-ts/src/case/case-rerun.ts`
- Modify: `backend-ts/src/routes/runs.ts`
- Modify: `backend-ts/src/routes/runs.test.ts`
- Modify: `backend-ts/src/quality/materialize-run.ts`
- Modify: `backend-ts/src/quality/materialize-run.test.ts`
- Create: `backend-ts/src/engine/ingress/webchart/hapi-app-live.test.ts`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOY.md`
- Modify: `docs/MEASURES.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/JOURNAL.md`

**Interfaces:**
- Each population read path obtains latest rows first, calls `directoryForRows(rows)` once, and threads that single snapshot through all employee/provider/tenant resolution for the request/materialization.
- `materializeRun` builds its snapshot from the run outcomes and passes injected lookup closures into `resolveScope`; static `employeeById`/`providerById` are not used for live rows.
- `rerunToVerify` returns/throws a typed unsupported result for `wc|` before any run, outcome, case, or audit mutation; the route maps it to HTTP 409.

- [x] **Step 1: Write failing read-model rehydration tests**

  Seed completed latest outcome rows whose subjects are unknown `wc|...` ids, clear/replace the live registry to simulate restart, then assert roster rows, hierarchy `wc` tenant reconciliation (`All = sum tenants`), programs/site filters, case detail identity, and quality all/tenant/site/provider snapshots retain those rows with minimal raw Patient-id names.

- [x] **Step 2: Run focused read-model tests and confirm RED**

  Run: `corepack pnpm test -- src/compliance/roster-read-model.test.ts src/program/hierarchy-rollup.test.ts src/case/case-detail-read-model.test.ts src/quality/materialize-run.test.ts`

- [x] **Step 3: Inject one merged directory snapshot through every read path**

  Replace static lookups only inside the request/materialization paths named by the design; preserve default static arguments for unrelated callers and seam-off identity. Ensure quality scope uses the snapshot provider lookup and tenant mapping.

- [x] **Step 4: Run Step 2 tests and confirm GREEN**

- [x] **Step 5: Write failing `wc|` rerun safety tests**

  Assert direct case rerun and `/api/runs/:id/rerun` both return the controlled unsupported result/409 and that run, outcome, case, and audit counts are unchanged.

- [x] **Step 6: Implement the non-mutating 409 deferral and confirm GREEN**

  Detect `wc|` before bundle construction or store mutation; keep synthetic reruns byte-identical.

- [x] **Step 7: Add the self-skipping app-level HAPI test**

  Mirror `hapi-live.test.ts`: gate only on `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL`; perform a 2-second metadata probe; configure runtime `WORKWELL_WEBCHART_BASE_URL` from that dedicated test value inside the test; execute a live app run; assert `wc|` visibility in roster, hierarchy, and quality; assert `All = sum tenants`; clear the directory and assert minimal-name rehydration. Never reference teatea.

- [x] **Step 8: Update documentation**

  Document ARCHITECTURE §3/§7 data flow/failure posture, DEPLOY env plus local HAPI recipe, MEASURES enrollment/segment behavior, ADR-033, and a newest-first JOURNAL entry dated 2026-07-17. Include the `/admin → Groups` one-click `WebChart` site addition and audited `SEGMENT_UPDATED` behavior.

- [x] **Step 9: Verify 6b and commit**

  Run focused tests and `corepack pnpm typecheck`, then commit: `feat(webchart): surface live tenant read models`

---

### Task 3: Final verification and PR handoff

- [ ] Start HAPI: `docker compose -f infra/docker-compose.yml up -d hapi-fhir`
- [ ] Load fixtures from `backend-ts/`: `corepack pnpm load:hapi`
- [ ] Run backend static/full checks: `corepack pnpm typecheck` and `corepack pnpm test`
- [ ] Run live suite: set `WORKWELL_WEBCHART_LIVE_TEST_BASE_URL=http://localhost:8081`; `corepack pnpm test`
- [ ] Manual demo with runtime `WORKWELL_WEBCHART_BASE_URL=http://localhost:8081` and `WORKWELL_WEBCHART_API_KEY=local-dev`: trigger ALL_PROGRAMS and verify the tenant selector, 56 `wc|` roster rows, and hierarchy reconciliation.
- [ ] Run frontend checks from `frontend/`: `npm run lint` and `npm run build`.
- [ ] Review the complete diff against every design section and fix all Critical/Important findings.
- [ ] Push `feat/webchart-live-tenant` and open a PR to `main` with spec mapping and exact verification counts. Do not merge.
