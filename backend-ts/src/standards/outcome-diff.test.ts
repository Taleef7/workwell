import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcomeDiff } from "./outcome-diff.ts";
import { CMS122V14 } from "./references/cms122v14.ts";

// Three subjects with externalIds that hash into birth years 1980–1999 → ages 27–46 in 2026.
// All are within the 18–75 official IPP age gate, so age divergence = 0.
const MOCK_OUTCOMES = [
  { subjectId: "emp-001", status: "OVERDUE",       runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
  { subjectId: "emp-002", status: "COMPLIANT",     runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
  { subjectId: "emp-003", status: "MISSING_DATA",  runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
];

test("computeOutcomeDiff: one impact per criterion, measureId + ecqmId match ref", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.equal(r.measureId, "cms122");
  assert.equal(r.ecqmId, "CMS122v14");
  assert.equal(r.totalSubjectsEvaluated, 3);
  assert.equal(r.criterionImpacts.length, CMS122V14.criteria.length);
});

test("computeOutcomeDiff: run provenance comes from first outcome row", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.equal(r.runId, "run-1");
  assert.equal(r.asOf, "2026-06-01");
});

test("computeOutcomeDiff: age-18-75 is verifiable; all emp-00x ages 27–46 → 0 divergent", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const age = r.criterionImpacts.find((c) => c.key === "age-18-75")!;
  assert.ok(age, "age-18-75 criterion must be present");
  assert.equal(age.verifiable, true);
  assert.equal(age.subjectsAffected, 0);
  assert.equal(age.coverage, "OMITTED");
});

test("computeOutcomeDiff: qualifying-visit is unverifiable with a reason string", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const visit = r.criterionImpacts.find((c) => c.key === "qualifying-visit")!;
  assert.ok(visit);
  assert.equal(visit.verifiable, false);
  assert.equal(visit.subjectsAffected, 0);
  assert.ok(visit.reason && visit.reason.length > 0);
});

test("computeOutcomeDiff: hospice, long-term-care-66, advanced-illness-frailty-66, palliative-care all unverifiable", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  for (const key of ["hospice", "long-term-care-66", "advanced-illness-frailty-66", "palliative-care"]) {
    const c = r.criterionImpacts.find((x) => x.key === key)!;
    assert.ok(c, `missing criterion ${key}`);
    assert.equal(c.verifiable, false, `${key} should be unverifiable`);
    assert.ok(c.reason, `${key} should have a reason`);
  }
});

test("computeOutcomeDiff: COVERED criterion numerator-exclusions-none has verifiable=true and 0 divergent", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const numex = r.criterionImpacts.find((c) => c.key === "numerator-exclusions-none")!;
  assert.ok(numex);
  assert.equal(numex.coverage, "COVERED");
  assert.equal(numex.verifiable, true);
  assert.equal(numex.subjectsAffected, 0);
});

test("computeOutcomeDiff: totalDivergent equals sum of subjectsAffected across all impacts", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  const sum = r.criterionImpacts.reduce((acc, c) => acc + c.subjectsAffected, 0);
  assert.equal(r.totalDivergent, sum);
});

test("computeOutcomeDiff: headline is non-empty and mentions totalSubjectsEvaluated and totalDivergent", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.ok(r.headline.length > 0);
  assert.match(r.headline, new RegExp(String(r.totalSubjectsEvaluated)));
  assert.match(r.headline, new RegExp(String(r.totalDivergent)));
});

test("computeOutcomeDiff: disclaimer is non-empty and mentions ValueSetResolver", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  assert.match(r.disclaimer, /ValueSetResolver/);
  assert.match(r.disclaimer, /ADR-008/);
});

test("computeOutcomeDiff: empty outcomes returns valid report with zeros", () => {
  const r = computeOutcomeDiff(CMS122V14, [], 2026);
  assert.equal(r.runId, null);
  assert.equal(r.asOf, null);
  assert.equal(r.totalSubjectsEvaluated, 0);
  assert.equal(r.totalDivergent, 0);
  assert.equal(r.criterionImpacts.length, CMS122V14.criteria.length);
});

test("computeOutcomeDiff: subjects born outside 18-75 range ARE counted as divergent on age criterion", () => {
  // Construct a fake externalId that hashes to a birth year outside 18–75 in a given evalYear.
  // birth year 1980 → evalYear 1950 → age = -30 → outside 18-75 → divergent.
  const outcomes = [{ subjectId: "emp-001", status: "OVERDUE", runId: "r", runStartedAt: "1950-01-01" }];
  const r = computeOutcomeDiff(CMS122V14, outcomes, 1950);
  const age = r.criterionImpacts.find((c) => c.key === "age-18-75")!;
  // birth year 1980, evalYear 1950 → age = -30 → outside 18-75 → divergent
  assert.equal(age.subjectsAffected, 1);
  assert.equal(r.totalDivergent, 1);
});
