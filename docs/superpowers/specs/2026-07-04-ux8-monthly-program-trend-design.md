# UX-8 — Monthly-snapshot program-card trends

**Date:** 2026-07-04
**Status:** Approved — ready for implementation plan
**Ticket:** UX-8 (Fable review `03-ui-ux-inspection.md`)

## Problem

The `/programs` landing-page per-card trend chart draws from **per-run** compliance
history (`GET /api/programs/:id/trend` → `ProgramTrendPoint[]`, newest 10 runs). Under
the E13 PR-3 daily scheduled runs the per-run rate barely moves, so several cards
flat-line at ~78% and render "↑ 0% from last run" — the hero visualization communicates
nothing and the delta reads like a bug.

The E16 `quality_snapshots` table already stores the real quality-over-time series
(measure × calendar month × scope) and backs the measure-page "Quality over time" card.
UX-8 rewires the landing-page card trends onto that same source of truth so the hero
tells the E16 story: a monthly trend that actually moves.

## Goal

Each `/programs` card shows a **monthly** compliance trend from `quality_snapshots`,
re-scoped by the page's global System (tenant) and Site filters, falling back to the
existing per-run trend when a scope has insufficient monthly history. Descriptive only —
no compliance is (re)computed (ADR-008).

## Non-goals

- No schema change (reuses `quality_snapshots`), no new endpoint, no new deps.
- The measure-page "Quality over time" card (E16 PR-3) is untouched.
- No change to the KPI numbers on the card (compliance %, open cases) — only the trend.

## Design

### 1. Scope resolution (`snapshotScopeFor`)

A pure helper maps the existing `ProgramFilters` (`tenant`, `site`) → a
`quality_snapshots` scope `{ scopeLevel, scopeId }`, mirroring how `buildSnapshotRows`
keys them:

| Filters | Scope |
|---|---|
| no tenant, no site | `{ "all", "ALL" }` |
| tenant only | `{ "tenant", tenantId }` |
| site set (tenant known or uniquely resolvable from the directory) | `{ "site", "tenantId\|site" }` |
| site set but tenant ambiguous / unresolvable | `null` → per-run fallback |

Site→tenant resolution reuses the synthetic employee directory (a site belongs to a
tenant). If a site name maps to more than one tenant and no tenant filter narrows it, the
helper returns `null` and the trend falls back to per-run (the fallback covers every
scope the snapshot table can't cleanly answer).

### 2. `programTrend` — monthly path with per-run fallback

`ProgramDeps` gains an **optional** `qualitySnapshots?: QualitySnapshotStore` (optional so
existing callers/tests compile unchanged; absent ⇒ per-run only). `programTrend` becomes:

1. If `deps.qualitySnapshots` present and `snapshotScopeFor(filters)` resolves:
   `querySnapshots({ measureId, scopeLevel, scopeId, from, to })` — the `YYYY-MM-DD`
   `from`/`to` filters are mapped to `YYYY-MM` (slice to month). Rows come back period-ASC.
2. If **≥ 2** monthly rows → return a monthly `ProgramTrendPoint[]` (chronological, capped
   to the last 12 months):
   - `complianceRate` = round1(numerator, denominator)
   - `totalEvaluated` = denominator
   - `compliant`/`dueSoon`/`overdue`/`missingData`/`excluded` = the snapshot bucket counts
   - `period` = `"YYYY-MM"` (new field)
   - `startedAt` = the snapshot `period_end` (keeps existing timestamp ordering valid)
   - `runId` = the snapshot `source_run_id` (kept for key stability; not shown)
3. Otherwise → the **existing per-run trend, unchanged** (`period` undefined).

`ProgramTrendPoint` gains one additive field: `period?: string`. The response stays an
array; granularity is inferred by the consumer from `points[0]?.period`.

The `/api/programs/:id/trend` route passes `qualitySnapshots: stores.qualitySnapshots`
into `ProgramDeps`. No other program read model (`programOverview`, `programTopDrivers`,
`riskOutlook`) changes.

### 3. Frontend — `TrendChart` (`app/(dashboard)/programs/page.tsx`)

`TrendPoint` gains `period?: string`. The component branches on `data[0]?.period`:

- **Monthly** (`period` present): x-axis label = month short-form (e.g. `Jun`), the delta
  line reads **"from last month"**, and the caption + `ChartDataTable` row label use the
  month. Chart body and styling are otherwise identical.
- **Per-run** (no `period`): identical to today.

No new fetch — the card keeps its single per-card `/trend` call. The existing
`ChartDataTable` screen-reader alternative and `aria-hidden` chart pattern are preserved.

## Data flow

```
/programs card
  → GET /api/programs/:id/trend?tenant=&site=&from=&to=   (already called per card)
      → programTrend(deps{+qualitySnapshots}, id, filters)
          → snapshotScopeFor(filters) → scope | null
          → scope && store.querySnapshots(...) ≥2 months ? monthly points (period-stamped)
                                                          : per-run points (unchanged)
  ← ProgramTrendPoint[] (each optionally carrying `period`)
  → TrendChart infers month-vs-run from points[0].period → labels + "from last month"
```

## Testing

- **Backend** (`program-read-models.test.ts`): a fake `QualitySnapshotStore` —
  (a) ≥2 snapshots at the resolved scope → monthly points with `period` + rate from
  numerator/denominator; (b) <2 snapshots → per-run fallback (existing behavior);
  (c) `snapshotScopeFor` returns all/tenant/site correctly and `null` for an ambiguous
  site; (d) no `qualitySnapshots` dep → per-run (back-compat).
- **Frontend** (vitest): `TrendChart` with period-stamped data renders month labels +
  "from last month"; per-run data renders unchanged.

## Rollback

Additive and reversible by reverting the PR — the per-run trend path is retained as the
fallback, so removing the monthly branch restores prior behavior. No schema, no data
migration.
