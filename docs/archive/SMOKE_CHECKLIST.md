# WorkWell Studio Smoke Checklist

Date: 2026-05-05

This checklist is the quick rehearsal verification path for MCP tools, exports, outreach delivery transitions, and admin integration sync.

## Preconditions

1. Backend API is running.
2. Frontend is running (optional for API-only checks).
3. At least one run and one open case exist in the database.

## MCP Tool Smoke (Read-Only)

Run these through your MCP client against the WorkWell MCP server:

1. `list_measures`
Expected: returns active measures with IDs, versions, and status.

2. `get_measure_version` with a valid `measureId`
Expected: returns structured spec fields, compile status, value sets, and fixtures.

3. `list_runs` with default args
Expected: returns recent runs and summary counters.

4. `get_run_summary` with and without `runId`
Expected: returns totals, pass-rate, and outcome counts.

5. `list_cases`
Expected: returns case rows with status/priority/assignee context.

6. `get_case` with a valid `caseId`
Expected: returns case detail with evidence payload and timeline.

7. `explain_outcome` with a valid `caseId`
Expected: returns summary plus supporting facts grounded in persisted evidence.

8. Audit verification
Expected: `audit_events` contains `MCP_TOOL_CALLED` events for the above invocations.

## CSV Export Smoke

1. `GET /api/exports/runs?format=csv`
Expected: `200`, `text/csv`, headers include run summary columns.

2. `GET /api/exports/outcomes?format=csv&runId=<latest-run-id>`
Expected: `200`, `text/csv`, includes outcome rows for selected run.

3. `GET /api/exports/cases?format=csv&status=open`
Expected: `200`, `text/csv`, includes current open-case rows.

4. `GET /api/audit-events/export?format=csv`
Expected: `200`, `text/csv`, includes audit trail rows.

## Outreach Delivery Transition Smoke

1. Trigger outreach:
- `POST /api/cases/{caseId}/actions/outreach`
Expected: timeline includes outreach action with `deliveryStatus=QUEUED`.

2. Mark delivery sent:
- `POST /api/cases/{caseId}/actions/outreach/delivery?deliveryStatus=SENT`
Expected: timeline includes `CASE_OUTREACH_DELIVERY_UPDATED` and `deliveryStatus=SENT`.

3. Mark delivery failed:
- `POST /api/cases/{caseId}/actions/outreach/delivery?deliveryStatus=FAILED`
Expected: timeline includes failure update and next-action guidance for retry/escalation.

## Admin Integration Sync Smoke

1. List integration health:
- `GET /api/admin/integrations`
Expected: returns `fhir`, `mcp`, `ai` rows with status + lastSyncAt.

2. Trigger manual sync:
- `POST /api/admin/integrations/{integration}/sync`
Expected: response includes updated `lastSyncAt`.

3. Audit verification
Expected: `audit_events` includes `INTEGRATION_SYNC_TRIGGERED` with integration ID and stub result payload.
