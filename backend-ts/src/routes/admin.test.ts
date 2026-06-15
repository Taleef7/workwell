/**
 * Admin route test (#108): the dashboard read surface + toggles. Seeds an audit event so the
 * viewer can resolve scope + employeeId. node --import tsx --test src/routes/admin.test.ts
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
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleAdmin } from "./admin.ts";

const dbPath = join(tmpdir(), `workwell-admin-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };

const get = (path: string) => handleAdmin(new Request(`http://x${path}`, { method: "GET" }), env as never);
const post = (path: string) => handleAdmin(new Request(`http://x${path}`, { method: "POST" }), env as never);
const body = async (path: string) => get(path).then((r) => r!.json());

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: {}, measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  const caseRec = await new SqliteCaseStore(db).upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  await new SqliteCaseEventStore(db).appendAudit({
    eventType: "CASE_ESCALATED", entityType: "case", entityId: caseRec!.id, actor: "cm@workwell.dev",
    refRunId: run.id, refCaseId: caseRec!.id, refMeasureVersionId: "audiogram-v1.0", payload: { priority: "HIGH" },
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("integrations: list + manual sync; unknown → 404", async () => {
  const list = (await body("/api/admin/integrations")) as Array<{ integration: string; displayName: string; status: string }>;
  assert.deepEqual(list.map((i) => i.integration).sort(), ["ai", "fhir", "hris", "mcp"]);
  assert.equal(list.find((i) => i.integration === "hris")!.status, "simulated");
  const synced = await post("/api/admin/integrations/fhir/sync");
  assert.equal(synced?.status, 200);
  assert.ok(((await synced!.json()) as { lastSyncAt: string }).lastSyncAt, "sync stamps lastSyncAt");
  // The sync must PERSIST so the page's reload reflects it (not revert to null).
  const reloaded = (await body("/api/admin/integrations")) as Array<{ integration: string; lastSyncAt: string | null }>;
  assert.ok(reloaded.find((i) => i.integration === "fhir")!.lastSyncAt, "lastSyncAt persisted across the reload");
  assert.equal((await post("/api/admin/integrations/nope/sync"))?.status, 404);
});

test("scheduler: status + enable toggle", async () => {
  assert.equal(((await body("/api/admin/scheduler")) as { enabled: boolean }).enabled, false);
  const on = await post("/api/admin/scheduler?enabled=true");
  assert.equal(((await on!.json()) as { enabled: boolean; cron: string }).enabled, true);
  assert.equal(((await body("/api/admin/scheduler")) as { enabled: boolean }).enabled, true, "toggle persists in-process");
  await post("/api/admin/scheduler?enabled=false");
});

test("audit-events viewer: access/mutation scope + employeeId resolved from the case", async () => {
  const all = (await body("/api/admin/audit-events?scope=all&limit=50")) as Array<{ eventType: string; scope: string; employeeExternalId: string | null; actor: string }>;
  const row = all.find((r) => r.eventType === "CASE_ESCALATED")!;
  // Scope is access (CASE_VIEWED) vs mutation (everything else) — the Java/admin contract.
  assert.equal(row.scope, "mutation");
  assert.equal(row.employeeExternalId, "emp-006", "resolved via ref_case_id → case employee");
  assert.equal(row.actor, "cm@workwell.dev");
  // The "mutations" tab (frontend default-adjacent) shows the escalation; "access" (CASE_VIEWED only) is empty here.
  const mutations = (await body("/api/admin/audit-events?scope=mutations")) as Array<{ scope: string; eventType: string }>;
  assert.ok(mutations.every((r) => r.scope === "mutation"));
  assert.ok(mutations.some((r) => r.eventType === "CASE_ESCALATED"));
  assert.deepEqual(await body("/api/admin/audit-events?scope=access"), [], "no CASE_VIEWED events → access tab empty");
});

test("static reads: terminology + data mappings + outreach templates + preview", async () => {
  const tm = (await body("/api/admin/terminology-mappings")) as Array<{ mappingStatus: string }>;
  assert.equal(tm.length, 5);
  assert.equal(tm.filter((m) => m.mappingStatus === "APPROVED").length, 3);
  assert.ok(((await body("/api/admin/data-mappings")) as unknown[]).length >= 3);
  const templates = (await body("/api/admin/outreach-templates")) as Array<{ id: string; subject: string }>;
  assert.equal(templates[0]!.id, "default-template");
  const preview = (await body("/api/admin/outreach-templates/default-template/preview")) as { subject: string };
  assert.match(preview.subject, /Outreach Reminder/);
  assert.equal((await get("/api/admin/outreach-templates/nope/preview"))?.status, 404);
});

test("deferred subsystems return their empty shape (dashboard renders)", async () => {
  assert.deepEqual(await body("/api/admin/waivers?status=active"), []);
  assert.deepEqual(await body("/api/admin/outreach/delivery-log?limit=20"), []);
});

test("GET /api/admin/data-mappings returns the full V012 seed; POST /validate stamps + returns it", async () => {
  const list = (await body("/api/admin/data-mappings")) as Array<{ canonicalElement: string; sourceId: string }>;
  assert.equal(list.length, 14, "15-row V012 seed minus none; 14 distinct canonicals");
  assert.ok(list.some((m) => m.canonicalElement === "procedure.audiogram" && m.sourceId === "fhir"));
  assert.ok(list.some((m) => m.canonicalElement === "employee.role" && m.sourceId === "hris"));

  const res = await handleAdmin(new Request("http://x/api/admin/data-mappings/validate", { method: "POST" }), env as never);
  assert.equal(res?.status, 200);
  const validated = (await res!.json()) as Array<{ mappingStatus: string; lastValidatedAt: string | null }>;
  assert.equal(validated.length, 14);
  assert.ok(validated.every((m) => m.mappingStatus === "MAPPED"), "no degraded source → all MAPPED");
  assert.ok(validated.every((m) => m.lastValidatedAt != null), "validate stamps lastValidatedAt");
});
