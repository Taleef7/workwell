/**
 * Audit-backed CampaignStore (#75 E5): recordCampaign writes an OUTREACH_CAMPAIGN_COMPLETED audit
 * event; list/get/listRecipients read it back, newest-first.
 *   node --import tsx --test src/stores/audit-campaign-store.test.ts
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./sqlite/schema.ts";
import { SqliteCaseEventStore } from "./sqlite/case-event-store-sqlite.ts";
import { AuditBackedCampaignStore } from "./audit-campaign-store.ts";
import type { CampaignRecord, CampaignRecipientRecord } from "./campaign-store.ts";

const dbPath = join(tmpdir(), `workwell-camp-${crypto.randomUUID()}.sqlite`);
let store: AuditBackedCampaignStore;

const mkCampaign = (id: string): CampaignRecord => ({
  id, channel: "SMS", measureId: "audiogram", site: null, outcomeStatus: "OVERDUE", templateId: null,
  status: "COMPLETED", total: 2, sent: 2, failed: 0, simulated: 2, createdBy: "admin", createdAt: new Date().toISOString(),
});
const mkRecipient = (campaignId: string, caseId: string): CampaignRecipientRecord => ({
  campaignId, caseId, employeeId: "emp-006", employeeName: "Omar Siddiq", channel: "SMS",
  toAddress: "sms:emp-006", status: "SIMULATED", messageId: "sim-sms-1", sentAt: new Date().toISOString(),
});

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  store = new AuditBackedCampaignStore(new SqliteCaseEventStore(db));
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("recordCampaign round-trips through list/get/listRecipients", async () => {
  await store.recordCampaign(mkCampaign("c1"), [mkRecipient("c1", "case-1"), mkRecipient("c1", "case-2")]);
  const list = await store.listCampaigns();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, "c1");
  assert.equal(list[0]!.total, 2);
  const got = await store.getCampaign("c1");
  assert.equal(got?.channel, "SMS");
  const recips = await store.listRecipients("c1");
  assert.equal(recips.length, 2);
  assert.equal(recips[0]!.employeeName, "Omar Siddiq");
});

test("listCampaigns is newest-first and getCampaign returns null for unknown id", async () => {
  await store.recordCampaign(mkCampaign("c2"), [mkRecipient("c2", "case-3")]);
  const list = await store.listCampaigns();
  assert.equal(list[0]!.id, "c2", "newest first");
  assert.equal(await store.getCampaign("nope"), null);
  assert.deepEqual(await store.listRecipients("nope"), []);
});

test("non-campaign audit events are excluded (no undefined entries)", async () => {
  // Fresh store + db so this is independent of the other tests' ordering/state.
  const isoPath = join(tmpdir(), `workwell-camp-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(isoPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const events = new SqliteCaseEventStore(db);
  const isoStore = new AuditBackedCampaignStore(events);

  // A foreign (non-campaign) audit event with a different payload shape.
  await events.appendAudit({
    eventType: "CASE_ASSIGNED", entityType: "case", entityId: "case-x", actor: "admin",
    refRunId: null, refCaseId: "case-x", refMeasureVersionId: null, payload: { foo: "bar" },
  });
  // One real campaign alongside it.
  await isoStore.recordCampaign(mkCampaign("c3"), [mkRecipient("c3", "case-9")]);

  const list = await isoStore.listCampaigns();
  assert.equal(list.length, 1, "foreign event excluded");
  assert.ok(list.every((c) => !!c?.id), "no undefined campaign entries");
  assert.equal(list[0]!.id, "c3");

  try { rmSync(isoPath, { force: true }); } catch { /* best effort */ }
});
