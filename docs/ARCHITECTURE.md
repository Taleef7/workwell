# WorkWell Measure Studio - Architecture

> **This is the compact module and boundary reference**: where things live, and which rules the code
> or CI enforces. The readable explanation of how the system works is [`docs/guide/`](guide/README.md).
> Decisions and their reasons are in [`docs/DECISIONS.md`](DECISIONS.md) (titles in `ADR_INDEX.md`).
> Section numbers are stable: source code cites §6, §7 and §10.

## 1) System Overview

WorkWell evaluates quality and compliance measures (CMS eCQMs and occupational/OSHA measures) with
CQL, keeps the per-define evidence, and turns non-compliant outcomes into cases people work.

- **Backend:** one TypeScript worker (`backend-ts/`, `@mieweb/cloud`) on a long-lived Node host
  (`src/server.ts` serves `src/worker.ts`). No JVM (ADR-008).
- **Engine:** CQL compiles to ELM at build time; the ELM is committed and runs in-process on
  `cql-execution`. A measure named in `WORKWELL_OFFICIAL_MEASURES` instead runs CMS's published
  artifact through `fqm-execution` (ADR-045, ADR-078).
- **Data:** PostgreSQL 16 on Neon (the `Pg*Store` ceiling, `workwell_spike` schema, created on boot
  with `IF NOT EXISTS`). SQLite floor for tests and local. `DATABASE_URL` picks the ceiling.
- **Frontend:** Next.js 16 App Router, React 19, Tailwind 4, `@mieweb/ui` (ADR-004), NITRO grid from
  vendored `@mieweb/datavis` (ADR-007).
- **AI:** OpenAI, assistive text only, deterministic fallbacks (`docs/AI_GUARDRAILS.md`).
- **Deployment profile:** `WORKWELL_INSTANCE` (`src/config/deployment-profile.ts`). Unset or `twh` is
  the default profile (subject term "employee", every tenant). `maui` means subject term "patient",
  the `maui` tenant only, and a generated patient corpus (ADR-070, ADR-075).

## 2) Deployment Topology

```text
Browser -> <stack>.os.mieweb.org          Next.js frontend (MIE Create-a-Container)
        -> <stack>-api-ts.os.mieweb.org   backend-ts worker on a Node host (MIE container)
             -> Neon Postgres (workwell_spike)
             -> in-process CQL engine / fqm-execution for routed measures
             -> evidence bucket (Cloudflare R2, S3 API)
             -> OpenAI (assistive text only)
             -> MCP endpoints (/sse, /mcp/message)
```

| Stack | Frontend | API | Deploy workflow | Self-heal |
|---|---|---|---|---|
| TWH (demo) | `twh.os.mieweb.org` | `twh-api-ts.os.mieweb.org` | `deploy-twh-mieweb.yml` (push to `main`, dispatch) | `reconcile-twh-mieweb.yml` |
| Maui (pilot sandbox) | `maui.os.mieweb.org` | `maui-api-ts.os.mieweb.org` | `deploy-maui-mieweb.yml` (push to `main`, dispatch) | `reconcile-maui-mieweb.yml` |
| Staging | `twh-staging.os.mieweb.org` | `twh-staging-api-ts.os.mieweb.org` | `deploy-staging-mieweb.yml` (dispatch only) | none |

- Reconcilers (cron every 15 min; GitHub runs them less often) recreate a down container from
  `:latest` with the same env as the deploy (`backend-ts/src/wiring/official-flip-config.test.ts`).
- `deploy-workwell-redirect-mieweb.yml` redirects `workwell.os.mieweb.org` to TWH.
- Stack env that shapes behaviour:
  - both: `WORKWELL_SCHEDULER_ENABLED=true`, `WORKWELL_BUCKET_S3_*`.
  - TWH: `WORKWELL_INSTANCE=twh`, `WORKWELL_OFFICIAL_MEASURES=cms122,cms125`.
  - Maui: `WORKWELL_INSTANCE=maui`, `WORKWELL_OFFICIAL_MEASURES=cms122,cms125,cms2,cms130,cms165,cms137`,
    `WORKWELL_MAUI_CORPUS_SIZE`, `WORKWELL_RUN_CHUNK_SIZE`, `WORKWELL_SCHEDULER_ANCHOR_HOUR_UTC`,
    `WORKWELL_OUTCOME_RETENTION_DAYS=400`.
- Other workflows: `ci.yml`, `flip-gate.yml`, `cross-engine-sweep.yml`, `vendor-official-measure.yml`,
  `publish-packages.yml`, `backup-neon-nightly.yml`.
- Secrets, env vars, rollback and the flip runbook: `docs/DEPLOY.md`.

## 3) Backend Module Boundaries (`backend-ts/src/*`)

**Entry points**
- `src/server.ts` - container entry. Boots the `@mieweb/cloud` host (`MIEWEB_TARGET`) and the
  scheduler, then serves `worker.fetch`.
- `src/worker.ts` - the one request handler. The startup guard first, then health, version and
  OpenAPI (before auth), then auth, then each `routes/*.ts` handler in turn; CORS is added to every
  response. An unmatched `/api/*` is a 404 pointing at §7.

**Packages** (`backend-ts/packages/`; published surface in `docs/PACKAGES.md`)
- `measure-engine` (`@work-well/measure-engine`) - the evaluation core: `evaluate-measure.ts`,
  `measure-executor.ts`, `cql/cql-execution-engine.ts`, the value-set resolvers and `vsac-client.ts`.
  Depends only on `cql-execution` and `cql-exec-fhir`. Measure content is injected (ADR-059).
- `measure-codegen` (`@work-well/measure-codegen`) - rule params to CQL (`generate-cql.ts`, ADR-015).
- `official-executor` - the only home of `fqm-execution`, loaded by lazy import (ADR-026). Not published.
- `example-consumer` - a test that uses the packages as an outsider would (ADR-062). Not published.

**Modules**
- `admin/` - scheduler (`scheduler.ts`, `schedulerTick`: a daily `ALL_PROGRAMS` run, then outcome
  compaction and read-model warm-up), waivers, outreach templates, demo reset, admin data, runtime
  health (`runtime-health.ts`: build identity and the event-loop stall monitor).
- `ai/` - `ai-assist.ts` (draft spec, draft CQL, test fixtures, explain-why-flagged, run insight,
  each with a fallback), `openai-chat.ts`.
- `audit/` - `audit-packet.ts` (`buildRunPacket`, `buildMeasureVersionPacket`, `buildCasePacket`; JSON
  or HTML). The ledger is written through `CaseEventStore` (`appendAudit`, `recordCaseEvent`).
- `auth/` - `authorize.ts` (route-to-role rules, actor identity), `jwt.ts`, `password.ts`,
  `demo-users.ts` (hardcoded accounts; no SSO).
- `case/` - case rules (`case-logic.ts`: `planCaseUpsert`, `closureKindOf`, `nextActionFor`), actions,
  rerun-to-verify (`case-rerun.ts`), outreach (`case-outreach.ts` `dispatchOutreach`,
  `outreach-campaign.ts` `runCampaign`, `outreach-channel.ts`, `email-service.ts`), evidence
  (`evidence-service.ts`, `resolve-bucket.ts`), appointments, provider panels (`panel-assignment.ts`,
  ADR-080), work-list and case-detail read models (`worklist-read-model.ts`, `worklist-patients.ts`,
  `case-detail-read-model.ts` `deriveWhyFlagged`).
- `cds/` - CDS Hooks discovery and cards (`discovery.ts`, `cards.ts`), ADR-067.
- `compliance/` - the roster (`roster-read-model.ts`, `roster-vocabulary.ts` `deriveCell`), panels,
  the shared subject filters (`subject-filters.ts`), the live CQL answer for staff-closed cases
  (`live-cell.ts`, ADR-083), attributed lists (`subject-list-*.ts`, ADR-082).
- `config/` - `deployment-profile.ts` (`DEPLOYMENT_PROFILE`, `classifyRunnable`), `cors.ts`,
  `startup-safety.ts`, `seam-inventory.ts` (§10), `official-measure-ids.ts`.
- `engine/` - WorkWell's measure content and data ingress. No stores, routes or `@mieweb/*` (§6).
  - `cql/` - `measure-registry.ts`, committed ELM in `cql/elm/`, `bundled-ecqm-expansions.ts`,
    `workwell-engine.ts` (`createWorkwellEngine()`, the one place content meets the engine),
    `codegen/generate-sql.ts` (rule to MariaDB SQL for the shim, ADR-034).
  - `ingress/` - `evaluate-bundle.ts` (`evaluateBundle`, `evaluateBatch`; DB-less), `data-source.ts`
    (`PatientDataSource` port, `resolveDataSource`), `webchart/` (FHIR client, SMART Backend Services
    auth, `normalizeWebChartBundle`, terminology crosswalk, live directory), `enrollment/roster.ts`
    (`stampEnrollment`).
  - `synthetic/` - employee catalog and tenants, `fhir-bundle-builder.ts`, `measure-bindings.ts`, the
    Maui corpus (`corpus/`), the scale structure.
  - `immunization/` - `ImmunizationForecast` port and the ICE adapter (ADR-029). Advisory only.
  - `cli/` - `pnpm evaluate --patient <bundle.json> --measure <id>`.
- `export/` - CSV builders (`export-csv.ts`, `csv.ts`). Column contracts: `DATA_MODEL_CONTRACTS.md` §6.
- `fhir/` - MeasureReport (`measure-report.ts`: `membershipFor`, `createRateAggregator`,
  `outsideEveryRate`), QRDA I export and import (`qrda1-*.ts`, `cda-parse.ts`), QRDA III
  (`qrda3-export.ts`), run aggregation, MAT bundle export.
- `identity/` - cross-system people (`resolvePeople`, `mergedComplianceTimeline`); human-confirmed
  links in `person_links` (ADR-022).
- `mcp/` - read-only tools (`tools.ts`), JSON-RPC dispatch and per-tool role gates (`dispatch.ts`),
  per-call audit (`tool-audit.ts`).
- `measure/` - catalog, lifecycle, authoring, CQL compile (`cql-translator.ts`), traceability, impact
  preview, value-set governance and terminology mappings, data readiness, OSHA references, UCUM.
- `openapi/` - `spec.ts`, the hand-authored OpenAPI 3.1.1 document (ADR-068).
- `order/` - advisory order proposals (`proposeOrders`, FHIR `ServiceRequest` with `intent=proposal`)
  and the `StandingOrderProvider` port (ADR-013).
- `program/` - programs overview, trend, top drivers and risk outlook (`program-read-models.ts`),
  hierarchy and scale rollups, winning-run resolution (`latest-population.ts`), post-run memo warm-up
  (`warm-read-models.ts`).
- `quality/` - quality-over-time snapshots (`buildSnapshotRows`, `materializeRun`; ADR-021).
- `routes/` - one file per route group. Each file's header comment lists its routes.
- `run/` - the run pipeline (`run-pipeline.ts`: planning, `finishManualRun`, case upsert, cycle
  rollover), run read models, measurement periods (`compliance-period.ts`, `run-period.ts`), outcome
  compaction (ADR-073), the incremental cache (`incremental/`, ADR-035), stuck-run recovery, alerts
  (`alert-channel.ts`), scale evaluation and its worker pool, offline CLIs (`cli/`).
- `segment/` - cohort applicability (`segment-applicability.ts`: `matchesCohort`, `isApplicable`;
  ADR-016).
- `standards/` - fidelity against the official spec and outcome diffs (`measure-fidelity.ts`,
  `outcome-diff.ts`, `execution-diff.ts`, `literal-diff.ts`), cross-engine checks, official test cases.
- `stores/` - one port per store (`*-store.ts`), Pg ceiling in `postgres/`, SQLite floor in
  `sqlite/`, chosen by `getStores` in `factory.ts`. Both run the shared `store-contract.ts` tests.
- `wiring/` - app composition: `engineForEnv` (`engine-factory.ts`), `routedEngineForEnv`
  (`executor-router.ts`), official routing, the artifact's own terminology (ADR-036), QI-Core
  preparation (`preparedForQiCore`, ADR-037), per-measure semantics (`officialMeasureSemantics`),
  bundle sources.

**Schema and measure content**
- Schema: `backend-ts/src/stores/postgres/schema-pg.ts` (ceiling) and
  `backend-ts/src/stores/sqlite/schema.ts` (floor). Contracts: `docs/DATA_MODEL_CONTRACTS.md`.
  Schema changes are owner-only.
- Measures: `backend-ts/measures/*.cql` plus `*.yaml` bindings (ADR-006). Vendored CMS artifacts:
  `backend-ts/measures/official/<id>/` (ADR-036, ADR-047). Plain-English catalog: `docs/MEASURES.md`.

## 4) Frontend Route Surfaces (`app/(dashboard)`)

- `/programs` - KPI overview and per-measure cards. `/programs/[measureId]` - one measure's trend,
  drivers, risk outlook and quality-over-time. `/programs/hierarchy` - tenant to patient rollup.
- `/compliance` - the roster grid (subjects x a panel's measures).
- `/worklist` - one row per patient. `/cases` - one row per gap, with bulk actions and CSV export.
  `/cases/[id]` - case detail, timeline, evidence, actions.
- `/lists` - attributed patient lists (ADR-082).
- `/campaigns` - bulk outreach. `/orders` - advisory order proposals.
- `/people`, `/people/[personId]` - cross-system people.
- `/employees/[externalId]` - subject profile, per-measure status, simulate-as-of.
- `/measures` - catalog. `/studio/[id]` - authoring tabs (Spec, CQL, Rule Builder, Value Sets,
  Tests, Standards). `/studio/elm` - compiled ELM beside its CQL.
- `/runs` - run history and outcomes. `/admin` - operations, governance, outreach, audit, groups.

Outside the dashboard: `/login`, `/sandbox` (read-only viewer sign-in), `/api-docs` (OpenAPI).

Shared pieces: `components/client-providers.tsx` (keeps `@mieweb/ui` out of Server Components),
`components/run-status-provider.tsx` (global run tracker, fires `ww:run-complete`), `lib/rbac.ts`
(mirrors `authorize.ts`), `lib/api/client.ts`, `features/datavis/NitroGrid` (over `vendor/datavis`),
`components/chart-data-table.tsx` (screen-reader table behind each chart). The UI shows statuses from
the read models and never derives compliance.

## 5) End-to-End Data Flow

### 5.1 OSHA/Policy Text -> Spec
The author fills the Studio Spec tab by hand or with an AI draft (`AI_DRAFT_SPEC_GENERATED`). It
saves to `measure_versions.spec_json` and, when set, `measure_versions.osha_reference_id`.

### 5.2 Spec -> CQL
The author edits CQL, or uses the Rule Builder (`generateCql`). `POST /api/measures/compile`
validates it; the result lands in `measure_versions.compile_status` / `compile_result`. Activation
needs a clean compile and well-formed test fixtures. `validateTests`
(`measure/measure-read-models.ts`) checks fixture structure only and does not run the fixtures.

### 5.3 CQL -> Run
- Trigger with `POST /api/runs/manual`. Bare `POST /api/runs` only creates a QUEUED run for
  `POST /api/runs/claim`.
- Scopes: `ALL_PROGRAMS`, `MEASURE`, `SITE`, `EMPLOYEE`, `CASE`. `ASYNC_SCOPES` (`ALL_PROGRAMS`,
  `SITE`, `MEASURE`) return RUNNING and finish in the background; `EMPLOYEE` and `CASE` are synchronous.
- Per subject: build the FHIR bundle, evaluate (authored engine or routed official executor), store
  `Outcome Status` and `expressionResults` in `outcomes.evidence_json` (shape: `DATA_MODEL_CONTRACTS` §5).
- Subjects are evaluated in chunks (`WORKWELL_RUN_CHUNK_SIZE`), yielding the event loop (ADR-085).
- Official measures are scored over the calendar year of the evaluation date (ADR-072).

### 5.4 Outcomes -> Cases
`CaseStore.upsertFromOutcome` applies `planCaseUpsert` on the key
`(employee_id, measure_version_id, evaluation_period)`. The rules are in `DATA_MODEL_CONTRACTS.md` §4.
After the loop: older-cycle cases close as `CYCLE_ROLLED_OVER`, `RUN_COMPLETED` is written, and the
quality snapshot is materialized (`materializeRun`, best-effort).

### 5.5 Cases -> Actions
Operators assign (single or `POST /api/cases/bulk-assign`), escalate, send outreach
(`dispatchOutreach` via the `OutreachChannel` port; simulated by default), record delivery state,
upload evidence, and rerun-to-verify. A rerun closes the case only on COMPLIANT or EXCLUDED.

### 5.6 Actions -> Audit
State changes write `audit_events`. That is the rule, and it is not yet true everywhere (#598); the
exceptions are listed in `DATA_MODEL_CONTRACTS.md` §4. New code audits before it mutates.
`recordCaseEvent` writes the action row and the audit row in one transaction before the case patch.
Evidence downloads write `EVIDENCE_DOWNLOADED`.

## 6) Runtime Invariants

**Compliance authority**
- CQL `Outcome Status` is the only compliance source. AI, immunization forecasts, order proposals,
  segments, identity, hierarchy and quality rollups, VSAC expansion, the incremental cache, the
  executor choice and the standards diffs never set or override it.
- AI rules live in `docs/AI_GUARDRAILS.md`. CDS cards never emit `critical` or `systemActions`
  (ADR-067).
- Segments gate case creation and roster display only. An out-of-cohort COMPLIANT outcome, or an
  EXCLUDED one with an active case, still resolves that case.

**Boundaries (enforced by tests in CI)**
- `src/engine/` is self-contained: relative imports stay inside it, bare imports come from an
  allowlist (`src/engine/engine-boundary.test.ts`).
- The app reaches the engine only through `@work-well/measure-engine`'s `index.ts`
  (`src/engine/measure-engine-api.test.ts`). The package's own dependency closure:
  `packages/measure-engine/src/package-boundary.test.ts`.
- `fqm-execution` lives only in `@work-well/official-executor` (`src/standards/fqm-isolation.test.ts`).
- The audit-first paths are held by `src/audit/audit-order.test.ts`.
- The two work-list loaders (SQL page and in-memory pipeline) must agree
  (`src/case/worklist-page-conformance.test.ts`, ADR-084).
- Every documented OpenAPI path must be served (`src/routes/openapi.test.ts`).
- One worker with modular `src/` areas. No microservices, no message broker.

**Runs**
- One subject's failure makes that subject `MISSING_DATA` with `{ evaluationError, message }`. The run
  continues.
- A routed measure's batch failure (including "nothing retrieved for anybody") reaches every subject
  of that measure through the same per-subject isolation. Other measures are unaffected.
- A terminal run (`COMPLETED`, `PARTIAL_FAILURE`, `FAILED`, `CANCELLED`) takes no new outcomes:
  `POST /api/runs/:id/evaluate` answers 409.
- `RunStore.finalizeRun` moves only QUEUED or RUNNING runs. `failStuckRuns` sweeps stuck runs and
  skips `seed:%` runs.
- Read models use completed population runs only. A FAILED run is ignored, so the last good run stays
  authoritative.
- A request never executes a whole population. The fidelity diff executes only runs of at most
  `IN_REQUEST_EXECUTION_MAX_SUBJECTS` (20) subjects (`routes/measures.ts`).
- Post-run work (per-case audit, quality snapshot, alerts, compaction, warm-up) is best-effort and
  never fails a finished run.
- Persisted evidence dates are UTC, independent of the host timezone.
- Case upsert rules (idempotency, `IN_PROGRESS` kept, human closures respected, out-of-population
  never opens a case): `DATA_MODEL_CONTRACTS.md` §4.

**Security and config**
- Actor identity comes from `auth/authorize.ts`. Caller-supplied actor fields are ignored.
- `ROLE_VIEWER` may GET and HEAD only; any write is 403.
- A production-like config that is unsafe makes every request answer 503 `unsafe_configuration`
  (`config/startup-safety.ts`): auth disabled, a weak JWT secret, an insecure cookie, or
  `WORKWELL_CORS_ALLOWED_ORIGINS` missing, blank, wildcard, localhost or invalid.
- `NEXT_PUBLIC_DEMO_MODE=true` fails the production frontend build (`frontend/next.config.ts`).
- Email stays simulated unless `WORKWELL_EMAIL_PROVIDER=sendgrid` and its API key are set.
- A database statement timeout or pool-acquire timeout answers 503, not 500 (ADR-084).

## 7) External Interfaces

**Integration surface** - versioned, and the only routes in the OpenAPI document (ADR-061, ADR-067,
ADR-068):
- `GET /api/v1/compliance/{subjectId}/{measureId}` - one subject, one measure, one answer.
  Contract: `docs/COMPLIANCE_API.md`.
- `GET /cds-services` (public), `POST /cds-services/{serviceId}`, `POST /cds-services/{serviceId}/feedback`
  - CDS Hooks `patient-view` cards from a completed run. Contract: `docs/CDS_HOOKS.md`.
- `GET /api/v1/openapi.json` (public) - the OpenAPI 3.1.1 document.
- `GET /health`, `GET /api/version` (public) - see §9.

**Internal REST** (`/api/*`, logically v1, moves with the frontend, no stability promise). Handlers
are in `backend-ts/src/routes/`; each file's header comment lists its routes.

| Group | Route file(s) |
|---|---|
| Measures, compile, lifecycle, fidelity, rule builder | `measures.ts` |
| Runs, outcomes, MeasureReport, QRDA I/III, QRDA I import | `runs.ts`, `outcomes.ts` |
| Cases, work list, bulk assign, outreach, evidence; campaigns | `cases.ts`, `worklist.ts`, `campaigns.ts` |
| Roster, simulate-as-of, subject search/profile | `compliance.ts`, `compliance-simulation.ts`, `employees.ts` |
| Programs, hierarchy, tenants, quality history | `programs.ts`, `hierarchy.ts`, `tenants.ts`, `quality.ts` |
| Panels, providers, payers, attributed lists | `panels.ts`, `providers.ts`, `payers.ts`, `subject-lists.ts` |
| People, segments, orders, immunization forecast | `identity.ts`, `segments.ts`, `orders.ts`, `immunization.ts` |
| CSV and audit exports, audit packets | `exports.ts`, `auditor.ts` |
| Admin (scheduler, waivers, templates, audit viewer, runtime) | `admin.ts` |
| AI, auth, raw CQL (`POST /$cql`) | `ai.ts`, `auth.ts`, `cql-evaluation.ts` |

- CSV column contracts and `?listId=` rules: `docs/DATA_MODEL_CONTRACTS.md` §6.
- Standards exports (MeasureReport, QRDA I, QRDA III) answer 409 `run_compacted` for a run older than
  the compaction cutoff (ADR-077). What we may claim about them: `docs/STANDARDS_CONFORMANCE.md`.

**MCP** - `GET /sse` and `POST /mcp/message`: read-only tools, role-gated, audited per call. See
`docs/MCP.md`.

**WebChart ingest** - FHIR over HTTP with SMART Backend Services auth (`engine/ingress/webchart/`);
the dev database through `wcdb-fhir-shim/`. See `docs/WEBCHART_FHIR_MAPPING.md` and
`docs/WEBCHART_API_ASSUMPTIONS_2026-07.md`.

**Packages** - `@work-well/measure-engine` and `@work-well/measure-codegen` on npm. See `docs/PACKAGES.md`.

**Offline CLIs** (`pnpm <script>` in `backend-ts/`; never on the request path): `evaluate`,
`seed:scale`, `seed:quality-history`, `seed:trend-history`, `outcomes:compact`, `resolve-valuesets`,
`vendor:official`, `flip-gate`, `flip-snapshot`, `test:official-cases`, `generate:sql`,
`compile-measures`, `corpus:export`. Definitions: `backend-ts/package.json`.

## 8) Current Infra Split

- MIE Create-a-Container runs a frontend and a backend container per stack (§2).
- Neon: all relational data, `workwell_spike` schema, one database per stack (`workwell-twh` for TWH).
- Cloudflare R2: uploaded evidence via the `bucket-s3` seam (`workwell-evidence-twh`, `-maui`).
- GHCR images: `ghcr.io/taleef7/workwell-api-ts` (one backend image for every stack),
  `workwell-twh-frontend`, `workwell-maui-frontend`, `workwell-redirect`.
- Backups: `backup-neon-nightly.yml`; runbook `docs/BACKUP_DR_RUNBOOK.md`.

## 9) API Versioning Convention

- Existing routes stay under unprefixed `/api/...` and are logically v1.
- `/api/v1/` is reserved for the deliberately versioned integration surface in §7.
- A breaking shape change gets a new `/api/v2/...` path. The old path stays for at least one minor
  version cycle. Additive changes stay on v1.
- `GET /api/version` (public): `{ api: "v1", stack: "typescript", build: "workwell-api-ts", sha,
  startedAt }`. `/health` adds uptime and event-loop stall counts; what ran during a stall is on the
  ADMIN-only `GET /api/admin/runtime`.
- OpenAPI: `GET /api/v1/openapi.json`, hand-authored 3.1.1, promised surface only, rendered at `/api-docs`.

## 10) Inert-seam inventory

Each seam has a simulated or local default and an adapter that turns on only when its env vars are
set. `describeSeams(env)` (`backend-ts/src/config/seam-inventory.ts`) reports each one by calling that
seam's own predicate, never a second parse of the env. `worker.ts` logs one line per instance at boot:

```
seams: sendgrid=off datachaser=off ice=off eh-fhir=off webchart=off sql-executor=off vsac=off alert-webhook=off bucket-s3=off incremental-eval=off official-measures=off
```

The inventory reports only; it never selects a seam. Test: `backend-ts/src/config/seam-inventory.test.ts`.

| Seam | Predicate (file) | Turned on by | Default |
|---|---|---|---|
| `sendgrid` | `isSendgridConfigured` (`case/email-service.ts`) | `WORKWELL_EMAIL_PROVIDER=sendgrid` and `WORKWELL_EMAIL_SENDGRID_API_KEY` | simulated email |
| `datachaser` | `isDataChaserConfigured` (`case/outreach-channel.ts`) | `WORKWELL_OUTREACH_DATACHASER_API_KEY` and `..._BASE_URL` | simulated channels |
| `ice` | `isIceConfigured` (`engine/immunization/immunization-forecast.ts`) | `WORKWELL_IMMZ_ICE_BASE_URL` alone | simulated forecaster |
| `eh-fhir` | `isEhFhirConfigured` (`order/standing-order-provider.ts`) | `WORKWELL_EH_FHIR_BASE_URL` and `WORKWELL_EH_FHIR_API_KEY` | simulated standing orders |
| `webchart` | `isWebChartConfigured` (`engine/ingress/data-source.ts`) | `WORKWELL_WEBCHART_BASE_URL` and either `WORKWELL_WEBCHART_API_KEY` or `WORKWELL_WEBCHART_CLIENT_ID` plus a private key (`..._PRIVATE_KEY_B64` deployed, `..._PRIVATE_KEY` local) | JSON-bucket source |
| `sql-executor` | `isSqlPushdownSelected` (`packages/measure-engine/src/measure-executor.ts`) | `WORKWELL_MEASURE_EXECUTOR=sql-pushdown` (a stub; rejects on use) | `fhirNativeExecutor` |
| `vsac` | `isVsacConfigured` (`packages/measure-engine/src/cql/resolve-value-set-resolver.ts`; gated in `wiring/engine-factory.ts`) | `WORKWELL_VSAC_API_KEY` | local value sets |
| `alert-webhook` | `isAlertWebhookConfigured` (`run/alert-channel.ts`) | `WORKWELL_ALERT_WEBHOOK_URL` | console line only |
| `bucket-s3` | `isS3BucketConfigured` (`case/resolve-bucket.ts`) | `WORKWELL_BUCKET_S3_BUCKET`, `..._ACCESS_KEY_ID`, `..._SECRET_ACCESS_KEY` | in-container `fs` bucket; set on TWH and Maui |
| `incremental-eval` | `isIncrementalEnabled` (`run/incremental/incremental-eval.ts`) | `WORKWELL_INCREMENTAL_EVAL=true` | every subject re-evaluated |
| `official-measures` | `isOfficialRoutingConfigured` (`wiring/official-routing.ts`) | `WORKWELL_OFFICIAL_MEASURES=<catalog ids>` plus each measure's vendored terminology, or routing refuses | authored engine; set on TWH and Maui (§2) |

Run alerts (`emitAlert`): a FAILED or PARTIAL_FAILURE run, stuck-run recovery or a scheduler error
emits one. The console line (`WORKWELL_ALERT` + JSON) is always on; the webhook is the seam above.
