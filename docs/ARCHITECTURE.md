# WorkWell Measure Studio - Architecture

## 1) System Overview
WorkWell Measure Studio is a two-tier web application:
- Frontend: Next.js App Router dashboard on Vercel.
- Backend: Spring Boot API on Fly.io.
- Data: PostgreSQL 16 (Neon) with Flyway migrations.
- Optional assistive surfaces: OpenAI-backed Spring AI calls for drafting/explanations (never compliance decisions).

Compliance outcomes are determined only by CQL evaluation + structured evidence persistence.

## 2) Deployment Topology

```text
Browser
  -> Vercel (Next.js frontend)
      -> Fly.io (Spring Boot API)
          -> Neon Postgres (primary app DB)
          -> CQL engine in-process (cqf-fhir-cr + HAPI FHIR model)
          -> OpenAI API (assistive text only)
          -> MCP read interface (/sse + tools)
```

Production endpoints:
- Frontend: `https://frontend-seven-eta-24.vercel.app`
- Backend: `https://workwell-measure-studio-api.fly.dev`

## 3) Backend Module Boundaries (`com.workwell.*`)
- `measure`: measure catalog, versioning, lifecycle transitions.
- `valueset`: value set registry and measure/value-set linkage.
- `compile`: CQL translator compile validation and compile metadata.
- `fhir`: measure library/resource assembly used by evaluation runtime.
- `run`: run orchestration, run detail/summary read models, rerun scope support.
- `caseflow`: case upsert/resolution, outreach + delivery-state + rerun-to-verify, case detail timeline.
- `audit`: append-only audit event publisher + export/query paths.
- `export`: runs/outcomes/cases CSV contracts.
- `integrations`: integration service adapters/checks.
- `admin`: scheduler settings, integration health, outreach template APIs.
- `ai`: AI draft spec, explain-why-flagged, run insight surfaces with deterministic fallback.
- `mcp`: read-only MCP tools and tool-call audit logging.
- `notification`: outreach preview/composition support.
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
1. User triggers manual run (`/api/runs/manual` or scoped run endpoint).
2. Run row inserted in `runs`.
3. For each employee:
   - Synthetic FHIR bundle is constructed from employee profile + exam config.
   - CQL engine evaluates measure defines against in-memory FHIR repository.
   - `Outcome Status` define determines bucket (`COMPLIANT|DUE_SOON|OVERDUE|MISSING_DATA|EXCLUDED`).
   - Define-level `expressionResults` are captured into `outcomes.evidence_json`.
4. Run summary counters are finalized in `runs`.

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
- Public API actor identity always comes from Spring Security; caller-supplied actor fields are ignored or removed.
- Production startup is fail-fast: the backend refuses auth-disabled, weak-secret, wildcard-CORS, localhost-CORS-in-production, or backend-demo configurations when a production-like profile is active.
- Production CORS uses exact allowed origins from `workwell.cors.allowed-origins`; wildcard Vercel patterns are not used.
- Frontend demo prefill is a local convenience only; `NEXT_PUBLIC_DEMO_MODE=true` fails the production frontend build.

## 7) External Interfaces
- REST API: measure, run, case, admin, export endpoints.
- REST API: evidence upload/download on case detail, role-gated to case manager/admin.
- MCP: read-only tools with per-call audit events and Spring Security role gates on `/sse` and `/mcp/**`.
- MCP tool audit actors come from the authenticated security context, not a hardcoded transport identity.
- CSV exports: runs/outcomes/cases + audit export.

## 8) Current Infra Split
- Fly.io hosts backend process and serves REST + MCP SSE.
- Vercel hosts frontend only.
- Neon hosts all relational persistence used by backend.

No microservice decomposition is used in MVP; package boundaries are the future extraction seam.
