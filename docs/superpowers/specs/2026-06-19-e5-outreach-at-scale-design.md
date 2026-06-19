# E5 — Outreach at Scale Design

Date: 2026-06-19
Status: Approved (design); no schema today (CampaignStore port + audit-backed demo adapter; Pg table is a documented drop-in)
Epic: #75 (E5). Sub-issues to be opened on merge.

## Goal

Generalize outreach from a single simulated email channel into a **multi-channel** capability
(email / SMS / phone) with **batch campaigns** — "DataChaser powers SMS/email/phone campaigns" from
the press release — while keeping everything **simulated by default** (CLAUDE.md hard rule). A
**DataChaser adapter stub** stands in for the real provider, inert until API access is confirmed.

## Current state (what exists)

- `backend-ts/src/case/email-service.ts` — `EmailService` interface + `simulatedEmailService`
  (`send(to, subject, body) → EmailDeliveryRecord` with `status: "SIMULATED"`). The only channel.
- `backend-ts/src/case/case-outreach.ts` — per-case `previewOutreach` / `sendOutreach` /
  `updateOutreachDelivery`. Channel hardcoded `"SIMULATED_EMAIL"`. Templates: built-in outcome-aware
  `TEMPLATES` with `{{…}}` rendering; a DB `outreach_templates` table + admin CRUD also exists.
- Every send already writes a `case_action` (`OUTREACH_SENT`) + `audit_event` (`CASE_OUTREACH_SENT`).
- `outreach_delivery_log` is **specified in DATA_MODEL.md §3.16 but not persisted in backend-ts**.
- There is no SMS/phone, no batch/campaign concept.

## Persistence decision (the design's crux)

A campaign is **created state**, not derived data (unlike the E4 hierarchy, which is a projection — so
no-schema was correct there). The production-correct home for campaigns is real tables
(`outreach_campaigns` + the already-specified `outreach_delivery_log`), indexed, with a delivery
lifecycle that provider webhooks update asynchronously.

But the sending is **simulated** and the provider (**DataChaser**) is itself a **stub**, and schema —
*both* the Neon ceiling (`schema-pg.ts`) *and* the SQLite floor (`schema.ts`) — is owner-gated
(Taleef). Building webhook-updatable delivery persistence while the layer that emits those updates
doesn't exist is premature.

**Resolution — stage it behind a `CampaignStore` port (the codebase's own idiom):**
- Define a `CampaignStore` interface. Consumers (campaign engine, read-models, route) depend only on it.
- Ship an **audit-backed demo adapter**: `createCampaign` writes an `OUTREACH_CAMPAIGN_COMPLETED`
  audit event carrying the campaign summary + recipient list; `listCampaigns`/`getCampaign`/
  `listRecipients` read it back via the existing `listAuditEvents`. **No DDL on floor or ceiling**, and
  it persists (audit_events is on Neon). The audit-as-db detail is **quarantined inside this one
  adapter**, not the architecture.
- Document the production drop-in: a `PgCampaignStore` over `outreach_campaigns` +
  `outreach_delivery_log`, plus the owner's migration — **zero consumer changes** to swap in.

This is the same staging pattern already used across the repo (SQLite floor / Pg ceiling stores; the
`ValueSetResolver` port with a VSAC drop-in; the `OutreachChannel` port itself).

## 1. OutreachChannel port

`backend-ts/src/case/outreach-channel.ts`:

```ts
export type ChannelType = "EMAIL" | "SMS" | "PHONE";

export interface OutreachMessage {
  channel: ChannelType;
  to: string;       // email address, phone number — synthetic + non-routable in the demo
  subject?: string; // EMAIL only
  body: string;
}

export interface OutreachDeliveryRecord {
  channel: ChannelType;
  provider: string;   // "simulated" | "datachaser"
  status: string;     // "SIMULATED" | "SENT" | "FAILED" | "QUEUED"
  messageId: string;
  to: string;
  sentAt: string;     // ISO-8601
  errorDetail: string | null;
}

export interface OutreachChannel {
  readonly type: ChannelType;
  send(msg: OutreachMessage): OutreachDeliveryRecord;
}
```

- **Simulated adapters** for all three channels: `simulatedEmailChannel`, `simulatedSmsChannel`,
  `simulatedPhoneChannel` (each returns a `SIMULATED` record with a channel-prefixed messageId, e.g.
  `sim-sms-<uuid>`). The EMAIL channel delegates to the existing `simulatedEmailService.send` so the
  current email behavior/tests are unchanged. SMS/PHONE ignore `subject` (body-only).
- **DataChaser stub** `dataChaserChannel(type, config)` — a single adapter representing the real
  provider for all three channels. Inert: only constructed by the selector when configured; its `send`
  is a documented stub (returns a `QUEUED`/`datachaser` record; real HTTP wiring deferred to Doug Q4).
- **Selector** `resolveChannel(type, env): OutreachChannel` — returns the **simulated** adapter by
  default; returns the DataChaser adapter **only when** `WORKWELL_OUTREACH_DATACHASER_API_KEY` and
  `WORKWELL_OUTREACH_DATACHASER_BASE_URL` are both set (inert-unless-configured, mirroring SendGrid).

## 2. Channel-aware single-case send (refactor)

Extract the core of `sendOutreach` into a reusable `dispatchOutreach(deps, caseRow, opts)` that:
renders the template → `channel.send(...)` → records the `OUTREACH_SENT` `case_action` +
`CASE_OUTREACH_SENT` `audit_event` (now stamping `channel` and, when present, `campaignId` into the
payload) → patches the case to `OPEN` with the follow-up next action. Both the single-case
`sendOutreach` and the campaign loop call it (DRY; identical treatment per recipient).

`sendOutreach` (and the `POST /api/cases/:id/actions/outreach` route + case-detail UI) gain an optional
`channel` param; default `EMAIL` → byte-identical to today. The `dispatchOutreach` channel is resolved
via `resolveChannel(channelType, env)`.

## 3. CampaignStore port + audit-backed demo adapter

`backend-ts/src/stores/campaign-store.ts` (interface + records):

```ts
export interface CampaignRecord {
  id: string;
  channel: ChannelType;
  measureId: string | null;
  site: string | null;
  outcomeStatus: string | null;
  templateId: string | null;
  status: string;     // "COMPLETED" | "PARTIAL_FAILURE"
  total: number; sent: number; failed: number; simulated: number;
  createdBy: string;
  createdAt: string;  // ISO-8601
}

export interface CampaignRecipientRecord {
  campaignId: string;
  caseId: string;
  employeeId: string;
  employeeName: string;
  channel: ChannelType;
  toAddress: string;
  status: string;       // delivery status of the send
  messageId: string | null;
  sentAt: string;
}

export interface CampaignStore {
  recordCampaign(campaign: CampaignRecord, recipients: CampaignRecipientRecord[]): Promise<void>;
  listCampaigns(limit?: number): Promise<CampaignRecord[]>;   // newest-first
  getCampaign(id: string): Promise<CampaignRecord | null>;
  listRecipients(campaignId: string): Promise<CampaignRecipientRecord[]>;
}
```

Demo adapter `backend-ts/src/stores/audit-campaign-store.ts` (`AuditBackedCampaignStore`):
- Depends only on `CaseEventStore` (`appendAudit` + `listAuditEvents`).
- `recordCampaign` writes one `appendAudit({ eventType: "OUTREACH_CAMPAIGN_COMPLETED",
  entityType: "campaign", entityId: campaign.id, actor: campaign.createdBy, payload: { campaign,
  recipients } })`.
- `listCampaigns` = `listAuditEvents()` filtered to `eventType === "OUTREACH_CAMPAIGN_COMPLETED"`,
  mapped to `payload.campaign`, newest-first, capped at `limit` (default 100).
- `getCampaign(id)` / `listRecipients(id)` = the same scan, matched on `payload.campaign.id === id`.
- Wired in `stores/factory.ts` as `campaigns` on **both** the floor and ceiling store sets (audit_events
  exists in both). Documented: the production swap is a `PgCampaignStore` over `outreach_campaigns` +
  `outreach_delivery_log` (+ owner migration), selected on the ceiling — no consumer change.

(Note: `AuditEventRow` exposes `eventType` + `payload` but not `entity_type`, so the read keys on the
distinct `eventType` string. Demo-scale; the Pg adapter replaces the scan with indexed queries.)

## 4. Campaign engine

`backend-ts/src/case/outreach-campaign.ts`:

```ts
export interface CampaignRequest {
  measureId?: string | null;
  site?: string | null;
  outcomeStatus?: string | null; // OVERDUE | MISSING_DATA | DUE_SOON
  channel: ChannelType;
  templateId?: string | null;
  dryRun?: boolean;
}
export interface CampaignResult {
  campaignId: string | null; // null on dryRun
  channel: ChannelType;
  dryRun: boolean;
  total: number; sent: number; failed: number; simulated: number;
  recipients: CampaignRecipientRecord[]; // on dryRun: caseId/employee/to with status "PREVIEW"
}
export async function runCampaign(deps, req: CampaignRequest, actor: string): Promise<CampaignResult>;
export async function listCampaigns(deps): Promise<CampaignRecord[]>;
export async function getCampaignDetail(deps, id): Promise<{ campaign: CampaignRecord; recipients: CampaignRecipientRecord[] } | null>;
```

- **Recipient resolution:** `caseStore.listCases({ statuses: ["OPEN"], measureId, limit: 100000 })`,
  then filter in-app by `site` (via `employeeById(c.employeeId).site`, case-insensitive — `CaseQuery`
  has no site column, same pattern as program-read-models) and by `outcomeStatus`
  (`c.currentOutcomeStatus`). Channel is validated against `ChannelType`.
- **dryRun:** returns the resolved recipients (status `"PREVIEW"`) with no sends, no audit, no campaign
  record.
- **Real run:** for each recipient, `dispatchOutreach(deps, case, { channel, templateId, campaignId })`
  (per-recipient `OUTREACH_SENT` action + audit, channel-rendered, simulated by default); tally
  sent/failed/simulated; then `campaignStore.recordCampaign(campaign, recipients)`. Campaign `status` =
  `PARTIAL_FAILURE` if any `failed`, else `COMPLETED`.
- **Count semantics (authoritative):** `total` = recipients dispatched; `failed` = sends whose record
  `status === "FAILED"`; `sent` = `total − failed` (every non-failed dispatch — status in
  {SENT, SIMULATED, QUEUED}); `simulated` = the subset with `status === "SIMULATED"` (informational).
  Invariant: `sent + failed === total`. On the demo (all simulated): `sent === simulated === total`,
  `failed === 0`.
- **Safety:** simulated by default; real channels inert unless DataChaser is configured. Every send and
  the campaign summary write audit events (audit invariant upheld).

## 5. Route

`backend-ts/src/routes/campaigns.ts`, wired in `worker.ts` after the cases handler (auth under
`/api/**`):

```
POST /api/campaigns            body: CampaignRequest (+ ?dryRun=true)  → CampaignResult
GET  /api/campaigns                                                     → CampaignRecord[] (newest-first)
GET  /api/campaigns/:id                                                 → { campaign, recipients } | 404
```

`channel` validated (400 on a bad value); unknown campaign id → 404.

## 6. Frontend

- New route `frontend/app/(dashboard)/campaigns/page.tsx`: a **launcher** (measure / site / outcome
  filters + channel + template select → **Dry-run preview** lists recipients → **Send** shows
  per-recipient results + the campaign summary) and a **history** list (past campaigns with channel +
  counts) → click → detail (recipients). Reuses `useApi`, `useGlobalFilters`, the measures source, and
  the existing semantic-table styling (NITRO grid deferred).
- A **channel selector** on the existing case-detail outreach action (EMAIL default).
- A nav link to `/campaigns`.

## 7. Testing

- **Channel port:** each simulated adapter returns the right `channel`/`provider`/`SIMULATED` shape;
  SMS/PHONE omit subject; `resolveChannel` returns simulated by default and DataChaser only when both
  env vars are set; the DataChaser stub is inert/documented.
- **dispatchOutreach refactor:** single-case `sendOutreach` default-EMAIL behavior is unchanged
  (existing case-outreach tests stay green); a non-EMAIL channel records the right channel in the
  action payload.
- **CampaignStore (audit-backed):** `recordCampaign` then `listCampaigns`/`getCampaign`/
  `listRecipients` round-trip; newest-first; unknown id → null.
- **Campaign engine:** recipient resolution honors measure/site/outcome filters; `dryRun` sends nothing
  and writes no audit; a real run dispatches per recipient, tallies counts, sets `status`
  COMPLETED/PARTIAL_FAILURE, and persists; counts reconcile (`sent+failed === total`, simulated counted
  under sent for the simulated provider — define precisely in the plan).
- **Route:** POST returns the result (dryRun + real); bad channel → 400; GET list + GET :id (404 on
  unknown); reconciliation of the returned counts.
- **Frontend:** `npm run lint` + `npm run build`; a dry-run→send render check if a component-test
  pattern exists.

## 8. Out of scope (YAGNI)

Real DataChaser HTTP wiring; the `PgCampaignStore` adapter + its migration (documented drop-in, owner-
gated); scheduled/recurring campaigns; opt-out/consent management; provider delivery webhooks;
persisting `outreach_delivery_log` now; per-channel template variants (SMS/phone reuse the body).

## 9. Docs to update in the same PR

`docs/ARCHITECTURE.md` (the `OutreachChannel` + `CampaignStore` ports under §3 `notification`/`caseflow`;
`/campaigns` route surface in §4; the campaign endpoints in §7), `docs/DATA_MODEL.md` (the CampaignStore
port + the documented `outreach_campaigns`/`outreach_delivery_log` production drop-in; note
`outreach_delivery_log` is still not persisted), `docs/DECISIONS.md` (ADR-011 — multi-channel outreach
port + the staged CampaignStore persistence decision and why audit-backed-now/table-later), `docs/JOURNAL.md`
(dated entry), `README.md` (the `/campaigns` route + the campaign API), `CLAUDE.md` (Current Focus: E5
done; next E6 #76). Keep the "simulated by default / DataChaser stub / no schema today" framing accurate.
