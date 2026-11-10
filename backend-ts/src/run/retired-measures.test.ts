/**
 * #889: the still-active cases of a retired measure close, audit-first, on an all-programs run.
 *
 *   node --import tsx --import ./src/engine/utc.ts --test src/run/retired-measures.test.ts
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
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { createWorkwellEngine } from "../engine/cql/workwell-engine.ts";
import { executeManualRun, type RunPipelineDeps } from "./run-pipeline.ts";
import { closeRetiredMeasureCases, MEASURE_RETIRED, retiredClosureTouched } from "./retired-measures.ts";
import { closureKindOf } from "../case/case-logic.ts";
import type { AppendAuditInput } from "../stores/case-event-store.ts";

const dbPath = join(tmpdir(), `workwell-retired-${crypto.randomUUID()}.sqlite`);
let caseStore: SqliteCaseStore;
let events: SqliteCaseEventStore;
let runStore: SqliteRunStore;
let outcomeStore: SqliteOutcomeStore;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  caseStore = new SqliteCaseStore(db);
  events = new SqliteCaseEventStore(db);
  runStore = new SqliteRunStore(db);
  outcomeStore = new SqliteOutcomeStore(db);
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

/** One case of `measureId` per subject, opened OVERDUE; the measure id keeps each test's cases apart. */
async function openCases(measureId: string, subjects: string[]) {
  const ids: string[] = [];
  for (const subjectId of subjects) {
    const up = await caseStore.upsertFromOutcome({
      runId: "seed-run",
      subjectId,
      measureId,
      evaluationPeriod: "2026",
      outcomeStatus: "OVERDUE",
    });
    ids.push(up!.id);
  }
  return ids;
}

const resolvedFor = async (caseId: string) =>
  (await events.auditEventsForCases([caseId], 50)).filter((e) => e.eventType === "CASE_RESOLVED");

test("closes OPEN and IN_PROGRESS cases as a system closure, one CASE_RESOLVED each; a second pass closes nothing", async () => {
  const [a, b] = (await openCases("retired-a", ["s-1", "s-2"])) as [string, string];
  await caseStore.patchCase(b, { status: "IN_PROGRESS" });

  const r = await closeRetiredMeasureCases(
    { caseStore, events, runStore },
    { retiredMeasureIds: ["retired-a"], runId: null, actor: "system", now: () => "2026-11-05T12:00:00.000Z" },
  );
  assert.deepEqual({ closed: r.closed, failed: r.failed, auditGaps: r.auditGaps, unread: r.unreadMeasures }, { closed: 2, failed: 0, auditGaps: 0, unread: [] });
  assert.ok(retiredClosureTouched(r));
  for (const id of [a, b]) {
    const c = (await caseStore.getCase(id))!;
    assert.equal(c.status, "RESOLVED");
    assert.equal(c.closedReason, MEASURE_RETIRED);
    assert.equal(c.closedBy, null);
    assert.equal(c.closedAt, "2026-11-05T12:00:00.000Z");
    assert.equal(closureKindOf(c), "SYSTEM", "a retirement is the system's closure, never a person's");
    const ev = await resolvedFor(id);
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.payload as Record<string, unknown>).reason, MEASURE_RETIRED);
  }
  const priors = await Promise.all([a, b].map(async (id) => ((await resolvedFor(id))[0]!.payload as Record<string, unknown>).priorStatus));
  assert.deepEqual(priors, ["OPEN", "IN_PROGRESS"]);

  const again = await closeRetiredMeasureCases({ caseStore, events }, { retiredMeasureIds: ["retired-a"], runId: null, actor: "system" });
  assert.equal(again.closed, 0, "idempotent: nothing is left to close");
  assert.equal(retiredClosureTouched(again), false);
  assert.equal((await resolvedFor(a)).length, 1, "and no second event");
});

test("leaves staff-closed cases and every other measure's cases alone", async () => {
  const [staffClosed] = (await openCases("retired-b", ["s-1"])) as [string];
  await caseStore.patchCase(staffClosed, { status: "CLOSED", closedAt: "2026-10-01T00:00:00.000Z", closedReason: "MANUAL_RESOLVE", closedBy: "lead@example" });
  const [other] = (await openCases("still-runs-b", ["s-1"])) as [string];

  const r = await closeRetiredMeasureCases({ caseStore, events }, { retiredMeasureIds: ["retired-b"], runId: null, actor: "system" });
  assert.equal(r.closed, 0);
  assert.equal((await caseStore.getCase(staffClosed))!.closedReason, "MANUAL_RESOLVE");
  assert.equal((await caseStore.getCase(other))!.status, "OPEN");
  assert.equal((await resolvedFor(other)).length, 0);
});

test("a case closed after the list was read gets no event and is not touched", async () => {
  const [id] = (await openCases("retired-c", ["s-1"])) as [string];
  const racing = {
    listCases: caseStore.listCases.bind(caseStore),
    patchCase: caseStore.patchCase.bind(caseStore),
    // Staff close it between the list read and the re-read.
    getCase: async (caseId: string) => {
      await caseStore.patchCase(caseId, { status: "CLOSED", closedAt: "2026-11-05T00:00:00.000Z", closedReason: "MANUAL_RESOLVE", closedBy: "staff@example" });
      return caseStore.getCase(caseId);
    },
  };
  const r = await closeRetiredMeasureCases({ caseStore: racing, events }, { retiredMeasureIds: ["retired-c"], runId: null, actor: "system" });
  assert.equal(r.closed, 0);
  assert.equal((await resolvedFor(id)).length, 0, "no CASE_RESOLVED for a case the pass did not close");
  assert.equal((await caseStore.getCase(id))!.closedBy, "staff@example");
});

test("a failed audit leaves the case open; a failed patch is counted and its event stands (audit-first)", async () => {
  const [gap] = (await openCases("retired-d", ["s-1"])) as [string];
  const noLedger = { appendAudit: async () => { throw new Error("ledger down"); } };
  const r1 = await closeRetiredMeasureCases({ caseStore, events: noLedger }, { retiredMeasureIds: ["retired-d"], runId: null, actor: "system" });
  assert.deepEqual([r1.closed, r1.auditGaps, r1.failed], [0, 1, 0]);
  assert.equal((await caseStore.getCase(gap))!.status, "OPEN", "never a silent change");

  const order: string[] = [];
  const ledger = { appendAudit: async (input: AppendAuditInput) => { order.push(`audit:${input.eventType}`); } };
  const failingPatch = {
    listCases: caseStore.listCases.bind(caseStore),
    getCase: caseStore.getCase.bind(caseStore),
    patchCase: async () => { order.push("patch"); throw new Error("write failed"); },
  };
  const r2 = await closeRetiredMeasureCases({ caseStore: failingPatch, events: ledger }, { retiredMeasureIds: ["retired-d"], runId: null, actor: "system" });
  assert.deepEqual([r2.closed, r2.failed], [0, 1]);
  assert.deepEqual(order, ["audit:CASE_RESOLVED", "patch"], "the event is written before the mutation");
  assert.equal((await caseStore.getCase(gap))!.status, "OPEN");
});

test("a measure whose cases cannot be listed is reported, and the others still close", async () => {
  const [id] = (await openCases("retired-e", ["s-1"])) as [string];
  const flaky = {
    listCases: async (q: Parameters<SqliteCaseStore["listCases"]>[0]) => {
      if (q.measureId === "unreadable") throw new Error("read failed");
      return caseStore.listCases(q);
    },
    getCase: caseStore.getCase.bind(caseStore),
    patchCase: caseStore.patchCase.bind(caseStore),
  };
  const r = await closeRetiredMeasureCases({ caseStore: flaky, events }, { retiredMeasureIds: ["unreadable", "retired-e"], runId: null, actor: "system" });
  assert.deepEqual(r.unreadMeasures, ["unreadable"]);
  assert.equal(r.closed, 1);
  assert.equal((await caseStore.getCase(id))!.status, "RESOLVED");
});

test("the run pipeline closes them on an ALL_PROGRAMS run only, and RUN_COMPLETED carries the counts", async () => {
  const [id] = (await openCases("retired-f", ["s-1"])) as [string];
  const audits: AppendAuditInput[] = [];
  const recording = {
    appendAudit: async (input: AppendAuditInput) => { audits.push(input); await events.appendAudit(input); },
    appendAudits: async (inputs: AppendAuditInput[]) => { for (const i of inputs) await recording.appendAudit(i); },
    recordCaseEvents: events.recordCaseEvents.bind(events),
  };
  const deps = {
    runStore,
    outcomeStore,
    caseStore,
    events: recording,
    engine: createWorkwellEngine(),
    employees: EMPLOYEES.slice(0, 2),
    retiredMeasureIds: ["retired-f"],
  } as unknown as RunPipelineDeps;

  await executeManualRun(deps, { scopeType: "MEASURE", measureId: "audiogram" });
  assert.equal((await caseStore.getCase(id))!.status, "OPEN", "a MEASURE run never runs the pass");

  const res = await executeManualRun(deps, { scopeType: "ALL_PROGRAMS" });
  const c = (await caseStore.getCase(id))!;
  assert.equal(c.status, "RESOLVED");
  assert.equal(c.closedReason, MEASURE_RETIRED);
  const ev = await resolvedFor(id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.refRunId, res.runId, "the closure cites the run that made it");
  const completed = audits.find((a) => a.eventType === "RUN_COMPLETED" && a.refRunId === res.runId);
  assert.ok(completed, "RUN_COMPLETED written");
  const retired = (completed!.payload as Record<string, unknown>).retired as Record<string, unknown>;
  assert.equal(retired.closed, 1);
  const rollover = (completed!.payload as Record<string, unknown>).rollover as Record<string, unknown> | undefined;
  assert.equal(rollover?.closed ?? 0, 0, "never counted as a rollover closure: the year-change rehearsal checks rollover for equality");

  const quiet = await executeManualRun(deps, { scopeType: "ALL_PROGRAMS" });
  const next = audits.find((a) => a.eventType === "RUN_COMPLETED" && a.refRunId === quiet.runId)!;
  assert.equal("retired" in (next.payload as Record<string, unknown>), false, "a pass that touched nothing adds no key");
});
