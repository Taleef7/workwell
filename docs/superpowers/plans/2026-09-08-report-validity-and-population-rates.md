# Report Validity + Population and Rates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Local-only planning note.** This file is never staged or committed (owner rule: planning notes stay
> out of the public repo; stage explicit paths only, never `git add -A`). Commits and the PR are
> owner-gated: every "Commit" step below means *stage the named paths and stop for the owner's go*.

**Goal:** Every number the pilot's quality lead can see on the run detail, the programs dashboard and the
regulatory exports is either true or refused: no report from an unfinished, failed or compacted run, no
site recheck replacing the practice roster, no workflow-status percentage labelled as the CMS rate, and
no evaluation error silently counted as a denominator failure.

**Architecture:** Five behavioural contracts, each with a store/route/read-model seam and a failing test
first. (1) One reportability predicate shared by MeasureReport, QRDA I/III and the UI. (2) A compaction
keep set that protects the newest *usable* finalized row and never touches an in-flight run; the
compaction pass's intent audit event is the non-circular completeness evidence, so a population export
refuses when a pass postdates the run. (3) Population winners are an allowlist of whole-roster scopes.
(4) The existing `createRateAggregator` (which already applies the CQM IG folds) feeds an evidence-based
measure rate on the programs overview, shown as a separate metric from the status-bucket history, and
counts evaluation errors explicitly. (5) The roster distinguishes "evaluated, not in population" and
"evaluation failed" from "missing data", and a run-level reconciliation endpoint names its units.

**Tech Stack:** TypeScript on `@mieweb/cloud`, node:test (`node --import tsx --test`), SQLite floor +
Postgres ceiling behind the store contract, Next.js 16 + vitest for the frontend. No new dependencies.

**Pinned baseline:** `564d5d93`. Branch: `feat/report-validity-and-population-rates` from `origin/main`.

**Reference reproduction (do not commit, do not modify):**
`docs/transcripts/workwell-review-reproductions-2026-09-07.mjs`, run from `backend-ts` with
`node --import tsx ../docs/transcripts/workwell-review-reproductions-2026-09-07.mjs --expect-fixed`.
Its finding-13 scenario calls `compactOlderThan` directly, bypassing the policy layer that writes the
intent event this plan relies on, so that one check is NOT expected to pass; Tasks 3 and 4 carry the
equivalent through `compactOutcomes`. The other three checks must pass at the end.

---

## File structure

| File | Responsibility |
|---|---|
| `backend-ts/src/run/reportable.ts` (new) | `REPORTABLE_RUN_STATUSES` + `isReportableRunStatus` — the one predicate every exporter and the run summary use |
| `backend-ts/src/run/compaction-evidence.ts` (new) | `compactionExposure(run, events)` — reads the newest `OUTCOMES_COMPACTION_STARTED` intent event; non-circular |
| `backend-ts/src/fhir/run-aggregate.ts` (new) | `aggregateOfficialRun` (paged evidence sum) + `runProducedOfficialEvidence`, moved out of the route so the programs read model can share them |
| `backend-ts/src/program/measure-rate.ts` (new) | `officialMeasureRate` — the evidence-based rate for a terminal run, memoized per immutable run |
| `backend-ts/src/routes/runs.ts` | Guards (409 `run_not_reportable`, 409 `run_compacted`) on MeasureReport/QRDA; error header; `/reconciliation` route |
| `backend-ts/src/stores/{postgres,sqlite}/outcome-store-*.ts` | Keep set (usable + newest), in-flight exclusion, population allowlist in SQL |
| `backend-ts/src/stores/store-contract.ts` | Contract tests for both stores |
| `backend-ts/src/program/rollup-shared.ts` | `POPULATION_SCOPES` allowlist; honest `complianceRateOf` comment |
| `backend-ts/src/fhir/measure-report.ts` | `evaluationErrors` on the aggregate; error rows are in no population; `isEvaluationErrorEvidence` exported |
| `backend-ts/src/program/program-read-models.ts` | `ProgramSummary.measureRate` |
| `backend-ts/src/compliance/roster-vocabulary.ts` | `OUT_OF_POPULATION` display state; evaluation-failed method |
| `backend-ts/src/cds/cards.ts` | `OUT_OF_POPULATION` renders no card (like EXCLUDED) |
| `frontend/lib/run-status.ts`, `frontend/app/(dashboard)/runs/page.tsx` | Reportable gate on the export buttons; reconciliation block |
| `frontend/app/(dashboard)/programs/page.tsx`, `frontend/lib/status.ts` | Measure-rate tile, workflow-status relabel, new display state label/class |
| `docs/DECISIONS.md`, `docs/ADR_INDEX.md`, `docs/DATA_MODEL_CONTRACTS.md`, `docs/guide/05-fhir.md`, `docs/JOURNAL.md` | ADR-077 + amendments, the retention contract, the export contract, the day's entry |

---

### Task 0: Branch

- [ ] **Step 1: Branch from main**

```bash
cd "C:/Users/talee/OneDrive - Higher Education Commission/projects/WorkWell Studio"
git fetch origin main
git switch -c feat/report-validity-and-population-rates origin/main
git log --oneline -1
```
Expected: a new branch at the tip of `origin/main`. If `origin/main` is behind `564d5d93` (PR #539 unmerged), that is fine; nothing here depends on #539.

- [ ] **Step 2: Baseline the suites (so a later failure is attributable)**

```bash
cd backend-ts && pnpm typecheck && pnpm test 2>&1 | tail -5
cd ../frontend && npx vitest run 2>&1 | tail -5
```
Expected: both green. Never pipe `pnpm test` through `head`.

---

### Task 1: One reportability predicate, and MeasureReport enforces it on every variant

**Files:**
- Create: `backend-ts/src/run/reportable.ts`
- Modify: `backend-ts/src/routes/runs.ts:355-368` (replace the local set), `:1182-1186` (add guard)
- Test: `backend-ts/src/routes/runs.test.ts`

- [ ] **Step 1: Write the failing test** (append to `runs.test.ts`)

```ts
test("GET /api/runs/:id/measure-report refuses every non-reportable status on all three variants (review finding 12)", async () => {
  await get("/api/runs"); // initialize the floor schema when this test is selected in isolation
  const runStore = new SqliteRunStore(env.DB as never);
  const outcomeStore = new SqliteOutcomeStore(env.DB as never);
  for (const status of ["REQUESTED", "QUEUED", "RUNNING", "FAILED", "CANCELLED", "COMPLETED", "PARTIAL_FAILURE"]) {
    const run = await runStore.createRun({
      status, scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
      measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
    });
    await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", evaluationPeriod: "2026", status: "COMPLIANT", evidence: {} });
    const reportable = status === "COMPLETED" || status === "PARTIAL_FAILURE";
    for (const type of ["summary", "individual", "bundle"]) {
      const res = (await get(`/api/runs/${run.id}/measure-report?type=${type}`))!;
      assert.equal(res.status, reportable ? 200 : 409, `${status} ${type}`);
      if (!reportable) assert.equal(((await res.json()) as { error: string }).error, "run_not_reportable");
      else assert.equal(res.headers.get("content-type"), "application/fhir+json");
    }
  }
});
```

- [ ] **Step 2: Run it, expect failure**

```bash
cd backend-ts && node --import tsx --test src/routes/runs.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: the new test fails with `200 !== 409` on `REQUESTED summary`.

- [ ] **Step 3: Create the predicate module**

`backend-ts/src/run/reportable.ts`:
```ts
/**
 * Which runs may be exported as a quality report — MeasureReport, QRDA I, QRDA III.
 *
 * A run in a REPORTABLE status has FINISHED and its outcomes are final. `PARTIAL_FAILURE` is
 * reportable (ADR-074 d12): those runs finished, and their failed subjects persist `MISSING_DATA` with
 * an `evaluationError`, which is a real outcome rather than an absent one; the exporters count those
 * errors separately (`x-workwell-evaluation-errors`). `FAILED` and `CANCELLED` are TERMINAL but not
 * reportable: the run stopped, and what it persisted is a partial roster that would read as complete.
 *
 * `frontend/lib/run-status.ts` mirrors this set for the export buttons; the backend is the authority
 * and answers 409 `run_not_reportable` regardless of what a client shows.
 */
export const REPORTABLE_RUN_STATUSES: ReadonlySet<string> = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

export function isReportableRunStatus(status: string | null | undefined): boolean {
  return REPORTABLE_RUN_STATUSES.has((status ?? "").toUpperCase());
}
```

- [ ] **Step 4: Use it in the route**

In `runs.ts`, add the import next to the other `../run/` imports:
```ts
import { isReportableRunStatus } from "../run/reportable.ts";
```
Replace lines 355-358 (`const REPORTABLE_RUN_STATUSES = ...` and the head of `notReportable`) so the helper reads:
```ts
const notReportable = (status: string): Response | null =>
  isReportableRunStatus(status)
    ? null
    : json(
        {
          error: "run_not_reportable",
          message:
            `A quality report may only be exported from a finished run; this one is ${status}. ` +
            `Exporting a run that is still writing outcomes would present a partial roster as complete.`,
          status,
        },
        409,
      );
```
Delete the now-unused `REPORTABLE_RUN_STATUSES` constant. Keep the docstring above it (edit its first line to say the set lives in `src/run/reportable.ts`).

In the MeasureReport route (after `if (!run) return json({ error: "not_found", id: mrId }, 404);`) add:
```ts
    // Same refusal QRDA I/III already apply, BEFORE any outcome row is read: a RUNNING run's partial
    // roster and a FAILED run's fragment were both exported as `status: "complete"` until 2026-09-08
    // (review finding 12), and the UI's export buttons showed for every TERMINAL run, FAILED included.
    const unfinishedMr = notReportable(run.status);
    if (unfinishedMr) return unfinishedMr;
```

- [ ] **Step 5: Run the test file and typecheck**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/routes/runs.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: all pass.

---

### Task 2: The UI's export buttons use the same predicate

**Files:**
- Modify: `frontend/lib/run-status.ts`, `frontend/app/(dashboard)/runs/page.tsx:974-976`
- Test: `frontend/app/(dashboard)/runs/__tests__/page.export-gate.test.tsx` (new)

- [ ] **Step 1: Write the failing test**

```tsx
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get, post: vi.fn(), downloadBlob: vi.fn() };
const routerMock = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const searchParamsMock = vi.hoisted(() => new URLSearchParams());
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock, useSearchParams: () => searchParamsMock }));
vi.mock("@/components/global-filter-context", () => ({ useGlobalFilters: () => ({ siteId: "", from: "", to: "" }) }));
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking: vi.fn() }) }));
vi.mock("@/features/datavis/NitroGridClient", () => ({ default: () => <div data-testid="outcomes-grid" /> }));

import RunsPage from "../page";

function fixtures(status: string) {
  const run = {
    runId: "run-1", measureName: "Breast Cancer Screening", status, scopeType: "MEASURE", triggerType: "MANUAL",
    startedAt: "2026-08-30T00:00:00Z", completedAt: "2026-08-30T00:01:00Z", durationMs: 60_000,
    totalEvaluated: 1, compliantCount: 0, nonCompliantCount: 1,
  };
  const summary = {
    ...run, measureVersion: "1.0", totalCases: 1, passRate: 0, outcomeCounts: [{ status: "OVERDUE", count: 1 }],
    dataFreshAsOf: "2026-08-30T00:01:00Z", dataFreshnessMinutes: 1, retentionNotice: null,
  };
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/runs?limit=20") return Promise.resolve([run]);
    if (url === "/api/runs/run-1") return Promise.resolve(summary);
    return Promise.resolve([]);
  });
}

describe("RunsPage export gate", () => {
  beforeEach(() => fixtures("COMPLETED"));

  it("offers the standards exports for a COMPLETED run", async () => {
    render(<RunsPage />);
    expect(await screen.findByRole("button", { name: "MeasureReport (FHIR)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "QRDA III (XML)" })).toBeInTheDocument();
  });

  it.each(["FAILED", "CANCELLED", "RUNNING"])("hides them for a %s run, which the backend refuses with 409", async (status) => {
    fixtures(status);
    render(<RunsPage />);
    await screen.findByText(/Evaluated:/);
    expect(screen.queryByRole("button", { name: "MeasureReport (FHIR)" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "QRDA III (XML)" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it, expect the FAILED/CANCELLED cases to fail**

```bash
cd frontend && npx vitest run "app/(dashboard)/runs/__tests__/page.export-gate.test.tsx" 2>&1 | tail -15
```
Expected: COMPLETED passes; FAILED and CANCELLED fail (buttons present); RUNNING passes already.

- [ ] **Step 3: Add the predicate to `frontend/lib/run-status.ts`** (append)

```ts
/** Runs whose outcomes are FINAL and may be exported as a quality report. Mirrors the backend's
 *  `src/run/reportable.ts`, which is the authority (it answers 409 `run_not_reportable`). FAILED and
 *  CANCELLED are terminal but NOT reportable: what they persisted is a fragment. */
export const REPORTABLE_RUN_STATUSES = new Set(["COMPLETED", "PARTIAL_FAILURE"]);

export function isReportableRunStatus(status: string | null | undefined): boolean {
  return REPORTABLE_RUN_STATUSES.has((status ?? "").toUpperCase());
}
```

- [ ] **Step 4: Gate the buttons in `runs/page.tsx`**

Find the import from `@/lib/run-status` and add `isReportableRunStatus`. Replace the condition at lines 974-976:
```tsx
              {/* Standards exports — single-measure runs only (the endpoints 422 on ALL_PROGRAMS), and only
                  REPORTABLE runs: FAILED/CANCELLED are terminal but the backend refuses them with 409. */}
              {normalizeEnumValue(selectedRun.scopeType) === "MEASURE" && isReportableRunStatus(selectedRun.status) ? (
```

- [ ] **Step 5: Run the test, lint**

```bash
cd frontend && npx vitest run "app/(dashboard)/runs/__tests__/page.export-gate.test.tsx" 2>&1 | tail -8 && npm run lint 2>&1 | tail -3
```
Expected: 4 passed, lint clean.

---

### Task 3: The keep set protects the newest USABLE row and never touches an in-flight run

**Files:**
- Modify: `backend-ts/src/stores/sqlite/outcome-store-sqlite.ts:177-208`, `backend-ts/src/stores/postgres/outcome-store-postgres.ts:207-225`, `backend-ts/src/stores/outcome-store.ts:132-140` (docstring)
- Test: `backend-ts/src/stores/store-contract.ts` (after the tie test at ~:395)

- [ ] **Step 1: Write the failing contract test**

```ts
  test(`[${label}] compactOlderThan keeps the newest USABLE row: a FAILED run or an evaluation error never evicts a finalized answer, and an in-flight run is never a candidate (ADR-077)`, async () => {
    const { runStore, outcomeStore } = await fresh();
    const mk = (status: string) => runStore.createRun({ ...sampleRun("audiogram"), status });
    const completed = await mk("COMPLETED");
    const failed = await mk("FAILED");
    const errored = await mk("PARTIAL_FAILURE");
    const running = await mk("RUNNING");
    const row = (runId: string, subjectId: string, status: string, evaluatedAt: string, evidence: Record<string, unknown> = {}) =>
      ({ runId, subjectId, measureId: "audiogram", evaluationPeriod: "2027-01-01", status, evidence, evaluatedAt });
    await outcomeStore.recordOutcomes([
      // emp-001: a usable January answer, a FAILED February row, an evaluation-error March row (the newest).
      row(completed.id, "emp-001", "COMPLIANT", "2027-01-01T00:00:00.000Z"),
      row(failed.id, "emp-001", "OVERDUE", "2027-02-01T00:00:00.000Z"),
      row(errored.id, "emp-001", "MISSING_DATA", "2027-03-01T00:00:00.000Z", { evaluationError: "engine threw", message: "boom" }),
      // emp-002: ONLY unusable rows — the newest still survives so no roster cell goes blank.
      row(failed.id, "emp-002", "OVERDUE", "2027-01-01T00:00:00.000Z"),
      row(failed.id, "emp-002", "OVERDUE", "2027-02-01T00:00:00.000Z"),
      // emp-003: an in-flight run's row, however old, is never deleted; the finalized June row is the answer.
      row(running.id, "emp-003", "OVERDUE", "2026-01-01T00:00:00.000Z"),
      row(completed.id, "emp-003", "COMPLIANT", "2027-06-01T00:00:00.000Z"),
    ]);

    const deleted = await outcomeStore.compactOlderThan("2027-09-01T00:00:00.000Z");
    assert.equal(deleted, 2, "emp-001's FAILED row and emp-002's older FAILED row — nothing else");

    const rows = async (runId: string) => (await outcomeStore.listOutcomes(runId)).map((o) => `${o.subjectId}@${o.evaluatedAt}`).sort();
    assert.deepEqual(await rows(completed.id), ["emp-001@2027-01-01T00:00:00.000Z", "emp-003@2027-06-01T00:00:00.000Z"], "the last USABLE answer survives even though newer unusable rows exist");
    assert.deepEqual(await rows(errored.id), ["emp-001@2027-03-01T00:00:00.000Z"], "the newest row (an error) is kept too, so its age stays visible beside the last good answer");
    assert.deepEqual(await rows(failed.id), ["emp-002@2027-02-01T00:00:00.000Z"], "a subject with no usable row keeps their newest");
    assert.deepEqual(await rows(running.id), ["emp-003@2026-01-01T00:00:00.000Z"], "an in-flight run is never compacted");
  });
```

- [ ] **Step 2: Run the contract on the floor, expect failure**

```bash
cd backend-ts && node --import tsx --test src/stores/sqlite/*.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: the new test fails (`deleted` is 3 or more: the completed January row is evicted today).

- [ ] **Step 3: SQLite keep set**

Replace the body of `compactOlderThan` in `outcome-store-sqlite.ts` with:
```ts
  async compactOlderThan(cutoff: string): Promise<number> {
    const { results } = await this.db
      .prepare(
        `DELETE FROM outcomes
          WHERE evaluated_at < ?
            -- An in-flight run (QUEUED/RUNNING/REQUESTED) is still writing; its rows are never candidates.
            AND run_id IN (SELECT id FROM runs WHERE UPPER(status) IN ('COMPLETED','PARTIAL_FAILURE','FAILED','CANCELLED'))
            -- KEEP 1: the newest USABLE row per (subject, measure, period) — from a reportable run, and
            -- not an evaluation error. A FAILED rerun or an engine failure must not evict the last
            -- finalized clinical answer (review finding 13, ADR-077).
            AND id NOT IN (
              SELECT id FROM outcomes o2
               WHERE o2.id = (
                 SELECT o3.id FROM outcomes o3
                   JOIN runs r3 ON r3.id = o3.run_id
                  WHERE o3.subject_id = o2.subject_id
                    AND o3.measure_id = o2.measure_id
                    AND o3.evaluation_period = o2.evaluation_period
                    AND UPPER(r3.status) IN ('COMPLETED','PARTIAL_FAILURE')
                    AND json_extract(o3.evidence_json, '$.evaluationError') IS NULL
                  ORDER BY o3.evaluated_at DESC, o3.id DESC
                  LIMIT 1
               )
            )
            -- KEEP 2: the newest row per key regardless (ADR-073's original rule), tie-broken by id DESC
            -- like the ceiling's DISTINCT ON. A key with no usable row keeps its newest so no roster
            -- cell goes blank, and a newer failure stays visible beside the last good answer.
            AND id NOT IN (
              SELECT id FROM outcomes o2
               WHERE o2.id = (
                 SELECT o3.id FROM outcomes o3
                  WHERE o3.subject_id = o2.subject_id
                    AND o3.measure_id = o2.measure_id
                    AND o3.evaluation_period = o2.evaluation_period
                  ORDER BY o3.evaluated_at DESC, o3.id DESC
                  LIMIT 1
               )
            )
            -- KEEP 3: every row a case cites, matched per row rather than per run.
            AND NOT EXISTS (
              SELECT 1 FROM cases c
               WHERE c.last_run_id = outcomes.run_id
                 AND c.employee_id = outcomes.subject_id
                 AND c.measure_id = outcomes.measure_id
            )
          RETURNING id`,
      )
      .bind(cutoff)
      .all<{ id: string }>();
    return (results ?? []).length;
  }
```

- [ ] **Step 4: Postgres keep set**

In `outcome-store-postgres.ts`, next to the existing `CASES_TABLE` constant add `const RUNS_TABLE = \`${SPIKE_SCHEMA}.runs\`;` (same style), then replace `compactOlderThan`:
```ts
  async compactOlderThan(cutoff: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM ${T} o
        WHERE o.evaluated_at < $1
          AND o.run_id IN (SELECT id FROM ${RUNS_TABLE} WHERE UPPER(status) IN ('COMPLETED','PARTIAL_FAILURE','FAILED','CANCELLED'))
          AND o.id NOT IN (
            SELECT DISTINCT ON (o3.subject_id, o3.measure_id, o3.evaluation_period) o3.id
              FROM ${T} o3
              JOIN ${RUNS_TABLE} r3 ON r3.id = o3.run_id
             WHERE UPPER(r3.status) IN ('COMPLETED','PARTIAL_FAILURE')
               AND NOT (o3.evidence_json ? 'evaluationError')
             ORDER BY o3.subject_id, o3.measure_id, o3.evaluation_period, o3.evaluated_at DESC, o3.id DESC
          )
          AND o.id NOT IN (
            SELECT DISTINCT ON (subject_id, measure_id, evaluation_period) id
              FROM ${T}
             ORDER BY subject_id, measure_id, evaluation_period, evaluated_at DESC, id DESC
          )
          AND NOT EXISTS (
            SELECT 1 FROM ${CASES_TABLE} c
             WHERE c.last_run_id = o.run_id
               AND c.employee_id = o.subject_id
               AND c.measure_id = o.measure_id
          )`,
      [cutoff],
    );
    return rowCount ?? 0;
  }
```
Keep the long EXPLAIN-history comment above it, and append one paragraph: *"2026-09-08 (ADR-077): a second keep set joined to `runs` protects the newest USABLE row; the run-status join is a new cost on the pilot's table and has NOT been re-measured with EXPLAIN ANALYZE at scale — the memory rule is to measure before claiming, so this is recorded as unmeasured, not as index-friendly."*

- [ ] **Step 5: Update the interface docstring** in `outcome-store.ts:132-140`: replace the first bullet with
```
   *  - the newest USABLE row per `(subject_id, measure_id, evaluation_period)` — from a COMPLETED or
   *    PARTIAL_FAILURE run and not an evaluation error — AND the newest row regardless, whatever their
   *    age. Per PERIOD, not merely per measure: ... (keep the rest of the existing text)
   *  - every row of a run that is still QUEUED/RUNNING — an in-flight run is never compacted.
```

- [ ] **Step 6: Run both contracts**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/stores/sqlite/*.test.ts src/stores/postgres/*.test.ts src/run/outcome-compaction.test.ts 2>&1 | grep -E "not ok|# (pass|fail|skip)"
```
Expected: all pass; the Postgres contract self-skips without a local `postgres:16` (say so in the PR if it skipped).

---

### Task 4: Compaction evidence — a population export refuses when a pass postdates the run

**Files:**
- Create: `backend-ts/src/run/compaction-evidence.ts`, `backend-ts/src/run/compaction-evidence.test.ts`
- Modify: `backend-ts/src/routes/runs.ts` (qrda1, qrda, measure-report routes)
- Test: `backend-ts/src/routes/runs.test.ts`

- [ ] **Step 1: Unit test for the predicate**

`backend-ts/src/run/compaction-evidence.test.ts`:
```ts
/**
 * The compaction pass writes OUTCOMES_COMPACTION_STARTED BEFORE it deletes (outcome-compaction.ts) and
 * that write is awaited, so its absence means no pass ran and its `cutoff` bounds what a pass could
 * have reached. That is the only completeness evidence that is not derived from the surviving rows.
 *   node --import tsx --test src/run/compaction-evidence.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionExposure } from "./compaction-evidence.ts";

const events = (cutoffs: string[]) => ({
  recentAuditEventsByType: async (_type: string, limit: number) =>
    cutoffs.slice(0, limit).map((cutoff) => ({ occurredAt: cutoff, eventType: "OUTCOMES_COMPACTION_STARTED", actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: { cutoff, retentionDays: 400 } })),
});

test("no compaction pass ever ran → not exposed", async () => {
  assert.deepEqual(await compactionExposure({ startedAt: "2026-01-01T00:00:00.000Z" }, events([])), { exposed: false, cutoff: null });
});

test("a pass whose cutoff postdates the run's start → exposed, naming the cutoff", async () => {
  assert.deepEqual(
    await compactionExposure({ startedAt: "2026-01-01T00:00:00.000Z" }, events(["2026-06-01T00:00:00.000Z"])),
    { exposed: true, cutoff: "2026-06-01T00:00:00.000Z" },
  );
});

test("a pass whose cutoff predates the run's start could not have reached it → not exposed", async () => {
  assert.deepEqual(
    await compactionExposure({ startedAt: "2026-07-01T00:00:00.000Z" }, events(["2026-06-01T00:00:00.000Z"])),
    { exposed: false, cutoff: "2026-06-01T00:00:00.000Z" },
  );
});

test("a malformed intent payload is treated as exposure, never as proof of completeness", async () => {
  const bad = { recentAuditEventsByType: async () => [{ occurredAt: "x", eventType: "OUTCOMES_COMPACTION_STARTED", actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: {} }] };
  assert.deepEqual(await compactionExposure({ startedAt: "2026-07-01T00:00:00.000Z" }, bad), { exposed: true, cutoff: null });
});
```

- [ ] **Step 2: Run, expect module-not-found**

```bash
cd backend-ts && node --import tsx --test src/run/compaction-evidence.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Implement**

`backend-ts/src/run/compaction-evidence.ts`:
```ts
/**
 * Non-circular evidence about whether outcome compaction (ADR-073) could have removed rows from a run.
 *
 * WHY THE LEDGER AND NOT THE RUN: `RunSummary.totalEvaluated` is a count of the SURVIVING rows
 * (`read-models.ts`, `retentionNoticeFor`'s own comment), so comparing it with the surviving rows is
 * always equal and detects nothing — the review's reproduction shows a 1-of-2 report becoming 0-of-1
 * while the "total" becomes 1. `RUN_COMPLETED`'s payload count is best-effort and counts work items
 * including out-of-population subjects, so equality there proves nothing either.
 *
 * What IS reliable: `compactOutcomes` awaits an `OUTCOMES_COMPACTION_STARTED` audit event BEFORE it
 * deletes, and if that write fails nothing is deleted. Cutoffs only move forward (now − window), so the
 * NEWEST intent event carries the furthest cutoff any pass has applied. A run that started before that
 * cutoff had every row eligible; a run that started after it could not have been reached. This is
 * conservative — a run whose rows all happened to survive is still refused — and conservative is the
 * contract: a report is refused rather than rendered from rows that may be incomplete (ADR-077).
 *
 * It holds as long as `compactOutcomes` is the only deletion path, which it is: the scheduler and the
 * `outcomes-compact` CLI both call it. A direct `compactOlderThan` is a store primitive, not a policy.
 */
import type { CaseEventStore } from "../stores/case-event-store.ts";
import type { RunRecord } from "../stores/run-store.ts";

export const COMPACTION_INTENT_EVENT = "OUTCOMES_COMPACTION_STARTED";

export interface CompactionExposure {
  /** True when a compaction pass's cutoff postdates the run's start, or the ledger cannot be read. */
  exposed: boolean;
  /** The furthest cutoff any pass has applied, or null when none has run (or the payload was unreadable). */
  cutoff: string | null;
}

export async function compactionExposure(
  run: Pick<RunRecord, "startedAt">,
  events: Pick<CaseEventStore, "recentAuditEventsByType">,
): Promise<CompactionExposure> {
  const [latest] = await events.recentAuditEventsByType(COMPACTION_INTENT_EVENT, 1);
  if (!latest) return { exposed: false, cutoff: null };
  const cutoff = typeof latest.payload?.cutoff === "string" ? latest.payload.cutoff : null;
  const cutoffMs = cutoff === null ? Number.NaN : Date.parse(cutoff);
  const startedMs = Date.parse(run.startedAt);
  // An unreadable cutoff or start is exposure: absence of proof is never proof of completeness.
  if (!Number.isFinite(cutoffMs) || !Number.isFinite(startedMs)) return { exposed: true, cutoff };
  return { exposed: startedMs < cutoffMs, cutoff };
}
```

- [ ] **Step 4: Route test** (append to `runs.test.ts`; this test must stay LAST in the file — it writes a ledger event every later test would see)

```ts
test("population exports refuse a run a compaction pass could have reached (409 run_compacted), and serve one it could not", async () => {
  await get("/api/runs");
  const runStore = new SqliteRunStore(env.DB as never);
  const outcomeStore = new SqliteOutcomeStore(env.DB as never);
  const events = new SqliteCaseEventStore(env.DB as never);
  const mk = (startedAt: string) => runStore.createRun({
    status: "COMPLETED", scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2020-01-01T00:00:00.000Z", measurementPeriodEnd: "2020-12-31T23:59:59.999Z", startedAt, completedAt: startedAt,
  });
  const before = await mk("2020-06-01T00:00:00.000Z");
  const after = await mk("2021-06-01T00:00:00.000Z");
  for (const run of [before, after]) await outcomeStore.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", evaluationPeriod: "2020", status: "COMPLIANT", evidence: {}, evaluatedAt: run.startedAt });
  // The intent event the compaction pass writes before deleting. Its cutoff sits between the two runs.
  await events.appendAudit({ eventType: "OUTCOMES_COMPACTION_STARTED", entityType: "outcome", entityId: null, actor: "system", refRunId: null, refCaseId: null, refMeasureVersionId: null, payload: { cutoff: "2021-01-01T00:00:00.000Z", retentionDays: 1 } });

  for (const path of ["/measure-report?type=summary", "/measure-report?type=individual", "/measure-report?type=bundle", "/qrda1", "/qrda?format=xml"]) {
    const refused = (await get(`/api/runs/${before.id}${path}`))!;
    assert.equal(refused.status, 409, `before ${path}`);
    const body = (await refused.json()) as { error: string; compactionCutoff: string };
    assert.equal(body.error, "run_compacted");
    assert.equal(body.compactionCutoff, "2021-01-01T00:00:00.000Z");
    assert.equal((await get(`/api/runs/${after.id}${path}`))!.status, 200, `after ${path}`);
  }
});
```

- [ ] **Step 5: Route implementation** in `runs.ts`

Import: `import { compactionExposure } from "../run/compaction-evidence.ts";` and `import type { RunRecord } from "../stores/run-store.ts";` (if not already imported). Add a helper below `notReportable`:
```ts
/**
 * A population export from a run a compaction pass could have reached is REFUSED, not rendered from the
 * survivors: the survivors are a keep set (newest per subject, plus what cases cite), and a score
 * computed over them is a different number wearing the original run's identity (review finding 13).
 * The evidence is the ledger, never the surviving rows — see `compaction-evidence.ts` for why.
 */
const compacted = async (run: RunRecord, env: RunsEnv): Promise<Response | null> => {
  const exposure = await compactionExposure(run, (await getStores(env)).events);
  if (!exposure.exposed) return null;
  return json(
    {
      error: "run_compacted",
      message:
        `This run started ${run.startedAt}, before the outcome-retention cutoff ${exposure.cutoff ?? "(unreadable)"} ` +
        `that a compaction pass has since applied, so its per-subject rows may be incomplete. A report built from ` +
        `the surviving rows would carry a different score under this run's identity, so none is built. ` +
        `The run's own counts and the quality history are unaffected; the outcomes CSV still returns the surviving rows.`,
      startedAt: run.startedAt,
      compactionCutoff: exposure.cutoff,
    },
    409,
  );
};
```
Apply it in all three routes immediately after the `notReportable` check (i.e. before `distinctMeasuresForRun`):
```ts
    const gone = await compacted(run, env);
    if (gone) return gone;
```
(Use distinct local names per route: `goneI`, `goneIii`, `goneMr`.)

- [ ] **Step 6: Run**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/run/compaction-evidence.test.ts src/routes/runs.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: all pass.

---

### Task 5: Population winners are an allowlist of whole-roster scopes

**Files:**
- Modify: `backend-ts/src/program/rollup-shared.ts:3-6,18-31`, `backend-ts/src/quality/materialize-run.ts:27,57`, `backend-ts/src/stores/postgres/outcome-store-postgres.ts:387`, `backend-ts/src/stores/sqlite/outcome-store-sqlite.ts:338`
- Test: `backend-ts/src/stores/store-contract.ts:685-745`, `backend-ts/src/program/program-overview.population.test.ts` (new)

- [ ] **Step 1: Extend the store-contract test**

Inside the `listLatestPopulationOutcomes == JS reduction` test, after `const aCase = ...` add:
```ts
    // A SITE recheck is COMPLETED and NEWER, and it is one clinic: it must not become "the roster".
    const aSite = await mkRun("audiogram", "2026-06-15T00:00:00.000Z", { scopeType: "SITE", scopeId: "audiogram" });
```
add its row to `recordOutcomes`:
```ts
      { runId: aSite.id, subjectId: "emp-006", measureId: "audiogram", status: "COMPLIANT", evidence: {} },
```
and extend the final assertion's message list with a second assertion:
```ts
    assert.ok(!rosterLike.some((r) => r.runId === aSite.id), "a newer COMPLETED SITE run never replaces the whole-roster snapshot (review finding 11)");
```

- [ ] **Step 2: Programs overview test** — `backend-ts/src/program/program-overview.population.test.ts`

```ts
/**
 * The programs overview picks each measure's latest WHOLE-ROSTER run. A SITE recheck is a population
 * of one clinic; if it won, the dashboard would report that clinic's rate as the practice's (finding 11).
 *   node --import tsx --test src/program/program-overview.population.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { RunStore } from "../stores/run-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { programOverview } from "./program-read-models.ts";
import { isPopulationRun, POPULATION_SCOPES } from "./rollup-shared.ts";

const row = (runId: string, runStartedAt: string, runScopeType: string, subjectId: string, status: string): OutcomeWithRun =>
  ({ runId, runStartedAt, runScopeType, runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId, measureId: "audiogram", status });

const rows = [
  row("run-measure", "2026-06-01T00:00:00.000Z", "MEASURE", "emp-006", "OVERDUE"),
  row("run-measure", "2026-06-01T00:00:00.000Z", "MEASURE", "emp-007", "OVERDUE"),
  row("run-site", "2026-07-01T00:00:00.000Z", "SITE", "emp-006", "COMPLIANT"),
];

const deps = {
  outcomeStore: { listOutcomesWithRun: async () => rows, listOutcomes: async () => [], aggregateScaleRun: async () => [] } as unknown as OutcomeStore,
  runStore: { listRuns: async () => [] } as unknown as RunStore,
  caseStore: { listCases: async () => [] } as unknown as CaseStore,
};

test("the allowlist names the whole-roster scopes and nothing else", () => {
  assert.deepEqual([...POPULATION_SCOPES].sort(), ["ALL_PROGRAMS", "MEASURE"]);
  for (const scope of ["SITE", "CASE", "EMPLOYEE", "site"]) assert.equal(isPopulationRun(scope), false, scope);
  for (const scope of ["MEASURE", "ALL_PROGRAMS", "measure"]) assert.equal(isPopulationRun(scope), true, scope);
});

test("a newer COMPLETED SITE run does not replace the practice-wide overview", async () => {
  const audiogram = (await programOverview(deps, {})).find((p) => p.measureId === "audiogram")!;
  assert.equal(audiogram.latestRunId, "run-measure");
  assert.equal(audiogram.totalEvaluated, 2, "both subjects of the whole-roster run, not the one the site recheck saw");
  assert.equal(audiogram.overdue, 2);
});
```

- [ ] **Step 3: Run, expect failure**

```bash
cd backend-ts && node --import tsx --test src/program/program-overview.population.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: import of `POPULATION_SCOPES` fails, or `latestRunId === "run-site"`.

- [ ] **Step 4: Implement the allowlist**

`rollup-shared.ts`: replace lines 3-6 with
```ts
/**
 * The scopes whose runs describe the WHOLE roster and may therefore be a measure's population winner
 * (the roster, the programs overview, the hierarchy rollup, the quality snapshot). An ALLOWLIST, not
 * "everything but the rerun scopes": a SITE run is one clinic and a CASE/EMPLOYEE run is one person,
 * and until 2026-09-08 a newer COMPLETED SITE run replaced the practice-wide snapshot with its own
 * clinic (review finding 11, ADR-077). A future scope is out until it is deliberately admitted.
 * Compared case-insensitively: the Java backend persisted some scope values lowercase.
 */
export const POPULATION_SCOPES: ReadonlySet<string> = new Set(["MEASURE", "ALL_PROGRAMS"]);
export const isPopulationRun = (scopeType: string): boolean => POPULATION_SCOPES.has(scopeType.toUpperCase());
```
Grep for `RERUN_SCOPES` across `src/`; if nothing else imports it, delete it (it no longer expresses the rule).

Replace the `complianceRateOf` docstring (lines 18-22):
```ts
/**
 * The WORKFLOW-STATUS rate: compliant / (compliant + dueSoon + overdue + missingData), 1 decimal.
 * This is NOT the CMS proportion — it reduces the five operational buckets, not the measure's
 * population membership, and for an inverse measure (cms122) "compliant" is not its numerator. The
 * evidence-based rate is `officialMeasureRate` (`program/measure-rate.ts`) and the two are shown as
 * different metrics (ADR-077); a former comment here calling this "the way CMS scores it" was wrong.
 */
```

`materialize-run.ts`: delete `const SNAPSHOT_SCOPES = ...` (line 27), import `POPULATION_SCOPES` from `../program/rollup-shared.ts`, and use it at line 57: `if (!POPULATION_SCOPES.has(run.scopeType.toUpperCase())) return skip(...)`.

Both stores' `listLatestPopulationOutcomes`: replace `"UPPER(r2.scope_type) NOT IN ('CASE','EMPLOYEE')"` with `"UPPER(r2.scope_type) IN ('MEASURE','ALL_PROGRAMS')"` and update the adjacent comment to say it mirrors `POPULATION_SCOPES`.

- [ ] **Step 5: Run the affected suites**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/program/*.test.ts src/stores/sqlite/*.test.ts src/quality/*.test.ts src/compliance/roster-read-model.test.ts 2>&1 | grep -E "not ok|# (pass|fail|skip)"
```
Expected: all pass. If `backfill-trend-history` or `hierarchy-rollup` tests relied on SITE rows winning, read the failing assertion before changing anything: a SITE winner was the defect.

---

### Task 6: An evaluation error is counted, and is in no population

**Files:**
- Modify: `backend-ts/src/fhir/measure-report.ts` (`membershipFor` ~:257, `RateAggregate` :355, `createRateAggregator` :368), `backend-ts/src/routes/runs.ts` (`isEvaluationErrorEvidence` :276, `aggregateCountsForRun`, headers)
- Test: `backend-ts/src/fhir/measure-report.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `measure-report.test.ts`)

```ts
test("an evaluation-error row is in NO population and is counted as an error, on every measure (ADR-077)", async () => {
  const module = await import("./measure-report.ts");
  const error = { status: "MISSING_DATA", evidence: { evaluationError: "engine threw", message: "boom" } };
  // Authored measure: until 2026-09-08 this counted as ipp+denom (a denominator failure) — an engine
  // crash deflated the rate. A measure that flags MISSING_DATA as out-of-population happened to hide it.
  for (const measureId of ["audiogram", "cms122", "cms137"]) {
    assert.deepEqual(module.membershipFor(error, measureId), { ipp: false, denom: false, denex: false, numer: false, denexcep: false }, measureId);
  }
  const agg = module.createRateAggregator("cms122");
  agg.add({ status: "OVERDUE", evidence: { official: { populationResults: { ipp: true, denom: true, numer: true, denex: false, denexcep: false } } } });
  agg.add(error);
  const out = agg.finish();
  assert.deepEqual(out.rates, [{ ipp: 1, denom: 1, denex: 0, numer: 1, denexcep: 0 }]);
  assert.equal(out.evaluationErrors, 1, "the error is visible in the aggregate, not lost");
  assert.equal(out.unmeasured, 0, "unmeasured is ADR-074's 'in no rate' count, a different thing");
  assert.equal(module.isEvaluationErrorEvidence(error.evidence), true);
  assert.equal(module.isEvaluationErrorEvidence({ expressionResults: [] }), false);
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd backend-ts && node --import tsx --test src/fhir/measure-report.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```

- [ ] **Step 3: Implement in `measure-report.ts`**

Add near `missingDataMeansOutOfPopulation` (~:72):
```ts
/** The evidence the run pipeline persists for a subject whose evaluation threw — no engine spoke for it. */
export function isEvaluationErrorEvidence(evidence: unknown): boolean {
  return typeof evidence === "object" && evidence !== null && "evaluationError" in evidence;
}
const NO_POPULATION: PopulationMembership = { ipp: false, denom: false, denex: false, numer: false, denexcep: false };
```
In `membershipFor`, before `const official = officialMembership(...)`:
```ts
  // No engine spoke for this subject: they are in NO population. Counting them by the authored status
  // rule put an engine crash in the denominator as a failure (and, for an inverse measure, as the
  // opposite of its numerator) — the "mixed provenance" this docstring used to accept. The aggregate
  // reports them in `evaluationErrors` instead (ADR-077).
  if (isEvaluationErrorEvidence(outcome.evidence)) return { ...NO_POPULATION };
```
Rewrite the MIXED PROVENANCE paragraph of that docstring to say the trade-off is now: errored subjects are counted separately and never inside a population.

`RateAggregate`: add
```ts
  /** Rows whose evidence is an evaluation error: in no population, in no rate, reported so the gap is visible. */
  evaluationErrors: number;
```
`createRateAggregator`: add `let evaluationErrors = 0;` and in `add`, first line: `if (isEvaluationErrorEvidence(outcome.evidence)) { evaluationErrors += 1; return; }`; include `evaluationErrors` in the returned object of `finish()`.

- [ ] **Step 4: Route: export the count**

In `runs.ts`: delete the local `isEvaluationErrorEvidence` (line ~276) and import it from `../fhir/measure-report.ts` (extend the existing import). Add `const EVALUATION_ERRORS_HEADER = "x-workwell-evaluation-errors";` beside `UNMEASURED_HEADER`. `aggregateCountsForRun`'s return type gains `evaluationErrors: number` (0 on the histogram branch, with a comment that a status histogram cannot see evidence and that branch is authored seed data only); set `[EVALUATION_ERRORS_HEADER]: String(aggregate.evaluationErrors)` next to every `UNMEASURED_HEADER` use (QRDA III and MeasureReport summary).

- [ ] **Step 5: Run**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/fhir/*.test.ts src/routes/runs.test.ts src/routes/compliance-api.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: all pass. If a `compliance-api` test asserted an errored subject's membership as `ipp: true`, read ADR-061 first: the API "says where its numbers came from"; update the expectation to no-population and make sure the response still carries the error marker it carried before (do not add a new field).

---

### Task 7: The programs overview shows the evidence's rate, separately from the workflow-status rate

**Files:**
- Create: `backend-ts/src/fhir/run-aggregate.ts`, `backend-ts/src/program/measure-rate.ts`, `backend-ts/src/program/measure-rate.test.ts`
- Modify: `backend-ts/src/routes/runs.ts` (`runProducedOfficialEvidence` + paged loop move), `backend-ts/src/program/program-read-models.ts` (`ProgramSummary`, `programOverview`), `frontend/app/(dashboard)/programs/page.tsx`
- Test: `frontend/app/(dashboard)/programs/__tests__/page.measure-rate.test.tsx` (new)

- [ ] **Step 1: Backend failing test** — `backend-ts/src/program/measure-rate.test.ts`

```ts
/**
 * The dashboard's measure rate is the run's official evidence reduced by the SAME aggregator the
 * MeasureReport uses — not a second reducer, and not the workflow-status buckets (ADR-077).
 *   node --import tsx --test src/program/measure-rate.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeRecord } from "../stores/outcome-store.ts";
import { officialMeasureRate, resetMeasureRateMemo } from "./measure-rate.ts";

const official = (populationResults: Record<string, boolean>) => ({ official: { populationResults } });
let n = 0;
const rec = (status: string, evidence: Record<string, unknown>): OutcomeRecord =>
  ({ id: `o-${++n}`, runId: "run-1", subjectId: `p-${n}`, measureId: "cms122", evaluationPeriod: "2026", status, evidence, evaluatedAt: "2026-06-01T00:00:00.000Z" });

test("reduces official evidence to per-rate counts, an effective denominator and a score; counts errors", async () => {
  resetMeasureRateMemo();
  const rows = [
    rec("OVERDUE", official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false })),   // poor control
    rec("COMPLIANT", official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false })),
    rec("EXCLUDED", official({ ipp: true, denom: true, numer: false, denex: true, denexcep: false })),
    rec("MISSING_DATA", official({ ipp: false, denom: false, numer: false, denex: false, denexcep: false })),
    rec("MISSING_DATA", { evaluationError: "engine threw", message: "boom" }),
  ];
  let calls = 0;
  const os = { listOutcomes: async (_runId: string, opts?: { limit?: number; offset?: number }) => { calls++; return rows.slice(opts?.offset ?? 0, (opts?.offset ?? 0) + (opts?.limit ?? rows.length)); } };
  const rate = await officialMeasureRate(os, "run-1", "cms122");
  assert.ok(rate);
  assert.equal(rate.source, "official-evidence");
  assert.deepEqual(rate.rates, [{ label: null, ipp: 3, denom: 3, denex: 1, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }]);
  assert.equal(rate.evaluationErrors, 1);
  assert.equal(rate.unmeasured, 0);
  const again = await officialMeasureRate(os, "run-1", "cms122");
  assert.equal(again, rate, "memoized per immutable terminal run");
  assert.ok(calls >= 1);
});

test("a run with no official evidence has no measure rate (null), never a status-bucket stand-in", async () => {
  resetMeasureRateMemo();
  const os = { listOutcomes: async () => [rec("COMPLIANT", { expressionResults: [] })] };
  assert.equal(await officialMeasureRate(os, "run-2", "audiogram"), null);
});

test("a multi-rate measure carries its reviewed rate labels", async () => {
  resetMeasureRateMemo();
  const two = { official: { rates: [{ ipp: true, denom: true, numer: true, denex: false, denexcep: false }, { ipp: true, denom: true, numer: false, denex: false, denexcep: false }] } };
  const os = { listOutcomes: async () => [{ ...rec("OVERDUE", two), measureId: "cms137" }] };
  const rate = await officialMeasureRate(os, "run-3", "cms137");
  assert.deepEqual(rate?.rates.map((r) => r.label), ["Initiation", "Engagement"]);
});
```
(If `OutcomeRecord` has fields beyond those listed, add them to `rec` — read `outcome-store.ts` for the exact interface.)

- [ ] **Step 2: Run, expect module-not-found**

```bash
cd backend-ts && node --import tsx --test src/program/measure-rate.test.ts 2>&1 | tail -5
```

- [ ] **Step 3: Move the paged aggregation out of the route** — `backend-ts/src/fhir/run-aggregate.ts`

```ts
/**
 * One run's official evidence, summed page by page — shared by the MeasureReport/QRDA III exporters
 * (`routes/runs.ts`) and the programs overview (`program/measure-rate.ts`), so the dashboard and the
 * regulatory export cannot disagree because they reduced the same rows differently (ADR-077).
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import {
  createRateAggregator,
  isEvaluationErrorEvidence,
  officialMembership,
  officialReportIdentity,
  type OfficialReportIdentity,
  type RateAggregate,
} from "./measure-report.ts";

/** Rows per page when summing a run's official evidence; bounded memory at any roster size. */
export const AGGREGATE_PAGE = 2000;

export interface OfficialRunAggregate extends RateAggregate {
  /** The artifact identity read off the first evaluated row; null when no row carried one. */
  official: OfficialReportIdentity | null;
}

/** Whether ANY evaluated row of the run carries official population evidence (errored rows are skipped, never read as "not official"). */
export async function runProducedOfficialEvidence(os: Pick<OutcomeStore, "listOutcomes">, runId: string): Promise<boolean> {
  // (move the existing body of routes/runs.ts `runProducedOfficialEvidence` here unchanged)
}

export async function aggregateOfficialRun(os: Pick<OutcomeStore, "listOutcomes">, runId: string, measureId: string): Promise<OfficialRunAggregate> {
  const aggregator = createRateAggregator(measureId);
  let identity: OfficialReportIdentity | null = null;
  for (let offset = 0; ; offset += AGGREGATE_PAGE) {
    const page = await os.listOutcomes(runId, { limit: AGGREGATE_PAGE, offset });
    for (const row of page) {
      aggregator.add(row);
      if (!identity && !isEvaluationErrorEvidence(row.evidence)) identity = officialReportIdentity(row.evidence);
    }
    if (page.length < AGGREGATE_PAGE) break;
  }
  return { ...aggregator.finish(), official: identity };
}
```
In `runs.ts`: delete the local `runProducedOfficialEvidence`, `AGGREGATE_PAGE` and the paged loop inside `aggregateCountsForRun`; import both functions from `../fhir/run-aggregate.ts`; `aggregateCountsForRun`'s official branch becomes
```ts
  const { rates, strata, unmeasured, evaluationErrors, official: identity } = await aggregateOfficialRun(os, runId, measureId);
  return { counts: rates, strata, unmeasured, evaluationErrors, official: identity };
```
Keep the explanatory comments (paged-not-listOutcomes, per-rate, unmeasured) by moving them onto `aggregateOfficialRun`.

- [ ] **Step 4: The measure rate** — `backend-ts/src/program/measure-rate.ts`

```ts
/**
 * The evidence-based rate for one terminal run of one measure — the number a quality lead means by
 * "our CMS122 rate". Reduced by `createRateAggregator`, which already applies the CQM IG folds
 * (numerator exclusions into the numerator, exceptions conditional on the raw numerator), so the score
 * here is `numer / (denom − denex − denexcep)` over its NORMALIZED output and nothing is subtracted
 * twice. Shown on the programs overview as a metric SEPARATE from the workflow-status rate (ADR-077).
 */
import type { OutcomeStore } from "../stores/outcome-store.ts";
import { aggregateOfficialRun, runProducedOfficialEvidence } from "../fhir/run-aggregate.ts";
import { officialMeasureSemantics } from "../wiring/official-measure-semantics.ts";

export interface MeasureRateGroup {
  /** The reviewed rate label (`OFFICIAL_MEASURE_SEMANTICS[id].rateLabels`); null for a single-rate measure. */
  label: string | null;
  ipp: number;
  denom: number;
  denex: number;
  denexcep: number;
  numer: number;
  /** `denom − denex − denexcep` — what the score divides by. */
  effectiveDenominator: number;
  /** `numer / effectiveDenominator`, or null when the effective denominator is 0. */
  score: number | null;
}

export interface MeasureRate {
  source: "official-evidence";
  runId: string;
  /** The artifact canonical the evidence names, when a row carried it. */
  measureCanonical: string | null;
  rates: MeasureRateGroup[];
  /** Subjects counted in no rate (ADR-074 d5). */
  unmeasured: number;
  /** Subjects whose evaluation threw: in no population, reported rather than hidden. */
  evaluationErrors: number;
}

/** Terminal runs are immutable, so a run's rate never changes; bounded FIFO over (runId, measureId). */
const memo = new Map<string, MeasureRate>();
const MEMO_LIMIT = 32;
export function resetMeasureRateMemo(): void {
  memo.clear();
}

export async function officialMeasureRate(
  os: Pick<OutcomeStore, "listOutcomes">,
  runId: string,
  measureId: string,
): Promise<MeasureRate | null> {
  const key = `${runId}|${measureId}`;
  const hit = memo.get(key);
  if (hit) return hit;
  // One row decides whether there is official evidence to reduce; an authored run is never paged.
  if (!(await runProducedOfficialEvidence(os, runId))) return null;
  const aggregate = await aggregateOfficialRun(os, runId, measureId);
  const labels = officialMeasureSemantics(measureId)?.rateLabels;
  const rate: MeasureRate = {
    source: "official-evidence",
    runId,
    measureCanonical: aggregate.official?.canonical ?? null,
    rates: aggregate.rates.map((c, index) => {
      const effectiveDenominator = c.denom - c.denex - c.denexcep;
      return {
        label: labels?.[index] ?? null,
        ipp: c.ipp, denom: c.denom, denex: c.denex, denexcep: c.denexcep, numer: c.numer,
        effectiveDenominator,
        score: effectiveDenominator > 0 ? c.numer / effectiveDenominator : null,
      };
    }),
    unmeasured: aggregate.unmeasured,
    evaluationErrors: aggregate.evaluationErrors,
  };
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
  memo.set(key, rate);
  return rate;
}
```
Check `OfficialReportIdentity`'s field name for the canonical (read `measure-report.ts` where `officialReportIdentity` is defined) and use it instead of `.canonical` if it differs.

- [ ] **Step 5: Wire into the overview**

`program-read-models.ts`: import `officialMeasureRate, type MeasureRate` from `./measure-rate.ts`; add to `ProgramSummary`:
```ts
  /**
   * The EVIDENCE's rate for `latestRunId` — the measure's own populations reduced by the same
   * aggregator the MeasureReport uses — or null when the run carries no official evidence. Shown as a
   * separate metric from `complianceRate`, which is the workflow-status rate (ADR-077).
   */
  measureRate: MeasureRate | null;
```
In `programOverview`, the summary literal gets `measureRate: null,` and after `await foldScaleCounts(...)` add:
```ts
  // Sequential and memoized: one paged read per (run, measure) for the life of the process, and the
  // overview has at most a handful of measures. Authored runs cost one row (`runProducedOfficialEvidence`).
  for (const s of summaries) {
    if (s.latestRunId) s.measureRate = await officialMeasureRate(deps.outcomeStore, s.latestRunId, s.measureId);
  }
```
Update the module docstring (lines 1-10) to mention the two rates. `foldScaleCounts` must not touch `measureRate`.

- [ ] **Step 6: Run backend**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/program/*.test.ts src/routes/runs.test.ts src/routes/programs*.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```
Expected: all pass. Any test that constructs a `ProgramSummary` literal needs `measureRate: null`.

- [ ] **Step 7: Frontend failing test** — `frontend/app/(dashboard)/programs/__tests__/page.measure-rate.test.tsx`

Copy the mock preamble of `page.inverse.test.tsx` (lines 1-16) verbatim, then:
```tsx
import ProgramsPage from "../page";

const base = {
  measureId: "cms137", measureName: "Initiation and Engagement of Substance Use Disorder Treatment", policyRef: "CMS137", version: "FHIR v1",
  latestRunId: "run-1", latestRunAt: "2026-08-30T00:00:00Z", totalEvaluated: 10, denominator: 10,
  compliant: 4, dueSoon: 0, overdue: 6, missingData: 0, excluded: 0, complianceRate: 40, openCaseCount: 6,
};
const withRate = {
  ...base,
  measureRate: {
    source: "official-evidence", runId: "run-1", measureCanonical: null,
    rates: [
      { label: "Initiation", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 4, effectiveDenominator: 10, score: 0.4 },
      { label: "Engagement", ipp: 10, denom: 10, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 10, score: 0.1 },
    ],
    unmeasured: 0, evaluationErrors: 2,
  },
};
const withoutRate = { ...base, measureId: "audiogram", measureName: "Audiogram", policyRef: "OSHA", measureRate: null };

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) => {
    if (url === "/api/measures") return Promise.resolve([]);
    if (url.startsWith("/api/programs?") || url === "/api/programs") return Promise.resolve([withRate, withoutRate]);
    return Promise.resolve([]);
  });
});

describe("ProgramsPage measure rate", () => {
  it("shows the evidence's rate per rate, labelled as official evidence, beside — not on — the workflow-status rate", async () => {
    render(<ProgramsPage />);
    const tile = await screen.findByTestId("measure-rate-cms137");
    expect(within(tile).getByText("Measure rate (official evidence)")).toBeInTheDocument();
    expect(within(tile).getByText(/Initiation/)).toHaveTextContent("40.0%");
    expect(within(tile).getByText(/Engagement/)).toHaveTextContent("10.0%");
    expect(within(tile).getByText(/2 evaluation errors not counted/)).toBeInTheDocument();
    expect(screen.getAllByText("Workflow status").length).toBeGreaterThan(0);
  });

  it("shows no measure-rate tile for a run without official evidence", async () => {
    render(<ProgramsPage />);
    await screen.findByTestId("measure-rate-cms137");
    expect(screen.queryByTestId("measure-rate-audiogram")).not.toBeInTheDocument();
  });
});
```
(Add `within` to the testing-library import. Read the page's actual `/api/programs` URL construction and match the mock to it.)

- [ ] **Step 8: Frontend implementation** in `programs/page.tsx`

Extend `ProgramSummary`:
```ts
  measureRate?: {
    source: "official-evidence";
    runId: string;
    measureCanonical: string | null;
    rates: Array<{ label: string | null; ipp: number; denom: number; denex: number; denexcep: number; numer: number; effectiveDenominator: number; score: number | null }>;
    unmeasured: number;
    evaluationErrors: number;
  } | null;
```
In the card's headline block, under the `{programRate.label} {value}%` paragraph, add a caption `<p className="text-xs text-neutral-500 dark:text-neutral-400">Workflow status</p>` (keep the existing "Lower is better" note after it). Change the trend eyebrow text from `Trend` to `Workflow status trend` and the caption to `` `${program.measureName} workflow status history` ``.

After the status chips `div` and before the trend `div`, insert:
```tsx
              {program.measureRate ? (
                <div className="mt-3 rounded border border-neutral-200 p-2 dark:border-neutral-800" data-testid={`measure-rate-${program.measureId}`}>
                  <p className="text-xs font-semibold uppercase tracking-[0.15em] text-neutral-500 dark:text-neutral-400">Measure rate (official evidence)</p>
                  {program.measureRate.rates.map((rate, index) => (
                    <p key={rate.label ?? index} className="text-sm text-neutral-900 dark:text-neutral-100">
                      {rate.label ?? "Rate"}: {rate.score === null ? "n/a" : `${(rate.score * 100).toFixed(1)}%`}
                      <span className="ml-1 text-xs text-neutral-500 dark:text-neutral-400">
                        {fmtCount(rate.numer)} / {fmtCount(rate.effectiveDenominator)} (initial population {fmtCount(rate.ipp)}, removed {fmtCount(rate.denex + rate.denexcep)})
                      </span>
                    </p>
                  ))}
                  {program.measureRate.evaluationErrors > 0 ? (
                    <p className="text-xs text-rose-700 dark:text-rose-300">{program.measureRate.evaluationErrors} evaluation errors not counted</p>
                  ) : null}
                  {program.measureRate.unmeasured > 0 ? (
                    <p className="text-xs text-amber-700 dark:text-amber-300">{program.measureRate.unmeasured} counted in no rate</p>
                  ) : null}
                </div>
              ) : null}
```
Find the page-level KPI that renders `overallComplianceRate` and relabel it `Workflow compliance` if its label currently says "Compliance" alone; do not compute anything new there.

- [ ] **Step 9: Run frontend**

```bash
cd frontend && npx vitest run "app/(dashboard)/programs" 2>&1 | tail -8 && npm run lint 2>&1 | tail -3
```
Expected: all programs tests pass (the inverse/pilot/terminology tests may need `measureRate: null` in their fixtures only if the type is required; it is optional above, so they should not).

---

### Task 8: The roster tells "not in population" and "evaluation failed" apart from "missing data"

**Files:**
- Modify: `backend-ts/src/compliance/roster-vocabulary.ts:14-16,24-40`, `backend-ts/src/cds/cards.ts` (the display-state switch), `frontend/lib/status.ts:145-155,~190`
- Test: `backend-ts/src/compliance/roster-vocabulary.test.ts`, `backend-ts/src/cds/cards.test.ts:278`

- [ ] **Step 1: Failing vocabulary test** (append; mirrors the env pattern at `:131-140`)

```ts
test("official: out of the initial population → OUT_OF_POPULATION; an evaluation error → MISSING_DATA with a failure method (ADR-077)", () => {
  const prior = process.env.WORKWELL_OFFICIAL_MEASURES;
  process.env.WORKWELL_OFFICIAL_MEASURES = "cms122";
  try {
    const out = deriveCell("MISSING_DATA", { expressionResults: [], official: { populationResults: { ipp: false, denom: false, denex: false, numer: false, denexcep: false } } }, "cms122", PERIOD);
    assert.equal(out.status, "OUT_OF_POPULATION");
    assert.match(out.method, /initial population/);
    const err = deriveCell("MISSING_DATA", { evaluationError: "engine failure", message: "boom" }, "cms122", PERIOD);
    assert.deepEqual(err, { status: "MISSING_DATA", method: "Evaluation failed; no engine result for this subject" });
    const inPop = deriveCell("MISSING_DATA", { expressionResults: [], official: { populationResults: { ipp: true, denom: true, denex: false, numer: false, denexcep: false } } }, "cms122", PERIOD);
    assert.equal(inPop.status, "MISSING_DATA", "in the population and missing data stays MISSING_DATA");
  } finally {
    if (prior === undefined) delete process.env.WORKWELL_OFFICIAL_MEASURES;
    else process.env.WORKWELL_OFFICIAL_MEASURES = prior;
  }
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd backend-ts && node --import tsx --test src/compliance/roster-vocabulary.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
```

- [ ] **Step 3: Implement** in `roster-vocabulary.ts`

Add `| "OUT_OF_POPULATION"` to `DisplayState` with a comment: *evaluated by the official logic and found outside the measure's initial population — nothing to chase, and NOT the same as "no data" or "not evaluated".* Import `isEvaluationErrorEvidence, officialMembership` from `../fhir/measure-report.ts`. At the top of `deriveCell`, before `const ers = ...`:
```ts
  // No engine spoke for this subject. Say so, rather than the measure's "missing data" wording, which
  // would read as a clinical fact about the record (ADR-077).
  if (isEvaluationErrorEvidence(evidence)) return { status: "MISSING_DATA", method: "Evaluation failed; no engine result for this subject" };
```
Replace the official branch:
```ts
  if (isOfficialRouted(measureId)) {
    const d = officialDisplayFor(measureId, canonicalStatus, evidence);
    // Out of the initial population is a RESULT: the logic ran and this subject is not the measure's
    // concern this period. It shared MISSING_DATA's chip with "in the population, data missing", so a
    // panel could not tell a diabetic with no HbA1c from a non-diabetic (review finding 7).
    if (canonicalStatus === "MISSING_DATA" && officialMembership(evidence)?.ipp === false) {
      return { status: "OUT_OF_POPULATION", method: d?.method ?? "Not in the measure's initial population for this period" };
    }
    if (d) return { status: canonicalStatus as DisplayState, method: d.method };
  }
```

- [ ] **Step 4: CDS cards** — open `backend-ts/src/cds/cards.ts`, find where `EXCLUDED` yields no card, and treat `OUT_OF_POPULATION` identically (one line + the docstring sentence at ~:246). In `cards.test.ts:278` add `"OUT_OF_POPULATION"` to `ALL` and assert it produces no card, next to the EXCLUDED assertion.

- [ ] **Step 5: Frontend labels** — `frontend/lib/status.ts`: add `OUT_OF_POPULATION: "Not in population",` to `COMPLIANCE_STATUS_LABELS`; in `complianceStatusClass` add `if (normalized === "OUT_OF_POPULATION") return "bg-slate-100 text-slate-700 dark:bg-slate-800/40 dark:text-slate-300";` before the NOT_APPLICABLE line. Grep `app/(dashboard)/compliance` for a hard-coded status option list; if the roster filter builds its options from a literal array, add `OUT_OF_POPULATION` there too.

- [ ] **Step 6: Run**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/compliance/*.test.ts src/cds/*.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
cd ../frontend && npx vitest run lib 2>&1 | tail -5
```

---

### Task 9: A run explains its own numbers — the reconciliation endpoint

**Files:**
- Modify: `backend-ts/src/routes/runs.ts` (new `GET /api/runs/:id/reconciliation`), `frontend/app/(dashboard)/runs/page.tsx`
- Test: `backend-ts/src/routes/runs.test.ts`, `frontend/app/(dashboard)/runs/__tests__/page.reconciliation.test.tsx` (new)

- [ ] **Step 1: Backend failing test** (append to `runs.test.ts`, BEFORE the compaction test from Task 4)

```ts
test("GET /api/runs/:id/reconciliation names its units and ties rows, errors, populations and cases together", async () => {
  await get("/api/runs");
  const runStore = new SqliteRunStore(env.DB as never);
  const outcomeStore = new SqliteOutcomeStore(env.DB as never);
  const run = await runStore.createRun({
    status: "PARTIAL_FAILURE", scopeType: "MEASURE", scopeId: "cms122", triggeredBy: "test", requestedScope: { measureId: "cms122" },
    measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T23:59:59.999Z",
  });
  const official = (populationResults: Record<string, boolean>) => ({ official: { populationResults } });
  await outcomeStore.recordOutcomes([
    { runId: run.id, subjectId: "p-1", measureId: "cms122", evaluationPeriod: "2026", status: "OVERDUE", evidence: official({ ipp: true, denom: true, numer: true, denex: false, denexcep: false }) },
    { runId: run.id, subjectId: "p-2", measureId: "cms122", evaluationPeriod: "2026", status: "COMPLIANT", evidence: official({ ipp: true, denom: true, numer: false, denex: false, denexcep: false }) },
    { runId: run.id, subjectId: "p-3", measureId: "cms122", evaluationPeriod: "2026", status: "MISSING_DATA", evidence: official({ ipp: false, denom: false, numer: false, denex: false, denexcep: false }) },
    { runId: run.id, subjectId: "p-4", measureId: "cms122", evaluationPeriod: "2026", status: "MISSING_DATA", evidence: { evaluationError: "engine threw", message: "boom" } },
  ]);
  const res = (await get(`/api/runs/${run.id}/reconciliation`))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.unit, "subject-measure pairs");
  assert.equal(body.rowsPersisted, 4);
  assert.equal(body.evaluationErrors, 1);
  assert.deepEqual(body.official, {
    measureId: "cms122",
    rates: [{ label: null, ipp: 2, denom: 2, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }],
    outOfPopulation: 1, unmeasured: 0, evaluationErrors: 1,
  });
  assert.equal(body.casesCiting, 0);
  assert.deepEqual(body.compaction, { exposed: false, cutoff: null });
  assert.equal(body.workItems, null, "no RUN_COMPLETED ledger event was written for a store-created run");

  const running = await runStore.createRun({ status: "RUNNING", scopeType: "MEASURE", scopeId: "cms122", triggeredBy: "test", requestedScope: {}, measurementPeriodStart: "2026-01-01T00:00:00.000Z", measurementPeriodEnd: "2026-12-31T23:59:59.999Z" });
  assert.equal((await get(`/api/runs/${running.id}/reconciliation`))!.status, 409, "a moving run has nothing to reconcile yet");
});
```

- [ ] **Step 2: Run, expect failure** (`null` response → the test's `!` throws)

- [ ] **Step 3: Implement the route** in `runs.ts`, before the run-detail route (`/^\/api\/runs\/([^/]+)$/`):

```ts
  /**
   * The reconciliation ladder (review finding 5): every count on this run, in ONE stated unit, so a
   * reader can see why the roster, the summary and the export do not show the same number. Units
   * matter: the directory counts people, this run counts subject-measure PAIRS, a rate counts subjects
   * in a population, and a case is one (subject, measure, period). Terminal runs only — a moving run has
   * nothing to reconcile yet.
   */
  const reconId = pathname.match(/^\/api\/runs\/([^/]+)\/reconciliation$/)?.[1];
  if (reconId && req.method === "GET") {
    const run = await (await store(env)).getRun(reconId);
    if (!run) return json({ error: "not_found", id: reconId }, 404);
    if (!TERMINAL_RUN_STATUSES.has(run.status)) return json({ error: "run_not_terminal", status: run.status }, 409);
    const stores = await getStores(env);
    const byStatus = await stores.outcomes.countOutcomesByStatus(reconId);
    const rowsPersisted = byStatus.reduce((sum, c) => sum + c.count, 0);
    const completedEvent = (await stores.events.auditEventsByRun(reconId)).find((e) => e.eventType === "RUN_COMPLETED");
    const workItems = typeof completedEvent?.payload?.totalEvaluated === "number" ? completedEvent.payload.totalEvaluated : null;
    const measureIds = await stores.outcomes.distinctMeasuresForRun(reconId, 2);
    let official: Record<string, unknown> | null = null;
    let evaluationErrors = 0;
    if (measureIds.length === 1) {
      const measureId = measureIds[0]!;
      const rate = await officialMeasureRate(stores.outcomes, reconId, measureId);
      if (rate) {
        // Rows persisted minus rows in the initial population of rate 1 minus errors = out of population.
        const inIpp = rate.rates[0]?.ipp ?? 0;
        official = { measureId, rates: rate.rates, outOfPopulation: rowsPersisted - inIpp - rate.evaluationErrors, unmeasured: rate.unmeasured, evaluationErrors: rate.evaluationErrors };
        evaluationErrors = rate.evaluationErrors;
      }
    }
    if (!official) {
      // Authored runs carry no population evidence; count errors by reading the rows once, paged.
      for (let offset = 0; ; offset += AGGREGATE_PAGE) {
        const page = await stores.outcomes.listOutcomes(reconId, { limit: AGGREGATE_PAGE, offset });
        for (const row of page) if (isEvaluationErrorEvidence(row.evidence)) evaluationErrors += 1;
        if (page.length < AGGREGATE_PAGE) break;
      }
    }
    return json({
      runId: reconId,
      status: run.status,
      unit: "subject-measure pairs",
      workItems,
      rowsPersisted,
      byStatus: byStatus.map((c) => ({ status: c.status, count: c.count })),
      evaluationErrors,
      official,
      casesCiting: await stores.cases.countByLastRun(reconId),
      compaction: await compactionExposure(run, stores.events),
      notes: [
        "workItems is the ledger's count of pairs the run set out to evaluate (null when the RUN_COMPLETED event is absent); rowsPersisted is what survives in the outcomes table.",
        "A rate counts subjects in that rate's population; outOfPopulation subjects were evaluated and found outside it; evaluationErrors are in no population.",
        "casesCiting counts cases whose last run is this one — one per (subject, measure, period), not per outreach.",
      ],
    });
  }
```
Import `officialMeasureRate` from `../program/measure-rate.ts` and `AGGREGATE_PAGE` from `../fhir/run-aggregate.ts`. If `stores.cases.countByLastRun` is named differently, use the same call the run-detail route uses for `totalCases`.

- [ ] **Step 4: Frontend** — in `runs/page.tsx`, add state `const [reconciliation, setReconciliation] = useState<Reconciliation | null>(null);` with a `Reconciliation` type matching the JSON above; when the selected run is terminal, `api.get(\`/api/runs/${selectedRunId}/reconciliation\`)` alongside the summary fetch (find where `/api/runs/${id}` is fetched and add it there, catching errors into `null`). Render after the Outcome Counts block:
```tsx
              {reconciliation ? (
                <div data-testid="run-reconciliation">
                  <p className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">Reconciliation ({reconciliation.unit})</p>
                  <ul className="text-xs text-neutral-600 dark:text-neutral-400">
                    <li>Set out to evaluate: {reconciliation.workItems ?? "not recorded"}</li>
                    <li>Rows persisted: {reconciliation.rowsPersisted}</li>
                    <li>Evaluation errors (in no population): {reconciliation.evaluationErrors}</li>
                    {reconciliation.official ? (
                      <>
                        <li>Evaluated, not in population: {reconciliation.official.outOfPopulation}</li>
                        {reconciliation.official.rates.map((rate, index) => (
                          <li key={rate.label ?? index}>
                            {rate.label ?? "Rate"}: initial population {rate.ipp}, denominator {rate.denom}, removed {rate.denex + rate.denexcep}, numerator {rate.numer}
                            {rate.score === null ? "" : `, score ${(rate.score * 100).toFixed(1)}%`}
                          </li>
                        ))}
                      </>
                    ) : null}
                    <li>Cases citing this run: {reconciliation.casesCiting}</li>
                    {reconciliation.compaction.exposed ? <li className="text-amber-700 dark:text-amber-300">A retention pass (cutoff {reconciliation.compaction.cutoff}) may have removed rows; population exports are refused.</li> : null}
                  </ul>
                </div>
              ) : null}
```

- [ ] **Step 5: Frontend test** — `page.reconciliation.test.tsx`: same preamble as Task 2's test; mock `/api/runs/run-1/reconciliation` to return `{ runId: "run-1", status: "COMPLETED", unit: "subject-measure pairs", workItems: 4, rowsPersisted: 4, byStatus: [], evaluationErrors: 1, official: { measureId: "cms122", rates: [{ label: null, ipp: 2, denom: 2, denex: 0, denexcep: 0, numer: 1, effectiveDenominator: 2, score: 0.5 }], outOfPopulation: 1, unmeasured: 0, evaluationErrors: 1 }, casesCiting: 1, compaction: { exposed: false, cutoff: null }, notes: [] }`; assert `findByTestId("run-reconciliation")` contains "Rows persisted: 4", "Evaluated, not in population: 1" and "score 50.0%".

- [ ] **Step 6: Run everything touched**

```bash
cd backend-ts && pnpm typecheck && node --import tsx --test src/routes/runs.test.ts 2>&1 | grep -E "not ok|# (pass|fail)"
cd ../frontend && npx vitest run "app/(dashboard)/runs" 2>&1 | tail -6 && npm run lint 2>&1 | tail -3
```

---

### Task 10: Documentation that travels with the behaviour

**Files:**
- Modify: `docs/DECISIONS.md` (new ADR-077 at the top; SINCE notes under ADR-073 :444 and ADR-074 d12 :284), `docs/ADR_INDEX.md`, `docs/DATA_MODEL_CONTRACTS.md:185-215`, `docs/guide/05-fhir.md` (MeasureReport/QRDA export section), `docs/JOURNAL.md`

- [ ] **Step 1: ADR-077** — insert above ADR-076 in `DECISIONS.md`:

```markdown
## ADR-077: a report is refused rather than rendered from rows that may be incomplete — and a dashboard rate is the evidence's rate, shown apart from the workflow's

**Date:** 2026-09-08. **Status:** accepted. Amends ADR-031, ADR-073, ADR-074 d12.

### Context
An external review of the pilot sandbox (2026-09-07) found four ways a number could be shown with a
meaning it did not have, all reproduced against `564d5d93`: every MeasureReport variant returned
`status: "complete"` for REQUESTED, QUEUED, RUNNING, FAILED and CANCELLED runs while QRDA refused them;
a COMPLETED SITE recheck became the whole practice's population snapshot; outcome compaction changed a
historical run's score from 1/2 to 0/1 while the run's own "total" fell in step, because that total is
a count of the surviving rows; and a FAILED rerun's row evicted the last finalized answer. Separately,
the programs dashboard's headline was the five workflow buckets reduced to a percentage, labelled as if
it were the CMS rate, and an evaluation error was counted by the authored status rule as a subject in
the denominator who failed.

### Decision
1. **One reportability predicate.** `src/run/reportable.ts` (COMPLETED, PARTIAL_FAILURE) governs
   MeasureReport (all three variants), QRDA I and QRDA III, and the UI's export buttons mirror it. A
   FAILED or CANCELLED run is terminal and not reportable. (Extends ADR-074 d12.)
2. **Completeness evidence is the ledger, never the surviving rows.** `compactOutcomes` awaits an
   `OUTCOMES_COMPACTION_STARTED` intent event before deleting; the newest such event's `cutoff` bounds
   what any pass could have reached. A population export from a run that started before that cutoff is
   refused with 409 `run_compacted`. Conservative by design: a run whose rows all survived is still
   refused, because the alternative is a score wearing an identity it no longer earns. Comparing
   `totalEvaluated` with surviving rows was rejected as circular.
3. **The keep set protects the newest USABLE row** (from a reportable run, not an evaluation error)
   AND the newest row regardless, per (subject, measure, period), plus what cases cite; rows of an
   in-flight run are never candidates. (Amends ADR-073.)
4. **A population winner is a whole-roster run.** `POPULATION_SCOPES` = MEASURE, ALL_PROGRAMS — an
   allowlist. SITE, CASE and EMPLOYEE runs are visible in case detail and never replace the snapshot.
5. **The dashboard's measure rate is the evidence's rate**, reduced by `createRateAggregator` — the
   same reducer the MeasureReport uses, whose `normalizeMembership` already applies the CQM IG folds,
   so nothing is subtracted twice — and shown as a SEPARATE metric from the workflow-status rate, which
   keeps its history under its own name. No improvement is computed between the two.
6. **An evaluation error is in no population.** It is counted (`evaluationErrors` on the aggregate, the
   `x-workwell-evaluation-errors` header, the reconciliation endpoint, the dashboard tile) and never
   inside a denominator. (Amends ADR-031's status-rule fallback for errored rows.)
7. **The roster distinguishes** OUT_OF_POPULATION (evaluated, outside the initial population) from
   MISSING_DATA (in the population, data missing) and from an evaluation failure (MISSING_DATA with a
   failure method), and a run has a reconciliation endpoint that names its unit.

### Consequences
- A run older than the retention window can no longer export a MeasureReport or QRDA; its counts, its
  quality-history snapshot and the surviving outcomes CSV remain. A durable per-run report archive is
  the way to keep old reports exportable and is an owner decision (schema).
- The Postgres keep set now joins `runs`; its cost at pilot scale is recorded as unmeasured in the
  store's comment and is a follow-up to EXPLAIN ANALYZE before the pilot's table grows.
- A SITE run's fresher result is not reflected on the roster until the next whole-roster run; a
  "newer check available" overlay is deferred to the panel-worklist slice.
- The reproduction script that surfaced these defects bypasses `compactOutcomes`, so its compaction
  check does not observe decision 2; the contract tests carry the equivalent through the policy layer.
```

- [ ] **Step 2: SINCE notes.** Under ADR-073's Decision list add: *"SINCE 2026-09-08 (ADR-077 d2/d3): the keep set protects the newest USABLE row as well as the newest row; in-flight runs are never compacted; and the intent event is the completeness evidence a population export checks."* Under ADR-074 d12 add: *"SINCE 2026-09-08 (ADR-077 d1): the same set now guards every MeasureReport variant, and the UI mirrors it."*

- [ ] **Step 3: `docs/ADR_INDEX.md`** — add at the top of the list: `- ADR-077: a report is refused rather than rendered from rows that may be incomplete — and a dashboard rate is the evidence's rate, shown apart from the workflow's`, and change "(14 of 75)" / "61 unmarked" to "(14 of 76)" / "62 unmarked".

- [ ] **Step 4: `docs/DATA_MODEL_CONTRACTS.md` §6.5** — replace the "Never deleted" list's first bullet with the usable-plus-newest rule, add a bullet "every row of a run that is still QUEUED/RUNNING", and replace the "What a consumer sees after the window" paragraph: the outcomes CSV returns surviving rows with the `retentionNotice`; **MeasureReport (every variant), QRDA I and QRDA III answer 409 `run_compacted`** when a compaction pass's cutoff postdates the run's start, and the evidence for that is the `OUTCOMES_COMPACTION_STARTED` event, never the run's own counts.

- [ ] **Step 5: `docs/guide/05-fhir.md`** — in the section that describes the MeasureReport/QRDA exports, state the reportable set, both 409s (`run_not_reportable`, `run_compacted`), the two response headers (`x-workwell-unmeasured-subjects`, `x-workwell-evaluation-errors`), and that the programs overview's measure rate is the same aggregate. One paragraph; link ADR-077.

- [ ] **Step 6: `docs/JOURNAL.md`** — new top entry `## 2026-09-08 — the numbers a quality lead can see are true or refused (ADR-077)`: what the review found (without quoting it or naming its author's tool), what changed, what was deliberately deferred (roster overlay, report archive, EXPLAIN at scale, source interpretation, corpus time, worklist), and the three owner items (backup key + Maui backup workflow, PY2027 lineage question to MIE, adjudication time with the pilot's quality lead). Naming policy: "Maui", "the pilot group", "the pilot's quality lead".

---

### Task 11: Whole-suite verification, the reproduction, and reviews

- [ ] **Step 1: Full backend + frontend**

```bash
cd backend-ts && pnpm typecheck && pnpm test 2>&1 | tail -8
cd ../frontend && npm run lint && npm run build 2>&1 | tail -5 && npx vitest run 2>&1 | tail -6
```
Expected: green. Paste the tail lines into the PR description later.

- [ ] **Step 2: The reproduction**

```bash
cd backend-ts && node --import tsx ../docs/transcripts/workwell-review-reproductions-2026-09-07.mjs --expect-fixed 2>&1 | tail -30
```
Expected: checks 11, 12 and "13 supplement" pass; check 13 fails as explained in the header of this plan (it bypasses `compactOutcomes`). Record exactly this in the PR.

- [ ] **Step 3: Reviews before the PR opens** (owner rule: three reviewers, then Codex on the PR)
  - Gemini 3.8 high via the agy lane, own `superpowers:code-reviewer`, GLM 5.3 xhigh — one review brief each, naming ADR-077's seven decisions as the acceptance criteria and the two things a reviewer should attack: the Postgres keep-set SQL (double NOT IN, in-flight exclusion) and the compaction predicate's direction (`startedAt < cutoff`).
  - Fix what they find; re-run Step 1.

- [ ] **Step 4: Commit checkpoint (OWNER-GATED)** — stage explicit paths only; never this plan, never `docs/transcripts/`:

```bash
git status --short
git add backend-ts/src/run/reportable.ts backend-ts/src/run/compaction-evidence.ts backend-ts/src/run/compaction-evidence.test.ts \
  backend-ts/src/fhir/run-aggregate.ts backend-ts/src/fhir/measure-report.ts backend-ts/src/fhir/measure-report.test.ts \
  backend-ts/src/program/measure-rate.ts backend-ts/src/program/measure-rate.test.ts backend-ts/src/program/rollup-shared.ts \
  backend-ts/src/program/program-read-models.ts backend-ts/src/program/program-overview.population.test.ts \
  backend-ts/src/routes/runs.ts backend-ts/src/routes/runs.test.ts \
  backend-ts/src/stores/outcome-store.ts backend-ts/src/stores/store-contract.ts \
  backend-ts/src/stores/postgres/outcome-store-postgres.ts backend-ts/src/stores/sqlite/outcome-store-sqlite.ts \
  backend-ts/src/quality/materialize-run.ts backend-ts/src/compliance/roster-vocabulary.ts backend-ts/src/compliance/roster-vocabulary.test.ts \
  backend-ts/src/cds/cards.ts backend-ts/src/cds/cards.test.ts \
  frontend/lib/run-status.ts frontend/lib/status.ts "frontend/app/(dashboard)/runs/page.tsx" "frontend/app/(dashboard)/programs/page.tsx" \
  "frontend/app/(dashboard)/runs/__tests__/page.export-gate.test.tsx" "frontend/app/(dashboard)/runs/__tests__/page.reconciliation.test.tsx" \
  "frontend/app/(dashboard)/programs/__tests__/page.measure-rate.test.tsx" \
  docs/DECISIONS.md docs/ADR_INDEX.md docs/DATA_MODEL_CONTRACTS.md docs/guide/05-fhir.md docs/JOURNAL.md
git status --short   # STOP: show this to the owner and wait for the go before committing
```
Commit message (conventional, no attribution): `feat(run): a report is refused rather than rendered from incomplete rows, and the dashboard shows the evidence's rate (ADR-077)`.

- [ ] **Step 5: PR (OWNER-GATED)** — after the owner's go: push, open the PR with the verification tails, the reproduction result, the deferred list, and the request for Codex review. Then poll Codex.
