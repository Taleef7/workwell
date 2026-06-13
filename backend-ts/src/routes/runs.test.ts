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
  const rows = (await listed!.json()) as Array<{ outcomeStatus: string; employeeExternalId: string; caseId: string | null }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.outcomeStatus, "COMPLIANT"); // RunOutcomeRow shape
  assert.ok(rows[0]!.employeeExternalId, "row carries the employee external id");
  assert.equal(rows[0]!.caseId, null);

  // An evaluated run must not be re-handed to a worker (it left the QUEUED claim path).
  const claim = await post("/api/runs/claim");
  assert.equal(claim?.status, 204, "evaluated run is not re-claimed");

  // ---- read models (#107) -------------------------------------------------
  // List: the run appears with the RunListItem shape + computed counts.
  const list = await get("/api/runs");
  assert.equal(list?.status, 200);
  const rows2 = (await list!.json()) as Array<{ runId: string; measureName: string; totalEvaluated: number; compliantCount: number }>;
  const mine = rows2.find((r) => r.runId === run.id)!;
  assert.ok(mine, "created run is in the list");
  assert.equal(mine.measureName, "Audiogram");
  assert.equal(mine.totalEvaluated, 1);
  assert.equal(mine.compliantCount, 1);

  // Detail: RunSummary with passRate + outcomeCounts.
  const detail = await get(`/api/runs/${run.id}`);
  assert.equal(detail?.status, 200);
  const summary = (await detail!.json()) as { measureVersion: string; passRate: number; outcomeCounts: Array<{ status: string; count: number }>; totalCases: number };
  assert.equal(summary.measureVersion, "1.0.0");
  assert.equal(summary.passRate, 100); // the one subject is COMPLIANT
  assert.equal(summary.totalCases, 0);
  assert.deepEqual(summary.outcomeCounts, [{ status: "COMPLIANT", count: 1 }]);
});

test("POST /api/runs/manual maps scope errors (ALL_PROGRAMS → 501, missing measure → 400)", async () => {
  const unsupported = await post("/api/runs/manual", { scopeType: "ALL_PROGRAMS" });
  assert.equal(unsupported?.status, 501);
  const invalid = await post("/api/runs/manual", { scopeType: "MEASURE" });
  assert.equal(invalid?.status, 400);
});

test("GET /api/runs honors status/scopeType/site filters", async () => {
  const a = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "t", requestedScope: { site: "PLANT_A" } });
  const aRun = (await a!.json()) as { id: string };
  const b = await post("/api/runs", { scopeType: "ALL_PROGRAMS", triggeredBy: "t", requestedScope: {} });
  const bRun = (await b!.json()) as { id: string };

  const ids = async (qs: string) => ((await get(`/api/runs?${qs}`).then((r) => r!.json())) as Array<{ runId: string }>).map((x) => x.runId);

  assert.deepEqual(await ids("scopeType=ALL_PROGRAMS"), [bRun.id]);
  assert.deepEqual(await ids("site=PLANT_A"), [aRun.id]);
  assert.equal((await ids("site=PLANT_Z")).length, 0, "an unmatched site filters all out (not ignored)");
  // both are QUEUED (not evaluated), so a QUEUED status filter returns both
  assert.equal((await ids("status=QUEUED")).filter((id) => id === aRun.id || id === bRun.id).length, 2);
  assert.equal((await ids("status=FAILED")).length, 0);
});

test("GET /api/runs/:id/logs returns the run's log timeline; unknown run detail → 404", async () => {
  const created = await post("/api/runs", { scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test" });
  const run = (await created!.json()) as { id: string };

  const logs = await get(`/api/runs/${run.id}/logs`);
  assert.equal(logs?.status, 200);
  assert.ok(Array.isArray(await logs!.json()));

  const missing = await get(`/api/runs/${crypto.randomUUID()}`);
  assert.equal(missing?.status, 404);
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
