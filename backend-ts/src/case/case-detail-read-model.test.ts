/**
 * case-detail-read-model unit tests (#76 E6).
 *   node --import tsx --test src/case/case-detail-read-model.test.ts
 *
 * Verifies:
 *  (a) toCaseDetail includes immunizationForecast in the output when the param is provided,
 *      OMITS the key when not provided, and case `status` is identical either way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCaseDetail } from "./case-detail-read-model.ts";
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
