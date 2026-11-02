/**
 * The earlier-cycle marker (#882).
 *
 *   node --import tsx --test src/run/earlier-cycle.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import type { Stores } from "../stores/factory.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { runNightlyRecompute } from "../admin/scheduler.ts";
import { runtimeHealth } from "../admin/runtime-health.ts";
import { executeRerun } from "./run-pipeline.ts";
import { earlierCycleMeasures, earlierCycleScope, isEarlierCycleRun, withoutServerScopeKeys } from "./earlier-cycle.ts";
import { latestRunRows } from "../program/rollup-shared.ts";
import { latestRunsFromRows } from "../test-support/latest-runs.ts";
import type { OutcomeWithRun } from "../stores/outcome-store.ts";

test("a run is marked only when some measure scores a cycle that had ended on the day it was planned", () => {
  assert.deepEqual(earlierCycleScope(["cms122", "cms165"], "2026-12-31", "2027-01-04"), { earlierCycle: true });
  assert.deepEqual(earlierCycleMeasures(["cms122", "cms165", "cms122"], "2026-12-31", "2027-01-04"), ["cms122", "cms165"]);
  // The 31 December nightly, planned on 31 December: the current cycle.
  assert.deepEqual(earlierCycleScope(["cms122"], "2026-12-31", "2026-12-31"), {});
  // The first 2027 nightly, and a rehearsal dated ahead of the clock.
  assert.deepEqual(earlierCycleScope(["cms122"], "2027-01-01", "2027-01-01"), {});
  assert.deepEqual(earlierCycleScope(["cms122"], "2027-01-01", "2026-11-02"), {});
});

test("only the JSON boolean true is the marker", () => {
  assert.equal(isEarlierCycleRun({ requestedScope: { earlierCycle: true } }), true);
  for (const value of ["true", 1, "1", false, null, undefined, {}]) {
    assert.equal(isEarlierCycleRun({ requestedScope: { earlierCycle: value } }), false, JSON.stringify(value));
  }
  assert.equal(isEarlierCycleRun({ requestedScope: null }), false);
  assert.equal(isEarlierCycleRun(null), false);
});

test("a client's today and marker are dropped; everything else it asked for is kept", () => {
  assert.deepEqual(
    withoutServerScopeKeys({ evaluationDate: "2026-12-31", measureId: "cms122", today: "2030-01-01", earlierCycle: false }),
    { evaluationDate: "2026-12-31", measureId: "cms122" },
  );
});

const row = (runId: string, runStartedAt: string, marked = false): OutcomeWithRun => ({
  runId,
  runStartedAt,
  runScopeType: "ALL_PROGRAMS",
  runStatus: "COMPLETED",
  runTriggeredBy: "scheduler",
  subjectId: "pat-001",
  measureId: "cms122",
  status: "OVERDUE",
  ...(marked ? { runEarlierCycle: true as const } : {}),
});

test("the JS reductions over run rows never pick a marked run, however recent", () => {
  const nightly = row("nightly-2027", "2027-01-04T12:00:00.000Z");
  const rescore = row("rescore-2026", "2027-01-04T20:00:00.000Z", true);
  assert.deepEqual(latestRunRows([nightly, rescore]).map((r) => r.runId), ["nightly-2027"]);
  assert.deepEqual(latestRunRows([rescore]), []);
});

test("the fake store's latest-run reduction skips a marked run, as the stores' SQL does", async () => {
  const winners = await latestRunsFromRows([
    row("nightly-2027", "2027-01-04T12:00:00.000Z"),
    row("rescore-2026", "2027-01-04T20:00:00.000Z", true),
  ])(["cms122"], {});
  assert.deepEqual(winners.map((w) => w.runId), ["nightly-2027"]);
});

// ---- the pipeline: the lead's January re-score, before and after the first 2027 nightly ----------

const dbPaths: string[] = [];
after(() => {
  for (const p of dbPaths) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort: Windows keeps the file locked while the handle is open
    }
  }
});

async function freshStores(): Promise<Stores> {
  const dbPath = join(tmpdir(), `workwell-earlier-cycle-${crypto.randomUUID()}.sqlite`);
  dbPaths.push(dbPath);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return {
    runs: new SqliteRunStore(db),
    outcomes: new SqliteOutcomeStore(db),
    cases: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
  } as unknown as Stores;
}

/** OVERDUE for everyone but the subjects in `compliant`, read off the bundle's Patient. */
const engineWith = (compliant: ReadonlySet<string>): EvaluateMeasureBinding => ({
  evaluate: async (input) => {
    const bundle = input.patientBundle as { entry?: Array<{ resource?: { resourceType?: string; id?: string } }> };
    const id = bundle.entry?.find((e) => e.resource?.resourceType === "Patient")?.resource?.id ?? "";
    const outcome = compliant.has(id) ? ("COMPLIANT" as const) : ("OVERDUE" as const);
    return { subjectId: id, measure: input.measureId, outcome, evidence: { expressionResults: [] } };
  },
});

test("a re-score of 2026 in January opens nothing, still resolves an active case found compliant, and is nobody's latest", async () => {
  const stores = await freshStores();
  const [kept, cleared, unseen] = [EMPLOYEES[0]!, EMPLOYEES[1]!, EMPLOYEES[2]!];
  const nightly = (engine: EvaluateMeasureBinding, employees: typeof EMPLOYEES, evaluationDate: string, today: string) =>
    runNightlyRecompute({ stores, engine, segments: [], employees, evaluationDate, today });

  // 31 December: the year's last nightly, planned on its own day, opens both patients' 2026 cases.
  const december = await nightly(engineWith(new Set()), [kept, cleared], "2026-12-31", "2026-12-31");
  const decemberRun = (await stores.runs.getRun(december))!;
  assert.equal(decemberRun.requestedScope.today, "2026-12-31", "the server's date is saved on the run");
  assert.equal(isEarlierCycleRun(decemberRun), false, "a run of the current cycle is not marked");
  const openAfterDecember = (await stores.cases.listCases({ limit: 100_000 })).filter((c) => c.status === "OPEN");
  assert.ok(openAfterDecember.length > 0);
  const sufficiencyBefore = runtimeHealth().lastPopulationRun;
  assert.equal(sufficiencyBefore?.runId, december);

  // 4 January, before any 2027 nightly has run: the lead re-scores 2026. `cleared`'s late record has
  // arrived; `unseen` was never scored before.
  const rescore = await nightly(engineWith(new Set([cleared.externalId])), [kept, cleared, unseen], "2026-12-31", "2027-01-04");
  const rescoreRun = (await stores.runs.getRun(rescore))!;
  assert.equal(isEarlierCycleRun(rescoreRun), true, "the re-score is marked");
  const completed = (await stores.events.auditEventsByRun(rescore)).find((a) => a.eventType === "RUN_COMPLETED")!;
  const earlier = completed.payload.earlierCycle as string[];
  assert.ok(earlier.length > 0, "the audit names the measures scored over a cycle that had ended");
  assert.deepEqual([...earlier].sort(), earlier);
  assert.ok((await stores.outcomes.listOutcomes(rescore)).length > 0, "its outcomes are recorded");

  const cases = await stores.cases.listCases({ limit: 100_000 });
  const of = (subject: string, measureId: string) => cases.filter((c) => c.employeeId === subject && c.measureId === measureId);
  for (const measureId of earlier) {
    assert.deepEqual(of(unseen.externalId, measureId), [], `${measureId}: no case is opened in a cycle that has ended`);
    for (const c of of(cleared.externalId, measureId)) {
      assert.equal(c.status, "RESOLVED", `${measureId}: an active case found compliant still resolves`);
      assert.equal(c.closedReason, "AUTO_RESOLVED");
    }
    for (const c of of(kept.externalId, measureId)) assert.equal(c.status, "OPEN", `${measureId}: a gap stays open`);
  }
  assert.equal(runtimeHealth().lastPopulationRun?.runId, december, "/health still describes the last current-cycle run");
  const winners = await stores.outcomes.listLatestPopulationRuns(earlier, {});
  assert.deepEqual(new Set(winners.map((w) => w.runId)), new Set([december]), "every latest read stays on December's run");

  // The first 2027 nightly rolls 2026 over; a second re-score then reopens nothing.
  await nightly(engineWith(new Set()), [kept, cleared, unseen], "2027-01-05", "2027-01-05");
  const again = await nightly(engineWith(new Set()), [kept, cleared, unseen], "2026-12-31", "2027-01-06");
  const audits = await stores.events.auditEventsByRun(again);
  assert.deepEqual(
    audits.filter((a) => a.eventType === "CASE_CREATED" || (a.eventType === "CASE_UPDATED" && a.payload.disposition === "REOPENED")),
    [],
    "a rolled-over 2026 case found in a gap is not reopened",
  );
  const active2026 = (await stores.cases.listCases({ limit: 100_000 })).filter(
    (c) => earlier.includes(c.measureId) && c.evaluationPeriod.startsWith("2026") && (c.status === "OPEN" || c.status === "IN_PROGRESS"),
  );
  assert.deepEqual(active2026, []);

  // "Rerun same scope" of the 31 December run, from January: planned afresh, so marked afresh.
  const rerun = await executeRerun(
    { runStore: stores.runs, outcomeStore: stores.outcomes, caseStore: stores.cases, engine: engineWith(new Set()) as never, segments: [], employees: [kept], events: stores.events, today: "2027-01-06" },
    december,
  );
  assert.equal(isEarlierCycleRun(await stores.runs.getRun(rerun.runId)), true);
});
