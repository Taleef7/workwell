import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLiteralDiff, literalDiffAvailable, loadOfficialCms122Bundle, __clearLiteralDiffCache } from "./literal-diff.ts";
import {
  CMS122_DIABETES_OID,
  CMS122_HBA1C_OID,
  CMS122_QUALIFYING_VISIT_OIDS,
  CMS122_HOSPICE_OID,
  CMS122_PALLIATIVE_OID,
} from "./cms122-official.ts";
import { CMS122V14 } from "./references/cms122v14.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import type { ValueSetResolver } from "../engine/cql/value-set-resolver.ts";

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
  assert.equal(literalDiffAvailable(), true);
  const b = loadOfficialCms122Bundle();
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

  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", calculate: fakeCalculate };
  const report = await computeLiteralDiff(CMS122V14, rows(12), deps);

  assert.equal(report.mode, "literal");
  assert.equal(report.runId, "run-lit-1");
  assert.equal(report.subjects.length, 12);
  assert.equal(report.officialMeasure.version, "0.5.000");
  // Official outcomes span the mapped vocabulary.
  const outs = new Set(report.subjects.map((s) => s.officialOutcome));
  assert.ok(outs.has("OVERDUE") && outs.has("COMPLIANT") && outs.has("EXCLUDED") && outs.has("OUT_OF_POPULATION"));
  // Every divergent subject carries a non-empty, derivable gate.
  for (const s of report.subjects.filter((x) => x.diverged)) assert.ok(s.divergenceGate.length > 0);
  // Attribution vocabulary is population-level and honest.
  for (const g of Object.keys(report.byGate)) {
    assert.ok(["initial-population", "denominator-exclusion", "workwell-exclusion", "numerator-glycemic-status", "workwell-side"].includes(g));
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
  const deps = { engine: new CqlExecutionEngine({ valueSetResolver: RESOLVER }), resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", calculate: spyCalculate };
  await computeLiteralDiff(CMS122V14, rows(4), deps);
  assert.ok(capturedOptions, "calculate must be invoked with an options object");
  assert.equal(capturedOptions!.calculateHTML, false, "fqm-execution 1.8.5 has no disableHTMLGeneration option — calculateHTML must be explicitly disabled");
  assert.equal(capturedOptions!.calculateClauseCoverage, false);
  assert.equal(capturedOptions!.calculateRAVs, false);
  assert.equal(capturedOptions!.calculateSDEs, false);
  assert.equal(capturedOptions!.measurementPeriodStart, "2026-01-01");
  assert.equal(capturedOptions!.measurementPeriodEnd, "2026-12-31T23:59:59.999Z");
  assert.equal(capturedOptions!.disableHTMLGeneration, undefined, "disableHTMLGeneration is not a real fqm-execution option — must not be relied on");
});

test("literal diff: REAL fqm-execution runs the official QICore artifact end-to-end", async () => {
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

test("ADR-008 guard: the literal diff never changes WorkWell's cms122 outcome on the harness bundle", async () => {
  // The harness evaluates WorkWell on the *enriched + QICore-stamped* patient bundle (age-out /
  // hospice / GMI injection for the diagnostic ladder). ADR-008 means that path is deterministic and
  // read-only — re-evaluating the same subject with the same enricher input yields the same Outcome
  // Status. Comparing against the unenriched synthetic base is wrong: production cms122 now reads
  // age/visit/DENEX, so enrichment intentionally changes some WorkWell outcomes (e.g. emp-005 age-out).
  __clearLiteralDiffCache();
  const engine = new CqlExecutionEngine({ valueSetResolver: RESOLVER });
  const noopCalculate = (_mb: unknown, patientBundles: unknown[]) =>
    Promise.resolve({ results: (patientBundles as Array<{ entry: Array<{ resource: { resourceType?: string; id?: string } }> }>).map((pb) => ({ patientId: pb.entry.find((e) => e.resource.resourceType === "Patient")?.resource.id, detailedResults: [{ populationResults: [{ populationType: "initial-population", result: false }] }] })) });
  const report = await computeLiteralDiff(CMS122V14, rows(20), { engine, resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", calculate: noopCalculate });
  // Second independent pass through computeLiteralDiff (cleared cache) must match byte-for-byte.
  __clearLiteralDiffCache();
  const again = await computeLiteralDiff(CMS122V14, rows(20), { engine, resolver: RESOLVER, employees: EMPLOYEES, today: "2026-06-30", asOf: "2026-06-30", calculate: noopCalculate });
  assert.equal(again.subjects.length, report.subjects.length);
  for (let i = 0; i < report.subjects.length; i++) {
    const a = report.subjects[i]!;
    const b = again.subjects[i]!;
    assert.equal(a.subjectId, b.subjectId);
    assert.equal(a.workwellOutcome, b.workwellOutcome, `literal diff non-deterministic WorkWell cms122 for ${a.subjectId}`);
  }
  // And no subject is ERROR from the WorkWell side of the harness.
  assert.ok(report.subjects.every((s) => s.workwellOutcome !== "ERROR"));
});
