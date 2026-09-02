# Maui E2E Suite

End-to-end tests for the **Maui** pilot profile (`WORKWELL_INSTANCE=maui`): a
primary-care quality team working **by provider panel and by patient**, using
status chips ("jelly beans") as pre-filtered work lists and thinking in MIPS
Quality IDs.

- `cms122` — Diabetes — **MIPS 001 · CMS122**
- `cms125` — Breast Cancer Screening — **MIPS 112 · CMS125**
- `hypertension` — Hypertension BP Screening — **no MIPS label**

The existing TWH suite (`e2e/tests/*.spec.ts`, project `chromium`) is
untouched: the `maui` project only runs `tests/maui/**`, and the `chromium`
project ignores `tests/maui/**`.

## Accounts

All Maui accounts use the password `Workwell123!`:

| Email | Role |
|---|---|
| `quality-lead@maui.workwell.dev` | case manager |
| `quality-staff@maui.workwell.dev` | case manager |
| `clinician@maui.workwell.dev` | viewer (read-only) |
| `admin@maui.workwell.dev` | admin |

## Boot the local Maui stack

The suite mutates data (triggers runs, sends outreach, assigns cases) — only
run it against a local stack.

### 1. Backend (SQLite floor, no database needed)

```powershell
cd backend-ts
$env:WORKWELL_INSTANCE = "maui"
$env:WORKWELL_OFFICIAL_MEASURES = "cms122,cms125"
$env:WORKWELL_AUTH_JWT_SECRET = "maui-e2e-dev-secret-key-32chars-minimum!!"
corepack pnpm@10 dev
```

The backend serves on http://localhost:8080 — verify with `GET /api/version`.
If the port differs, read `@mieweb/cli`'s config output and use what it prints.
A fresh SQLite file is used by default; the dev CLI accepts a custom path if
you need one.

### 2. Frontend

```powershell
cd frontend
$env:NEXT_PUBLIC_SUBJECT_TERM = "patient"
$env:NEXT_PUBLIC_PUBLIC_DEMO = "off"
$env:NEXT_PUBLIC_API_URL = "http://localhost:8080"
$env:NEXT_PUBLIC_API_BASE_URL = "http://localhost:8080"
corepack pnpm@10 dev
```

This serves on http://localhost:3000. Wait for the login page to respond
before running the suite.

(Git Bash equivalent for the frontend: `NEXT_PUBLIC_SUBJECT_TERM=patient NEXT_PUBLIC_PUBLIC_DEMO=off NEXT_PUBLIC_API_URL=http://localhost:8080 NEXT_PUBLIC_API_BASE_URL=http://localhost:8080 corepack pnpm@10 dev`.)

### 3. Run the suite

```powershell
cd e2e
npx playwright install chromium   # first time only
npx playwright test --project=maui
```

Playwright reads `PLAYWRIGHT_BASE_URL`, `PLAYWRIGHT_API_BASE_URL`, and
`PLAYWRIGHT_PROFILE` from the environment. Defaults are the local URLs above.
In PowerShell:

```powershell
$env:PLAYWRIGHT_PROFILE = "maui"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
$env:PLAYWRIGHT_API_BASE_URL = "http://localhost:8080"
npx playwright test --project=maui
```

When you are done, stop the backend and frontend dev servers.


## Running in CI

Actions → CI → Run workflow → `e2e_profile: maui`. The `e2e-maui` job boots the backend (`WORKWELL_INSTANCE=maui`, SQLite) and a patient-mode frontend build on the runner and runs this project against them; nothing shared is touched. It runs the authored cms122/cms125 (no official routing) because the vendored terminology sidecars are not available in CI; with no VSAC key the authored path yields the same 38/7/3 distribution. Local runs on a Windows developer box tend to die with `0xC0000142` (desktop-heap exhaustion) — use CI.
