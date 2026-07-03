/**
 * E12 PR-2: WebChart → measure terminology reconciliation.
 *   node --import tsx --test src/engine/ingress/webchart/terminology.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileCoding, reconcileCodings, crosswalkMeasureIds, targetEventType } from "./terminology.ts";
import { MEASURE_BINDINGS } from "../../synthetic/measure-bindings.ts";

const eventOf = (measureId: string) => ({
  system: MEASURE_BINDINGS[measureId]!.event.valueSet,
  code: MEASURE_BINDINGS[measureId]!.event.code,
});

const systems = (cs: { system?: string }[]): string[] => cs.map((c) => c.system ?? "").sort();

test("reconcileCoding: real CPT/CVX/LOINC → the measure's synthetic event coding", () => {
  const audiogram = reconcileCoding({ system: "http://www.ama-assn.org/go/cpt", code: "92557" });
  assert.deepEqual(audiogram, [
    {
      system: MEASURE_BINDINGS["audiogram"]!.event.valueSet,
      code: MEASURE_BINDINGS["audiogram"]!.event.code,
      display: MEASURE_BINDINGS["audiogram"]!.event.code,
    },
  ]);
  assert.deepEqual(systems(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code: "141" })), [MEASURE_BINDINGS["flu_vaccine"]!.event.valueSet]);
});

test("reconcileCoding: one real code can satisfy several measures (HbA1c → diabetes + cms122)", () => {
  // LOINC 4548-4 drives both diabetes_hba1c and cms122 — both synthetic codings must be returned so
  // BOTH measures match when evaluating that observation.
  const both = systems(reconcileCoding({ system: "http://loinc.org", code: "4548-4" }));
  assert.deepEqual(both, [MEASURE_BINDINGS["cms122"]!.event.valueSet, MEASURE_BINDINGS["diabetes_hba1c"]!.event.valueSet].sort());
});

test("reconcileCoding: tolerates system aliases (OID + case) and HCPCS letter codes", () => {
  // CVX by OID instead of the canonical URI still resolves.
  assert.ok(reconcileCoding({ system: "urn:oid:2.16.840.1.113883.12.292", code: "115" }).length);
  // HCPCS G0202 (uppercase letter) matches case-insensitively.
  assert.deepEqual(systems(reconcileCoding({ system: "http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets", code: "g0202" })), [MEASURE_BINDINGS["cms125"]!.event.valueSet]);
});

test("reconcileCoding: an unmapped or empty coding → [] (most WebChart codes are irrelevant)", () => {
  assert.deepEqual(reconcileCoding({ system: "http://loinc.org", code: "99999-9" }), []);
  assert.deepEqual(reconcileCoding({ system: "http://www.ama-assn.org/go/cpt", code: "" }), []);
  assert.deepEqual(reconcileCoding(undefined), []);
  assert.deepEqual(reconcileCoding({ code: "92557" }), []); // no system → no confident match
});

test("reconcileCodings: appends the synthetic coding, preserves the original, dedupes", () => {
  const real = [{ system: "http://www.ama-assn.org/go/cpt", code: "92557", display: "Audiometry" }];
  const out = reconcileCodings(real);
  assert.equal(out.length, 2, "original + synthetic");
  assert.deepEqual(out[0], real[0], "original preserved for provenance");
  assert.equal(out[1]?.code, MEASURE_BINDINGS["audiogram"]!.event.code);
  // Idempotent: reconciling again doesn't add a third.
  assert.equal(reconcileCodings(out).length, 2);
});

test("reconcileCodings: no matches → returns the same array reference (cheap no-op)", () => {
  const real = [{ system: "http://loinc.org", code: "99999-9" }];
  assert.equal(reconcileCodings(real), real);
  assert.deepEqual(reconcileCodings([]), []);
  assert.deepEqual(reconcileCodings(undefined), []);
});

test("crosswalk targets only reference real, current measures", () => {
  for (const id of crosswalkMeasureIds()) {
    assert.ok(MEASURE_BINDINGS[id], `crosswalk measure '${id}' exists in the bindings`);
  }
});

test("targetEventType: reports the retrieve type so the normalizer can synthesize resources", () => {
  assert.equal(targetEventType(eventOf("audiogram")), "procedure");
  assert.equal(targetEventType(eventOf("diabetes_hba1c")), "procedure"); // lab recorded as Observation, retrieved as Procedure
  assert.equal(targetEventType(eventOf("cms122")), "observation"); // value-based, stays an Observation
  assert.equal(targetEventType(eventOf("flu_vaccine")), "immunization");
  assert.equal(targetEventType({ system: "urn:nope", code: "x" }), null);
});
