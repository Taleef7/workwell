/**
 * Programs route test (#107 programs module): seed runs + outcomes + cases via the
 * stores, then assert GET /api/programs/overview computes per-measure KPIs (latest run
 * wins, complianceRate, open case count) and honors the site filter; /sites lists sites.
 *   node --import tsx --test src/routes/programs.test.ts
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
import { handlePrograms } from "./programs.ts";

const dbPath = join(tmpdir(), `workwell-programs-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let latestRunId: string;

const get = (qs = "") => handlePrograms(new Request(`http://x/api/programs${qs}`, { method: "GET" }), env as never);

interface Summary {
  measureId: string;
  totalEvaluated: number;
  compliant: number;
  overdue: number;
  complianceRate: number;
  openCaseCount: number;
  latestRunId: string | null;
}
const audiogramOf = async (qs = "") =>
  ((await get(`/overview${qs}`).then((r) => r!.json())) as Summary[]).find((p) => p.measureId === "audiogram")!;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const cases = new SqliteCaseStore(db);
  const mkRun = () =>
    runStore.createRun({
      scopeType: "MEASURE",
      scopeId: "audiogram",
      triggeredBy: "test",
      requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-06-13T00:00:00.000Z",
      measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
    });

  // An older run (should be superseded by the newer one in the overview).
  const older = await mkRun();
  await outcomes.recordOutcome({ runId: older.id, subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await new Promise((r) => setTimeout(r, 8)); // ensure a strictly later started_at

  // The latest run: emp-006 (Plant A) OVERDUE + emp-001 (HQ) COMPLIANT → 2 evaluated, 50% compliant.
  const latest = await mkRun();
  latestRunId = latest.id;
  await outcomes.recordOutcome({ runId: latest.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: latest.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  // an open case for the overdue subject → openCaseCount 1
  await cases.upsertFromOutcome({ runId: latest.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("GET /api/programs/overview returns one row per Active measure (the runnable set)", async () => {
  const rows = (await get("/overview").then((r) => r!.json())) as Summary[];
  assert.equal(rows.length, 10, "10 Active/runnable measures");
});

test("overview aggregates the LATEST run's outcomes + complianceRate + open case count", async () => {
  const a = await audiogramOf();
  assert.equal(a.latestRunId, latestRunId, "newest run wins");
  assert.equal(a.totalEvaluated, 2);
  assert.equal(a.compliant, 1);
  assert.equal(a.overdue, 1);
  assert.equal(a.complianceRate, 50);
  assert.equal(a.openCaseCount, 1);
});

test("a measure with no outcomes reports zeros + null latest run", async () => {
  const rows = (await get("/overview").then((r) => r!.json())) as Summary[];
  const empty = rows.find((p) => p.measureId === "flu_vaccine")!;
  assert.equal(empty.totalEvaluated, 0);
  assert.equal(empty.complianceRate, 0);
  assert.equal(empty.latestRunId, null);
});

test("site filter scopes the outcomes (Plant A keeps only emp-006 → overdue, 0% compliant)", async () => {
  const a = await audiogramOf("?site=Plant%20A");
  assert.equal(a.totalEvaluated, 1, "only the Plant A subject");
  assert.equal(a.overdue, 1);
  assert.equal(a.compliant, 0);
  assert.equal(a.complianceRate, 0);
  assert.equal(a.openCaseCount, 1, "the open case is Plant A");
});

test("GET /api/programs is an alias of /overview", async () => {
  const base = (await get("").then((r) => r!.json())) as Summary[];
  assert.equal(base.length, 10);
});

test("GET /api/programs/sites lists distinct employee sites", async () => {
  const sites = (await get("/sites").then((r) => r!.json())) as string[];
  assert.ok(sites.includes("Plant A") && sites.includes("HQ"));
  assert.deepEqual([...sites].sort(), sites, "ascending");
});
