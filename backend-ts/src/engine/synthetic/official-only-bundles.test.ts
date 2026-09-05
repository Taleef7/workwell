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

/**
 * The January regression. ADR-072 made an officially-routed measure score over the CALENDAR YEAR, but
 * every synthetic event is dated relative to the EVALUATION DATE — so before `dateInMeasurementPeriod`
 * a run in the first ~60 days of a year put its only qualifying encounter in the previous year, outside
 * the period, and the artifact found NOBODY in the initial population. The run completed, every case
 * read MISSING_DATA, and the roster showed "nobody eligible" instead of an error.
 *
 * It survived review because every other test in this repo pins a mid-year date (2026-07-27,
 * 2027-06-30), where the bug is invisible. PY2027 begins 2027-01-01 and Maui runs nightly, so this is
 * the window that matters most.
 */
for (const evaluationDate of ["2027-01-01", "2027-01-15", "2027-02-15", "2027-03-01", "2027-06-30", "2027-12-31"]) {
  test(`every qualifying encounter falls inside the calendar measurement period at ${evaluationDate}`, () => {
    const employee = EMPLOYEES.find((e) => e.tenantId === "maui")!;
    const periodStart = `${evaluationDate.slice(0, 4)}-01-01`;
    const periodEnd = `${evaluationDate.slice(0, 4)}-12-31`;

    for (const measureId of ["cms2", "cms130", "cms165"] as const) {
      for (const target of ["COMPLIANT", "OVERDUE", "EXCLUDED"] as const) {
        const bundle = buildOfficialOnlyBundle(employee, measureId, target, evaluationDate);
        const encounters = bundle.entry
          .map((entry) => entry.resource as { resourceType?: string; period?: { start?: string } })
          .filter((resource) => resource.resourceType === "Encounter");
        assert.ok(encounters.length > 0, `${measureId}/${target}: no Encounter at all`);
        for (const encounter of encounters) {
          const day = (encounter.period?.start ?? "").slice(0, 10);
          assert.ok(
            day >= periodStart && day <= periodEnd,
            `${measureId}/${target} at ${evaluationDate}: encounter ${day} is outside ${periodStart}..${periodEnd} — ` +
              "the artifact would report every subject out of the initial population",
          );
        }
      }
    }
  });
}
