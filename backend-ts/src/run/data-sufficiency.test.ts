/**
 * #853 (D12): the data-sufficiency floors, at their boundaries.
 *   node --import tsx --test src/run/data-sufficiency.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_SUFFICIENCY_FLOORS,
  DATA_SUFFICIENCY_MINIMUM,
  countSufficiency,
  sufficiencyWindowFor,
  dataInsufficientChecks,
  describeShortfall,
  judgeSufficiency,
  withSufficiency,
  type SufficiencyMetrics,
} from "./data-sufficiency.ts";

const LOINC = "http://loinc.org";
/** A 2026 run: the window is the 2026 calendar year. */
const WINDOW = sufficiencyWindowFor("2026-06-01");
const encounter = (coded: boolean, at = "2026-05-04T14:00:00Z") => ({
  resourceType: "Encounter",
  period: { start: at, end: at },
  type: coded
    ? [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213" }], text: "Office visit" }]
    : [{ text: "Office visit" }],
});
const bloodPressure = (status: string, at = "2026-05-04T14:10:00Z") => ({
  resourceType: "Observation",
  status,
  effectiveDateTime: at,
  code: { coding: [{ system: LOINC, code: "85354-9" }] },
  component: [
    { code: { coding: [{ system: LOINC, code: "8480-6" }] }, valueQuantity: { value: 128, unit: "mm[Hg]" } },
    { code: { coding: [{ system: LOINC, code: "8462-4" }] }, valueQuantity: { value: 78, unit: "mm[Hg]" } },
  ],
});
const bundle = (...resources: unknown[]) => ({
  resourceType: "Bundle",
  type: "collection",
  entry: [{ resource: { resourceType: "Patient", id: "p" } }, ...resources.map((resource) => ({ resource }))],
});
const metrics = (over: Partial<SufficiencyMetrics> = {}): SufficiencyMetrics => ({
  subjects: 1000,
  failedFetches: 0,
  encounters: 1000,
  encountersWithCodedType: 1000,
  bloodPressures: 1000,
  bloodPressuresFinal: 1000,
  ...over,
});
const SIX = ["cms122", "cms125", "cms130", "cms137", "cms165", "cms2"].map((measureId) => ({ measureId, fqmScored: true }));
const flagged = (m: SufficiencyMetrics, measures = SIX) =>
  Object.fromEntries(judgeSufficiency(m, measures).map((v) => [v.measureId, v.shortfalls.map((s) => s.check)]));

test("counts what the floors judge, and nothing of a record that could not be read", () => {
  const degraded = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id: "x" } }] };
  const m = countSufficiency(
    [
      bundle(encounter(true), encounter(false), bloodPressure("final"), bloodPressure("unknown")),
      bundle(encounter(true), bloodPressure("amended")),
      degraded,
    ],
    (b) => b === degraded,
    WINDOW,
  );
  assert.deepEqual(m, {
    subjects: 3,
    failedFetches: 1,
    encounters: 3,
    encountersWithCodedType: 2,
    bloodPressures: 3,
    bloodPressuresFinal: 2,
  });
});

test("a coding without a system, or a code, is not a coded type", () => {
  const halfCoded = { resourceType: "Encounter", type: [{ coding: [{ code: "99213" }] }, { coding: [{ system: "x", code: "" }] }] };
  const m = countSufficiency([bundle({ ...halfCoded, period: { start: "2026-03-01" } })], () => false, WINDOW);
  assert.equal(m.encounters, 1);
  assert.equal(m.encountersWithCodedType, 0);
});

test("a blood pressure CMS165 cannot read (components not in LOINC's system) is not counted at all", () => {
  const unreadable = { ...bloodPressure("unknown"), component: [{ code: { coding: [{ system: "http://loinc.org/", code: "8480-6" }] } }] };
  assert.equal(countSufficiency([bundle(unreadable)], () => false, WINDOW).bloodPressures, 0);
});

test("encounter floor: 94.9% coded fires for every CMS-scored measure, 95% does not", () => {
  assert.equal(DATA_SUFFICIENCY_FLOORS.encounterTypeCoded, 0.95);
  const fires = flagged(metrics({ encounters: 1000, encountersWithCodedType: 949 }));
  assert.deepEqual(Object.keys(fires).sort(), ["cms122", "cms125", "cms130", "cms137", "cms165", "cms2"]);
  assert.deepEqual(fires.cms122, ["encounterTypeCoded"]);
  assert.deepEqual(flagged(metrics({ encounters: 1000, encountersWithCodedType: 950 })), {});
});

test("blood-pressure floor: CMS165 only, 94.9% final fires, 95% does not", () => {
  assert.deepEqual(flagged(metrics({ bloodPressures: 1000, bloodPressuresFinal: 949 })), { cms165: ["bloodPressureFinal"] });
  assert.deepEqual(flagged(metrics({ bloodPressures: 1000, bloodPressuresFinal: 950 })), {});
});

test("failed fetches: 1% fires for every measure, authored ones included; 0.9% does not", () => {
  const measures = [...SIX, { measureId: "audiogram", fqmScored: false }];
  const fires = flagged(metrics({ subjects: 1000, failedFetches: 10 }), measures);
  assert.equal(Object.keys(fires).length, 7);
  assert.deepEqual(fires.audiogram, ["failedFetches"]);
  assert.deepEqual(flagged(metrics({ subjects: 1000, failedFetches: 9 }), measures), {});
});

test("the encounter and blood-pressure floors judge only what CMS's logic reads: our authored CMS165 is exempt", () => {
  const thin = metrics({ encountersWithCodedType: 0, bloodPressuresFinal: 0 });
  assert.deepEqual(flagged(thin, [{ measureId: "cms165", fqmScored: false }]), {});
  assert.deepEqual(flagged(thin, [{ measureId: "cms165", fqmScored: true }]), { cms165: ["encounterTypeCoded", "bloodPressureFinal"] });
});

test("a metric with nothing to measure never fires: no encounters is not 0% coded (1 January)", () => {
  assert.deepEqual(flagged(metrics({ encounters: 0, encountersWithCodedType: 0, bloodPressures: 0, bloodPressuresFinal: 0 })), {});
  assert.deepEqual(flagged(metrics({ subjects: 0, failedFetches: 0 })), {});
});

test("only what the measures read counts: years of uncoded history do not fail a practice that codes this year", () => {
  // The owner's case for the window: a 2019 visit typed as text affects no 2026 rate.
  const legacy = Array.from({ length: 500 }, () => encounter(false, "2019-03-01T10:00:00Z"));
  const thisYear = Array.from({ length: 200 }, () => encounter(true));
  const m = countSufficiency([bundle(...legacy, ...thisYear)], () => false, WINDOW);
  assert.equal(m.encounters, 200);
  assert.equal(m.encountersWithCodedType, 200);
  assert.deepEqual(flagged(m), {});

  // Each end of an encounter must lie inside, and one without a usable period is never read by the logic.
  const straddlesStart = { ...encounter(false), period: { start: "2025-12-31T20:00:00Z", end: "2026-01-01T02:00:00Z" } };
  const straddlesEnd = { ...encounter(false), period: { start: "2026-12-31T22:00:00Z", end: "2027-01-01T03:00:00Z" } };
  const undated = { resourceType: "Encounter", type: [{ text: "Office visit" }] };
  assert.equal(countSufficiency([bundle(straddlesStart, straddlesEnd, undated)], () => false, WINDOW).encounters, 0);

  // A blood pressure counts by when it was taken.
  const bp = countSufficiency([bundle(bloodPressure("unknown", "2025-11-02T09:00:00Z"), bloodPressure("final"))], () => false, WINDOW);
  assert.deepEqual([bp.bloodPressures, bp.bloodPressuresFinal], [1, 1]);
});

test("a share floor is judged only once enough is in the window: 99 uncoded visits do not fire, 100 do", () => {
  assert.equal(DATA_SUFFICIENCY_MINIMUM, 100);
  const uncoded = (n: number) => countSufficiency([bundle(...Array.from({ length: n }, () => encounter(false)))], () => false, WINDOW);
  assert.deepEqual(flagged(uncoded(99)), {});
  assert.deepEqual(flagged(uncoded(100)).cms122, ["encounterTypeCoded"]);
  const unfinal = (n: number) =>
    countSufficiency([bundle(...Array.from({ length: n }, () => bloodPressure("unknown")))], () => false, WINDOW);
  assert.deepEqual(flagged(unfinal(99)), {});
  assert.deepEqual(flagged(unfinal(100)).cms165, ["bloodPressureFinal"]);
});

test("the WebChart trial's shape is insufficient: every visit type as text, every panel status unknown", () => {
  const trial = Array.from({ length: DATA_SUFFICIENCY_MINIMUM }, () => bundle(encounter(false), bloodPressure("unknown")));
  const verdict = flagged(countSufficiency(trial, () => false, WINDOW));
  assert.deepEqual(verdict.cms165, ["encounterTypeCoded", "bloodPressureFinal"]);
  assert.deepEqual(verdict.cms122, ["encounterTypeCoded"]);
});

test("the shortfall reads plainly for a run log", () => {
  const [verdict] = judgeSufficiency(metrics({ encounters: 189, encountersWithCodedType: 111 }), [{ measureId: "cms122", fqmScored: true }]);
  assert.equal(describeShortfall(verdict!.shortfalls[0]!), "encounter types coded: 111 of 189 (58.7%), floor 95.0%");
});

test("the evidence flag is set, replaced or removed on every row, never kept from an earlier run", () => {
  const evidence = { official: { populationResults: [] } };
  const set = withSufficiency(evidence, ["encounterTypeCoded"]);
  assert.deepEqual(dataInsufficientChecks(set), ["encounterTypeCoded"]);
  // A copied-forward row from a thin run, scored now on sufficient data, loses the flag.
  const cleared = withSufficiency(set, undefined) as Record<string, unknown>;
  assert.equal("dataInsufficient" in cleared, false);
  assert.deepEqual(cleared, evidence);
  assert.equal(dataInsufficientChecks(cleared), null);
  // An errored row keeps its error key and carries the flag too.
  const errored = withSufficiency({ evaluationError: "engine failure", message: "boom" }, ["failedFetches"]);
  assert.deepEqual(errored, { evaluationError: "engine failure", message: "boom", dataInsufficient: { checks: ["failedFetches"] } });
});
