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

## Deployed Instance Status

### Backend (Fly.io — `https://workwell-measure-studio-api.fly.dev`)
- `GET /actuator/health` → **200 UP** (backend is running)
- `GET /api/measures` (no token) → **200** — EXPECTED 401/403 ❌
- `GET /api/runs` (no token) → **200** — EXPECTED 401/403 ❌
- `GET /sse` MCP (no token) → **200** — EXPECTED 401/403 ❌
- `GET /api/admin/integrations` (no token) → **200** — EXPECTED 401/403 ❌
- `POST /api/auth/login` → **404** — login endpoint not found ❌

**Diagnosis:** The deployed Fly.io instance is running pre-hardening code. It predates PRs #5 and #6. Authentication is not enforced on the live instance. The backend must be redeployed from `main` to bring the production instance up to the hardened state.

### Frontend (Vercel — `https://frontend-seven-eta-24.vercel.app`)
- `GET /` → **307 redirect** (standard Next.js login redirect — expected behavior)
- Vercel auto-deploys from `main`; frontend should be current.

## Manual QA Summary

Manual browser QA could not be completed because the deployed backend is running pre-hardening code and the `/api/auth/login` endpoint does not exist on the live instance. All checklist flows that require authenticated API calls would test the wrong backend state.

**Recommendation:** Redeploy backend to Fly.io from `main`, then run the full `docs/DEMO_QA_CHECKLIST.md` pass.

| Area | Status | Notes |
|------|--------|-------|
| Auth | ⚠️ Blocked | Deployed backend missing `AuthController`; auth not enforced |
| Measure Studio | ⚠️ Blocked | Depends on auth working end-to-end |
| Runs | ⚠️ Blocked | Depends on auth working end-to-end |
| Cases | ⚠️ Blocked | Depends on auth working end-to-end |
| Admin | ⚠️ Blocked | Depends on auth working end-to-end |
| MCP | ⚠️ Blocked | `/sse` returns 200 without auth on live instance |
| Exports | ⚠️ Blocked | Depends on auth working end-to-end |

## Known Deferred Items
- `SITE` and `EMPLOYEE` scoped runs remain deferred (not implemented; 400 returned for unsupported scopes).
- Real HRIS/FHIR integrations remain future work; current mappings are demo/seeded.
- Demo terminology mappings are not official production terminology.
- PDF audit packet export is deferred.
- Local backup branch `backup/remaining-todos-uncommitted` is retained temporarily for inspection.
- `.claude/` remains untracked.
- Old Superpowers worktree directory at `C:/Users/talee/.config/superpowers/worktrees/WorkWell Studio/remaining-todos` still exists on disk (no Git significance; safe to delete manually via Explorer).

## Issues Found

### P1 — Backend not redeployed to Fly.io
The Fly.io instance is running pre-PR #5 code. Authentication is not enforced. The `AuthController`, MCP v2 tools, security hardening, and all other merged changes are absent from the live backend.

**Fix:** Run `fly deploy` from `backend/` against the current `main` HEAD. See `docs/DEPLOY.md` for the full deploy checklist.

### Environment — Docker not running locally
`McpSecurityIntegrationTest` cannot run without Docker. Not a code defect. Run in CI or start Docker Desktop.

## Recommended Next Steps
1. **Redeploy backend to Fly.io** (`fly deploy` from `backend/`) — this is the critical action before any further QA.
2. **Run full `docs/DEMO_QA_CHECKLIST.md`** after redeploy confirms auth is enforced.
3. **Verify security posture post-deploy:** confirm unauthenticated `/api/measures`, `/sse`, `/api/admin/integrations` all return 401/403.
4. When QA passes, inspect `backup/remaining-todos-uncommitted` to decide whether any content should be ported to `main` or discarded.
5. Consider moving the repo outside OneDrive if Gradle temp-file issues recur (the build redirect fix in PR #6 mitigates the known issue, but OneDrive sync can still interfere with long-running Gradle daemons).
