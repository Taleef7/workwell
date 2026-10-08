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
import { SqliteSegmentStore } from "../stores/sqlite/segment-store-sqlite.ts";
import { handleEmployees } from "./employees.ts";
import { replaceLiveDirectory } from "../engine/ingress/webchart/live-directory.ts";

const dbPath = join(tmpdir(), `workwell-employees-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let caseId: string;
let cmsCaseId: string;

const get = (path: string) => handleEmployees(new Request(`http://x${path}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    status: "COMPLETED",
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
  await outcomes.recordOutcome({
    runId: run.id,
    subjectId: "emp-006",
    measureId: "cms125",
    evaluationPeriod: "2026-06-13",
    status: "MISSING_DATA",
    evidence: {},
    evaluatedAt: "2026-06-12T00:00:00.000Z",
  });
  const store = new SqliteCaseStore(db);
  const c = await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  caseId = c!.id;
  const cmsCase = await store.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "cms125", evaluationPeriod: "2026-06-13", outcomeStatus: "MISSING_DATA" });
  cmsCaseId = cmsCase!.id;
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
    measureOutcomes: Array<{ measureId: string; measureName: string; measureVersion: string; logic: unknown; outcomeStatus: string; daysSinceLastExam: number | null; daysUntilDue: number | null; openCaseId: string | null }>;
    openCases: Array<{ caseId: string; measureId: string; outcomeStatus: string; logic: unknown }>;
    recentAuditEvents: Array<{ eventType: string; summary: string }>;
  };
  assert.equal(p.externalId, "emp-006");
  assert.equal(p.name, "Omar Siddiq");
  assert.equal(p.active, true);
  // employee-profile uses the engine registry name (consistent with cases/runs), i.e. "Audiogram".
  const audiogram = p.measureOutcomes.find((o) => o.outcomeStatus === "OVERDUE")!;
  assert.equal(audiogram.measureId, "audiogram");
  assert.equal(audiogram.measureName, "Audiogram");
  assert.equal(audiogram.outcomeStatus, "OVERDUE");
  // ACTUAL recency, not the overdue amount: exam was 420 days ago against a 365-day window.
  assert.equal(audiogram.daysSinceLastExam, 420, "actual days since last exam");
  assert.equal(audiogram.daysUntilDue, 365 - 420, "window − recency (negative ⇒ overdue)");
  assert.equal(audiogram.openCaseId, caseId, "outcome links its open case");
  const cms125 = p.measureOutcomes.find((o) => o.measureId === "cms125")!;
  assert.equal(cms125.measureId, "cms125");
  assert.equal(cms125.measureName, "Breast Cancer Screening");
  assert.equal(cms125.openCaseId, cmsCaseId, "cms125 outcome links its open case");
  const audiogramCase = p.openCases.find((c) => c.caseId === caseId);
  assert.ok(audiogramCase);
  assert.equal(audiogramCase.measureId, "audiogram");
  const cmsCase = p.openCases.find((c) => c.caseId === cmsCaseId);
  assert.ok(cmsCase);
  assert.equal(cmsCase.measureId, "cms125");
  // Authored CQL scored both rows (TWH's occupational measure, and a cms125 row with no `official`
  // block): no CMS or translation identity, and the authored library's own version (#769).
  assert.equal(audiogram.logic, null);
  assert.equal(audiogram.measureVersion, "1.0.0");
  assert.equal(cms125.logic, null);
  assert.equal(cms125.measureVersion, "2.0.0", "an authored row keeps the authored version");
  assert.equal(audiogramCase.logic, null);
  assert.equal(cmsCase.logic, null);
  assert.ok(p.recentAuditEvents.some((e) => e.eventType === "CASE_CREATED" && /opened a case/.test(e.summary)));
});

test("profile shows what the roster shows: out-of-population MISSING_DATA reads OUT_OF_POPULATION (#671)", async () => {
  const db = env.DB as never;
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "cms122",
    triggeredBy: "test",
    status: "COMPLETED",
    requestedScope: { measureId: "cms122" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
  });
  // Outside every rate's initial population: stored as MISSING_DATA (ADR-078), displayed as not in
  // population by the roster (`deriveCell`). The same evidence shape as roster-vocabulary.test.ts.
  await new SqliteOutcomeStore(db).recordOutcome({
    runId: run.id,
    subjectId: "emp-006",
    measureId: "cms122",
    evaluationPeriod: "2026-06-13",
    status: "MISSING_DATA",
    evidence: { expressionResults: [], official: { populationResults: { ipp: false, denom: false, denex: false, numer: false, denexcep: false } } },
    evaluatedAt: "2026-06-01T00:00:00.000Z",
  });
  const p = (await (await get("/api/employees/emp-006/profile"))!.json()) as {
    measureOutcomes: Array<{ measureId: string; outcomeStatus: string; displayStatus: string }>;
  };
  const cms122 = p.measureOutcomes.find((o) => o.measureId === "cms122")!;
  assert.equal(cms122.outcomeStatus, "MISSING_DATA", "the stored bucket is unchanged");
  assert.equal(cms122.displayStatus, "OUT_OF_POPULATION", "and the page is told what the table shows");
  // In the population with nothing on file stays a real gap.
  assert.equal(p.measureOutcomes.find((o) => o.measureId === "cms125")!.displayStatus, "MISSING_DATA");
});

test("profile applies the roster's segment overlay: a measure outside the subject's groups reads NOT_APPLICABLE (#671)", async () => {
  // One enabled segment holding emp-006 (by override) for the audiogram only: on the roster every other
  // measure is NOT_APPLICABLE for them, and the posture must not show a gap the table calls not applicable.
  const segments = new SqliteSegmentStore(env.DB as never);
  const seg = await segments.createSegment({
    name: "Audiogram only",
    enabled: true,
    rule: { match: "ANY", conditions: [] },
    measureIds: ["audiogram"],
    overrides: [{ externalId: "emp-006", mode: "INCLUDE" }],
  });
  try {
    const p = (await (await get("/api/employees/emp-006/profile"))!.json()) as {
      measureOutcomes: Array<{ measureId: string; displayStatus: string }>;
    };
    const by = new Map(p.measureOutcomes.map((o) => [o.measureId, o.displayStatus]));
    assert.equal(by.get("audiogram"), "OVERDUE", "the segment's own measure keeps its reading");
    assert.equal(by.get("cms125"), "NOT_APPLICABLE", "outside every enabled group, as the roster shows it");
  } finally {
    await segments.deleteSegment(seg.id);
  }
});

test("GET /api/employees/:id/profile → 404 for an unknown employee", async () => {
  assert.equal((await get("/api/employees/emp-999/profile"))?.status, 404);
});

test("configured live employee profile uses the cached identity and restart-safe outcome rehydration", async () => {
  const db = env.DB as never;
  const subjectId = "wc|employee-profile-live-1";
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-07-17T00:00:00.000Z",
    measurementPeriodEnd: "2026-07-17T23:59:59.999Z",
  });
  await new SqliteOutcomeStore(db).recordOutcome({
    runId: run.id,
    subjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-07-17",
    status: "OVERDUE",
    evidence: {},
  });
  const configuredEnv = env as typeof env & Record<string, string>;
  configuredEnv.WORKWELL_WEBCHART_BASE_URL = "http://webchart.test";
  configuredEnv.WORKWELL_WEBCHART_API_KEY = "fixture-key";
  replaceLiveDirectory([{
    resourceType: "Bundle",
    entry: [{ resource: { resourceType: "Patient", id: "employee-profile-live-1", name: [{ text: "Live Profile Name" }] } }],
  }]);

  try {
    const live = await get(`/api/employees/${subjectId}/profile`);
    assert.equal(live?.status, 200);
    const liveProfile = (await live!.json()) as { externalId: string; name: string; site: string };
    assert.deepEqual(
      { externalId: liveProfile.externalId, name: liveProfile.name, site: liveProfile.site },
      { externalId: subjectId, name: "Live Profile Name", site: "WebChart" },
    );

    replaceLiveDirectory([]);
    const restarted = await get(`/api/employees/${subjectId}/profile`);
    assert.equal(restarted?.status, 200);
    const restartedProfile = (await restarted!.json()) as { name: string; site: string };
    assert.equal(restartedProfile.name, "employee-profile-live-1");
    assert.equal(restartedProfile.site, "WebChart");

    delete configuredEnv.WORKWELL_WEBCHART_BASE_URL;
    delete configuredEnv.WORKWELL_WEBCHART_API_KEY;
    assert.equal((await get(`/api/employees/${subjectId}/profile`))?.status, 404, "seam-off hides persisted live identities");
  } finally {
    delete configuredEnv.WORKWELL_WEBCHART_BASE_URL;
    delete configuredEnv.WORKWELL_WEBCHART_API_KEY;
    replaceLiveDirectory([]);
  }
});

test("GET /api/employees/search matches name/role; honors min-length + open gaps", async () => {
  const byName = (await get("/api/employees/search?q=omar").then((r) => r!.json())) as Array<Record<string, unknown>>;
  const omar = byName.find((e) => e.externalId === "emp-006")!;
  assert.ok(omar);
  // The two open cases the fixture made (audiogram, cms125): what the work list and the page show.
  assert.equal(omar.openGaps, 2);
  assert.equal("latestOutcome" in omar, false, "no single stored status for a person scored on several measures");

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

test("search counts the ACTIVE cases (open or in progress), and a person with none reads 0 (#655)", async () => {
  const store = new SqliteCaseStore(env.DB as never);
  const omarGaps = async () =>
    ((await get("/api/employees/search?q=omar").then((r) => r!.json())) as Array<{ externalId: string; openGaps: number }>)
      .find((e) => e.externalId === "emp-006")!.openGaps;
  const was = await omarGaps();
  try {
    // In progress is still open work: the page's Open Cases table lists it, so the badge counts it.
    await store.patchCase(caseId, { status: "IN_PROGRESS" });
    assert.equal(await omarGaps(), was, "an in-progress case is still an open gap");
    await store.patchCase(caseId, { status: "CLOSED", closedAt: new Date().toISOString(), closedReason: "MANUAL_RESOLVE", closedBy: "cm@workwell.dev" });
    const after = (await get("/api/employees/search?q=omar").then((r) => r!.json())) as Array<{ externalId: string; openGaps: number }>;
    assert.equal(after.find((e) => e.externalId === "emp-006")!.openGaps, was - 1, "a closed case is not an open gap");
    for (const e of after.filter((x) => x.externalId !== "emp-006")) assert.equal(e.openGaps, 0);
  } finally {
    await store.patchCase(caseId, { status: "OPEN", closedAt: null, closedReason: null, closedBy: null });
  }
});

test("profile reads each measure's WINNING population run, never a newer single-patient rerun (#655)", async () => {
  const db = env.DB as never;
  const runs = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  // The winner: the newest finished population run (earlier tests leave others behind).
  const population = await runs.createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({
    runId: population.id,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "OVERDUE",
    evidence: {},
  });
  // A newer one-patient rerun says COMPLIANT. The roster table ignores it (not a population run), so
  // the summary beside it must too, or one page gives two answers.
  const rerun = await runs.createRun({
    scopeType: "EMPLOYEE",
    scopeId: "emp-006",
    triggeredBy: "test",
    status: "COMPLETED",
    requestedScope: { employeeId: "emp-006" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({
    runId: rerun.id,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "COMPLIANT",
    evidence: {},
    evaluatedAt: "2099-01-01T00:00:00.000Z",
  });
  // And a population run still in flight, newer still: not finished, so not the answer yet.
  const inFlight = await runs.createRun({
    scopeType: "ALL_PROGRAMS",
    triggeredBy: "test",
    status: "RUNNING",
    requestedScope: {},
    measurementPeriodStart: "2026-06-13T00:00:00.000Z",
    measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({
    runId: inFlight.id,
    subjectId: "emp-006",
    measureId: "audiogram",
    evaluationPeriod: "2026-06-13",
    status: "COMPLIANT",
    evidence: {},
    evaluatedAt: "2099-01-02T00:00:00.000Z",
  });
  const p = (await (await get("/api/employees/emp-006/profile"))!.json()) as {
    measureOutcomes: Array<{ measureId: string; outcomeStatus: string; displayStatus: string }>;
  };
  const audiogram = p.measureOutcomes.filter((o) => o.measureId === "audiogram");
  assert.equal(audiogram.length, 1, "one row per measure");
  assert.equal(audiogram[0]!.outcomeStatus, "OVERDUE", "the completed population run's answer, as the table shows it");
  assert.equal(audiogram[0]!.displayStatus, "OVERDUE");
});
