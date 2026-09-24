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
import { programOverview, programRiskOutlook, __overviewMemo, __chartMemos, __sitesMemo } from "./program-read-models.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import { __resetRuntimeHealth, runtimeDetail, runtimeHealth } from "../admin/runtime-health.ts";

const rows: OutcomeWithRun[] = [
  { runId: "run-1", runStartedAt: "2026-09-01T00:00:00.000Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE" },
  { runId: "run-1", runStartedAt: "2026-09-01T00:00:00.000Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: "emp-007", measureId: "audiogram", status: "COMPLIANT" },
];

const makeDeps = (overrides: Partial<OutcomeStore> = {}) => ({
  outcomeStore: {
    listOutcomesWithRun: async () => rows,
    listLatestPopulationRuns: latestRunsFromRows(rows),
    listOutcomes: async () => [],
    // Nothing to aggregate in this fixture, so the membership read is empty too — stated rather than
    // inherited, because `aggregateOfficialRun` reads it and not `listOutcomes` (review of #610).
    listOutcomeMembershipsForRun: async () => [],
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
  // Added 2026-09-15, and two reviewers both named its absence: the warm pass gained a
  // `programRiskOutlook` call and nothing asserted it, so deleting the call left this test green
  // while the first request after every nightly paid the cold read the memo exists to prevent.
  assert.ok(__chartMemos.outlookMemo.size > 0, "and the risk outlook, warmed since 2026-09-15");

  // The warmed answer is the one a request gets, not merely SOME cached value.
  let reads = 0;
  const counting = makeDeps({ listOutcomesWithRun: async () => { reads += 1; return rows; } });
  const audiogram = (await programOverview(counting, {})).find((p) => p.measureId === "audiogram")!;
  assert.equal(audiogram.overdue, 1);
  assert.equal(reads, 0, "served from the warm memo — no outcome read at all");

  // Same for the outlook, and at a DIFFERENT horizon from the 90 the warm pass used — which is the
  // point of keeping `horizonDays` out of the memo key.
  const outlook = await programRiskOutlook(counting, "audiogram", 30);
  assert.ok(outlook);
  assert.equal(reads, 0, "the warmed outlook serves any horizon without re-reading");
});

test("a warm failure is swallowed: a completed run is never failed by cache maintenance", async () => {
  clearAll();
  const exploding = makeDeps({ listOutcomesWithRun: async () => { throw new Error("store is down"); } });
  await assert.doesNotReject(() => warmReadModels(exploding));
});

test("every pass is recorded on the runtime view, failed or not, under the trigger that started it (#615)", async () => {
  // The nightly awaited this and dropped the result, so on 2026-09-24 nobody could say whether the
  // pass that should have warmed the pilot's dashboard had run, failed, or never started.
  clearAll();
  __resetRuntimeHealth();
  assert.equal(runtimeHealth().lastWarm, null, "nothing recorded before a pass");

  await warmReadModels(makeDeps(), "nightly");
  const ok = runtimeHealth().lastWarm!;
  assert.equal(ok.trigger, "nightly");
  assert.equal(ok.ok, true);
  assert.equal(ok.failedMeasures, 0);
  assert.ok(ok.durationMs >= 0 && Date.parse(ok.finishedAt) > 0);

  clearAll();
  const exploding = makeDeps({ listOutcomesWithRun: async () => { throw new Error("store is down"); } });
  const result = await warmReadModels(exploding, "boot");
  assert.equal(result.ok, false);
  const failed = runtimeHealth().lastWarm!;
  assert.equal(failed.trigger, "boot");
  assert.equal(failed.ok, false, "a failed pass is recorded as failed, not skipped");
  assert.equal("error" in failed, false, "the public view carries no error text");

  const detail = runtimeDetail().warms;
  assert.deepEqual(detail.map((w) => [w.trigger, w.ok]), [["boot", false], ["nightly", true]], "newest first");
  assert.match(detail[0]!.error ?? "", /store is down/, "the admin view says why");
});
