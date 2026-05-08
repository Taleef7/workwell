# WorkWell Measure Studio — Demo Script
## Target audience: Faculty advisor + internship sponsor
## Duration: ~20 minutes
## Setup: See DEMO_RUNBOOK.md for required pre-flight checks

---

## Act 1: The Programs Overview (2 min)
- Click `Programs` in the left navigation to open `/programs`.
Expected output: KPI row loads with total employees, overall pass rate, open worklist count, and trend indicator.
Talking point: "This is the operational command center showing workforce compliance health at a glance."
- In the measure grid, point to all 4 cards (Audiogram, TB Surveillance, HAZWOPER Surveillance, Flu Vaccine) and each card’s sparkline.
Expected output: Each card shows current pass rate and trend.
Talking point: "Each program card combines current status with recent trend so supervisors can prioritize quickly."
- Scroll to the Top non-compliant drivers table.
Expected output: Driver rows appear with counts for the most common non-compliance causes.
Talking point: "Root-cause visibility is built in, so we focus interventions on the highest-impact gaps."
- Click `Run All Measures Now`, then click `Confirm` in the modal.
Expected output: A successful action state appears and all four measure cards show refreshed run timestamps.
Talking point: "One action re-evaluates every active program with a full audit trail."

## Act 2: Drill into Audiogram (4 min)
- Click the `Audiogram` card on `/programs`.
Expected output: You land on the Audiogram measure view with run history visible.
Talking point: "Now we drill from portfolio view into one measure’s execution evidence."
- Open the latest run from the Runs history tab.
Expected output: Run detail shows outcome buckets and evaluated employee counts.
Talking point: "Run-level evidence is deterministic and tied to a specific versioned measure."
- In the AI Run Insight panel, read one bullet from the generated summary.
Expected output: Insight bullet appears with plain-language interpretation.
Talking point: "AI summarizes evidence, but measure compliance is still decided by CQL only."
- Click a `NON_COMPLIANT` or `OVERDUE` outcome row to open case detail.
Expected output: Case detail panel/page opens for that employee.
Talking point: "Each non-compliant outcome automatically becomes an actionable case."
- In case detail, show the timeline/audit trail and then perform `Assign` followed by `Escalate`.
Expected output: New timeline entries appear for assignment and escalation state transitions.
Talking point: "Every workflow action is traceable for operational accountability."

## Act 3: Outreach Workflow (3 min)
- From an open non-compliant case, click `Send Outreach`.
Expected output: Outreach preview modal opens with message template content.
Talking point: "Outreach is template-driven so communication is consistent and reviewable."
- Read the preview body, then click `Send`.
Expected output: Case status updates to `OUTREACH_SENT` and timeline logs the action.
Talking point: "The workflow converts compliance findings directly into employee communication."
- Watch/update delivery state to show `QUEUED` then `SENT`.
Expected output: Delivery badge transitions from queued to sent.
Talking point: "Delivery tracking closes the loop between decision and execution."
- Return to the cases list, multi-select 3 open cases, and run `Bulk Escalate`.
Expected output: Bulk action completes and selected cases reflect escalated status/timeline entries.
Talking point: "Supervisors can perform high-volume operations without losing per-case audit integrity."

## Act 4: Measure Studio (3 min)
- Navigate directly to `/studio/{audiogram-id}` from the measure detail or URL.
Expected output: Measure Studio opens with CQL editor and version metadata.
Talking point: "Studio keeps clinical logic versioned and editable in one place."
- Show the CQL editor and current version badge/status.
Expected output: Active/draft version data is visible in header and editor area.
Talking point: "Authors can inspect and evolve logic with explicit lifecycle controls."
- Click `New Version`, enter a `changeSummary`, and submit.
Expected output: A new Draft version appears in version history.
Talking point: "Version cloning allows safe iteration without mutating active production logic."
- Point out lifecycle progression labels: Draft -> Approved -> Active.
Expected output: Lifecycle states are visible with compile/test gate cues.
Talking point: "Activation is gated to prevent unvalidated logic from entering production."

## Act 5: Flu Vaccine & HAZWOPER (2 min)
- Run `Flu Vaccine` from its measure card/page.
Expected output: Run completes with a non-zero compliant count and visible pass rate.
Talking point: "This confirms the platform supports distinct program logic beyond a single demo measure."
- Run `HAZWOPER Surveillance`.
Expected output: Outcome buckets include `EXCLUDED` for employees outside HAZWOPER role scope.
Talking point: "Eligibility boundaries are explicit, so exclusions are explainable and intentional."
- Return to `/programs`.
Expected output: KPI row and program cards reflect refreshed run metrics.
Talking point: "Portfolio metrics update immediately after measure-level execution."

## Act 6: AI + MCP (4 min)
- Open an overdue Audiogram case and click `Explain This Case`.
Expected output: AI explanation appears with evidence-aligned reasoning.
Talking point: "AI improves readability, while deterministic evidence remains the source of truth."
- In MCP client (Claude Desktop or terminal), call `list_measures`.
Expected output: Response lists all 4 active measures with IDs/metadata.
Talking point: "MCP exposes structured compliance context to any compatible LLM agent."
- Call `get_run_summary` for the latest Audiogram run.
Expected output: Response shows run totals and outcome counts.
Talking point: "External agents can retrieve run-level operational state without UI navigation."
- Call `explain_outcome` using the pinned Audiogram case ID from `DEMO_RUNBOOK.md`.
Expected output: Response includes populated evidence fields for `lastExamDate`, `daysOverdue`, and `complianceWindowDays` (not `unknown`).
Talking point: "This is deterministic explainability over MCP, not a black-box narrative."

## Act 7: Admin Panel (2 min)
- Click `Admin` in navigation to open `/admin`.
Expected output: Integration Health row shows service states (FHIR, MCP, AI, HRIS).
Talking point: "Operational reliability is visible and monitorable from one control surface."
- Toggle scheduler `Off`, then `On`.
Expected output: Scheduler state updates and persists visibly.
Talking point: "Operators can pause/resume scheduled automation during incidents or maintenance."
- Open Outreach Templates and read one template body aloud.
Expected output: Template content is visible and editable in admin context.
Talking point: "Comms governance is centralized so outreach remains consistent across teams."
