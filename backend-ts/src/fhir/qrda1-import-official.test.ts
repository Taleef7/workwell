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

const cms165OutcomeOf = async (xml: string): Promise<string | undefined> => {
  const imported = importQrda1Document(xml).bundle;
  const executor = officialMeasureExecutor({ expand: officialTerminologyExpander(loadOfficialArtifact) });
  const results = await executor.evaluateBatch("cms165", [{ subjectId: "rt-subject", patientBundle: imported }], EVAL);
  return results.get("rt-subject")?.outcome;
};

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
