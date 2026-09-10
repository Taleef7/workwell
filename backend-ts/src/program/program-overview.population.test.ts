/**
 * The programs overview picks each measure's latest WHOLE-ROSTER run. A SITE recheck is a population
 * of one clinic; if it won, the dashboard would report that clinic's rate as the practice's (review
 * finding 11, ADR-077 d4).
 *   node --import tsx --test src/program/program-overview.population.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { programOverview } from "./program-read-models.ts";
import { isPopulationRun, POPULATION_SCOPES } from "./rollup-shared.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const row = (runId: string, runStartedAt: string, runScopeType: string, subjectId: string, status: string): OutcomeWithRun =>
  ({ runId, runStartedAt, runScopeType, runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId, measureId: "audiogram", status });

const rows = [
  row("run-measure", "2026-06-01T00:00:00.000Z", "MEASURE", "emp-006", "OVERDUE"),
  row("run-measure", "2026-06-01T00:00:00.000Z", "MEASURE", "emp-007", "OVERDUE"),
  row("run-site", "2026-07-01T00:00:00.000Z", "SITE", "emp-006", "COMPLIANT"),
];

const deps = {
  outcomeStore: {
    listOutcomesWithRun: async () => rows,
    listLatestPopulationRuns: latestRunsFromRows(rows),
    listOutcomes: async () => [],
    aggregateScaleRun: async () => [],
  } as unknown as OutcomeStore,
  runStore: { listRuns: async () => [] } as unknown as RunStore,
  caseStore: { listCases: async () => [] } as unknown as CaseStore,
};

test("the allowlist names the whole-roster scopes and nothing else", () => {
  assert.deepEqual([...POPULATION_SCOPES].sort(), ["ALL_PROGRAMS", "MEASURE"]);
  for (const scope of ["SITE", "CASE", "EMPLOYEE", "site"]) assert.equal(isPopulationRun(scope), false, scope);
  for (const scope of ["MEASURE", "ALL_PROGRAMS", "measure"]) assert.equal(isPopulationRun(scope), true, scope);
});

test("a newer COMPLETED SITE run does not replace the practice-wide overview", async () => {
  const audiogram = (await programOverview(deps, {})).find((p) => p.measureId === "audiogram")!;
  assert.equal(audiogram.latestRunId, "run-measure");
  assert.equal(audiogram.totalEvaluated, 2, "both subjects of the whole-roster run, not the one the site recheck saw");
  assert.equal(audiogram.overdue, 2);
});
