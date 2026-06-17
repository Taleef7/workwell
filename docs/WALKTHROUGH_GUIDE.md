# WorkWell Measure Studio — Complete Walkthrough & Functionality Guide

**Version:** All sprints (0–7) merged
**Last updated:** 2026-05-18 (URLs updated 2026-06-08 to the live MIE TWH stack)
**Audience:** Anyone testing, evaluating, or demonstrating the platform — no technical background required
**Production URL:** https://twh.os.mieweb.org
**Issue tracker:** https://github.com/Taleef7/workwell-measure-studio/issues/23

> **Stack note:** This walkthrough was authored against the now-decommissioned Vercel/Fly stack.
> URLs point to the live MIE TWH stack (`twh.os.mieweb.org`); any embedded case/run/measure IDs
> are illustrative and may differ on the current instance. As of the #109 cutover (2026-06-17) the
> backend API is the **TypeScript** service at `twh-api-ts.os.mieweb.org` (the Java `twh-api` remains
> as rollback); the old Fly-era notes below (cold-start, `min_machines_running`) are historical.

---

## What is WorkWell Measure Studio?

WorkWell Measure Studio is an **occupational health compliance management platform**. Organizations that employ workers in safety-sensitive roles (manufacturing, healthcare, emergency response) are legally required to ensure those workers stay current with periodic medical surveillance — annual hearing tests, TB screenings, HAZMAT physicals, flu vaccines, and more. WorkWell automates that tracking.

The platform does three things:
1. **Authors** compliance rules as machine-readable CQL logic (a clinical standard language used in healthcare quality measurement).
2. **Runs** those rules against employee records to produce compliance outcomes.
3. **Manages** the resulting non-compliance cases through to resolution, with a full audit trail.

AI assists human reviewers with drafting and explanation, but **every compliance decision is made by the CQL engine** — never by AI. This is a core design principle.

---

## Quick Reference

### Production URLs
| Surface | URL |
|---------|-----|
| Application | https://twh.os.mieweb.org |
| Backend API | https://twh-api-ts.os.mieweb.org |
| Health check | https://twh-api-ts.os.mieweb.org/actuator/health |

### Demo Accounts
All accounts use the same password: **`Workwell123!`**

| Email | Role | What they can do |
|-------|------|-----------------|
| `admin@workwell.dev` | Admin | Everything — full platform access |
| `approver@workwell.dev` | Approver | Approve and activate measures; view all data |
| `cm@workwell.dev` | Case Manager | Manage cases, run measures, export data |
| `author@workwell.dev` | Author | Draft and edit measures in Studio; cannot approve/activate |

### Pinned Demo IDs (stable across runs)
| Resource | ID |
|----------|-----|
| Audiogram measure | `4ae5d865-3d64-4a17-905d-f1b315a037e2` |
| TB Surveillance measure | `8c9fda6f-b9bb-413a-be4d-8ce4faa72999` |
| HAZWOPER Surveillance measure | `eaa81302-b6f6-4aba-a143-bb72941f9c00` |
| Flu Vaccine measure | `9db33281-0933-4dd6-86e9-e4c6df2b9a94` |
| Pinned Audiogram open case | `32fee6f4-6e69-4675-b44e-5f6392de7dbd` (emp-006, Omar Siddiq, OVERDUE) |

---

## Section 1: Logging In

### What this is
The login screen is the entry point to the application. WorkWell uses demo accounts with fixed credentials — in a production deployment these would be connected to an organization's identity provider.

### Steps

1. Open https://twh.os.mieweb.org in your browser.
2. You will be redirected to the **Login** page at `/login`.
3. Enter the following credentials to log in as an administrator (full access):
   - **Email:** `admin@workwell.dev`
   - **Password:** `Workwell123!`
4. Click **Sign In**.
5. You should be redirected to the Programs dashboard at `/programs`.

### What just happened
The application sent your credentials to the backend, which verified them and returned two tokens: a **short-lived access token** (15 minutes) stored in `localStorage` and attached as a Bearer header on every API call, and a **long-lived refresh token** (8 hours) stored in an HttpOnly cookie that the browser sends automatically when the access token needs to be renewed. You never handle either directly — the app refreshes the access token silently in the background.

### Try other roles
To understand how role-based access works, log out (bottom of the sidebar) and log in with each role:
- `author@workwell.dev` — can draft measures but cannot approve or activate them
- `approver@workwell.dev` — can approve and activate measures
- `cm@workwell.dev` — manages cases and runs measures

---

## Section 2: Programs Dashboard (`/programs`)

### What this is
The Programs dashboard is the **operational command center**. It shows a real-time snapshot of workforce compliance across all four active programs. This is what an occupational health director would look at each morning.

### Steps

1. After login, you should already be on `/programs`. If not, click **Programs** in the left sidebar.
   > **Sidebar labels:** The Runs page is labelled **Test Runs** in the sidebar, not "Runs". The cases worklist has two sidebar entries: **Cases** and **Worklist** — both navigate to `/cases`.
2. At the top, you will see a **KPI row** (Key Performance Indicators) with four metric cards:
   - **Employees tracked** — total employees assessed in the most recent run across all measures
   - **Overall compliance** — percentage currently compliant across all active programs (e.g., 72.0%)
   - **Open cases** — total non-compliance work items that need action
   - **Last run** — timestamp of the most recent completed run across all programs
3. Below the KPI row, you will see **four measure program cards**, one per active measure. The **bold name is the exact card label rendered in the UI**; the quoted phrase is the longer policy title used only in the measure documentation:
   - **Audiogram** (OSHA 1910.95) — "Annual Audiogram Completed"
   - **Flu Vaccine** — "Flu Vaccine This Season"
   - **HAZWOPER Surveillance** (OSHA 1910.120) — "HAZWOPER Annual Medical Surveillance"
   - **TB Surveillance** (CDC) — "Annual TB Screening"
4. Each card shows:
   - Current compliance rate (e.g., "68.0%")
   - Outcome badge counts: Compliant / Due Soon / Overdue / Missing Data / Excluded
   - **Trend** sparkline — compliance rate over recent runs (requires ≥ 2 completed runs with evaluated employees to render)
   - **Top Sites** and **Top Roles** — the sites/roles with the most overdue employees for this program
   - **By Reason** — breakdown of flagged employees by outcome type (OVERDUE / DUE_SOON / MISSING_DATA)
5. Driver breakdowns are **per-card** — there is no global drivers table. Look inside each program card for the **By Reason**, **Top Sites**, and **Top Roles** sections. These show data scoped to that program's most recent run only.

### Running all measures at once

6. Click the **Run All Measures Now** button (top right of the programs page).
7. An inline confirmation appears in the header: _"Run all 4 active programs now?"_ with **Confirm** and **Cancel** buttons.
8. Click **Confirm**.
9. The system will trigger a run with scope `ALL_PROGRAMS`. Watch the measure cards refresh — pass rates, timestamps, and outcome counts will update.
10. This takes approximately 5–15 seconds on a warm server. If the backend has been idle, Fly.io may cold-start the machine — allow up to 30–45 seconds for the first request. Subsequent requests in the session will be fast.

### What just happened
The backend executed all four CQL measure libraries against the synthetic employee dataset (~50 employees). For each employee/measure combination, the CQL engine evaluated conditions like "Is the employee enrolled in this program?", "When was their last qualifying exam?", and "How many days ago was that?" — then classified the result into one of five outcome buckets: COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, or EXCLUDED.

---

## Section 3: Drilling Into a Measure — Audiogram Example (`/programs/[measureId]`)

### What this is
Each program card on the dashboard links to a **measure-specific detail view** showing run history, outcome trends, and the specific employees affected. This is the primary operational view for a program coordinator managing one measure.

### Steps

1. From `/programs`, click the **Audiogram** card (or click its title).
   > **Naming note:** Consistent with the Section 2 card list, the measure is labelled **Audiogram** throughout the running application (cards, run history, outcomes). The longer policy title "Annual Audiogram Completed" appears only in the measure documentation, not in the UI.
2. You land on `/programs/4ae5d865-3d64-4a17-905d-f1b315a037e2`.
3. The page shows:
   - **Compliance trend (last 10)** — a line chart of compliance rate across recent runs
   - **Outcome breakdown (latest run)** — a donut chart showing the proportion of COMPLIANT vs. DUE_SOON vs. OVERDUE vs. MISSING_DATA vs. EXCLUDED for the latest run
   - **Top sites**, **Top roles**, and **Reason mix** — the sites/roles driving non-compliance and a visual bar breakdown of flagged outcomes by reason
   - **Run history** — a table of recent runs for this measure: run ID, start time, compliance rate, and total evaluated, with a **View all runs →** link to the full Runs page

### Viewing a run

4. In the **Run history** table, click any run ID. This opens the **Runs page** (`/runs`) with that run pre-selected in the **Run Detail** panel.
5. On `/runs` you see:
   - **Run Detail panel** — measure name, scope type (ALL_PROGRAMS or MEASURE), trigger type (MANUAL), run status (COMPLETED), start/completed time, **duration in seconds**, total evaluated, total cases, pass rate, data freshness, and an **Outcome Counts** list
   - **Run Logs** — timestamped INFO-level log entries for the run
   - **Outcomes table** — one row per employee with the columns **Employee**, **Role**, **Site**, **Outcome**, **Days Since Exam**, **Waiver**, and **Case** (there is no "evaluation period" column)
6. Click any **non-compliant** outcome row (DUE_SOON / OVERDUE / MISSING_DATA — these have a Case ID) to navigate to that employee's case detail. Compliant and Excluded rows have no case and are shown muted and non-clickable.

### AI Run Insight

7. The **AI Run Insight** panel lives on the **Runs page** run detail (`/runs`), not on `/programs/[measureId]`. It appears above the Run Detail panel as a blue callout.
8. The insight **auto-loads** when a run is selected — there is no "Generate Insight" button.
9. Within 3–5 seconds, 3–5 bullet points appear in plain English, for example:
   - _"68% of enrolled employees are currently compliant — a 4-point improvement over the previous run."_
   - _"The primary driver of non-compliance is exam recency: 11 employees have not had an audiogram within the past 365 days."_
   - _"2 employees are classified MISSING_DATA, indicating their exam records could not be located in the current period."_
10. The panel header reads: **"AI-generated operational insight - verify before acting"**, and the panel can be dismissed with the **Dismiss** link. This is the AI guardrail in action — compliance is decided only by the CQL engine.

### Repeat for other measures
Follow the same steps for:
- **TB Surveillance** — click its card on `/programs`
- **HAZWOPER Surveillance** — click its card; notice that `EXCLUDED` employees appear (employees not in HAZWOPER program)
- **Flu Vaccine** — click its card; notice a seasonal compliance window logic

---

## Section 4: The Cases Worklist (`/cases`)

### What this is
A **case** is created automatically every time an employee produces a non-compliant outcome (DUE_SOON, OVERDUE, or MISSING_DATA). Cases persist across runs and are resolved when the employee becomes compliant. The Cases page is where case managers work through their daily action queue.

> **Sidebar note:** The left navigation has two related items — **Cases** (`/cases`) and **Worklist** (`/worklist`). This walkthrough uses **Cases**, which is the full filterable card grid. **Worklist** is a lighter summary surface for live, excluded, and follow-up cases.

### Steps

1. Click **Cases** in the left sidebar. You land on `/cases`.
2. The page header is **"Why Flagged cases"**. Above the filter row you'll see two view tabs — **All Cases** and **My Cases** — that scope the grid to everyone or to cases assigned to your account.
3. Cases render as **cards in a grid** (not a table), 25 per page. Each card shows:
   - Status badge (Open / Closed / Excluded) and Priority badge (HIGH / MEDIUM / LOW)
   - Measure name (e.g., "Annual Audiogram")
   - Employee name (links to the employee profile) and external ID
   - Site
   - Why-flagged outcome chip (OVERDUE / DUE_SOON / MISSING_DATA / COMPLIANT / EXCLUDED)
   - Evaluation period
   - SLA chip when applicable
   - Last updated timestamp
   - A **View structured evidence →** link to the case detail
   - For excluded cases, the exclusion reason and waiver expiry are also shown
   - (Assignee and Next Action are not surfaced on the card; both live on the case detail.)

### Filtering the worklist

4. Use the filter row to narrow the list:
   - **Status filter** — pill toggle buttons: **Open** (default), **Closed**, **All**, **Excluded**. "Closed" covers both `CLOSED` and `RESOLVED` states.
   - **Measure** dropdown — defaults to "All Active Measures" and lists each active measure
   - **Priority** dropdown — All / High / Medium / Low
   - **Assignee** dropdown — All Assignees, Unassigned, or any user currently assigned to a loaded case
   - **Site** dropdown — All Sites or any site present in the loaded cases
   - **Search** input — case-insensitive partial match on employee name or external ID; server-side, so it spans the whole worklist, not just what's currently on screen

5. Example: Set Status = **Open** and Measure = **Annual Audiogram**. The grid narrows to only open audiogram cases.

### Searching

6. Use the **Search** input to find a specific employee. Type `Omar` — within ~300 ms Omar Siddiq's card (emp-006, OVERDUE) appears, and the URL updates with `?search=Omar` so the query is shareable. Clear the input to restore the full list. If the search has no matches, the empty state reads *"No results match your search "<term>"."*

### Bulk actions

7. Select 2–3 cards by ticking the **Select** checkbox at the top of each card. Use **Select all in current results** above the grid to toggle every card on screen.
8. A blue **bulk-actions toolbar** appears with a selected-count chip, an assignee input, and three buttons:
   - **Assign to…** — applies the assignee in the input to every selected case
   - **Escalate selected** — escalates each selected case
   - **Export selected** — downloads a CSV (`cases-selected.csv`) limited to the selected case IDs
9. Click **Escalate selected**. Each case is escalated in turn and a toast confirms the action.

### Pagination

10. The grid loads 25 cards at a time. If more cases match the filters, a **Load more cases** button appears at the bottom of the grid — click it to append the next 25.

### Exporting the worklist

11. The top of the page has **two export buttons**:
    - **Export cases CSV** — downloads `cases.csv` honoring the current Status and Measure filters
    - **Export audit CSV** — downloads the full audit-event log (`audit-events.csv`)
12. Open `cases.csv` — columns include: `caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus`.

---

## Section 5: Case Detail (`/cases/[id]`)

### What this is
The case detail page is the **single source of truth** for one employee's non-compliance situation. It shows why the employee was flagged, the complete history of actions taken, and gives the case manager all the tools to resolve the case.

### Steps — opening a case

1. From `/cases`, click **Omar Siddiq's** case row (search for `Omar` if needed). Or navigate directly to:
   `https://twh.os.mieweb.org/cases/32fee6f4-6e69-4675-b44e-5f6392de7dbd`
2. The case detail page opens.

### Understanding the page layout

The case detail page has a two-column layout on desktop and stacks on smaller screens:

**Case summary card (top left)**
- Measure label, employee name link, and employee external ID
- Status and priority badges
- Four info cards: **Outcome**, **Evaluation period**, **Outcome summary**, and **Last run**
- **Next action** text and an **Outreach delivery** badge
- Outreach template dropdown with the seeded template options
- Inline assignee field, action buttons, and outreach preview

**Why Flagged**
This section is labelled **Why Flagged** with the heading **Structured evidence trail**. It renders raw CQL define names from `expressionResults`, a `why_flagged` summary block, an optional raw evidence toggle, and the evaluated resource JSON. It does not have a separate "Employee & Measure Panel" heading.

**Right-side support panels**
- **Metadata** — created/updated/closed timestamps, assignee, and outcome-evaluated timestamp
- **Appointments** — scheduled appointment entries created by **Schedule Appointment**
- **Evidence** — upload/download controls for supporting PDFs or images
- **Audit timeline** — append-only history of state changes, actions, notifications, and payloads

### AI Explanation

3. Click the **Explain Why Flagged** button.
4. Wait 2–5 seconds. A 2–3 sentence explanation appears:
   _"Omar Siddiq is enrolled in the Hearing Conservation Program and last completed an audiogram on March 10, 2025 — 420 days ago. The required compliance window is 365 days, placing him 55 days overdue. No active waiver is on file."_
5. The explanation appears in a panel labelled **Plain-language explanation (AI-assisted)**. The disclaimer text is returned by the API and displayed under the explanation; the AI cannot change the outcome status — it can only explain it.

### Assigning a case

6. Find the inline **Assignee** field in the Next action card.
7. Enter an assignee value, for example `Jane Smith`.
8. Click **Assign**. There is no assignment dialog; the field saves inline and the timeline logs the assignment.

### Escalating a case

9. Click **Escalate**.
10. A confirmation dialog appears before the API call runs.
11. Click **Confirm escalation**. The case priority may increase, the next action updates, and the timeline logs the escalation.

### Sending outreach

12. Choose an outreach template from the dropdown. The demo seed includes multiple template options for different reminder and escalation tones.
13. Click **Preview outreach**.
14. An inline **Outreach preview** panel opens showing the template name, subject, due date, and body text. The synthetic recipient is stored in the audit payload after send, not shown as a separate "To" field in the preview.
15. Read the preview body, then click **Send outreach**.
16. The preview clears, the timeline logs the outreach, and the **Outreach delivery** badge refreshes immediately.
17. On the demo stack, the badge updates to `SIMULATED` because `WORKWELL_EMAIL_PROVIDER=simulated` is the mandatory default and no real email leaves the process.

> **Note:** The manual delivery buttons remain available for follow-up state changes (**Mark queued**, **Mark sent**, **Mark failed**), but they are no longer required just to make the first send visible. The first successful send now updates the badge from `NOT_SENT` to the returned delivery status automatically.

### Updating delivery status

18. Find the manual delivery buttons under the outreach preview area.
19. Click **Mark sent** if you want to manually record a later delivery-state update.
20. The badge updates and the timeline logs the state change.

### Scheduling and manual resolution

21. Click **Schedule Appointment** to open the inline appointment panel.
22. Choose an appointment type, date/time, location, and optional notes, then click **Save Appointment**. The appointment appears in the **Appointments** panel.
23. Click **Mark Resolved** to open the inline closure panel.
24. Enter a closure note and click **Confirm Resolve**. A note is required before manual resolution is accepted.

### Uploading evidence

25. In the **Evidence** panel, select any PDF or image file from your computer (e.g., a scanned exam record).
26. Optionally enter a description.
27. Click **Upload Evidence**. The file is linked to the case.
28. An `EVIDENCE_UPLOADED` audit event is written.
29. Click **Download** next to the uploaded file — the file downloads and an `EVIDENCE_DOWNLOADED` audit event is written.

> **Role check:** If you are logged in as `author@workwell.dev`, the download button will return **403 Forbidden**. Evidence downloads are restricted to ROLE_CASE_MANAGER and ROLE_ADMIN. Log back in as `admin@workwell.dev` to proceed.

### Rerun to Verify

30. Click **Rerun to verify**.
31. This re-evaluates Omar Siddiq's compliance status by running the Audiogram CQL against his current data.
32. If the data hasn't changed (and it hasn't in the demo dataset), he will still be OVERDUE. The case stays open and the timeline logs the rerun result.
33. If his data showed a recent exam (which you could simulate by modifying test data), the outcome would change to COMPLIANT and the case would auto-close with `status=RESOLVED` and `closed_at` set.

### Audit Packet

34. At the top right, choose **JSON** or **HTML** from the audit packet format selector.
35. Click **Export Case Audit Packet**.
36. A file downloads containing:
    - Case summary (employee, measure, status, priority, timeline)
    - Full evidence payload from CQL
    - All actions taken (assign, escalate, outreach, rerun)
    - AI explanation log (what was asked, what was returned)
    - Disclaimers (AI is assistive only; CQL is the compliance source of truth)
37. This packet is suitable for auditor review or regulatory documentation.

---

## Section 6: Runs History (`/runs`)

### What this is
The Runs page shows every execution of every measure — a permanent history of when compliance was evaluated, over what scope, and what the outcomes were. Think of each run as a "compliance snapshot" at a point in time.

### Steps

1. Click **Runs** in the left sidebar. You land on `/runs`.
2. You see a table of all runs:
   - Run ID (partial UUID)
   - Measure name and scope (e.g., "ALL_PROGRAMS", "Audiogram")
   - Trigger type (MANUAL or SCHEDULED)
   - Status (COMPLETED, PARTIAL_FAILURE, FAILED)
   - Started at, Duration (shown in **seconds**, not milliseconds)
   - Evaluated / Compliant / Non-compliant counts
   - Pass rate

### Triggering a new run

3. Click **Run Measures Now** (or a "New Run" button if visible).
4. A scope selection dialog opens. Options:
   - **All Programs** — evaluate all 4 active measures for all enrolled employees
   - **Single Measure** — select one measure from the dropdown
5. Select **Single Measure** and choose **Audiogram** from the dropdown.
6. Click **Confirm**.
7. A new row appears at the top of the table with status `RUNNING`. Within 5–15 seconds it updates to `COMPLETED`.

### Opening a run

8. Click the most recent completed run to open its detail view.
9. Review:
   - **Run metadata** — scope, trigger, timestamps, total evaluated
   - **Outcome summary** — counts per bucket with pass rate
   - **Outcome table** — one row per employee, showing their status for this run
   - **Run logs tab** — timestamped log entries (INFO level) showing the evaluation progress

### Exporting runs data

10. Click **Export Runs CSV** (or go directly to `https://twh-api-ts.os.mieweb.org/api/exports/runs?format=csv` — you'll need to authenticate first, so use the app's export button).
11. The CSV downloads with columns: runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf.

12. To export outcomes for a specific run:
    - From the run detail, click **Export Outcomes CSV**.
    - The file includes one row per employee with their evidence data: last exam date, days overdue, role/site eligibility, waiver status.

---

## Section 7: Measure Studio (`/studio/[id]`)

### What this is
The Measure Studio is the **authoring environment** for compliance measures. This is where subject matter experts write the compliance rule logic in CQL (Clinical Quality Language), version it, validate it, and promote it through a lifecycle. Think of it as a specialized IDE for compliance rules.

### Navigating to Studio

1. Click **Measures** in the left sidebar. You land on the measure catalog at `/measures`.
2. You see all four seeded measures listed: Annual Audiogram, Annual TB Screening, HAZWOPER Annual Medical Surveillance, Flu Vaccine This Season.
3. Click **Annual Audiogram** (or click its name/pencil icon to open Studio directly).
4. You land on `/studio/4ae5d865-3d64-4a17-905d-f1b315a037e2`.

### Studio Tabs Overview

The Studio has 6 tabs across the top:
- **Spec** — the human-readable policy specification
- **CQL** — the machine-executable rule logic
- **Value Sets** — code lists the CQL references
- **Tests** — test fixtures to verify the CQL logic
- **Traceability** — policy-to-evidence gap analysis
- **Activation Impact** — dry-run preview of what activating a new version would do

---

### Tab 1: Spec

**What this is:** The Spec tab stores the structured policy specification — a human-readable description of the compliance rule that serves as the authoritative source before CQL is written.

5. Click the **Spec** tab.
6. You see fields:
   - **Name** — "Annual Audiogram"
   - **Description** — "Employees enrolled in the Hearing Conservation Program must complete an audiogram within every rolling 365-day window."
   - **Policy Reference** — "OSHA 29 CFR 1910.95" (with URL to ecfr.gov)
   - **Eligibility Criteria** — who the measure applies to (role filter, site filter, program enrollment text)
   - **Exclusions** — criteria that exempt an employee (e.g., "Has Active Waiver")
   - **Compliance Window** — "365 days"
   - **Required Data Elements** — ["Procedure/audiogram", "Observation/hearing-conservation-enrollment", "Flag/waiver"]

7. Try editing the **Description** field. Change it to: `"Hearing Conservation Program members must complete a baseline and annual audiogram as required by OSHA 1910.95."`
8. Click **Save**. A success toast appears: _"Spec saved."_

### AI Draft Spec

9. Click **AI Draft** (or "Generate Spec with AI" button on the Spec tab).
10. A text area appears: _"Paste policy text to draft from"_
11. Paste this OSHA excerpt:
    > `Employers shall establish and maintain an audiometric testing program as provided in this section by making audiometric testing available to all employees whose exposures equal or exceed an 8-hour time-weighted average of 85 decibels. The employer shall establish and maintain records of the original background sound pressure level measurements required in paragraph (f) of this section.`
12. Click **Generate**.
13. Within 3–5 seconds, the Spec fields auto-fill with AI-generated content. A yellow banner appears: _"AI-generated draft — review and edit before saving."_
14. Review the generated content (it will not be perfect — it's a starting point), then click **Save** if you want to keep it, or **Discard**.

---

### Tab 2: CQL

**What this is:** The CQL (Clinical Quality Language) tab is where the actual compliance logic lives. CQL is an HL7 standard language used in clinical quality measures. WorkWell is unique among occupational health tools in using CQL — it allows the logic to be versioned, shared, and validated programmatically.

15. Click the **CQL** tab.
16. You see a **Monaco code editor** (the same engine used in VS Code) containing the CQL library for Annual Audiogram. The code looks like:

```
library AnnualAudiogramCQL version '1.0.0'

using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

context Patient

define "In Hearing Conservation Program":
  exists (...)

define "Has Active Waiver":
  exists (...)

define "Most Recent Audiogram Date":
  ...

define "Days Since Last Audiogram":
  if "Most Recent Audiogram Date" is null then null
  else difference in days between "Most Recent Audiogram Date" and Today()

define "Outcome Status":
  if "Has Active Waiver" then 'EXCLUDED'
  else if not "In Hearing Conservation Program" then 'EXCLUDED'
  else if "Most Recent Audiogram Date" is null then 'MISSING_DATA'
  else if "Days Since Last Audiogram" > 365 then 'OVERDUE'
  else if "Days Since Last Audiogram" > 335 then 'DUE_SOON'
  else 'COMPLIANT'
```

17. Note the **compile status badge** at the top (e.g., "COMPILED ✓" in green, or "NOT COMPILED" in grey).
18. Note the **version badge** (e.g., "v1.0 — Active").

### Compiling CQL

19. Make a small edit to the CQL — add a comment at the top: `// Reviewed 2026-05-18`
20. Click **Compile**.
21. Within 2–5 seconds, the compile result updates. If the CQL is valid: _"Compiled successfully — 0 errors, 0 warnings"_. If there's an error (e.g., you introduced a syntax mistake), the error is shown with a line number.
22. The compile result (success or failure) is stored in the database as `compile_result` JSON and the `compile_status` field is updated.

> **Important:** A measure **cannot be approved or activated** unless its CQL has been successfully compiled. This is the compile gate.

### Creating a new version

23. Click **New Version** (button near the version badge).
24. A dialog appears asking for a **Change Summary**: enter `"Testing version bump — minor comment update"`
25. Click **Create Version**.
26. A new Draft version appears (e.g., "v1.1 — Draft"). The CQL from v1.0 is cloned into v1.1 as a starting point.
27. You are now editing v1.1 without touching the active v1.0 production logic.

---

### Tab 3: Value Sets

**What this is:** Value sets are named code lists (e.g., "all procedure codes that count as a hearing test"). The CQL references these by name. The Value Sets tab manages the governance of those lists — are they resolved? Do they contain the right codes? Are they current?

28. Click the **Value Sets** tab.
29. You see a table of value sets linked to this measure version. For Audiogram, you'll see entries like:
    - "Hearing Conservation Enrollment" (OID: 2.16.840.1.113883.3.workwell.001) — Status: RESOLVED
    - "Audiogram Procedure Codes" — Status: RESOLVED
30. Click **Resolve Check** (or "Run Governance Check").
31. The system validates each value set:
    - Is it resolved? (code count > 0)
    - Are there any CQL references that don't have a matching value set?
    - Are there any blockers or warnings?
32. Results appear: e.g., _"2 value sets resolved. 0 blockers. 0 warnings."_

33. Click any value set row to expand its **detail view**:
    - Canonical URL
    - Code systems included
    - Resolution status
    - Code count
    - Full code list

---

### Tab 4: Tests

**What this is:** Test fixtures are synthetic employee scenarios with known expected outcomes. Before a measure can be activated, its test fixtures must all pass. This ensures the CQL logic produces the correct result for known inputs.

34. Click the **Tests** tab.
35. You see a list of test fixtures, each with:
    - **Name** — human-readable description (e.g., "Employee with exam 30 days ago — expect COMPLIANT")
    - **Input data** — synthetic employee profile (exam date, program enrollment, waiver status)
    - **Expected outcome** — what the CQL should return
    - **Last result** — PASSED / FAILED / NOT RUN

36. Click **Run All Fixtures**.
37. The system evaluates each fixture through the CQL engine and updates the result column.
38. All fixtures for the seeded Audiogram measure should pass (PASSED in green).
39. If a fixture shows FAILED, the actual outcome differs from the expected — this is a logic bug.

---

### Tab 5: Traceability

**What this is:** The Traceability tab shows a **policy-to-evidence matrix** — a structured map from each regulatory requirement (e.g., "OSHA 1910.95(g)(1): Annual audiogram required") to the CQL defines and data elements that implement and verify it. This is critical for regulatory audit — you can prove that every policy requirement is addressed by specific logic.

40. Click the **Traceability** tab.
41. You see a matrix with rows for each policy requirement and columns for CQL coverage.
42. Green checkmarks indicate requirements with CQL defines and test fixtures. Orange warning triangles indicate gaps — requirements mentioned in the Spec but not yet fully covered in CQL.
43. The traceability matrix is used to demonstrate to auditors that the compliance logic is intentional and policy-grounded.

---

### Tab 6: Activation Impact

**What this is:** Before activating a new measure version (promoting it from Draft/Approved to Active), the Activation Impact Preview runs a **dry-run** — it evaluates the new version against all enrolled employees and shows you what the outcome distribution would look like. No data is written. This lets approvers see the impact before committing.

44. Click the **Activation Impact** tab.
45. If you created a new Draft version earlier (v1.1), select it from the version dropdown.
46. Click **Preview Impact**.
47. Within 5–15 seconds, a result appears:
    - Projected outcome counts: Compliant X, Due Soon Y, Overdue Z, Missing Data W, Excluded V
    - Case impact: X new cases would open, Y existing cases would close
    - Pass rate comparison: "v1.0 (current): 68% → v1.1 (preview): 69%"
48. An `MEASURE_IMPACT_PREVIEWED` audit event is written, but **no database changes occur** — this is read-only.

---

### Measure Lifecycle: Draft → Approved → Active

**As Admin or Approver:**

49. With the Draft v1.1 open, ensure:
    - CQL has been compiled successfully (green status)
    - All test fixtures pass
50. Click **Approve**.
51. A confirmation dialog: _"This will mark v1.1 as Approved. An approver audit event will be logged."_
52. Click **Confirm**. Status changes to `APPROVED`. The timeline logs who approved it and when.
53. Click **Activate**.
54. A final confirmation: _"Activating v1.1 will make it the live version. The current active version (v1.0) will be deprecated."_
55. Click **Confirm**. Status changes to `ACTIVE`. `activated_at` is set. An audit event is written.

> **Note:** If you are logged in as `author@workwell.dev`, the Approve and Activate buttons will be disabled or return 403 — authors cannot approve their own work.

---

## Section 8: Admin Panel (`/admin`)

### What this is
The Admin panel gives administrators operational control over the platform's infrastructure components: the run scheduler, integration health monitoring, outreach templates, and the outreach delivery log.

### Steps

1. Click **Admin** in the left sidebar. You land on `/admin`.

> **Role check:** This page is only visible to ROLE_ADMIN. If you are logged in as `cm@workwell.dev` (Case Manager) and try to access `/admin/integrations` via the API, you will receive 403 Forbidden.

### Integration Health

2. The **Integration Health** panel shows the status of four system integrations:
   - **FHIR** — the FHIR data service (should show UP/OK with a last-sync timestamp)
   - **MCP** — the MCP server (should show UP/OK)
   - **AI** — the AI model service (shows OK or DEGRADED)
   - **HRIS** — the employee data source (shows SIMULATED — demo mode)
3. Click **Manual Sync** (or "Sync Now") next to any integration.
4. The system sends a health probe to that integration and updates the `last_sync_at` and `last_sync_result` fields.

### Scheduler Controls

5. Find the **Scheduler** toggle/controls.
6. The scheduler runs measure evaluations on a regular interval (e.g., daily).
7. Toggle the scheduler **Off** — a confirmation dialog appears: _"Pausing the scheduler will stop automated runs. Proceed?"_
8. Click **Confirm**. The scheduler state changes to DISABLED.
9. Toggle it back **On**. State returns to ENABLED.

### Outreach Templates

10. Find the **Outreach Templates** section (may be a tab or panel).
11. You see the default outreach templates — pre-written email messages used when sending outreach from case detail.
12. Click a template to view/edit its body.
13. A template might look like:
    - **Subject:** `Action Required: {{measureName}} — {{employeeName}}`
    - **Body:** `Dear {{employeeName}}, our records indicate you are overdue for your {{measureName}} assessment...`
14. Edit the body, click **Save**. The updated template will be used for future outreach sends.

### Outreach Delivery Log

15. Find the **Outreach Delivery Log** (may be under an "Outreach" tab).
16. You see one row per outreach email attempt:
    - Recipient address (e.g., `emp-006@workwell-demo.dev`)
    - Subject
    - Provider: `simulated` (demo mode)
    - Status: `SIMULATED` (no real email sent)
    - Sent at timestamp
17. Every outreach send from any case creates a log entry here. This is the audit trail for all outreach activity.

---

## Section 9: Terminology Mappings (`/admin`)

### What this is
Terminology mappings define how local occupational health codes (used internally) map to standard clinical codes (CPT, CVX, SNOMED-CT). These mappings are required for interoperability with external clinical systems and for MAT export.

### Where to find it
On the Admin page, scroll past **Source mappings** (data readiness panel) to the **Local code mappings** panel (the "terminology governance" section). Both panels are on the same Admin route; only the **Source mappings** panel has a **Validate Mappings** button — the **Local code mappings** panel has **Add Mapping** and **Refresh** actions instead.

### Steps

1. From Admin, scroll to the **Local code mappings** panel.
2. You see a table with columns: **Local Code**, **Local System**, **Standard Code**, **Standard System**, **Status**, **Confidence**, **Reviewed By**, **Notes**.
3. Demo data includes 5 pre-seeded mappings:
   - Audiogram exam → CPT 92557 (APPROVED)
   - TB PPD test → CPT 86580 (APPROVED)
   - Flu vaccine → CVX 141 (APPROVED)
   - HAZWOPER physical → internal code (REVIEWED)
   - TB IGRA test → CPT 86480 (PROPOSED)
4. Click **Add Mapping** in the panel header. An inline form appears below the panel description.
5. Fill in the form:
   - **Local Code:** `ANNUAL-FIT-TEST`
   - **Local Display:** `Annual respirator fit test`
   - **Local System:** `urn:workwell:demo`
   - **Standard Code:** `415070008`
   - **Standard Display:** `Fitting of mask (procedure)`
   - **Standard System:** `http://snomed.info/sct`
   - **Status:** `PROPOSED`
   - **Confidence:** `0.90`
   - **Notes:** optional context for reviewers
6. Click **Save mapping**. The new mapping appears at the top of the table (PROPOSED mappings sort first). The inline form closes automatically.

> **Note:** Status promotion (PROPOSED → REVIEWED → APPROVED → REJECTED) is currently performed via the API directly (`POST /api/admin/terminology-mappings`). Inline row-level status editing is not exposed in the UI for this MVP; use a fresh **Add Mapping** call with the updated status, or hit the API directly to update existing mappings in a follow-up sprint.

---

## Section 10: CSV Exports

### What this is
WorkWell provides CSV exports for runs, outcomes, cases, and audit events — suitable for import into Excel, reporting tools, or compliance databases. Each export button label below matches what the UI actually renders today.

### Steps

**Export Run History:**
1. Navigate to `/runs`.
2. Click **Export runs CSV** in the toolbar.
3. The file `runs.csv` downloads. Open in Excel — you should see columns including run ID, measure name, pass rate, outcome counts.

**Export Outcomes for a Specific Run:**
4. From `/runs`, click a row in the run list to open the right-side run detail panel.
5. In the panel, click **Export outcomes CSV** (button label may render as `Export outcomes CSV` with the selected run's filter applied).
6. The file `outcomes.csv` downloads with employee-level data: name, status, last exam date, days overdue, waiver status.

**Export Cases:**
7. Navigate to `/cases`.
8. Apply filters (e.g., Status = OPEN, measure filter, etc.).
9. Click **Export cases CSV** in the worklist toolbar.
10. The file `cases.csv` (or `cases-selected.csv` when rows are selected) downloads with one row per case including delivery status.

**Export Audit Events:**
11. The audit events CSV export is also exposed on the **Cases** page toolbar (next to **Export cases CSV**), not on the Admin page. Click **Export audit CSV**.
12. The audit CSV contains every state-changing operation with timestamps, actors, and payloads — suitable for regulatory review.

> The audit CSV button lives on the Cases page because operators reviewing cases are the primary consumers; admins can hit the underlying endpoint directly at `/api/audit-events/export?format=csv` from any context.

---

## Section 11: Audit Packets (Structured Export for Auditors)

### What this is
Audit packets are structured, self-contained documents that bundle all evidence related to one entity (a case, a run, or a measure version) into a single JSON or HTML file. These are designed for submission to auditors or regulators who need to verify the platform's compliance decisions without direct database access.

### Format selector (consistent across all three entry points)
Every entry point uses the same control: a small **format dropdown** (JSON / HTML) directly beside the **Export … Audit Packet** button. **You must pick the format first**, then click the export button — clicking the button alone always uses whatever format is currently selected (default: JSON). This dropdown is present in all three places listed below.

### Types of packets

**Case audit packet** (includes: case history, evidence, actions, outreach, AI logs, disclaimers):
1. Open any case detail page (e.g., Omar Siddiq's OVERDUE case).
2. In the case header (top-right), find the **format dropdown** next to **Export Case Audit Packet** and select **HTML**.
3. Click **Export Case Audit Packet**.
4. An HTML file downloads (`workwell-case-packet-<caseId>.html`) — formatted for print, with all evidence, actions, and AI logs laid out in audit-friendly sections.

**Run audit packet** (includes: run metadata, outcome summary, logs, audit events):
5. Open `/runs` and select a run to open the right-side detail panel.
6. Near the bottom of the panel, find the **format dropdown** next to **Export Run Audit Packet** and select **JSON**.
7. Click **Export Run Audit Packet**.
8. A JSON file downloads (`workwell-run-packet-<runId>.json`) — machine-readable, with a SHA-256 hash of the payload for integrity verification.

**Measure version packet** (includes: spec, CQL code + hash, compile result, value sets, traceability, approval history):
9. Open Studio for any measure (e.g., Annual Audiogram).
10. Open the **Release & Approval** tab. Below the readiness checklist, find the **format dropdown** next to **Export Measure Audit Packet** and select **JSON** or **HTML**. (The same control is also available in the Studio header for quick access.)
11. Click **Export Measure Audit Packet**. The packet includes the complete lifecycle history of that measure version from Draft to Active.

Every packet generation writes an `AUDIT_PACKET_GENERATED` event to the audit log.

---

## Section 12: MCP Tools (Claude Desktop Integration)

### What this is
WorkWell exposes a **Machine-Callable Protocol (MCP) server** that allows AI agents (like Claude Desktop) to query compliance data programmatically. This means a compliance officer can ask Claude Desktop natural-language questions about workforce compliance and get answers backed by the live WorkWell database.

### Prerequisites
- **Claude Desktop is installed.** Download from https://claude.ai/download (macOS and Windows supported).
- **A valid WorkWell JWT.** Log in to the WorkWell UI as any user with at least `ROLE_CASE_MANAGER` and copy the access token. In the dashboard the access token is held only in memory — easiest path is to sign in via the WorkWell auth API (`POST /api/auth/login` with `{ "email": "...", "password": "..." }`) and capture the `accessToken` from the JSON response.
- **The WorkWell backend is reachable.** For the deployed demo this is `https://twh-api-ts.os.mieweb.org`. For local development this is typically `http://localhost:8080`.

### Claude Desktop config file

Edit Claude Desktop's MCP config (path is platform-dependent):
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add (or merge into) an `mcpServers` block pointing at the SSE endpoint with the JWT as a bearer token:

```json
{
  "mcpServers": {
    "workwell": {
      "url": "https://twh-api-ts.os.mieweb.org/sse",
      "transport": "sse",
      "headers": {
        "Authorization": "Bearer <PASTE_WORKWELL_JWT_HERE>"
      }
    }
  }
}
```

Save the file and fully restart Claude Desktop (Quit / `Cmd+Q`, not just close the window). On launch Claude reads the config and connects to the MCP server. If the JWT is missing or expired, the connection is rejected with `401 Unauthorized` (unauthenticated). A `403` instead means the token is valid but the account lacks the required MCP role.

> The Fly machine should have `min_machines_running = 1` (see `docs/DEPLOY.md`) so the SSE transport stays warm for remote MCP clients.

### Available MCP Tools
| Tool | What it does |
|------|-------------|
| `list_measures` | Returns all active measures with IDs and metadata |
| `get_employee` | Returns an employee's profile and enrollment status |
| `check_compliance` | Returns the latest compliance outcome for one employee + measure |
| `list_noncompliant` | Returns all currently non-compliant employees (with optional measure filter) |
| `explain_rule` | Returns the human-readable rule text for a measure |

### Using MCP Tools in Claude Desktop

1. Open **Claude Desktop**.
2. Start a new conversation.
3. Type: `Use the workwell MCP server to list all active measures.`
4. Claude invokes `list_measures` and returns a structured list.

5. Type: `Check compliance for employee emp-006 on the Annual Audiogram measure.`
6. Claude invokes `check_compliance` with `employeeId=emp-006` and the Audiogram measure ID.
7. The response shows: Status = OVERDUE, last exam date, days overdue.

8. Type: `List all non-compliant employees in the system.`
9. Claude invokes `list_noncompliant` and returns a table.

10. Type: `Explain why Omar Siddiq (case ID 32fee6f4-6e69-4675-b44e-5f6392de7dbd) was flagged.`
11. Claude invokes `explain_rule` or `check_compliance` with structured evidence.

> **Audit trail:** Every MCP tool call writes an `MCP_TOOL_CALLED` audit event with the tool name, parameters, calling user, and timestamp. MCP is not an anonymous interface — every call is traceable.

> **Role check:** MCP routes are protected by the backend's auth/role gate. An unauthenticated MCP connection attempt returns `401`; an authenticated caller lacking the required role gets `403`. The JWT in the Claude Desktop config must belong to a user with at least ROLE_CASE_MANAGER.

---

## Section 13: Security Boundaries

### What this is
WorkWell enforces role-based access control throughout the application. This section documents what each role can and cannot do, and how to verify these boundaries.

### Role capability matrix

| Action | AUTHOR | APPROVER | CASE_MANAGER | ADMIN |
|--------|--------|----------|--------------|-------|
| View programs dashboard | ✓ | ✓ | ✓ | ✓ |
| View case list & detail | ✓ | ✓ | ✓ | ✓ |
| Assign / escalate case | ✗ | ✓ | ✓ | ✓ |
| Send outreach | ✗ | ✓ | ✓ | ✓ |
| Trigger a run | ✗ | ✓ | ✓ | ✓ |
| Edit measure Spec | ✓ | ✓ | ✗ | ✓ |
| Edit CQL | ✓ | ✓ | ✗ | ✓ |
| Compile CQL | ✓ | ✓ | ✗ | ✓ |
| Approve measure | ✗ | ✓ | ✗ | ✓ |
| Activate measure | ✗ | ✓ | ✗ | ✓ |
| Access Admin panel | ✗ | ✗ | ✗ | ✓ |
| Upload evidence | ✗ | ✓ | ✓ | ✓ |
| Download evidence | ✗ | ✗ | ✓ | ✓ |
| Export audit packet | ✗ | ✓ | ✓ | ✓ |

### Verifying security boundaries

**Test 1 — Author cannot approve:**
1. Log in as `author@workwell.dev` (password: `Workwell123!`)
2. Navigate to Studio for any measure.
3. The **Approve** and **Activate** buttons should be disabled or absent.
4. Confirm by opening browser developer tools → Network tab, then manually calling:
   `POST https://twh-api-ts.os.mieweb.org/api/measures/{id}/approve`
   with your session JWT. Expected response: `403 Forbidden`.

**Test 2 — Anonymous access rejected:**
5. Open an incognito window.
6. Try to access: `https://twh-api-ts.os.mieweb.org/api/measures`
7. Expected: `401 Unauthorized` (no cookie, no JWT). The TS backend returns `401` for unauthenticated requests; `403` is reserved for an *authenticated* caller lacking the required role (e.g. Test 1).

**Test 3 — Case Manager cannot access Admin:**
8. Log in as `cm@workwell.dev`
9. Navigate to `/admin`.
10. Expected: an in-page "Admin access required" panel renders for this role; the Admin nav item is hidden in the sidebar.

**Test 4 — MCP requires authentication:**
11. In your terminal (if you have curl):
    ```
    curl https://twh-api-ts.os.mieweb.org/sse
    ```
12. Expected: `401 Unauthorized` (unauthenticated — same auth gate as Test 2).

> **Note on the `/login` redirect you may see during testing:** If during one of these RBAC tests the app forwards you to `/login` instead of showing the access-denied panel, that redirect is *session expiry* (the access token in memory was lost on a hard navigation or refresh) rather than an explicit RBAC denial. This is tracked separately as **Bug 4 — session persistence** in UAT issue #23; it is not a Section 13 / role-enforcement defect.

---

## Section 14: Demo Reset (Non-Production Only)

### What this is
A non-production endpoint exists to reset the volatile demo data (outreach logs, bulk audit entries, etc.) back to a clean state for repeated demos. **This endpoint does not exist in production** (guarded by `@Profile("!prod")` on the backend, and the Admin UI now hides the entire panel unless the frontend was built with `NEXT_PUBLIC_DEMO_MODE=true`).

> **Only use this in a local development environment — never on the production Fly.io instance.**

### Visibility rules
- **Backend:** `POST /api/admin/demo-reset` returns `403 Forbidden` whenever the `prod` Spring profile is active (`DemoResetService` is `@Profile("!prod")`).
- **Frontend:** the **Reset demo data** card on `/admin` renders only when `process.env.NEXT_PUBLIC_DEMO_MODE === "true"` at build time. Production Vercel builds never set `NEXT_PUBLIC_DEMO_MODE=true` (the build fails fast if they do — see `frontend/next.config.ts`), so the card is structurally absent in production, not merely hidden via CSS.

### Steps (local only)
1. Log in as `admin@workwell.dev`.
2. On `/admin`, scroll to the red-bordered **Reset demo data** card.
3. Click **Reset Demo Data**. **The confirmation is rendered inline** within the card — *not* a modal dialog. You will see:
   - A red message: *"Are you sure? This cannot be undone."*
   - A red **Confirm Reset** button
   - A neutral **Cancel** button
4. Click **Confirm Reset**.
5. Tables truncated: `runs`, `outcomes`, `cases`, `case_actions`, `audit_events`, `outreach_delivery_log`, and other volatile demo tables. Employees, measures (and measure versions), value sets, and integration health rows are preserved.

### Measure catalog after reset
Demo Reset does **not** touch the measure catalog. After a reset, `/measures` continues to show the seeded catalog of seven measures across four lifecycle states:

| Measure | Lifecycle | Source migration |
|---------|-----------|------------------|
| Annual Audiogram | ACTIVE | initial seed |
| HAZWOPER Annual Medical Surveillance | ACTIVE | initial seed |
| Annual TB Screening | ACTIVE | initial seed |
| Flu Vaccine This Season | ACTIVE | initial seed |
| Hepatitis B Vaccination Series | APPROVED (not yet activated) | `V017__seed_additional_measures.sql` |
| Respirator Fit Test | DRAFT | `V017__seed_additional_measures.sql` |
| Lead Medical Surveillance | DEPRECATED | `V017__seed_additional_measures.sql` |

The three non-Active measures from V017 exist to exercise the catalog's lifecycle filtering and the Studio Release & Approval flow without disturbing the four canonical Active measures used by runs and cases.

---

## What to Report as an Issue

If during any step above you encounter behavior that differs from the expected outcome described, please report it at:

**https://github.com/Taleef7/workwell-measure-studio/issues/23**

When reporting, include:
1. **Which section and step number** (e.g., "Section 5, Step 17 — Outreach")
2. **What you did** (exact steps, values entered)
3. **What you expected** to happen
4. **What actually happened** (error message, screenshot, wrong value)
5. **Which account you were logged in as**
6. **Browser and OS** (e.g., Chrome 124 on Windows 11)

---

## Appendix A: Outcome Status Definitions

| Status | Meaning |
|--------|---------|
| `COMPLIANT` | Employee is enrolled and has completed the required exam/test within the compliance window |
| `DUE_SOON` | Compliant today, but will become overdue within the next 30 days |
| `OVERDUE` | Compliance window has passed — exam is required |
| `MISSING_DATA` | Employee is enrolled but no qualifying exam record could be found in the system |
| `EXCLUDED` | Employee has an active exemption (medical waiver, not in scope of program) — no action required |

---

## Appendix B: Measure Reference

| Measure | Policy | Compliance Window | Key Logic |
|---------|--------|------------------|-----------|
| Annual Audiogram | OSHA 29 CFR 1910.95 | 365 days | Enrolled in Hearing Conservation Program; not waived; last audiogram within window |
| HAZWOPER Surveillance | OSHA 29 CFR 1910.120 | 365 days | Enrolled in HAZWOPER program; not medically exempt; last surveillance exam within window |
| Annual TB Screening | CDC TB Guidance | 365 days | In TB screening program; not exempt; last TB screen within window |
| Flu Vaccine | CDC + Org Policy | Seasonal | Clinical-facing employee; not exempt; received flu vaccine this season |

---

## Appendix C: Glossary

| Term | Definition |
|------|-----------|
| CQL | Clinical Quality Language — an HL7 standard for expressing clinical logic in a computable form |
| FHIR | Fast Healthcare Interoperability Resources — the data standard CQL operates on |
| MAT | Measure Authoring Tool — the CMS/HL7 tool for building eCQMs; WorkWell measures can export to this format |
| eCQM | Electronic Clinical Quality Measure — the standard format for regulatory-grade quality measures |
| MCP | Model Context Protocol — a standard for AI agents to call structured tools |
| JWT | JSON Web Token — the authentication credential used by WorkWell's API |
| Audit packet | A structured, self-contained compliance evidence document for regulatory submission |
| Flyway | Database migration tool that ensures schema changes are versioned and applied in order |
| JPA / HAPI FHIR | Java libraries used to evaluate CQL against FHIR-format patient/employee data |
| Evidence JSON | The structured CQL output stored per outcome — contains every define value that led to the outcome |
