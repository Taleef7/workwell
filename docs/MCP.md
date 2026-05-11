# WorkWell MCP

WorkWell exposes a read-only MCP surface for programmatic inspection of cases, runs, measures, measure versions, structured outcome explanations, employee compliance status, and data quality gaps.

## Security boundary

MCP security is enforced at two layers:

**Transport access** — `/sse` and `/mcp/**` require one of:
- `ROLE_ADMIN`
- `ROLE_CASE_MANAGER`
- `ROLE_MCP_CLIENT`

**Tool execution** — each tool enforces its own application-role policy before running any query. `ROLE_MCP_CLIENT` alone is **not** sufficient to read employee, case, or compliance data. A service account that needs to call restricted tools must also hold a data-access role (`ROLE_CASE_MANAGER` or `ROLE_ADMIN`).

- There is no public MCP mode in production.
- MCP tool calls are audited as `MCP_TOOL_CALLED` regardless of outcome (including access-denied).
- The audit actor comes from the authenticated security context, not a hardcoded transport identity.
- Denied tool calls return a structured `ACCESS_DENIED` safe error and are audited with `success=false`.

## Tool posture

- MCP tools are read-only.
- Tool arguments are sanitized before audit persistence.
- Invalid tool arguments return safe structured errors and still generate audit records.
- MCP tools never decide compliance; CQL remains the source of truth.
- `check_compliance` derives status from persisted CQL outcomes only — AI is never consulted.
- `explain_rule` returns deterministic metadata from measure spec and CQL; no AI is used.

## Tool inventory (v2.0.0)

### Tool role matrix

The table below shows **tool-execution** roles (transport access is separate — see above).

| Tool | Required application roles | Data sensitivity |
|------|---------------------------|-----------------|
| `get_case` | CASE_MANAGER, ADMIN | Restricted — employee/case data |
| `list_cases` | CASE_MANAGER, ADMIN | Restricted — employee/case data |
| `get_run_summary` | CASE_MANAGER, ADMIN | Restricted — run/outcome data |
| `list_runs` | CASE_MANAGER, ADMIN | Restricted — run/outcome data |
| `explain_outcome` | CASE_MANAGER, ADMIN | Restricted — employee/case evidence |
| `get_employee` | CASE_MANAGER, ADMIN | Restricted — employee/compliance data |
| `check_compliance` | CASE_MANAGER, ADMIN | Restricted — employee/compliance data |
| `list_noncompliant` | CASE_MANAGER, ADMIN | Restricted — employee/case data |
| `list_measures` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — measure catalog |
| `get_measure_version` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — measure spec/CQL |
| `explain_rule` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — deterministic metadata |
| `get_measure_traceability` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — traceability matrix |
| `list_data_quality_gaps` | AUTHOR, APPROVER, CASE_MANAGER, ADMIN | Internal — data readiness |

`ROLE_MCP_CLIENT` alone does not grant access to any tool. It only permits connection to the MCP transport. A service account must additionally hold the relevant data-access role.

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
`mode` values: `latest` (persisted outcome), `preview` (same data, labeled preview — no new records). `complianceDecisionSource` is always `cql_outcome`. `decisionAvailable` is `true` when an outcome row exists and `false` when the status is `NO_OUTCOME`.

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

Error codes used: `ACCESS_DENIED`, `EMPLOYEE_NOT_FOUND`, `MEASURE_NOT_FOUND`, `CASE_NOT_FOUND`, `INVALID_ARGUMENT`

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
