# WorkWell Measure Studio — Remaining Sprint TODO
> All items below are prioritised by demo / governance credibility impact.
> Walk-through video is excluded (owner: Taleef, D15).

---

## Legend
| Symbol | Meaning |
|--------|---------|
| 🔴 CRITICAL | Destroys a core demo/governance story if absent |
| 🟡 MAJOR | Visible regression vs. internship proposal or v0 storyboard |
| 🔵 MINOR | Polish/correctness issue; degrades confidence but won't block demo |

---

## ✅ 🔴 CRITICAL-1 — Authentication & Role-Based Access Control (DONE 2026-05-07)

### Pain Point
`SecurityConfig.java` has `auth.anyRequest().permitAll()` — every endpoint is wide open.
The entire governance and accountability story rests on *named actors* operating within
defined roles (Author, Approver, Case Manager, Admin). Without this:
- The audit log records `"actor": "case-manager"` as a hardcoded string — completely meaningless.
- The internship proposal lists Role Separation as a **Phase 0 foundation** (before any other
  phase can be considered complete).
- In a live demo with Doug, anyone could hit any mutation endpoint as anyone — there is no
  story about trust, accountability, or separation of duties.
- Approval workflows (blocking activation until an Approver signs off) are theatre without
  real role checks.

### Scope of work
1. Define four roles as Spring Security authorities: `ROLE_AUTHOR`, `ROLE_APPROVER`,
   `ROLE_CASE_MANAGER`, `ROLE_ADMIN`.
2. Create a `demo_users` table (migration V003) seeded with one named user per role:
   - `author@workwell.dev` / `approver@workwell.dev` / `cm@workwell.dev` / `admin@workwell.dev`
   - Passwords bcrypt-hashed; store in migration for deterministic demo resets.
3. Issue signed JWT on `POST /api/auth/login`; validate on every protected route via a
   `JwtAuthFilter`.
4. Lock down endpoints by role:
   - `POST /api/measures/**` (create/edit/clone) → AUTHOR, ADMIN
   - `POST /api/measures/*/activate` → APPROVER, ADMIN
   - `POST /api/runs/**` → CASE_MANAGER, ADMIN
   - `POST /api/cases/*/actions` → CASE_MANAGER, ADMIN
   - `GET /api/admin/**` → ADMIN
   - All `GET` endpoints → any authenticated user
5. Replace every hardcoded `"actor"` string with `SecurityContextHolder.getContext()
   .getAuthentication().getName()` so audit rows reflect real user email.
6. Frontend: store JWT in memory (not localStorage); add login page at `/login`;
   redirect unauthenticated requests; show current user + role badge in header.
7. Seed the four demo personas into `SyntheticEmployeeCatalog` so they also appear
   as employees where relevant.

### Acceptance criteria
- Unauthenticated request to any mutation endpoint returns 401.
- `cm@workwell.dev` cannot activate a measure (returns 403).
- `author@workwell.dev` cannot close a case (returns 403).
- Audit log rows show the logged-in user's email, not "system" or "case-manager".
- Frontend shows logged-in user email and role badge in the top navigation bar.

Status:
- Completed and verified on 2026-05-07.
- Implemented `demo_users` migration (`V003`), JWT login (`POST /api/auth/login`), JWT auth filter, role-gated endpoint policy, actor resolution from security context, `/login` frontend flow with in-memory JWT session, and header user/role badge.
- Demo login credentials: `author@workwell.dev`, `approver@workwell.dev`, `cm@workwell.dev`, `admin@workwell.dev` (password: `Workwell123!`).

---

## ✅ 🔴 CRITICAL-2 — Measures Catalog Shows Active-Only (All Statuses Required) (DONE 2026-05-07)

### Pain Point
`MeasureService.listMeasures()` filters with `WHERE mv.status = 'Active'`.
Ticket 1 acceptance criteria from the proposal explicitly says the catalog must list
**all measures with a visible status pill**. Currently:
- An Author who creates a Draft measure cannot see their own work in the catalog.
- A deprecated measure vanishes entirely — no audit trail visible in the UI.
- The lifecycle story (Draft → Approved → Active → Deprecated) cannot be demonstrated
  end-to-end because two of the four states are invisible.
- Approvers cannot see what is pending their review.

### Scope of work
1. Remove the `status = 'Active'` predicate from `MeasureService.listMeasures()`.
2. Add an optional `?status=` query parameter so callers can filter if they choose.
3. Add a `?search=` query param for name/tag filtering (already partially exists on
   the frontend but the backend doesn't support it on this endpoint).
4. Return `currentStatus`, `statusUpdatedAt`, and `statusUpdatedBy` in the list
   response DTO.
5. Frontend Catalog page: add a status filter pill row (All / Draft / Approved /
   Active / Deprecated) and render a coloured `<Badge>` per row using the status.
6. Ensure the "New Version" / "Clone" action is only shown to Authors; "Approve"
   button only shown to Approvers (ties to CRITICAL-1).

### Acceptance criteria
- A freshly created Draft measure appears immediately in the catalog with a grey "Draft" pill.
- Filtering by "Approved" shows only measures in Approved state.
- Filtering by "Active" reproduces the previous default view.
- A deprecated measure shows a red "Deprecated" pill and is not executable.

Status:
- Completed and verified on 2026-05-07.
- Backend catalog now returns all lifecycle statuses by default, with optional `?status=` and `?search=` filters.
- Catalog response now includes `statusUpdatedAt` and `statusUpdatedBy`.
- Frontend Measures page now has status filter pills (`All/Draft/Approved/Active/Deprecated`), a search box, and status badges per row.
- Studio role visibility tightened:
  - `New Version` action shown only for `ROLE_AUTHOR`.
  - `Approve` action shown only for `ROLE_APPROVER`.

---

## ✅ 🔴 CRITICAL-3 — Manual Case Closure ("Mark Resolved") (DONE 2026-05-07)

### Pain Point
The proposal workflow explicitly lists "Mark resolved (manual closure)" as one of the
five case action types. Currently the only way a case closes is via a successful
rerun-to-verify — which requires the employee to already be compliant in the CQL
evaluation. This means:
- Cases where compliance was confirmed *off-system* (paper record, verbal
  confirmation, external system) can never be closed.
- Case managers can see cases stack up with no way to clear them.
- The worklist will balloon during a demo: every non-compliant employee from every
  historical run sits open forever.
- The proposal's "case manager closes + verifies in one pass" success criterion
  is not achievable.

### Scope of work
1. Add `POST /api/cases/{id}/actions` payload variant: `{ type: "RESOLVE", note: "...",
   resolvedAt: "ISO8601", resolvedBy: "actorEmail" }`.
2. `CaseService.resolveCase()`: set `status = 'CLOSED'`, `closedAt`, `closedReason =
   'MANUAL_RESOLVE'`, `closedBy`; write audit event `CASE_MANUALLY_CLOSED`.
3. Guard: only `ROLE_CASE_MANAGER` and `ROLE_ADMIN` may call this; return 403 otherwise.
4. Frontend Case Detail panel: add "Mark Resolved" button in the actions section;
   open a modal requiring a mandatory closure note; on confirm call the endpoint and
   optimistically update case status chip to "Closed".
5. Worklist query must exclude `CLOSED` cases from the default view; add a "Closed"
   filter tab so managers can review historical closures.

### Acceptance criteria
- Case manager can close any OPEN or IN_PROGRESS case with a note.
- Closed case disappears from the default worklist view.
- Audit log contains a `CASE_MANUALLY_CLOSED` event with actor email and note.
- Author cannot close a case (403).

Status:
- Completed and verified on 2026-05-07.
- Added closure action endpoint:
  - `POST /api/cases/{id}/actions` with `{ type: "RESOLVE", note, resolvedAt, resolvedBy }`.
- Added service workflow:
  - `CaseFlowService.resolveCase(...)` now enforces `OPEN`/`IN_PROGRESS` only, requires closure note, sets case to `CLOSED`, sets `closed_at`, `closed_reason = MANUAL_RESOLVE`, and `closed_by`.
  - Writes both case action (`RESOLVE`) and audit event `CASE_MANUALLY_CLOSED`.
- Added case closure fields via migration `V004__case_manual_closure_fields.sql`:
  - `cases.closed_reason`
  - `cases.closed_by`
- Frontend Case Detail now includes `Mark Resolved` action with required-note modal and optimistic status refresh.
- Worklist has explicit status tabs (`Open`, `Closed`, `All`) and default open view continues to hide closed items.

---

## ✅ 🔴 CRITICAL-4 — Schedule Appointment Case Action (DONE 2026-05-07)

### Pain Point
The proposal workflow diagram shows "Schedule appointment" as a distinct action branch
with: appointment confirmation → notify employee/supervisor → log scheduling action.
It is entirely absent. The workflow diagram is the *most visual* artifact in the
internship deliverable — Doug will notice the missing branch immediately.
This is the highest-frequency occupational health intervention (audiogram follow-up,
annual physical, TB test scheduling) so its absence hollows out the ops story.

### Scope of work
1. Add DB table (migration V004): `scheduled_appointments (id, case_id, employee_id,
   measure_id, appointment_type, scheduled_at, location, status [PENDING/CONFIRMED/
   CANCELLED], notes, created_by, created_at)`.
2. `POST /api/cases/{id}/actions` variant: `{ type: "SCHEDULE_APPOINTMENT",
   appointmentType, scheduledAt, location, notes }`.
3. `AppointmentService.scheduleAppointment()`: insert row, write audit event
   `APPOINTMENT_SCHEDULED`, update case status to `IN_PROGRESS` if currently `OPEN`.
4. `GET /api/cases/{id}/appointments` — list appointments for a case (used by evidence
   timeline).
5. Frontend Case Detail: "Schedule Appointment" button opens a modal with date/time
   picker, appointment type dropdown (Audiogram / TB Test / Annual Physical / Flu
   Vaccine / Other), location field, notes. On save, the timeline refreshes showing
   the new appointment entry.
6. Appointment appears in the case evidence timeline as a distinct event type with a
   calendar icon.
7. (Simulated) Auto-notification: after appointment is saved, create an outreach record
   of type `APPOINTMENT_REMINDER` in `QUEUED` state — demonstrating the notification
   branch without a real calendar system.

### Acceptance criteria
- Scheduling an appointment changes case status to IN_PROGRESS.
- Appointment appears in the evidence timeline.
- An outreach record of type APPOINTMENT_REMINDER is auto-created in QUEUED state.
- Audit log contains `APPOINTMENT_SCHEDULED` with actor, case ID, and `scheduledAt`.
- Author cannot schedule appointments (403).

Status:
- Completed and verified on 2026-05-07.
- Added appointment + reminder persistence:
  - `scheduled_appointments` table
  - `outreach_records` table (for queued reminder records)
  - Migration: `V005__scheduled_appointments_and_outreach_records.sql`
- Added case action variant:
  - `POST /api/cases/{id}/actions` with `{ type: "SCHEDULE_APPOINTMENT", appointmentType, scheduledAt, location, notes }`
- Added service workflow:
  - `CaseFlowService.scheduleAppointment(...)`
  - Inserts appointment row
  - Inserts `APPOINTMENT_REMINDER` outreach record in `QUEUED` state (`auto_triggered=true`)
  - Moves case `OPEN -> IN_PROGRESS`
  - Writes audit event `APPOINTMENT_SCHEDULED`
- Added appointments read endpoint:
  - `GET /api/cases/{id}/appointments`
- Frontend Case Detail:
  - Added `Schedule Appointment` modal (type, datetime, location, notes)
  - Added appointment list panel
  - Timeline icon updated for appointment events.

---

## ✅ 🔴 CRITICAL-5 — Upload Evidence / Documentation Case Action (DONE 2026-05-07)

### Pain Point
The proposal workflow shows "Upload evidence (PDF/result)" → "Link evidence to case +
update timeline" → "Log evidence upload". This is absent entirely.
Occupational health compliance inherently involves paper artefacts: lab results, fit
test certificates, vaccination records. Without this action:
- Cases that are compliant by external documentation have no way to record that evidence.
- The "Why Flagged" story is one-directional (system says flagged) with no operator
  rebuttal path.
- The case timeline is thin — only outreach entries and reruns appear.

### Scope of work
1. Add `evidence_attachments` table (migration V005): `(id, case_id, uploaded_by,
   file_name, file_size_bytes, mime_type, storage_key, description, uploaded_at)`.
   For demo: store files on the server filesystem under `uploads/evidence/{case_id}/`
   (no S3 required for sprint).
2. `POST /api/cases/{id}/evidence` — multipart upload endpoint; accept PDF, PNG, JPG
   ≤ 10 MB; store file; insert DB row; write audit event `EVIDENCE_UPLOADED`.
3. `GET /api/cases/{id}/evidence` — list evidence for a case.
4. `GET /api/evidence/{id}/download` — stream file back (inline for images, attachment
   for PDF).
5. Frontend Case Detail: "Upload Evidence" button opens a file picker + description
   field; shows upload progress; on success, evidence appears in the timeline with
   file name, uploader, and a download link.
6. Evidence entries display with a paperclip icon in the timeline; PDF files show a
   preview thumbnail placeholder.

### Acceptance criteria
- PDF and image files upload and appear in the case timeline.
- Files > 10 MB are rejected with a clear error message.
- Audit log contains `EVIDENCE_UPLOADED` with file name and uploader.
- Download link streams the correct file.
- Evidence table is visible in `/api/admin/audit` export.

Status:
- Completed and verified on 2026-05-07.
- Added persistence + storage:
  - `evidence_attachments` table via `V006__evidence_attachments.sql`.
  - Files stored under `uploads/evidence/{caseId}/...`.
- Added backend endpoints:
  - `POST /api/cases/{id}/evidence` (multipart upload)
  - `GET /api/cases/{id}/evidence` (list evidence)
  - `GET /api/evidence/{id}/download` (stream file; inline images, attachment PDFs)
- Validation/limits:
  - Allowed mime types: PDF, PNG, JPG/JPEG
  - Max size: 10 MB (clear rejection message)
- Added audit + timeline signal:
  - Writes `EVIDENCE_UPLOADED` audit event with file metadata + actor.
- Frontend Case Detail:
  - Added file picker + description + upload action
  - Added evidence list with metadata and download links
  - Added evidence timeline icon handling.

---

## ✅ 🟡 MAJOR-1 — Employee Evaluation Population Too Small for Demo (DONE 2026-05-07)

### Pain Point
`CqlEvaluationService` evaluates only 12–15 hardcoded employees per measure.
The v0 storyboard shows 142 compliant employees for TB Surveillance alone.
In a demo context, counts of 12–15 read as a toy prototype. The internship proposal
calls for a "seeded demo dataset" at enterprise scale. When Doug sees run summaries
with 8 compliant and 4 overdue, the system looks unfinished rather than production-ready.

### Scope of work
1. `SyntheticEmployeeCatalog.java` already generates 100 employees — wire
   `CqlEvaluationService` to pull from the full catalog instead of a hardcoded list.
2. Generate CQL-compatible FHIR input bundles for all 100 employees per measure
   (deterministic seed: employee ID → compliance outcome so reruns are stable).
3. Parameterise compliance rate per measure in `application.yml`:
   - `audiogram`: 78% compliant
   - `tb_surveillance`: 91% compliant
   - `hazwoper`: 65% compliant
   - `flu_vaccine`: 84% compliant
4. Update historical run seeding (5 runs × 30-day intervals) to use full 100-employee
   population with ±5% variance per run (already partially done — verify it flows through).
5. Run summary counts must now reflect the full population. Confirm `run_outcomes` rows
   are inserted for all 100 employees per run (not just the 12-15 previously).

### Acceptance criteria
- Each manual run produces exactly 100 outcome rows (one per employee).
- TB Surveillance run summary shows ≥ 85 compliant employees.
- Historical seed data shows 5 runs with plausible upward compliance trends.
- No performance regression: run completes in < 30 seconds for 100 employees.

Status:
- Completed and verified on 2026-05-07.
- `CqlEvaluationService` now evaluates the full `SyntheticEmployeeCatalog` population (100 employees) for each measure.
- Added deterministic seeded outcome assignment keyed by `measure + employeeId` so reruns are stable.
- Added configurable compliance targets in `application.yml`:
  - `audiogram: 0.78`
  - `tb_surveillance: 0.91`
  - `hazwoper: 0.65`
  - `flu_vaccine: 0.84`
- Historical seeding flow (`SeedHistoricalRunsService`) verified against full-population payloads and pass-rate variance deltas.
- Backend query bug fixed in `MeasureService.listMeasures(...)` (PostgreSQL null-parameter typing issue) to keep manual run seeding path stable.
- Added integration verification coverage:
  - `Major1PopulationIntegrationTest` verifies:
    - 100 outcomes per measure in manual all-program runs
    - TB compliant count >= 85
    - historical seed creates 5 runs with upward compliant trend
  - `CqlEvaluationServiceTest` updated for 100-employee deterministic evaluation path and per-employee fallback isolation.

---

## ✅ 🟡 MAJOR-2 — Release / Approval Tab Missing from Studio (DONE 2026-05-08)

### Pain Point
The v0 storyboard shows five Studio tabs: Spec / CQL / Value Sets / Tests /
**Release-Approval**. The current implementation has four tabs with scattered status
buttons outside any formal tab. The Approval workflow — the governance centrepiece of
measure lifecycle — has no dedicated surface. Without this tab:
- Approvers have no obvious place to perform their role.
- The compile gate and test fixture gate results are not surfaced before the approval
  decision.
- The transition from Approved → Active is buried in a dropdown, not a deliberate
  gate with visibility into readiness.

### Scope of work
1. Add a fifth `Release & Approval` tab to the Studio page
   (`frontend/app/(dashboard)/studio/[id]/page.tsx`).
2. Tab content sections:
   - **Readiness Checklist**: compile status (✅/❌), test fixture status (✅/❌),
     value set resolvability (✅/⚠️/❌), required spec fields complete (✅/❌).
   - **Version History**: table of all versions for this measure with status pills,
     author, created date, change summary.
   - **Approval Action** (shown only to APPROVER/ADMIN): "Approve for Release" button
     (disabled if checklist has any ❌); confirmation modal showing the checklist
     summary; on confirm → `POST /api/measures/{id}/approve`.
   - **Activate** (shown only after Approved, to APPROVER/ADMIN): "Activate Measure"
     button; confirmation modal warning that this replaces any currently Active version.
   - **Deprecate** (shown only for Active, to ADMIN): "Deprecate" button with
     mandatory deprecation reason field.
3. Backend: add `POST /api/measures/{id}/approve` endpoint (`APPROVER`, `ADMIN` only)
   that transitions status Draft → Approved and writes audit event `MEASURE_APPROVED`.
   The existing activate/deprecate endpoints stay but move their UI surface here.
4. The Approve button must be disabled (with tooltip) if compile status is ERROR or
   test fixtures are failing.

### Acceptance criteria
- Fifth tab "Release & Approval" visible in Studio.
- Readiness checklist accurately reflects compile/test/value-set state.
- Approver role can approve; Author role sees the tab read-only.
- Approving a measure with compile errors is blocked (button disabled + tooltip).
- Audit log shows `MEASURE_APPROVED` with approver email.

Status:
- Completed and verified on 2026-05-08.
- Added Studio fifth tab: `Release & Approval`.
- Added checklist surface in tab:
  - Compile status (`✅/❌`)
  - Test fixture validation (`✅/❌`)
  - Value set resolvability (`✅/⚠️/❌`)
  - Required spec fields completeness (`✅/❌`)
- Added Version History table in Studio with version, status, author, created date, and change summary.
- Added backend release actions:
  - `POST /api/measures/{id}/approve`
  - `POST /api/measures/{id}/deprecate` (requires mandatory reason)
  - `GET /api/measures/{id}/versions` (history)
- Approval behavior:
  - Only `Draft -> Approved`
  - Enforces compile status `COMPILED|WARNINGS` and passing fixtures
  - Writes `MEASURE_APPROVED` audit event with approver identity.
- Release actions in UI moved to Release tab with confirmation modals:
  - `Approve for Release` (APPROVER/ADMIN; disabled with tooltip when blocked)
  - `Activate Measure` (APPROVER/ADMIN after Approved)
  - `Deprecate` (ADMIN only, mandatory reason)
- Security policy updated:
  - `/api/measures/*/approve` -> APPROVER/ADMIN
  - `/api/measures/*/deprecate` -> ADMIN

---

## ✅ 🟡 MAJOR-3 — Outreach Templates Not Migration-Managed (Fragile Fallback) (DONE 2026-05-08)

### Pain Point
`OutreachTemplateService.listTemplates()` catches `DataAccessException` and falls back
to in-memory hardcoded defaults when the `outreach_templates` table doesn't exist.
This is a silent failure: the system *appears* to work but the templates are not
persisted, not auditable, and will diverge from demo expectations if the table is
ever created later with different data. It also means template edits made through
the admin UI are lost on restart. A fallback that swallows a schema error in production
is a data integrity time-bomb.

### Scope of work
1. Write migration V003 (or next available): create `outreach_templates` table with
   columns `(id, name, subject, body, type [OUTREACH/APPOINTMENT_REMINDER/ESCALATION],
   created_by, created_at, updated_at, active)`.
2. Seed four templates in the same migration:
   - Hearing Conservation Overdue Outreach
   - TB Surveillance Follow-Up
   - General Compliance Reminder
   - Appointment Confirmation (for APPOINTMENT_REMINDER type)
3. Remove the `DataAccessException` catch-and-fallback block in
   `OutreachTemplateService`; let the real persistence layer handle all CRUD.
4. Add `POST /api/admin/outreach-templates` and `PUT /api/admin/outreach-templates/{id}`
   endpoints (ADMIN only) so templates are editable through the admin UI without
   code changes.
5. Verify the outreach modal correctly lists templates from DB at runtime.

### Acceptance criteria
- `outreach_templates` table exists after running all migrations from scratch.
- No DataAccessException fallback code remains in the service.
- Template edits through the admin UI persist across restarts.
- The outreach modal lists the four seeded templates.

Status:
- Completed and verified on 2026-05-08.
- Added migration `V007__outreach_templates.sql`:
  - creates `outreach_templates` with `name`, `subject`, `body_text`, `type`, `created_by`, `created_at`, `updated_at`, `active`
  - seeds four templates:
    - Hearing Conservation Overdue Outreach
    - TB Surveillance Follow-Up
    - General Compliance Reminder
    - Appointment Confirmation
- Removed fallback behavior in `OutreachTemplateService`:
  - deleted `DataAccessException` catch-and-fallback template path
  - templates now load strictly from DB persistence.
- Added admin mutation endpoints:
  - `POST /api/admin/outreach-templates`
  - `PUT /api/admin/outreach-templates/{id}`
- Added service persistence methods:
  - `createTemplate(...)`
  - `updateTemplate(...)`
  - type normalization/validation (`OUTREACH`, `APPOINTMENT_REMINDER`, `ESCALATION`).
- Security tightened for admin templates:
  - `/api/admin/**` now requires `ROLE_ADMIN`.

---

## ✅ 🟡 MAJOR-4 — Global "All Sites" + Date Range Header Filters Missing (DONE 2026-05-08)

### Pain Point
The v0 storyboard prominently shows two global filter controls in the top navigation:
"All Sites" dropdown and "Last 30 Days" date-range picker. These filters are expected
to cascade across the Dashboard, Runs list, Cases worklist, and Programs overview.
Currently the frontend has only a search box routing to `/cases?search=...`.
Without site and date filters:
- Multi-site organisations (WorkWell's core customer profile) cannot scope their view.
- The Programs overview sparklines are not time-bounded — "last 30 days" vs "all time"
  produces dramatically different compliance trends.
- The demo looks incomplete compared to the storyboard that was shown to Doug.

### Scope of work
1. Add a `GlobalFilterContext` (React context) providing `{ siteId, dateRange }` to
   all dashboard pages.
2. Header component: add `<SiteSelector>` (dropdown of unique sites from
   `synthetic_employees.site`) and `<DateRangePicker>` (preset options: Last 7 Days /
   Last 30 Days / Last 90 Days / All Time) to the top navigation bar.
3. Propagate filters via URL query params (`?site=SITE_A&from=2026-04-01&to=2026-05-07`)
   so links are shareable and browser-navigable.
4. Backend: add `?site=` and `?from=`/`?to=` params to:
   - `GET /api/runs` (filter by run `created_at` and scope's site)
   - `GET /api/cases` (filter by `created_at` and employee site)
   - `GET /api/programs/overview` (aggregate filtered by date range)
5. Synthetic employee data already has `site` field — confirm it's populated on all
   100 employees across at least 3 distinct sites (e.g., Site A / Site B / Site C).

### Acceptance criteria
- Selecting "Site B" in the header filters all dashboard widgets to Site B employees only.
- Changing date range from "Last 30 Days" to "All Time" updates run count and case count.
- URL reflects active filters; refreshing the page preserves the filter state.
- "All Sites" / "All Time" shows unfiltered aggregate data (existing behaviour).

Status:
- Completed and verified on 2026-05-08.
- Added frontend global filter plumbing:
  - `GlobalFilterContext` provider in dashboard layout.
  - Header controls for site + date preset (`7d`, `30d`, `90d`, `all`).
  - URL query propagation/preservation for `site`, `from`, and `to`.
- Added backend filtering support:
  - `GET /api/runs` now accepts `site`, `from`, `to`.
  - `GET /api/cases` now accepts `from`, `to` (with existing site support retained).
  - `GET /api/programs` and `GET /api/programs/overview` now support `site`, `from`, `to`.
  - Added `GET /api/programs/sites` for distinct site options.
  - Program trend/top-drivers endpoints now also support `site`, `from`, `to`.
- Updated dashboard pages to consume global filters:
  - `/programs`, `/runs`, and `/cases` now pass header filters through API calls.

---

## ✅ 🟡 MAJOR-5 — Auto-Notification on Case Creation Not Firing (DONE 2026-05-08)

### Pain Point
The proposal workflow states notifications should auto-trigger on case upsert based
on outcome status (Overdue → immediate outreach queued; Due Soon → reminder queued).
Currently outreach only happens via explicit operator action in the Case Detail panel.
This means:
- Cases created by scheduled or manual runs sit silently in the worklist — no
  employee-facing communication happens unless a case manager manually initiates it.
- The "templated notification workflow" mitigation listed in the proposal's Anticipated
  Challenges section is not implemented.
- High case volumes (100 employees × 4 measures = up to 400 cases) make manual
  outreach initiation per case untenable.

### Scope of work
1. In `CaseService.upsertCase()`, after a new case is created (not updated):
   - If outcome = `OVERDUE`: enqueue an outreach record using the "General Compliance
     Reminder" template with `status = 'QUEUED'` and `auto_triggered = true`.
   - If outcome = `DUE_SOON`: enqueue using the "Hearing Conservation Overdue Outreach"
     template (or the measure-appropriate template).
   - Write audit event `NOTIFICATION_AUTO_QUEUED` with case ID and template name.
2. `EXCLUDED` outcome: do not auto-notify (employee is explicitly excluded).
3. `MISSING_DATA` outcome: enqueue a "Missing Data Follow-Up" outreach (add this
   template to the migration in MAJOR-3).
4. The Case Detail outreach panel should visually distinguish auto-triggered
   notifications (show "Auto" badge) from manually initiated ones.
5. Add a counter badge to the Worklist tab title showing cases with no outreach yet
   queued (i.e., cases that fell through auto-notify due to a bug or edge case).

### Acceptance criteria
- Running a measure against 100 employees produces QUEUED outreach records for all
  OVERDUE and DUE_SOON cases automatically.
- EXCLUDED cases have no auto-queued outreach.
- Auto-triggered outreach records are marked `auto_triggered = true` in the DB.
- Audit log contains `NOTIFICATION_AUTO_QUEUED` for each auto-triggered record.
- Case Detail panel shows "Auto" badge on auto-triggered notifications.

Status:
- Completed and verified on 2026-05-08.
- Added auto-notification persistence on new case creation:
  - `CaseFlowService.upsertOpenCase(...)` now creates an `outreach_records` row for newly created `DUE_SOON`, `OVERDUE`, and `MISSING_DATA` cases.
  - New audit event `NOTIFICATION_AUTO_QUEUED` records the auto-queued template and outcome.
  - `EXCLUDED` cases do not create outreach records.
- Added missing-data outreach template seed:
  - Migration `V008__missing_data_follow_up_template.sql`
  - Seeds `Missing Data Follow-Up` for auto-queue use.
- Manual outreach now also records an `outreach_records` row so the record table reflects both manual and automated notifications.
- Case detail timeline now shows `Auto` / `Manual` badges for outreach-related entries.
- Worklist nav badge now shows how many open cases have not queued any outreach yet.

---

## ✅ 🟡 MAJOR-6 — EXCLUDED Outcomes Have No Worklist Representation (DONE 2026-05-08)

### Pain Point
The proposal states "Excluded recorded with waiver/exclusion context." Currently
`CaseService` skips case creation entirely for EXCLUDED outcomes. This means:
- There is no way to see which employees are excluded from a measure and why.
- Waivers cannot be tracked, audited, or reviewed for expiry.
- An employee excluded in error has no surface for correction.
- Reporting on exclusion rates (a real occupational health compliance metric) is
  impossible.

### Scope of work
1. Create `waivers` table (migration V009): `(id, employee_id, measure_id,
   measure_version_id, exclusion_reason, granted_by, granted_at, expires_at,
   notes, active)`.
2. When CQL evaluation returns EXCLUDED, `CaseService` should: create a case with
   `status = 'EXCLUDED'`; link to a waiver row if exclusion context is present in
   the `expressionResults`; write audit event `CASE_EXCLUDED`.
3. Worklist: add an "Excluded" filter tab that shows excluded cases with their
   exclusion reason and waiver expiry date (if applicable).
4. Admin surface: `GET /api/admin/waivers` list with filters for measure, site,
   expiry date; `POST /api/admin/waivers` to manually grant waivers (ADMIN only).
5. If a waiver has `expires_at` in the past, surface a warning badge on the excluded
   case ("Waiver Expired — Rerun Recommended").

### Acceptance criteria
- EXCLUDED outcomes produce case rows with `status = 'EXCLUDED'`.
- Excluded cases appear in the Worklist under the "Excluded" filter tab.
- Waivers table is populated for cases where exclusion context is available.
- Expired waivers surface a warning in the Case Detail panel.

Status:
- Completed and verified on 2026-05-08.
- Added waiver persistence and lookup via `V009__waivers.sql` and `WaiverService`.
- EXCLUDED outcomes now create `EXCLUDED` case rows, link waiver context when available, and surface exclusion reason plus waiver expiry / expired badges in the worklist and case detail views.
- Admin waivers surface now supports listing/filtering and manual grant flows.

---

## ✅ 🟡 MAJOR-7 — Monaco Editor Absent (Textarea Regression) (DONE 2026-05-08)

### Pain Point
The v0 storyboard was built with a Monaco editor (VS Code's editor engine) for CQL
authoring. The current textarea is a hard regression — no syntax highlighting, no
bracket matching, no line numbers, no error inline annotations. The "no new
dependencies after D5" rule blocked this but it is now D6+ and the sprint window
still has days remaining. A CQL editor with syntax highlighting is the most
*visually* impressive part of the authoring story and the first thing a technical
reviewer will notice.

### Scope of work
1. Add `@monaco-editor/react` to `frontend/package.json` (this is a React wrapper —
   no separate Monaco CDN needed; it lazy-loads the worker).
2. Replace the `<textarea>` in the Studio CQL tab with `<Editor language="sql">`
   (CQL is close enough to SQL for syntax colouring; alternatively register a custom
   language tokeniser for CQL keywords).
3. Wire `onChange` to the existing CQL state; wire `markers` / `setModelMarkers` to
   display backend compile errors as red squiggles at the correct line/column
   (the backend already returns `line` and `column` in compile error responses).
4. Set the editor theme to `vs-dark` (matches the dark sidebar; toggle with the
   page's light/dark mode).
5. Make the editor height auto-grow to fill the tab panel (min 400px, max 100vh minus
   header).

### Acceptance criteria
- CQL tab shows Monaco editor with line numbers and syntax colouring.
- Compile errors from the backend appear as red underline squiggles at the correct
  line and column.
- Clicking a squiggle shows the error message in a hover tooltip.
- Editor content is preserved when switching tabs and returning to the CQL tab.

Status:
- Completed and verified on 2026-05-08.
- Added `@monaco-editor/react` and replaced the CQL textarea with a Monaco editor using SQL syntax highlighting, dark theme, automatic layout, and preserved view state.
- Backend compile errors now include line/column prefixes, and the frontend parses those messages into Monaco markers for squiggles plus the visible error list.

---

## ✅ 🔵 MINOR-1 — OSHA/Policy Reference Dropdown Added (DONE 2026-05-08)

### Pain Point
The v0 storyboard shows a pre-populated OSHA reference dropdown in the Spec tab
(e.g., "29 CFR 1910.95 — Occupational Noise Exposure", "29 CFR 1910.1030 — BBP").
The current implementation uses a plain text input. While functionally equivalent,
a dropdown with pre-populated OSHA citations makes the system look purpose-built
for occupational health compliance rather than generic. This is a low-effort change
with high visual signal during a demo walkthrough.

### Scope of work
1. Add `osha_references` table (migration V010) with columns `(id, cfr_citation,
   title, program_area)` seeded with at least 8 common occupational health citations:
   - 29 CFR 1910.95 — Occupational Noise Exposure
   - 29 CFR 1910.1030 — Bloodborne Pathogens
   - 29 CFR 1910.134 — Respiratory Protection
   - 29 CFR 1910.1020 — Access to Employee Exposure and Medical Records
   - 29 CFR 1910.120 — HAZWOPER
   - 29 CFR 1910.1096 — Ionizing Radiation
   - 29 CFR 1904 — Recording and Reporting Occupational Injuries and Illnesses
   - 29 CFR 1910.269 — Electric Power Generation (for utility sector)
2. `GET /api/osha-references` — public (authenticated) list endpoint.
3. Frontend Spec tab: replace free-text `policyRef` input with a searchable
   combobox (`<Combobox>` from shadcn/ui) populated from the endpoint. Allow
   free-text entry as a fallback for non-OSHA references.
4. Store the selected `osha_reference_id` FK in `measure_versions` and return it
   in the measure version DTO.

### Acceptance criteria
- Spec tab shows a searchable OSHA reference dropdown.
- All 8 seeded references appear in the dropdown.
- Free-text entry still works for non-OSHA references.
- Selected reference is persisted and reloaded when reopening the measure.

Status:
- Completed and verified on 2026-05-08.
- Added migration `backend/src/main/resources/db/migration/V010__osha_references.sql`:
  - creates `osha_references`
  - adds `measure_versions.osha_reference_id`
  - seeds 8 common occupational health citations
  - backfills existing matching measure versions where policy text already matches a curated citation
- Added authenticated list endpoint:
  - `GET /api/osha-references`
- Updated Studio Spec tab:
  - replaced the free-text policy reference field with a searchable combobox
  - supports curated OSHA citations plus free-text fallback
  - preserves the selected structured reference when reopening the measure
- Updated measure version plumbing so the selected OSHA reference id round-trips through the backend DTO and persistence layer.

---

## ✅ 🔵 MINOR-2 — "Log Case Viewed" Audit Event Missing (DONE 2026-05-08)

### Pain Point
The proposal workflow diagram explicitly shows a "Log case viewed" audit event when
a case manager opens a case. This is standard in compliance systems — knowing *who*
looked at a sensitive employee record is as important as knowing who changed it.
Currently the Case Detail page loads without any audit trail of access. In a
healthcare/occupational-health context, this is a significant oversight.

### Scope of work
1. Backend: `GET /api/cases/{id}` — after fetching and returning the case, write
   a non-blocking audit event `CASE_VIEWED` with `caseId`, `actor` (from JWT),
   `viewedAt`. Use `@Async` so it doesn't add latency to the read path.
2. The `CASE_VIEWED` event should be visible in the audit log export but should
   *not* appear in the case's own timeline (it's an access log, not an action).
3. Admin audit page: add filter option "Access Events Only" to surface CASE_VIEWED
   events separately from mutation events.

### Acceptance criteria
- Opening a case detail page produces a `CASE_VIEWED` audit event.
- Event appears in the admin audit log under "Access Events".
- Event does not appear in the case timeline.
- Event includes the actor's email (not a hardcoded string).

Status:
- Completed and verified on 2026-05-08.
- Added `CaseAccessAuditService` so case detail reads asynchronously emit `CASE_VIEWED` audit rows with case, actor, measure, and view timestamp context.
- Case detail timeline excludes access events, and the admin audit log now supports access/mutation filtering through `/api/admin/audit-events`.


---

## 🔵 MINOR-3 — Excluded Outcomes Skipped in Notification Flow (Edge Case)

> Covered by MAJOR-6 implementation. Verify that the auto-notify logic in MAJOR-5
> explicitly checks for EXCLUDED and emits no outreach. Add an integration test
> asserting zero outreach rows for EXCLUDED outcomes after a run.

Status:
- Verified on 2026-05-08 as part of the MAJOR-5 / MAJOR-6 test pass.
- EXCLUDED outcomes continue to skip outreach creation, and the population integration test now asserts zero outreach rows for EXCLUDED cases.

---

## Implementation Order for Codex

Execute strictly in this sequence. Each item must pass its own tests before the next
begins. Do not batch items.

```
1.  ✅ CRITICAL-1  Auth / RBAC
2.  ✅ CRITICAL-2  Catalog shows all statuses
3.  ✅ CRITICAL-3  Manual case closure
4.  ✅ CRITICAL-4  Schedule appointment action
5.  ✅ CRITICAL-5  Upload evidence action
6.  ✅ MAJOR-1  100-employee evaluation population
7.  ✅ MAJOR-2  Release / Approval Studio tab
8.  ✅ MAJOR-3  Outreach templates migration
9.  ✅ MAJOR-4  Global site + date filters
10. ✅ MAJOR-5  Auto-notification on case creation
11. ✅ MAJOR-6  EXCLUDED outcomes / waivers worklist
12. ✅ MAJOR-7  Monaco editor
13. ✅ MINOR-1  OSHA reference dropdown
14. ✅ MINOR-2  Case viewed audit event
```

---
_End of TODO_
