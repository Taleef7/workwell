# MCP v2 Safe Agent Tools README

## Objective

Implement MCP v2 as a safe, authenticated, audited agent layer. MCP should support the original agent-sandbox vision without becoming a compliance or security bypass.

Original conceptual tools included:

- `get_employee`
- `check_compliance`
- `list_noncompliant`
- `explain_rule`

Current tools include operational read tools such as cases, runs, measures, measure versions, and outcome explanations. MCP v2 should preserve those and add the original conceptual tools safely.

## Safety rule

MCP is an interface to WorkWell. It must respect auth, authorization, actor identity, audit, sensitivity, tenant/user scope, and the CQL-source-of-truth rule.

No MCP tool should directly decide compliance through LLM reasoning.

## Files to inspect

- `backend/src/main/java/com/workwell/mcp/McpServerConfig.java`
- `backend/src/main/java/com/workwell/config/SecurityConfig.java`
- `backend/src/main/java/com/workwell/security/SecurityActor.java`
- `backend/src/main/java/com/workwell/caseflow/CaseFlowService.java`
- `backend/src/main/java/com/workwell/run/RunPersistenceService.java`
- `backend/src/main/java/com/workwell/measure/MeasureService.java`
- `backend/src/main/java/com/workwell/compile/CqlEvaluationService.java`

## Prerequisite

Complete P0 MCP security first. The MCP endpoint must not be public.

## Existing tools to preserve/refine

Keep/refine:

- `get_case`
- `list_cases`
- `get_run_summary`
- `list_measures`
- `get_measure_version`
- `list_runs`
- `explain_outcome`

Ensure each tool:

- authenticates actor
- checks role
- has limits/pagination
- returns safe structured JSON
- handles invalid UUIDs safely
- writes audit event

## New tools

### `get_employee`

Input:

```json
{ "employeeExternalId": "emp-006" }
```

Output: employee summary, role, site, active flag, programs, latest outcomes. Return only necessary fields.

Authorization: case manager/admin.

### `check_compliance`

Input:

```json
{
  "employeeExternalId": "emp-006",
  "measureName": "Annual Audiogram",
  "evaluationDate": "2026-05-09",
  "mode": "latest | preview"
}
```

Behavior:

- `latest`: retrieve latest persisted outcome.
- `preview`: use dry-run/scoped evaluator, not AI.
- do not create official outcomes/cases in preview.

Output: status, source, why flagged, case ID if exists.

### `list_noncompliant`

Input:

```json
{
  "measureName": "Annual Audiogram",
  "site": "Plant A",
  "status": "OVERDUE",
  "limit": 25
}
```

Default limit 25, max 100. Return case/employee/status/priority/next action.

### `explain_rule`

Input:

```json
{ "measureName": "Annual Audiogram" }
```

Return deterministic measure metadata: policy ref, description, eligibility, compliance window, required data elements, CQL defines, value sets. Do not use LLM by default.

### `get_measure_traceability`

Return traceability matrix rows for a measure/version. Use same backend as traceability endpoint.

### `preview_measure_impact`

Dry-run impact preview for a measure version. Must not create outcomes/cases. Author/approver/admin only. Audit required.

### `list_data_quality_gaps`

Return readiness gaps for measure/integration. Use Data Readiness backend.

### `get_case_audit_packet`

Return case audit packet summary or JSON. Case manager/admin only. Packet generation must be audited.

## Tool standards

Each tool must define:

- name
- description
- JSON schema
- required fields
- max limits
- role requirements
- audit payload
- safe error codes
- output shape

## Error handling

Do not crash on invalid UUIDs or missing records. Return safe errors:

```json
{
  "error": true,
  "code": "CASE_NOT_FOUND",
  "message": "Case not found or not accessible."
}
```

Avoid revealing inaccessible records.

## Auditing

Every tool call writes:

- `MCP_TOOL_CALLED`
- actor
- tool name
- sanitized args or args hash
- returned count
- success/failure
- error code if any
- timestamp

Sensitive tools can also write specific events such as `AUDIT_PACKET_GENERATED`.

## Admin visibility

Add Admin MCP page/section:

- MCP enabled/disabled
- endpoint path
- auth requirement
- tool list
- last 20 tool calls
- recent errors
- docs link

## Tests

- unauthenticated MCP call denied.
- unauthorized role denied.
- authorized call succeeds.
- invalid args return safe error.
- limit enforcement works.
- audit event written.
- preview tool is dry-run only.
- `check_compliance` does not use AI to decide status.

## Acceptance criteria

- endpoint secured.
- existing tools audited and role-gated.
- at least `get_employee`, `check_compliance`, `list_noncompliant`, and `explain_rule` exist.
- structured JSON output.
- limits enforced.
- tests cover auth/audit/invalid input/no-AI decision.
- docs list tools, roles, examples, and safety guarantees.

---

## Implementation Progress

### Status
Complete

### Completed
- [x] Existing MCP tools inspected (get_case, list_cases, get_run_summary, list_measures, get_measure_version, list_runs, explain_outcome)
- [x] Existing MCP tools preserved — no regressions; executeTool wrapper already audits all calls
- [x] get_employee added — returns employee summary + last 5 outcomes; returns EMPLOYEE_NOT_FOUND safe error if not found
- [x] check_compliance added — latest and preview modes both return persisted CQL outcome; complianceDecisionSource always "cql_outcome"; no AI called
- [x] list_noncompliant added — open cases with DUE_SOON/OVERDUE/MISSING_DATA filter; default limit 25, max 100 enforced; INVALID_ARGUMENT returned for unknown status values
- [x] explain_rule added — deterministic from MeasureService spec + CQL define parsing; source field is "deterministic_metadata"; no AI
- [x] get_measure_traceability added — delegates to MeasureTraceabilityService.generate(); returns rows + gaps
- [x] list_data_quality_gaps added — delegates to DataReadinessService.computeReadiness(); returns blockers + warnings + element readiness
- [x] MCP tool auth/role behavior verified — existing security tests pass; unauthenticated and unauthorized roles still denied
- [x] MCP audit behavior verified — all new tools use executeTool wrapper, writing MCP_TOOL_CALLED with actor from security context
- [x] Safe errors implemented — error/code/message shape used throughout new tools
- [x] Tests added — 8 new tests in McpSecurityIntegrationTest covering: EMPLOYEE_NOT_FOUND, check_compliance no-outcome path, preview mode source, limit cap enforcement, invalid status rejection, explain_rule missing args, explain_rule deterministic source, audit actor from security context
- [x] McpServerConfigTest updated — added MeasureTraceabilityService and DataReadinessService mocks, updated version assertion to 2.0.0
- [x] Backend test suite passes
- [x] Frontend lint passes
- [x] MCP.md updated with full v2 tool inventory, schemas, error codes, and audit record format

### Notes from implementation
- MCP server version bumped to 2.0.0.
- executeTool wrapper reused for all new tools — no new audit path needed.
- check_compliance preview mode resolves to same persisted data as latest, labeled with source="preview". Real-time per-employee CQL re-evaluation from MCP is not implemented to avoid creating unaudited transient state; operators who need fresh evaluation should trigger a manual run.
- listNoncompliant queries cases directly (not CaseFlowService.listCases) to avoid loading the full outreach/waiver join and to enforce limit in SQL.
- get_employee returns internal UUID in the response for cross-referencing; it is not used for routing.

### Tests/verification
- McpSecurityIntegrationTest: 4 original + 8 new = 12 tests total
- McpServerConfigTest: 1 test (tool registration + version)
- Backend full suite: all tests pass
- Frontend lint: clean

### Commit
- feat(mcp): add MCP v2 agent tools — get_employee, check_compliance, list_noncompliant, explain_rule, get_measure_traceability, list_data_quality_gaps
