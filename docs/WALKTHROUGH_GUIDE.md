# WorkWell Measure Studio — Complete Walkthrough & Functionality Guide

**Version:** Sprint 6 (all sprints merged)
**Last updated:** 2026-05-18
**Audience:** Anyone testing, evaluating, or demonstrating the platform — no technical background required
**Production URL:** https://workwell-measure-studio.vercel.app
**Issue tracker:** https://github.com/Taleef7/workwell-measure-studio/issues/23

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
| Application | https://workwell-measure-studio.vercel.app |
| Backend API | https://workwell-measure-studio-api.fly.dev |
| Health check | https://workwell-measure-studio-api.fly.dev/actuator/health |

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

1. Open https://workwell-measure-studio.vercel.app in your browser.
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
A **case** is created automatically every time an employee produces a non-compliant outcome (DUE_SOON, OVERDUE, or MISSING_DATA). Cases persist across runs and are resolved when the employee becomes compliant. The worklist is where case managers work through their daily action queue.

### Steps

1. Click **Cases** in the left sidebar. You land on `/cases`.
2. You see a table of all open cases. Default columns include:
   - Employee Name
   - Measure Name (which program)
   - Outcome Status (OVERDUE / DUE_SOON / MISSING_DATA)
   - Priority (HIGH / MEDIUM / LOW)
   - Assignee (if assigned)
   - Next Action (e.g., "Send outreach", "Escalate")
   - Last Updated

### Filtering the worklist

3. Use the filter controls at the top to narrow the list:
   - **Status filter** — select `OPEN` to see only active cases, `RESOLVED` to see closed ones
   - **Measure filter** — select "Annual Audiogram" to see only audiogram cases
   - **Priority filter** — select `HIGH` to see the most urgent
   - **Site filter** — filter by employee work location
   - **Assignee filter** — filter to cases assigned to a specific person

4. Example: Set Status = `OPEN` and Measure = `Annual Audiogram`. The list narrows to show only open audiogram cases.

### Searching

5. Use the **search bar** to find a specific employee by name. Type `Omar` and press Enter — you should see Omar Siddiq's case appear (emp-006, OVERDUE).

### Bulk actions

6. Select 2–3 cases by clicking their checkboxes on the left.
7. A **Bulk Actions** toolbar appears at the top showing: Bulk Assign, Bulk Escalate, Export Selected.
8. Click **Bulk Escalate**. A confirmation dialog appears.
9. Click **Confirm**. The selected cases update to an escalated state and new timeline entries are written for each.

### Exporting the worklist

10. Click **Export CSV** (top right of the cases list). A file named `cases.csv` downloads to your computer.
11. Open it — columns include: caseId, employeeExternalId, employeeName, role, site, measureName, status, priority, currentOutcomeStatus, nextAction, createdAt, closedAt, latestOutreachDeliveryStatus.

---

## Section 5: Case Detail (`/cases/[id]`)

### What this is
The case detail page is the **single source of truth** for one employee's non-compliance situation. It shows why the employee was flagged, the complete history of actions taken, and gives the case manager all the tools to resolve the case.

### Steps — opening a case

1. From `/cases`, click **Omar Siddiq's** case row (search for `Omar` if needed). Or navigate directly to:
   `https://workwell-measure-studio.vercel.app/cases/32fee6f4-6e69-4675-b44e-5f6392de7dbd`
2. The case detail page opens.

### Understanding the page layout

The case detail page has several sections:

**Employee & Measure Panel (top left)**
- Employee name, external ID, role, site, supervisor
- Measure name and version (e.g., "Annual Audiogram v1.0")
- Current status (e.g., OVERDUE), Priority (e.g., HIGH), Assignee (if any)
- Next recommended action

**Why Flagged (evidence panel)**
This section shows the structured evidence from the CQL engine:
- Last exam date (e.g., "2025-03-10")
- Days since last exam (e.g., "420 days")
- Compliance window (e.g., "365 days")
- Days overdue (e.g., "55 days")
- Program enrolled: Yes
- Waiver status: None
- Outcome status: OVERDUE

**Timeline (right side or below)**
An append-only log of every action and state change: when the case was created, every action taken, by whom, and when.

### AI Explanation

3. Click the **Explain Why Flagged** button (may show a sparkle icon ✨).
4. Wait 2–5 seconds. A 2–3 sentence explanation appears:
   _"Omar Siddiq is enrolled in the Hearing Conservation Program and last completed an audiogram on March 10, 2025 — 420 days ago. The required compliance window is 365 days, placing him 55 days overdue. No active waiver is on file."_
5. This is AI-generated text grounded in the structured evidence. The AI cannot change the outcome status — it can only explain it.

### Assigning a case

6. Click **Assign** (or the Assign button/dropdown in the actions area).
7. In the dialog, enter an assignee name: `Jane Smith`
8. Click **Save**. The timeline logs: _"Case assigned to Jane Smith by admin@workwell.dev at [timestamp]"_

### Escalating a case

9. Click **Escalate**.
10. An escalation confirmation dialog appears: _"This will mark the case as escalated and notify the assigned supervisor."_
11. Click **Confirm**. The case priority may increase and the timeline logs the escalation.

### Sending outreach

12. Click **Send Outreach**.
13. An outreach preview modal opens showing:
    - **To:** `emp-006@workwell-demo.dev` (synthetic address — no real email is sent in demo mode)
    - **Subject:** `Action Required: Annual Audiogram — Omar Siddiq`
    - **Body:** A template message explaining the compliance gap and requesting the employee schedule their exam
14. Read the preview body. The message is templated — consistent and reviewable.
15. Click **Send**.
16. The modal closes. The timeline logs: _"Outreach sent to emp-006@workwell-demo.dev at [timestamp]"_
17. The **Delivery Status** badge updates to `QUEUED`.

> **Note:** In demo mode (`WORKWELL_EMAIL_PROVIDER=simulated`), no real email is sent. The delivery record is logged in the database as `SIMULATED` and visible in Admin → Outreach Delivery Log. In a production deployment with SendGrid configured, a real email would be sent.

### Updating delivery status

18. Find the delivery status area on the case detail. Click **Mark as Sent** (or find the delivery status dropdown).
19. Set delivery status to `SENT`.
20. The badge updates and the timeline logs the state change.

### Uploading evidence

21. Click **Upload Evidence** (or find the evidence section).
22. Select any PDF or image file from your computer (e.g., a scanned exam record).
23. Click **Upload**. The file is linked to the case.
24. An `EVIDENCE_UPLOADED` audit event is written.
25. Click **Download** next to the uploaded file — the file downloads and an `EVIDENCE_DOWNLOADED` audit event is written.

> **Role check:** If you are logged in as `author@workwell.dev`, the download button will return **403 Forbidden**. Evidence downloads are restricted to ROLE_CASE_MANAGER and ROLE_ADMIN. Log back in as `admin@workwell.dev` to proceed.

### Rerun to Verify

26. Click **Rerun to Verify**.
27. This re-evaluates Omar Siddiq's compliance status by running the Audiogram CQL against his current data.
28. If the data hasn't changed (and it hasn't in the demo dataset), he will still be OVERDUE. The case stays open and the timeline logs: _"Rerun completed: outcome still OVERDUE. Case remains open."_
29. If his data showed a recent exam (which you could simulate by modifying test data), the outcome would change to COMPLIANT and the case would auto-close with `status=RESOLVED` and `closed_at` set.

### Audit Packet

30. Look for an **Export Audit Packet** button (may be in a menu or toolbar).
31. Click it and select format **JSON** or **HTML**.
32. A file downloads containing:
    - Case summary (employee, measure, status, priority, timeline)
    - Full evidence payload from CQL
    - All actions taken (assign, escalate, outreach, rerun)
    - AI explanation log (what was asked, what was returned)
    - Disclaimers (AI is assistive only; CQL is the compliance source of truth)
33. This packet is suitable for auditor review or regulatory documentation.

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

10. Click **Export Runs CSV** (or go directly to `https://workwell-measure-studio-api.fly.dev/api/exports/runs?format=csv` — you'll need to authenticate first, so use the app's export button).
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

### Steps

1. From Admin, find **Terminology Mappings** (may be a sub-tab or panel).
2. You see a table of mappings with columns: Local Code, Local System, Standard Code, Standard System, Status, Confidence.
3. Demo data includes 5 pre-seeded mappings:
   - Audiogram exam → CPT 92557 (APPROVED)
   - TB PPD test → CPT 86580 (APPROVED)
   - Flu vaccine → CVX 141 (APPROVED)
   - HAZWOPER physical → internal code (REVIEWED)
   - TB IGRA test → CPT 86480 (PROPOSED)
4. Click **Add Mapping**:
   - **Local Code:** `ANNUAL-FIT-TEST`
   - **Local System:** `workwell-ohs`
   - **Standard Code:** `415070008`
   - **Standard System:** `http://snomed.info/sct`
   - **Status:** `PROPOSED`
   - **Confidence:** `0.90`
5. Click **Save**. The new mapping appears with status PROPOSED.
6. Click it, change status to **APPROVED**, click **Save**.

---

## Section 10: CSV Exports

### What this is
WorkWell provides CSV exports for runs, outcomes, and cases — suitable for import into Excel, reporting tools, or compliance databases.

### Steps

**Export Run History:**
1. Navigate to `/runs`.
2. Click **Export CSV** (or use the URL: click the export button which calls `/api/exports/runs?format=csv`).
3. The file `runs.csv` downloads. Open in Excel — you should see columns including run ID, measure name, pass rate, outcome counts.

**Export Outcomes for a Specific Run:**
4. Open any run detail page.
5. Click **Export Outcomes CSV**.
6. The file `outcomes.csv` downloads with employee-level data: name, status, last exam date, days overdue, waiver status.

**Export Cases:**
7. Navigate to `/cases`.
8. Apply filters (e.g., Status = OPEN).
9. Click **Export CSV**.
10. The file `cases.csv` downloads with one row per case including delivery status.

**Export Audit Events:**
11. Navigate to the audit events export (may be under Admin or via direct URL).
12. The audit CSV contains every state-changing operation with timestamps, actors, and payloads — suitable for regulatory review.

---

## Section 11: Audit Packets (Structured Export for Auditors)

### What this is
Audit packets are structured, self-contained documents that bundle all evidence related to one entity (a case, a run, or a measure version) into a single JSON or HTML file. These are designed for submission to auditors or regulators who need to verify the platform's compliance decisions without direct database access.

### Types of packets

**Case audit packet** (includes: case history, evidence, actions, outreach, AI logs, disclaimers):
1. Open any case detail page (e.g., Omar Siddiq's OVERDUE case).
2. Click **Export Audit Packet**.
3. Select **HTML** format.
4. An HTML file downloads — formatted for print, with all evidence, actions, and AI logs laid out in audit-friendly sections.

**Run audit packet** (includes: run metadata, outcome summary, logs, audit events):
5. Open any run detail page.
6. Click **Export Audit Packet**.
7. Select **JSON** format.
8. A JSON file downloads — machine-readable, with a SHA-256 hash of the payload for integrity verification.

**Measure version packet** (includes: spec, CQL code + hash, compile result, value sets, traceability, approval history):
9. Open Studio for Annual Audiogram.
10. With an Active version selected, click **Export Audit Packet**.
11. The packet includes the complete lifecycle history of that measure version from Draft to Active.

Every packet generation writes an `AUDIT_PACKET_GENERATED` event to the audit log.

---

## Section 12: MCP Tools (Claude Desktop Integration)

### What this is
WorkWell exposes a **Machine-Callable Protocol (MCP) server** that allows AI agents (like Claude Desktop) to query compliance data programmatically. This means a compliance officer can ask Claude Desktop natural-language questions about workforce compliance and get answers backed by the live WorkWell database.

### Prerequisites
- Claude Desktop is installed
- The MCP server is configured in Claude Desktop's config file with a valid WorkWell JWT
- The WorkWell backend is running

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

> **Role check:** MCP routes are protected by Spring Security. An unauthenticated MCP connection attempt returns 403. The JWT in the Claude Desktop config must belong to a user with at least ROLE_CASE_MANAGER.

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
   `POST https://workwell-measure-studio-api.fly.dev/api/measures/{id}/approve`
   with your session JWT. Expected response: `403 Forbidden`.

**Test 2 — Anonymous access rejected:**
5. Open an incognito window.
6. Try to access: `https://workwell-measure-studio-api.fly.dev/api/measures`
7. Expected: `403 Forbidden` (no cookie, no JWT).

**Test 3 — Case Manager cannot access Admin:**
8. Log in as `cm@workwell.dev`
9. Navigate to `/admin`.
10. Expected: Access denied or redirect (the Admin nav item may not appear for this role).

**Test 4 — MCP requires authentication:**
11. In your terminal (if you have curl):
    ```
    curl https://workwell-measure-studio-api.fly.dev/sse
    ```
12. Expected: `403 Forbidden`.

---

## Section 14: Demo Reset (Non-Production Only)

### What this is
A non-production endpoint exists to reset the volatile demo data (outreach logs, bulk audit entries, etc.) back to a clean state for repeated demos. **This endpoint does not exist in production** (guarded by `@Profile("!prod")`).

> **Only use this in a local development environment — never on the production Fly.io instance.**

### Steps (local only)
1. Log in as `admin@workwell.dev`.
2. In Admin, find the **Demo Reset** button (only visible in non-prod profile).
3. Click it. Confirmation dialog appears.
4. Click **Confirm**.
5. Tables truncated: audit_events, outreach_delivery_log, case_actions (volatile entries only). Core seed data (employees, measures, outcomes) is preserved.

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
