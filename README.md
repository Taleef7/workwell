# WorkWell Measure Studio

WorkWell Measure Studio is a Spring Boot + Next.js monorepo for **Total Worker Health (TWH)** compliance operations. It combines measure authoring, deterministic CQL evaluation, case management, audit trails, admin tooling, and exportable evidence in one demoable stack.

## What it includes

- Measure catalog + Studio authoring for Spec, CQL, Value Sets, Tests, Traceability, and Activation Impact Preview
- Lifecycle flow: `Draft -> Approved -> Active -> Deprecated`
- Compile gate and test-fixture validation gate before activation
- Manual runs for ALL_PROGRAMS, MEASURE, and CASE scopes across Audiogram, TB Surveillance, HAZWOPER Surveillance, Flu Vaccine, and all-program views
- Case worklist, case detail, outreach, assign/escalate, rerun-to-verify, and timeline audit history
- CSV exports for runs, outcomes, cases, and audit events
- Read-only MCP tools for programmatic inspection
- AI assist surfaces for drafting and explanations, with compliance always decided by CQL

## Production surfaces

- Primary demo frontend: `https://twh.os.mieweb.org`
- Primary demo backend API: `https://twh-api.os.mieweb.org`
- Public preview frontend: `https://workwell-measure-studio.vercel.app`
- Public preview backend API: `https://workwell-measure-studio-api.fly.dev`

## Stack

- Backend: Java 21, Spring Boot 3.x, Gradle Kotlin DSL, PostgreSQL 16, Flyway
- Frontend: Next.js 16 App Router, TypeScript, Tailwind, shadcn/ui, Monaco
- CQL/FHIR: HAPI FHIR JPA + `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0
- Infra: MIE Create-a-Container (primary), Neon, GitHub Actions, pnpm (with Vercel/Fly public preview surfaces)

## Current status

- Sprint queue through Sprint 7 is implemented in the repo as of **2026-05-22**.
- Sprint 7.1–7.5 issues are closed (`#47`–`#51`), with Sprint 7.2–7.5 promoted to `main`.

## Repository layout

- `backend/` Spring Boot API, CQL evaluation, caseflow, exports, MCP, and security
- `frontend/` Next.js dashboard, Studio, admin, login, and demo UX
- `docs/` architecture, data model, deployment, demo runbook, and closeout notes

## Quick start

### Backend

```bash
cd backend
./gradlew.bat test
./gradlew.bat bootRun
```

### Frontend

```bash
cd frontend
pnpm install
pnpm lint
pnpm build
pnpm dev
```

## Key routes

- `/` public landing page with GitHub link, walkthrough video, and sandbox CTA
- `/sandbox` no-manual-login demo entry that routes into the dashboard
- `/programs` dashboard overview
- `/programs/[measureId]` measure trend/detail view
- `/runs` run history and summaries
- `/cases` worklist and filters
- `/cases/[id]` case detail, timeline, outreach, and rerun actions
- `/measures` measure catalog and create flow
- `/studio/[id]` Studio authoring for a specific measure
- `/admin` scheduler controls and integration health
- `/login` demo login entry point

## API highlights

- `GET /api/measures`
- `GET /api/measures/{id}`
- `PUT /api/measures/{id}/spec`
- `POST /api/measures/{id}/cql/compile`
- `PUT /api/measures/{id}/tests`
- `POST /api/measures/{id}/tests/validate`
- `POST /api/measures/{id}/ai/draft-cql` — generate an AI-assisted CQL draft (with fallback template)
- `POST /api/measures/{id}/ai/generate-test-fixtures` — generate five AI-assisted outcome fixtures (with fallback set)
- `GET /api/measures/{id}/data-readiness` — per-measure data readiness: required element mapping status, source freshness, missingness rate, blockers and warnings
- `GET /api/admin/data-mappings` — list all canonical data element source mappings
- `POST /api/admin/data-mappings/validate` — cross-reference integration health into mapping statuses (marks STALE on degraded source)
- `GET /api/measures/{id}/traceability` — policy-to-evidence traceability matrix with gap detection
- `POST /api/measures/{id}/impact-preview` — dry-run activation impact: outcome counts, case impact, no DB writes; writes `MEASURE_IMPACT_PREVIEWED` audit event
- `POST /api/measures/{id}/value-sets/resolve-check` — governance resolve-check: resolution status, code counts, CQL unattached reference detection, blockers/warnings
- `GET /api/value-sets/{id}/diff?to={toId}` — code-level diff between two value set versions with affected measure list
- `GET /api/value-sets/{id}/detail` — full value set detail including governance metadata and code list
- `GET /api/admin/terminology-mappings` — list local-to-standard terminology mappings with status and confidence
- `POST /api/admin/terminology-mappings` — create a new terminology mapping (PROPOSED by default)
- `GET /api/programs/{measureId}/risk-outlook?horizonDays=30` — upcoming due-soon pressure, repeat non-compliers, and site risk rates
- `GET /api/measures/{measureId}/versions/{versionId}/export/mat?format=xml` — FHIR R4 MAT-compatible bundle export; requires `ROLE_APPROVER` or `ROLE_ADMIN`
- `POST /api/runs/manual` (supports `ALL_PROGRAMS`, `MEASURE`, and `CASE` scopes)
- `GET /api/runs?limit=1`
- `GET /api/cases?status=open`
- `POST /api/cases/{caseId}/evidence` and `GET /api/evidence/{id}/download` for case evidence, restricted to case manager/admin roles
- `GET /api/admin/integrations`
- `GET /api/exports/runs?format=csv`
- `GET /api/exports/outcomes?format=csv&runId={id}`
- `GET /api/exports/cases?format=csv`
- `GET /api/auditor/cases/{caseId}/packet?format=json|html` — structured case audit packet: case summary, evidence, actions, outreach, appointments, AI assist logs, disclaimers; requires `ROLE_CASE_MANAGER` or `ROLE_ADMIN`
- `GET /api/auditor/runs/{runId}/packet?format=json|html` — structured run audit packet: run metadata, outcomes summary, logs, audit events, disclaimers; requires `ROLE_CASE_MANAGER` or `ROLE_ADMIN`
- `GET /api/auditor/measure-versions/{mvId}/packet?format=json|html` — structured measure version audit packet: spec, CQL+hash, compile result, value sets, governance, traceability, data readiness, approval history; requires `ROLE_APPROVER` or `ROLE_ADMIN`

## CSV exports

Exact export contracts live in [`docs/EXPORTS.md`](docs/EXPORTS.md).

## Docs to read next

- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/MEASURES.md`
- `docs/DEPLOY.md`
- `docs/DEMO_SCRIPT.md`
- `docs/DEMO_RUNBOOK.md`
- `docs/JOURNAL.md`

## Notes

- `POST /api/eval` is internal compatibility-only and requires `X-WorkWell-Internal: true`.
- Case rerun-to-verify re-evaluates the subject through the structured CQL path and only resolves the case when that evaluation returns a compliant or excluded outcome.
- Evidence uploads and downloads are role-protected for `ROLE_CASE_MANAGER` and `ROLE_ADMIN`; downloads resolve the linked case first and write `EVIDENCE_DOWNLOADED` audit events with sanitized filenames and content types.
- Production backend startup rejects unsafe settings: auth-off, weak or missing JWT secrets, wildcard CORS, localhost CORS in production-like profiles, and backend demo flags without an explicit public-demo override.
- Production CORS uses exact origins from `WORKWELL_CORS_ALLOWED_ORIGINS`; `https://*.vercel.app` is not allowed.
- Frontend demo prefill (`NEXT_PUBLIC_DEMO_MODE`) is local-only and the frontend build fails if it is enabled during a production build.
- Public APIs derive audit identity from the authenticated security context; they no longer accept caller-supplied `actor` or `resolvedBy` inputs.
- MCP routes remain protected through Spring Security role checks; there is no public MCP mode in production. See [`docs/MCP.md`](docs/MCP.md).
- `docs/archive/SPIKE_PLAN.md` is historical sprint context.
