import { test } from "node:test";
import assert from "node:assert/strict";
import { officialDisplayFor } from "./official-display.ts";
import { resolveDeploymentProfile } from "../config/deployment-profile.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";

/**
 * DERIVED from the pilot's measure set, not hand-listed. The list used to be the five ids the table held
 * on the day it was written, so when cms137 joined the pilot's set with no display entry the test kept
 * passing — and the roster fell back to "Overdue — no record on file" for a patient with a documented
 * substance use disorder episode, while the worklist told the operator to order a screening. Every
 * official-capable measure a deployment can run must have wording here, or the fallback prose is what a
 * clinician reads.
 */
const IDS = [...resolveDeploymentProfile("maui").runnableMeasureIds].filter((id) => officialMeasureSemantics(id) !== undefined);
const STATUSES = ["COMPLIANT", "OVERDUE", "EXCLUDED", "MISSING_DATA"] as const;

test("every official measure the pilot can run has wording for every status — derived from the profile", () => {
  assert.ok(IDS.includes("cms137"), "the set this derives from must include the pilot's sixth measure");
  assert.ok(IDS.length >= 6, `expected the six ACO measures, got ${IDS.join(", ")}`);
  for (const id of IDS) for (const s of STATUSES) {
    const d = officialDisplayFor(id, s);
    assert.ok(d, `${id}/${s}: no official display wording — the roster would fall back to authored prose`);
    assert.ok(d.method && d.whyFlagged && d.nextAction, `${id}/${s}`);
    assert.doesNotMatch(d.method, /on file/i); // official wording never claims a record's absence for OVERDUE
  }
});
test("cms122 OVERDUE says what the numerator means, not 'no record'", () => {
  assert.match(officialDisplayFor("cms122", "OVERDUE")!.method, /above 9%/);
});
test("cms137 OVERDUE names BOTH rates, and its next action is treatment follow-up rather than a screening order", () => {
  // The bucket is the worst of Initiation and Engagement (ADR-074); wording that named only one would
  // misdescribe the other half of the flagged patients.
  const overdue = officialDisplayFor("cms137", "OVERDUE")!;
  assert.match(overdue.method, /initiation within 14 days/i);
  assert.match(overdue.method, /engaged within 34 days/i);
  assert.doesNotMatch(overdue.nextAction, /screening/i, "SUD treatment is not a screening; 'order a screening' is clinically wrong here");
  assert.match(officialDisplayFor("cms137", "MISSING_DATA")!.method, /November 14/);
});
test("EXCLUDED is a denominator exclusion or exception, never an 'exemption on file'", () => {
  for (const id of IDS) assert.match(officialDisplayFor(id, "EXCLUDED")!.method, /excluded by measure logic/i);
});
