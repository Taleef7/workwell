/**
 * Generation ↔ evaluation golden test (#107): for each runnable measure + seeded target,
 * derive the exam config → build the synthetic FHIR bundle → evaluate through the JVM-free
 * CQL engine, and assert the ACTUAL engine outcome. Proves the ported synthetic generator
 * drives the engine exactly like the Java SyntheticFhirBundleBuilder.
 *
 * The seeded target is a *distribution bucket*, not a guarantee — the canonical outcome is
 * always the CQL result (AI/seed never decides compliance). For season-based (flu) and
 * value-based (cms122) measures, some buckets intentionally converge to a different outcome,
 * exactly as the Java seeded distribution does (it assigns the same buckets and persists the
 * CQL result). Those convergences are pinned below so they can never drift silently.
 *   node --import tsx --test src/engine/synthetic/fhir-bundle-builder.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../cql/cql-execution-engine.ts";
import { MEASURE_BINDINGS } from "./measure-bindings.ts";
import { deriveExamConfig, withRefusal, type TargetOutcome } from "./exam-config.ts";
import { buildSyntheticBundle } from "./fhir-bundle-builder.ts";
import { employeeById } from "./employee-catalog.ts";

const QICORE_BASE = "http://hl7.org/fhir/us/qicore/StructureDefinition/";

/** Every resource in a synthetic bundle must declare a QI-Core profile (#92 / E3.4). */
function assertAllQiCore(bundle: { entry: Array<{ resource: unknown }> }): void {
  for (const entry of bundle.entry) {
    const resource = entry.resource as Record<string, unknown>;
    const meta = resource["meta"] as { profile?: string[] } | undefined;
    assert.ok(meta && Array.isArray(meta.profile) && meta.profile.length > 0,
      `resource ${String(resource["resourceType"])} is missing meta.profile`);
    assert.ok(meta.profile[0]!.startsWith(QICORE_BASE),
      `resource ${String(resource["resourceType"])} profile "${meta.profile[0]}" does not start with "${QICORE_BASE}"`);
  }
}

const engine = new CqlExecutionEngine();
const EVAL_DATE = "2026-06-13";
const emp = employeeById("emp-006")!; // Omar Siddiq, Welder, Plant A

// [measureId, seeded target bucket, expected canonical CQL outcome]
const CASES: Array<[string, TargetOutcome, string]> = [
  // recency / Procedure (window 365): target == actual for every bucket
  ["audiogram", "COMPLIANT", "COMPLIANT"],
  ["audiogram", "DUE_SOON", "DUE_SOON"],
  ["audiogram", "OVERDUE", "OVERDUE"],
  ["audiogram", "MISSING_DATA", "MISSING_DATA"],
  ["audiogram", "EXCLUDED", "EXCLUDED"],
  // recency with a non-365 window (180)
  ["diabetes_hba1c", "COMPLIANT", "COMPLIANT"],
  ["diabetes_hba1c", "OVERDUE", "OVERDUE"],
  // Immunization, season-based: the DUE_SOON bucket is an in-period shot → COMPLIANT
  ["flu_vaccine", "COMPLIANT", "COMPLIANT"],
  ["flu_vaccine", "DUE_SOON", "COMPLIANT"], // convergence (matches Java seeded distribution)
  ["flu_vaccine", "OVERDUE", "OVERDUE"],
  ["flu_vaccine", "MISSING_DATA", "MISSING_DATA"],
  ["flu_vaccine", "EXCLUDED", "EXCLUDED"],
  // Observation, value-based (HbA1c > 9%): the DUE_SOON bucket has no value → MISSING_DATA
  ["cms122", "COMPLIANT", "COMPLIANT"],
  ["cms122", "DUE_SOON", "MISSING_DATA"], // convergence (value-based has no due-soon)
  ["cms122", "OVERDUE", "OVERDUE"],
  ["cms122", "MISSING_DATA", "MISSING_DATA"],
  ["cms122", "EXCLUDED", "EXCLUDED"],
  // PERMANENT series (MMR): COMPLIANT (old doses still compliant), partial → MISSING_DATA, none → MISSING_DATA, excluded
  ["mmr", "COMPLIANT", "COMPLIANT"],
  ["mmr", "OVERDUE", "MISSING_DATA"],
  ["mmr", "MISSING_DATA", "MISSING_DATA"],
  ["mmr", "EXCLUDED", "EXCLUDED"],
  // PERMANENT series (Varicella): same pattern as MMR
  ["varicella", "COMPLIANT", "COMPLIANT"],
  ["varicella", "OVERDUE", "MISSING_DATA"],
  ["varicella", "MISSING_DATA", "MISSING_DATA"],
  ["varicella", "EXCLUDED", "EXCLUDED"],
  // PERMANENT series (Hepatitis B): same pattern as MMR/Varicella
  ["hepatitis_b_vaccination_series", "COMPLIANT", "COMPLIANT"],
  ["hepatitis_b_vaccination_series", "OVERDUE", "MISSING_DATA"],
  ["hepatitis_b_vaccination_series", "MISSING_DATA", "MISSING_DATA"],
  ["hepatitis_b_vaccination_series", "EXCLUDED", "EXCLUDED"],
];

for (const [measureId, target, expected] of CASES) {
  test(`${measureId}: seeded ${target} → engine ${expected}`, async () => {
    const config = deriveExamConfig(MEASURE_BINDINGS[measureId]!, target);
    const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
    const result = await engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: EVAL_DATE });
    assert.equal(result.outcome, expected, `${measureId} seeded ${target} → got ${result.outcome}, expected ${expected}`);
    assert.equal(result.subjectId, "emp-006");
  });
}

// ---------------------------------------------------------------------------
// QI-Core meta.profile structural tests (#92 E3.4 Task 1)
// ---------------------------------------------------------------------------

test("QI-Core profiles: audiogram COMPLIANT bundle (Procedure) — Patient + Condition + Procedure all carry correct meta.profile", () => {
  const config = deriveExamConfig(MEASURE_BINDINGS["audiogram"]!, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);

  // Universal invariant: every resource in the bundle must carry a QI-Core profile.
  assertAllQiCore(bundle);

  // Patient: required fields + correct profile
  const patientEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Patient",
  );
  assert.ok(patientEntry, "Patient entry must exist");
  const patient = patientEntry.resource as Record<string, unknown>;
  assert.equal((patient["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-patient`);
  assert.ok(patient["id"], "Patient must have id");
  assert.ok(Array.isArray(patient["name"]) && (patient["name"] as unknown[]).length > 0, "Patient must have name");

  // Condition (enrollment): required fields + correct profile
  const conditionEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Condition",
  );
  assert.ok(conditionEntry, "Condition (enrollment) entry must exist for enrolled employee");
  const condition = conditionEntry.resource as Record<string, unknown>;
  assert.equal((condition["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-condition`);
  assert.ok(condition["clinicalStatus"], "Condition must have clinicalStatus");
  assert.ok(condition["verificationStatus"], "Condition must have verificationStatus");
  assert.ok(condition["code"], "Condition must have code");
  assert.ok(condition["subject"], "Condition must have subject");

  // Procedure (qualifying event): required fields + correct profile
  const procedureEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Procedure",
  );
  assert.ok(procedureEntry, "Procedure entry must exist for COMPLIANT audiogram");
  const procedure = procedureEntry.resource as Record<string, unknown>;
  assert.equal((procedure["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-procedure`);
  assert.ok(procedure["status"], "Procedure must have status");
  assert.ok(procedure["code"], "Procedure must have code");
  assert.ok(procedure["subject"], "Procedure must have subject");
});

test("QI-Core profiles: flu_vaccine COMPLIANT bundle (Immunization) — Immunization carries correct meta.profile", () => {
  const config = deriveExamConfig(MEASURE_BINDINGS["flu_vaccine"]!, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);

  // Universal invariant
  assertAllQiCore(bundle);

  // Immunization: required fields + correct profile
  const immunizationEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Immunization",
  );
  assert.ok(immunizationEntry, "Immunization entry must exist for COMPLIANT flu_vaccine");
  const immunization = immunizationEntry.resource as Record<string, unknown>;
  assert.equal((immunization["meta"] as { profile: string[] }).profile[0], `${QICORE_BASE}qicore-immunization`);
  assert.ok(immunization["status"], "Immunization must have status");
  assert.ok(immunization["vaccineCode"], "Immunization must have vaccineCode");
  assert.ok(immunization["patient"], "Immunization must have patient");
});

test("QI-Core profiles: cms122 COMPLIANT bundle (Observation) — Observation carries correct meta.profile", () => {
  const config = deriveExamConfig(MEASURE_BINDINGS["cms122"]!, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);

  // Universal invariant
  assertAllQiCore(bundle);

  // Observation: required fields + correct profile
  const observationEntry = bundle.entry.find(
    (e) => (e.resource as Record<string, unknown>)["resourceType"] === "Observation",
  );
  assert.ok(observationEntry, "Observation entry must exist for COMPLIANT cms122");
  const observation = observationEntry.resource as Record<string, unknown>;
  assert.equal(
    (observation["meta"] as { profile: string[] }).profile[0],
    `${QICORE_BASE}qicore-observation-clinical-result`,
  );
  assert.ok(observation["status"], "Observation must have status");
  assert.ok(observation["code"], "Observation must have code");
  assert.ok(observation["subject"], "Observation must have subject");
});

test("emits a refusal Condition when config.refused and binding.refusal present", () => {
  const binding = MEASURE_BINDINGS["adult_immunization"];
  const base = deriveExamConfig(binding!, "OVERDUE");
  const bundle = buildSyntheticBundle(
    { externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A", providerId: "prov-001", tenantId: "twh" },
    withRefusal(base),
    "2026-06-19",
  );
  const codes = bundle.entry
    .map((e) => (e.resource as { code?: { coding?: { code?: string }[] } }).code?.coding?.[0]?.code)
    .filter(Boolean);
  assert.ok(codes.includes("tdap-refusal"), `expected tdap-refusal in ${JSON.stringify(codes)}`);
});

test("does NOT emit a refusal Condition when config.refused is false", () => {
  const binding = MEASURE_BINDINGS["adult_immunization"];
  const bundle = buildSyntheticBundle(
    { externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A", providerId: "prov-001", tenantId: "twh" },
    deriveExamConfig(binding!, "OVERDUE"),
    "2026-06-19",
  );
  const codes = bundle.entry
    .map((e) => (e.resource as { code?: { coding?: { code?: string }[] } }).code?.coding?.[0]?.code)
    .filter(Boolean);
  assert.ok(!codes.includes("tdap-refusal"));
});

// ---------------------------------------------------------------------------
// PERMANENT series (multi-dose) tests (E10 Task 2)
// ---------------------------------------------------------------------------

test("permanent series: COMPLIANT bucket emits requiredDoses Immunizations", () => {
  const binding = {
    rateKey: "test_series", complianceClass: "PERMANENT" as const, complianceWindowDays: 0,
    enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
    waiver: { code: "x-contra", valueSet: "urn:workwell:vs:x-contra" },
    event: { code: "x-vaccine", valueSet: "urn:workwell:vs:x-vaccines", type: "immunization" as const },
    series: { requiredDoses: 2 },
  };
  const config = deriveExamConfig(binding, "COMPLIANT");
  assert.equal(config.doseCount, 2);
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
  const imms = bundle.entry.filter((e) => (e.resource as Record<string, unknown>)["resourceType"] === "Immunization");
  assert.equal(imms.length, 2, "two completed doses expected for a 2-dose series");
});

test("permanent series: OVERDUE bucket emits a partial series (requiredDoses - 1)", () => {
  const binding = {
    rateKey: "test_series", complianceClass: "PERMANENT" as const, complianceWindowDays: 0,
    enrollment: { code: "immz-enrolled", valueSet: "urn:workwell:vs:immz-enrollment" },
    waiver: { code: "x-contra", valueSet: "urn:workwell:vs:x-contra" },
    event: { code: "x-vaccine", valueSet: "urn:workwell:vs:x-vaccines", type: "immunization" as const },
    series: { requiredDoses: 2 },
  };
  const config = deriveExamConfig(binding, "OVERDUE");
  assert.equal(config.doseCount, 1);
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
  const imms = bundle.entry.filter((e) => (e.resource as Record<string, unknown>)["resourceType"] === "Immunization");
  assert.equal(imms.length, 1, "one dose expected for a partial 2-dose series");
});

// E11.2c — multi-alternative series (Hep B Heplisav-vs-traditional): the COMPLIANT bundle is stamped
// with ONE chosen alternative's real CVX code (not the legacy `hepb-vaccine` union placeholder) and its
// own dose count — so the per-alternative `<alt> Complete` CQL define matches.
test("multi-alternative series: Hep B COMPLIANT stamps a single alternative's CVX code + its dose count", () => {
  const binding = MEASURE_BINDINGS["hepatitis_b_vaccination_series"]!;
  const config = deriveExamConfig(binding, "COMPLIANT");
  const bundle = buildSyntheticBundle(emp, config, EVAL_DATE);
  const codes = bundle.entry
    .map((e) => e.resource as Record<string, unknown>)
    .filter((r) => r["resourceType"] === "Immunization")
    .map((r) => ((r["vaccineCode"] as { coding: { code: string }[] }).coding[0]!.code));
  assert.ok(codes.length > 0, "expected at least one Hep B dose");
  assert.ok(!codes.includes("hepb-vaccine"), "doses must use a real CVX code, not the union placeholder");
  const chosen = binding.alternatives!.find((a) => a.codes.includes(codes[0]!));
  assert.ok(chosen, `dose code ${codes[0]} must belong to a declared alternative`);
  assert.ok(codes.every((c) => c === codes[0]), "all doses share the one chosen alternative's code");
  assert.equal(codes.length, chosen!.requiredDoses, "dose count equals the chosen alternative's requiredDoses");
});

// Codex P2: a partial Hep B series must stay BELOW the roster's union denominator (series.requiredDoses)
// so the roster renders IN_PROGRESS — even when the employee hashes to the 3-dose Traditional alternative
// (which would otherwise emit 2 doses == the denominator and read as MISSING_DATA "2 dose(s) on file").
test("multi-alternative series: Hep B partial (OVERDUE) emits doses below the roster denominator, stays MISSING_DATA", async () => {
  const binding = MEASURE_BINDINGS["hepatitis_b_vaccination_series"]!;
  const required = binding.series!.requiredDoses; // union roster denominator (2)
  // Every directory employee must satisfy the cap, regardless of which alternative they hash to.
  for (const externalId of ["emp-001", "emp-002", "emp-003", "emp-006", "emp-010", "emp-021"]) {
    const e = employeeById(externalId);
    if (!e) continue;
    const config = deriveExamConfig(binding, "OVERDUE");
    const bundle = buildSyntheticBundle(e, config, EVAL_DATE);
    const imms = bundle.entry.filter((x) => (x.resource as Record<string, unknown>)["resourceType"] === "Immunization");
    assert.ok(imms.length < required, `${externalId}: partial dose count ${imms.length} must be < roster denominator ${required}`);
    assert.ok(imms.length >= 1, `${externalId}: a partial series still has at least one dose`);
    const result = await engine.evaluate({ measureId: "hepatitis_b_vaccination_series", patientBundle: bundle, evaluationDate: EVAL_DATE });
    assert.equal(result.outcome, "MISSING_DATA", `${externalId}: a partial series is canonically MISSING_DATA`);
  }
});
