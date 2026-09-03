/**
 * Compliance roster route (E10.2) — seed a minimal DB, call handleCompliance, assert shape.
 *   node --import tsx --test src/routes/compliance.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { handleCompliance } from "./compliance.ts";
import { replaceLiveDirectory } from "../engine/ingress/webchart/live-directory.ts";

const dbPath = join(tmpdir(), `workwell-roster-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown; WORKWELL_WEBCHART_BASE_URL?: string; WORKWELL_WEBCHART_API_KEY?: string };
const get = (qs = "") => handleCompliance(new Request(`http://x/api/compliance/roster${qs}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  // A second measure's COMPLIANT cell proves the any-column status filter is broader than the
  // measure-scoped one (the Programs chip contract pins the scoped count to that column only).
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "mmr", triggeredBy: "test", requestedScope: { measureId: "mmr" },
    measurementPeriodStart: "2026-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  // emp-041 (Nurse / Clinic) is in the seeded "Clinical Staff" cohort, whose rule-set includes mmr —
  // so the applicability overlay leaves the real COMPLIANT cell visible (an out-of-cohort subject would
  // read NOT_APPLICABLE; see the segments tests).
  await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-041", measureId: "mmr", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [{ define: "Dose Count", result: 2 }] },
  });
  // The roster only reads terminal (COMPLETED/PARTIAL_FAILURE) population runs — finalize so the cell shows.
  await runStore.finalizeRun(run.id, "COMPLETED");
  const fluRun = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "flu_vaccine", triggeredBy: "test", requestedScope: { measureId: "flu_vaccine" },
    measurementPeriodStart: "2026-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  await outcomes.recordOutcome({
    runId: fluRun.id, subjectId: "emp-042", measureId: "flu_vaccine", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [] },
  });
  await runStore.finalizeRun(fluRun.id, "COMPLETED");
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("measureId scopes the status filter to that measure's column", async () => {
  const parse = async (qs: string) => {
    const res = (await get(qs))!;
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: Array<{ cells: Record<string, { status: string }> }> };
    return { total: Number(res.headers.get("X-Total-Count")), statuses: body.rows.map((r) => r.cells["mmr"]?.status) };
  };

  const unscoped = await parse("?status=COMPLIANT&pageSize=200");
  assert.ok(unscoped.total >= 2, "fixture needs a compliant cell outside mmr to make the scope meaningful");

  const scoped = await parse("?status=COMPLIANT&measureId=mmr&pageSize=200");
  assert.equal(scoped.total, 1);
  assert.equal(scoped.statuses.filter((s) => s === "COMPLIANT").length, 1);
  assert.ok(scoped.statuses.every((s) => s === "COMPLIANT" || s === undefined));

  // Without measureId the any-column view may include other compliant cells; with it, the count
  // equals that column's cell count (the Programs chip contract).
  assert.ok(scoped.total <= unscoped.total);
});

test("measureId outside the defaulted panel resolves the roster to the panel containing that measure", async () => {
  const res = (await get("?measureId=cms125&status=COMPLIANT&pageSize=200"))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    panel: string;
    rows: Array<{ cells: Record<string, { status: string }> }>;
  };
  // The measure lives in the wellness panel, not the immunizations default — the roster must
  // resolve to wellness so the drill-down can return its column instead of silently zero rows.
  assert.equal(body.panel, "wellness");
  const compliant = body.rows.filter((r) => r.cells["cms125"]?.status === "COMPLIANT");
  assert.equal(body.rows.length, compliant.length);
});

test("non-roster path returns null (not this route)", async () => {
  assert.equal(await handleCompliance(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("Fable L24: an unknown panel is a 400, not a silent default to immunizations", async () => {
  const res = await get("?panel=bogus");
  assert.equal(res?.status, 400);
  // a valid panel still works; an omitted panel defaults
  assert.equal((await get("?panel=osha"))?.status, 200);
  assert.equal((await get(""))?.status, 200);
});

test("POST is not handled by this route", async () => {
  assert.equal(await handleCompliance(new Request("http://x/api/compliance/roster", { method: "POST" }), env as never), null);
});

test("GET /api/compliance/roster → columns + rows + X-Total-Count; mmr cell carries the dose method", async () => {
  const res = (await get("?panel=immunizations&pageSize=200"))!;
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("X-Total-Count"));
  const body = (await res.json()) as {
    panel: string;
    columns: Array<{ measureId: string; complianceClass: string }>;
    rows: Array<{ subject: { externalId: string }; cells: Record<string, { status: string; method: string }> }>;
  };
  assert.equal(body.panel, "immunizations");
  assert.ok(body.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = body.rows.find((r) => r.subject.externalId === "emp-041")!;
  const mmrCell = row.cells["mmr"]!;
  assert.equal(mmrCell.status, "COMPLIANT");
  assert.equal(mmrCell.method, "2 valid dose(s)");
});

test("persisted wc rows are reversible: hidden seam-off and rehydrated only when configured", async () => {
  const runStore = new SqliteRunStore(env.DB as never);
  const outcomes = new SqliteOutcomeStore(env.DB as never);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "mmr", triggeredBy: "test", status: "COMPLETED",
    requestedScope: { measureId: "mmr" }, measurementPeriodStart: "2026-07-17T00:00:00.000Z",
    measurementPeriodEnd: "2026-07-17T23:59:59.999Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "wc|roster-restart", measureId: "mmr", status: "COMPLIANT", evidence: {} });
  replaceLiveDirectory([{ resourceType: "Bundle", entry: [{ resource: { resourceType: "Patient", id: "roster-restart", name: [{ text: "Cached Live Name" }] } }] }]);
  try {
    const off = (await get("?panel=immunizations&pageSize=300").then((r) => r!.json())) as {
      rows: Array<{ subject: { externalId: string } }>;
    };
    assert.ok(!off.rows.some((row) => row.subject.externalId.startsWith("wc|")));

    env.WORKWELL_WEBCHART_BASE_URL = "http://webchart.test";
    env.WORKWELL_WEBCHART_API_KEY = "fixture-key";
    const on = (await get("?panel=immunizations&pageSize=300").then((r) => r!.json())) as {
      rows: Array<{ subject: { externalId: string; name: string } }>;
    };
    assert.equal(on.rows.find((row) => row.subject.externalId === "wc|roster-restart")?.subject.name, "Cached Live Name");
  } finally {
    delete env.WORKWELL_WEBCHART_BASE_URL;
    delete env.WORKWELL_WEBCHART_API_KEY;
    replaceLiveDirectory([]);
  }
});
