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
  const templates = (await body("/api/admin/outreach-templates")) as Array<{ id: string; subject: string; type: string }>;
  assert.equal(templates.length, 5, "V007 + V008 demo templates seeded");
  assert.ok(templates.some((t) => t.id === "11111111-0000-0000-0000-000000000001"));
  assert.ok(templates.some((t) => t.id === "11111111-0000-0000-0000-000000000005"), "V008 Missing Data Follow-Up seeded");
  const preview = (await body("/api/admin/outreach-templates/11111111-0000-0000-0000-000000000001/preview")) as { subject: string };
  assert.match(preview.subject, /Overdue Audiogram/);
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

const adminPost = (path: string, b: unknown) =>
  handleAdmin(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(b) }), env as never, "admin@workwell.dev");
const adminPut = (path: string, b: unknown) =>
  handleAdmin(new Request(`http://x${path}`, { method: "PUT", body: JSON.stringify(b) }), env as never, "admin@workwell.dev");

test("outreach-templates: create → appears in list (created_by actor); update edits + can deactivate", async () => {
  const created = await adminPost("/api/admin/outreach-templates", { name: "New Tpl", subject: "Sub {measure_name}", bodyText: "Hi {employee_name}", type: "OUTREACH" });
  assert.equal(created?.status, 201);
  const rec = (await created!.json()) as { id: string; createdBy: string; active: boolean };
  assert.equal(rec.createdBy, "admin@workwell.dev");
  assert.equal(rec.active, true);

  const list = (await body("/api/admin/outreach-templates")) as Array<{ id: string }>;
  assert.ok(list.some((t) => t.id === rec.id), "new template listed");

  // preview renders the placeholders.
  const preview = (await body(`/api/admin/outreach-templates/${rec.id}/preview`)) as { subject: string; bodyText: string };
  assert.match(preview.subject, /Annual Audiogram/);
  assert.match(preview.bodyText, /Jane Smith/);

  // update deactivates → drops off the active list.
  const upd = await adminPut(`/api/admin/outreach-templates/${rec.id}`, { name: "New Tpl v2", subject: "S", bodyText: "B", type: "ESCALATION", active: false });
  assert.equal(upd?.status, 200);
  assert.equal(((await upd!.json()) as { name: string; active: boolean }).name, "New Tpl v2");
  const after = (await body("/api/admin/outreach-templates")) as Array<{ id: string }>;
  assert.ok(!after.some((t) => t.id === rec.id), "deactivated template no longer active");

  // every state change writes an audit_event (CLAUDE.md/AGENTS.md): create + update appear in the ledger.
  const audits = (await body("/api/admin/audit-events?scope=all&limit=50")) as Array<{ eventType: string; actor: string }>;
  assert.ok(audits.some((a) => a.eventType === "OUTREACH_TEMPLATE_CREATED" && a.actor === "admin@workwell.dev"));
  assert.ok(audits.some((a) => a.eventType === "OUTREACH_TEMPLATE_UPDATED" && a.actor === "admin@workwell.dev"));
});

test("outreach-templates: create with missing fields → 400; bad type → 400; update unknown → 404", async () => {
  assert.equal((await adminPost("/api/admin/outreach-templates", { name: "x" }))?.status, 400);
  assert.equal((await adminPost("/api/admin/outreach-templates", { name: "n", subject: "s", bodyText: "b", type: "WEIRD" }))?.status, 400);
  assert.equal((await adminPut("/api/admin/outreach-templates/nope", { name: "n", subject: "s", bodyText: "b", type: "OUTREACH", active: true }))?.status, 404);
});

test("waivers: grant resolves employee + measure display fields, then lists newest/active-first", async () => {
  const granted = await adminPost("/api/admin/waivers", {
    employeeExternalId: "emp-006",
    measureId: "audiogram",
    exclusionReason: "Documented medical contraindication",
    expiresAt: "2027-03-01T00:00:00.000Z",
    notes: "Reviewed by OH",
    active: true,
  });
  assert.equal(granted?.status, 201);
  const rec = (await granted!.json()) as { waiverId: string; employeeName: string; site: string; measureName: string; measureVersion: string; grantedBy: string; expired: boolean };
  assert.equal(rec.employeeName, "Omar Siddiq", "resolved from the synthetic directory");
  assert.equal(rec.site, "Plant A");
  assert.equal(rec.measureName, "Annual Audiogram Completed", "resolved from the measure store");
  assert.ok(rec.measureVersion, "measure version resolved");
  assert.equal(rec.grantedBy, "admin@workwell.dev");
  assert.equal(rec.expired, false);

  const list = (await body("/api/admin/waivers?")) as Array<{ waiverId: string; measureId: string }>;
  assert.ok(list.some((w) => w.waiverId === rec.waiverId));

  // filters: measureId + active + site
  assert.ok(((await body("/api/admin/waivers?measureId=audiogram")) as unknown[]).length >= 1);
  assert.deepEqual(await body("/api/admin/waivers?measureId=hazwoper"), [], "no waiver for hazwoper");
  assert.ok(((await body("/api/admin/waivers?active=true")) as unknown[]).length >= 1);
  assert.ok(((await body("/api/admin/waivers?site=Plant A")) as unknown[]).length >= 1);
  assert.deepEqual(await body("/api/admin/waivers?site=Nowhere"), [], "site filter excludes");

  // a WAIVER_GRANTED audit was written.
  const audits = (await body("/api/admin/audit-events?scope=all&limit=50")) as Array<{ eventType: string; actor: string }>;
  assert.ok(audits.some((a) => a.eventType === "WAIVER_GRANTED" && a.actor === "admin@workwell.dev"));
});

test("waivers: grant validation — unknown employee, unknown measure, missing reason, bad date → 400", async () => {
  assert.equal((await adminPost("/api/admin/waivers", { employeeExternalId: "ghost", measureId: "audiogram", exclusionReason: "x" }))?.status, 400);
  assert.equal((await adminPost("/api/admin/waivers", { employeeExternalId: "emp-006", measureId: "nope", exclusionReason: "x" }))?.status, 400);
  assert.equal((await adminPost("/api/admin/waivers", { employeeExternalId: "emp-006", measureId: "audiogram", exclusionReason: " " }))?.status, 400);
  assert.equal((await adminPost("/api/admin/waivers", { employeeExternalId: "emp-006", measureId: "audiogram", exclusionReason: "x", expiresAt: "whenever" }))?.status, 400);
});

test("demo-reset: clears volatile data (non-prod); 403 under prod profile", async () => {
  // a case + audit event exist from `before`; demo-reset clears them.
  assert.ok(((await body("/api/admin/audit-events?scope=all&limit=50")) as unknown[]).length > 0);
  const reset = await adminPost("/api/admin/demo-reset", {});
  assert.equal(reset?.status, 200);
  assert.equal(((await reset!.json()) as { status: string }).status, "reset_complete");
  assert.deepEqual(await body("/api/admin/audit-events?scope=all&limit=50"), [], "audit ledger cleared");

  // prod profile → 403, no reset performed.
  const prodEnv = { DB: (env as { DB: unknown }).DB, SPRING_PROFILES_ACTIVE: "prod" };
  const denied = await handleAdmin(new Request("http://x/api/admin/demo-reset", { method: "POST", body: "{}" }), prodEnv as never, "admin@workwell.dev");
  assert.equal(denied?.status, 403);
});
