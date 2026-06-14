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
import { handleCases } from "./cases.ts";

const dbPath = join(tmpdir(), `workwell-cases-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };

const get = (qs = "") => handleCases(new Request(`http://x/api/cases${qs}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const store = new SqliteCaseStore(db);
  const runId = crypto.randomUUID();
  // emp-006 = Omar Siddiq (Plant A): OVERDUE; emp-001 = Demo Author (HQ): MISSING_DATA; emp-008 EXCLUDED
  await store.upsertFromOutcome({ runId, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  await store.upsertFromOutcome({ runId, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: "2026-06-13", outcomeStatus: "MISSING_DATA" });
  await store.upsertFromOutcome({ runId, subjectId: "emp-008", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "EXCLUDED" });
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

test("paging via limit/offset", async () => {
  assert.equal(((await get("?status=open&limit=1&offset=0").then((r) => r!.json())) as unknown[]).length, 1);
  assert.equal(((await get("?status=open&limit=1&offset=2").then((r) => r!.json())) as unknown[]).length, 0);
});
