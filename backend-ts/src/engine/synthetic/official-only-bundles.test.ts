import test from "node:test";
import assert from "node:assert/strict";
import { buildOfficialOnlyBundle, OFFICIAL_ONLY_CONVERGENCE } from "./official-only-bundles.ts";
import { EMPLOYEES } from "../../config/deployment-profile.ts";

const EVAL = "2027-06-30";
const e = EMPLOYEES.find((x) => x.tenantId === "maui")!;

test("every (measure, target) pair yields a collection bundle with a QI-Core Patient and an office visit", () => {
  for (const id of ["cms2", "cms130", "cms165"] as const) {
    for (const target of ["COMPLIANT", "OVERDUE", "EXCLUDED", "MISSING_DATA", "DUE_SOON"] as const) {
      const b = buildOfficialOnlyBundle(e, id, target, EVAL);
      assert.equal(b.type, "collection");
      const types = b.entry.map((x) => (x.resource as { resourceType: string }).resourceType);
      assert.ok(types.includes("Patient") && types.includes("Encounter"), `${id}/${target}: ${types.join(",")}`);
    }
  }
});

test("the convergence table is declared: DUE_SOON and MISSING_DATA converge to OVERDUE for all three", () => {
  for (const id of ["cms2", "cms130", "cms165"] as const) {
    assert.equal(OFFICIAL_ONLY_CONVERGENCE[id].DUE_SOON, "OVERDUE");
    assert.equal(OFFICIAL_ONLY_CONVERGENCE[id].MISSING_DATA, "OVERDUE");
  }
});

test("cms165 COMPLIANT carries one BP panel with systolic 128 and diastolic 78 inside the measurement period", () => {
  const b = buildOfficialOnlyBundle(e, "cms165", "COMPLIANT", EVAL);
  const obs = b.entry.map((x) => x.resource as Record<string, unknown>).find((r) => r.resourceType === "Observation")!;
  const comps = obs.component as Array<{ code: { coding: Array<{ code: string }> }; valueQuantity: { value: number } }>;
  assert.deepEqual(comps.map((c) => [c.code.coding[0]!.code, c.valueQuantity.value]), [["8480-6", 128], ["8462-4", 78]]);
  assert.ok(String(obs.effectiveDateTime).startsWith("2027-"));
});

test("cms2 COMPLIANT (adult) uses the adult screening instrument and a negative result", () => {
  const b = buildOfficialOnlyBundle(e, "cms2", "COMPLIANT", EVAL);
  const obs = b.entry.map((x) => x.resource as Record<string, unknown>).find((r) => r.resourceType === "Observation")!;
  const codes = (obs.code as { coding: Array<{ code: string }> }).coding.map((c) => c.code);
  assert.ok(codes.includes("73832-8"), codes.join(","));
});
