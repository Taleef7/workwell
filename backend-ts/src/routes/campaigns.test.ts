/**
 * Campaign route (#75 E5): POST /api/campaigns (dryRun + real), GET list, GET :id, 400 on bad channel.
 *   node --import tsx --test src/routes/campaigns.test.ts
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
import { handleCampaigns } from "./campaigns.ts";

const dbPath = join(tmpdir(), `workwell-camproute-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const actor = "admin";
const post = (body: unknown, qs = "") =>
  handleCampaigns(new Request(`http://x/api/campaigns${qs}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env as never, actor);
const get = (path = "") => handleCampaigns(new Request(`http://x/api/campaigns${path}`, { method: "GET" }), env as never, actor);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const cases = new SqliteCaseStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "t", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  for (const s of ["emp-006", "emp-010"]) {
    await outcomes.recordOutcome({ runId: run.id, subjectId: s, measureId: "audiogram", status: "OVERDUE", evidence: {} });
    await cases.upsertFromOutcome({ runId: run.id, subjectId: s, measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
  }
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("POST dryRun previews recipients, persists nothing", async () => {
  const res = await post({ measureId: "audiogram", channel: "SMS", dryRun: true });
  assert.equal(res?.status, 200);
  const body = (await res!.json()) as { dryRun: boolean; total: number; campaignId: string | null };
  assert.equal(body.dryRun, true);
  assert.equal(body.total, 2);
  assert.equal(body.campaignId, null);
  assert.equal(((await get().then((r) => r!.json())) as unknown[]).length, 0);
});

test("POST real run sends + persists; GET list + GET :id reflect it", async () => {
  const res = await post({ measureId: "audiogram", channel: "SMS" });
  const body = (await res!.json()) as { campaignId: string; total: number; sent: number };
  assert.equal(body.total, 2);
  assert.equal(body.sent, 2);
  const list = (await get().then((r) => r!.json())) as Array<{ id: string }>;
  assert.equal(list.length, 1);
  const detail = await get(`/${body.campaignId}`);
  assert.equal(detail?.status, 200);
  const d = (await detail!.json()) as { campaign: { id: string }; recipients: unknown[] };
  assert.equal(d.campaign.id, body.campaignId);
  assert.equal(d.recipients.length, 2);
});

test("bad channel → 400; unknown id → 404; non-handled path → null", async () => {
  assert.equal((await post({ measureId: "audiogram", channel: "FAX" }))?.status, 400);
  assert.equal((await get("/nope"))?.status, 404);
  assert.equal(await handleCampaigns(new Request("http://x/api/other", { method: "GET" }), env as never, actor), null);
});
