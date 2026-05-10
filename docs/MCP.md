# WorkWell MCP

WorkWell exposes a read-only MCP surface for programmatic inspection of cases, runs, measures, measure versions, structured outcome explanations, employee compliance status, and data quality gaps.

## Security boundary

- `/sse` and `/mcp/**` are protected by Spring Security.
- MCP access is role-gated to `ROLE_ADMIN`, `ROLE_CASE_MANAGER`, or `ROLE_MCP_CLIENT`.
- There is no public MCP mode in production.
- MCP tool calls are audited as `MCP_TOOL_CALLED`.
- The audit actor comes from the authenticated security context, not a hardcoded transport identity.

## Tool posture

- MCP tools are read-only.
- Tool arguments are sanitized before audit persistence.
- Invalid tool arguments return safe structured errors and still generate audit records.
- MCP tools never decide compliance; CQL remains the source of truth.
- `check_compliance` derives status from persisted CQL outcomes only — AI is never consulted.
- `explain_rule` returns deterministic metadata from measure spec and CQL; no AI is used.

## Tool inventory (v2.0.0)

### Operational read tools (v1 — preserved)

| Tool | Purpose | Role |
|------|---------|------|
| `get_case` | Full case detail by caseId | CASE_MANAGER, ADMIN, MCP_CLIENT |
| `list_cases` | Case summaries with status/measure filter | CASE_MANAGER, ADMIN, MCP_CLIENT |
| `get_run_summary` | Run metadata and outcome counts | CASE_MANAGER, ADMIN, MCP_CLIENT |
| `list_runs` | Run history with optional measure filter, bounded limit | CASE_MANAGER, ADMIN, MCP_CLIENT |
| `list_measures` | Measure catalog with lifecycle-status filter | CASE_MANAGER, ADMIN, MCP_CLIENT |
| `get_measure_version` | Latest active measure spec and CQL summary | CASE_MANAGER, ADMIN, MCP_CLIENT |
| `explain_outcome` | Deterministic explanation from case evidence fields | CASE_MANAGER, ADMIN, MCP_CLIENT |

### Agent tools (v2 — new)

| Tool | Purpose | Role |
|------|---------|------|
| `get_employee` | Employee summary + last 5 compliance outcomes | CASE_MANAGER, ADMIN |
| `check_compliance` | Latest or preview compliance status by employee/measure — no AI, no case creation | CASE_MANAGER, ADMIN |
| `list_noncompliant` | Non-compliant open cases with measure/site/status filter; default limit 25, max 100 | CASE_MANAGER, ADMIN |
| `explain_rule` | Deterministic measure rule: policy ref, eligibility, compliance window, CQL defines, value sets — no AI | CASE_MANAGER, ADMIN |
| `get_measure_traceability` | Policy-to-evidence traceability matrix rows and gaps | CASE_MANAGER, ADMIN |
| `list_data_quality_gaps` | Data readiness gaps and blockers for a measure | CASE_MANAGER, ADMIN |

## Tool schema examples

### `get_employee`
```json
{ "employeeExternalId": "emp-006" }
```
Returns: `employeeExternalId`, `name`, `role`, `site`, `active`, `latestOutcomes[]`

### `check_compliance`
```json
{
  "employeeExternalId": "emp-006",
  "measureName": "Annual Audiogram",
  "evaluationDate": "2026-05-09",
  "mode": "latest"
}
```
`mode` values: `latest` (persisted outcome), `preview` (same data, labeled preview — no new records). `complianceDecisionSource` is always `cql_outcome`.

### `list_noncompliant`
```json
{
  "measureName": "Annual Audiogram",
  "site": "Plant A",
  "status": "OVERDUE",
  "limit": 25
}
```
Valid `status` values: `DUE_SOON`, `OVERDUE`, `MISSING_DATA`. Default limit 25, max 100.

### `explain_rule`
```json
{ "measureName": "Annual Audiogram" }
```
Returns: `measureName`, `policyRef`, `description`, `eligibility`, `complianceWindow`, `requiredDataElements`, `cqlDefines[]`, `attachedValueSets[]`, `source: "deterministic_metadata"`

### `get_measure_traceability`
```json
{ "measureName": "Annual Audiogram" }
```

### `list_data_quality_gaps`
```json
{ "measureName": "Annual Audiogram" }
```

## Safe error format

Invalid arguments or missing records return a structured error — no stack traces:
```json
{
  "error": true,
  "code": "EMPLOYEE_NOT_FOUND",
  "message": "Employee not found: emp-ghost"
}
```

Error codes used: `EMPLOYEE_NOT_FOUND`, `MEASURE_NOT_FOUND`, `CASE_NOT_FOUND`, `INVALID_ARGUMENT`

## Audit record (MCP_TOOL_CALLED)

Every tool call writes an audit event regardless of success or failure:

```json
{
  "toolName": "list_noncompliant",
  "sanitizedArguments": { "measureName": "Annual Audiogram", "limit": 25 },
  "argumentHash": "<sha256>",
  "resultSize": 12,
  "success": true,
  "sensitivityLabel": "restricted",
  "timestamp": "2026-05-10T12:00:00Z"
}
```

## Operational notes

- `list_cases` and `get_case` are the primary case inspection tools.
- `get_run_summary`, `list_runs`, `list_measures`, `get_measure_version`, and `explain_outcome` expose the operational read surface.
- `get_employee` and `check_compliance` are the primary employee-facing tools.
- `list_noncompliant` is equivalent to a filtered worklist query.
- `explain_rule` replaces ad-hoc policy lookups with deterministic spec metadata.
- Any future MCP write surface must go through a separate security review and documentation update.
