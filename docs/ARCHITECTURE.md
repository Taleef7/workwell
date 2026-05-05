# WorkWell Measure Studio - Architecture

## Scope
This document captures the MVP architecture baseline from `docs/SPIKE_PLAN.md`, centered on a single backend deployable and clear module boundaries.

## Deployment Rationale (ADR-001)
The project runs as one Spring Boot deployable plus one Next.js frontend during MVP. This keeps the system operationally simple while the highest-risk work (CQL evaluation integration, idempotent caseflow behavior, and evidence traceability) is still being validated.

Why this is the default:
- 13-week timeline favors fast vertical slices over distributed service overhead.
- One runtime boundary reduces local setup and CI complexity.
- Domain package boundaries preserve a clean seam for future extraction.

## Runtime Topology
- Frontend: Next.js dashboard shell and workflow UI.
- Backend: Spring Boot API + orchestration logic.
- Datastores/services: Postgres app DB, HAPI FHIR server, optional AI provider in Phase 4.

## Backend Domain Package Layout
- `com.workwell.measure`: measure catalog and version lifecycle.
- `com.workwell.compile`: CQL compile/validate APIs.
- `com.workwell.run`: run orchestration, outcome persistence, and latest-run readback.
- `com.workwell.caseflow`: idempotent case upsert, case state transitions, simulated outreach action logging, rerun-to-verify closure flow, and Why Flagged readback.
- `com.workwell.audit`: append-only audit event publishing and query.
- `com.workwell.valueset`: value set registry and resolvability checks.
- `com.workwell.ai`: guardrailed AI assist for Draft Spec and Explain Why Flagged (advisory-only).
- `com.workwell.export`: CSV export services for runs/outcomes/cases.
- `com.workwell.admin`: admin integrations health and manual sync stubs.
- `com.workwell.mcp`: read-only MCP server tools for measure/run/case retrieval.

## Seam for Future Split
If post-MVP scale or team ownership requires service decomposition, package boundaries are the extraction seam:
- `run` + `compile` can split behind an internal API first.
- `caseflow` can split once run-output contracts are stable.
- `mcp` can remain separately deployable earlier because it is read-only.

No split is planned in MVP unless a specific bottleneck forces it.

## TBD before Phase 3
- Sequence diagram for the full run pipeline (`evaluateMeasureWithCqlEngine -> evaluateMeasure(compositeResults)` plus outcome/case writes).
- Interface contracts between `run` and `caseflow` modules (event payload schema).
- Deployment topology decision for demo vs pilot (single host vs container platform).

## Current API Surface (MVP live)
Caseflow:
- `GET /api/cases`
- `GET /api/cases/{id}`
- `POST /api/cases/{id}/actions/outreach` (simulated outreach action; audit logged)
- `POST /api/cases/{id}/actions/outreach/delivery?deliveryStatus=QUEUED|SENT|FAILED` (persist simulated delivery lifecycle)
- `POST /api/cases/{id}/rerun-to-verify` (case-level verification rerun; closes case when verified compliant)
- `POST /api/cases/{id}/assign`
- `POST /api/cases/{id}/escalate`

Reporting:
- `GET /api/exports/runs?format=csv`
- `GET /api/exports/outcomes?format=csv&runId={optional}`
- `GET /api/exports/cases?format=csv`
- `GET /api/audit-events/export?format=csv`

Admin integrations:
- `GET /api/admin/integrations`
- `POST /api/admin/integrations/{integration}/sync`

AI:
- `POST /api/measures/{id}/ai/draft-spec`
- `POST /api/cases/{id}/explain`

MCP:
- Read-only tool layer including `get_case`, `list_cases`, `get_run_summary`, `list_measures`, `get_measure_version`, `list_runs`, `explain_outcome`.
