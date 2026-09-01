/**
 * case-read-models unit tests.
 *   node --import tsx --test src/case/case-read-models.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCaseSummary } from "./case-read-models.ts";
import type { CaseRecord } from "../stores/case-store.ts";

const CASE: CaseRecord = {
  id: "case-001",
  employeeId: "emp-006",
  measureId: "adult_immunization",
  evaluationPeriod: "2026-01-01",
  status: "OPEN",
  priority: "MEDIUM",
  assignee: null,
  nextAction: "Send outreach",
  currentOutcomeStatus: "MISSING_DATA",
  lastRunId: "run-001",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  closedAt: null,
  closedReason: null,
  closedBy: null,
};

test("toCaseSummary includes measureId matching the case record", () => {
  const summary = toCaseSummary(CASE);
  assert.equal(summary.measureId, "adult_immunization");
});
