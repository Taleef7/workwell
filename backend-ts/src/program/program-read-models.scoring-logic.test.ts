/**
 * The programs card and the measure page name the logic that scored the winning run's rows, read from
 * those rows' own evidence and never from today's routing (#769).
 *   node --import tsx --test src/program/program-read-models.scoring-logic.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { programOverview, __overviewMemo, __chartMemos } from "./program-read-models.ts";
import { resetMeasureRateMemo } from "./measure-rate.ts";
import { executedLogicFor } from "../measure/measure-identity.ts";
import { loadOfficialManifest } from "../wiring/official-artifacts.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";

const MEASURE = "cms122";
const POPULATIONS = { ipp: true, denom: true, numer: false, denex: false, denexcep: false };
const Y2026 = { start: "2026-01-01", end: "2026-12-31" };

const cms122 = (ecqmId = "122FHIR") => ({
  official: { ecqmId, version: "1.0.000", artifactSha256: loadOfficialManifest(MEASURE)!.sha256, measurementPeriod: Y2026, populationResults: POPULATIONS },
});
const translated = {
  official: {
    kind: "derived", label: "WorkWell translation of CMS122v15", url: "urn:workwell:measure:cms122:translation", derivedFrom: "CMS122v15",
    ecqmId: null, version: "ww-2027.1", artifactSha256: "sha256:t", measurementPeriod: Y2026, populationResults: POPULATIONS,
  },
};
const TRANSLATION_LOGIC = {
  kind: "workwell-translation", label: "WorkWell translation of CMS122v15", version: "ww-2027.1",
  url: "urn:workwell:measure:cms122:translation", derivedFrom: "CMS122v15",
};
const CMS_LOGIC = {
  kind: "cms-artifact", ecqmId: "CMS122FHIR", version: "1.0.000", derivedFrom: "CMS122v14",
  status: "draft", statusNote: "posted for public comment Jan–Feb 2026",
};

/** The overview's fakes, one winning cms122 run whose rows carry `evidences`; counts the membership reads. */
function depsFor(runId: string, evidences: unknown[]) {
  const startedAt = "2026-02-01T00:00:00.000Z";
  const rows: OutcomeWithRun[] = [{
    runId, runStartedAt: startedAt, runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual",
    subjectId: "emp-006", measureId: MEASURE, status: "COMPLIANT",
  }];
  const reads = { count: 0 };
  const deps = {
    outcomeStore: {
      listOutcomesWithRun: async () => rows,
      listLatestPopulationRuns: latestRunsFromRows(rows),
      listOutcomes: async () => [],
      listOutcomeMembershipsForRun: async (_runId: string, measureId: string) => {
        reads.count++;
        return measureId === MEASURE ? evidences.map((evidence) => ({ status: "COMPLIANT", evidence })) : [];
      },
      aggregateScaleRun: async () => [],
    } as unknown as OutcomeStore,
    runStore: {
      listRuns: async () => [],
      getRun: async (id: string) =>
        id === runId ? { id, measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T23:59:59.999Z", startedAt, requestedScope: {} } : null,
    } as unknown as RunStore,
    caseStore: { listCases: async () => [] } as unknown as CaseStore,
  };
  return { deps, reads };
}

const clearOverview = () => {
  __overviewMemo.clear();
  for (const memo of Object.values(__chartMemos)) memo.clear();
};

const summaryOf = async (deps: ReturnType<typeof depsFor>["deps"]) =>
  (await programOverview(deps, {})).find((p) => p.measureId === MEASURE)!;

test("routing names CMS's artifact, the rows say the translation scored them: the card names the translation", async () => {
  clearOverview();
  resetMeasureRateMemo();
  // What TODAY's routing would label this measure with. The card must not borrow it.
  assert.equal(executedLogicFor(MEASURE)?.ecqmId, "CMS122FHIR");
  const { deps } = depsFor("run-sl-translated", [translated, translated]);
  const s = await summaryOf(deps);
  assert.deepEqual(s.scoringLogics, [TRANSLATION_LOGIC]);
  assert.deepEqual(s.measureRate?.logic, TRANSLATION_LOGIC);
  assert.equal(s.measureRate?.official?.ecqmId, null);
  assert.doesNotMatch(JSON.stringify({ logics: s.scoringLogics, rate: s.measureRate }), /122FHIR/, "no CMS eCQM id anywhere for a translated run");
});

test("CMS's rows: the logic carries the one served spelling and its lineage, from the bare evidence id", async () => {
  clearOverview();
  resetMeasureRateMemo();
  const { deps } = depsFor("run-sl-cms", [cms122(), cms122()]);
  const s = await summaryOf(deps);
  assert.deepEqual(s.scoringLogics, [CMS_LOGIC]);
  assert.equal(s.measureRate?.official?.ecqmId, "CMS122FHIR", "`/api/programs` serves the prefixed id, never the stored `122FHIR`");
});

test("CMS's row and a translated row in the winning run: two logics, no rate, and the memoized conflict is not read back as authored", async () => {
  clearOverview();
  resetMeasureRateMemo();
  const { deps, reads } = depsFor("run-sl-mixed", [cms122(), translated]);
  const first = await summaryOf(deps);
  assert.equal(first.measureRate, null);
  assert.deepEqual(first.scoringLogics, [CMS_LOGIC, TRANSLATION_LOGIC]);
  // The overview's own memo cleared, the rate memo kept: the next request is answered from the memo.
  clearOverview();
  const before = reads.count;
  const second = await summaryOf(deps);
  assert.equal(reads.count, before, "the rate memo answered");
  assert.equal(second.measureRate, null);
  assert.deepEqual(second.scoringLogics, [CMS_LOGIC, TRANSLATION_LOGIC], "still two logics, not the empty list of an authored run");
});

test("authored rows name no logic", async () => {
  clearOverview();
  resetMeasureRateMemo();
  const { deps } = depsFor("run-sl-authored", [{ expressionResults: [] }]);
  const s = await summaryOf(deps);
  assert.equal(s.measureRate, null);
  assert.deepEqual(s.scoringLogics, []);
});
