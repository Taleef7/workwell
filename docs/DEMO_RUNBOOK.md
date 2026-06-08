# Last updated: 2026-06-08 (capture-based; originally verified 2026-05-07 on the legacy stack)

# Demo Runbook (Production)

> **Stack note:** URLs point to the live MIE TWH stack. Run/case IDs are environment-specific and
> change every run, so this runbook captures them at demo time via the API (see "Capture current
> IDs") rather than hardcoding them.

## Production Surfaces
- Frontend: `https://twh.os.mieweb.org`
- Backend API: `https://twh-api.os.mieweb.org`

## Capture current IDs (run at demo time)

Run and case IDs are environment-specific and change on every run, so capture them live rather
than relying on pinned values. All `/api/**` calls require a bearer token.

```bash
# 1) Mint an access token (admin or case-manager account)
TOKEN=$(curl -fsS -X POST https://twh-api.os.mieweb.org/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@workwell.dev","password":"Workwell123!"}' | jq -r .token)

# 2) Measure IDs (names are stable across reseeds; UUIDs differ per instance)
curl -fsS https://twh-api.os.mieweb.org/api/measures \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[] | "\(.name): \(.id)"'

# 3) Latest Audiogram-scoped run ID. /api/runs has no measureId filter — it only
#    supports status/scopeType/triggerType/site/from/to/limit — so post-filter the
#    returned JSON by measure name. If no measure-scoped Audiogram run exists, drop
#    the map(...) and take .[0].id: the latest ALL_PROGRAMS run also covers Audiogram.
MEASURE_ID=<audiogram-measure-id>   # from step 2; reused by the case filter below
curl -fsS "https://twh-api.os.mieweb.org/api/runs?limit=50" \
  -H "Authorization: Bearer $TOKEN" | jq -r 'map(select(.measureName | test("Audiogram"))) | .[0].id'

# 4) An open Audiogram case ID (for MCP explain_outcome). /api/cases filters by
#    measureId (the logical measure UUID), not measureName — reuse $MEASURE_ID.
curl -fsS "https://twh-api.os.mieweb.org/api/cases?status=open&measureId=$MEASURE_ID" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id'
```

Stable seeded reference: employee `emp-006` (Omar Siddiq) carries an Audiogram `OVERDUE` outcome
and is a reliable persona for a deterministic `explain_outcome` demo — external IDs survive
reseeds, the case UUID does not.

## Pre-flight Smoke Check (curl)

```bash
curl -fsS https://twh-api.os.mieweb.org/actuator/health
curl -fsS https://twh-api.os.mieweb.org/api/measures -H "Authorization: Bearer $TOKEN"
curl -fsS "https://twh-api.os.mieweb.org/api/runs?limit=50" -H "Authorization: Bearer $TOKEN" | jq 'map(select(.measureName | test("Audiogram")))'
curl -fsS "https://twh-api.os.mieweb.org/api/cases?status=open&measureId=$MEASURE_ID" -H "Authorization: Bearer $TOKEN"
```

Expected:
- Health returns `{"status":"UP"}`.
- Measures response includes all 4 active programs.
- At least one recent run is returned for Audiogram.
- At least one open Audiogram case exists.

## 30-Minute Pre-Demo Checklist
- Verify backend is up (`/actuator/health` is UP).
- Verify frontend opens at `https://twh.os.mieweb.org/programs`.
- Verify all 4 measures are Active in `GET /api/measures`.
- Verify at least one open Audiogram case exists.
- Capture a current run ID and open Audiogram case ID (see "Capture current IDs").
- Verify MCP server is running and can execute `list_measures`, `get_run_summary`, `explain_outcome`.

## Reference MCP Calls for Live Demo

Substitute the IDs captured above:

```text
list_measures
get_run_summary {"runId":"<run-id>"}
explain_outcome {"caseId":"<open-case-id>"}
```
