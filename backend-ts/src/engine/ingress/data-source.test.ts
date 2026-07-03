/**
 * E12 PR-1 (#184): the PatientDataSource port — JSON-bucket adapter (default), inert WebChart stub
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

test("webChartDataSource: constructs the (provisional) HTTP client by default without throwing", () => {
  assert.equal(webChartDataSource({ baseUrl: "x", apiKey: "k" }).kind, "webchart");
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

test("evaluateSource: evaluates every bundle a JSON source yields", async () => {
  const src = jsonBucketDataSource([load("audiogram", "present_recent"), load("audiogram", "missing")]);
  const res = await evaluateSource(src, "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 2);
  assert.equal(res.succeeded, 2);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
  assert.equal(res.results[1]?.outcome?.outcome, "MISSING_DATA");
});
