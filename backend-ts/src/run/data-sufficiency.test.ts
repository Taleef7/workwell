/**
 * #853 (D12): the data-sufficiency floors, at their boundaries.
 *   node --import tsx --test src/run/data-sufficiency.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_SUFFICIENCY_FLOORS,
  countSufficiency,
  dataInsufficientChecks,
  describeShortfall,
  judgeSufficiency,
  withSufficiency,
  type SufficiencyMetrics,
} from "./data-sufficiency.ts";

const LOINC = "http://loinc.org";
const encounter = (coded: boolean) => ({
  resourceType: "Encounter",
  type: coded
    ? [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213" }], text: "Office visit" }]
    : [{ text: "Office visit" }],
});
const bloodPressure = (status: string) => ({
  resourceType: "Observation",
  status,
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
  const m = countSufficiency([bundle(halfCoded)], () => false);
  assert.equal(m.encounters, 1);
  assert.equal(m.encountersWithCodedType, 0);
});

test("a blood pressure CMS165 cannot read (components not in LOINC's system) is not counted at all", () => {
  const unreadable = { ...bloodPressure("unknown"), component: [{ code: { coding: [{ system: "http://loinc.org/", code: "8480-6" }] } }] };
  assert.equal(countSufficiency([bundle(unreadable)], () => false).bloodPressures, 0);
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

test("the WebChart trial's shape is insufficient: every visit type as text, every panel status unknown", () => {
  const trial = Array.from({ length: 10 }, () => bundle(encounter(false), bloodPressure("unknown")));
  const verdict = flagged(countSufficiency(trial, () => false));
  assert.deepEqual(verdict.cms165, ["encounterTypeCoded", "bloodPressureFinal"]);
  assert.deepEqual(verdict.cms122, ["encounterTypeCoded"]);
});

test("the shortfall reads plainly for a run log", () => {
  const [verdict] = judgeSufficiency(metrics({ encounters: 89, encountersWithCodedType: 11 }), [{ measureId: "cms122", fqmScored: true }]);
  assert.equal(describeShortfall(verdict!.shortfalls[0]!), "encounter types coded: 11 of 89 (12.4%), floor 95.0%");
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
