# Policy Traceability and Measure Impact Preview README

## Objective

Implement two overdelivery features that make WorkWell defensible:

1. Policy Traceability Matrix.
2. Measure Impact Preview before activation.

These answer: “Why does this rule flag someone?” and “What will happen if we activate this version?”

## Part A: Policy Traceability Matrix

### Product concept

For each measure version, show:

Policy citation/requirement -> spec field -> CQL define -> value set/code -> required data element -> test fixture -> runtime evidence -> case/action.

Example:

| Policy Requirement | Spec Field | CQL Define | Value Set | Data Element | Test Fixture | Runtime Evidence | Case Link |
|---|---|---|---|---|---|---|---|
| Annual audiogram required for hearing conservation employees | complianceWindow=Annual | `Most Recent Audiogram Date` | Audiogram Procedure Codes | Procedure.performedDateTime | emp-overdue-audiogram | last_exam_date=2025-03-10 | CASE-123 |

### Files to inspect

Backend:

- `measure/MeasureService.java`
- `compile/CqlEvaluationService.java`
- `web/MeasureController.java`
- Flyway migrations.

Frontend:

- Studio route/page or new `TraceabilityTab.tsx`.

Docs:

- `docs/MEASURES.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`

### Endpoint

Add one of:

```http
GET /api/measures/{measureId}/traceability
GET /api/measure-versions/{measureVersionId}/traceability
```

Response should include measure ID, version ID, rows, and gaps/warnings.

Minimum row fields:

- policy citation
- policy requirement
- spec field/value
- CQL define
- CQL snippet
- value sets
- required data elements
- test fixtures
- runtime evidence keys
- gaps/warnings

### How to generate initial rows

Start simple and deterministic:

- policy citation from measure policy ref / OSHA reference.
- requirements from spec JSON.
- CQL defines by parsing `define "..."` lines.
- value sets from attached value sets.
- test fixtures from spec JSON.
- runtime evidence keys from known `why_flagged` schema.
- gaps from consistency checks.

### Gap checks

Warn if:

- required data element not present in evidence.
- value set attached but not referenced in CQL.
- CQL references value set not attached.
- no fixture covers `MISSING_DATA`.
- no fixture covers `EXCLUDED`.
- missing policy citation.
- compile status not compiled.

### UI

Add a Traceability tab or section in Release & Approval:

- summary
- matrix table
- warnings panel
- export JSON/CSV
- filters by requirement, CQL define, value set, severity

### Acceptance criteria

- seeded measure displays meaningful traceability rows.
- endpoint returns structured rows.
- gaps/warnings appear.
- UI displays matrix.
- export available.

## Part B: Measure Impact Preview

### Product concept

Before approval/activation, show what this measure version would do:

- employees evaluated
- outcome counts
- cases created/updated/closed/excluded
- site/role breakdown
- warnings about missing data
- difference vs current active version if possible

### Endpoint

```http
POST /api/measures/{measureId}/impact-preview
```

Request:

```json
{
  "measureVersionId": "uuid",
  "evaluationDate": "2026-05-09",
  "scope": { "site": null, "employeeExternalId": null }
}
```

Response:

```json
{
  "populationEvaluated": 100,
  "outcomeCounts": {
    "COMPLIANT": 78,
    "DUE_SOON": 7,
    "OVERDUE": 10,
    "MISSING_DATA": 3,
    "EXCLUDED": 2
  },
  "caseImpact": {
    "wouldCreate": 13,
    "wouldUpdate": 6,
    "wouldClose": 4,
    "wouldExclude": 2
  },
  "siteBreakdown": [],
  "roleBreakdown": [],
  "warnings": []
}
```

### Rules

Impact preview is a dry run:

- do not persist official outcomes.
- do not create/update/close cases.
- may write audit event `MEASURE_IMPACT_PREVIEW_GENERATED`.
- must use same CQL evaluation logic as real runs.

### UI

Release tab should have:

- `Preview Activation Impact` button.
- outcome cards.
- case impact summary.
- site/role tables.
- warnings.
- acknowledgement checkbox before activation: “I reviewed activation impact.”

### Tests

- preview does not create outcomes/cases.
- preview uses evaluator path.
- counts returned.
- audit event written.

### Acceptance criteria

- traceability matrix exists.
- impact preview exists.
- activation flow references preview.
- preview is dry-run only.

## Implementation Progress (2026-05-09)

Status: **Complete**

### Backend — Part A (Traceability)

- `backend/src/main/java/com/workwell/measure/MeasureTraceabilityService.java` — new service; builds policy-to-evidence matrix from spec JSON, parsed CQL defines (regex), linked value sets, test fixtures, and known runtime evidence keys. Gap checks: missing policy citation, bad compile status, no test fixtures, missing MISSING_DATA/EXCLUDED fixture coverage, value sets not referenced in CQL.
- `backend/src/main/java/com/workwell/web/MeasureController.java` — `GET /api/measures/{id}/traceability` wired.
- `backend/src/test/java/com/workwell/measure/MeasureTraceabilityIntegrationTest.java` — 5 integration tests (Testcontainers, requires Docker).
- `backend/src/test/java/com/workwell/web/MeasureControllerTest.java` — controller unit tests for traceability endpoint added.

### Backend — Part B (Impact Preview)

- `backend/src/main/java/com/workwell/measure/MeasureImpactPreviewService.java` — new service; dry-run via `cqlEvaluationService.evaluate()` only; never calls `runPersistenceService` or `caseFlowService`; estimates case impact from existing open cases; writes `MEASURE_IMPACT_PREVIEWED` audit event.
- `backend/src/main/java/com/workwell/web/MeasureController.java` — `POST /api/measures/{id}/impact-preview` wired.
- `backend/src/test/java/com/workwell/measure/MeasureImpactPreviewIntegrationTest.java` — 7 integration tests verifying dry-run invariants (no outcomes/cases/runs written, audit event written, Testcontainers, requires Docker).
- `backend/src/test/java/com/workwell/web/MeasureControllerTest.java` — controller unit test for impact-preview endpoint added.

### Frontend

- `frontend/features/studio/types.ts` — added `TraceabilityValueSetRef`, `TestFixtureRef`, `TraceabilityRow`, `TraceabilityGap`, `TraceabilityResponse`, `CaseImpact`, `ImpactPreviewResponse`.
- `frontend/features/studio/components/TraceabilityTab.tsx` — summary card, error/warning gap panels, 7-column policy-to-evidence matrix table, Export JSON button.
- `frontend/features/studio/components/ImpactPreviewPanel.tsx` — "Preview Activation Impact" button, outcome count cards, case impact summary, warnings panel, "preview only" note.
- `frontend/features/studio/components/ReleaseApprovalTab.tsx` — `ImpactPreviewPanel` embedded above Activate Measure button when measure is Approved.
- `frontend/app/(dashboard)/studio/[id]/page.tsx` — "Traceability" tab added to Tab union and tab bar.

Verification: lint exit 0, build all 12 routes ✓.
