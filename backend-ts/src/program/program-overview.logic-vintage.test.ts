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
import { loadOfficialManifest } from "../wiring/official-artifacts.ts";
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

const POPULATIONS = { ipp: true, denom: true, numer: false, denex: false, denexcep: false };
const OFFICIAL = { official: { populationResults: POPULATIONS } };

/**
 * One winning run for cms122, scoring `year`, whose rows carry official evidence (optionally naming its
 * artifact) or not; `scale` adds a completed run of the generated scale tenant, which the authored engine scores.
 */
const overviewFor = async (runId: string, year: number, official: boolean, artifact: Record<string, string> = {}, scale = false) => {
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
        measureId === MEASURE
          ? [{ status: "COMPLIANT", evidence: official ? { official: { ...artifact, populationResults: POPULATIONS } } : { expressionResults: [] } }]
          : [],
      aggregateScaleRun: async () => (scale ? [{ status: "COMPLIANT", count: 5 }] : []),
    } as unknown as OutcomeStore,
    runStore: {
      listRuns: async () =>
        scale ? [{ id: "scale-1", triggeredBy: "seed:scale", status: "COMPLETED", scopeId: MEASURE, startedAt }] : [],
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

test("the run's evidence decides which artifact scored it: today's manifest speaks only for that artifact", async () => {
  const sha256 = loadOfficialManifest(MEASURE)!.sha256;
  const same = await overviewFor("run-vintage-same-artifact", 2027, true, { ecqmId: "122FHIR", version: "1.0.000", artifactSha256: sha256 });
  assert.equal(same.logicVintage?.note, "Scored with the 2026 FHIR logic; 2027 logic not yet available");
  // Scored by other bytes under the same version (re-vendored since): today's declared period says
  // nothing about it. The digest has to travel from the evidence for this to be caught.
  const other = await overviewFor("run-vintage-other-artifact", 2027, true, { ecqmId: "122FHIR", version: "1.0.000", artifactSha256: "sha256:another" });
  assert.equal(other.logicVintage, null);
});

test("a total that folds in the authored scale tenant's counts carries no note about the artifact's year", async () => {
  const summary = await overviewFor("run-vintage-scale", 2027, true, {}, true);
  assert.equal(summary.includesAuthoredScaleCounts, true);
  assert.equal(summary.totalEvaluated, 6, "the live row and the five scale rows");
  assert.ok(summary.measureRate, "the live run still carried official evidence");
  assert.equal(summary.logicVintage, null);
});

test("logicVintageOf needs an official run, a scored year and a manifest describing the run's artifact", () => {
  const manifest = { effectivePeriod: { start: "2026-01-01", end: "2026-12-31" }, sha256: "sha256:a", version: "1.0.000" };
  const ran = (official: { ecqmId: string | null; version: string | null; artifactSha256?: string | null } | null) => ({ official });
  assert.equal(logicVintageOf("cms125", ran(null), 2027, () => manifest)?.measurementYear, 2027, "no identity recorded: the manifest is the fallback");
  assert.equal(logicVintageOf("cms125", null, 2027, () => manifest), null, "no official evidence");
  assert.equal(logicVintageOf("cms125", ran(null), null, () => manifest), null);
  assert.equal(logicVintageOf("cms125", ran(null), 2027, () => null), null);
  assert.equal(logicVintageOf("cms125", ran({ ecqmId: "125FHIR", version: "1.0.000", artifactSha256: "sha256:a" }), 2027, () => manifest)?.measurementYear, 2027);
  assert.equal(logicVintageOf("cms125", ran({ ecqmId: "125FHIR", version: "1.0.000", artifactSha256: "sha256:b" }), 2027, () => manifest), null, "same version, other bytes");
  assert.equal(logicVintageOf("cms125", ran({ ecqmId: "125FHIR", version: "0.5.000" }), 2027, () => manifest), null, "no digest: the version decides");
});

test("logicVintageOf: a translated run has no vintage gap; CMS's draft over a year a routed translation covers says what the next run uses", () => {
  const manifest = { effectivePeriod: { start: "2026-01-01", end: "2026-12-31" }, sha256: "sha256:a", version: "1.0.000" };
  const none = () => null;
  const routed = () => ({ derived: { label: "WorkWell translation of CMS137v15" } });
  // The translation scored 2027: nothing is out of date, whatever CMS's manifest says.
  const translated = { official: { ecqmId: null, version: "ww-2027.1", artifactSha256: "sha256:t", kind: "derived" as const, label: "WorkWell translation of CMS137v15" } };
  assert.equal(logicVintageOf("cms137", translated, 2027, () => manifest, routed), null);
  assert.equal(logicVintageOf("cms137", translated, 2027, () => manifest, none), null, "even with no translation routed any more");
  // CMS's draft scored 2027 with no translation routed: today's note, unchanged.
  const cms = { official: { ecqmId: "137FHIR", version: "1.0.000", artifactSha256: "sha256:a" } };
  assert.equal(logicVintageOf("cms137", cms, 2027, () => manifest, none)?.note, "Scored with the 2026 FHIR logic; 2027 logic not yet available");
  // CMS's draft scored 2027 before the translation was routed: "not yet available" would be false.
  const note = logicVintageOf("cms137", cms, 2027, () => manifest, routed);
  assert.equal(note?.note, "Scored with the 2026 FHIR logic; WorkWell translation of CMS137v15 applies from the next run");
  assert.equal(note?.artifactYears, "2026");
  // A year CMS's artifact covers carries no note either way.
  assert.equal(logicVintageOf("cms137", cms, 2026, () => manifest, routed), null);
  // The default reads the deployment: with no translation allowlisted it is today's note.
  assert.equal(logicVintageOf("cms137", cms, 2027, () => manifest)?.note, "Scored with the 2026 FHIR logic; 2027 logic not yet available");
});
