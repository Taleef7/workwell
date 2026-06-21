/**
 * Case outreach dispatch test (#75 E5) — the channel-aware `dispatchOutreach` core behind
 * `sendOutreach`. Seeds a case + its outcome on the SQLite floor, then asserts the recorded
 * OUTREACH_SENT action payload: EMAIL is the default (unchanged behavior), and an explicit
 * "SMS" channel is carried through to the payload.
 *   node --import tsx --test src/case/case-outreach.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { sendOutreach, type OutreachDeps } from "./case-outreach.ts";

const dbPath = join(tmpdir(), `workwell-outreach-${crypto.randomUUID()}.sqlite`);
let db: Awaited<ReturnType<typeof createSqliteD1>>;
let deps: OutreachDeps;

/** Seed a fresh OVERDUE audiogram case (its own run) + evidence, returning its case id. */
async function freshCase(subjectId: string): Promise<string> {
  const run = await new SqliteRunStore(db).createRun({
    scopeType: "MEASURE",
    scopeId: "audiogram",
    triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z",
    measurementPeriodEnd: "2026-01-01T00:00:00.000Z",
  });
  const c = await new SqliteCaseStore(db).upsertFromOutcome({
    runId: run.id,
    subjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-01-01",
    outcomeStatus: "OVERDUE",
  });
  await new SqliteOutcomeStore(db).recordOutcome({
    runId: run.id,
    subjectId,
    measureId: "audiogram",
    evaluationPeriod: "2026-01-01",
    status: "OVERDUE",
    evidence: {
      expressionResults: [
        { define: "Has Active Waiver", result: false },
        { define: "Most Recent Audiogram Date", result: "2025-04-19T00:00:00.000Z" },
        { define: "Days Since Last Audiogram", result: 420 },
        { define: "Outcome Status", result: "OVERDUE" },
      ],
    },
  });
  return c!.id;
}

/** The latest outreach action payload from the (audit-sourced) timeline. The case_action payload
 *  rides under the CASE_OUTREACH_SENT audit event's `payload.action` (case-outreach.ts). */
async function latestOutreachAction(caseId: string): Promise<Record<string, unknown>> {
  const timeline = await deps.events.caseTimeline(caseId);
  const sent = timeline.filter((t) => t.eventType === "CASE_OUTREACH_SENT").at(-1);
  assert.ok(sent, "a CASE_OUTREACH_SENT audit event exists");
  return (sent!.payload.action as Record<string, unknown>) ?? {};
}

before(async () => {
  db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  deps = {
    cases: new SqliteCaseStore(db),
    events: new SqliteCaseEventStore(db),
    outcomes: new SqliteOutcomeStore(db),
  };
});

after(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {
    /* best effort */
  }
});

test("sendOutreach defaults to EMAIL: payload carries channel=EMAIL + simulated provider; case OPEN", async () => {
  const caseId = await freshCase("emp-100");
  const detail = await sendOutreach(deps, caseId, "cm@workwell.dev");
  assert.ok(detail, "detail returned for an existing case");
  assert.equal(detail!.status, "OPEN");
  assert.equal(detail!.latestOutreachDeliveryStatus, "SIMULATED");

  const payload = await latestOutreachAction(caseId);
  assert.equal(payload.channel, "EMAIL", "default channel is EMAIL (was hardcoded SIMULATED_EMAIL)");
  assert.equal(payload.deliveryProvider, "simulated");
  assert.equal(payload.toAddress, "emp-100@workwell-demo.dev", "EMAIL address shape unchanged");
});

test("sendOutreach with channel=SMS records channel=SMS + simulated provider; case OPEN", async () => {
  const caseId = await freshCase("emp-101");
  const detail = await sendOutreach(deps, caseId, "cm@workwell.dev", null, "SMS");
  assert.ok(detail, "detail returned for an existing case");
  assert.equal(detail!.status, "OPEN");

  const payload = await latestOutreachAction(caseId);
  assert.equal(payload.channel, "SMS");
  assert.equal(payload.deliveryProvider, "simulated");
  assert.equal(payload.toAddress, "sms:emp-101", "SMS address shape");
});
