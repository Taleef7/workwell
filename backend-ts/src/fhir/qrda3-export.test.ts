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

/**
 * Anchors on the Measure Data observation's **CD value** (`<value xsi:type="CD" code="NUMER" …/>`), not
 * on any `code="NUMER"`.
 *
 * It used to match the latter, and that became ambiguous when the Performance Rate observation started
 * carrying the `reference`/`externalObservation` the IG requires — which names the numerator it rates
 * with `<code code="NUMER" …/>`. Since that observation is emitted BEFORE the populations, a lazy scan
 * from the first `code="NUMER"` ran on to the next `INT` value it found, which belonged to IPOP: the
 * helper reported 10 for a numerator of 6. The document was correct; the locator was not.
 */
const aggregateCount = (xml: string, code: string): number => {
  const match = xml.match(new RegExp(`xsi:type="CD" code="${code}"[\\s\\S]*?xsi:type="INT" value="(\\d+)"`));
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
  // An INT, not the version string — see qrda-common.ts `cdaVersionNumber` and evidence 2026-08-02 §5.2.
  assert.match(xml, /<versionNumber value="1"\/>/);
  assert.ok(!xml.includes('value="1.0.000"'), "the version STRING is not a valid CDA INT");

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

/*
 * ---------------------------------------------------------------------------------------------------
 * QRDA III conformance — pinned because CI runs neither CVU+ nor a schema validator.
 *
 * Each assertion corresponds to a finding Cypress CVU+ 7.5.1 reported against the HL7 base ruler on
 * 2026-08-02 (`docs/evidence/CVU_VALIDATION_RUN_2026-08-02.md` §10), all of which are now 0.
 * ---------------------------------------------------------------------------------------------------
 */

test("QRDA III: the CDA header carries recordTarget, author and custodian (all SHALL)", () => {
  const xml = buildQrda3Document(run, "audiogram", outcomes);
  // CONF:4484-17212 / 18156+18158 / 17213. recordTarget's id is NULLED, not invented: CDA requires a
  // patient identifier and an aggregate report is about a population.
  assert.match(xml, /<recordTarget>\s*<patientRole>\s*<id nullFlavor="NA"\/>/, "recordTarget, id nulled");
  assert.match(xml, /<author>\s*<time value="\d{14}"\/>[\s\S]*?<assignedAuthoringDevice>/, "author + time");
  assert.match(xml, /<assignedAuthor>[\s\S]*?<representedOrganization>/, "CONF:4484-18163");
  assert.match(xml, /<custodian>[\s\S]*<representedCustodianOrganization>/, "custodian");
  assert.ok(!xml.includes("<assignedPerson>"), "no person is named — same stance as Category I");
});

test("QRDA III: Measure Data (…27.3.5) WRAPS Aggregate Count (…27.3.3), not the reverse", () => {
  // The defect this pins is subtle and was worth 12 findings per document: `…27.3.3` IS the Aggregate
  // Count template and used to sit on the OUTER observation, so the validator applied Aggregate Count's
  // rules to it (missing MSRAGG / methodCode / INT) while the inner element that satisfied them was
  // validated as nothing at all. A document can carry every required element and still fail every rule
  // about them, if they hang off the wrong template.
  const xml = buildQrda3Document(run, "audiogram", outcomes);
  assert.ok(!xml.includes("2.16.840.1.113883.10.20.27.3.24"), "…27.3.24 is not a QRDA III template here");
  const measureData = xml.match(
    /<observation[^>]*>\s*<templateId root="2\.16\.840\.1\.113883\.10\.20\.27\.3\.5" extension="2016-09-01"\/>[\s\S]*?<\/observation>\s*<\/component>/g,
  ) ?? [];
  assert.equal(measureData.length, 4, "one Measure Data observation per population (DENEXCEP absent)");
  for (const md of measureData) {
    assert.match(md, /<code code="ASSERTION"/, "CONF:3259-17617");
    assert.match(md, /<statusCode code="completed"\/>/, "CONF:3259-18199");
    assert.match(md, /<value xsi:type="CD"/, "CONF:3259-17618");
    assert.match(
      md,
      /<entryRelationship typeCode="SUBJ" inversionInd="true">\s*<observation[^>]*>\s*<templateId root="2\.16\.840\.1\.113883\.10\.20\.27\.3\.3"\/>/,
      "CONF:3259-17619 — Aggregate Count nested INSIDE Measure Data",
    );
    assert.match(md, /<code code="MSRAGG"[\s\S]*?<value xsi:type="INT"[\s\S]*?<methodCode code="COUNT"/, "count");
    assert.match(md, /<reference typeCode="REFR">\s*<externalObservation[^>]*>\s*<id /, "CONF:3259-18239");
  }
});

test("QRDA III: templateIds carry the R2.1 extensions, and no CMS template is claimed", () => {
  const xml = buildQrda3Document(run, "audiogram", outcomes);
  for (const [root, ext] of [
    ["2.16.840.1.113883.10.20.27.1.1", "2020-12-01"], // CONF:4484-17208/21319
    ["2.16.840.1.113883.10.20.27.2.1", "2020-12-01"], // CONF:4484-17284/21171
    ["2.16.840.1.113883.10.20.27.3.1", "2020-12-01"], // CONF:4484-17908/21170
    ["2.16.840.1.113883.10.20.27.3.5", "2016-09-01"], // CONF:3259-17912/21161
    ["2.16.840.1.113883.10.20.17.3.8", "2020-12-01"], // CONF:4484-21468 Reporting Parameters Act
  ]) {
    assert.ok(xml.includes(`root="${root}" extension="${ext}"`), `${root} @ ${ext}`);
  }
  // `…27.1.2` is "QRDA Category III Report - CMS (V4)". We do not conform to the CMS Hospital IG, so we
  // do not claim it — the same call ADR-050 made for Category I's `…24.1.3`. It went UNFLAGGED by the
  // HL7 ruler because we also had its extension wrong, so it matched no rule at all.
  assert.ok(!xml.includes("2.16.840.1.113883.10.20.27.1.2"), "no CMS-flavoured Cat III document template");
});

test("QRDA III: the Reporting Parameters Act appears in the Measure Section too", () => {
  // CONF:4484-21467 is asserted on the MEASURE section, not only the Reporting Parameters section — so
  // the act is required in both places. Cypress's own conformant fixture carries it twice for this reason.
  const xml = buildQrda3Document(run, "audiogram", outcomes);
  const acts = xml.match(/<templateId root="2\.16\.840\.1\.113883\.10\.20\.17\.3\.8" extension="2020-12-01"\/>/g) ?? [];
  assert.equal(acts.length, 2, "Reporting Parameters Act in BOTH the reporting-parameters and measure sections");
});

test("QRDA III: an official measure references its published population criteria by name", () => {
  const xml = buildQrda3Document(run, "cms122", [officialOutcome("cms122")]);
  // The extension is the published `Measure.group.population.id`; the root is ours, saying whose
  // identifier scheme this is. Authored measures have no such criterion and fall back to the code.
  assert.match(xml, /<externalObservation[^>]*>\s*<id root="[0-9a-f-]{36}" extension="InitialPopulation_1"\/>/);
  const authored = buildQrda3Document(run, "audiogram", outcomes);
  assert.match(authored, /<externalObservation[^>]*>\s*<id root="[0-9a-f-]{36}" extension="IPOP"\/>/);
});
