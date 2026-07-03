/**
 * E12 PR-2: WebChart FHIR bundle normalization.
 *   node --import tsx --test src/engine/ingress/webchart/normalize.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWebChartBundle } from "./normalize.ts";
import { MEASURE_BINDINGS } from "../../synthetic/measure-bindings.ts";

type AnyRec = Record<string, any>;
const codings = (r: AnyRec, field: "code" | "vaccineCode"): AnyRec[] => r[field]?.coding ?? [];

test("normalizeWebChartBundle: a FHIR searchset/collection Bundle → the engine collection shape", () => {
  const raw = {
    resourceType: "Bundle",
    type: "searchset",
    entry: [{ resource: { resourceType: "Patient", id: "p1" } }],
  };
  const out = normalizeWebChartBundle(raw);
  assert.equal(out.resourceType, "Bundle");
  assert.equal(out.type, "collection");
  assert.equal(out.entry.length, 1);
  assert.equal((out.entry[0]!.resource as AnyRec).resourceType, "Patient");
});

test("normalizeWebChartBundle: reconciles a Procedure's real CPT (adds the synthetic coding)", () => {
  const raw = {
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Procedure",
          code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "92557" }] },
        },
      },
    ],
  };
  const proc = normalizeWebChartBundle(raw).entry[0]!.resource as AnyRec;
  const cs = codings(proc, "code");
  assert.equal(cs.length, 2);
  assert.ok(cs.some((c) => c.code === MEASURE_BINDINGS["audiogram"]!.event.code));
});

test("normalizeWebChartBundle: reconciles an Immunization's vaccineCode (CVX)", () => {
  const raw = {
    resourceType: "Bundle",
    entry: [
      { resource: { resourceType: "Immunization", vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "141" }] } } },
    ],
  };
  const imm = normalizeWebChartBundle(raw).entry[0]!.resource as AnyRec;
  const cs = codings(imm, "vaccineCode");
  assert.equal(cs.length, 2);
  assert.ok(cs.some((c) => c.code === MEASURE_BINDINGS["flu_vaccine"]!.event.code));
});

test("normalizeWebChartBundle: accepts a bare resource array and a single resource", () => {
  assert.equal(normalizeWebChartBundle([{ resourceType: "Patient", id: "p1" }]).entry.length, 1);
  assert.equal(normalizeWebChartBundle({ resourceType: "Patient", id: "p1" }).entry.length, 1);
});

test("normalizeWebChartBundle: empty / garbage payload → empty bundle, never throws", () => {
  assert.deepEqual(normalizeWebChartBundle(undefined).entry, []);
  assert.deepEqual(normalizeWebChartBundle({}).entry, []);
  assert.deepEqual(normalizeWebChartBundle("nonsense").entry, []);
  assert.deepEqual(normalizeWebChartBundle({ resourceType: "Bundle" }).entry, []); // no entry array
});

test("normalizeWebChartBundle: a resource with no matchable code passes through untouched", () => {
  const raw = { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation", code: { coding: [{ system: "http://loinc.org", code: "99999-9" }] } } }] };
  const out = normalizeWebChartBundle(raw);
  assert.equal(out.entry.length, 1); // no synthesis for an unmapped code
  assert.equal(codings(out.entry[0]!.resource as AnyRec, "code").length, 1); // unchanged
});

test("normalizeWebChartBundle: a lab Observation for a Procedure-retrieved measure → synthesizes a dated Procedure", () => {
  // WebChart records HbA1c as an Observation; diabetes_hba1c's CQL retrieves [Procedure]. The
  // normalizer must emit a synthesized Procedure carrying the diabetes_hba1c coding + the lab date, so
  // the recency measure can match — while cms122 ([Observation]) matches the Observation itself.
  const raw = {
    resourceType: "Bundle",
    entry: [
      {
        resource: {
          resourceType: "Observation",
          subject: { reference: "Patient/p1" },
          effectiveDateTime: "2026-05-01T00:00:00Z",
          code: { coding: [{ system: "http://loinc.org", code: "4548-4" }] },
          valueQuantity: { value: 6.5, unit: "%" },
        },
      },
    ],
  };
  const out = normalizeWebChartBundle(raw).entry.map((e) => e.resource as AnyRec);
  const obs = out.find((r) => r.resourceType === "Observation")!;
  const proc = out.find((r) => r.resourceType === "Procedure")!;
  assert.ok(obs && proc, "both the Observation and a synthesized Procedure are present");
  // The Observation keeps its value + carries the cms122 ([Observation]) coding.
  assert.ok(codings(obs, "code").some((c) => c.code === MEASURE_BINDINGS["cms122"]!.event.code));
  assert.equal(obs.valueQuantity.value, 6.5);
  // The synthesized Procedure carries the diabetes_hba1c ([Procedure]) coding, the lab date, subject, and provenance.
  assert.equal(proc.status, "completed");
  assert.equal(proc.performedDateTime, "2026-05-01T00:00:00Z");
  assert.deepEqual(proc.subject, { reference: "Patient/p1" });
  assert.equal(proc.meta.tag[0].code, "derived-from-observation");
  assert.ok(codings(proc, "code").some((c) => c.code === MEASURE_BINDINGS["diabetes_hba1c"]!.event.code));
});

test("normalizeWebChartBundle: does not mutate its input", () => {
  const raw = {
    resourceType: "Bundle",
    entry: [{ resource: { resourceType: "Procedure", code: { coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "92557" }] } } }],
  };
  const snapshot = JSON.stringify(raw);
  normalizeWebChartBundle(raw);
  assert.equal(JSON.stringify(raw), snapshot, "the caller's payload is untouched");
});
