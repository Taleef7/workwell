import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  realIceForecaster,
  syntheticIceHistory,
  ICE_DOSE_CVX,
  ICE_VACCINE_GROUP,
  type IceDoseHistory,
} from "./ice-forecaster.ts";
import { parseCdsOutputProposals } from "./ice-vmr.ts";
import { simulatedForecaster, type ImmunizationForecast } from "./immunization-forecast.ts";
import { resolveForecaster } from "./resolve-forecaster.ts";

const GOLDEN = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../spike/ice/dss-response.json", import.meta.url)), "utf8"),
) as unknown;

const CFG = { baseUrl: "http://ice.test/opencds-decision-support-service" };

interface Call {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

/** The CDSInput XML the adapter actually posted on call `i`. */
function postedCdsInput(calls: Call[], i: number): string {
  const call = calls[i];
  assert.ok(call, `expected a call at index ${i}`);
  const body = call.body as {
    evaluationRequest: { dataRequirementItemData: Array<{ data: { base64EncodedPayload: string[] } }> };
  };
  const dri = body.evaluationRequest.dataRequirementItemData[0];
  assert.ok(dri, "posted DSS envelope must carry a dataRequirementItemData entry");
  assert.ok(Array.isArray(dri.data.base64EncodedPayload), "the posted payload must be an array (ICE 400s otherwise)");
  const b64 = dri.data.base64EncodedPayload[0];
  assert.ok(b64, "the posted payload array must be non-empty");
  return atob(b64);
}

function callAt(calls: Call[], i: number): Call {
  const call = calls[i];
  assert.ok(call, `expected a call at index ${i}`);
  return call;
}

/** A transport that always replays the golden live ICE response, recording what it was asked. */
function goldenFetch(calls: Call[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(JSON.stringify(GOLDEN), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

// The golden response's DTP (Tdap) proposal is RECOMMENDED due 2026-03-15, influenza RECOMMENDED
// due 2026-07-01, HepB NOT_RECOMMENDED (COMPLETE).
const forecasterOn = (fetchImpl: typeof fetch, today = "2026-07-13") =>
  realIceForecaster(CFG, { fallback: simulatedForecaster, fetchImpl, today: () => today });

test("maps the live ICE proposals onto the three port series", async () => {
  const calls: Call[] = [];
  const f = await forecasterOn(goldenFetch(calls)).forecast("emp-006", "2026-07-13");

  assert.equal(f.subjectId, "emp-006");
  assert.equal(f.asOf, "2026-07-13");
  assert.deepEqual(
    f.series.map((s) => s.series),
    ["TDAP", "INFLUENZA", "HEPB"],
  );

  const tdap = f.series.find((s) => s.series === "TDAP");
  assert.equal(tdap?.nextDueDate, "2026-03-15");
  assert.equal(tdap?.status, "OVERDUE", "due 2026-03-15 is before asOf 2026-07-13");
  assert.match(String(tdap?.reason), /^ICE RECOMMENDED \(.*ADMINISTER_TDAP_OR_TD.*\)$/);

  const flu = f.series.find((s) => s.series === "INFLUENZA");
  assert.equal(flu?.nextDueDate, "2026-07-01");
  assert.equal(flu?.status, "OVERDUE", "due 2026-07-01 is before asOf 2026-07-13");

  const hepb = f.series.find((s) => s.series === "HEPB");
  assert.equal(hepb?.status, "UP_TO_DATE");
  assert.equal(hepb?.nextDueDate, null);
  assert.equal(hepb?.reason, "ICE NOT_RECOMMENDED (COMPLETE)");
});

test("a RECOMMENDED proposal whose due date is still ahead of asOf reads DUE, not OVERDUE", async () => {
  const f = await forecasterOn(goldenFetch([]), "2026-01-01").forecast("emp-006", "2026-01-01");
  const tdap = f.series.find((s) => s.series === "TDAP");
  assert.equal(tdap?.status, "DUE", "due 2026-03-15 is after asOf 2026-01-01");
});

test("asOf == today posts /evaluate; a different asOf posts /evaluateAtSpecifiedTime with specifiedTime", async () => {
  const calls: Call[] = [];
  const f = forecasterOn(goldenFetch(calls), "2026-07-13");

  await f.forecast("emp-006", "2026-07-13");
  assert.match(callAt(calls, 0).url, /\/api\/resources\/evaluate$/);
  assert.equal((callAt(calls, 0).body as Record<string, unknown>).specifiedTime, undefined);

  await f.forecast("emp-006", "2020-01-18");
  assert.match(callAt(calls, 1).url, /\/api\/resources\/evaluateAtSpecifiedTime$/);
  assert.equal((callAt(calls, 1).body as Record<string, unknown>).specifiedTime, "2020-01-18");
  // the DSS envelope must still be intact alongside specifiedTime
  assert.ok((callAt(calls, 1).body as Record<string, unknown>).evaluationRequest);
});

test("the posted CDSInput carries the subject's dose history as CVX-coded events", async () => {
  const calls: Call[] = [];
  await forecasterOn(goldenFetch(calls)).forecast("emp-006", "2026-07-13");
  const xml = postedCdsInput(calls, 0);
  const history = syntheticIceHistory("emp-006");
  assert.equal((xml.match(/<substanceAdministrationEvent>/g) ?? []).length, history.doses.length);
  assert.match(xml, new RegExp(`substanceCode code="${ICE_DOSE_CVX.TDAP}"`));
  assert.match(xml, new RegExp(`<birthTime value="${history.dob}"/>`));
});

test("no API key ⇒ no Authorization header; an API key ⇒ bearer", async () => {
  const calls: Call[] = [];
  await forecasterOn(goldenFetch(calls)).forecast("emp-006", "2026-07-13");
  assert.equal(callAt(calls, 0).headers.authorization, undefined);

  const keyed = realIceForecaster(
    { ...CFG, apiKey: "sekret" },
    { fallback: simulatedForecaster, fetchImpl: goldenFetch(calls), today: () => "2026-07-13" },
  );
  await keyed.forecast("emp-006", "2026-07-13");
  assert.equal(callAt(calls, 1).headers.authorization, "Bearer sekret");
});

test("transport error falls back to the simulated forecaster (advisory surface never errors)", async () => {
  const boom = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { fallback: simulatedForecaster, fetchImpl: boom }).forecast(
    "emp-006",
    "2026-07-13",
  );
  const expected: ImmunizationForecast = await simulatedForecaster.forecast("emp-006", "2026-07-13");
  assert.deepEqual(f, expected);
});

test("non-2xx falls back", async () => {
  const five = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { fallback: simulatedForecaster, fetchImpl: five }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, await simulatedForecaster.forecast("emp-006", "2026-07-13"));
});

test("an unparseable body falls back", async () => {
  const junk = (async () =>
    new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { fallback: simulatedForecaster, fetchImpl: junk }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, await simulatedForecaster.forecast("emp-006", "2026-07-13"));
});

test("a response missing one of our three vaccine groups falls back (never a half-empty forecast)", async () => {
  const goldenXmlStripped = JSON.parse(JSON.stringify(GOLDEN)) as Record<string, unknown>;
  // Rebuild the payload with the influenza (800) proposal removed.
  const walk = (o: unknown): string[] | undefined => {
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const rec = o as Record<string, unknown>;
      if ("base64EncodedPayload" in rec) return rec.base64EncodedPayload as string[];
      for (const v of Object.values(rec)) {
        const r = walk(v);
        if (r) return r;
      }
    } else if (Array.isArray(o)) {
      for (const v of o) {
        const r = walk(v);
        if (r) return r;
      }
    }
    return undefined;
  };
  const payload = walk(goldenXmlStripped)!;
  const first = payload[0];
  assert.ok(first, "fixture setup: payload array must be non-empty");
  const xml = atob(first);
  const stripped = xml.replace(
    /<substanceAdministrationProposal>(?:(?!<\/substanceAdministrationProposal>)[\s\S])*?code="800"[\s\S]*?<\/substanceAdministrationProposal>/,
    "",
  );
  // (code="800" still appears in per-dose evaluation blocks — only the PROPOSAL must be gone.)
  assert.equal(
    parseCdsOutputProposals(stripped).filter((p) => p.groupCode === "800").length,
    0,
    "fixture setup: the influenza proposal must be gone",
  );
  payload[0] = btoa(stripped);

  const partial = (async () =>
    new Response(JSON.stringify(goldenXmlStripped), { status: 200 })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { fallback: simulatedForecaster, fetchImpl: partial }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, await simulatedForecaster.forecast("emp-006", "2026-07-13"));
});

test("a hanging sidecar times out and falls back", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, {
    fallback: simulatedForecaster,
    fetchImpl: hang,
    timeoutMs: 20,
  }).forecast("emp-006", "2026-07-13");
  assert.deepEqual(f, await simulatedForecaster.forecast("emp-006", "2026-07-13"));
});

test("the history source is injectable (the WebChart drop-in seam)", async () => {
  const calls: Call[] = [];
  const custom: IceDoseHistory = {
    patientId: "wc-42",
    dob: "1975-04-02",
    gender: "M",
    doses: [{ cvx: "115", date: "2010-05-05" }],
  };
  const f = realIceForecaster(CFG, {
    fallback: simulatedForecaster,
    fetchImpl: goldenFetch(calls),
    historySource: () => custom,
    today: () => "2026-07-13",
  });
  const out = await f.forecast("emp-006", "2026-07-13");
  const xml = postedCdsInput(calls, 0);
  assert.match(xml, /<birthTime value="1975-04-02"\/>/);
  assert.match(xml, /extension="wc-42"/);
  // dose counts on the result come from the injected history, not the synthetic one
  assert.equal(out.series.find((s) => s.series === "TDAP")?.dosesReceived, 1);
  assert.equal(out.series.find((s) => s.series === "TDAP")?.lastDoseDate, "2010-05-05");
});

test("syntheticIceHistory expands multi-dose series and is deterministic", () => {
  const a = syntheticIceHistory("emp-006");
  const b = syntheticIceHistory("emp-006");
  assert.deepEqual(a, b);
  assert.match(a.dob, /^\d{4}-\d{2}-\d{2}$/);
  // emp-006 has 2 HepB doses in the shared synthetic history ⇒ 2 HepB events
  assert.equal(a.doses.filter((d) => d.cvx === ICE_DOSE_CVX.HEPB).length, 2);
  // events are chronologically ordered
  const dates = a.doses.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort());
});

test("group codes are the ICE vaccine groups the live engine emits", () => {
  assert.deepEqual(ICE_VACCINE_GROUP, { TDAP: "200", INFLUENZA: "800", HEPB: "100" });
});

test("resolveForecaster: simulated by default, real ICE when BASE_URL is set (key optional)", async () => {
  assert.equal(resolveForecaster({}), simulatedForecaster);
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_API_KEY: "k" }), simulatedForecaster, "key alone does not select");
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "   " }), simulatedForecaster, "blank is not set");
  const real = resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "http://ice:8080/x" });
  assert.notEqual(real, simulatedForecaster);
});
