# WorkWell Measure Studio - Architecture

## 1) System Overview
WorkWell Measure Studio is a **Total Worker Health (TWH)** compliance platform — a two-tier web application that unifies OSHA occupational safety compliance and CMS/HEDIS clinical quality measures in a single system. TWH is the NIOSH framework recognising that worker health is shaped by both workplace hazards and general health promotion.

- Frontend: Next.js App Router dashboard on MIE Create-a-Container, built on MIE's `@mieweb/ui` component library (Tailwind 4) with dark mode + Enterprise Health brand and a runtime brand switcher (semantic-token theming via `useTheme`/`useBrand`; see ADR-004). `@mieweb/ui` is imported only from client components (`components/client-providers.tsx` boundary). The DataVis **NITRO** data grid (`@mieweb/ui/datavis` + vendored `datavis` source under `frontend/vendor/datavis`; see ADR-007) drives the large operational/audit tables (`/measures`, `/runs` Outcomes, `/admin`) via the client-only `features/datavis/NitroGrid` seam.
- Backend: Spring Boot API on MIE Create-a-Container.
- Data: PostgreSQL 16 (Neon) with Flyway migrations.
- Optional assistive surfaces: OpenAI-backed Spring AI calls for drafting/explanations (never compliance decisions).

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
- `engine`: Spring-free measure-evaluation seam. `engine.port` declares the input ports (`PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider`); `engine.model` holds `MeasureDefinition` + `BundleOutcome`; `engine.synthetic` provides the default demo adapters (the synthetic FHIR bundle, employee catalog, and compliance rates); `engine.yaml` loads the declarative `measures/*.yaml` files as the **single source of measure bindings** (`YamlMeasureDefinitionProvider`, ADR-006); `engine.cli` hosts the headless evaluator (`HeadlessEvaluatorCli`, run via `./gradlew.bat evaluateMeasure --args="patient.json measure.yaml"` — no Spring, no DB). `CqlEvaluationService` is constructed from the ports and exposes a public `evaluateBundle(...)` for arbitrary FHIR bundles, so real EHR/FHIR data adapters can be added later without touching the core (ADR-005). A `EngineNoSpringContextTest` proves the core evaluates with no `ApplicationContext`.
- `fhir`: measure library/resource assembly used by evaluation runtime and MAT-compatible FHIR bundle export.
- `run`: run orchestration, run detail/summary read models, rerun scope support, and predictive risk-outlook analytics.
- `caseflow`: case upsert/resolution, outreach + delivery-state + rerun-to-verify, case detail timeline.
- `audit`: append-only audit event publisher + export/query paths. `AuditPacketService` assembles structured audit export packets (case, run, measure version) as JSON or HTML bytes; writes `AUDIT_PACKET_GENERATED` audit events and records in `audit_packet_exports`.
- `export`: runs/outcomes/cases CSV contracts.
- `integrations`: integration service adapters/checks.
- `admin`: scheduler settings, integration health, outreach template APIs.
- `ai`: AI draft spec, explain-why-flagged, run insight surfaces with deterministic fallback.
- `mcp`: read-only MCP tools and tool-call audit logging.
- `notification`: outreach email delivery (`EmailService` — provider switch, default `simulated`; SendGrid wiring inert unless explicitly configured) + `EmailDeliveryRecord`.
- `config`: cross-cutting app/security/CORS/runtime configuration.
- `security`: HTTP security policy and allowed origins.
- `web`: REST controllers and request/response contracts.

## 4) Frontend Route Surfaces (`app/(dashboard)`)
- `/programs`: compliance KPI overview + per-program cards.
- `/programs/[measureId]`: measure-specific trend and driver view.
- `/runs`: run history, run detail, outcomes table, rerun selected scope.
- `/cases`: worklist with filters, search, bulk actions, exports.
- `/cases/[id]`: case detail, timeline, evidence, outreach/escalate/assign/rerun actions.
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
- CQL `Outcome Status` is the only compliance classification source.
- Case idempotency is enforced by unique constraint: `(employee_id, measure_version_id, evaluation_period)`.
- One employee evaluation failure does not abort whole run; failed employee is persisted as `MISSING_DATA` with evaluation error evidence.
- Scoped runs use the same structured CQL path as rerun-to-verify for CASE verification.
- Public API actor identity always comes from Spring Security; caller-supplied actor fields are ignored or removed.
- Production startup is fail-fast: the backend refuses auth-disabled, weak-secret, wildcard-CORS, localhost-CORS-in-production, or backend-demo configurations when a production-like profile is active.
- Production CORS uses exact allowed origins from `workwell.cors.allowed-origins`; wildcard Vercel patterns are not used.
- Frontend demo prefill is a local convenience only; `NEXT_PUBLIC_DEMO_MODE=true` fails the production frontend build.

## 7) External Interfaces
- REST API: measure, run, case, admin, export, and auditor packet endpoints.
- REST API: evidence upload/download on case detail, role-gated to case manager/admin.
- MCP: read-only tools with per-call audit events and Spring Security role gates on `/sse` and `/mcp/**`.
- MCP tool audit actors come from the authenticated security context, not a hardcoded transport identity.
- CSV exports: runs/outcomes/cases + audit export. The audit export streams the ledger from a DB cursor (Java `StreamingResponseBody`; backend-ts paged `ReadableStream`) so memory stays bounded regardless of ledger size.
- Worklist pagination: `GET /api/cases` returns a plain array plus an `X-Total-Count` header (full filtered match count, exposed via CORS) so clients can page past the result cap.
- Headless evaluator CLI (`backend-ts/src/engine/cli/`): `pnpm evaluate --patient <bundle.json> --measure <id>` → `MeasureOutcome` JSON on stdout, no server/DB. A thin shell over `CqlExecutionEngine` (#72 / E2).

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
