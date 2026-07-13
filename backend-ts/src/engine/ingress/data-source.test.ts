/**
 * E12 PR-1/#255: the PatientDataSource port — JSON-bucket adapter (default), gated WebChart adapter
 * (inert-unless-configured), resolveDataSource selection, and evaluateSource sugar.
 *   node --import tsx --test src/engine/ingress/data-source.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { jsonBucketDataSource, webChartDataSource, resolveDataSource, evaluateSource } from "./data-source.ts";
import { fixtureWebChartClient } from "./webchart/webchart-client.ts";

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

/** A WebChart-shaped audiogram bundle: enrollment (from the OH program roster) + a REAL-CPT-coded event. */
function webchartAudiogram(eventCode: { system: string; code: string }, performedDateTime: string): unknown {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "wc-emp-1" } },
      {
        resource: {
          resourceType: "Condition",
          subject: { reference: "Patient/wc-emp-1" },
          // Program membership is supplied by the occupational-health roster, not WebChart clinical
          // coding — so it already carries the enrollment value set. Reconciliation targets the EVENT.
          code: { coding: [{ system: "urn:workwell:vs:hearing-enrollment", code: "hearing-enrollment" }] },
        },
      },
      {
        resource: {
          resourceType: "Procedure",
          status: "completed",
          subject: { reference: "Patient/wc-emp-1" },
          code: { coding: [eventCode] },
          performedDateTime,
        },
      },
    ],
  };
}

test("jsonBucketDataSource: single object, array, and empty input load to the right length", async () => {
  assert.equal((await jsonBucketDataSource({ a: 1 }).loadBundles()).length, 1);
  assert.equal((await jsonBucketDataSource([{ a: 1 }, { b: 2 }]).loadBundles()).length, 2);
  assert.equal((await jsonBucketDataSource(undefined).loadBundles()).length, 0); // no input → empty bucket
  assert.equal(jsonBucketDataSource({}).kind, "json");
});

test("resolveDataSource: defaults to JSON; selects WebChart only when BOTH env vars are set", () => {
  assert.equal(resolveDataSource({}, { a: 1 }).kind, "json");
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x" }, { a: 1 }).kind, "json"); // only one set → JSON
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_API_KEY: "k" }, { a: 1 }).kind, "json");  // only one set → JSON
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: " ", WORKWELL_WEBCHART_API_KEY: "k" }, { a: 1 }).kind, "json"); // blank-after-trim → JSON
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x", WORKWELL_WEBCHART_API_KEY: "k" }).kind, "webchart");
});

test("resolveDataSource: the SMART pair (CLIENT_ID + PRIVATE_KEY) also selects WebChart (PR-2c)", () => {
  const PEM = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
  assert.equal(
    resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x", WORKWELL_WEBCHART_CLIENT_ID: "c", WORKWELL_WEBCHART_PRIVATE_KEY: PEM }).kind,
    "webchart",
  );
  // half a SMART pair is NOT configured
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x", WORKWELL_WEBCHART_CLIENT_ID: "c" }, { a: 1 }).kind, "json");
  assert.equal(resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x", WORKWELL_WEBCHART_PRIVATE_KEY: PEM }, { a: 1 }).kind, "json");
  // blank-after-trim SMART values are NOT configured
  assert.equal(
    resolveDataSource({ WORKWELL_WEBCHART_BASE_URL: "x", WORKWELL_WEBCHART_CLIENT_ID: " ", WORKWELL_WEBCHART_PRIVATE_KEY: " " }, { a: 1 }).kind,
    "json",
  );
});

test("webChartDataSource: the default HTTP transport constructs only on the gated WebChart path", () => {
  const src = webChartDataSource({ baseUrl: "x", apiKey: "k" });
  assert.equal(src.kind, "webchart");
});

test("resolveDataSource: deployed default stays JSON when WebChart env vars are unset or blank", async () => {
  const input = { unchanged: true };
  for (const env of [
    {},
    { WORKWELL_WEBCHART_BASE_URL: "", WORKWELL_WEBCHART_API_KEY: "" },
    { WORKWELL_WEBCHART_BASE_URL: " ", WORKWELL_WEBCHART_API_KEY: " " },
  ]) {
    const source = resolveDataSource(env, input);
    assert.equal(source.kind, "json");
    assert.deepEqual(await source.loadBundles(), [input]);
  }
});

test("webChartDataSource: real CPT-coded WebChart data evaluates end-to-end via terminology reconciliation", async () => {
  const CPT_92557 = { system: "http://www.ama-assn.org/go/cpt", code: "92557" };
  const wc = webchartAudiogram(CPT_92557, "2026-04-23T00:00:00.000Z"); // recent, real CPT

  // Control — the SAME real-coded data through the plain JSON source (no reconciliation): the CQL
  // inline filter doesn't recognize CPT 92557, so the enrolled subject reads MISSING_DATA.
  const control = await evaluateSource(jsonBucketDataSource(structuredClone(wc)), "audiogram", { evaluationDate: EVAL });
  assert.equal(control.results[0]?.outcome?.outcome, "MISSING_DATA");

  // Treatment — through the WebChart source (normalize + reconcile via an injected fixture client),
  // CPT 92557 gains the synthetic audiogram-procedure coding → CQL matches → recent → COMPLIANT.
  const src = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient([wc]));
  const res = await evaluateSource(src, "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 1);
  assert.equal(res.succeeded, 1);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
});

test("webChartDataSource: a real LOINC lab Observation evaluates a Procedure-retrieved measure (Observation→Procedure synthesis)", async () => {
  // WebChart records HbA1c as an Observation (LOINC 4548-4); diabetes_hba1c's CQL retrieves [Procedure].
  // The adapter synthesizes a dated Procedure from the lab so the recency measure matches end-to-end.
  const wc = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "wc-emp-2" } },
      {
        resource: {
          resourceType: "Condition",
          subject: { reference: "Patient/wc-emp-2" },
          code: { coding: [{ system: "urn:workwell:vs:diabetes-program", code: "diabetes-enrolled" }] },
        },
      },
      {
        resource: {
          resourceType: "Observation",
          status: "final",
          subject: { reference: "Patient/wc-emp-2" },
          effectiveDateTime: "2026-05-01T00:00:00.000Z", // ~42 days before EVAL → within the 180d window
          code: { coding: [{ system: "http://loinc.org", code: "4548-4" }] },
          valueQuantity: { value: 6.5, unit: "%" },
        },
      },
    ],
  };
  // Control — un-reconciled: the [Procedure] retrieve never sees the LOINC Observation → MISSING_DATA.
  const control = await evaluateSource(jsonBucketDataSource(structuredClone(wc)), "diabetes_hba1c", { evaluationDate: EVAL });
  assert.equal(control.results[0]?.outcome?.outcome, "MISSING_DATA");
  // Treatment — the WebChart source synthesizes the Procedure → recency satisfied → COMPLIANT.
  const src = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient([wc]));
  const res = await evaluateSource(src, "diabetes_hba1c", { evaluationDate: EVAL });
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
});

test("webChartDataSource: a real CVX Heplisav-B series (multi-alternative measure) evaluates to COMPLIANT", async () => {
  // Hep B is a multi-alternative series measure — the CQL matches CVX 189 under the synthetic value set,
  // not the generic event code. A complete Heplisav-B series (2 doses, ≥28d apart) must reconcile and
  // evaluate COMPLIANT (Codex P2 regression guard).
  const dose = (when: string) => ({
    resource: {
      resourceType: "Immunization",
      status: "completed",
      patient: { reference: "Patient/wc-emp-3" },
      vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: "189" }] },
      occurrenceDateTime: when,
    },
  });
  const wc = {
    resourceType: "Bundle",
    type: "collection",
    entry: [
      { resource: { resourceType: "Patient", id: "wc-emp-3" } },
      {
        resource: {
          resourceType: "Condition",
          subject: { reference: "Patient/wc-emp-3" },
          code: { coding: [{ system: "urn:workwell:vs:immz-enrollment", code: "immz-enrolled" }] },
        },
      },
      dose("2026-01-01T00:00:00.000Z"),
      dose("2026-03-01T00:00:00.000Z"), // ~59 days later, ≥28d ACIP interval
    ],
  };
  // Control — un-reconciled real CVX 189 isn't in urn:workwell:vs:hepb-vaccines → series incomplete.
  const control = await evaluateSource(jsonBucketDataSource(structuredClone(wc)), "hepatitis_b_vaccination_series", { evaluationDate: EVAL });
  assert.notEqual(control.results[0]?.outcome?.outcome, "COMPLIANT");
  // Treatment — reconciled to {hepb-vaccines, 189} → Heplisav-B Complete → COMPLIANT.
  const src = webChartDataSource({ baseUrl: "x", apiKey: "k" }, fixtureWebChartClient([wc]));
  const res = await evaluateSource(src, "hepatitis_b_vaccination_series", { evaluationDate: EVAL });
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
});

test("evaluateSource: evaluates every bundle a JSON source yields", async () => {
  const src = jsonBucketDataSource([load("audiogram", "present_recent"), load("audiogram", "missing")]);
  const res = await evaluateSource(src, "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 2);
  assert.equal(res.succeeded, 2);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
  assert.equal(res.results[1]?.outcome?.outcome, "MISSING_DATA");
});
