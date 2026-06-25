/**
 * case-detail-read-model unit tests (#76 E6).
 *   node --import tsx --test src/case/case-detail-read-model.test.ts
 *
 * Verifies:
 *  (a) toCaseDetail includes immunizationForecast in the output when the param is provided,
 *      OMITS the key when not provided, and case `status` is identical either way.
 *  (b) deriveWhyFlagged — waiver_status reflects contraindication exclusions (#76 Codex P2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCaseDetail, deriveWhyFlagged, overdueDays } from "./case-detail-read-model.ts";
import { simulatedForecaster } from "../engine/immunization/immunization-forecast.ts";
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

const FORECAST = simulatedForecaster.forecast("emp-006", "2026-06-19");

test("toCaseDetail omits immunizationForecast key when param is not provided", () => {
  const detail = toCaseDetail(CASE, null);
  assert.equal("immunizationForecast" in detail, false, "key must be absent (not undefined) when not provided");
});

test("toCaseDetail includes immunizationForecast when param is provided", () => {
  const detail = toCaseDetail(CASE, null, [], null, FORECAST);
  assert.ok("immunizationForecast" in detail, "key must be present");
  assert.equal(detail.immunizationForecast?.subjectId, "emp-006");
  assert.equal(detail.immunizationForecast?.asOf, "2026-06-19");
  assert.equal(detail.immunizationForecast?.series.length, 3, "simulated forecaster always returns 3 series (TDAP/INFLUENZA/HEPB)");
});

test("case status is identical with or without immunizationForecast (forecast is advisory)", () => {
  const without = toCaseDetail(CASE, null);
  const with_ = toCaseDetail(CASE, null, [], null, FORECAST);
  assert.equal(with_.status, without.status, "status must not change");
  assert.equal(with_.currentOutcomeStatus, without.currentOutcomeStatus, "outcomeStatus must not change");
  assert.equal(with_.priority, without.priority, "priority must not change");
});

test("toCaseDetail spreads spread-omit pattern (undefined param → key absent, not null)", () => {
  const detail = toCaseDetail(CASE, null, [], null, undefined);
  assert.equal("immunizationForecast" in detail, false, "undefined param must not write the key at all");
});

// ---------------------------------------------------------------------------
// Test B — deriveWhyFlagged: waiver_status reflects contraindication (#76 Codex P2)
// ---------------------------------------------------------------------------
test("deriveWhyFlagged — EXCLUDED immunization case with Has Contraindication=true → waiver_status 'active'", () => {
  const evidence = {
    expressionResults: [
      { define: "Has Contraindication", result: true },
      { define: "Outcome Status", result: "EXCLUDED" },
    ],
  };
  const wf = deriveWhyFlagged(evidence, "adult_immunization", "2026-06-19", "EXCLUDED");
  assert.equal(wf.waiver_status, "active", "contraindication true must produce waiver_status 'active'");
  assert.equal(wf.outcome_status, "EXCLUDED");
});

test("deriveWhyFlagged — non-excluded immunization case with Has Contraindication=false → waiver_status 'none'", () => {
  const evidence = {
    expressionResults: [
      { define: "Has Contraindication", result: false },
      { define: "Outcome Status", result: "MISSING_DATA" },
    ],
  };
  const wf = deriveWhyFlagged(evidence, "adult_immunization", "2026-06-19", "MISSING_DATA");
  assert.equal(wf.waiver_status, "none", "contraindication false must produce waiver_status 'none'");
  assert.equal(wf.outcome_status, "MISSING_DATA");
});

test("overdueDays is grace-aware: overdue is measured past windowDays + gracePeriodDays (E11.2a)", () => {
  // No grace (default 0) — pre-grace behavior, unchanged.
  assert.equal(overdueDays(400, 365), 35); // 400 - 365
  assert.equal(overdueDays(350, 365), 0); // within window
  // With a 30-day grace: a subject within grace (DUE_SOON band) reads 0; only past 395 counts as overdue.
  assert.equal(overdueDays(380, 365, 30), 0); // within grace (≤ 395)
  assert.equal(overdueDays(395, 365, 30), 0); // exactly at the graced deadline
  assert.equal(overdueDays(410, 365, 30), 15); // 410 - (365 + 30)
});
