# DATA_MODEL — Contracts (always-loaded extract)

> **Authoritative.** These three contracts are extracted from `docs/DATA_MODEL.md` so they can be
> `@`-imported into every session — the Definition of Done makes idempotency + audit invariants
> mandatory on every PR, so they are load-bearing on every change.
>
> The rest of `docs/DATA_MODEL.md` (§1 Scope, §2 Core Tables, §3 Full Table Schemas — 43k chars)
> stays on demand: it is derivable from `backend-ts/src/stores/postgres/schema-pg.ts` and the
> SQLite floor `schema.ts`. Read it when touching schema; do not duplicate it here.
>
> Edit this file, not a copy in `DATA_MODEL.md` — §4–6 there now point here.

## 4) Idempotency Contract for Case Upsert
Constraint: `UNIQUE(employee_id, measure_version_id, evaluation_period)`.

### Worked Example
Inputs:
- employee: `emp-006`
- measure version: Audiogram `v1.0`
- evaluation period: `2026-05-06`

Run A outcome: `OVERDUE`
- No existing row -> insert new `cases` row (`status=OPEN`, `priority=HIGH`).

Run B outcome (same key): `OVERDUE`
- Conflict on unique key -> update same row (`updated_at`, `last_run_id`, `next_action`, etc.).
- No duplicate case created.

Run C outcome (same key): `COMPLIANT`
- Existing row is resolved (`status=RESOLVED`, `closed_at=NOW()`, `closed_reason='AUTO_RESOLVED'`,
  `closed_by=NULL` — a **system** closure).

### State-aware upsert (Fable H1/H2, 2026-07-02)
`upsertFromOutcome` is no longer a blanket `ON CONFLICT DO UPDATE SET status = excluded.status`. Both the
SQLite floor and the Pg ceiling read the current row and apply the shared pure `planCaseUpsert`
(`backend-ts/src/case/case-logic.ts`):
- **IN_PROGRESS is preserved** on a still-non-compliant run (an operator's "scheduling" state is never
  clobbered back to OPEN).
- **Human closures are respected.** A case a person closed (`closed_by` set) is **not** reopened by a
  later non-compliant run; only a **system** closure (`closed_by IS NULL`) reopens — either a prior
  auto-resolve (status `RESOLVED`) or an auto-exclusion (status `EXCLUDED`) whose waiver has since
  lapsed so CQL no longer returns EXCLUDED (Codex P2). Reopening a human-closed case is left an
  explicit, audited operator action.
- **Active-case counts include `IN_PROGRESS`.** Because the upsert now preserves `IN_PROGRESS` (rather
  than flipping it to OPEN), every "active/open case" rollup (`ACTIVE_CASE_STATUSES` = `OPEN` +
  `IN_PROGRESS`) counts both — otherwise a reconfirmed IN_PROGRESS case would silently drop out of the
  hierarchy/programs open-case count (Codex P2).
- **No `closed_at` drift.** A COMPLIANT outcome on an already-terminal case is a no-op.
- The upsert returns an `UpsertedCase` (a `CaseRecord` superset carrying a `disposition` of
  `CREATED | UPDATED | REOPENED | RESOLVED | EXCLUDED | UNCHANGED`). The run pipeline emits a matching
  `CASE_*` audit event for every disposition except `UNCHANGED` (an idempotent re-confirm of the same open
  outcome — refreshed silently, so a nightly run records one `RUN_COMPLETED`, not hundreds of noise
  events). Population runs previously wrote **no** case/run audit events at all — the H1 hard-rule fix.
  The per-case audit is **best-effort at the run boundary** (Codex P1): it is written after the upsert
  (the disposition is only known post-mutation), and a transient `audit_events` failure is caught and
  logged as a run `WARN` rather than aborting the run — so an otherwise-complete run still finalizes
  instead of being left stuck RUNNING / marked FAILED after the case was already mutated (mirrors the
  `RUN_COMPLETED` best-effort write).

### Resolution is not segment-gated; cycle rollover is closed out (Fable M10/M11, 2026-07-03)
- **Resolution is never blocked by segment applicability (M11 / Codex P2).** The run pipeline gates case
  *creation* by `isApplicable`, but two **close-only** bypasses run the upsert even out-of-cohort so a
  subject who left a cohort still has their open case resolved: (1) **COMPLIANT** — a `planCaseUpsert` no-op
  when no case exists, so always safe; (2) **EXCLUDED** — but only when an active case already exists for
  that `(subject, measure, period)` (a run-start snapshot of active cases keys this check), so a fresh
  waiver excuses an existing open case. EXCLUDED with *no* existing case stays applicability-gated (it would
  otherwise *insert* a new EXCLUDED case, re-polluting the excluded lists the gate keeps clear). Every
  non-compliant (case-creating) outcome stays gated.
- **Strictly-older-cycle cases are closed out at run finish (M10).** After a population run's evaluation
  loop, any OPEN/`IN_PROGRESS` case for a `(subject, measure)` the run evaluated whose `evaluation_period`
  is **strictly older** than the run's own compliance cycle is closed with `status='RESOLVED'`,
  `closed_reason='CYCLE_ROLLED_OVER'`, `closed_by=NULL` (a **system** closure), and an audited
  `CASE_RESOLVED` event. Comparing cycle *order* (not mere inequality) means a backdated/historical rerun
  never resolves today's actionable case (Codex P2). This prevents a cycle rollover from orphaning the prior
  period's OPEN case (surfaced by `?status=open`, campaigns with no period filter, CSV exports, MCP
  `list_noncompliant`) — the `backend-ts` equivalent of the Java V022 migration. Best-effort (a read/audit
  failure logs a WARN, never aborts the run); scoped to the subjects the run actually evaluated (a
  SITE/EMPLOYEE run never touches out-of-scope cases). Display/routing only — CQL `Outcome Status` stays
  authoritative (ADR-008).

## 5) `evidence_json` Contract (authoritative)

### Canonical shape
```json
{
  "expressionResults": [
    { "define": "In Hearing Conservation Program", "result": true },
    { "define": "Has Active Waiver", "result": false },
    { "define": "Most Recent Audiogram Date", "result": "2025-03-10T00:00:00Z" },
    { "define": "Days Since Last Audiogram", "result": 420 },
    { "define": "Outcome Status", "result": "OVERDUE" }
  ],
  "evaluatedResource": {
    "patientId": "emp-006",
    "measureId": "audiogram",
    "measurementPeriod": {
      "start": "2025-05-06T00:00:00Z",
      "end": "2026-05-06T00:00:00Z"
    }
  },
  "why_flagged": {
    "last_exam_date": "2025-03-10",
    "compliance_window_days": 365,
    "days_overdue": 55,
    "role_eligible": true,
    "site_eligible": true,
    "waiver_status": "NONE",
    "outcome_status": "OVERDUE"
  }
}
```

### Field-by-field meaning
- `expressionResults`: raw define outputs from the CQL engine used for traceability.
- `evaluatedResource`: resource-level context used during evaluation.
- `why_flagged`: derived/explainer fields used by UI for readable case diagnostics.

> **`why_flagged` is DERIVED AT READ TIME, not persisted (#463).** In the TypeScript backend the
> persisted `evidence_json` carries **`expressionResults`** — plus **`official`** when the measure is
> official-routed (load-bearing: MeasureReport/QRDA read `evidence_json.official.populationResults`,
> ADR-031/046), and `evaluationError`/`message` on failure
> (`backend-ts/packages/measure-engine/src/evaluate-measure.ts`). `why_flagged` is computed on read
> by `deriveWhyFlagged` (`backend-ts/src/case/case-detail-read-model.ts`) from the expression results
> and measure config. The `evaluatedResource` block in the canonical example above is **Java-era**:
> it is neither persisted nor derived on any TS surface today. The canonical shape shows the
> *logical* contract a consumer sees on read surfaces (case detail, exports, MCP tools), not the
> stored bytes; the section predates the re-platform (ADR-008).

If evaluation fails for one employee, `evidence_json` includes:
```json
{ "evaluationError": "CQL engine failure", "message": "<error text>" }
```
with status forced to `MISSING_DATA`.

## 6) CSV Export Contracts

### 6.1 `GET /api/exports/runs?format=csv`
Columns:
`runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf`

### 6.2 `GET /api/exports/outcomes?format=csv&runId={optional}`
Columns:
`outcomeId, runId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, lastExamDate, complianceWindowDays, daysOverdue, roleEligible, siteEligible, waiverStatus, evaluatedAt`

### 6.3 `GET /api/exports/cases?format=csv`
Columns:
`caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus`

Supports filters: `status`, `measureId`, `priority`, `assignee`, `site`, `caseIds`.

### 6.4 `GET /api/audit-events/export?format=csv`
Audit event export is append-only and includes event metadata + payload snapshot for timeline reconstruction.
