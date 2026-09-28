/**
 * LIVE ICE sidecar test — self-skips unless WORKWELL_IMMZ_ICE_BASE_URL is set (the same
 * "runs when the dependency is up, skips otherwise" pattern as the Pg-ceiling store contract).
 * It is the only test that proves the adapter against a real ICE engine rather than the captured
 * golden response.
 *
 *   docker run --rm -d -p 32775:8080 --memory=3g --name ice hlnconsulting/ice:latest
 *   WORKWELL_IMMZ_ICE_BASE_URL=http://localhost:32775/opencds-decision-support-service \
 *     node --import tsx --test src/engine/immunization/ice-live.test.ts
 *
 * Assertions are deliberately structural (shape, series coverage, as-of behavior) rather than
 * pinned to specific dates: ICE ships ACIP rule updates, so a pinned date would rot. The golden
 * fixture test (`ice-forecaster.test.ts`) is what pins exact values.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { realIceForecaster, type IceDoseHistory } from "./ice-forecaster.ts";

const BASE_URL = (process.env.WORKWELL_IMMZ_ICE_BASE_URL ?? "").trim();

/**
 * Gate on REACHABLE, not merely on the var being SET. Otherwise a stale `WORKWELL_IMMZ_ICE_BASE_URL`
 * (left over from an old compose session, or sourced from a `.env`) turns the standard `pnpm test`
 * into a network-dependent suite that FAILS after a string of timeouts instead of skipping. The
 * Pg-ceiling store contract — the precedent this file follows — probes connectivity the same way.
 */
async function iceReachable(): Promise<boolean> {
  if (!BASE_URL) return false;
  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/api/resources/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(2_000),
    });
    // Any HTTP answer proves the sidecar is up — an empty body legitimately answers 400.
    return res.status > 0;
  } catch {
    return false;
  }
}

const skip = (await iceReachable())
  ? false
  : BASE_URL
    ? `ICE sidecar at ${BASE_URL} is not reachable — skipping the live suite`
    : "WORKWELL_IMMZ_ICE_BASE_URL not set — live ICE sidecar not available";

// Test data for the live engine, never served (the app has no history source yet, #628). A failed
// call answers an empty forecast, so every test below asserts the series are present: a silent
// degrade can never masquerade as a live pass.
const HISTORY: IceDoseHistory = {
  patientId: "emp-006",
  dob: "1971-06-16",
  gender: "M",
  doses: [
    { cvx: "115", date: "2021-06-25" },
    { cvx: "141", date: "2021-09-30" },
    { cvx: "43", date: "2021-11-06" },
    { cvx: "43", date: "2022-01-05" },
  ],
};

test("live ICE: forecasts all three series for a subject with a dose history", { skip }, async () => {
  const f = realIceForecaster({ baseUrl: BASE_URL }, { historySource: () => HISTORY, timeoutMs: 60_000 });
  const out = await f.forecast("emp-006", new Date().toISOString().slice(0, 10));

  assert.equal(out.subjectId, "emp-006");
  assert.deepEqual(
    out.series.map((s) => s.series),
    ["TDAP", "INFLUENZA", "HEPB"],
  );
  for (const s of out.series) {
    assert.ok(["UP_TO_DATE", "DUE", "OVERDUE"].includes(s.status), `unexpected status ${s.status}`);
    assert.match(String(s.reason), /^ICE (RECOMMENDED|FUTURE_RECOMMENDED|CONDITIONAL|NOT_RECOMMENDED)/);
    if (s.nextDueDate !== null) assert.match(s.nextDueDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  // The engine saw our doses: the reported last-dose dates come from the history we posted.
  const tdap = out.series.find((s) => s.series === "TDAP");
  assert.equal(tdap?.lastDoseDate, "2021-06-25");
});

test("live ICE: an as-of date in the past shifts the engine's own clock", { skip }, async () => {
  const f = realIceForecaster({ baseUrl: BASE_URL }, { historySource: () => HISTORY, timeoutMs: 60_000 });
  const now = await f.forecast("emp-006", new Date().toISOString().slice(0, 10));
  const past = await f.forecast("emp-006", "2020-01-18");

  const dueNow = now.series.find((s) => s.series === "INFLUENZA")?.nextDueDate;
  const duePast = past.series.find((s) => s.series === "INFLUENZA")?.nextDueDate;
  assert.ok(dueNow && duePast, "influenza carries a proposed date in both runs");
  assert.notEqual(duePast, dueNow, "evaluateAtSpecifiedTime must move the forecast, not repeat today's");
  assert.ok(duePast < dueNow, "a 2020 as-of must propose an earlier influenza dose than today's");
});

test("live ICE: an injected dose history is what the engine scores", { skip }, async () => {
  const f = realIceForecaster(
    { baseUrl: BASE_URL },
    {
      timeoutMs: 60_000,
      // No HepB doses at all → ICE must not report the series complete.
      historySource: () => ({
        patientId: "live-test-1",
        dob: "1985-03-04",
        gender: "F",
        doses: [{ cvx: "115", date: "2015-04-01" }],
      }),
    },
  );
  const out = await f.forecast("live-test-1", new Date().toISOString().slice(0, 10));
  assert.equal(out.series.length, 3, "the live call must succeed (a failure answers no series)");
  const hepb = out.series.find((s) => s.series === "HEPB");
  assert.equal(hepb?.dosesReceived, 0);
  assert.doesNotMatch(String(hepb?.reason), /COMPLETE\b/, "a subject with no HepB doses is not COMPLETE");
});

// Regression (found live 2026-07-13): a subject with NO DTP-family history gets a *product*-coded
// Tdap proposal (substance CVX 115, focus group 200). An adapter keyed on substanceCode finds no
// group 200, throws "no proposal for TDAP", and silently degrades the WHOLE forecast to empty.
test("live ICE: a subject with no Tdap history still gets a real TDAP forecast", { skip }, async () => {
  const f = realIceForecaster(
    { baseUrl: BASE_URL },
    {
      timeoutMs: 60_000,
      historySource: () => ({
        patientId: "live-no-tdap",
        dob: "1980-02-02",
        gender: "F",
        doses: [{ cvx: "43", date: "2021-03-01" }], // HepB only — nothing in the DTP family
      }),
    },
  );
  const out = await f.forecast("live-no-tdap", new Date().toISOString().slice(0, 10));
  const tdap = out.series.find((s) => s.series === "TDAP");
  assert.ok(tdap, "TDAP must be present");
  assert.equal(tdap.dosesReceived, 0);
  assert.match(String(tdap.reason), /^ICE /, "must be an ICE-sourced forecast, not a silent fallback");
  assert.ok(["DUE", "OVERDUE"].includes(tdap.status), `an adult with no Tdap is due; got ${tdap.status}`);
});
