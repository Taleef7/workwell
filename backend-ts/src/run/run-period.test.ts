import { test } from "node:test";
import assert from "node:assert/strict";
import { caseRerunEvaluationDate } from "./run-period.ts";

const routed = { WORKWELL_OFFICIAL_MEASURES: "cms122" };

test("a rerun of an earlier year's official case is evaluated as of that year's last day", () => {
  assert.equal(caseRerunEvaluationDate("cms122", "2026-01-01", "2027-01-04", routed), "2026-12-31");
  assert.equal(caseRerunEvaluationDate("cms122", "2025-01-01", "2027-03-01", routed), "2025-12-31");
});

test("a rerun within the case's own year, or of an authored measure, is evaluated as of today", () => {
  assert.equal(caseRerunEvaluationDate("cms122", "2026-01-01", "2026-10-17", routed), "2026-10-17");
  assert.equal(caseRerunEvaluationDate("cms122", "2026-01-01", "2026-12-31", routed), "2026-12-31");
  assert.equal(caseRerunEvaluationDate("audiogram", "2026-01-01", "2027-01-04", routed), "2027-01-04", "authored cycles are not calendar years");
  assert.equal(caseRerunEvaluationDate("cms122", "2026-01-01", "2027-01-04", {}), "2027-01-04", "not routed: authored logic");
  assert.equal(caseRerunEvaluationDate("cms122", "2026-07-01", "2027-01-04", routed), "2027-01-04", "not a calendar-year key");
});
