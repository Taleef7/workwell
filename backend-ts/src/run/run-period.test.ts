import { test } from "node:test";
import assert from "node:assert/strict";
import { caseRerunEvaluationDate } from "./run-period.ts";

test("a rerun of an earlier year's official case is evaluated as of that year's last day", () => {
  assert.equal(caseRerunEvaluationDate(true, "2026-01-01", "2027-01-04"), "2026-12-31");
  assert.equal(caseRerunEvaluationDate(true, "2025-01-01", "2027-03-01"), "2025-12-31");
});

test("a rerun within the case's own year, or of an authored measure, is evaluated as of today", () => {
  assert.equal(caseRerunEvaluationDate(true, "2026-01-01", "2026-10-17"), "2026-10-17");
  assert.equal(caseRerunEvaluationDate(true, "2026-01-01", "2026-12-31"), "2026-12-31");
  assert.equal(caseRerunEvaluationDate(false, "2026-01-01", "2027-01-04"), "2027-01-04", "authored logic: its cycles are not calendar years");
  assert.equal(caseRerunEvaluationDate(true, "2026-07-01", "2027-01-04"), "2027-01-04", "not a calendar-year key");
});
