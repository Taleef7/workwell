/**
 * #89 / E3.1 — FHIR MeasureReport builders: population reconciliation with outcomes
 * + structural conformance to FHIR R4 (JVM-free). Pure functions, no DB.
 *   node --import tsx --test src/fhir/measure-report.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countPopulations,
  buildSummaryMeasureReport,
  buildIndividualMeasureReport,
  buildMeasureReportBundle,
} from "./measure-report.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const run: RunRecord = {
  id: "run-1", status: "COMPLETED", scopeType: "MEASURE", scopeId: "mv-1", triggeredBy: "manual", site: null,
  requestedScope: { measureId: "audiogram" }, startedAt: "2026-06-12T00:00:00.000Z", completedAt: "2026-06-12T00:05:00.000Z",
  measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
};
const POP = "http://terminology.hl7.org/CodeSystem/measure-population";
let n = 0;
const oc = (status: string): OutcomeRecord => ({
  id: `o${++n}`, runId: "run-1", subjectId: `emp-${n}`, measureId: "audiogram",
  evaluationPeriod: "2026-06-12", status, evidence: {}, evaluatedAt: "2026-06-12T00:01:00.000Z",
});
const outcomes: OutcomeRecord[] = [
  ...Array.from({ length: 6 }, () => oc("COMPLIANT")),
  oc("DUE_SOON"), oc("OVERDUE"), oc("MISSING_DATA"), oc("EXCLUDED"),
];
const countOf = (mr: { group: Array<{ population: Array<{ code: { coding: Array<{ code: string }> }; count: number }> }> }, code: string): number => {
  const found = mr.group[0]!.population.find((p) => p.code.coding[0]?.code === code);
  assert.ok(found, `population ${code} not found`);
  return found.count;
};

test("countPopulations: IPP/DENEX/DENOM/NUMER from buckets", () => {
  assert.deepEqual(countPopulations(outcomes), { ipp: 10, denex: 1, denom: 9, numer: 6 });
});

test("summary: counts + measureScore reconcile; conformant", () => {
  const mr = buildSummaryMeasureReport(run, "audiogram", outcomes);
  assert.equal(mr.resourceType, "MeasureReport");
  assert.equal(mr.status, "complete");
  assert.equal(mr.type, "summary");
  assert.equal(mr.measure, "urn:workwell:measure:audiogram");
  assert.equal(mr.period.start, run.measurementPeriodStart);
  assert.equal(mr.period.end, run.measurementPeriodEnd);
  assert.equal(countOf(mr, "initial-population"), 10);
  assert.equal(countOf(mr, "denominator-exclusion"), 1);
  assert.equal(countOf(mr, "denominator"), 9);
  assert.equal(countOf(mr, "numerator"), 6);
  assert.ok(Math.abs(mr.group[0]!.measureScore!.value - 6 / 9) < 1e-9);
  for (const p of mr.group[0]!.population) assert.equal(p.code.coding[0]!.system, POP);
});

test("summary: all-excluded → DENOM 0, measureScore omitted (no divide-by-zero)", () => {
  const mr = buildSummaryMeasureReport(run, "audiogram", [oc("EXCLUDED"), oc("EXCLUDED")]);
  assert.equal(countOf(mr, "denominator"), 0);
  assert.equal(mr.group[0]!.measureScore, undefined);
});

test("individual: subject ref + 0/1 membership; no measureScore", () => {
  const compliant = buildIndividualMeasureReport(oc("COMPLIANT"), run, "audiogram");
  assert.equal(compliant.type, "individual");
  assert.match(compliant.subject!.reference, /^Patient\/emp-/);
  assert.equal(compliant.group[0]!.measureScore, undefined);
  assert.equal(countOf(compliant, "numerator"), 1);
  assert.equal(countOf(compliant, "denominator"), 1);
  assert.equal(countOf(compliant, "denominator-exclusion"), 0);
  const excluded = buildIndividualMeasureReport(oc("EXCLUDED"), run, "audiogram");
  assert.equal(countOf(excluded, "denominator-exclusion"), 1);
  assert.equal(countOf(excluded, "denominator"), 0);
  assert.equal(countOf(excluded, "numerator"), 0);
});

test("bundle: summary + one individual per outcome; individuals sum to summary", () => {
  const bundle = buildMeasureReportBundle(run, "audiogram", outcomes);
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "collection");
  assert.equal(bundle.entry.length, 1 + outcomes.length);
  assert.equal(bundle.entry[0]!.resource.type, "summary");
  const individuals = bundle.entry.slice(1).map((e) => e.resource);
  const sum = (code: string) => individuals.reduce((acc, mr) => acc + countOf(mr, code), 0);
  assert.equal(sum("initial-population"), 10);
  assert.equal(sum("numerator"), 6);
  assert.equal(sum("denominator"), 9);
  assert.equal(sum("denominator-exclusion"), 1);
});
