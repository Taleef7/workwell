/**
 * A `next_action` that changes under an unchanged status is a state change, and is audited (MM-1 U3
 * review finding; ADR-074 d13).
 *
 * Before the rate-aware wording, `next_action` was a function of (status, measure) alone, so a
 * re-confirmed OVERDUE really was UNCHANGED and the pipeline rightly wrote no audit event for it. Now a
 * cms137 patient who moves from not-initiated to initiated-not-engaged stays OVERDUE while the persisted
 * `next_action` moves from the initiation wording to the engagement wording — a real clinical change
 * that the store must report as UPDATED, so the pipeline's `CASE_UPDATED` event records it. A genuine
 * re-confirm (same wording) stays UNCHANGED, so a nightly run still records one event, not thousands.
 *
 *   WORKWELL_OFFICIAL_MEASURES=cms137 node --import tsx --test src/stores/case-store-next-action.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./sqlite/schema.ts";
import { SqliteCaseStore } from "./sqlite/case-store-sqlite.ts";
import { SqliteRunStore } from "./sqlite/run-store-sqlite.ts";

const previousRouting = process.env.WORKWELL_OFFICIAL_MEASURES;
process.env.WORKWELL_OFFICIAL_MEASURES = "cms122,cms125,cms137";

const dbPath = join(tmpdir(), `workwell-case-next-action-${crypto.randomUUID()}.sqlite`);
let store: SqliteCaseStore;
let runId: string;

const rate = (numer: boolean) => [
  { populationType: "initial-population", result: true },
  { populationType: "denominator", result: true },
  { populationType: "numerator", result: numer },
];
const evidenceWithRates = (r1: boolean, r2: boolean) => ({
  expressionResults: [],
  official: { ecqmId: "CMS137", populationResults: rate(r1), rates: [rate(r1), rate(r2)] },
});
const NOT_INITIATED = evidenceWithRates(false, false);
const NOT_ENGAGED = evidenceWithRates(true, false);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  store = new SqliteCaseStore(db);
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "cms137",
    triggeredBy: "test",
    requestedScope: { measureId: "cms137" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-12-31T00:00:00.000Z",
  });
  runId = run.id;
});
after(() => {
  if (previousRouting === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
  else process.env.WORKWELL_OFFICIAL_MEASURES = previousRouting;
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

const key = { runId: "", subjectId: "pat-001", measureId: "cms137", evaluationPeriod: "2026-01-01", outcomeStatus: "OVERDUE" };

test("a re-confirmed OVERDUE whose rate-aware next_action moved is UPDATED, not UNCHANGED; a true re-confirm stays UNCHANGED", async () => {
  const created = await store.upsertFromOutcome({ ...key, runId, evidence: NOT_INITIATED });
  assert.equal(created?.disposition, "CREATED");
  assert.match(String(created!.nextAction), /not initiated within 14 days/i);

  const reconfirmed = await store.upsertFromOutcome({ ...key, runId, evidence: NOT_INITIATED });
  assert.equal(reconfirmed?.disposition, "UNCHANGED", "same status, same wording: refreshed silently");

  const moved = await store.upsertFromOutcome({ ...key, runId, evidence: NOT_ENGAGED });
  assert.equal(moved?.disposition, "UPDATED", "same status, different next_action: a state change the pipeline must audit");
  assert.match(String(moved!.nextAction), /engagement/i);
  assert.equal(moved!.status, "OPEN");

  const again = await store.upsertFromOutcome({ ...key, runId, evidence: NOT_ENGAGED });
  assert.equal(again?.disposition, "UNCHANGED");
});
