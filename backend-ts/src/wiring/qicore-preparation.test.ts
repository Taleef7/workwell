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
import { calculateOfficial, type MeasureBundle } from "@work-well/official-executor";

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

/**
 * A blood pressure is stamped with its US Core profile, so cms165 can see a reading in a bundle that
 * carries no `meta.profile` of its own (issue #533, ADR-076 d1).
 *
 * cms165 is the one measure the executor runs with `trustMetaProfile: true`, because its decisive
 * retrieve identifies a reading by profile ALONE. Under that setting an unstamped blood pressure is not
 * retrieved at all.
 *
 * The line this must not cross is fabrication, and the danger is asymmetric: a missed stamp leaves a
 * measure unable to see a reading, while a wrong one puts a resource that is NOT a blood pressure into
 * a compliance population. So the predicate demands the US Core shape — a panel code on the resource AND
 * both a systolic and a diastolic component — and the negative cases below are the ones review found in
 * a looser first version that flattened the resource's and its components' codes into one list.
 *
 * Positive and negative live in ONE test on purpose. Split, the negative half passed with the stamping
 * code deleted, since an untouched Observation has no `meta.profile` either — a test that asserted
 * nothing (review finding).
 */
const BP_PROFILE = "http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure";
const loinc = (code: string) => ({ coding: [{ system: "http://loinc.org", code }] });
const qty = (value: number) => ({ value, unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" });
const bpComponents = [
  { code: loinc("8480-6"), valueQuantity: qty(118) },
  { code: loinc("8462-4"), valueQuantity: qty(76) },
];
const stamped = (resource: Record<string, unknown>): boolean => {
  const out = preparedForQiCore({ entry: [{ resource }] } as never) as {
    entry: Array<{ resource: { meta?: { profile?: string[] } } }>;
  };
  // Exact element equality, not `includes`: CodeQL reads `.includes(<url>)` on a string-ish value as a
  // substring check and flags it (alert #31); `some` with `===` says what is meant and is equivalent.
  return out.entry[0]!.resource.meta?.profile?.some((p) => p === BP_PROFILE) ?? false;
};

test("a blood pressure is stamped, and everything that only resembles one is not", () => {
  // THE POSITIVE, first: without it the negatives below would pass against deleted code.
  assert.equal(
    stamped({ resourceType: "Observation", status: "final", code: loinc("85354-9"), component: bpComponents }),
    true,
    "a panel code with systolic and diastolic components IS a blood pressure",
  );
  assert.equal(
    stamped({ resourceType: "Observation", status: "final", code: loinc("55284-4"), component: bpComponents }),
    true,
    "the other panel code counts too",
  );

  // A VITALS panel carrying a blood pressure among its components is not a blood pressure. Flattening
  // the resource's codes with its components' matched this, and would have handed cms165 a resource
  // whose other components are pulse and temperature.
  assert.equal(
    stamped({
      resourceType: "Observation",
      status: "final",
      code: loinc("8716-3"),
      component: [{ code: loinc("85354-9"), valueQuantity: qty(1) }, ...bpComponents],
    }),
    false,
    "the panel code must be on the resource, not among its components",
  );

  // Two codes on one `code` are not two components. cms165 reads systolic and diastolic OUT of
  // `component`, so this resolves to null — and being newest it would displace a real reading.
  assert.equal(
    stamped({
      resourceType: "Observation",
      status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "8480-6" }, { system: "http://loinc.org", code: "8462-4" }] },
    }),
    false,
    "systolic and diastolic on `code` with no components is not a reading",
  );

  // An empty panel — a cancelled order, a dataAbsentReason header — has a panel code and no reading.
  assert.equal(
    stamped({ resourceType: "Observation", status: "final", code: loinc("85354-9") }),
    false,
    "a panel code alone is not a reading",
  );
  assert.equal(
    stamped({ resourceType: "Observation", status: "final", code: loinc("85354-9"), component: [bpComponents[0]!] }),
    false,
    "half a blood pressure is not one",
  );

  // A component with no measurement is not a reading, and stamping it would assert a US Core
  // conformance the resource does not have.
  assert.equal(
    stamped({
      resourceType: "Observation",
      status: "final",
      code: loinc("85354-9"),
      component: [{ code: loinc("8480-6") }, { code: loinc("8462-4") }],
    }),
    false,
    "components without values are not measurements",
  );
  // A `valueQuantity` with a unit and no `value`, beside a `dataAbsentReason`, is a VALID way to record
  // "not measured" — and the first predicate stamped it, because it only asked whether the container
  // existed. cms165 would then read the newest reading with null systolic/diastolic and displace a real
  // controlled one (Codex review, #539).
  assert.equal(
    stamped({
      resourceType: "Observation",
      status: "final",
      code: loinc("85354-9"),
      component: [
        { code: loinc("8480-6"), valueQuantity: { unit: "mm[Hg]", system: "http://unitsofmeasure.org", code: "mm[Hg]" }, dataAbsentReason: { coding: [{ code: "not-performed" }] } },
        bpComponents[1]!,
      ],
    }),
    false,
    "a component whose quantity carries no numeric value is not a measurement, even with a unit",
  );

  // TWO systolic components — a bilateral reading, or a duplicated flowsheet row. cms165 reads the
  // systolic out with `singleton from`, which throws on two, so this must never be stamped.
  assert.equal(
    stamped({
      resourceType: "Observation",
      status: "final",
      code: loinc("85354-9"),
      component: [bpComponents[0]!, { code: loinc("8480-6"), valueQuantity: qty(122) }, bpComponents[1]!],
    }),
    false,
    "two systolic components would make the measure throw, so they are not stamped",
  );

  // Not a blood pressure at all, and the exact resource that — unstamped and profile-ignored — was being
  // read as a patient's latest blood pressure.
  assert.equal(stamped({ resourceType: "Observation", status: "final", code: loinc("4548-4") }), false, "a hemoglobin is not one");
  assert.equal(
    stamped({
      resourceType: "Observation",
      status: "final",
      code: { coding: [{ system: "http://snomed.info/sct", code: "85354-9" }] },
      component: bpComponents,
    }),
    false,
    "the right code in the wrong system is not one",
  );
});

test("LOINC is recognised however the source spells it", () => {
  for (const system of ["http://loinc.org", "http://loinc.org/", "urn:oid:2.16.840.1.113883.6.1", "HTTP://LOINC.ORG"]) {
    assert.equal(
      stamped({
        resourceType: "Observation",
        status: "final",
        code: { coding: [{ system, code: "85354-9" }] },
        component: [
          { code: { coding: [{ system, code: "8480-6" }] }, valueQuantity: qty(118) },
          { code: { coding: [{ system, code: "8462-4" }] }, valueQuantity: qty(76) },
        ],
      }),
      true,
      `${system} should be recognised as LOINC`,
    );
  }
});

test("an existing meta.profile is preserved, not replaced", () => {
  const bundle = {
    entry: [
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          meta: { profile: ["http://hl7.org/fhir/us/qicore/StructureDefinition/qicore-observation-lab"] },
          code: loinc("85354-9"),
          component: bpComponents,
        },
      },
    ],
  };
  const out = preparedForQiCore(bundle as never) as { entry: Array<{ resource: { meta?: { profile?: string[] } } }> };
  assert.equal(out.entry[0]!.resource.meta?.profile?.length, 2, "the artifact's own profile stays; ours is added");
});

test("stamping does not leak into the caller's bundle (ADR-008: the authored outcome is unchanged)", () => {
  // `preparedForQiCore` clones; the official executor uses it precisely so the authored engine sees the
  // same bytes whether or not official routing is on.
  const resource = { resourceType: "Observation", status: "final", code: loinc("85354-9"), component: bpComponents };
  const bundle = { entry: [{ resource }] };
  preparedForQiCore(bundle as never);
  assert.equal((resource as { meta?: unknown }).meta, undefined, "the caller's own bundle is untouched");
});
