/**
 * `validateTests` checks SHAPE, not outcomes (#599).
 *
 * Studio rendered a green tick on a row labelled "Test Fixtures" and blocked activation until it
 * passed, which reads as *the fixtures were run and the measure produced the expected outcomes*. It
 * never meant that: the function checks the list is non-empty and that each entry carries a name, a
 * subject, and an `expectedOutcome` in the allowed set. So activation was gated by a control that
 * could not fail on the thing its label implied — the vacuous-guard shape this repo keeps finding.
 *
 * These tests pin the limitation rather than the copy, and that is deliberate. The Studio row now
 * says "Fixtures Well-Formed … not executed against the measure", but a label is easy to drift back.
 * If someone later implements execution (issue #599's option 2, which is the real fix), the first
 * test here FAILS — forcing the label and the behaviour to move together rather than apart.
 *
 *   node --import tsx --test src/measure/validate-tests-does-not-execute.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTests } from "./measure-read-models.ts";

type Fixture = Parameters<typeof validateTests>[0][number];

const fixture = (over: Partial<Fixture> = {}): Fixture =>
  ({
    fixtureName: "a well-formed fixture",
    employeeExternalId: "emp-006",
    expectedOutcome: "COMPLIANT",
    ...over,
  }) as Fixture;

test("a fixture naming a subject that does not exist still PASSES — nothing is executed", () => {
  // `nobody-at-all` is in no directory and no corpus. If this function ran the measure it could not
  // report success here. When #599's option 2 lands, this is the test that tells you to move the
  // label with it.
  const result = validateTests([fixture({ employeeExternalId: "nobody-at-all" })]);
  assert.equal(result.passed, true, "shape-only: the subject is never looked up");
  assert.deepEqual(result.failures, []);
});

test("a fixture whose expected outcome contradicts the measure still passes", () => {
  // Two fixtures for the SAME subject asserting opposite outcomes. At most one can be right, and a
  // gate that evaluated anything would say so.
  const result = validateTests([
    fixture({ fixtureName: "compliant", expectedOutcome: "COMPLIANT" }),
    fixture({ fixtureName: "overdue", expectedOutcome: "OVERDUE" }),
  ]);
  assert.equal(result.passed, true, "contradictory expectations are not detectable without executing");
});

test("what it DOES check: presence, a name, a subject, and a known outcome bucket", () => {
  // The other half of an honest label - the check is real, it is just narrower than it read.
  assert.equal(validateTests([]).passed, false, "an empty set blocks activation");
  assert.match(validateTests([]).failures[0]!, /At least one test fixture/);

  assert.equal(validateTests([fixture({ fixtureName: "  " })]).passed, false, "a blank name is not a name");
  assert.equal(validateTests([fixture({ employeeExternalId: "" })]).passed, false, "a subject is required");

  const unknown = validateTests([fixture({ expectedOutcome: "WIBBLE" as Fixture["expectedOutcome"] })]);
  assert.equal(unknown.passed, false);
  assert.match(unknown.failures[0]!, /unsupported expectedOutcome/);

  // And every failure names WHICH fixture, since an author has to find it.
  const second = validateTests([fixture(), fixture({ fixtureName: "" })]);
  assert.match(second.failures[0]!, /Fixture 2/);
});
