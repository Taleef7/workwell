import { test } from "node:test";
import assert from "node:assert/strict";
import { OFFICIAL_DISPLAY, needFor, officialDisplayFor } from "./official-display.ts";
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
test("T2: cms122 and cms165 OVERDUE name every path into the gap, so no patient with no result reads 'above 9%'", () => {
  // CMS122's numerator is the latest above 9%, the latest without a result, or none this period; CMS165's
  // gap is no qualifying reading, or the most recent day's lowest reading not below 140/90.
  const a1c = officialDisplayFor("cms122", "OVERDUE")!;
  for (const text of [a1c.method, a1c.whyFlagged]) {
    assert.match(text, /no glycemic status assessment/i);
    assert.match(text, /no result/);
    assert.match(text, /above 9%/);
  }
  assert.match(a1c.nextAction, /^Draw an HbA1c if there is none this period or the latest has no result; otherwise review glycemic control\.$/);
  const bp = officialDisplayFor("cms165", "OVERDUE")!;
  for (const text of [bp.method, bp.whyFlagged]) {
    assert.match(text, /no blood pressure/i);
    assert.match(text, /140/);
  }
  assert.match(bp.nextAction, /^Take and record a blood pressure if none counts this period/);
});

test("T2: no official OVERDUE line asserts a value without naming the no-record path", () => {
  // A line that states a threshold as the reason ("above 9%", "140/90") is only true for a patient with a
  // result. Every official OVERDUE that names one must also say the gap can be no record at all.
  for (const id of Object.keys(OFFICIAL_DISPLAY)) {
    const display = officialDisplayFor(id, "OVERDUE");
    if (!display) continue;
    for (const text of [display.method, display.whyFlagged]) {
      if (/\d+(\.\d+)?%|\d{2,3}\/\d{2,3}|\b1[0-9]{2}\b/.test(text)) {
        assert.match(text, /\bno\b|\bnone\b/i, `${id} OVERDUE asserts a value with no no-record path: "${text}"`);
      }
    }
  }
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

test("a WorkWell translation's exclusion is never credited to official logic; CMS's wording is untouched", () => {
  const translated = { official: { kind: "derived", label: "WorkWell translation of CMS137v15" } };
  const cms = officialDisplayFor("cms137", "EXCLUDED", { official: { ecqmId: "137FHIR" } })!;
  assert.match(cms.whyFlagged, /by official measure logic/);
  const derived = officialDisplayFor("cms137", "EXCLUDED", translated)!;
  assert.doesNotMatch(derived.whyFlagged, /official/i);
  assert.equal(derived.whyFlagged, cms.whyFlagged.replace("by official measure logic", "by the measure logic"));
  assert.equal(derived.method, cms.method);
  assert.equal(derived.nextAction, cms.nextAction);
  for (const id of ["cms122", "cms125", "cms2", "cms130", "cms165"]) {
    assert.doesNotMatch(officialDisplayFor(id, "EXCLUDED", translated)!.whyFlagged, /official/i, id);
  }
});

test("#880: an OVERDUE gap's `need` says what closes it, never the patient's current value, in a card's headline length", () => {
  // The headline sits in front of a clinician mid-encounter (AI_GUARDRAILS §1.1). A patient with no
  // reading at all lands in the same bucket as one above goal, so the phrase names the target only.
  for (const id of IDS) {
    const need = needFor(id, "OVERDUE", {});
    if (id === "cms137") {
      assert.equal(need, null, "CMS137 with no rates in hand: one sentence cannot say which rate");
      continue;
    }
    assert.ok(need, `${id}: no need phrase`);
    assert.match(need, /^Needs /, id);
    assert.doesNotMatch(need, /(is|was|above|over|latest|most recent|your)/i, `${id} states a current value: "${need}"`);
    assert.ok(need.length + " (CMS1234)".length <= 140, id);
  }
  const rate = (numer: boolean) => [
    { populationType: "initial-population", result: true },
    { populationType: "denominator", result: true },
    { populationType: "numerator", result: numer },
  ];
  assert.match(needFor("cms137", "OVERDUE", { official: { rates: [rate(false), rate(false)] } })!, /started within 14 days/);
  assert.match(needFor("cms137", "OVERDUE", { official: { rates: [rate(true), rate(false)] } })!, /continued within 34 days/);
  // Only OVERDUE carries one.
  for (const id of IDS) for (const s of ["COMPLIANT", "EXCLUDED", "MISSING_DATA", "DUE_SOON"]) {
    assert.equal(needFor(id, s, {}), null, `${id}/${s}`);
    assert.equal(officialDisplayFor(id, s)?.need, undefined, `${id}/${s} table entry`);
  }
  // A WorkWell translation's row keeps it: the phrase claims nothing about who wrote the logic.
  assert.equal(needFor("cms165", "OVERDUE", { official: { kind: "derived" } }), "Needs a blood pressure below 140/90 this year");
});
