# Synthetic Trend History — Design

**Date:** 2026-06-20
**Branch:** `feat/synthetic-trend-history`
**Status:** Approved (approach A, ~12 weeks weekly, feature-branch delivery)

## Problem
The per-measure trend charts on `/programs` and `/programs/[measureId]` render as flat lines or "Not enough run history for trend." Two causes:
1. `run/compliance-rates.ts` defines **one fixed rate per measure**, and runs are deterministic → every run yields the same compliance %, so any trend is a flat line.
2. Most measures have only **one** population run, so the trend has too few points.

The trend read model (`program/program-read-models.ts → programTrend`) plots one point per population run: `(runId, startedAt, complianceRate)`, newest-first, **capped at 10**, computed from that run's persisted `outcomes`.

## Goal
Seed realistic, varied trend history so each runnable measure shows a believable wavy compliance line over the past ~12 weeks, using the **real store + real engine-derived outcomes** (no faked SQL, no frontend mocking, all invariants intact).

## Approach (A — approved)
A controlled, idempotent **backfill** that writes ~12 weekly **backdated** `COMPLETED` MEASURE runs per runnable measure, each with a compliance rate that varies week-to-week around the measure's base rate.

### Key efficiency insight
`deriveExamConfig(binding, target)` depends only on **(measure, target)** — not on employee identity — and `buildSyntheticBundle` produces the same outcome for that config regardless of which employee it's stamped on. So the engine's outcome for a given `(measure, target)` is identical across all employees. We therefore precompute the `(measure, target) → outcome` map with **55 engine calls** (11 measures × 5 targets) and assign all historical outcomes from distributions — instead of 13,200 engine evaluations.

## Components

1. **`historicalComplianceRate(rateKey, weekIndex, totalWeeks)`** (in `run/compliance-rates.ts`)
   - Pure, deterministic (no `Math.random`): base rate ± a bounded oscillation, seeded by `javaHashCode(rateKey)` so each measure has its own phase/shape; clamped to `[0.40, 0.99]`.
   - Amplitude ~±0.06. `weekIndex` 0 = oldest, `totalWeeks-1` = newest. The newest historical week should land near the measure's base rate so it's continuous with the current real run.

2. **`seededDistributionAtRate(employees, rateKey, rate)`** (in `run/distribution.ts`)
   - Extract the existing `seededDistribution` body to accept an explicit rate; `seededDistribution` keeps current behavior by calling it with `complianceRate(rateKey)`. No behavior change to existing callers.

3. **Store: optional backdating** (`stores/run-store.ts` + both adapters)
   - Add optional `startedAt?`, `completedAt?`, `status?` to `CreateRunInput`. SQLite + Postgres adapters use them when present, else current defaults (`now`, `QUEUED`). Columns already exist — **no schema/DDL change**.
   - Add `recordOutcomes(inputs: RecordOutcomeInput[])` batch to `OutcomeStore` (+ both adapters) so 13.2k inserts are practical on Neon (chunked multi-row insert; SQLite floor loops in a txn).
   - The Postgres store-contract test (`stores/store-contract.ts`) gets coverage for backdated `createRun` + batch `recordOutcomes`.

4. **`backfillTrendHistory(deps, { weeks = 12, asOf? })`** (new `run/backfill-trend-history.ts`)
   - **Idempotent:** skip entirely if any run with `triggeredBy === "seed:trend-history"` already exists.
   - Precompute `(measure, target) → outcome` (55 engine calls).
   - For each runnable measure × week `w` (oldest→newest): `startedAt`/`completedAt` = `asOf − (weeks − w) * 7d`; `rate = historicalComplianceRate(rateKey, w, weeks)`; `createRun({ scopeType: "MEASURE", scopeId: measureId, triggeredBy: "seed:trend-history", status: "COMPLETED", startedAt, completedAt, measurementPeriod… })`; `recordOutcomes` for all 100 employees from `seededDistributionAtRate`, status = precomputed outcome for that target, evidence = `{ seedTrendHistory: true, target, rate }`.
   - **Does NOT** call `caseStore.upsertFromOutcome` — historical runs must not mutate the live worklist/cases. Only `runs` + `outcomes` are written.

5. **CLI script** `run/cli/seed-trend-history.ts` + `package.json` script `seed:trend-history`
   - Builds the store from `env` (same factory as the worker; honors `DATABASE_URL` for Neon), runs `backfillTrendHistory`, prints a summary. Controlled, on-demand — **not** wired into request-path startup (avoids slow/accidental backfills). Run locally or against Neon when ready.

## Data flow
`seed:trend-history` → `backfillTrendHistory` → (precompute outcomes via engine) → per measure/week: `runStore.createRun(backdated, COMPLETED)` + `outcomeStore.recordOutcomes(100)` → `programTrend` reads them as population runs → varied chart.

## Invariants preserved
- CQL remains the outcome source (outcomes come from the engine-derived `(measure,target)→outcome` map; the existing real seed uses the same target→outcome path).
- No schema/DDL change (only optional params over existing columns).
- Cases/worklist untouched (no case upsert in the backfill).
- Idempotent (week-level) + reversible. All seeded runs carry `triggered_by = 'seed:trend-history'` and outcomes are tagged `evidence.seedTrendHistory = true`. The `outcomes.run_id` FK is **not** `ON DELETE CASCADE`, so rollback deletes the tagged outcomes **first**, then the runs (schema-qualify on the Postgres ceiling):
  ```sql
  DELETE FROM workwell_spike.outcomes
    WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history');
  DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:trend-history';
  ```
- Programs **overview** unaffected: each measure's newest synthetic week is anchored strictly **before that measure's latest real run** (excluding the feature's own seeded runs), and the overview selects `max(runStartedAt)` per measure — so a seeded point can never become "current".
- Every synthetic write is audited: a `TREND_HISTORY_SEEDED` audit event per seeded measure (CLAUDE.md "every state change writes audit_event").

## Testing
- `historicalComplianceRate`: deterministic, bounded `[0.40,0.99]`, varies across weeks, differs by measure, newest week ≈ base rate.
- `seededDistributionAtRate`: counts match the rate; default path unchanged.
- `backfillTrendHistory` (SQLite in-memory floor): creates `weeks × measures` runs all `COMPLETED` with backdated, strictly increasing `startedAt`; ~100 outcomes/run; idempotent on second call (no duplicates); cases store untouched; `programTrend` returns >1 distinct `complianceRate`.
- Store adapters: backdated `createRun` round-trips `startedAt`/`completedAt`/`status`; `recordOutcomes` batch persists all rows.
- Full `pnpm typecheck` + `pnpm test` green.

## Out of scope
- Backdating the existing real runs; changing the trend cap (stays 10); any frontend change (the chart already renders multi-point trends correctly).
