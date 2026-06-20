/**
 * Unit tests for the historical-trend compliance rate (synthetic trend history feature).
 * `historicalComplianceRate` must be pure + deterministic (no Math.random), bounded to
 * [0.40, 0.99], vary across weeks, differ by measure (phase seeded from the rateKey), and
 * land the newest week near the measure's base rate (continuous with the current real run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { complianceRate, historicalComplianceRate } from "./compliance-rates.ts";

const WEEKS = 12;
const KEYS = ["audiogram", "tb_surveillance", "hazwoper", "flu_vaccine", "hypertension"];

test("historicalComplianceRate is deterministic (same inputs → same output)", () => {
  for (const key of KEYS) {
    for (let w = 0; w < WEEKS; w++) {
      assert.equal(historicalComplianceRate(key, w, WEEKS), historicalComplianceRate(key, w, WEEKS));
    }
  }
});

test("historicalComplianceRate stays within [0.40, 0.99]", () => {
  // Include a low base (hazwoper 0.65) and a high base (tb 0.91) and an unconfigured key.
  for (const key of [...KEYS, "cms125", "totally-unknown-key"]) {
    for (let w = 0; w < WEEKS; w++) {
      const r = historicalComplianceRate(key, w, WEEKS);
      assert.ok(r >= 0.4, `${key} week ${w} = ${r} below floor`);
      assert.ok(r <= 0.99, `${key} week ${w} = ${r} above ceiling`);
    }
  }
});

test("historicalComplianceRate varies across weeks (not a flat line)", () => {
  for (const key of KEYS) {
    const series = Array.from({ length: WEEKS }, (_, w) => historicalComplianceRate(key, w, WEEKS));
    assert.ok(new Set(series).size > 1, `${key} produced a flat line: ${series.join(",")}`);
  }
});

test("historicalComplianceRate differs by measure (per-measure phase)", () => {
  // The week-0 value should differ across at least two measures with different rateKeys.
  const week0 = KEYS.map((k) => historicalComplianceRate(k, 0, WEEKS));
  assert.ok(new Set(week0).size > 1, `all measures shared the same week-0 rate: ${week0.join(",")}`);
});

test("historicalComplianceRate gives same-base measures distinct curves (L1 guard)", () => {
  // cms125 and adult_immunization share the 0.80 default base; their 12-week series must differ.
  const a = Array.from({ length: WEEKS }, (_, w) => historicalComplianceRate("cms125", w, WEEKS));
  const b = Array.from({ length: WEEKS }, (_, w) => historicalComplianceRate("adult_immunization", w, WEEKS));
  assert.notDeepEqual(a, b, `same-base measures produced identical curves: ${a.join(",")}`);
});

test("historicalComplianceRate newest week ≈ base rate (continuous with the current real run)", () => {
  for (const key of KEYS) {
    const base = complianceRate(key);
    const newest = historicalComplianceRate(key, WEEKS - 1, WEEKS);
    assert.ok(
      Math.abs(newest - base) <= 0.02,
      `${key} newest week ${newest} not near base ${base}`,
    );
  }
});

test("historicalComplianceRate amplitude stays near ±0.06 of the base rate", () => {
  for (const key of KEYS) {
    const base = complianceRate(key);
    for (let w = 0; w < WEEKS; w++) {
      const r = historicalComplianceRate(key, w, WEEKS);
      // before clamping the oscillation is ~±0.06; clamping only narrows it, so the
      // deviation from base can never exceed the amplitude budget (+ a tiny epsilon).
      assert.ok(Math.abs(r - base) <= 0.061, `${key} week ${w} deviates ${Math.abs(r - base)} from base`);
    }
  }
});
