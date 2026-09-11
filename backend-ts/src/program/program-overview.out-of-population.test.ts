/**
 * A subject outside the measure's initial population is not missing data, and is not in the rate's
 * denominator (ADR-078 + ADR-079 + #546). On the pilot this was the WHOLE Missing Data column of all
 * six measures — `missingData` equalled `total − initialPopulation` to the row — and it reported
 * CMS125 at 18.0% for a population that scores 72.1%.
 *
 * Every surface reads the persisted `outOfPopulation` column, so the assertions below are also the
 * statement that the overview, the trend and top-drivers are on ONE basis.
 *   node --import tsx --test src/program/program-overview.out-of-population.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { programOverview, programTopDrivers, programTrend, __overviewMemo, __chartMemos } from "./program-read-models.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const MEASURE = "cms122";
const RUN = "run-1";
const AT = "2026-09-01T00:00:00.000Z";

const row = (subjectId: string, status: string, outOfPopulation?: boolean): OutcomeWithRun => ({
  runId: RUN,
  runStartedAt: AT,
  runScopeType: "ALL_PROGRAMS",
  runStatus: "COMPLETED",
  runTriggeredBy: "manual",
  subjectId,
  measureId: MEASURE,
  status,
  outOfPopulation,
});

/**
 * Two subjects the measure describes (one compliant, one overdue), and three it does not — all five
 * persisted the way ADR-078 persists them, the three as MISSING_DATA carrying the flag.
 */
const ROWS = [
  row("emp-006", "COMPLIANT", false),
  row("emp-007", "OVERDUE", false),
  row("emp-008", "MISSING_DATA", true),
  row("emp-009", "MISSING_DATA", true),
  row("emp-010", "MISSING_DATA", true),
];

const makeDeps = (rows: OutcomeWithRun[] = ROWS) => ({
  outcomeStore: {
    listOutcomesWithRun: async () => rows,
    listLatestPopulationRuns: latestRunsFromRows(rows),
    listOutcomes: async () => [],
    aggregateScaleRun: async () => [],
  } as unknown as OutcomeStore,
  runStore: { listRuns: async () => [] } as unknown as RunStore,
  caseStore: { listCases: async () => [] } as unknown as CaseStore,
});

const reset = () => {
  __overviewMemo.clear();
  for (const memo of Object.values(__chartMemos)) memo.clear();
};

const only = async (rows?: OutcomeWithRun[]) =>
  (await programOverview(makeDeps(rows), {})).find((p) => p.measureId === MEASURE)!;

test("out-of-population subjects leave missingData, get their own count, and leave the rate's denominator", async () => {
  reset();
  const summary = await only();

  assert.equal(summary.totalEvaluated, 5, "every row the run wrote is still reported");
  assert.equal(summary.notInPopulation, 3);
  assert.equal(summary.missingData, 0, "all three MISSING_DATA rows were out of population");
  assert.equal(summary.denominator, 2, "total − excluded − notInPopulation");
  // The whole point: 1/2, not 1/4.
  assert.equal(summary.complianceRate, 50);
});

test("an in-population MISSING_DATA subject is still missing data, and still counts against the rate", async () => {
  reset();
  const summary = await only([...ROWS, row("emp-011", "MISSING_DATA", false)]);

  assert.equal(summary.notInPopulation, 3);
  assert.equal(summary.missingData, 1, "the in-population one is real work and stays");
  assert.equal(summary.denominator, 3);
  assert.equal(summary.complianceRate, 33.3, "1 compliant of 3 the measure describes");
});

test("a run that never recorded the flag reads exactly as it did before ADR-079", async () => {
  reset();
  // `undefined` is what every row written before the column existed carries, and what an
  // un-backfilled deployment reads. It must not be guessed in either direction.
  const summary = await only(ROWS.map((r) => ({ ...r, outOfPopulation: undefined })));

  assert.equal(summary.notInPopulation, 0);
  assert.equal(summary.missingData, 3, "unrecorded stays MISSING_DATA — the pre-ADR-079 answer");
  assert.equal(summary.denominator, 5);
});

test("the flag is only honoured on a MISSING_DATA row, so a duplicate can never drive missingData negative", async () => {
  reset();
  // There is no UNIQUE on (run_id, subject_id, measure_id). A run that persisted one subject twice
  // under two statuses would otherwise subtract 2 from a MISSING_DATA count of 1.
  const summary = await only([...ROWS, row("emp-008", "COMPLIANT", true)]);

  assert.equal(summary.notInPopulation, 3, "the COMPLIANT duplicate is not counted out of population");
  assert.equal(summary.missingData, 0);
  assert.ok(summary.missingData >= 0 && summary.denominator >= 0);
});

test("top-drivers stops calling out-of-population subjects flagged work", async () => {
  reset();
  const drivers = await programTopDrivers(makeDeps(), MEASURE, {});
  const reasons = Object.fromEntries(drivers.byOutcomeReason.map((r) => [r.reason, r.count]));

  assert.equal(reasons["MISSING_DATA"], undefined, "no MISSING_DATA slice: all three were out of population");
  assert.equal(reasons["OVERDUE"], 1);
  assert.equal(drivers.byOutcomeReason.find((r) => r.reason === "OVERDUE")!.pct, 100, "the mix is over ACTIONABLE rows");
});

test("the trend point is on the SAME basis as the headline it sits under", async () => {
  reset();
  // The defect two reviewers caught in the first cut: a corrected headline above an uncorrected
  // sparkline, which the measure page rendered as a +54-point improvement that never happened.
  const summary = await only();
  reset();
  const trend = await programTrend(makeDeps(), MEASURE, {});

  assert.equal(trend.length, 1);
  assert.equal(trend[0]!.notInPopulation, 3);
  assert.equal(trend[0]!.missingData, 0);
  assert.equal(trend[0]!.denominator, 2);
  assert.equal(trend[0]!.complianceRate, summary.complianceRate, "one run, one rate — whichever surface reports it");
  assert.equal(trend[0]!.totalEvaluated, 5, "the point still reports every row the run wrote");
});
