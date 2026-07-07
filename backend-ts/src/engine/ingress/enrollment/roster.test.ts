/**
 * OH enrollment roster + enrollment-Condition stamping (WebChart dev-DB proof, PR-1).
 *   node --import tsx --test src/engine/ingress/enrollment/roster.test.ts
 *
 * The measures gate on a program-enrollment Condition (urn:workwell:vs:*) that WebChart doesn't carry
 * (it's OH program membership, not clinical coding), so a real WebChart bundle alone reads MISSING_DATA.
 * These tests prove: (1) stampEnrollment adds exactly that Condition from MEASURE_BINDINGS, is idempotent,
 * and no-ops safely; (2) evaluateSourceWithRoster wires it into the real WebChart ingress so an enrolled
 * subject with a real-LOINC lab evaluates to a real bucket while a not-enrolled control stays MISSING_DATA.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FhirBundle } from "../../synthetic/fhir-bundle-builder.ts";
import { webChartDataSource, jsonBucketDataSource, evaluateSource } from "../data-source.ts";
import { fixtureWebChartClient } from "../webchart/webchart-client.ts";
import { parseEnrollmentRoster, isEnrolled, stampEnrollment, evaluateSourceWithRoster } from "./roster.ts";

const EVAL = "2026-06-12";

/** A minimal engine-shape bundle: a Patient + a synthetic-coded audiogram Procedure, NO enrollment. */
function bundleWithProcedure(subjectId: string, performedDateTime: string): FhirBundle {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: subjectId } },
      {
        resource: {
          resourceType: "Procedure",
          status: "completed",
          subject: { reference: `Patient/${subjectId}` },
          code: { coding: [{ system: "urn:workwell:vs:audiogram-procedures", code: "audiogram-procedure" }] },
          performedDateTime,
        },
      },
    ],
  };
}

/** A RAW WebChart-shaped HbA1c bundle (real LOINC, NO enrollment Condition) — the dev-DB reality. */
function webchartHba1c(subjectId: string, effectiveDateTime: string): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: subjectId } },
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          subject: { reference: `Patient/${subjectId}` },
          effectiveDateTime,
          code: { coding: [{ system: "http://loinc.org", code: "4548-4" }] },
          valueQuantity: { value: 6.5, unit: "%" },
        },
      },
    ],
  };
}

const conditions = (b: FhirBundle) =>
  b.entry.map((e) => e.resource as Record<string, unknown>).filter((r) => r.resourceType === "Condition");

test("stampEnrollment: adds the measure's enrollment Condition for an enrolled subject", () => {
  const roster = parseEnrollmentRoster({ "wc-1": ["audiogram"] });
  const stamped = stampEnrollment(bundleWithProcedure("wc-1", "2026-03-01T00:00:00"), "audiogram", roster);
  const conds = conditions(stamped);
  assert.equal(conds.length, 1);
  const cond = conds[0]!;
  assert.equal(cond.id, "wc-1-hearing-enrollment");
  assert.deepEqual(cond.subject, { reference: "Patient/wc-1" });
  assert.deepEqual(cond.clinicalStatus, { coding: [{ code: "active" }] });
  assert.deepEqual(cond.verificationStatus, {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }],
  });
  assert.deepEqual(cond.code, {
    coding: [{ system: "urn:workwell:vs:hearing-enrollment", code: "hearing-enrollment", display: "hearing-enrollment" }],
  });
});

test("stampEnrollment: is idempotent — stamping twice equals stamping once", () => {
  const roster = parseEnrollmentRoster({ "wc-1": ["audiogram"] });
  const once = stampEnrollment(bundleWithProcedure("wc-1", "2026-03-01T00:00:00"), "audiogram", roster);
  const twice = stampEnrollment(once, "audiogram", roster);
  assert.deepEqual(twice, once);
  assert.equal(conditions(twice).length, 1);
});

test("stampEnrollment: no-ops when the subject is not enrolled in that measure", () => {
  const roster = parseEnrollmentRoster({ "wc-1": ["hazwoper"] }); // enrolled elsewhere, not audiogram
  const input = bundleWithProcedure("wc-1", "2026-03-01T00:00:00");
  const out = stampEnrollment(input, "audiogram", roster);
  assert.equal(conditions(out).length, 0);
});

test("stampEnrollment: no-ops on an unknown measure or a bundle with no Patient", () => {
  const roster = parseEnrollmentRoster({ "wc-1": ["audiogram"] });
  assert.equal(conditions(stampEnrollment(bundleWithProcedure("wc-1", "2026-03-01T00:00:00"), "not_a_measure", roster)).length, 0);
  const noPatient: FhirBundle = { resourceType: "Bundle", type: "collection", entry: [] };
  assert.deepEqual(stampEnrollment(noPatient, "audiogram", roster), noPatient);
});

test("parseEnrollmentRoster + isEnrolled: reflects the record and tolerates junk", () => {
  const roster = parseEnrollmentRoster({ "wc-1": ["audiogram", "hazwoper"], "wc-2": ["diabetes_hba1c"] });
  assert.equal(isEnrolled(roster, "wc-1", "audiogram"), true);
  assert.equal(isEnrolled(roster, "wc-1", "diabetes_hba1c"), false);
  assert.equal(isEnrolled(roster, "wc-2", "diabetes_hba1c"), true);
  assert.equal(isEnrolled(roster, "nobody", "audiogram"), false);
  // Junk shapes are ignored, not thrown.
  assert.equal(isEnrolled(parseEnrollmentRoster(undefined), "wc-1", "audiogram"), false);
  assert.equal(isEnrolled(parseEnrollmentRoster({ "wc-1": "audiogram" }), "wc-1", "audiogram"), false);
});

test("evaluateSourceWithRoster: an enrolled subject's real-LOINC lab evaluates to a real bucket", async () => {
  const wc = webchartHba1c("wc-2", "2026-05-01T00:00:00"); // ~42d before EVAL → within the 180d window
  const src = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient([wc]));

  // Control — no roster: WebChart data has no enrollment Condition, so the gate fails → MISSING_DATA.
  const control = await evaluateSource(
    webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient([structuredClone(wc)])),
    "diabetes_hba1c",
    { evaluationDate: EVAL },
  );
  assert.equal(control.results[0]?.outcome?.outcome, "MISSING_DATA");

  // Treatment — the roster stamps enrollment → gate passes → recent lab → COMPLIANT.
  const roster = parseEnrollmentRoster({ "wc-2": ["diabetes_hba1c"] });
  const res = await evaluateSourceWithRoster(src, "diabetes_hba1c", roster, { evaluationDate: EVAL });
  assert.equal(res.total, 1);
  assert.equal(res.succeeded, 1);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
});

test("evaluateSourceWithRoster: enrollment applies only to the listed subject", async () => {
  const wc = webchartHba1c("wc-2", "2026-05-01T00:00:00");
  const src = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient([wc]));
  const roster = parseEnrollmentRoster({ "someone-else": ["diabetes_hba1c"] }); // wc-2 not listed
  const res = await evaluateSourceWithRoster(src, "diabetes_hba1c", roster, { evaluationDate: EVAL });
  assert.equal(res.results[0]?.outcome?.outcome, "MISSING_DATA");
});

test("evaluateSourceWithRoster: fails fast on an unknown measure (mirrors evaluateBatch)", async () => {
  const roster = parseEnrollmentRoster({ "wc-2": ["diabetes_hba1c"] });
  await assert.rejects(
    () => evaluateSourceWithRoster(jsonBucketDataSource([]), "not_a_measure", roster, { evaluationDate: EVAL }),
    /unknown measure 'not_a_measure'/,
  );
});
