# WorkWell Measure Studio - Data Model

## 1) Scope
This document is the current schema and contract reference for the WorkWell MVP runtime.
All tables below reflect active backend behavior as of 2026-05-10.

## 2) Core Tables and Responsibilities
- `measures`: logical measure records (name, owner, tags).
- `measure_versions`: executable measure revisions (spec, CQL, compile metadata, lifecycle status).
- `osha_references`: curated OSHA/policy reference lookup used by Studio Spec authoring.
- `value_sets`: value set catalog with code payloads and governance metadata (canonical URL, code systems, source, status, resolution status, expansion hash).
- `terminology_mappings`: local-to-standard code mappings with review workflow status and confidence scores.
- `measure_value_set_links`: many-to-many link between versions and value sets.
- `employees`: **Java-era only** — backend-ts has no `employees` table; the workforce is the synthetic directory (`employee-catalog.ts`) resolved at read-time. See §3.6.
- `runs`: execution instances + aggregate metrics.
- `run_logs`: per-run log timeline.
- `outcomes`: per-employee evaluated result rows.
- `cases`: actionable non-compliance work items.
- `case_actions`: user/system actions taken on cases.
- `audit_events`: append-only audit ledger.
- `integration_health`: persisted admin health state per integration.
- `outreach_templates`: optional DB-backed message templates (runtime falls back to built-ins if table absent).
- `outreach_delivery_log`: append-only record of every outreach email send attempt (recipient, subject, provider, status). Demo stack records `SIMULATED` rows only.
- `audit_packet_exports`: record of every audit packet generation (type, entity, format, actor, timestamp, payload hash, size).

## 3) Full Table Schemas

### 3.1 `measures`
```sql
id UUID PK DEFAULT gen_random_uuid()
name TEXT NOT NULL
policy_ref TEXT
owner TEXT
tags TEXT[]
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### 3.2 `measure_versions`
```sql
id UUID PK DEFAULT gen_random_uuid()
measure_id UUID NOT NULL REFERENCES measures(id)
osha_reference_id UUID REFERENCES osha_references(id)
version TEXT NOT NULL
status TEXT NOT NULL
spec_json JSONB NOT NULL
cql_text TEXT
compile_status TEXT
compile_result JSONB
change_summary TEXT
approved_by TEXT
activated_at TIMESTAMPTZ
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
UNIQUE(measure_id, version)
```

### 3.3 `osha_references`
```sql
id UUID PK DEFAULT gen_random_uuid()
cfr_citation TEXT NOT NULL UNIQUE
title TEXT NOT NULL
program_area TEXT NOT NULL
```

### 3.4 `value_sets`
```sql
id UUID PK DEFAULT gen_random_uuid()
oid TEXT NOT NULL
name TEXT NOT NULL
version TEXT
codes_json JSONB NOT NULL
last_resolved_at TIMESTAMPTZ
canonical_url TEXT
code_systems TEXT[] DEFAULT '{}'
source TEXT
status TEXT NOT NULL DEFAULT 'DRAFT'
expansion_hash TEXT
resolution_status TEXT NOT NULL DEFAULT 'UNKNOWN'
resolution_error TEXT
UNIQUE(oid, version)
```

Resolution status values: `RESOLVED`, `UNRESOLVED`, `EMPTY`, `ERROR`, `UNKNOWN`.
Demo value sets are seeded with fixed UUIDs (`a0000001-0000-0000-0000-00000000000{1-4}`) and `resolution_status = 'RESOLVED'` for stable cross-migration references.

### 3.4a `terminology_mappings`
```sql
id UUID PK DEFAULT gen_random_uuid()
local_code TEXT NOT NULL
local_display TEXT
local_system TEXT NOT NULL
standard_code TEXT NOT NULL
standard_display TEXT
standard_system TEXT NOT NULL
mapping_status TEXT NOT NULL
mapping_confidence NUMERIC
reviewed_by TEXT
reviewed_at TIMESTAMPTZ
notes TEXT
UNIQUE(local_system, local_code, standard_system, standard_code)
```

Mapping status values: `PROPOSED`, `REVIEWED`, `APPROVED`, `REJECTED`.
Demo seeds: 3 APPROVED mappings (audiogram→CPT 92557, TB PPD→CPT 86580, flu→CVX 141), 1 REVIEWED (HAZWOPER internal), 1 PROPOSED (TB IGRA→CPT 86480).

### 3.5 `measure_value_set_links`
```sql
measure_version_id UUID NOT NULL REFERENCES measure_versions(id)
value_set_id UUID NOT NULL REFERENCES value_sets(id)
PRIMARY KEY(measure_version_id, value_set_id)
```

### 3.6 Workforce / `employees`

> **backend-ts has no `employees` DB table.** In the TypeScript backend the workforce is the
> **synthetic employee directory** (`backend-ts/src/engine/synthetic/employee-catalog.ts`), resolved
> at read-time — it is the source of truth, not a relational table. Each entry is
> `{externalId, name, role, site, providerId, tenantId}`, where `site` is the **location** level,
> `providerId` attributes the employee to a clinician, and `tenantId` is the **WebChart system /
> employer** (the level above enterprise, E13 PR-1 / #185). The directory also exports `PROVIDERS`
> (synthetic occupational-health clinicians, 2 per location — the **provider** level, each carrying a
> `tenantId`), `TENANTS` + `enterpriseForTenant` (one enterprise per tenant in PR-1), giving the
> **tenant→enterprise→location→provider→patient** hierarchy. Two tenants ship: `twh` (Total Worker
> Health — the original 100 employees) and `ihn` (Indus Hospital Network — a second synthetic system,
> 50 employees / 3 campuses / 6 providers). `outcomes` and `cases` persist only the `subjectId`; every
> level above a subject — provider, location, enterprise, **tenant** — is resolved at read-time from
> the directory, so the multi-level rollup (`hierarchy-rollup.ts`, #74/E4; multi-tenant #185/E13)
> requires **no SQL and no `employees`/`tenants` table** (the #93 schema stop-and-ask gate is satisfied
> with no migration; ADR-010/ADR-019).

The schema below is the **historical Java-era `employees` table** (retired with the JVM in #109 PR4),
retained for reference only:

```sql
-- Java-era only (no longer present in backend-ts)
id UUID PK DEFAULT gen_random_uuid()
external_id TEXT UNIQUE NOT NULL
name TEXT NOT NULL
role TEXT
site TEXT
supervisor_id UUID REFERENCES employees(id)
fhir_patient_id TEXT
start_date DATE
active BOOLEAN DEFAULT TRUE
```

### 3.7 `runs`
```sql
id UUID PK DEFAULT gen_random_uuid()
scope_type TEXT NOT NULL
scope_id UUID
site TEXT
trigger_type TEXT NOT NULL
status TEXT NOT NULL
triggered_by TEXT
started_at TIMESTAMPTZ NOT NULL
completed_at TIMESTAMPTZ
total_evaluated INTEGER
compliant INTEGER
non_compliant INTEGER
duration_ms BIGINT
measurement_period_start TIMESTAMPTZ NOT NULL
measurement_period_end TIMESTAMPTZ NOT NULL
requested_scope_json JSONB NOT NULL DEFAULT '{}'::jsonb
failure_summary TEXT
partial_failure_count INTEGER NOT NULL DEFAULT 0
dry_run BOOLEAN NOT NULL DEFAULT FALSE
```

Runtime status values observed in the current implementation include `REQUESTED`, `QUEUED`, `RUNNING`, `PARTIAL_FAILURE`, `COMPLETED`, `FAILED`, and `CANCELLED`.
For measure/case runs, `scope_id` stores the resolved measure version UUID; for all-programs runs it remains null.
`triggered_by` is surfaced in the run read model and drives the derived `triggerType`: `triggered_by='seed:trend-history'` → `"SEED"`, otherwise `"MANUAL"`. See §3.20.

### 3.8 `run_logs`
```sql
id BIGSERIAL PK
run_id UUID NOT NULL REFERENCES runs(id)
ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
level TEXT NOT NULL
message TEXT NOT NULL
```

### 3.9 `outcomes`
```sql
id UUID PK DEFAULT gen_random_uuid()
run_id UUID NOT NULL REFERENCES runs(id)
employee_id UUID NOT NULL REFERENCES employees(id)
measure_version_id UUID NOT NULL REFERENCES measure_versions(id)
evaluation_period TEXT NOT NULL
status TEXT NOT NULL
evidence_json JSONB NOT NULL
evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
INDEX outcomes_employee_measure_period_idx(employee_id, measure_version_id, evaluation_period)
INDEX outcomes_run_id_idx(run_id)
```

### 3.10 `cases`
```sql
id UUID PK DEFAULT gen_random_uuid()
employee_id UUID NOT NULL REFERENCES employees(id)
measure_version_id UUID NOT NULL REFERENCES measure_versions(id)
evaluation_period TEXT NOT NULL
status TEXT NOT NULL
priority TEXT NOT NULL
assignee TEXT
next_action TEXT
current_outcome_status TEXT NOT NULL
last_run_id UUID NOT NULL REFERENCES runs(id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
closed_at TIMESTAMPTZ
UNIQUE(employee_id, measure_version_id, evaluation_period)
```

### 3.11 `case_actions`
```sql
id UUID PK DEFAULT gen_random_uuid()
case_id UUID NOT NULL REFERENCES cases(id)
action_type TEXT NOT NULL
payload_json JSONB
performed_by TEXT
performed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```

### 3.12 `audit_events`
```sql
id BIGSERIAL PK
event_type TEXT NOT NULL
entity_type TEXT NOT NULL
entity_id UUID
actor TEXT
ref_run_id UUID
ref_case_id UUID
ref_measure_version_id UUID
payload_json JSONB
occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
INDEX audit_events_ref_run_id_idx(ref_run_id)
INDEX audit_events_ref_case_id_idx(ref_case_id)
```

> **Reads (#181, no DDL):** the case-detail timeline is sourced **solely** from `audit_events`
> (`caseTimeline`) — the prior `audit_events UNION ALL case_actions` double-listed every action; both
> rows are still written atomically (`recordCaseEvent`), only the read is single-source. New bounded,
> newest-first store reads avoid materializing the whole ledger: `recentAuditEvents(limit)` (admin
> audit viewer — also bounds its per-case `getCase` loop) and `auditEventsForCases(caseIds, limit)`
> (employee-profile activity feed, pushes `ref_case_id IN (…)` + LIMIT into SQL). The admin **Outreach
> Delivery Log** view is derived read-time from `CASE_OUTREACH_SENT` audit events (no dedicated table
> on the demo stack — see §3.16). All additive store-contract changes; no schema change.

### 3.13 `integration_health`
```sql
id TEXT PK
display_name TEXT NOT NULL
status TEXT NOT NULL
last_sync_at TIMESTAMPTZ
last_sync_result TEXT
config_json JSONB NOT NULL DEFAULT '{}'::jsonb
```
Seeded IDs: `fhir`, `mcp`, `ai`, `hris`.

### 3.14 `outreach_templates` (optional migration-safe table)
Expected runtime schema:
```sql
id UUID PK DEFAULT gen_random_uuid()
name TEXT NOT NULL
subject TEXT NOT NULL
body_text TEXT NOT NULL
measure_id UUID REFERENCES measures(id)
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
```
If this table is absent, service falls back to built-in default templates.

### 3.15 `audit_packet_exports`
```sql
id UUID PK DEFAULT gen_random_uuid()
packet_type TEXT NOT NULL
entity_id UUID NOT NULL
format TEXT NOT NULL
generated_by TEXT NOT NULL
generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
payload_hash TEXT
payload_size_bytes BIGINT
```
`packet_type` values: `CASE`, `RUN`, `MEASURE_VERSION`.
`format` values: `json`, `html`.
`payload_hash` is a SHA-256 hex digest of the serialized packet bytes for integrity verification.
Written by `AuditPacketService` on every successful packet generation alongside an `AUDIT_PACKET_GENERATED` audit event.

### 3.16 `outreach_delivery_log`
```sql
id UUID PK DEFAULT gen_random_uuid()
case_id UUID NOT NULL REFERENCES cases(id)
case_action_id UUID REFERENCES case_actions(id)
to_address TEXT NOT NULL
subject TEXT NOT NULL
provider TEXT NOT NULL
status TEXT NOT NULL
sent_at TIMESTAMPTZ NOT NULL
error_detail TEXT
INDEX outreach_log_case_id_idx(case_id)
INDEX outreach_log_sent_at_idx(sent_at DESC)
```
One row per outreach email send attempt, written by `CaseFlowService.sendOutreach` via `EmailService`.
`provider` values: `simulated` (demo default), `sendgrid`.
`status` values: `SIMULATED` (no real email sent), `SENT`, `FAILED`.
`to_address` is a deterministic synthetic address `<employee.external_id>@workwell-demo.dev` (employees carry no email column; address is non-routable and stable across reruns).
Created by migration `V021__add_outreach_delivery_log.sql`. Surfaced read-only via `GET /api/admin/outreach/delivery-log` (`OutreachDeliveryLogService`, joined to measure name through cases→measure_versions→measures).
Truncated by the non-prod `DemoResetService`.

> **Note (#75 / E5 — channel-aware sends):** the per-case outreach action now carries a channel
> (EMAIL/SMS/PHONE, default EMAIL) via the `OutreachChannel` port. On the demo stack sends remain
> simulated, so this table is still **not persisted in `backend-ts`** — the `outreach_delivery_log`
> rows above are the production drop-in target (see §3.17), not written today.

### 3.17 Outreach campaigns — `CampaignStore` port (audit-backed today; no campaigns table)
E5 (#75) adds bulk outreach **campaigns** behind a `CampaignStore` port
(`backend-ts/src/stores/campaign-store.ts`). **There is no `outreach_campaigns` table in `backend-ts`
today** (no new DDL on the SQLite floor or the Pg ceiling). The audit-backed demo adapter
(`audit-campaign-store.ts`) persists each completed campaign as a single audit event:
```text
event_type = 'OUTREACH_CAMPAIGN_COMPLETED'
payload_json = { campaign: {...filters, channel, counts: { sent, failed, simulated }}, recipients: [...] }
```
Reads scan `listAuditEvents` and filter by `event_type` (O(total-ledger-size) — acceptable at demo scale).
Sends are simulated by default, so a campaign currently records simulated counts.

**Production drop-in (documented, not built):** a `PgCampaignStore` over a dedicated
`outreach_campaigns` table (one row per campaign: filters, channel, counts, status, owner, timestamps)
joined to the `outreach_delivery_log` (§3.16) for per-recipient delivery rows. This is the same
owner-gated schema work as §3.16 — when real sends are wired (SendGrid/DataChaser), both tables move
from documented to created. Until then the port keeps the data model unchanged.

### 3.18 Immunization forecasting — `ImmunizationForecast` port (read-time; no table)
E6 (#76) adds ACIP-style immunization forecasting behind the `ImmunizationForecast` port
(`backend-ts/src/engine/immunization/immunization-forecast.ts`). **No new DB table.** The forecast
is computed read-time by the simulated forecaster over its own deterministic per-subject synthetic
immunization history; it is never persisted in `backend-ts` today.

- **Refusal / contraindication** for the `adult_immunization` measure ride in `outcomes.evidence_json`
  as CQL expression defines (`Refused`, `Has Contraindication`) — no new columns.
- **Production drop-in (documented, not built):** an `immunization_forecasts` cache table (one row
  per subject + series: next-dose-due date, forecasting engine, computed-at timestamp) fed by a real
  ICE adapter behind `resolveForecaster`. This is the analogous pattern to §3.17 — when a real ICE
  adapter is wired, the cache table drops in without touching the measure or case schema. Until then
  the port keeps the data model unchanged.
- `adult_immunization` adds no new columns to `outcomes`, `cases`, or any other table. The advisory
  `immunizationForecast` block in `GET /api/cases/:id` is assembled at read-time.

### 3.19 Order proposals — derived read-time; no `orders` table
E7 (#77) adds an advisory proposed-order engine behind `GET /api/orders/proposals`. **There is no
`orders` or `submitted_orders` table in `backend-ts` today** (no new DDL on the SQLite floor or the
Pg ceiling). Proposals are derived read-time from `outcomes`:

- `proposeOrders(outcomes, provider)` in `backend-ts/src/order/order-proposal.ts` selects the
  at-risk subset (OVERDUE/DUE_SOON/MISSING_DATA), maps each to a `ProposedOrder` via the
  action-evaluator catalog, deduplicates in-batch, and suppresses subjects with a qualifying standing
  order (returned separately in `suppressed`).
- The `StandingOrderProvider` port (`backend-ts/src/order/standing-order-provider.ts`) abstracts the
  standing-order query: `simulatedStandingOrderProvider` (deterministic, no HTTP) is the default;
  `ehStandingOrderProvider` is an inert stub until both `WORKWELL_EH_FHIR_BASE_URL` +
  `WORKWELL_EH_FHIR_API_KEY` are set. The real EH query is a FHIR `ServiceRequest?subject=&status=active`
  search — a drop-in behind the port when credentials are available.
- Proposals are **advisory only** — a human reviews and submits; nothing is auto-submitted. Proposals
  are not persisted.

**Production drop-in (documented, not built):** when the real EH write path is wired, a future
`OrderSubmitter` port posts `ServiceRequest` resources to EH and an owner-gated
`submitted_orders` audit table records each submission (submittedAt, actor, measureId, subjectId,
orderCode, ehOrderId). Until then the port keeps the data model unchanged.

### 3.20 Synthetic trend history (seeded runs) — no schema change
PR #180 backfills backdated synthetic run history so the `/programs` + `/programs/[measureId]` trend
charts show realistic variation. It reuses the existing `runs`/`outcomes` tables and adds **no
schema/DDL change** (existing columns only):

- **Seeded runs** are written into `runs` with `triggered_by = 'seed:trend-history'`, backdated
  `started_at`/`completed_at`, and `status = 'COMPLETED'`. The run read model derives
  `triggerType="SEED"` for these (real operator runs → `"MANUAL"`); they are filterable via
  `GET /api/runs?triggerType=SEED`. Each measure's newest synthetic week is anchored strictly **before**
  that measure's latest real run, so the programs overview (latest-run-per-measure) is never hijacked.
- **Seeded outcomes** are written into `outcomes` tagged `evidence_json.seedTrendHistory = true` with a
  backdated `evaluated_at` (so seeded history does not out-sort the real latest outcome in
  `evaluated_at DESC` reads). `OutcomeWithRun` joins `runs.triggered_by` as `runTriggeredBy`, letting
  read models exclude seed runs by identity.
- **Audited:** one `TREND_HISTORY_SEEDED` audit event per seeded measure (every state change writes an
  audit event).
- **Idempotent + resumable** at the week level (keyed on the seeded started day =
  `outcomes.evaluation_period`): a rerun or larger `--weeks` fills only missing weeks, no duplicates.

Additive store-contract changes (no DDL): `CreateRunInput` gained optional `startedAt`/`completedAt`/
`status` (backdating; defaults now/null/`QUEUED`); `OutcomeStore` gained a `recordOutcomes(inputs[])`
batch insert (chunked multi-row on the Pg ceiling, atomic batch on the SQLite floor); and
`RecordOutcomeInput` gained an optional `evaluatedAt` (backdated; default now).

**Reversible rollback (synthetic demo data only) — delete tagged outcomes first, then runs**
(`outcomes.run_id` is not `ON DELETE CASCADE`; schema-qualify on the Pg ceiling):
```sql
DELETE FROM workwell_spike.outcomes
  WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history');
DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history';
```

### 3.21 Multi-alternative Hep B repoint (E11.2c / #183) — no schema change
The live `hepatitis_b_vaccination_series` measure was repointed onto the E11.2c multi-alternative-series
codegen (Heplisav-B 2-dose CVX 189 OR traditional 3-dose CVX 08/43/44/45, ACIP min intervals). This is
**additive seed/app data only — no DDL**: the `urn:workwell:vs:hepb-vaccines` value-set seed gained CVX
44/45 (`value-set-seed.ts`); the measure binding (`hepatitis_b.yaml` → `measure-bindings.ts`) gained a
merged `alternatives` array consumed by the alternative-aware synthetic dose model; the hand-written +
generated Hep B CQL/ELM were regenerated. `outcomes`/`cases` are unchanged — the per-alternative dose
counts/intervals ride in `outcomes.evidence_json.expressionResults` (the `"Heplisav-B Complete"` /
`"Traditional Complete"` / union `"Dose Count"` defines). Reversible by reverting the PR. CQL `Outcome
Status` remains the sole compliance authority (ADR-008/ADR-015).

### 3.22 Segments / risk-groups (E11.3 / #183) — 3 owner-gated tables

Segments map a cohort → an applicable rule-set; applicability gates **case creation + display only**, never
compliance (ADR-016). The first E11 feature with schema. Three tables on the floor + ceiling (TEXT ids,
app-generated `crypto.randomUUID()`; floor `enabled` INTEGER 0/1 + `rule_json` JSON TEXT, ceiling `enabled`
BOOLEAN + `rule_json` JSONB, schema-qualified to `workwell_spike`):

```sql
segments (
  id TEXT PK, name TEXT NOT NULL, description TEXT, enabled BOOLEAN/INTEGER NOT NULL DEFAULT true/1,
  rule_json JSONB/TEXT NOT NULL DEFAULT '{}',           -- cohort predicate {match, conditions[]}
  created_by TEXT, created_at TIMESTAMPTZ/TEXT NOT NULL, updated_at TIMESTAMPTZ/TEXT NOT NULL
)
segment_measures (                                       -- the applicable rule-set (M:N)
  segment_id → segments(id) ON DELETE CASCADE, measure_id TEXT, PRIMARY KEY (segment_id, measure_id)
)
segment_overrides (                                      -- per-employee INCLUDE/EXCLUDE membership corrections
  segment_id → segments(id) ON DELETE CASCADE, external_id TEXT, mode TEXT, PRIMARY KEY (segment_id, external_id)
)
```

`measure_id`/`external_id` are text keys into the synthetic measure registry + employee directory (no FK —
backend-ts has no `measures`/`employees` tables). Backed by a `SegmentStore` port (floor + ceiling, store
contract; `deleteSegment` removes child rows explicitly on the floor since `PRAGMA foreign_keys` is off,
cascades on the ceiling). Seeded idempotently by name with **3 ENABLED** demo cohorts (All Employees baseline
/ OSHA Safety-Sensitive / Clinical Staff) whose rule-sets together cover every Active runnable measure.
Because the seed ships enabled, the applicability overlay is **active on the demo stack** from first deploy.
**Reversibility:** zero enabled segments ⇒ everything applicable to everyone (pre-E11.3 behavior); the feature
reverts by disabling/deleting all segments. `outcomes`/`cases` are unchanged — the run pipeline only *skips* a case upsert when not
applicable; the outcome is still persisted. CQL `Outcome Status` stays authoritative (ADR-008/ADR-016).

### 3.23 Population-scale tenant (E13 PR-2 / #185) — encoded `subject_id`, no schema change

> **Live Neon status (2026-06-29):** seeded — 14 runs × 120,000 subjects = **1,680,000 outcomes** in
> `workwell_spike`; live All Systems = 1,682,100 (ihn 700 + twh 1,400 + mhn 1,680,000).

The `mhn` ("MetroHealth Network") tenant's ~120k subjects are **generated demo data with no schema
change**: they exist **only** as `outcomes` rows whose `subject_id` **encodes the hierarchy** —
`mhn|Lxx|Pxx|nnnnnnn` (tenant | location | provider | sequence; the codec + the small ~240-provider
structure are in `backend-ts/src/engine/synthetic/scale-structure.ts`). No employees, no new columns,
no new tables.

- **Seeded** by `pnpm seed:scale [--subjects 120000]` (`backend-ts/src/run/cli/`) — owner-run on-demand,
  **not** on deploy. One COMPLETED `MEASURE` run per runnable measure with `triggered_by='seed:scale'`,
  backdated, `evidence_json` minimal (`{scale:true}` — generated rows need no `expressionResults`).
  Idempotent (a single `seed:scale` run ⇒ no-op rerun); audited (`SCALE_POPULATION_SEEDED` per measure).
- **Read** via `OutcomeStore.aggregateScaleRun(runId)` — a single `GROUP BY` over the encoded
  `subject_id` (Postgres `split_part(subject_id,'|',…)`; SQLite `substr` over the fixed-width id),
  returning per (location, provider, status) counts — **O(providers)** rows, never the per-subject rows.
  The rollup + programs overview exclude `seed:scale` runs from the in-memory scan and build/fold `mhn`
  from this. `outcomes`/`cases`/`runs` schemas are **unchanged**.
- **Reversible** (delete tagged outcomes first, then runs; schema-qualify on the Pg ceiling):
  ```sql
  DELETE FROM workwell_spike.outcomes
    WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
  DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
  ```
CQL `Outcome Status` stays authoritative for live-evaluated subjects (ADR-008/ADR-020).

### 3.24 Quality-over-time snapshots — `quality_snapshots` (E16) — NEW table

A materialized AGGREGATE of a completed population run's outcomes per (measure, calendar month, scope),
so "what was measure X's population compliance on month M for scope S?" is a bounded table read instead
of a re-scan of the per-subject `outcomes` (O(120k) at population scale). The first E16 schema — one
table on the floor (`stores/sqlite/schema.ts`) + ceiling (`stores/postgres/schema-pg.ts`,
`workwell_spike`); TEXT id (`crypto.randomUUID()`), floor TEXT timestamps / ceiling TIMESTAMPTZ:

```sql
quality_snapshots (
  id TEXT PK, measure_id TEXT, period TEXT,                 -- period = 'YYYY-MM' (calendar month); measure_id = the outcomes slug
  period_start <ts>, period_end <ts>,                       -- calendar-month bounds
  scope_level TEXT,                                         -- 'all' | 'tenant' | 'site' | 'provider'
  scope_id TEXT,                                            -- 'ALL' | tenantId | tenantId|site | tenantId|site|providerId
  tenant_id TEXT,                                           -- null only for the 'all' root
  numerator INTEGER, denominator INTEGER,                   -- numerator = compliant; denominator = total − excluded
  compliant INTEGER, due_soon INTEGER, overdue INTEGER, missing_data INTEGER, excluded INTEGER,
  source_run_id TEXT, computed_at <ts>,
  UNIQUE (measure_id, period, scope_level, scope_id)        -- idempotent upsert; last write wins
)
-- indexes: (measure_id, period); (scope_level, scope_id)
```

- **Written** by `materializeRun` (`backend-ts/src/quality/`) on completion of a population run
  (ALL_PROGRAMS/MEASURE), hooked best-effort into `finishManualRun`. The scale tenant (`mhn`) folds in
  via `OutcomeStore.aggregateScaleRun` (a bounded GROUP BY) — the 120k per-subject rows are never loaded.
  Idempotent (floor `INSERT OR REPLACE`, ceiling `ON CONFLICT DO UPDATE`); audited
  (`QUALITY_SNAPSHOT_MATERIALIZED`).
- **Aggregate-only** — no per-employee row (that would reintroduce the 160k-row scan the table exists to
  avoid; the per-person Simulate path #197 covers the individual case). Reconciles
  All = Σ tenants = Σ sites = Σ providers at every (measure, period). `numerator`/`denominator` reuse the
  proportion model (`fhir/measure-report.ts` `countPopulations`).
- **Read** via the `QualitySnapshotStore` port (`querySnapshots({measureId, scopeLevel, scopeId, tenantId, from, to})`),
  surfaced by `GET /api/quality/history` (E16 PR-2, authenticated read-only). Also **backfilled** for past
  months by `pnpm seed:quality-history` (`run/backfill-quality-history.ts`) — real evaluated snapshots
  (audited `QUALITY_HISTORY_BACKFILLED`), superseding the synthetic `seed:trend-history` for the quality
  trend; idempotent + resumable at the month level. The `/programs/[measureId]` "Quality over time" card
  (E16 PR-3) consumes the read API.
- **Reversible** (synthetic-friendly; schema-qualify on the Pg ceiling):
  ```sql
  DELETE FROM workwell_spike.quality_snapshots;
  ```
Descriptive only — CQL `Outcome Status` stays the sole compliance authority (ADR-008/ADR-021).

### 3.25 Cross-system identity (E15 PR-1 / #187) — read-time; no table

Cross-system person identity is resolved **read-time from the synthetic directory** — **no new DB table**
in PR-1 (mirrors E13/ADR-019). A small set of synthetic people exist in >1 WebChart system, modeled by a
shared `nationalId` + `dateOfBirth` on a couple of **existing** twh↔ihn `EmployeeProfile` rows (the two
fields are **new optional columns on the synthetic `EmployeeProfile` type**, §3.6 — not a DB column;
present only on the cross-system rows, absent ⇒ the record is its own singleton person). No rows are added
and no existing ids change, so E13 tenant counts and reconciliation (All = Σ tenants) are untouched.

- `resolvePeople`/`duplicateCandidates`/`mergedComplianceTimeline` (`backend-ts/src/identity/`) group and
  annotate at read-time; the merged timeline reuses the existing per-subject `outcomes` read
  (`listOutcomesForEmployee`). A `MOBILITY_OVERLAY` seed marks a moved person's PRIOR system + move date.
- **Reconcile overrides (E15 PR-2, now built):** human-confirmed CONFIRMED/BROKEN links are persisted in
  the owner-approved `person_links` table (**§3.26**) and applied at read-time by `resolvePeople`, written
  by the audited `POST /api/identity/people/:id/reconcile`. The auto grouping above still needs no table;
  only the manual overrides do. Descriptive only — identity never sets `Outcome Status` (ADR-008/ADR-022).

### 3.26 Cross-system identity links — `person_links` (E15 PR-2 / #187) — NEW owner-approved table

The first E15 schema. A human-confirmed assertion that two source-system records ARE (`CONFIRMED`) or
are NOT (`BROKEN`) the same person — the audited write path behind the reconcile action. One table on
the floor (`stores/sqlite/schema.ts`) + ceiling (`stores/postgres/schema-pg.ts`, `workwell_spike`); TEXT
id (`crypto.randomUUID()`), floor TEXT / ceiling TIMESTAMPTZ timestamps:

```sql
person_links (
  id             TEXT PK,
  a_tenant_id    TEXT NOT NULL, a_external_id TEXT NOT NULL,   -- pair normalized so (a) <= (b)
  b_tenant_id    TEXT NOT NULL, b_external_id TEXT NOT NULL,   -- lexicographically, direction-independent
  link_type      TEXT NOT NULL,                               -- 'CONFIRMED' | 'BROKEN'
  created_by     TEXT, created_at <ts> NOT NULL,
  UNIQUE (a_tenant_id, a_external_id, b_tenant_id, b_external_id)
)
```

- **Read-time override** (`resolvePeople`, `backend-ts/src/identity/`): auto matchKey grouping is unioned
  by CONFIRMED pairs and split by BROKEN pairs (union-find; BROKEN removes the direct edge). Pairs are
  normalized on write, so CONFIRM(x,y) and UNLINK(y,x) hit the same row (last write wins — the floor uses
  `INSERT OR REPLACE`, the ceiling `ON CONFLICT … DO UPDATE`). No FK — `a_*`/`b_*` are text refs into the
  synthetic directory (backend-ts has no `employees` table).
- **Written** only by `POST /api/identity/people/:personId/reconcile` (CASE_MANAGER/ADMIN), audited
  `IDENTITY_LINK_CONFIRMED`/`IDENTITY_LINK_BROKEN`. Backed by the `PersonLinkStore` port (floor + ceiling;
  store-contract tested).
- **Descriptive only** — a link overrides read-time grouping, never `Outcome Status` (ADR-008/ADR-022);
  E13 reconciliation (All = Σ tenants) is unaffected (a link never moves a record between tenants).
- **Reversible** (schema-qualify on the Pg ceiling): `DELETE FROM workwell_spike.person_links;` Also
  **truncated by the non-prod `DemoResetService`** (with the run-derived volatile tables) so a demo reset
  returns to the auto-resolved baseline — a manual CONFIRM/UNLINK never persists past a reset while its
  `audit_events` are wiped.

The read-time note in §3.25 (identity resolved from the synthetic directory, no table in PR-1) still holds
for the auto grouping; PR-2 adds only this overrides table.

## 4) Idempotency Contract for Case Upsert
Constraint: `UNIQUE(employee_id, measure_version_id, evaluation_period)`.

### Worked Example
Inputs:
- employee: `emp-006`
- measure version: Audiogram `v1.0`
- evaluation period: `2026-05-06`

Run A outcome: `OVERDUE`
- No existing row -> insert new `cases` row (`status=OPEN`, `priority=HIGH`).

Run B outcome (same key): `OVERDUE`
- Conflict on unique key -> update same row (`updated_at`, `last_run_id`, `next_action`, etc.).
- No duplicate case created.

Run C outcome (same key): `COMPLIANT`
- Existing row is resolved (`status=RESOLVED`, `closed_at=NOW()`, `closed_reason='AUTO_RESOLVED'`,
  `closed_by=NULL` — a **system** closure).

### State-aware upsert (Fable H1/H2, 2026-07-02)
`upsertFromOutcome` is no longer a blanket `ON CONFLICT DO UPDATE SET status = excluded.status`. Both the
SQLite floor and the Pg ceiling read the current row and apply the shared pure `planCaseUpsert`
(`backend-ts/src/case/case-logic.ts`):
- **IN_PROGRESS is preserved** on a still-non-compliant run (an operator's "scheduling" state is never
  clobbered back to OPEN).
- **Human closures are respected.** A case a person closed (`closed_by` set) is **not** reopened by a
  later non-compliant run; only a **system** closure (`closed_by IS NULL`) reopens — either a prior
  auto-resolve (status `RESOLVED`) or an auto-exclusion (status `EXCLUDED`) whose waiver has since
  lapsed so CQL no longer returns EXCLUDED (Codex P2). Reopening a human-closed case is left an
  explicit, audited operator action.
- **Active-case counts include `IN_PROGRESS`.** Because the upsert now preserves `IN_PROGRESS` (rather
  than flipping it to OPEN), every "active/open case" rollup (`ACTIVE_CASE_STATUSES` = `OPEN` +
  `IN_PROGRESS`) counts both — otherwise a reconfirmed IN_PROGRESS case would silently drop out of the
  hierarchy/programs open-case count (Codex P2).
- **No `closed_at` drift.** A COMPLIANT outcome on an already-terminal case is a no-op.
- The upsert returns an `UpsertedCase` (a `CaseRecord` superset carrying a `disposition` of
  `CREATED | UPDATED | REOPENED | RESOLVED | EXCLUDED | UNCHANGED`). The run pipeline emits a matching
  `CASE_*` audit event for every disposition except `UNCHANGED` (an idempotent re-confirm of the same open
  outcome — refreshed silently, so a nightly run records one `RUN_COMPLETED`, not hundreds of noise
  events). Population runs previously wrote **no** case/run audit events at all — the H1 hard-rule fix.

## 5) `evidence_json` Contract (authoritative)

### Canonical shape
```json
{
  "expressionResults": [
    { "define": "In Hearing Conservation Program", "result": true },
    { "define": "Has Active Waiver", "result": false },
    { "define": "Most Recent Audiogram Date", "result": "2025-03-10T00:00:00Z" },
    { "define": "Days Since Last Audiogram", "result": 420 },
    { "define": "Outcome Status", "result": "OVERDUE" }
  ],
  "evaluatedResource": {
    "patientId": "emp-006",
    "measureId": "audiogram",
    "measurementPeriod": {
      "start": "2025-05-06T00:00:00Z",
      "end": "2026-05-06T00:00:00Z"
    }
  },
  "why_flagged": {
    "last_exam_date": "2025-03-10",
    "compliance_window_days": 365,
    "days_overdue": 55,
    "role_eligible": true,
    "site_eligible": true,
    "waiver_status": "NONE",
    "outcome_status": "OVERDUE"
  }
}
```

### Field-by-field meaning
- `expressionResults`: raw define outputs from the CQL engine used for traceability.
- `evaluatedResource`: resource-level context used during evaluation.
- `why_flagged`: derived/explainer fields used by UI for readable case diagnostics.

If evaluation fails for one employee, `evidence_json` includes:
```json
{ "evaluationError": "CQL engine failure", "message": "<error text>" }
```
with status forced to `MISSING_DATA`.

## 6) CSV Export Contracts

### 6.1 `GET /api/exports/runs?format=csv`
Columns:
`runId, measureName, measureVersion, scopeType, triggerType, status, startedAt, completedAt, durationMs, totalEvaluated, compliant, dueSoon, overdue, missingData, excluded, passRate, dataFreshAsOf`

### 6.2 `GET /api/exports/outcomes?format=csv&runId={optional}`
Columns:
`outcomeId, runId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, lastExamDate, complianceWindowDays, daysOverdue, roleEligible, siteEligible, waiverStatus, evaluatedAt`

### 6.3 `GET /api/exports/cases?format=csv`
Columns:
`caseId, employeeExternalId, employeeName, role, site, measureName, measureVersion, evaluationPeriod, status, priority, assignee, currentOutcomeStatus, nextAction, lastRunId, createdAt, updatedAt, closedAt, latestOutreachDeliveryStatus`

Supports filters: `status`, `measureId`, `priority`, `assignee`, `site`, `caseIds`.

### 6.4 `GET /api/audit-events/export?format=csv`
Audit event export is append-only and includes event metadata + payload snapshot for timeline reconstruction.
