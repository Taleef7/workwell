# E13 PR-2 — Population-scale tenant (120k) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Prove the multi-tenant rollup scales to a ~120k-subject tenant on the live stack via generated outcomes seeded once on-demand, hierarchy encoded in `subject_id`, and SQL `GROUP BY` aggregation so app memory stays bounded.

**Architecture:** A new `mhn` tenant whose 120k subjects exist only as `outcomes` rows keyed by an encoded `subject_id` (`mhn|L07|P03|000123`). A `seed:scale` CLI writes them (per-measure COMPLETED runs, generated statuses, audited). A new `aggregateScaleRun(runId)` store method does the Postgres `GROUP BY split_part(...)`; the hierarchy rollup + programs KPIs build the scale subtree/counts from it (provider-leaf; no 120k patient nodes) and exclude `seed:scale` runs from the existing in-memory path. No DDL, no new deps. Spec: `docs/superpowers/specs/2026-06-26-e13-population-scale-design.md`.

**Tech Stack:** TypeScript (`backend-ts`, node:test + tsx), Postgres ceiling + SQLite floor, Next.js frontend (no change needed beyond PR-1).

---

## File structure

- `backend-ts/src/engine/synthetic/scale-structure.ts` — **create**: `mhn` tenant structure (locations/providers) + `subject_id` codec.
- `backend-ts/src/engine/synthetic/scale-structure.test.ts` — **create**.
- `backend-ts/src/engine/synthetic/employee-catalog.ts` — **modify**: register `mhn` in `TENANTS` + `ENTERPRISES`.
- `backend-ts/src/stores/outcome-store.ts` — **modify**: add `aggregateScaleRun` + `ScaleGroupCount` to the port.
- `backend-ts/src/stores/postgres/outcome-store-postgres.ts` — **modify**: Pg `GROUP BY split_part` impl.
- `backend-ts/src/stores/sqlite/outcome-store-sqlite.ts` — **modify**: floor impl (bounded JS group).
- `backend-ts/src/stores/sqlite/outcome-store-scale.test.ts` — **create**: floor aggregation test.
- `backend-ts/src/run/backfill-scale.ts` — **create**: the generated-outcome scale seeder.
- `backend-ts/src/run/backfill-scale.test.ts` — **create**.
- `backend-ts/src/run/cli/seed-scale.ts` + `seed-scale-bin.ts` — **create**: the CLI.
- `backend-ts/src/run/cli/seed-scale.test.ts` — **create**.
- `backend-ts/package.json` — **modify**: add `seed:scale` script.
- `backend-ts/src/program/scale-rollup.ts` — **create**: build the scale-tenant subtree from `aggregateScaleRun`.
- `backend-ts/src/program/scale-rollup.test.ts` — **create**.
- `backend-ts/src/program/hierarchy-rollup.ts` — **modify**: exclude scale runs from the in-memory path; merge the scale subtree.
- `backend-ts/src/program/hierarchy-rollup.test.ts` — **modify**: scale-merge + reconciliation tests.
- `backend-ts/src/program/program-read-models.ts` — **modify**: exclude scale runs; add scale KPI counts.
- `backend-ts/src/program/program-read-models.scale.test.ts` (or extend `routes/programs.test.ts`) — **create/modify**.
- Docs — `ARCHITECTURE.md`, `DATA_MODEL.md`, `DEPLOY.md`, `DECISIONS.md` (ADR), `JOURNAL.md`, `CLAUDE.md`, `README.md`.

> Run backend tests with `corepack pnpm@10 exec tsx --test <file>` and the suite with `corepack pnpm@10 test` (this environment has no bare `pnpm`).

---

## Task 1: Scale structure + subject_id codec

**Files:** Create `backend-ts/src/engine/synthetic/scale-structure.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test** — `scale-structure.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCALE_TENANT, SCALE_LOCATIONS, scaleProvidersFor, encodeScaleSubject, decodeScaleSubject, isScaleSubject,
} from "./scale-structure.ts";

test("scale tenant + structure are deterministic and sized", () => {
  assert.equal(SCALE_TENANT.id, "mhn");
  assert.equal(SCALE_LOCATIONS.length, 24);
  for (const loc of SCALE_LOCATIONS) assert.equal(scaleProvidersFor(loc.id).length, 10);
});

test("codec round-trips and identifies scale subjects", () => {
  const id = encodeScaleSubject(7, 3, 123);
  assert.equal(id, "mhn|L07|P03|0000123");
  assert.ok(isScaleSubject(id));
  assert.ok(!isScaleSubject("emp-006"));
  const d = decodeScaleSubject(id);
  assert.deepEqual(d, { tenantId: "mhn", locationId: "L07", providerId: "P03", n: 123 });
  assert.equal(decodeScaleSubject("emp-006"), null);
});

test("location/provider ids match the codec's L../P.. format", () => {
  assert.ok(SCALE_LOCATIONS.every((l) => /^L\d\d$/.test(l.id)));
  assert.ok(scaleProvidersFor("L00").every((p) => /^P\d\d$/.test(p.id)));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/engine/synthetic/scale-structure.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `scale-structure.ts`:

```ts
/**
 * Population-scale tenant structure + subject_id codec (#185 E13 PR-2). The "MetroHealth Network"
 * (mhn) tenant's 120k subjects do NOT live in the in-memory directory — they exist only as outcome
 * rows whose subject_id encodes their place in the hierarchy. This module holds the SMALL structure
 * (24 locations × 10 providers = 240 provider nodes) used to NAME rollup nodes, plus the codec that
 * the scale seed writes and the SQL aggregation reads. No employees here.
 */
import type { Tenant } from "./employee-catalog.ts";

export const SCALE_TENANT: Tenant = { id: "mhn", name: "MetroHealth Network" };

export interface ScaleLocation { id: string; name: string; }
export interface ScaleProvider { id: string; name: string; locationId: string; }

const LOCATION_COUNT = 24;
const PROVIDERS_PER_LOCATION = 10;
const pad2 = (n: number): string => String(n).padStart(2, "0");

export const SCALE_LOCATIONS: readonly ScaleLocation[] = Array.from({ length: LOCATION_COUNT }, (_, i) => ({
  id: `L${pad2(i)}`,
  name: `MetroHealth Region ${i + 1}`,
}));

const PROVIDERS_BY_LOC = new Map<string, ScaleProvider[]>();
for (let li = 0; li < LOCATION_COUNT; li++) {
  const locId = `L${pad2(li)}`;
  PROVIDERS_BY_LOC.set(
    locId,
    Array.from({ length: PROVIDERS_PER_LOCATION }, (_, pi) => ({
      id: `P${pad2(pi)}`,
      name: `Clinic ${li + 1}-${pi + 1}`,
      locationId: locId,
    })),
  );
}

/** Providers serving a scale location (sorted by id); [] for an unknown location. */
export function scaleProvidersFor(locationId: string): ScaleProvider[] {
  return PROVIDERS_BY_LOC.get(locationId) ?? [];
}

/** Encode a scale subject id: `mhn|L07|P03|0000123`. */
export function encodeScaleSubject(locIdx: number, provIdx: number, n: number): string {
  return `${SCALE_TENANT.id}|L${pad2(locIdx)}|P${pad2(provIdx)}|${String(n).padStart(7, "0")}`;
}

export interface DecodedScaleSubject { tenantId: string; locationId: string; providerId: string; n: number; }

/** Decode a scale subject id; null when it isn't one. */
export function decodeScaleSubject(subjectId: string): DecodedScaleSubject | null {
  const parts = subjectId.split("|");
  if (parts.length !== 4 || parts[0] !== SCALE_TENANT.id) return null;
  const n = Number(parts[3]);
  if (!Number.isFinite(n)) return null;
  return { tenantId: parts[0]!, locationId: parts[1]!, providerId: parts[2]!, n };
}

export const isScaleSubject = (subjectId: string): boolean => subjectId.startsWith(`${SCALE_TENANT.id}|`);
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/engine/synthetic/scale-structure.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register `mhn` in the directory** — edit `employee-catalog.ts`:

In `TENANTS` add a third entry:
```ts
  { id: "mhn", name: "MetroHealth Network" },
```
In `ENTERPRISES` add:
```ts
  { id: "mhn", name: "MetroHealth Network", tenantId: "mhn" },
```

- [ ] **Step 6: Run the catalog test + typecheck**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/engine/synthetic/employee-catalog.test.ts && corepack pnpm@10 typecheck`
Expected: PASS. (The catalog test asserts `TENANTS` ids include `mhn` now — update its `["ihn","twh"]` assertion to include `"mhn"`: change to `["ihn","mhn","twh"]` and the count check accordingly.)

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/engine/synthetic/scale-structure.ts backend-ts/src/engine/synthetic/scale-structure.test.ts backend-ts/src/engine/synthetic/employee-catalog.ts backend-ts/src/engine/synthetic/employee-catalog.test.ts
git commit -m "feat(e13): scale tenant structure (mhn) + subject_id codec"
```

---

## Task 2: `aggregateScaleRun` store method (port + Pg + floor)

**Files:** Modify `outcome-store.ts`, `outcome-store-postgres.ts`, `outcome-store-sqlite.ts`; create `outcome-store-scale.test.ts`.

- [ ] **Step 1: Add the type + port method** to `outcome-store.ts`:

```ts
/** A grouped count from a scale run: outcomes per (location, provider, status). The SQL aggregation
 *  returns O(locations×providers×statuses) rows — never O(subjects) — so app memory stays bounded. */
export interface ScaleGroupCount {
  locationId: string;
  providerId: string;
  status: string;
  count: number;
}
```
Add to the `OutcomeStore` interface:
```ts
  /**
   * Aggregate a population-scale run's outcomes by (location, provider, status), parsing the encoded
   * subject_id (`mhn|Lxx|Pxx|n`) — a single GROUP BY that never materializes the per-subject rows.
   * Used by the hierarchy rollup + programs KPIs for the scale tenant (#185 E13 PR-2).
   */
  aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]>;
```

- [ ] **Step 2: Write the failing floor test** — `outcome-store-scale.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "./schema.ts";
import { SqliteRunStore } from "./run-store-sqlite.ts";
import { SqliteOutcomeStore } from "./outcome-store-sqlite.ts";
import { encodeScaleSubject } from "../../engine/synthetic/scale-structure.ts";

const dbPath = join(tmpdir(), `workwell-scale-${crypto.randomUUID()}.sqlite`);
let outcomes: SqliteOutcomeStore;
let runId: string;

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runs = new SqliteRunStore(db);
  outcomes = new SqliteOutcomeStore(db);
  const run = await runs.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "seed:scale", status: "COMPLETED",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  runId = run.id;
  // L00/P00: 2 COMPLIANT, 1 OVERDUE; L00/P01: 1 COMPLIANT
  await outcomes.recordOutcomes([
    { runId, subjectId: encodeScaleSubject(0, 0, 1), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: encodeScaleSubject(0, 0, 2), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
    { runId, subjectId: encodeScaleSubject(0, 0, 3), measureId: "audiogram", status: "OVERDUE", evidence: {} },
    { runId, subjectId: encodeScaleSubject(0, 1, 4), measureId: "audiogram", status: "COMPLIANT", evidence: {} },
  ]);
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("aggregateScaleRun groups by location/provider/status", async () => {
  const groups = await outcomes.aggregateScaleRun(runId);
  const key = (g: { locationId: string; providerId: string; status: string }) => `${g.locationId}/${g.providerId}/${g.status}`;
  const byKey = new Map(groups.map((g) => [key(g), g.count]));
  assert.equal(byKey.get("L00/P00/COMPLIANT"), 2);
  assert.equal(byKey.get("L00/P00/OVERDUE"), 1);
  assert.equal(byKey.get("L00/P01/COMPLIANT"), 1);
  // bounded: 2 provider×status groups for P00 + 1 for P01 = 3 rows, not 4 subject rows
  assert.equal(groups.length, 3);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/stores/sqlite/outcome-store-scale.test.ts`
Expected: FAIL (`aggregateScaleRun` not implemented).

- [ ] **Step 4: Implement the floor** — in `outcome-store-sqlite.ts` add (imports: none new; parse in JS since SQLite lacks `split_part`):

```ts
  async aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]> {
    // The floor only runs small-N tests, so reading the run's rows and grouping in JS is fine.
    // (The Postgres ceiling does the real GROUP BY for the 120k case.)
    const { results } = await this.db
      .prepare(`SELECT subject_id, status FROM outcomes WHERE run_id = ?`)
      .bind(runId)
      .all<{ subject_id: string; status: string }>();
    const counts = new Map<string, ScaleGroupCount>();
    for (const r of results ?? []) {
      const parts = r.subject_id.split("|");
      if (parts.length !== 4) continue; // not a scale subject
      const locationId = parts[1]!, providerId = parts[2]!;
      const k = `${locationId}|${providerId}|${r.status}`;
      const g = counts.get(k);
      if (g) g.count++;
      else counts.set(k, { locationId, providerId, status: r.status, count: 1 });
    }
    return [...counts.values()];
  }
```
(Use the same `.prepare().bind().all()` result-shape the file already uses — check whether it destructures `{ results }` or `{ rows }`; match the existing `listOutcomes` method in this file. Add `import type { ScaleGroupCount } from "../outcome-store.ts";`.)

- [ ] **Step 5: Implement the ceiling** — in `outcome-store-postgres.ts` add (mirrors the `pool.query` idiom; `SPIKE_SCHEMA` is already imported):

```ts
  async aggregateScaleRun(runId: string): Promise<ScaleGroupCount[]> {
    const { rows } = await this.pool.query<{ location_id: string; provider_id: string; status: string; count: string }>(
      `SELECT split_part(subject_id, '|', 2) AS location_id,
              split_part(subject_id, '|', 3) AS provider_id,
              status, COUNT(*)::text AS count
         FROM ${SPIKE_SCHEMA}.outcomes
        WHERE run_id = $1 AND subject_id LIKE 'mhn|%'
        GROUP BY 1, 2, 3`,
      [runId],
    );
    return rows.map((r) => ({ locationId: r.location_id, providerId: r.provider_id, status: r.status, count: Number(r.count) }));
  }
```
(Add `import type { ScaleGroupCount } from "../outcome-store.ts";`.)

- [ ] **Step 6: Run the floor test + typecheck**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/stores/sqlite/outcome-store-scale.test.ts && corepack pnpm@10 typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/stores/outcome-store.ts backend-ts/src/stores/postgres/outcome-store-postgres.ts backend-ts/src/stores/sqlite/outcome-store-sqlite.ts backend-ts/src/stores/sqlite/outcome-store-scale.test.ts
git commit -m "feat(e13): aggregateScaleRun — bounded SQL GROUP BY over encoded subject_id"
```

---

## Task 3: Scale-seed backfill (generated outcomes)

**Files:** Create `backend-ts/src/run/backfill-scale.ts` + `.test.ts`.

- [ ] **Step 1: Write the failing test** — `backfill-scale.test.ts` (floor; seed a small N, assert runs+outcomes+audit + bounded aggregation):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
// @ts-expect-error — @mieweb/cloud-local ships .mjs without types
import { createSqliteD1 } from "@mieweb/cloud-local";
import { RUN_STORE_FLOOR_DDL } from "../stores/sqlite/schema.ts";
import { SqliteRunStore } from "../stores/sqlite/run-store-sqlite.ts";
import { SqliteOutcomeStore } from "../stores/sqlite/outcome-store-sqlite.ts";
import { SqliteCaseEventStore } from "../stores/sqlite/case-event-store-sqlite.ts";
import { backfillScalePopulation, SCALE_TRIGGER } from "./backfill-scale.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";

async function fresh() {
  const dbPath = join(tmpdir(), `workwell-bscale-${crypto.randomUUID()}.sqlite`);
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  return { dbPath, runs: new SqliteRunStore(db), outcomes: new SqliteOutcomeStore(db), events: new SqliteCaseEventStore(db) };
}

test("backfillScalePopulation writes one run + N outcomes per runnable measure, audited + idempotent", async () => {
  const { dbPath, runs, outcomes, events } = await fresh();
  try {
    const deps = { runStore: runs, outcomeStore: outcomes, auditStore: events };
    const r1 = await backfillScalePopulation(deps, { subjects: 240, asOf: "2026-06-26" });
    const measures = Object.keys(MEASURES).length;
    assert.equal(r1.runsCreated, measures, "one run per runnable measure");
    assert.equal(r1.outcomesCreated, measures * 240);
    // idempotent: a second run is a no-op
    const r2 = await backfillScalePopulation(deps, { subjects: 240, asOf: "2026-06-26" });
    assert.equal(r2.skipped, true);
    // audited
    const audits = await events.listAuditEvents({ limit: 1000 });
    assert.ok(audits.some((a) => a.eventType === "SCALE_POPULATION_SEEDED"));
    // bounded aggregation over a scale run (240 subjects → ≤ 240 provider×status groups)
    const all = await runs.listRuns(1000);
    const scaleRun = all.find((x) => x.triggeredBy === SCALE_TRIGGER)!;
    const groups = await outcomes.aggregateScaleRun(scaleRun.id);
    assert.ok(groups.length <= 24 * 10 * 5, "bounded group count");
    assert.equal(groups.reduce((s, g) => s + g.count, 0), 240, "groups sum to the subject count");
  } finally {
    try { rmSync(dbPath, { force: true }); } catch { /* best effort */ }
  }
});
```
(Check the exact `listAuditEvents` method name/shape on `CaseEventStore` and match it; if it differs, adjust the audit assertion accordingly.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/run/backfill-scale.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** — `backfill-scale.ts` (model on `backfill-trend-history.ts`):

```ts
/**
 * Generated population-scale backfill (#185 E13 PR-2). Writes the mhn ("MetroHealth Network") tenant's
 * ~120k subjects as OUTCOME rows (one COMPLETED MEASURE run per runnable measure, subject_id-encoded,
 * minimal evidence) so the rollup can aggregate 120k in SQL without live CQL evaluation. Deterministic,
 * idempotent (skips if a seed:scale run already exists), audited (SCALE_POPULATION_SEEDED). Owner-run
 * on-demand via the seed:scale CLI — NOT on deploy. Reversible: delete seed:scale outcomes then runs.
 */
import type { RunStore } from "../stores/run-store.ts";
import type { OutcomeStore, RecordOutcomeInput } from "../stores/outcome-store.ts";
import type { CaseEventStore } from "../stores/case-event-store.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { complianceRate } from "./compliance-rates.ts";
import { encodeScaleSubject, SCALE_LOCATIONS, scaleProvidersFor } from "../engine/synthetic/scale-structure.ts";
import { outcomeForTarget } from "./backfill-trend-history.ts"; // reuse the measure→target→status map if exported; else inline (see note)

export const SCALE_TRIGGER = "seed:scale";
export const SCALE_POPULATION_SEEDED_EVENT = "SCALE_POPULATION_SEEDED";
const DAY_MS = 86_400_000;
const STATUSES = ["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED"] as const;

export interface ScaleBackfillDeps {
  runStore: RunStore;
  outcomeStore: OutcomeStore;
  auditStore: CaseEventStore;
}
export interface ScaleBackfillArgs { subjects: number; asOf: string; }
export interface ScaleBackfillSummary { skipped: boolean; runsCreated: number; outcomesCreated: number; subjects: number; }

/** Deterministic status for subject index i at compliance `rate` — round(rate*N) compliant, then a
 *  fixed split of the remainder across the other four buckets (no randomness; stable across runs). */
function statusForIndex(i: number, n: number, rate: number): string {
  const compliant = Math.round(n * rate);
  if (i < compliant) return "COMPLIANT";
  const rest = i - compliant;
  // cycle the 4 non-compliant buckets deterministically
  const order = ["OVERDUE", "DUE_SOON", "MISSING_DATA", "EXCLUDED"] as const;
  return order[rest % order.length]!;
}

export async function backfillScalePopulation(deps: ScaleBackfillDeps, args: ScaleBackfillArgs): Promise<ScaleBackfillSummary> {
  const measureIds = Object.keys(MEASURES);
  // Idempotent: if any seed:scale run already exists, no-op (a rerun must not double-write 120k rows).
  const existing = (await deps.runStore.listRuns(100_000)).some((r) => r.triggeredBy === SCALE_TRIGGER);
  if (existing) return { skipped: true, runsCreated: 0, outcomesCreated: 0, subjects: args.subjects };

  const providers = SCALE_LOCATIONS.flatMap((loc, li) =>
    scaleProvidersFor(loc.id).map((_, pi) => ({ li, pi })),
  ); // 240 (location,provider) index pairs
  const startedMs = new Date(`${args.asOf}T00:00:00.000Z`).getTime();
  const startedAt = new Date(startedMs).toISOString();
  const completedAt = new Date(startedMs + 60_000).toISOString();
  const periodEnd = new Date(startedMs).toISOString();
  const periodStart = new Date(startedMs - 365 * DAY_MS).toISOString();

  let runsCreated = 0, outcomesCreated = 0;
  for (const measureId of measureIds) {
    const run = await deps.runStore.createRun({
      scopeType: "MEASURE", scopeId: measureId, triggeredBy: SCALE_TRIGGER, status: "COMPLETED",
      startedAt, completedAt,
      requestedScope: { measureId, evaluationDate: args.asOf, scalePopulation: true },
      measurementPeriodStart: periodStart, measurementPeriodEnd: periodEnd,
    });
    const rate = complianceRate(MEASURE_BINDINGS[measureId]!.rateKey);
    const inputs: RecordOutcomeInput[] = Array.from({ length: args.subjects }, (_, i) => {
      const { li, pi } = providers[i % providers.length]!;
      return {
        runId: run.id,
        subjectId: encodeScaleSubject(li, pi, i),
        measureId,
        evaluationPeriod: args.asOf,
        status: statusForIndex(i, args.subjects, rate),
        evaluatedAt: completedAt,
        evidence: { scale: true }, // minimal — generated rows need no expressionResults
      };
    });
    // chunk the batch insert so a single multi-row INSERT stays within Postgres parameter limits
    const CHUNK = 5_000;
    for (let off = 0; off < inputs.length; off += CHUNK) {
      await deps.outcomeStore.recordOutcomes(inputs.slice(off, off + CHUNK));
    }
    runsCreated++;
    outcomesCreated += inputs.length;
    await deps.auditStore.appendAudit({
      eventType: SCALE_POPULATION_SEEDED_EVENT, entityType: "run", entityId: run.id,
      actor: SCALE_TRIGGER, refRunId: run.id, refCaseId: null, refMeasureVersionId: null,
      payload: { measureId, subjects: args.subjects, asOf: args.asOf },
    });
  }
  return { skipped: false, runsCreated, outcomesCreated, subjects: args.subjects };
}
```
> NOTE on `outcomeForTarget`: if `backfill-trend-history.ts` does NOT export a reusable target→status map, drop that import and the `statusForIndex` cycle above (which emits canonical statuses directly) is self-contained — keep it. Verify `STATUSES` is unused and remove it if so. Verify `recordOutcomes` chunking isn't already done inside the Pg adapter (if it self-chunks, the CHUNK loop here is still safe/idempotent).

- [ ] **Step 4: Run to verify pass**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/run/backfill-scale.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/run/backfill-scale.ts backend-ts/src/run/backfill-scale.test.ts
git commit -m "feat(e13): generated population-scale backfill (per-measure runs, audited, idempotent)"
```

---

## Task 4: Scale-seed CLI

**Files:** Create `seed-scale.ts`, `seed-scale-bin.ts`, `seed-scale.test.ts`; modify `package.json`.

- [ ] **Step 1: Write the failing test** — `seed-scale.test.ts` (mirror `seed-trend-history.test.ts`; test `parseArgs` only — no DB):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, SeedCliUsageError } from "./seed-scale.ts";

test("parseArgs reads --subjects/--as-of and rejects bad input", () => {
  assert.deepEqual(parseArgs(["--subjects", "120000", "--as-of", "2026-06-26"]), { subjects: 120000, asOf: "2026-06-26" });
  assert.throws(() => parseArgs(["--subjects", "0"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--as-of", "nope"]), SeedCliUsageError);
  assert.throws(() => parseArgs(["--bogus"]), SeedCliUsageError);
});

test("defaults: no args → default subjects", () => {
  assert.equal(parseArgs([]).subjects ?? 120000, 120000);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/run/cli/seed-scale.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `seed-scale.ts`** (copy `seed-trend-history.ts` structure; swap the backfill + args):

```ts
/**
 * CLI: seed the generated population-scale tenant (mhn ~120k) — one COMPLETED MEASURE run per runnable
 * measure with subject_id-encoded generated outcomes, so the rollup + programs KPIs aggregate 120k in
 * SQL. Owner-run ON DEMAND, NOT on deploy. Local (SQLite floor) or Neon (export DATABASE_URL).
 *
 *   pnpm seed:scale [--subjects 120000] [--as-of YYYY-MM-DD]
 *
 * ROLLBACK (reversible) — delete tagged OUTCOMES first, then runs (schema-qualify on Postgres):
 *   DELETE FROM workwell_spike.outcomes
 *     WHERE run_id IN (SELECT id FROM workwell_spike.runs WHERE triggered_by = 'seed:scale');
 *   DELETE FROM workwell_spike.runs WHERE triggered_by = 'seed:scale';
 */
import { getStores, type StoresEnv } from "../../stores/factory.ts";
import { backfillScalePopulation } from "../backfill-scale.ts";

export const USAGE = "Usage: pnpm seed:scale [--subjects <n>] [--as-of YYYY-MM-DD]";
const DEFAULT_SUBJECTS = 120_000;

export class SeedCliUsageError extends Error { override readonly name = "SeedCliUsageError"; }
export interface SeedScaleArgs { subjects?: number; asOf?: string; }

export function parseArgs(args: string[]): SeedScaleArgs {
  const out: SeedScaleArgs = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--subjects") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 1) throw new SeedCliUsageError(`--subjects must be a positive integer\n${USAGE}`);
      out.subjects = Math.trunc(n);
    } else if (a === "--as-of") {
      const d = args[++i];
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new SeedCliUsageError(`--as-of must be YYYY-MM-DD\n${USAGE}`);
      out.asOf = d;
    } else if (a === "--help" || a === "-h") {
      throw new SeedCliUsageError(USAGE);
    } else {
      throw new SeedCliUsageError(`unknown argument '${a}'\n${USAGE}`);
    }
  }
  return out;
}

async function buildEnv(): Promise<StoresEnv> {
  const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
  if (databaseUrl) return { DATABASE_URL: databaseUrl };
  // @ts-expect-error — @mieweb/cloud-local ships .mjs without types
  const { createSqliteD1 } = await import("@mieweb/cloud-local");
  const dbPath = process.env.WORKWELL_SQLITE_PATH ?? "./.workwell-local.sqlite";
  const DB = await createSqliteD1(dbPath);
  return { DB };
}

export async function main(argv: string[]): Promise<number> {
  let parsed: SeedScaleArgs;
  try { parsed = parseArgs(argv); }
  catch (e) { process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`); return 2; }
  try {
    const env = await buildEnv();
    const stores = await getStores(env);
    const asOf = parsed.asOf ?? new Date().toISOString().slice(0, 10);
    const summary = await backfillScalePopulation(
      { runStore: stores.runs, outcomeStore: stores.outcomes, auditStore: stores.events },
      { subjects: parsed.subjects ?? DEFAULT_SUBJECTS, asOf },
    );
    const backend = (process.env.DATABASE_URL ?? "").trim() ? "postgres" : "sqlite";
    process.stdout.write(
      summary.skipped
        ? `[seed:scale] already seeded (${backend}) — no-op. Rollback SQL in this CLI's header.\n`
        : `[seed:scale] ${backend}: ${summary.runsCreated} runs × ${summary.subjects} subjects = ${summary.outcomesCreated} outcomes.\n`,
    );
    return 0;
  } catch (e) { process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
}
```
(Confirm `stores.events` is the `CaseEventStore` on the factory bundle — it's what `seed-trend-history.ts` passes as `auditStore`. If the factory names it differently, match that.)

- [ ] **Step 4: Implement `seed-scale-bin.ts`** (mirror `seed-trend-history-bin.ts`):

```ts
#!/usr/bin/env -S tsx
import { main } from "./seed-scale.ts";
main(process.argv.slice(2)).then((code) => process.exit(code)).catch(() => process.exit(1));
```
(Match the exact shebang/shape of `seed-trend-history-bin.ts`.)

- [ ] **Step 5: Add the npm script** to `backend-ts/package.json` next to `seed:trend-history`:

```json
    "seed:scale": "tsx src/run/cli/seed-scale-bin.ts",
```

- [ ] **Step 6: Run the CLI test + a live smoke against the floor**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/run/cli/seed-scale.test.ts`
Expected: PASS.
Run: `cd backend-ts && WORKWELL_SQLITE_PATH=./.scale-smoke.sqlite corepack pnpm@10 exec tsx src/run/cli/seed-scale-bin.ts --subjects 1000 --as-of 2026-06-26`
Expected: prints `[seed:scale] sqlite: <measures> runs × 1000 subjects = <n> outcomes.` Then delete `./.scale-smoke.sqlite`.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/run/cli/seed-scale.ts backend-ts/src/run/cli/seed-scale-bin.ts backend-ts/src/run/cli/seed-scale.test.ts backend-ts/package.json
git commit -m "feat(e13): pnpm seed:scale CLI (owner-run, on-demand)"
```

---

## Task 5: Scale-tenant rollup subtree + merge

**Files:** Create `backend-ts/src/program/scale-rollup.ts` + `.test.ts`; modify `hierarchy-rollup.ts` + its test.

- [ ] **Step 1: Write the failing test** — `scale-rollup.test.ts` (builds a scale subtree from group-counts):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScaleSubtree } from "./scale-rollup.ts";
import type { ScaleGroupCount } from "../stores/outcome-store.ts";

test("buildScaleSubtree → tenant→enterprise→location→provider(leaf), reconciling", () => {
  const groups: ScaleGroupCount[] = [
    { locationId: "L00", providerId: "P00", status: "COMPLIANT", count: 2 },
    { locationId: "L00", providerId: "P00", status: "OVERDUE", count: 1 },
    { locationId: "L00", providerId: "P01", status: "COMPLIANT", count: 1 },
  ];
  const tenant = buildScaleSubtree(groups);
  assert.equal(tenant!.level, "tenant");
  assert.equal(tenant!.id, "mhn");
  assert.equal(tenant!.totals.evaluated, 4);
  assert.equal(tenant!.totals.compliant, 3);
  // enterprise → location L00 → providers P00,P01 (leaves)
  const ent = tenant!.children[0]!;
  assert.equal(ent.level, "enterprise");
  const loc = ent.children.find((c) => c.id === "L00")!;
  assert.equal(loc.totals.evaluated, 4);
  const p00 = loc.children.find((c) => c.id === "P00")!;
  assert.equal(p00.level, "provider");
  assert.equal(p00.children.length, 0, "provider is a leaf (no 120k patients)");
  assert.equal(p00.totals.evaluated, 3);
  // reconciles: location = Σ providers; tenant = Σ locations
  const sumProv = loc.children.reduce((s, p) => s + p.totals.evaluated, 0);
  assert.equal(loc.totals.evaluated, sumProv);
});

test("empty groups → null (no scale data)", () => {
  assert.equal(buildScaleSubtree([]), null);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/program/scale-rollup.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `scale-rollup.ts`** (reuses the rollup node types + the seal/round helpers — re-implement the tiny totals helpers locally to avoid exporting internals):

```ts
/**
 * Scale-tenant rollup subtree (#185 E13 PR-2). Builds the mhn tenant→enterprise→location→provider tree
 * from the bounded ScaleGroupCount aggregation (NOT per-subject rows). Provider is a LEAF — the 120k
 * patients are deliberately not enumerated. Node names come from scale-structure.ts.
 */
import type { HierarchyNode, HierarchyTotals } from "./hierarchy-rollup.ts";
import type { ScaleGroupCount } from "../stores/outcome-store.ts";
import { SCALE_TENANT, SCALE_LOCATIONS, scaleProvidersFor, enterpriseNameForScale } from "../engine/synthetic/scale-structure.ts";
import { round1 } from "./rollup-shared.ts";

interface Mut { evaluated: number; compliant: number; dueSoon: number; overdue: number; missingData: number; excluded: number; openCases: number; }
const zero = (): Mut => ({ evaluated: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 0, openCases: 0 });
const add = (t: Mut, status: string, c: number): void => {
  t.evaluated += c;
  if (status === "COMPLIANT") t.compliant += c;
  else if (status === "DUE_SOON") t.dueSoon += c;
  else if (status === "OVERDUE") t.overdue += c;
  else if (status === "MISSING_DATA") t.missingData += c;
  else if (status === "EXCLUDED") t.excluded += c;
};
const acc = (a: Mut, b: Mut): void => {
  a.evaluated += b.evaluated; a.compliant += b.compliant; a.dueSoon += b.dueSoon; a.overdue += b.overdue;
  a.missingData += b.missingData; a.excluded += b.excluded; a.openCases += b.openCases;
};
const seal = (t: Mut): HierarchyTotals => ({ ...t, complianceRate: round1(t.compliant, t.evaluated) });

/** Build the mhn tenant subtree from grouped counts; null when there is no scale data. */
export function buildScaleSubtree(groups: ScaleGroupCount[]): HierarchyNode | null {
  if (groups.length === 0) return null;
  const provTotals = new Map<string, Mut>(); // key: `${loc}|${prov}`
  for (const g of groups) {
    const k = `${g.locationId}|${g.providerId}`;
    add(provTotals.get(k) ?? provTotals.set(k, zero()).get(k)!, g.status, g.count);
  }
  const locNodes = new Map<string, HierarchyNode[]>();
  const locTotals = new Map<string, Mut>();
  for (const [k, t] of provTotals) {
    const [locId, provId] = k.split("|") as [string, string];
    const provName = scaleProvidersFor(locId).find((p) => p.id === provId)?.name ?? provId;
    const provNode: HierarchyNode = { level: "provider", id: provId, name: provName, parentId: locId, totals: seal(t), children: [] };
    (locNodes.get(locId) ?? locNodes.set(locId, []).get(locId)!).push(provNode);
    acc(locTotals.get(locId) ?? locTotals.set(locId, zero()).get(locId)!, t);
  }
  const entTotals = zero();
  const locationChildren: HierarchyNode[] = [...locNodes.entries()]
    .map(([locId, provs]): HierarchyNode => {
      const lt = locTotals.get(locId)!;
      acc(entTotals, lt);
      const locName = SCALE_LOCATIONS.find((l) => l.id === locId)?.name ?? locId;
      return { level: "location", id: locId, name: locName, parentId: SCALE_TENANT.id, totals: seal(lt), children: provs.sort((a, b) => a.id.localeCompare(b.id)) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const tenantTotals = seal(entTotals);
  const enterpriseNode: HierarchyNode = {
    level: "enterprise", id: SCALE_TENANT.id, name: enterpriseNameForScale(), parentId: SCALE_TENANT.id,
    totals: tenantTotals, children: locationChildren,
  };
  return { level: "tenant", id: SCALE_TENANT.id, name: SCALE_TENANT.name, parentId: "all", totals: tenantTotals, children: [enterpriseNode] };
}
```
> Add `export const enterpriseNameForScale = (): string => SCALE_TENANT.name;` to `scale-structure.ts` (the enterprise name = the tenant name, matching PR-1's 1:1 tenant↔enterprise). Confirm `HierarchyTotals` + `HierarchyNode` are exported from `hierarchy-rollup.ts` (they are).

- [ ] **Step 4: Run to verify pass**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/program/scale-rollup.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the merge into `hierarchy-rollup.ts`.**

5a. Exclude scale runs from the in-memory scan — change line ~84:
```ts
    const allRows = (await deps.outcomeStore.listOutcomesWithRun({ from, to }))
      .filter((r) => isPopulationRun(r.runScopeType) && r.runTriggeredBy !== "seed:scale");
```

5b. Add the scale-tenant deps + build. The rollup needs `runStore` (to find latest scale run per measure) — extend `HierarchyDeps`:
```ts
export interface HierarchyDeps {
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
  runStore?: RunStore; // optional: when present, the mhn scale subtree is merged in (E13 PR-2)
}
```
(Import `RunStore` + `buildScaleSubtree` + `aggregate helper`.)

5c. After building `tenantNodes` (the in-memory small-tenant subtrees), build the scale subtree and append it, unless filtered to a non-mhn tenant:
```ts
  // E13 PR-2: merge the population-scale mhn subtree (SQL-aggregated; provider-leaf).
  let scaleNode: HierarchyNode | null = null;
  if (deps.runStore && (!tenantFilter || tenantFilter === SCALE_TENANT.id)) {
    const scaleRuns = (await deps.runStore.listRuns(100_000))
      .filter((r) => r.triggeredBy === "seed:scale" && r.status === "COMPLETED");
    // latest scale run per measure (scopeId = measureId), honoring the measureId filter
    const latestByMeasure = new Map<string, string>();
    for (const r of scaleRuns) {
      if (measureId && r.scopeId !== measureId) continue;
      const prev = latestByMeasure.get(r.scopeId ?? "");
      if (!prev || r.startedAt > (scaleRuns.find((x) => x.id === prev)?.startedAt ?? "")) latestByMeasure.set(r.scopeId ?? "", r.id);
    }
    const groups: ScaleGroupCount[] = [];
    for (const runId of latestByMeasure.values()) groups.push(...(await deps.outcomeStore.aggregateScaleRun(runId)));
    scaleNode = buildScaleSubtree(groups);
  }
```
(Simplify the "latest per measure" with a sort if clearer: sort `scaleRuns` by `startedAt` asc, then `latestByMeasure.set(scopeId, runId)` overwrites to the latest.)

5d. Include `scaleNode` in the All-Systems aggregation + children, and handle the `?tenant=mhn` filtered return:
```ts
  if (tenantFilter) {
    if (tenantFilter === SCALE_TENANT.id) {
      return scaleNode ?? { level: "tenant", id: SCALE_TENANT.id, name: SCALE_TENANT.name, parentId: "all", totals: seal(zero()), children: [] };
    }
    return tenantNodes.find((t) => t.id === tenantFilter) ?? { /* existing empty tenant node */ };
  }
  const allChildren = scaleNode ? [...tenantNodes, scaleNode] : tenantNodes;
  const allTotals = zero();
  for (const t of entTotals.values()) accumulate(allTotals, t);
  if (scaleNode) accumulate(allTotals, toMut(scaleNode.totals)); // add scale tenant totals to the root
  return { level: "all", id: "all", name: "All Systems", parentId: null, totals: seal(allTotals), children: allChildren.sort((a,b)=>a.id.localeCompare(b.id)) };
```
> `toMut` converts a sealed `HierarchyTotals` back to the mutable shape for `accumulate` (drop `complianceRate`): `const toMut = (t: HierarchyTotals): MutableTotals => ({ evaluated: t.evaluated, compliant: t.compliant, dueSoon: t.dueSoon, overdue: t.overdue, missingData: t.missingData, excluded: t.excluded, openCases: t.openCases });`. Reuse the existing `MutableTotals`/`accumulate`/`seal`/`zero` already in this file.

- [ ] **Step 6: Add the rollup merge test** to `hierarchy-rollup.test.ts` — seed a small scale run + a live run, pass `runStore`, assert the All root has the `mhn` child reconciling and `?tenant=mhn` returns the subtree. (Use the existing floor-store harness; `recordOutcomes` scale rows with `encodeScaleSubject`; create the run with `triggeredBy:"seed:scale"`.)

```ts
test("merges the mhn scale subtree (SQL-aggregated) and reconciles; ?tenant=mhn isolates it", async () => {
  // build a fresh db with a live audiogram run (emp-006 OVERDUE) + a seed:scale audiogram run (4 subjects)
  // … (mirror the freshStores pattern in this file) …
  const root = await buildHierarchyRollup({ outcomeStore: o, caseStore: c, runStore: rs }, { measureId: "audiogram" });
  const mhn = root.children.find((n) => n.id === "mhn")!;
  assert.equal(mhn.level, "tenant");
  assert.equal(mhn.totals.evaluated, 4);
  assertReconciles(root); // All = Σ tenants incl. mhn
  const sub = await buildHierarchyRollup({ outcomeStore: o, caseStore: c, runStore: rs }, { measureId: "audiogram", tenant: "mhn" });
  assert.equal(sub.level, "tenant");
  assert.equal(sub.id, "mhn");
});
```
(`assertReconciles` already recurses; the provider-leaf scale nodes reconcile because each is a leaf with its own total.)

- [ ] **Step 7: Wire `runStore` into the route** — `backend-ts/src/routes/hierarchy.ts`: pass `runStore: s.runs` in the `buildHierarchyRollup` deps.

- [ ] **Step 8: Run rollup tests + route test + typecheck**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/program/scale-rollup.test.ts src/program/hierarchy-rollup.test.ts src/routes/hierarchy.test.ts && corepack pnpm@10 typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend-ts/src/program/scale-rollup.ts backend-ts/src/program/scale-rollup.test.ts backend-ts/src/program/hierarchy-rollup.ts backend-ts/src/program/hierarchy-rollup.test.ts backend-ts/src/routes/hierarchy.ts backend-ts/src/engine/synthetic/scale-structure.ts
git commit -m "feat(e13): merge the SQL-aggregated mhn scale subtree into the rollup"
```

---

## Task 6: Programs KPIs include the scale tenant

**Files:** Modify `program-read-models.ts`, `routes/programs.ts`, and a test.

- [ ] **Step 1: Write the failing test** — append to `routes/programs.test.ts` (seed a small seed:scale run for `obesity_bmi`, assert the overview folds it in unless `?tenant` excludes it):

```ts
test("E13 PR-2: programs overview folds in the scale tenant counts (excluded by ?tenant=twh)", async () => {
  const runStore = new SqliteRunStore(env.DB as never);
  const oc = new SqliteOutcomeStore(env.DB as never);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "obesity_bmi", triggeredBy: "seed:scale", status: "COMPLETED",
    requestedScope: { measureId: "obesity_bmi" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await oc.recordOutcomes([
    { runId: run.id, subjectId: encodeScaleSubject(0, 0, 1), measureId: "obesity_bmi", status: "COMPLIANT", evidence: {} },
    { runId: run.id, subjectId: encodeScaleSubject(0, 0, 2), measureId: "obesity_bmi", status: "OVERDUE", evidence: {} },
  ]);
  const bmiOf = async (qs = "") =>
    ((await get(`/overview${qs}`).then((r) => r!.json())) as Summary[]).find((p) => p.measureId === "obesity_bmi")!;
  assert.equal((await bmiOf()).totalEvaluated >= 2, true, "scale counts included by default");
  assert.equal((await bmiOf("?tenant=twh")).totalEvaluated, 0, "scale excluded when scoped to twh");
  const mhn = await bmiOf("?tenant=mhn");
  assert.equal(mhn.totalEvaluated, 2);
  assert.equal(mhn.compliant, 1);
});
```
(Import `encodeScaleSubject`. Note: the prior E13-PR1 obesity_bmi test in this file seeds a live run; ensure these don't collide — use a distinct measure if needed, e.g. `cholesterol_ldl`.)

- [ ] **Step 2: Run to verify failure**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/routes/programs.test.ts`
Expected: FAIL (scale counts not folded in).

- [ ] **Step 3: Implement** in `program-read-models.ts`:

3a. Exclude scale runs from the in-memory scan (the `programOverview` `rows` filter, ~line 142):
```ts
    (r) => siteMatch(r.subjectId) && tenantMatch(r.subjectId) && isPopulationRun(r.runScopeType) && isCompletedRun(r.runStatus) && r.runTriggeredBy !== "seed:scale",
```

3b. After the per-measure `summaries` are built, fold in the scale tenant's counts when the tenant filter allows it. Add `runStore` to `ProgramDeps` (optional) and, when present and `(!tenant || tenant === "mhn")`, find the latest `seed:scale` run per measure, `aggregateScaleRun`, sum by status, and add to that measure's summary (or REPLACE when `tenant === "mhn"`):
```ts
  const tenant = filters.tenant?.trim() || null;
  if (deps.runStore && (!tenant || tenant === "mhn")) {
    const scaleRuns = (await deps.runStore.listRuns(100_000))
      .filter((r) => r.triggeredBy === "seed:scale" && r.status === "COMPLETED")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const latest = new Map<string, string>(); // measureId → latest scale runId
    for (const r of scaleRuns) if (r.scopeId) latest.set(r.scopeId, r.id);
    for (const s of summaries) {
      const runId = latest.get(s.measureId);
      if (!runId) continue;
      const groups = await deps.outcomeStore.aggregateScaleRun(runId);
      const n = (st: string) => groups.filter((g) => g.status === st).reduce((a, g) => a + g.count, 0);
      const base = tenant === "mhn" ? { compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 0, total: 0 }
                                    : { compliant: s.compliant, dueSoon: s.dueSoon, overdue: s.overdue, missingData: s.missingData, excluded: s.excluded, total: s.totalEvaluated };
      s.compliant = base.compliant + n("COMPLIANT");
      s.dueSoon = base.dueSoon + n("DUE_SOON");
      s.overdue = base.overdue + n("OVERDUE");
      s.missingData = base.missingData + n("MISSING_DATA");
      s.excluded = base.excluded + n("EXCLUDED");
      s.totalEvaluated = base.total + groups.reduce((a, g) => a + g.count, 0);
      s.complianceRate = round1(s.compliant, s.totalEvaluated);
      if (tenant === "mhn") s.latestRunId = runId;
    }
  }
```
(Make `ProgramSummary` fields mutable for this in-place fold, or rebuild the summary object. Confirm `round1` is imported — it is, from `rollup-shared.ts`.)

3c. Pass `runStore` from `routes/programs.ts` `deps()` (it already calls `getStores`): add `runStore: s.runs` (already present — `deps` returns `runStore: s.runs`). So `ProgramDeps.runStore` is already supplied; just make the read model use it.

- [ ] **Step 4: Run to verify pass**

Run: `cd backend-ts && corepack pnpm@10 exec tsx --test src/routes/programs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/program/program-read-models.ts backend-ts/src/routes/programs.ts backend-ts/src/routes/programs.test.ts
git commit -m "feat(e13): programs overview KPIs fold in the scale tenant (?tenant-aware)"
```

---

## Task 7: Bounded-memory + perf assertions, then full gate

**Files:** Add a bounded-memory test (floor) in `outcome-store-scale.test.ts`; optional Pg benchmark.

- [ ] **Step 1: Bounded-memory test** — append to `outcome-store-scale.test.ts`: seed N=2000 then N=20000 across the same structure into two runs and assert `aggregateScaleRun(...).length` is identical (group count is O(providers), independent of N).

```ts
test("group count is bounded by structure, not by subject count", async () => {
  // seed two runs with the SAME provider structure but different N; group counts must match.
  // (build a fresh db; create two seed:scale runs; recordOutcomes 2000 vs 20000 spread over the 240 providers)
  // assert small.length === big.length
});
```

- [ ] **Step 2: (Optional, Pg-gated) perf benchmark** — only meaningful against a real Postgres; gate like the existing Pg-ceiling contract test (self-skip when no `DATABASE_URL`/local pg). Seed ~50k via `backfillScalePopulation`, time `buildHierarchyRollup` with `runStore`, assert `< 2000ms` and that a `listOutcomesWithRun` spy never returned scale rows. If the repo has no Pg-gated test harness to copy, SKIP this step and rely on the bounded-memory invariant (Step 1) — note the omission in the commit.

- [ ] **Step 3: Full backend gate**

Run: `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test`
Expected: PASS (≈760 tests; 1 pg-skip). Fix any population/count assertions that now include `mhn` in `TENANTS` (search `grep -rn '"ihn","twh"\|length, 2' src/**/*.test.ts` — the tenants list is now 3).

- [ ] **Step 4: Frontend gate** (no code change expected; the tenant selector + depth-agnostic table already handle `mhn` and provider-leaves):

Run: `cd frontend && npm run lint && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(e13): bounded-memory invariant for the scale aggregation + suite fixups"
```

---

## Task 8: Docs + ADR

**Files:** `ARCHITECTURE.md`, `DATA_MODEL.md`, `DEPLOY.md`, `DECISIONS.md`, `JOURNAL.md`, `CLAUDE.md`, `README.md`.

- [ ] **Step 1: DECISIONS.md** — new ADR (next number, ADR-020): "Population scale via generated outcomes + encoded `subject_id` + SQL aggregation (provider-leaf), no DDL." Record: generated not live-evaluated; subject_id codec; `aggregateScaleRun` bounded; rollup/overview merge + scale-run exclusion from the in-memory path; owner-run seed; reversible; ADR-008 (CQL authoritative for live subjects).
- [ ] **Step 2: ARCHITECTURE.md** — §3 program module (the scale subtree + `aggregateScaleRun` + bounded-memory invariant + scale-run exclusion), §7 API (rollup/overview now include `mhn` when seeded; `GET /api/tenants` lists it), §6 invariants (the scale path never materializes per-subject rows in app memory).
- [ ] **Step 3: DATA_MODEL.md** — §3.6/§3.20-style note: the `mhn` scale tenant's subjects live only as `outcomes` rows with an encoded `subject_id` (`mhn|Lxx|Pxx|n`), generated by `seed:scale`, **no schema/columns added**; the reversible rollback SQL.
- [ ] **Step 4: DEPLOY.md** — a `pnpm seed:scale` subsection mirroring the trend-history one (usage against Neon, idempotent, reversible rollback SQL, owner-gated, NOT on deploy).
- [ ] **Step 5: README.md** — add `pnpm seed:scale` to the seed section.
- [ ] **Step 6: JOURNAL.md** + **CLAUDE.md** Current Focus — E13 PR-2 done; PR-3 (cron) next.
- [ ] **Step 7: Commit**

```bash
git add docs CLAUDE.md README.md
git commit -m "docs(e13): ADR-020 + ARCHITECTURE/DATA_MODEL/DEPLOY/JOURNAL/README for PR-2 scale"
```

---

## Task 9: Final verification + PR

- [ ] **Step 1:** `cd backend-ts && corepack pnpm@10 typecheck && corepack pnpm@10 test` → green.
- [ ] **Step 2:** `cd frontend && npm run lint && npm run build` → green.
- [ ] **Step 3:** Code-review the whole branch diff (superpowers code-reviewer over `main...HEAD`). Address findings.
- [ ] **Step 4:** Push, open PR to `main` summarizing PR-2 (generated 120k scale tenant, SQL-aggregated rollup/overview, no DDL/deps, owner-run seed, reversible; roster + cron out of scope). No auto-merge.

---

## Self-review notes
- **Spec coverage:** structure+codec (T1), `aggregateScaleRun` (T2), generated seed (T3), CLI (T4), rollup merge + `?tenant` (T5), overview KPIs (T6), bounded-memory/perf (T7), docs/ADR (T8). All §2–§5 spec items mapped.
- **Type consistency:** `ScaleGroupCount {locationId,providerId,status,count}` defined T2, consumed T5/T6; `encodeScaleSubject(locIdx,provIdx,n)` / `decodeScaleSubject` / `isScaleSubject` T1 used T2/T3; `buildScaleSubtree(groups): HierarchyNode|null` T5; `SCALE_TRIGGER="seed:scale"` consistent across T3/T5/T6; `HierarchyDeps.runStore?` optional so existing callers compile.
- **Risk flagged:** the `mhn` entry in `TENANTS` changes tenant-list assertions (T7 hunts them); `recordOutcomes` chunking + Pg parameter limits handled in T3; `listAuditEvents`/`stores.events` exact names to confirm against the trend-history seeder (T3/T4 notes).
