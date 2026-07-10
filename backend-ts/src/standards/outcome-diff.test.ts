import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOutcomeDiff } from "./outcome-diff.ts";
import { CMS122V14 } from "./references/cms122v14.ts";

// Three subjects with externalIds that hash into birth years 1980–1999 → ages 27–46 in 2026.
const MOCK_OUTCOMES = [
  { subjectId: "emp-001", status: "OVERDUE", runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
  { subjectId: "emp-002", status: "COMPLIANT", runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
  { subjectId: "emp-003", status: "MISSING_DATA", runId: "run-1", runStartedAt: "2026-06-01T00:00:00Z" },
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

test("computeOutcomeDiff: COVERED criteria report verifiable=true and 0 incremental impact", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  for (const key of ["age-18-75", "qualifying-visit", "hospice", "palliative-care", "numerator-exclusions-none"]) {
    const c = r.criterionImpacts.find((x) => x.key === key)!;
    assert.ok(c, `missing criterion ${key}`);
    assert.equal(c.coverage, "COVERED", `${key} should be COVERED after production-faithful promotion`);
    assert.equal(c.verifiable, true);
    assert.equal(c.subjectsAffected, 0, `${key}: COVERED ⇒ no incremental estimate impact`);
  }
});

test("computeOutcomeDiff: Phase-2 OMITTED DENEX remain unverifiable", () => {
  const r = computeOutcomeDiff(CMS122V14, MOCK_OUTCOMES, 2026);
  for (const key of ["long-term-care-66", "advanced-illness-frailty-66"]) {
    const c = r.criterionImpacts.find((x) => x.key === key)!;
    assert.ok(c, `missing criterion ${key}`);
    assert.equal(c.coverage, "OMITTED");
    assert.equal(c.verifiable, false, `${key} should be unverifiable`);
    assert.ok(c.reason, `${key} should have a reason`);
  }
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
