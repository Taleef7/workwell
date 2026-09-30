import { test } from "node:test";
import assert from "node:assert/strict";
import type { PopulationCounts } from "../standards/official-cases.ts";
import { expectedCase, expectedStatus, membershipOf } from "./madie-oracle.ts";

/**
 * The oracle on the population shapes NO steward deck holds (#727 review): the end-to-end test only
 * exercises the shapes the decks contain, so these rules would otherwise stand unchecked. They pin the
 * ORACLE — the specification — not production; where production disagrees on a shape the decks lack,
 * the end-to-end test cannot see it (the evidence file's "Not covered").
 */
const v = (ipp: number, denom: number, denex: number, numer: number, denexcep = 0): PopulationCounts => ({
  "initial-population": ipp,
  denominator: denom,
  "denominator-exclusion": denex,
  numerator: numer,
  "denominator-exception": denexcep,
});

test("an exception applies only to a patient who did NOT meet the numerator (QI-Core IG)", () => {
  assert.equal(expectedStatus("cms2", [v(1, 1, 0, 1, 1)]), "COMPLIANT");
  assert.deepEqual(membershipOf(v(1, 1, 0, 1, 1)), { ipp: true, denom: true, denex: false, numer: true, denexcep: false });
  assert.equal(expectedStatus("cms2", [v(1, 1, 0, 0, 1)]), "EXCLUDED");
});

test("an exclusion wins over the numerator, and the numerator is not scored", () => {
  assert.equal(expectedStatus("cms125", [v(1, 1, 1, 1)]), "EXCLUDED");
  assert.equal(membershipOf(v(1, 1, 1, 1)).numer, false);
});

test("in the initial population but not the denominator is not a gap", () => {
  assert.equal(expectedStatus("cms125", [v(1, 0, 0, 0)]), "EXCLUDED");
  assert.equal(expectedCase("EXCLUDED")?.status, "EXCLUDED");
});

test("the inverse measure: cms122's numerator is the gap", () => {
  assert.equal(expectedStatus("cms122", [v(1, 1, 0, 1)]), "OVERDUE");
  assert.equal(expectedStatus("cms122", [v(1, 1, 0, 0)]), "COMPLIANT");
});

test("multi-rate: only the rates the patient is in decide, and the worst of those wins", () => {
  // Out of rate 2's population: rate 1 alone decides, rather than "out of population" winning.
  assert.equal(expectedStatus("cms137", [v(1, 1, 0, 1), v(0, 0, 0, 0)]), "COMPLIANT");
  // Excluded on one rate, a gap on the other: the gap.
  assert.equal(expectedStatus("cms137", [v(1, 1, 1, 0), v(1, 1, 0, 0)]), "OVERDUE");
  // Excluded on one, met on the other: met (an exclusion is the least severe).
  assert.equal(expectedStatus("cms137", [v(1, 1, 1, 0), v(1, 1, 0, 1)]), "COMPLIANT");
  assert.equal(expectedStatus("cms137", [v(0, 0, 0, 0), v(0, 0, 0, 0)]), "OUT_OF_POPULATION");
  assert.equal(expectedCase("OUT_OF_POPULATION"), null);
});
