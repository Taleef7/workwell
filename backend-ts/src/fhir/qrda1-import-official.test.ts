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
