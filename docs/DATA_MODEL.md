# WorkWell Measure Studio - Data Model

## 1) Scope
This document is the current schema and contract reference for the WorkWell MVP runtime.
All tables below reflect active backend behavior as of 2026-05-08.

## 2) Core Tables and Responsibilities
- `measures`: logical measure records (name, owner, tags).
- `measure_versions`: executable measure revisions (spec, CQL, compile metadata, lifecycle status).
- `osha_references`: curated OSHA/policy reference lookup used by Studio Spec authoring.
- `value_sets`: value set catalog with code payloads.
- `measure_value_set_links`: many-to-many link between versions and value sets.
- `employees`: seeded workforce entities used for evaluation/case operations.
- `runs`: execution instances + aggregate metrics.
- `run_logs`: per-run log timeline.
- `outcomes`: per-employee evaluated result rows.
- `cases`: actionable non-compliance work items.
- `case_actions`: user/system actions taken on cases.
- `audit_events`: append-only audit ledger.
- `integration_health`: persisted admin health state per integration.
- `outreach_templates`: optional DB-backed message templates (runtime falls back to built-ins if table absent).

## 3) Full Table Schemas

### 3.1 `measures`
```sql
id UUID PK DEFAULT gen_random_uuid()
name TEXT NOT NULL
policy_ref TEXT
owner TEXT
tags TEXT[]
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### 3.2 `measure_versions`
```sql
id UUID PK DEFAULT gen_random_uuid()
measure_id UUID NOT NULL REFERENCES measures(id)
osha_reference_id UUID REFERENCES osha_references(id)
version TEXT NOT NULL
status TEXT NOT NULL
spec_json JSONB NOT NULL
cql_text TEXT
compile_status TEXT
compile_result JSONB
change_summary TEXT
approved_by TEXT
activated_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE(measure_id, version)
```

### 3.3 `osha_references`
```sql
id UUID PK DEFAULT gen_random_uuid()
cfr_citation TEXT NOT NULL UNIQUE
title TEXT NOT NULL
program_area TEXT NOT NULL
```

### 3.4 `value_sets`
```sql
id UUID PK DEFAULT gen_random_uuid()
oid TEXT NOT NULL
name TEXT NOT NULL
version TEXT
codes_json JSONB NOT NULL
last_resolved_at TIMESTAMPTZ
UNIQUE(oid, version)
```

### 3.5 `measure_value_set_links`
```sql
measure_version_id UUID NOT NULL REFERENCES measure_versions(id)
value_set_id UUID NOT NULL REFERENCES value_sets(id)
PRIMARY KEY(measure_version_id, value_set_id)
```

### 3.6 `employees`
```sql
id UUID PK DEFAULT gen_random_uuid()
external_id TEXT UNIQUE NOT NULL
name TEXT NOT NULL
role TEXT
site TEXT
supervisor_id UUID REFERENCES employees(id)
fhir_patient_id TEXT
start_date DATE
active BOOLEAN DEFAULT TRUE
```

### 3.7 `runs`
```sql
id UUID PK DEFAULT gen_random_uuid()
scope_type TEXT NOT NULL
scope_id UUID
site TEXT
trigger_type TEXT NOT NULL
status TEXT NOT NULL
triggered_by TEXT
started_at TIMESTAMPTZ NOT NULL
completed_at TIMESTAMPTZ
total_evaluated INTEGER
compliant INTEGER
non_compliant INTEGER
duration_ms BIGINT
measurement_period_start TIMESTAMPTZ NOT NULL
measurement_period_end TIMESTAMPTZ NOT NULL
requested_scope_json JSONB NOT NULL DEFAULT '{}'::jsonb
failure_summary TEXT
partial_failure_count INTEGER NOT NULL DEFAULT 0
dry_run BOOLEAN NOT NULL DEFAULT FALSE
```

Runtime status values observed in the current implementation include `REQUESTED`, `QUEUED`, `RUNNING`, `PARTIAL_FAILURE`, `COMPLETED`, `FAILED`, and `CANCELLED`.
For measure/case runs, `scope_id` stores the resolved measure version UUID; for all-programs runs it remains null.

### 3.8 `run_logs`
```sql
id BIGSERIAL PK
run_id UUID NOT NULL REFERENCES runs(id)
ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
level TEXT NOT NULL
message TEXT NOT NULL
```

### 3.9 `outcomes`
```sql
id UUID PK DEFAULT gen_random_uuid()
run_id UUID NOT NULL REFERENCES runs(id)
employee_id UUID NOT NULL REFERENCES employees(id)
measure_version_id UUID NOT NULL REFERENCES measure_versions(id)
evaluation_period TEXT NOT NULL
status TEXT NOT NULL
evidence_json JSONB NOT NULL
evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
INDEX outcomes_employee_measure_period_idx(employee_id, measure_version_id, evaluation_period)
INDEX outcomes_run_id_idx(run_id)
```

### 3.10 `cases`
```sql
id UUID PK DEFAULT gen_random_uuid()
employee_id UUID NOT NULL REFERENCES employees(id)
measure_version_id UUID NOT NULL REFERENCES measure_versions(id)
evaluation_period TEXT NOT NULL
status TEXT NOT NULL
priority TEXT NOT NULL
assignee TEXT
next_action TEXT
current_outcome_status TEXT NOT NULL
last_run_id UUID NOT NULL REFERENCES runs(id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
closed_at TIMESTAMPTZ
UNIQUE(employee_id, measure_version_id, evaluation_period)
```

### 3.11 `case_actions`
```sql
id UUID PK DEFAULT gen_random_uuid()
case_id UUID NOT NULL REFERENCES cases(id)
action_type TEXT NOT NULL
payload_json JSONB
performed_by TEXT
performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### 3.12 `audit_events`
```sql
id BIGSERIAL PK
event_type TEXT NOT NULL
entity_type TEXT NOT NULL
entity_id UUID
actor TEXT
ref_run_id UUID
ref_case_id UUID
ref_measure_version_id UUID
payload_json JSONB
occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
INDEX audit_events_ref_run_id_idx(ref_run_id)
INDEX audit_events_ref_case_id_idx(ref_case_id)
```

### 3.13 `integration_health`
```sql
id TEXT PK
display_name TEXT NOT NULL
status TEXT NOT NULL
last_sync_at TIMESTAMPTZ
last_sync_result TEXT
config_json JSONB NOT NULL DEFAULT '{}'::jsonb
```
Seeded IDs: `fhir`, `mcp`, `ai`, `hris`.

### 3.14 `outreach_templates` (optional migration-safe table)
Expected runtime schema:
```sql
id UUID PK DEFAULT gen_random_uuid()
name TEXT NOT NULL
subject TEXT NOT NULL
body_text TEXT NOT NULL
measure_id UUID REFERENCES measures(id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```
If this table is absent, service falls back to built-in default templates.

## 4) Idempotency Contract for Case Upsert
Constraint: `UNIQUE(employee_id, measure_version_id, evaluation_period)`.

### Worked Example
Inputs:
- employee: `emp-006`
- measure version: Audiogram `v1.0`
- evaluation period: `2026-05-06`

Run A outcome: `OVERDUE`
- No existing row -> insert new `cases` row (`status=OPEN`, `priority=HIGH`).

Run B outcome (same key): `OVERDUE`
- Conflict on unique key -> update same row (`updated_at`, `last_run_id`, `next_action`, etc.).
- No duplicate case created.

Run C outcome (same key): `COMPLIANT`
- Existing row is resolved (`status=RESOLVED`, `closed_at=NOW()`).

## 5) `evidence_json` Contract (authoritative)

### Canonical shape
```json
{
  "expressionResults": [
    { "define": "In Hearing Conservation Program", "result": true },
    { "define": "Has Active Waiver", "result": false },
    { "define": "Most Recent Audiogram Date", "result": "2025-03-10T00:00:00Z" },
    { "define": "Days Since Last Audiogram", "result": 420 },
    { "define": "Outcome Status", "result": "OVERDUE" }
  ],
  "evaluatedResource": {
    "patientId": "emp-006",
    "measureId": "audiogram",
    "measurementPeriod": {
      "start": "2025-05-06T00:00:00Z",
      "end": "2026-05-06T00:00:00Z"
    }
  },
  "why_flagged": {
    "last_exam_date": "2025-03-10",
    "compliance_window_days": 365,
    "days_overdue": 55,
    "role_eligible": true,
    "site_eligible": true,
    "waiver_status": "NONE",
    "outcome_status": "OVERDUE"
  }
}
```

### Field-by-field meaning
- `expressionResults`: raw define outputs from the CQL engine used for traceability.
- `evaluatedResource`: resource-level context used during evaluation.
- `why_flagged`: derived/explainer fields used by UI for readable case diagnostics.

If evaluation fails for one employee, `evidence_json` includes:
```json
{ "evaluationError": "CQL engine failure", "message": "<error text>" }
```
with status forced to `MISSING_DATA`.

## 6) CSV Export Contracts

### 6.1 `GET /api/exports/runs?format=csv`
Columns:
`runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf`

### 6.2 `GET /api/exports/outcomes?format=csv&runId={optional}`
Columns:
`outcomeId, runId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, lastExamDate, complianceWindowDays, daysOverdue, roleEligible, siteEligible, waiverStatus, evaluatedAt`

### 6.3 `GET /api/exports/cases?format=csv`
Columns:
`caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus`

Supports filters: `status`, `measureId`, `priority`, `assignee`, `site`, `caseIds`.

### 6.4 `GET /api/audit-events/export?format=csv`
Audit event export is append-only and includes event metadata + payload snapshot for timeline reconstruction.
