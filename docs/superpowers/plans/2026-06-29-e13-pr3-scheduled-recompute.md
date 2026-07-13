# E13 PR-3: Scheduled Recompute — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the inert `/api/admin/scheduler` to fire audited `ALL_PROGRAMS` runs on a recurring schedule via an in-process Node.js `setInterval`.

**Architecture:** A new `backend-ts/src/admin/scheduler.ts` module owns all scheduling logic — enabled state (in-memory, seeded from `WORKWELL_SCHEDULER_ENABLED` env var), `lastRunAt` derived from querying the `runs` table for `triggered_by='scheduler'` runs, and a `runTick()` function that fires `planManualRun` + `finishOrFail` with the `scheduler` trigger. `server.ts` starts a 5-minute `setInterval` that calls `schedulerTick(env)`. The admin GET/POST routes replace their in-memory stub with calls to this module. No schema changes.

**Tech Stack:** TypeScript, `@mieweb/cloud` store interfaces, Node.js `setInterval`, existing `planManualRun`/`finishOrFail` pipeline, SQLite floor + Postgres ceiling via the factory.

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `backend-ts/src/admin/scheduler.ts` | Scheduler state, tick logic, audit write, `getSchedulerStatus` |
| Create | `backend-ts/src/admin/scheduler.test.ts` | Unit tests for `runTick` + `getSchedulerStatusFromStores` |
| Modify | `backend-ts/src/run/read-models.ts:90-94` | `triggerTypeOf`: add `scheduler` → SCHEDULED, `seed:scale` → SEED |
| Modify | `backend-ts/src/run/read-models.test.ts:55-62` | Add `scheduler` → SCHEDULED assertions |
| Modify | `backend-ts/src/admin/admin-data.ts:64-78` | Remove in-memory scheduler stub (type + 4 exports) |
| Modify | `backend-ts/src/routes/admin.ts:109-113` | Wire scheduler routes to `scheduler.ts` |
| Modify | `backend-ts/src/server.ts` | Add `setInterval` tick + `clearInterval` in shutdown |
| Modify | `docs/JOURNAL.md` | E13 PR-3 entry |

---

## Task 1: Update `triggerTypeOf` + tests

**Files:**
- Modify: `backend-ts/src/run/read-models.ts:90-94`
- Modify: `backend-ts/src/run/read-models.test.ts:55-62`

- [ ] **Step 1.1: Update `triggerTypeOf` to add SCHEDULED and fix seed:scale gap**

  Open `backend-ts/src/run/read-models.ts`. Replace lines 90–94:

  ```typescript
  /** Map a run's `triggered_by` to the list/filter `triggerType`. Real operator runs stay MANUAL;
   *  seed runs surface as SEED; scheduler-fired runs surface as SCHEDULED. */
  export function triggerTypeOf(run: RunRecord): string {
    if (run.triggeredBy === "seed:trend-history" || run.triggeredBy === "seed:scale") return "SEED";
    if (run.triggeredBy === "scheduler") return "SCHEDULED";
    return "MANUAL";
  }
  ```

- [ ] **Step 1.2: Run the existing triggerType test to verify it still passes**

  ```bash
  cd backend-ts
  node --import tsx --test src/run/read-models.test.ts
  ```

  Expected: all tests PASS (the existing `seed:trend-history → SEED` assertions still hold).

- [ ] **Step 1.3: Add `scheduler` → SCHEDULED assertions to the test**

  Open `backend-ts/src/run/read-models.test.ts`. In the test named `"triggerType reflects triggered_by — seed runs surface as SEED, not MANUAL (Codex P2)"` (around line 55), add two more assertions at the end of the test body:

  ```typescript
  assert.equal(toRunListItem(run({ triggeredBy: "scheduler" }), sample).triggerType, "SCHEDULED");
  assert.equal(matchesRunFilters(run({ triggeredBy: "scheduler" }), { triggerType: "SCHEDULED" }), true);
  assert.equal(matchesRunFilters(run({ triggeredBy: "scheduler" }), { triggerType: "MANUAL" }), false);
  // Also verify seed:scale is now SEED (not MANUAL)
  assert.equal(toRunListItem(run({ triggeredBy: "seed:scale" }), sample).triggerType, "SEED");
  assert.equal(matchesRunFilters(run({ triggeredBy: "seed:scale" }), { triggerType: "SEED" }), true);
  ```

- [ ] **Step 1.4: Run the test to verify new assertions pass**

  ```bash
  node --import tsx --test src/run/read-models.test.ts
  ```

  Expected: all tests PASS including the new assertions.

- [ ] **Step 1.5: Commit**

  ```bash
  git add backend-ts/src/run/read-models.ts backend-ts/src/run/read-models.test.ts
  git commit -m "feat(scheduler): add SCHEDULED triggerType for scheduler-fired runs; fix seed:scale→SEED gap (E13 PR-3)"
  ```

---

## Task 2: Create `scheduler.ts` module

**Files:**
- Create: `backend-ts/src/admin/scheduler.ts`

- [ ] **Step 2.1: Write the failing test first (TDD) — see Task 3; skip ahead then return**

  Actually: write `scheduler.ts` now. The test file that imports it comes in Task 3.

- [ ] **Step 2.2: Write `scheduler.ts`**

  Create `backend-ts/src/admin/scheduler.ts` with this exact content:

  ```typescript
  /**
   * Scheduled recompute (E13 PR-3) — wires the in-process tick that fires audited ALL_PROGRAMS
   * runs on a configurable interval. The enabled flag lives in-memory (boot-time default from
   * WORKWELL_SCHEDULER_ENABLED; toggled via POST /api/admin/scheduler) and resets on restart —
   * matching the demo-stack pattern for optional simulation features (email, outreach, etc.).
   * lastRunAt/lastRunStatus are derived at read-time from the runs table (no new schema).
   *
   * Invariant: every state change writes an audit_event — SCHEDULER_RUN_TRIGGERED is written
   * BEFORE planManualRun so a partial failure never produces an unaudited run (CLAUDE.md hard rule).
   */
  import type { Stores, StoresEnv } from "../stores/factory.ts";
  import { getStores } from "../stores/factory.ts";
  import type { HydratedSegment } from "../stores/segment-store.ts";
  import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
  import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
  import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
  import { ensureSegmentSeed } from "../segment/segment-seed.ts";
  import { planManualRun, finishOrFail } from "../run/run-pipeline.ts";

  export interface SchedulerStatus {
    enabled: boolean;
    cron: string;
    nextFireAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: string;
  }

  export const SCHEDULER_CRON = "0 0 6 * * *"; // 6 AM UTC daily (display only — tick uses INTERVAL_HOURS)
  const SCHEDULER_RUN_INTERVAL_HOURS = 24;

  // One engine per process — matches the pattern in routes/runs.ts.
  const _engine = new CqlExecutionEngine();

  // In-memory state: resets on process restart.
  let schedulerEnabled = false;

  /** Seed `enabled` from the WORKWELL_SCHEDULER_ENABLED env var. Call once at server boot. */
  export function initSchedulerFromEnv(env: { WORKWELL_SCHEDULER_ENABLED?: string }): void {
    schedulerEnabled = (env.WORKWELL_SCHEDULER_ENABLED ?? "").toLowerCase() === "true";
  }

  /** Toggle (called by POST /api/admin/scheduler?enabled=). */
  export function setSchedulerEnabled(enabled: boolean): void {
    schedulerEnabled = enabled;
  }

  export function isSchedulerEnabled(): boolean {
    return schedulerEnabled;
  }

  /** Derive the last scheduler-fired run from the runs table (newest-first scan up to 50). */
  async function lastSchedulerRun(stores: Stores): Promise<{ at: string; status: string } | null> {
    const runs = await stores.runs.listRuns(50);
    const last = runs.find((r) => r.triggeredBy === "scheduler");
    if (!last) return null;
    return { at: last.startedAt, status: last.status };
  }

  function computeNextFireAt(lastAt: string | null): string | null {
    if (!schedulerEnabled) return null;
    if (!lastAt) {
      // Never run: schedule for today's or tomorrow's 6 AM UTC.
      const t = new Date();
      t.setUTCHours(6, 0, 0, 0);
      if (t <= new Date()) t.setUTCDate(t.getUTCDate() + 1);
      return t.toISOString();
    }
    return new Date(new Date(lastAt).getTime() + SCHEDULER_RUN_INTERVAL_HOURS * 3_600_000).toISOString();
  }

  /** Build the SchedulerStatus shape from a Stores bundle (used by GET /api/admin/scheduler). */
  export async function getSchedulerStatusFromStores(stores: Stores): Promise<SchedulerStatus> {
    const last = await lastSchedulerRun(stores);
    return {
      enabled: schedulerEnabled,
      cron: SCHEDULER_CRON,
      nextFireAt: computeNextFireAt(last?.at ?? null),
      lastRunAt: last?.at ?? null,
      lastRunStatus: last?.status ?? "unknown",
    };
  }

  /** Convenience wrapper for the route handler (resolves stores from env). */
  export async function getSchedulerStatus(env: StoresEnv): Promise<SchedulerStatus> {
    return getSchedulerStatusFromStores(await getStores(env));
  }

  /** Deps injected by the tick — separated so tests can pass a mock engine + limited employees. */
  export interface SchedulerTickDeps {
    stores: Stores;
    engine: EvaluateMeasureBinding;
    segments: HydratedSegment[];
    /** Injectable for tests — defaults to the full synthetic directory inside planManualRun. */
    employees?: readonly EmployeeProfile[];
  }

  /**
   * Core tick logic — injectable for testing (see scheduler.test.ts).
   * Returns true when a run was actually fired, false when skipped (disabled or not yet due).
   */
  export async function runTick(deps: SchedulerTickDeps): Promise<boolean> {
    if (!schedulerEnabled) return false;

    const last = await lastSchedulerRun(deps.stores);
    if (last) {
      const hoursSinceLast = (Date.now() - new Date(last.at).getTime()) / 3_600_000;
      // 30-min window so the 5-min tick doesn't miss or double-fire near the interval boundary.
      if (hoursSinceLast < SCHEDULER_RUN_INTERVAL_HOURS - 0.5) return false;
    }

    // Audit BEFORE creating the run (CLAUDE.md hard rule: every state change writes audit_event).
    await deps.stores.events.appendAudit({
      eventType: "SCHEDULER_RUN_TRIGGERED",
      entityType: "scheduler",
      entityId: null,
      actor: "scheduler",
      refRunId: null,
      refCaseId: null,
      refMeasureVersionId: null,
      payload: { cron: SCHEDULER_CRON, triggeredAt: new Date().toISOString() },
    });

    const runDeps = {
      runStore: deps.stores.runs,
      outcomeStore: deps.stores.outcomes,
      caseStore: deps.stores.cases,
      engine: deps.engine,
      segments: deps.segments,
      employees: deps.employees,
    };

    const planned = await planManualRun(runDeps, {
      scopeType: "ALL_PROGRAMS",
      triggeredBy: "scheduler",
    });

    // finishOrFail never throws — it finalizes the run FAILED on any post-plan error,
    // so the run never sticks in RUNNING after the tick returns.
    await finishOrFail(runDeps, planned);
    return true;
  }

  /**
   * Production entrypoint — resolves live stores + segments from env, then calls runTick.
   * Called from the setInterval in server.ts every 5 minutes. Errors are logged but never rethrown
   * so a transient DB glitch never kills the tick loop.
   */
  export async function schedulerTick(env: StoresEnv): Promise<void> {
    const stores = await getStores(env);
    await ensureSegmentSeed(env);
    const allSegs = await stores.segments.listSegments();
    const deps: SchedulerTickDeps = {
      stores,
      engine: _engine,
      segments: allSegs.filter((s) => s.enabled),
    };
    await runTick(deps); // caller (server.ts setInterval) catches and logs
  }
  ```

- [ ] **Step 2.3: Typecheck**

  ```bash
  cd backend-ts
  pnpm typecheck
  ```

  Expected: zero errors. If there are import errors (e.g., `CqlExecutionEngine`, `ensureSegmentSeed`), verify the import paths against the existing files in `backend-ts/src/engine/cql/` and `backend-ts/src/segment/`.

---

## Task 3: Write and run `scheduler.test.ts`

**Files:**
- Create: `backend-ts/src/admin/scheduler.test.ts`

- [ ] **Step 3.1: Write the test file**

  Create `backend-ts/src/admin/scheduler.test.ts`:

  ```typescript
  /**
   * Scheduler tick unit tests (E13 PR-3).
   *   node --import tsx --test src/admin/scheduler.test.ts
   */
  import { test, before, after } from "node:test";
  import assert from "node:assert/strict";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { rmSync } from "node:fs";
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  import { createSqliteD1 } from "@mieweb/cloud-local";
  import { RUN_STORE_FLOOR_DDL, migrateFloorSchema } from "../stores/sqlite/schema.ts";
  import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
  import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
  import { SqliteCaseStore } from "../stores/sqlite/case-store-sqlite.ts";
  import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
  import { SqliteMeasureStore } from "../stores/sqlite/measure-store-sqlite.ts";
  import { SqliteEvidenceStore } from "../stores/sqlite/evidence-store-sqlite.ts";
  import { SqliteAppointmentStore } from "../stores/sqlite/appointment-store-sqlite.ts";
  import { SqliteValueSetStore } from "../stores/sqlite/value-set-store-sqlite.ts";
  import { SqliteOutreachTemplateStore } from "../stores/sqlite/outreach-template-store-sqlite.ts";
  import { SqliteWaiverStore } from "../stores/sqlite/waiver-store-sqlite.ts";
  import { SqliteSegmentStore } from "../stores/sqlite/segment-store-sqlite.ts";
  import { AuditBackedCampaignStore } from "../stores/audit-campaign-store.ts";
  import type { Stores } from "../stores/factory.ts";
  import type { EvaluateMeasureBinding } from "../engine/evaluate-measure.ts";
  import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
  import {
    setSchedulerEnabled,
    runTick,
    getSchedulerStatusFromStores,
    SCHEDULER_CRON,
  } from "./scheduler.ts";

  const dbPath = join(tmpdir(), `workwell-sched-${crypto.randomUUID()}.sqlite`);
  let stores: Stores;

  // Minimal mock engine — returns COMPLIANT without running CQL (tests shouldn't hit the engine).
  const mockEngine: EvaluateMeasureBinding = {
    evaluate: async () => ({ outcome: "COMPLIANT", evidence: { expressionResults: [] } }),
  };

  // Use a single employee so the ALL_PROGRAMS tick is fast in tests.
  const oneEmployee = [EMPLOYEES[0]!];

  before(async () => {
    // @ts-expect-error — createSqliteD1 is untyped
    const db = await createSqliteD1(dbPath);
    await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
    await migrateFloorSchema(db);
    const events = new SqliteCaseEventStore(db);
    stores = {
      runs: new SqliteRunStore(db),
      outcomes: new SqliteOutcomeStore(db),
      cases: new SqliteCaseStore(db),
      events,
      measures: new SqliteMeasureStore(db),
      evidence: new SqliteEvidenceStore(db),
      appointments: new SqliteAppointmentStore(db),
      valueSets: new SqliteValueSetStore(db),
      outreachTemplates: new SqliteOutreachTemplateStore(db),
      waivers: new SqliteWaiverStore(db),
      segments: new SqliteSegmentStore(db),
      campaigns: new AuditBackedCampaignStore(events),
    };
  });

  after(() => {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  });

  test("runTick returns false and fires no run when scheduler is disabled", async () => {
    setSchedulerEnabled(false);
    const fired = await runTick({ stores, engine: mockEngine, segments: [], employees: oneEmployee });
    assert.equal(fired, false);
    const runs = await stores.runs.listRuns(10);
    assert.equal(runs.filter((r) => r.triggeredBy === "scheduler").length, 0, "no scheduler run created");
  });

  test("runTick fires a run and writes SCHEDULER_RUN_TRIGGERED audit when enabled with no prior run", async () => {
    setSchedulerEnabled(true);
    const fired = await runTick({ stores, engine: mockEngine, segments: [], employees: oneEmployee });
    assert.equal(fired, true);

    // Audit event written
    const events = await stores.events.recentAuditEvents(20);
    assert.ok(
      events.some((e) => e.eventType === "SCHEDULER_RUN_TRIGGERED"),
      "SCHEDULER_RUN_TRIGGERED audit event must be present",
    );

    // Run created with correct triggeredBy
    const runs = await stores.runs.listRuns(10);
    const schedulerRuns = runs.filter((r) => r.triggeredBy === "scheduler");
    assert.equal(schedulerRuns.length, 1, "exactly one scheduler run");
    assert.equal(schedulerRuns[0]!.scopeType, "ALL_PROGRAMS");
  });

  test("runTick skips a second consecutive call (< 23.5 h since last run)", async () => {
    setSchedulerEnabled(true);
    // The previous test just fired one — a second immediate call must skip.
    const fired = await runTick({ stores, engine: mockEngine, segments: [], employees: oneEmployee });
    assert.equal(fired, false, "should not fire again immediately after the first run");
    const runs = await stores.runs.listRuns(10);
    assert.equal(
      runs.filter((r) => r.triggeredBy === "scheduler").length,
      1,
      "still only one scheduler run",
    );
  });

  test("getSchedulerStatusFromStores reflects enabled + lastRunAt + correct cron", async () => {
    setSchedulerEnabled(true);
    const status = await getSchedulerStatusFromStores(stores);
    assert.equal(status.enabled, true);
    assert.equal(status.cron, SCHEDULER_CRON);
    assert.ok(typeof status.lastRunAt === "string", "lastRunAt must be a string (from the run just fired)");
    assert.ok(typeof status.nextFireAt === "string", "nextFireAt computed when enabled");
    assert.ok(["COMPLETED", "PARTIAL_FAILURE", "RUNNING"].includes(status.lastRunStatus), "lastRunStatus is a terminal or running value");
  });

  test("getSchedulerStatusFromStores returns null nextFireAt when disabled", async () => {
    setSchedulerEnabled(false);
    const status = await getSchedulerStatusFromStores(stores);
    assert.equal(status.enabled, false);
    assert.equal(status.nextFireAt, null, "nextFireAt must be null when disabled");
  });
  ```

- [ ] **Step 3.2: Run the test to see it fail (TDD red)**

  ```bash
  cd backend-ts
  node --import tsx --test src/admin/scheduler.test.ts
  ```

  Expected: file not importable (scheduler.ts exists after Task 2, so tests should actually run — if you did Task 2 first). On first run, tests should PASS if the implementation is correct.

- [ ] **Step 3.3: Fix any test failures**

  Common failures:
  - Import path errors → verify paths in `@ts-expect-error` lines match actual file locations.
  - `migrateFloorSchema` not exported → check `backend-ts/src/stores/sqlite/schema.ts` exports; if not exported, remove that call (the base DDL is sufficient for tests).
  - `recentAuditEvents` not available → check `CaseEventStore` interface for the exact method name.

- [ ] **Step 3.4: Typecheck and confirm all tests pass**

  ```bash
  pnpm typecheck && node --import tsx --test src/admin/scheduler.test.ts
  ```

  Expected: zero typecheck errors, 5 tests PASS.

- [ ] **Step 3.5: Commit**

  ```bash
  git add backend-ts/src/admin/scheduler.ts backend-ts/src/admin/scheduler.test.ts
  git commit -m "feat(scheduler): add scheduler module with runTick + getSchedulerStatus + tests (E13 PR-3)"
  ```

---

## Task 4: Remove in-memory scheduler stub from `admin-data.ts`

**Files:**
- Modify: `backend-ts/src/admin/admin-data.ts:64-78`

- [ ] **Step 4.1: Delete the in-memory scheduler section**

  Open `backend-ts/src/admin/admin-data.ts`. Delete lines 64–78 (the entire block from the comment `// ---- scheduler` through `export function setSchedulerEnabled`):

  ```
  // ---- scheduler (in-process toggle; resets on restart — demo settings) --------
  export interface SchedulerStatus {
    enabled: boolean;
    cron: string;
    nextFireAt: string | null;
    lastRunAt: string | null;
    lastRunStatus: string;
  }
  let schedulerEnabled = false;
  const CRON = "0 0 6 * * *";
  export const schedulerStatus = (): SchedulerStatus => ({ enabled: schedulerEnabled, cron: CRON, nextFireAt: null, lastRunAt: null, lastRunStatus: "unknown" });
  export function setSchedulerEnabled(enabled: boolean): SchedulerStatus {
    schedulerEnabled = enabled;
    return schedulerStatus();
  }
  ```

  After deletion, the line that follows should be the comment `// Terminology mappings moved to value-set governance...`.

- [ ] **Step 4.2: Typecheck**

  ```bash
  pnpm typecheck
  ```

  Expected: errors in `routes/admin.ts` about missing `schedulerStatus`/`setSchedulerEnabled` imports — that's correct; Task 5 fixes them.

---

## Task 5: Wire scheduler routes in `routes/admin.ts`

**Files:**
- Modify: `backend-ts/src/routes/admin.ts`

- [ ] **Step 5.1: Replace the import of the old in-memory functions**

  Open `backend-ts/src/routes/admin.ts`. Find the import at the top:

  ```typescript
  import {
    listIntegrations,
    syncIntegration,
    schedulerStatus,
    setSchedulerEnabled,
    listDataMappings,
    validateDataMappings,
    toAdminAuditRows,
    toDeliveryLog,
  } from "../admin/admin-data.ts";
  ```

  Replace it with:

  ```typescript
  import {
    listIntegrations,
    syncIntegration,
    listDataMappings,
    validateDataMappings,
    toAdminAuditRows,
    toDeliveryLog,
  } from "../admin/admin-data.ts";
  import { getSchedulerStatus, setSchedulerEnabled } from "../admin/scheduler.ts";
  ```

- [ ] **Step 5.2: Update the two scheduler route handlers**

  Find lines 109–113:

  ```typescript
  // ---- scheduler -----------------------------------------------------------
  if (pathname === "/api/admin/scheduler" && req.method === "GET") return json(schedulerStatus());
  if (pathname === "/api/admin/scheduler" && req.method === "POST") {
    return json(setSchedulerEnabled((q.get("enabled") ?? "false").toLowerCase() === "true"));
  }
  ```

  Replace with:

  ```typescript
  // ---- scheduler (DB-backed via scheduler.ts — E13 PR-3) -------------------
  if (pathname === "/api/admin/scheduler" && req.method === "GET") {
    return json(await getSchedulerStatus(env));
  }
  if (pathname === "/api/admin/scheduler" && req.method === "POST") {
    setSchedulerEnabled((q.get("enabled") ?? "false").toLowerCase() === "true");
    return json(await getSchedulerStatus(env));
  }
  ```

- [ ] **Step 5.3: Typecheck**

  ```bash
  pnpm typecheck
  ```

  Expected: zero errors.

- [ ] **Step 5.4: Run the full test suite to catch any regressions**

  ```bash
  pnpm test
  ```

  Expected: all tests pass (same count as before + 5 new scheduler tests).

- [ ] **Step 5.5: Commit**

  ```bash
  git add backend-ts/src/admin/admin-data.ts backend-ts/src/routes/admin.ts
  git commit -m "feat(scheduler): wire /api/admin/scheduler to DB-backed scheduler module (E13 PR-3)"
  ```

---

## Task 6: Add `setInterval` tick to `server.ts`

**Files:**
- Modify: `backend-ts/src/server.ts`

- [ ] **Step 6.1: Add the scheduler tick after `startLocalHost`**

  Open `backend-ts/src/server.ts`. After the line:

  ```typescript
  console.log(`[workwell] backend-ts host listening on :${host.port} (target=${target})`);
  ```

  Add the following block (before the `let stopping = false;` line):

  ```typescript
  // Scheduled recompute (E13 PR-3) — fires ALL_PROGRAMS runs on a 24-h interval.
  // Enabled via WORKWELL_SCHEDULER_ENABLED=true; disabled by default (matches the
  // simulated-by-default pattern for optional demo features: email, outreach, etc.).
  // Only wires when DATABASE_URL is set (Postgres ceiling) — the SQLite floor has no
  // DATABASE_URL so the tick would have no DB binding. Local dev uses `pnpm dev`, not server.ts.
  const { initSchedulerFromEnv, schedulerTick } = await import("./admin/scheduler.ts");
  initSchedulerFromEnv(process.env as { WORKWELL_SCHEDULER_ENABLED?: string });
  let schedulerInterval: ReturnType<typeof setInterval> | undefined;
  if ((process.env.DATABASE_URL ?? "").trim()) {
    const schedulerEnv = { DATABASE_URL: process.env.DATABASE_URL };
    const TICK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min
    schedulerInterval = setInterval(() => {
      schedulerTick(schedulerEnv).catch((err: unknown) =>
        console.error("[scheduler] tick error:", err),
      );
    }, TICK_INTERVAL_MS);
    console.log(`[scheduler] tick started — interval=${TICK_INTERVAL_MS / 60_000}m, enabled=${process.env.WORKWELL_SCHEDULER_ENABLED ?? "false"}`);
  }
  ```

- [ ] **Step 6.2: Clear the interval in the `shutdown` handler**

  Find the existing `shutdown` function:

  ```typescript
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[workwell] ${signal} received — draining for up to ${shutdownGraceMs}ms, then exiting`);
    host.stop();
    setTimeout(() => process.exit(0), shutdownGraceMs);
  };
  ```

  Replace it with (adds `clearInterval` before `host.stop()`):

  ```typescript
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[workwell] ${signal} received — draining for up to ${shutdownGraceMs}ms, then exiting`);
    clearInterval(schedulerInterval);
    host.stop();
    setTimeout(() => process.exit(0), shutdownGraceMs);
  };
  ```

- [ ] **Step 6.3: Typecheck**

  ```bash
  pnpm typecheck
  ```

  Expected: zero errors. If `process.env` type errors appear because `StoresEnv` requires `DB?: CloudDatabase`, cast as `StoresEnv`: `const schedulerEnv: StoresEnv = { DATABASE_URL: process.env.DATABASE_URL };`.

- [ ] **Step 6.4: Smoke-test the server boots without errors (optional — skip if no local Postgres)**

  If you have a local Postgres or `pnpm dev` available:

  ```bash
  pnpm dev
  # Observe log output: "[scheduler] tick started — interval=5m, enabled=false"
  # No errors expected.
  # Ctrl-C to stop.
  ```

- [ ] **Step 6.5: Commit**

  ```bash
  git add backend-ts/src/server.ts
  git commit -m "feat(scheduler): start in-process 5-min tick in server.ts; clear on shutdown (E13 PR-3)"
  ```

---

## Task 7: Verify, docs, and final commit

**Files:**
- Run: full test suite + typecheck
- Modify: `docs/JOURNAL.md`

- [ ] **Step 7.1: Run full typecheck + test suite**

  ```bash
  cd backend-ts
  pnpm typecheck && pnpm test
  ```

  Expected:
  - 0 typecheck errors
  - All existing tests pass + 5 new scheduler tests pass
  - Total test count increases by 5

- [ ] **Step 7.2: Manually verify the scheduler endpoint**

  Start the backend locally (`pnpm dev`) and curl the scheduler endpoint:

  ```bash
  # Get current status (requires auth — use admin credentials)
  curl -s http://localhost:8080/api/admin/scheduler \
    -H "Authorization: Bearer <token>" | jq .
  # Expected shape:
  # { "enabled": false, "cron": "0 0 6 * * *", "nextFireAt": null, "lastRunAt": null, "lastRunStatus": "unknown" }

  # Enable the scheduler
  curl -s -X POST "http://localhost:8080/api/admin/scheduler?enabled=true" \
    -H "Authorization: Bearer <token>" | jq .
  # Expected: { "enabled": true, "nextFireAt": "<tomorrow 6 AM UTC>", ... }

  # Disable
  curl -s -X POST "http://localhost:8080/api/admin/scheduler?enabled=false" \
    -H "Authorization: Bearer <token>" | jq .
  # Expected: { "enabled": false, "nextFireAt": null, ... }
  ```

- [ ] **Step 7.3: Add JOURNAL.md entry**

  Open `docs/JOURNAL.md`. Prepend a new dated entry (2026-06-29 or today's date) at the top, ABOVE any existing entries:

  ```markdown
  ## 2026-06-29 — E13 PR-3: Scheduled Recompute

  **Goal:** Wire the inert `/api/admin/scheduler` to fire real, audited `ALL_PROGRAMS` runs.

  **Approach:**
  - New `backend-ts/src/admin/scheduler.ts` owns all scheduling logic: `runTick()` checks the
    `runs` table for the last `triggered_by='scheduler'` run, skips if < 23.5 h ago, else writes
    `SCHEDULER_RUN_TRIGGERED` audit event and fires `planManualRun` + `finishOrFail`.
  - `schedulerEnabled` is in-memory (boot-time default from `WORKWELL_SCHEDULER_ENABLED` env var;
    toggled via POST /api/admin/scheduler). Resets on restart — same pattern as email/outreach
    simulated-by-default.
  - `server.ts` starts a 5-min `setInterval` calling `schedulerTick(env)` (Postgres ceiling only;
    clears on SIGTERM/SIGINT).
  - `GET /api/admin/scheduler` now returns real `lastRunAt`/`lastRunStatus` from the DB + computed
    `nextFireAt`.
  - `triggerTypeOf` extended: `scheduler` → SCHEDULED, `seed:scale` → SEED (fixing a gap).
  - 5 new unit tests in `scheduler.test.ts`.

  **Audit trail:** Every scheduled run starts with a `SCHEDULER_RUN_TRIGGERED` event (actor=`scheduler`);
  the run itself carries `triggered_by='scheduler'` and shows as SCHEDULED in the `/runs` list.

  **No schema changes.** Reversible by setting `WORKWELL_SCHEDULER_ENABLED=false` (default).
  ```

- [ ] **Step 7.4: Final commit**

  ```bash
  git add docs/JOURNAL.md
  git commit -m "docs(journal): E13 PR-3 scheduled recompute entry"
  ```

---

## Self-Review

**Spec coverage check:**
- ✅ Wire `/api/admin/scheduler` to fire actual ALL_PROGRAMS runs → `runTick` + `planManualRun` + `finishOrFail`
- ✅ Runs are audited → `SCHEDULER_RUN_TRIGGERED` written BEFORE `planManualRun` (audit invariant)
- ✅ Mirrors the self-heal reconciler pattern → recurring background process, errors logged not thrown, never blocks the request path
- ✅ Real `lastRunAt`/`lastRunStatus` in GET response → queried from `runs` table
- ✅ Runs show as SCHEDULED in the run list → `triggerTypeOf` updated
- ✅ No schema changes → uses existing `runs` + `audit_events` tables
- ✅ Reversible → disabled by default; clearing `WORKWELL_SCHEDULER_ENABLED` reverts

**Placeholder scan:** None found — all code blocks are complete and exact.

**Type consistency check:**
- `SchedulerStatus` defined once in `scheduler.ts`, used in both `getSchedulerStatus` and `getSchedulerStatusFromStores`
- `SchedulerTickDeps` defined once, used in `runTick` and in the test file
- `appendAudit` called with all required fields (`refRunId: null`, `refCaseId: null`, `refMeasureVersionId: null`)
- `StoresEnv` from factory used consistently in `schedulerTick` and route handler signatures
