# E4 — Multi-level Dashboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drill from enterprise → location → provider → patient on the `/programs` dashboard with rollups that reconcile (parent totals = Σ children) at every level.

**Architecture:** No SQL. The workforce is the static synthetic directory (`employee-catalog.ts`); we add a `providerId` to each employee and a small `PROVIDERS` roster (2 occupational-health clinicians per location), then resolve the hierarchy at read-time exactly like `site`/`role` today. A new `hierarchy-rollup` read-model aggregates the same outcome rows `programOverview` uses into a node tree, exposed at `GET /api/hierarchy/rollup`. The frontend renders a nested expandable semantic table.

**Tech Stack:** TypeScript (`backend-ts`, node:test + tsx), `@mieweb/cloud` worker routes, SQLite floor for tests, Next.js 16 App Router + React 19 (frontend).

**Branch:** `feat/issue-74-multi-level-dashboards` (already created).

**Spec:** `docs/superpowers/specs/2026-06-18-e4-multi-level-dashboards-design.md`

---

## File Structure

- `backend-ts/src/engine/synthetic/employee-catalog.ts` — **modify**: add `Provider` type, `PROVIDERS` (8), `ENTERPRISE`, `providerId` on every employee (derived round-robin), `providerById`, `providersForLocation`.
- `backend-ts/src/engine/synthetic/employee-catalog.test.ts` — **modify**: directory-integrity assertions for the new hierarchy.
- `backend-ts/src/program/hierarchy-rollup.ts` — **create**: `buildHierarchyRollup` + types.
- `backend-ts/src/program/hierarchy-rollup.test.ts` — **create**: reconciliation + correctness + scope-filter tests.
- `backend-ts/src/routes/hierarchy.ts` — **create**: `GET /api/hierarchy/rollup`.
- `backend-ts/src/routes/hierarchy.test.ts` — **create**: route test (shape, reconciliation through API, filters).
- `backend-ts/src/worker.ts` — **modify**: register `handleHierarchy`.
- `frontend/app/(dashboard)/programs/hierarchy/page.tsx` — **create**: drill-down view.
- `frontend/app/(dashboard)/programs/page.tsx` — **modify**: add a "View hierarchy" link.
- Docs — **modify**: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/JOURNAL.md`, `docs/DECISIONS.md`, `README.md`, `CLAUDE.md`.

---

## Task 1: Hierarchy in the synthetic directory

**Files:**
- Modify: `backend-ts/src/engine/synthetic/employee-catalog.ts`
- Test: `backend-ts/src/engine/synthetic/employee-catalog.test.ts`

- [ ] **Step 1: Read the current file and its test** to preserve the existing 100-employee literal and the existing test cases verbatim.

Run: `node --import tsx --test backend-ts/src/engine/synthetic/employee-catalog.test.ts`
Expected: PASS (baseline before changes).

- [ ] **Step 2: Write the failing integrity test** — append these tests to `employee-catalog.test.ts` (keep existing tests):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPLOYEES, PROVIDERS, ENTERPRISE, providerById, providersForLocation,
} from "./employee-catalog.ts";

test("every employee is attributed to a provider at the SAME location", () => {
  for (const e of EMPLOYEES) {
    const p = providerById(e.providerId);
    assert.ok(p, `employee ${e.externalId} has unresolved provider ${e.providerId}`);
    assert.equal(p!.location, e.site, `provider ${p!.id} location must equal employee ${e.externalId} site`);
  }
});

test("PROVIDERS: unique ids, 2 per location, every employee site is covered", () => {
  const ids = PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "provider ids unique");
  const sites = [...new Set(EMPLOYEES.map((e) => e.site))];
  for (const site of sites) {
    assert.ok(providersForLocation(site).length >= 1, `location ${site} has >=1 provider`);
  }
});

test("ENTERPRISE is the single tenant root", () => {
  assert.equal(ENTERPRISE.id, "twh");
  assert.ok(ENTERPRISE.name.length > 0);
});

test("provider attribution is deterministic (stable across imports)", () => {
  const first = EMPLOYEES.map((e) => `${e.externalId}:${e.providerId}`).join(",");
  // Re-derive via the same helper to prove no randomness crept in.
  for (const e of EMPLOYEES) assert.equal(providerById(e.providerId)!.location, e.site);
  assert.ok(first.includes("emp-006:"));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --import tsx --test backend-ts/src/engine/synthetic/employee-catalog.test.ts`
Expected: FAIL — `PROVIDERS`/`ENTERPRISE`/`providerById`/`providersForLocation` not exported; `e.providerId` undefined.

- [ ] **Step 4: Implement the hierarchy.** In `employee-catalog.ts`:

  a. Add `providerId` to the interface:

```ts
export interface EmployeeProfile {
  externalId: string;
  name: string;
  role: string;
  site: string;        // = location level
  providerId: string;  // attributed provider (an entry in PROVIDERS), at the same `site`
}

export interface Provider {
  id: string;
  name: string;
  location: string; // one of the employee `site` values
}

/** Single-tenant enterprise root for the multi-level dashboard hierarchy (#74 E4). */
export const ENTERPRISE = { id: "twh", name: "Total Worker Health" } as const;

/** Synthetic occupational-health clinicians — 2 per location (provider level, #74 E4). */
export const PROVIDERS: readonly Provider[] = [
  { id: "prov-001", name: "Dr. Sara Mahmood", location: "Plant A" },
  { id: "prov-002", name: "NP Kamran Sheikh", location: "Plant A" },
  { id: "prov-003", name: "Dr. Lubna Aziz", location: "Plant B" },
  { id: "prov-004", name: "NP Faisal Dar", location: "Plant B" },
  { id: "prov-005", name: "Dr. Hina Qureshi", location: "HQ" },
  { id: "prov-006", name: "NP Bilal Mansoor", location: "HQ" },
  { id: "prov-007", name: "Dr. Ayesha Raza", location: "Clinic" },
  { id: "prov-008", name: "NP Tariq Saleem", location: "Clinic" },
];
```

  b. Rename the existing 100-row literal from `export const EMPLOYEES: readonly EmployeeProfile[] = [ ... ]` to a base list **without** `providerId`, then derive `EMPLOYEES`. Keep all 100 rows exactly as they are:

```ts
type EmployeeBase = Omit<EmployeeProfile, "providerId">;

const EMPLOYEE_BASE: readonly EmployeeBase[] = [
  // ...the existing 100 rows, unchanged (externalId/name/role/site)...
];

const PROVIDERS_BY_LOCATION = new Map<string, Provider[]>();
for (const p of PROVIDERS) {
  (PROVIDERS_BY_LOCATION.get(p.location) ?? PROVIDERS_BY_LOCATION.set(p.location, []).get(p.location)!).push(p);
}
for (const list of PROVIDERS_BY_LOCATION.values()) list.sort((a, b) => a.id.localeCompare(b.id));

/** Providers serving a location (sorted by id); [] for an unknown location. */
export function providersForLocation(location: string): Provider[] {
  return PROVIDERS_BY_LOCATION.get(location) ?? [];
}

/**
 * Deterministic round-robin: within each site, employees sorted by externalId are spread
 * across that site's providers in id order. Pure function of the inputs — no randomness —
 * so attribution is stable across runs/imports (required by the reconciliation tests).
 */
function assignProviders(base: readonly EmployeeBase[]): EmployeeProfile[] {
  const bySite = new Map<string, EmployeeBase[]>();
  for (const e of base) (bySite.get(e.site) ?? bySite.set(e.site, []).get(e.site)!).push(e);
  const out = new Map<string, string>(); // externalId -> providerId
  for (const [site, emps] of bySite) {
    const providers = providersForLocation(site);
    const sorted = [...emps].sort((a, b) => a.externalId.localeCompare(b.externalId));
    sorted.forEach((e, i) => {
      // Fallback to a synthetic site-provider id if a site somehow has no provider roster.
      const pid = providers.length ? providers[i % providers.length]!.id : `prov-${site}`;
      out.set(e.externalId, pid);
    });
  }
  return base.map((e) => ({ ...e, providerId: out.get(e.externalId)! }));
}

export const EMPLOYEES: readonly EmployeeProfile[] = assignProviders(EMPLOYEE_BASE);

const BY_ID = new Map<string, EmployeeProfile>(EMPLOYEES.map((e) => [e.externalId, e]));
const PROVIDER_BY_ID = new Map<string, Provider>(PROVIDERS.map((p) => [p.id, p]));

export function employeeById(externalId: string): EmployeeProfile | null {
  return BY_ID.get(externalId) ?? null;
}

/** Lookup a provider by id; null when unknown. */
export function providerById(id: string): Provider | null {
  return PROVIDER_BY_ID.get(id) ?? null;
}
```

  Note: every existing `site` value (`HQ`, `Plant A`, `Plant B`, `Clinic`) has a provider in `PROVIDERS`, so the `prov-${site}` fallback never fires for the seeded directory — it only guards against a future site with no roster.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test backend-ts/src/engine/synthetic/employee-catalog.test.ts`
Expected: PASS (existing + new tests).

- [ ] **Step 6: Typecheck**

Run: `cd backend-ts && pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/engine/synthetic/employee-catalog.ts backend-ts/src/engine/synthetic/employee-catalog.test.ts
git commit -m "feat(engine): #93 E4.1 — provider/enterprise hierarchy in the synthetic directory"
```

---

## Task 2: Hierarchy rollup read-model

**Files:**
- Create: `backend-ts/src/program/hierarchy-rollup.ts`
- Test: `backend-ts/src/program/hierarchy-rollup.test.ts`

Background the implementer must honor (read `program-read-models.ts` first):
- Count only **population** runs: `runScopeType` not in `{CASE, EMPLOYEE}` (the `isPopulationRun` rule).
- Per measure, count only the **latest** population run's outcomes (max `runStartedAt` group) — the same "best run" selection as `programOverview`.
- Active measures = `MEASURE_CATALOG.filter(m => m.status === "Active")`.
- `complianceRate = round1(compliant, evaluated)` = `total === 0 ? 0 : Math.round((compliant/total)*1000)/10`.
- Subjects that don't resolve via `employeeById` cannot be placed in the tree and are **skipped** (the synthetic directory is the universe). Document this.

- [ ] **Step 1: Write the failing test** — `backend-ts/src/program/hierarchy-rollup.test.ts`:

```ts
/**
 * Hierarchy rollup (#74 E4): seed outcomes/cases via the floor stores, then assert the
 * enterprise→location→provider→patient tree reconciles (parent totals = Σ children) at every
 * level and computes per-level complianceRate/openCases correctly.
 *   node --import tsx --test src/program/hierarchy-rollup.test.ts
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
import { buildHierarchyRollup, type HierarchyNode } from "./hierarchy-rollup.ts";

const dbPath = join(tmpdir(), `workwell-hier-${crypto.randomUUID()}.sqlite`);
let outcomes: SqliteOutcomeStore;
let cases: SqliteCaseStore;

const COUNT_KEYS = ["evaluated", "compliant", "dueSoon", "overdue", "missingData", "excluded", "openCases"] as const;

/** Assert parent count totals equal the sum of children, recursively, and rate is consistent. */
function assertReconciles(node: HierarchyNode): void {
  if (node.children.length > 0) {
    for (const k of COUNT_KEYS) {
      const sum = node.children.reduce((acc, c) => acc + c.totals[k], 0);
      assert.equal(node.totals[k], sum, `${node.level}:${node.id} ${k} = Σ children`);
    }
  }
  const t = node.totals;
  const expectedRate = t.evaluated === 0 ? 0 : Math.round((t.compliant / t.evaluated) * 1000) / 10;
  assert.equal(t.complianceRate, expectedRate, `${node.level}:${node.id} rate recomputed`);
  node.children.forEach(assertReconciles);
}

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runStore = new SqliteRunStore(db);
  outcomes = new SqliteOutcomeStore(db);
  cases = new SqliteCaseStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test",
    requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  // Plant A subjects (emp-006 OVERDUE, emp-010 COMPLIANT), HQ subject (emp-001 COMPLIANT).
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-010", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("rollup reconciles at every level and the root totals the population", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  assert.equal(root.level, "enterprise");
  assert.equal(root.totals.evaluated, 3);
  assert.equal(root.totals.compliant, 2);
  assert.equal(root.totals.overdue, 1);
  assert.equal(root.totals.openCases, 1);
  assert.equal(root.totals.complianceRate, 66.7); // 2/3
  assertReconciles(root);
});

test("levels are enterprise→location→provider→patient and a patient maps to its provider's location", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "audiogram" });
  const plantA = root.children.find((c) => c.id === "Plant A")!;
  assert.equal(plantA.level, "location");
  assert.equal(plantA.totals.evaluated, 2, "emp-006 + emp-010");
  const provider = plantA.children[0]!;
  assert.equal(provider.level, "provider");
  const patient = provider.children[0]!;
  assert.equal(patient.level, "patient");
  assert.ok(["emp-006", "emp-010"].includes(patient.id));
});

test("empty scope (unknown measure) → enterprise node with zeros and no children", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, { measureId: "does-not-exist" });
  assert.equal(root.level, "enterprise");
  assert.equal(root.totals.evaluated, 0);
  assert.equal(root.totals.complianceRate, 0);
  assert.equal(root.children.length, 0);
});

test("omitting measureId aggregates across all Active measures (no crash, reconciles)", async () => {
  const root = await buildHierarchyRollup({ outcomeStore: outcomes, caseStore: cases }, {});
  assert.ok(root.totals.evaluated >= 3);
  assertReconciles(root);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/program/hierarchy-rollup.test.ts`
Expected: FAIL — `./hierarchy-rollup.ts` does not exist.

- [ ] **Step 3: Implement the read-model** — `backend-ts/src/program/hierarchy-rollup.ts`:

```ts
/**
 * Hierarchy rollup (#74 E4) — the enterprise→location→provider→patient tree for the
 * multi-level dashboard. Aggregates the SAME outcome rows the programs overview uses
 * (latest population run per Active measure; single-subject CASE/EMPLOYEE reruns excluded)
 * into a node tree where parent count totals equal the sum of their children at every level.
 *
 * No DB schema: the hierarchy is resolved at read-time from the synthetic directory
 * (employee.site = location, employee.providerId = provider). Subjects that don't resolve
 * to a directory employee can't be placed in the tree and are skipped.
 */
import type { OutcomeStore, OutcomeWithRun } from "../stores/outcome-store.ts";
import type { CaseStore } from "../stores/case-store.ts";
import { ENTERPRISE, PROVIDERS, employeeById, providerById } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";

export type HierarchyLevel = "enterprise" | "location" | "provider" | "patient";

export interface HierarchyTotals {
  evaluated: number;
  compliant: number;
  dueSoon: number;
  overdue: number;
  missingData: number;
  excluded: number;
  complianceRate: number;
  openCases: number;
}

export interface HierarchyNode {
  level: HierarchyLevel;
  id: string;
  name: string;
  parentId: string | null;
  totals: HierarchyTotals;
  children: HierarchyNode[];
}

export interface HierarchyDeps {
  outcomeStore: OutcomeStore;
  caseStore: CaseStore;
}

export interface HierarchyFilters {
  measureId?: string | null;
  from?: string | null;
  to?: string | null;
}

const RERUN_SCOPES = new Set(["CASE", "EMPLOYEE"]);
const isPopulationRun = (scopeType: string): boolean => !RERUN_SCOPES.has(scopeType.toUpperCase());
const day = (s: string): string => s.slice(0, 10);
const round1 = (compliant: number, total: number) => (total === 0 ? 0 : Math.round((compliant / total) * 1000) / 10);

interface MutableTotals {
  evaluated: number; compliant: number; dueSoon: number; overdue: number;
  missingData: number; excluded: number; openCases: number;
}
const zero = (): MutableTotals => ({ evaluated: 0, compliant: 0, dueSoon: 0, overdue: 0, missingData: 0, excluded: 0, openCases: 0 });
const addStatus = (t: MutableTotals, status: string): void => {
  t.evaluated++;
  if (status === "COMPLIANT") t.compliant++;
  else if (status === "DUE_SOON") t.dueSoon++;
  else if (status === "OVERDUE") t.overdue++;
  else if (status === "MISSING_DATA") t.missingData++;
  else if (status === "EXCLUDED") t.excluded++;
};
const seal = (t: MutableTotals): HierarchyTotals => ({ ...t, complianceRate: round1(t.compliant, t.evaluated) });

/** Latest population run's rows for one measure (max runStartedAt group), [] if none. */
function latestRunRows(rows: OutcomeWithRun[]): OutcomeWithRun[] {
  const byRun = new Map<string, { startedAt: string; rows: OutcomeWithRun[] }>();
  for (const r of rows) {
    const g = byRun.get(r.runId) ?? byRun.set(r.runId, { startedAt: r.runStartedAt, rows: [] }).get(r.runId)!;
    g.rows.push(r);
  }
  let best: { startedAt: string; rows: OutcomeWithRun[] } | null = null;
  for (const g of byRun.values()) if (!best || g.startedAt > best.startedAt) best = g;
  return best?.rows ?? [];
}

export async function buildHierarchyRollup(deps: HierarchyDeps, filters: HierarchyFilters): Promise<HierarchyNode> {
  const from = filters.from?.trim() || undefined;
  const to = filters.to?.trim() || undefined;
  const measureId = filters.measureId?.trim() || null;

  // Scope measures: a given Active measure, or all Active measures. Unknown/non-Active → empty.
  const active = MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id);
  const scopeMeasures = measureId ? (active.includes(measureId) ? [measureId] : []) : active;

  // Per-patient accumulator (only directory-resolvable subjects are placeable).
  const byPatient = new Map<string, MutableTotals>();
  const ensure = (subjectId: string): MutableTotals | null => {
    if (!employeeById(subjectId)) return null; // unplaceable — skip
    return byPatient.get(subjectId) ?? byPatient.set(subjectId, zero()).get(subjectId)!;
  };

  if (scopeMeasures.length > 0) {
    const allRows = (await deps.outcomeStore.listOutcomesWithRun({ from, to })).filter((r) => isPopulationRun(r.runScopeType));
    const byMeasure = new Map<string, OutcomeWithRun[]>();
    for (const r of allRows) (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
    for (const m of scopeMeasures) {
      for (const r of latestRunRows(byMeasure.get(m) ?? [])) {
        const acc = ensure(r.subjectId);
        if (acc) addStatus(acc, r.status);
      }
    }
    // Open cases (scoped to the measure when filtered), bounded by the date window on createdAt.
    const openCases = await deps.caseStore.listCases({ statuses: ["OPEN"], measureId: measureId ?? undefined, limit: 100000 });
    for (const c of openCases) {
      if (from && day(c.createdAt) < day(from)) continue;
      if (to && day(c.createdAt) > day(to)) continue;
      const acc = ensure(c.employeeId);
      if (acc) acc.openCases++;
    }
  }

  // Build leaves (patient nodes) for any subject with evaluated>0 OR openCases>0.
  const providerTotals = new Map<string, MutableTotals>();
  const locationTotals = new Map<string, MutableTotals>();
  const patientsByProvider = new Map<string, HierarchyNode[]>();
  const ent = zero();

  for (const [subjectId, t] of byPatient) {
    if (t.evaluated === 0 && t.openCases === 0) continue;
    const emp = employeeById(subjectId)!;
    const node: HierarchyNode = {
      level: "patient", id: subjectId, name: emp.name, parentId: emp.providerId, totals: seal(t), children: [],
    };
    (patientsByProvider.get(emp.providerId) ?? patientsByProvider.set(emp.providerId, []).get(emp.providerId)!).push(node);
    const pt = providerTotals.get(emp.providerId) ?? providerTotals.set(emp.providerId, zero()).get(emp.providerId)!;
    const lt = locationTotals.get(emp.site) ?? locationTotals.set(emp.site, zero()).get(emp.site)!;
    for (const acc of [pt, lt, ent]) {
      acc.evaluated += t.evaluated; acc.compliant += t.compliant; acc.dueSoon += t.dueSoon;
      acc.overdue += t.overdue; acc.missingData += t.missingData; acc.excluded += t.excluded; acc.openCases += t.openCases;
    }
  }

  // Provider nodes grouped under their location; locations under the enterprise.
  const locationNodes = new Map<string, HierarchyNode[]>();
  for (const [providerId, patients] of patientsByProvider) {
    const prov = providerById(providerId);
    const location = prov?.location ?? "Unknown";
    const provNode: HierarchyNode = {
      level: "provider", id: providerId, name: prov?.name ?? providerId, parentId: location,
      totals: seal(providerTotals.get(providerId)!),
      children: patients.sort((a, b) => a.id.localeCompare(b.id)),
    };
    (locationNodes.get(location) ?? locationNodes.set(location, []).get(location)!).push(provNode);
  }

  const locationChildren: HierarchyNode[] = [...locationNodes.entries()]
    .map(([location, providers]): HierarchyNode => ({
      level: "location", id: location, name: location, parentId: ENTERPRISE.id,
      totals: seal(locationTotals.get(location)!),
      children: providers.sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    level: "enterprise", id: ENTERPRISE.id, name: ENTERPRISE.name, parentId: null,
    totals: seal(ent), children: locationChildren,
  };
}
```

  Note on `PROVIDERS` import: it is imported for documentation/parity with the directory but the rollup only places providers that have ≥1 in-scope patient (empty providers are omitted, which keeps reconciliation exact). If the linter flags the unused import, drop `PROVIDERS` from the import line.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/program/hierarchy-rollup.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + full test suite**

Run: `cd backend-ts && pnpm typecheck && pnpm test`
Expected: no type errors; ~430+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/program/hierarchy-rollup.ts backend-ts/src/program/hierarchy-rollup.test.ts
git commit -m "feat(program): #74 E4 — reconciling hierarchy rollup read-model"
```

---

## Task 3: `GET /api/hierarchy/rollup` route

**Files:**
- Create: `backend-ts/src/routes/hierarchy.ts`
- Test: `backend-ts/src/routes/hierarchy.test.ts`
- Modify: `backend-ts/src/worker.ts`

- [ ] **Step 1: Write the failing route test** — `backend-ts/src/routes/hierarchy.test.ts`:

```ts
/**
 * Hierarchy route (#74 E4): seed an audiogram run + outcomes + an open case, then assert
 * GET /api/hierarchy/rollup returns the enterprise tree, reconciles through the API, and
 * honors the measureId filter.
 *   node --import tsx --test src/routes/hierarchy.test.ts
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
import { handleHierarchy } from "./hierarchy.ts";

const dbPath = join(tmpdir(), `workwell-hier-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleHierarchy(new Request(`http://x/api/hierarchy/rollup${qs}`, { method: "GET" }), env as never);

interface Node { level: string; id: string; totals: { evaluated: number; compliant: number; complianceRate: number; openCases: number }; children: Node[]; }

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const cases = new SqliteCaseStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "audiogram", triggeredBy: "test", requestedScope: { measureId: "audiogram" },
    measurementPeriodStart: "2026-06-13T00:00:00.000Z", measurementPeriodEnd: "2026-06-13T00:00:00.000Z",
  });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", status: "OVERDUE", evidence: {} });
  await outcomes.recordOutcome({ runId: run.id, subjectId: "emp-001", measureId: "audiogram", status: "COMPLIANT", evidence: {} });
  await cases.upsertFromOutcome({ runId: run.id, subjectId: "emp-006", measureId: "audiogram", evaluationPeriod: "2026-06-13", outcomeStatus: "OVERDUE" });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("GET /api/hierarchy/rollup returns the enterprise tree, reconciling, filtered by measure", async () => {
  const res = await get("?measureId=audiogram");
  assert.equal(res?.status, 200);
  const root = (await res!.json()) as Node;
  assert.equal(root.level, "enterprise");
  assert.equal(root.totals.evaluated, 2);
  assert.equal(root.totals.compliant, 1);
  assert.equal(root.totals.complianceRate, 50);
  assert.equal(root.totals.openCases, 1);
  // reconciliation through the API: location sum = root
  const locEvaluated = root.children.reduce((a, c) => a + c.totals.evaluated, 0);
  assert.equal(locEvaluated, root.totals.evaluated);
});

test("non-GET → null (not handled here)", async () => {
  const res = await handleHierarchy(new Request("http://x/api/hierarchy/rollup", { method: "POST" }), env as never);
  assert.equal(res, null);
});

test("unrelated path → null", async () => {
  const res = await handleHierarchy(new Request("http://x/api/other", { method: "GET" }), env as never);
  assert.equal(res, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/routes/hierarchy.test.ts`
Expected: FAIL — `./hierarchy.ts` does not exist.

- [ ] **Step 3: Implement the route** — `backend-ts/src/routes/hierarchy.ts`:

```ts
/**
 * Hierarchy route (#74 E4) — the multi-level dashboard rollup behind the unchanged frontend
 * contract. Authenticated under /api/** by the worker's security matrix.
 *
 *   GET /api/hierarchy/rollup?measureId=&from=&to=  → HierarchyNode (enterprise root)
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { buildHierarchyRollup } from "../program/hierarchy-rollup.ts";

interface HierarchyEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleHierarchy(req: Request, env: HierarchyEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/hierarchy/rollup") return null;

  const s = await getStores(env);
  const q = url.searchParams;
  const tree = await buildHierarchyRollup(
    { outcomeStore: s.outcomes, caseStore: s.cases },
    { measureId: q.get("measureId"), from: q.get("from"), to: q.get("to") },
  );
  return json(tree);
}
```

- [ ] **Step 4: Wire it into the worker.** In `backend-ts/src/worker.ts`, add the import near the other route imports (after the programs import):

```ts
import { handleHierarchy } from "./routes/hierarchy.ts";
```

  And register it right after the programs handler block (after line `if (programsResponse) return programsResponse;`):

```ts
  const hierarchyResponse = await handleHierarchy(req, env);
  if (hierarchyResponse) return hierarchyResponse;
```

- [ ] **Step 5: Run the route test + typecheck**

Run: `cd backend-ts && node --import tsx --test src/routes/hierarchy.test.ts && pnpm typecheck`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/routes/hierarchy.ts backend-ts/src/routes/hierarchy.test.ts backend-ts/src/worker.ts
git commit -m "feat(routes): #74 E4 — GET /api/hierarchy/rollup endpoint"
```

---

## Task 4: Frontend drill-down view

**Files:**
- Create: `frontend/app/(dashboard)/programs/hierarchy/page.tsx`
- Modify: `frontend/app/(dashboard)/programs/page.tsx` (add a link)

The implementer must first read `frontend/app/(dashboard)/programs/page.tsx` and one existing data-fetching page to copy the project's API-client import, auth/fetch pattern, "use client" boundary, and table styling (Tailwind + `@mieweb/ui`). Match those patterns rather than inventing new ones.

- [ ] **Step 1: Inspect the existing programs page + API client.**

Run: `ls "frontend/app/(dashboard)/programs/"` and read `page.tsx` + the lib that does authenticated fetches (search `frontend/lib` or `frontend/features` for the fetch helper used by `/programs`).
Expected: identify the fetch helper, the API base usage, and the table component pattern.

- [ ] **Step 2: Create the hierarchy page** — `frontend/app/(dashboard)/programs/hierarchy/page.tsx`. Use the **same** fetch helper and client-component boundary the existing programs page uses. The page must:
  - Fetch `GET /api/hierarchy/rollup?measureId=<selected>` (default: no measureId = all Active measures).
  - Render a measure `<select>` (options: "All measures" + each Active measure name from the existing measures/programs data source already used on `/programs`).
  - Render a nested **expandable** table: each row shows name, evaluated, compliant, complianceRate (%), openCases. Enterprise row expands to locations, location → providers, provider → patients. Use per-row open/closed state (`useState<Set<string>>`), indenting children by level. A patient row links to `/cases` is **not** required; keep it read-only.
  - Show a loading state and an empty state ("No data for this scope").

  Skeleton (adapt imports/styles to the existing page):

```tsx
"use client";
import { useEffect, useState } from "react";
// import { apiFetch } from "<the same helper /programs uses>";

interface Totals { evaluated: number; compliant: number; dueSoon: number; overdue: number; missingData: number; excluded: number; complianceRate: number; openCases: number; }
interface Node { level: string; id: string; name: string; parentId: string | null; totals: Totals; children: Node[]; }

export default function HierarchyPage() {
  const [root, setRoot] = useState<Node | null>(null);
  const [loading, setLoading] = useState(true);
  const [measureId, setMeasureId] = useState<string>("");
  const [open, setOpen] = useState<Set<string>>(new Set(["twh"]));

  useEffect(() => {
    setLoading(true);
    const qs = measureId ? `?measureId=${encodeURIComponent(measureId)}` : "";
    // replace apiFetch with the project helper; it returns parsed JSON
    apiFetch(`/api/hierarchy/rollup${qs}`).then((d: Node) => setRoot(d)).finally(() => setLoading(false));
  }, [measureId]);

  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const rows: Array<{ node: Node; depth: number }> = [];
  const walk = (node: Node, depth: number) => {
    rows.push({ node, depth });
    if (open.has(node.id)) node.children.forEach((c) => walk(c, depth + 1));
  };
  if (root) walk(root, 0);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Compliance hierarchy</h1>
        <select className="border rounded px-2 py-1 bg-transparent" value={measureId} onChange={(e) => setMeasureId(e.target.value)}>
          <option value="">All measures</option>
          {/* map Active measures → <option value={m.id}>{m.name}</option> from the existing source */}
        </select>
      </div>
      {loading ? <p>Loading…</p> : !root || root.children.length === 0 ? <p>No data for this scope.</p> : (
        <table className="w-full text-sm">
          <thead><tr className="text-left border-b"><th>Name</th><th>Evaluated</th><th>Compliant</th><th>Rate</th><th>Open cases</th></tr></thead>
          <tbody>
            {rows.map(({ node, depth }) => (
              <tr key={`${node.level}-${node.id}`} className="border-b">
                <td style={{ paddingLeft: `${depth * 1.25}rem` }}>
                  {node.children.length > 0 ? (
                    <button onClick={() => toggle(node.id)} className="mr-1">{open.has(node.id) ? "▾" : "▸"}</button>
                  ) : <span className="mr-1 inline-block w-3" />}
                  {node.name}
                </td>
                <td>{node.totals.evaluated}</td>
                <td>{node.totals.compliant}</td>
                <td>{node.totals.complianceRate}%</td>
                <td>{node.totals.openCases}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Link from `/programs`.** In `frontend/app/(dashboard)/programs/page.tsx`, add a visible link to `/programs/hierarchy` (e.g. a "View hierarchy" `<Link href="/programs/hierarchy">` near the page header), matching the existing link/button styling on that page.

- [ ] **Step 4: Lint + build**

Run: `cd frontend && npm run lint && npm run build`
Expected: lint clean; production build succeeds. (`NEXT_PUBLIC_DEMO_MODE` must not be `true`.)

- [ ] **Step 5: Commit**

```bash
git add "frontend/app/(dashboard)/programs/hierarchy/page.tsx" "frontend/app/(dashboard)/programs/page.tsx"
git commit -m "feat(frontend): #94 E4.2 — hierarchy drill-down view on /programs"
```

---

## Task 5: Docs

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/DECISIONS.md`, `docs/JOURNAL.md`, `README.md`, `CLAUDE.md`

- [ ] **Step 1: ARCHITECTURE.md** — under §3 `program` module, add the `hierarchy-rollup` read-model (enterprise→location→provider→patient, reconciling rollups, read-time from the synthetic directory, no schema). Under §4 add the `/programs/hierarchy` route surface. Under §7 add the interface line: `GET /api/hierarchy/rollup?measureId=&from=&to= → HierarchyNode (enterprise root); reconciling totals at every level (#74 E4)`.

- [ ] **Step 2: DATA_MODEL.md** — correct the stale `employees`-table description: note that in `backend-ts` the workforce is the synthetic directory (`employee-catalog.ts`), each entry `{ externalId, name, role, site, providerId }`, with `PROVIDERS` (provider level) + `ENTERPRISE` root; outcomes/cases store only `subjectId` and the hierarchy is resolved at read-time (no SQL). Keep the historical Java `employees` table note clearly marked as Java-era.

- [ ] **Step 3: DECISIONS.md** — add an ADR (next number) recording: provider = attributed occupational-health clinician (eCQM/MIPS-authentic), strictly nested under location for reconciling rollups, modeled in the synthetic directory with no DB schema change (the #93 stop-and-ask gate is satisfied with no migration).

- [ ] **Step 4: JOURNAL.md** — add a dated `2026-06-18` entry (newest on top): E4 shipped — hierarchy model in the synthetic directory, reconciling rollup read-model + `/api/hierarchy/rollup`, drill-down UI; no schema change (finding: backend-ts has no employees table).

- [ ] **Step 5: README.md** — add `/programs/hierarchy` to Key routes and `GET /api/hierarchy/rollup` to API highlights.

- [ ] **Step 6: CLAUDE.md** — update Current Focus: E4 (#74) done (E4.1 #93 + E4.2 #94); next epic E5 (#75).

- [ ] **Step 7: Commit**

```bash
git add docs/ARCHITECTURE.md docs/DATA_MODEL.md docs/DECISIONS.md docs/JOURNAL.md README.md CLAUDE.md
git commit -m "docs: #74 E4 — multi-level dashboards (architecture, data model, ADR, journal)"
```

---

## Final verification (before PR)

- [ ] `cd backend-ts && pnpm typecheck && pnpm test` — all green.
- [ ] `cd frontend && npm run lint && npm run build` — clean.
- [ ] Whole-PR code review via the `superpowers:code-reviewer` subagent on the full branch diff vs `main` (MANDATORY before merge).
- [ ] PR opened referencing #74, #93, #94; merge on green after review.
