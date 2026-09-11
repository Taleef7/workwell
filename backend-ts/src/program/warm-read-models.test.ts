/**
 * The post-run warm: it fills the memos a completed run has just invalidated, and it never lets its
 * own failure reach a run that has already completed and been reported.
 *   node --import tsx --test src/program/warm-read-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { warmReadModels } from "./warm-read-models.ts";
import { programOverview, __overviewMemo, __chartMemos, __sitesMemo } from "./program-read-models.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const rows: OutcomeWithRun[] = [
  { runId: "run-1", runStartedAt: "2026-09-01T00:00:00.000Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE" },
  { runId: "run-1", runStartedAt: "2026-09-01T00:00:00.000Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT" },
];

const makeDeps = (overrides: Partial<OutcomeStore> = {}) => ({
  outcomeStore: {
    listOutcomesWithRun: async () => rows,
    listLatestPopulationRuns: latestRunsFromRows(rows),
    listOutcomes: async () => [],
    aggregateScaleRun: async () => [],
    ...overrides,
  } as unknown as OutcomeStore,
  runStore: { listRuns: async () => [] } as unknown as RunStore,
  caseStore: { listCases: async () => [] } as unknown as CaseStore,
});

const clearAll = () => {
  __overviewMemo.clear();
  __sitesMemo.clear();
  for (const memo of Object.values(__chartMemos)) memo.clear();
};

test("warming leaves the dashboard's memos filled, so the first request after a run is a hit", async () => {
  clearAll();
  const deps = makeDeps();
  await warmReadModels(deps);

  assert.ok(__overviewMemo.size > 0, "the overview buckets are cached");
  // Not the site list: on the default profile with the WebChart seam off, `programSites` answers
  // from the static directory without reading outcomes at all, so there is nothing to memoize. The
  // warm still calls it, because on a scoped profile (the pilot) that call is the expensive one.
  assert.equal(__sitesMemo.size, 0);
  assert.ok(__chartMemos.trendMemo.size > 0 && __chartMemos.driversMemo.size > 0, "and both per-measure panels");

  // The warmed answer is the one a request gets, not merely SOME cached value.
  let reads = 0;
  const counting = makeDeps({ listOutcomesWithRun: async () => { reads += 1; return rows; } });
  const audiogram = (await programOverview(counting, {})).find((p) => p.measureId === "audiogram")!;
  assert.equal(audiogram.overdue, 1);
  assert.equal(reads, 0, "served from the warm memo — no outcome read at all");
});

test("a warm failure is swallowed: a completed run is never failed by cache maintenance", async () => {
  clearAll();
  const exploding = makeDeps({ listOutcomesWithRun: async () => { throw new Error("store is down"); } });
  await assert.doesNotReject(() => warmReadModels(exploding));
});
