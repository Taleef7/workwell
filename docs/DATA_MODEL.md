# WorkWell Measure Studio - Data Model

## Scope
This document summarizes the MVP schema baseline from `docs/PROJECT_PLAN.md` and ADR-002 decisions used by run and case workflows.

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

## evidence_json Contract (ADR-002)
Persisted evidence payload shape:

```json
{
  "expressionResults": {
    "Initial Population": true,
    "Denominator": true,
    "Numerator": false
  },
  "evaluatedResource": [
    "Procedure/abc123",
    "Condition/def456"
  ]
}
```

Interpretation rules:
- `expressionResults` stores define-level outputs from CQL evaluation.
- `evaluatedResource` stores the concrete references used in the computed MeasureReport.
- This payload is canonical for Why Flagged rendering and audit defensibility.

## rule_path[] Contract
`rule_path[]` is not stored in the database.

UI/runtime behavior:
- derive `rule_path[]` at render time from CQL define names + `expressionResults`.
- keep derivation deterministic and traceable to persisted evidence.

## TBD before Phase 4
- Documented JSON schema versioning strategy for `evidence_json`.
- Retention/backfill rules for evidence payload changes.
- Export contract for run/outcome/case evidence in CSV/JSON deliverables.
