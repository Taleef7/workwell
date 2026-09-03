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
  expandArtifactTerminology,
  officialMeasureExecutor,
  outcomeFromPopulations,
  populationExpressionResults,
  requiredOids,
} from "./official-executor-adapter.ts";
import { deriveWhyFlagged } from "../case/case-detail-read-model.ts";
import { OFFICIAL_MEASURE_SEMANTICS, officialMeasureSemantics } from "./official-measure-semantics.ts";
import { loadOfficialArtifact, type OfficialArtifact } from "./official-artifacts.ts";
import type { FqmCalculate } from "@work-well/official-executor";

const IPP = "initial-population";
const DENOM = "denominator";
const DENEX = "denominator-exclusion";
const DENEXCEP = "denominator-exception";
const NUMER = "numerator";

/**
 * A bundle carrying the one resource fqm keys its results by. Not decoration: the adapter correlates
 * fqm's `Patient.id` back to the caller's subject id, so a Patient-less bundle has no result to
 * attribute. Real inputs always have one; `{}` never did, and using it hid that the two ids differ.
 */
const patientBundle = (id: string) => ({
  resourceType: "Bundle",
  entry: [{ resource: { resourceType: "Patient", id } }],
});

test("population -> workflow bucket, for a normal measure (numerator = the good outcome)", () => {
  const map = (p: Record<string, boolean>) => outcomeFromPopulations(p, true);

  assert.deepEqual(map({ [IPP]: false }), { outcome: "MISSING_DATA", inInitialPopulation: false });
  // In the IPP but out of the DENOMINATOR: the measure does not score them, so there is nothing to
  // chase. Reading only IPP would call this OVERDUE and open a case, while the exporter's
  // normalizeMembership clamps the same subject out of DENOM - the two would disagree about a person.
  assert.deepEqual(map({ [IPP]: true, [DENOM]: false, [NUMER]: false }), {
    outcome: "EXCLUDED",
    inInitialPopulation: true,
  });
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
      for (const denom of [true, false]) {
        for (const denex of [true, false]) {
          for (const numer of [true, false]) {
            buckets.add(
              outcomeFromPopulations(
                { [IPP]: ipp, [DENOM]: denom, [DENEX]: denex, [NUMER]: numer },
                numeratorMeansCompliant,
              ).outcome,
            );
          }
        }
      }
    }
  }
  assert.ok(!buckets.has("DUE_SOON"), "inventing a forecast would be authoring on top of the steward");
  assert.deepEqual([...buckets].sort(), ["COMPLIANT", "EXCLUDED", "MISSING_DATA", "OVERDUE"]);
});

test("evidence is derived from POPULATION results, because statement values do not survive vendoring", () => {
  // Measured, not assumed: we strip ELM annotations when vendoring (PR-6a, an 86% size cut), which
  // removes `localId`; fqm resolves a statement's `raw` BY localId, so `raw` is always undefined and
  // `final` collapses to NA|UNHIT|FALSE. Over six real CMS122 MADiE cases, 0 of 96 root statements read
  // TRUE — including for subjects the measure places in the NUMERATOR. Persisting those would put
  // `official:Numerator = "FALSE"` beside `populationResults: [{numerator, result: true}]` in one
  // regulatory record, with the false half being what the Evidence Explorer and auditor packet render.
  assert.deepEqual(
    populationExpressionResults([
      { populationType: "initial-population", result: true },
      { populationType: "numerator", result: false },
    ]),
    [
      { define: "official:initial-population", result: true },
      { define: "official:numerator", result: false },
    ],
  );
});

test("official evidence cannot be misread by the REAL why_flagged deriver", () => {
  // Calling deriveWhyFlagged rather than re-implementing its regex: a copy of the pattern would keep
  // passing if the real one were ever unanchored, which is exactly the change that would break this.
  const authored = deriveWhyFlagged(
    { expressionResults: [{ define: "Most Recent Audiogram Date", result: "2026-01-02T00:00:00Z" }] },
    "audiogram",
    "2026-07",
    "OVERDUE",
  );
  assert.equal(authored.last_exam_date, "2026-01-02", "sanity: the deriver really does read that shape");

  const official = deriveWhyFlagged(
    {
      expressionResults: populationExpressionResults([
        { populationType: "numerator", result: true },
        { populationType: "denominator-exclusion", result: true },
      ]),
    },
    "cms122",
    "2026-07",
    "EXCLUDED",
  );
  assert.equal(official.last_exam_date, null, "no official define may be mistaken for an exam date");
  assert.equal(official.days_overdue, null, "nor for a days-since count");
  // The unanchored waiver matcher DOES fire on "official:denominator-exclusion" — and correctly, now
  // that the result is a real boolean rather than fqm's constant "FALSE" string. A DENEX subject
  // genuinely has an exclusion on file. Asserted rather than left to chance: the match is incidental,
  // and an incidental behaviour nobody has written down is one nobody will preserve.
  assert.equal(official.waiver_status, "active");
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
  for (const catalogId of ["cms122", "cms125", "cms130", "cms165"]) {
    const semantics = officialMeasureSemantics(catalogId);
    assert.ok(semantics, `${catalogId} is vendored but has no recorded semantics`);
    assert.ok(semantics.rationale.length > 40, `${catalogId}: the rationale must say WHY`);
  }
});

test("cms130 and cms165 treat numerator membership as COMPLIANT", () => {
  for (const catalogId of ["cms130", "cms165"]) {
    const artifact = loadOfficialArtifact(catalogId);
    assert.ok(artifact, `${catalogId} must have a vendored artifact`);
    assert.equal(artifact.manifest.improvementNotation, "increase");
    const semantics = officialMeasureSemantics(catalogId);
    assert.equal(semantics?.numeratorMeansCompliant, true, `${catalogId} numerator means compliant`);
    assert.equal(
      outcomeFromPopulations({ [IPP]: true, [DENOM]: true, [NUMER]: true }, semantics!.numeratorMeansCompliant).outcome,
      "COMPLIANT",
    );
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
    /1 of 2 value sets could not be expanded[\s\S]*2\.16\.2[\s\S]*resolve-valuesets/,
  );

  // And when the expander THROWS - the likeliest production trigger, a transient store failure.
  // buildValueSetCache catches that internally and substitutes an empty expansion, so recording
  // emptiness only on the success path let this through silently. It must refuse identically.
  await assert.rejects(
    () =>
      expandArtifactTerminology(artifact, async (oid) => {
        if (oid === "2.16.1") return [{ code: "a", system: "s" }];
        throw new Error("value_sets read failed");
      }),
    /1 of 2 value sets could not be expanded/,
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
    () => executor.evaluate({ measureId: "unknownmeasure", patientBundle: patientBundle("patient-1") }),
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
    () => executor.evaluate({ measureId: "cms122", patientBundle: patientBundle("patient-1") }),
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
    patientBundle: patientBundle("patient-1"),
    evaluationDate: "2026-07-25",
  });

  assert.equal(outcome.outcome, "COMPLIANT", "cms125's numerator (a mammogram) means compliant");
  assert.equal(outcome.inInitialPopulation, true);
  assert.deepEqual(outcome.evidence.expressionResults, [
    { define: "official:initial-population", result: true },
    { define: "official:denominator", result: true },
    { define: "official:denominator-exclusion", result: false },
    { define: "official:numerator", result: true },
  ]);
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
    false,
    "profile-filtered retrieval matches NOTHING against our bundles' profiles (and throws on a " +
      "WebChart bundle with none) - literal-diff runs this same artifact with the default",
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

  const outcome = await executor.evaluate({ measureId: "cms122", patientBundle: patientBundle("p1") });
  const membership = officialMembership(outcome.evidence);

  assert.ok(membership, "the exporter must be able to read the evidence the executor just wrote");
  assert.deepEqual(membership, { ipp: true, denom: true, denex: false, numer: false, denexcep: true });

  // And the workflow bucket disagrees with the report, correctly: an excepted patient needs no outreach
  // (EXCLUDED), while the report still counts them in the denominator with an exception.
  assert.equal(outcome.outcome, "EXCLUDED");
});

test("non-proportion scoring, and an artifact whose id does not match, are both refused", async () => {
  const base = fakeArtifact("cms125", ["2.16.1"]);
  const withScoring = (scoring: string, catalogId = "cms125") => ({
    ...base,
    manifest: { ...base.manifest, scoring, catalogId },
  });
  const run = (artifact: OfficialArtifact) =>
    officialMeasureExecutor({
      expand: async () => [{ code: "a", system: "s" }],
      loadArtifact: () => artifact,
      calculate: async () => ({ results: [] }),
    }).evaluate({ measureId: "cms125", patientBundle: patientBundle("patient-1") });

  // A cohort measure has no numerator population at all, so populations["numerator"] is undefined and
  // the mapping would call every subject COMPLIANT (or every subject OVERDUE) on one flag.
  await assert.rejects(() => run(withScoring("cohort")), /scoring 'cohort' is not supported/);
  await assert.rejects(
    () => run(withScoring("proportion", "cms122")),
    /loaded artifact declares catalogId 'cms122'/,
  );
});

test("the semantics lookup does not resolve inherited object keys", () => {
  // PR-7b calls this with an OPERATOR-supplied id. A bare index on an object literal returns
  // Object.prototype.constructor for "constructor" — truthy, with numeratorMeansCompliant undefined,
  // which maps every subject to OVERDUE.
  for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(officialMeasureSemantics(inherited), undefined, `${inherited} must not resolve`);
  }
});

test("the measurement period is the authored engine's, quirk for quirk", async () => {
  // subtractMonths is duplicated from cql-execution-engine.ts deliberately, overflow included: the
  // first cut "improved" it by clamping, which silently gave the two paths different periods on a leap
  // day — a divergence PR-8 would then report as a logic difference.
  const seen: string[] = [];
  const executor = officialMeasureExecutor({
    expand: async () => [{ code: "a", system: "s" }],
    loadArtifact: () => ({
      ...fakeArtifact("cms122", ["2.16.1"]),
      manifest: { ...fakeArtifact("cms122", ["2.16.1"]).manifest, catalogId: "cms122" },
    }),
    calculate: async (_b, _p, options) => {
      seen.push(String((options as Record<string, unknown>)["measurementPeriodStart"]));
      return { results: [] };
    },
  });
  await assert.rejects(() => executor.evaluate({ measureId: "cms122", patientBundle: patientBundle("patient-1"), evaluationDate: "2024-02-29" }));
  assert.equal(seen[0], "2023-03-01", "non-clamping overflow, exactly as the authored engine does it");
});

test("a malformed expander still produces the DIAGNOSTIC refusal, not a raw TypeError", async () => {
  // It would fail closed either way — buildValueSetCache calls .map() outside its try — but as an
  // opaque "Cannot read properties of undefined", losing the message that names the OIDs and the CLI
  // that fixes them. That message is the entire value of this refusal.
  const artifact = fakeArtifact("fake", ["2.16.1"]);
  for (const bad of [undefined, null, {}, "codes"]) {
    await assert.rejects(
      () => expandArtifactTerminology(artifact, (async () => bad) as never),
      /1 of 1 value sets could not be expanded/,
      `an expander returning ${JSON.stringify(bad) ?? "undefined"} must still name the OIDs`,
    );
  }
});

/**
 * Measure-major batching (roadmap §7.4 PR-8).
 *
 * Two claims worth testing separately: that a roster costs ONE fqm call rather than N (the point of the
 * change), and that a batch which retrieved nothing for anybody refuses rather than reporting the whole
 * roster ineligible (the safety net batching made possible).
 */
const batchArtifact = (): OfficialArtifact => {
  const base = fakeArtifact("cms125", ["2.16.1"]);
  return { ...base, manifest: { ...base.manifest, catalogId: "cms125" } };
};

/**
 * fqm's shape for N subjects.
 *
 * `retrieved: false` is the empty-retrieve catastrophe PR-8 guards — the only one the EXECUTOR refuses.
 * `inIpp: false` is the DIFFERENT one, and the executor deliberately does NOT guard it (ADR-043): it
 * reports honestly and the run pipeline warns, because a legitimately all-ineligible cohort produces the
 * identical shape. The pair still has to be expressible independently: retrieves matching while nobody
 * enters the initial population is exactly what real WebChart data did (236 LOINC Observations found, all
 * 56 subjects out of CMS125's IPP for want of a `us-core-sex` extension), and a harness that could only
 * turn both off at once would make that case untestable — which is how the executor's refusal came to
 * look sufficient in the first place.
 */
const calculatorFor = (
  subjectIds: string[],
  opts: { retrieved?: boolean; inIpp?: boolean } = {},
): { calculate: FqmCalculate; batchSizes: number[] } => {
  const batchSizes: number[] = [];
  const empty = opts.retrieved === false;
  const inIpp = opts.inIpp ?? !empty;
  const calculate: FqmCalculate = async (_bundle, patients) => {
    batchSizes.push((patients as unknown[]).length);
    return {
      results: subjectIds.map((patientId) => ({
        patientId,
        ...(empty ? {} : { evaluatedResource: [{ resourceType: "Observation" }] }),
        detailedResults: [
          {
            populationResults: [
              { populationType: IPP, result: inIpp },
              { populationType: DENOM, result: inIpp },
              { populationType: NUMER, result: inIpp },
            ],
            statementResults: [],
          },
        ],
      })),
    };
  };
  return { calculate, batchSizes };
};

const batchExecutor = (calculate: FqmCalculate, over: Record<string, unknown> = {}) =>
  officialMeasureExecutor({
    expand: async () => [{ code: "a", system: "s" }],
    loadArtifact: batchArtifact,
    calculate,
    ...over,
  });

test("PR-8: a whole roster costs ONE fqm call, not one per subject", async () => {
  const ids = ["s1", "s2", "s3", "s4", "s5"];
  const { calculate, batchSizes } = calculatorFor(ids);

  const results = await batchExecutor(calculate).evaluateBatch(
    "cms125",
    ids.map((subjectId) => ({ subjectId, patientBundle: patientBundle(subjectId) })),
    "2026-07-25",
  );

  // The whole point: fqm parses the artifact's ELM per CALL, so five subjects in one call is four ELM
  // parses of a 2.4 MB bundle saved — 149 on a real live-tenant roster.
  assert.deepEqual(batchSizes, [5], "five subjects must arrive as ONE batch of five");
  assert.deepEqual([...results.keys()], ids);
  assert.equal(results.get("s3")!.outcome, "COMPLIANT");
});

test("PR-8: batched and per-subject produce the same outcome for the same subject", async () => {
  // Batching is a performance change. If it moved an answer it would be a correctness change wearing a
  // performance change's clothes — so assert the two paths agree rather than trusting that sharing a code
  // path makes disagreement impossible.
  const single = await batchExecutor(calculatorFor(["s1"]).calculate).evaluate({
    measureId: "cms125",
    patientBundle: patientBundle("s1"),
    evaluationDate: "2026-07-25",
  });
  const batched = await batchExecutor(calculatorFor(["s1", "s2"]).calculate).evaluateBatch(
    "cms125",
    [
      { subjectId: "s1", patientBundle: patientBundle("s1") },
      { subjectId: "s2", patientBundle: patientBundle("s2") },
    ],
    "2026-07-25",
  );

  assert.deepEqual(batched.get("s1"), single, "the same subject must evaluate identically either way");
});

test("PR-8: a batch that retrieved NOTHING for anybody refuses instead of reporting a roster ineligible", async () => {
  // fqm does not error when every retrieve comes back empty — it returns a complete-looking result with
  // nobody in any population, indistinguishable downstream from a genuinely ineligible roster. That is
  // what a profile or terminology misconfiguration looks like, and it is the failure this executor could
  // otherwise report as a successful run in which every single person is out of scope.
  const { calculate } = calculatorFor(["s1", "s2", "s3"], { retrieved: false });

  await assert.rejects(
    batchExecutor(calculate).evaluateBatch(
      "cms125",
      ["s1", "s2", "s3"].map((subjectId) => ({ subjectId, patientBundle: patientBundle(subjectId) })),
      "2026-07-25",
    ),
    /retrieved NOTHING for any of 3 subjects/,
  );
});

test("ADR-043: a whole roster out of the IPP is REPORTED, not refused — a zero-denominator run is valid", async () => {
  // This is the shape PR-8f's retrieve check cannot see (retrieves matched; the IPP conjunct did not), and
  // measured on real WebChart data it is exactly what happened: 236 LOINC Observations found, all 56
  // subjects out of official CMS125's initial population for want of a `us-core-sex` extension.
  //
  // The first cut REFUSED here. Review (Codex P1) showed that destroys a valid result: for a site-scoped
  // CMS125 run over an all-male cohort, zero-in-IPP is the correct answer, and a batch failure would
  // replace every subject's `official.populationResults` evidence with an `evaluationError`, mark the run
  // PARTIAL_FAILURE and alert — recurring, because cohort composition varies by run, so "stop routing
  // this measure" is not a remedy an operator can apply. The executor cannot distinguish the two causes,
  // so it must not destroy the benign one. Surfacing it is the run pipeline's job (a WARN), and enforcing
  // it is the flip gate's.
  const { calculate } = calculatorFor(["s1", "s2", "s3"], { retrieved: true, inIpp: false });

  const results = await batchExecutor(calculate).evaluateBatch(
    "cms125",
    ["s1", "s2", "s3"].map((subjectId) => ({ subjectId, patientBundle: patientBundle(subjectId) })),
    "2026-07-25",
  );

  assert.equal(results.size, 3, "every subject must still come back");
  for (const id of ["s1", "s2", "s3"]) {
    assert.equal(results.get(id)!.inInitialPopulation, false);
    assert.equal(results.get(id)!.outcome, "MISSING_DATA", "out of scope, not non-compliant");
    // The regulatory evidence must SURVIVE. This is what a refusal would have thrown away.
    assert.ok(results.get(id)!.evidence?.official, `${id} keeps its official populationResults evidence`);
  }
});

test("ADR-043: one subject in the IPP and the rest out is an ordinary screening roster", async () => {
  // Guards against the check ever being re-tightened into "most subjects must qualify".
  const calculate: FqmCalculate = async (_bundle, patients) => ({
    results: (patients as Array<{ entry: Array<{ resource: { id: string } }> }>).map((b, i) => ({
      patientId: b.entry[0]!.resource.id,
      evaluatedResource: [{ resourceType: "Observation" }],
      detailedResults: [
        {
          populationResults: [
            { populationType: IPP, result: i === 0 },
            { populationType: DENOM, result: i === 0 },
            { populationType: NUMER, result: false },
          ],
          statementResults: [],
        },
      ],
    })),
  });

  const results = await batchExecutor(calculate).evaluateBatch(
    "cms125",
    ["s1", "s2", "s3"].map((subjectId) => ({ subjectId, patientBundle: patientBundle(subjectId) })),
    "2026-07-25",
  );
  assert.equal(results.size, 3);
  assert.equal(results.get("s1")!.inInitialPopulation, true);
  assert.equal(results.get("s2")!.inInitialPopulation, false);
});

test("PR-8: the retrieve check does NOT fire for a single subject — that answer is legitimate", async () => {
  // One person with no clinical data really does retrieve nothing. This is `/simulate` and
  // rerun-to-verify; failing them would be a false alarm on a correct result.
  const { calculate } = calculatorFor(["s1"], { retrieved: false });

  const outcome = await batchExecutor(calculate).evaluate({
    measureId: "cms125",
    patientBundle: patientBundle("s1"),
    evaluationDate: "2026-07-25",
  });
  assert.equal(outcome.outcome, "MISSING_DATA");
  assert.equal(outcome.inInitialPopulation, false, "out of scope for the measure, not non-compliant");
});

test("PR-8: an empty batch is not an error, and never reaches fqm", async () => {
  const { calculate, batchSizes } = calculatorFor([]);
  assert.equal((await batchExecutor(calculate).evaluateBatch("cms125", [], "2026-07-25")).size, 0);
  assert.deepEqual(batchSizes, [], "asking a calculator about nobody is how you get a confusing failure");
});

test("PR-8: every refusal still fires on the batch path — they are not single-subject guards", async () => {
  // `evaluate` now delegates to `evaluateBatch`, so a refusal that had lived only on the old
  // single-subject path would be gone entirely. Assert each on the path actually reached.
  const { calculate } = calculatorFor(["s1", "s2"]);
  const subjects = [
    { subjectId: "s1", patientBundle: patientBundle("s1") },
    { subjectId: "s2", patientBundle: patientBundle("s2") },
  ];
  const cohort = batchArtifact();

  await assert.rejects(
    batchExecutor(calculate, { loadArtifact: () => null }).evaluateBatch("cms125", subjects),
    /no executable official artifact is vendored/,
  );
  await assert.rejects(
    batchExecutor(calculate, { loadArtifact: () => fakeArtifact("cms122", ["2.16.1"]) }).evaluateBatch("cms125", subjects),
    /declares catalogId 'cms122'/,
  );
  await assert.rejects(
    batchExecutor(calculate, {
      loadArtifact: () => ({ ...cohort, manifest: { ...cohort.manifest, scoring: "cohort" } }),
    }).evaluateBatch("cms125", subjects),
    /scoring 'cohort' is not supported/,
  );
  await assert.rejects(
    batchExecutor(calculate, {
      loadArtifact: () => ({ ...cohort, manifest: { ...cohort.manifest, catalogId: "unknownmeasure" } }),
    }).evaluateBatch("unknownmeasure", subjects),
    /no recorded official measure semantics/,
  );
  await assert.rejects(
    batchExecutor(calculate, { expand: async () => [] }).evaluateBatch("cms125", subjects),
    /value sets could not be expanded/,
  );
});

test("PR-8: results come back keyed by the CALLER's subject id, not the bundle's Patient.id", async () => {
  // Review caught this: fqm keys by `Patient.id`, and the two ids coincide for every synthetic subject
  // (`fhir-bundle-builder` stamps `Patient.id = externalId`) but NEVER for a live WebChart one, which the
  // directory prefixes with its tenant (`wc|123` for `Patient.id` `123`). Returning fqm's key passed every
  // synthetic test and matched nothing for the exact population official routing is aimed at — the run
  // would silently fall back to per-subject evaluation, i.e. strictly slower than not batching at all.
  const { calculate } = calculatorFor(["123", "456"]); // fqm answers with PATIENT ids

  const results = await batchExecutor(calculate).evaluateBatch(
    "cms125",
    [
      { subjectId: "wc|123", patientBundle: patientBundle("123") },
      { subjectId: "wc|456", patientBundle: patientBundle("456") },
    ],
    "2026-07-25",
  );

  assert.deepEqual([...results.keys()], ["wc|123", "wc|456"], "keyed by what the caller asked about");
  assert.equal(results.get("wc|123")!.subjectId, "wc|123", "and the outcome carries that id too");
});

test("PR-8: two subjects sharing a Patient.id are refused, never attributed to one another", async () => {
  // fqm's own results would be ambiguous, and picking either one reports a person's compliance under
  // somebody else's name. There is no safe guess available here.
  const { calculate } = calculatorFor(["dup"]);

  await assert.rejects(
    batchExecutor(calculate).evaluateBatch(
      "cms125",
      [
        { subjectId: "emp-001", patientBundle: patientBundle("dup") },
        { subjectId: "emp-002", patientBundle: patientBundle("dup") },
      ],
      "2026-07-25",
    ),
    /share Patient\.id 'dup'/,
  );
});

test("PR-8: a single evaluation still reports the bundle's own Patient.id as its subject", async () => {
  // The headless CLI prints this, and it came straight back from fqm before batching existed. The batch
  // correlation must not quietly replace it with something else.
  const { calculate } = calculatorFor(["patient-9"]);
  const outcome = await batchExecutor(calculate).evaluate({
    measureId: "cms125",
    patientBundle: patientBundle("patient-9"),
    evaluationDate: "2026-07-25",
  });
  assert.equal(outcome.subjectId, "patient-9");
});
