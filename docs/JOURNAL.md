# Journal

## 2026-05-03

### D3 - S1a Audiogram vertical (progress)

**Goals set**
- Start S1a by replacing placeholder run flow with a real measure-specific vertical slice.
- Keep changes within backend/frontend ownership boundaries and preserve ADR-002 evidence shape.

**What shipped**
- Added seeded Audiogram demo evaluator service for 5 synthetic patients with outcome buckets:
  - `COMPLIANT`, `DUE_SOON`, `OVERDUE`, `MISSING_DATA`, `EXCLUDED`
  - File: `backend/src/main/java/com/workwell/measure/AudiogramDemoService.java`
- Added S1a run endpoint:
  - `POST /api/runs/audiogram`
  - File: `backend/src/main/java/com/workwell/web/EvalController.java`
- Added DB-backed persistence and readback for seeded runs:
  - `runs`, `outcomes`, `audit_events` rows are written through `RunPersistenceService`
  - `GET /api/runs/audiogram/latest` reads the latest persisted run
  - File: `backend/src/main/java/com/workwell/run/RunPersistenceService.java`
- Added baseline authored CQL resource for Annual Audiogram:
  - File: `backend/src/main/resources/measures/audiogram.cql`
- Expanded dashboard run page to execute and render the S1a vertical response, including run summary and per-patient evidence payloads:
  - File: `frontend/app/(dashboard)/runs/page.tsx`

**Verification**
- Backend tests: `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Frontend lint: `npm run lint` -> success
- Frontend production build: `npm run build` -> success

**Notes**
- This slice establishes the S1a authored-measure/run/evidence path with deterministic seeded outcomes.
- Persistence is now live for seeded Audiogram runs; case detail integration remains for next S1a steps.

**Fix + redeploy**
- Live `/api/runs/audiogram` initially failed because the seeded missing-data patient produced a `null` evidence value and `Map.of(...)` rejected it.
- Updated evidence assembly to use null-safe `LinkedHashMap` payloads.
- Added a direct service test for the seeded run to guard against the same regression.
- Redeployed Fly backend and verified live success:
  - `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`
  - `OPTIONS https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`
  - Returned summary counts: `1 / 1 / 1 / 1 / 1` across compliant, due soon, overdue, missing data, excluded

**Current status**
- Backend and frontend both verify locally after persistence wiring.
- Ready to push the DB-backed run path live and confirm the latest-run readback in the browser.

**Caseflow / Why Flagged**
- Wired seeded Audiogram outcomes into the `cases` table for non-compliant statuses:
  - `DUE_SOON`, `OVERDUE`, `MISSING_DATA` create or refresh open cases.
  - `COMPLIANT` and `EXCLUDED` close an existing case if one is already present.
- Added read APIs for:
  - `GET /api/cases`
  - `GET /api/cases/{id}`
- Added frontend case views:
  - `/cases` list page
  - `/cases/[id]` detail page with structured evidence, metadata, and audit timeline
- Verification completed after the change:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `npm run lint` -> success
  - `npm run build` -> success

**Case action + rerun-to-verify loop**
- Added case action API endpoints:
  - `POST /api/cases/{id}/actions/outreach`
  - `POST /api/cases/{id}/rerun-to-verify`
- Added backend case lifecycle behavior for S4b:
  - Outreach action writes `case_actions` plus `CASE_OUTREACH_SENT` audit event.
  - Rerun-to-verify writes a case-scoped verification run, persists a compliant verification outcome, records action/audit events, and closes the case.
- Added UI controls on `/cases/[id]`:
  - `Send outreach`
  - `Rerun to verify`
  - Page refreshes with updated status and audit timeline after each action.
- Verification after this slice:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `npm run lint` -> success
  - `npm run build` -> success

**Deploy + live checkpoint verification**
- Backend deployed to Fly using repo-root context with backend config:
  - `flyctl deploy --config backend/fly.toml`
  - Live URL: `https://workwell-measure-studio-api.fly.dev`
- Frontend deployed to Vercel production:
  - Deployment: `https://frontend-5wx93gznt-taleef7s-projects.vercel.app`
  - Active alias observed: `https://frontend-seven-eta-24.vercel.app`
- Live API verification evidence:
  - `GET /actuator/health` -> `UP`
  - `POST /api/runs/audiogram` -> returned run id `79d87735-81b7-42dc-86b2-bf200a196890`
  - `GET /api/cases` -> `3` cases
  - `POST /api/cases/d99266b2-0cb8-47b9-a329-c7ccc89ea00e/actions/outreach` -> next action updated to follow-up + rerun guidance
  - `POST /api/cases/d99266b2-0cb8-47b9-a329-c7ccc89ea00e/rerun-to-verify` -> case transitioned to `CLOSED` with `COMPLIANT`
  - `GET /api/cases/d99266b2-0cb8-47b9-a329-c7ccc89ea00e` -> `closedAt` present and timeline length `5`
- Checkpoint readout:
  - The core S4b loop (open case -> outreach action -> rerun verification -> case closure + audit chain) is now live and test-backed.
  - Ready to re-evaluate completed scope against SPIKE_PLAN acceptance and pick the next highest-risk gap.

**Advisor checkpoint package**
- Added `docs/advisor_update.md` as a comprehensive status handoff for external advisor review.
- Document includes:
  - spike-by-spike Done/Partial/Missing matrix against `docs/SPIKE_PLAN.md`
  - execution evidence from `docs/JOURNAL.md` and deploy checks
  - issue log, risk assessment, and recommended next execution sequence
  - explicit advisor feedback prompts for scope/risk decisions

## 2026-05-02

### D1 - Plan + Provision (completed)

**Goals set**
- Finalize canonical sprint docs and archive legacy planning docs.
- Prepare deploy targets (Neon, Fly.io, Vercel) without doing the D2 deployment.
- Close ADR-002 on `evidence_json` shape to unblock S1.

**What shipped today**
- Archived legacy plan files under `docs/archive/`, including `PROJECT_PLAN_v1.md` with top note:
  - "Archived May 2, 2026. Replaced by docs/SPIKE_PLAN.md."
- Canonical sprint docs are now in place:
  - `docs/SPIKE_PLAN.md`
  - `docs/DEPLOY.md`
  - `AGENTS.md` and `CLAUDE.md` updated to point to `SPIKE_PLAN.md` as source of truth.
- Added root `.env.example` with all deployment variables from `docs/DEPLOY.md`:
  - `DATABASE_URL`
  - `DATABASE_URL_DIRECT`
  - `ANTHROPIC_API_KEY`
  - `SPRING_PROFILES_ACTIVE`
  - `NEXT_PUBLIC_API_BASE_URL`
  - `NEXT_PUBLIC_APP_NAME`
- Added `backend/fly.toml` with D1 baseline:
  - app: `workwell-measure-studio-api`
  - region: `ord`
  - memory: `512mb`
  - healthcheck: `/actuator/health`
  - JVM opts: `-Xmx384m -Xss256k`
- Closed ADR-002 in `docs/DECISIONS.md` with accepted shape:
  - `evidence_json = { expressionResults, evaluatedResource }`
  - `rule_path[]` derived at render time (not persisted)

**Sub-spike / verification evidence**
- Re-ran CQF ADR probe test in spike repo:
  - `../workwell-spike-cqf`: `./gradlew.bat test --tests com.workwell.spike.DualEvaluationCostSubSpikeTest`
  - Result: `BUILD SUCCESSFUL`
- Backend tests in this repo were green in D1 verification sweep:
  - `backend\gradlew.bat test` -> `BUILD SUCCESSFUL`

**Provisioning status (end of D1)**
- Fly:
  - Authenticated and app created with `flyctl launch --no-deploy`.
  - Current staged secret: `SPRING_PROFILES_ACTIVE=prod`.
  - No app deploy performed (correct for D1).
- Vercel:
  - Git repository now connected (confirmed in project Git settings).
  - Preview deployment failure observed on PR branch due to project root mismatch.
  - Exact error: "No Next.js version detected".
  - Root cause: Vercel building from repo root while Next.js app lives in `frontend/`.
  - Required fix: set Vercel project Root Directory to `frontend` and redeploy.
- Neon:
  - CLI provisioning created a project defaulting to PostgreSQL 17.
  - This conflicts with locked stack requirement (PostgreSQL 16).
  - DB secrets pointing to PG17 were intentionally not kept as final runtime configuration.

**What surprised**
- Neon CLI default behavior is PG17 unless PG version is explicitly controlled through supported path.
- Vercel integration succeeded, but monorepo root detection still caused preview build failure.
- CQF processor two-step path remains the best evidence-friendly path and did not require a second full evaluation in the measured probe.

**Risk status**
- ADR-002 risk: closed.
- Vercel preview build risk: open until Root Directory is set to `frontend`.
- Database version compliance risk: open until Neon PG16 target is created/selected.

**Plan for D2 (S0 walking skeleton only)**
- Do not add scope beyond S0.
- Complete infra readiness first:
  - Ensure Vercel Root Directory = `frontend` and preview deploy succeeds.
  - Ensure Neon target is PostgreSQL 16.
  - Set final Fly DB secrets (`DATABASE_URL`, `DATABASE_URL_DIRECT`) from compliant PG16 Neon target.
  - Add `ANTHROPIC_API_KEY` only if AI surface is exercised in S0 path.
- Then execute S0 end-to-end:
  - Backend `/api/eval` on Fly
  - Frontend call from Vercel
  - Health checks and demoable round-trip

### D2 prep progress (resumed)

**What shipped in code**
- Added backend stub-auth security config to allow sprint-phase unauthenticated API access:
  - `backend/src/main/java/com/workwell/config/SecurityConfig.java`
- Added S0 walking-skeleton endpoint:
  - `POST /api/eval` in `backend/src/main/java/com/workwell/web/EvalController.java`
  - Accepts `patientBundle` + `cqlLibrary`, returns placeholder outcome + evidence payload shape.
- Added endpoint test:
  - `backend/src/test/java/com/workwell/web/EvalControllerTest.java`
- Replaced placeholder "Test Runs" UI with an S0 API probe page:
  - `frontend/app/(dashboard)/runs/page.tsx`
  - Button posts sample payload to `${NEXT_PUBLIC_API_BASE_URL}/api/eval` and renders response/error.

**Verification run**
- Backend:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Frontend:
  - `npm run lint` -> success
  - `npm run build` -> success

**Still pending outside repo code**
- Vercel project setting: Root Directory must be `frontend`.
- Neon runtime target must be PostgreSQL 16 before final Fly DB secret wiring.
- Deployed S0 validation on live URLs (Fly `/actuator/health`, Vercel `/runs` probe).

### D2 - S0 walking skeleton (completed)

**Infra completion**
- Neon PG16 project created and selected for runtime (`workwell-measure-studio-pg16`).
- Fly secrets set with JDBC-form `DATABASE_URL` and `DATABASE_URL_DIRECT` values from PG16 target.
- Backend deployed to Fly and verified healthy on:
  - `https://workwell-measure-studio-api.fly.dev/actuator/health`
- Vercel root directory locked to `frontend` and production alias confirmed:
  - `https://workwell-measure-studio.vercel.app`

**What shipped after D2 prep**
- Backend CORS handling enabled in spring security to allow browser preflight from Vercel frontend.
  - File: `backend/src/main/java/com/workwell/config/SecurityConfig.java`
- Frontend eval probe hardened by normalizing `NEXT_PUBLIC_API_BASE_URL` and surfacing the full request URL on failure.
  - File: `frontend/app/(dashboard)/runs/page.tsx`

**Production verification evidence**
- Preflight check from Vercel origin to Fly eval endpoint:
  - `OPTIONS /api/eval` -> `200`, `Access-Control-Allow-Origin` returned correctly.
- Direct API eval check:
  - `POST https://workwell-measure-studio-api.fly.dev/api/eval` -> `200` with expected placeholder payload.
- Browser check on production frontend:
  - `/runs` "Run Eval Probe" now renders successful JSON response (COMPLIANT placeholder outcome).

**Commits applied during D2 completion**
- `a62c4d3` `fix(api): allow CORS preflight for eval probe [S0]`
- `b672d8f` `fix(frontend): normalize API base URL for eval probe [S0]`

**Result**
- S0 acceptance met: deployed patient/CQL eval probe round-trip works end-to-end across Vercel + Fly + Neon.
  - Ready to move into D3/S1a Audiogram vertical.

---

## 2026-05-01

CQF/FHIR de-risking and ADR-002 probes completed in `../workwell-spike-cqf` with passing test evidence and documented transfer notes in `docs/CQF_FHIR_CR_REFERENCE.md`.

## 2026-04-29

Initial planning baseline and scaffolding completed.
