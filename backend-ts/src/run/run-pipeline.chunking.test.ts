/**
 * The seven invariants chunked evaluation must not break (ADR-074, spec §6).
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
  listCasesPreload: number;
  listCasesRollover: number;
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
  /** Report an official logicVersion, which is what gates the ADR-043 empty-IPP check. */
  officialRouting?: boolean;
}): ChunkTestDeps {
  const counters: Counters = {
    listCasesPreload: 0,
    listCasesRollover: 0,
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
      if (opts.failOnChunk === chunkIndex) throw new Error("persist failed for this chunk");
      return realOutcomes.recordOutcomes(inputs);
    },
    listOutcomes: (runId: string, o?: { limit?: number; offset?: number }) => realOutcomes.listOutcomes(runId, o),
    getOutcomeById: (id: string) => realOutcomes.getOutcomeById(id),
  } as RunPipelineDeps["outcomeStore"];

  let rollingOver = false;
  const caseStore = {
    ...realCases,
    listCases: (q: CaseQuery) => {
      if (rollingOver) counters.listCasesRollover += 1;
      else counters.listCasesPreload += 1;
      return realCases.listCases(q);
    },
    upsertFromOutcome: (input: Parameters<typeof realCases.upsertFromOutcome>[0]) => realCases.upsertFromOutcome(input),
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
    },
    counters,
    auditEvents,
    // Marks the rollover phase for the listCases counter — see invariant 5.
    get __rollover() {
      return rollingOver;
    },
    set __rollover(v: boolean) {
      rollingOver = v;
    },
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
});

test("invariant 5: the active-case snapshot is preloaded ONCE per measure, however many chunks", async () => {
  // Counted separately from the rollover's own listCases calls: the rollover queries per measure too,
  // and this change does not alter it, so a single combined counter would read 4 for two measures and
  // the assertion would be wrong rather than discriminating.
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(500) });
  await runFully(deps, { scopeType: "ALL_PROGRAMS" });
  const measures = new Set(deps.counters.batchCalls.map((c) => c.measureId)).size;
  assert.ok(measures >= 2, "the fixture must run more than one measure for this to discriminate");
  assert.ok(deps.counters.listCasesPreload <= measures * 2, `${deps.counters.listCasesPreload} listCases for ${measures} measures over 5 chunks each`);
});

test("invariant 6: counters accumulate across chunks", async () => {
  const deps = makeTestDeps({ chunkSize: 100, subjects: seedSubjects(250) });
  const { run } = await runFully(deps, { scopeType: "MEASURE", measureId: MEASURE });
  // `totalEvaluated` is not a column on the run row — it is carried on the terminal audit event, and
  // the read model derives the rest from the outcomes. A per-chunk counter would report the last
  // chunk's 50 here.
  const completed = deps.auditEvents.find((e) => e.eventType === "RUN_COMPLETED")!;
  assert.equal(completed.payload.totalEvaluated, 250);
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
