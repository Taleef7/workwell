import { test } from "node:test";
import assert from "node:assert/strict";
import {
  syntheticImmunizationHistory,
  simulatedForecaster,
  resolveForecaster,
  iceForecaster,
  VACCINE_SERIES,
} from "./immunization-forecast.ts";

test("synthetic history is deterministic per subject and covers all 3 series", () => {
  const a = syntheticImmunizationHistory("emp-006");
  const b = syntheticImmunizationHistory("emp-006");
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((h) => h.series).sort(), [...VACCINE_SERIES].sort());
});

test("simulated forecaster returns a forecast for all 3 series with computed nextDueDate", () => {
  const f = simulatedForecaster.forecast("emp-006", "2026-06-19");
  assert.equal(f.subjectId, "emp-006");
  assert.equal(f.asOf, "2026-06-19");
  assert.equal(f.series.length, 3);
  for (const s of f.series) {
    assert.ok(["UP_TO_DATE", "DUE", "OVERDUE", "CONTRAINDICATED", "REFUSED"].includes(s.status));
  }
});

test("Td/Tdap is OVERDUE when asOf is far past the last dose + 10y", () => {
  const f = simulatedForecaster.forecast("emp-006", "2099-01-01");
  const tdap = f.series.find((s) => s.series === "TDAP")!;
  assert.equal(tdap.status, "OVERDUE");
});

test("resolveForecaster returns simulated by default", () => {
  assert.equal(resolveForecaster({}), simulatedForecaster);
});

test("resolveForecaster returns the ICE stub only when both env vars set; stub is inert", () => {
  const env = { WORKWELL_IMMZ_ICE_API_KEY: "k", WORKWELL_IMMZ_ICE_BASE_URL: "https://ice.example" };
  const f = resolveForecaster(env);
  assert.notEqual(f, simulatedForecaster);
  const out = f.forecast("emp-006", "2026-06-19");
  assert.ok(out.series.every((s) => (s.reason ?? "").includes("ICE not wired")));
});

test("only one env var set still returns simulated (inert-unless-fully-configured)", () => {
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_API_KEY: "k" }), simulatedForecaster);
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "https://x" }), simulatedForecaster);
});
