/**
 * The invariants chunked evaluation must not break (ADR-075, spec §6).
 *
 * Every pre-existing run-pipeline test runs a roster smaller than one chunk, so all of them pass
 * against a chunked pipeline AND against an unchunked one — they cannot see this change at all. These
 * force several chunks, which is the only way the properties below are observable.
 *
 * Stubbed at the STORE / ENGINE / BUNDLE-SOURCE boundary, which is where the real caller sits. Nothing
 * stubs `planManualRun` or `finishOrFail` themselves: a harness that replaced the pipeline functions
 * would be gentler than production and the tests would stop meaning anything.
 *
 *   node --import tsx --test src/run/run-pipeline.chunking.test.ts
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
import { planManualRun, finishOrFail, type ManualRunRequest, type RunPipelineDeps } from "./run-pipeline.ts";
import { OFFICIAL_LOGIC_VERSION_PREFIX } from "../wiring/executor-router.ts";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { SubjectBundleSource } from "../wiring/subject-bundle-source.ts";
import type { RecordOutcomeInput, OutcomeRecord } from "../stores/outcome-store.ts";
import type { CaseQuery } from "../stores/case-store.ts";

const MEASURE = "cms122";
const OTHER = "cms125";

const dbPath = join(tmpdir(), `workwell-chunking-${crypto.randomUUID()}.sqlite`);
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
beforeEach(() => {
  delete process.env.WORKWELL_RUN_CHUNK_SIZE;
});

function seedSubjects(n: number): EmployeeProfile[] {
  return Array.from({ length: n }, (_, i) => ({
    externalId: `pat-${String(i + 1).padStart(5, "0")}`,
    name: `Subject ${i + 1}`,
    role: "Patient",
    site: "Wailuku Clinic",
    providerId: "maui-prov-001",
    tenantId: "twh",
    dateOfBirth: "1970-01-01",
  }));
}

interface Counters {
  /**
   * EVERY `listCases` the pipeline makes. Not split into preload and rollover: both happen per measure
   * and neither is distinguishable by its query, so a "preload only" counter would be a name over a
   * number that also counts the other. The bound below is stated for what it actually counts.
   */
  listCasesCalls: number;
  recordOutcomesBatchSizes: number[];
  bundlesBuilt: number;
  batchCalls: Array<{ measureId: string; size: number }>;
}

interface ChunkTestDeps extends RunPipelineDeps {
  counters: Counters;
  auditEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
}

/**
 * A bundle source that COUNTS what the pipeline asks it to build.
 *
 * Counted here rather than by instrumenting the pipeline's internals: bundle construction is private
 * to `run-pipeline.ts`, and a harness reaching into it would prove something about the test rather
 * than about the caller.
 */
function countingBundleSource(counters: Counters): SubjectBundleSource {
  const note = (_subjectId: string) => {
    counters.bundlesBuilt += 1;
  };
  return {
    targetFor: () => "COMPLIANT",
    distribution: (employees) => employees.map((employee) => ({ employee, target: "COMPLIANT" as const })),
    bundleFor: (employee) => {
      note(employee.externalId);
      return { resourceType: "Bundle", type: "collection", entry: [] } as never;
    },
    bundleForSubject: (employee) => {
      note(employee.externalId);
      return { resourceType: "Bundle", type: "collection", entry: [] } as never;
    },
  };
}

function makeTestDeps(opts: {
  subjects: EmployeeProfile[];
  chunkSize: number;
  /** Subjects the stub engine puts in the initial population. */
  ippSubjectIds?: string[];
  /** Make the OUTCOME STORE throw while persisting this chunk (0-based). */
  failOnChunk?: number;
  /** Persist the FIRST `partialRows` rows of the failing chunk before throwing — a store that batches in slices. */
  partialRows?: number;
  /** Report an official logicVersion, which is what gates the ADR-043 empty-IPP check. */
  officialRouting?: boolean;
}): ChunkTestDeps {
  const counters: Counters = {
    listCasesCalls: 0,
    recordOutcomesBatchSizes: [],
    bundlesBuilt: 0,
    batchCalls: [],
  };
  const auditEvents: Array<{ eventType: string; payload: Record<string, unknown> }> = [];
  const ipp = new Set(opts.ippSubjectIds ?? opts.subjects.map((s) => s.externalId));
  const source = countingBundleSource(counters);
  const realOutcomes = new SqliteOutcomeStore(db as never);
  const realCases = new SqliteCaseStore(db as never);
  const realRuns = new SqliteRunStore(db as never);

  process.env.WORKWELL_RUN_CHUNK_SIZE = String(opts.chunkSize);

  let chunkIndex = -1;
  const outcomeStore: RunPipelineDeps["outcomeStore"] = {
    ...realOutcomes,
    recordOutcome: (input: RecordOutcomeInput) => realOutcomes.recordOutcome(input),
    recordOutcomes: async (inputs: RecordOutcomeInput[]): Promise<OutcomeRecord[]> => {
      chunkIndex += 1;
      counters.recordOutcomesBatchSizes.push(inputs.length);
      if (opts.failOnChunk === chunkIndex) {
        if (opts.partialRows) await realOutcomes.recordOutcomes(inputs.slice(0, opts.partialRows));
        throw new Error("persist failed for this chunk");
      }
      return realOutcomes.recordOutcomes(inputs);
    },
    countOutcomesByStatus: (runId: string) => realOutcomes.countOutcomesByStatus(runId),
    listOutcomes: (runId: string, o?: { limit?: number; offset?: number }) => realOutcomes.listOutcomes(runId, o),
    getOutcomeById: (id: string) => realOutcomes.getOutcomeById(id),
  } as RunPipelineDeps["outcomeStore"];

  const caseStore = {
    ...realCases,
    listCases: (q: CaseQuery) => {
      counters.listCasesCalls += 1;
      return realCases.listCases(q);
    },
    upsertFromOutcome: (input: Parameters<typeof realCases.upsertFromOutcome>[0]) => realCases.upsertFromOutcome(input),
    // Re-bound like the rest: `...realCases` spreads an INSTANCE, and its methods live on the
    // prototype, so nothing here is inherited by the spread.
    upsertFromOutcomes: (inputs: Parameters<typeof realCases.upsertFromOutcomes>[0]) => realCases.upsertFromOutcomes(inputs),
    patchCase: (id: string, patch: Parameters<typeof realCases.patchCase>[1]) => realCases.patchCase(id, patch),
  } as unknown as RunPipelineDeps["caseStore"];

  const engine: RunPipelineDeps["engine"] = {
    evaluate: async () => ({ outcome: "COMPLIANT", evidence: {}, inInitialPopulation: true }),
    evaluateBatch: async (measureId: string, subjects: () => Array<{ subjectId: string; patientBundle: unknown }>) => {
      const list = subjects();
      counters.batchCalls.push({ measureId, size: list.length });
      return new Map(
        list.map((s) => [
          s.subjectId,
          { outcome: ipp.has(s.subjectId) ? "COMPLIANT" : "MISSING_DATA", evidence: {}, inInitialPopulation: ipp.has(s.subjectId) },
        ]),
      );
    },
    logicVersionFor: (measureId: string) =>
      opts.officialRouting ? `${OFFICIAL_LOGIC_VERSION_PREFIX}1:artifact:terminology:${measureId}` : undefined,
  } as unknown as RunPipelineDeps["engine"];

  return {
    runStore: realRuns,
    outcomeStore,
    caseStore,
    engine,
    employees: opts.subjects,
    bundleSource: source,
    events: {
      appendAudit: async (event: { eventType: string; payload?: Record<string, unknown> }) => {
        auditEvents.push({ eventType: event.eventType, payload: event.payload ?? {} });
        // The pipeline ignores the return; the real store returns a record.
        return { id: crypto.randomUUID() } as never;
      },
      // Delegates to this fake's own `appendAudit`, so the batch can never record less than the
      // single-row path this fixture asserts on.
      appendAudits: async (events: { eventType: string; payload?: Record<string, unknown> }[]) => {
        for (const event of events) auditEvents.push({ eventType: event.eventType, payload: event.payload ?? {} });
      },
    },
    counters,
    auditEvents,
  } as unknown as ChunkTestDeps;
}

async function runFully(deps: ChunkTestDeps, req: ManualRunRequest) {
  const planned = await planManualRun(deps, req);
  await finishOrFail(deps, planned);
  const run = (await deps.runStore.listRuns(1))[0]!;
  return { run, planned };
}

const runLog = async (deps: ChunkTestDeps, runId: string) =>
  (await deps.runStore.listLogs(runId)).map((l) => `${l.level} ${l.message}`).join("\n");

test("invariant 1: ADR-043 empty-IPP membership is judged over the COMPLETE roster, never per chunk", async () => {
  // 1,200 subjects, chunk size 500, and the ONLY subject in the IPP is in the last chunk. A per-chunk
  // judgement would warn about chunks 1 and 2. `officialRouting` is REQUIRED — the empty-IPP check is
  // gated on the engine reporting an official logicVersion, and without it the check never fires, so
  // this test would pass against a per-chunk implementation too.
  const deps = makeTestDeps({ chunkSize: 500, subjects: seedSubjects(1200), ippSubjectIds: ["pat-01200"], officialRouting: true });
  const { run } = await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  assert.equal(run.status, "COMPLETED", "ADR-043 warns, it never refuses");
  assert.ok(!/entered the official initial population/i.test(await runLog(deps, run.id)), "one chunk with no IPP member is not an empty roster");
});

test("invariant 1b: a roster with NO ipp member anywhere still warns — the check is not simply disabled", async () => {
  // The negative control. Without it, invariant 1 passes trivially against an implementation that
  // deleted the empty-IPP check outright.
  const deps = makeTestDeps({ chunkSize: 500, subjects: seedSubjects(1200), ippSubjectIds: [], officialRouting: true });
  const { run } = await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  assert.equal(run.status, "COMPLETED");
  assert.match(await runLog(deps, run.id), /entered the official initial population/i, "a genuinely empty IPP is still surfaced");
});

test("invariant 2: a re-run over the same period creates no duplicate case across chunks", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250), ippSubjectIds: [] });
  await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  const afterFirst = (await deps.caseStore!.listCases({ measureId: MEASURE, limit: 100000 })).length;
  assert.ok(afterFirst > 0, "the fixture must actually open cases, or this proves nothing");
  await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  assert.equal((await deps.caseStore!.listCases({ measureId: MEASURE, limit: 100000 })).length, afterFirst);
});

test("invariant 3: a chunk failure finalizes the run ONCE, as FAILED", async () => {
  const ok = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  const { run: okRun } = await runFully(ok, { scopeType: "MEASURE", measureId: MEASURE });
  assert.equal(okRun.status, "COMPLETED");
  assert.equal(ok.auditEvents.filter((e) => e.eventType === "RUN_COMPLETED").length, 1);

  const bad = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250), failOnChunk: 1 });
  const planned = await planManualRun(bad, { scopeType: "MEASURE", measureId: MEASURE });
  await finishOrFail(bad, planned).catch(() => undefined);
  const badRun = (await bad.runStore.listRuns(1))[0]!;
  assert.equal(badRun.status, "FAILED");
  // `failPlannedRun` emits RUN_COMPLETED carrying status FAILED (pre-existing, not this change's
  // doing). What matters is that exactly ONE terminal event is written, not which name it carries.
  assert.equal(bad.auditEvents.filter((e) => e.eventType === "RUN_COMPLETED" || e.eventType === "RUN_FAILED").length, 1);
  // And the chunks before the failure are not silently kept as a partial success.
  assert.deepEqual(bad.counters.recordOutcomesBatchSizes, [100, 100], "the run stopped at the failing chunk");
  // The terminal row states what the run ACTUALLY did before it failed. It used to hardcode zeros —
  // accurate when the only reachable failure was live-population prep, and a false statement in the
  // ledger once a mid-run persist failure became ordinary: 100 outcomes were committed here.
  const terminal = bad.auditEvents.find((e) => e.eventType === "RUN_COMPLETED")!;
  assert.equal(terminal.payload.status, "FAILED");
  assert.equal(terminal.payload.totalEvaluated, 100, "the ledger must not claim nothing was evaluated");
  assert.equal(terminal.payload.plannedTotal, 250, "and it says how much the run had planned to do");
});

test("a chunk that was PARTLY persisted before its store rejected is counted by what is in the store", async () => {
  // The SQLite floor batches in slices of 90 and any adapter may slice; when a later slice fails, the
  // earlier ones are durable and the call still rejects. Advancing `progress.evaluated` only on a
  // returned length put those rows outside the terminal audit — 100 reported here while 140 rows sat
  // in the table (Codex review, #528). The pipeline now recounts from the store on a persist failure.
  const bad = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250), failOnChunk: 1, partialRows: 40 });
  const planned = await planManualRun(bad, { scopeType: "MEASURE", measureId: MEASURE });
  await finishOrFail(bad, planned).catch(() => undefined);
  const badRun = (await bad.runStore.listRuns(1))[0]!;
  assert.equal(badRun.status, "FAILED");
  assert.equal((await bad.outcomeStore.listOutcomes(badRun.id)).length, 140, "the fixture really did leave 140 durable rows");
  const terminal = bad.auditEvents.find((e) => e.eventType === "RUN_COMPLETED")!;
  assert.equal(terminal.payload.totalEvaluated, 140, "the ledger says what the store holds, not what the last successful call returned");
});

/**
 * Opens a case for each of `subjects` at a STRICTLY OLDER evaluation period, which is what the cycle
 * rollover closes at run finish. Seeded through the real store's own upsert rather than an INSERT, so
 * the rows are shaped exactly as the pipeline would have left them last cycle.
 */
async function seedStaleCycleCases(deps: ChunkTestDeps, subjects: EmployeeProfile[], measureId: string): Promise<void> {
  for (const subject of subjects) {
    await deps.caseStore!.upsertFromOutcome({
      runId: crypto.randomUUID(),
      subjectId: subject.externalId,
      measureId,
      evaluationPeriod: "2020-01-01",
      outcomeStatus: "OVERDUE",
    });
  }
}

test("invariant 4: cycle rollover runs ONCE, at run finish, not at a chunk boundary", async () => {
  // Three stale cases and three chunks. A rollover inside the chunk loop would either close each case
  // once per chunk (three CASE_RESOLVED events per case) or close the ones it saw early and re-close
  // them; either way the ledger stops matching what happened. Rollover is a run-finish act because a
  // chunk is an arbitrary slice of the roster and knows nothing about the rest of it.
  const subjects = seedSubjects(250);
  const deps = makeTestDeps({ chunkSize: 100, subjects, ippSubjectIds: [] });
  await seedStaleCycleCases(deps, subjects.slice(0, 3), MEASURE);
  deps.auditEvents.length = 0;

  await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  const rolled = deps.auditEvents.filter((e) => e.payload.reason === "CYCLE_ROLLED_OVER");
  assert.equal(rolled.length, 3, "each stale case rolls over exactly once, not once per chunk");
  assert.deepEqual(
    [...new Set(rolled.map((e) => e.payload.subjectId))].sort(),
    subjects.slice(0, 3).map((s) => s.externalId).sort(),
    "the three rolled-over cases are the three stale ones",
  );
});

test("invariant 5: the active-case snapshot is preloaded ONCE per measure, however many chunks", async () => {
  // TWO per measure is the correct bound, and it is two rather than one because the pipeline queries
  // cases twice per measure for different reasons: the run-start active-case snapshot, and the
  // cycle-rollover sweep at run finish. Neither is per chunk. Five chunks × two measures would be 10
  // preloads if the snapshot moved inside the chunk loop, which is what this discriminates against.
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(500) });
  await runFully(deps, { scopeType: "ALL_PROGRAMS" });
  const measures = new Set(deps.counters.batchCalls.map((c) => c.measureId)).size;
  assert.ok(measures >= 2, "the fixture must run more than one measure for this to discriminate");
  assert.equal(deps.counters.listCasesCalls, measures * 2, `${deps.counters.listCasesCalls} listCases for ${measures} measures over 5 chunks each`);
});

test("invariant 6: the run's counters accumulate across chunks", async () => {
  // `totalEvaluated` alone does NOT test this: it is `items.length`, computed once, and can never be a
  // per-chunk value. The counters genuinely at risk are `compliant`, `nonCompliant` and `failures` —
  // they are incremented inside the loop, so resetting them per chunk would report only the LAST
  // chunk's counts on a 20,000-patient run and every existing test would stay green, because they all
  // fit in one chunk where the reset is a no-op. A mixed IPP is what makes the two numbers differ.
  const subjects = seedSubjects(250);
  const deps = makeTestDeps({
    chunkSize: 100,
    subjects,
    ippSubjectIds: subjects.slice(0, 150).map((s) => s.externalId),
  });
  const { run } = await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  const completed = deps.auditEvents.find((e) => e.eventType === "RUN_COMPLETED")!;
  assert.equal(completed.payload.totalEvaluated, 250);
  assert.equal(completed.payload.compliant, 150, "compliant is the whole run's, not the last chunk's");
  assert.equal(completed.payload.nonCompliant, 100, "nonCompliant is the whole run's, not the last chunk's");
  assert.equal((await deps.outcomeStore.listOutcomes(run.id)).length, 250, "every chunk's outcomes are persisted");
});

test("invariant 7 + memory: each chunk persists before the next is built, and only one chunk's bundles live", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  assert.deepEqual(deps.counters.recordOutcomesBatchSizes, [100, 100, 50], "chunks are persisted as they finish, not all at the end");
  // One bundle per subject per RUN, not per subject per measure and not twice per subject: the
  // pre-pass and the loop both read the chunk's cache.
  assert.equal(deps.counters.bundlesBuilt, 250, `${deps.counters.bundlesBuilt} bundles for 250 subjects`);
  // NOT asserted: that the cache is dropped at the end of each chunk. It is not observable at this
  // boundary — every subject belongs to exactly one chunk, so "built once per subject" reads the same
  // whether the cache dies with its chunk or lives for the whole run, and a harness that released on
  // its own schedule would be measuring itself. What bounds memory and IS observable is asserted
  // instead: the pre-pass is sized to the chunk (below) and each subject is built once (above).
});

test("a multi-measure run builds ONE bundle per subject, not one per subject per measure", async () => {
  // The reason `bundleForSubject` exists. At the pilot's five measures a full-record bundle rebuilt per
  // measure is five times the work and five times the peak.
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(200) });
  await runFully(deps, { scopeType: "ALL_PROGRAMS" });
  const measures = new Set(deps.counters.batchCalls.map((c) => c.measureId)).size;
  assert.ok(measures >= 2);
  assert.equal(deps.counters.bundlesBuilt, 200, `${deps.counters.bundlesBuilt} bundles for 200 subjects × ${measures} measures`);
});

test("the batch pre-pass is per chunk — a measure is batched once per chunk over that chunk's subjects", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  assert.deepEqual(
    deps.counters.batchCalls,
    [{ measureId: MEASURE, size: 100 }, { measureId: MEASURE, size: 100 }, { measureId: MEASURE, size: 50 }],
    "one batch per measure per chunk, sized to the chunk",
  );
});

test("an unset chunk size still runs the whole roster, in one chunk", async () => {
  // The default must not change behaviour for the 150-subject deployments already in production.
  const deps = makeTestDeps({ chunkSize: 500, subjects: seedSubjects(150) });
  delete process.env.WORKWELL_RUN_CHUNK_SIZE;
  const { run } = await runFully(deps, { scopeType: "MEASURE", measureId: OTHER });
  assert.equal((await deps.outcomeStore.listOutcomes(run.id)).length, 150);
  assert.deepEqual(deps.counters.recordOutcomesBatchSizes, [150]);
});
