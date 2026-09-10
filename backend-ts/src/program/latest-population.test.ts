/**
 * The shared "latest population run per measure" read (`latest-population.ts`) and the run-keyed memo
 * the programs read models build on it.
 *   node --import tsx --test src/program/latest-population.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { latestPopulationSnapshot, latestPopulationWinners, RunKeyedMemo } from "./latest-population.ts";
import { programOverview, programSites, programTopDrivers, programTrend, __overviewMemo, __sitesMemo, __chartMemos } from "./program-read-models.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const row = (runId: string, startedAt: string, subjectId: string, measureId: string, status: string, over: Partial<OutcomeWithRun> = {}): OutcomeWithRun => ({
  runId, runStartedAt: startedAt, runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId, measureId, status, ...over,
});

test("RunKeyedMemo serves an entry only under the runKey it was stored with, and stays bounded", () => {
  const memo = new RunKeyedMemo<number>(2);
  memo.set("a", "run-1", 1);
  assert.equal(memo.get("a", "run-1"), 1, "same key + same winners → hit");
  assert.equal(memo.get("a", "run-2"), undefined, "a new winner invalidates without a timer");
  assert.equal(memo.get("b", "run-1"), undefined, "a different filter key is a different entry");
  memo.set("b", "run-1", 2);
  memo.set("c", "run-1", 3); // evicts "a", the oldest
  assert.equal(memo.size, 2);
  assert.equal(memo.get("a", "run-1"), undefined, "the oldest entry is evicted past max");
  assert.equal(memo.get("c", "run-1"), 3);
  memo.set("b", "run-9", 4); // re-setting refreshes the entry and its winners
  assert.equal(memo.get("b", "run-1"), undefined);
  assert.equal(memo.get("b", "run-9"), 4);
});

test("latestPopulationSnapshot keeps exactly the (measure, run) pairs that won, even when the store returns the runs' other rows", async () => {
  // audiogram won run-new; hazwoper's newest run with a hazwoper row is run-old. run-old is an
  // ALL_PROGRAMS run that also holds an audiogram row, which the caller must not see beside run-new's.
  const rows = [
    row("run-old", "2026-03-01T00:00:00.000Z", "emp-006", "audiogram", "OVERDUE"),
    row("run-old", "2026-03-01T00:00:00.000Z", "emp-001", "hazwoper", "OVERDUE"),
    row("run-new", "2026-04-01T00:00:00.000Z", "emp-006", "audiogram", "COMPLIANT"),
  ];
  const requested: string[][] = [];
  const store = {
    listLatestPopulationRuns: latestRunsFromRows(rows),
    // A store that ignores `runIds` (like every pre-existing fake) — the helper still narrows.
    listOutcomesWithRun: async (filter: { runIds?: string[] }) => { requested.push(filter.runIds ?? []); return rows; },
  } as unknown as OutcomeStore;
  const snap = await latestPopulationSnapshot(store, ["audiogram", "hazwoper", "never-run"], { excludeScale: true }, undefined);
  assert.deepEqual(
    snap.rows.map((r) => `${r.measureId}@${r.runId}`).sort(),
    ["audiogram@run-new", "hazwoper@run-old"],
    "one run per measure, the winner's rows only",
  );
  assert.deepEqual(requested.flat().sort(), ["run-new", "run-old"], "the rows are asked for BY RUN ID (one narrowed read per winner here)");
  assert.equal(snap.runKey, "audiogram:run-new,hazwoper:run-old");
  const { runKey } = await latestPopulationWinners(store, ["hazwoper", "audiogram"], { excludeScale: true });
  assert.equal(runKey, snap.runKey, "the key is order-independent and names every winner");
  assert.deepEqual(await latestPopulationSnapshot(store, [], {}, undefined).then((s) => s.rows), [], "no measures → no read");
});

test("a single-measure read is narrowed to that measure, so a window never reads the run's other measures", async () => {
  const rows = [
    row("run-1", "2026-06-01T00:00:00.000Z", "emp-006", "audiogram", "OVERDUE"),
    row("run-1", "2026-06-01T00:00:00.000Z", "emp-006", "hazwoper", "COMPLIANT"),
    row("run-2", "2026-06-02T00:00:00.000Z", "emp-006", "audiogram", "COMPLIANT"),
    row("run-2", "2026-06-02T00:00:00.000Z", "emp-006", "hazwoper", "COMPLIANT"),
  ];
  const reads: Array<{ runIds?: string[]; measureId?: string }> = [];
  const store = {
    listLatestPopulationRuns: latestRunsFromRows(rows),
    listOutcomesWithRun: async (filter: { runIds?: string[]; measureId?: string }) => {
      reads.push(filter);
      return rows.filter((r) => (!filter.runIds || filter.runIds.includes(r.runId)) && (!filter.measureId || r.measureId === filter.measureId));
    },
  } as unknown as OutcomeStore;
  const snap = await latestPopulationSnapshot(store, ["audiogram"], {}, undefined, 10);
  assert.deepEqual(reads, [{ measureId: "audiogram", runIds: ["run-2", "run-1"] }], "one read, the measure in SQL, both runs of the window");
  assert.deepEqual(snap.rows.map((r) => `${r.measureId}@${r.runId}`).sort(), ["audiogram@run-1", "audiogram@run-2"]);
  // Two measures that both won the same run: that run once, whole.
  reads.length = 0;
  await latestPopulationSnapshot(store, ["audiogram", "hazwoper"], {}, undefined);
  assert.deepEqual(reads, [{ runIds: ["run-2"] }]);
});

test("a winner none of whose rows the caller can see falls back to the newest run that has one — the filter-then-reduce rule", async () => {
  // The site filter's shape: run-new evaluated only a subject at another clinic; run-old holds one
  // at the requested clinic. The old code filtered by site THEN took the newest run, and got run-old.
  const rows = [
    row("run-old", "2026-06-01T00:00:00.000Z", "at-clinic", "audiogram", "OVERDUE"),
    row("run-old", "2026-06-01T00:00:00.000Z", "elsewhere", "audiogram", "COMPLIANT"),
    row("run-new", "2026-06-02T00:00:00.000Z", "elsewhere", "audiogram", "COMPLIANT"),
  ];
  const store = {
    listLatestPopulationRuns: latestRunsFromRows(rows),
    listOutcomesWithRun: async (filter: { runIds?: string[]; measureId?: string }) =>
      rows.filter((r) => (!filter.runIds || filter.runIds.includes(r.runId)) && (!filter.measureId || r.measureId === filter.measureId)),
  } as unknown as OutcomeStore;
  const atClinic = await latestPopulationSnapshot(store, ["audiogram"], {}, undefined, 1, { visible: (id) => id === "at-clinic" });
  assert.deepEqual(atClinic.rows.map((r) => `${r.subjectId}@${r.runId}`), ["at-clinic@run-old"], "run-old's VISIBLE rows — what filter-then-reduce kept");
  assert.equal(atClinic.runKey, "audiogram:run-old", "the snapshot's own key names the run the rows came from");
  const anywhere = await latestPopulationSnapshot(store, ["audiogram"], {}, undefined, 1, { visible: () => true });
  assert.deepEqual(anywhere.rows.map((r) => r.runId), ["run-new"], "with a visible row, the winner stands");
  const windowed = await latestPopulationSnapshot(store, ["audiogram"], {}, undefined, 2, { visible: (id) => id === "at-clinic" });
  assert.deepEqual(new Set(windowed.rows.map((r) => r.runId)), new Set(["run-new", "run-old"]), "a window never falls back (stated edge): it keeps its N runs");
});

// Fakes for the programs read models: the rows are mutable so a test can "complete a nightly".
function programDeps(rows: OutcomeWithRun[], counters: { rowReads: number }) {
  return {
    outcomeStore: {
      listLatestPopulationRuns: latestRunsFromRows(() => rows),
      listOutcomesWithRun: async () => { counters.rowReads++; return rows; },
      listOutcomes: async () => [],
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: { listRuns: async () => [] } as unknown as RunStore,
    caseStore: { listCases: async () => [] } as unknown as CaseStore,
    webChartEnv: {},
  };
}

test("programOverview reads the winners' rows once per set of winners; a newer completed run invalidates the memo", async () => {
  __overviewMemo.clear();
  const rows = [row("run-1", "2026-06-01T00:00:00.000Z", "emp-006", "audiogram", "OVERDUE")];
  const counters = { rowReads: 0 };
  const deps = programDeps(rows, counters);
  const first = (await programOverview(deps, { site: null, tenant: null })).find((s) => s.measureId === "audiogram")!;
  assert.equal(first.overdue, 1);
  assert.equal(counters.rowReads, 1);
  const again = (await programOverview(deps, { site: null, tenant: null })).find((s) => s.measureId === "audiogram")!;
  assert.equal(again.overdue, 1);
  assert.equal(counters.rowReads, 1, "same winners → the rows are not read again");
  // A different filter is its own entry (the site filter shapes the buckets).
  await programOverview(deps, { site: "Plant A", tenant: null });
  assert.equal(counters.rowReads, 2, "a new filter combination reads once");
  // The nightly completes: a newer run wins, and the next read sees it without any explicit reset.
  rows.push(row("run-2", "2026-06-02T00:00:00.000Z", "emp-006", "audiogram", "COMPLIANT"));
  const after = (await programOverview(deps, { site: null, tenant: null })).find((s) => s.measureId === "audiogram")!;
  assert.equal(after.compliant, 1);
  assert.equal(after.overdue, 0);
  assert.equal(after.latestRunId, "run-2");
  assert.equal(counters.rowReads, 3, "a new winner → one fresh read");
});

test("programSites, programTrend and programTopDrivers memoize under the winners' key and refresh on a new winner", async () => {
  __sitesMemo.clear();
  __chartMemos.trendMemo.clear();
  __chartMemos.driversMemo.clear();
  const rows = [row("run-1", "2026-06-01T00:00:00.000Z", "emp-006", "audiogram", "OVERDUE")];
  const counters = { rowReads: 0 };
  // The seam ON makes the site list read rows (seam off, the default profile answers from the directory).
  const deps = { ...programDeps(rows, counters), webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "k" } };

  await programSites(deps);
  await programSites(deps);
  assert.equal(counters.rowReads, 1, "sites: one read for the same winners");

  const t1 = await programTrend(deps, "audiogram", { site: null, tenant: null });
  const t2 = await programTrend(deps, "audiogram", { site: null, tenant: null });
  assert.equal(t1.length, 1);
  assert.deepEqual(t2, t1);
  assert.equal(counters.rowReads, 2, "trend: one read for the same window");

  const d1 = await programTopDrivers(deps, "audiogram", { site: null, tenant: null });
  await programTopDrivers(deps, "audiogram", { site: null, tenant: null });
  assert.equal(d1.byOutcomeReason[0]?.reason, "OVERDUE");
  assert.equal(counters.rowReads, 3, "top-drivers: one read for the same winner");

  rows.push(row("run-2", "2026-06-02T00:00:00.000Z", "emp-006", "audiogram", "COMPLIANT"));
  const trend = await programTrend(deps, "audiogram", { site: null, tenant: null });
  assert.equal(trend[0]!.runId, "run-2", "the new winner is the first point");
  assert.equal(trend.length, 2);
  const drivers = await programTopDrivers(deps, "audiogram", { site: null, tenant: null });
  assert.deepEqual(drivers.byOutcomeReason, [], "no one is flagged on the new winner");
  assert.equal(counters.rowReads, 5, "each chart re-read once for the new winner");
});

test("a seam flip is not served the other seam state's memo entry", async () => {
  __overviewMemo.clear();
  const rows = [row("run-1", "2026-06-01T00:00:00.000Z", "wc|live-1", "audiogram", "OVERDUE")];
  const counters = { rowReads: 0 };
  const off = programDeps(rows, counters);
  const on = { ...off, webChartEnv: { WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "k" } };
  const offSummary = (await programOverview(off, { site: null, tenant: null })).find((s) => s.measureId === "audiogram")!;
  assert.equal(offSummary.totalEvaluated, 0, "seam off: a wc subject is invisible");
  const onSummary = (await programOverview(on, { site: null, tenant: null })).find((s) => s.measureId === "audiogram")!;
  assert.equal(onSummary.totalEvaluated, 1, "seam on: the same winners, a different answer — from its own entry");
});
