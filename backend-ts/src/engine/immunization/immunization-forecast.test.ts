import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyForecast, isIceConfigured, noHistoryForecaster } from "./immunization-forecast.ts";
import { resolveForecaster } from "./resolve-forecaster.ts";

// #628: the default forecaster used to invent a dose history from a hash of the subject id, and the
// case page rendered it as the person's record. With no history there is nothing to forecast.
test("the default forecaster has no history, so it returns no series and says why", async () => {
  const f = await noHistoryForecaster.forecast("emp-006", "2026-06-19");
  assert.deepEqual(f, { subjectId: "emp-006", asOf: "2026-06-19", historyAvailable: false, series: [] });
});

test("emptyForecast distinguishes 'no history' from 'no answer this time'", () => {
  assert.equal(emptyForecast("s", "2026-01-01", false).historyAvailable, false);
  assert.equal(emptyForecast("s", "2026-01-01", true).historyAvailable, true);
  assert.deepEqual(emptyForecast("s", "2026-01-01", true).series, []);
});

test("resolveForecaster returns the no-history forecaster by default", () => {
  assert.equal(resolveForecaster({}), noHistoryForecaster);
});

// ADR-029: the real ICE adapter is selected by BASE_URL alone — a self-hosted ICE sidecar has no
// API key. The key remains optional (a bearer token for an authenticating proxy) and can never by
// itself select the seam.
test("isIceConfigured is BASE_URL-only; the API key alone never selects ICE", () => {
  assert.equal(isIceConfigured({}), false);
  assert.equal(isIceConfigured({ WORKWELL_IMMZ_ICE_API_KEY: "k" }), false);
  assert.equal(isIceConfigured({ WORKWELL_IMMZ_ICE_BASE_URL: "   " }), false, "blank is not configured");
  assert.equal(isIceConfigured({ WORKWELL_IMMZ_ICE_BASE_URL: "http://ice:8080/x" }), true);
  assert.equal(
    isIceConfigured({ WORKWELL_IMMZ_ICE_BASE_URL: "http://ice:8080/x", WORKWELL_IMMZ_ICE_API_KEY: "k" }),
    true,
  );
});

test("resolveForecaster returns the real ICE adapter when BASE_URL is set", () => {
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_API_KEY: "k" }), noHistoryForecaster);
  assert.notEqual(resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "https://ice.example" }), noHistoryForecaster);
});

// A configured ICE used to be fed the same invented history. With no history source it must answer
// "no history" and never dial the sidecar.
test("a configured ICE with no history source answers 'no history' without dialing", async () => {
  let dialed = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    dialed += 1;
    throw new Error("must not dial ICE without a history");
  }) as typeof fetch;
  try {
    const f = await resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "http://ice.test/x" }).forecast("emp-006", "2026-07-13");
    assert.deepEqual(f, { subjectId: "emp-006", asOf: "2026-07-13", historyAvailable: false, series: [] });
    assert.equal(dialed, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
