# Data Readiness and Integration Mapping README

## Objective

Implement a Data Readiness Cockpit and mapping layer so WorkWell can show whether a measure has the data needed to evaluate safely.

The biggest real-world risk is not visual design; it is bad, stale, missing, or unmapped data causing incorrect outcomes. Missing data must be visible and must not be silently treated as overdue.

## Product questions to answer

- Can this measure be safely run?
- Which required data elements are missing?
- Which source system provides each field?
- Which codes are unmapped?
- Which sites/roles have stale data?
- Which employees are affected by missingness?
- What must be fixed before activation or production use?

## Files to inspect

Backend:

- `admin/*`
- `web/AdminController.java`
- `measure/MeasureService.java`
- `compile/CqlEvaluationService.java`
- `run/RunPersistenceService.java`
- Flyway migrations.

Frontend:

- `admin/page.tsx`
- `runs/page.tsx`
- `runs/[id]/page.tsx`
- `studio/[id]/page.tsx`

## Core concepts

Required data elements may include:

- employee role
- employee site
- program enrollment
- most recent audiogram date
- waiver/exemption status
- TB screening date
- flu vaccine date
- HAZWOPER clearance date
- exposure group

Each required element should have:

- source system
- mapping status
- freshness
- missingness rate
- code/value-set mapping status
- last sync timestamp
- impacted measures

## Suggested database additions

```sql
CREATE TABLE integration_sources (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ,
  last_successful_sync_at TIMESTAMPTZ,
  last_error TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE data_element_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id TEXT NOT NULL REFERENCES integration_sources(id),
  canonical_element TEXT NOT NULL,
  source_field TEXT NOT NULL,
  fhir_resource_type TEXT,
  fhir_path TEXT,
  code_system TEXT,
  mapping_status TEXT NOT NULL,
  last_validated_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE(source_id, canonical_element)
);

CREATE TABLE data_readiness_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  measure_version_id UUID REFERENCES measure_versions(id),
  run_id UUID REFERENCES runs(id),
  snapshot_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  overall_status TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
```

Mapping statuses:

- `MAPPED`
- `UNMAPPED`
- `PARTIAL`
- `STALE`
- `ERROR`

Readiness statuses:

- `READY`
- `READY_WITH_WARNINGS`
- `NOT_READY`

## Endpoints

### List mappings

```http
GET /api/admin/data-mappings
```

### Validate mappings

```http
POST /api/admin/data-mappings/validate
```

### Measure data readiness

```http
GET /api/measures/{measureId}/data-readiness
```

Response shape:

```json
{
  "overallStatus": "READY_WITH_WARNINGS",
  "requiredElements": [
    {
      "canonicalElement": "employee.role",
      "label": "Employee role",
      "sourceId": "hris",
      "mappingStatus": "MAPPED",
      "freshnessStatus": "FRESH",
      "missingnessRate": 0.01,
      "sampleMissingEmployees": ["emp-019"]
    }
  ],
  "blockers": [],
  "warnings": ["12% of eligible employees are missing audiogram procedure dates."]
}
```

## Readiness calculation

1. Read `requiredDataElements` from measure spec.
2. Map to canonical elements.
3. Check mapping exists.
4. Check source integration health.
5. Compute missingness over employee population.
6. Compute freshness.
7. Return blockers/warnings.

Minimum demo implementation can use seeded mappings and synthetic employee catalog.

## Frontend UX

### Admin Data Readiness Cockpit

Show:

- integration health cards
- data element mappings table
- mapping status filters
- last sync/freshness
- impacted measures
- validate mappings button

### Measure Studio readiness panel

Show in Release/Approval:

- required elements
- mapping status
- missingness
- freshness
- blockers/warnings
- link to Admin mapping page

### Run Detail data quality section

Show:

- missing data count
- missingness by field
- employees affected
- whether missing data created cases

## Outcome rule

Missing data is not overdue. If required evidence is missing, outcome should be `MISSING_DATA`, not `OVERDUE`, unless CQL can truly determine overdue with available data.

## Tests

- readiness endpoint returns required elements.
- unmapped element returns `NOT_READY`.
- stale source returns warning.
- missingness rate appears.
- missing data outcomes remain separate from overdue.
- mapping writes require admin.

## Acceptance criteria

- data readiness endpoint exists.
- admin or release panel shows mappings/readiness.
- missingness/freshness visible.
- missing data remains distinct.
- seeded demo mappings exist.
- tests cover mapped/unmapped/stale/missing scenarios.
