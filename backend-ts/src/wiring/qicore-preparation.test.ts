/**
 * QICore bundle preparation (PR-8).
 *
 * The unit tests always run. The one that matters most — that preparation is what stands between the
 * official artifact and an entirely out-of-population roster — executes the real vendored artifact and
 * self-skips without the fetched terminology sidecar, like the rest of the official suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareForQiCore, preparedForQiCore, type PreparableBundle } from "./qicore-preparation.ts";
import { loadOfficialArtifact } from "./official-artifacts.ts";
import { loadOfficialTerminology, officialTerminologyExpander } from "./official-terminology.ts";
import { expandArtifactTerminology } from "./official-executor-adapter.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { seededTargetFor } from "../run/distribution.ts";
import { calculateOfficial, type MeasureBundle } from "@workwell/official-executor";

const bundleWith = (...resources: Array<Record<string, unknown>>): PreparableBundle => ({
  resourceType: "Bundle",
  type: "collection",
  entry: resources.map((resource) => ({ resource })),
});

test("a Condition gets the status QI-Core binds - and no invented onset", () => {
  const bundle = bundleWith({ resourceType: "Condition", id: "c1" });
  prepareForQiCore(bundle);
  const condition = bundle.entry[0]!.resource;
  assert.deepEqual(condition.clinicalStatus, {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }],
  });
  // An onset date is the date of a real event. CMS165 gates denominator membership on hypertension
  // onset relative to the measurement period, so minting one here would decide who is in the measure.
  // Measured, it also buys nothing: status alone already yields IPP=25/25 on the CMS122 artifact.
  assert.equal(condition.onsetDateTime, undefined, "onset is never fabricated");
});

test("a REAL clinicalStatus is preserved - resolved does not silently become active", () => {
  // The first cut overwrote unconditionally, which would have turned a corrected misdiagnosis into an
  // active confirmed problem: that patient enters CMS122's denominator and, with no HbA1c, its
  // numerator. The defect being fixed is an UNBINDABLE coding, so that is what the guard tests.
  const resolved = {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "resolved" }],
  };
  const bundle = bundleWith({ resourceType: "Condition", clinicalStatus: resolved });
  prepareForQiCore(bundle);
  assert.deepEqual(bundle.entry[0]!.resource.clinicalStatus, resolved);
});

test("prepared bundles never share a mutable object", () => {
  // Module-level constants assigned by reference would alias ONE object into every prepared bundle,
  // so a single downstream mutation would reach all of them at once.
  const a = bundleWith({ resourceType: "Condition" });
  const b = bundleWith({ resourceType: "Condition" });
  prepareForQiCore(a);
  prepareForQiCore(b);
  assert.notEqual(a.entry[0]!.resource.clinicalStatus, b.entry[0]!.resource.clinicalStatus);
  assert.deepEqual(a.entry[0]!.resource.clinicalStatus, b.entry[0]!.resource.clinicalStatus);
});

test("a system-less clinicalStatus is OVERWRITTEN, not merged", () => {
  // Merging would leave the unmatched synthetic coding beside a matched one and change nothing —
  // QI-Core binds ConditionClinicalStatusCodes, and a coding with no system cannot match it.
  const bundle = bundleWith({ resourceType: "Condition", clinicalStatus: { coding: [{ code: "active" }] } });
  prepareForQiCore(bundle);
  const coding = (bundle.entry[0]!.resource.clinicalStatus as { coding: Array<{ system?: string }> }).coding;
  assert.equal(coding.length, 1);
  assert.ok(coding[0]!.system, "the surviving coding must be the fully-qualified one");
});

test("data that already carries onset, category or Encounter class is left ALONE", () => {
  // This is what makes it safe over real WebChart data rather than only over the synthetic corpus:
  // structural gaps get filled, existing clinical metadata is never rewritten.
  const bundle = bundleWith(
    { resourceType: "Condition", onsetDateTime: "2019-04-04", category: [{ text: "real" }] },
    { resourceType: "Encounter", class: { code: "IMP" } },
  );
  prepareForQiCore(bundle);
  assert.equal(bundle.entry[0]!.resource.onsetDateTime, "2019-04-04");
  assert.deepEqual(bundle.entry[0]!.resource.category, [{ text: "real" }]);
  assert.deepEqual(bundle.entry[1]!.resource.class, { code: "IMP" });
});

test("it normalizes structure and never touches a clinical fact", () => {
  // The line this module must not cross: filling in FHIR metadata an official profile requires is
  // normalization; adding a code or a value would be fabricating a finding that never happened.
  const observation = { resourceType: "Observation", code: { coding: [{ code: "x" }] }, valueQuantity: { value: 9.5 } };
  const bundle = bundleWith(observation);
  const before = JSON.stringify(observation);
  prepareForQiCore(bundle);
  assert.equal(JSON.stringify(bundle.entry[0]!.resource), before, "Observations are not preparable");
});

test("the copying form leaves its input untouched", () => {
  // The runtime executor needs this: the authored engine may evaluate the same bundle, and ADR-008
  // requires its outcome to be byte-identical whether or not official routing is on.
  const bundle = bundleWith({ resourceType: "Condition", id: "c1" });
  const original = JSON.stringify(bundle);
  const prepared = preparedForQiCore(bundle);
  assert.equal(JSON.stringify(bundle), original, "the input must not be mutated");
  assert.notEqual(JSON.stringify(prepared), original);
});

// ---------------------------------------------------------------------------------------------------
// The real artifact. Self-skipping — `pnpm vendor:official` produces the terminology it needs.
// ---------------------------------------------------------------------------------------------------

const artifact = loadOfficialArtifact("cms122");
const skip =
  artifact && loadOfficialTerminology(artifact).ok
    ? false
    : "run 'pnpm vendor:official' to fetch the terminology sidecar";

test("WITHOUT preparation the official artifact reads the whole roster out-of-population", { skip }, async () => {
  // The claim the router's docstring has been carrying as prose since PR-7b, measured. It is the
  // silent kind of failure: a run that completes successfully and reports every subject MISSING_DATA.
  const cache = await expandArtifactTerminology(artifact!, officialTerminologyExpander(loadOfficialArtifact));
  const binding = (MEASURE_BINDINGS as Record<string, { rateKey: string }>)["cms122"]!;
  const subjects = EMPLOYEES.slice(0, 25);
  const asOf = "2026-06-01";

  const build = (prepare: boolean) =>
    subjects.map((employee) => {
      const target = seededTargetFor(EMPLOYEES, binding.rateKey, employee.externalId) ?? "MISSING_DATA";
      const bundle = buildSyntheticBundle(employee, deriveExamConfig(binding as never, target), asOf) as never;
      return prepare ? preparedForQiCore(bundle as PreparableBundle) : bundle;
    });

  const period = { start: "2026-01-01", end: "2026-12-31" };
  const inPopulation = (results: Map<string, Record<string, boolean>>) =>
    [...results.values()].filter((m) => m["initial-population"]).length;

  const raw = await calculateOfficial({
    bundle: artifact!.bundle as MeasureBundle,
    patientBundles: build(false),
    period,
    valueSetCache: cache,
  });
  assert.equal(inPopulation(raw as never), 0, "unprepared: nobody is in the initial population");

  const prepared = await calculateOfficial({
    bundle: artifact!.bundle as MeasureBundle,
    patientBundles: build(true),
    period,
    valueSetCache: cache,
  });
  assert.equal(inPopulation(prepared as never), subjects.length, "prepared: the whole cohort is");
});
