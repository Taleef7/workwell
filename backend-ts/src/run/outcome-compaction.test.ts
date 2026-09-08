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
  // COMPLETED, not the default QUEUED: since ADR-077 d3 an in-flight run's rows are never candidates,
  // so a fixture run that is "old enough to compact" must also be one that finished.
  status: "COMPLETED" as const,
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
    // SAME evaluation period: the December row supersedes the January one, which is what makes the
    // January one deletable. Two different periods would both be kept — see the per-period test below.
    { runId, subjectId: "pat-90001", measureId: "cms122", evaluationPeriod: "2027-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-01-01T00:00:00.000Z" },
    { runId, subjectId: "pat-90001", measureId: "cms122", evaluationPeriod: "2027-01-01", status: "COMPLIANT", evidence: {}, evaluatedAt: "2027-12-01T00:00:00.000Z" },
  ]);

  const result = (await compactOutcomes(stores, { retentionDays: 90, now: NOW }))!;
  assert.equal(result.cutoff, "2027-10-02T00:00:00.000Z", "90 days before 2027-12-31");
  assert.equal(result.deleted, 1, "the January row goes; December is the subject's newest and stays");

  const [event] = audits.filter((e) => e.eventType === "OUTCOMES_COMPACTED");
  assert.ok(event, "a deletion is a state change and is audited — no exceptions");
  assert.deepEqual(Object.keys(event.payload).sort(), ["cutoff", "deleted", "durationMs", "retentionDays"]);
  assert.equal(event.payload.cutoff, "2027-10-02T00:00:00.000Z");
  assert.equal(event.payload.retentionDays, 90);
});

test("the ledger entry precedes the delete: no audit write, no deletion — and a failed pass still names its cutoff", async () => {
  // The two stores share no transaction. "Delete, then audit" meant an audit failure left rows
  // irreversibly gone with no record of it — the scheduler logs the rejection and moves on, and a later
  // pass cannot say how much the first one removed (Codex review, #528). So the intent is written first.
  const { stores, runs } = makeStores();
  const runId = (await runs.createRun(SAMPLE_RUN)).id;
  const outcomes = (stores as never as { outcomes: SqliteOutcomeStore }).outcomes;
  await outcomes.recordOutcomes([
    { runId, subjectId: "pat-90002", measureId: "cms122", evaluationPeriod: "2027-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-01-01T00:00:00.000Z" },
    { runId, subjectId: "pat-90002", measureId: "cms122", evaluationPeriod: "2027-01-01", status: "COMPLIANT", evidence: {}, evaluatedAt: "2027-12-01T00:00:00.000Z" },
  ]);
  const rowsFor = async () => (await outcomes.listOutcomes(runId)).length;

  // 1. The FIRST audit write fails: nothing may be deleted.
  const audits: Audit[] = [];
  let failNth = 1;
  let calls = 0;
  const events = {
    appendAudit: async (e: { eventType: string; payload?: Record<string, unknown> }) => {
      calls += 1;
      if (calls === failNth) throw new Error("transient audit store failure");
      audits.push({ eventType: e.eventType, payload: e.payload ?? {} });
      return { id: crypto.randomUUID() } as never;
    },
  };
  const flaky = { ...(stores as never as Record<string, unknown>), events } as never;
  await assert.rejects(compactOutcomes(flaky, { retentionDays: 90, now: NOW }), /transient audit store failure/);
  assert.equal(await rowsFor(), 2, "the audit write failed, so the delete must not have run");
  assert.equal(audits.length, 0);

  // 2. The SECOND (completion) write fails: the row is gone, and the ledger already says which window
  //    was applied — the deletion is recorded even though the count is not.
  calls = 0;
  failNth = 2;
  await assert.rejects(compactOutcomes(flaky, { retentionDays: 90, now: NOW }), /transient audit store failure/);
  assert.equal(await rowsFor(), 1, "the delete ran");
  assert.deepEqual(audits.map((e) => e.eventType), ["OUTCOMES_COMPACTION_STARTED"]);
  assert.equal(audits[0]!.payload.cutoff, "2027-10-02T00:00:00.000Z", "the intent record names the cutoff the rows were deleted against");

  // 3. A clean pass writes both, in that order.
  calls = 0;
  failNth = 0;
  audits.length = 0;
  await compactOutcomes(flaky, { retentionDays: 90, now: NOW });
  assert.deepEqual(audits.map((e) => e.eventType), ["OUTCOMES_COMPACTION_STARTED", "OUTCOMES_COMPACTED"]);
});

test("a row a case CITES survives — open or closed, and only that row, not its whole run", async () => {
  const { stores, runs } = makeStores();
  const s = stores as never as { outcomes: SqliteOutcomeStore; cases: SqliteCaseStore };
  const oldRun = (await runs.createRun(SAMPLE_RUN)).id;
  const newRun = (await runs.createRun(SAMPLE_RUN)).id;

  // Three subjects sharing ONE old run. One has an open case citing it, one a CLOSED case, one none.
  // Pinning by run — which is what this did first — would protect all three; pinning per row protects
  // exactly the two that are cited, which is what stops one long-open case preserving 100,000 rows.
  const subjects = ["pat-91001", "pat-91002", "pat-91003"];
  await s.outcomes.recordOutcomes([
    ...subjects.map((subjectId) => ({ runId: oldRun, subjectId, measureId: "cms125", evaluationPeriod: "2027-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-01-01T00:00:00.000Z" })),
    ...subjects.map((subjectId) => ({ runId: newRun, subjectId, measureId: "cms125", evaluationPeriod: "2027-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2027-12-01T00:00:00.000Z" })),
  ]);
  await s.cases.upsertFromOutcome({ runId: oldRun, subjectId: "pat-91001", measureId: "cms125", evaluationPeriod: "2027-01-01", outcomeStatus: "OVERDUE" });
  const closed = (await s.cases.upsertFromOutcome({ runId: oldRun, subjectId: "pat-91002", measureId: "cms125", evaluationPeriod: "2027-01-01", outcomeStatus: "OVERDUE" }))!;
  await s.cases.patchCase(closed.id, { status: "RESOLVED", closedAt: new Date().toISOString(), closedReason: "MANUAL", closedBy: "someone" });

  const result = (await compactOutcomes(stores, { retentionDays: 90, now: NOW }))!;
  assert.equal(result.deleted, 1, "only the uncited subject's old row goes");

  const survivors = (await s.outcomes.listOutcomes(oldRun)).map((o) => o.subjectId).sort();
  // The CLOSED case matters as much as the open one: its detail page still resolves its evidence
  // through `last_run_id`, and a resolved case is exactly the record re-read when a number is
  // challenged. Pinning only OPEN cases — the first version — silently emptied that page.
  assert.deepEqual(survivors, ["pat-91001", "pat-91002"]);
});

test("the keep-rule is per (subject, measure, PERIOD) — a closed year's evidence is not swept by the next year's run", async () => {
  // The regulatory case, and the reason the rule is not merely per (subject, measure). A calendar-year
  // eCQM's whole 2027 evidence is superseded the moment the first 2028 run lands; under a
  // newest-per-measure rule every 2027 row becomes deletable months before anyone could be asked to
  // justify a 2027 rate.
  const { stores, runs } = makeStores();
  const s = stores as never as { outcomes: SqliteOutcomeStore };
  const py2027 = (await runs.createRun(SAMPLE_RUN)).id;
  const py2028 = (await runs.createRun(SAMPLE_RUN)).id;
  await s.outcomes.recordOutcomes([
    { runId: py2027, subjectId: "pat-92001", measureId: "cms122", evaluationPeriod: "2027-01-01", status: "COMPLIANT", evidence: { official: { year: 2027 } }, evaluatedAt: "2027-12-31T00:00:00.000Z" },
    { runId: py2028, subjectId: "pat-92001", measureId: "cms122", evaluationPeriod: "2028-01-01", status: "OVERDUE", evidence: {}, evaluatedAt: "2028-01-02T00:00:00.000Z" },
  ]);

  // Compact well into 2028, long after the 2027 row stopped being the subject's newest for cms122.
  const result = (await compactOutcomes(stores, { retentionDays: 90, now: Date.parse("2028-06-01T00:00:00.000Z") }))!;
  assert.equal(result.deleted, 0, "the 2027 row is that PERIOD's newest and must survive");
  const kept = await s.outcomes.listOutcomes(py2027);
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0]!.evidence, { official: { year: 2027 } }, "the evidence a PY2027 rate rests on is still readable");
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
