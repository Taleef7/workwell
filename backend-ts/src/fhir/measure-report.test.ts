/**
 * #89 / E3.1 — FHIR MeasureReport builders: population reconciliation with outcomes
 * + structural conformance to FHIR R4 (JVM-free). Pure functions, no DB.
 *   node --import tsx --test src/fhir/measure-report.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countPopulations,
  officialMembership,
  membershipFor,
  populationCountsFromStatus,
  buildSummaryMeasureReport,
  buildIndividualMeasureReport,
  buildMeasureReportBundle,
} from "./measure-report.ts";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import type { RunRecord } from "../stores/run-store.ts";
import type { OutcomeRecord, OutcomeStatusCount } from "../stores/outcome-store.ts";

const run: RunRecord = {
  id: "run-1", status: "COMPLETED", scopeType: "MEASURE", scopeId: "mv-1", triggeredBy: "manual", site: null,
  requestedScope: { measureId: "audiogram" }, startedAt: "2026-06-12T00:00:00.000Z", completedAt: "2026-06-12T00:05:00.000Z",
  measurementPeriodStart: "2025-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
};
const GENERATED_AT = "2026-07-15T20:30:00.000Z";
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
  assert.deepEqual(countPopulations(outcomes, "audiogram"), { ipp: 10, denex: 1, denom: 10, numer: 6, denexcep: 0 });
});

test("summary: counts + measureScore reconcile; conformant", () => {
  const mr = buildSummaryMeasureReport(run, "audiogram", outcomes, GENERATED_AT);
  assert.equal(mr.resourceType, "MeasureReport");
  assert.equal(mr.status, "complete");
  assert.equal(mr.type, "summary");
  assert.equal(mr.measure, "urn:workwell:measure:audiogram");
  assert.equal(mr.period.start, run.measurementPeriodStart);
  assert.equal(mr.period.end, run.measurementPeriodEnd);
  assert.equal(countOf(mr, "initial-population"), 10);
  assert.equal(countOf(mr, "denominator-exclusion"), 1);
  assert.equal(countOf(mr, "denominator"), 10);
  assert.equal(countOf(mr, "numerator"), 6);
  assert.ok(Math.abs(mr.group[0]!.measureScore!.value - 6 / 9) < 1e-9);
  for (const p of mr.group[0]!.population) assert.equal(p.code.coding[0]!.system, POP);
});

test("summary: all-excluded retains DENOM membership count and omits score when effective denominator is zero", () => {
  const mr = buildSummaryMeasureReport(run, "audiogram", [oc("EXCLUDED"), oc("EXCLUDED")], GENERATED_AT);
  assert.equal(countOf(mr, "denominator"), 2);
  assert.equal(countOf(mr, "denominator-exclusion"), 2);
  assert.equal(mr.group[0]!.measureScore, undefined);
});

test("cms122/cms125 MISSING_DATA is out of population in row and histogram count paths", () => {
  const cmsOutcomes = [oc("COMPLIANT"), oc("OVERDUE"), oc("MISSING_DATA"), oc("EXCLUDED")];
  const histogram: OutcomeStatusCount[] = [
    { status: "COMPLIANT", count: 1, latestEvaluatedAt: run.completedAt },
    { status: "OVERDUE", count: 1, latestEvaluatedAt: run.completedAt },
    { status: "MISSING_DATA", count: 1, latestEvaluatedAt: run.completedAt },
    { status: "EXCLUDED", count: 1, latestEvaluatedAt: run.completedAt },
  ];

  for (const measureId of ["cms122", "cms125"]) {
    assert.deepEqual(countPopulations(cmsOutcomes, measureId), { ipp: 3, denom: 3, denex: 1, numer: 1, denexcep: 0 });
    assert.deepEqual(populationCountsFromStatus(histogram, measureId), { ipp: 3, denom: 3, denex: 1, numer: 1, denexcep: 0 });
  }
  assert.deepEqual(countPopulations(cmsOutcomes, "audiogram"), { ipp: 4, denom: 4, denex: 1, numer: 1, denexcep: 0 });
  assert.deepEqual(populationCountsFromStatus(histogram, "audiogram"), { ipp: 4, denom: 4, denex: 1, numer: 1, denexcep: 0 });
});

test("individual: subject ref + 0/1 membership; no measureScore", () => {
  const compliant = buildIndividualMeasureReport(oc("COMPLIANT"), run, "audiogram", GENERATED_AT);
  assert.equal(compliant.type, "individual");
  assert.match(compliant.subject!.reference, /^Patient\/emp-/);
  assert.equal(compliant.group[0]!.measureScore, undefined);
  assert.equal(countOf(compliant, "numerator"), 1);
  assert.equal(countOf(compliant, "denominator"), 1);
  assert.equal(countOf(compliant, "denominator-exclusion"), 0);
  const excluded = buildIndividualMeasureReport(oc("EXCLUDED"), run, "audiogram", GENERATED_AT);
  assert.equal(countOf(excluded, "denominator-exclusion"), 1);
  assert.equal(countOf(excluded, "denominator"), 1);
  assert.equal(countOf(excluded, "numerator"), 0);

  for (const measureId of ["cms122", "cms125"]) {
    const missing = buildIndividualMeasureReport(oc("MISSING_DATA"), run, measureId, GENERATED_AT);
    for (const code of ["initial-population", "numerator", "denominator", "denominator-exclusion"])
      assert.equal(countOf(missing, code), 0, `${measureId} ${code}`);
  }
});

test("AUTHORED outcomes keep the WorkWell canonical and increase notation", () => {
  for (const measureId of ["cms122", "cms125"]) {
    const report = buildSummaryMeasureReport(run, measureId, [oc("COMPLIANT"), oc("OVERDUE")], GENERATED_AT);
    assert.equal(report.measure, `urn:workwell:measure:${measureId}`);
    assert.ok(!report.measure.includes("cms.gov"), "never claims the official CMS canonical");
    assert.equal(report.improvementNotation?.coding[0]?.code, "increase");
    assert.equal(countOf(report, "numerator"), 1, "COMPLIANT is WorkWell's numerator");
  }
});

/** An outcome as the official executor persists it: membership IS `populationResults` (ADR-031). */
const routedOc = (measureId: string, inNumerator: boolean, version = "1.0.000"): OutcomeRecord => ({
  id: `o${++n}`, runId: "run-1", subjectId: `emp-${n}`, measureId,
  evaluationPeriod: "2026-06-12", status: inNumerator ? "OVERDUE" : "COMPLIANT",
  evidence: {
    official: {
      ecqmId: measureId === "cms122" ? "CMS122FHIR" : "CMS125FHIR",
      version,
      engine: "fqm-execution",
      artifactSha256: loadOfficialArtifact(measureId)?.manifest.sha256,
      populationResults: [
        { populationType: "initial-population", result: true },
        { populationType: "denominator", result: true },
        { populationType: "denominator-exclusion", result: false },
        { populationType: "numerator", result: inNumerator },
      ],
    },
  },
  evaluatedAt: "2026-06-12T00:01:00.000Z",
});

test("ADR-046: an OFFICIAL cms122 report declares DECREASE — its numerator counts poor control", () => {
  // The obligation this file has carried since PR-3: canonical, improvementNotation and membership must
  // switch TOGETHER or the report contradicts itself. cms122's official numerator is poor glycemic
  // control, so `increase` over it says higher-is-better about a numerator counting harm. Review of #356
  // caught that PR-9c shipped without discharging this, which is why cms122 was held out of that flip.
  //
  // The old guard could not fail here: its fixtures carried no official evidence, so it only ever
  // exercised the authored path.
  const report = buildSummaryMeasureReport(
    run, "cms122", [routedOc("cms122", true), routedOc("cms122", false)], GENERATED_AT,
  );
  assert.equal(report.improvementNotation?.coding[0]?.code, "decrease");
  assert.equal(countOf(report, "numerator"), 1, "numerator counts the POOR-control subject");
  // And the canonical moves with it — a WorkWell urn over an official numerator is the same lie.
  assert.ok(report.measure.includes("madie.cms.gov"), `expected the official canonical, got ${report.measure}`);
});

test("ADR-046: an OFFICIAL cms125 report stays INCREASE — its numerator means screened", () => {
  // The trio must track the measure's own semantics, not flip for everything official. cms125's
  // numerator means compliance, so `increase` is correct and unchanged.
  const report = buildSummaryMeasureReport(
    run, "cms125", [routedOc("cms125", true), routedOc("cms125", false)], GENERATED_AT,
  );
  assert.equal(report.improvementNotation?.coding[0]?.code, "increase");
  assert.ok(report.measure.includes("madie.cms.gov"));
});

test("ADR-046: a re-vendored artifact does NOT get the current canonical retroactively", () => {
  // A run exported after a re-vendor must not be labelled with a canonical it was never scored by. The
  // sha in the evidence is the discriminator; a mismatch falls back to a version-qualified urn, which is
  // less pretty and true.
  const stale = routedOc("cms125", true);
  (stale.evidence as { official: { artifactSha256: string } }).official.artifactSha256 = "sha256:not-the-vendored-one";
  const report = buildSummaryMeasureReport(run, "cms125", [stale], GENERATED_AT);
  assert.equal(report.measure, "urn:workwell:measure:cms125:official:1.0.000");
  assert.ok(!report.measure.includes("madie.cms.gov"), "never claims a canonical this run did not use");
});

test("ADR-046: the INDIVIDUAL report derives the trio from its own outcome", () => {
  const official = buildIndividualMeasureReport(routedOc("cms122", true), run, "cms122", GENERATED_AT);
  assert.equal(official.improvementNotation?.coding[0]?.code, "decrease");
  assert.ok(official.measure.includes("madie.cms.gov"));

  const authored = buildIndividualMeasureReport(oc("COMPLIANT"), run, "cms122", GENERATED_AT);
  assert.equal(authored.improvementNotation?.coding[0]?.code, "increase");
  assert.equal(authored.measure, "urn:workwell:measure:cms122");
});

test("base R4 metadata: UUID id, generation date, and contained WorkWell reporter", () => {
  const summary = buildSummaryMeasureReport(run, "audiogram", outcomes, GENERATED_AT);
  assert.match(summary.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(summary.date, GENERATED_AT);
  assert.notEqual(summary.date, run.completedAt, "generation time is distinct from run completion time");
  assert.deepEqual(summary.reporter, { reference: "#workwell-measure-studio" });
  assert.deepEqual(summary.contained, [
    { resourceType: "Organization", id: "workwell-measure-studio", name: "WorkWell Measure Studio" },
  ]);

  const individual = buildIndividualMeasureReport(oc("COMPLIANT"), run, "cms122", GENERATED_AT);
  assert.match(individual.id, /^[0-9a-f-]{36}$/);
  assert.equal(individual.date, GENERATED_AT);
  assert.equal(individual.reporter.reference, "#workwell-measure-studio");
  assert.equal(individual.improvementNotation?.coding[0]?.code, "increase");
});

test("bundle: summary + one individual per outcome; individuals sum to summary", () => {
  const bundle = buildMeasureReportBundle(run, "audiogram", outcomes, GENERATED_AT);
  assert.equal(bundle.resourceType, "Bundle");
  assert.equal(bundle.type, "collection");
  assert.equal(bundle.entry.length, 1 + outcomes.length);
  assert.equal(bundle.entry[0]!.resource.type, "summary");
  for (const entry of bundle.entry) {
    assert.equal(entry.fullUrl, `urn:uuid:${entry.resource.id}`);
    assert.match(entry.fullUrl, /^urn:uuid:[0-9a-f-]{36}$/);
    assert.equal(entry.resource.date, GENERATED_AT, "every report in the bundle shares one generation time");
  }
  const individuals = bundle.entry.slice(1).map((e) => e.resource);
  const sum = (code: string) => individuals.reduce((acc, mr) => acc + countOf(mr, code), 0);
  assert.equal(sum("initial-population"), 10);
  assert.equal(sum("numerator"), 6);
  assert.equal(sum("denominator"), 10);
  assert.equal(sum("denominator-exclusion"), 1);
});

/**
 * PR-3 (roadmap §7.4) — evidence-first population membership, so the exporter is ready for
 * official-routed outcomes BEFORE the flip, without a hardcoded per-measure flag for each of the
 * eight incoming CMS measures.
 */
const officialOc = (
  status: string,
  populationResults: Record<string, boolean>,
  measureId = "cms122",
): OutcomeRecord => ({
  id: `oo${++n}`, runId: "run-1", subjectId: `emp-o${n}`, measureId,
  evaluationPeriod: "2026-06-12", status,
  evidence: { official: { ecqmId: "CMS122v14", version: "1.0.000", engine: "fqm-execution", populationResults } },
  evaluatedAt: "2026-06-12T00:01:00.000Z",
});

test("PR-3: official populationResults drive membership, not the outcome status", () => {
  // An official NUMER subject whose workflow status is OVERDUE (cms122 is an inverse measure:
  // numerator = poor control). Status-based counting would call this a non-numerator.
  const counts = countPopulations(
    [officialOc("OVERDUE", { ipp: true, denom: true, denex: false, numer: true })],
    "cms122",
  );
  assert.deepEqual(counts, { ipp: 1, denom: 1, denex: 0, numer: 1, denexcep: 0 });
});

test("PR-3: official ipp=false is out of population regardless of status", () => {
  const counts = countPopulations(
    [officialOc("COMPLIANT", { ipp: false, denom: false, denex: false, numer: false })],
    "cms122",
  );
  assert.deepEqual(counts, { ipp: 0, denom: 0, denex: 0, numer: 0, denexcep: 0 });
});

test("PR-3: DENEXCEP maps to the exception count without a sixth outcome bucket", () => {
  // CMS68-class: an excepted subject is in DENOM, subtracted for the score — the vocabulary
  // decision (roadmap §7.3) is that this rides in evidence, never a new OutcomeStatus.
  const counts = countPopulations(
    [officialOc("EXCLUDED", { ipp: true, denom: true, denex: false, denexcep: true, numer: false }, "cms68")],
    "cms68",
  );
  assert.equal(counts.ipp, 1);
  assert.equal(counts.denom, 1);
  assert.equal(counts.denexcep, 1);
  assert.equal(counts.denex, 0);
});

test("PR-3: individual MeasureReport uses official membership too", () => {
  const report = buildIndividualMeasureReport(
    officialOc("OVERDUE", { ipp: true, denom: true, denex: false, numer: true }),
    run,
    "cms122",
    GENERATED_AT,
  );
  const pop = (code: string) =>
    report.group[0]?.population.find((p) => p.code.coding[0]?.code === code)?.count;
  assert.equal(pop("numerator"), 1);
  assert.equal(pop("initial-population"), 1);
});

test("PR-3: authored outcomes are UNCHANGED — no official evidence means the status rule still applies", () => {
  // The zero-behavior-change guarantee for this PR: every authored measure keeps today's counts.
  const authored = [oc("COMPLIANT"), oc("OVERDUE"), oc("EXCLUDED"), oc("MISSING_DATA")];
  assert.deepEqual(countPopulations(authored, "audiogram"), { ipp: 4, denom: 4, denex: 1, numer: 1, denexcep: 0 });
  // cms122 keeps its binding-driven MISSING_DATA-is-out-of-population behavior (ADR-031).
  assert.deepEqual(countPopulations(authored, "cms122"), { ipp: 3, denom: 3, denex: 1, numer: 1, denexcep: 0 });
});

test("PR-3: malformed official evidence falls back to the status rule rather than throwing", () => {
  const bad: OutcomeRecord = {
    id: "bad", runId: "run-1", subjectId: "emp-bad", measureId: "cms122",
    evaluationPeriod: "2026-06-12", status: "COMPLIANT",
    evidence: { official: { populationResults: "not-an-object" } },
    evaluatedAt: "2026-06-12T00:01:00.000Z",
  };
  assert.deepEqual(countPopulations([bad], "cms122"), { ipp: 1, denom: 1, denex: 0, numer: 1, denexcep: 0 });
});


/** Silence the deliberate WORKWELL_ALERT lines while asserting the degrade paths. */
function quietly<T>(fn: () => T): T {
  const original = console.error;
  console.error = () => {};
  try { return fn(); } finally { console.error = original; }
}

test("PR-3 parser: accepts the fqm-native array shape (what the writer most naturally produces)", () => {
  const m = officialMembership({
    official: {
      populationResults: [
        { populationType: "initial-population", result: true },
        { populationType: "denominator", result: true },
        { populationType: "denominator-exclusion", result: false },
        { populationType: "numerator", result: true },
      ],
    },
  });
  assert.deepEqual(m, { ipp: true, denom: true, denex: false, numer: true, denexcep: false });
});

test("PR-3 parser: accepts denominator-exception from the array shape", () => {
  const m = officialMembership({
    official: {
      populationResults: [
        { populationType: "initial-population", result: true },
        { populationType: "denominator", result: true },
        { populationType: "denominator-exception", result: true },
        { populationType: "numerator", result: false },
      ],
    },
  });
  assert.equal(m?.denexcep, true);
});

test("PR-3 parser: a partially-spelled keyed payload is REJECTED, not read as all-false", () => {
  // The silent-misread hazard: `denominator`/`numerator` spelled out would otherwise yield
  // DENOM 0 / NUMER 0 with no signal - a plausible-looking but wrong regulatory artifact.
  const m = quietly(() =>
    officialMembership({ official: { populationResults: { ipp: true, denominator: true, numerator: true } } }),
  );
  assert.equal(m, null);
});

test("PR-3 parser: absent official evidence is silent; present-but-unreadable is LOUD", () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: unknown) => { lines.push(String(msg)); };
  try {
    assert.equal(officialMembership({ expressionResults: [] }), null, "authored evidence -> null");
    assert.equal(lines.length, 0, "an authored outcome must not alert");
    officialMembership({ official: { populationResults: "nope" } });
    assert.equal(lines.length, 1, "unreadable official evidence must alert");
    assert.match(lines[0] ?? "", /WORKWELL_ALERT.*OFFICIAL_POPULATION_RESULTS_UNREADABLE/);
  } finally {
    console.error = original;
  }
});

test("PR-3 parser: membership violating numer within denom within ipp is clamped, not emitted", () => {
  // A non-conformant report (numerator 1 / denominator 0) would be rejected by Cypress.
  const m = quietly(() =>
    officialMembership({ official: { populationResults: { ipp: true, denom: false, denex: false, numer: true } } }),
  );
  assert.deepEqual(m, { ipp: true, denom: false, denex: false, numer: false, denexcep: false });
});

test("PR-3: official individuals still sum exactly to the official summary (ADR-031 reconciliation)", () => {
  const officialOutcomes = [
    officialOc("OVERDUE", { ipp: true, denom: true, denex: false, numer: true }),
    officialOc("COMPLIANT", { ipp: true, denom: true, denex: false, numer: false }),
    officialOc("EXCLUDED", { ipp: true, denom: true, denex: true, numer: false }),
    officialOc("MISSING_DATA", { ipp: false, denom: false, denex: false, numer: false }),
  ];
  const summary = countPopulations(officialOutcomes, "cms122");
  const summed = officialOutcomes
    .map((o) => membershipFor(o, "cms122"))
    .reduce(
      (acc, m) => ({
        ipp: acc.ipp + (m.ipp ? 1 : 0),
        denom: acc.denom + (m.denom ? 1 : 0),
        denex: acc.denex + (m.denex ? 1 : 0),
        numer: acc.numer + (m.numer ? 1 : 0),
        denexcep: acc.denexcep + (m.denexcep ? 1 : 0),
      }),
      { ipp: 0, denom: 0, denex: 0, numer: 0, denexcep: 0 },
    );
  assert.deepEqual(summary, summed);
  assert.deepEqual(summary, { ipp: 3, denom: 3, denex: 1, numer: 1, denexcep: 0 });
});

test("PR-3: the histogram path CANNOT see official evidence - the divergence is pinned, not assumed", () => {
  // This is why routes/runs.ts sends official-routed measures down the row path
  // (wiring/official-routing.ts). Pin the trap concretely so prose is never the only guard.
  const officialOutcomes = [officialOc("OVERDUE", { ipp: true, denom: true, denex: false, numer: true })];
  const rowBased = countPopulations(officialOutcomes, "cms122");
  const histogram = populationCountsFromStatus([{ status: "OVERDUE", count: 1, latestEvaluatedAt: "2026-06-12T00:01:00.000Z" }], "cms122");
  assert.equal(rowBased.numer, 1, "official evidence says this subject IS the numerator");
  assert.equal(histogram.numer, 0, "the status histogram cannot know that - hence the routing guard");
});
