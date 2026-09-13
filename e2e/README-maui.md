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

## Reads, writes, and the stack you are pointed at

The suite is split by whether a spec DISTURBS the stack it reads.

Everything in the `maui` project is read-only, so it changes nothing on any
stack it is pointed at. Three specs mutate and live in the `maui-writes`
project, which Playwright schedules after every read has finished and runs on
one worker: `runs.spec.ts` (starts a population run), `worklist-writes.spec.ts`
(maps a provider panel, which reassigns every open case on it, and assigns a
patient's gaps), and `case-workflow.spec.ts` (assigns a case, moves it to
IN_PROGRESS, sends outreach).

**Read-only is not the same as harmless at pilot scale.** One test in the
`maui` project — the case CSV export in `exports.spec.ts` — currently holds the
whole database connection pool for a minute against the 20,000-patient sandbox,
and every database-backed endpoint queues behind it (measured 2026-09-13:
`/api/panels` 0.3 s idle, three consecutive 45 s timeouts during an export).
That test is red against the sandbox on purpose until the batched lookup lands,
and the specs that happen to run after it can fail in its shadow. Against CI's
48-patient corpus it is fast and green.

**A write happens only against a local stack, or when you ask for one by name.**
`writesAllowed()` (`tests/maui/helpers.ts`) is true when the base URL's host is
`localhost` or `127.0.0.1`, or when `PLAYWRIGHT_ALLOW_WRITES=1` is set;
otherwise every mutating test skips with the reason, and global setup refuses to
start a population run. This is enforcement rather than advice because the
advice was already here and did not hold: on 2026-09-12 the panel test ran
against the deployed sandbox, moved 339 open cases onto a staff account, and its
restore — reading one page of 50 — put back 50, leaving 289 cases assigned for
about ten minutes on a stack the pilot group signs into.

Where a write can be undone it is: each block restores every case to the
assignee it actually had and then re-reads those cases to compare, and
`worklist-writes.spec.ts` finally asks the SERVER whether the account is back
where it started rather than trusting its own restore loop.

Three things cannot be undone, and the guard rather than a cleverer cleanup is
the answer to all three. The outreach record and the status change in
`case-workflow.spec.ts` are a ledger of something having happened. And
**`assignment_source` does not come back**: every assignment this suite makes or
restores goes through the operator path, so a case that a nightly run had placed
via a provider panel comes out marked as an operator's choice, and a later panel
edit will leave it where it is (ADR-080 d1/d3). Harmless on CI's fresh corpus,
permanent on any stack you run with `PLAYWRIGHT_ALLOW_WRITES=1`.

```powershell
# only when you mean it, and never against a stack somebody else is using
$env:PLAYWRIGHT_ALLOW_WRITES = "1"
```

## Boot the local Maui stack

### 1. Backend (SQLite floor, no database needed)

```powershell
cd backend-ts
$env:WORKWELL_INSTANCE = "maui"
$env:WORKWELL_AUTH_JWT_SECRET = "maui-e2e-dev-secret-key-32chars-minimum!!"
corepack pnpm@10 dev
```

The backend serves on http://localhost:8080 — verify with `GET /api/version`.
This boot runs the authored cms122/cms125, the same setup the CI job uses. Do
NOT set `WORKWELL_OFFICIAL_MEASURES` on a clean checkout: the official
artifacts need their vendored terminology sidecars
(`measures/official/*/terminology.json`, gitignored), and without them
`officialRoutingProblems()` refuses every evaluation route the global setup
depends on. To exercise official routing locally, run the credentialed vendor
step first (`docs/DEPLOY.md`, "vendoring official terminology").
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
$env:PLAYWRIGHT_PROFILE = "maui"
$env:PLAYWRIGHT_BASE_URL = "http://localhost:3000"
$env:PLAYWRIGHT_API_BASE_URL = "http://localhost:8080"
npx playwright test --project=maui --project=maui-writes
```

**Set both URLs.** `PLAYWRIGHT_PROFILE=maui` is REQUIRED — every Maui spec skips
itself when it is unset, and the global setup seeds no run, so Playwright exits
green with every test skipped. The two URLs are required in practice as well:
`PLAYWRIGHT_BASE_URL` falls back to the **staging host**, not to localhost
(`base-url.ts`), so omitting it drives a browser against staging while the API
calls go to your local backend, and every failure then looks like a product
defect. Omitting them also means writes are denied, since the guard above needs
both to be local.

Name both projects, or the write specs never run: `--project=maui` alone is the
read-only half.

When you are done, stop the backend and frontend dev servers.


## Running in CI

Actions → CI → Run workflow → `e2e_profile: maui`. The `e2e-maui` job boots the backend (`WORKWELL_INSTANCE=maui`, SQLite) and a patient-mode frontend build on the runner and runs this project against them; nothing shared is touched. It runs the authored cms122/cms125 (no official routing) because the vendored terminology sidecars are not available in CI; with no VSAC key the authored path yields the same 38/7/3 distribution. Local runs on a Windows developer box tend to die with `0xC0000142` (desktop-heap exhaustion) — use CI.
