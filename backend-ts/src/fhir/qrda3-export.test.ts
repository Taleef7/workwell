/**
 * #91 / E3.3 — QRDA III stub: well-formed + structurally representative + counts reconcile.
 *   node --import tsx --test src/fhir/qrda3-export.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQrda3Document } from "./qrda3-export.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const run: RunRecord = {
  id: "run-1", status: "COMPLETED", scopeType: "MEASURE", scopeId: "mv-1", site: null,
  requestedScope: { measureId: "audiogram" }, startedAt: "2026-06-12T00:00:00.000Z", completedAt: "2026-06-12T00:05:00.000Z",
  measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
};
let n = 0;
const oc = (status: string): OutcomeRecord => ({
  id: `o${++n}`, runId: "run-1", subjectId: `emp-${n}`, measureId: "audiogram",
  evaluationPeriod: "2026-06-12", status, evidence: {}, evaluatedAt: "2026-06-12T00:01:00.000Z",
});
const outcomes: OutcomeRecord[] = [
  ...Array.from({ length: 6 }, () => oc("COMPLIANT")),
  oc("DUE_SOON"), oc("OVERDUE"), oc("MISSING_DATA"), oc("EXCLUDED"),
]; // IPP 10, DENEX 1, DENOM 9, NUMER 6

test("buildQrda3Document: well-formed + structurally representative", () => {
  const xml = buildQrda3Document(run, "audiogram", outcomes);
  assert.ok(xml.startsWith("<?xml"), "has XML declaration");
  assert.match(xml, /<ClinicalDocument[\s\S]*<\/ClinicalDocument>\s*$/, "ClinicalDocument root, balanced");
  assert.ok(xml.includes('root="2.16.840.1.113883.10.20.27.1.1"'), "QRDA III templateId");
  assert.ok(xml.includes('code="55184-6"'), "QRDA III document code (LOINC)");
  assert.ok(xml.includes('root="2.16.840.1.113883.10.20.27.2.1"'), "Measure Section templateId");
  assert.ok(xml.includes('extension="audiogram"'), "measure reference");
  assert.ok(xml.includes('value="20250612000000"') && xml.includes('value="20260612000000"'), "reporting period low/high");
  assert.equal((xml.match(/</g) || []).length, (xml.match(/>/g) || []).length);
});

test("buildQrda3Document: aggregate counts reconcile with countPopulations", () => {
  const xml = buildQrda3Document(run, "audiogram", outcomes);
  assert.ok(xml.includes('value="10"'), "IPP 10");
  assert.ok(xml.includes('value="9"'), "DENOM 9");
  assert.ok(xml.includes('value="6"'), "NUMER 6");
  assert.ok(xml.includes('value="1"'), "DENEX 1");
  assert.ok(xml.includes('value="0.6667"'), "performance rate 6/9");
});

test("buildQrda3Document: all-excluded → performance rate 0, no divide-by-zero", () => {
  const xml = buildQrda3Document(run, "audiogram", [oc("EXCLUDED"), oc("EXCLUDED")]);
  assert.ok(xml.includes('value="0"'), "perf rate 0 when DENOM 0");
  assert.ok(!xml.includes("NaN") && !xml.includes("Infinity"));
});
