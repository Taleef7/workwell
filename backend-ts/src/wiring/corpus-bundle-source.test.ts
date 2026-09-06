import test from "node:test";
import assert from "node:assert/strict";
import { corpusBundleSource, corpusIndexOf } from "./corpus-bundle-source.ts";
import { corpusDirectory } from "../engine/synthetic/corpus/corpus-directory.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";
import { MAUI_MEASURE_IDS_FOR_TEST } from "./corpus-bundle-source.ts";
import { runProfileChild } from "../test-support/run-profile-child.ts";

const EMPLOYEES = corpusDirectory(DEFAULT_CORPUS_SEED, 60).EMPLOYEES;

test("bundleForSubject returns the whole record, and bundleFor returns the SAME record for every measure", () => {
  const src = corpusBundleSource();
  for (const employee of [EMPLOYEES[0]!, EMPLOYEES[47]!, EMPLOYEES[52]!]) {
    const whole = JSON.stringify(src.bundleForSubject!(employee, "2027-12-31"));
    for (const id of MAUI_MEASURE_IDS_FOR_TEST) {
      assert.equal(JSON.stringify(src.bundleFor(employee, id, "COMPLIANT", "2027-12-31")), whole, `${employee.externalId}/${id} sees the same record`);
    }
    // A whole record is not an empty one — a source that returned `{entry: []}` would pass the
    // equality above for every measure and evaluate every patient out of the population.
    const bundle = src.bundleForSubject!(employee, "2027-12-31") as { entry: unknown[] };
    assert.ok(bundle.entry.length > 1, `${employee.externalId}: ${bundle.entry.length} resources`);
  }
});

test("the subject in the bundle is the subject that was asked for, at their own panel", () => {
  const src = corpusBundleSource();
  const employee = EMPLOYEES[52]!;
  const bundle = src.bundleForSubject!(employee, "2027-12-31") as { entry: { resource: Record<string, unknown> }[] };
  const patient = bundle.entry.map((e) => e.resource).find((r) => r.resourceType === "Patient")!;
  assert.equal(patient.id, employee.externalId);
  // The name comes from the DIRECTORY, not from a standalone regeneration: disambiguation depends on
  // who came before, so a source that regenerated it alone could rename a patient mid-run.
  assert.deepEqual(patient.name, [{ text: employee.name }]);
  assert.deepEqual(patient.generalPractitioner, [{ reference: `Practitioner/${employee.providerId}` }]);
});

test("distribution covers every employee and the target is inert — the corpus is data-first", () => {
  const src = corpusBundleSource();
  const assignments = src.distribution(EMPLOYEES, "cms122");
  assert.equal(assignments.length, EMPLOYEES.length);
  assert.deepEqual(assignments.map((a) => a.employee.externalId), EMPLOYEES.map((e) => e.externalId));
  assert.equal(src.targetFor(EMPLOYEES, "cms122", EMPLOYEES[3]!.externalId), "COMPLIANT");
});

test("a subject outside the corpus is a clear error, not an empty bundle", () => {
  const src = corpusBundleSource();
  assert.throws(
    () => src.bundleFor({ ...EMPLOYEES[0]!, externalId: "emp-999" }, "cms122", "COMPLIANT", "2027-12-31"),
    /not a corpus subject/,
  );
});

test("corpusIndexOf verifies the id it parsed rather than trusting the digits", () => {
  assert.equal(corpusIndexOf("pat-001"), 0);
  assert.equal(corpusIndexOf("pat-048"), 47);
  assert.equal(corpusIndexOf("pat-00049"), 48);
  assert.equal(corpusIndexOf("pat-20000"), 19999);
  // The two shapes do not overlap: the prefix is three digits, the generated ids five. An id in the
  // wrong shape resolves to a real index arithmetically, and would return a NEIGHBOUR's whole chart.
  assert.equal(corpusIndexOf("pat-00003"), null, "a five-digit id inside the prefix is not a corpus id");
  assert.equal(corpusIndexOf("pat-049"), null, "a three-digit id past the prefix is not a corpus id");
  assert.equal(corpusIndexOf("emp-001"), null);
  assert.equal(corpusIndexOf("pat-1"), null);
});

test("a Maui process routes every measure through the corpus, and still refuses one it cannot run", () => {
  // Child process: the profile is resolved at module load, so an in-process test can only ever see
  // `default` and would prove nothing about the branch this exists for.
  const out = runProfileChild("maui", `
    const { compositeBundleSource } = await import("./src/wiring/subject-bundle-source.ts");
    const { corpusDirectory } = await import("./src/engine/synthetic/corpus/corpus-directory.ts");
    const { DEFAULT_CORPUS_SEED } = await import("./src/engine/synthetic/corpus/corpus-parameters.ts");
    const employee = corpusDirectory(DEFAULT_CORPUS_SEED, 48).EMPLOYEES[0];
    const src = compositeBundleSource({ WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2,cms130,cms165" });
    const cms122 = JSON.stringify(src.bundleFor(employee, "cms122", "COMPLIANT", "2027-12-31"));
    const cms130 = JSON.stringify(src.bundleFor(employee, "cms130", "COMPLIANT", "2027-12-31"));
    let refused = null;
    try { src.bundleFor(employee, "audiogram", "COMPLIANT", "2027-12-31"); } catch (error) { refused = String(error.message); }
    console.log(JSON.stringify({
      sameRecord: cms122 === cms130,
      hasBundleForSubject: typeof src.bundleForSubject === "function",
      subjectMatches: JSON.stringify(src.bundleForSubject(employee, "2027-12-31")) === cms122,
      refused,
    }));
  `);
  // An authored measure and an official-only one would take different branches off the profile
  // deployment; on Maui they are the same whole record, which is the point of the corpus source.
  assert.equal(out.sameRecord, true);
  assert.equal(out.hasBundleForSubject, true);
  assert.equal(out.subjectMatches, true);
  assert.match(String(out.refused), /audiogram is not runnable here \(not in the maui profile/);
});
