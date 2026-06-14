/**
 * Cases worklist route test (#107): seed cases via the store, then assert
 * GET /api/cases returns CaseSummary[] honoring status/site/search + paging.
 *   node --import tsx --test src/routes/cases.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { handleCases } from "./cases.ts";

const dbPath = join(tmpdir(), `workwell-cases-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let omarCaseId: string;

const get = (qs = "") => handleCases(new Request(`http://x/api/cases${qs}`, { method: "GET" }), env as never);
const getPath = (path: string) => handleCases(new Request(`http://x${path}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const store = new SqliteCaseStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  // a real run row so the outcome FK is satisfied
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  const runId = run.id;
  // emp-006 = Omar Siddiq (Plant A): OVERDUE; emp-001 = Demo Author (HQ): MISSING_DATA; emp-008 EXCLUDED
  const omar = await store.upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  omarCaseId = omar!.id;
  await store.upsertFromOutcome({ runId, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: "2026-06-13", outcomeStatus: "MISSING_DATA" });
  await store.upsertFromOutcome({ runId, subjectId: "emp-008", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "EXCLUDED" });
  // evidence for Omar's case (drives the detail's why_flagged)
  await outcomes.recordOutcome({
    runId,
    subjectId: "emp-006",
    measureId: "audiogram",
    status: "OVERDUE",
    evidence: {
      expressionResults: [
        { define: "Has Active Waiver", result: false },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    },
  });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/cases returns CaseSummary rows resolved to employee + measure", async () => {
  const res = await get("?status=open");
  assert.equal(res?.status, 200);
  const rows = (await res!.json()) as Array<{ caseId: string; employeeName: string; measureName: string; priority: string; site: string }>;
  assert.equal(rows.length, 2, "two OPEN cases (EXCLUDED is filtered out)");
  const omar = rows.find((r) => r.employeeName === "Omar Siddiq")!;
  assert.equal(omar.measureName, "Audiogram");
  assert.equal(omar.priority, "HIGH"); // OVERDUE
  assert.equal(omar.site, "Plant A");
});

test("status=excluded selects EXCLUDED; site and search filters apply", async () => {
  assert.equal(((await get("?status=excluded").then((r) => r!.json())) as unknown[]).length, 1);
  const plantA = (await get("?status=open&site=Plant%20A").then((r) => r!.json())) as Array<{ employeeName: string }>;
  assert.deepEqual(plantA.map((r) => r.employeeName), ["Omar Siddiq"]);
  const search = (await get("?status=open&search=hazwoper").then((r) => r!.json())) as Array<{ measureName: string }>;
  assert.deepEqual(search.map((r) => r.measureName), ["HAZWOPER Surveillance"]);
});

test("missing status defaults to OPEN (not all); status=all is the unfiltered view", async () => {
  const def = (await get().then((r) => r!.json())) as Array<{ status: string }>;
  assert.equal(def.length, 2, "default worklist shows only OPEN cases");
  assert.ok(def.every((c) => c.status === "OPEN"));
  const all = (await get("?status=all").then((r) => r!.json())) as unknown[];
  assert.equal(all.length, 3, "status=all includes the EXCLUDED case");
});

test("assignee=unassigned matches the NULL-assignee cases", async () => {
  assert.equal(((await get("?status=open&assignee=unassigned").then((r) => r!.json())) as unknown[]).length, 2);
  assert.equal(((await get("?status=open&assignee=someone@workwell.dev").then((r) => r!.json())) as unknown[]).length, 0);
});

test("from/to filter by case creation day (inclusive)", async () => {
  assert.equal(((await get("?status=open&from=2999-01-01").then((r) => r!.json())) as unknown[]).length, 0, "future from → none");
  assert.equal(((await get("?status=open&to=2000-01-01").then((r) => r!.json())) as unknown[]).length, 0, "past to → none");
  assert.equal(((await get("?status=open&from=2000-01-01&to=2999-12-31").then((r) => r!.json())) as unknown[]).length, 2, "wide range → all open");
});

test("GET /api/cases/:id returns CaseDetail with evidence + derived why_flagged", async () => {
  const res = await getPath(`/api/cases/${omarCaseId}`);
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as {
    caseId: string;
    employeeName: string;
    measureName: string;
    outcomeSummary: string;
    evidenceJson: { why_flagged: { days_overdue: number; waiver_status: string; last_exam_date: string }; expressionResults: unknown[] };
    timeline: unknown[];
  };
  assert.equal(d.caseId, omarCaseId);
  assert.equal(d.employeeName, "Omar Siddiq");
  assert.equal(d.measureName, "Audiogram");
  assert.match(d.outcomeSummary, /overdue/i);
  // why_flagged derived from the CQL define results (420 days, window 365 → 55 overdue)
  assert.equal(d.evidenceJson.why_flagged.days_overdue, 55);
  assert.equal(d.evidenceJson.why_flagged.waiver_status, "none");
  assert.ok(d.evidenceJson.expressionResults.length >= 1, "raw expressionResults preserved");
  assert.deepEqual(d.timeline, [], "timeline empty until the audit module is ported");
});

test("GET /api/cases/:id for an unknown case → 404", async () => {
  const res = await getPath(`/api/cases/${crypto.randomUUID()}`);
  assert.equal(res?.status, 404);
});

test("paging via limit/offset", async () => {
  assert.equal(((await get("?status=open&limit=1&offset=0").then((r) => r!.json())) as unknown[]).length, 1);
  assert.equal(((await get("?status=open&limit=1&offset=2").then((r) => r!.json())) as unknown[]).length, 0);
});
