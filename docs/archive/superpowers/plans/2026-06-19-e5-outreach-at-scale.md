# E5 — Outreach at Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-channel outreach (email/SMS/phone, simulated) + batch campaigns, behind clean ports, with a DataChaser stub — simulated by default, no schema today.

**Architecture:** An `OutreachChannel` port with simulated email/SMS/phone adapters + an inert DataChaser stub, selected by `resolveChannel(type, env)` (simulated unless configured). The per-case send is refactored so a shared `dispatchOutreach` core powers both single-case and campaign sends. Campaigns persist behind a `CampaignStore` port whose demo adapter is **audit-backed** (writes/reads an `OUTREACH_CAMPAIGN_COMPLETED` audit event — no DDL on floor or ceiling); a Pg `outreach_campaigns`/`outreach_delivery_log` adapter + owner migration is the documented drop-in.

**Tech Stack:** TypeScript (`backend-ts`, node:test + tsx), `@mieweb/cloud` worker routes, SQLite floor for tests, Next.js 16 App Router + React 19 (frontend).

**Branch:** `feat/issue-75-outreach-at-scale` (already created).

**Spec:** `docs/superpowers/specs/2026-06-19-e5-outreach-at-scale-design.md`

---

## File Structure

- `backend-ts/src/case/outreach-channel.ts` — **create**: `ChannelType`, `OutreachMessage`, `OutreachDeliveryRecord`, `OutreachChannel`, simulated adapters, DataChaser stub, `resolveChannel`.
- `backend-ts/src/case/outreach-channel.test.ts` — **create**.
- `backend-ts/src/case/case-outreach.ts` — **modify**: extract `dispatchOutreach`; channel-aware send; optional `channels` resolver in deps.
- `backend-ts/src/case/case-outreach.test.ts` — **modify** (keep green; adjust only assertions changed by channel generalization).
- `backend-ts/src/stores/campaign-store.ts` — **create**: `CampaignStore` interface + record types.
- `backend-ts/src/stores/audit-campaign-store.ts` — **create**: `AuditBackedCampaignStore`.
- `backend-ts/src/stores/audit-campaign-store.test.ts` — **create**.
- `backend-ts/src/stores/factory.ts` — **modify**: add `campaigns: CampaignStore` to both store sets.
- `backend-ts/src/case/outreach-campaign.ts` — **create**: `runCampaign`/`listCampaigns`/`getCampaignDetail`.
- `backend-ts/src/case/outreach-campaign.test.ts` — **create**.
- `backend-ts/src/routes/campaigns.ts` — **create**: the campaign route.
- `backend-ts/src/routes/campaigns.test.ts` — **create**.
- `backend-ts/src/worker.ts` — **modify**: register `handleCampaigns`.
- `frontend/app/(dashboard)/campaigns/page.tsx` — **create**.
- Frontend nav + case-detail channel selector — **modify**.
- Docs — **modify**: ARCHITECTURE, DATA_MODEL, DECISIONS (ADR-011), JOURNAL, README, CLAUDE.

---

## Task 1: OutreachChannel port

**Files:**
- Create: `backend-ts/src/case/outreach-channel.ts`
- Test: `backend-ts/src/case/outreach-channel.test.ts`

- [ ] **Step 1: Read** `backend-ts/src/case/email-service.ts` (the existing `EmailService` + `simulatedEmailService`; the new EMAIL channel will delegate to it).

- [ ] **Step 2: Write the failing test** — `outreach-channel.test.ts`:

```ts
/**
 * OutreachChannel port (#75 E5): the simulated adapters return the right shape per channel,
 * and resolveChannel picks simulated by default / DataChaser only when configured.
 *   node --import tsx --test src/case/outreach-channel.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveChannel, simulatedEmailChannel, simulatedSmsChannel, simulatedPhoneChannel, type ChannelType } from "./outreach-channel.ts";

test("simulated email channel returns a SIMULATED record carrying the subject", () => {
  const r = simulatedEmailChannel.send({ channel: "EMAIL", to: "x@workwell-demo.dev", subject: "Hi", body: "Body" });
  assert.equal(r.channel, "EMAIL");
  assert.equal(r.provider, "simulated");
  assert.equal(r.status, "SIMULATED");
  assert.match(r.messageId, /^sim-/);
  assert.equal(r.to, "x@workwell-demo.dev");
  assert.equal(r.errorDetail, null);
});

test("simulated SMS and phone channels are body-only (subject ignored) and SIMULATED", () => {
  for (const [ch, type] of [[simulatedSmsChannel, "SMS"], [simulatedPhoneChannel, "PHONE"]] as const) {
    const r = ch.send({ channel: type as ChannelType, to: "+15550000000", body: "Reminder" });
    assert.equal(r.channel, type);
    assert.equal(r.status, "SIMULATED");
    assert.equal(r.provider, "simulated");
  }
});

test("resolveChannel returns the simulated adapter by default (no DataChaser config)", () => {
  for (const t of ["EMAIL", "SMS", "PHONE"] as ChannelType[]) {
    const ch = resolveChannel(t, {});
    assert.equal(ch.type, t);
    assert.equal(ch.send({ channel: t, to: "x", body: "b" }).provider, "simulated");
  }
});

test("resolveChannel returns the DataChaser stub only when both env vars are set", () => {
  const ch = resolveChannel("SMS", {
    WORKWELL_OUTREACH_DATACHASER_API_KEY: "k",
    WORKWELL_OUTREACH_DATACHASER_BASE_URL: "https://dc.example",
  });
  assert.equal(ch.type, "SMS");
  const r = ch.send({ channel: "SMS", to: "+15550000000", body: "b" });
  assert.equal(r.provider, "datachaser");
  // partial config → still simulated (both must be present)
  assert.equal(resolveChannel("SMS", { WORKWELL_OUTREACH_DATACHASER_API_KEY: "k" }).send({ channel: "SMS", to: "x", body: "b" }).provider, "simulated");
});
```

- [ ] **Step 3: Run it — expect FAIL** (`./outreach-channel.ts` missing).

- [ ] **Step 4: Implement** `outreach-channel.ts`:

```ts
/**
 * OutreachChannel port (#75 E5) — multi-channel outreach (email/SMS/phone). Simulated adapters by
 * default (CLAUDE.md hard rule: nothing real is sent on the demo stack). A DataChaser stub stands in
 * for the real provider and is selected ONLY when explicitly configured (inert-unless-configured,
 * mirroring the SendGrid pattern); its transport is a documented stub pending API access (Doug Q4).
 */
import { simulatedEmailService } from "./email-service.ts";

export type ChannelType = "EMAIL" | "SMS" | "PHONE";

export interface OutreachMessage {
  channel: ChannelType;
  to: string;
  subject?: string; // EMAIL only; SMS/PHONE ignore it
  body: string;
}

export interface OutreachDeliveryRecord {
  channel: ChannelType;
  provider: string; // "simulated" | "datachaser"
  status: string; // "SIMULATED" | "SENT" | "FAILED" | "QUEUED"
  messageId: string;
  to: string;
  sentAt: string;
  errorDetail: string | null;
}

export interface OutreachChannel {
  readonly type: ChannelType;
  send(msg: OutreachMessage): OutreachDeliveryRecord;
}

/** Env knobs the channel selector reads (a subset of the worker env). */
export interface ChannelEnv {
  WORKWELL_OUTREACH_DATACHASER_API_KEY?: string;
  WORKWELL_OUTREACH_DATACHASER_BASE_URL?: string;
}

const simRecord = (msg: OutreachMessage, prefix: string): OutreachDeliveryRecord => ({
  channel: msg.channel,
  provider: "simulated",
  status: "SIMULATED",
  messageId: `${prefix}-${crypto.randomUUID()}`,
  to: msg.to,
  sentAt: new Date().toISOString(),
  errorDetail: null,
});

/** EMAIL simulated channel — delegates to the existing simulatedEmailService so email behavior is unchanged. */
export const simulatedEmailChannel: OutreachChannel = {
  type: "EMAIL",
  send(msg) {
    const rec = simulatedEmailService.send(msg.to, msg.subject ?? "", msg.body);
    return { channel: "EMAIL", provider: rec.provider, status: rec.status, messageId: rec.messageId, to: rec.toAddress, sentAt: rec.sentAt, errorDetail: rec.errorDetail };
  },
};

export const simulatedSmsChannel: OutreachChannel = { type: "SMS", send: (msg) => simRecord(msg, "sim-sms") };
export const simulatedPhoneChannel: OutreachChannel = { type: "PHONE", send: (msg) => simRecord(msg, "sim-phone") };

const SIMULATED: Record<ChannelType, OutreachChannel> = {
  EMAIL: simulatedEmailChannel,
  SMS: simulatedSmsChannel,
  PHONE: simulatedPhoneChannel,
};

/**
 * DataChaser stub (#75 E5) — represents MIE's DataChaser provider for all 3 channels. Inert: real
 * HTTP wiring is deferred (Doug Q4). When (improperly) reached without a transport it returns a
 * QUEUED record rather than sending. Only constructed by resolveChannel when fully configured.
 */
export function dataChaserChannel(type: ChannelType, _config: { apiKey: string; baseUrl: string }): OutreachChannel {
  return {
    type,
    send(msg) {
      // STUB: a real implementation would POST to `${_config.baseUrl}` with `_config.apiKey`.
      return { channel: type, provider: "datachaser", status: "QUEUED", messageId: `dc-${crypto.randomUUID()}`, to: msg.to, sentAt: new Date().toISOString(), errorDetail: null };
    },
  };
}

/**
 * Select the channel adapter: the simulated adapter by default; the DataChaser stub ONLY when both
 * WORKWELL_OUTREACH_DATACHASER_API_KEY and _BASE_URL are set (inert-unless-configured).
 */
export function resolveChannel(type: ChannelType, env: ChannelEnv): OutreachChannel {
  const apiKey = (env.WORKWELL_OUTREACH_DATACHASER_API_KEY ?? "").trim();
  const baseUrl = (env.WORKWELL_OUTREACH_DATACHASER_BASE_URL ?? "").trim();
  if (apiKey && baseUrl) return dataChaserChannel(type, { apiKey, baseUrl });
  return SIMULATED[type];
}

export const CHANNEL_TYPES: readonly ChannelType[] = ["EMAIL", "SMS", "PHONE"];
export const isChannelType = (v: unknown): v is ChannelType => typeof v === "string" && (CHANNEL_TYPES as readonly string[]).includes(v);
```

- [ ] **Step 5: Run the test — expect PASS.**
- [ ] **Step 6: `cd backend-ts && pnpm typecheck` — clean.**
- [ ] **Step 7: Commit:**
```bash
git add backend-ts/src/case/outreach-channel.ts backend-ts/src/case/outreach-channel.test.ts
git commit -m "feat(case): #75 E5 — OutreachChannel port (email/SMS/phone, simulated) + DataChaser stub"
```

---

## Task 2: Channel-aware single-case send (dispatchOutreach refactor)

**Files:**
- Modify: `backend-ts/src/case/case-outreach.ts`
- Modify: `backend-ts/src/case/case-outreach.test.ts`

Read `case-outreach.ts` fully first (it's ~300 lines). The goal: extract the send core into a reusable `dispatchOutreach` and make it channel-aware, WITHOUT changing the default (EMAIL) behavior the existing tests assert. Keep `previewOutreach` and `updateOutreachDelivery` unchanged.

- [ ] **Step 1: Add channel support to `OutreachDeps` + a dispatch core.** Add an import:
```ts
import { resolveChannel, type ChannelType, type ChannelEnv, type OutreachChannel } from "./outreach-channel.ts";
```
Extend `OutreachDeps`:
```ts
export interface OutreachDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  email?: EmailService;        // kept for back-compat (EMAIL simulated path)
  channels?: (type: ChannelType) => OutreachChannel; // default: resolveChannel(type, {}) = all simulated
}
```
Add a helper to pick the channel (default all-simulated):
```ts
const channelFor = (deps: OutreachDeps, type: ChannelType): OutreachChannel =>
  (deps.channels ?? ((t: ChannelType) => resolveChannel(t, {} as ChannelEnv)))(type);
```

- [ ] **Step 2: Extract `dispatchOutreach`.** Refactor the body of `sendOutreach` (the part that renders, sends, records the `OUTREACH_SENT` action + `CASE_OUTREACH_SENT` audit, and patches the case) into:

```ts
export interface DispatchOptions {
  channel?: ChannelType;       // default "EMAIL"
  templateId?: string | null;
  campaignId?: string | null;  // stamped into the action/audit payload when part of a campaign
  actor: string;
}

export interface DispatchResult {
  caseId: string;
  employeeId: string;
  channel: ChannelType;
  toAddress: string;
  status: string;     // delivery record status (SIMULATED | SENT | FAILED | QUEUED)
  messageId: string;
  templateName: string;
}

/** Render + send (via the resolved channel) + record action/audit + patch the case OPEN. Shared by
 *  the single-case sendOutreach and the campaign loop. */
export async function dispatchOutreach(deps: OutreachDeps, existing: <case row type>, opts: DispatchOptions): Promise<DispatchResult> {
  const channelType: ChannelType = opts.channel ?? "EMAIL";
  const { employeeName, measureName, dueDate } = await renderContext(deps, existing);
  const t = resolveTemplate(opts.templateId, existing.currentOutcomeStatus, measureName);
  const subject = renderTemplate(t.subject, employeeName, measureName, dueDate, existing.currentOutcomeStatus);
  const body = renderTemplate(t.bodyText, employeeName, measureName, dueDate, existing.currentOutcomeStatus);
  const toAddress = channelType === "EMAIL"
    ? `${existing.employeeId}@workwell-demo.dev`
    : `sms:${existing.employeeId}`; // synthetic, non-routable handle for SMS/PHONE in the demo
  const channel = channelFor(deps, channelType);
  const delivery = channel.send({ channel: channelType, to: toAddress, subject: channelType === "EMAIL" ? subject : undefined, body });

  const nextAction = "Wait for employee follow-up, then rerun to verify closure.";
  const actionPayload = {
    autoTriggered: false,
    channel: channelType,                 // was "SIMULATED_EMAIL"; now the real ChannelType
    deliveryProvider: delivery.provider,
    template: t.name, templateName: t.name, templateId: t.id,
    subject,
    deliveryStatus: delivery.status,
    emailDeliveryStatus: delivery.status, // retained key for back-compat with the case-detail read model
    note: `Outreach dispatched via ${delivery.provider} provider (${delivery.status}) over ${channelType}.`,
    emailMessageId: delivery.messageId,
    toAddress: delivery.to,
    sentAt: delivery.sentAt,
    ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
  };
  await deps.events.recordCaseEvent({
    action: { caseId: existing.id, actionType: "OUTREACH_SENT", actor: opts.actor, payload: actionPayload },
    audit: {
      eventType: "CASE_OUTREACH_SENT", entityType: "case", entityId: existing.id, actor: opts.actor,
      refRunId: existing.lastRunId, refCaseId: existing.id, refMeasureVersionId: existing.measureId,
      payload: { caseStatus: "OPEN", nextAction, outcomeStatus: existing.currentOutcomeStatus, action: actionPayload },
    },
  });
  await deps.cases.patchCase(existing.id, { status: "OPEN", nextAction });
  return { caseId: existing.id, employeeId: existing.employeeId, channel: channelType, toAddress: delivery.to, status: delivery.status, messageId: delivery.messageId, templateName: t.name };
}
```
(Use the actual case row type from `deps.cases.getCase` for the `existing` param — reuse the inferred type, e.g. `NonNullable<Awaited<ReturnType<CaseStore["getCase"]>>>`.)

Then rewrite `sendOutreach` to delegate:
```ts
export async function sendOutreach(deps: OutreachDeps, caseId: string, actor: string, templateId?: string | null, channel?: ChannelType): Promise<CaseDetail | null> {
  const existing = await deps.cases.getCase(caseId);
  if (!existing) return null;
  await dispatchOutreach(deps, existing, { channel, templateId, actor });
  return buildDetail(deps, caseId);
}
```

- [ ] **Step 3: Update the existing tests** in `case-outreach.test.ts`: run them first to see what breaks. The default path is still EMAIL/simulated, so most assertions hold. The one likely change: any assertion of `channel === "SIMULATED_EMAIL"` becomes `channel === "EMAIL"` (with `deliveryProvider === "simulated"`). Update ONLY those; do not weaken other assertions. Add one new test: `sendOutreach(..., channel: "SMS")` records `channel: "SMS"`, `deliveryProvider: "simulated"` in the action payload, and the case goes OPEN.

- [ ] **Step 4: Run** `cd backend-ts && node --import tsx --test src/case/case-outreach.test.ts` — all pass. Then `pnpm typecheck`.
- [ ] **Step 5: Commit:**
```bash
git add backend-ts/src/case/case-outreach.ts backend-ts/src/case/case-outreach.test.ts
git commit -m "refactor(case): #75 E5 — extract channel-aware dispatchOutreach; channel param on send"
```

---

## Task 3: CampaignStore port + audit-backed adapter

**Files:**
- Create: `backend-ts/src/stores/campaign-store.ts`
- Create: `backend-ts/src/stores/audit-campaign-store.ts`
- Test: `backend-ts/src/stores/audit-campaign-store.test.ts`
- Modify: `backend-ts/src/stores/factory.ts`

- [ ] **Step 1: Define the port** `campaign-store.ts`:

```ts
/**
 * CampaignStore port (#75 E5) — persistence seam for outreach campaigns. The demo adapter is
 * audit-backed (no schema). The production drop-in is a PgCampaignStore over outreach_campaigns +
 * outreach_delivery_log (+ owner migration), selected on the ceiling — no consumer change.
 */
import type { ChannelType } from "../case/outreach-channel.ts";

export interface CampaignRecord {
  id: string;
  channel: ChannelType;
  measureId: string | null;
  site: string | null;
  outcomeStatus: string | null;
  templateId: string | null;
  status: string; // "COMPLETED" | "PARTIAL_FAILURE"
  total: number; sent: number; failed: number; simulated: number;
  createdBy: string;
  createdAt: string;
}

export interface CampaignRecipientRecord {
  campaignId: string;
  caseId: string;
  employeeId: string;
  employeeName: string;
  channel: ChannelType;
  toAddress: string;
  status: string;
  messageId: string | null;
  sentAt: string;
}

export interface CampaignStore {
  recordCampaign(campaign: CampaignRecord, recipients: CampaignRecipientRecord[]): Promise<void>;
  listCampaigns(limit?: number): Promise<CampaignRecord[]>; // newest-first
  getCampaign(id: string): Promise<CampaignRecord | null>;
  listRecipients(campaignId: string): Promise<CampaignRecipientRecord[]>;
}
```

- [ ] **Step 2: Write the failing test** `audit-campaign-store.test.ts`:

```ts
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
```

- [ ] **Step 3: Run it — expect FAIL** (modules missing).

- [ ] **Step 4: Implement** `audit-campaign-store.ts`:

```ts
/**
 * Audit-backed CampaignStore (#75 E5) — the demo persistence adapter. A campaign is stored as a single
 * OUTREACH_CAMPAIGN_COMPLETED audit event whose payload carries the campaign + its recipients. Reads
 * scan listAuditEvents (oldest-first) and filter by eventType. No DDL on floor or ceiling. Demo-scale;
 * the production PgCampaignStore over outreach_campaigns + outreach_delivery_log is the drop-in.
 */
import type { CaseEventStore } from "./case-event-store.ts";
import type { CampaignRecord, CampaignRecipientRecord, CampaignStore } from "./campaign-store.ts";

const CAMPAIGN_EVENT = "OUTREACH_CAMPAIGN_COMPLETED";

export class AuditBackedCampaignStore implements CampaignStore {
  constructor(private readonly events: CaseEventStore) {}

  async recordCampaign(campaign: CampaignRecord, recipients: CampaignRecipientRecord[]): Promise<void> {
    await this.events.appendAudit({
      eventType: CAMPAIGN_EVENT, entityType: "campaign", entityId: campaign.id, actor: campaign.createdBy,
      refRunId: null, refCaseId: null, refMeasureVersionId: null,
      payload: { campaign, recipients },
    });
  }

  /** All campaign payloads, newest-first (listAuditEvents is oldest-first → reverse). */
  private async all(): Promise<Array<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] }>> {
    const rows = await this.events.listAuditEvents();
    return rows
      .filter((r) => r.eventType === CAMPAIGN_EVENT)
      .map((r) => r.payload as unknown as { campaign: CampaignRecord; recipients: CampaignRecipientRecord[] })
      .reverse();
  }

  async listCampaigns(limit = 100): Promise<CampaignRecord[]> {
    return (await this.all()).slice(0, limit).map((p) => p.campaign);
  }
  async getCampaign(id: string): Promise<CampaignRecord | null> {
    return (await this.all()).find((p) => p.campaign.id === id)?.campaign ?? null;
  }
  async listRecipients(campaignId: string): Promise<CampaignRecipientRecord[]> {
    return (await this.all()).find((p) => p.campaign.id === campaignId)?.recipients ?? [];
  }
}
```

- [ ] **Step 5: Wire into the factory.** In `factory.ts`:
  - import: `import type { CampaignStore } from "./campaign-store.ts";` and `import { AuditBackedCampaignStore } from "./audit-campaign-store.ts";`
  - add `campaigns: CampaignStore;` to the `Stores` interface.
  - in `buildPostgres`: capture `const events = new PgCaseEventStore(pool);`, use `events` for the `events:` field, and add `campaigns: new AuditBackedCampaignStore(events),`.
  - in `buildSqlite`: capture `const events = new SqliteCaseEventStore(db);`, use it for `events:`, and add `campaigns: new AuditBackedCampaignStore(events),`.
  - Add a one-line comment above the `campaigns` field noting the production drop-in (PgCampaignStore over outreach_campaigns + outreach_delivery_log).

- [ ] **Step 6: Run** `cd backend-ts && node --import tsx --test src/stores/audit-campaign-store.test.ts && pnpm typecheck && pnpm test` — green.
- [ ] **Step 7: Commit:**
```bash
git add backend-ts/src/stores/campaign-store.ts backend-ts/src/stores/audit-campaign-store.ts backend-ts/src/stores/audit-campaign-store.test.ts backend-ts/src/stores/factory.ts
git commit -m "feat(stores): #75 E5 — CampaignStore port + audit-backed demo adapter (Pg drop-in documented)"
```

---

## Task 4: Campaign engine

**Files:**
- Create: `backend-ts/src/case/outreach-campaign.ts`
- Test: `backend-ts/src/case/outreach-campaign.test.ts`

Read `backend-ts/src/program/program-read-models.ts` for the site-matching pattern (`employeeById(subjectId)?.site`, case-insensitive) and `case-outreach.ts` for `dispatchOutreach`.

- [ ] **Step 1: Write the failing test** `outreach-campaign.test.ts` — seed OPEN cases via the stores, run a dry-run then a real campaign, assert recipient resolution + counts + persistence:

```ts
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
  // Two OPEN OVERDUE audiogram cases at Plant A (emp-006, emp-010) + one HQ (emp-001).
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
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** `outreach-campaign.ts`:

```ts
/**
 * Campaign engine (#75 E5) — resolve eligible OPEN cases (measure/site/outcome), then dispatch
 * outreach per recipient via the channel (simulated by default) reusing dispatchOutreach, and persist
 * the result via the CampaignStore. dryRun previews recipients with no sends, no audit, no persistence.
 */
import type { CaseStore } from "../stores/case-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { OutcomeStore } from "../stores/outcome-store.ts";
import type { CampaignStore, CampaignRecord, CampaignRecipientRecord } from "../stores/campaign-store.ts";
import { employeeById } from "../engine/synthetic/employee-catalog.ts";
import { dispatchOutreach, type OutreachDeps } from "./case-outreach.ts";
import { isChannelType, resolveChannel, type ChannelType, type ChannelEnv, type OutreachChannel } from "./outreach-channel.ts";

export interface CampaignDeps {
  cases: CaseStore;
  events: CaseEventStore;
  outcomes: OutcomeStore;
  campaigns: CampaignStore;
  channels?: (type: ChannelType) => OutreachChannel; // default: resolveChannel(type, {}) (all simulated)
}

export interface CampaignRequest {
  measureId?: string | null;
  site?: string | null;
  outcomeStatus?: string | null;
  channel: ChannelType;
  templateId?: string | null;
  dryRun?: boolean;
}

export interface CampaignResult {
  campaignId: string | null;
  channel: ChannelType;
  dryRun: boolean;
  total: number; sent: number; failed: number; simulated: number;
  recipients: CampaignRecipientRecord[];
}

export class CampaignError extends Error {}

const eq = (a: string | null | undefined, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();

export async function runCampaign(deps: CampaignDeps, req: CampaignRequest, actor: string): Promise<CampaignResult> {
  if (!isChannelType(req.channel)) throw new CampaignError("channel must be EMAIL, SMS, or PHONE");
  const measureId = req.measureId?.trim() || undefined;
  const site = req.site?.trim() || null;
  const outcome = req.outcomeStatus?.trim() || null;

  const open = await deps.cases.listCases({ statuses: ["OPEN"], measureId, limit: 100000 });
  const eligible = open.filter(
    (c) => (!site || eq(employeeById(c.employeeId)?.site ?? null, site)) && (!outcome || eq(c.currentOutcomeStatus, outcome)),
  );

  if (req.dryRun) {
    const recipients: CampaignRecipientRecord[] = eligible.map((c) => ({
      campaignId: "", caseId: c.id, employeeId: c.employeeId, employeeName: employeeById(c.employeeId)?.name ?? c.employeeId,
      channel: req.channel, toAddress: req.channel === "EMAIL" ? `${c.employeeId}@workwell-demo.dev` : `sms:${c.employeeId}`,
      status: "PREVIEW", messageId: null, sentAt: "",
    }));
    return { campaignId: null, channel: req.channel, dryRun: true, total: recipients.length, sent: 0, failed: 0, simulated: 0, recipients };
  }

  const campaignId = crypto.randomUUID();
  const outreachDeps: OutreachDeps = { cases: deps.cases, events: deps.events, outcomes: deps.outcomes, channels: deps.channels };
  const recipients: CampaignRecipientRecord[] = [];
  let sent = 0, failed = 0, simulated = 0;
  for (const c of eligible) {
    const d = await dispatchOutreach(outreachDeps, c, { channel: req.channel, templateId: req.templateId, campaignId, actor });
    const isFailed = d.status === "FAILED";
    if (isFailed) failed++; else sent++;
    if (d.status === "SIMULATED") simulated++;
    recipients.push({
      campaignId, caseId: d.caseId, employeeId: d.employeeId, employeeName: employeeById(d.employeeId)?.name ?? d.employeeId,
      channel: d.channel, toAddress: d.toAddress, status: d.status, messageId: d.messageId, sentAt: new Date().toISOString(),
    });
  }
  const campaign: CampaignRecord = {
    id: campaignId, channel: req.channel, measureId: measureId ?? null, site, outcomeStatus: outcome,
    templateId: req.templateId ?? null, status: failed > 0 ? "PARTIAL_FAILURE" : "COMPLETED",
    total: recipients.length, sent, failed, simulated, createdBy: actor, createdAt: new Date().toISOString(),
  };
  await deps.campaigns.recordCampaign(campaign, recipients);
  return { campaignId, channel: req.channel, dryRun: false, total: recipients.length, sent, failed, simulated, recipients };
}

export async function listCampaigns(deps: CampaignDeps): Promise<CampaignRecord[]> {
  return deps.campaigns.listCampaigns();
}
export async function getCampaignDetail(deps: CampaignDeps, id: string): Promise<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } | null> {
  const campaign = await deps.campaigns.getCampaign(id);
  if (!campaign) return null;
  return { campaign, recipients: await deps.campaigns.listRecipients(id) };
}
```
Note: `dispatchOutreach`'s `existing` param type must accept the `CaseRecord` returned by `listCases`. Confirm `listCases` returns the same shape `getCase` returns (both `CaseRecord`); if `dispatchOutreach` was typed to `getCase`'s return, widen it to `CaseRecord` so the campaign loop type-checks.

- [ ] **Step 4: Run the test — expect PASS.** Then `pnpm typecheck && pnpm test` — green.
- [ ] **Step 5: Commit:**
```bash
git add backend-ts/src/case/outreach-campaign.ts backend-ts/src/case/outreach-campaign.test.ts
git commit -m "feat(case): #75 E5 — campaign engine (resolve recipients, dryRun, dispatch, persist)"
```

---

## Task 5: Campaign route

**Files:**
- Create: `backend-ts/src/routes/campaigns.ts`
- Test: `backend-ts/src/routes/campaigns.test.ts`
- Modify: `backend-ts/src/worker.ts`

Read `backend-ts/src/routes/cases.ts` for the `actor` derivation + `actionDeps(env)` pattern and how POST bodies are read; mirror it.

- [ ] **Step 1: Write the failing route test** `campaigns.test.ts` — seed OPEN cases, then POST a dryRun + a real campaign, GET list + GET :id, assert shapes + a 400 on a bad channel:

```ts
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
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Implement** `campaigns.ts`:

```ts
/**
 * Campaigns route (#75 E5) — batch outreach campaigns. Authenticated under /api/** by the worker
 * security matrix; the actor comes from the auth middleware (never the request body).
 *
 *   POST /api/campaigns        body: CampaignRequest (+ ?dryRun=true) → CampaignResult
 *   GET  /api/campaigns                                               → CampaignRecord[] (newest-first)
 *   GET  /api/campaigns/:id                                           → { campaign, recipients } | 404
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { runCampaign, listCampaigns, getCampaignDetail, CampaignError, type CampaignDeps, type CampaignRequest } from "../case/outreach-campaign.ts";
import { resolveChannel, type ChannelType, type ChannelEnv } from "../case/outreach-channel.ts";

interface CampaignsEnv extends ChannelEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function deps(env: CampaignsEnv): Promise<CampaignDeps> {
  const s = await getStores(env);
  return {
    cases: s.cases, events: s.events, outcomes: s.outcomes, campaigns: s.campaigns,
    channels: (type: ChannelType) => resolveChannel(type, env), // DataChaser only if env-configured; else simulated
  };
}

export async function handleCampaigns(req: Request, env: CampaignsEnv, actor: string): Promise<Response | null> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (!pathname.startsWith("/api/campaigns")) return null;

  if (req.method === "POST" && pathname === "/api/campaigns") {
    const body = (await req.json().catch(() => ({}))) as Partial<CampaignRequest>;
    const dryRun = body.dryRun ?? url.searchParams.get("dryRun") === "true";
    try {
      const result = await runCampaign(await deps(env), { ...body, channel: body.channel as ChannelType, dryRun } as CampaignRequest, actor);
      return json(result);
    } catch (err) {
      if (err instanceof CampaignError) return json({ error: "invalid_request", message: err.message }, 400);
      throw err;
    }
  }

  if (req.method === "GET" && pathname === "/api/campaigns") {
    return json(await listCampaigns(await deps(env)));
  }

  const id = req.method === "GET" ? pathname.match(/^\/api\/campaigns\/([^/]+)$/)?.[1] : undefined;
  if (id) {
    const detail = await getCampaignDetail(await deps(env), id);
    return detail ? json(detail) : json({ error: "not_found", message: `Campaign not found: ${id}` }, 404);
  }

  return null;
}
```

- [ ] **Step 4: Wire into `worker.ts`.** Read how `handleCases` is called (it takes `(req, env, actor)`). Add the import near the others:
```ts
import { handleCampaigns } from "./routes/campaigns.ts";
```
Register it right after the cases handler block (`if (casesResponse) return casesResponse;`), passing the same `actor`:
```ts
  const campaignsResponse = await handleCampaigns(req, env, actor);
  if (campaignsResponse) return campaignsResponse;
```
(Confirm the `actor` variable name used by the cases registration and reuse it exactly.)

- [ ] **Step 5: Run** `cd backend-ts && node --import tsx --test src/routes/campaigns.test.ts && pnpm typecheck && pnpm test` — green.
- [ ] **Step 6: Commit:**
```bash
git add backend-ts/src/routes/campaigns.ts backend-ts/src/routes/campaigns.test.ts backend-ts/src/worker.ts
git commit -m "feat(routes): #75 E5 — /api/campaigns (run/list/detail) endpoint"
```

---

## Task 6: Frontend — campaign launcher + history

**Files:**
- Create: `frontend/app/(dashboard)/campaigns/page.tsx`
- Modify: the dashboard nav (add a "Campaigns" link) + the case-detail outreach action (channel selector)

- [ ] **Step 1: Discover patterns.** Read `frontend/app/(dashboard)/programs/hierarchy/page.tsx` (built in E4 — same `useApi`/`useGlobalFilters`/measures-source pattern, semantic table, `setTimeout(...,0)` load idiom), the dashboard nav component (where the E4 nav links live — find how nav items are registered), and the case-detail outreach action component (to add a channel `<select>`). Reuse these patterns; do not hand-roll fetch.

- [ ] **Step 2: Build `campaigns/page.tsx`** (client component) using the discovered `useApi`:
  - **Launcher form:** selects for Measure (All + Active measures, slug values, from `/api/programs/overview`), Site (All + sites from `/api/programs/sites`), Outcome (All / OVERDUE / MISSING_DATA / DUE_SOON), Channel (EMAIL / SMS / PHONE), Template (optional — "Default (outcome-based)" + templates if a list endpoint exists; else just default). A **Dry run** button → `POST /api/campaigns` with `dryRun:true` → render the recipient preview table (employee, channel, to). A **Send** button → `POST /api/campaigns` → render the result summary (total/sent/failed/simulated) + recipients.
  - **History:** on load, `GET /api/campaigns` → a table (createdAt, channel, measure, total, sent, failed, status); clicking a row → `GET /api/campaigns/:id` → recipients detail.
  - Loading + empty states. Stable keys. A note that sends are simulated on the demo stack.
- [ ] **Step 3: Add a "Campaigns" nav link** (mirror the existing nav items) and a **channel `<select>`** on the case-detail outreach action (default EMAIL) that forwards `?channel=` (or a body field) to the existing send call — match how the outreach send is currently invoked from the case-detail UI.
- [ ] **Step 4: `cd frontend && npm run lint && npm run build`** — clean.
- [ ] **Step 5: Commit:**
```bash
git add "frontend/app/(dashboard)/campaigns/page.tsx" <nav + case-detail files>
git commit -m "feat(frontend): #75 E5 — campaign launcher + history; channel selector on case outreach"
```

---

## Task 7: Docs

**Files:** `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: ARCHITECTURE.md** — §3 `notification`/`caseflow`: add the `OutreachChannel` port (email/SMS/phone simulated + DataChaser stub, `resolveChannel` inert-unless-configured) and the `CampaignStore` port (audit-backed demo adapter; Pg `outreach_campaigns`/`outreach_delivery_log` drop-in). §4: add `/campaigns`. §7: add the `/api/campaigns` endpoints.
- [ ] **Step 2: DATA_MODEL.md** — document the `CampaignStore` port + the production `outreach_campaigns` / `outreach_delivery_log` tables as a documented drop-in (still not persisted in backend-ts; campaigns currently live as `OUTREACH_CAMPAIGN_COMPLETED` audit events). Keep the existing `outreach_delivery_log` §3.16 note accurate.
- [ ] **Step 3: DECISIONS.md** — add ADR-011: multi-channel `OutreachChannel` port + the staged `CampaignStore` persistence decision (audit-backed now / Pg tables later) and why (campaign is created state, but sending is simulated + DataChaser stubbed + schema owner-gated → stage behind a port). Reference the contrast with E4 (derived data → no-schema was correct there).
- [ ] **Step 4: JOURNAL.md** — dated `2026-06-19` entry (newest on top): E5 shipped — OutreachChannel port (email/SMS/phone simulated) + DataChaser stub + campaigns behind a CampaignStore port (audit-backed; Pg drop-in documented), `/api/campaigns`, campaign launcher UI. No schema. Simulated by default.
- [ ] **Step 5: README.md** — add `/campaigns` to Key routes and `POST/GET /api/campaigns` to API highlights.
- [ ] **Step 6: CLAUDE.md** — Current Focus: E5 (#75) done; next epic E6 (#76 — immunization & forecasting). Note ADR-011 + the audit-backed/no-schema-today posture.
- [ ] **Step 7: Commit:**
```bash
git add docs/ARCHITECTURE.md docs/DATA_MODEL.md docs/DECISIONS.md docs/JOURNAL.md README.md CLAUDE.md
git commit -m "docs: #75 E5 — outreach at scale (architecture, data model, ADR-011, journal)"
```

---

## Final verification (before PR)

- [ ] `cd backend-ts && pnpm typecheck && pnpm test` — all green.
- [ ] `cd frontend && npm run lint && npm run build` — clean.
- [ ] Whole-PR code review via the `superpowers:code-reviewer` subagent on the full branch diff vs `main` (MANDATORY before merge).
- [ ] PR referencing #75; merge on green after review.
- [ ] Verify live after deploy: login, `POST /api/campaigns` dryRun + real (SMS), `GET /api/campaigns`, and the `/campaigns` UI dry-run→send.
