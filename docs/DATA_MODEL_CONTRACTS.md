# DATA_MODEL — Contracts (always-loaded)

> **Authoritative**; mandatory on every PR. Bare paths are under `backend-ts/src/`. Schemas:
`stores/postgres/schema-pg.ts` (Pg ceiling), `stores/sqlite/schema.ts` (SQLite floor). § numbers are
cited from source; keep them. CSV columns are only APPENDED, never inserted.

## 4) Idempotency Contract for Case Upsert
Key `UNIQUE(employee_id, measure_id, evaluation_period)` (no version: a new year's logic opens no new key); never a duplicate case. Non-compliant,
no row: insert `OPEN` (priority from the outcome); later runs update that row. `COMPLIANT`: `RESOLVED`,
`closed_at=NOW()`, `closed_reason='AUTO_RESOLVED'`, `closed_by=NULL` (a system closure); a no-op on a
terminal case.

### State-aware upsert
`upsertFromOutcome` (both stores) applies the pure `planCaseUpsert` (`case/case-logic.ts`) to the current
row, never a blanket `ON CONFLICT` status overwrite.
- **IN_PROGRESS is preserved**; every open-case reader and count uses `ACTIVE_CASE_STATUSES`
(`OPEN`+`IN_PROGRESS`). Deliberately `OPEN`-only (widening is an owner call): outreach-campaign targeting
and the case on an MCP compliance answer.
- **A human closure (`closed_by` set) is never reopened or rewritten by a run** (an EXCLUDED outcome
leaves it too, #747); only a system closure (auto-`RESOLVED`,
or `EXCLUDED` whose waiver lapsed) reopens, and reopening a human one is an audited operator action. Its
`current_outcome_status` is FROZEN at closure; CQL's current answer is read from `outcomes` on the winning
run (`compliance/live-cell.ts`).
- **`closed_by` decides who closed**, never `status`/`closed_reason`: `closureKindOf` = `NONE` | `STAFF`
(any person's closure: `MANUAL_RESOLVE`->`CLOSED`, rerun-to-verify->`RESOLVED`/`EXCLUDED`) | `SYSTEM`.
`CaseQuery.closure` also requires a terminal status (`closed_by IS NULL` matches every OPEN row).
- **Out-of-population never opens a case (ADR-078):** the outcome persists as MISSING_DATA;
`planCaseUpsert` no-ops, or closes an active case `RESOLVED`, `closed_reason='OUT_OF_POPULATION'`,
`closed_by=NULL` (audited `CASE_RESOLVED`). In-population MISSING_DATA from a completed evaluation opens one.
- **A failed evaluation never changes a case.** An engine or batch error persists MISSING_DATA with
`evaluationError` and marks the run PARTIAL_FAILURE, but no case is opened, reopened, updated or rolled
over for that (subject, measure); the run logs a WARN with the count. A failed rerun-to-verify audits its
attempt as `CASE_RERUN_FAILED`, leaves the case as it was, and answers 500 `verification_failed` with the run id.
- **Dispositions** (`UpsertedCase`): `CREATED|UPDATED|REOPENED|RESOLVED|EXCLUDED|UNCHANGED`; each but
`UNCHANGED` emits its `CASE_*` event. A re-confirm whose persisted `next_action` string changed (new
missed rate, wording-table edit, NULL legacy value) is `UPDATED`, payload `nextAction`.
- **`next_action_source` (ADR-076 d2):** `patchCase` writes `OPERATOR`; `upsertFromOutcome` and
rerun-to-verify (any caller computing a run's action) write `SYSTEM`. An OPERATOR action stands while the
status is re-confirmed (`UNCHANGED`); a status change restores the computed action and `SYSTEM`.
- **Panel assignment on INSERT only (ADR-080 d2):** `UpsertCaseInput.panelAssignee` sets `assignee` +
`assignment_source='PANEL'` on insert; UPDATE/REOPEN never touch them. Source = `PANEL` | `OPERATOR`
(`patchCase({assignee})`, `assignCases(…, source)`) | NULL (with an assignee = operator-owned; cleared
with the assignee). No `panelAssignee` ⇒ `NULL/NULL`. `planPanelBackfill` moves only unowned and PANEL
cases; its compare-and-set checks assignee and `expectedSource`, and a change of source alone is a real
change (an operator can claim a case the panel placed).
- **`POST /api/cases/bulk-assign`:** `{ assignee, caseIds[] }` or `{ assignee, measureId, subjectIds[] }`,
resolved in one bounded read to each subject's ACTIVE case in that ONE measure, then the `caseIds` path
unchanged (500 cap included). `measureId` is required and single; both shapes = 400; nothing found =
`assigned: 0` in the success shape.

### Audit ordering (incomplete: see the missing primitive below)
- **New code audits BEFORE it mutates**; the ledger errs toward an over-claim, never a silent change.
`audit/audit-order.test.ts` holds it (the mutation fails; the event is still required); add new
audit-first paths there. `backend-ts/scripts/audit-order-sweep.py` lists every `await` before an audit
write; keep the list below in step with it in the SAME change.
- **Mutate-first exceptions:** the run-created case transition, import-driven finalize (`routes/runs.ts`),
`recover-stuck-runs`, `batch-evaluate-scale` — run-boundary best-effort (`WARN`), so a finished run is
never stranded. `dispatchOutreach` — the payload is `channel.send()`'s result; needs ADR-073 d4's
intent/completion pair (owner call). The three identity-link writes — `upsertLink` returns the existing id
on conflict (owner call). `backfill-scale`, `backfill-quality-history`, `backfill-trend-history` —
one-shot seeding. `resolve-valuesets` — build-time CLI. `rerunToVerify` — action audit-first,
`CASE_RESOLVED` after the patch. `uploadEvidence` audits before the bucket write, so a failed upload can
leave an "Evidence uploaded" row on the case timeline (an owner question, `OPEN_QUESTIONS.md`).
- **The sweep reports 64 hits across 20 files (2026-10-08); check the count, not the labels.** The six
added since 2026-10-02 are all in `rerunToVerify`: #763 removed a local `const … = (` the matcher read as
a function start, so that function's earlier run writes now show against its `CASE_RERUN_FAILED` audit.
The code is unchanged; the old count was the undercount. The files
above account for 10; the other 10 are not violations: `panel-assignment` (mapping before consequences),
`segments` and `outcome-compaction` (matcher artifacts / the ADR-073 d4 completion event),
`subject-lists` (audit in `beforeComplete`), `evidence-service`, `audit-packet`, `materialize-run`,
`measure-seed` (reads or pure computation), `case-event-store-postgres` (the audit writer itself) and
`store-contract` (the test that drives them).
- **Missing primitive:** no cross-store `applyCaseAction({ patch, action, audit })` (`CaseEventStore` +
`CaseStore`), and no open issue tracks it (#598 was closed by a PR keyword on 2026-09-21; its remainder
was listed in #614, which was closed on 2026-09-23 as superseded by the milestone, and no milestone issue
carries the primitive). Until it exists, do not rely on the ledger being complete for
run-created transitions; a reconciliation job is no substitute.

### The work list is read two ways; both must agree (ADR-084)
`/api/cases` takes page + exact total in one statement (`CaseStore.listCasesPage`, `COUNT(*) OVER ()`)
when every filter has a SQL form (current cycle, frozen `outcome`, `outreach`, `createdFrom`/`createdTo`).
An EMPTY page carries no window value and takes a bounded second `COUNT(*)` — empty is not "total zero".
`site`, `search`, a panel above `PANEL_PREFILTER_MAX_IDS` (in-memory directory) and the staff-closed list
take the uncapped pipeline; `sqlPageBlockedBy` names the blocker. A conformance test requires identical
totals and page ids from both loaders. On a scoped profile `CaseStore.distinctCaseSubjectIds` checks every
case subject is in the directory; a violation disables the fast path.

### Resolution is not segment-gated; cycle rollover is closed out
- `isApplicable` gates creation only. Out-of-cohort close-only upserts: COMPLIANT, and EXCLUDED only where
an active case exists (run-start snapshot).
- After a population run, OPEN/`IN_PROGRESS` cases of an evaluated `(subject, measure)` in a strictly
OLDER cycle (order, not inequality) close `RESOLVED`, `closed_reason='CYCLE_ROLLED_OVER'`,
`closed_by=NULL`, audited `CASE_RESOLVED`; best-effort. CQL `Outcome Status` stays authoritative.

## 5) `evidence_json` Contract (authoritative)
Official measures score the evaluation date's calendar year, authored ones a rolling window; on a mixed
run only `evidence_json.official.measurementPeriod` names an official outcome's year (ADR-072).

### Canonical shape (read surfaces)
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
    "last_exam_date": "2025-03-10", "compliance_window_days": 365, "days_overdue": 55,
    "role_eligible": true, "site_eligible": true, "waiver_status": "NONE", "outcome_status": "OVERDUE"
  }
}
```
- `why_flagged` is **derived at read time** (`deriveWhyFlagged`, `case/case-detail-read-model.ts`), never
persisted. On an outcome with `official` evidence `compliance_window_days` is `null`: an official measure has
no single window (#650), so no screen, card, CSV or AI fallback states one.
- **Persisted:** `expressionResults` (raw defines; on an official outcome, population membership
`official:<population>` or multi-rate `official:<Rate label>:<population>`); `official` when
official-routed (`populationResults`, read by MeasureReport/QRDA; multi-rate adds `rates`, stratified adds
`strata` of `{ id, code, result, appliesResult }` keyed by `Measure.group.stratifier.id`, both otherwise
absent); `qrda1Import` on QRDA-I imports (finalize requires it on every outcome). An outcome scored by a
WorkWell translation (decision 3) adds `official.kind: "derived"`, `label`, `url` and `derivedFrom`, and its
`ecqmId` is `null`: read `kind` before falling back to any CMS identity. QRDA I/III refuse such a run
(422 `derived_logic_not_reportable`); a run whose evaluated rows were scored by more than one logic (CMS's
artifact, a translation, authored CQL) or period is refused by QRDA I/III and every MeasureReport type
(422 `mixed_logic`); an errored row counts as no logic.
- **Evaluation failure** replaces the evidence with `{ "evaluationError": "CQL engine failure",
"message": "<error text>" }` and forces `MISSING_DATA` (`run/run-pipeline.ts`); imports keep `qrda1Import`.

## 6) CSV Export Contracts

### 6.1 `GET /api/exports/runs?format=csv`
Filters `status`, `scopeType`, `triggerType`, `site`, `from`/`to`, `limit`: `/api/runs`'s
(`matchesRunFilters`). `from`/`to` = `startedAt` UTC day, malformed = 400. `limit` default 200, max
10,000, applied after filtering.

Columns:
`runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf, notInPopulation`

`notInPopulation` was appended, never inserted (ADR-079): the `missingData` subset outside the initial
population. `missingData` still counts every persisted MISSING_DATA row and `passRate` is still
`compliant / totalEvaluated`.

`measureVersion` (#769) is only what a run row can know, since it carries no evidence: an authored-only
measure's library version on a MEASURE/CASE run; empty for a measure with a CMS artifact (its rows may be
the artifact's, a translation's or authored CQL's; the run's reconciliation names them) and for every
multi-measure run. Never the catalog record's `v1.0`.

### 6.2 `GET /api/exports/outcomes?format=csv&runId={optional}`
Filters: `runId`, `site`, `providerId`, `ageBand`, `sex`, `payer`.

Columns:
`outcomeId, runId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, lastExamDate, complianceWindowDays, daysOverdue, roleEligible, siteEligible, waiverStatus, evaluatedAt, providerId, payer, executedLogic`

`complianceWindowDays` is empty on an official outcome (#650), as in `why_flagged`.

`executedLogic` was appended, never inserted (#769): the logic that scored the row, from its own
evidence (`scoringLogicOf`): `CMS125FHIR v1.0.000`, or `WorkWell translation of CMS137v15 (ww-2027.1)`
(§6.6's string plus the translation's version); empty for an authored or errored row. `measureVersion`
is the same row's (`measureVersionOf`): the artifact's or translation's own version, the authored
library's for an authored row, empty for an errored row; never the catalog record's `v1.0`.

### 6.3 `GET /api/exports/cases?format=csv`
Columns:
`caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus, providerId, payer, closedReason, closedBy, liveState, liveOutcomeStatus, liveOutcomeRunId, executedLogic`

Filters: `status`, `measureId`, `priority`, `assignee`, `site`, `caseIds`, `providerId`, `ageBand`,
`sex`, `payer`, `from`/`to`, `outcome`, `search`, `period`. **The export returns exactly the rows of the
work-list screen it came from** (one `caseFilterParams` set; tests compare query strings and result sets).
- `from`/`to`: `created_at` UTC day, inclusive, `/api/cases`'s validator (`routes/query-dates.ts`; 400).
- `outcome`: folded like `/api/cases`; the frozen `current_outcome_status`, except on `staff_closed`, where
it filters today's CQL answer. Both compare the display status, not the canonical bucket (`shownStatusFor`).
- `search` (`matchesCaseSearch`) and `site` (EXACT, `siteMatches`) filter the directory after an unbounded
store read.
- `period`: `current` = each measure's current cycle; any other value = a literal period; **blank = ALL
HISTORY here**, `current` on the work list (`wantsCurrentCycle`). Explicit `current` applies on every status.
- `status` (`worklistQueryFor`): blank = every row here and the ACTIVE set on the work list; `all` =
every row on both; `staff_closed` = terminal with `closed_by` set.
- `providerId`, `payer` were appended, never inserted (also §6.2): directory facts, empty where unrecorded
(WebChart Coverage: #591); `payer` is a Source of Payment Typology code.
- `closedReason`, `closedBy`, `liveState`, `liveOutcomeStatus`, `liveOutcomeRunId` were appended, never
inserted (ADR-083). `live*` only on person-closed rows (else empty); not evaluated = `UNKNOWN`; a winning
run describing another `evaluationPeriod` = `UNKNOWN`/`UNKNOWN`, run id filled. `liveState`
(`GAP|CLEAR|UNKNOWN`) is the reconciliation column (out-of-population is not a gap).
- `latestOutreachDeliveryStatus`: `deliveryStatus` of the newest `OUTREACH_DELIVERY_UPDATED`/`OUTREACH_SENT`
action (empty if none, never an older one), read in one batch.
- `executedLogic` was appended, never inserted, and `measureVersion` changed meaning in place (#769): both
describe the case's CITED outcome (`lastRunId`, subject, measure) as §6.2 does, read once per (run,
measure) for the exported rows (`scoringForCases`), never from today's routing; empty when that run holds
no row for the case. On a person-closed row they describe the frozen `currentOutcomeStatus`, not `live*`.

**Subject headers** (§6.2/§6.3, `subjectHeaders`): a patient deployment (`WORKWELL_INSTANCE=maui`,
`subjectTerm === "patient"`) names the subject columns `patientExternalId`/`patientName`, and in §6.2
`lastExamDate`/`waiverStatus` as `lastResultDate`/`exclusionStatus`; nothing else changes (`role`,
`roleEligible`, `siteEligible` stay).

**`payer` is a SET** (`?payer=1&payer=11` = `?payer=1,11`; OR within, AND across filters). Codes match
exactly (`1` never matches `11`); grouping is opt-in (`payerCodesInGroup`); an unknown code matches nobody.

**Panel filters are directory joins** (`compliance/subject-filters.ts`, one predicate on every surface;
`hasActiveSubjectFilters`): `providerId` = the PCP's external id; `ageBand` `0-17|18-44|45-64|65+` from
`dateOfBirth` vs today (UTC); `sex` `F|M`, matching nothing where unrecorded. A bad `ageBand`/`sex` is a
**400** naming the accepted values.

### 6.4 `GET /api/audit-events/export?format=csv`
Append-only: event metadata + payload snapshot.

### 6.5 Outcome Retention Contract (ADR-073)
Inert unless `WORKWELL_OUTCOME_RETENTION_DAYS` is set. Runs after each nightly recompute and its quality
snapshot; `compactOutcomes` is the only delete path, with `OUTCOMES_COMPACTION_STARTED` before the delete
and `OUTCOMES_COMPACTED` after.
**Never deleted (ADR-077 d3):** per `(subject_id, measure_id, evaluation_period)` the newest USABLE row
(COMPLETED/PARTIAL_FAILURE run, no evaluation error) AND the newest row; rows of QUEUED/RUNNING/REQUESTED
runs; rows any case cites (`run_id, subject_id, measure_id`); every `runs` row and its counts. Every other
row with `evaluated_at` before the cutoff is deleted.
§6.2 then returns the surviving rows (run detail shows a `retentionNotice`); MeasureReport, QRDA I and
QRDA III answer **409 `run_compacted`** for a run started before the furthest applied cutoff, judged by the
intent event, never the run's counts. The quality-over-time snapshot store is never compacted.

### 6.6 `GET /api/subject-lists/{id}/report?measurementYear=YYYY&format=csv` (ADR-082)
Columns (pinned by a test; subject pair per `subjectHeaders`, TWH `employeeExternalId`/`employeeName`):

`listId, listRevision, generatedAt, rawIdentifier, patientExternalId, patientName, resolution,
rowStatus, measureId, ecqmId, measureVersion, runId, measurementPeriodStart, measurementPeriodEnd,
evaluatedAt, rate, initialPopulation, denominator, denominatorExclusion, denominatorException,
numerator, status, outOfPopulation, evaluationError, providerId, payer, executedLogic`

- `measurementYear` is REQUIRED. Per measure: the newest reportable population run whose own measurement
period is that year (`RunStore.listPopulationRunsForPeriod`), never chosen by start date.
- `rowStatus`: `EVALUATED`, one row per (measure, rate); `MISSING_FROM_RUN`, a matched member the run never
evaluated, one row per measure, patient/provider/payer filled, population/status/rate columns empty
(never `0`/`false`); `NOT_MATCHED` (NOT_FOUND/AMBIGUOUS), exactly ONE row per unmatched member (never
one per measure), after all evaluated rows, patient and measure columns empty.
- Every JSON count is recomputable from the rows (no usable run = one `MISSING_FROM_RUN` per matched
member). Unless compacted: `matchedSubjects = distinctSubjectsSeen + missingFromRun`,
`distinctSubjectsSeen = scoredSubjects + unmeasured + evaluationErrors + outOfPopulation`; buckets are
disjoint, assigned in order error -> out of population -> no rate -> scored, never by subtraction.
- `missingFromRun` is never subtracted from a denominator. Score =
`numerator / (denominator − denominatorExclusion − denominatorException)`; the two `denominator*` columns
stay separate.
- Compaction refuses per measure: `compactionStatus: "compacted"`, no rows, `missingFromRun: 0`, named in
the CORS-exposed `X-WorkWell-Compacted-Measures`; **409 `run_compacted`** only when every run is exposed;
never a truncated 200.
- `rawIdentifier`, subject name and rate label pass through `csvTextCell` (defuses a leading `=`, `+`,
`-`, `@`, tab, CR).
- `ecqmId` is CMS-prefixed (`CMS137FHIR`, `ecqmIdOf`) since #769; it was the evidence's bare `137FHIR`.
- `executedLogic` was appended, never inserted: `CMS137FHIR v1.0.000` for CMS's artifact, a WorkWell
translation's label (its `ecqmId` empty) otherwise; filled wherever the measure columns are. A selected
run whose counted rows were scored by more than one logic answers **409 `mixed_logic`**, as a run mixing
periods answers 409 `period_mismatch`.

### 6.7 `?listId=` on the filtered surfaces (ADR-082)
Restricts the roster, cases route, work list, §6.2/§6.3 CSVs and MCP `list_noncompliant` to a list's
MATCHED members (server-resolved). Requires CASE_MANAGER/ADMIN on every surface (else **403**,
`parameter: "listId"`); unknown id = **404** (`LIST_NOT_FOUND` on MCP), never unfiltered; a list with no
resolved member matches nobody.
