# WorkWell Measure Studio - Data Model

## Scope
This document summarizes the MVP schema baseline from `docs/SPIKE_PLAN.md` and ADR-002 decisions used by run and case workflows.

## Six Core Tables
1. `measures`: logical measure catalog records.
2. `measure_versions`: executable/versioned definitions and compile metadata.
3. `runs`: each execution instance with scope, timing, and summary counters.
4. `outcomes`: per employee x measure_version result rows with `evidence_json`.
5. `cases`: operational worklist records derived from non-compliant outcomes.
6. `audit_events`: append-only state-change ledger across measure/run/case actions.

Supporting tables in the same baseline include `value_sets`, `measure_value_set_links`, `employees`, `run_logs`, and `case_actions`.

## Idempotency Contract (Case Upsert)
`cases` must enforce:
- `UNIQUE(employee_id, measure_version_id, evaluation_period)`

This is the non-negotiable invariant that prevents duplicate worklist cases on reruns for the same evaluation scope.

Case lifecycle rules used by the seeded measure slices:
- `DUE_SOON`, `OVERDUE`, and `MISSING_DATA` outcomes create or refresh open cases.
- `COMPLIANT` and `EXCLUDED` outcomes do not create new active cases; if a matching case already exists, it is closed on rerun.
- The `audit_events` table holds the per-case timeline that powers the Why Flagged detail view.
- `case_actions` stores operator actions (for current MVP: `OUTREACH_SENT`, `OUTREACH_DELIVERY_UPDATED`, `RERUN_TO_VERIFY`, `ASSIGNED`, `ESCALATED`) with JSON payloads and performer/timestamp metadata.
- Case-level rerun verification persists a dedicated run row and a verification outcome row before case closure, preserving run/case linkage in `audit_events`.
- Outreach delivery lifecycle is persisted as payload state (`deliveryStatus` = `QUEUED|SENT|FAILED`) and exposed on case detail as latest delivery state.

## evidence_json Contract (ADR-002)
Persisted evidence payload shape:

```json
{
  "expressionResults": [
    { "define": "In Hearing Conservation Program", "result": true },
    { "define": "Has Active Waiver", "result": false },
    { "define": "Days Since Last Audiogram", "result": 120 }
  ],
  "evaluatedResource": {
    "patientId": "patient-001",
    "daysSinceLastAudiogram": 120,
    "hasActiveWaiver": false,
    "measurementWindowDays": 365
  }
}
```

Interpretation rules:
- `expressionResults` stores define-level outputs from CQL evaluation as an ordered array.
- `evaluatedResource` stores the concrete resource and scalar context used in the computed MeasureReport.
- This payload is canonical for Why Flagged rendering and audit defensibility.

## rule_path[] Contract
`rule_path[]` is not stored in the database.

UI/runtime behavior:
- derive `rule_path[]` at render time from CQL define names + `expressionResults`.
- keep derivation deterministic and traceable to persisted evidence.

## TBD before Phase 4
- Documented JSON schema versioning strategy for `evidence_json`.
- Retention/backfill rules for evidence payload changes.
- CSV export contract is now defined in `README.md` for runs/outcomes/cases; future work can add explicit contract-version headers if schemas evolve.
