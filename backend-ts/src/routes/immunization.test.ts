import { test } from "node:test";
import assert from "node:assert/strict";
import { handleImmunizationForecast } from "./immunization.ts";

const env = {} as never;
const get = (qs: string) =>
  handleImmunizationForecast(new Request(`http://x/api/immunization/forecast${qs}`, { method: "GET" }), env);

test("returns an empty forecast that says there is no history (#628)", async () => {
  const res = await get("?subjectId=emp-006");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { subjectId: string; historyAvailable: boolean; series: unknown[] };
  assert.equal(body.subjectId, "emp-006");
  assert.equal(body.historyAvailable, false);
  assert.deepEqual(body.series, []);
});

test("400 on missing subjectId", async () => {
  const res = await get("");
  assert.equal(res!.status, 400);
});

test("400 on malformed asOf", async () => {
  const res = await get("?subjectId=emp-006&asOf=2026-13-99");
  assert.equal(res!.status, 400);
});

test("honors a valid asOf", async () => {
  const res = await get("?subjectId=emp-006&asOf=2030-01-01");
  assert.equal(res!.status, 200);
  const body = await res!.json() as { asOf: string };
  assert.equal(body.asOf, "2030-01-01");
});

test("falls through (null) on non-matching path or method", async () => {
  const res = await handleImmunizationForecast(new Request("http://x/api/other", { method: "GET" }), env);
  assert.equal(res, null);
  const post = await handleImmunizationForecast(new Request("http://x/api/immunization/forecast", { method: "POST" }), env);
  assert.equal(post, null);
});
