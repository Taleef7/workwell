/**
 * QRDA Category I export (M-B).
 *
 * The most important test here is the boring one: the document PARSES. Every other assertion is about
 * content, and content assertions on a string that is not well-formed XML would pass happily while the
 * artifact is unusable — this file builds CDA by hand, so balance is a property to check rather than a
 * property of the tooling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQrda1Document, buildQrda1Documents } from "./qrda1-export.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";


/**
 * A dependency-free well-formedness check: tags balance and nest correctly, and no raw `<`/`&` survives
 * in text. CLAUDE.md forbids new dependencies without approval, so this stands in for an XML parser —
 * and it is stronger than the regex the Category III test uses, which only checks the root element.
 *
 * Returns null when well-formed, else the first problem.
 */
function xmlProblem(xml: string): string | null {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  while ((m = tag.exec(xml)) !== null) {
    const text = xml.slice(lastEnd, m.index);
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text)) return `unescaped & in text near ${text.slice(0, 40)}`;
    lastEnd = tag.lastIndex;
    const [, closing, name, attrs, selfClose] = m;
    if (m[0].startsWith("<?") || m[0].startsWith("<!")) continue;
    if (/&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(attrs ?? "")) return `unescaped & in attributes of <${name}>`;
    if (closing) {
      const open = stack.pop();
      if (open !== name) return `</${name}> closes <${open ?? "nothing"}>`;
    } else if (!selfClose) {
      stack.push(name!);
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

/**
 * The reported count for one population code — extracted from that population's own component block
 * rather than by a windowed regex, so a layout change cannot make the assertion silently match the
 * NEXT population's value.
 */
function populationCount(xml: string, code: string): number | undefined {
  const block = xml.split("<component>").find((c) => c.includes(`code="${code}"`));
  const m = block ? /<value xsi:type="INT" value="(\d+)"\/>/.exec(block) : null;
  return m ? Number(m[1]) : undefined;
}

const run = {
  id: "run-qrda1",
  measurementPeriodStart: "2025-01-01T00:00:00.000Z",
  measurementPeriodEnd: "2025-12-31T00:00:00.000Z",
} as RunRecord;

const outcome = (status: string, official?: Record<string, unknown>): OutcomeRecord =>
  ({
    id: "o1", runId: run.id, subjectId: "emp-006", measureId: "cms125",
    evaluationPeriod: "2025-12-31", status,
    evidence: official ? { official } : {},
    evaluatedAt: "2025-12-31T00:00:00.000Z",
  }) as OutcomeRecord;

const officialEvidence = (numer: boolean) => ({
  ecqmId: "CMS125FHIR",
  version: "1.0.000",
  engine: "fqm-execution",
  artifactSha256: undefined,
  populationResults: [
    { populationType: "initial-population", result: true },
    { populationType: "denominator", result: true },
    { populationType: "denominator-exclusion", result: false },
    { populationType: "numerator", result: numer },
  ],
});


test("QRDA I: the document is well-formed XML", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  assert.equal(xmlProblem(xml), null, "hand-built CDA must be well-formed");
  assert.ok(xml.startsWith("<?xml"), "has an XML declaration");
  assert.match(xml, /<ClinicalDocument[\s\S]*<\/ClinicalDocument>\s*$/, "ClinicalDocument root, balanced");
  assert.match(xml, /<code code="55182-0"/, "LOINC code for a Quality Measure Report");
});

test("QRDA I: it carries the QRDA Category I template ids and a recordTarget", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  // US Realm header + QRDA Category I Report + QDM-based QRDA.
  for (const root of ["2.16.840.1.113883.10.20.22.1.1", "2.16.840.1.113883.10.20.24.1.2", "2.16.840.1.113883.10.20.24.1.3"]) {
    assert.ok(xml.includes(`<templateId root="${root}"`), root);
  }
  // Category I is PATIENT-level — the recordTarget is what distinguishes it from Category III.
  assert.match(xml, /<recordTarget>[\s\S]*?extension="emp-006"/);
});

test("QRDA I: EVERY population is reported, including the ones the subject is not in", () => {
  // A receiver must be able to tell "not in the numerator" from "the numerator was not reported".
  // Omitting false members collapses those into the same document.
  const xml = buildQrda1Document(run, "cms125", outcome("OVERDUE", officialEvidence(false)));
  for (const code of ["IPOP", "DENOM", "DENEX", "DENEXCEP", "NUMER"]) {
    assert.match(xml, new RegExp(`code="${code}"`), `${code} must be present`);
  }
  // ipp/denom true, numer false — read from official populationResults, not the workflow status.
  assert.equal(populationCount(xml, "IPOP"), 1);
  assert.equal(populationCount(xml, "DENOM"), 1);
  assert.equal(populationCount(xml, "DENEX"), 0);
  assert.equal(populationCount(xml, "NUMER"), 0);
});

test("QRDA I: membership is EVIDENCE-first — official results beat the workflow status", () => {
  // cms122 is an inverse measure: its official numerator is poor control, so a subject whose workflow
  // status is OVERDUE is IN the numerator. A status-derived document would report the opposite.
  const inverse = {
    ...outcome("OVERDUE", officialEvidence(true)),
    measureId: "cms122",
  } as OutcomeRecord;
  const xml = buildQrda1Document(run, "cms122", inverse);
  assert.equal(populationCount(xml, "NUMER"), 1, "official numerator membership wins");
});

test("QRDA I: an OFFICIAL outcome references the published eMeasure UUIDs", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT", officialEvidence(true)));
  assert.match(xml, /<id root="2\.16\.840\.1\.113883\.4\.738" extension="[0-9a-f-]{36}"\/>/);
  assert.match(xml, /<setId root="[0-9a-f-]{36}"\/>/);
  assert.match(xml, /<versionNumber value="1\.0\.000"\/>/);
  assert.ok(!xml.includes('root="urn:workwell:measure"'), "an official document must not claim WorkWell's urn");
});

test("QRDA I: an AUTHORED outcome references WorkWell's urn and no eMeasure identity", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  assert.match(xml, /<id root="urn:workwell:measure" extension="cms125"\/>/);
  assert.ok(!xml.includes("2.16.840.1.113883.4.738"), "no official identity over authored membership");
});

test("QRDA I: the Patient Data section is marked ABSENT, not faked", () => {
  // The QDM entries a receiving engine would recalculate from are not exported. A hollow section that
  // looked populated would be worse than one that says so — this is the claim STANDARDS_CONFORMANCE
  // records as the gap.
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  assert.match(xml, /<section nullFlavor="NI">[\s\S]{0,300}?2\.16\.840\.1\.113883\.10\.20\.24\.2\.1/);
  assert.match(xml, /QDM patient data elements are not exported/);
});

test("QRDA I: the reporting period is the RUN's measurement period", () => {
  const xml = buildQrda1Document(run, "cms125", outcome("COMPLIANT"));
  assert.match(xml, /<low value="20250101\d{6}"\/>/);
  assert.match(xml, /<high value="20251231\d{6}"\/>/);
});

test("QRDA I: one document per subject, each parseable and named by its subject", () => {
  const docs = buildQrda1Documents(run, "cms125", [
    outcome("COMPLIANT"),
    { ...outcome("OVERDUE"), id: "o2", subjectId: "emp-007" } as OutcomeRecord,
  ]);
  assert.deepEqual(docs.map((d) => d.subjectId), ["emp-006", "emp-007"]);
  for (const d of docs) assert.equal(xmlProblem(d.xml), null, `${d.subjectId} must be well-formed`);
  assert.notEqual(docs[0]!.xml, docs[1]!.xml, "documents must differ by subject");
});

test("QRDA I: XML special characters in a subject id cannot break the document", () => {
  const nasty = { ...outcome("COMPLIANT"), subjectId: 'emp<&"006' } as OutcomeRecord;
  const xml = buildQrda1Document(run, "cms125", nasty);
  assert.equal(xmlProblem(xml), null, "escaping must hold for hostile input");
  assert.ok(!xml.includes('emp<&"006'), "raw special characters must not reach the document");
});
