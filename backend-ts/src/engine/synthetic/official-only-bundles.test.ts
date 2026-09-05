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
      const resources = b.entry.map((x) => x.resource as { resourceType: string; meta?: { profile?: string[] } });
      const types = resources.map((r) => r.resourceType);
      assert.ok(types.includes("Patient") && types.includes("Encounter"), `${id}/${target}: ${types.join(",")}`);
      // The PROFILE and the encounter CODE, not just the resource type. Both are load-bearing for
      // retrieval: the official artifacts retrieve through QI-Core profiles and a coded qualifying
      // encounter, so stripping either leaves a bundle that still has "a Patient and an Encounter"
      // and puts nobody in the initial population. Asserting the type alone cannot see that.
      const patient = resources.find((r) => r.resourceType === "Patient")!;
      assert.ok(
        patient.meta?.profile?.some((p) => p.endsWith("/qicore-patient")),
        `${id}/${target}: Patient is not QI-Core stamped (${JSON.stringify(patient.meta)})`,
      );
      const encounter = b.entry
        .map((x) => x.resource as { resourceType: string; meta?: { profile?: string[] }; type?: Array<{ coding: Array<{ code: string }> }> })
        .find((r) => r.resourceType === "Encounter")!;
      assert.ok(
        encounter.meta?.profile?.some((p) => p.endsWith("/qicore-encounter")),
        `${id}/${target}: Encounter is not QI-Core stamped`,
      );
      assert.ok(
        encounter.type?.[0]?.coding?.some((c) => c.code === "99213"),
        `${id}/${target}: the qualifying office visit carries no code`,
      );
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
  // ...and the RESULT, which is what the test name claims and what decides the numerator. Asserting
  // only the instrument code passes just as happily on a POSITIVE screen, which is the opposite
  // measure outcome.
  const value = obs.valueCodeableConcept as { coding: Array<{ code: string }> } | undefined;
  const resultCodes = value?.coding?.map((c) => c.code) ?? [];
  assert.ok(
    resultCodes.includes("428171000124102"),
    `expected the NEGATIVE depression-screen result, got ${resultCodes.join(",") || "no valueCodeableConcept"}`,
  );
  assert.ok(!resultCodes.includes("428181000124104"), "a COMPLIANT cms2 subject must not carry a positive screen");
  // The screening Observation carries the screening-assessment profile, NOT the generic clinical-result
  // one — the artifact retrieves on it (see this module's header).
  const meta = obs.meta as { profile?: string[] } | undefined;
  assert.ok(
    meta?.profile?.some((p) => p.includes("screening-assessment")),
    `cms2 screening Observation profile: ${JSON.stringify(meta)}`,
  );
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
