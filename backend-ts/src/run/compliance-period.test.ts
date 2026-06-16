/**
 * Compliance-cycle bucketing unit tests (#150 H1) — TS parity with the Java
 * `CompliancePeriodTest`. Pure functions, no DB.
 *   node --import tsx --test src/run/compliance-period.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cadenceFor, cycleAnchor, cycleKey, bucketPeriodForMeasure } from "./compliance-period.ts";

test("cadenceFor: ≤200-day window is biannual, larger is annual, seasonal overrides", () => {
  assert.equal(cadenceFor(180, false), "BIANNUAL");
  assert.equal(cadenceFor(200, false), "BIANNUAL");
  assert.equal(cadenceFor(201, false), "ANNUAL");
  assert.equal(cadenceFor(365, false), "ANNUAL");
  assert.equal(cadenceFor(820, false), "ANNUAL");
  assert.equal(cadenceFor(0, false), "ANNUAL"); // a non-positive window is not biannual
  assert.equal(cadenceFor(365, true), "SEASONAL"); // seasonal flag wins regardless of window
});

test("cycleAnchor ANNUAL → Jan 1 of the year", () => {
  assert.equal(cycleAnchor("ANNUAL", "2026-01-01"), "2026-01-01");
  assert.equal(cycleAnchor("ANNUAL", "2026-06-16"), "2026-01-01");
  assert.equal(cycleAnchor("ANNUAL", "2026-12-31"), "2026-01-01");
});

test("cycleAnchor BIANNUAL → Jan 1 (H1) or Jul 1 (H2)", () => {
  assert.equal(cycleAnchor("BIANNUAL", "2026-01-01"), "2026-01-01");
  assert.equal(cycleAnchor("BIANNUAL", "2026-06-30"), "2026-01-01");
  assert.equal(cycleAnchor("BIANNUAL", "2026-07-01"), "2026-07-01");
  assert.equal(cycleAnchor("BIANNUAL", "2026-12-31"), "2026-07-01");
});

test("cycleAnchor SEASONAL → Jul 1 of the current Jul–Jun season", () => {
  assert.equal(cycleAnchor("SEASONAL", "2026-07-01"), "2026-07-01"); // start of season
  assert.equal(cycleAnchor("SEASONAL", "2026-12-15"), "2026-07-01"); // mid-season (fall)
  assert.equal(cycleAnchor("SEASONAL", "2027-02-15"), "2026-07-01"); // same season, next calendar year
  assert.equal(cycleAnchor("SEASONAL", "2026-06-30"), "2025-07-01"); // prior season tail
});

test("cycleKey composes cadence + anchor", () => {
  assert.equal(cycleKey(180, false, "2026-09-09"), "2026-07-01"); // biannual H2
  assert.equal(cycleKey(365, false, "2026-09-09"), "2026-01-01"); // annual
  assert.equal(cycleKey(365, true, "2026-09-09"), "2026-07-01"); // seasonal
});

test("idempotency: any two dates in the same cycle bucket to the same key", () => {
  // The H1 property — a nightly run on any day of a cycle yields one stable period key.
  const jan = "2026-01-01";
  for (const d of ["2026-01-02", "2026-03-15", "2026-06-30"]) {
    assert.equal(cycleKey(365, false, d), jan, `${d} annual → ${jan}`);
  }
  // ...and a date in the NEXT cycle buckets differently (a genuinely new cohort).
  assert.notEqual(cycleKey(365, false, "2027-01-01"), jan);
});

test("bucketPeriodForMeasure resolves each runnable measure's cadence from its binding", () => {
  const asOf = "2026-09-09"; // H2 → exercises the biannual split
  assert.equal(bucketPeriodForMeasure("audiogram", asOf), "2026-01-01"); // 365 → annual
  assert.equal(bucketPeriodForMeasure("cms125", asOf), "2026-01-01"); // 820 → annual
  assert.equal(bucketPeriodForMeasure("diabetes_hba1c", asOf), "2026-07-01"); // 180 → biannual H2
  assert.equal(bucketPeriodForMeasure("flu_vaccine", asOf), "2026-07-01"); // seasonal
  assert.equal(bucketPeriodForMeasure("unknown_measure", asOf), "2026-01-01"); // fallback 365 → annual
});
