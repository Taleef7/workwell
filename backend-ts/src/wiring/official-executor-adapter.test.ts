/**
 * The official executor adapter (roadmap §7.2/§7.3, PR-7a).
 *
 * The mapping tests are exhaustive on purpose: every one of these five buckets is what an operator acts
 * on, and the inverse-measure case (cms122) is one boolean away from reporting every poorly-controlled
 * diabetic as compliant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evidenceStatements,
  expandArtifactTerminology,
  officialMeasureExecutor,
  outcomeFromPopulations,
  requiredOids,
} from "./official-executor-adapter.ts";
import { OFFICIAL_MEASURE_SEMANTICS, officialMeasureSemantics } from "./official-measure-semantics.ts";
import { loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import type { FqmCalculate } from "@workwell/official-executor";

const IPP = "initial-population";
const DENOM = "denominator";
const DENEX = "denominator-exclusion";
const DENEXCEP = "denominator-exception";
const NUMER = "numerator";

test("population -> workflow bucket, for a normal measure (numerator = the good outcome)", () => {
  const map = (p: Record<string, boolean>) => outcomeFromPopulations(p, true);

  assert.deepEqual(map({ [IPP]: false }), { outcome: "MISSING_DATA", inInitialPopulation: false });
  assert.deepEqual(map({ [IPP]: true, [DENOM]: true, [NUMER]: true }), {
    outcome: "COMPLIANT",
    inInitialPopulation: true,
  });
  assert.deepEqual(map({ [IPP]: true, [DENOM]: true, [NUMER]: false }), {
    outcome: "OVERDUE",
    inInitialPopulation: true,
  });
  assert.deepEqual(map({ [IPP]: true, [DENOM]: true, [DENEX]: true, [NUMER]: false }), {
    outcome: "EXCLUDED",
    inInitialPopulation: true,
  });
});

test("population -> workflow bucket, for an INVERSE measure (numerator = the failure)", () => {
  // cms122: numerator is HbA1c > 9% or unassessed. Getting this backwards reports every poorly
  // controlled diabetic as compliant, which is the single worst defect this milestone could ship.
  const map = (p: Record<string, boolean>) => outcomeFromPopulations(p, false);

  assert.equal(map({ [IPP]: true, [DENOM]: true, [NUMER]: true }).outcome, "OVERDUE");
  assert.equal(map({ [IPP]: true, [DENOM]: true, [NUMER]: false }).outcome, "COMPLIANT");
});

test("denominator-exception maps to EXCLUDED — the CMS68 unblock, with no enum change", () => {
  // An excepted patient needs no outreach, which is the only question the workflow vocabulary answers.
  // The reporting distinction survives in evidence_json.official.populationResults.
  assert.equal(
    outcomeFromPopulations({ [IPP]: true, [DENOM]: true, [DENEXCEP]: true, [NUMER]: false }, true).outcome,
    "EXCLUDED",
  );
});

test("out-of-IPP is MISSING_DATA *paired with* inInitialPopulation:false, never bare", () => {
  // The pair is the whole L17 signal: without the flag, "out of scope for this measure" is
  // indistinguishable from "eligible but we hold no data", and the roster would chase the wrong people.
  const result = outcomeFromPopulations({ [IPP]: false, [DENOM]: false, [NUMER]: false }, true);
  assert.equal(result.outcome, "MISSING_DATA");
  assert.equal(result.inInitialPopulation, false);
});

test("DUE_SOON is never emitted — official CQL has no forecast define", () => {
  const buckets = new Set<string>();
  for (const numeratorMeansCompliant of [true, false]) {
    for (const ipp of [true, false]) {
      for (const denex of [true, false]) {
        for (const numer of [true, false]) {
          buckets.add(
            outcomeFromPopulations(
              { [IPP]: ipp, [DENEX]: denex, [NUMER]: numer },
              numeratorMeansCompliant,
            ).outcome,
          );
        }
      }
    }
  }
  assert.ok(!buckets.has("DUE_SOON"), "inventing a forecast would be authoring on top of the steward");
  assert.deepEqual([...buckets].sort(), ["COMPLIANT", "EXCLUDED", "MISSING_DATA", "OVERDUE"]);
});

test("evidence keeps the measure's own library statements, not its includes", () => {
  const statements = [
    { libraryName: "CMS122FHIRDiabetesAssessGT9Pct", statementName: "Numerator", final: "TRUE" },
    { libraryName: "CMS122FHIRDiabetesAssessGT9Pct", statementName: "Denominator", final: "TRUE" },
    { libraryName: "FHIRHelpers", statementName: "ToInterval", final: "NA" },
    { libraryName: "Hospice", statementName: "Has Hospice Services", final: "FALSE" },
    { libraryName: "CMS122FHIRDiabetesAssessGT9Pct", final: "TRUE" }, // unnamed → dropped
  ];
  assert.deepEqual(evidenceStatements(statements, "CMS122FHIRDiabetesAssessGT9Pct"), [
    { define: "Numerator", result: "TRUE" },
    { define: "Denominator", result: "TRUE" },
  ]);
});

test("every vendored measure has recorded semantics — the table cannot silently fall behind", () => {
  // Fail-closed is only fail-closed if someone notices. Vendoring a measure without deciding what its
  // numerator means would otherwise surface as a runtime throw during a population run.
  for (const catalogId of Object.keys(OFFICIAL_MEASURE_SEMANTICS)) {
    assert.ok(
      loadOfficialArtifact(catalogId),
      `${catalogId} has semantics recorded but no vendored artifact`,
    );
  }
  for (const catalogId of ["cms122", "cms125"]) {
    const semantics = officialMeasureSemantics(catalogId);
    assert.ok(semantics, `${catalogId} is vendored but has no recorded semantics`);
    assert.ok(semantics.rationale.length > 40, `${catalogId}: the rationale must say WHY`);
  }
});

test("cms122's semantics contradict its own artifact, deliberately", () => {
  // The artifact declares improvementNotation "increase" despite being inverse. If anyone ever
  // "simplifies" the table by deriving from the artifact, this fails and says why.
  const artifact = loadOfficialArtifact("cms122");
  assert.ok(artifact);
  assert.equal(artifact.manifest.improvementNotation, "increase");
  assert.equal(
    officialMeasureSemantics("cms122")?.numeratorMeansCompliant,
    false,
    "cms122's numerator is poor glycemic control; the artifact's improvementNotation must NOT be derived from",
  );
});

const fakeArtifact = (catalogId: string, valueSetOids: string[]): OfficialArtifact => {
  const elm = {
    library: { valueSets: { def: valueSetOids.map((oid) => ({ id: `http://x/ValueSet/${oid}` })) } },
  };
  return {
    manifest: {
      catalogId,
      measureName: "FakeMeasure",
      version: "1.0.000",
      cmsId: "999FHIR",
      url: "https://example.invalid",
      status: "active",
      effectivePeriod: null,
      scoring: "proportion",
      populationBasis: "boolean",
      improvementNotation: "increase",
      populations: [],
      source: { repo: "r", ref: "f".repeat(40), path: "p", rawSha256: "sha256:0" },
      reduction: {},
      sha256: "sha256:abc",
    },
    bundle: {
      resourceType: "Bundle",
      entry: [
        { resource: { resourceType: "Measure" } },
        {
          resource: {
            resourceType: "Library",
            name: "FakeMeasure",
            content: [
              {
                contentType: "application/elm+json",
                data: Buffer.from(JSON.stringify(elm), "utf8").toString("base64"),
              },
            ],
          },
        },
      ],
    },
  };
};

test("a value set that expands to nothing REFUSES the evaluation rather than narrowing it", async () => {
  // This is the defect that would be hardest to notice in production: fqm aborts on a MISSING value set,
  // so buildValueSetCache emits unexpandable ones as empty-but-present. An empty set matches nothing, so
  // an un-imported OID reports every subject out-of-population — which reads downstream exactly like a
  // genuinely ineligible roster. Concretely: resolve-valuesets has only ever imported CMS122's OIDs.
  const artifact = fakeArtifact("fake", ["2.16.1", "2.16.2"]);
  await assert.rejects(
    () => expandArtifactTerminology(artifact, async (oid) => (oid === "2.16.1" ? [{ code: "a", system: "s" }] : [])),
    /1 of 2 value sets expanded to zero codes.*2\.16\.2.*resolve-valuesets/s,
  );

  // Fully imported terminology passes and yields one cache entry per referenced canonical.
  const cache = await expandArtifactTerminology(artifact, async () => [{ code: "a", system: "s" }]);
  assert.equal(cache.length, 2);
  assert.deepEqual(requiredOids(artifact), ["2.16.1", "2.16.2"]);
});

test("a measure with no recorded semantics is refused, not guessed at", async () => {
  const executor = officialMeasureExecutor({
    expand: async () => [{ code: "a", system: "s" }],
    loadArtifact: () => fakeArtifact("unknownmeasure", ["2.16.1"]),
    calculate: async () => ({ results: [] }),
  });
  await assert.rejects(
    () => executor.evaluate({ measureId: "unknownmeasure", patientBundle: {} }),
    /no recorded official measure semantics/,
  );
});

test("an unvendored measure is refused with a clear reason", async () => {
  const executor = officialMeasureExecutor({
    expand: async () => [{ code: "a", system: "s" }],
    loadArtifact: () => null,
    calculate: async () => ({ results: [] }),
  });
  await assert.rejects(
    () => executor.evaluate({ measureId: "cms122", patientBundle: {} }),
    /no executable official artifact is vendored/,
  );
});

test("a full evaluation produces the workflow bucket AND the lossless official evidence", async () => {
  const calls: Array<{ options: Record<string, unknown> }> = [];
  const calculate: FqmCalculate = async (_bundle, _patients, options) => {
    calls.push({ options: options as Record<string, unknown> });
    return {
      results: [
        {
          patientId: "patient-1",
          detailedResults: [
            {
              populationResults: [
                { populationType: IPP, result: true },
                { populationType: DENOM, result: true },
                { populationType: DENEX, result: false },
                { populationType: NUMER, result: true },
              ],
              statementResults: [
                { libraryName: "FakeMeasure", statementName: "Numerator", final: "TRUE" },
                { libraryName: "FHIRHelpers", statementName: "ToInterval", final: "NA" },
              ],
            },
          ],
        },
      ],
    };
  };
  const executor = officialMeasureExecutor({
    expand: async () => [{ code: "a", system: "s" }],
    loadArtifact: () => ({
      ...fakeArtifact("cms125", ["2.16.1"]),
      manifest: { ...fakeArtifact("cms125", ["2.16.1"]).manifest, catalogId: "cms125" },
    }),
    calculate,
  });

  const outcome = await executor.evaluate({
    measureId: "cms125",
    patientBundle: {},
    evaluationDate: "2026-07-25",
  });

  assert.equal(outcome.outcome, "COMPLIANT", "cms125's numerator (a mammogram) means compliant");
  assert.equal(outcome.inInitialPopulation, true);
  assert.deepEqual(outcome.evidence.expressionResults, [{ define: "Numerator", result: "TRUE" }]);
  assert.deepEqual(outcome.evidence.official, {
    ecqmId: "999FHIR",
    version: "1.0.000",
    engine: "fqm-execution",
    artifactSha256: "sha256:abc",
    // fqm's array VERBATIM, including the false entries: this is what MeasureReport/QRDA read, and the
    // workflow bucket cannot express it. Deliberately not the reduced code→boolean map, which drops
    // duplicate population types (legal for ratio measures) and everything beyond type/result.
    populationResults: [
      { populationType: IPP, result: true },
      { populationType: DENOM, result: true },
      { populationType: DENEX, result: false },
      { populationType: NUMER, result: true },
    ],
  });

  // The measurement period matches the AUTHORED path (12 months back from the evaluation date), so the
  // PR-8 shadow diff isolates the logic difference rather than confounding it with a period change.
  const options = calls[0]!.options;
  assert.equal(options["measurementPeriodStart"], "2025-07-25");
  assert.equal(
    options["measurementPeriodEnd"],
    "2026-07-25T23:59:59.999Z",
    "date-only period ends must be normalized (fqm#371) or the last day silently drops out",
  );
  assert.equal(
    options["trustMetaProfile"],
    true,
    "official artifacts retrieve by QICore profile; base-type retrieval finds nothing",
  );
});

test("what the adapter WRITES is what the exporter READS — the two halves cannot drift apart", async () => {
  // PR-3 shipped the exporter half before this half existed, and warned that a third shape would be
  // rejected-and-alerted rather than tolerated. It was right to: the first cut of this adapter persisted
  // the reduced code→boolean map, which `officialMembership` refuses ("missing a required boolean"),
  // silently degrading the report to status-derived membership — precisely the failure evidence-first
  // exporting exists to prevent. Nothing but a round trip catches that, so: round-trip it.
  const { officialMembership } = await import("../fhir/measure-report.ts");

  const executor = officialMeasureExecutor({
    expand: async () => [{ code: "a", system: "s" }],
    loadArtifact: () => fakeArtifact("cms122", ["2.16.1"]),
    calculate: async () => ({
      results: [
        {
          patientId: "p1",
          detailedResults: [
            {
              populationResults: [
                { populationType: IPP, result: true },
                { populationType: DENOM, result: true },
                { populationType: DENEX, result: false },
                { populationType: DENEXCEP, result: true },
                { populationType: NUMER, result: false },
              ],
              statementResults: [],
            },
          ],
        },
      ],
    }),
  });

  const outcome = await executor.evaluate({ measureId: "cms122", patientBundle: {} });
  const membership = officialMembership(outcome.evidence);

  assert.ok(membership, "the exporter must be able to read the evidence the executor just wrote");
  assert.deepEqual(membership, { ipp: true, denom: true, denex: false, numer: false, denexcep: true });

  // And the workflow bucket disagrees with the report, correctly: an excepted patient needs no outreach
  // (EXCLUDED), while the report still counts them in the denominator with an exception.
  assert.equal(outcome.outcome, "EXCLUDED");
});
