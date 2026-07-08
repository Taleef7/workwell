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

test("reconcileCoding: MIE's actual dev-DB LOINC codes reconcile (LDL 2089-1, systolic BP 8480-6) (#246)", () => {
  // The dev DB records LDL as LOINC 2089-1 and BP as component 8480-6 (systolic), not the synthetic
  // assumptions (13457-7/18262-6, panel 85354-9) — crosswalk rows added after confirming the real codes.
  assert.deepEqual(systems(reconcileCoding({ system: "http://loinc.org", code: "2089-1" })), [MEASURE_BINDINGS["cholesterol_ldl"]!.event.valueSet]);
  assert.deepEqual(systems(reconcileCoding({ system: "http://loinc.org", code: "8480-6" })), [MEASURE_BINDINGS["hypertension"]!.event.valueSet]);
  // Both are [Procedure]-retrieved recency measures → the normalizer synthesizes a Procedure from the lab.
  assert.equal(targetEventType(reconcileCoding({ system: "http://loinc.org", code: "2089-1" })[0]!), "procedure");
  assert.equal(targetEventType(reconcileCoding({ system: "http://loinc.org", code: "8480-6" })[0]!), "procedure");
});

test("reconcileCoding: multi-alternative series (Hep B) preserves the real CVX code, not the generic event code", () => {
  // Hep B's CQL matches the specific alternative codes (189 Heplisav-B, 08/43/44/45 traditional) under
  // urn:workwell:vs:hepb-vaccines — NOT the generic `hepb-vaccine`. Reconciliation must keep the CVX
  // number as the synthetic code or the series never matches (Codex P2).
  const vs = MEASURE_BINDINGS["hepatitis_b_vaccination_series"]!.event.valueSet;
  assert.deepEqual(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code: "189" }), [{ system: vs, code: "189", display: "189" }]);
  assert.deepEqual(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code: "08" }), [{ system: vs, code: "08", display: "08" }]);
  // ...while a non-alternative immunization measure (MMR) still uses its generic event code.
  assert.equal(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code: "03" })[0]?.code, MEASURE_BINDINGS["mmr"]!.event.code);
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

test("code currency (2026): active seasonal flu CVX codes reconcile to flu_vaccine, not just 141/140", () => {
  // Real WebChart flu records overwhelmingly carry modern CVX codes (high-dose 135/197, recombinant
  // 155/185, adjuvanted 168/205, quadrivalent 150/158, cell-based 171/186, trivalent 140/141/320/333).
  // Matching only 141/140 missed the vast majority — regression guard for the currency fix.
  const fluVs = MEASURE_BINDINGS["flu_vaccine"]!.event.valueSet;
  for (const code of ["141", "140", "150", "158", "171", "185", "197", "205", "168", "135", "155", "231", "320", "333", "337"]) {
    assert.deepEqual(
      systems(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code })),
      [fluVs],
      `active flu CVX ${code} should reconcile to flu_vaccine`,
    );
  }
});

test("code currency (2026): active adult Td CVX codes (09/113/196) reconcile — the inactive 139 is no longer the only Td code", () => {
  const immzVs = MEASURE_BINDINGS["adult_immunization"]!.event.valueSet;
  // 115 (Tdap) was already covered; the fix adds the ACTIVE Td codes (09/113/196). 139 (Td unspecified)
  // is INACTIVE — kept as a read-only crosswalk row for legacy records, but no longer the sole Td path.
  for (const code of ["115", "09", "113", "196", "139"]) {
    assert.deepEqual(
      systems(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code })),
      [immzVs],
      `Td/Tdap CVX ${code} should reconcile to adult_immunization`,
    );
  }
});

test("code currency: an MMRV dose (CVX 94) counts toward BOTH mmr AND varicella immunity", () => {
  const mmrVs = MEASURE_BINDINGS["mmr"]!.event.valueSet;
  const varVs = MEASURE_BINDINGS["varicella"]!.event.valueSet;
  assert.deepEqual(systems(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code: "94" })), [mmrVs, varVs].sort());
  // Plain varicella (CVX 21) still reconciles to varicella only.
  assert.deepEqual(systems(reconcileCoding({ system: "http://hl7.org/fhir/sid/cvx", code: "21" })), [varVs]);
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
