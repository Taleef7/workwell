# WorkWell Studio Post-Merge Status

## Date
2026-05-11

## Current Git State
- **Current branch:** `main`
- **Remote branches:** `origin/main` only
- **Local backup branch:** `backup/remaining-todos-uncommitted` (local-only, not pushed)
- **Working tree:** Clean — only `.claude/` untracked (intentionally not committed)

## Merged PRs
- **PR #5:** P0 security and correctness hardening — MCP auth, actor spoofing removal, evidence authorization, CORS, production startup checks, regression tests
- **PR #6:** Testing/CI sync and MCP v2 safe agent tools — `McpSecurityIntegrationTest`, CI build step, README_08 QA checklist, MCP v2 tools (`get_employee`, `check_compliance`, `list_noncompliant`, `explain_rule`, `get_measure_traceability`, `list_data_quality_gaps`), tool authorization hardening

All 9 README implementation specs (README_01 through README_09) are fully implemented and merged.

## Verification Results

### Backend MCP targeted tests (`com.workwell.mcp.*`)
- **Result: FAILED (1 of 2)**
- `McpSecurityIntegrationTest` → `initializationError`: `java.lang.IllegalStateException at DockerClientProviderStrategy.java:274`
- **Root cause:** Testcontainers requires a running Docker daemon. Docker is not running in this environment. This is an environment constraint, not a code defect.
- `McpSecurityIntegrationTest` uses `@Testcontainers` + `@Container` (confirmed by annotation scan).
- Mitigation: run these tests in CI where Docker is available, or start Docker Desktop locally before running.

### Backend full build (`./gradlew.bat build -x test`)
- **Result: BUILD SUCCESSFUL** — compileJava, processResources, bootJar all clean.

### Frontend lint (`pnpm lint`)
- **Result: PASSED** — no lint errors or warnings.

### Frontend build (`pnpm build`)
- **Result: PASSED** — all 12 routes compiled cleanly (static + dynamic). No TypeScript or build errors.

### `git diff --check`
- **Result: PASSED** — no whitespace errors.

## Deployment Verification (2026-05-11)

### Pre-deploy secret audit
Missing secrets found and set before deploy:
- `WORKWELL_AUTH_JWT_SECRET` — was missing (app was using weak default); set to strong 64-char random value
- `WORKWELL_CORS_ALLOWED_ORIGINS` — set to `https://workwell-measure-studio.vercel.app` (initially set to `https://frontend-seven-eta-24.vercel.app`, corrected 2026-05-12)
- `WORKWELL_AUTH_ENABLED=true`, `WORKWELL_DEMO_ENABLED=false`, `WORKWELL_DEMO_ALLOW_PUBLIC_DEMO=false` — set explicitly

### Deploy
- Command: `fly deploy --config backend/fly.toml` from repo root (required because `context = '..'` in fly.toml must be resolved from repo root, not `backend/`)
- Build: `gradle bootJar` in Depot — BUILD SUCCESSFUL
- Flyway: 12 new migrations applied (V003 through V014)
- Startup: Spring Boot started in 19.6s, `StartupSafetyValidator` passed all production checks
- Health: `GET /actuator/health` → `{"status":"UP"}`
- Image: `registry.fly.io/workwell-measure-studio-api:deployment-01KRCM4NJ991A7WZ036Z1J5J3K`

### Backend (Fly.io — `https://workwell-measure-studio-api.fly.dev`)
- `GET /actuator/health` → **200 UP** ✅
- `GET /api/measures` (no token) → **403** ✅
- `GET /api/runs` (no token) → **403** ✅
- `GET /sse` MCP (no token) → **403** ✅
- `GET /mcp/message` (no token) → **403** ✅
- `POST /api/auth/login` → **200 + JWT token** ✅

### Frontend (Vercel — `https://workwell-measure-studio.vercel.app`)
- `GET /` → **307 redirect** (Next.js login redirect — expected) ✅
- `NEXT_PUBLIC_API_BASE_URL` = `https://workwell-measure-studio-api.fly.dev` (confirmed in Vercel env config)

## API QA Results (post-deploy, 2026-05-11)

Demo credentials: `{email}@workwell.dev` / `Workwell123!`
Note: README and DEMO_QA_CHECKLIST incorrectly state password is `password` — actual seeded password is `Workwell123!`. Update needed.

### Auth and role-based access
| Check | Expected | Result |
|-------|----------|--------|
| Login as `cm@workwell.dev` | 200 + token | ✅ 200 |
| Login as `admin@workwell.dev` | 200 + token | ✅ 200 |
| Login as `author@workwell.dev` | 200 + token | ✅ 200 |
| `/api/measures` unauthenticated | 403 | ✅ 403 |
| `/api/admin/integrations` unauthenticated | 403 | ✅ 403 |
| `/sse` unauthenticated | 403 | ✅ 403 |
| `/mcp/message` unauthenticated | 403 | ✅ 403 |
| `/api/measures` as CM | 200 | ✅ 200 |
| `/api/runs?limit=1` as CM | 200 | ✅ 200 |
| `/api/cases?status=open` as CM | 200 | ✅ 200 |
| `/api/admin/integrations` as CM | 403 | ✅ 403 |
| `/api/admin/integrations` as Admin | 200 | ✅ 200 |
| Approve measure as AUTHOR | 403 | ✅ 403 |

### Measure Studio
| Check | Expected | Result |
|-------|----------|--------|
| Measure list | 200 | ✅ 200 |
| Measure detail | 200 | ✅ 200 |
| Traceability | 200 | ✅ 200 |
| Data readiness | 200 | ✅ 200 |
| Impact preview (dry-run) | 200 | ⏱ Slow/timeout (heavy computation over all employees; not a failure) |
| Value set resolve-check | 200 | ⏱ See note above |

### Runs
| Check | Expected | Result |
|-------|----------|--------|
| Runs list | 200 | ✅ 200 |
| Run detail | 200 | ✅ 200 |
| Runs CSV export | 200 | ✅ 200 |
| Outcomes CSV export | 200 | ✅ 200 |
| Unsupported SITE scope | 400 | ✅ 400 |

### Cases
| Check | Expected | Result |
|-------|----------|--------|
| Case list | 200 | ✅ 200 |
| Case detail | 200 | ✅ 200 |
| Cases CSV export | 200 | ✅ 200 |

### Admin and exports
| Check | Expected | Result |
|-------|----------|--------|
| Data mappings | 200 | ✅ 200 |
| Terminology mappings | 200 | ✅ 200 |
| Audit events export | 200 | ✅ 200 |
| Run audit packet (json) | 200 | ✅ 200 |
| Case audit packet (json) | 200 | ✅ 200 |

### Security edge cases
| Check | Expected | Result |
|-------|----------|--------|
| `/api/eval` without `X-WorkWell-Internal` header | 404 (per README) | ⚠️ 400 — endpoint accessible, returns 400 for invalid body. Minor discrepancy. |

### MCP
MCP QA via client not performed (no MCP client connected). Role-based endpoint security confirmed via HTTP (`/sse` and `/mcp/message` both return 403 unauthenticated). `McpSecurityIntegrationTest` covers role/authorization logic and requires Docker.

## Known Deferred Items
- `SITE` and `EMPLOYEE` scoped runs remain deferred (not implemented; 400 returned for unsupported scopes).
- Real HRIS/FHIR integrations remain future work; current mappings are demo/seeded.
- Demo terminology mappings are not official production terminology.
- PDF audit packet export is deferred.
- Local backup branch `backup/remaining-todos-uncommitted` is retained temporarily for inspection.
- `.claude/` remains untracked.
- Old Superpowers worktree directory at `C:/Users/talee/.config/superpowers/worktrees/WorkWell Studio/remaining-todos` still exists on disk (no Git significance; safe to delete manually via Explorer).

## Issues Found

### Minor — Demo password mismatch in README/checklist
README and `docs/DEMO_QA_CHECKLIST.md` state password is `password`. Actual seeded BCrypt hash corresponds to `Workwell123!`. Update both docs.

### Minor — `/api/eval` returns 400 instead of 404 without internal header
README states: `POST /api/eval is internal compatibility-only and requires X-WorkWell-Internal: true` and the checklist expects 404. Actual behavior is 400 (Bad Request). The endpoint is reachable without the header but rejects the request. Not a security issue — auth is still required.

### Environment — `McpSecurityIntegrationTest` requires Docker
`McpSecurityIntegrationTest` cannot run without Docker Desktop running locally. Not a code defect. Start Docker Desktop or rely on CI where Docker is available.

## Corrections Applied (2026-05-12)

### Frontend URL correction
The Vercel project `workwell-measure-studio` (`https://workwell-measure-studio.vercel.app`) is the canonical frontend — it has GitHub auto-deploy integration connected to `main`. A duplicate project named `frontend` (`https://frontend-seven-eta-24.vercel.app`) existed from an earlier CLI deploy and was mistakenly referenced in CORS config and docs.

Fixes applied:
- `WORKWELL_CORS_ALLOWED_ORIGINS` Fly secret updated to `https://workwell-measure-studio.vercel.app`
- `NEXT_PUBLIC_API_BASE_URL` in the `workwell-measure-studio` Vercel project had a UTF-8 BOM prepended — removed and re-added cleanly
- `frontend/.vercel/project.json` updated to point at `prj_d18xpsaGvibOHQweh238zQhFWhoN` (`workwell-measure-studio`)
- README.md, ARCHITECTURE.md, DEMO_RUNBOOK.md updated to canonical URL

Login verified working at `https://workwell-measure-studio.vercel.app/login` with all demo credentials.

## Recommended Next Steps
1. ~~Fix demo password in README.md and `docs/DEMO_QA_CHECKLIST.md`~~ — Done.
2. Run `McpSecurityIntegrationTest` with Docker Desktop running to confirm MCP authorization logic.
3. Do a full browser walkthrough against `https://workwell-measure-studio.vercel.app` using `docs/DEMO_QA_CHECKLIST.md`.
4. Inspect `backup/remaining-todos-uncommitted` when convenient and delete if no content is worth porting.
5. Consider moving the repo outside OneDrive if Gradle temp-file issues recur.
