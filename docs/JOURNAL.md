# Journal

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
