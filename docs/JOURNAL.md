# Journal

## 2026-05-04

### Studio measure-load hotfix + deploy/push checkpoint

- Fixed the reported `Failed to load measure (400)` issue when opening a measure from `/measures`:
  - Root cause: client-side dynamic route parameter handling in `/studio/[id]` was not robust in the current Next.js setup, causing invalid IDs to be sent to `/api/measures/{id}`.
  - Fix: switched Studio page to `useParams()` + normalized `measureId` usage across all API calls + guard for missing IDs.
- Deployment + push completed:
  - Commit: `015057f` (`feat(measure): value sets, test gates, and studio readiness polish [S2]`)
  - Backend deployed: `https://workwell-measure-studio-api.fly.dev`
  - Frontend deployed + aliased: `https://frontend-seven-eta-24.vercel.app`
  - Pushed to GitHub `main`.
- Production smoke verification (`2026-05-04T00:28:26-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/measures` -> `200` (`measureCount=2`)
  - `GET /api/measures/{id}` using live id -> `200` (`detailName=TB Surveillance`, `detailStatus=Active`)
  - `GET /api/cases?status=open` -> `200` (`openCases=23`)
  - `GET https://frontend-seven-eta-24.vercel.app/measures` -> `200`
  - `GET https://frontend-seven-eta-24.vercel.app/studio/{id}` -> `200`

### Release governance polish: activation readiness UX + richer lifecycle audit payloads

- Completed approval/release UX improvements in Studio:
  - Added backend readiness endpoint: `GET /api/measures/{id}/activation-readiness`
  - Added "Activation Readiness" summary panel on `/studio/[id]` for `Approved` measures.
  - Activation button now uses explicit readiness state and shows the first blocker inline when activation is blocked.
  - Transition success toast now confirms resulting status.
- Completed lifecycle audit payload enrichment:
  - `MEASURE_VERSION_STATUS_CHANGED` now includes:
    - `compileStatus`
    - `valueSetCount`
    - `testFixtureCount`
    - `testValidationPassed`
    - `activationBlockers`
- Added integration test coverage to verify richer transition audit payload fields are written.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Scheduled run backbone (P2 execution maturity)

- Added shared all-program run orchestrator service:
  - `backend/src/main/java/com/workwell/run/AllProgramsRunService.java`
  - `POST /api/runs/manual` now delegates to this shared service.
- Added scheduled trigger service:
  - `backend/src/main/java/com/workwell/run/ScheduledRunService.java`
  - Cron task calls all-program run path and persists outcomes/cases/audit via existing infrastructure.
  - Safe default posture: scheduler is disabled unless explicitly enabled.
- Added scheduler configuration:
  - `workwell.scheduler.enabled` from `WORKWELL_SCHEDULER_ENABLED` (default `false`)
  - `workwell.scheduler.cron` from `WORKWELL_SCHEDULER_CRON` (default `0 0 6 * * *`)

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `ac0a88d` (`feat(run): add scheduled all-program run backbone [S3]`)
- Backend redeployed to Fly: `https://workwell-measure-studio-api.fly.dev`
- Timestamped smoke check (`2026-05-04T00:33:15-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/measures` -> `200` (`measureCount=2`)
- `POST /api/runs/manual` with `{"scope":"All Programs"}` -> `200` (`runId=bc058da6-adea-4f74-a745-9f9dd34d7a66`, `activeMeasuresExecuted=2`)

### Run history/log visibility expansion (P2 execution maturity)

- Backend run APIs expanded:
  - `GET /api/runs` supports filters: `status`, `scopeType`, `triggerType`, `limit`
  - `GET /api/runs/{id}/logs` returns persisted run-log entries (latest-first)
  - Existing `GET /api/runs/{id}` retained for summary/detail
- Backend service additions:
  - Added run list query with filter and limit controls
  - Added run log query with limit controls
- Frontend `/runs` rewritten from S0 probe page to run-ops console:
  - Filter bar (status/scope/trigger)
  - Run history table with status/scope/duration
  - Run detail panel (counts, pass rate, timings)
  - Run logs panel (level/timestamp/message)
  - Manual "Run Measures Now" trigger integrated with refresh and selection
- Controller test coverage added for:
  - run list endpoint filters
  - run detail endpoint
  - run logs endpoint

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production deployment + hotfix checkpoint:
- Commits pushed:
  - `ebee7db` (`feat(run): expand run history and logs visibility [S3]`)
  - `443102c` (`fix(run): harden run list filtering and complete run visibility [S3]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Live issue discovered and fixed immediately:
  - Initial `GET /api/runs` returned `500` due to nullable filter SQL handling.
  - Fixed by switching to dynamic SQL condition construction (only bind `LOWER(?)` clauses when filters are present).
- Timestamped production smoke check (`2026-05-04T00:44:07-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/runs?limit=5` -> `200` (`runCount=5`)
  - `GET /api/runs/{id}` -> `200` (`status=completed`)
  - `GET /api/runs/{id}/logs?limit=5` -> `200` (`logCount=1`)
- `GET https://frontend-seven-eta-24.vercel.app/runs` -> `200`

### Data freshness indicators (P2 execution maturity)

- Added standardized freshness fields to run summary responses:
  - `dataFreshAsOf`: latest `outcomes.evaluated_at` timestamp for the run
  - `dataFreshnessMinutes`: age in minutes from `dataFreshAsOf` to now
- Frontend `/runs` detail panel now surfaces:
  - "Data Freshness: X min old"
  - "Data Fresh As Of: <timestamp>"
- Controller test fixture updated to include freshness fields in run summary payload.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `ec7c794` (`feat(run): add data freshness indicators to run summaries [S3]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Timestamped production smoke check (`2026-05-04T00:47:59-04:00`):
  - `GET /api/runs?limit=1` -> `200`
- `GET /api/runs/{id}` -> includes `dataFreshAsOf` and `dataFreshnessMinutes` (`30`)
- `GET https://frontend-seven-eta-24.vercel.app/runs` -> `200`

### Worklist filter expansion (P2 operations maturity)

- Expanded backend case list filters:
  - Existing: `status`, `measureId`
  - Added: `priority`, `assignee`, `site`
- Expanded frontend `/cases` filter controls:
  - `Status`, `Measure`, `Priority`, `Assignee`, `Site`
  - Query-string filter wiring to backend API
- Added `site` field to case summary payload and surfaced site in case cards.
- Updated MCP case listing integration call-site for new case-list method signature.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `f9e0ed2` (`feat(caseflow): expand worklist filters across api and ui [S4]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Timestamped production smoke check (`2026-05-04T01:11:34-04:00`):
  - `GET /api/cases?status=open&priority=HIGH` -> `200` (`highOpenCount=11`)
  - `GET /api/cases?status=all&site=Clinic` -> `200` (`clinicCasesCount=8`)
  - `GET /api/cases?status=all&assignee=unassigned` -> `200` (`unassignedCasesCount=28`)
  - `GET https://frontend-seven-eta-24.vercel.app/cases` -> `200`

### Assignment + escalation flow (P2 operations maturity)

- Added backend case actions:
  - `POST /api/cases/{caseId}/assign?assignee=<name>`
  - `POST /api/cases/{caseId}/escalate`
- Action behavior:
  - Assign updates `cases.assignee`, records `case_actions` row (`ASSIGNED`), emits `CASE_ASSIGNED`.
  - Escalate sets `priority=HIGH`, keeps `status=OPEN`, updates next action text, records `case_actions` row (`ESCALATED`), emits `CASE_ESCALATED`.
- Added frontend controls on case detail page:
  - Assignee input + Assign button
  - Escalate button
- Added controller tests for assign/escalate endpoints.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `46849b5` (`feat(caseflow): add assignment and escalation actions [S4]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Timestamped production smoke check (`2026-05-04T01:48:47-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/cases?status=open` -> `200` (`openCaseCount=27`, `caseId=c6d79a2f-8f86-4d48-ac91-06f21d478ccb`)
  - `POST /api/cases/{caseId}/assign?assignee=QA%20Lead&actor=codex-smoke` -> `200` (`status=OPEN`, `assignee=QA Lead`)
  - `POST /api/cases/{caseId}/escalate?actor=codex-smoke` -> `200` (`status=OPEN`, `priority=HIGH`)
  - `GET https://frontend-seven-eta-24.vercel.app/cases/{caseId}` -> `200`

### Case timeline/evidence consistency pass (P2 operations maturity)

- Improved assignment action evidence consistency:
  - Assignment payload now records real `previousAssignee` instead of `"unknown"`.
- Improved case timeline completeness:
  - Case detail timeline now merges both `audit_events` and `case_actions`, ordered chronologically.
  - Timeline payload entries now include `timelineSource` (`audit_event` or `case_action`) for clearer provenance.
- Improved case-detail evidence clarity:
  - Added structured quick-read fields for `why_flagged` in UI (last exam date, window, overdue days, eligibility, waiver status).
  - Timeline event labels are now human-readable (for example `CASE_ESCALATED` -> `Case Escalated`).

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

## 2026-05-03

### End-of-day closeout: status-source bugfix, run scope hardening, idempotency, MCP live-shape

- Completed critical status-source cleanup:
  - Removed legacy name-based filtering hacks for `AnnualAudiogramCompleted`.
  - Enforced `measure_versions.status` as the source of truth for active measure scope.
  - Added explicit active-scope query in run persistence:
    - `SELECT DISTINCT m.id, m.name, mv.id AS measure_version_id, mv.status FROM measures m JOIN measure_versions mv ON mv.measure_id = m.id WHERE mv.status = 'Active'`.
- Added manual all-programs run endpoint:
  - `POST /api/runs/manual` with scope `"All Programs"`.
  - Endpoint now resolves active measure versions via the active-scope query and persists a run with `scope_type='all_programs'`.
- Case upsert idempotency hardening:
  - Replaced split insert/update logic with a single `INSERT ... ON CONFLICT (employee_id, measure_version_id, evaluation_period) DO UPDATE`.
  - Confirmed case write path is now deterministic for reruns over the same key.
- Compliant rerun closure behavior aligned to spec:
  - Chosen state: `RESOLVED` (documented in code comment).
  - Compliant reruns now transition open cases to resolved state and emit `CASE_RESOLVED`.
- Seed strategy decision for `patient-*` rows:
  - Selected Option A.
  - Removed `patient-*` exclusion filter from case list path.
  - Added code comment documenting legacy `patient-*` + `emp-*` rows as valid demo records.
- MCP tools wired to explicit live payload contracts:
  - `list_cases` now returns status, priority, assignee, and `measure_version_id`.
  - `get_run_summary` now returns `total_cases`, `compliant_count`, `non_compliant_count`, `pass_rate`, and `duration`.
  - `get_case` now exposes full evidence payload plus extracted `why_flagged`.
- Evidence payload structured:
  - Demo run engines now persist `why_flagged` object with:
    - `last_exam_date`, `compliance_window_days`, `days_overdue`, `role_eligible`, `site_eligible`, `waiver_status` (+ outcome metadata).
- Audit coverage added:
  - `MEASURE_VERSION_DRAFT_SAVED` on spec/CQL draft edits.
  - `MEASURE_VERSION_STATUS_CHANGED` on lifecycle transitions (including activation).
  - `RUN_STARTED` and `RUN_COMPLETED` on run flows (measure runs + case rerun verification + all-program runs).

Verification checkpoints (local):
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests \"com.workwell.web.CaseControllerTest\" --tests \"com.workwell.web.EvalControllerTest\"` -> PASS
- `backend\\gradlew.bat test` -> FAIL on environment-level Docker/Testcontainers availability (`DockerClientProviderStrategy`), not on compile.
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Follow-up verification after Docker restore:
- `backend\\gradlew.bat test` -> PASS (all tests green once Docker/Testcontainers were available).
- Fresh DB smoke issue found and fixed:
  - Initial `/api/runs/manual` on empty DB returned `500` (`No active measures found to execute`).
  - Fix applied in `EvalController`: call `measureService.listMeasures()` before resolving active measure scope so default active seeds are present.
- Smoke re-run against containerized backend + postgres:
  - `POST /api/runs/manual` now succeeds on fresh DB without needing a prior `/api/measures` call.
  - Sample result: `activeMeasuresExecuted=2`, `totalEvaluated=25`, `totalCases=14`, `passRate=32.0`.

Git closeout:
- Grouped final changes into logical commits (backend+tests, frontend, docs) with spike-tagged commit messages.
- Verified no extra temp/runtime artifacts remained after Docker smoke runs.
- Final local checks remained green before closeout:
  - `backend\\gradlew.bat test`
  - `frontend npm run lint`
  - `frontend npm run build`

### Production consistency fix (advisor escalation: data-level cleanup)

- External validation continued to report stale public responses (`3` measures including `AnnualAudiogramCompleted`) despite app-level filtering checks from our side.
- To remove dependence on machine/region/code-path behavior, applied direct database cleanup against production data:
  - Legacy measure version rows for `AnnualAudiogramCompleted` set to `Deprecated` (no remaining `Active` versions).
  - Legacy placeholder open cases (`employee external_id LIKE 'patient-%'`) set to `CLOSED` with `closed_at=NOW()`.
- Post-change data assertions:
  - `active_legacy_versions=0`
  - `open_legacy_cases=0`

Timestamped production checkpoint (`2026-05-03T20:40:00-04:00`):
- `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `GET https://workwell-measure-studio-api.fly.dev/api/measures?cb=<timestamp>` -> `200`, returns exactly 2 active measures (`TB Surveillance`, `Audiogram`)
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&cb=<timestamp>` -> `200`, `open_count=13`, `legacy_rows=0`
- Response trace sample: `fly-request-id: 01KQR6W1V49NHKNZ0HQCYYXKG4-ord`

### D16 readiness sign-off (production walkthrough)

- Completed end-to-end live walkthrough aligned to `docs/DEMO_SCRIPT.md` on production backend + frontend.
- Confirmed clickable frontend shell routes for demo navigation:
  - `/measures`, `/studio`, `/runs`, `/cases`, `/programs`, `/worklist` all return `200` on `https://frontend-seven-eta-24.vercel.app`.
- Case lifecycle demo loop executed live on an open Audiogram overdue case:
  - `POST /api/cases/{caseId}/actions/outreach` -> case remained `OPEN`
  - `POST /api/cases/{caseId}/rerun-to-verify` -> case transitioned `CLOSED` with `COMPLIANT`
  - Case timeline tail includes `CASE_OUTREACH_SENT`, `CASE_RERUN_VERIFIED`, `CASE_CLOSED`

Timestamped endpoint checklist (`2026-05-03T20:00:00-04:00`):
- `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200` with 2 active measures (`TB Surveillance`, `Audiogram`)
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> `200`, no `patient-*` rows
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=<audiogram-id>` -> `200`, clean filtered list
- `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`; `GET /api/runs/{id}` -> `200` (`totalEvaluated=15`)
- `POST https://workwell-measure-studio-api.fly.dev/api/runs/tb-surveillance` -> `200`; TB case detail `nextAction` confirms TB-specific copy
- `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200`
- MCP Layer 1 validation: confirmed via Claude Code with live responses (open Audiogram cases + latest run summary)

- Readiness decision: operational demo flow is stable and sign-off ready for D16 with bug-fix-only posture.

### D16 pre-freeze bugfix pass (TB copy, legacy clutter, placeholder routes)

- Fixed TB next-action copy bug in caseflow action generation:
  - TB open-case actions now use TB-specific language:
    - `Schedule the annual TB screening before the due date.`
    - `Escalate TB screening follow-up immediately.`
    - `Collect the missing TB screening documentation.`
- Clarified verification detail:
  - Existing TB cases created before the fix retained old text.
  - After triggering a fresh TB run in production (`runId=6793de66-b547-445e-8bcf-90fff6b621ec`), TB case detail now shows corrected TB-specific `nextAction`.
- Removed legacy demo clutter from list surfaces:
  - Measure list now excludes legacy `AnnualAudiogramCompleted`.
  - Case list now excludes legacy placeholder employees (`patient-*`) and the legacy measure line.
- Replaced placeholder frontend routes to avoid blank-page demo risk:
  - `/programs` now provides navigation cards to live demo surfaces (`/measures`, `/runs`).
  - `/worklist` now routes users directly to live cases via CTA (`/cases`).
- Production verification:
  - `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> 2 measures (`TB Surveillance`, `Audiogram`)
  - `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> no `patient-*` rows
  - `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=<tb-id>` + case detail -> TB-specific `nextAction` confirmed
  - Frontend redeployed and aliased: `https://frontend-seven-eta-24.vercel.app`

### External advisor handoff refreshed

- Rewrote `docs/advisor_update.md` into a clean, comprehensive status packet for external advisor review.
- Included:
  - shipped scope through Step 6,
  - latest MCP validation evidence from Claude Code,
  - production smoke snapshot,
  - explicit agent recommendations for D16 demo-freeze strategy,
  - targeted clarifying questions for advisor guidance on final sequencing and risk tolerance.
- Intent: accelerate advisor feedback loop and lock final pre-D16 execution posture without scope creep.

### MCP validation confirmed (Claude Code + production smoke)

- Claude Code MCP validation now passes end-to-end with real data:
  - Prompt equivalent: "Show me all open Audiogram cases" returned 10 open Audiogram cases.
  - Prompt equivalent: "Get the summary of the latest run" returned run summary with counts:
    - `COMPLIANT=3`, `DUE_SOON=3`, `OVERDUE=4`, `MISSING_DATA=3`, `EXCLUDED=2`, `totalEvaluated=15`.
- This confirms stale-schema fallback works (`measureId=\"Audiogram\"`) and latest-run default behavior works (`get_run_summary` without `runId`).
- Production smoke pass rerun after validation:
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200` (Audiogram Active `v1.0`, TB Surveillance Active `v1.3`)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> `200` (17 open)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=4ae5d865-3d64-4a17-905d-f1b315a037e2` -> `200` (10 open Audiogram)
  - `2026-05-03T02:36:00-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200` (`runId=f7e73f4a-cc22-4be1-b417-9420040e0fd4`)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/runs/f7e73f4a-cc22-4be1-b417-9420040e0fd4` -> `200` (`totalEvaluated=15`)
  - `2026-05-03T02:36:00-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/tb-surveillance` -> `200` (`runId=5cc29869-8abf-4f66-9a09-2bdeee32751d`)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200`
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/sse` with `Accept: text/event-stream` -> `200` (stream endpoint reachable)

### MCP usability hotfix (Claude prompt compatibility)

- User validation surfaced MCP input friction: `list_cases` required `measureId` UUID and `get_run_summary` required explicit `runId`, which blocked natural-language prompt execution in Claude Code.
- Applied backend MCP compatibility update:
  - `list_cases` now supports either `measureId` **or** `measureName` (case-insensitive lookup through measure catalog).
  - `get_run_summary` now accepts optional `runId`; when omitted, it returns the latest persisted run.
  - Added `RunPersistenceService.loadLatestRun()` to back the latest-run path.
- Production checkpoint:
  - `2026-05-03T02:06:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T02:06:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200`

### Advisor sync - post-review execution reset

- Advisor review completed. Progress confirmed through S1 (Audiogram vertical) and early S4 backend (case lifecycle + audit chain).
- S2 (catalog/authoring) confirmed as the highest-priority remaining spike.
- Decision: rerun-to-verify remains demo-simulated for all measures through D16. Do not generalize the evaluator this sprint.
- Decision: S5 MCP scope is limited to Layer 1 only - three read-only tools (`get_case`, `list_cases`, `get_run_summary`) wrapping existing API endpoints. AI explain and write tools are post-D16.
- Decision: S6 video/walkthrough production is deferred until a stable live demo exists. Written demo script is sufficient for D16.
- Revised execution priority order is now recorded in `docs/SPIKE_PLAN.md` and supersedes prior task ordering.

### Step 0 checkpoint (docs-first update complete)

- Updated `docs/JOURNAL.md` and `docs/SPIKE_PLAN.md` per advisor instructions before implementation changes.
- Added explicit S2 thin-vertical scope note and revised priority order with deferred items.
- Production checkpoint:
  - `2026-05-02T23:58:38-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`

### Step 1 progress - S2 thin vertical implemented locally

- Implemented backend Measure APIs:
  - `GET /api/measures`
  - `POST /api/measures`
  - `GET /api/measures/{id}`
  - `PUT /api/measures/{id}/spec`
  - `PUT /api/measures/{id}/cql`
  - `POST /api/measures/{id}/cql/compile`
  - `POST /api/measures/{id}/status`
- Seeded Audiogram as catalog-visible Active `v1.0` in service-level seed guard.
- Implemented frontend S2 UI:
  - `/measures` table with status pills and create flow
  - `/studio/[id]` with Spec tab, CQL tab + compile gate, lifecycle action buttons
  - Save Draft success toast behavior on Spec save
- Local verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `frontend npm run lint` -> success
  - `frontend npm run build` -> success
- Deployment state:
  - Frontend production deployed: `https://frontend-seven-eta-24.vercel.app`
  - Backend deploy currently blocked on this machine because `flyctl` is not installed (`flyctl` command not found).
- Production checkpoint evidence:
  - `2026-05-02T23:58:38-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-02T23:58:38-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `404` (expected until backend deployment with Step 1 code)

### Step 1 deployment checkpoint (completed)

- Backend deployed via Fly after `flyctl` install.
- Production checkpoint:
  - `2026-05-03T00:17:01-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T00:19:48-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200`
- Frontend production deployed and aliased:
  - `https://frontend-seven-eta-24.vercel.app`

### Step 2 — S3 audit + minimum generalization refactor

Audit answers:

- Which classes/methods in `AudiogramDemoService` and `RunPersistenceService` were hardcoded to Audiogram fixtures?
  - `AudiogramDemoService.run()` hardcoded Audiogram patient fixture list and Audiogram-specific measure name/version.
  - `RunPersistenceService.persistAudiogramRun(...)`, `loadLatestAudiogramRun()`, `loadOutcomesForRun(...)`, and seed helpers (`ensureMeasure*`) were coupled to Audiogram types/constants and patient-id naming.
- Does `CaseFlowService` reference any Audiogram-specific types or IDs?
  - Before refactor: yes, method signatures used `AudiogramDemoService.AudiogramOutcome`, and several message strings/templates were Audiogram-specific.
  - After refactor: shared case upsert path now uses generic `DemoOutcome` model and no longer depends on Audiogram Java types/IDs.
- Can a second measure seeded run be added by implementing a new `DemoService` + registering it, without modifying `CaseFlowService` or `RunPersistenceService`?
  - Yes. `RunPersistenceService` now exposes `persistDemoRun(DemoRunPayload)` and `CaseFlowService` accepts generic outcome models (`upsertCases(...)`), so a second measure service can plug into the same run/case/audit infrastructure.

Minimum changes applied:

- Added shared run models:
  - `backend/src/main/java/com/workwell/run/DemoRunModels.java`
- Refactored shared persistence to generic payload:
  - `RunPersistenceService.persistDemoRun(...)` added and used by existing Audiogram path.
- Refactored shared case upsert path to generic outcomes:
  - `CaseFlowService.upsertCases(...)` now accepts shared `DemoOutcome`.
- Kept simulation pattern in place (no generalized evaluator introduced).

Verification + deployment checkpoint:

- Local backend verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Production checkpoint:
  - `2026-05-03T00:23:51-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T00:23:51-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200`
  - `2026-05-03T00:23:51-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`

### Step 3 — S4 worklist filter cleanup + audit-linkage verification

Implemented:

- Backend case filters:
  - `GET /api/cases?status=open|closed|all` (default `open`)
  - `GET /api/cases?measureId=<measure-id>` (optional, combinable with status)
- Frontend `/cases` filter controls:
  - `Status` dropdown (Open / Closed / All), default Open
  - `Measure` dropdown (populated from active measures)
  - Re-fetch on filter changes

Audit chain linkage verification (Audiogram path):

- Code-path inspection confirms required run/case linkage for the demo lifecycle chain:
  - `CASE_CREATED` / `CASE_UPDATED` include `ref_run_id` and `ref_case_id`
  - `CASE_OUTREACH_SENT` includes `ref_run_id` and `ref_case_id`
  - `CASE_RERUN_VERIFIED` includes `ref_run_id` and `ref_case_id`
  - `CASE_CLOSED` includes `ref_run_id` and `ref_case_id`
- No additional linkage fix was required for the specified chain.

Verification + deployment checkpoint:

- Local verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `frontend npm run lint` -> success
  - `frontend npm run build` -> success
- Production deploy:
  - Backend deployed on Fly
  - Frontend deployed and aliased to `https://frontend-seven-eta-24.vercel.app`
- Production checkpoint:
  - `2026-05-03T00:28:21-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T00:28:21-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> `200` (3 cases)
  - `2026-05-03T00:28:21-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=<active-id>` -> `200` (filter path verified)

### Step 4 — S6 early (TB seed + synthetic dataset expansion)

Implemented:

- Added shared synthetic employee catalog with ~50 employees across required roles/sites:
  - Roles represented: `Maintenance Tech`, `Nurse`, `Welder`, `Office Staff`, `Industrial Hygienist`, `Clinic Staff`
  - Sites represented: `Plant A`, `Plant B`, `Clinic`
- Extended run persistence seeding to maintain the synthetic employee roster in `employees` and upsert profile fields (name, role, site).
- Expanded Audiogram simulation to a larger seeded cohort with mixed outcomes and persisted case generation through existing run/case/audit pipeline.
- Added `TBSurveillanceDemoService` and registered:
  - `POST /api/runs/tb-surveillance`
- Added TB measure seed in catalog as Active:
  - `TB Surveillance` version `v1.3`
- Aligned Audiogram demo run metadata to:
  - `Audiogram` version `v1.0`

TB run distribution validation:

- Production TB run response currently returns:
  - `outcomes=10`
  - `compliant=5`
  - `dueSoon=1`
  - `overdue=2`
  - `missingData=1`
  - `excluded=1`
- This satisfies the target mix for demo credibility and keeps run simulation per-measure (no generalized evaluator introduced).

Verification + deployment checkpoint:

- Local backend verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Production checkpoint:
  - `2026-05-03T01:04:54-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T01:04:54-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> includes Active `Audiogram` and Active `TB Surveillance`
  - `2026-05-03T01:04:54-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/tb-surveillance` -> `200`

### Step 5 — S5 MCP Layer 1 read tools

Implemented MCP Layer 1 as read-only tools only:

- `get_case`
  - Input: `caseId: string`
  - Returns full case detail payload from existing caseflow read path.
- `list_cases`
  - Input: `status?: string` (default `open`), `measureId?: string`
  - Returns case summaries using existing filtered case listing path.
- `get_run_summary`
  - Input: `runId: string`
  - Added supporting endpoint: `GET /api/runs/{id}` for run metadata + outcome counts by status.

Implementation notes:

- Added MCP Java SDK dependencies and Spring WebMVC SSE transport wiring.
- MCP server config:
  - `backend/src/main/java/com/workwell/mcp/McpServerConfig.java`
- New run summary endpoint:
  - `backend/src/main/java/com/workwell/web/RunController.java`

Validation status:

- Programmatic MCP transport validation completed:
  - `GET /sse` returns MCP endpoint event with session-scoped message route.
  - MCP initialize and message POST handshake return success status.
- Full Claude Desktop interactive validation is pending in this environment (no direct Claude Desktop UI session available from this runtime).

Deployment checkpoint:

- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/runs/{id}` -> `200`
- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/sse` -> MCP endpoint advertised

### Step 6 — S6 final (audit export + demo script)

Implemented:

- Audit trail CSV export endpoint:
  - `GET /api/audit-events/export?format=csv`
  - Columns: `timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail`
- Frontend export control:
  - Added **Export CSV** button on `/cases` to trigger browser download.
- Added written demo script:
  - `docs/DEMO_SCRIPT.md`

Local verification:

- `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- `frontend npm run lint` -> success
- `frontend npm run build` -> success

Production checkpoint:

- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200` (`text/csv`)

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

- MCP schema-compat deploy checkpoint:
  - 2026-05-03T13:53:42.1028589-04:00 GET https://workwell-measure-studio-api.fly.dev/actuator/health -> UP
