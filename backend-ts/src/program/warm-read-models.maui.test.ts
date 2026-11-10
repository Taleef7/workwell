/**
 * The post-run warm on the Maui profile, in a fresh process so the profile is really Maui's (#615).
 *   node --import tsx --test src/program/warm-read-models.maui.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runProfileChild } from "../test-support/run-profile-child.ts";

// Pairs of runs: a 12:00Z nightly and a 02:00Z manual run the next UTC day, which is 22:00 the same
// evening in US Eastern. Two UTC days, one Eastern day: Maui's shape when a late-evening manual run
// follows the nightly. Warmed in UTC, the newest ten runs are ten days and the memo stops there, five
// Eastern days short. The warm is called exactly as the scheduler and the boot call it: no zone given.
const script = `
  import { warmReadModels } from "./src/program/warm-read-models.ts";
  import { programTrend } from "./src/program/program-read-models.ts";
  import { latestRunsFromRows } from "./src/test-support/latest-runs.ts";

  const rows = [];
  for (let k = 1; k <= 10; k++) {
    for (const [day, hour, label] of [[2 * k, "12", "nightly"], [2 * k + 1, "02", "manual"]]) {
      const dd = String(day).padStart(2, "0");
      rows.push({ runId: "run-" + dd + "-" + label, runStartedAt: "2026-08-" + dd + "T" + hour + ":00:00.000Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "pat-001", measureId: "cms122", status: "COMPLIANT" });
    }
  }
  let reads = 0;
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => { reads++; return rows; },
      listLatestPopulationRuns: latestRunsFromRows(rows),
      listOutcomes: async () => [],
      anyOutcomeForMeasure: async () => null,
      listOutcomeMembershipsForRun: async () => [],
      aggregateScaleRun: async () => [],
      listOutcomeSubjectMembershipsForRun: async () => [],
    },
    runStore: {
      listRuns: async () => [],
      listPopulationRunsForPeriod: async () => [],
      getRunsByIds: async (ids) => ids.map((id) => ({ id, measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T23:59:59.999Z", startedAt: "2026-08-01T00:00:00.000Z", requestedScope: {} })),
    },
    caseStore: { listCases: async () => [] },
    webChartEnv: {},
  };

  await warmReadModels(deps, "run");
  const afterWarm = reads;
  const hawaii = await programTrend(deps, "cms122", {}, { tz: "Pacific/Honolulu" });
  const hawaiiReads = reads - afterWarm;
  console.log(JSON.stringify({ afterWarm, hawaiiPoints: hawaii.length, hawaiiReads }));
`;

test("Maui's warm asks in the practice's zone by default: its first visitor in Hawaii reads nothing (#615, #882)", () => {
  const out = runProfileChild("maui", script, { WORKWELL_OFFICIAL_MEASURES: "cms122" });
  assert.ok((out.afterWarm as number) > 0, "the warm read the trend");
  assert.equal(out.hawaiiPoints, 10, "ten Hawaii days");
  assert.equal(out.hawaiiReads, 0, "served from what the warm memoized");
});

// The scorecard's kept reads (#884). One population run per year, every measure in it; the warm is called as
// the scheduler, the boot and a manual run call it. `WARM_EXTRA` is a manual run's own year; `WARM_FAIL`
// makes every evidence read fail.
const scorecardScript = `
  import { warmReadModels } from "./src/program/warm-read-models.ts";
  import { scorecardMeasures, scorecardRows } from "./src/compliance/scorecard.ts";

  const fail = process.env.WARM_FAIL === "1";
  const extra = process.env.WARM_EXTRA ? [Number(process.env.WARM_EXTRA)] : undefined;
  const evidenceReads = [];
  let panelReads = 0;
  let runListReads = 0;
  const runOf = (year) => ({
    id: "run-" + year, status: "COMPLETED", scopeType: "ALL_PROGRAMS", triggeredBy: "nightly", requestedScope: {},
    startedAt: year + "-06-01T12:00:00.000Z",
    measurementPeriodStart: year + "-01-01T00:00:00.000Z", measurementPeriodEnd: year + "-12-31T23:59:59.999Z",
  });
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => { panelReads++; return []; },
      listLatestPopulationRuns: async () => { panelReads++; return []; },
      listOutcomes: async () => [],
      anyOutcomeForMeasure: async () => ({ id: "o-1" }),
      listOutcomeMembershipsForRun: async () => [],
      aggregateScaleRun: async () => [],
      listOutcomeSubjectMembershipsForRun: async (runId, measureId) => {
        evidenceReads.push(runId + "|" + measureId);
        if (fail) throw new Error("the database is not answering");
        return [{ id: "o-" + runId, subjectId: "pat-001", evaluatedAt: "2026-06-01T00:00:00.000Z", status: "COMPLIANT", evidence: {} }];
      },
    },
    runStore: {
      listRuns: async () => { runListReads++; return []; },
      getRunsByIds: async () => [],
      listPopulationRunsForPeriod: async (from) => [runOf(Number(from.slice(0, 4)))],
    },
    caseStore: { listCases: async () => [] },
    webChartEnv: {},
  };

  const result = await warmReadModels(deps, "run", undefined, extra ? { scorecardYears: extra } : {});
  const warmed = [...new Set(evidenceReads.map((r) => r.split("|")[0].slice(4)))].sort();
  const afterWarm = evidenceReads.length;
  // Every measure of every warmed year is now a hit.
  for (const year of warmed) for (const m of scorecardMeasures()) await scorecardRows.rows(deps.outcomeStore, { runId: "run-" + year, startedAt: runOf(Number(year)).startedAt }, m.id, Number(year)).catch(() => {});
  console.log(JSON.stringify({
    ok: result.ok, failedMeasures: result.failedMeasures, measures: scorecardMeasures().length,
    warmed, afterWarm, readsAfter: evidenceReads.length - afterWarm, panelReads, runListReads,
  }));
`;
const scorecardEnv = { WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2" };
const warm = (now: string, env: Record<string, string> = {}) =>
  runProfileChild("maui", scorecardScript, { ...scorecardEnv, ...env }, { now });

test("the warm fills the scorecard's kept reads for the practice's year, so its first visitor reads nothing (#884)", () => {
  const out = warm("2027-04-10T20:00:00.000Z");
  assert.equal(out.measures, 3);
  assert.deepEqual(out.warmed, ["2027"], "April: this year only");
  assert.equal(out.afterWarm, 3, "one read per measure");
  assert.equal(out.readsAfter, 0, "every measure of the year is kept");
});

test("from January to March the warm fills last year too, which the lead is closing out (#884, §4A.10)", () => {
  const out = warm("2027-02-10T20:00:00.000Z");
  assert.deepEqual(out.warmed, ["2026", "2027"]);
  assert.equal(out.afterWarm, 6);
  assert.equal(out.readsAfter, 0);
});

test("the year is the practice's: 05:00Z on 1 January is still 31 December in Hawaii, so only 2026 is warmed", () => {
  assert.deepEqual(warm("2027-01-01T05:00:00.000Z").warmed, ["2026"]);
});

test("a manual run's own year is warmed beside the working years", () => {
  const out = warm("2027-04-10T20:00:00.000Z", { WARM_EXTRA: "2025" });
  assert.deepEqual(out.warmed, ["2025", "2027"]);
  assert.equal(out.readsAfter, 0);
});

test("a scorecard warm that fails stops at once, says so once, and leaves the dashboard's warm to run", () => {
  const out = warm("2027-04-10T20:00:00.000Z", { WARM_FAIL: "1" });
  assert.equal(out.afterWarm, 1, "stopped at the first failure, not one wait per measure");
  const warns = String(out.stderr).split("\n").filter((l) => l.includes("read-model warm failed for the scorecard"));
  assert.equal(warns.length, 1);
  assert.equal(out.ok, true, "the overview is not the scorecard");
  assert.deepEqual(out.failedMeasures, [], "the scorecard's failure counts toward no panel's limit");
  assert.ok((out.panelReads as number) > 0, "the dashboard's panels were still warmed");
  assert.ok((out.runListReads as number) > 0, "and the run list");
});
