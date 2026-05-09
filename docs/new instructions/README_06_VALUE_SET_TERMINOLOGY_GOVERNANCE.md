# Value Set and Terminology Governance README

## Objective

Evolve WorkWell’s value set feature into a credible terminology governance layer. Real compliance logic depends on stable codes, versions, local mappings, and terminology drift visibility.

## Product questions

- Which value sets does this measure depend on?
- Which version is locked to this measure version?
- Are all referenced value sets resolvable?
- What changed between two versions?
- Which measures are affected by a value set change?
- Are local codes mapped to standard terminology?
- Can a measure activate with unresolved value sets?

## Files to inspect

Backend:

- `measure/MeasureService.java`
- `web/MeasureController.java`
- CQL compile/value set parsing logic
- Flyway migrations

Frontend:

- Studio Value Sets tab
- Admin pages if any

Docs:

- `docs/MEASURES.md`
- `docs/DATA_MODEL.md`
- `docs/ARCHITECTURE.md`

## Concepts

Value set fields:

- ID
- OID or canonical URL
- name
- version
- code systems
- codes JSON
- expansion timestamp
- source
- last resolved timestamp
- resolvability status
- owner/status

Code fields:

- code
- display
- system
- version
- active/inactive

Mapping fields:

- local code/display/system
- standard code/display/system
- confidence
- mapping status
- reviewer/date

## Database additions

Extend `value_sets` if needed:

```sql
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS canonical_url TEXT;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS code_systems TEXT[] DEFAULT '{}';
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS expansion_hash TEXT;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
ALTER TABLE value_sets ADD COLUMN IF NOT EXISTS created_by TEXT;
```

Add terminology mappings:

```sql
CREATE TABLE terminology_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  local_code TEXT NOT NULL,
  local_display TEXT,
  local_system TEXT NOT NULL,
  standard_code TEXT NOT NULL,
  standard_display TEXT,
  standard_system TEXT NOT NULL,
  mapping_status TEXT NOT NULL,
  mapping_confidence NUMERIC,
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  UNIQUE(local_system, local_code, standard_system, standard_code)
);
```

## Endpoints

```http
GET /api/value-sets?query=&status=&codeSystem=
GET /api/value-sets/{id}
GET /api/value-sets/{id}/diff?to={otherValueSetId}
POST /api/measures/{measureId}/value-sets/resolve-check
GET /api/admin/terminology-mappings
POST /api/admin/terminology-mappings
PUT /api/admin/terminology-mappings/{id}
```

## Resolve check response

```json
{
  "measureId": "uuid",
  "allResolved": false,
  "valueSets": [
    { "id": "uuid", "name": "Audiogram Procedure Codes", "status": "RESOLVED", "codeCount": 12 },
    { "id": "uuid", "name": "Local Waiver Codes", "status": "UNRESOLVED", "issue": "No codes in expansion" }
  ]
}
```

## Activation gate rules

Block activation if:

- CQL references value set not attached.
- attached value set has zero codes.
- attached value set unresolved.
- required local mapping unresolved.
- production-like measure lacks pinned value set version.

Warn if:

- value set is stale.
- newer version exists.
- optional mappings unreviewed.
- code count changed significantly.

## UI

### Measure Studio Value Sets tab

Show:

- attached value sets
- OID/canonical URL
- version
- code count
- resolvability status
- last resolved timestamp
- warnings
- attach/detach
- resolve check
- diff viewer

### Admin Terminology page

Show:

- value set catalog
- search/filter
- code count
- linked measures
- local mappings
- unmapped local code warnings

### Release readiness card

Include:

- attached value sets pass/fail
- resolved pass/fail
- version pinned warn/pass
- mappings reviewed warn/fail/pass

## Demo implementation approach

Do not build full terminology-server integration yet. Start with:

- seeded value set metadata
- expansion hash from sorted codes JSON
- diff from codes JSON
- simple CQL text scan for value set references
- static/demo local mappings
- TODO for real terminology server

## Tests

- unresolved value set blocks activation.
- zero-code value set blocks activation.
- diff identifies added/removed codes.
- CQL referenced but unattached value set produces blocker.
- admin-only mapping writes are protected.

## Acceptance criteria

- value sets are version-aware.
- resolve-check endpoint exists.
- activation readiness includes value set blockers/warnings.
- diff works for seeded value sets.
- UI shows governance status clearly.
- tests cover unresolved/zero-code/stale/diff scenarios.
