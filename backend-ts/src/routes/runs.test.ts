/**
 * Integration test for the run→evaluate→persist slice (#104/#106): drives the
 * actual `handleRuns` route over a real @mieweb/cloud-local SQLite CloudDatabase —
 * create a run, evaluate a subject through the JVM-free CQL engine, persist + list
 * the outcome. No JVM, no server.
 *   node --import tsx --test src/routes/runs.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { handleRuns } from "./runs.ts";

const dbPath = join(tmpdir(), `workwell-runs-route-${crypto.randomUUID()}.sqlite`);
const bundle = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../spike/synthetic/audiogram/present_recent.json", import.meta.url)), "utf8"),
);
let env: { DB: unknown };

const post = (path: string, body?: unknown) =>
  handleRuns(new Request(`http://x${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined }), env as never);
const get = (path: string) => handleRuns(new Request(`http://x${path}`, { method: "GET" }), env as never);

before(async () => {
  env = { DB: await createSqliteD1(dbPath) };
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("create run → evaluate subject via engine → persist + list outcome", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  assert.equal(created?.status, 201);
  const run = (await created!.json()) as { id: string };
  assert.ok(run.id);

  const evaluated = await post(`/api/runs/${run.id}/evaluate`, {
    measureId: "audiogram",
    patientBundle: bundle,
    evaluationDate: "2026-06-12",
  });
  assert.equal(evaluated?.status, 201);
  const outcome = (await evaluated!.json()) as { id: string; runId: string; status: string; measureId: string };
  assert.equal(outcome.runId, run.id);
  assert.equal(outcome.measureId, "audiogram");
  assert.equal(outcome.status, "COMPLIANT");

  const listed = await get(`/api/runs/${run.id}/outcomes`);
  assert.equal(listed?.status, 200);
  const rows = (await listed!.json()) as Array<{ status: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "COMPLIANT");

  // An evaluated run must not be re-handed to a worker (it left the QUEUED claim path).
  const claim = await post("/api/runs/claim");
  assert.equal(claim?.status, 204, "evaluated run is not re-claimed");
});

test("evaluate against an unknown run → 404", async () => {
  const res = await post(`/api/runs/${crypto.randomUUID()}/evaluate`, { measureId: "audiogram", patientBundle: bundle });
  assert.equal(res?.status, 404);
});

test("evaluate with a missing body → 400", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE" });
  const run = (await created!.json()) as { id: string };
  const res = await post(`/api/runs/${run.id}/evaluate`, { measureId: "audiogram" });
  assert.equal(res?.status, 400);
});
