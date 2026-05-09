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
