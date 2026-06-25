# E11.3 Segments / Risk-Groups — PR-1 (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, owner-gated segment (risk-group) model — cohort → applicable rule-set with hybrid (rule + override) membership — and wire its applicability into the roster (N/A overlay + segment filter) and the run pipeline (gate case creation), backend only.

**Architecture:** Three new tables in the `workwell_spike` schema (Pg ceiling) + the SQLite floor. A pure `segment-applicability.ts` engine (the single applicability definition) is consumed by the roster read model and the run→case seam. A `SegmentStore` port (floor + ceiling adapters, wired in `factory.ts`) backs an ADMIN-gated `/api/segments` CRUD route. Reversibility invariant: **zero enabled segments ⇒ every measure applicable to everyone** (= today's behavior), so the whole feature is a safe additive overlay.

**Tech Stack:** TypeScript (Node 24, ESM, `.ts` import specifiers), `@mieweb/cloud` worker, `node:test` + `node:assert/strict`, SQLite floor (`CloudDatabase`) + Postgres ceiling (`pg`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-25-e11-3-segments-design.md`

**Branch:** `feat/e11-3-segments` (already created; the design spec is committed here).

**Conventions to follow (read once before starting):**
- Build/verify from `backend-ts/`: `pnpm typecheck` then `pnpm test`. A single test file: `node --test --experimental-strip-types src/<path>.test.ts` (this repo runs `.ts` tests directly — match the script in `package.json`; if unsure run the whole `pnpm test`).
- Commit per task, conventional commits, scope `(segments)`, reference `#183`. Footer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Vj9GhN5vxoENWrwrU56GZz
  ```
- IDs are app-generated `crypto.randomUUID()` **stored as TEXT** on both backends (matches `value_sets`/`measures`/`waivers` — a refinement on the spec's `UUID`, chosen for floor/ceiling parity). Booleans are `INTEGER` 0/1 on the floor, `BOOLEAN` on the ceiling (matches `outreach_templates.active`). JSON is `TEXT` on the floor, `JSONB` on the ceiling.

---

## File Structure

**Create:**
- `backend-ts/src/stores/segment-store.ts` — the `SegmentStore` port + all shared types (`HydratedSegment`, `SegmentRule`, `SegmentCondition`, `SegmentOverride`, `CreateSegmentInput`, `UpdateSegmentPatch`, `OverrideMode`).
- `backend-ts/src/stores/sqlite/segment-store-sqlite.ts` — floor adapter.
- `backend-ts/src/stores/postgres/segment-store-postgres.ts` — ceiling adapter.
- `backend-ts/src/segment/segment-applicability.ts` — pure applicability engine.
- `backend-ts/src/segment/segment-applicability.test.ts` — engine unit tests.
- `backend-ts/src/segment/segment-seed.ts` — idempotent demo-segment seed.
- `backend-ts/src/routes/segments.ts` — `/api/segments` CRUD + preview route.
- `backend-ts/src/routes/segments.test.ts` — route tests.

**Modify:**
- `backend-ts/src/stores/postgres/schema-pg.ts` — append 3 `CREATE TABLE`s (owner-gated; authorized).
- `backend-ts/src/stores/sqlite/schema.ts` — append 3 `CREATE TABLE`s.
- `backend-ts/src/stores/factory.ts` — add `segments` to `Stores`, build on floor + ceiling.
- `backend-ts/src/stores/store-contract.ts` — add `segmentStoreContract(label, freshStore)`.
- `backend-ts/src/stores/postgres/store-postgres.test.ts` — register the segment contract for both backends (wherever `valueSetStoreContract` is registered).
- `backend-ts/src/compliance/roster-vocabulary.ts` — add `NOT_APPLICABLE` to `DisplayState`.
- `backend-ts/src/compliance/roster-read-model.ts` — applicability overlay + `segment` filter.
- `backend-ts/src/compliance/roster-read-model.test.ts` — overlay + filter tests.
- `backend-ts/src/routes/compliance.ts` — load segments, pass to `buildRoster`, accept `?segment=`.
- `backend-ts/src/run/run-pipeline.ts` — `segments` dep + `isApplicable` gate on the case upsert.
- `backend-ts/src/run/run-pipeline.test.ts` — case-gating tests.
- `backend-ts/src/routes/runs.ts` — load enabled segments into the run deps.
- `backend-ts/src/routes/measures.ts` — call `seedSegments` in the seed block.
- `backend-ts/src/auth/authorize.ts` — ADMIN gate on `/api/segments` writes.
- `backend-ts/src/worker.ts` — register `handleSegments`.
- `docs/DECISIONS.md` — ADR-016.
- `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`, `docs/JOURNAL.md` — segment tables + surfaces.

---

## Task 0: Owner-gated DDL — the 3 segment tables

**Files:**
- Modify: `backend-ts/src/stores/postgres/schema-pg.ts` (append before the closing `` `; ``)
- Modify: `backend-ts/src/stores/sqlite/schema.ts` (append before the closing `` `; `` of `RUN_STORE_FLOOR_DDL`)

> Authorized by the maintainer in this session (the spec's stop-and-ask is cleared). New tables only — no `ALTER` to existing tables, so no floor backfill entry is needed.

- [ ] **Step 1: Append the ceiling DDL** to the `RUN_STORE_PG_DDL` template in `schema-pg.ts`, immediately before the final closing `` ` ``:

```sql
-- Segments / risk-groups (#183 E11.3). cohort (rule_json + overrides) → applicable rule-set
-- (segment_measures). Applicability gates case creation + roster display; never compliance (ADR-016).
CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.segments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  rule_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.segment_measures (
  segment_id   TEXT NOT NULL REFERENCES ${SPIKE_SCHEMA}.segments(id) ON DELETE CASCADE,
  measure_id   TEXT NOT NULL,
  PRIMARY KEY (segment_id, measure_id)
);

CREATE TABLE IF NOT EXISTS ${SPIKE_SCHEMA}.segment_overrides (
  segment_id   TEXT NOT NULL REFERENCES ${SPIKE_SCHEMA}.segments(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  mode         TEXT NOT NULL,
  PRIMARY KEY (segment_id, external_id)
);
```

- [ ] **Step 2: Append the floor DDL** to the `RUN_STORE_FLOOR_DDL` template in `schema.ts`, immediately before the final closing `` ` ``:

```sql
/* Segments / risk-groups (#183 E11.3). Floor analogue: enabled INTEGER 0/1, rule_json JSON TEXT.
   deleteSegment removes child rows explicitly (the floor does not enable PRAGMA foreign_keys, so
   ON DELETE CASCADE is advisory here). */
CREATE TABLE IF NOT EXISTS segments (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  rule_json    TEXT NOT NULL DEFAULT '{}',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS segment_measures (
  segment_id   TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  measure_id   TEXT NOT NULL,
  PRIMARY KEY (segment_id, measure_id)
);

CREATE TABLE IF NOT EXISTS segment_overrides (
  segment_id   TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  mode         TEXT NOT NULL,
  PRIMARY KEY (segment_id, external_id)
);
```

- [ ] **Step 3: Typecheck** (no code references the tables yet — this just verifies the template literals are well-formed).

Run: `cd backend-ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend-ts/src/stores/postgres/schema-pg.ts backend-ts/src/stores/sqlite/schema.ts
git commit -m "feat(segments): add segments/segment_measures/segment_overrides DDL (floor + ceiling) (#183)"
```

---

## Task 1: Applicability engine (pure) + tests

**Files:**
- Create: `backend-ts/src/stores/segment-store.ts` (types only in this task — the port interface lands in Task 2; define the data types here so the engine can import them)
- Create: `backend-ts/src/segment/segment-applicability.ts`
- Test: `backend-ts/src/segment/segment-applicability.test.ts`

- [ ] **Step 1: Create the shared types** in `backend-ts/src/stores/segment-store.ts`:

```ts
/**
 * SegmentStore port (#183 E11.3) — persistence for risk-group segments. A segment maps a cohort
 * (rule_json predicate + per-employee overrides) to an applicable rule-set (measure ids). The
 * port + both adapters (floor + ceiling) back the /api/segments CRUD route and the applicability
 * overlay. Applicability gates case creation + roster display only — never compliance (ADR-016).
 */
export type OverrideMode = "INCLUDE" | "EXCLUDE";

export interface SegmentCondition {
  attr: "role" | "site";
  op: "equals" | "contains" | "in";
  value: string | string[];
}

export interface SegmentRule {
  match: "ANY" | "ALL";
  conditions: SegmentCondition[];
}

export interface SegmentOverride {
  externalId: string;
  mode: OverrideMode;
}

export interface HydratedSegment {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  rule: SegmentRule;
  measureIds: string[];
  overrides: SegmentOverride[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSegmentInput {
  name: string;
  description?: string;
  enabled?: boolean;
  rule: SegmentRule;
  measureIds: string[];
  overrides?: SegmentOverride[];
}

export interface UpdateSegmentPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  rule?: SegmentRule;
}
```

- [ ] **Step 2: Write the failing test** `backend-ts/src/segment/segment-applicability.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { HydratedSegment } from "../stores/segment-store.ts";
import { matchesRule, matchesCohort, applicableMeasures, isApplicable } from "./segment-applicability.ts";

const emp = (over: Partial<EmployeeProfile> = {}): EmployeeProfile => ({
  externalId: "emp-006", name: "Omar Siddiq", role: "Welder", site: "Plant A", providerId: "prov-001", ...over,
});

const seg = (over: Partial<HydratedSegment> = {}): HydratedSegment => ({
  id: "s1", name: "S1", description: "", enabled: true,
  rule: { match: "ANY", conditions: [] }, measureIds: [], overrides: [],
  createdBy: "x", createdAt: "t", updatedAt: "t", ...over,
});

test("matchesRule: contains is case-insensitive substring on role", () => {
  const e = emp({ role: "Welder / Hazwoper Responder" });
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "hazwoper" }] }), true);
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "nurse" }] }), false);
});

test("matchesRule: equals + in on site; ALL vs ANY", () => {
  const e = emp({ site: "Clinic", role: "Nurse" });
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "site", op: "equals", value: "clinic" }] }), true);
  assert.equal(matchesRule(e, { match: "ANY", conditions: [{ attr: "site", op: "in", value: ["HQ", "Clinic"] }] }), true);
  assert.equal(matchesRule(e, { match: "ALL", conditions: [
    { attr: "site", op: "equals", value: "Clinic" }, { attr: "role", op: "contains", value: "welder" },
  ] }), false);
});

test("matchesRule: empty conditions match nobody", () => {
  assert.equal(matchesRule(emp(), { match: "ANY", conditions: [] }), false);
});

test("matchesCohort: EXCLUDE override wins, INCLUDE forces in", () => {
  const ruleHazwoper = { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Welder" }] };
  // matches by rule, but EXCLUDE override removes
  assert.equal(matchesCohort(emp(), seg({ rule: ruleHazwoper, overrides: [{ externalId: "emp-006", mode: "EXCLUDE" }] })), false);
  // does not match by rule, but INCLUDE override adds
  assert.equal(matchesCohort(emp({ role: "Office Staff" }), seg({ rule: ruleHazwoper, overrides: [{ externalId: "emp-006", mode: "INCLUDE" }] })), true);
});

test("applicableMeasures: union across enabled matching segments; disabled ignored", () => {
  const e = emp({ role: "Welder", site: "Plant A" });
  const a = seg({ id: "a", rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] }, measureIds: ["audiogram", "hazwoper"] });
  const b = seg({ id: "b", enabled: false, rule: { match: "ANY", conditions: [{ attr: "site", op: "equals", value: "Plant A" }] }, measureIds: ["flu_vaccine"] });
  const got = applicableMeasures(e, [a, b]);
  assert.deepEqual([...got].sort(), ["audiogram", "hazwoper"]);
});

test("isApplicable: zero enabled segments ⇒ everything applies (reversibility)", () => {
  assert.equal(isApplicable(emp(), "audiogram", []), true);
  assert.equal(isApplicable(emp(), "audiogram", [seg({ enabled: false, measureIds: ["audiogram"] })]), true);
});

test("isApplicable: with enabled segments, out-of-cohort measure is not applicable", () => {
  const s = seg({ rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] }, measureIds: ["audiogram"] });
  assert.equal(isApplicable(emp({ role: "Welder" }), "audiogram", [s]), true);
  assert.equal(isApplicable(emp({ role: "Office Staff" }), "audiogram", [s]), false);
});
```

- [ ] **Step 2b: Run to verify it fails**

Run: `cd backend-ts && node --test --experimental-strip-types src/segment/segment-applicability.test.ts`
Expected: FAIL — `Cannot find module './segment-applicability.ts'`.

- [ ] **Step 3: Implement** `backend-ts/src/segment/segment-applicability.ts`:

```ts
/**
 * Segment applicability engine (#183 E11.3) — the SINGLE definition of "does this measure apply to
 * this employee under the configured segments?". Pure, no I/O. Consumed by the roster read model
 * (N/A overlay + segment filter) and the run pipeline (case-creation gate). Applicability never
 * decides compliance — CQL Outcome Status is unchanged (ADR-008/ADR-016).
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { HydratedSegment, SegmentRule, SegmentCondition } from "../stores/segment-store.ts";

/** Evaluate a cohort predicate over an employee's role/site (case-insensitive). Empty ⇒ matches nobody. */
export function matchesRule(emp: EmployeeProfile, rule: SegmentRule): boolean {
  const conditions = rule.conditions ?? [];
  if (conditions.length === 0) return false;
  const testOne = (c: SegmentCondition): boolean => {
    const attr = (c.attr === "site" ? emp.site : emp.role).toLowerCase();
    if (c.op === "equals") return typeof c.value === "string" && attr === c.value.toLowerCase();
    if (c.op === "contains") return typeof c.value === "string" && attr.includes(c.value.toLowerCase());
    if (c.op === "in") return Array.isArray(c.value) && c.value.some((v) => attr === String(v).toLowerCase());
    return false;
  };
  return rule.match === "ALL" ? conditions.every(testOne) : conditions.some(testOne);
}

/** Cohort membership = rule match, with per-employee overrides (EXCLUDE wins, then INCLUDE). */
export function matchesCohort(emp: EmployeeProfile, segment: HydratedSegment): boolean {
  const override = segment.overrides.find((o) => o.externalId === emp.externalId);
  if (override?.mode === "EXCLUDE") return false;
  if (override?.mode === "INCLUDE") return true;
  return matchesRule(emp, segment.rule);
}

/** Union of the rule-sets of every ENABLED segment the employee belongs to. */
export function applicableMeasures(emp: EmployeeProfile, segments: HydratedSegment[]): Set<string> {
  const out = new Set<string>();
  for (const s of segments) {
    if (!s.enabled) continue;
    if (matchesCohort(emp, s)) for (const m of s.measureIds) out.add(m);
  }
  return out;
}

/** True if the measure applies to the employee. Reversibility: zero ENABLED segments ⇒ always true. */
export function isApplicable(emp: EmployeeProfile, measureId: string, segments: HydratedSegment[]): boolean {
  if (!segments.some((s) => s.enabled)) return true;
  return applicableMeasures(emp, segments).has(measureId);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend-ts && node --test --experimental-strip-types src/segment/segment-applicability.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/stores/segment-store.ts backend-ts/src/segment/segment-applicability.ts backend-ts/src/segment/segment-applicability.test.ts
git commit -m "feat(segments): pure applicability engine + shared types (#183)"
```

---

## Task 2: SegmentStore port interface

**Files:**
- Modify: `backend-ts/src/stores/segment-store.ts` (append the interface)

- [ ] **Step 1: Append the `SegmentStore` interface** to `backend-ts/src/stores/segment-store.ts`:

```ts
export interface SegmentStore {
  /** All segments, hydrated with measures + overrides, ordered by name ASC. */
  listSegments(): Promise<HydratedSegment[]>;
  getSegment(id: string): Promise<HydratedSegment | null>;
  createSegment(input: CreateSegmentInput): Promise<HydratedSegment>;
  /** Patch name/description/enabled/rule (bumps updated_at). null if id unknown. */
  updateSegment(id: string, patch: UpdateSegmentPatch): Promise<HydratedSegment | null>;
  /** Delete the segment and its measures + overrides. No-op if id unknown. */
  deleteSegment(id: string): Promise<void>;
  /** Replace the applicable rule-set (delete-then-insert). */
  setMeasures(id: string, measureIds: string[]): Promise<void>;
  /** Replace the overrides (delete-then-insert). */
  setOverrides(id: string, overrides: SegmentOverride[]): Promise<void>;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/stores/segment-store.ts
git commit -m "feat(segments): SegmentStore port interface (#183)"
```

---

## Task 3: SQLite floor adapter

**Files:**
- Create: `backend-ts/src/stores/sqlite/segment-store-sqlite.ts`

The store contract test (Task 5) verifies behavior on both backends, so no separate adapter unit test here — mirror the `SqliteValueSetStore` patterns (`db.prepare(...).bind(...).run()/.first()/.all<Row>()`).

- [ ] **Step 1: Implement** `backend-ts/src/stores/sqlite/segment-store-sqlite.ts`:

```ts
/**
 * SQLite/D1 floor implementation of the SegmentStore contract (#183 E11.3). rule_json is JSON TEXT,
 * enabled is INTEGER 0/1. Measures + overrides live in child tables; deleteSegment removes them
 * explicitly (the floor does not enable PRAGMA foreign_keys).
 */
import type { CloudDatabase } from "@mieweb/cloud";
import type {
  CreateSegmentInput, HydratedSegment, SegmentOverride, SegmentRule, SegmentStore, UpdateSegmentPatch,
} from "../segment-store.ts";

interface SegRow {
  id: string; name: string; description: string | null; enabled: number;
  rule_json: string; created_by: string | null; created_at: string; updated_at: string;
}

function parseRule(json: string | null): SegmentRule {
  if (!json) return { match: "ANY", conditions: [] };
  try {
    const raw = JSON.parse(json) as Partial<SegmentRule>;
    return { match: raw.match === "ALL" ? "ALL" : "ANY", conditions: Array.isArray(raw.conditions) ? raw.conditions : [] };
  } catch {
    return { match: "ANY", conditions: [] };
  }
}

export class SqliteSegmentStore implements SegmentStore {
  constructor(private readonly db: CloudDatabase) {}

  private async hydrate(row: SegRow): Promise<HydratedSegment> {
    const ms = await this.db.prepare("SELECT measure_id FROM segment_measures WHERE segment_id = ? ORDER BY measure_id ASC").bind(row.id).all<{ measure_id: string }>();
    const ov = await this.db.prepare("SELECT external_id, mode FROM segment_overrides WHERE segment_id = ? ORDER BY external_id ASC").bind(row.id).all<{ external_id: string; mode: string }>();
    return {
      id: row.id, name: row.name, description: row.description ?? "", enabled: Number(row.enabled) === 1,
      rule: parseRule(row.rule_json),
      measureIds: (ms.results ?? []).map((r) => r.measure_id),
      overrides: (ov.results ?? []).map((r) => ({ externalId: r.external_id, mode: r.mode === "INCLUDE" ? "INCLUDE" : "EXCLUDE" } as SegmentOverride)),
      createdBy: row.created_by ?? "", createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async listSegments(): Promise<HydratedSegment[]> {
    const { results } = await this.db.prepare("SELECT * FROM segments ORDER BY name ASC").all<SegRow>();
    return Promise.all((results ?? []).map((r) => this.hydrate(r)));
  }

  async getSegment(id: string): Promise<HydratedSegment | null> {
    const row = await this.db.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegRow>();
    return row ? this.hydrate(row) : null;
  }

  async createSegment(input: CreateSegmentInput): Promise<HydratedSegment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db
      .prepare("INSERT INTO segments (id, name, description, enabled, rule_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, input.name, input.description ?? null, input.enabled === false ? 0 : 1, JSON.stringify(input.rule), null, now, now)
      .run();
    await this.setMeasures(id, input.measureIds);
    await this.setOverrides(id, input.overrides ?? []);
    return (await this.getSegment(id))!;
  }

  async updateSegment(id: string, patch: UpdateSegmentPatch): Promise<HydratedSegment | null> {
    const existing = await this.db.prepare("SELECT * FROM segments WHERE id = ?").bind(id).first<SegRow>();
    if (!existing) return null;
    const name = patch.name ?? existing.name;
    const description = patch.description !== undefined ? patch.description : existing.description;
    const enabled = patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : existing.enabled;
    const ruleJson = patch.rule !== undefined ? JSON.stringify(patch.rule) : existing.rule_json;
    await this.db
      .prepare("UPDATE segments SET name = ?, description = ?, enabled = ?, rule_json = ?, updated_at = ? WHERE id = ?")
      .bind(name, description, enabled, ruleJson, new Date().toISOString(), id)
      .run();
    return this.getSegment(id);
  }

  async deleteSegment(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM segment_measures WHERE segment_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM segment_overrides WHERE segment_id = ?").bind(id).run();
    await this.db.prepare("DELETE FROM segments WHERE id = ?").bind(id).run();
  }

  async setMeasures(id: string, measureIds: string[]): Promise<void> {
    await this.db.prepare("DELETE FROM segment_measures WHERE segment_id = ?").bind(id).run();
    for (const m of [...new Set(measureIds)]) {
      await this.db.prepare("INSERT INTO segment_measures (segment_id, measure_id) VALUES (?, ?)").bind(id, m).run();
    }
  }

  async setOverrides(id: string, overrides: SegmentOverride[]): Promise<void> {
    await this.db.prepare("DELETE FROM segment_overrides WHERE segment_id = ?").bind(id).run();
    const seen = new Set<string>();
    for (const o of overrides) {
      if (seen.has(o.externalId)) continue;
      seen.add(o.externalId);
      await this.db.prepare("INSERT INTO segment_overrides (segment_id, external_id, mode) VALUES (?, ?, ?)").bind(id, o.externalId, o.mode).run();
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/stores/sqlite/segment-store-sqlite.ts
git commit -m "feat(segments): SQLite floor SegmentStore adapter (#183)"
```

---

## Task 4: Postgres ceiling adapter

**Files:**
- Create: `backend-ts/src/stores/postgres/segment-store-postgres.ts`

Mirror an existing Pg adapter (e.g. `value-set-store-postgres.ts`) for the `pool.query(text, params)` pattern and the `SPIKE_SCHEMA`-qualified table names. Read `value-set-store-postgres.ts` first to copy the exact pool call signature and `$1`/`$2` placeholder style.

- [ ] **Step 1: Implement** `backend-ts/src/stores/postgres/segment-store-postgres.ts`:

```ts
/**
 * Postgres ceiling implementation of the SegmentStore contract (#183 E11.3). rule_json is JSONB,
 * enabled is BOOLEAN; child rows cascade on delete (FK ON DELETE CASCADE). Schema-qualified to
 * workwell_spike (SPIKE_SCHEMA).
 */
import type { PgPool } from "./pg-database.ts";
import { SPIKE_SCHEMA } from "./schema-pg.ts";
import type {
  CreateSegmentInput, HydratedSegment, SegmentOverride, SegmentRule, SegmentStore, UpdateSegmentPatch,
} from "../segment-store.ts";

const S = SPIKE_SCHEMA;

interface SegRow {
  id: string; name: string; description: string | null; enabled: boolean;
  rule_json: unknown; created_by: string | null; created_at: string; updated_at: string;
}

function parseRule(raw: unknown): SegmentRule {
  const r = (raw ?? {}) as Partial<SegmentRule>;
  return { match: r.match === "ALL" ? "ALL" : "ANY", conditions: Array.isArray(r.conditions) ? r.conditions : [] };
}

export class PgSegmentStore implements SegmentStore {
  constructor(private readonly pool: PgPool) {}

  private async hydrate(row: SegRow): Promise<HydratedSegment> {
    const ms = await this.pool.query<{ measure_id: string }>(`SELECT measure_id FROM ${S}.segment_measures WHERE segment_id = $1 ORDER BY measure_id ASC`, [row.id]);
    const ov = await this.pool.query<{ external_id: string; mode: string }>(`SELECT external_id, mode FROM ${S}.segment_overrides WHERE segment_id = $1 ORDER BY external_id ASC`, [row.id]);
    return {
      id: row.id, name: row.name, description: row.description ?? "", enabled: row.enabled === true,
      rule: parseRule(row.rule_json),
      measureIds: ms.rows.map((r) => r.measure_id),
      overrides: ov.rows.map((r) => ({ externalId: r.external_id, mode: r.mode === "INCLUDE" ? "INCLUDE" : "EXCLUDE" } as SegmentOverride)),
      createdBy: row.created_by ?? "", createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async listSegments(): Promise<HydratedSegment[]> {
    const { rows } = await this.pool.query<SegRow>(`SELECT * FROM ${S}.segments ORDER BY name ASC`);
    return Promise.all(rows.map((r) => this.hydrate(r)));
  }

  async getSegment(id: string): Promise<HydratedSegment | null> {
    const { rows } = await this.pool.query<SegRow>(`SELECT * FROM ${S}.segments WHERE id = $1`, [id]);
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  async createSegment(input: CreateSegmentInput): Promise<HydratedSegment> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO ${S}.segments (id, name, description, enabled, rule_json, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [id, input.name, input.description ?? null, input.enabled !== false, JSON.stringify(input.rule), null, now, now],
    );
    await this.setMeasures(id, input.measureIds);
    await this.setOverrides(id, input.overrides ?? []);
    return (await this.getSegment(id))!;
  }

  async updateSegment(id: string, patch: UpdateSegmentPatch): Promise<HydratedSegment | null> {
    const { rows } = await this.pool.query<SegRow>(`SELECT * FROM ${S}.segments WHERE id = $1`, [id]);
    const existing = rows[0];
    if (!existing) return null;
    const name = patch.name ?? existing.name;
    const description = patch.description !== undefined ? patch.description : existing.description;
    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const ruleJson = patch.rule !== undefined ? JSON.stringify(patch.rule) : JSON.stringify(parseRule(existing.rule_json));
    await this.pool.query(
      `UPDATE ${S}.segments SET name = $1, description = $2, enabled = $3, rule_json = $4::jsonb, updated_at = $5 WHERE id = $6`,
      [name, description, enabled, ruleJson, new Date().toISOString(), id],
    );
    return this.getSegment(id);
  }

  async deleteSegment(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${S}.segments WHERE id = $1`, [id]); // children cascade
  }

  async setMeasures(id: string, measureIds: string[]): Promise<void> {
    await this.pool.query(`DELETE FROM ${S}.segment_measures WHERE segment_id = $1`, [id]);
    for (const m of [...new Set(measureIds)]) {
      await this.pool.query(`INSERT INTO ${S}.segment_measures (segment_id, measure_id) VALUES ($1, $2)`, [id, m]);
    }
  }

  async setOverrides(id: string, overrides: SegmentOverride[]): Promise<void> {
    await this.pool.query(`DELETE FROM ${S}.segment_overrides WHERE segment_id = $1`, [id]);
    const seen = new Set<string>();
    for (const o of overrides) {
      if (seen.has(o.externalId)) continue;
      seen.add(o.externalId);
      await this.pool.query(`INSERT INTO ${S}.segment_overrides (segment_id, external_id, mode) VALUES ($1, $2, $3)`, [id, o.externalId, o.mode]);
    }
  }
}
```

> If `value-set-store-postgres.ts` uses a different pool method name/shape (e.g. `this.pool.query(...)` returns `{ rows }` — verify), match it exactly. Adjust `created_at`/`updated_at` handling if the ceiling returns `Date` objects vs strings (the `new Date(...).toISOString()` above is defensive either way).

- [ ] **Step 2: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend-ts/src/stores/postgres/segment-store-postgres.ts
git commit -m "feat(segments): Postgres ceiling SegmentStore adapter (#183)"
```

---

## Task 5: Wire into factory + store contract

**Files:**
- Modify: `backend-ts/src/stores/factory.ts`
- Modify: `backend-ts/src/stores/store-contract.ts`
- Modify: `backend-ts/src/stores/postgres/store-postgres.test.ts`

- [ ] **Step 1: Write the failing contract** — append `segmentStoreContract` to `backend-ts/src/stores/store-contract.ts` (add the import at the top: `import type { SegmentStore } from "./segment-store.ts";`):

```ts
/** Registers the SegmentStore contract for one backend. `freshStore` → isolated, empty. */
export function segmentStoreContract(label: string, freshStore: () => Promise<SegmentStore>): void {
  test(`[${label}] createSegment persists hydrated measures + overrides; listSegments reads back`, async () => {
    const store = await freshStore();
    const created = await store.createSegment({
      name: "OSHA Safety-Sensitive",
      description: "field roles",
      rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] },
      measureIds: ["audiogram", "hazwoper"],
      overrides: [{ externalId: "emp-001", mode: "INCLUDE" }],
    });
    assert.ok(created.id);
    assert.equal(created.enabled, true);
    assert.deepEqual(created.measureIds.sort(), ["audiogram", "hazwoper"]);
    assert.deepEqual(created.overrides, [{ externalId: "emp-001", mode: "INCLUDE" }]);
    assert.equal(created.rule.conditions[0]!.op, "contains");

    const all = await store.listSegments();
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], created);
  });

  test(`[${label}] getSegment returns null for unknown id`, async () => {
    const store = await freshStore();
    assert.equal(await store.getSegment(crypto.randomUUID()), null);
  });

  test(`[${label}] updateSegment patches enabled + rule, bumps nothing else; null for unknown`, async () => {
    const store = await freshStore();
    const s = await store.createSegment({ name: "X", rule: { match: "ANY", conditions: [] }, measureIds: ["flu_vaccine"] });
    const upd = await store.updateSegment(s.id, { enabled: false, rule: { match: "ALL", conditions: [{ attr: "site", op: "equals", value: "Clinic" }] } });
    assert.equal(upd!.enabled, false);
    assert.equal(upd!.rule.match, "ALL");
    assert.deepEqual(upd!.measureIds, ["flu_vaccine"], "measures untouched by updateSegment");
    assert.equal(await store.updateSegment(crypto.randomUUID(), { enabled: true }), null);
  });

  test(`[${label}] setMeasures/setOverrides replace; deleteSegment removes children`, async () => {
    const store = await freshStore();
    const s = await store.createSegment({ name: "Y", rule: { match: "ANY", conditions: [] }, measureIds: ["audiogram"] });
    await store.setMeasures(s.id, ["hazwoper", "tb_surveillance"]);
    await store.setOverrides(s.id, [{ externalId: "emp-002", mode: "EXCLUDE" }]);
    const after = await store.getSegment(s.id);
    assert.deepEqual(after!.measureIds.sort(), ["hazwoper", "tb_surveillance"]);
    assert.deepEqual(after!.overrides, [{ externalId: "emp-002", mode: "EXCLUDE" }]);
    await store.deleteSegment(s.id);
    assert.equal(await store.getSegment(s.id), null);
    assert.deepEqual(await store.listSegments(), []);
  });
}
```

- [ ] **Step 2: Register the contract for both backends.** In `backend-ts/src/stores/postgres/store-postgres.test.ts`, find where `valueSetStoreContract(...)` is called for the floor and the ceiling, and add an analogous `segmentStoreContract(...)` call right beside each, using the same `freshStore` factory pattern that constructs `new SqliteSegmentStore(db)` (floor) and `new PgSegmentStore(pool)` (ceiling) against a fresh, schema-initialized store. Import `segmentStoreContract` from `../store-contract.ts`, `SqliteSegmentStore` from `../sqlite/segment-store-sqlite.ts`, and `PgSegmentStore` from `./segment-store-postgres.ts`.

> Grep first: `grep -n "valueSetStoreContract" src/stores/postgres/store-postgres.test.ts` to copy the exact floor + ceiling registration shape (how it builds a fresh DB/pool and runs the DDL).

- [ ] **Step 3: Add `segments` to the `Stores` bundle** in `backend-ts/src/stores/factory.ts`:
  - Add imports: `import { SqliteSegmentStore } from "./sqlite/segment-store-sqlite.ts";`, `import { PgSegmentStore } from "./postgres/segment-store-postgres.ts";`, `import type { SegmentStore } from "./segment-store.ts";`.
  - Add to the `Stores` interface: `segments: SegmentStore;`.
  - In `buildPostgres`, add to the returned object: `segments: new PgSegmentStore(pool),`.
  - In `buildSqlite`, add to the returned object: `segments: new SqliteSegmentStore(db),`.

- [ ] **Step 4: Run the contract + typecheck**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: PASS — the `[sqlite]` segment contract tests run (the `[postgres]` ones self-skip without a local `postgres:16`, as the existing contract does).

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/stores/factory.ts backend-ts/src/stores/store-contract.ts backend-ts/src/stores/postgres/store-postgres.test.ts
git commit -m "feat(segments): wire SegmentStore into factory + store contract (#183)"
```

---

## Task 6: Demo-segment seed

**Files:**
- Create: `backend-ts/src/segment/segment-seed.ts`
- Modify: `backend-ts/src/routes/measures.ts`

- [ ] **Step 1: Implement** `backend-ts/src/segment/segment-seed.ts`:

```ts
/**
 * Demo risk-group seed (#183 E11.3). Idempotent by segment name: existing names are left untouched,
 * so re-running on boot is safe and operator edits are never clobbered. Seeds four cohorts mapping to
 * applicable rule-sets so the roster grid shows a meaningful applicable/N-A mix out of the box.
 */
import type { CreateSegmentInput, SegmentStore } from "../stores/segment-store.ts";

export const DEMO_SEGMENTS: CreateSegmentInput[] = [
  {
    name: "OSHA Safety-Sensitive",
    description: "Field roles in OSHA surveillance programs.",
    rule: { match: "ANY", conditions: [
      { attr: "role", op: "contains", value: "Welder" },
      { attr: "role", op: "contains", value: "Maintenance" },
      { attr: "role", op: "contains", value: "Hazwoper" },
      { attr: "role", op: "contains", value: "Industrial Hygienist" },
    ] },
    measureIds: ["audiogram", "hazwoper", "tb_surveillance"],
  },
  {
    name: "Clinical Staff",
    description: "Clinic-based and nursing staff (infection control + immunizations).",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "equals", value: "Clinic" },
      { attr: "role", op: "contains", value: "Nurse" },
    ] },
    measureIds: ["flu_vaccine", "tb_surveillance", "mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization"],
  },
  {
    name: "Office Staff",
    description: "Administrative roles — wellness program only.",
    rule: { match: "ANY", conditions: [
      { attr: "role", op: "contains", value: "Office" },
      { attr: "role", op: "in", value: ["Author", "Approver", "Admin", "Case Manager"] },
    ] },
    measureIds: ["hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl"],
  },
  {
    name: "All Employees",
    description: "Baseline immunization + wellness applicable to everyone.",
    rule: { match: "ANY", conditions: [
      { attr: "site", op: "in", value: ["HQ", "Plant A", "Plant B", "Clinic"] },
    ] },
    measureIds: ["mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization", "hypertension", "obesity_bmi"],
  },
];

/** Idempotently seed the demo segments — skips any whose name already exists. */
export async function seedSegments(store: SegmentStore): Promise<void> {
  const existing = new Set((await store.listSegments()).map((s) => s.name));
  for (const seg of DEMO_SEGMENTS) {
    if (existing.has(seg.name)) continue;
    await store.createSegment(seg);
  }
}
```

- [ ] **Step 2: Call the seed** in `backend-ts/src/routes/measures.ts`. Add the import beside the value-set seed import (line ~49):

```ts
import { seedSegments } from "../segment/segment-seed.ts";
```

Then inside the same seed block where `seedValueSets(...)` is awaited (the `seed` promise body around line 96), add after the `seedValueSets(...)` line:

```ts
        await seedSegments(stores.segments);
```

> Confirm `stores` is in scope at that point (the block already references `stores.valueSets`); use the same `stores` reference.

- [ ] **Step 3: Write a seed idempotency test** — append to (or create) `backend-ts/src/segment/segment-seed.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteSegmentStore } from "../stores/sqlite/segment-store-sqlite.ts";
import { seedSegments, DEMO_SEGMENTS } from "./segment-seed.ts";
import { freshSqliteDb } from "../stores/sqlite/test-helpers.ts"; // see note

test("seedSegments is idempotent by name", async () => {
  const db = await freshSqliteDb();
  const store = new SqliteSegmentStore(db);
  await seedSegments(store);
  await seedSegments(store);
  const all = await store.listSegments();
  assert.equal(all.length, DEMO_SEGMENTS.length);
  assert.ok(all.find((s) => s.name === "OSHA Safety-Sensitive"));
});
```

> **Note:** there may be no `test-helpers.ts`. Grep an existing sqlite store test (e.g. `grep -rln "new SqliteValueSetStore" src/stores`) to copy how it builds a fresh in-memory `CloudDatabase` with the floor DDL applied (likely an inline helper that runs `RUN_STORE_FLOOR_DDL` against a `@mieweb/cloud` in-memory DB). Reuse that exact helper instead of importing a non-existent module.

- [ ] **Step 4: Run + typecheck**

Run: `cd backend-ts && pnpm typecheck && node --test --experimental-strip-types src/segment/segment-seed.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend-ts/src/segment/segment-seed.ts backend-ts/src/segment/segment-seed.test.ts backend-ts/src/routes/measures.ts
git commit -m "feat(segments): idempotent demo-segment seed (#183)"
```

---

## Task 7: Roster applicability overlay + segment filter

**Files:**
- Modify: `backend-ts/src/compliance/roster-vocabulary.ts`
- Modify: `backend-ts/src/compliance/roster-read-model.ts`
- Modify: `backend-ts/src/compliance/roster-read-model.test.ts`
- Modify: `backend-ts/src/routes/compliance.ts`

- [ ] **Step 1: Add `NOT_APPLICABLE` to the vocabulary.** In `backend-ts/src/compliance/roster-vocabulary.ts`, extend the `DisplayState` union:

```ts
export type DisplayState =
  | "COMPLIANT" | "DUE_SOON" | "OVERDUE" | "MISSING_DATA" | "EXCLUDED" | "DECLINED" | "IN_PROGRESS" | "NA" | "NOT_APPLICABLE";
```

(Do **not** change `deriveCell` — `NOT_APPLICABLE` is applied by the read model, which knows the segments; `deriveCell` does not.)

- [ ] **Step 2: Write the failing read-model test.** In `backend-ts/src/compliance/roster-read-model.test.ts`, add tests. First read the existing test to copy how it builds `RosterDeps` + seeds outcomes; then add:

```ts
test("applicability overlay: out-of-cohort measure cell becomes NOT_APPLICABLE", async () => {
  // Arrange: an outcomeStore with a COMPLIANT mmr outcome for emp-001 in a completed population run,
  // and a single enabled segment whose rule-set does NOT include mmr but matches emp-001.
  // (Reuse the existing test's outcome-seeding helper.)
  const deps = await freshRosterDepsWithMmrCompliantFor("emp-001"); // existing-style helper
  const segments = [{
    id: "s", name: "Office", description: "", enabled: true,
    rule: { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Author" }] },
    measureIds: ["hypertension"], overrides: [], createdBy: "x", createdAt: "t", updatedAt: "t",
  }];
  const roster = await buildRoster({ ...deps, segments }, { panel: "immunizations", pageSize: 200 });
  const row = roster.rows.find((r) => r.subject.externalId === "emp-001")!;
  assert.equal(row.cells["mmr"].status, "NOT_APPLICABLE", "mmr not in emp-001's segment rule-set");
});

test("applicability fallback: no enabled segments ⇒ outcome cell unchanged (reversibility)", async () => {
  const deps = await freshRosterDepsWithMmrCompliantFor("emp-001");
  const roster = await buildRoster({ ...deps, segments: [] }, { panel: "immunizations", pageSize: 200 });
  const row = roster.rows.find((r) => r.subject.externalId === "emp-001")!;
  assert.equal(row.cells["mmr"].status, "COMPLIANT");
});

test("segment filter: scopes rows to cohort members and columns to the rule-set", async () => {
  const deps = await freshRosterDepsWithMmrCompliantFor("emp-001");
  const segments = [{
    id: "s1", name: "Clinical", description: "", enabled: true,
    rule: { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Author" }] },
    measureIds: ["mmr"], overrides: [], createdBy: "x", createdAt: "t", updatedAt: "t",
  }];
  const roster = await buildRoster({ ...deps, segments }, { segment: "s1", pageSize: 200 });
  assert.deepEqual(roster.columns.map((c) => c.measureId), ["mmr"]);
  assert.ok(roster.rows.every((r) => r.subject.role.includes("Author")));
});
```

> Adapt `freshRosterDepsWithMmrCompliantFor` to whatever the existing test already does to seed a completed population run + outcome (it must — the file already tests cells). If the existing test seeds via a real `SqliteOutcomeStore`, reuse that; pass `segments: []` for existing tests so they keep passing.

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend-ts && node --test --experimental-strip-types src/compliance/roster-read-model.test.ts`
Expected: FAIL — `segments` not accepted on `RosterDeps`; `segment` not accepted on `RosterFilters`.

- [ ] **Step 4: Implement the overlay + filter** in `backend-ts/src/compliance/roster-read-model.ts`:
  - Add imports: `import { isApplicable, matchesCohort } from "../segment/segment-applicability.ts";` and `import type { HydratedSegment } from "../stores/segment-store.ts";`.
  - Add `segments: HydratedSegment[];` to `RosterDeps`.
  - Add `segment?: string | null;` to `RosterFilters`.
  - At the start of `buildRoster`, after resolving `panel`, resolve an optional active segment and the effective `measureIds`:

```ts
  const segments = deps.segments ?? [];
  const activeSegment = filters.segment ? segments.find((s) => s.id === filters.segment) ?? null : null;
```

  - When `activeSegment` is set, override `measureIds` to the segment's rule-set (intersected with Active runnable measures) **instead of** the panel set:

```ts
  const measureIds = activeSegment
    ? activeSegment.measureIds.filter((m) => active.has(m))
    : PANELS[panel].filter((m) => active.has(m));
```

  - In the row-assembly loop (step 3 of the existing code), after computing `cells[m]`, apply the overlay; and when an `activeSegment` is set, also filter rows to its members. Concretely, replace the existing `rows` build with:

```ts
  let rows: RosterRow[] = EMPLOYEES.map((emp) => {
    const cells: Record<string, RosterCell> = {};
    for (const m of measureIds) {
      const base = cellByMeasureSubject.get(m)?.get(emp.externalId) ?? { status: "NA", method: "Not evaluated" };
      cells[m] = isApplicable(emp, m, segments)
        ? base
        : { status: "NOT_APPLICABLE", method: "Not applicable (no matching group)" };
    }
    return { subject: { externalId: emp.externalId, name: emp.name, role: emp.role, site: emp.site }, cells };
  });
  if (activeSegment) {
    rows = rows.filter((r) => {
      const emp = employeeById(r.subject.externalId);
      return emp ? matchesCohort(emp, activeSegment) : false;
    });
  }
```

  (Add `employeeById` to the existing `employee-catalog` import.)

- [ ] **Step 5: Pass segments from the route.** In `backend-ts/src/routes/compliance.ts`:
  - Load segments: after `const stores = await getStores(env);`, add `const segments = await stores.segments.listSegments();`.
  - Pass them into `buildRoster`: change `{ outcomeStore: stores.outcomes }` to `{ outcomeStore: stores.outcomes, segments }`.
  - Add the `segment` filter: add `segment: q.get("segment"),` to the filters object.

- [ ] **Step 6: Run the tests + typecheck**

Run: `cd backend-ts && pnpm typecheck && node --test --experimental-strip-types src/compliance/roster-read-model.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/compliance/roster-vocabulary.ts backend-ts/src/compliance/roster-read-model.ts backend-ts/src/compliance/roster-read-model.test.ts backend-ts/src/routes/compliance.ts
git commit -m "feat(segments): roster applicability N/A overlay + segment filter (#183)"
```

---

## Task 8: Run-pipeline case gating

**Files:**
- Modify: `backend-ts/src/run/run-pipeline.ts`
- Modify: `backend-ts/src/run/run-pipeline.test.ts`
- Modify: `backend-ts/src/routes/runs.ts`

- [ ] **Step 1: Write the failing test.** In `backend-ts/src/run/run-pipeline.test.ts`, add (reuse the file's existing helpers that build `RunPipelineDeps` with a real `SqliteCaseStore`/`SqliteOutcomeStore` + a stub engine):

```ts
test("case gating: an out-of-cohort non-compliant outcome persists the outcome but creates NO case", async () => {
  // engine stub forces OVERDUE; one enabled segment whose rule-set excludes the measure for this employee.
  const deps = await freshPipelineDepsForcing("OVERDUE"); // existing-style helper returns {runStore,outcomeStore,caseStore,engine}
  const segments = [{
    id: "s", name: "Welders only", description: "", enabled: true,
    rule: { match: "ANY" as const, conditions: [{ attr: "role" as const, op: "contains" as const, value: "Welder" }] },
    measureIds: ["audiogram"], overrides: [], createdBy: "x", createdAt: "t", updatedAt: "t",
  }];
  // emp-007 is "Office Staff" (not a Welder) → audiogram not applicable.
  await executeManualRun({ ...deps, segments, employees: [office007()] }, { scopeType: "EMPLOYEE", employeeExternalId: "emp-007" });
  const cases = await deps.caseStore.listOpenCases(); // use the store's actual list method
  assert.equal(cases.find((c) => c.measureId === "audiogram" && c.employeeId === "emp-007"), undefined, "no case for non-applicable measure");
  // outcome WAS persisted (ADR-008)
  // ...assert via outcomeStore that an OVERDUE audiogram outcome exists for emp-007.
});

test("case gating: zero enabled segments ⇒ case created as today (reversibility)", async () => {
  const deps = await freshPipelineDepsForcing("OVERDUE");
  await executeManualRun({ ...deps, segments: [], employees: [office007()] }, { scopeType: "EMPLOYEE", employeeExternalId: "emp-007" });
  const cases = await deps.caseStore.listOpenCases();
  assert.ok(cases.find((c) => c.measureId === "audiogram" && c.employeeId === "emp-007"), "case created when no segments");
});
```

> Adapt helper names to the file's existing patterns. `office007()` returns the `EmployeeProfile` for emp-007 from `EMPLOYEES` (`employeeById("emp-007")!`). Use the `CaseStore`'s real list method (grep the interface — likely `listOpenCases` or `listCases`).

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend-ts && node --test --experimental-strip-types src/run/run-pipeline.test.ts`
Expected: FAIL — `segments` not accepted on `RunPipelineDeps`.

- [ ] **Step 3: Implement the gate** in `backend-ts/src/run/run-pipeline.ts`:
  - Add imports: `import { isApplicable } from "../segment/segment-applicability.ts";` and `import type { HydratedSegment } from "../stores/segment-store.ts";`.
  - Add to `RunPipelineDeps`: `/** Enabled segments for case-creation applicability gating; empty/absent ⇒ all applicable. */ segments?: HydratedSegment[];`.
  - In `finishManualRun`, replace the unconditional case upsert (the `await deps.caseStore?.upsertFromOutcome({...})` block) with an applicability-gated version:

```ts
    // Idempotent case upsert — gated by segment applicability (#183 E11.3): an out-of-cohort
    // (subject, measure) does NOT create/upsert a case. The outcome above is ALWAYS persisted
    // (CQL stays the sole compliance authority — ADR-008). Empty/absent segments ⇒ all applicable.
    if (deps.caseStore && isApplicable(item.employee, item.measureId, deps.segments ?? [])) {
      await deps.caseStore.upsertFromOutcome({
        runId: run.id,
        subjectId: item.employee.externalId,
        measureId: item.measureId,
        evaluationPeriod: period,
        outcomeStatus: status,
      });
    }
```

- [ ] **Step 4: Load segments into the run deps** in `backend-ts/src/routes/runs.ts`. Where the manual-run and rerun `deps` objects are built (the `{ runStore, outcomeStore, caseStore, engine }` literals), add `segments`. Add a small loader near the other store helpers:

```ts
async function enabledSegments(env: RunsEnv): Promise<HydratedSegment[]> {
  const all = await (await getStores(env)).segments.listSegments();
  return all.filter((s) => s.enabled);
}
```

Add the import `import type { HydratedSegment } from "../stores/segment-store.ts";`. Then in BOTH deps constructions (the `/api/runs/manual` handler and the `/api/runs/:id/rerun` non-CASE handler), add `segments: await enabledSegments(env),` to the deps literal.

> The CASE rerun path (`rerunToVerify`) is single-subject verification and does not create new cases via this seam — leave it unchanged.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd backend-ts && pnpm typecheck && node --test --experimental-strip-types src/run/run-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/run/run-pipeline.ts backend-ts/src/run/run-pipeline.test.ts backend-ts/src/routes/runs.ts
git commit -m "feat(segments): gate case creation by segment applicability in the run pipeline (#183)"
```

---

## Task 9: `/api/segments` CRUD + preview route

**Files:**
- Create: `backend-ts/src/routes/segments.ts`
- Create: `backend-ts/src/routes/segments.test.ts`
- Modify: `backend-ts/src/auth/authorize.ts`
- Modify: `backend-ts/src/worker.ts`

- [ ] **Step 1: Add the authorization rule.** In `backend-ts/src/auth/authorize.ts`, add these BEFORE the generic `{ method: "GET", pattern: rx("/api/**"), ... }` rules (place beside the `/api/campaigns` / `/api/orders` rules):

```ts
  // Segments (#183 E11.3) — risk-group config. Writes are ADMIN; reads (list + preview) fall through
  // to the AUTHENTICATED /api/** rule (the roster + admin editor both read them).
  { method: "POST", pattern: rx("/api/segments/**"), access: [A] },
  { method: "PUT", pattern: rx("/api/segments/**"), access: [A] },
  { method: "DELETE", pattern: rx("/api/segments/**"), access: [A] },
```

- [ ] **Step 2: Write the failing route test** `backend-ts/src/routes/segments.test.ts` (mirror the structure of an existing route test — e.g. `compliance.test.ts` — for how it builds `env` + calls the handler; segments needs an `actor` arg):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSegments } from "./segments.ts";
import { freshEnv } from "./test-helpers.ts"; // see note — reuse existing route-test env builder

const actor = "admin@workwell.dev";
const req = (method: string, path: string, body?: unknown) =>
  new Request(`http://api${path}`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });

test("POST then GET /api/segments round-trips; preview resolves members", async () => {
  const env = await freshEnv();
  const created = await handleSegments(req("POST", "/api/segments", {
    name: "Welders", rule: { match: "ANY", conditions: [{ attr: "role", op: "contains", value: "Welder" }] },
    measureIds: ["audiogram"],
  }), env, actor);
  assert.equal(created!.status, 201);
  const body = await created!.json() as { id: string };
  assert.ok(body.id);

  const list = await handleSegments(req("GET", "/api/segments"), env, actor);
  const arr = await list!.json() as unknown[];
  assert.ok(arr.length >= 1);

  const preview = await handleSegments(req("GET", `/api/segments/${body.id}/preview`), env, actor);
  const p = await preview!.json() as { count: number; members: string[] };
  assert.ok(p.count > 0, "Welder rule resolves some directory members");
});

test("returns null for non-segment paths (so the worker falls through)", async () => {
  const env = await freshEnv();
  assert.equal(await handleSegments(req("GET", "/api/cases"), env, actor), null);
});
```

> **Note:** if there's no `test-helpers.ts`, grep an existing route test (`grep -rln "DATABASE_URL" src/routes/*.test.ts`) for how it builds an in-memory `env` (a `{ DB }` with the floor DDL applied). Reuse that pattern; the route uses `getStores(env)` so the env only needs `DB` (floor).

- [ ] **Step 3: Run to verify it fails**

Run: `cd backend-ts && node --test --experimental-strip-types src/routes/segments.test.ts`
Expected: FAIL — `Cannot find module './segments.ts'`.

- [ ] **Step 4: Implement** `backend-ts/src/routes/segments.ts`:

```ts
/**
 * Segments route (#183 E11.3) — risk-group CRUD + a membership preview. Writes (POST/PUT/DELETE) are
 * ADMIN-gated in authorize.ts; GET list + preview fall through to AUTHENTICATED. Every write emits a
 * SEGMENT_* audit event (CLAUDE.md hard rule). Segments configure applicability only — never compliance
 * (ADR-016).
 *
 *   GET    /api/segments                 → HydratedSegment[]
 *   GET    /api/segments/:id/preview     → { count, members: externalId[] }
 *   POST   /api/segments                 → 201 HydratedSegment   (+ SEGMENT_CREATED)
 *   PUT    /api/segments/:id             → 200 HydratedSegment   (+ SEGMENT_UPDATED) | 404
 *   DELETE /api/segments/:id             → 204                   (+ SEGMENT_DELETED) | 404
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { matchesCohort } from "../segment/segment-applicability.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import type { CreateSegmentInput, SegmentOverride, UpdateSegmentPatch } from "../stores/segment-store.ts";

interface SegmentsEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function audit(env: SegmentsEnv, eventType: string, id: string, actor: string, payload: Record<string, unknown>): Promise<void> {
  const stores = await getStores(env);
  await stores.events.appendAudit({
    eventType, entityType: "segment", entityId: id, actor,
    refRunId: null, refCaseId: null, refMeasureVersionId: null, payload,
  });
}

export async function handleSegments(req: Request, env: SegmentsEnv, actor: string): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (!path.startsWith("/api/segments")) return null;

  const stores = await getStores(env);
  const store = stores.segments;

  // GET /api/segments
  if (req.method === "GET" && path === "/api/segments") {
    return json(await store.listSegments());
  }

  // GET /api/segments/:id/preview
  const previewMatch = path.match(/^\/api\/segments\/([^/]+)\/preview$/);
  if (req.method === "GET" && previewMatch) {
    const seg = await store.getSegment(previewMatch[1]!);
    if (!seg) return json({ error: "not_found" }, 404);
    const members = EMPLOYEES.filter((e) => matchesCohort(e, seg)).map((e) => e.externalId);
    return json({ count: members.length, members });
  }

  // POST /api/segments
  if (req.method === "POST" && path === "/api/segments") {
    const body = (await req.json().catch(() => ({}))) as Partial<CreateSegmentInput>;
    if (!body.name || !body.rule || !Array.isArray(body.measureIds)) {
      return json({ error: "invalid_request", message: "name, rule, measureIds are required" }, 400);
    }
    const created = await store.createSegment({
      name: body.name, description: body.description, enabled: body.enabled,
      rule: body.rule, measureIds: body.measureIds, overrides: body.overrides ?? [],
    });
    await audit(env, "SEGMENT_CREATED", created.id, actor, { name: created.name, measureIds: created.measureIds });
    return json(created, 201);
  }

  // PUT /api/segments/:id
  const idMatch = path.match(/^\/api\/segments\/([^/]+)$/);
  if (req.method === "PUT" && idMatch) {
    const id = idMatch[1]!;
    const body = (await req.json().catch(() => ({}))) as Partial<CreateSegmentInput> & { overrides?: SegmentOverride[] };
    const patch: UpdateSegmentPatch = { name: body.name, description: body.description, enabled: body.enabled, rule: body.rule };
    const updated = await store.updateSegment(id, patch);
    if (!updated) return json({ error: "not_found" }, 404);
    if (Array.isArray(body.measureIds)) await store.setMeasures(id, body.measureIds);
    if (Array.isArray(body.overrides)) await store.setOverrides(id, body.overrides);
    const hydrated = (await store.getSegment(id))!;
    await audit(env, "SEGMENT_UPDATED", id, actor, { name: hydrated.name, enabled: hydrated.enabled, measureIds: hydrated.measureIds });
    return json(hydrated, 200);
  }

  // DELETE /api/segments/:id
  if (req.method === "DELETE" && idMatch) {
    const id = idMatch[1]!;
    const existing = await store.getSegment(id);
    if (!existing) return json({ error: "not_found" }, 404);
    await store.deleteSegment(id);
    await audit(env, "SEGMENT_DELETED", id, actor, { name: existing.name });
    return new Response(null, { status: 204 });
  }

  return null;
}
```

- [ ] **Step 5: Register in the worker.** In `backend-ts/src/worker.ts`, add the import near the other route imports:

```ts
import { handleSegments } from "./routes/segments.ts";
```

And add the dispatch beside `handleCompliance` (it takes `actor`, like `handleCases`):

```ts
  // Segments — risk-group CRUD + membership preview (#183 E11.3).
  const segmentsResponse = await handleSegments(req, env, actor);
  if (segmentsResponse) return segmentsResponse;
```

> Place it BEFORE `handleCompliance` so `/api/segments/:id/preview` is matched here, and ensure it's within the authenticated section (after `actor` is resolved). Confirm `actor` is the same variable passed to `handleCases`.

- [ ] **Step 6: Run tests + typecheck + full suite**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: PASS (all suites; the new route + contract + engine tests green; Pg-ceiling contract self-skips).

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/routes/segments.ts backend-ts/src/routes/segments.test.ts backend-ts/src/auth/authorize.ts backend-ts/src/worker.ts
git commit -m "feat(segments): /api/segments CRUD + preview route, ADMIN-gated + audited (#183)"
```

---

## Task 10: ADR-016 + docs

**Files:**
- Modify: `docs/DECISIONS.md` (prepend ADR-016 above ADR-015)
- Modify: `docs/DATA_MODEL.md`, `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`

- [ ] **Step 1: Add ADR-016** at the top of `docs/DECISIONS.md` (above `## ADR-015`):

```markdown
## ADR-016: Segments / risk-groups are an applicability layer, not a compliance authority — E11.3 (#183)

Date: 2026-06-25
Status: Accepted

**Decision.** A *segment* (risk-group) maps a cohort (a `role`/`site` predicate rule + per-employee
INCLUDE/EXCLUDE overrides) to an applicable rule-set (measure ids). Applicability gates **case creation**
(the run→case upsert) and **display** (the roster N/A overlay + the per-employee card) only. It NEVER
changes CQL evaluation or `Outcome Status` — CQL stays the sole compliance authority (ADR-008). The
outcome is always persisted with full evidence even when no case is created.

**Reversibility invariant.** Zero ENABLED segments ⇒ every measure is applicable to everyone (= the
pre-E11.3 behavior). Disabling/deleting all segments fully reverts the feature, so it is a safe additive
overlay. Persisted in 3 owner-gated tables (`segments`, `segment_measures`, `segment_overrides`) on the
floor + ceiling; the single applicability definition lives in `segment-applicability.ts`.

**Scope.** Predicates are `role`/`site` only for now; richer (FHIR-data, program-enrollment) predicates
and WebChart-group import are deferred to later epics. The Configure Groups editor UI is E11.3 PR-2.
```

- [ ] **Step 2: Update `docs/DATA_MODEL.md`** — add a section (e.g. §3.22) documenting the 3 tables (columns as in Task 0) and noting "applicability gates case creation + display only; reversible; ADR-016".

- [ ] **Step 3: Update `docs/ARCHITECTURE.md`** — add `segment` to the backend module list (the applicability engine + store + route), note the roster `NOT_APPLICABLE` overlay + `?segment=` filter on `/api/compliance/roster`, the run-pipeline case-gating runtime invariant ("applicability gates case creation; the outcome is always persisted — ADR-016"), and the `GET/POST/PUT/DELETE /api/segments` external interface (ADMIN writes; reads authenticated).

- [ ] **Step 4: Add a `docs/JOURNAL.md` entry** (newest on top, dated 2026-06-25) summarizing E11.3 PR-1: the 3-table segment model, the pure applicability engine, roster N/A overlay + segment filter, run-pipeline case-gating, the seed, ADR-016; PR-2 = Configure Groups UI; backend suite green. **Note (decided at the whole-branch review):** the demo seed ships ENABLED, so the overlay goes live on the demo on first deploy (deliberate, covers every Active measure); the reversibility property still holds (disable/delete all segments ⇒ pre-E11.3 behavior).

- [ ] **Step 5: Commit**

```bash
git add docs/DECISIONS.md docs/DATA_MODEL.md docs/ARCHITECTURE.md docs/JOURNAL.md
git commit -m "docs(segments): ADR-016 + DATA_MODEL/ARCHITECTURE/JOURNAL for E11.3 PR-1 (#183)"
```

---

## Task 11: Full verification + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Full backend verification**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: typecheck clean; all tests pass (the new `[sqlite]` segment contract, applicability, roster, run-gating, seed, and route tests green; the `[postgres]` contract self-skips without a local `postgres:16`). Capture the pass/total count.

- [ ] **Step 2: Sanity-run the headless evaluator is unaffected** (segments don't touch CQL):

Run: `cd backend-ts && pnpm evaluate --patient ./spike/synthetic/<an existing fixture>.json --measure hepatitis_b_vaccination_series` (use an existing fixture path — grep `spike/synthetic`).
Expected: an unchanged `MeasureOutcome` (segments are not on the evaluation path).

- [ ] **Step 3: Code review (whole branch diff).** Per the maintainer's standing rule, run `superpowers:code-reviewer` over the entire PR-1 diff (`git diff main...feat/e11-3-segments`) before opening the PR. Address findings.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin feat/e11-3-segments
gh pr create --title "E11.3 PR-1 — segments/risk-groups backend (cohort→rule-set, applicability N/A + case-gating) (#183)" --body "<summary + reversibility note + 'PR-2 = Configure Groups UI' + Generated-with footer>"
```

Expected: CI green. Do NOT merge — the maintainer reviews + merges (CLAUDE.md).

---

## Self-Review (completed by plan author)

**Spec coverage:** §4 data model → Task 0. §5 predicate → Task 1 (`matchesRule`). §6 engine → Task 1. §7 store → Tasks 2–5. §8 roster overlay + filter + `NOT_APPLICABLE` → Task 7. §9 case-gating → Task 8. §10 API + audit → Task 9 (per-case display §5 inherits via the roster path — no separate task, as designed). §12 ADR → Task 10. §13 seed → Task 6. §14 testing → embedded per task. §15 PR-1 boundary → this whole plan (PR-2 frontend is a separate plan). §11 Configure Groups editor → **out of scope for PR-1** (PR-2). ✅

**Placeholder scan:** Helper names in test steps (`freshRosterDepsWithMmrCompliantFor`, `freshPipelineDepsForcing`, `freshEnv`) are flagged with explicit "grep the existing test to copy the real helper" notes because the exact helper shape lives in files the executor will open — these are pointers, not blanks. All production code is shown in full.

**Type consistency:** `HydratedSegment`/`SegmentRule`/`SegmentCondition`/`SegmentOverride`/`CreateSegmentInput`/`UpdateSegmentPatch` defined once (Task 1) and used identically in the store (2–5), engine (1), roster (7), pipeline (8), route (9). `isApplicable`/`matchesCohort`/`matchesRule`/`applicableMeasures` signatures match across consumers. `NOT_APPLICABLE` added to `DisplayState` (Task 7) before use.
