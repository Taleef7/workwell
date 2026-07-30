/**
 * #91 / E3.3 — QRDA III stub: well-formed + structurally representative + counts reconcile.
 *   node --import tsx --test src/fhir/qrda3-export.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQrda3Document, buildQrda3DocumentFromCounts } from "./qrda3-export.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const run: RunRecord = {
  id: "run-1", status: "COMPLETED", scopeType: "MEASURE", scopeId: "mv-1", triggeredBy: "manual", site: null,
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
]; // IPP 10, DENEX 1, DENOM label count 10, effective denominator 9, NUMER 6

const aggregateCount = (xml: string, code: string): number => {
  const match = xml.match(new RegExp(`code="${code}"[\\s\\S]*?xsi:type="INT" value="(\\d+)"`));
  assert.ok(match, `${code} aggregate count`);
  return Number(match[1]);
};

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
  assert.equal(aggregateCount(xml, "IPOP"), 10);
  assert.equal(aggregateCount(xml, "DENOM"), 10, "DENOM membership count includes DENEX");
  assert.equal(aggregateCount(xml, "NUMER"), 6);
  assert.equal(aggregateCount(xml, "DENEX"), 1);
  assert.ok(xml.includes('value="0.6667"'), "performance rate 6/(10-1)");
});

test("buildQrda3Document: all-excluded → performance rate 0, no divide-by-zero", () => {
  const xml = buildQrda3Document(run, "audiogram", [oc("EXCLUDED"), oc("EXCLUDED")]);
  assert.ok(xml.includes('xsi:type="REAL" value="0"'), "perf rate 0 when DENOM 0");
  assert.ok(!xml.includes("NaN") && !xml.includes("Infinity"));
});

test("PR-3: exceptions are absent for authored measures and emitted + scored for official ones", () => {
  const authored = { ipp: 10, denom: 10, denex: 2, numer: 4, denexcep: 0 };
  const xml = buildQrda3DocumentFromCounts(run, "audiogram", authored);
  assert.ok(!xml.includes("DENEXCEP"), "authored QRDA must stay byte-identical (no exception observation)");
  assert.ok(xml.includes('value="0.5000"'), "4 / (10-2) = 0.5000");

  const official = { ipp: 10, denom: 10, denex: 2, numer: 4, denexcep: 3 };
  const officialXml = buildQrda3DocumentFromCounts(run, "cms68", official);
  assert.ok(officialXml.includes('code="DENEXCEP"'), "official QRDA must carry the exception count");
  // Score must subtract exceptions too: 4 / (10 - 2 - 3) = 0.8000 — and must equal what the
  // MeasureReport reports for the same counts.
  assert.ok(officialXml.includes('value="0.8000"'), "exceptions must leave the effective denominator");
});

/** An outcome as the official executor persists it. */
const officialOutcome = (measureId: string): OutcomeRecord =>
  ({
    id: "o-official", runId: run.id, subjectId: "emp-1", measureId,
    evaluationPeriod: "2025-12-31", status: "COMPLIANT",
    evidence: {
      official: {
        ecqmId: "122FHIR", version: "1.0.000", engine: "fqm-execution",
        populationResults: [
          { populationType: "initial-population", result: true },
          { populationType: "denominator", result: true },
          { populationType: "numerator", result: true },
        ],
      },
    },
    evaluatedAt: "2025-12-31T00:00:00.000Z",
  }) as OutcomeRecord;

test("ADR-046: an official QRDA references the published measure by its eMeasure UUIDs", () => {
  // `manifest.cmsId` is the PUBLISHER identifier ("122FHIR") and is NOT what QRDA III references — a
  // consumer cannot resolve an organizer to a published measure version from it (Codex, #357). The
  // Measure resource carries the two identifiers that do resolve, typed by `artifact-identifier-type`.
  const xml = buildQrda3Document(run, "cms122", [officialOutcome("cms122")]);

  // version-specific → the eMeasure Identifier root; names the exact version whose logic scored this.
  assert.match(xml, /<id root="2\.16\.840\.1\.113883\.4\.738" extension="2ea22cb2-9bcc-4ca6-b2f2-68fc964365ad"\/>/);
  // version-independent → setId; the measure's identity across versions.
  assert.match(xml, /<setId root="f04ee808-8ece-4936-8b26-fafa462e1594"\/>/);
  assert.match(xml, /<versionNumber value="1\.0\.000"\/>/);

  assert.ok(!xml.includes('extension="122FHIR"'), "the publisher id must not stand in for the eMeasure id");
  assert.ok(!xml.includes('root="urn:workwell:measure"'), "an official export must not claim WorkWell's urn");
});

test("ADR-046: an AUTHORED QRDA is unchanged — WorkWell's urn, no eMeasure identifiers", () => {
  const xml = buildQrda3Document(run, "cms122", [
    { ...officialOutcome("cms122"), evidence: {} } as OutcomeRecord,
  ]);
  assert.match(xml, /<id root="urn:workwell:measure" extension="cms122"\/>/);
  assert.ok(!xml.includes("2.16.840.1.113883.4.738"), "no official identity over authored counts");
  assert.ok(!xml.includes("<setId"), "no setId on the authored path");
});
