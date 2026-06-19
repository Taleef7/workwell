/**
 * Campaign engine (#75 E5): recipient resolution honors measure/site/outcome; dryRun sends nothing;
 * a real run dispatches per recipient, tallies counts (sent+failed===total), and persists.
 *   node --import tsx --test src/case/outreach-campaign.test.ts
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
import { AuditBackedCampaignStore } from "../stores/audit-campaign-store.ts";
import { runCampaign, listCampaigns, getCampaignDetail, type CampaignDeps } from "./outreach-campaign.ts";

const dbPath = join(tmpdir(), `workwell-campeng-${crypto.randomUUID()}.sqlite`);
let deps: CampaignDeps;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const cases = new SqliteCaseStore(db);
  const events = new SqliteCaseEventStore(db);
  deps = { cases, events, outcomes, campaigns: new AuditBackedCampaignStore(events) };
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  // OPEN OVERDUE audiogram cases: emp-006 + emp-010 (Plant A), emp-001 (HQ).
  for (const s of ["emp-006", "emp-010", "emp-001"]) {
    await outcomes.recordOutcome({ runId: run.id, subjectId: s, measureId: "audiogram", status: "OVERDUE", evidence: {} });
    await cases.upsertFromOutcome({ runId: run.id, subjectId: s, measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  }
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("dryRun resolves recipients (measure+outcome filter) and sends nothing", async () => {
  const res = await runCampaign(deps, { measureId: "audiogram", outcomeStatus: "OVERDUE", channel: "SMS", dryRun: true }, "admin");
  assert.equal(res.dryRun, true);
  assert.equal(res.campaignId, null);
  assert.equal(res.total, 3);
  assert.equal(res.recipients.every((r) => r.status === "PREVIEW"), true);
  assert.equal((await listCampaigns(deps)).length, 0, "no campaign persisted on dryRun");
});

test("site filter narrows recipients (Plant A → 2)", async () => {
  const res = await runCampaign(deps, { measureId: "audiogram", site: "Plant A", channel: "SMS", dryRun: true }, "admin");
  assert.equal(res.total, 2);
});

test("a real run dispatches per recipient, tallies counts, and persists", async () => {
  const res = await runCampaign(deps, { measureId: "audiogram", outcomeStatus: "OVERDUE", channel: "SMS" }, "admin");
  assert.equal(res.dryRun, false);
  assert.ok(res.campaignId);
  assert.equal(res.total, 3);
  assert.equal(res.sent, 3);
  assert.equal(res.failed, 0);
  assert.equal(res.simulated, 3);
  assert.equal(res.sent + res.failed, res.total);
  const list = await listCampaigns(deps);
  assert.equal(list.length, 1);
  const detail = await getCampaignDetail(deps, res.campaignId!);
  assert.equal(detail?.recipients.length, 3);
  assert.equal(detail?.campaign.channel, "SMS");
});
