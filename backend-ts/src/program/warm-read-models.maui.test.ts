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
      listOutcomeMembershipsForRun: async () => [],
      aggregateScaleRun: async () => [],
    },
    runStore: {
      listRuns: async () => [],
      getRunsByIds: async (ids) => ids.map((id) => ({ id, measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T23:59:59.999Z", startedAt: "2026-08-01T00:00:00.000Z", requestedScope: {} })),
    },
    caseStore: { listCases: async () => [] },
    webChartEnv: {},
  };

  await warmReadModels(deps, "run");
  const afterWarm = reads;
  const eastern = await programTrend(deps, "cms122", {}, { tz: "America/New_York" });
  const easternReads = reads - afterWarm;
  console.log(JSON.stringify({ afterWarm, easternPoints: eastern.length, easternReads }));
`;

test("Maui's warm asks in the practice's zone by default: its first US Eastern visitor reads nothing (#615)", () => {
  const out = runProfileChild("maui", script, { WORKWELL_OFFICIAL_MEASURES: "cms122" });
  assert.ok((out.afterWarm as number) > 0, "the warm read the trend");
  assert.equal(out.easternPoints, 10, "ten Eastern days");
  assert.equal(out.easternReads, 0, "served from what the warm memoized");
});
