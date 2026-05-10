# WorkWell Studio Agent Handoff and Execution Order

## Purpose

This is the master implementation handoff for the coding agent. The project should be treated as a serious occupational-health compliance prototype, not as a generic dashboard. WorkWell Studio’s goal is to convert OSHA/internal medical-surveillance requirements into versioned, executable, testable CQL/eCQM logic, run that logic against employee health data, and operationalize non-compliant outcomes as auditable follow-up cases.

Core product chain:

1. Policy or OSHA requirement -> structured measure spec.
2. Structured spec -> CQL/eCQM logic.
3. CQL/eCQM logic -> measure run over employees.
4. Measure run -> per-employee outcome and structured evidence.
5. Non-compliant outcome -> idempotent case worklist item.
6. Case action -> outreach, scheduling, evidence, verification, closure.
7. Every edit/run/action -> audit trail.
8. AI and MCP assist only; they do not decide compliance.

## Current repo assumption

Assume the app already has Spring Boot backend, Next.js frontend, PostgreSQL/Flyway, measure catalog/studio, spec/CQL/value sets/tests/release tabs, manual runs, outcomes, cases, evidence, outreach, audit/export, AI assistive endpoints, and MCP read tools. Do not rebuild from scratch. Harden and extend.

## Critical invariants

1. CQL is the source of truth for compliance status.
2. AI cannot set compliance outcomes.
3. MCP cannot bypass authentication, authorization, auditing, or tenant/user scope.
4. Missing data must stay distinct from non-compliance.
5. Manual closure must not be mislabeled as CQL-compliant closure.
6. Excluded/waived employees must not create active outreach noise.
7. Audit actor must come from authenticated security context, not query params.
8. Case idempotency should remain employee + measure version + evaluation period unless deliberately redesigned.
9. Synthetic/demo behavior must be explicitly labeled.
10. Production config must be stricter than demo config.

## Execution order

### Phase 0: P0 correctness and security

Start with:

- `README_01_P0_SECURITY_AND_CORRECTNESS.md`
- `README_08_TESTING_CI_AND_DOCS_SYNC.md`

Fix MCP auth, actor spoofing, rerun-to-verify, evidence authorization, CORS, production startup checks, and regression tests.

### Phase 1: Operational credibility

Then implement:

- `README_02_SCOPED_RUNS_AND_RUN_JOB_MODEL.md`
- `README_03_FRONTEND_API_AND_UI_REFACTOR.md`

Add scoped runs, durable run states/logs, case-scoped verification, typed frontend API client, and componentized Measure Studio.

### Phase 2: Overdelivery features

Then implement:

- `README_04_POLICY_TRACEABILITY_AND_IMPACT_PREVIEW.md`
- `README_05_DATA_READINESS_AND_INTEGRATION_MAPPING.md`
- `README_06_VALUE_SET_TERMINOLOGY_GOVERNANCE.md`
- `README_07_AUDITOR_MODE_AND_EXPORT_PACKET.md`
- `README_09_MCP_V2_SAFE_AGENT_TOOLS.md`

These make WorkWell feel like a defensible enterprise compliance product.

## Repo hygiene

For every change: create a small branch, add tests, update docs, avoid demo shortcuts in production paths, do not weaken security silently, keep frontend/backend contracts aligned, and prefer explicit failure states over fake success.

## Suggested branches

- `fix/p0-secure-mcp`
- `fix/p0-remove-actor-spoofing`
- `fix/p0-rerun-verification-cql`
- `fix/p0-evidence-authorization`
- `feat/scoped-manual-runs`
- `feat/run-job-model`
- `refactor/frontend-api-client`
- `refactor/measure-studio-tabs`
- `feat/policy-traceability`
- `feat/impact-preview`
- `feat/data-readiness-cockpit`
- `feat/value-set-governance`
- `feat/auditor-packet`
- `feat/mcp-v2-safe-tools`

## Overall definition of done

The sprint is successful when P0 risks are fixed and tested, scoped runs work for All Programs/Measure/Case, rerun-to-verify uses real evaluation, frontend fetch behavior is explicit and typed, Measure Studio is componentized, traceability/impact/data readiness/value set governance/audit packets/MCP v2 have at least minimum viable implementations, and docs describe actual behavior accurately.
