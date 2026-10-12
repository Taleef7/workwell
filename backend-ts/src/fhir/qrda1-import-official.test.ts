/**
 * The check the round trip structurally could not make: does an IMPORTED bundle still land in the
 * OFFICIAL initial population?
 *
 * `qrda1-import.test.ts` proves the exporter and importer agree with each other. That is worth having
 * and it is not enough — it never runs the official engine, so it cannot see a field that survives the
 * round trip in the wrong FORM. Review (#362) measured exactly that: the import wrote `Patient.gender`
 * and no `us-core-sex` extension, so official CMS125 — the measure `WORKWELL_OFFICIAL_MEASURES` routes
 * on demo/production — put **every imported subject out of the initial population**, silently, with a
 * 201 and an empty `untranslatedTemplates`.
 *
 * The test that was supposed to cover this asserted `patient.gender === "female"` and cited ADR-042 in
 * its comment — naming the right hazard while measuring the element ADR-042 established is *not* the one
 * CMS125 reads. So this file asserts the population membership itself, which is the only thing that
 * cannot be satisfied by the wrong field.
 *
 * Self-skips without the vendored artifact + terminology sidecar (gitignored, fetched at build), the
 * same way every other official-execution test does, and is wired into the `official-cases` CI job.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildQrda1Document } from "./qrda1-export.ts";
import { importQrda1Document, SYSTEM_FOR_OID } from "./qrda1-import.ts";
import { officialMeasureExecutor } from "../wiring/official-executor-adapter.ts";
import { officialTerminologyExpander, loadOfficialTerminology } from "../wiring/official-terminology.ts";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import { officialRoutingProblems } from "../wiring/executor-router.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord } from "../stores/outcome-store.ts";

const EVAL = "2025-12-31";
const MEASURE = "cms125";

// Absent the vendored artifact/terminology this cannot run. Skipping is honest; asserting nothing while
// looking green is the failure mode this file exists to prevent.
const skip =
  officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: MEASURE }).length > 0
    ? "official artifact or terminology sidecar unavailable (gitignored; fetched at build)"
    : false;

const run = {
  id: "run-official-rt",
  measurementPeriodStart: "2025-01-01T00:00:00.000Z",
  measurementPeriodEnd: "2025-12-31T00:00:00.000Z",
} as RunRecord;

const outcome = {
  id: "o1", runId: run.id, subjectId: "rt-subject", measureId: MEASURE,
  evaluationPeriod: EVAL, status: "COMPLIANT",
  evidence: { official: { ecqmId: "CMS125FHIR", version: "1.0.000", engine: "fqm-execution", populationResults: [] } },
  evaluatedAt: "2025-12-31T00:00:00.000Z",
} as OutcomeRecord;

/** A woman of screening age with a qualifying visit — CMS125's three IPP conjuncts, in FHIR. */
const sourceBundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    {
      resource: {
        resourceType: "Patient",
        id: "rt-subject",
        gender: "female",
        birthDate: "1970-04-01",
        extension: [{ url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex", valueCode: "248152002" }],
      },
    },
    {
      resource: {
        resourceType: "Encounter", id: "enc-1", status: "finished",
        type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "Office visit" }] }],
        period: { start: "2025-04-02T09:00:00Z", end: "2025-04-02T09:30:00Z" },
      },
    },
    {
      resource: {
        resourceType: "Observation", id: "obs-mg", status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "imaging" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "24606-6", display: "MG Breast Screening" }] },
        effectiveDateTime: "2025-05-10T10:00:00Z",
      },
    },
  ],
};

const inIpp = async (bundle: unknown): Promise<boolean> => {
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const results = await executor.evaluateBatch(MEASURE, [{ subjectId: "rt-subject", patientBundle: bundle }], EVAL);
  return results.get("rt-subject")?.inInitialPopulation === true;
};

test("official CMS125 admits the SOURCE bundle to the initial population", { skip }, async () => {
  // Non-degeneracy: if the source were already out of the IPP, the round-trip assertion below would
  // pass for the wrong reason — comparing two out-of-population answers.
  assert.equal(await inIpp(sourceBundle), true, "the fixture must be in the IPP for this file to mean anything");
});

test("official CMS125 STILL admits the bundle after a QRDA I round trip (review, #362)", { skip }, async () => {
  // The critical one. Measured before the fix: source COMPLIANT / inIPP=true, round-tripped
  // MISSING_DATA / inIPP=false — because the import wrote only `Patient.gender`, and CMS125's official
  // initial population reads the `us-core-sex` EXTENSION (ADR-042). Every imported subject fell out of
  // the population on the stack that actually routes this measure to official.
  const roundTripped = importQrda1Document(buildQrda1Document(run, MEASURE, outcome, sourceBundle)).bundle;
  assert.equal(await inIpp(roundTripped), true, "an imported subject must not silently leave the IPP");
});

test("the imported Patient carries us-core-sex, not just gender", { skip: false }, () => {
  // Asserted directly as well as through the engine: the engine test says WHETHER it works, this says
  // WHY, so a regression names the field instead of moving a population count. Runs unconditionally —
  // it needs no artifact.
  const patient = importQrda1Document(buildQrda1Document(run, MEASURE, outcome, sourceBundle)).bundle.entry[0]!
    .resource as { gender?: string; extension?: Array<{ url: string; valueCode: string }> };
  assert.equal(patient.gender, "female");
  const sex = (patient.extension ?? []).find((e) => e.url === "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex");
  // The SNOMED concept id, not "F" or "female": the ELM compares against the id, so a wrong value is
  // indistinguishable from an absent extension — the mistake that cost ADR-042 a measurement pass.
  assert.equal(sex?.valueCode, "248152002");
});

test(
  "every code system the ARTIFACTS use is spelled identically in the importer's map",
  { skip },
  () => {
    // `cql-execution` compares `system` by exact string equality:
    //
    //     function codesMatch(code1, code2) { return code1.code === code2.code && code1.system === code2.system; }
    //
    // So a near-miss URL is worse than an absent one. An absent system drops the resource and says so in
    // `untranslatedTemplates`; a wrong URL imports it and leaves it invisible to every retrieve, with no
    // diagnostic anywhere. HCPCS was exactly that until #388 — `urn:oid:2.16.840.1.113883.6.285` against
    // the expansions' `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets`, across 103 codes
    // including Annual Wellness Visit and Hospice Care Ambulatory — and the C2 comparison still read
    // EXACT because the initial population is `exists(...)` and those patients carry other qualifying
    // encounters. A right answer for the wrong reason.
    //
    // This is the half `qrda1-import.test.ts` cannot do: it pins literals, which stay true after a
    // re-vendor moves a URL. This reads the vendored expansions themselves.
    const mapped = new Set(Object.values(SYSTEM_FOR_OID));
    const unmapped = new Map<string, number>();
    for (const measure of ["cms122", "cms125"]) {
      const artifact = loadOfficialArtifact(measure);
      if (!artifact) continue;
      const terminology = loadOfficialTerminology(artifact);
      if (!terminology.ok) continue;
      for (const codes of terminology.codesByOid.values()) {
        for (const code of codes) {
          if (code.system && !mapped.has(code.system)) {
            unmapped.set(code.system, (unmapped.get(code.system) ?? 0) + 1);
          }
        }
      }
    }
    // Supplemental-data vocabularies only: Source of Payment Typology (Patient Characteristic Payer) and
    // CDCREC (race/ethnicity). Neither appears in a population criterion, and neither datatype is
    // translated — so they are named here rather than mapped, and this list failing to shrink is the
    // signal that a clinical system has appeared that we do not read.
    const SUPPLEMENTAL_ONLY = new Set(["https://nahdo.org/sopt", "urn:oid:2.16.840.1.113883.6.238"]);
    const clinical = [...unmapped.entries()].filter(([system]) => !SUPPLEMENTAL_ONLY.has(system));
    assert.deepEqual(
      clinical,
      [],
      `code systems in the artifacts' own expansions that the importer maps to nothing: ${JSON.stringify(clinical)}`,
    );
  },
);

/**
 * The body site moves CMS125's 2026 answer (#784). CMS125FHIR v1.0.000 counts an "Unilateral
 * Mastectomy, Unspecified Laterality" condition (`…198.12.1071`) as a left or right mastectomy by its
 * `bodySite` qualifier, so one on each side is a bilateral mastectomy and a denominator exclusion.
 * The same two conditions without a site are no exclusion at all, which is what the import produced
 * before it read `<targetSiteCode>`.
 */
const unspecifiedMastectomy = (id: string, side?: { code: string; display: string }) => ({
  resource: {
    resourceType: "Condition", id,
    verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
    code: { coding: [{ system: "http://snomed.info/sct", code: "248802009", display: "Absence of breast" }] },
    ...(side ? { bodySite: [{ coding: [{ system: "http://snomed.info/sct", ...side }] }] } : {}),
    onsetDateTime: "2020-03-01T00:00:00Z",
  },
});

const withMastectomies = (sited: boolean) => ({
  ...sourceBundle,
  entry: [
    ...sourceBundle.entry,
    unspecifiedMastectomy("mast-left", sited ? { code: "7771000", display: "Left" } : undefined),
    unspecifiedMastectomy("mast-right", sited ? { code: "24028007", display: "Right" } : undefined),
  ],
});

const outcomeAfterRoundTrip = async (bundle: unknown): Promise<string | undefined> => {
  const imported = importQrda1Document(buildQrda1Document(run, MEASURE, outcome, bundle)).bundle;
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const results = await executor.evaluateBatch(MEASURE, [{ subjectId: "rt-subject", patientBundle: imported }], EVAL);
  return results.get("rt-subject")?.outcome;
};

test("official CMS125 excludes a round-tripped patient whose two unspecified-laterality mastectomies carry a side each (#784)", { skip }, async () => {
  assert.equal(await outcomeAfterRoundTrip(withMastectomies(true)), "EXCLUDED");
});

test("official CMS125 does not exclude the same patient when the conditions carry no side (#784)", { skip }, async () => {
  // The control: without it, the test above could pass on the conditions' codes alone.
  assert.equal(await outcomeAfterRoundTrip(withMastectomies(false)), "COMPLIANT");
});

/**
 * A screening the document says did not happen is no screening (#790). The mammogram is exported as QDM
 * states it, then its `statusCode` is restated `aborted`: imported with the mapper's `final` it satisfied the
 * numerator; now it is not imported, and the patient stays a gap.
 */
const outcomeOfDocument = async (xml: string): Promise<string | undefined> => {
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const results = await executor.evaluateBatch(MEASURE, [{ subjectId: "rt-subject", patientBundle: importQrda1Document(xml).bundle }], EVAL);
  return results.get("rt-subject")?.outcome;
};

test("official CMS125: an aborted mammogram is no screening (#790)", { skip }, async () => {
  const xml = buildQrda1Document(run, MEASURE, outcome, sourceBundle);
  const at = xml.indexOf('extension="obs-mg"');
  const status = xml.indexOf('<statusCode code="completed"/>', at);
  assert.ok(at > 0 && status > at, "the exported mammogram states its status");
  const aborted = `${xml.slice(0, status)}<statusCode code="aborted"/>${xml.slice(status + '<statusCode code="completed"/>'.length)}`;
  assert.equal(await outcomeOfDocument(xml), "COMPLIANT", "as exported, the mammogram counts");
  assert.ok(!importQrda1Document(aborted).bundle.entry.some((e) => (e.resource as { id?: string }).id === "obs-mg"));
  assert.equal(await outcomeOfDocument(aborted), "OVERDUE", "aborted, it does not");
});

/**
 * A preliminary result is not a result (#790). A Laboratory Test, Performed is `completed`, and its Result says
 * whether the value is final: `active` is how a preliminary one is sent. Read as final, a later preliminary
 * 9.5% made this patient poorly controlled; imported as a test with no value, it did too (review, #790). Not
 * imported, the most recent final HbA1c is March's 6.0%.
 */
const skipCms122 =
  officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122" }).length > 0
    ? "official cms122 artifact or terminology sidecar unavailable (gitignored; fetched at build)"
    : false;

const hba1c = (id: string, when: string, resultStatus: string, value: string) => `<entry><observation classCode="OBS" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.38" extension="2019-12-01"/>
      <id root="1.3.6.1.4.1.115" extension="${id}"/>
      <code code="4548-4" codeSystem="2.16.840.1.113883.6.1"/>
      <statusCode code="completed"/>
      <effectiveTime><low value="${when}"/><high value="${when}"/></effectiveTime>
      <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.87" extension="2019-12-01"/>
        <code code="4548-4" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="${resultStatus}"/>
        <effectiveTime value="${when}"/>
        <value xsi:type="PQ" value="${value}" unit="%"/>
      </observation></entryRelationship>
    </observation></entry>`;

const diabeticDocument = (labs: string) => `<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <recordTarget><patientRole><id root="urn:workwell:employee" extension="rt-subject"/>
    <patient><administrativeGenderCode code="F" codeSystem="2.16.840.1.113883.5.1"><translation code="248152002" codeSystem="2.16.840.1.113883.6.96"/></administrativeGenderCode>
    <birthTime value="19700401"/></patient></patientRole></recordTarget>
  <component><structuredBody><component><section>
    <templateId root="2.16.840.1.113883.10.20.24.2.1" extension="2021-08-01"/>
    <entry><encounter classCode="ENC" moodCode="EVN">
      <templateId root="2.16.840.1.113883.10.20.24.3.23" extension="2021-08-01"/>
      <id root="1.3.6.1.4.1.115" extension="enc-1"/>
      <code code="99213" codeSystem="2.16.840.1.113883.6.12"/>
      <statusCode code="completed"/>
      <effectiveTime><low value="20250402090000"/><high value="20250402093000"/></effectiveTime>
    </encounter></entry>
    <entry><act classCode="ACT" moodCode="EVN"><templateId root="2.16.840.1.113883.10.20.24.3.137" extension="2019-12-01"/>
      <code code="CONC" codeSystem="2.16.840.1.113883.5.6"/><statusCode code="active"/>
      <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.24.3.135" extension="2021-08-01"/>
        <id root="1.3.6.1.4.1.115" extension="dx-1"/>
        <code code="29308-4" codeSystem="2.16.840.1.113883.6.1"/>
        <statusCode code="completed"/>
        <effectiveTime><low value="20200101"/><high nullFlavor="UNK"/></effectiveTime>
        <value xsi:type="CD" code="44054006" codeSystem="2.16.840.1.113883.6.96"/>
      </observation></entryRelationship>
    </act></entry>
    ${labs}
  </section></component></structuredBody></component>
</ClinicalDocument>`;

const cms122OutcomeOf = async (xml: string): Promise<string | undefined> => {
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const results = await executor.evaluateBatch("cms122", [{ subjectId: "rt-subject", patientBundle: importQrda1Document(xml).bundle }], EVAL);
  return results.get("rt-subject")?.outcome;
};

test("official CMS122: a later PRELIMINARY HbA1c is not the most recent result (review, #790)", { skip: skipCms122 }, async () => {
  const march = hba1c("a1", "20250301100000", "completed", "6.0");
  assert.equal(await cms122OutcomeOf(diabeticDocument(march + hba1c("a2", "20251001100000", "completed", "9.5"))), "OVERDUE", "a final 9.5% in October is poor control");
  assert.equal(await cms122OutcomeOf(diabeticDocument(march + hba1c("a2", "20251001100000", "active", "9.5"))), "COMPLIANT", "a preliminary one is not read");
  assert.equal(await cms122OutcomeOf(diabeticDocument(march + hba1c("a2", "20251001100000", "aborted", "9.5"))), "COMPLIANT", "nor an aborted one");
});

/**
 * A blood pressure through the QRDA I route reaches CMS165 (#591, LOCKED §4A.8). The panel is exported as
 * QDM's two readings and imported back as one panel, which is the only shape CMS165FHIR v1.0.000 reads.
 * The control moves the diastolic reading 59 seconds: the two are no longer one blood pressure, nothing is
 * paired, and the patient has no reading CMS165 can see.
 */
const skipCms165 =
  officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms165" }).length > 0
    ? "official cms165 artifact or terminology sidecar unavailable (gitignored; fetched at build)"
    : false;

const hypertensiveBundle = {
  resourceType: "Bundle",
  type: "collection",
  entry: [
    { resource: { resourceType: "Patient", id: "rt-subject", gender: "female", birthDate: "1970-04-01" } },
    {
      resource: {
        resourceType: "Encounter", id: "enc-1", status: "finished",
        type: [{ coding: [{ system: "http://www.ama-assn.org/go/cpt", code: "99213", display: "Office visit" }] }],
        period: { start: "2025-04-02T09:00:00Z", end: "2025-04-02T09:30:00Z" },
      },
    },
    {
      resource: {
        resourceType: "Condition", id: "htn",
        verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
        code: { coding: [{ system: "http://hl7.org/fhir/sid/icd-10-cm", code: "I10", display: "Essential hypertension" }] },
        onsetDateTime: "2020-03-01T00:00:00Z",
      },
    },
    {
      resource: {
        resourceType: "Observation", id: "bp-1", status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
        code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
        effectiveDateTime: "2025-06-01T10:00:00Z",
        component: [
          { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 128, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
          { code: { coding: [{ system: "http://loinc.org", code: "8462-4" }] }, valueQuantity: { value: 78, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } },
        ],
      },
    },
  ],
};

const cms165Outcome = {
  ...outcome, measureId: "cms165",
  evidence: { official: { ecqmId: "CMS165FHIR", version: "1.0.000", engine: "fqm-execution", populationResults: [] } },
} as OutcomeRecord;

const cms165OutcomeOfBundle = async (bundle: unknown): Promise<string | undefined> => {
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const results = await executor.evaluateBatch("cms165", [{ subjectId: "rt-subject", patientBundle: structuredClone(bundle) }], EVAL);
  return results.get("rt-subject")?.outcome;
};

const cms165OutcomeOf = async (xml: string): Promise<string | undefined> => cms165OutcomeOfBundle(importQrda1Document(xml).bundle);

test("official CMS165 sees a round-tripped blood pressure: two readings at one time are one panel (§4A.8)", { skip: skipCms165 }, async () => {
  const xml = buildQrda1Document(run, "cms165", cms165Outcome, hypertensiveBundle);
  assert.equal(await cms165OutcomeOf(xml), "COMPLIANT", "128/78 on the most recent day is controlled");
});

test("official CMS165 does not see the same readings 59 seconds apart: nothing is paired (§4A.8)", { skip: skipCms165 }, async () => {
  const xml = buildQrda1Document(run, "cms165", cms165Outcome, hypertensiveBundle);
  // The diastolic is the second Physical Exam entry; move its time alone.
  const at = xml.lastIndexOf("8462-4");
  const moved = xml.slice(0, at) + xml.slice(at).replace(/<effectiveTime value="(\d{12})00/, (_m, hhmm: string) => `<effectiveTime value="${hhmm}59`);
  assert.notEqual(moved, xml, "the fixture must move the diastolic reading");
  assert.equal(await cms165OutcomeOf(moved), "OVERDUE", "no blood pressure CMS165 can read is not controlled");
});

test("official CMS165 reads an imported blood pressure's day in the document's own offset (review, #787)", { skip: skipCms165 }, async () => {
  const xml = buildQrda1Document(run, "cms165", cms165Outcome, hypertensiveBundle);
  const at = (value: string) => xml.replace(/<effectiveTime value="20250601100000"\/>/g, `<effectiveTime value="${value}"/>`);
  assert.equal((xml.match(/<effectiveTime value="20250601100000"\/>/g) ?? []).length, 2, "the fixture must restate both readings' time");
  // The panel's only reading. In UTC the first is 1 January 2026 and the second 31 December 2025, so a panel
  // converted to UTC scored each the wrong way round.
  assert.equal(await cms165OutcomeOf(at("20251231200000-0500")), "COMPLIANT", "20:00 on 31 December in New York is a 2025 reading");
  assert.equal(await cms165OutcomeOf(at("20260101030000+0500")), "OVERDUE", "03:00 on 1 January in Karachi is a 2026 reading");
});

test("official CMS165: a reading spelled outside LOINC's own system is neither scored nor exported, so the run and its QRDA agree (review, #787)", { skip: skipCms165 }, async () => {
  const [patientEntry, encounter, hypertensionEntry, early] = hypertensiveBundle.entry;
  // Evaluated as a source bundle, not an imported one, so it states what the importer would add: the
  // patient's US Core sex and the diagnosis's clinical status.
  const patient = { resource: { ...(patientEntry!.resource as Record<string, unknown>), extension: [{ url: "http://hl7.org/fhir/us/core/StructureDefinition/us-core-sex", valueCode: "248152002" }] } };
  const hypertension = {
    resource: { ...(hypertensionEntry!.resource as Record<string, unknown>), clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] } },
  };
  assert.equal(await cms165OutcomeOfBundle({ ...hypertensiveBundle, entry: [patient, encounter!, hypertension, early!] }), "COMPLIANT", "the fixture alone is controlled");
  const reading = (system: string, code: string, value: number) => ({ code: { coding: [{ system, code }] }, valueQuantity: { value, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" } });
  // The fixture's 128/78 on 1 June, then a later reading whose codes CMS165 cannot read.
  for (const [systolic, diastolic] of [[150, 95], [128, 78]] as const) {
    const late = {
      resource: {
        ...(early!.resource as Record<string, unknown>), id: "bp-late", effectiveDateTime: "2025-09-01T10:00:00Z",
        component: [reading("http://loinc.org/", "8480-6", systolic), reading("http://loinc.org/", "8462-4", diastolic)],
      },
    };
    const bundle = { ...hypertensiveBundle, entry: [patient!, encounter!, hypertension!, early!, late] };
    // Before, preparation stamped it: CMS165 took 1 September as the latest day, read no values from it, and
    // scored the patient OVERDUE whatever the reading said.
    assert.equal(await cms165OutcomeOfBundle(bundle), "COMPLIANT", `${systolic}/${diastolic}: the run scores the readable 128/78`);
    assert.equal(await cms165OutcomeOf(buildQrda1Document(run, "cms165", cms165Outcome, bundle)), "COMPLIANT", `${systolic}/${diastolic}: and so does its QRDA`);
  }
});
