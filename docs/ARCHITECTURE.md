# WorkWell Measure Studio - Architecture

## 1) System Overview
WorkWell Measure Studio is a **Total Worker Health (TWH)** compliance platform — a two-tier web application that unifies OSHA occupational safety compliance and CMS/HEDIS clinical quality measures in a single system. TWH is the NIOSH framework recognising that worker health is shaped by both workplace hazards and general health promotion.

- Frontend: Next.js App Router dashboard on MIE Create-a-Container, built on MIE's `@mieweb/ui` component library (Tailwind 4) with dark mode + Enterprise Health brand and a runtime brand switcher (semantic-token theming via `useTheme`/`useBrand`; see ADR-004). `@mieweb/ui` is imported only from client components (`components/client-providers.tsx` boundary). The DataVis **NITRO** data grid (`@mieweb/ui/datavis` + vendored `datavis` source under `frontend/vendor/datavis`; see ADR-007) drives the large operational/audit tables (`/measures`, `/runs` Outcomes, `/admin`) via the client-only `features/datavis/NitroGrid` seam.
- Backend: TypeScript worker (`@mieweb/cloud`, `backend-ts/`) on a long-lived Node host — MIE Create-a-Container (the Java/Spring backend was retired in #109 PR4; ADR-008).
- Data: PostgreSQL 16 (Neon) via the `Pg*Store` ceiling, isolated `workwell_spike` schema (self-creating `CREATE … IF NOT EXISTS` on boot — the old Java Flyway migrations were deleted with `backend/` in PR4); SQLite floor for tests/local.
- Optional assistive surfaces: OpenAI-backed AI calls (backend-ts AI surfaces) for drafting/explanations (never compliance decisions).

Compliance outcomes are determined only by CQL evaluation + structured evidence persistence.

## 2) Deployment Topology

```text
Browser
  -> twh.os.mieweb.org  (Next.js frontend — MIE container)
      -> twh-api-ts.os.mieweb.org  (TypeScript worker on a long-lived Node host — MIE container)
          -> Neon Postgres / workwell-twh  (Pg ceiling, workwell_spike schema)
          -> JVM-free CQL engine (build-time CQL→ELM, in-process)
          -> OpenAI API (assistive text only)
          -> MCP read interface (/sse + tools)
```

Production endpoints:
- Frontend: `https://twh.os.mieweb.org`
- Backend API: `https://twh-api-ts.os.mieweb.org` — the de-Java TypeScript backend (`backend-ts/`), the **sole** backend (Java retired in #109 PR4)

> **#109 — JVM retired (PR4):** the Java/Spring backend is gone (`backend/` deleted). The TypeScript
> backend serves the same unchanged `/api/*` contract over a Cloudflare-style worker on a long-lived
> Node host, evaluates CQL via the JVM-free build-time CQL→ELM path, and persists to the Neon
> `workwell_spike` schema (the Pg ceiling). The module boundaries in §3 below are named against the
> original Java packages (`com.workwell.*`); `backend-ts/src/<area>/` mirrors the same boundaries.

Deploy workflow: `.github/workflows/deploy-twh-mieweb.yml` — triggers on every push to `main` and via `workflow_dispatch`. Builds the TypeScript backend and the TWH-branded frontend (pointed at `twh-api-ts`) as Docker images, pushes to GHCR, and deploys both containers via MIE Create-a-Container API. A self-heal reconciler (`reconcile-twh-mieweb.yml`) recreates a down container from `:latest` every 15 min.

Instance model: `WORKWELL_INSTANCE=twh` seeds all three measure categories on startup (OSHA safety, HEDIS wellness, CMS eCQM catalog). A single TWH deployment is the canonical demo environment.

## 3) Backend Module Boundaries (`com.workwell.*`)
- `measure`: measure catalog, versioning, lifecycle transitions, policy traceability matrix (`MeasureTraceabilityService`), dry-run activation impact preview (`MeasureImpactPreviewService`), and value set governance + terminology mapping (`ValueSetGovernanceService` — resolve-check, diff, CQL unattached reference detection, terminology mapping CRUD).
- `admin`: integration health (`IntegrationHealthService` — scheduled 15-min fhir/mcp/hris refresh, reactive AI status, distinct `simulated` HRIS status), scheduler, waivers, outreach templates (list/create/update/preview), outreach delivery log (`OutreachDeliveryLogService`), non-prod demo reset (`DemoResetService`, `@Profile("!prod")`), and data readiness (`DataReadinessService` — source mapping, freshness, missingness computation).
- `valueset`: value set registry and measure/value-set linkage.
- `compile`: CQL translator compile validation and compile metadata; hosts the `CqlEvaluationService` evaluation core.
- `engine`: Spring-free measure-evaluation seam. `engine.port` declares the input ports (`PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider`); `engine.model` holds `MeasureDefinition` + `BundleOutcome`; `engine.synthetic` provides the default demo adapters (the synthetic FHIR bundle, employee catalog, and compliance rates); `engine.yaml` loads the declarative `measures/*.yaml` files as the **single source of measure bindings** (`YamlMeasureDefinitionProvider`, ADR-006); `engine.cli` hosts the headless evaluator (`backend-ts/src/engine/cli/`, run via `pnpm evaluate --patient <bundle.json> --measure <id>` — no server, no DB; #72 / E2). `CqlEvaluationService` is constructed from the ports and exposes a public `evaluateBundle(...)` for arbitrary FHIR bundles, so real EHR/FHIR data adapters can be added later without touching the core (ADR-005). A `EngineNoSpringContextTest` proves the core evaluates with no `ApplicationContext`. Value-set expansion (E3.2 / #90): a `ValueSetResolver` port (`engine/cql/value-set-resolver.ts`) with a store-backed adapter feeds a populated `cql.CodeService`; `CqlExecutionEngine` takes an optional resolver (default off = the inline-code path). A live VSAC adapter is a future drop-in behind the same port. Synthetic resources are stamped with QI-Core `meta.profile` canonicals + required elements (E3.4 / #92) — structural alignment (metadata-only; does not affect evaluation). `engine.immunization` hosts the **`ImmunizationForecast` port** (`backend-ts/src/engine/immunization/immunization-forecast.ts`): `simulatedForecaster` (default — ACIP-style next-dose-due over the port's own deterministic per-subject synthetic immunization history covering Td/Tdap, Influenza, Hepatitis B) + an inert `iceForecaster` stub selected only when both `WORKWELL_IMMZ_ICE_API_KEY` + `WORKWELL_IMMZ_ICE_BASE_URL` are set; `resolveForecaster(env)` selects between them (mirrors ADR-011's inert-unless-configured pattern). Forecasting is **advisory only** — `CQL Outcome Status` is the sole compliance authority (#76 / E6; ADR-012).
- `fhir`: measure library/resource assembly used by evaluation runtime and MAT-compatible FHIR bundle export.
- `run`: run orchestration, run detail/summary read models, rerun scope support, and predictive risk-outlook analytics. The run read model derives `triggerType` from `runs.triggered_by` (`'seed:trend-history'` → `SEED`, else `MANUAL`). A **synthetic trend-history backfill** (`backend-ts/src/run/backfill-trend-history.ts`) and its seed CLI (`backend-ts/src/run/cli/`, `pnpm seed:trend-history`) write backdated weekly COMPLETED `MEASURE` runs + outcomes per runnable measure so the `/programs` trend charts vary — a controlled, on-demand offline tool (not on the request path); audited via `TREND_HISTORY_SEEDED` (#180).
- `program`: the programs-overview read model and the multi-level **hierarchy-rollup** read model (`backend-ts/src/program/hierarchy-rollup.ts`) — an enterprise→location→provider→patient `HierarchyNode` tree whose parent counts equal Σ children at every level (reconciling). It draws on the same outcome rows as the programs overview (latest population run per Active measure; CASE/EMPLOYEE reruns excluded) and resolves the hierarchy **at read-time from the synthetic employee directory** (`engine/synthetic/employee-catalog.ts` — `providerId`/`PROVIDERS`/`ENTERPRISE`), so there is **no schema/DB table** for it. Shared helpers (`isPopulationRun`/`round1`/day/`RERUN_SCOPES`/`latestRunRows`) live in `backend-ts/src/program/rollup-shared.ts`; the date-param parser in `backend-ts/src/routes/query-dates.ts` (#74 / E4; `latestRunRows` extracted for reuse by the E7 orders route).
- `caseflow`: case upsert/resolution, outreach + delivery-state + rerun-to-verify, case detail timeline. Outreach is **channel-aware**: `dispatchOutreach` (`backend-ts/src/case/case-outreach.ts`) is the shared send core used by both single-case send and campaigns, dispatching through the `OutreachChannel` port. The bulk **campaign engine** (`backend-ts/src/case/outreach-campaign.ts`, `runCampaign`) resolves eligible OPEN cases (measure/site/outcome filters), supports a `dryRun` recipient preview with no sends, and on a real run dispatches per recipient (per-recipient try/catch → FAILED, so a mid-loop failure never abandons the campaign and PARTIAL_FAILURE is reachable), tallying sent/failed/simulated and persisting via the `CampaignStore` port (#75 / E5).
- `audit`: append-only audit event publisher + export/query paths. `AuditPacketService` assembles structured audit export packets (case, run, measure version) as JSON or HTML bytes; writes `AUDIT_PACKET_GENERATED` audit events and records in `audit_packet_exports`.
- `export`: runs/outcomes/cases CSV contracts.
- `integrations`: integration service adapters/checks.
- `admin`: scheduler settings, integration health, outreach template APIs.
- `ai`: AI draft spec, explain-why-flagged, run insight surfaces with deterministic fallback.
- `mcp`: read-only MCP tools and tool-call audit logging.
- `notification`: outreach email delivery (`EmailService` — provider switch, default `simulated`; SendGrid wiring inert unless explicitly configured) + `EmailDeliveryRecord`. The multi-channel **`OutreachChannel` port** (`backend-ts/src/case/outreach-channel.ts`) generalizes this: `ChannelType` EMAIL/SMS/PHONE each have a simulated adapter (EMAIL delegates to the existing simulated email service; SMS/PHONE are body-only), plus an inert **DataChaser stub** (`dataChaserChannel` — returns QUEUED with a self-describing note, no real HTTP). `resolveChannel(type, env)` returns the simulated adapter **by default** and the DataChaser stub **only** when both `WORKWELL_OUTREACH_DATACHASER_API_KEY` + `WORKWELL_OUTREACH_DATACHASER_BASE_URL` are set (inert-unless-configured, mirroring SendGrid). Simulated by default on the demo stack.
- `stores` (campaign): the **`CampaignStore` port** (`backend-ts/src/stores/campaign-store.ts`) with an audit-backed demo adapter (`audit-campaign-store.ts`) — a campaign persists as a single `OUTREACH_CAMPAIGN_COMPLETED` audit event (payload `{campaign, recipients}`); reads scan `listAuditEvents` filtered by event type (O(ledger-size), demo-scale). **No new DDL** on the SQLite floor or the Pg ceiling. The production drop-in is a `PgCampaignStore` over `outreach_campaigns` + `outreach_delivery_log` (documented, not built). Wired in `factory.ts` for both floor + ceiling.
- `order`: advisory proposed-order engine (#77 / E7). `order-catalog.ts` — action-evaluator map: runnable measure → `OrderCode` (reuses terminology-mapping seed codes for audiogram/tb_surveillance/flu_vaccine/hazwoper; LOCAL `urn:workwell:orders` codes for others). `order-proposal.ts` — `proposeOrders(outcomes, provider)`: Panel=Risk selection (OVERDUE/DUE_SOON/MISSING_DATA propose; COMPLIANT/EXCLUDED don't), risk→priority (OVERDUE=urgent; DUE_SOON/MISSING_DATA=routine), in-batch dedupe + standing-order suppression (suppressed returned separately). Pure + trigger-agnostic. `proposed-order.ts` — `ProposedOrder` domain type + `toServiceRequest()` (FHIR R4 `ServiceRequest`, `intent:"proposal"`, `status:"draft"`, hand-built JSON — no FHIR runtime dep) + `bundleOf()`. **`StandingOrderProvider` port** (`standing-order-provider.ts`): `simulatedStandingOrderProvider` (default, deterministic ~1/5 of subjects have a standing order, no HTTP) + inert `ehStandingOrderProvider` stub selected only when both `WORKWELL_EH_FHIR_BASE_URL` + `WORKWELL_EH_FHIR_API_KEY` are set; `resolveStandingOrderProvider(env)`. Inert-unless-configured (mirrors ADR-011/ADR-012). Proposals are **advisory — never auto-submitted** (human reviews and submits; the real EH `OrderSubmitter` write path is a named-but-deferred drop-in). No schema.
- `config`: cross-cutting app/security/CORS/runtime configuration.
- `security`: HTTP security policy and allowed origins.
- `web`: REST controllers and request/response contracts.

## 4) Frontend Route Surfaces (`app/(dashboard)`)
- `/programs`: compliance KPI overview + per-program cards.
- `/programs/[measureId]`: measure-specific trend and driver view.
- `/programs/hierarchy`: enterprise→location→provider→patient drill-down (nested expandable rollup table with a measure filter; linked from `/programs`).
- `/runs`: run history, run detail, outcomes table, rerun selected scope.
- `/cases`: worklist with filters, search, bulk actions, exports.
- `/cases/[id]`: case detail, timeline, evidence, outreach/escalate/assign/rerun actions (the outreach action has a channel selector — EMAIL/SMS/PHONE); for `adult_immunization` cases an advisory immunization-forecast panel (Td/Tdap, Influenza, Hepatitis B next-dose-due) is shown — advisory only, never affects status (#76 / E6).
- `/campaigns`: bulk outreach campaign launcher (measure/site/outcome/channel/template filters → Dry-run recipient preview → Send → result summary + recipients) + campaign history list → detail (#75 / E5).
- `/measures`: measure list and create flow.
- `/studio/[id]`: authoring tabs (Spec/CQL/Value Sets/Tests), compile + version cloning.
- `/admin`: scheduler controls + integration health + manual sync.

## 5) End-to-End Data Flow

### 5.1 OSHA/Policy Text -> Spec
1. Author opens Studio Spec tab.
2. Manual entry or AI Draft Spec creates a draft proposal.
3. The policy reference is selected from the curated OSHA combobox or entered as free text.
4. Draft is saved to `measure_versions.spec_json` and, when applicable, `measure_versions.osha_reference_id`.
5. `AI_DRAFT_SPEC_GENERATED` audit event is written if AI was used.

### 5.2 Spec -> CQL
1. Author updates CQL text in Studio.
2. Compile API runs translator validation.
3. Compile result persisted in `measure_versions.compile_status` + `compile_result`.
4. Activation is blocked unless compile gate and test-fixture gate pass.

### 5.3 CQL -> Run
1. User triggers a scoped manual run (`/api/runs/manual`) or a case rerun using the shared CASE path.
2. Run row inserted in `runs` with requested-scope JSON and a transitional status such as `RUNNING`.
3. For each employee in the resolved scope:
   - Synthetic FHIR bundle is constructed from employee profile + exam config.
   - CQL engine evaluates measure defines against in-memory FHIR repository.
   - `Outcome Status` define determines bucket (`COMPLIANT|DUE_SOON|OVERDUE|MISSING_DATA|EXCLUDED`).
   - Define-level `expressionResults` are captured into `outcomes.evidence_json`.
4. Run summary counters, failure summary, and final status are persisted in `runs`.
5. Supported scopes now include `ALL_PROGRAMS`, `MEASURE`, `SITE`, `EMPLOYEE`, and `CASE`. `CASE` stays synchronous for rerun-to-verify; the other manual scopes run through the async run job model.

### 5.4 Outcomes -> Cases
1. Non-compliant outcomes (`DUE_SOON|OVERDUE|MISSING_DATA`) upsert open cases.
2. `COMPLIANT|EXCLUDED` closes existing case for same `(employee, measure_version, evaluation_period)`.
3. Case events and operator actions are written to `audit_events` and `case_actions`.

### 5.5 Cases -> Actions
1. Operator can assign, escalate, preview/send outreach, and mark delivery state.
2. Delivery state (`QUEUED|SENT|FAILED`) updates next-action guidance and timeline.
3. Rerun-to-verify re-evaluates the case subject through the persisted measure CQL and only closes the case when the structured outcome is compliant or excluded; non-compliant reruns keep the case open/in progress.

### 5.6 Actions -> Audit
Every state-changing operation emits an `audit_events` record with actor + entity refs + payload.
Evidence uploads and downloads are restricted to case manager/admin roles; downloads resolve the linked case, sanitize the response filename, and write `EVIDENCE_DOWNLOADED` audit rows with the evidence UUID, case UUID, content type, file size, and timestamp.
Public API actions derive audit identity from the authenticated security context. The backend no longer accepts caller-supplied `actor` or `resolvedBy` fields for audit identity.

## 6) Runtime Invariants
- AI cannot set compliance status.
- Immunization forecasts are advisory only; the `ImmunizationForecast` port never sets or overrides `Outcome Status`.
- Order proposals are advisory only; `proposeOrders` never auto-submits and never sets or overrides `Outcome Status`. A human reviews and submits (ADR-013).
- CQL `Outcome Status` is the only compliance classification source.
- Case idempotency is enforced by unique constraint: `(employee_id, measure_version_id, evaluation_period)`.
- One employee evaluation failure does not abort whole run; failed employee is persisted as `MISSING_DATA` with evaluation error evidence.
- Scoped runs use the same structured CQL path as rerun-to-verify for CASE verification.
- Synthetic trend-history seeding is audited (`TREND_HISTORY_SEEDED` per measure) and anchors each measure's newest synthetic week strictly before that measure's latest real run, so the programs overview (latest-run-per-measure) is never hijacked by synthetic data (#180).
- Public API actor identity always comes from the TypeScript auth middleware (`backend-ts/src/auth/authorize.ts`); caller-supplied actor fields are ignored or removed.
- Production startup is fail-fast: the backend refuses auth-disabled, weak-secret, wildcard-CORS, localhost-CORS-in-production, or backend-demo configurations when a production-like profile is active.
- Production CORS uses exact allowed origins from `workwell.cors.allowed-origins`; wildcard Vercel patterns are not used.
- Frontend demo prefill is a local convenience only; `NEXT_PUBLIC_DEMO_MODE=true` fails the production frontend build.

## 7) External Interfaces
- REST API: measure, run, case, admin, export, and auditor packet endpoints.
- REST API: evidence upload/download on case detail, role-gated to case manager/admin.
- MCP: read-only tools with per-call audit events and auth-middleware role gates (`backend-ts/src/auth/authorize.ts`) on `/sse` and `/mcp/**`.
- MCP tool audit actors come from the authenticated security context, not a hardcoded transport identity.
- CSV exports: runs/outcomes/cases + audit export. The audit export streams the ledger from a DB cursor (a paged `ReadableStream`) so memory stays bounded regardless of ledger size.
- Worklist pagination: `GET /api/cases` returns a plain array plus an `X-Total-Count` header (full filtered match count, exposed via CORS) so clients can page past the result cap.
- Headless evaluator CLI (`backend-ts/src/engine/cli/`): `pnpm evaluate --patient <bundle.json> --measure <id>` → `MeasureOutcome` JSON on stdout, no server/DB. A thin shell over `CqlExecutionEngine` (#72 / E2).
- Run trigger filter (#180): `GET /api/runs` supports a `triggerType` filter including `SEED`; `GET /api/runs?triggerType=SEED` returns the synthetic trend-history runs (real operator runs stay `MANUAL`). The trend-history seed CLI (`pnpm seed:trend-history [--weeks 12] [--as-of YYYY-MM-DD]`, `backend-ts/src/run/cli/`) is a controlled offline tool — not request-path/startup; idempotent + resumable at the week level; no schema. See DATA_MODEL §3.20.
- FHIR R4 `MeasureReport` (#89 / E3.1): `GET /api/runs/{runId}/measure-report?type=summary|individual|bundle` → `application/fhir+json`. Built from persisted `outcomes` (proportion model: IPP=all, DENEX=EXCLUDED, DENOM=IPP−DENEX, NUMER=COMPLIANT, score=NUMER/DENOM); single-measure runs only (422 otherwise). No FHIR runtime dependency.
- QRDA Category III aggregate stub (#91 / E3.3): `GET /api/runs/{runId}/qrda?format=xml` → `application/xml`. Hand-built CDA (well-formed, structurally representative; not IG-validated), aggregate counts via the shared `countPopulations`. See `docs/STANDARDS_CONFORMANCE.md`.
- Hierarchy rollup (#74 / E4): `GET /api/hierarchy/rollup?measureId=&from=&to=` → a `HierarchyNode` (enterprise root) with reconciling counts at every level (parent totals = Σ children). Authenticated under `/api/**`; validates `from`/`to` as `YYYY-MM-DD` (400 on malformed). Read-time over the synthetic directory; no schema.
- Outreach campaigns (#75 / E5): `POST /api/campaigns` (+ `?dryRun` for a recipient preview with no sends), `GET /api/campaigns`, `GET /api/campaigns/:id` — **gated to CASE_MANAGER/ADMIN** (matches per-case outreach; `authorize.ts` rule `rx("/api/campaigns/**") → [CM, A]`). The per-case outreach action `POST /api/cases/:id/actions/outreach` now accepts `?channel=EMAIL|SMS|PHONE` (default EMAIL). Sends are simulated by default; campaigns persist as `OUTREACH_CAMPAIGN_COMPLETED` audit events (no campaigns table — see DATA_MODEL §3.17).
- Immunization forecast (#76 / E6): `GET /api/immunization/forecast?subjectId=&asOf=` → `ImmunizationForecast` JSON (Td/Tdap, Influenza, Hepatitis B next-dose-due). `asOf` defaults to today, validated YYYY-MM-DD (400 on malformed); subjectId required (400 if missing). Authenticated under `/api/**`. Read-time; no schema. Advisory only — never sets compliance status (ADR-012).
- Order proposals (#77 / E7): `GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir` — **gated CASE_MANAGER/ADMIN** (`authorize.ts` `rx("/api/orders/**") → [CM, A]`). Selects latest population run per Active measure (reuses `rollup-shared.ts` `isPopulationRun` + `latestRunRows`). `format=domain` → `{proposed, suppressed}` JSON; `format=fhir` → FHIR R4 ServiceRequest `Bundle` (proposed only). Panel=Risk (OVERDUE/DUE_SOON/MISSING_DATA propose; COMPLIANT/EXCLUDED don't). In-batch dedupe + standing-order suppression. Read-time; **no schema**. Proposals are advisory — never auto-submitted (ADR-013).

## 8) Current Infra Split
- MIE Create-a-Container hosts both frontend (`twh`) and the TypeScript backend (`twh-api-ts`) processes.
- Neon (`workwell-twh` project) hosts all relational persistence used by backend (the `workwell_spike` schema).
- GHCR (`ghcr.io/taleef7/workwell-api-ts`, `ghcr.io/taleef7/workwell-twh-frontend`) stores Docker images.

No microservice decomposition is used in MVP; package boundaries are the future extraction seam.

## 9) API Versioning Convention
- The current API contract is **v1**. `GET /api/version` returns
  `{"api":"v1","build":"<impl-version-or-unknown>","uptime":"<seconds>s"}`
  and is unauthenticated for health/discovery use.
- Existing endpoints remain under the unprefixed `/api/...` path for the MVP
  demo; they are logically v1. Migrating controllers to an explicit `/api/v1/...`
  prefix is intentionally deferred (Sprint 4 note) to avoid churn across
  Actuator, Swagger, CORS, and the frontend client.
- **Convention for future breaking changes:** when a response shape change cannot
  be made backward-compatible, introduce the new endpoint under `/api/v2/...`
  rather than mutating the v1 path. The old `/api/v1/...` (or current unprefixed)
  path must be retained for at least one minor version cycle so integrators have
  a migration window. Additive, backward-compatible changes stay on v1.
- The OpenAPI document (`workwell.swagger.enabled=true`) advertises version `v1`.
