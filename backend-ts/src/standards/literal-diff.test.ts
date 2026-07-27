import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLiteralDiff, literalDiffAvailable, loadOfficialMeasureBundle, __clearLiteralDiffCache } from "./literal-diff.ts";
import {
  CMS122_DIABETES_OID,
  CMS122_HBA1C_OID,
  CMS122_QUALIFYING_VISIT_OIDS,
  CMS122_HOSPICE_OID,
  CMS122_PALLIATIVE_OID,
} from "./cms122-official.ts";
import { CMS122V14 } from "./references/cms122v14.ts";
import { loadOfficialArtifact } from "../wiring/official-artifacts.ts";
import { officialMeasurementPeriod } from "../wiring/official-executor-adapter.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";
import { CMS125V14 } from "./references/cms125v14.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededTargetFor } from "../run/distribution.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";

/**
 * Terminology for the tests that assert MAPPING rather than terminology. Injected so the offline suite
 * never depends on the fetched-at-build sidecar — the real one is exercised by the end-to-end test
 * below, which self-skips without it.
 */
const STUB_TERMINOLOGY: unknown[] = [];

// Resolver supplying the gating VSAC members (diabetes / HbA1c / office visit / hospice / palliative);
// everything else resolves empty → an empty-but-present ValueSet in the fqm cache (no missing-VS error).
const RESOLVER: ValueSetResolver = {
  expand: (oid) =>
    Promise.resolve(
      oid === CMS122_DIABETES_OID ? [{ code: "44054006", system: "http://snomed.info/sct" }]
      : oid === CMS122_HBA1C_OID ? [{ code: "4548-4", system: "http://loinc.org" }]
      : oid === CMS122_QUALIFYING_VISIT_OIDS[0] ? [{ code: "99213", system: "http://www.ama-assn.org/go/cpt" }]
      : oid === CMS122_HOSPICE_OID ? [{ code: "183919006", system: "http://snomed.info/sct" }]
      : oid === CMS122_PALLIATIVE_OID ? [{ code: "103735009", system: "http://snomed.info/sct" }]
      : [],
    ),
};

const rows = (n: number) =>
  EMPLOYEES.slice(0, n).map((e) => ({ subjectId: e.externalId, status: "MISSING_DATA", runId: "run-lit-1", runStartedAt: "2026-06-30T00:00:00Z" }));

test("vendored official CMS122v14 bundle is present with pre-compiled ELM (the gate)", () => {
  // `literalDiffAvailable()` is deliberately NOT asserted here: since ADR-036 it also reports whether
  // the fetched-at-build terminology sidecar is present, which is a fact about the working tree. This
  // test is about the COMMITTED artifact, and that must hold on any clone.
  const b = loadOfficialMeasureBundle("cms122");
  assert.ok(b);
  const libs = b!.entry.filter((e) => e.resource?.resourceType === "Library");
  assert.equal(libs.length, 9);
  for (const l of libs) {
    const c = l.resource.content as Array<{ contentType?: string; data?: string }>;
    assert.ok(c.some((x) => x.contentType === "application/elm+json" && x.data), "every library carries base64 elm+json");
  }
});

test("literal diff: injected calculate → per-subject mapping, gate attribution, memoization", async () => {
  __clearLiteralDiffCache();
  // A deterministic fake fqm-execution: read the enriched patient bundle ids and assign populations by index.
  const fakeCalculate = (_mb: unknown, patientBundles: unknown[]) => {
    const results = (patientBundles as Array<{ entry: Array<{ resource: { resourceType?: string; id?: string } }> }>).map((pb, i) => {
      const patientId = pb.entry.find((e) => e.resource.resourceType === "Patient")?.resource.id;
      // rotate: in-numerator (OVERDUE), in-compliant, excluded, out-of-population
      const kind = i % 4;
      const populationResults =
        kind === 0 ? [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }, { populationType: "denominator-exclusion", result: false }, { populationType: "numerator", result: true }]
        : kind === 1 ? [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }, { populationType: "denominator-exclusion", result: false }, { populationType: "numerator", result: false }]
        : kind === 2 ? [{ populationType: "initial-population", result: true }, { populationType: "denominator", result: true }, { populationType: "denominator-exclusion", result: true }, { populationType: "numerator", result: false }]
        : [{ populationType: "initial-population", result: false }, { populationType: "denominator", result: false }, { populationType: "denominator-exclusion", result: false }, { populationType: "numerator", result: false }];
      return { patientId, detailedResults: [{ populationResults }] };
    });
    return Promise.resolve({ results });
  };

  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", valueSetCache: STUB_TERMINOLOGY, calculate: fakeCalculate };
  const report = await computeLiteralDiff(CMS122V14, rows(12), deps);

  assert.equal(report.mode, "literal");
  assert.equal(report.runId, "run-lit-1");
  assert.equal(report.subjects.length, 12);
  // Read from the manifest, never a literal: spelling the version into a test is the same staleness
  // trap that let the vendored artifact sit at v0.5.000 while upstream had moved on (PR-5).
  assert.equal(report.officialMeasure.version, loadOfficialArtifact("cms122")?.manifest.version);
  assert.match(report.officialMeasure.version, /^\d+\.\d+\.\d+$/);
  // Official outcomes span the mapped vocabulary — which is now the RUNTIME's, not a diff-local one.
  // Out-of-population reads MISSING_DATA here because that is what `outcomeFromPopulations` returns and
  // what the authored measures say for not-in-IPP; the diff used to emit its own `OUT_OF_POPULATION`
  // and count the resulting mismatch as a divergence the flip would never produce.
  const outs = new Set(report.subjects.map((s) => s.officialOutcome));
  assert.ok(outs.has("OVERDUE") && outs.has("COMPLIANT") && outs.has("EXCLUDED") && outs.has("MISSING_DATA"));
  assert.ok(!outs.has("OUT_OF_POPULATION"), "the diff must not invent a vocabulary the runtime lacks");
  // Every divergent subject carries a non-empty, derivable gate.
  for (const s of report.subjects.filter((x) => x.diverged)) assert.ok(s.divergenceGate.length > 0);
  // Attribution vocabulary is population-level and honest.
  for (const g of Object.keys(report.byGate)) {
    assert.ok(["initial-population", "denominator-exclusion", "workwell-exclusion", "numerator", "workwell-side"].includes(g));
  }

  // Memoized per run-id.
  const again = await computeLiteralDiff(CMS122V14, rows(12), deps);
  assert.equal(again, report);
});

test("literal diff: fqm-execution options disable HTML/coverage/RAV output (Codex P2, #277)", async () => {
  __clearLiteralDiffCache();
  let capturedOptions: Record<string, unknown> | undefined;
  const spyCalculate = (_mb: unknown, patientBundles: unknown[], options: unknown) => {
    capturedOptions = options as Record<string, unknown>;
    return Promise.resolve({
      results: (patientBundles as Array<{ entry: Array<{ resource: { resourceType?: string; id?: string } }> }>).map((pb) => ({
        patientId: pb.entry.find((e) => e.resource.resourceType === "Patient")?.resource.id,
        detailedResults: [{ populationResults: [{ populationType: "initial-population", result: false }] }],
      })),
    });
  };
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", valueSetCache: STUB_TERMINOLOGY, calculate: spyCalculate };
  await computeLiteralDiff(CMS122V14, rows(4), deps);
  assert.ok(capturedOptions, "calculate must be invoked with an options object");
  assert.equal(capturedOptions!.calculateHTML, false, "fqm-execution 1.8.5 has no disableHTMLGeneration option — calculateHTML must be explicitly disabled");
  assert.equal(capturedOptions!.calculateClauseCoverage, false);
  assert.equal(capturedOptions!.calculateRAVs, false);
  assert.equal(capturedOptions!.calculateSDEs, false);
  // Derived from the SHARED helper the runtime executor uses, never a literal: the point of PR-8d is
  // that the diff and the runtime cannot disagree about the measurement period, and a hardcoded date
  // here would let them drift apart while the test still passed. It used to read the calendar year.
  const period = officialMeasurementPeriod("cms122", "2026-06-30");
  assert.equal(capturedOptions!.measurementPeriodStart, period.start);
  assert.equal(capturedOptions!.measurementPeriodEnd, period.end);
  assert.equal(period.start, "2025-06-30", "the registry window is rolling 12 months, not the calendar year");
  assert.equal(capturedOptions!.disableHTMLGeneration, undefined, "disableHTMLGeneration is not a real fqm-execution option — must not be relied on");
});

test("literal diff: REAL fqm-execution runs the official QICore artifact end-to-end", {
  // The one test here that must use the REAL terminology: it executes the actual QICore artifact, and
  // an empty stub cache would make every retrieve match nothing — the run would "pass" while proving
  // the opposite of what it claims. Self-skips without the fetched sidecar; CI's official-cases job
  // has it.
  skip: literalDiffAvailable("cms122") ? false : "run 'pnpm vendor:official' to fetch the terminology sidecar",
}, async () => {
  __clearLiteralDiffCache();
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30" };
  // Small slice so the (real) QICore multi-library execution stays fast; ELM is cached across patients.
  const report = await computeLiteralDiff(CMS122V14, rows(8), deps);
  assert.equal(report.mode, "literal");
  assert.equal(report.subjects.length, 8);
  // The QICore-structural stamping must let at least one subject populate (not everyone out-of-pop/ERROR):
  const inPopulation = report.subjects.filter((s) => s.officialOutcome !== "OUT_OF_POPULATION" && s.officialOutcome !== "ERROR");
  assert.ok(inPopulation.length >= 1, "the literal QICore measure must place ≥1 subject in-population");
  assert.equal(report.totalErrors, 0, "no subject should fail to evaluate");
});

test("ADR-008 guard: the literal diff reports the outcome the RUNTIME authored engine would give", async () => {
  // Strengthened in PR-8d, because the diff no longer enriches. It used to evaluate WorkWell on the
  // enriched + stamped bundle, so the strongest available assertion was self-consistency across two
  // passes — true of any deterministic function, including a wrong one. Now the diff feeds the authored
  // engine the plain synthetic bundle, exactly as a run does, so the real property is assertable:
  // WorkWell's side of the diff must equal a direct evaluation of the same subject. If it ever diverges,
  // the diff is reporting a WorkWell outcome that will not occur, and the shadow forecasts nothing.
  __clearLiteralDiffCache();
  const engine = new CqlExecutionEngine({ valueSetResolver: RESOLVER });
  const noopCalculate = (_mb: unknown, patientBundles: unknown[]) =>
    Promise.resolve({ results: (patientBundles as Array<{ entry: Array<{ resource: { resourceType?: string; id?: string } }> }>).map((pb) => ({ patientId: pb.entry.find((e) => e.resource.resourceType === "Patient")?.resource.id, detailedResults: [{ populationResults: [{ populationType: "initial-population", result: false }] }] })) });
  const report = await computeLiteralDiff(CMS122V14, rows(20), { engine, resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", valueSetCache: STUB_TERMINOLOGY, calculate: noopCalculate });

  const binding = MEASURE_BINDINGS["cms122"]!;
  for (const subject of report.subjects) {
    const employee = EMPLOYEES.find((e) => e.externalId === subject.subjectId)!;
    const target = seededTargetFor(EMPLOYEES, binding.rateKey, subject.subjectId) ?? "MISSING_DATA";
    const bundle = buildSyntheticBundle(employee, deriveExamConfig(binding, target), "2026-06-30");
    const direct = await engine.evaluate({ measureId: "cms122", patientBundle: bundle, evaluationDate: "2026-06-30" });
    assert.equal(
      subject.workwellOutcome,
      direct.outcome,
      `the diff reports ${subject.subjectId} as ${subject.workwellOutcome}, a run would say ${direct.outcome}`,
    );
  }
  // And no subject is ERROR from the WorkWell side of the harness.
  assert.ok(report.subjects.every((s) => s.workwellOutcome !== "ERROR"));
});

test("literal tier is available for cms125, not just cms122", () => {
  // The capability PR-8d adds. `literalDiffAvailable` was argument-less and cms122-hardcoded, so the
  // route declined cms125's literal tier and answered with the estimate — while the roadmap described
  // the shadow period as a cms122+cms125 exercise. Asserted on the COMMITTED artifact + semantics, with
  // the terminology sidecar excluded, so it holds on a fresh clone.
  for (const id of ["cms122", "cms125"]) {
    assert.ok(loadOfficialMeasureBundle(id), `${id}: no vendored official bundle`);
    assert.ok(officialMeasureSemantics(id), `${id}: no recorded numerator semantics`);
  }
  assert.equal(literalDiffAvailable("hypertension"), false, "a measure with no official artifact must not claim the tier");
});

test("cms125's numerator is NOT inverted (the mapping is per-measure)", async () => {
  // cms122's numerator is poor glycemic control; cms125's is a completed mammogram. The mapping was
  // hardcoded to the first reading, so had cms125 ever reached this tier it would have reported every
  // screened woman OVERDUE. One subject, in-numerator, through each measure's own semantics.
  const inNumerator = (patientBundles: unknown[]) =>
    Promise.resolve({
      results: (patientBundles as Array<{ entry: Array<{ resource: { resourceType?: string; id?: string } }> }>).map((pb) => ({
        patientId: pb.entry.find((e) => e.resource.resourceType === "Patient")?.resource.id,
        detailedResults: [{ populationResults: [
          { populationType: "initial-population", result: true },
          { populationType: "denominator", result: true },
          { populationType: "denominator-exclusion", result: false },
          { populationType: "numerator", result: true },
        ] }],
      })),
    });
  const calculate = (_mb: unknown, patientBundles: unknown[]) => inNumerator(patientBundles);
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", valueSetCache: STUB_TERMINOLOGY, calculate };

  // Deliberately ONE cache clear, at the top. Both calls use the same runId, because that is what an
  // ALL_PROGRAMS run produces: every measure's outcomes under one `runs.id`. Clearing between them
  // would hide the memo-collision this also guards — see the next test.
  __clearLiteralDiffCache();
  const cms122 = await computeLiteralDiff(CMS122V14, rows(2), deps);
  assert.ok(cms122.subjects.every((s) => s.officialOutcome === "OVERDUE"), "cms122 numerator = poor control → OVERDUE");

  const cms125 = await computeLiteralDiff(CMS125V14, rows(2), deps);
  assert.ok(cms125.subjects.every((s) => s.officialOutcome === "COMPLIANT"), "cms125 numerator = screened → COMPLIANT");
});

test("the memo is keyed by MEASURE and run, not run alone", async () => {
  // An ALL_PROGRAMS run writes every measure's outcomes under ONE `runs.id`, so `latestRunRows` hands
  // both measures the same run id. Keyed on runId alone — which was safe while this tier was
  // cms122-only — the second request returned the FIRST measure's whole report: its measureId, ecqmId,
  // subjects and provenance, under the other measure's URL. The same "one measure's criteria under
  // another measure's name" the route guards against, one layer down.
  const calculate = (_mb: unknown, patientBundles: unknown[]) =>
    Promise.resolve({
      results: (patientBundles as Array<{ entry: Array<{ resource: { resourceType?: string; id?: string } }> }>).map((pb) => ({
        patientId: pb.entry.find((e) => e.resource.resourceType === "Patient")?.resource.id,
        detailedResults: [{ populationResults: [{ populationType: "initial-population", result: false }] }],
      })),
    });
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", valueSetCache: STUB_TERMINOLOGY, calculate };

  __clearLiteralDiffCache();
  const first = await computeLiteralDiff(CMS122V14, rows(2), deps);
  const second = await computeLiteralDiff(CMS125V14, rows(2), deps);

  assert.equal(first.measureId, "cms122");
  assert.equal(second.measureId, "cms125", "the second measure was served the first measure's memoized report");
  assert.equal(second.ecqmId, CMS125V14.ecqmId);
  assert.notEqual(first, second);

  // ...and the memo still WORKS: same measure + same run is the same object.
  assert.equal(await computeLiteralDiff(CMS125V14, rows(2), deps), second);
});
