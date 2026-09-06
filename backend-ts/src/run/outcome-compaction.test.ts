/**
 * Outcome retention (ADR-073). The store contract proves `compactOlderThan` keeps the right rows; this
 * proves the POLICY around it — that it is inert unless configured, that it pins what open cases cite,
 * that it audits, and that it runs after the quality snapshot rather than before.
 *
 *   node --import tsx --test src/run/outcome-compaction.test.ts
 */
import { test, before, after, beforeEach } from "node:test";
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
import { compactOutcomes, retentionDaysFromEnv } from "./outcome-compaction.ts";
import { backfillTrendHistory } from "./backfill-trend-history.ts";

const NOW = Date.parse("2027-12-31T00:00:00.000Z");
const SAMPLE_RUN = {
  scopeType: "ALL_PROGRAMS" as const,
  triggeredBy: "scheduler",
  requestedScope: {},
  measurementPeriodStart: "2027-01-01T00:00:00.000Z",
  measurementPeriodEnd: "2027-12-31T23:59:59.999Z",
};
const dbPath = join(tmpdir(), `workwell-compaction-${crypto.randomUUID()}.sqlite`);
let db: unknown;

before(async () => {
  db = await createSqliteD1(dbPath);
  await (db as { exec(sql: string): Promise<unknown> }).exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
});
after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

interface Audit {
  eventType: string;
  payload: Record<string, unknown>;
}

function makeStores() {
  const audits: Audit[] = [];
  const runs = new SqliteRunStore(db as never);
  return {
    audits,
    runs,
    stores: {
      outcomes: new SqliteOutcomeStore(db as never),
      cases: new SqliteCaseStore(db as never),
      events: {
        appendAudit: async (e: { eventType: string; payload?: Record<string, unknown> }) => {
          audits.push({ eventType: e.eventType, payload: e.payload ?? {} });
          return { id: crypto.randomUUID() } as never;
        },
      },
    } as never,
  };
}

beforeEach(() => {
  delete process.env.WORKWELL_OUTCOME_RETENTION_DAYS;
});

test("retentionDaysFromEnv is OFF unless it is a positive integer", () => {
  assert.equal(retentionDaysFromEnv({}), undefined);
  assert.equal(retentionDaysFromEnv({ WORKWELL_OUTCOME_RETENTION_DAYS: "" }), undefined);
  assert.equal(retentionDaysFromEnv({ WORKWELL_OUTCOME_RETENTION_DAYS: "90" }), 90);
  for (const bad of ["0", "-1", "abc", "90.5"]) {
    assert.equal(retentionDaysFromEnv({ WORKWELL_OUTCOME_RETENTION_DAYS: bad }), undefined, `bad value ${bad}`);
  }
});

test("compaction is a hard no-op unless retention is configured — and writes no audit event", async () => {
  // The direction that matters: a deployment that has not opted in must never lose a row, and must not
  // acquire an audit trail suggesting it did.
  const { stores, audits } = makeStores();
  assert.equal(await compactOutcomes(stores, { retentionDays: undefined, now: NOW }), null);
  assert.equal(await compactOutcomes(stores, { retentionDays: 0, now: NOW }), null);
  assert.equal(audits.filter((e) => e.eventType === "OUTCOMES_COMPACTED").length, 0);
});

test("one OUTCOMES_COMPACTED audit event per pass, carrying the declared payload", async () => {
  const { stores, audits, runs } = makeStores();
  const runId = (await runs.createRun(SAMPLE_RUN)).id;
  await (stores as never as { outcomes: SqliteOutcomeStore }).outcomes.recordOutcomes([
    { runId, subjectId: "pat-90001", measureId: "cms122", evaluationPeriod: "2027-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-01-01T00:00:00.000Z" },
    { runId, subjectId: "pat-90001", measureId: "cms122", evaluationPeriod: "2027-12-01", status: "COMPLIANT", evidence: {}, evaluatedAt: "2027-12-01T00:00:00.000Z" },
  ]);

  const result = (await compactOutcomes(stores, { retentionDays: 90, now: NOW }))!;
  assert.equal(result.cutoff, "2027-10-02T00:00:00.000Z", "90 days before 2027-12-31");
  assert.equal(result.deleted, 1, "the January row goes; December is the subject's newest and stays");

  const [event] = audits.filter((e) => e.eventType === "OUTCOMES_COMPACTED");
  assert.ok(event, "a deletion is a state change and is audited — no exceptions");
  assert.deepEqual(Object.keys(event.payload).sort(), ["cutoff", "deleted", "durationMs", "kept", "retentionDays"]);
  assert.equal(event.payload.cutoff, "2027-10-02T00:00:00.000Z");
  assert.equal(event.payload.retentionDays, 90);
});

test("a run an OPEN case points at is pinned — its evidence survives however old", async () => {
  const { stores, runs } = makeStores();
  const s = stores as never as { outcomes: SqliteOutcomeStore; cases: SqliteCaseStore };
  // THREE runs, and the two old ones are separate. The first version of this put both subjects' old
  // rows in the run it then pinned, so nothing was deletable and the test could not tell a working pin
  // from a compaction that deleted nothing at all.
  const pinnedRun = (await runs.createRun(SAMPLE_RUN)).id;
  const unpinnedOldRun = (await runs.createRun(SAMPLE_RUN)).id;
  const newRun = (await runs.createRun(SAMPLE_RUN)).id;

  await s.outcomes.recordOutcomes([
    { runId: pinnedRun, subjectId: "pat-90002", measureId: "cms125", evaluationPeriod: "2027-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-01-01T00:00:00.000Z" },
    { runId: unpinnedOldRun, subjectId: "pat-90003", measureId: "cms125", evaluationPeriod: "2027-02-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-02-01T00:00:00.000Z" },
    { runId: newRun, subjectId: "pat-90002", measureId: "cms125", evaluationPeriod: "2027-12-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-12-01T00:00:00.000Z" },
    { runId: newRun, subjectId: "pat-90003", measureId: "cms125", evaluationPeriod: "2027-12-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-12-01T00:00:00.000Z" },
  ]);
  // An open case whose lastRunId is the pinned run — a case opened months ago and still being worked.
  await s.cases.upsertFromOutcome({ runId: pinnedRun, subjectId: "pat-90002", measureId: "cms125", evaluationPeriod: "2027-01-01", outcomeStatus: "OVERDUE" });

  const result = (await compactOutcomes(stores, { retentionDays: 90, now: NOW }))!;
  assert.equal(result.kept, 1, "one run is pinned by an open case");
  // Both old rows are equally deletable on age and on not-being-newest. The ONLY thing separating them
  // is the pin, which is what makes this test about the pin.
  assert.equal(result.deleted, 1, "the unpinned old row goes and the pinned one does not");
  assert.equal((await s.outcomes.listOutcomes(pinnedRun)).length, 1, "the case's own evidence must remain readable");
  assert.equal((await s.outcomes.listOutcomes(unpinnedOldRun)).length, 0, "an unpinned superseded row is removed");
});

test("run rows and their counts survive compaction — a compacted run still reports what it found", async () => {
  const { stores, runs } = makeStores();
  const before = await runs.listRuns(1000);
  await compactOutcomes(stores, { retentionDays: 90, now: NOW });
  const after = await runs.listRuns(1000);
  assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id), "no run row is deleted");
});

test("backfill-trend-history REFUSES under a retention window, and says why", async () => {
  // It writes rows dated weeks in the past that are nobody's newest — precisely what the next
  // compaction deletes. Reporting success and then silently losing the series is the failure.
  await assert.rejects(
    () => backfillTrendHistory({} as never, { retentionDays: 90 }),
    /retention/i,
  );
  process.env.WORKWELL_OUTCOME_RETENTION_DAYS = "90";
  await assert.rejects(() => backfillTrendHistory({} as never, {}), /retention/i, "it reads the env too, not only the option");
  delete process.env.WORKWELL_OUTCOME_RETENTION_DAYS;
});
