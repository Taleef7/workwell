# Last verified: 2026-05-07

# Demo Runbook (Production)

## Production Surfaces
- Frontend: `https://frontend-seven-eta-24.vercel.app`
- Backend API: `https://workwell-measure-studio-api.fly.dev`

## Pinned Production IDs

### Measures
- Audiogram: `4ae5d865-3d64-4a17-905d-f1b315a037e2`
- TB Surveillance: `8c9fda6f-b9bb-413a-be4d-8ce4faa72999`
- HAZWOPER Surveillance: `eaa81302-b6f6-4aba-a143-bb72941f9c00`
- Flu Vaccine: `9db33281-0933-4dd6-86e9-e4c6df2b9a94`

### Latest run IDs (per measure query, `limit=1`)
- Audiogram latest run: `3866d69a-2519-4051-bad0-98da9ea696bf`
- TB Surveillance latest run: `fba26713-92ff-49e3-84d0-fa8d137881f7`
- HAZWOPER Surveillance latest run: `3866d69a-2519-4051-bad0-98da9ea696bf`
- Flu Vaccine latest run: `3866d69a-2519-4051-bad0-98da9ea696bf`

### Pinned Audiogram open case for MCP `explain_outcome`
- Case ID: `32fee6f4-6e69-4675-b44e-5f6392de7dbd`
- Employee: `emp-006` (Omar Siddiq)
- Outcome status: `OVERDUE`

## Pre-flight Smoke Check (curl)

```bash
curl -fsS https://workwell-measure-studio-api.fly.dev/actuator/health
curl -fsS https://workwell-measure-studio-api.fly.dev/api/measures
curl -fsS "https://workwell-measure-studio-api.fly.dev/api/runs?measureId=4ae5d865-3d64-4a17-905d-f1b315a037e2&limit=1"
curl -fsS "https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureName=Audiogram"
```

Expected:
- Health returns `{"status":"UP"}`.
- Measures response includes all 4 active programs.
- At least one recent run is returned for Audiogram.
- At least one open Audiogram case exists.

## 30-Minute Pre-Demo Checklist
- Verify backend is up (`/actuator/health` is UP).
- Verify frontend opens at `https://frontend-seven-eta-24.vercel.app/programs`.
- Verify all 4 measures are Active in `GET /api/measures`.
- Verify at least one open Audiogram case exists.
- Verify MCP server is running and can execute:
  - `list_measures`
  - `get_run_summary`
  - `explain_outcome` with case ID `32fee6f4-6e69-4675-b44e-5f6392de7dbd`

## Reference MCP Calls for Live Demo

```text
list_measures
get_run_summary {"runId":"3866d69a-2519-4051-bad0-98da9ea696bf"}
explain_outcome {"caseId":"32fee6f4-6e69-4675-b44e-5f6392de7dbd"}
```
