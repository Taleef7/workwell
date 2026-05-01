# WorkWell Measure Studio - Architecture

## Scope
This document captures the MVP architecture baseline from `docs/PROJECT_PLAN.md`, centered on a single backend deployable and clear module boundaries.

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
- `com.workwell.run`: run orchestration and outcome persistence.
- `com.workwell.caseflow`: idempotent case upsert and case state transitions.
- `com.workwell.audit`: append-only audit event publishing and query.
- `com.workwell.valueset`: value set registry and resolvability checks.
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
