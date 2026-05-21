# eCQM and TWH Instance Deployment Plan

**Date:** 2026-05-21  
**Branch:** `feat/ecqm-twh-instances`  
**Status:** Implementation complete — pending owner actions and deploy

---

## Context

Doug requested two additional WorkWell-stack deployments alongside `workwell.os.mieweb.org`:

- **ecqm.os.mieweb.org** — Clinical quality / wellness measures (hypertension, diabetes HbA1c, obesity BMI, cholesterol LDL). Audience: clinical quality teams and JPMC/Cigna-style wellness programs.
- **twh.os.mieweb.org** — Total Worker Health (NIOSH). Combines both OSHA safety measures and wellness measures in one instance. Audience: integrated EHS + wellness programs.

The workwell instance keeps its existing 4 OSHA measures (Audiogram, TB, HAZWOPER, Flu Vaccine) unchanged.

---

## Architecture

```
Same repo
  → One backend image (ghcr.io/taleef7/workwell-api)
      Runtime env: WORKWELL_INSTANCE=ecqm|twh|workwell
      Seeds: instance-aware (ecqm=wellness only, twh=both, workwell=OSHA only)

  → Three frontend images (separate build per instance)
      ghcr.io/taleef7/workwell-frontend        (workwell, existing)
      ghcr.io/taleef7/workwell-ecqm-frontend   (ecqm — new)
      ghcr.io/taleef7/workwell-twh-frontend    (twh — new)
      Build args: NEXT_PUBLIC_API_URL, NEXT_PUBLIC_APP_NAME, NEXT_PUBLIC_APP_TAGLINE

  → Three Neon databases (one per instance, independent)
      Existing: DATABASE_URL (workwell)
      New: DATABASE_URL_ECQM, DATABASE_URL_TWH (Taleef provisions)

  → Three MIE hostname pairs
      workwell / workwell-api (existing)
      ecqm / ecqm-api (new)
      twh / twh-api (new)
```

## Measure Assignment Per Instance

| Measure | workwell | ecqm | twh |
|---|---|---|---|
| Audiogram (OSHA) | ✓ | — | ✓ |
| TB Surveillance (CDC) | ✓ | — | ✓ |
| HAZWOPER Surveillance | ✓ | — | ✓ |
| Flu Vaccine | ✓ | — | ✓ |
| Hypertension Control | — | ✓ | ✓ |
| Diabetes HbA1c | — | ✓ | ✓ |
| Obesity BMI Screening | — | ✓ | ✓ |
| Cholesterol LDL | — | ✓ | ✓ |

---

## Implementation Completed

### Task 1 — Wellness CQL measure files ✅
- `backend/src/main/resources/measures/hypertension.cql` — Annual BP screening (365-day window)
- `backend/src/main/resources/measures/diabetes_hba1c.cql` — Biannual HbA1c (180-day window)
- `backend/src/main/resources/measures/obesity_bmi.cql` — Annual BMI screening (365-day window)
- `backend/src/main/resources/measures/cholesterol_ldl.cql` — Annual LDL screening (365-day window)

All 4 follow the exact same pattern as audiogram.cql: FHIR R4 Procedure resources, valueset declarations, Compliant/DueSoon/Overdue/MissingData/Excluded defines, and a final `Outcome Status` string define.

### Task 2 — `WORKWELL_INSTANCE` config property ✅
- `backend/src/main/resources/application.yml` — Added `workwell.instance: ${WORKWELL_INSTANCE:workwell}` and 4 new compliance rates

### Task 3 — Instance-aware seeding in `MeasureService` ✅
- Added `@Value("${workwell.instance:workwell}") private String workwellInstance`
- Added `ensureInstanceSeeds()` gating OSHA seeds on `workwell|twh`, wellness seeds on `ecqm|twh`
- Added `ensureHypertensionSeed()`, `ensureDiabetesHbA1cSeed()`, `ensureObesityBmiSeed()`, `ensureCholesterolLdlSeed()`

### Task 4 — New cases in `CqlEvaluationService.measureSeedSpecFor()` ✅
- Added 4 cases (Hypertension BP Screening, Diabetes HbA1c Monitoring, BMI Screening & Counseling, Cholesterol LDL Screening) — all `useImmunization=false`

### Task 5 — Wellness value sets in `ValueSetGovernanceService` ✅
- Added 10 value sets with `b0000001-...` UUIDs:
  - wellness-enrollment, wellness-exemption, bp-screening (CPT 99213)
  - diabetes-program, diabetes-exemption, hba1c-labs (CPT 83036)
  - bmi-screening (CPT 99401), cholesterol-program, cholesterol-exemption, ldl-labs (CPT 83721)
- Added `ensureLink()` calls for all 4 wellness measures

### Task 6 — Frontend branding env vars ✅
- `frontend/Dockerfile` — Added `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_APP_TAGLINE` build args
- Updated `app/layout.tsx`, `app/page.tsx`, `app/(dashboard)/layout.tsx`, `app/login/page.tsx`, `app/sandbox/page.tsx`, `app/sandbox/layout.tsx` to use the env vars

### Task 7 — `deploy-ecqm-mieweb.yml` ✅
- `.github/workflows/deploy-ecqm-mieweb.yml` — Builds `workwell-ecqm-frontend` image with eCQM branding, deploys to `ecqm-api`/`ecqm` hostnames, uses `DATABASE_URL_ECQM` + `WORKWELL_AUTH_JWT_SECRET_ECQM`, sets `WORKWELL_INSTANCE=ecqm`

### Task 8 — `deploy-twh-mieweb.yml` ✅
- `.github/workflows/deploy-twh-mieweb.yml` — Builds `workwell-twh-frontend` image with TWH branding, deploys to `twh-api`/`twh` hostnames, uses `DATABASE_URL_TWH` + `WORKWELL_AUTH_JWT_SECRET_TWH`, sets `WORKWELL_INSTANCE=twh`

---

## Owner Actions Required (Taleef)

These require manual steps outside the codebase — complete before triggering the workflows.

### 1. Create Neon databases
In your Neon account, create two projects:
- `workwell-ecqm` (Postgres 16, region us-east)
- `workwell-twh` (Postgres 16, region us-east)

Copy the **pooled** connection string for each (used as `DATABASE_URL` by the app).

### 2. Add GitHub repository secrets
Settings → Secrets and variables → Actions → New repository secret:

| Secret name | Value |
|---|---|
| `DATABASE_URL_ECQM` | Neon pooled connection string for workwell-ecqm |
| `DATABASE_URL_TWH` | Neon pooled connection string for workwell-twh |
| `WORKWELL_AUTH_JWT_SECRET_ECQM` | Strong random string ≥32 chars |
| `WORKWELL_AUTH_JWT_SECRET_TWH` | Strong random string ≥32 chars |

Existing shared secrets (`LAUNCHPAD_API_URL`, `LAUNCHPAD_API_KEY`, `OPENAI_API_KEY`) are reused — no new additions needed.

### 3. Make GHCR packages public
After the first workflow run pushes the new images, go to:
- GitHub → Packages → `workwell-ecqm-frontend` → Package settings → Make public
- GitHub → Packages → `workwell-twh-frontend` → Package settings → Make public

---

## Verification

### Local backend verification
```bash
cd backend

# ecqm: expect Hypertension, Diabetes, BMI, Cholesterol (no OSHA measures)
WORKWELL_INSTANCE=ecqm ./gradlew bootRun

# twh: expect all 8 measures
WORKWELL_INSTANCE=twh ./gradlew bootRun

# workwell (default): expect 4 OSHA measures
./gradlew bootRun
```

### Post-deploy smoke checks
```
GET https://ecqm-api.os.mieweb.org/actuator/health → {"status":"UP"}
GET https://ecqm.os.mieweb.org/ → 200, page title "WorkWell eCQM Studio"
GET https://ecqm-api.os.mieweb.org/api/measures → 4 wellness measures

GET https://twh-api.os.mieweb.org/actuator/health → {"status":"UP"}
GET https://twh.os.mieweb.org/ → 200, page title "WorkWell TWH"
GET https://twh-api.os.mieweb.org/api/measures → 8 measures (OSHA + wellness)
```
