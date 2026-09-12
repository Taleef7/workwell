# DATA_MODEL — Contracts (always-loaded extract)

> **Authoritative.** These three contracts are extracted from `docs/DATA_MODEL.md` so they can be
> `@`-imported into every session — the Definition of Done makes idempotency + audit invariants
> mandatory on every PR, so they are load-bearing on every change.
>
> The rest of `docs/DATA_MODEL.md` (§1 Scope, §2 Core Tables, §3 Full Table Schemas) stays on demand:
> it is derivable from `backend-ts/src/stores/postgres/schema-pg.ts` and the SQLite floor `schema.ts`.
> Read it when touching schema; do not duplicate it here.
>
> Edit this file, not a copy in `DATA_MODEL.md` — §4–6 there point here. Section numbers are cited from
> source comments (§4, §5, §6.2, §6.3) and stay fixed.

## 4) Idempotency Contract for Case Upsert
Constraint: `UNIQUE(employee_id, measure_version_id, evaluation_period)`.

- A non-compliant outcome with no existing row inserts a new `cases` row (`status=OPEN`, priority from the outcome).
- The same key on a later run updates the same row (`updated_at`, `last_run_id`, `next_action`, …). No duplicate case is ever created.
- A `COMPLIANT` outcome on the same key resolves the row (`status=RESOLVED`, `closed_at=NOW()`,
  `closed_reason='AUTO_RESOLVED'`, `closed_by=NULL` — a **system** closure).

### State-aware upsert
`upsertFromOutcome` is not a blanket `ON CONFLICT DO UPDATE SET status = excluded.status`. Both the
SQLite floor and the Pg ceiling read the current row and apply the shared pure `planCaseUpsert`
(`backend-ts/src/case/case-logic.ts`):
- **IN_PROGRESS is preserved** on a still-non-compliant run (an operator's "scheduling" state is never
  clobbered back to OPEN).
- **Human closures are respected.** A case a person closed (`closed_by` set) is **not** reopened by a
  later non-compliant run; only a **system** closure (`closed_by IS NULL`) reopens — either a prior
  auto-resolve (status `RESOLVED`) or an auto-exclusion (status `EXCLUDED`) whose waiver has since
  lapsed so CQL no longer returns EXCLUDED. Reopening a human-closed case is left an explicit, audited
  operator action.
- **So do the open-case READERS, and that had to be propagated (MM-2).** The work list, its CSV export
  (`?status=open`) and the MCP `list_cases`/`list_noncompliant` tools each mapped "open" to `["OPEN"]`
  alone. A case an operator had started was therefore visible on the screen and absent from the CSV
  taken off that screen, and absent from the tool serving the same list to a client — a row missing
  from an export is missing without anyone being told. All four now use `ACTIVE_CASE_STATUSES`.
  **Two readers still scope to `OPEN` only and are left alone deliberately**: outreach-campaign
  targeting (`case/outreach-campaign.ts`) and the case attached to an MCP compliance answer
  (`mcp/tools.ts`). Both predate this and neither is the work list; whether a case someone has already
  picked up should also receive automated outreach is a question for the owner, not a silent widening.
- **Active-case counts include `IN_PROGRESS`.** Because the upsert preserves `IN_PROGRESS` (rather than
  flipping it to OPEN), every "active/open case" rollup (`ACTIVE_CASE_STATUSES` = `OPEN` +
  `IN_PROGRESS`) counts both — otherwise a reconfirmed IN_PROGRESS case would silently drop out of the
  hierarchy/programs open-case count.
- **No `closed_at` drift.** A COMPLIANT outcome on an already-terminal case is a no-op.
- **A subject OUTSIDE the initial population never opens a case (ADR-078).** The run pipeline sets
  `outOfPopulation` on the upsert from the executor's own `inInitialPopulation: false`; the outcome is
  still persisted as MISSING_DATA (CQL is authoritative), but `planCaseUpsert` returns a no-op where
  no case exists and closes an active one with `status=RESOLVED`, `closed_reason='OUT_OF_POPULATION'`,
  `closed_by=NULL` (a system closure, audited `CASE_RESOLVED`). In-population MISSING_DATA still opens
  a case. Before this, every non-diabetic opened a CMS122 case (ADR-043's recorded fan-out).
- The upsert returns an `UpsertedCase` (a `CaseRecord` superset carrying a `disposition` of
  `CREATED | UPDATED | REOPENED | RESOLVED | EXCLUDED | UNCHANGED`). The run pipeline emits a matching
  `CASE_*` audit event for every disposition except `UNCHANGED` (an idempotent re-confirm of the same open
  outcome — refreshed silently, so a nightly run records one `RUN_COMPLETED`, not hundreds of noise
  events). A re-confirm whose persisted `next_action` MOVED is `UPDATED`, not `UNCHANGED`: on a
  multi-rate measure the action names the rate the subject missed (ADR-074 d13), so the same OVERDUE
  can carry a new action, and that is a state change the pipeline audits — the `CASE_UPDATED` payload
  carries the new `nextAction`. The rule compares strings, so a change to a wording table
  (`OFFICIAL_DISPLAY`, the next-action overrides, the subject-term prose) re-audits every open case ONCE
  on the next run, and a legacy row whose `next_action` is NULL does so on first contact. Deliberate:
  the persisted row changed.
- **An OPERATOR's `next_action` is not overwritten by a run that learned nothing new** (ADR-076 d2).
  `cases.next_action_source` records who wrote it: `patchCase` is the operator surface (escalate,
  manual resolve, outreach) and marks `OPERATOR`; `upsertFromOutcome` marks `SYSTEM`. **Rerun-to-verify
  passes `SYSTEM` explicitly**, because the action it writes is `nextActionFor(...)` — the string a run
  would compute — and freezing that would pin a multi-rate case to the rate it missed the day it was
  reverified. Any caller computing an action the way a run does must say so the same way.
  While the outcome status is re-confirmed unchanged, an OPERATOR action stands and the disposition is
  `UNCHANGED` — the persisted row did not change, so there is no state change to audit. The moment the
  status moves, the computed action takes over and ownership reverts to `SYSTEM`, because an
  instruction written about being OVERDUE is stale once CQL says something else. Wording-table edits
  and a moved missed rate still reach every SYSTEM-owned case; the case page and roster cell show the
  missed rate either way, since they read the outcome's evidence rather than `next_action`. The per-case audit is **best-effort at the run boundary**: it is written after the upsert
  (the disposition is only known post-mutation), and a transient `audit_events` failure is caught and
  logged as a run `WARN` rather than aborting the run — so an otherwise-complete run still finalizes
  instead of being left stuck RUNNING / marked FAILED after the case was already mutated (mirrors the
  `RUN_COMPLETED` best-effort write).

### Resolution is not segment-gated; cycle rollover is closed out
- **Resolution is never blocked by segment applicability.** The run pipeline gates case *creation* by
  `isApplicable`, but two **close-only** bypasses run the upsert even out-of-cohort so a subject who
  left a cohort still has their open case resolved: (1) **COMPLIANT** — a `planCaseUpsert` no-op when no
  case exists, so always safe; (2) **EXCLUDED** — but only when an active case already exists for that
  `(subject, measure, period)` (a run-start snapshot of active cases keys this check), so a fresh waiver
  excuses an existing open case. EXCLUDED with *no* existing case stays applicability-gated (it would
  otherwise *insert* a new EXCLUDED case, re-polluting the excluded lists the gate keeps clear). Every
  non-compliant (case-creating) outcome stays gated.
- **Strictly-older-cycle cases are closed out at run finish.** After a population run's evaluation
  loop, any OPEN/`IN_PROGRESS` case for a `(subject, measure)` the run evaluated whose `evaluation_period`
  is **strictly older** than the run's own compliance cycle is closed with `status='RESOLVED'`,
  `closed_reason='CYCLE_ROLLED_OVER'`, `closed_by=NULL` (a **system** closure), and an audited
  `CASE_RESOLVED` event. Comparing cycle *order* (not mere inequality) means a backdated/historical rerun
  never resolves today's actionable case. This prevents a cycle rollover from orphaning the prior
  period's OPEN case (surfaced by `?status=open`, campaigns with no period filter, CSV exports, MCP
  `list_noncompliant`). Best-effort (a read/audit failure logs a WARN, never aborts the run); scoped to
  the subjects the run actually evaluated (a SITE/EMPLOYEE run never touches out-of-scope cases).
  Display/routing only — CQL `Outcome Status` stays authoritative (ADR-008).

## 5) `evidence_json` Contract (authoritative)

> **The run-level period and the outcome-level period are different things (ADR-072).** An officially
> routed measure is scored over the **calendar year** containing the evaluation date — recorded on the
> run row (`measurementPeriodStart`/`End`) and inside `evidence_json.official` — while an authored
> measure keeps its rolling registry window. A run mixing both keeps the authored behaviour rather than
> re-scoping half of itself, so `evidence_json.official.measurementPeriod` is the only place that states
> which year a given official outcome actually describes; do not infer it from the run row on a mixed run.

### Canonical shape (what a consumer sees on read surfaces)
```json
{
  "expressionResults": [
    { "define": "In Hearing Conservation Program", "result": true },
    { "define": "Has Active Waiver", "result": false },
    { "define": "Most Recent Audiogram Date", "result": "2025-03-10T00:00:00Z" },
    { "define": "Days Since Last Audiogram", "result": 420 },
    { "define": "Outcome Status", "result": "OVERDUE" }
  ],
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

- `expressionResults`: raw define outputs from the CQL engine used for traceability.
- `why_flagged`: derived/explainer fields used by UI for readable case diagnostics.

> **`why_flagged` is DERIVED AT READ TIME, not persisted (#463).** The persisted `evidence_json` carries
> **`expressionResults`** — plus **`official`** when the measure is official-routed (load-bearing:
> MeasureReport/QRDA read `evidence_json.official.populationResults`, ADR-031/046; a MULTI-RATE measure
> also carries `official.rates`, one population array per group, and a STRATIFIED one `official.strata`,
> one array per group of `{ id, code, result, appliesResult }` keyed by the artifact's
> `Measure.group.stratifier.id` — ADR-074; both absent for every single-rate, unstratified measure so
> their evidence is byte-identical. On an official outcome `expressionResults` is the POPULATION
> membership, named `official:<population>` for a single-rate measure and `official:<Rate label>:<population>`
> for a multi-rate one — every rate, under the reviewed `rateLabels` of its semantics entry (ADR-074 d13))
> and **`qrda1Import`** when the outcome arrived through the QRDA-I
> import path (ADR-051/056 — finalize refuses a run unless every outcome carries it). On an evaluation
> failure the normal evidence is **replaced** by `{ evaluationError, message }` with status forced to
> `MISSING_DATA` (`backend-ts/src/run/run-pipeline.ts`; the import path additionally retains its
> `qrda1Import` provenance). `why_flagged` is computed on read by `deriveWhyFlagged`
> (`backend-ts/src/case/case-detail-read-model.ts`) from the expression results and measure config.
> The canonical shape above is the *logical* contract a consumer sees on read surfaces (case detail,
> exports, MCP tools), not the stored bytes.

If evaluation fails for one subject, `evidence_json` includes:
```json
{ "evaluationError": "CQL engine failure", "message": "<error text>" }
```
with status forced to `MISSING_DATA`.

## 6) CSV Export Contracts

### 6.1 `GET /api/exports/runs?format=csv`
Columns:
`runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf, notInPopulation`

> **`notInPopulation` was APPENDED (ADR-079, 2026-09-10)**, never inserted, so a consumer reading by
> position keeps every column it had. It is the subset of `missingData` whose subjects the measure's
> own logic put OUTSIDE its initial population — 0 for an authored measure and for any run written
> before the `outcomes.out_of_population` column existed. `missingData` still counts every persisted
> MISSING_DATA row, and `passRate` is still `compliant / totalEvaluated`: both state what the RUN
> wrote. The rate that describes a POPULATION is the programs overview's, and that one drops these
> subjects from its denominator — which is what `notInPopulation` lets a reader reconcile.

### 6.2 `GET /api/exports/outcomes?format=csv&runId={optional}`
Supports filters: `runId`, `site`, `providerId`, `ageBand`, `sex`, `payer`.

Columns:
`outcomeId, runId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, lastExamDate, complianceWindowDays, daysOverdue, roleEligible, siteEligible, waiverStatus, evaluatedAt, providerId, payer`

### 6.3 `GET /api/exports/cases?format=csv`
Columns:
`caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus, providerId, payer`

Supports filters: `status`, `measureId`, `priority`, `assignee`, `site`, `caseIds`, `providerId`,
`ageBand`, `sex`, `payer`.

> **Subject headers follow the deployment profile.** On a patient deployment
> (`WORKWELL_INSTANCE=maui`, `DEPLOYMENT_PROFILE.subjectTerm === "patient"`) the two subject columns in
> §6.2 and §6.3 are named `patientExternalId` and `patientName`, and in §6.2 `lastExamDate` and
> `waiverStatus` are named `lastResultDate` and `exclusionStatus`; column order and every other header
> are unchanged, and the default profile keeps the names above byte-for-byte
> (`backend-ts/src/export/export-csv.ts`, `subjectHeaders`). The remaining occupational columns
> (`role`, `roleEligible`, `siteEligible`) are still emitted on a patient deployment; dropping them is a
> contract change deferred until the pilot's export needs are known.

> **`providerId` and `payer` were APPENDED to both CSVs (MM-2)**, never inserted, so a consumer
> reading by position keeps every column it had — the same rule ADR-079's `notInPopulation` followed.
> Both are DIRECTORY facts resolved at export time, so both are EMPTY on a deployment whose roster
> records none: the occupational directory has never carried a payer, and the live WebChart directory
> discards Coverage until #533's ingest work lands. `payer` is a Source of Payment Typology code, the
> same vocabulary the measures' `SDE Payer` reads.

> **The payer filter is a SET, and that is not cosmetic.** `?payer=` accepts a repeated parameter or a
> comma list (`?payer=1&payer=11` and `?payer=1,11` are the same query), matching a subject whose code
> equals ANY of them — OR within the filter, AND against the others. The typology is HIERARCHICAL:
> `1` is Medicare and `11` is its managed-care child (Medicare Advantage), which on the pilot corpus is
> 3,927 and 2,900 patients. A single-valued filter would let someone ask for Medicare, receive the
> smaller set, and never learn the rest were withheld under a heading claiming to contain them. The
> PREDICATE still compares exact codes — `1` never matches `11` — and grouping is something a caller
> opts into by selecting several; `payerCodesInGroup`
> (`backend-ts/src/engine/synthetic/payer-display.ts`) is what turns "Medicare" into the codes actually
> present in the directory. Unlike `ageBand` and `sex`, payer terminology is OPEN: any non-empty token
> is accepted and an unknown one matches nobody, because refusing it would mean refusing a real
> Coverage code our display table has not been taught.

> **The panel filters are DIRECTORY joins, not stored columns** (`compliance/subject-filters.ts`).
> `providerId` matches `EmployeeProfile.providerId` — the PCP's external id (`maui-prov-012`), never a
> display name. `ageBand` is one of `0-17 | 18-44 | 45-64 | 65+`, derived from `dateOfBirth` against
> today's **UTC** date at query time, so a row's band can change between two exports taken either side
> of a birthday. `sex` is `F | M` and matches nothing on a roster that records none (the occupational
> directory), rather than matching everyone. An unrecognised token for `ageBand` or `sex` is a **400**
> naming the accepted values — never a silently unfiltered export served under a heading that says
> "65+". The same filters apply to the roster, the cases route and the MCP `list_noncompliant` tool,
> through one predicate; column names and order are unchanged. **Whether ANY of them is active is
> also one question** (`hasActiveSubjectFilters`): each of those four surfaces used to carry its own
> copy of `providerId || ageBand || sex`, which silently skips the predicate for every filter added
> afterwards — a guard that reads as present and cannot fire.

### 6.4 `GET /api/audit-events/export?format=csv`
Audit event export is append-only and includes event metadata + payload snapshot for timeline reconstruction.

### 6.5 Outcome Retention Contract (ADR-073)

**Inert unless `WORKWELL_OUTCOME_RETENTION_DAYS` is set**, and unset means OFF. **Maui ships 400 days
since 2026-09-07** (ADR-076 d4), in the same commit as the Postgres keep-set index ADR-073 d1 required;
TWH and every other deployment leave it unset, so their history stays whole. 400 days keeps a full
measurement year plus a margin, and removes nothing on an instance younger than that. Where it is set,
one pass runs after each nightly recompute — after that run's quality snapshot, never before — and the
`OUTCOMES_COMPACTION_STARTED` intent event is written BEFORE the delete and the `OUTCOMES_COMPACTED`
completion event after it, so nothing is deleted without a ledger entry (ADR-073 d4).

**Never deleted, at any age (ADR-073, amended by ADR-077 d3):**
- the newest USABLE `outcomes` row per `(subject_id, measure_id, evaluation_period)` — from a
  COMPLETED or PARTIAL_FAILURE run and not an evaluation error — AND the newest row regardless. Two keep
  sets: a FAILED rerun or an engine failure never evicts the last finalized answer, and a key with no
  usable row still keeps its newest so no roster cell goes blank. Per PERIOD, so a closed measurement
  year's evidence is not swept away by the first run of the next one;
- every row of a run that is still QUEUED/RUNNING/REQUESTED — an in-flight run is never compacted;
- every row any case cites, matched on `(run_id, subject_id, measure_id)` — open or closed;
- every `runs` row and its counts — a compacted run still reports what it found.

**Deleted:** every other `outcomes` row with `evaluated_at` before the cutoff — the superseded
intermediate history. **The only deletion path is `compactOutcomes`**, which awaits the
`OUTCOMES_COMPACTION_STARTED` intent event before deleting; that event is the completeness evidence
below.

**What a consumer sees after the window.** §6.2's outcomes CSV for a run older than the window returns
the SURVIVING rows, not an error and not a padded set; the run-detail read model carries a
`retentionNotice` saying so, because a lower count would otherwise read as a smaller run.
**MeasureReport (every variant), QRDA I and QRDA III answer 409 `run_compacted`** for a run that
started before the furthest cutoff any compaction pass has applied (ADR-077 d2): a score computed over a keep set is a
different number wearing the run's identity, so none is built. The evidence for that refusal is the
intent event, never the run's own counts — `totalEvaluated` is a count of the surviving rows, so
comparing it with the surviving rows is circular. Long-run history is the quality-over-time snapshot
store, which compaction never touches. `evidence_json` for a deleted row is gone with it — a case's own
evidence is preserved by the `last_run_id` pin.
