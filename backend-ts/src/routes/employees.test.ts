/**
 * Employees route test (#107): seed a run + outcomes + a case for an employee, then assert
 * the profile (outcomes/open-cases/audit timeline) and search behave like the Java service.
 *   node --import tsx --test src/routes/employees.test.ts
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
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { handleEmployees } from "./employees.ts";

const dbPath = join(tmpdir(), `workwell-employees-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let caseId: string;

const get = (path: string) => handleEmployees(new Request(`http://x${path}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  const outcomes = new SqliteOutcomeStore(db);
  await outcomes.recordOutcome({
    runId: run.id,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: {
      expressionResults: [
        { define: "Most Recent Audiogram Date", result: "2025-04-19T00:00:00.000Z" },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    },
  });
  const store = new SqliteCaseStore(db);
  const c = await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  caseId = c!.id;
  // an audit event tied to the case so the profile timeline has an entry
  await new SqliteCaseEventStore(db).appendAudit({
    eventType: "CASE_CREATED",
    entityType: "case",
    entityId: caseId,
    actor: "cm@workwell.dev",
    refRunId: run.id,
    refCaseId: caseId,
    refMeasureVersionId: null,
    payload: {},
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/employees/:id/profile returns identity + outcomes + open cases + audit timeline", async () => {
  const res = await get("/api/employees/emp-006/profile");
  assert.equal(res?.status, 200);
  const p = (await res!.json()) as {
    externalId: string;
    name: string;
    site: string;
    active: boolean;
    measureOutcomes: Array<{ measureName: string; outcomeStatus: string; daysSinceLastExam: number | null; daysUntilDue: number | null; openCaseId: string | null }>;
    openCases: Array<{ caseId: string; outcomeStatus: string }>;
    recentAuditEvents: Array<{ eventType: string; summary: string }>;
  };
  assert.equal(p.externalId, "emp-006");
  assert.equal(p.name, "Omar Siddiq");
  assert.equal(p.active, true);
  // employee-profile uses the engine registry name (consistent with cases/runs), i.e. "Audiogram".
  const audiogram = p.measureOutcomes.find((o) => o.outcomeStatus === "OVERDUE")!;
  assert.equal(audiogram.measureName, "Audiogram");
  assert.equal(audiogram.outcomeStatus, "OVERDUE");
  // ACTUAL recency, not the overdue amount: exam was 420 days ago against a 365-day window.
  assert.equal(audiogram.daysSinceLastExam, 420, "actual days since last exam");
  assert.equal(audiogram.daysUntilDue, 365 - 420, "window − recency (negative ⇒ overdue)");
  assert.equal(audiogram.openCaseId, caseId, "outcome links its open case");
  assert.ok(p.openCases.some((c) => c.caseId === caseId));
  assert.ok(p.recentAuditEvents.some((e) => e.eventType === "CASE_CREATED" && /opened a case/.test(e.summary)));
});

test("GET /api/employees/:id/profile → 404 for an unknown employee", async () => {
  assert.equal((await get("/api/employees/emp-999/profile"))?.status, 404);
});

test("GET /api/employees/search matches name/role; honors min-length + latest outcome", async () => {
  const byName = (await get("/api/employees/search?q=omar").then((r) => r!.json())) as Array<{ externalId: string; latestOutcome: string | null }>;
  assert.ok(byName.some((e) => e.externalId === "emp-006"));
  assert.equal(byName.find((e) => e.externalId === "emp-006")!.latestOutcome, "OVERDUE");

  const byRole = (await get("/api/employees/search?q=welder").then((r) => r!.json())) as Array<{ role: string }>;
  assert.ok(byRole.length > 0 && byRole.every((e) => /welder/i.test(e.role)));

  // min 2 chars
  assert.deepEqual(await get("/api/employees/search?q=o").then((r) => r!.json()), []);
});

test("GET /api/employees/search respects limit (1..50)", async () => {
  const one = (await get("/api/employees/search?q=e&limit=1").then((r) => r!.json())) as unknown[];
  // 'e' is < 2 chars → empty; use a 2-char needle that matches many
  assert.deepEqual(one, []);
  const capped = (await get("/api/employees/search?q=em&limit=2").then((r) => r!.json())) as unknown[];
  assert.ok(capped.length <= 2);
});
