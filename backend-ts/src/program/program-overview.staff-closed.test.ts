/**
 * `staffClosedGapCount` (#569) — the number that reconciles the Overdue chip with the open-case count.
 *
 * The contradiction it closes: a patient an operator marked resolved stays in the Overdue bucket
 * (outcome-derived, so CQL's answer) and drops out of `openCaseCount` (ACTIVE cases only). Both
 * figures were right and they disagreed, with nothing on the page accounting for the difference.
 *
 * Two properties beyond the count itself: it is computed OUTSIDE the winner-keyed memo (it reads a
 * mutable table, so a memoized value would go stale the moment somebody closed a case), and it
 * applies exactly the predicates `openCaseCount` applies — both now call one builder, because a copy
 * that forgot `inPeriod` would put a chip beside a tab whose total it does not describe.
 *
 * node --import tsx --test src/program/program-overview.staff-closed.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeRecord, OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseQuery, CaseRecord, CaseStore } from "../stores/case-store.ts";
import { programOverview, __overviewMemo, __chartMemos } from "./program-read-models.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import { bucketPeriodForMeasure } from "../run/compliance-period.ts";

const MEASURE = "cms122";
const RUN = "run-1";
const AT = "2026-09-01T00:00:00.000Z";
const TODAY = new Date().toISOString().slice(0, 10);
const CYCLE = bucketPeriodForMeasure(MEASURE, TODAY);

const row = (subjectId: string, status: string): OutcomeWithRun => ({
  runId: RUN, runStartedAt: AT, runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED",
  runTriggeredBy: "manual", subjectId, measureId: MEASURE, status,
});
const winRow = (subjectId: string, status: string): OutcomeRecord => ({
  id: `o-${subjectId}`, runId: RUN, subjectId, measureId: MEASURE, evaluationPeriod: CYCLE, status,
  evidence: { expressionResults: [{ define: "Outcome Status", result: status }] }, evaluatedAt: AT,
});

/** Four patients: two the run still counts, one it now finds compliant, one it never evaluated. */
const ROWS = [row("emp-006", "OVERDUE"), row("emp-007", "OVERDUE"), row("emp-008", "COMPLIANT"), row("emp-009", "OVERDUE")];
const WIN_ROWS = [winRow("emp-006", "OVERDUE"), winRow("emp-007", "OVERDUE"), winRow("emp-008", "COMPLIANT")];

const caseRow = (over: Partial<CaseRecord> & { employeeId: string }): CaseRecord => ({
  id: `case-${over.employeeId}`,
  measureId: MEASURE,
  evaluationPeriod: CYCLE,
  status: "CLOSED",
  priority: "HIGH",
  assignee: null,
  nextAction: null,
  nextActionSource: "OPERATOR",
  assignmentSource: null,
  currentOutcomeStatus: "OVERDUE",
  lastRunId: RUN,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  closedAt: "2026-09-02T00:00:00.000Z",
  closedReason: "MANUAL_RESOLVE",
  closedBy: "nurse@example.org",
  ...over,
});

function makeDeps(caseRows: CaseRecord[], onQuery?: (q: CaseQuery) => void) {
  return {
    outcomeStore: {
      listOutcomesWithRun: async () => ROWS,
      listLatestPopulationRuns: latestRunsFromRows(ROWS),
      listOutcomes: async (runId: string, opts?: { measureId?: string; subjectIds?: readonly string[] }) => {
        let rows = runId === RUN ? WIN_ROWS : [];
        if (opts?.measureId != null) rows = rows.filter((o) => o.measureId === opts.measureId);
        if (opts?.subjectIds !== undefined) {
          const wanted = new Set(opts.subjectIds);
          rows = rows.filter((o) => wanted.has(o.subjectId));
        }
        return rows;
      },
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: { listRuns: async () => [] } as unknown as RunStore,
    caseStore: {
      listCases: async (query: CaseQuery) => {
        onQuery?.(query);
        // Honour the predicates the read model relies on, so a missing filter cannot pass here.
        let out = caseRows;
        if (query.closure) {
          out = out.filter((c) => {
            const terminal = !["OPEN", "IN_PROGRESS"].includes(c.status);
            return terminal && (query.closure === "staff" ? c.closedBy != null : c.closedBy == null);
          });
        }
        if (query.statuses?.length) out = out.filter((c) => query.statuses!.includes(c.status));
        return out;
      },
    } as unknown as CaseStore,
  };
}

const reset = () => {
  __overviewMemo.clear();
  for (const memo of Object.values(__chartMemos)) memo.clear();
};
const only = async (caseRows: CaseRecord[], onQuery?: (q: CaseQuery) => void) =>
  (await programOverview(makeDeps(caseRows, onQuery), {})).find((p) => p.measureId === MEASURE)!;

test("staffClosedGapCount counts only the closures a PERSON made this cycle that CQL still counts", async () => {
  reset();
  const queries: CaseQuery[] = [];
  const summary = await only(
    [
      // Counted: a person closed it, this cycle, and the winning run still says OVERDUE.
      caseRow({ employeeId: "emp-006" }),
      // Not counted: rerun-verified, and the run agrees it is compliant. Saying "still counted by
      // CQL" about this patient would be false.
      caseRow({ employeeId: "emp-008", status: "RESOLVED", closedReason: "RERUN_VERIFIED", closedBy: "cm@workwell.dev", currentOutcomeStatus: "COMPLIANT" }),
      // Not counted: the run never evaluated them, so nothing can claim they are a gap today.
      caseRow({ employeeId: "emp-009" }),
      // Not counted: the run closed it, not a person.
      caseRow({ employeeId: "emp-010", status: "RESOLVED", closedReason: "AUTO_RESOLVED", closedBy: null }),
      // Not counted: a person's closure from a PRIOR cycle — a prior cycle's gap, and this cycle
      // opened a new case.
      caseRow({ employeeId: "emp-011", evaluationPeriod: "2019-01-01" }),
      // Still ACTIVE: this is `openCaseCount`'s row, and it must not appear in both numbers.
      caseRow({ employeeId: "emp-007", status: "OPEN", closedAt: null, closedReason: null, closedBy: null }),
    ],
    (q) => queries.push(q),
  );

  assert.equal(summary.staffClosedGapCount, 1, "emp-006 only");
  assert.equal(summary.openCaseCount, 1, "emp-007 only — the two numbers never count the same row");
  // The buckets are outcome-derived and UNCHANGED: the patient a person closed is still Overdue here,
  // which is the disagreement this count explains rather than hides.
  assert.equal(summary.overdue, 3);
  assert.equal(summary.compliant, 1);
  assert.equal(summary.complianceRate, 25, "and neither rate moved");

  // The classification is asked of the STORE (`closure: "staff"`), not filtered in JS afterwards.
  assert.ok(queries.some((q) => q.closure === "staff"), "one query asks for the closures a person made");
  assert.ok(queries.some((q) => q.statuses?.includes("OPEN")), "and the active read is unchanged");
});

test("staffClosedGapCount is computed OUTSIDE the memo — closing a case changes it while the same run wins", async () => {
  reset();
  const before = await only([caseRow({ employeeId: "emp-007", status: "OPEN", closedAt: null, closedReason: null, closedBy: null })]);
  assert.equal(before.staffClosedGapCount, 0);
  assert.equal(before.openCaseCount, 1);

  // Same winning run, same buckets (so the memo hits), but somebody has now closed the case. A
  // memoized staff-closed count would still say 0 — the stale-number defect the memo boundary exists
  // to prevent, and the reason `openCaseCount` is already read per request.
  const after = await only([caseRow({ employeeId: "emp-007" })]);
  assert.equal(after.staffClosedGapCount, 1, "the closure is visible immediately");
  assert.equal(after.openCaseCount, 0, "and the case has left the active count");
  assert.equal(after.overdue, before.overdue, "the memoized outcome buckets are untouched");
});

test("staffClosedGapCount applies the same site filter as openCaseCount", async () => {
  reset();
  // emp-006 and emp-007 are in the directory; a site that matches neither must zero BOTH counts,
  // which is the shared-predicate claim. A copy that dropped the site test would report 1 here.
  const rows = [caseRow({ employeeId: "emp-006" }), caseRow({ employeeId: "emp-007", status: "OPEN", closedAt: null, closedReason: null, closedBy: null })];
  const unfiltered = (await programOverview(makeDeps(rows), {})).find((p) => p.measureId === MEASURE)!;
  assert.equal(unfiltered.staffClosedGapCount, 1);
  assert.equal(unfiltered.openCaseCount, 1);

  reset();
  const elsewhere = (await programOverview(makeDeps(rows), { site: "Nowhere" })).find((p) => p.measureId === MEASURE)!;
  assert.equal(elsewhere.staffClosedGapCount, 0, "a site nobody is at zeroes the staff-closed count");
  assert.equal(elsewhere.openCaseCount, 0, "exactly as it zeroes the open count");
});

test("the chip is answered from the run THIS CARD reports, not from a winner resolved again", async () => {
  reset();
  // A scoped overview (a site or tenant filter) can settle on an older visible run than the newest
  // global winner — `latestPopulationSnapshot`'s visibility fallback, which fires when the newest
  // population run wrote no rows anyone on this page can see. The card's `overdue` and `missingData`
  // then describe that older run. A chip that resolved winners again, without the overview's
  // filters, would reconcile against numbers nobody on the page can see — the same "one patient,
  // two numbers, no explanation" contradiction this count exists to remove, one level up.
  //
  // The fixture drives that fallback for real rather than imitating it: the newest run wrote one row,
  // for a patient at Plant B, and the overview is filtered to Plant A — so the card falls back to
  // `run-1`, and the two runs disagree about the patient whose case a person closed.
  const NEWER = "run-2";
  const NEWER_AT = "2026-09-20T00:00:00.000Z";
  const asked: string[] = [];
  // Plant B, so the site filter hides it and the winner blanks — exactly the fallback's trigger.
  const newerRow: OutcomeWithRun = { ...row("emp-011", "OVERDUE"), runId: NEWER, runStartedAt: NEWER_AT };
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async (filter?: { runIds?: readonly string[] }) =>
        // The winners read is by run id; the fallback's history read is not, and sees both runs.
        (filter?.runIds?.length ? [newerRow] : [newerRow, row("emp-006", "OVERDUE")]),
      listLatestPopulationRuns: async () => [{
        runId: NEWER, runStartedAt: NEWER_AT, runScopeType: "ALL_PROGRAMS",
        runStatus: "COMPLETED", runTriggeredBy: "manual", measureId: MEASURE,
      }],
      listOutcomes: async (runId: string) => {
        asked.push(runId);
        // `run-1` — the run this card reports — still counts the patient; the newer one says they
        // became compliant. Reading the wrong one silently answers about a run nobody can see.
        return runId === NEWER
          ? [{ ...winRow("emp-006", "COMPLIANT"), id: "o-new", runId: NEWER }]
          : [winRow("emp-006", "OVERDUE")];
      },
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: { listRuns: async () => [] } as unknown as RunStore,
    caseStore: { listCases: async (q: CaseQuery) => (q.closure === "staff" ? [caseRow({ employeeId: "emp-006" })] : []) } as unknown as CaseStore,
  };

  const summary = (await programOverview(deps, { site: "Plant A" })).find((p) => p.measureId === MEASURE)!;

  assert.equal(summary.latestRunId, RUN, "the card reports the run its buckets came from");
  assert.equal(summary.overdue, 1, "and that run still counts the patient");
  assert.equal(summary.staffClosedGapCount, 1, "so the chip does too — it reconciles with the number beside it");
  assert.ok(!asked.includes(NEWER), `the newer run is never read for this card: ${asked.join(",") || "(no read)"}`);
});

test("a run that describes ANOTHER cycle says nothing about this cycle's closures", async () => {
  reset();
  // The card's run and the case can disagree about the measurement year — the run this measure last
  // completed may predate the cycle the case belongs to. Its OVERDUE is a statement about 2019, and
  // counting it as "still counted by CQL" today would put a number on the chip that no run supports.
  // The same equality the work list and the cases CSV apply, through the same helper.
  const stale = { ...winRow("emp-006", "OVERDUE"), evaluationPeriod: "2019-01-01" };
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => [row("emp-006", "OVERDUE")],
      listLatestPopulationRuns: latestRunsFromRows([row("emp-006", "OVERDUE")]),
      listOutcomes: async () => [stale],
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: { listRuns: async () => [] } as unknown as RunStore,
    caseStore: { listCases: async (q: CaseQuery) => (q.closure === "staff" ? [caseRow({ employeeId: "emp-006" })] : []) } as unknown as CaseStore,
  };

  const summary = (await programOverview(deps, {})).find((p) => p.measureId === MEASURE)!;
  assert.equal(summary.staffClosedGapCount, 0, "not a gap this cycle — the run answering is about another year");
  assert.equal(summary.overdue, 1, "the bucket is unchanged: it reports what the run wrote");
});
