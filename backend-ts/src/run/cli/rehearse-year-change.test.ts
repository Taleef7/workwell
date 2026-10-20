/**
 * The year-change rehearsal (#854): its refusals, and a 31 December nightly followed by a 1 January one.
 *
 *   node --import tsx --test src/run/cli/rehearse-year-change.test.ts
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import type { EvaluateMeasureBinding } from "@work-well/measure-engine";
import { RUN_STORE_FLOOR_DDL } from "../../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseStore } from "../../stores/sqlite/case-store-sqlite.ts";
import { SqliteCaseEventStore } from "../../stores/sqlite/case-event-store-sqlite.ts";
import type { Stores } from "../../stores/factory.ts";
import { EMPLOYEES } from "../../engine/synthetic/employee-catalog.ts";
import { RUNNABLE_MEASURE_IDS } from "../../config/deployment-profile.ts";
import { parseArgs, refusalFor, rehearse, render, RehearsalUsageError } from "./rehearse-year-change.ts";

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

const overdueEngine: EvaluateMeasureBinding = {
  evaluate: async (input) => ({ subjectId: "s", measure: input.measureId, outcome: "OVERDUE" as const, evidence: { expressionResults: [] } }),
};

async function freshStores(): Promise<Stores> {
  const dbPath = join(tmpdir(), `workwell-rehearsal-${crypto.randomUUID()}.sqlite`);
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

test("the arguments: a date and the host are both required, and nothing else is accepted", () => {
  assert.deepEqual(parseArgs(["--evaluation-date", "2027-01-01", "--confirm-host", "db.test"]), {
    evaluationDate: "2027-01-01",
    confirmHost: "db.test",
    out: null,
  });
  assert.throws(() => parseArgs(["--confirm-host", "db.test"]), RehearsalUsageError);
  assert.throws(() => parseArgs(["--evaluation-date", "2027-1-1", "--confirm-host", "db.test"]), RehearsalUsageError);
  for (const impossible of ["2027-02-29", "2027-02-30", "2027-13-01", "2027-04-31"]) {
    assert.throws(() => parseArgs(["--evaluation-date", impossible, "--confirm-host", "db.test"]), RehearsalUsageError, impossible);
  }
  assert.equal(parseArgs(["--evaluation-date", "2028-02-29", "--confirm-host", "db.test"]).evaluationDate, "2028-02-29", "a leap day is real");
  assert.throws(() => parseArgs(["--evaluation-date", "2027-01-01"]), RehearsalUsageError);
  assert.throws(() => parseArgs(["--evaluation-date", "2027-01-01", "--confirm-host", "db.test", "--force"]), RehearsalUsageError);
});

test("the environment: refused without a Postgres URL, on a host it was not told, and with a WebChart tenant", () => {
  const url = "postgres://u:p@ep-copy-123.us-east-2.aws.neon.tech/neondb";
  assert.match(refusalFor({}, "x")!, /DATABASE_URL is not set/);
  assert.match(refusalFor({ DATABASE_URL: url }, "ep-live-456.us-east-2.aws.neon.tech")!, /does not match/);
  assert.match(
    refusalFor({ DATABASE_URL: url, WORKWELL_WEBCHART_BASE_URL: "http://webchart.test", WORKWELL_WEBCHART_API_KEY: "k" }, "ep-copy-123.us-east-2.aws.neon.tech")!,
    /WebChart tenant/,
  );
  assert.equal(refusalFor({ DATABASE_URL: url }, "ep-copy-123.us-east-2.aws.neon.tech"), null);
});

test("31 December opens the year's cases; 1 January closes each calendar-year one as rolled over, audited, and opens the new year's", async () => {
  const stores = await freshStores();
  const deps = { stores, engine: overdueEngine, segments: [], employees: EMPLOYEES.slice(0, 3) };

  const december = await rehearse(deps, "2026-12-31", RUNNABLE_MEASURE_IDS);
  assert.equal(december.rollover, null, "nothing older to close on the old year's last day");
  const openIn = new Map(december.measures.map((m) => [m.measureId, m.activeAfter.current]));
  assert.ok([...openIn.values()].every((n) => n > 0), "the old year's nightly opened every measure's cases");

  const january = await rehearse(deps, "2027-01-01", RUNNABLE_MEASURE_IDS);
  assert.equal(january.status, "COMPLETED");
  // A measure whose cycle does not turn on 1 January (a flu season) keeps its cases; every other rolls over.
  const turned = january.measures.filter((m) => m.period !== december.measures.find((d) => d.measureId === m.measureId)!.period);
  const kept = january.measures.filter((m) => !turned.includes(m));
  assert.ok(turned.length > 0 && kept.length > 0, "the fixture holds both kinds");
  const rolled = turned.reduce((n, m) => n + openIn.get(m.measureId)!, 0);
  assert.deepEqual(january.rollover && { ...january.rollover, ms: 0 }, { closed: rolled, failed: 0, auditGaps: 0, unreadMeasures: [], ms: 0 });
  assert.equal(january.rolledOverAudited, rolled);
  for (const m of turned) {
    assert.equal(m.activeBefore.otherCycles, openIn.get(m.measureId), `${m.measureId}: the old year's cases are in another cycle`);
    assert.equal(m.activeAfter.otherCycles, 0, `${m.measureId}: no old-year case is left open`);
    assert.ok(m.activeAfter.current > 0, `${m.measureId}: the new year's cases are open`);
  }
  for (const m of kept) assert.equal(m.activeAfter.current, openIn.get(m.measureId), `${m.measureId}: its cycle did not turn`);
  assert.ok(january.checks.every((c) => c.ok), render(january));
  assert.match(render(january), new RegExp(`rollover: ${rolled} closed`));
});
