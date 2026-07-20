# wcdb-fhir-shim

A tiny, dev/demo-grade **FHIR R4 facade over the WebChart dev database** (`ghcr.io/mieweb/dev-wcdb`,
MariaDB) — the "shim" from the 2026-07-19 Doug directive (ADR-034, issue #309). It answers FHIR
queries by running SQL against the WCDB schema and returning FHIR objects, making it a drop-in for
the ADR-032 HAPI "fake WebChart": point the app's existing WebChart seam at it and the whole
live-tenant pipeline (fetch → normalize → crosswalk → CQL → dashboards) runs off real WebChart-shaped
SQL data. It also hosts the **CQL→SQL compliance API** (#292): executing the generated, committed
SQL in `sql/` (added in the compliance-API PR).

**This package is the only place in the repo allowed a MariaDB driver** (`mysql2`, ADR-034);
`backend-ts` stays driver-free. Never deployed to the live stack; synthetic data only; no PHI.

## Run

```bash
# 1) the database + shim via compose (profile-gated; default stack untouched):
docker compose -f ../infra/docker-compose.yml --profile wcdb up -d wcdb wcdb-fhir-shim

# — or natively against a running wcdb container on :33306 —
npm install
npm start                       # SHIM_PORT=8085 by default

# 2) point the app / CLIs at it:
#    WORKWELL_WEBCHART_BASE_URL=http://localhost:8085
#    WORKWELL_WEBCHART_API_KEY=local-dev          (accepted, not enforced)
```

Env: `WCDB_HOST` (localhost) · `WCDB_PORT` (33306) · `WCDB_DATABASE` (wc_miehr_wctroot) ·
`WCDB_USER` (root) · `WCDB_PASSWORD` (dev-wcdb's published dev credential) · `SHIM_PORT` (8085).

## Endpoints

| Route | Behavior |
|---|---|
| `GET /fhir/metadata` | Minimal R4 CapabilityStatement (availability probe) |
| `GET /fhir/Patient?_count=&_offset=` | Paged searchset over `patients` (`is_patient=1`); stable `wc-{pat_id}` ids; **same-origin** `link[next]` minted from the incoming Host header |
| `GET /fhir/Observation?patient=wc-N` | `observations_current ⋈ observation_codes` → final LOINC-coded Observations (deterministic minted ids) |
| `GET /fhir/Procedure?patient=wc-N` | `patient_procedures` → completed CPT/HCPCS Procedures |
| `GET /fhir/{Condition\|Immunization\|Encounter}?patient=` | Valid **empty** searchsets (no coded WCDB source; enrollment Conditions are stamped WorkWell-side) |
| `GET /health` | `{ok:true}` |
| `GET /compliance/{measureId}/cohort?start=&end=` | #292 demo API: executes the committed generated SQL (`sql/{measureId}.sql`, bound params) → numerator/denominator + per-status counts + per-patient verdicts. `end` = evaluation date (default today); the window is the measure's rule (echoed in `period`) |
| `GET /compliance/{patientId}/{measureId}?start=&end=` | Doug's question — "is this patient compliant for this measure, for this date range?" → `{outcomeStatus, compliant, lastEventDate, daysSince}` (`wc-N` or bare pat_id) |

Auth: `Authorization` is accepted and ignored (Doug's "you don't even need security" dev posture).
All endpoints are read-only — no state changes, hence no audit surface.

`sql/*.sql` are **generated artifacts** (`cd backend-ts && pnpm generate:sql`, freshness-tested
there) — never edited by hand and never assembled at request time; the shim only binds `?` params.
CQL remains the sole compliance authority (ADR-008); these results are demo/parity surface only.

## YAML patient ingest (Doug: "ask ai to generate patient data in yaml … put into webchart")

```bash
npm run ingest -- --file patients.example.yaml --dry-run   # plan only, writes nothing
npm run ingest -- --file patients.example.yaml             # insert into the dev-wcdb
npm run ingest -- --file patients.example.yaml --rollback  # delete exactly the file's patients
```

The WRITE half of the demo loop: AI-generated YAML patients (schema in `src/ingest.ts` /
`patients.example.yaml`) are inserted into `patients` + `observations_current`, after which the
whole read pipeline picks them up immediately — shim FHIR, CQL, generated SQL, dashboards.
Safeties: every touched field is validated against **WebChart's own `model` schema catalog**
(`src/model-metadata.ts` — the self-describing schema Doug pointed at, 685 objects / 7,630 fields
in the dev seed) before any write; LOINCs must already exist in `observation_codes` (fail-closed —
codes are never invented); idempotent by (firstName, lastName, birthDate); `--rollback` is exact.
**Dev database only** — synthetic data, never a live WebChart. Note: the live acceptance suites
pin the 56-patient seed population, so roll back before running them.

## FHIR mapping

`src/fhir-mapping.ts` intentionally duplicates the shapes of
`backend-ts/scripts/webchart-devdb-export.ts` (the committed-fixture generator): date-only FHIR
dateTimes, `wc-{pat_id}` subject ids, LOINC/CPT/HCPCS URIs the backend crosswalk recognizes,
final/completed statuses. **The drift guard is the live parity suite**, not a shared import.

## Verify

```bash
npm test                        # HTTP layer over a stubbed DB — no Docker needed

# live acceptance (the real gate) — from backend-ts/ with the shim running:
WORKWELL_WEBCHART_LIVE_TEST_BASE_URL=http://localhost:8085 \
  node --import tsx --test src/engine/ingress/webchart/hapi-live.test.ts
# expects: 56 unique patient bundles; wc-5 carries real-LOINC Observations; small page-size
# still yields 56; bucket-for-bucket parity with the committed-fixture evaluation.
```
