# E10 Plan 2 — Roster read model + status vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `GET /api/compliance/roster` — a read-time model that turns the latest population run's outcomes + evidence into a per-subject × per-panel-measure grid of `{ status, method }` cells, with the E10.5 display-state vocabulary (DECLINED / IN_PROGRESS / NA + method strings) derived from `Dose Count` / refusal / recency evidence.

**Architecture:** All in `backend-ts/`. A new `src/compliance/` module: `panels.ts` (the column sets), `roster-vocabulary.ts` (pure `deriveCell` — E10.5), and `roster-read-model.ts` (`buildRoster` — E10.2, built on the existing `listOutcomesWithRun` + `latestRunRows` + `listOutcomes`). A pathname route `src/routes/compliance.ts` registered in `worker.ts`, authenticated read-only under the existing `/api/**` matrix (all roles, like `/api/hierarchy/rollup`). The persisted status stays the 5 canonical buckets (ADR-008); DECLINED/IN_PROGRESS/NA are read-time refinements. No schema, no new deps.

**Tech Stack:** TypeScript (Node, `tsx`), `node:test` + `node:assert`. Reuses `rollup-shared.ts`, `case-detail-read-model.ts` (`deriveWhyFlagged`), `employee-catalog.ts` (`EMPLOYEES`), `MEASURE_BINDINGS` (`complianceClass`/`series`).

**Covers issues:** [#189 (E10.2)](https://github.com/Taleef7/workwell/issues/189) · [#192 (E10.5)](https://github.com/Taleef7/workwell/issues/192). Spec: `docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md` (Sections B + E).

---

## File map

**Create:**
- `backend-ts/src/compliance/panels.ts` — panel→measure-id column sets.
- `backend-ts/src/compliance/roster-vocabulary.ts` — `deriveCell` (E10.5 display state + method).
- `backend-ts/src/compliance/roster-vocabulary.test.ts`
- `backend-ts/src/compliance/roster-read-model.ts` — `buildRoster` (E10.2).
- `backend-ts/src/compliance/roster-read-model.test.ts`
- `backend-ts/src/routes/compliance.ts` — `handleCompliance` route.
- `backend-ts/src/routes/compliance.test.ts`

**Modify:**
- `backend-ts/src/case/case-detail-read-model.ts` — `export` the existing `expressionResults` helper (reuse, don't duplicate).
- `backend-ts/src/worker.ts` — register `handleCompliance`.
- `docs/ARCHITECTURE.md` — §4 route surface + §7 external interface for the roster endpoint.

**Note on NA:** with the current synthetic data every employee is enrolled in (and evaluated for) every measure, so NA cells won't actually appear yet — NA means "this subject has no outcome for this measure in its latest population run." Eligibility-define-based NA (segment-scoped applicability) arrives with E11 segments. The derivation is implemented and correct; it's just dormant on synthetic data.

---

### Task 1: Panel column sets

**Files:**
- Create: `backend-ts/src/compliance/panels.ts`
- Test: `backend-ts/src/compliance/panels.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/compliance/panels.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PANELS, DEFAULT_PANEL, isPanelId } from "./panels.ts";

test("panels expose the three column sets and a default", () => {
  assert.deepEqual(Object.keys(PANELS).sort(), ["immunizations", "osha", "wellness"]);
  assert.ok(PANELS.immunizations.includes("mmr"));
  assert.ok(PANELS.immunizations.includes("hepatitis_b_vaccination_series"));
  assert.equal(DEFAULT_PANEL, "immunizations");
});

test("isPanelId narrows known panel ids", () => {
  assert.equal(isPanelId("osha"), true);
  assert.equal(isPanelId("nope"), false);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend-ts && node --import tsx --test src/compliance/panels.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `panels.ts`**

Create `backend-ts/src/compliance/panels.ts`:
```ts
/**
 * Roster column sets (E10.2). Each panel scopes the roster grid to a coherent group of measures,
 * standing in for E11's risk-group/segment column scoping. Ids are the runnable measure ids.
 */
export type PanelId = "immunizations" | "osha" | "wellness";

export const PANELS: Record<PanelId, string[]> = {
  immunizations: ["mmr", "varicella", "hepatitis_b_vaccination_series", "adult_immunization", "flu_vaccine"],
  osha: ["audiogram", "hazwoper", "tb_surveillance"],
  wellness: ["hypertension", "diabetes_hba1c", "obesity_bmi", "cholesterol_ldl", "cms122", "cms125"],
};

export const DEFAULT_PANEL: PanelId = "immunizations";

export const isPanelId = (s: string): s is PanelId => Object.prototype.hasOwnProperty.call(PANELS, s);
```

- [ ] **Step 4: Run it — verify it passes**

Run: `cd backend-ts && node --import tsx --test src/compliance/panels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd backend-ts
git add src/compliance/panels.ts src/compliance/panels.test.ts
git commit -m "feat(compliance): roster panel column sets (E10.2, #189)"
```

---

### Task 2: Status vocabulary — `deriveCell` (E10.5)

**Files:**
- Modify: `backend-ts/src/case/case-detail-read-model.ts` (export `expressionResults`)
- Create: `backend-ts/src/compliance/roster-vocabulary.ts`
- Test: `backend-ts/src/compliance/roster-vocabulary.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/compliance/roster-vocabulary.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveCell } from "./roster-vocabulary.ts";

// Evidence is the engine's `{ expressionResults: [{define, result}] }` shape.
const ev = (results: Array<[string, unknown]>) => ({ expressionResults: results.map(([define, result]) => ({ define, result })) });
const PERIOD = "2026-06-12";

test("PERMANENT COMPLIANT → COMPLIANT + dose-count method", () => {
  const cell = deriveCell("COMPLIANT", ev([["Dose Count", 2], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "COMPLIANT", method: "2 valid dose(s)" });
});

test("PERMANENT partial series → IN_PROGRESS (canonical MISSING_DATA)", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 1], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "IN_PROGRESS", method: "1 of 2 doses on file" });
});

test("PERMANENT no doses → MISSING_DATA", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 0], ["Refused", false]]), "mmr", PERIOD);
  assert.deepEqual(cell, { status: "MISSING_DATA", method: "No doses on file" });
});

test("documented refusal → DECLINED (not excluded, case stays open)", () => {
  const cell = deriveCell("MISSING_DATA", ev([["Dose Count", 0], ["Refused", true]]), "mmr", PERIOD);
  assert.equal(cell.status, "DECLINED");
});

test("contraindication → EXCLUDED wins over refusal", () => {
  const cell = deriveCell("EXCLUDED", ev([["Dose Count", 0], ["Refused", true]]), "mmr", PERIOD);
  assert.equal(cell.status, "EXCLUDED");
});

test("RECURRING OVERDUE → OVERDUE + recency method", () => {
  const cell = deriveCell(
    "OVERDUE",
    ev([["Most Recent Audiogram Date", "2024-01-10T00:00:00Z"], ["Days Since Last Audiogram", 884]]),
    "audiogram",
    PERIOD,
  );
  assert.equal(cell.status, "OVERDUE");
  assert.match(cell.method, /2024-01-10/);
});

test("RECURRING COMPLIANT → COMPLIANT", () => {
  const cell = deriveCell(
    "COMPLIANT",
    ev([["Most Recent Audiogram Date", "2026-03-10T00:00:00Z"], ["Days Since Last Audiogram", 94]]),
    "audiogram",
    PERIOD,
  );
  assert.equal(cell.status, "COMPLIANT");
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend-ts && node --import tsx --test src/compliance/roster-vocabulary.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Export `expressionResults` from case-detail**

In `backend-ts/src/case/case-detail-read-model.ts`, change the helper declaration so it is exported (it is currently `function expressionResults(...)`):
```ts
export interface ExprResult {
  define: string;
  result: unknown;
}
export function expressionResults(evidence: unknown): ExprResult[] {
  const er = (evidence as { expressionResults?: unknown } | null)?.expressionResults;
  return Array.isArray(er) ? (er as ExprResult[]) : [];
}
```
(There is already a local `interface ExprResult` + `function expressionResults` in that file — add `export` to both and delete the old non-exported duplicates so there is exactly one of each.)

- [ ] **Step 4: Implement `roster-vocabulary.ts`**

Create `backend-ts/src/compliance/roster-vocabulary.ts`:
```ts
/**
 * Roster status vocabulary (E10.5). Maps a measure outcome's canonical bucket + evidence +
 * complianceClass to a UI display state + a plain-English method string. The persisted status is
 * unchanged (the 5 canonical buckets, ADR-008); DECLINED / IN_PROGRESS are read-time refinements
 * (NA is decided by the read model when a subject has no outcome for a measure).
 */
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveWhyFlagged, expressionResults } from "../case/case-detail-read-model.ts";

export type DisplayState =
  | "COMPLIANT" | "DUE_SOON" | "OVERDUE" | "MISSING_DATA" | "EXCLUDED" | "DECLINED" | "IN_PROGRESS" | "NA";

export interface Cell {
  status: DisplayState;
  method: string;
}

/** Derive the display state + method for one (canonical status, evidence) of a measure. */
export function deriveCell(canonicalStatus: string, evidence: unknown, measureId: string, evaluationPeriod: string): Cell {
  const ers = expressionResults(evidence);
  const get = (re: RegExp): unknown => ers.find((r) => re.test(r.define))?.result;
  const binding = MEASURE_BINDINGS[measureId];
  const refused = get(/refus/i) === true;

  if (canonicalStatus === "EXCLUDED") return { status: "EXCLUDED", method: "Contraindication / exemption on file" };
  if (refused) return { status: "DECLINED", method: "Declination on file" };

  if (binding?.complianceClass === "PERMANENT") {
    const dc = get(/^dose count$/i);
    const doseCount = typeof dc === "number" ? dc : 0;
    const required = binding.series?.requiredDoses ?? 2;
    if (canonicalStatus === "COMPLIANT") return { status: "COMPLIANT", method: `${doseCount} valid dose(s)` };
    if (doseCount > 0 && doseCount < required) return { status: "IN_PROGRESS", method: `${doseCount} of ${required} doses on file` };
    return { status: "MISSING_DATA", method: "No doses on file" };
  }

  // RECURRING (recency): reuse the case-detail why_flagged derivation for last-exam/days.
  const wf = deriveWhyFlagged(evidence, measureId, evaluationPeriod, canonicalStatus);
  const last = wf.last_exam_date;
  switch (canonicalStatus) {
    case "COMPLIANT":
      return { status: "COMPLIANT", method: last ? `Last completed ${last}` : "Compliant" };
    case "DUE_SOON":
      return { status: "DUE_SOON", method: last ? `Due soon — last ${last}` : "Due soon" };
    case "OVERDUE":
      return {
        status: "OVERDUE",
        method: last ? `Overdue — last ${last} (${wf.days_overdue ?? 0}d over)` : "Overdue — no record on file",
      };
    default:
      return { status: "MISSING_DATA", method: "No record on file" };
  }
}
```

- [ ] **Step 5: Run it — verify it passes**

Run: `cd backend-ts && node --import tsx --test src/compliance/roster-vocabulary.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 6: Confirm no regression from the export change**

Run: `cd backend-ts && node --import tsx --test src/case/case-detail-read-model.test.ts && node_modules/.bin/tsc --noEmit`
Expected: case-detail tests still pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd backend-ts
git add src/case/case-detail-read-model.ts src/compliance/roster-vocabulary.ts src/compliance/roster-vocabulary.test.ts
git commit -m "feat(compliance): roster status vocabulary deriveCell — DECLINED/IN_PROGRESS/method (E10.5, #192)"
```

---

### Task 3: Roster read model — `buildRoster` (E10.2)

**Files:**
- Create: `backend-ts/src/compliance/roster-read-model.ts`
- Test: `backend-ts/src/compliance/roster-read-model.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/compliance/roster-read-model.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { buildRoster } from "./roster-read-model.ts";

const EMP = EMPLOYEES[0]!.externalId; // a real directory subject

function fakeStore(withRun: OutcomeWithRun[], byRun: Record<string, OutcomeRecord[]>): OutcomeStore {
  return {
    listOutcomesWithRun: async () => withRun,
    listOutcomes: async (runId: string) => byRun[runId] ?? [],
    recordOutcome: async () => { throw new Error("unused"); },
    recordOutcomes: async () => { throw new Error("unused"); },
    listOutcomesForMeasure: async () => { throw new Error("unused"); },
    listOutcomesForEmployee: async () => { throw new Error("unused"); },
  } as OutcomeStore;
}

const ev = (results: Array<[string, unknown]>) => ({ expressionResults: results.map(([define, result]) => ({ define, result })) });

test("buildRoster — columns reflect the panel; a COMPLIANT mmr cell carries the dose method", async () => {
  const withRun: OutcomeWithRun[] = [
    { runId: "run-1", runStartedAt: "2026-06-12T00:00:00Z", runScopeType: "ALL_PROGRAMS", runStatus: "COMPLETED", runTriggeredBy: "manual", subjectId: EMP, measureId: "mmr", status: "COMPLIANT" },
  ];
  const byRun: Record<string, OutcomeRecord[]> = {
    "run-1": [
      { id: "o-1", runId: "run-1", subjectId: EMP, measureId: "mmr", evaluationPeriod: "2026-06-12", status: "COMPLIANT", evidence: ev([["Dose Count", 2]]), evaluatedAt: "2026-06-12T00:00:00Z" },
    ],
  };
  const roster = await buildRoster({ outcomeStore: fakeStore(withRun, byRun) }, { panel: "immunizations" });

  assert.equal(roster.panel, "immunizations");
  assert.ok(roster.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = roster.rows.find((r) => r.subject.externalId === EMP)!;
  assert.equal(row.cells["mmr"]!.status, "COMPLIANT");
  assert.equal(row.cells["mmr"]!.method, "2 valid dose(s)");
  // a measure with no outcome for this subject → NA
  assert.equal(row.cells["flu_vaccine"]!.status, "NA");
  // total counts all directory subjects (everyone), not just those with outcomes
  assert.equal(roster.total, EMPLOYEES.length);
});

test("buildRoster — status filter keeps only subjects with >=1 matching cell; page-size bounds rows", async () => {
  const roster = await buildRoster({ outcomeStore: fakeStore([], {}) }, { panel: "osha", status: "COMPLIANT", pageSize: 10 });
  // no outcomes → every cell NA → no subject has a COMPLIANT cell → empty
  assert.equal(roster.rows.length, 0);
  assert.equal(roster.total, 0);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend-ts && node --import tsx --test src/compliance/roster-read-model.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `roster-read-model.ts`**

Create `backend-ts/src/compliance/roster-read-model.ts`:
```ts
/**
 * Roster read model (E10.2) — `GET /api/compliance/roster`. Rows = every directory subject, columns =
 * the selected panel's Active measures, each cell = the E10.5 display state + method derived from the
 * subject's outcome in that measure's LATEST population run (NA when there is none). Read-time; no schema.
 * Reuses the "latest population run per measure" path the hierarchy rollup uses (`listOutcomesWithRun` +
 * `latestRunRows`) and loads evidence per run via `listOutcomes` (cached by run id).
 */
import type { OutcomeStore, OutcomeWithRun, OutcomeRecord } from "../stores/outcome-store.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURE_CATALOG } from "../measure/measure-catalog.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { isPopulationRun, latestRunRows } from "../program/rollup-shared.ts";
import { PANELS, DEFAULT_PANEL, isPanelId, type PanelId } from "./panels.ts";
import { deriveCell, type Cell } from "./roster-vocabulary.ts";

export interface RosterColumn {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
}
export interface RosterCell extends Cell {
  evidenceRef?: { runId: string; outcomeId: string };
}
export interface RosterRow {
  subject: { externalId: string; name: string; role: string; site: string };
  cells: Record<string, RosterCell>;
}
export interface Roster {
  panel: PanelId;
  columns: RosterColumn[];
  rows: RosterRow[];
  total: number;
}

export interface RosterDeps {
  outcomeStore: OutcomeStore;
}
export interface RosterFilters {
  panel?: string | null;
  status?: string | null;
  site?: string | null;
  role?: string | null;
  q?: string | null;
  page?: number;
  pageSize?: number;
}

export async function buildRoster(deps: RosterDeps, filters: RosterFilters): Promise<Roster> {
  const panel: PanelId = filters.panel && isPanelId(filters.panel) ? filters.panel : DEFAULT_PANEL;
  const active = new Set(MEASURE_CATALOG.filter((m) => m.status === "Active").map((m) => m.id));
  const measureIds = PANELS[panel].filter((m) => active.has(m));
  const columns: RosterColumn[] = measureIds.map((id) => ({
    measureId: id,
    name: MEASURES[id]?.name ?? id,
    complianceClass: MEASURE_BINDINGS[id]?.complianceClass ?? "RECURRING",
  }));

  // 1) latest population run per panel measure (no evidence) → its run id.
  const popRows = (await deps.outcomeStore.listOutcomesWithRun({})).filter((r) => isPopulationRun(r.runScopeType));
  const byMeasure = new Map<string, OutcomeWithRun[]>();
  for (const r of popRows) {
    if (!measureIds.includes(r.measureId)) continue;
    (byMeasure.get(r.measureId) ?? byMeasure.set(r.measureId, []).get(r.measureId)!).push(r);
  }

  // 2) per measure: load that run's outcomes WITH evidence (cached by run id) → cell per subject.
  const runCache = new Map<string, OutcomeRecord[]>();
  const loadRun = async (runId: string): Promise<OutcomeRecord[]> => {
    const cached = runCache.get(runId);
    if (cached) return cached;
    const rows = await deps.outcomeStore.listOutcomes(runId);
    runCache.set(runId, rows);
    return rows;
  };
  const cellByMeasureSubject = new Map<string, Map<string, RosterCell>>();
  for (const m of measureIds) {
    const latest = latestRunRows(byMeasure.get(m) ?? []);
    const cells = new Map<string, RosterCell>();
    cellByMeasureSubject.set(m, cells);
    if (latest.length === 0) continue;
    const runId = latest[0]!.runId;
    for (const o of await loadRun(runId)) {
      if (o.measureId !== m) continue;
      cells.set(o.subjectId, { ...deriveCell(o.status, o.evidence, m, o.evaluationPeriod), evidenceRef: { runId, outcomeId: o.id } });
    }
  }

  // 3) assemble rows over the whole directory; NA where a measure has no cell for the subject.
  let rows: RosterRow[] = EMPLOYEES.map((emp) => {
    const cells: Record<string, RosterCell> = {};
    for (const m of measureIds) {
      cells[m] = cellByMeasureSubject.get(m)?.get(emp.externalId) ?? { status: "NA", method: "Not evaluated" };
    }
    return { subject: { externalId: emp.externalId, name: emp.name, role: emp.role, site: emp.site }, cells };
  });

  // 4) filters (site/role/search/status), then page.
  if (filters.site) rows = rows.filter((r) => r.subject.site === filters.site);
  if (filters.role) rows = rows.filter((r) => r.subject.role === filters.role);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    rows = rows.filter((r) => r.subject.name.toLowerCase().includes(q) || r.subject.externalId.toLowerCase().includes(q));
  }
  if (filters.status) {
    const s = filters.status.toUpperCase();
    rows = rows.filter((r) => Object.values(r.cells).some((c) => c.status === s));
  }

  const total = rows.length;
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.max(1, Math.min(Math.trunc(filters.pageSize ?? 50), 200));
  const start = (page - 1) * pageSize;
  return { panel, columns, rows: rows.slice(start, start + pageSize), total };
}
```

- [ ] **Step 4: Run it — verify it passes**

Run: `cd backend-ts && node --import tsx --test src/compliance/roster-read-model.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
cd backend-ts
git add src/compliance/roster-read-model.ts src/compliance/roster-read-model.test.ts
git commit -m "feat(compliance): roster read model buildRoster (E10.2, #189)"
```

---

### Task 4: Route `GET /api/compliance/roster` + register in worker

**Files:**
- Create: `backend-ts/src/routes/compliance.ts`
- Modify: `backend-ts/src/worker.ts`
- Test: `backend-ts/src/routes/compliance.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/routes/compliance.test.ts` (seeds a real SQLite floor DB exactly like `hierarchy.test.ts` — `getStores(env)` reads `env.DB`):
```ts
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
import { handleCompliance } from "./compliance.ts";

const dbPath = join(tmpdir(), `workwell-roster-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
const get = (qs = "") => handleCompliance(new Request(`http://x/api/compliance/roster${qs}`, { method: "GET" }), env as never);

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  env = { DB: db };
  const runStore = new SqliteRunStore(db);
  const outcomes = new SqliteOutcomeStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "mmr", triggeredBy: "test", requestedScope: { measureId: "mmr" },
    measurementPeriodStart: "2026-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-001", measureId: "mmr", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [{ define: "Dose Count", result: 2 }] },
  });
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("non-roster path returns null (not this route)", async () => {
  assert.equal(await handleCompliance(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("POST is not handled by this route", async () => {
  assert.equal(await handleCompliance(new Request("http://x/api/compliance/roster", { method: "POST" }), env as never), null);
});

test("GET /api/compliance/roster → columns + rows + X-Total-Count; mmr cell carries the dose method", async () => {
  const res = (await get("?panel=immunizations&pageSize=200"))!;
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("X-Total-Count"));
  const body = (await res.json()) as {
    panel: string;
    columns: Array<{ measureId: string; complianceClass: string }>;
    rows: Array<{ subject: { externalId: string }; cells: Record<string, { status: string; method: string }> }>;
  };
  assert.equal(body.panel, "immunizations");
  assert.ok(body.columns.some((c) => c.measureId === "mmr" && c.complianceClass === "PERMANENT"));
  const row = body.rows.find((r) => r.subject.externalId === "emp-001")!;
  assert.equal(row.cells["mmr"].status, "COMPLIANT");
  assert.equal(row.cells["mmr"].method, "2 valid dose(s)");
});
```

> `getStores(env)` reads the real `env.DB` SQLite binding (there is no injected-store map) — this is exactly how `hierarchy.test.ts` and `programs.test.ts` set up their route tests. A freshly created run is a `MEASURE`-scope population run, which `buildRoster` includes (it filters `isPopulationRun` only, matching `hierarchy-rollup`).

- [ ] **Step 2: Run it — verify it fails**

Run: `cd backend-ts && node --import tsx --test src/routes/compliance.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `compliance.ts`**

Create `backend-ts/src/routes/compliance.ts`:
```ts
/**
 * Compliance roster route (E10.2) — the "Individual Compliance Status" grid behind the unchanged
 * frontend contract. Authenticated read-only under the /api/** matrix (all roles), like
 * /api/hierarchy/rollup.
 *
 *   GET /api/compliance/roster?panel=&status=&site=&role=&q=&page=&pageSize=
 *     → { panel, columns, rows }  + X-Total-Count header (full filtered match count)
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";
import { buildRoster } from "../compliance/roster-read-model.ts";

interface ComplianceEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

const intOr = (v: string | null, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export async function handleCompliance(req: Request, env: ComplianceEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  if (url.pathname !== "/api/compliance/roster") return null;

  const q = url.searchParams;
  const stores = await getStores(env);
  const roster = await buildRoster(
    { outcomeStore: stores.outcomes },
    {
      panel: q.get("panel"),
      status: q.get("status"),
      site: q.get("site"),
      role: q.get("role"),
      q: q.get("q"),
      page: intOr(q.get("page"), 1),
      pageSize: intOr(q.get("pageSize"), 50),
    },
  );
  return json(
    { panel: roster.panel, columns: roster.columns, rows: roster.rows },
    200,
    { "X-Total-Count": String(roster.total) },
  );
}
```

- [ ] **Step 4: Register the route in `worker.ts`**

In `backend-ts/src/worker.ts`, find the hierarchy registration (around line 196):
```ts
  const hierarchyResponse = await handleHierarchy(req, env);
  if (hierarchyResponse) return hierarchyResponse;
```
Add the import near the other route imports at the top:
```ts
import { handleCompliance } from "./routes/compliance.ts";
```
and the dispatch immediately after the hierarchy dispatch:
```ts
  const complianceResponse = await handleCompliance(req, env);
  if (complianceResponse) return complianceResponse;
```
(If the hierarchy registration shape differs — e.g. a different variable/guard — match that exact local pattern; read the surrounding 5 lines first.)

- [ ] **Step 5: Run the route test — verify it passes**

Run: `cd backend-ts && node --import tsx --test src/routes/compliance.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck + worker still builds**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd backend-ts
git add src/routes/compliance.ts src/routes/compliance.test.ts src/worker.ts
git commit -m "feat(compliance): GET /api/compliance/roster route + worker registration (E10.2, #189)"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`

- [ ] **Step 1: Document the endpoint in `docs/ARCHITECTURE.md`**

In §4 (Frontend/route surfaces) and §7 (External Interfaces), add the roster endpoint. In §7 add:
```markdown
- Compliance roster (#189 / E10.2): `GET /api/compliance/roster?panel=immunizations|osha|wellness&status=&site=&role=&q=&page=&pageSize=`
  → `{ panel, columns, rows }` + `X-Total-Count` (full filtered match count; CORS-exposed). Read-time over
  the latest population run per panel measure (reuses `rollup-shared` `latestRunRows`/`isPopulationRun` +
  `listOutcomes` for evidence). Each cell carries an E10.5 display state (COMPLIANT/DUE_SOON/OVERDUE/
  MISSING_DATA/EXCLUDED/DECLINED/IN_PROGRESS/NA) + method string derived from `Dose Count`/refusal/recency
  evidence; the persisted bucket is unchanged (ADR-008). Authenticated under `/api/**` (all roles). No schema.
```

- [ ] **Step 2: Full backend verification**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; the whole suite passes (the existing ~580 + the new compliance tests; 1 pre-existing Pg-ceiling skip is OK).

- [ ] **Step 3: Commit**

```bash
cd backend-ts && cd ..
git add docs/ARCHITECTURE.md
git commit -m "docs(architecture): GET /api/compliance/roster (E10.2)"
```

---

## What Plan 2 delivers / what's next

After Plan 2: a read-only `GET /api/compliance/roster` returning per-subject × per-panel-measure cells with the full display-state vocabulary + method strings — the exact data the grid + per-employee screen render in **Plan 3** (E10.3 #190 grid, E10.4 #191 per-employee screen). NA is implemented but dormant on synthetic data (all employees enrolled) until E11 segment-scoped eligibility.
