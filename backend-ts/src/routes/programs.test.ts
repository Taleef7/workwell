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

test("GET /api/programs/:id/trend returns per-run points newest-first (compliance over runs)", async () => {
  const trend = (await get("/audiogram/trend").then((r) => r!.json())) as Array<{
    runId: string;
    complianceRate: number;
    totalEvaluated: number;
    overdue: number;
  }>;
  assert.equal(trend.length, 2, "both audiogram runs");
  assert.equal(trend[0]!.runId, latestRunId, "newest run first");
  assert.equal(trend[0]!.totalEvaluated, 2);
  assert.equal(trend[0]!.complianceRate, 50);
  assert.equal(trend[1]!.complianceRate, 100, "older run was all-compliant");
});

test("GET /api/programs/:id/top-drivers ranks overdue by site/role + flagged-reason mix", async () => {
  const d = (await get("/audiogram/top-drivers").then((r) => r!.json())) as {
    bySite: Array<{ site: string; overdueCount: number; note: string }>;
    byRole: Array<{ role: string; overdueCount: number }>;
    byOutcomeReason: Array<{ reason: string; count: number; pct: number }>;
  };
  assert.deepEqual(d.bySite, [{ site: "Plant A", overdueCount: 1, note: "High overdue concentration" }]);
  assert.deepEqual(d.byRole, [{ role: "Welder", overdueCount: 1 }]);
  assert.deepEqual(d.byOutcomeReason, [{ reason: "OVERDUE", count: 1, pct: 100 }]);
});

test("trend/top-drivers for an unknown or no-data measure → empty (Java parity, no 404)", async () => {
  assert.deepEqual(await get("/flu_vaccine/trend").then((r) => r!.json()), []);
  assert.deepEqual(await get("/does-not-exist/top-drivers").then((r) => r!.json()), {
    bySite: [],
    byRole: [],
    byOutcomeReason: [],
  });
});

test("trend honors the date validation too (malformed from → 400)", async () => {
  assert.equal((await get("/audiogram/trend?from=2026-13-01"))?.status, 400);
});

test("GET /api/programs/:id/risk-outlook predicts upcoming due-soon + repeat non-compliers", async () => {
  // Seed hazwoper outcomes (separate measure, doesn't disturb the audiogram assertions above).
  const runStore = new SqliteRunStore(env.DB as never);
  const oc = new SqliteOutcomeStore(env.DB as never);
  const mk = () =>
    runStore.createRun({
      scopeType: "MEASURE",
      scopeId: "hazwoper",
      triggeredBy: "test",
      requestedScope: { measureId: "hazwoper" },
      measurementPeriodStart: "2026-06-13T00:00:00.000Z",
      measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
    });
  // emp-006 COMPLIANT with an exam 320 days ago → within 30 days of the due-soon threshold (365-30=335).
  const lastExam = new Date(Date.now() - 320 * 86400000).toISOString().slice(0, 10);
  const r1 = await mk();
  await oc.recordOutcome({
    runId: r1.id,
    subjectId: "emp-006",
    measureId: "hazwoper",
    evaluationPeriod: "2026-06-13",
    status: "COMPLIANT",
    evidence: { expressionResults: [{ define: "Most Recent Surveillance Exam Date", result: lastExam }] },
  });
  // emp-001 OVERDUE across 3 distinct evaluation periods → repeat non-complier (streak 3).
  for (const period of ["2024-06-13", "2025-06-13", "2026-06-13"]) {
    await oc.recordOutcome({ runId: r1.id, subjectId: "emp-001", measureId: "hazwoper", evaluationPeriod: period, status: "OVERDUE", evidence: {} });
  }

  const res = await get("/hazwoper/risk-outlook?horizonDays=30");
  assert.equal(res?.status, 200);
  const d = (await res!.json()) as {
    upcomingNonCompliantCount: number;
    upcomingExpirations: Array<{ externalId: string; daysUntilDueSoon: number; predictedDueSoonDate: string }>;
    repeatNonCompliers: Array<{ externalId: string; streakCount: number }>;
    siteComplianceRates: Array<{ site: string }>;
  };
  const omar = d.upcomingExpirations.find((e) => e.externalId === "emp-006")!;
  assert.ok(omar, "emp-006 is becoming due soon");
  assert.equal(omar.daysUntilDueSoon, 15, "335 threshold − 320 days since");
  assert.equal(d.upcomingNonCompliantCount, d.upcomingExpirations.length);
  const repeat = d.repeatNonCompliers.find((r) => r.externalId === "emp-001")!;
  assert.equal(repeat.streakCount, 3, "3 flagged periods in a row");
  assert.ok(d.siteComplianceRates.length >= 1);
});

test("GET /api/programs/:id/risk-outlook for an unknown measure → 404", async () => {
  assert.equal((await get("/does-not-exist/risk-outlook"))?.status, 404);
});

test("malformed from/to date filters → 400 (Java parseFromDate/parseToDate parity)", async () => {
  assert.equal((await get("/overview?from=2026-13-01"))?.status, 400, "bad month");
  assert.equal((await get("/overview?to=2026-02-30"))?.status, 400, "overflow day rejected like LocalDate");
  assert.equal((await get("/overview?from=not-a-date"))?.status, 400);
  const msg = (await get("/overview?from=2026-13-01").then((r) => r!.json())) as { message: string };
  assert.match(msg.message, /from must use YYYY-MM-DD/);
  // a valid date still returns 200 (blank → no filter, also 200)
  assert.equal((await get("/overview?from=2026-01-01&to=2026-12-31"))?.status, 200);
});

test("C4: a single-subject CASE rerun does not become a measure's latest run or skew the rollup", async () => {
  const runStore = new SqliteRunStore(env.DB as never);
  const oc = new SqliteOutcomeStore(env.DB as never);
  const mkRun = (scopeType: "MEASURE" | "CASE") =>
    runStore.createRun({
      scopeType,
      scopeId: "tb_surveillance",
      triggeredBy: "test",
      requestedScope: { measureId: "tb_surveillance" },
      measurementPeriodStart: "2026-06-13T00:00:00.000Z",
      measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
    });

  // Population MEASURE run: 2 evaluated, 1 compliant → 50%.
  const measureRun = await mkRun("MEASURE");
  await oc.recordOutcome({ runId: measureRun.id, subjectId: "emp-006", measureId: "tb_surveillance", status: "OVERDUE", evidence: {} });
  await oc.recordOutcome({ runId: measureRun.id, subjectId: "emp-001", measureId: "tb_surveillance", status: "COMPLIANT", evidence: {} });
  await new Promise((r) => setTimeout(r, 8)); // strictly later started_at

  // A newer single-subject CASE rerun-to-verify: emp-006 re-confirmed OVERDUE (would skew to 0%).
  const caseRerun = await mkRun("CASE");
  await oc.recordOutcome({ runId: caseRerun.id, subjectId: "emp-006", measureId: "tb_surveillance", status: "OVERDUE", evidence: {} });

  const tb = ((await get("/overview").then((r) => r!.json())) as Summary[]).find((p) => p.measureId === "tb_surveillance")!;
  assert.equal(tb.latestRunId, measureRun.id, "rollup latest run is the population MEASURE run, not the CASE rerun");
  assert.equal(tb.totalEvaluated, 2, "full population, not the single CASE-rerun subject");
  assert.equal(tb.complianceRate, 50, "not crashed to 0% by the single-subject rerun");

  const trend = (await get("/tb_surveillance/trend").then((r) => r!.json())) as Array<{ runId: string }>;
  assert.equal(trend.length, 1, "only the population run appears in the trend");
  assert.equal(trend[0]!.runId, measureRun.id);
});
