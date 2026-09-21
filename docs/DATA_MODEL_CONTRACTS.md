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
  **Two consequences of that no-op are contract, not incidental (#569, ADR-083 d1).** First,
  `current_outcome_status` on a human-closed row is **FROZEN at closure** — the run never touches the
  row again, so the column states what the last run before the closure said and can be months stale.
  CQL's current answer for that `(subject, measure)` lives in `outcomes`, on the winning population
  run, and any surface claiming to show "what CQL says" about such a row must read it there
  (`compliance/live-cell.ts`, bounded point reads). Second, `closed_by` — never `status`, never
  `closed_reason` — is the discriminator for WHO closed a case, because it is the column this rule
  itself decides by: `closureKindOf` (`case/case-logic.ts`) reads it as `NONE` for an active case,
  `STAFF` for every closure a person made (a manual `MANUAL_RESOLVE` close writes status `CLOSED`, a
  rerun-to-verify writes `RESOLVED`/`EXCLUDED` — both are STAFF), and `SYSTEM` otherwise.
  `CaseQuery.closure` (`'staff' | 'system'`) is the store-side form and implements the WHOLE
  classification — terminal status AND who closed it — because `closed_by IS NULL` alone matches every
  OPEN row.
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
- **A case is CREATED on its provider's panel, and never re-owned afterwards (ADR-080 d2).**
  `UpsertCaseInput.panelAssignee` is applied on the **insert branch only**: the row is written with
  `assignee` set and `assignment_source='PANEL'`. The UPDATE branch never touches `assignee` or
  `assignment_source` — not on a re-confirm, and not on a REOPEN, because a reopen is within the same
  cycle and is therefore the same piece of work somebody may already be holding. A NEW cycle is an
  insert and picks up whatever the map says then. Absent ⇒ `NULL/NULL`, which is exactly the behaviour
  of every deployment with no panel mappings.
  **`cases.assignment_source` records WHO chose** — `PANEL`, `OPERATOR`, or NULL. `patchCase({assignee})`
  is the operator surface and writes `OPERATOR`; `assignCases(…, source)` takes it explicitly, and
  clearing an assignee clears the source with it. A NULL source on a row that HAS an assignee is read
  as operator-owned, so a panel backfill never moves work a person placed by hand. The rule that
  decides what a panel change may move is the pure `planPanelBackfill` (`case/panel-assignment.ts`):
  unowned cases, and every PANEL-sourced case — whoever it currently names, since a PANEL-sourced row
  belongs to whoever owns the panel now. Nothing else moves.
  **The compare-and-set guards BOTH columns the rule read.** `CaseAssignExpectation.expectedSource`
  carries the provenance the caller saw; without it an operator re-asserting the same assignee (which
  makes the row theirs) would be overwritten by a backfill that still matched on the assignee alone.
  A change of source alone is a real change, so an operator can claim a case the panel already placed.
  **`POST /api/cases/bulk-assign` takes TWO body shapes, and the second names no case at all**
  (MM-2, 2026-09-15). `{ assignee, caseIds[] }` is the work list's, where every row IS a case.
  `{ assignee, measureId, subjectIds[] }` is the measure roster's: a roster CELL is an outcome
  reference (`{ runId, outcomeId }`), not a case, so that page has no case id to send. The server
  resolves them — the ACTIVE case for each subject in that ONE measure, in a single bounded read —
  and everything after the resolution is the `caseIds` path unchanged: the same 500 cap, the same
  assignable-account check, the same compare-and-set, the same `case_actions` and audit rows, the
  same response shape. `measureId` is REQUIRED and single: a patient row spans every routed measure,
  so "assign these patients" without one would mean six different pieces of work. Sending both shapes
  at once is a 400 rather than a guess. A selection where nobody has an active case for that measure
  answers `assigned: 0` in the success shape — the operator ticked real rows and pressed a real
  button, and a caller must not parse two shapes to learn that nothing moved.
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

### The work list is READ two ways, and they must answer the same question (#561, ADR-084)

`/api/cases` takes ONE page and the exact total from a single statement (`CaseStore.listCasesPage`,
rows plus `COUNT(*) OVER ()`), where every active filter has a SQL form. **One statement covers every
page that has rows** — which is every page a client renders; an EMPTY page carries no window value and
pays a second bounded `COUNT(*)`, because empty is not the same as "total zero" (it is also every page
past the end of a non-empty set, and answering 0 there would tell a client on the last page that the
set had vanished). Only that second statement can disagree with its page under concurrent writes. The four predicates that moved
into SQL are the per-measure current cycle (`cycles` + `cyclesFallbackPeriod`), the frozen `outcome`,
whether the case has an `OUTREACH_SENT` action (`outreach`), and the created-at day window
(`createdFrom`/`createdTo`, UTC day, inclusive at both ends on both stores).

**Three filters stay in memory because the database cannot see what they filter on**: `site`, `search`
and a panel selection above `PANEL_PREFILTER_MAX_IDS`, all of which read the in-memory directory —
there is no patients table to join (ADR-075). The staff-closed list stays too, for a different reason:
its outcome filter reads what CQL says TODAY per row and its three header counts describe the whole
list, so it needs the full set by construction. Where any of these is active the uncapped pipeline runs
and the answer is identical, slower. `sqlPageBlockedBy` names WHICH one blocked, because a fast path
that silently stops being taken is indistinguishable from one that was never wired up.

**Both loaders remain in the code, so a conformance test runs them over one fixture** and requires
identical totals and identical page ids across every filter combination and several page positions,
with the SQL path asserted to have actually run. A predicate added to one and not the other is
otherwise a filter that applies to the dashboard badge and not to the export taken from the same
screen, and nothing would fail.

**On a scoped deployment profile the SQL path rests on an INVARIANT, and the invariant is checked.**
`profileMatch` hides any subject the directory does not hold and has no SQL form, so a total computed
in SQL is exact only while every case subject is in the directory. That holds on the pilot by
construction — a deterministic corpus, and an import that refuses identifiers outside its namespace
(ADR-082) — and is nonetheless established from the data (`CaseStore.distinctCaseSubjectIds`, bounded
by subjects rather than by cases), once per process and again after every run. A violation disables the
fast path with a log line rather than serving a total that counts people no page can show.

**`/api/worklist/patients` keeps the uncapped pipeline** — it groups every row — and is recorded as
measured performance debt, not as "later".

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

> §6.6 (the attributed list's report) and §6.7 (`?listId=` on the filtered surfaces) were APPENDED
> 2026-09-16 (ADR-082). Neither changes a column in §6.1–§6.5.

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
`caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus, providerId, payer, closedReason, closedBy, liveState, liveOutcomeStatus, liveOutcomeRunId`

Supports filters: `status`, `measureId`, `priority`, `assignee`, `site`, `caseIds`, `providerId`,
`ageBand`, `sex`, `payer`, `from`/`to`, `outcome`, `search`.

> **The last four were added 2026-09-20, and the reason is the contract.** This export is reached
> from the work list's own button with the filters that list is showing. The **button sent three** of
> the nine and the **endpoint understood six**, so a CSV taken from a list narrowed by a created-at
> window, an outcome or a search was a WIDER file than the screen it came from, under a heading that
> said otherwise, with no error to notice — the reporting-integrity half of the `?status=open` defect
> above. `from`/`to` are the
> `created_at` UTC-day window, inclusive at both ends, validated by the SAME predicate `/api/cases`
> uses (`routes/query-dates.ts`) so a malformed value is a 400 naming the parameter on both surfaces
> rather than a lexicographic filter on garbage. `outcome` is the frozen `current_outcome_status`,
> folded exactly as `/api/cases` folds it (upper-cased, separators to `_`), so `?outcome=due-soon`
> means the same thing on both. `search` is a directory join over subject name, measure name and
> subject id, applied with the work list's own predicate (`matchesCaseSearch`) rather than a second
> copy of the field list. **The screen builds ONE parameter set for the list, its paging and the
> export** (`caseFilterParams`, `cases/page.tsx`), and a frontend test compares the two query
> strings, so a filter added to one and not the other fails without the test being edited.
>
> `search` is NOT on `CaseQuery`: like `site`, it reads the in-memory directory, so it is applied
> after the store read and does not take the SQL fast path (§"The work list is READ two ways").
> **Because those filters run after the read, the export's candidate read is UNBOUNDED** — the same
> `Number.MAX_SAFE_INTEGER` the work list uses for them. It was `100000`, which truncated the
> candidate set before the predicate that decides which rows the caller asked for: above that a
> searched subject visible on screen would be missing from the file taken off it, possibly leaving a
> header-only CSV. A cap that only bites once a deployment outgrows it fails quietly and later, and
> it protected nothing the list is not already exposed to at the same scale on the same table.

> **`outcome` is the frozen column on every list EXCEPT the staff-closed one, where it is what CQL
> says today.** The work list resolves the live answer for staff closures and filters on THAT
> (§4: `current_outcome_status` froze when the person closed the case), so handing the same token to
> the store here omitted a row the screen showed and carried one it did not — and the carried row
> contradicted its own `liveOutcomeStatus` cell. On `?status=staff_closed` the token is therefore
> withheld from the store and applied after the live pass the export already runs for those rows, so
> it costs nothing extra; on every other list the frozen column IS live (a run refreshes an active
> row and wrote a system-closed one) and the SQL predicate stands. Both surfaces compare through one
> function, `shownStatusFor` → `liveOrFrozenStatus` (`case/worklist-read-model.ts`), which takes the
> **display** status and not the canonical bucket the `liveOutcomeStatus` column carries — an
> out-of-population row is canonical `MISSING_DATA` and displays as out-of-population, so the two
> select different rows.

> **This export applies NO period logic, and the open and staff-closed LISTS default to the current
> compliance cycle.** That difference is not expressible as a query parameter and is therefore the
> one width difference the filter parity above does not close: `?status=open` can show zero rows on
> screen while the CSV taken from that screen carries a prior-cycle case, and the staff-closed tab —
> whose three header counts describe the current cycle — exports every prior year's closures beside
> them. Stated rather than fixed: what the export SHOULD do about a cycle is an owner decision, filed
> as an issue, and the frontend parity test compares query strings so it cannot see a server-side
> default.

> **`closedReason`, `closedBy`, `liveState`, `liveOutcomeStatus` and `liveOutcomeRunId` were
> APPENDED (#569, ADR-083)**, never inserted, so a consumer reading by position keeps every column it had — the same
> rule `providerId`/`payer` and ADR-079's `notInPopulation` followed. The two `live*` columns are
> populated **only for rows a PERSON closed** (`closed_by` non-NULL) and are the empty string on every
> other row: an active row's `currentOutcomeStatus` IS live, and a system-closed row was closed by the
> run that wrote it. A staff-closed row whose subject the winning run never evaluated carries the word
> `UNKNOWN` rather than an empty cell, because empty means "not a staff closure" — "not evaluable" is
> its own answer and must not read as "no longer a gap". `currentOutcomeStatus` keeps its meaning
> exactly: what the last run that touched the row wrote, which for a staff-closed row is the value
> frozen at closure (§4). **`liveState` is `GAP | CLEAR | UNKNOWN` and is the RECONCILIATION column**:
> a consumer deriving "still a gap" from `liveOutcomeStatus` alone would apply the case-opening rule
> and count an out-of-population row (canonical `MISSING_DATA`) as a gap, which the programs chip, the
> staff-closed tab and the roster all do not — this column is the one those surfaces use.
>
> **The three `live*` columns describe the ROW's own cycle, or they say `UNKNOWN`.** A winning run
> describes the measurement year it scored, and this export applies no period filter at all (below),
> so it carries more prior-cycle closures than any other surface. A closure whose `evaluationPeriod`
> the winning run does not describe therefore reads `UNKNOWN`/`UNKNOWN` with the run id still filled —
> never that run's answer, which would report a 2026 result against a 2024 closure and look exactly
> like a correct one. The same equality governs the work list, the MCP tool and the roster overlay;
> all four apply it through one function, because a rule spelled out per surface is a rule one surface
> ends up without.
>
> **`?status=` accepts `staff_closed`** — every terminal case a person closed (`CLOSED`, `RESOLVED` or
> `EXCLUDED` with `closed_by` set). On this export it means ALL HISTORY: the export has no period
> logic and the filter list above carries none, so unlike the work list's own `staff_closed` view it
> is not scoped to the current compliance cycle. `status` is parsed by ONE function shared with the
> work list and the MCP tool (`worklistQueryFor`), which takes the caller's default for a BLANK token
> explicitly — this export's blank still means no status filter at all (every row), the work list's
> still means the ACTIVE set.

> **`latestOutreachDeliveryStatus` is resolved for the whole export in one pass, and the column is
> unchanged (2026-09-13).** It is still the `deliveryStatus` of the newest `OUTREACH_DELIVERY_UPDATED`
> / `OUTREACH_SENT` action, still empty where a case has none, and still in the same position. Only the
> READ changed: `CaseEventStore.latestOutreachDeliveryStatuses(caseIds)` answers for a set, because the
> per-case form issued one query per row — **~32,600 on the pilot** through a ten-connection pool — which
> answered 504 at 60 s and held every connection while it ran, so every other database-backed endpoint
> timed out for the minute the export took. A store contract test compares the batched answer with the
> per-case one case by case, including the case where the newest action carries no `deliveryStatus`
> (both return null, rather than an older status the case has moved on from).
>
> **This export applies no status filter, and the row count is the whole `cases` table** (corrected
> 2026-09-15). The pilot's 32,558 cases are 15,309 OPEN, 15,676 RESOLVED and 1,573 EXCLUDED; earlier
> notes said "~15,300", which is the OPEN count and so the count of what `?status=open` would return,
> not what this endpoint does. At the ceiling's `OUTREACH_STATUS_CHUNK = 10_000` the batched form is
> therefore **four** statements on the pilot, not two. Measured after the deploy: 7.7 s cold, 6.5 s
> warm for 10,654,867 bytes, and `/api/panels` stays at 0.26–0.68 s with three exports in flight.

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
> discards Coverage until the WebChart ingest work lands (**#591**; #533 closed 2026-09-08 with that half unshipped). `payer` is a Source of Payment Typology code, the
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

### 6.6 `GET /api/subject-lists/{id}/report?measurementYear=YYYY&format=csv` (ADR-082)

The ACO's attributed list, scored for one measurement year, with the patient-level evidence. Columns:

`listId, listRevision, generatedAt, rawIdentifier, patientExternalId, patientName, resolution,
rowStatus, measureId, ecqmId, measureVersion, runId, measurementPeriodStart, measurementPeriodEnd,
evaluatedAt, rate, initialPopulation, denominator, denominatorExclusion, denominatorException,
numerator, status, outOfPopulation, evaluationError, providerId, payer`

The two subject columns follow `subjectHeaders(DEPLOYMENT_PROFILE.subjectTerm)` exactly as §6.2/§6.3
do (the list above is the patient-deployment spelling; TWH emits `employeeExternalId`,
`employeeName`). **The header is pinned by a test**, because the ACO's tooling reads it by name and a
renamed or inserted column surfaces downstream as wrong numbers rather than as an error.

> **`measurementYear` is REQUIRED and has no default.** An officially routed run is scored over the
> calendar year containing its evaluation date (ADR-072), so "the latest numbers" would answer a
> PY2027 question with PY2028's first nightly the moment January arrives — and would look exactly like
> a correct answer. The run chosen per measure is the newest reportable whole-population run whose own
> **measurement period** is that year, selected through
> `RunStore.listPopulationRunsForPeriod` — never by when the run STARTED. A manual run takes an
> arbitrary `evaluationDate`, so a rerun-to-verify of a closed year begins in the following one and
> legitimately scores the closed one; a start-date filter drops it and the report then answers "no run
> for this year" with that run sitting in the table.

**Three row shapes, and the two non-evaluated ones are contract, not convenience.**
- `rowStatus=EVALUATED` — **one row per (measure, rate)**. A multi-rate measure (cms137) yields two
  rows for one patient, under the reviewed `rateLabels` of its semantics entry (ADR-074 d13).
- `rowStatus=MISSING_FROM_RUN` — a MATCHED member the selected run never evaluated. **One row per
  MEASURE, not per rate.** The patient, provider and payer columns are filled; every population,
  status and rate column is **the empty string — never `0` or `false`**, which a consumer would read
  as a scored result of zero rather than as an absence.
- `rowStatus=NOT_MATCHED` — a NOT_FOUND or AMBIGUOUS member. **Exactly ONE row**, after all evaluated
  rows, with every patient and measure column empty. One row per measure would multiply a single
  unresolved identifier by six and read as six separate failures.

**Every JSON count is recomputable from these rows**, and a test does it — including for a measure
with **no usable run**, which emits one `MISSING_FROM_RUN` row per matched member rather than an entry
with a count and no rows. A **compacted** measure is the one exception and claims nothing per subject:
no rows, and `missingFromRun: 0`, because ADR-077 refuses numbers built over rows that may be
incomplete and "how many of your patients did this measure miss?" is such a number.

The JSON summary states, per measure, two identities that hold for every entry whose
`compactionStatus` is not `compacted`:
`matchedSubjects = distinctSubjectsSeen + missingFromRun` and
`distinctSubjectsSeen = scoredSubjects + unmeasured + evaluationErrors + outOfPopulation`.

> **The four not-scored buckets are DISJOINT, and `unmeasured` here is narrower than the aggregator's.**
> `createRateAggregator.finish()` returns an `unmeasured` that is a SUPERSET of its own
> `evaluationErrors` (it starts the count at the error count), and `outcomes.out_of_population` is an
> independently persisted column that can be true on a row the aggregator also calls unmeasured — so
> deriving these by subtraction double-counts every error and can make `scoredSubjects` NEGATIVE. Each
> seen subject is classified into exactly one bucket, in this order: an **evaluation error** first (no
> engine spoke for the subject, so nothing else about it is known), then **out of population**, then
> **in no rate** for any other reason, and only what survives all three is **scored**. `unmeasured` in
> this report therefore means "in no rate for a reason other than an error or being out of
> population".
`missingFromRun` is reported BESIDE the rates and **never subtracted from a denominator** — a member
the run never saw is a gap in the evidence, not an exclusion, and folding them in would let a smaller
run produce a higher score. The score is `numerator / (denominator − denominatorExclusion −
denominatorException)`; `status=EXCLUDED` is the workflow vocabulary while the two `denominator*`
columns are the artifact's populations, and the ACO's word "exclusions" covers both, so both are
emitted separately rather than summed.

> **Compaction refuses PER MEASURE (ADR-077, ADR-082 d5).** A measure whose selected run predates a
> compaction cutoff is returned with `compactionStatus: "compacted"`, no rates and no rows, and is
> named in the JSON and in the `X-WorkWell-Compacted-Measures` response header (exposed through
> `config/cors.ts`); the other measures' complete numbers are served with HTTP 200. The whole request
> is **409 `run_compacted`** only when EVERY selected run is exposed. Exposure is checked before the
> reads and again after them, and every derived row is computed before anything is serialised — a
> streamed CSV cannot change its status after the first byte, so a pass starting mid-report yields a
> 409 or a complete file, never a truncated 200.

> **Text a person supplied is neutralised against spreadsheet formula injection.** `rawIdentifier`,
> the subject name and the rate label go through `csvTextCell` (`export/csv.ts`), which prefixes a
> leading `=`, `+`, `-`, `@`, tab or CR with an apostrophe. `csvCell` quotes correctly and does not
> defuse, and a CSV of somebody's uploaded identifiers must not become code when the ACO opens it.

### 6.7 `?listId=` on the filtered surfaces (ADR-082)

> **`?listId=` requires a CASE_MANAGER or ADMIN seat on every surface, enforced once in the worker.**
> Five of the six surfaces are otherwise AUTHENTICATED, so without it the CM/ADMIN gate on
> `/api/subject-lists/**` was a control that could not fire for the widest read: a VIEWER holding a
> list id could take the whole membership — names, provider, payer, per-measure status — out of
> `GET /api/exports/cases?format=csv&listId=…`, which is strictly more than the members endpoint the
> gate protects. The id is not a secret by construction: it is in the query string of every filtered
> screen, so it reaches shareable URLs, browser history and access logs. A request naming a list
> without that seat is **403** with `parameter: "listId"`; the same surfaces are unchanged for a
> VIEWER when no list is named.

`?listId=` restricts the roster, the cases route, the work list, both §6.2/§6.3 CSVs and the MCP
`list_noncompliant` tool to a list's MATCHED members. It is a **resolved membership, not a token the
predicate parses**: the parameter names an immutable list and the server turns it into subjects, so a
client can ask for a list but cannot spell a membership. An unknown id is a **404** on every surface
(`LIST_NOT_FOUND` on the MCP tool) — never an unfiltered answer under a heading naming the ACO's
population. A list none of whose identifiers resolved is an **active filter matching nobody**, not an
absent one.
