import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  noIceHistory,
  realIceForecaster,
  ICE_SERIES_CVX,
  ICE_VACCINE_GROUP,
  type IceDoseHistory,
} from "./ice-forecaster.ts";
import { cvxCodesForMeasure } from "../ingress/webchart/terminology.ts";
import { parseCdsOutputProposals } from "./ice-vmr.ts";
import { noHistoryForecaster } from "./immunization-forecast.ts";
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

/**
 * A fixed dose history for the adapter tests: test data, never served. (It is the history the golden
 * response was captured against; the app has no history source yet, #628.)
 */
const FIXTURE: IceDoseHistory = {
  patientId: "emp-006",
  dob: "1971-06-16",
  gender: "M",
  doses: [
    { cvx: "115", date: "2021-06-25" }, // Tdap
    { cvx: "141", date: "2021-09-30" }, // influenza, seasonal, injectable
    { cvx: "43", date: "2021-11-06" }, // HepB, adult (the traditional 3-dose formulation)
    { cvx: "43", date: "2022-01-05" },
  ],
};
const fixtureHistory = () => FIXTURE;

/** What any failure answers: no series, but there was a history (so not "no history"). */
const failed = (subjectId: string, asOf: string) => ({ subjectId, asOf, historyAvailable: true, series: [] });

// The golden response's DTP (Tdap) proposal is RECOMMENDED due 2026-03-15, influenza RECOMMENDED
// due 2026-07-01, HepB NOT_RECOMMENDED (COMPLETE).
const forecasterOn = (fetchImpl: typeof fetch) =>
  realIceForecaster(CFG, { historySource: fixtureHistory, fetchImpl });

test("maps the live ICE proposals onto the three port series", async () => {
  const calls: Call[] = [];
  const f = await forecasterOn(goldenFetch(calls)).forecast("emp-006", "2026-07-13");

  assert.equal(f.subjectId, "emp-006");
  assert.equal(f.asOf, "2026-07-13");
  assert.equal(f.historyAvailable, true);
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
  const f = await forecasterOn(goldenFetch([])).forecast("emp-006", "2026-01-01");
  const tdap = f.series.find((s) => s.series === "TDAP");
  assert.equal(tdap?.status, "DUE", "due 2026-03-15 is after asOf 2026-01-01");
});

// ICE's clock is ALWAYS pinned to asOf — including when asOf is today. /evaluate would evaluate at the
// ICE *container's* clock, so a TZ-skewed host would shift "today" forecasts by a day while as-of
// forecasts stayed correct. (Verified live: pinning today returns byte-identical proposals.)
test("every call posts /evaluateAtSpecifiedTime with specifiedTime = asOf (the clock is always pinned)", async () => {
  const calls: Call[] = [];
  const f = forecasterOn(goldenFetch(calls));

  await f.forecast("emp-006", "2026-07-13"); // asOf == today
  assert.match(callAt(calls, 0).url, /\/api\/resources\/evaluateAtSpecifiedTime$/);
  assert.equal((callAt(calls, 0).body as Record<string, unknown>).specifiedTime, "2026-07-13");

  await f.forecast("emp-006", "2020-01-18"); // asOf in the past
  assert.match(callAt(calls, 1).url, /\/api\/resources\/evaluateAtSpecifiedTime$/);
  assert.equal((callAt(calls, 1).body as Record<string, unknown>).specifiedTime, "2020-01-18");
  // the DSS envelope must still be intact alongside specifiedTime
  assert.ok((callAt(calls, 1).body as Record<string, unknown>).evaluationRequest);
});

test("the posted CDSInput carries the subject's dose history as CVX-coded events", async () => {
  const calls: Call[] = [];
  await forecasterOn(goldenFetch(calls)).forecast("emp-006", "2026-07-13");
  const xml = postedCdsInput(calls, 0);
  assert.equal((xml.match(/<substanceAdministrationEvent>/g) ?? []).length, FIXTURE.doses.length);
  assert.match(xml, /substanceCode code="115"/);
  assert.match(xml, new RegExp(`<birthTime value="${FIXTURE.dob}"/>`));
});

test("no API key ⇒ no Authorization header; an API key ⇒ bearer", async () => {
  const calls: Call[] = [];
  await forecasterOn(goldenFetch(calls)).forecast("emp-006", "2026-07-13");
  assert.equal(callAt(calls, 0).headers.authorization, undefined);

  const keyed = realIceForecaster(
    { ...CFG, apiKey: "sekret" },
    { historySource: fixtureHistory, fetchImpl: goldenFetch(calls) },
  );
  await keyed.forecast("emp-006", "2026-07-13");
  assert.equal(callAt(calls, 1).headers.authorization, "Bearer sekret");
});

test("a transport error answers an empty forecast, never an invented one (the panel never errors)", async () => {
  const boom = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { historySource: fixtureHistory, fetchImpl: boom }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, failed("emp-006", "2026-07-13"));
});

test("non-2xx answers empty", async () => {
  const five = (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { historySource: fixtureHistory, fetchImpl: five }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, failed("emp-006", "2026-07-13"));
});

test("an unparseable body answers empty", async () => {
  const junk = (async () =>
    new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, { historySource: fixtureHistory, fetchImpl: junk }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, failed("emp-006", "2026-07-13"));
});

test("a response missing one of our three vaccine groups answers empty (never a half-empty forecast)", async () => {
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
  const f = await realIceForecaster(CFG, { historySource: fixtureHistory, fetchImpl: partial }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, failed("emp-006", "2026-07-13"));
});

test("a hanging sidecar times out and answers empty", async () => {
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as unknown as typeof fetch;
  const f = await realIceForecaster(CFG, {
    historySource: fixtureHistory,
    fetchImpl: hang,
    timeoutMs: 20,
  }).forecast("emp-006", "2026-07-13");
  assert.deepEqual(f, failed("emp-006", "2026-07-13"));
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
    fetchImpl: goldenFetch(calls),
    historySource: () => custom,
  });
  const out = await f.forecast("emp-006", "2026-07-13");
  const xml = postedCdsInput(calls, 0);
  assert.match(xml, /<birthTime value="1975-04-02"\/>/);
  assert.match(xml, /extension="wc-42"/);
  // dose counts on the result come from the injected history
  assert.equal(out.series.find((s) => s.series === "TDAP")?.dosesReceived, 1);
  assert.equal(out.series.find((s) => s.series === "TDAP")?.lastDoseDate, "2010-05-05");
});

// #628: with nothing on file for the subject, ICE is not asked to schedule them as though that were
// their record, and the forecast says there is no history (the case page shows that, not a forecast).
test("a history source with nothing for the subject answers 'no history' without dialing", async () => {
  const calls: Call[] = [];
  const f = await realIceForecaster(CFG, { historySource: noIceHistory, fetchImpl: goldenFetch(calls) }).forecast(
    "emp-006",
    "2026-07-13",
  );
  assert.deepEqual(f, { subjectId: "emp-006", asOf: "2026-07-13", historyAvailable: false, series: [] });
  assert.equal(calls.length, 0);
  assert.deepEqual(f, await noHistoryForecaster.forecast("emp-006", "2026-07-13"));
});

test("group codes are the ICE vaccine groups the live engine emits", () => {
  assert.deepEqual(ICE_VACCINE_GROUP, { TDAP: "200", INFLUENZA: "800", HEPB: "100" });
});

// An unhealthy sidecar (hung / restarting / OOM-thrashing) must not charge EVERY case-detail read the
// full timeout. After one failure the breaker answers empty without dialing, until its TTL.
test("the circuit breaker stops dialing an unhealthy ICE for the TTL, then retries", async () => {
  let attempts = 0;
  const failing = (async () => {
    attempts += 1;
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  let clock = 1_000_000;
  const f = realIceForecaster(CFG, {
    historySource: fixtureHistory,
    fetchImpl: failing,
    breakerTtlMs: 60_000,
    now: () => clock,
  });

  await f.forecast("emp-006", "2026-07-13");
  assert.equal(attempts, 1, "the first call dials ICE");

  await f.forecast("emp-007", "2026-07-13");
  const whileOpen = await f.forecast("emp-008", "2026-07-13");
  assert.equal(attempts, 1, "while the breaker is open, subsequent calls do NOT dial ICE");
  assert.deepEqual(whileOpen, failed("emp-008", "2026-07-13"), "an open breaker answers empty");

  clock += 60_001; // TTL elapsed
  await f.forecast("emp-009", "2026-07-13");
  assert.equal(attempts, 2, "after the TTL the breaker half-opens and retries");
});

test("a healthy call after a failure closes the breaker again", async () => {
  const calls: Call[] = [];
  let fail = true;
  const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
    if (fail) throw new Error("boom");
    return goldenFetch(calls)(url as string, init);
  }) as unknown as typeof fetch;

  let clock = 5_000_000;
  const f = realIceForecaster(CFG, {
    historySource: fixtureHistory,
    fetchImpl: flaky,
    breakerTtlMs: 1_000,
    now: () => clock,
  });

  await f.forecast("emp-006", "2026-07-13"); // trips the breaker
  fail = false;
  clock += 1_001;
  const recovered = await f.forecast("emp-006", "2026-07-13"); // retries, succeeds
  assert.ok(
    recovered.series.every((s) => String(s.reason).startsWith("ICE ")),
    "the recovered forecast must come from ICE",
  );
  // Breaker is closed: the next call dials immediately, without waiting out any TTL.
  const again = await f.forecast("emp-006", "2026-07-13");
  assert.ok(again.series.every((s) => String(s.reason).startsWith("ICE ")));
});

// If ICE ever emits two proposals for one vaccine group (e.g. a Td and a Tdap product), document
// order must win deterministically — a Map built by last-write would pick arbitrarily.
test("duplicate proposals for one group: the first in document order wins", async () => {
  const dup = (async () => {
    const xml = `<ns3:cdsOutput>${["800", "800", "200", "100"]
      .map(
        (g, i) => `<substanceAdministrationProposal>
<substance><substanceCode code="${g}" codeSystem="2.16.840.1.113883.3.795.12.100.1" displayName="G${g}"/></substance>
<relatedClinicalStatement><observationResult>
<observationFocus code="${g}" codeSystem="2.16.840.1.113883.3.795.12.100.1" displayName="G${g}"/>
<observationValue><concept code="${i === 1 ? "NOT_RECOMMENDED" : "RECOMMENDED"}" codeSystem="x"/></observationValue>
<interpretation code="${i === 1 ? "SECOND" : "FIRST"}" codeSystem="y"/>
</observationResult></relatedClinicalStatement>
<proposedAdministrationTimeInterval low="2026070100000${i}.000+0000"/>
</substanceAdministrationProposal>`,
      )
      .join("")}</ns3:cdsOutput>`;
    const envelope = {
      finalKMEvaluationResponse: [
        { kmEvaluationResultData: [{ data: { base64EncodedPayload: [btoa(xml)] } }] },
      ],
    };
    return new Response(JSON.stringify(envelope), { status: 200 });
  }) as unknown as typeof fetch;

  const f = await realIceForecaster(CFG, { historySource: fixtureHistory, fetchImpl: dup }).forecast(
    "emp-006",
    "2026-07-13",
  );
  const flu = f.series.find((s) => s.series === "INFLUENZA");
  assert.match(String(flu?.reason), /^ICE RECOMMENDED \(FIRST\)$/, "the FIRST influenza proposal wins");
});

// The fixture's HepB doses are CVX 43 (traditional adult HepB, a 3-dose ACIP series). Reporting
// dosesRequired: 2 (the Heplisav model) would render the self-contradictory card "2 of 2 doses — OVERDUE".
test("HepB dosesRequired on the ICE path matches the CVX actually reported (3, not the Heplisav 2)", async () => {
  const f = await forecasterOn(goldenFetch([])).forecast("emp-006", "2026-07-13");
  const hepb = f.series.find((s) => s.series === "HEPB");
  assert.equal(hepb?.dosesRequired, 3, "CVX 43 is the traditional 3-dose series");
  assert.equal(hepb?.dosesReceived, 2, "the fixture has 2 HepB doses");
});

// ICE scores whatever codes it is given. A history source supplying REAL-WORLD codes (Td 09/113/196,
// any of the 19 active seasonal flu codes, Heplisav 189 / HepB 08/44/45) gets a correct ICE
// recommendation — so the display fields must recognize those codes too, or the panel claims
// "no prior dose" for a subject whose recommendation was plainly based on them. This lands the moment
// the E12 WebChart history source is injected.
test("doses are counted across the WHOLE CVX set for a series, not just the representative code", async () => {
  const realWorld: IceDoseHistory = {
    patientId: "wc-real",
    dob: "1979-08-08",
    gender: "M",
    doses: [
      { cvx: "09", date: "2015-02-02" }, // Td (adult) — NOT the representative 115
      { cvx: "113", date: "2019-03-03" }, // Td (preservative-free)
      { cvx: "150", date: "2025-10-01" }, // influenza, quadrivalent — NOT the representative 141
      { cvx: "08", date: "2012-01-01" }, // HepB, adolescent/pediatric — NOT the representative 43
      { cvx: "44", date: "2012-03-01" }, // HepB, dialysis
    ],
  };
  const f = realIceForecaster(CFG, {
    fetchImpl: goldenFetch([]),
    historySource: () => realWorld,
  });
  const out = await f.forecast("wc-real", "2026-07-13");

  const tdap = out.series.find((s) => s.series === "TDAP");
  // Both Td codes were recognized (the point of this test) — but dosesReceived means "progress toward
  // the current requirement", so it clamps at 1 rather than rendering the nonsensical "2 of 1 doses".
  // lastDoseDate proves the SECOND dose was seen.
  assert.equal(tdap?.dosesReceived, 1);
  assert.equal(tdap?.dosesRequired, 1);
  assert.equal(tdap?.lastDoseDate, "2019-03-03", "the later Td (113) was recognized, not just the first");

  const flu = out.series.find((s) => s.series === "INFLUENZA");
  assert.equal(flu?.dosesReceived, 1, "a quadrivalent flu code counts");
  assert.equal(flu?.lastDoseDate, "2025-10-01");

  const hepb = out.series.find((s) => s.series === "HEPB");
  assert.equal(hepb?.dosesReceived, 2, "HepB 08 + 44 count toward the HepB series");
  assert.equal(hepb?.dosesRequired, 3, "a non-Heplisav history is a 3-dose series");
});

// A lifetime booster count against a per-cycle requirement would render "2 of 1 doses" on the card.
test("dosesReceived is progress toward the requirement, not a lifetime tally (never 'N of 1')", async () => {
  const many: IceDoseHistory = {
    patientId: "wc-many",
    dob: "1970-01-01",
    gender: "M",
    doses: [
      { cvx: "115", date: "2001-01-01" },
      { cvx: "09", date: "2011-01-01" },
      { cvx: "113", date: "2021-01-01" }, // three lifetime Td/Tdap boosters
      { cvx: "43", date: "2010-01-01" },
      { cvx: "43", date: "2010-03-01" },
      { cvx: "43", date: "2010-09-01" },
      { cvx: "44", date: "2015-01-01" }, // a FOURTH HepB dose on a 3-dose series
    ],
  };
  const out = await realIceForecaster(CFG, {
    fetchImpl: goldenFetch([]),
    historySource: () => many,
  }).forecast("wc-many", "2026-07-13");

  for (const s of out.series) {
    assert.ok(
      s.dosesReceived <= s.dosesRequired,
      `${s.series}: dosesReceived (${s.dosesReceived}) must never exceed dosesRequired (${s.dosesRequired})`,
    );
  }
  assert.equal(out.series.find((s) => s.series === "TDAP")?.lastDoseDate, "2021-01-01");
  assert.equal(out.series.find((s) => s.series === "HEPB")?.dosesReceived, 3, "clamped to the 3-dose series");
});

test("a pure Heplisav-B history is reported as the 2-dose series it is", async () => {
  const heplisav: IceDoseHistory = {
    patientId: "wc-heplisav",
    dob: "1985-01-01",
    gender: "F",
    doses: [
      { cvx: "189", date: "2024-01-01" },
      { cvx: "189", date: "2024-02-05" },
    ],
  };
  const out = await realIceForecaster(CFG, {
    fetchImpl: goldenFetch([]),
    historySource: () => heplisav,
  }).forecast("wc-heplisav", "2026-07-13");
  const hepb = out.series.find((s) => s.series === "HEPB");
  assert.equal(hepb?.dosesReceived, 2);
  assert.equal(hepb?.dosesRequired, 2, "Heplisav-B is a 2-dose primary series — not 3");
});

// The CVX sets must stay tied to the crosswalk (the repo's terminology authority), not drift into a
// private second list that a currency audit would miss.
test("the ICE series CVX sets are sourced from the WebChart crosswalk", () => {
  assert.deepEqual([...ICE_SERIES_CVX.TDAP].sort(), [...cvxCodesForMeasure("adult_immunization")].sort());
  assert.deepEqual([...ICE_SERIES_CVX.INFLUENZA].sort(), [...cvxCodesForMeasure("flu_vaccine")].sort());
  assert.deepEqual(
    [...ICE_SERIES_CVX.HEPB].sort(),
    [...cvxCodesForMeasure("hepatitis_b_vaccination_series")].sort(),
  );
  // And the fixture's codes must be members of their series' sets.
  assert.ok(ICE_SERIES_CVX.TDAP.has("115") && ICE_SERIES_CVX.INFLUENZA.has("141") && ICE_SERIES_CVX.HEPB.has("43"));
});

test("resolveForecaster: no-history by default, real ICE when BASE_URL is set (key optional)", async () => {
  assert.equal(resolveForecaster({}), noHistoryForecaster);
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_API_KEY: "k" }), noHistoryForecaster, "key alone does not select");
  assert.equal(resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "   " }), noHistoryForecaster, "blank is not set");
  const real = resolveForecaster({ WORKWELL_IMMZ_ICE_BASE_URL: "http://ice:8080/x" });
  assert.notEqual(real, noHistoryForecaster);
});
