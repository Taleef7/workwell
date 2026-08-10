# UX-8 — Monthly-snapshot program-card trends — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewire the `/programs` per-card trend chart from per-run history to the monthly `quality_snapshots` time-series (scoped by the page's tenant/site filters), falling back to the per-run trend when a scope has <2 monthly snapshots.

**Architecture:** Approach A — extend the existing `GET /api/programs/:id/trend` server-side. Two new pure helpers (`snapshotScopeFor`, `monthlyTrendPoints`) drive a monthly branch in `programTrend`; `ProgramTrendPoint` gains an additive `period?` field; the frontend `TrendChart` infers month-vs-run from `period` via a colocated pure `trendMeta` helper. No schema, no new endpoint, no new deps.

**Tech Stack:** TypeScript (`backend-ts`, node:test); Next.js 16 / React 19 / Recharts / vitest (`frontend`).

Spec: `docs/superpowers/specs/2026-07-04-ux8-monthly-program-trend-design.md`. Branch `feat/ux8-monthly-trend` (already created).

---

## File Structure

- **Modify** `backend-ts/src/program/program-read-models.ts` — add `snapshotScopeFor` + `monthlyTrendPoints` (exported pure helpers), add optional `qualitySnapshots` to `ProgramDeps`, add `period?` to `ProgramTrendPoint`, add the monthly branch to `programTrend`.
- **Create** `backend-ts/src/program/program-trend.test.ts` — unit tests for the two helpers + the monthly/fallback wiring (fakes).
- **Modify** `backend-ts/src/routes/programs.ts` — pass `qualitySnapshots: s.qualitySnapshots` into `ProgramDeps`.
- **Create** `frontend/app/(dashboard)/programs/trend-meta.ts` — the `TrendPoint` type + pure `trendMeta(data)` (labels, delta label, date-column header, monthly flag).
- **Create** `frontend/app/(dashboard)/programs/trend-meta.test.ts` — unit tests for `trendMeta`.
- **Modify** `frontend/app/(dashboard)/programs/page.tsx` — import `TrendPoint`/`trendMeta`, use them in `TrendChart`; make the delta text, `ChartDataTable` header, and caption granularity-aware.

---

## Task 1: `snapshotScopeFor` — map filters → snapshot scope (backend, pure)

**Files:**
- Modify: `backend-ts/src/program/program-read-models.ts`
- Test: `backend-ts/src/program/program-trend.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/program/program-trend.test.ts`:

```ts
/**
 * UX-8 — monthly-snapshot program trend. Unit-tests the two pure helpers + the monthly/fallback
 * wiring in programTrend.
 *   node --import tsx --test src/program/program-trend.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
// Task 2 adds `monthlyTrendPoints` and Task 3 adds `programDeps`/`ProgramDeps` + `programTrend` to this
// import as those tasks are implemented. Task 1 uses only `snapshotScopeFor`.
import { snapshotScopeFor } from "./program-read-models.ts";
import type { QualitySnapshotRow } from "../stores/quality-snapshot-store.ts";

test("snapshotScopeFor — no tenant/site → all/ALL", () => {
  assert.deepEqual(snapshotScopeFor({}), { scopeLevel: "all", scopeId: "ALL" });
});

test("snapshotScopeFor — tenant only → tenant/<id>", () => {
  assert.deepEqual(snapshotScopeFor({ tenant: "ihn" }), { scopeLevel: "tenant", scopeId: "ihn" });
});

test("snapshotScopeFor — tenant + site → site/<tenant|site>", () => {
  assert.deepEqual(snapshotScopeFor({ tenant: "twh", site: "Plant A" }), { scopeLevel: "site", scopeId: "twh|Plant A" });
});

test("snapshotScopeFor — site alone resolves its tenant from the directory", () => {
  // "Plant A" belongs to twh in the synthetic directory → resolves uniquely.
  assert.deepEqual(snapshotScopeFor({ site: "Plant A" }), { scopeLevel: "site", scopeId: "twh|Plant A" });
});

test("snapshotScopeFor — unknown site (no tenant) → null (fall back to per-run)", () => {
  assert.equal(snapshotScopeFor({ site: "Nowhere" }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/program/program-trend.test.ts`
Expected: FAIL — `snapshotScopeFor` export not found.

- [ ] **Step 3: Add the imports + `snapshotScopeFor` to `program-read-models.ts`**

At the top of `backend-ts/src/program/program-read-models.ts`, extend the existing imports. Change the `employee-catalog` import line (currently line 14) and add the snapshot-store type import after the existing store imports:

```ts
import { EMPLOYEES, employeeById, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { QualitySnapshotStore, QualitySnapshotRow, QualityScopeLevel } from "../stores/quality-snapshot-store.ts";
```

Then add the helper immediately after the `ProgramFilters` interface (after line 42):

```ts
/**
 * Map the page's tenant/site filters to a `quality_snapshots` scope (UX-8). Mirrors how
 * `buildSnapshotRows` keys scope_id: `"ALL"` | tenantId | `${tenantId}|${site}`. A site is
 * resolved to its tenant from the directory when no tenant filter narrows it; an unknown or
 * multi-tenant site returns null → the caller falls back to the per-run trend.
 */
export function snapshotScopeFor(
  filters: ProgramFilters,
): { scopeLevel: QualityScopeLevel; scopeId: string } | null {
  const site = filters.site?.trim() || null;
  const tenant = filters.tenant?.trim() || null;
  if (site) {
    let tenantId = tenant;
    if (!tenantId) {
      const tenants = [...new Set(EMPLOYEES.filter((e) => e.site === site).map((e) => e.tenantId))];
      if (tenants.length !== 1) return null; // 0 (unknown) or >1 (ambiguous) → per-run fallback
      tenantId = tenants[0]!;
    }
    return { scopeLevel: "site", scopeId: `${tenantId}|${site}` };
  }
  if (tenant) return { scopeLevel: "tenant", scopeId: tenant };
  return { scopeLevel: "all", scopeId: "ALL" };
}
```

- [ ] **Step 4: Run the `snapshotScopeFor` tests to verify they pass**

Run: `cd backend-ts && node --import tsx --test src/program/program-trend.test.ts`
Expected: the 5 `snapshotScopeFor` tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/program/program-read-models.ts backend-ts/src/program/program-trend.test.ts
git commit -m "feat(ux8): snapshotScopeFor — map program filters to a quality_snapshots scope"
```

---

## Task 2: `monthlyTrendPoints` — snapshot rows → trend points (backend, pure)

**Files:**
- Modify: `backend-ts/src/program/program-read-models.ts`
- Test: `backend-ts/src/program/program-trend.test.ts`

- [ ] **Step 1: Add the failing test**

First extend the import in `backend-ts/src/program/program-trend.test.ts` to add `monthlyTrendPoints`:

```ts
import { snapshotScopeFor, monthlyTrendPoints } from "./program-read-models.ts";
```

Then append to the same file:

```ts
const snap = (period: string, num: number, den: number): QualitySnapshotRow => ({
  id: `snap-${period}`,
  measureId: "audiogram",
  period,
  periodStart: `${period}-01T00:00:00.000Z`,
  periodEnd: `${period}-28T00:00:00.000Z`,
  scopeLevel: "all",
  scopeId: "ALL",
  tenantId: null,
  numerator: num,
  denominator: den,
  compliant: num,
  dueSoon: 0,
  overdue: den - num,
  missingData: 0,
  excluded: 0,
  sourceRunId: `run-${period}`,
  computedAt: `${period}-28T00:00:00.000Z`,
});

test("monthlyTrendPoints — maps rows chronologically, stamps period, rate = round1(num,den)", () => {
  const pts = monthlyTrendPoints([snap("2026-06", 8, 10), snap("2026-04", 5, 10), snap("2026-05", 9, 10)]);
  assert.deepEqual(pts.map((p) => p.period), ["2026-04", "2026-05", "2026-06"]);
  assert.equal(pts[2]!.complianceRate, 80); // 8/10
  assert.equal(pts[2]!.totalEvaluated, 10); // denominator
  assert.equal(pts[2]!.startedAt, "2026-06-28T00:00:00.000Z"); // periodEnd
  assert.equal(pts[0]!.overdue, 5); // bucket carried through
});

test("monthlyTrendPoints — caps to the newest 12 months", () => {
  // 15 distinct months 2025-01 … 2026-03; expect only the newest 12 (2025-04 … 2026-03).
  const many = Array.from({ length: 15 }, (_, i) =>
    snap(`20${25 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`, 1, 2),
  );
  const pts = monthlyTrendPoints(many);
  assert.equal(pts.length, 12);
  assert.equal(pts[0]!.period, "2025-04");
  assert.equal(pts[11]!.period, "2026-03");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/program/program-trend.test.ts`
Expected: FAIL — `monthlyTrendPoints` not exported.

- [ ] **Step 3: Add `period?` to `ProgramTrendPoint` and implement `monthlyTrendPoints`**

In `backend-ts/src/program/program-read-models.ts`, add `period` to the `ProgramTrendPoint` interface (after the `startedAt` field):

```ts
export interface ProgramTrendPoint {
  runId: string;
  startedAt: string;
  /** Present only for monthly (quality_snapshots) points — `YYYY-MM` (UX-8). Absent ⇒ per-run point. */
  period?: string;
  complianceRate: number;
  totalEvaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
}
```

Then add the helper immediately after `snapshotScopeFor`:

```ts
/** Map monthly snapshot rows → chronological trend points (last 12 months), stamped with `period` (UX-8). */
export function monthlyTrendPoints(rows: QualitySnapshotRow[]): ProgramTrendPoint[] {
  return rows
    .slice()
    .sort((a, b) => a.period.localeCompare(b.period))
    .slice(-12)
    .map((r): ProgramTrendPoint => ({
      runId: r.sourceRunId ?? r.id,
      startedAt: r.periodEnd,
      period: r.period,
      complianceRate: round1(r.numerator, r.denominator),
      totalEvaluated: r.denominator,
      compliant: r.compliant,
      dueSoon: r.dueSoon,
      overdue: r.overdue,
      missingData: r.missingData,
      excluded: r.excluded,
    }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/program/program-trend.test.ts`
Expected: the `snapshotScopeFor` + `monthlyTrendPoints` tests PASS (the `programTrend` wiring tests are added in Task 3).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/program/program-read-models.ts backend-ts/src/program/program-trend.test.ts
git commit -m "feat(ux8): monthlyTrendPoints + period field on ProgramTrendPoint"
```

---

## Task 3: monthly branch in `programTrend` + optional `qualitySnapshots` dep (backend)

**Files:**
- Modify: `backend-ts/src/program/program-read-models.ts`
- Test: `backend-ts/src/program/program-trend.test.ts`

- [ ] **Step 1: Add the failing wiring test**

First extend the imports in `backend-ts/src/program/program-trend.test.ts`:

```ts
import { snapshotScopeFor, monthlyTrendPoints, programTrend } from "./program-read-models.ts";
import type { ProgramDeps } from "./program-read-models.ts";
import type { QualitySnapshotRow } from "../stores/quality-snapshot-store.ts";
import type { OutcomeWithRun } from "../stores/outcome-store.ts";
```

Then append to the same file:

```ts
// Minimal fakes: programTrend only touches outcomeStore.listOutcomesWithRun (per-run path) and
// qualitySnapshots.querySnapshots (monthly path). runStore/caseStore are unused by programTrend.
function fakeDeps(opts: { snaps?: QualitySnapshotRow[]; perRun?: OutcomeWithRun[]; withSnapshots?: boolean }): ProgramDeps {
  const deps = {
    runStore: {} as ProgramDeps["runStore"],
    caseStore: {} as ProgramDeps["caseStore"],
    outcomeStore: { listOutcomesWithRun: async () => opts.perRun ?? [] } as unknown as ProgramDeps["outcomeStore"],
  } as ProgramDeps;
  if (opts.withSnapshots !== false) {
    deps.qualitySnapshots = { querySnapshots: async () => opts.snaps ?? [], upsertSnapshots: async () => {} };
  }
  return deps;
}

const perRunRow = (runId: string, startedAt: string, status: string): OutcomeWithRun => ({
  runId, runStartedAt: startedAt, runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual",
  subjectId: "emp-006", measureId: "audiogram", status,
});

test("programTrend — ≥2 monthly snapshots → monthly points (period stamped)", async () => {
  const deps = fakeDeps({ snaps: [snap("2026-05", 9, 10), snap("2026-06", 8, 10)] });
  const pts = await programTrend(deps, "audiogram", {});
  assert.equal(pts.length, 2);
  assert.equal(pts[0]!.period, "2026-05");
  assert.equal(pts[1]!.complianceRate, 80);
});

test("programTrend — <2 monthly snapshots → per-run fallback (no period)", async () => {
  const deps = fakeDeps({
    snaps: [snap("2026-06", 8, 10)], // only 1 month
    perRun: [perRunRow("run-a", "2026-06-01T00:00:00Z", "COMPLIANT"), perRunRow("run-b", "2026-06-02T00:00:00Z", "OVERDUE")],
  });
  const pts = await programTrend(deps, "audiogram", {});
  assert.ok(pts.every((p) => p.period === undefined), "fallback points carry no period");
  assert.deepEqual(new Set(pts.map((p) => p.runId)), new Set(["run-a", "run-b"]));
});

test("programTrend — no qualitySnapshots dep → per-run (back-compat)", async () => {
  const deps = fakeDeps({ withSnapshots: false, perRun: [perRunRow("run-a", "2026-06-01T00:00:00Z", "COMPLIANT")] });
  const pts = await programTrend(deps, "audiogram", {});
  assert.ok(pts.every((p) => p.period === undefined));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/program/program-trend.test.ts`
Expected: FAIL — the monthly tests return per-run shape (no `period`) because `programTrend` doesn't yet consult snapshots. (`ProgramDeps` also lacks `qualitySnapshots`, so `deps.qualitySnapshots = …` is a typecheck error — that's expected pre-Step-3.)

- [ ] **Step 3: Add `qualitySnapshots` to `ProgramDeps` and the monthly branch to `programTrend`**

In `backend-ts/src/program/program-read-models.ts`, add the optional store to `ProgramDeps` (after `caseStore`):

```ts
export interface ProgramDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
  employees?: readonly EmployeeProfile[];
  /** Optional — the monthly (quality_snapshots) trend source (UX-8). Absent ⇒ per-run trend only. */
  qualitySnapshots?: QualitySnapshotStore;
}
```

Then insert the monthly branch at the very start of `programTrend`'s body (before `const groups = await runsWithOutcomes(...)`):

```ts
export async function programTrend(
  deps: ProgramDeps,
  measureId: string,
  filters: ProgramFilters,
): Promise<ProgramTrendPoint[]> {
  // UX-8: prefer the monthly quality_snapshots series (the E16 source of truth) when the scope
  // resolves and has ≥2 months; otherwise fall back to the per-run trend below (unchanged).
  const scope = deps.qualitySnapshots ? snapshotScopeFor(filters) : null;
  if (deps.qualitySnapshots && scope) {
    const monthFrom = filters.from?.trim() ? filters.from.trim().slice(0, 7) : undefined;
    const monthTo = filters.to?.trim() ? filters.to.trim().slice(0, 7) : undefined;
    const snaps = await deps.qualitySnapshots.querySnapshots({
      measureId,
      scopeLevel: scope.scopeLevel,
      scopeId: scope.scopeId,
      from: monthFrom,
      to: monthTo,
    });
    const monthly = monthlyTrendPoints(snaps);
    if (monthly.length >= 2) return monthly;
  }

  // NOTE: Java unions a `run_based` branch for aggregate-only seeded runs; the TS floor `runs`
  const groups = await runsWithOutcomes(deps, measureId, filters);
  // ... existing per-run body unchanged ...
```

(Keep the rest of the existing `programTrend` body exactly as-is — the `groups.map(...).sort(...).slice(0, 10)` per-run computation.)

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/program/program-trend.test.ts`
Expected: all tests PASS (5 scope + 2 monthlyTrendPoints + 3 programTrend = 10).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/program/program-read-models.ts backend-ts/src/program/program-trend.test.ts
git commit -m "feat(ux8): programTrend prefers monthly snapshots, falls back to per-run"
```

---

## Task 4: wire `qualitySnapshots` into the programs route (backend)

**Files:**
- Modify: `backend-ts/src/routes/programs.ts:30-37`

- [ ] **Step 1: Add the store to the route's `deps` factory**

In `backend-ts/src/routes/programs.ts`, change the `deps` function (lines 30-37) to pass the snapshot store:

```ts
async function deps(env: ProgramsEnv): Promise<ProgramDeps> {
  const s = await getStores(env);
  return {
    runStore: s.runs,
    outcomeStore: s.outcomes,
    caseStore: s.cases,
    qualitySnapshots: s.qualitySnapshots,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend-ts && corepack pnpm@10 typecheck`
Expected: no errors.

- [ ] **Step 3: Run the full backend suite**

Run: `cd backend-ts && corepack pnpm@10 test`
Expected: all pass (previous count + the 10 new program-trend tests), 1 pg-skip, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add backend-ts/src/routes/programs.ts
git commit -m "feat(ux8): programs /trend route passes the quality-snapshot store"
```

---

## Task 5: frontend `trendMeta` pure helper (labels + granularity)

**Files:**
- Create: `frontend/app/(dashboard)/programs/trend-meta.ts`
- Test: `frontend/app/(dashboard)/programs/trend-meta.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/(dashboard)/programs/trend-meta.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { trendMeta, type TrendPoint } from "./trend-meta";

const p = (over: Partial<TrendPoint>): TrendPoint => ({ runId: "r", startedAt: "2026-06-15T00:00:00Z", complianceRate: 80, totalEvaluated: 10, ...over });

describe("trendMeta", () => {
  it("monthly (period present) → month/year labels, 'from last month', 'Month' header", () => {
    const m = trendMeta([
      p({ period: "2026-05", complianceRate: 90, startedAt: "2026-05-28T00:00:00Z" }),
      p({ period: "2026-06", complianceRate: 80, startedAt: "2026-06-28T00:00:00Z" }),
    ]);
    expect(m.monthly).toBe(true);
    expect(m.deltaLabel).toBe("from last month");
    expect(m.dateHeader).toBe("Month");
    expect(m.chartData[0]!.label).toMatch(/May/);
    expect(m.chartData[1]!.rate).toBe(80);
    expect(m.delta).toBeCloseTo(-10, 1); // 80 - 90
  });

  it("per-run (no period) → day labels, 'from last run', 'Run date' header", () => {
    const m = trendMeta([
      p({ complianceRate: 70, startedAt: "2026-06-01T00:00:00Z" }),
      p({ complianceRate: 78, startedAt: "2026-06-08T00:00:00Z" }),
    ]);
    expect(m.monthly).toBe(false);
    expect(m.deltaLabel).toBe("from last run");
    expect(m.dateHeader).toBe("Run date");
    expect(m.delta).toBeCloseTo(8, 1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run app/\(dashboard\)/programs/trend-meta.test.ts`
Expected: FAIL — `./trend-meta` module not found.

- [ ] **Step 3: Implement `trend-meta.ts`**

Create `frontend/app/(dashboard)/programs/trend-meta.ts`:

```ts
/**
 * UX-8 — derive the /programs card TrendChart's display model from its points. Monthly points
 * (quality_snapshots) carry a `period` (`YYYY-MM`); per-run points don't. Pure + testable so the
 * chart renderer stays a thin view.
 */
export type TrendPoint = {
  runId: string;
  startedAt: string;
  /** `YYYY-MM` for monthly (snapshot) points; absent for per-run points. */
  period?: string;
  complianceRate: number;
  totalEvaluated: number;
};

export interface TrendMeta {
  monthly: boolean;
  chartData: Array<{ label: string; rate: number }>;
  delta: number;
  deltaLabel: string;
  dateHeader: string;
}

/** `data` must already be filtered to points with totalEvaluated > 0 and sorted chronologically. */
export function trendMeta(data: TrendPoint[]): TrendMeta {
  const monthly = data.length > 0 && !!data[0]!.period;
  const chartData = data.map((t) => ({
    label: monthly && t.period
      ? new Date(`${t.period}-01T00:00:00Z`).toLocaleDateString("en", { month: "short", year: "2-digit" })
      : new Date(t.startedAt).toLocaleDateString("en", { month: "short", day: "numeric" }),
    rate: Math.round(t.complianceRate * 10) / 10,
  }));
  const last = chartData.length ? chartData[chartData.length - 1]!.rate : 0;
  const prev = chartData.length > 1 ? chartData[chartData.length - 2]!.rate : last;
  return {
    monthly,
    chartData,
    delta: last - prev,
    deltaLabel: monthly ? "from last month" : "from last run",
    dateHeader: monthly ? "Month" : "Run date",
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run app/\(dashboard\)/programs/trend-meta.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/(dashboard)/programs/trend-meta.ts" "frontend/app/(dashboard)/programs/trend-meta.test.ts"
git commit -m "feat(ux8): trendMeta helper — month-vs-run labels for the program trend"
```

---

## Task 6: wire `trendMeta` into `TrendChart` (frontend)

**Files:**
- Modify: `frontend/app/(dashboard)/programs/page.tsx`

- [ ] **Step 1: Replace the local `TrendPoint` type with the shared one**

In `frontend/app/(dashboard)/programs/page.tsx`, delete the local `TrendPoint` type declaration (lines 42-47) and import it from the new module. Add to the imports near the top (alongside the `ChartDataTable` import at line 22):

```ts
import { trendMeta, type TrendPoint } from "./trend-meta";
```

- [ ] **Step 2: Rewrite `TrendChart`'s body to use `trendMeta`**

In `TrendChart` (starts line 397), replace the block that computes `chartData`, `delta`, `deltaPositive` and the delta `<span>` and the `ChartDataTable` columns. The `sorted` computation, the loading branch, and the `sorted.length < 2` branch stay unchanged. After the `sorted.length < 2` guard, replace lines 415-424 (the `chartData`/`last`/`prev`/`delta`/`deltaPositive` consts) with:

```ts
  const { chartData, delta, deltaLabel, dateHeader } = trendMeta(sorted);
  const [domainLo, domainHi] = niceDomain(chartData.map((d) => d.rate));
  const deltaPositive = delta >= 0;
```

Change the delta `<span>` (line 430) to use the label:

```tsx
          {deltaPositive ? "↑" : "↓"} {Math.abs(Math.round(delta * 10) / 10)}% {deltaLabel}
```

Change the `ChartDataTable` `columns` (line 468) to use the granularity-aware header:

```tsx
        columns={[dateHeader, "Compliance"]}
```

- [ ] **Step 3: Make the card caption granularity-aware**

The `TrendChart` `caption` prop is passed at line 285 as ```${program.measureName} compliance trend by run```. Change that call site to drop the fixed "by run":

```tsx
                <TrendChart data={trend} loading={detailsLoading} caption={`${program.measureName} compliance trend`} />
```

Then inside `TrendChart`, where the `ChartDataTable` `caption={caption}` is rendered (line 467), make it granularity-aware:

```tsx
        caption={`${caption} by ${trendMeta(sorted).monthly ? "month" : "run"}`}
```

(Reuse the already-computed value instead of recomputing: capture `const meta = trendMeta(sorted);` once at the top of the render block and read `meta.chartData`, `meta.delta`, `meta.deltaLabel`, `meta.dateHeader`, `meta.monthly` from it — do not call `trendMeta` twice.)

- [ ] **Step 4: Typecheck + lint + unit tests**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run`
Expected: tsc clean, lint clean, all vitest pass (incl. the 2 new `trend-meta` tests).

- [ ] **Step 5: Build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add "frontend/app/(dashboard)/programs/page.tsx"
git commit -m "feat(ux8): program-card TrendChart renders monthly labels + 'from last month'"
```

---

## Task 7: docs + final verification

**Files:**
- Modify: `docs/JOURNAL.md` (new dated entry, newest on top)
- Modify: `docs/MEASURES.md` or `docs/ARCHITECTURE.md` §4 — one line noting the `/programs` card trend now reads `quality_snapshots` monthly with a per-run fallback (put it in ARCHITECTURE §4 `/programs` route bullet).

- [ ] **Step 1: Add a JOURNAL entry**

Prepend under `# Journal` in `docs/JOURNAL.md`:

```markdown
## 2026-07-04 — UX-8: program-card trends onto quality_snapshots (monthly)

The `/programs` per-card trend drew from per-run history, which flat-lines under the daily scheduled
runs ("↑ 0% from last run" read like a bug). Rewired it to the monthly `quality_snapshots` series (the
E16 source of truth), scoped by the page's tenant/site filters, with a per-run fallback when a scope has
<2 monthly snapshots. Additive only: `snapshotScopeFor` + `monthlyTrendPoints` (pure, exported),
`period?` on `ProgramTrendPoint`, an optional `qualitySnapshots` on `ProgramDeps`, and a frontend
`trendMeta` helper that swaps the labels to months + "from last month". No schema, no new endpoint, no
new deps; descriptive-only (ADR-008). Backend + frontend tests green.
```

- [ ] **Step 2: Add the ARCHITECTURE §4 note**

In `docs/ARCHITECTURE.md`, on the `/programs` route bullet (§4 Frontend Route Surfaces), append: "The per-card trend reads the monthly `quality_snapshots` series (scoped by the tenant/site filters), falling back to the per-run trend when a scope has <2 months (UX-8)."

- [ ] **Step 3: Full verification (both sides)**

Run: `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test`
Expected: typecheck clean; all tests pass / 1 pg-skip / 0 fail.

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/JOURNAL.md docs/ARCHITECTURE.md
git commit -m "docs(ux8): journal + architecture note for monthly program-card trends"
```

---

## Self-review notes (for the implementer)

- **Do NOT call `trendMeta` twice** in `TrendChart` — capture it once (`const meta = trendMeta(sorted)`), or the caption/labels drift is impossible but the double call is wasteful.
- **Scope-id format is load-bearing:** `snapshotScopeFor` must emit exactly `${tenantId}|${site}` and `"ALL"` to match `buildSnapshotRows` / `querySnapshots`. If a site test fails, verify the site→tenant mapping against `EMPLOYEES` in `employee-catalog.ts` (Plant A/Plant B/HQ/Clinic = twh; North Campus/South Campus/Outpatient Clinic = ihn).
- **Fallback is the safety net:** every scope the snapshot table can't answer (unknown/ambiguous site, <2 months, missing store) returns the existing per-run trend — no card ever renders empty where it previously had data.
- The measure-page "Quality over time" card (E16 PR-3) is a separate surface — do not touch it.
