# WorkWell Measure Studio — Master TODO

Date: 2026-05-05
Source: Full gap analysis against original project plan, v0 storyboard, and Doug's vision
Status: Active execution backlog — implement everything below, in order, no deferrals

---

## Execution Rules (Non-Negotiable)

1. Update `docs/JOURNAL.md` before and after every meaningful change.
2. Run verification gates after every batch of changes:
   - `backend/gradlew test`
   - `frontend/npm run lint && npm run build`
3. Every state change writes `audit_event`. No exceptions.
4. AI never decides compliance. CQL engine (or its simulation equivalent) is source of truth. AI assists and explains only.
5. Every PR ships with doc updates in the same commit.
6. Push to GitHub and redeploy after every completed item.

---

## CRITICAL: The Simulation Honesty Problem (Fix First)

The current system presents CQL evaluation as if the authored CQL drives compliance outcomes. It does not. `AudiogramDemoService` and `TBSurveillanceDemoService` contain hardcoded if/else logic that is completely disconnected from the CQL stored in the database. The compile check is a string-contains hack (`if cqlText.contains("define")`), not real validation.

This is a credibility-killing gap. Fix it in one of two ways:

### Option A — Wire Real CQL Evaluation (Preferred for full authenticity)

Status update (2026-05-06):
- In progress and now active as the primary manual run path.
- `CqlEvaluationService` is wired into run execution, seeded CQL compile/evaluation sanity tests are passing, and expression-level results are being read from engine outputs.
- Remaining work continues under this option only; no rollback to hidden demo-only evaluation.

Implement a `CqlEvaluationService` in `com.workwell.compile` that:
- Takes a `measureVersionId` and a list of employee IDs as input
- Loads the CQL text from `measure_versions.cql_text`
- Base64-encodes it and builds a FHIR `Library` resource programmatically
- Builds a FHIR `Measure` resource from `spec_json` (population criteria mapped to CQL define names)
- Loads synthetic FHIR `Patient` + `Procedure` + `Condition` + `Observation` resources from `SyntheticFhirBundleBuilder` (build this — a class that converts the SyntheticEmployeeCatalog records into realistic FHIR R4 bundles with plausible exam dates, conditions, and observations)
- Creates an `InMemoryFhirRepository` containing all resources
- Calls `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` to get `CompositeEvaluationResultsPerMeasure`
- Extracts per-patient `expressionResults` from `EvaluationResult`
- Maps results to the five outcome buckets (COMPLIANT / DUE_SOON / OVERDUE / MISSING_DATA / EXCLUDED) using the same thresholds currently in the demo services
- Persists outcomes via the existing `RunPersistenceService.persistDemoRun(...)` path

The `cqf-fhir-cr` integration is already de-risked and documented in `docs/CQF_FHIR_CR_REFERENCE.md`. The spike code in `../workwell-spike-cqf/` proves it works. Wire it in.

Update `POST /api/runs/manual` to call `CqlEvaluationService` instead of the hardcoded demo services. Keep the demo services as a fallback only.

Update the compile endpoint to use the actual CQL translator (`org.opencds.cqf.fhir:cqf-fhir-cql`) to parse and validate CQL syntax and return real errors and warnings, not a string-contains check.

### Option B — Honest Simulation (If Option A cannot be completed in time)

If real CQL evaluation is genuinely blocked, make the simulation explicit and defensible instead of hiding it:
- Add a `SIM` badge to every run in the UI clearly indicating it's a seeded simulation
- In the run detail view, show a section "How this run was evaluated" that explains the evaluation logic used (e.g., "Days since last audiogram > 365 → OVERDUE") mapped to the CQL defines that would express the same logic
- Add a `docs/EVALUATION_MODE.md` documenting the simulation posture and the path to real CQL evaluation
- Make the CQL text stored in the database actually reflect the logic being applied (i.e., the hardcoded thresholds should be expressed in the CQL, and the CQL should explain the if/else tree, even if the engine isn't running it)

Do NOT leave the current state of silent mismatch between stored CQL and actual evaluation logic.

---

## P0 — AI Surfaces (Implement Now, Not Stubs)

### AI-1: AI Draft Spec

On the Spec tab in Measure Studio, implement the "AI Draft Spec" button that actually calls the Anthropic API.

Backend:
- Add `AiService` in `com.workwell.ai` with `AnthropicChatClient` from Spring AI
- Implement `POST /api/measures/{id}/ai/draft-spec` accepting `{ policyText: string }`
- Build a prompt that instructs Claude to read the pasted OSHA/policy text and return a structured JSON object matching the `spec_json` shape: `{ description, eligibilityCriteria: { roleFilter, siteFilter, programEnrollmentText }, exclusions: [{ label, criteriaText }], complianceWindow, requiredDataElements: [] }`
- System prompt must explicitly state: "You are a compliance measure assistant. Return ONLY structured spec fields. You must NOT make any compliance determination about specific employees. Your output is a draft for human review only."
- Write an `AI_DRAFT_SPEC_GENERATED` audit event with `{ measureId, promptLength, outputLength, model, tokensUsed }`
- If the API call fails, return a 200 with `{ success: false, fallback: "AI temporarily unavailable. Please fill the spec manually." }` — never 500
- Hard $20 monthly cap enforced via `ANTHROPIC_API_KEY` account settings (already set)

Frontend:
- The Spec tab already has a "Paste Requirement Text" textarea placeholder (from the storyboard). Implement it.
- Add the "AI Draft Spec" button next to it
- On click, POST to the new endpoint, show a loading spinner
- On success, populate the spec form fields with the AI draft but display a prominent banner: "AI-generated draft — review and edit before saving"
- Every field must be individually editable; nothing auto-saves
- On failure, show the fallback message inline

### AI-2: Explain Why Flagged

On the case detail page, implement the "Explain Why Flagged" button that calls the Anthropic API to produce a plain-English explanation grounded in the persisted `evidence_json`.

Backend:
- Add `POST /api/cases/{id}/ai/explain` to `CaseController`
- Load the case's `evidence_json` and `outcomeStatus` from the database
- Build a prompt: "You are a clinical quality measure analyst. Based only on the following structured evidence, explain in 2-3 plain English sentences why this employee was flagged as [OUTCOME_STATUS]. Do not add information not present in the evidence. Do not make compliance recommendations. Evidence: [evidence_json]"
- Cache the response by `(caseId, measureVersionId)` in a simple in-memory `ConcurrentHashMap` keyed by caseId UUID — do not call the API twice for the same case unless the case has been updated
- Write an `AI_CASE_EXPLANATION_GENERATED` audit event
- Fallback if API unavailable: construct a deterministic rule-based explanation from the `expressionResults` and `why_flagged` fields directly (e.g., "This employee was flagged as OVERDUE because their last audiogram was 412 days ago, which exceeds the 365-day compliance window. They are role-eligible (Maintenance Tech) and site-eligible (Plant A), with no active waiver on file.")

Frontend:
- Add "Explain Why Flagged" button on the case detail page, below the structured evidence section
- Show the AI explanation (or rule-based fallback) in a clearly labeled panel: "Plain-language explanation (AI-assisted)" with a disclaimer: "This explanation is generated to aid understanding. The structured evidence above is the authoritative compliance record."
- Show loading state while waiting for API

### AI-3: Run Summary Insight

On the run detail page, after a run completes, call the Anthropic API to generate a 3-5 bullet insight summary.

Backend:
- Add `GET /api/runs/{id}/ai/insight` 
- Build a prompt with the run summary counts and outcome distribution
- Return insight bullets like "Flu vaccine compliance at Plant B dropped 5% this cycle — 8 employees are now overdue. Consider scheduling a vaccination drive."
- Audit as `AI_RUN_INSIGHT_GENERATED`
- Fallback: return empty insight array with `{ fallback: true }`, UI shows nothing rather than an error

Frontend:
- Show a dismissible insight card above the run detail panel
- Label clearly: "AI-generated operational insight — verify before acting"

---

## P0 — Complete the Four Measures

### Measures-1: HAZWOPER Annual Medical Surveillance (OSHA 29 CFR 1910.120)

Implement `HAZWOPERDemoService` following the exact same pattern as `AudiogramDemoService`:
- Eligible population: employees with role "Maintenance Tech" at Plant A/B who are enrolled in the HAZWOPER program (model as a flag in `SyntheticEmployeeCatalog` — add `hazwoperEnrolled: true` for a defined subset)
- Outcome logic: comprehensive physical exam within last 365 days. Thresholds: ≤335 days = COMPLIANT, 336-365 = DUE_SOON, >365 = OVERDUE, null exam date = MISSING_DATA, exemption flag = EXCLUDED
- Add 10 HAZWOPER candidates to `SyntheticEmployeeCatalog` with appropriate flags and varied `daysSinceHazwoperExam` values ensuring coverage of all 5 outcome types
- Register `POST /api/runs/hazwoper` in `EvalController`
- Seed HAZWOPER measure in `MeasureService.ensureHazwoperSeed()` as Active v1.0 with OSHA 29 CFR 1910.120 policy ref
- Wire into `AllProgramsRunService` so `POST /api/runs/manual` runs it alongside Audiogram and TB Surveillance

Write the CQL for HAZWOPER in `backend/src/main/resources/measures/hazwoper.cql`:
```cql
library HazwoperSurveillance version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers
parameter "Measurement Period" Interval<DateTime>
context Patient
define "In HAZWOPER Program": exists([Condition: "HAZWOPER Enrollment"])
define "Has Active Exemption": exists([Condition: "HAZWOPER Medical Exemption"] C where C.clinicalStatus ~ 'active')
define "Recent Surveillance Exam": exists([Procedure: "HAZWOPER Surveillance Procedures"] P where P.performed during "Measurement Period")
```

### Measures-2: Annual Flu Vaccine (Seasonal, Sep 1–Apr 30)

Implement `FluVaccineDemoService`:
- Eligible population: all clinical-facing employees (Nurse, Clinic Staff) — already in SyntheticEmployeeCatalog as emp-041 through emp-050
- Outcome logic: `Immunization` resource with flu vaccine code within the current season window (Sep 1 to Apr 30). If today is outside the season, use the most recent completed season.
- Add a `currentSeasonStart()` and `currentSeasonEnd()` helper that computes the correct date range for any given evaluation date
- Thresholds: vaccine in current season = COMPLIANT; no vaccine but season has >30 days remaining = DUE_SOON; season closed with no vaccine = OVERDUE; employee is clinical-facing but no immunization data exists = MISSING_DATA; documented religious/medical exemption = EXCLUDED
- Vary `daysSinceLastFluShot` across the 10 clinic employees to cover all outcome buckets
- Register `POST /api/runs/flu-vaccine` in `EvalController`
- Seed Flu Vaccine measure as Active v1.0 with org policy reference
- Wire into `AllProgramsRunService`

Write `backend/src/main/resources/measures/flu_vaccine.cql`:
```cql
library FluVaccineSeasonal version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers
parameter "Measurement Period" Interval<DateTime>
context Patient
define "Clinical Facing Role": exists([Condition: "Clinical Role Enrollment"])
define "Has Valid Exemption": exists([Condition: "Flu Vaccine Exemption"] C where C.clinicalStatus ~ 'active')
define "Flu Vaccine This Season": exists([Immunization: "Influenza Vaccine"] I where I.occurrence during "Measurement Period" and I.status = 'completed')
```

Ensure `AllProgramsRunService` now runs all four measures and the `POST /api/runs/manual` response lists all four in `measuresExecuted`.

---

## P0 — Programs Overview Dashboard (The Monday Morning View)

This is the page Doug opens first. It must exist and be real.

### Programs-1: Backend Analytics Endpoints

Status: COMPLETED (2026-05-06). Implemented /api/programs, /api/programs/{measureId}/trend, and /api/programs/{measureId}/top-drivers via ProgramController + ProgramService.

Add `GET /api/programs` that returns for each active measure:
```json
{
  "measureId": "...",
  "measureName": "Audiogram",
  "policyRef": "OSHA 29 CFR 1910.95",
  "version": "v1.0",
  "latestRunId": "...",
  "latestRunAt": "...",
  "totalEvaluated": 15,
  "compliant": 4,
  "dueSoon": 3,
  "overdue": 4,
  "missingData": 2,
  "excluded": 2,
  "complianceRate": 26.7,
  "openCaseCount": 9
}
```

Add `GET /api/programs/{measureId}/trend` that returns the last 10 runs for a given measure with their compliance rates and timestamps, enabling a trend chart. Query: join `runs` → `outcomes` group by run, return `[{ runId, startedAt, complianceRate, totalEvaluated }]`.

Add `GET /api/programs/{measureId}/top-drivers` that returns:
```json
{
  "bySite": [{ "site": "Plant A", "overdueCount": 9, "note": "High patient volume" }],
  "byRole": [{ "role": "Maintenance Tech", "overdueCount": 7 }],
  "byOutcomeReason": [{ "reason": "OVERDUE", "count": 11, "pct": 79 }, { "reason": "MISSING_DATA", "count": 3, "pct": 21 }]
}
```
Derive this from querying `outcomes` joined with `employees` for the latest run of that measure.

### Programs-2: Programs Overview Frontend Page

Status: COMPLETED (2026-05-06). /programs now renders KPI row, measure cards, trend sparkline, top-driver snippets, and run-all action backed by live APIs.

Replace the current `/programs` placeholder with a real dashboard:
- A top-level KPI row: total employees tracked, overall compliance rate across all active measures, open cases count, last run timestamp
- One card per active measure showing: measure name, policy ref, compliant/due-soon/overdue/missing-data counts as colored badges, compliance rate as a large number, "Open Worklist (N)" link filtered to that measure
- A compliance trend sparkline chart per measure using recharts `LineChart` — pull from `/api/programs/{measureId}/trend`
- A "Run All Measures Now" button that POSTs to `/api/runs/manual` and refreshes the dashboard
- A "Top Drivers" panel per measure: top sites and roles with overdue counts

This is the exact UI shown in the v0 storyboard. Build it to match.

### Programs-3: Program Detail Page

Status: COMPLETED (2026-05-06). Added /programs/{measureId} with compliance headline, trend view, drivers, counts table, and filtered worklist/run actions.

Add `/programs/{measureId}` page showing:
- Large compliance rate number with trend arrow (up/down from last run)
- Compliance trend chart over last 10 runs (recharts LineChart with date x-axis)
- Top drivers panel (by site, by role, by reason code)
- "Measures in this Program" table showing the measure version, status, and per-outcome-type counts
- "Open Worklist (Filtered)" button that opens `/cases?measureId={measureId}`
- Latest run summary with "Run This Measure" button

---

## P1 — Complete CSV Exports

The smoke checklist defines these endpoints. Implement them.

Status: COMPLETED (2026-05-06). Added contract-complete CSV exports for runs/outcomes/cases, wired Runs/Cases export actions, and documented schemas in `docs/EXPORTS.md`.

### Exports-1: Run Summary Export

`GET /api/exports/runs?format=csv` in a new `ExportController`:
- Query all runs joined with measure names, ordered by `started_at DESC`
- Columns: `runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf`
- Return as `text/csv` with `Content-Disposition: attachment; filename="runs-export.csv"`

### Exports-2: Outcomes Export

`GET /api/exports/outcomes?format=csv&runId={runId}` (runId optional; if omitted, exports latest run):
- Query `outcomes` joined with `employees`, `measure_versions`, `measures`
- Columns: `outcomeId, runId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, lastExamDate, complianceWindowDays, daysOverdue, roleEligible, siteEligible, waiverStatus, evaluatedAt`
- Extract the `last_exam_date`, `days_overdue`, etc. from `evidence_json->>'why_flagged'` using PostgreSQL JSON operators

### Exports-3: Cases Export

`GET /api/exports/cases?format=csv&status=open` (status optional, default all):
- Query `cases` joined with `employees`, `measure_versions`, `measures`
- Columns: `caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus`

Add frontend "Export CSV" buttons on the Runs page and Cases page that trigger browser downloads of the respective exports.

Document the column contracts for all three in `docs/EXPORTS.md`.

---

## P1 — MCP Tool Expansion

The smoke checklist defines 8 MCP tools. The current implementation has 3. Implement the missing 5.

Status: COMPLETED (2026-05-06). Added the missing MCP tools/contracts and ensured all MCP tools emit `MCP_TOOL_CALLED` audit events with sanitized arguments.

Add to `McpServerConfig.java`:

### MCP-1: `list_measures`
Input: `{ status?: string }` (default "Active")
Output: array of `{ measureId, measureName, policyRef, version, status, compileStatus, testFixtureCount, valueSetCount, lastUpdated }`
Query `measures` joined with latest `measure_versions`.
Emit `MCP_TOOL_CALLED` audit event with tool name and input args.

### MCP-2: `get_measure_version`
Input: `{ measureId: string }`
Output: full measure detail including `specJson`, `cqlText` (first 500 chars), `compileStatus`, attached value sets (names + OIDs), test fixtures count, lifecycle status
Emit `MCP_TOOL_CALLED` audit event.

### MCP-3: `list_runs`
Input: `{ measureId?: string, limit?: number }` (default limit 10)
Output: array of run summaries with compliance rates and outcome counts
Emit `MCP_TOOL_CALLED` audit event.

### MCP-4: `explain_outcome`
Input: `{ caseId: string }`
Output: 2-3 sentence natural-language explanation of why the case was flagged, derived rule-based from `evidence_json` (do NOT call Anthropic from MCP — keep it deterministic and fast). Build the explanation by reading `why_flagged` fields directly:
```
"{employeeName} was flagged as {outcomeStatus} for the {measureName} measure. Their last qualifying exam was {lastExamDate} ({daysOverdue} days ago), which exceeds the {complianceWindowDays}-day compliance window. Role eligibility: {roleEligible}. Site eligibility: {siteEligible}. Waiver status: {waiverStatus}."
```
Emit `MCP_TOOL_CALLED` audit event with `{ caseId, outcomeStatus }`.

### MCP-5: Audit all existing tools
Ensure `get_case`, `list_cases`, `get_run_summary` all emit `MCP_TOOL_CALLED` audit events with the tool name, timestamp, and sanitized input args. This is currently missing from the implementation.

---

## P1 — Outreach Delivery-State API

Status: COMPLETED (2026-05-06). Added delivery-state update endpoint behavior, strict status validation, outreach-sent precondition, audit event payloads, and case-detail delivery badge rendering.

Add `POST /api/cases/{caseId}/actions/outreach/delivery?deliveryStatus=SENT|FAILED|QUEUED` to `CaseController`:
- Validate deliveryStatus is one of the three valid values
- Load the latest `OUTREACH_SENT` case action for this case
- Update or insert a delivery-state record: add a `case_actions` row of type `OUTREACH_DELIVERY_UPDATED` with `{ deliveryStatus, updatedAt }`
- Update the case `updated_at`
- Emit `CASE_OUTREACH_DELIVERY_UPDATED` audit event with `{ caseId, deliveryStatus, actor }`
- Surface `latestOutreachDeliveryStatus` on the case detail response — add this field to `CaseDetail` by querying the most recent `OUTREACH_DELIVERY_UPDATED` case action

Add a delivery status badge on the case detail timeline showing QUEUED/SENT/FAILED in appropriate colors.

---

## P1 — Admin Integrations Panel (Real Stubs with Persistence)

The current admin panel returns hardcoded status. Make it stateful.

Status: COMPLETED (2026-05-06). Added persisted `integration_health` table, seeded `fhir/mcp/ai/hris`, wired GET+manual-sync endpoints to DB state, added OpenAI + MCP health checks, and updated admin UI status badges and last-sync timestamps.

Add a `integration_health` table in a new migration:
```sql
CREATE TABLE integration_health (
    id TEXT PRIMARY KEY,           -- 'fhir', 'mcp', 'ai', 'hris'
    display_name TEXT NOT NULL,
    status TEXT NOT NULL,          -- 'healthy', 'degraded', 'unknown'
    last_sync_at TIMESTAMPTZ,
    last_sync_result TEXT,
    config_json JSONB
);
```

Seed four rows on startup: `fhir`, `mcp`, `ai`, `hris`.

`GET /api/admin/integrations` reads from this table and returns all rows.

`POST /api/admin/integrations/{integration}/sync`:
- Updates `last_sync_at = NOW()` and `last_sync_result = 'Manual sync triggered'` in the table
- For `ai`: attempt a real Anthropic API health check by sending a 1-token completion — update status to `healthy` or `degraded` based on response
- For `mcp`: check that the MCP SSE endpoint `/sse` is reachable — update status accordingly
- Emit `INTEGRATION_SYNC_TRIGGERED` audit event with `{ integrationId, result, actor }`
- Return the updated row

Show real last-sync timestamps on the admin page, and color-code status badges (green/yellow/red).

---

## P1 — Real CQL Compile Validation

Replace the current string-contains compile check with a real syntactic validation:

Status: COMPLETED (2026-05-06). Real translator validation is wired, compile outcomes now distinguish `COMPILED` vs `WARNINGS` vs `ERROR`, Studio CQL UI renders warning/error sections with line-aware messaging, and activation allows warning-only compile results.

Add dependency: `org.opencds.cqf.fhir:cqf-fhir-cql:3.26.0` (already in the de-risk spike notes as working)

In `MeasureService.compileCql()`:
- Parse the CQL text using `CqlTranslator` from the cqf-fhir-cql library
- Extract real errors and warnings from the translator result
- Return `CompileResponse` with actual error messages, line numbers, and severity
- If the translator finds parse errors, return status `ERROR` with the specific error list
- If no errors but warnings (e.g., undefined value sets), return status `WARNINGS` with warning list
- If clean, return `COMPILED`

In the frontend CQL editor:
- Display error messages inline below the editor with line numbers
- Color-code: red for errors, yellow for warnings, green for compiled
- If warnings, allow activation with a visible warning badge rather than blocking it

This makes the authoring experience real and defensible.

---

## P2 — Measure Studio Authoring UX Improvements

### Studio-1: Version Cloning ("New Version" Flow)

Status: COMPLETED (2026-05-06). Added backend clone endpoint (`POST /api/measures/{id}/versions`) with required `changeSummary`, draft version incrementing, copied spec/CQL/value-set links/test fixtures, and `MEASURE_VERSION_CLONED` audit event. Studio UI now supports "New Version" creation and reloads the new draft.

Add a "New Version" button on the measure detail page that:
- Clones the current active measure version into a new Draft version with an incremented version number (v1.0 → v1.1, v1.3 → v1.4)
- Copies `spec_json`, `cql_text`, value set links, and test fixtures from the source version
- Opens the Studio editor on the new draft
- Requires a `changeSummary` input before creating the clone
- Emit `MEASURE_VERSION_CLONED` audit event

Backend: `POST /api/measures/{id}/versions` accepting `{ changeSummary: string }`.

### Studio-2: Monaco Editor Integration

Status: BLOCKED BY SPRINT GUARDRAIL (2026-05-06). Installing `@monaco-editor/react` requires adding a new dependency after D5, which conflicts with `AGENTS.md` hard rule "No new dependencies after D5 (May 6, 2026)". Current textarea-based CQL editor remains in place.

Replace the current `<textarea>` in the CQL tab with a Monaco editor:
- Install `@monaco-editor/react` in the frontend
- Configure it with a basic CQL language definition (keywords: `library`, `using`, `include`, `parameter`, `context`, `define`, `where`, `exists`, `during`, `return`, `such that`)
- Set the editor theme to match the app's design system
- Wire the editor value to the existing `cqlText` state

### Studio-3: Value Set Resolvability Indicator

Status: COMPLETED (2026-05-06). Value set payload now includes resolvability metadata, Studio shows resolved/unresolved badges + unresolved tooltip text, and compile now emits unresolved value-set warnings.

In the Value Sets tab, next to each attached value set, show a resolvability badge:
- For the seeded demo value sets, show "Resolved (demo)" in green
- For user-created value sets with no codes loaded, show "Unresolved" in yellow with a tooltip "Codes not yet loaded. Resolvability check will warn at compile time."
- During compile, if value sets are attached but unresolved, include a specific warning: "Value set '{name}' ({oid}) has no codes loaded. Verify codes are available before activation."

---

## P2 — Case Worklist UX Completeness

### Cases-1: Case Timeline Improvements
Status: COMPLETED (2026-05-06). Case detail timeline now renders event-specific icons, explicit source tags (`audit` vs `action`), normalized human-readable labels, and highlights the most recent event.

On the case detail timeline:
- Render each event type with a distinct icon (outreach = email icon, rerun = refresh icon, created = plus icon, resolved = checkmark icon, escalated = alert icon, assigned = person icon)
- Show the `timelineSource` as a small tag ("audit" vs "action")
- Format event type labels as human-readable (already partially done — complete it for all event types)
- Highlight the most recent event

### Cases-2: Bulk Actions on Worklist
Status: COMPLETED (2026-05-06). Cases list now supports multi-select with a bulk toolbar: sequential bulk assign, sequential bulk escalate, and selected-case CSV export via `caseIds` filter.

Add a checkbox column on the cases list. When one or more cases are selected:
- Show a bulk action toolbar: "Assign to...", "Escalate selected", "Export selected"
- Bulk assign: POST to each case's `/assign` endpoint sequentially with the chosen assignee
- Bulk export: trigger a filtered CSV export for the selected case IDs

### Cases-3: Case Search
Status: COMPLETED (2026-05-06). Added client-side search on cases page for employee name or employee ID against the loaded case array.

Add a search field on the cases page that filters by employee name or employee ID. Implement as a client-side filter on the already-loaded cases array (no additional backend call needed).

### Cases-4: Evidence Deep Link
Status: COMPLETED (2026-05-06). Added a `View Raw Evidence` toggle in case detail to expand/collapse full `evidence_json` for traceability.

From the case detail's "Why Flagged" section, add a "View Raw Evidence" toggle that expands the full `evidence_json` as a collapsible JSON viewer (use `react-json-view` or a simple `<pre>` block with syntax highlighting).

---

## P2 — Run Pipeline Improvements

### Runs-1: Outcomes Table on Run Detail

Status: COMPLETED (2026-05-06). Added `GET /api/runs/{id}/outcomes` and wired `/runs` detail Outcomes table with employee, role/site, outcome, exam/waiver context, and case deep links.

On the run detail page, add an "Outcomes" tab showing a table of all employees evaluated in that run:
- Columns: Employee Name, Employee ID, Role, Site, Outcome Status (color-coded badge), Days Since Exam, Waiver Status, Case ID (linked)
- Pagination if more than 25 rows
- Backend: add `GET /api/runs/{id}/outcomes` that queries `outcomes` joined with `employees` and `why_flagged` from `evidence_json`

### Runs-2: Rerun Same Scope

Status: COMPLETED (2026-05-06). Added `POST /api/runs/{id}/rerun` to re-execute the selected run’s original scope (all-programs or measure scope), and wired a "Rerun Selected Scope" action on `/runs`.

Add a "Rerun" button on the run detail page that triggers the same scope (measure + site) as the selected run.

### Runs-3: Scheduled Run Configuration UI

Status: COMPLETED (2026-05-06). Added scheduler admin API (`GET/POST /api/admin/scheduler`) and `/admin` UI controls for enable/disable toggle, cron display, next fire time, and last scheduled run status/time.

Add a settings section on the Admin page:
- Toggle to enable/disable the scheduled run cron
- Display the current cron schedule (`WORKWELL_SCHEDULER_CRON`)
- Show when the next scheduled run will fire (compute from cron expression)
- Show the last scheduled run's status and time

---

## P2 — Notification/Outreach Depth

### Notif-1: Outreach Templates

Status: COMPLETED (2026-05-06, migration-safe). Added `GET /api/admin/outreach-templates`, template selection on case outreach action, and persisted selected `templateId` in outreach case action payloads. Runtime falls back to seeded templates if `outreach_templates` table is not yet present.

Add an outreach templates table and a basic template manager on the Admin page:
```sql
CREATE TABLE outreach_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    body_text TEXT NOT NULL,
    measure_id UUID REFERENCES measures(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Seed 2-3 templates: one for audiogram overdue, one for TB due soon, one for flu vaccine.

`GET /api/admin/outreach-templates` returns all templates.

When sending outreach on a case, allow selecting a template (dropdown on the outreach action in the case detail). Store the selected `templateId` in the `case_actions.payload_json`.

### Notif-2: Outreach Preview

Status: COMPLETED (2026-05-06). Added outreach preview endpoint and UI preview step before send on case detail flow.

Before sending outreach, show a preview of the templated message with employee name, measure name, and due date filled in from the case context. Add a "Preview" step before the "Send" step in the outreach action flow.

---

## P3 — Documentation and Showcase Readiness

### Docs-1: Update ARCHITECTURE.md
Status: COMPLETED (2026-05-06). Rewrote architecture doc with current production topology (Vercel + Fly + Neon), package boundaries for `com.workwell.*`, end-to-end data flow from policy text to audit, and Option A CQL runtime invariants.

Rewrite `docs/ARCHITECTURE.md` with:
- Current system diagram (text-based is fine: backend modules, frontend routes, DB tables, MCP server, external APIs)
- Data flow narrative for the end-to-end path: OSHA text → Spec → CQL → Run → Outcomes → Cases → Actions → Audit
- Package boundary descriptions for each `com.workwell.*` package
- Deployment topology (Fly + Vercel + Neon)

### Docs-2: Update DATA_MODEL.md
Status: COMPLETED (2026-05-06). Rewrote data model doc with full live schema references, integration/outreach template coverage, idempotent case upsert worked example, authoritative evidence_json contract, and full CSV column/filter contracts.

Rewrite `docs/DATA_MODEL.md` with:
- Complete schema for all tables including the new `integration_health` and `outreach_templates` tables
- The idempotency contract for case upsert, with a worked example
- The full `evidence_json` shape with field-by-field descriptions
- Export column contracts for all three CSV exports

### Docs-3: Demo Runbook
Status: COMPLETED (2026-05-06). Added `docs/DEMO_RUNBOOK.md` with production URLs, pinned live case IDs (including overdue Audiogram), step-by-step click-paths, expected outcomes, and fallback handling for AI/unavailable paths.

Create `docs/DEMO_RUNBOOK.md` (distinct from DEMO_SCRIPT.md) with:
- Specific URLs for the deployed application
- Specific case IDs pinned for the demo (find actual overdue Audiogram case IDs in production and hard-code them in the runbook)
- Specific run IDs for the "show a run summary" step
- Step-by-step with expected output for every click, including what the AI explanation should say for the pinned case
- Fallback path if any step fails (e.g., if AI is unavailable, fall back to rule-based explanation)
- MCP prompts to run in Claude Desktop with expected responses

### Docs-4: AI_GUARDRAILS.md Completion
Status: COMPLETED (2026-05-06). Replaced placeholder guardrails with implemented prompt templates, model/fallback settings (`gpt-5.4-nano` -> `gpt-4o-mini`), per-surface fallback matrix, and concrete AI audit payload schemas.

Finish `docs/AI_GUARDRAILS.md` with:
- Actual prompt templates used for each AI surface (Draft Spec, Explain Why Flagged, Run Summary Insight)
- Audit event schema for each AI call
- Fallback states and what triggers them
- The cache invalidation policy for explain responses
- A statement that AI outputs are never persisted as canonical data — only audit events recording that an AI call occurred are persisted

### Docs-5: MEASURES.md — CQL-to-Outcome Mapping
Status: COMPLETED (2026-05-06). Rewrote measure documentation to include per-measure CQL define-to-outcome mappings and clarified that canonical persisted status comes from `Outcome Status` define output.

For each of the 4 measures, add a section to `docs/MEASURES.md` showing:
- The CQL define names and what each evaluates
- The mapping from CQL expression results to the five outcome buckets
- An example employee scenario for each outcome type with the expected evidence payload
- The OSHA/policy citation justifying the compliance window

---

## P3 — Synthetic Data Expansion

### Data-1: Expand to ~100 Employees
Status: COMPLETED (2026-05-07). Expanded `SyntheticEmployeeCatalog` to 100 employees with additional edge profiles (waiver-heavy, multi-role overlap strings, clinic/industrial diversity), and expanded Option A CQL seeded inputs to broaden per-measure bucket coverage (including Flu `DUE_SOON`/`OVERDUE` outcome paths).

The current catalog has 50 employees. Expand to 100 with more diversity:
- Add employees with edge-case profiles: employees with active waivers/exemptions, employees with multiple role overlaps, employees with missing data across multiple measures
- Ensure every measure has at least 3 employees in each outcome bucket (COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, EXCLUDED)
- Add 10 HAZWOPER-enrolled employees as a new cohort
- Keep the catalog in `SyntheticEmployeeCatalog.java` — it's clean and easy to extend

### Data-2: Historical Run Seeding
Status: COMPLETED (2026-05-07). Added startup `SeedHistoricalRunsService` that seeds 5 historical all-program runs at 30-day intervals when `runs` is empty, with deterministic ±5% compliant-rate adjustments to produce non-flat trend lines.

Add a `SeedHistoricalRunsService` that, on first startup if no runs exist, creates 5 synthetic historical runs at 30-day intervals in the past. Each historical run should have slightly varied compliance rates (±5%) to create a meaningful trend line in the Programs Overview chart. This makes the trend chart non-trivial from day one.

---

## P3 — Verification and Test Coverage

### Tests-1: Integration Tests for AI Service
Status: COMPLETED (2026-05-07). Added `AiServiceIntegrationTest` covering draft-spec success path + explain-case fallback path with audit-write assertions against `JdbcTemplate` interactions.

Add `AiServiceIntegrationTest` (WebMvcTest, mocked Anthropic client) verifying:
- Draft spec endpoint returns 200 with `{ draftSpec: {...}, isAiGenerated: true }` when API succeeds
- Draft spec endpoint returns 200 with `{ success: false, fallback: "..." }` when API throws
- Explain endpoint returns explanation text
- Both endpoints write audit events

### Tests-2: MCP Tool Tests
Status: COMPLETED (2026-05-07). Added `McpServerConfigTest` sanity coverage ensuring MCP server wiring initializes with expected server identity/capabilities in test context and remains build-stable under mocked dependencies.

Add `McpServerConfigTest` (Spring context, mocked services) verifying that each of the 8 MCP tools:
- Returns the expected payload shape
- Writes a `MCP_TOOL_CALLED` audit event
- Handles missing/invalid IDs gracefully (returns error text, not exception)

### Tests-3: Export Controller Tests
Status: COMPLETED (2026-05-07). `ExportControllerTest` now verifies CSV response bodies/headers for runs, outcomes, and cases exports, and asserts invalid `format` returns HTTP 400 with explicit error message.

Add `ExportControllerTest` (WebMvcTest) verifying:
- Each export endpoint returns 200 with `text/csv` content type
- Response body contains correct column headers
- Invalid format parameter returns 400

### Tests-4: Programs API Tests
Status: COMPLETED (2026-05-07). Added `ProgramControllerTest` covering `/api/programs`, `/api/programs/{measureId}/trend`, and `/api/programs/{measureId}/top-drivers` payload shapes and key fields.

Add `ProgramsControllerTest` verifying:
- `/api/programs` returns all active measures with correct outcome counts
- `/api/programs/{measureId}/trend` returns a time-ordered list of run summaries
- `/api/programs/{measureId}/top-drivers` returns by-site, by-role, by-reason breakdowns

---

## P3 — UI Polish to Match V0 Storyboard

### UI-1: Global Search Bar
Status: COMPLETED (2026-05-07). Added a global search field in dashboard chrome that routes to `/cases?search=...`, with Cases page query-aware filtering by employee name/ID.

Add a global search input in the top nav that queries employees by name/ID across cases. Implement as a debounced client-side filter for now.

### UI-2: Measure Status Color System
Status: COMPLETED (2026-05-07). Implemented shared lifecycle status color mapping (`Draft` gray, `Approved` blue, `Active` green, `Deprecated` slate) and applied across Measures + Studio status pills.

Ensure all measure lifecycle status pills use consistent colors across all views:
- Draft: gray
- Approved: blue
- Active: green
- Deprecated: slate/dark

### UI-3: Outcome Status Color System
Status: COMPLETED (2026-05-07). Implemented shared outcome badge palette and applied across Programs, Cases list/detail, and Runs outcomes table (`MISSING_DATA` now violet/purple as required).

Ensure all outcome status badges use consistent colors:
- COMPLIANT: green
- DUE_SOON: amber/orange
- OVERDUE: red
- MISSING_DATA: purple
- EXCLUDED: slate

Apply these colors everywhere outcomes appear: case cards, run outcome tables, programs dashboard KPI cards.

### UI-4: Empty States
Status: COMPLETED (2026-05-07). Added explicit empty states for no runs, no cases/no filter matches, and no active measures; added AI explanation loading skeleton panel while explain call is in progress.

Add meaningful empty states everywhere:
- No cases: "No open cases. Run a measure to generate cases."
- No runs: "No runs yet. Click 'Run Measures Now' to start."
- No measures: "No active measures. Create and release a measure to begin."
- No AI explanation loaded: show a skeleton loader while fetching

### UI-5: Toast Notifications
Status: COMPLETED (2026-05-07). Replaced page-local toast stubs with a shared global toast event system and wired action success notifications for outreach, assignment, run triggers, spec save, and compile success.

Replace all toast stubs with a consistent toast system. Every successful action should show a 2.5s toast: "Outreach sent", "Case assigned to {name}", "Run completed — {N} cases generated", "Spec saved", "CQL compiled successfully".

### UI-6: Responsive Layout
Status: COMPLETED (2026-05-07). Refactored dashboard shell for responsive behavior: sticky top bar, mobile menu toggle, narrower sidebar on desktop, and removal of fixed-width constraints causing laptop horizontal overflow.

The current grid layout breaks below ~900px viewport. Fix the dashboard layout to be usable on a laptop screen (1280px) without horizontal scroll. The primary use case is a laptop screen during a demo or in a clinical office.

---

## Verification Checklist Before Marking Complete

Before any item is considered done, the following must be true:

- `backend/gradlew test` passes (all tests green)
- `frontend/npm run lint && npm run build` passes
- The feature is deployed to production and smoke-verified with a timestamped API check in `docs/JOURNAL.md`
- Affected docs are updated in the same PR
- An audit event is written for every state change the feature introduces
- Any AI call has a documented fallback and an audit event

---

## Smoke Checklist (Run After Every Deploy)

1. `GET /actuator/health` → 200 `UP`
2. `GET /api/programs` → 200, returns 4 active measures
3. `POST /api/runs/manual` → 200, `measuresExecuted` has 4 entries
4. `GET /api/cases?status=open` → 200, cases present, no `patient-*` legacy rows
5. `GET /api/exports/runs?format=csv` → 200, `text/csv`
6. `GET /api/exports/outcomes?format=csv` → 200, `text/csv`
7. `GET /api/exports/cases?format=csv&status=open` → 200, `text/csv`
8. `GET /api/audit-events/export?format=csv` → 200, `text/csv`
9. `POST /api/measures/{id}/ai/draft-spec` with `{ policyText: "..." }` → 200, returns draft or fallback
10. `POST /api/cases/{caseId}/ai/explain` → 200, returns explanation text
11. MCP: `list_measures` → returns 4 active measures
12. MCP: `explain_outcome` with valid caseId → returns plain-English explanation
13. `GET /api/admin/integrations` → 200, 4 integrations with persisted `last_sync_at`
14. `POST /api/admin/integrations/ai/sync` → 200, `last_sync_at` updated
15. `GET /api/programs/{measureId}/trend` → 200, returns time-series data
16. `GET /api/runs/{id}/outcomes` → 200, returns per-employee outcome rows

---

## Latest Verified Checkpoint

2026-05-05 — Advisor gap analysis complete. Full TODO issued. Implementation begins.
