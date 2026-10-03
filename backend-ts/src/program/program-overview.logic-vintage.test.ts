/**
 * The programs overview says when a measure's winning run scored a year its vendored artifact was not
 * written for: from 1 January 2027, PY2027 scored with the 2026 FHIR logic (ROADMAP MM-1d). The run log
 * already carries this as a WARN; the summary puts it beside the numbers.
 *
 * Decided from the RUN — it carried official evidence and scored a year — never from today's routing.
 *   node --import tsx --test src/program/program-overview.logic-vintage.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { logicVintageOf, programOverview, __overviewMemo, __chartMemos } from "./program-read-models.ts";
import { resetMeasureRateMemo } from "./measure-rate.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const MEASURE = "cms122";

const row = (runId: string, startedAt: string): OutcomeWithRun => ({
  runId,
  runStartedAt: startedAt,
  runScopeType: "ALL_PROGRAMS",
  runStatus: "COMPLETED",
  runTriggeredBy: "manual",
  subjectId: "emp-006",
  measureId: MEASURE,
  status: "COMPLIANT",
});

const OFFICIAL = { official: { populationResults: { ipp: true, denom: true, numer: false, denex: false, denexcep: false } } };

/** One winning run for cms122, scoring `year`, whose rows carry official evidence or not. */
const overviewFor = async (runId: string, year: number, official: boolean) => {
  __overviewMemo.clear();
  for (const memo of Object.values(__chartMemos)) memo.clear();
  resetMeasureRateMemo();
  const startedAt = `${year}-02-01T00:00:00.000Z`;
  const rows = [row(runId, startedAt)];
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => rows,
      listLatestPopulationRuns: latestRunsFromRows(rows),
      listOutcomes: async () => [],
      listOutcomeMembershipsForRun: async (_runId: string, measureId: string) =>
        measureId === MEASURE ? [{ status: "COMPLIANT", evidence: official ? OFFICIAL : { expressionResults: [] } }] : [],
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: {
      listRuns: async () => [],
      getRun: async (id: string) =>
        id === runId
          ? { id, measurementPeriodStart: `${year}-01-01T00:00:00.000Z`, measurementPeriodEnd: `${year}-12-31T23:59:59.999Z`, startedAt, requestedScope: {} }
          : null,
    } as unknown as RunStore,
    caseStore: { listCases: async () => [] } as unknown as CaseStore,
  };
  return (await programOverview(deps, {})).find((p) => p.measureId === MEASURE)!;
};

test("a 2027 run scored by the 2026 artifact carries the vintage note", async () => {
  const summary = await overviewFor("run-vintage-2027", 2027, true);
  assert.ok(summary.measureRate, "the run carried official evidence");
  assert.equal(summary.measurementYear, 2027);
  assert.deepEqual(summary.logicVintage, {
    artifactYears: "2026",
    measurementYear: 2027,
    note: "Scored with the 2026 FHIR logic; 2027 logic not yet available",
  });
});

test("a 2026 run is covered by its artifact: no note", async () => {
  const summary = await overviewFor("run-vintage-2026", 2026, true);
  assert.equal(summary.measurementYear, 2026);
  assert.equal(summary.logicVintage, null);
});

test("an authored run has no artifact to be stale against, whatever year it scored", async () => {
  const summary = await overviewFor("run-vintage-authored", 2027, false);
  assert.equal(summary.measureRate, null);
  assert.equal(summary.logicVintage, null);
});

test("logicVintageOf needs an official run, a scored year and a manifest", () => {
  const manifest = { effectivePeriod: { start: "2026-01-01", end: "2026-12-31" } };
  assert.equal(logicVintageOf("cms125", true, 2027, () => manifest)?.measurementYear, 2027);
  assert.equal(logicVintageOf("cms125", false, 2027, () => manifest), null);
  assert.equal(logicVintageOf("cms125", true, null, () => manifest), null);
  assert.equal(logicVintageOf("cms125", true, 2027, () => null), null);
});
