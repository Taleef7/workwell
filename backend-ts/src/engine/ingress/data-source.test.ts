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

const SYNTH = fileURLToPath(new URL("../../../spike/synthetic", import.meta.url));
const load = (m: string, s: string): unknown => JSON.parse(readFileSync(path.join(SYNTH, m, `${s}.json`), "utf8"));
const EVAL = "2026-06-12";

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

test("webChartDataSource: inert stub rejects with a clear PR-2 message", async () => {
  await assert.rejects(() => webChartDataSource({ baseUrl: "x", apiKey: "k" }).loadBundles(), /not yet wired \(E12 PR-2\)/);
});

test("evaluateSource: evaluates every bundle a JSON source yields", async () => {
  const src = jsonBucketDataSource([load("audiogram", "present_recent"), load("audiogram", "missing")]);
  const res = await evaluateSource(src, "audiogram", { evaluationDate: EVAL });
  assert.equal(res.total, 2);
  assert.equal(res.succeeded, 2);
  assert.equal(res.results[0]?.outcome?.outcome, "COMPLIANT");
  assert.equal(res.results[1]?.outcome?.outcome, "MISSING_DATA");
});
