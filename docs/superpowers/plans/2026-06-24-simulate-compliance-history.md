# Simulate Compliance History Implementation Plan (#197)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An advisory, non-persisted, as-of-date re-evaluation of one employee's compliance across every active measure, surfaced as a date-scrub panel on the per-employee screen.

**Architecture:** A pure `simulateComplianceAsOf` reuses the existing engine + synthetic adapters: for each measure, take the employee's seeded exam config, build the bundle **anchored to today**, then `engine.evaluate({ evaluationDate: asOf })`, and map through `deriveCell` for the same E10.5 vocabulary as the card. A read-only `GET /api/employees/:externalId/simulate` exposes it (writes nothing — no runs/outcomes/cases/audit). A frontend panel lets the operator scrub a date and see the result, clearly advisory. CQL stays the sole compliance authority (ADR-008/ADR-012).

**Tech Stack:** backend-ts (`@mieweb/cloud` worker, in-memory CQL engine, `node --test`); frontend (Next.js 16, React 19, Tailwind 4, Vitest + RTL).

---

## File Structure

**Backend — create:** `backend-ts/src/run/employee-compliance-snapshot.ts` (+ `.test.ts`); `backend-ts/src/routes/compliance-simulation.ts` (+ `.test.ts`).
**Backend — modify:** `backend-ts/src/worker.ts` (register route).
**Frontend — create:** `frontend/features/employee/components/SimulateComplianceHistory.tsx` (+ `.test.tsx`).
**Frontend — modify:** `frontend/app/(dashboard)/employees/[externalId]/page.tsx` (mount panel).
**Docs — modify:** `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`.

---

## Task 1: `simulateComplianceAsOf` snapshot logic

**Files:**
- Create: `backend-ts/src/run/employee-compliance-snapshot.ts`
- Test: `backend-ts/src/run/employee-compliance-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/run/employee-compliance-snapshot.test.ts`:

```typescript
/** simulateComplianceAsOf — pure, in-memory, no DB. Proves today-anchoring (scrubbing the date
 * actually changes RECURRING outcomes while PERMANENT stay constant).
 *   node --import tsx --test src/run/employee-compliance-snapshot.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { seededTargetFor } from "./distribution.ts";
import { simulateComplianceAsOf } from "./employee-compliance-snapshot.ts";

const engine = new CqlExecutionEngine();
const TODAY = "2026-06-24";
const FUTURE = "2036-06-24"; // +10y — past any RECURRING window

// An employee whose audiogram is seeded COMPLIANT today (so +10y must flip it to OVERDUE).
const emp = EMPLOYEES.find((e) => seededTargetFor(EMPLOYEES, "audiogram", e.externalId) === "COMPLIANT")!;

test("snapshot covers every runnable measure with a valid display state", async () => {
  const snap = await simulateComplianceAsOf(emp.externalId, TODAY, { engine, today: TODAY });
  assert.ok(snap);
  assert.equal(snap!.externalId, emp.externalId);
  assert.equal(snap!.asOf, TODAY);
  assert.equal(snap!.evaluations.length, Object.keys(MEASURES).length);
  for (const ev of snap!.evaluations) {
    assert.ok(typeof ev.method === "string");
    assert.ok(["COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED", "DECLINED", "IN_PROGRESS", "NA"].includes(ev.status));
  }
});

test("scrubbing the date forward ages a RECURRING measure but leaves PERMANENT unchanged", async () => {
  const now = await simulateComplianceAsOf(emp.externalId, TODAY, { engine, today: TODAY });
  const future = await simulateComplianceAsOf(emp.externalId, FUTURE, { engine, today: TODAY });
  const audNow = now!.evaluations.find((e) => e.measureId === "audiogram")!;
  const audFuture = future!.evaluations.find((e) => e.measureId === "audiogram")!;
  assert.equal(audNow.status, "COMPLIANT");        // seeded compliant at "today"
  assert.equal(audFuture.status, "OVERDUE");       // today-anchored exam is now >10y old
  const mmrNow = now!.evaluations.find((e) => e.measureId === "mmr")!;
  const mmrFuture = future!.evaluations.find((e) => e.measureId === "mmr")!;
  assert.equal(mmrNow.status, mmrFuture.status);   // PERMANENT (series-completion) is date-invariant
});

test("unknown employee → null", async () => {
  assert.equal(await simulateComplianceAsOf("nobody-999", TODAY, { engine, today: TODAY }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/run/employee-compliance-snapshot.test.ts`
Expected: FAIL — `./employee-compliance-snapshot.ts` does not exist.

- [ ] **Step 3: Create `backend-ts/src/run/employee-compliance-snapshot.ts`**

```typescript
/**
 * Advisory, non-persisted, as-of-date compliance re-evaluation for ONE employee (#197). For each active
 * runnable measure it takes the employee's seeded exam config, builds the synthetic bundle anchored to
 * `today` (so events sit at absolute dates), evaluates as-of `asOf`, and maps the result through the
 * shared E10.5 `deriveCell` vocabulary. Writes NOTHING — no runs/outcomes/cases/audit (not a state
 * change). The CQL `Outcome Status` remains the sole compliance authority (ADR-008/ADR-012).
 *
 * Anchoring to `today` (not `asOf`) is what makes scrubbing meaningful: days-since-event = asOf -
 * (today - daysSince), so a later asOf ages a RECURRING measure toward OVERDUE while PERMANENT
 * (series-completion, no recency) measures stay constant.
 */
import { EMPLOYEES, type EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "../engine/synthetic/measure-bindings.ts";
import { deriveExamConfig } from "../engine/synthetic/exam-config.ts";
import { buildSyntheticBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import { seededTargetFor } from "./distribution.ts";
import { deriveCell, type DisplayState } from "../compliance/roster-vocabulary.ts";

export interface SnapshotEvaluation {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  status: DisplayState;
  method: string;
}
export interface EmployeeComplianceSnapshot {
  externalId: string;
  asOf: string;
  evaluations: SnapshotEvaluation[];
}
/** Structural engine type so tests can pass a fake; the real CqlExecutionEngine satisfies it. */
export interface SnapshotEngine {
  evaluate(input: { measureId: string; patientBundle: unknown; evaluationDate?: string }): Promise<{ outcome: string; evidence: unknown }>;
}
export interface SnapshotDeps {
  engine: SnapshotEngine;
  today: string; // YYYY-MM-DD — anchors the synthetic events
  employees?: readonly EmployeeProfile[];
}

export async function simulateComplianceAsOf(
  externalId: string,
  asOf: string,
  deps: SnapshotDeps,
): Promise<EmployeeComplianceSnapshot | null> {
  const employees = deps.employees ?? EMPLOYEES;
  const employee = employees.find((e) => e.externalId === externalId);
  if (!employee) return null;

  const evaluations: SnapshotEvaluation[] = [];
  for (const measureId of Object.keys(MEASURES)) {
    const binding = MEASURE_BINDINGS[measureId];
    if (!binding) continue;
    const name = MEASURES[measureId]!.name;
    try {
      const target = seededTargetFor(employees, binding.rateKey, externalId) ?? "MISSING_DATA";
      const config = deriveExamConfig(binding, target);
      const bundle = buildSyntheticBundle(employee, config, deps.today); // anchor to today
      const outcome = await deps.engine.evaluate({ measureId, patientBundle: bundle, evaluationDate: asOf });
      const cell = deriveCell(outcome.outcome, outcome.evidence, measureId, asOf);
      evaluations.push({ measureId, name, complianceClass: binding.complianceClass, status: cell.status, method: cell.method });
    } catch {
      // One measure failing must not abort the snapshot (mirrors the run pipeline's per-subject guard).
      evaluations.push({ measureId, name, complianceClass: binding.complianceClass, status: "MISSING_DATA", method: "Evaluation error" });
    }
  }
  return { externalId, asOf, evaluations };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/run/employee-compliance-snapshot.test.ts`
Expected: PASS (3 tests). If the `emp` finder returns undefined (no seeded-COMPLIANT audiogram employee), that's a real signal the seed changed — but with the current synthetic directory at least one exists; do not weaken the test, investigate the seed.

- [ ] **Step 5: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add backend-ts/src/run/employee-compliance-snapshot.ts backend-ts/src/run/employee-compliance-snapshot.test.ts
git commit -m "feat(compliance): simulateComplianceAsOf — advisory in-memory as-of-date snapshot (#197)"
```

Append to the commit body:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vj9GhN5vxoENWrwrU56GZz
```

---

## Task 2: `GET /api/employees/:externalId/simulate` route + worker registration

**Files:**
- Create: `backend-ts/src/routes/compliance-simulation.ts`, `backend-ts/src/routes/compliance-simulation.test.ts`
- Modify: `backend-ts/src/worker.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/routes/compliance-simulation.test.ts`:

```typescript
/** Compliance-simulation route — pure synthetic, no DB. node --import tsx --test src/routes/compliance-simulation.test.ts */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPLOYEES } from "../engine/synthetic/employee-catalog.ts";
import { MEASURES } from "../engine/cql/measure-registry.ts";
import { handleComplianceSimulation } from "./compliance-simulation.ts";

const ID = EMPLOYEES[0]!.externalId;
const call = (path: string, method = "GET") => handleComplianceSimulation(new Request(`http://x${path}`, { method }), {} as never);

test("non-matching path / method returns null", async () => {
  assert.equal(await call("/api/employees/x/profile"), null);
  assert.equal(await call(`/api/employees/${ID}/simulate`, "POST"), null);
});

test("GET …/simulate → { externalId, asOf, evaluations[] } for every measure (asOf defaults to today)", async () => {
  const res = (await call(`/api/employees/${ID}/simulate`))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { externalId: string; asOf: string; evaluations: Array<{ measureId: string; status: string; method: string }> };
  assert.equal(body.externalId, ID);
  assert.match(body.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.evaluations.length, Object.keys(MEASURES).length);
});

test("explicit asOf is echoed", async () => {
  const res = (await call(`/api/employees/${ID}/simulate?asOf=2030-01-01`))!;
  const body = (await res.json()) as { asOf: string };
  assert.equal(body.asOf, "2030-01-01");
});

test("malformed asOf → 400", async () => {
  const res = (await call(`/api/employees/${ID}/simulate?asOf=2026-13-99`))!;
  assert.equal(res.status, 400);
});

test("unknown employee → 404", async () => {
  const res = (await call("/api/employees/nobody-999/simulate"))!;
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/routes/compliance-simulation.test.ts`
Expected: FAIL — `./compliance-simulation.ts` does not exist.

- [ ] **Step 3: Create `backend-ts/src/routes/compliance-simulation.ts`**

```typescript
/**
 * Compliance-simulation route — GET /api/employees/:externalId/simulate?asOf=YYYY-MM-DD →
 * { externalId, asOf, evaluations[] }. An advisory, non-persisted, as-of-date re-evaluation of one
 * employee's compliance across every active measure (#197). Authenticated read-only under /api/**
 * (all roles, like the immunization forecast). Writes nothing; no schema. handleEmployees only matches
 * `/profile` + `/search`, so this `/simulate` path is not intercepted.
 */
import { CqlExecutionEngine } from "../engine/cql/cql-execution-engine.ts";
import { parseQueryDate, QueryDateError } from "./query-dates.ts";
import { simulateComplianceAsOf } from "../run/employee-compliance-snapshot.ts";

// The engine is stateless after construction (loaded ELM) — build once, reuse across requests.
const engine = new CqlExecutionEngine();

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleComplianceSimulation(req: Request): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/employees\/([^/]+)\/simulate$/);
  if (!match) return null;

  let externalId: string;
  try {
    externalId = decodeURIComponent(match[1]!);
  } catch {
    return json({ error: "not_found", externalId: match[1]! }, 404); // malformed %-encoding → unknown id
  }

  let asOf: string | undefined;
  try {
    asOf = parseQueryDate(url.searchParams.get("asOf"), "asOf");
  } catch (err) {
    if (err instanceof QueryDateError) return json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }

  const today = new Date().toISOString().slice(0, 10);
  const snapshot = await simulateComplianceAsOf(externalId, asOf ?? today, { engine, today });
  if (!snapshot) return json({ error: "not_found", externalId }, 404);
  return json(snapshot);
}
```

> Note: this handler ignores `env` (pure synthetic, no DB). The worker dispatch passes `(req, env)`; the extra arg is harmless. If the worker's dispatch helper requires a 2-arg signature, add `_env?: unknown` as a second param — confirm against how `handleImmunizationForecast(req, env)` is called in worker.ts and match its arity.

- [ ] **Step 4: Register in `backend-ts/src/worker.ts`**

Add the import next to `import { handleImmunizationForecast } from "./routes/immunization.ts";`:

```typescript
import { handleComplianceSimulation } from "./routes/compliance-simulation.ts";
```

And add the dispatch immediately after the `handleImmunizationForecast` block (`const immunizationResponse = await handleImmunizationForecast(req, env); if (immunizationResponse) return immunizationResponse;`):

```typescript
  // Advisory as-of-date compliance simulation for one employee (#197) — read-only, no writes.
  const simulationResponse = await handleComplianceSimulation(req);
  if (simulationResponse) return simulationResponse;
```

> If the worker calls handlers as `handle(req, env)` uniformly and lint/types object to the arity mismatch, change the call to `handleComplianceSimulation(req, env)` and add a `_env?: unknown` second param to the handler. Match the surrounding dispatch style.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/routes/compliance-simulation.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/routes/compliance-simulation.ts backend-ts/src/routes/compliance-simulation.test.ts backend-ts/src/worker.ts
git commit -m "feat(api): GET /api/employees/:id/simulate — advisory as-of-date compliance (#197)"
```

Append the two trailer lines.

---

## Task 3: `SimulateComplianceHistory` panel + mount

**Files:**
- Create: `frontend/features/employee/components/SimulateComplianceHistory.tsx`, `frontend/features/employee/components/SimulateComplianceHistory.test.tsx`
- Modify: `frontend/app/(dashboard)/employees/[externalId]/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/features/employee/components/SimulateComplianceHistory.test.tsx`:

```tsx
import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const apiMock = { get };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

import { SimulateComplianceHistory } from "./SimulateComplianceHistory";

const snapshotFor = (asOf: string) => ({
  externalId: "emp-001",
  asOf,
  evaluations: [
    { measureId: "audiogram", name: "Audiogram", complianceClass: "RECURRING", status: "OVERDUE", method: "Overdue — last 2024-01-01" },
    { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT", status: "COMPLIANT", method: "2 valid dose(s)" }
  ]
});

beforeEach(() => {
  get.mockReset().mockImplementation((url: string) =>
    Promise.resolve(snapshotFor(new URL(`http://x${url}`).searchParams.get("asOf") ?? "")));
});
afterEach(() => vi.clearAllMocks());

describe("SimulateComplianceHistory", () => {
  it("renders the advisory panel and a chip per simulated measure", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    expect(screen.getByText("Simulate Compliance History")).toBeInTheDocument();
    expect(await screen.findByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
  });

  it("refetches with the new asOf when the date changes", async () => {
    render(<SimulateComplianceHistory externalId="emp-001" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/as of/i), { target: { value: "2030-01-01" } });
    await waitFor(() => expect(String(get.mock.calls.at(-1)?.[0] ?? "")).toContain("asOf=2030-01-01"));
  });

  it("shows an error when the simulation fails", async () => {
    get.mockReset().mockRejectedValue(new Error("boom"));
    render(<SimulateComplianceHistory externalId="emp-001" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run features/employee/components/SimulateComplianceHistory.test.tsx`
Expected: FAIL — `./SimulateComplianceHistory` not found.

- [ ] **Step 3: Create `frontend/features/employee/components/SimulateComplianceHistory.tsx`**

```tsx
"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import type { DisplayState } from "@/features/compliance/types";

interface SnapshotEvaluation {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  status: DisplayState;
  method: string;
}
interface Snapshot {
  externalId: string;
  asOf: string;
  evaluations: SnapshotEvaluation[];
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/** Advisory as-of-date compliance simulation (#197). Scrub the date to see how this employee's
 *  compliance would read on that day — per measure, same chip/method vocabulary as the card. Read-only;
 *  the server persists nothing and CQL stays the sole compliance authority (ADR-008/ADR-012). */
export function SimulateComplianceHistory({ externalId }: { externalId: string }) {
  const api = useApi();
  const [asOf, setAsOf] = useState<string>(todayIso());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (date: string) => {
      setLoading(true);
      setError(null);
      try {
        setSnapshot(await api.get<Snapshot>(`/api/employees/${encodeURIComponent(externalId)}/simulate?asOf=${date}`));
      } catch (e) {
        setError((e as Error).message ?? "Failed to simulate compliance.");
        setSnapshot(null);
      } finally {
        setLoading(false);
      }
    },
    [api, externalId]
  );

  // Debounced fetch when the date changes (also fires on mount). The setState lives in `load` (called
  // from the timer callback), not synchronously in the effect body, so it doesn't trip set-state-in-effect.
  useEffect(() => {
    const t = setTimeout(() => void load(asOf), 300);
    return () => clearTimeout(t);
  }, [load, asOf]);

  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Simulate Compliance History</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            Advisory only — re-evaluates compliance as of the chosen date. Never changes status; CQL is the sole authority.
          </p>
        </div>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">As of</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
        </label>
      </div>

      {error ? (
        <p role="alert" className="mt-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : loading && !snapshot ? (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">Simulating…</p>
      ) : snapshot && snapshot.evaluations.length > 0 ? (
        <div className="mt-3 space-y-2">
          {snapshot.evaluations.map((ev) => (
            <div key={ev.measureId} className="flex items-center justify-between gap-3 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-2">
              <div>
                <span className="text-sm font-medium">{ev.name}</span>
                <span className="ml-1 text-[10px] uppercase text-neutral-400">{ev.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
              </div>
              <ComplianceChip cell={{ status: ev.status, method: ev.method }} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">No measures to simulate.</p>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run the component test to verify it passes**

Run: `cd frontend && npx vitest run features/employee/components/SimulateComplianceHistory.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Mount on the employee page**

In `frontend/app/(dashboard)/employees/[externalId]/page.tsx`:
1. Add the import next to the other `@/features/employee/components/...` imports:
```tsx
import { SimulateComplianceHistory } from "@/features/employee/components/SimulateComplianceHistory";
```
2. Directly after the existing `<IndividualComplianceStatus externalId={externalId} onRecalculated={refetch} />` line, add:
```tsx
      <SimulateComplianceHistory externalId={externalId} />
```
Read the file first to place it in the same column/container as the compliance card.

- [ ] **Step 6: Run the employee feature tests to confirm no regression**

Run: `cd frontend && npx vitest run features/employee`
Expected: PASS (existing card tests + the new panel test).

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/features/employee/components/SimulateComplianceHistory.tsx frontend/features/employee/components/SimulateComplianceHistory.test.tsx "frontend/app/(dashboard)/employees/[externalId]/page.tsx"
git commit -m "feat(compliance): Simulate Compliance History panel on the employee screen (#197)"
```

Append the two trailer lines.

---

## Task 4: Docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`

- [ ] **Step 1: Document the route in `docs/ARCHITECTURE.md` §7 (External Interfaces)**

Add near the `GET /api/outcomes/:outcomeId` bullet:

```markdown
- Compliance simulation (#197): `GET /api/employees/:externalId/simulate?asOf=YYYY-MM-DD` →
  `{ externalId, asOf, evaluations:[{ measureId, name, complianceClass, status, method }] }`. An advisory,
  **non-persisted** as-of-date re-evaluation of one employee across every active measure: per measure it
  takes the seeded exam config, builds the synthetic bundle **anchored to today**, evaluates as-of `asOf`,
  and maps through the shared `deriveCell` vocabulary (so a later date ages RECURRING measures while
  PERMANENT stay constant; simulate-as-of-today reproduces the live cell). `asOf` validated YYYY-MM-DD
  (400 malformed; default today); unknown employee → 404. Authenticated `/api/**` (all roles). **Writes
  nothing** — no runs/outcomes/cases/audit; read-time; no schema. CQL stays the sole authority (ADR-008/ADR-012).
```

And in §4 (Frontend Route Surfaces), append to the `/employees/[externalId]` bullet:

```markdown
  Also a **Simulate Compliance History** panel (E10.4 follow-up / #197): a date scrubber → the advisory
  `/simulate` snapshot rendered per measure with the same chips; advisory only, never sets status.
```

- [ ] **Step 2: Add a `docs/JOURNAL.md` entry on top**

```markdown
## 2026-06-24 — Simulate Compliance History (#197)

Shipped the last per-employee-screen action on `feat/simulate-compliance-history`. `GET
/api/employees/:externalId/simulate?asOf=` runs an advisory, **non-persisted** as-of-date re-evaluation of
one employee across every active measure — reusing the in-memory CQL engine + synthetic adapters
(`simulateComplianceAsOf`): per measure it takes the seeded exam config, builds the bundle **anchored to
today**, evaluates as-of the chosen date, and maps through the shared `deriveCell` vocabulary. Anchoring
to today (not the as-of date) is what makes scrubbing meaningful — a later date ages RECURRING measures
toward OVERDUE while PERMANENT (series-completion) measures stay constant, and simulate-as-of-today
reproduces the live cell. A `SimulateComplianceHistory` panel on `/employees/[externalId]` lets the
operator scrub a date and see the result with the same chips, clearly advisory. **Writes nothing** — no
runs/outcomes/cases/audit; no schema; no new deps. CQL stays the sole compliance authority (ADR-008/ADR-012).
This closes the per-employee-screen trio (Recalculate + evidence drill-in in #198, Simulate here).
```

- [ ] **Step 3: Full backend verification**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit && node --import tsx --test "src/**/*.test.ts"`
Expected: typecheck clean; all tests pass (1 pre-existing Pg-ceiling skip is fine).

- [ ] **Step 4: Full frontend verification**

Run: `cd frontend && npx vitest run && npm run lint && npm run build`
Expected: all Vitest pass; lint clean (the pre-existing `next-font` warning is fine); build compiles. Fix anything red before committing.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md docs/JOURNAL.md
git commit -m "docs(compliance): /api/employees/:id/simulate + Simulate Compliance History panel (#197)"
```

Append the two trailer lines.

---

## Self-Review

**1. Spec coverage:**
- §4.1 snapshot logic (seeded config → today-anchored bundle → evaluate(asOf) → deriveCell; zero writes) → Task 1. ✅
- §4.2 route (asOf validation 400, 404, all-roles, worker registration) → Task 2. ✅
- §4.3 frontend panel (date scrub, debounced fetch, ComplianceChip rows, advisory banner, loading/error) + mount → Task 3. ✅
- §6 error/edge (per-measure try/catch, malformed/unknown, debounce) → Tasks 1–3. ✅
- §7 testing (snapshot incl. the today-anchoring proof, route, frontend) → Tasks 1–3. ✅
- §8 guardrails (advisory, zero writes, no schema/deps) → honored throughout; documented Task 4. ✅

**2. Placeholder scan:** none — every code step is complete. The two worker-arity notes (Task 2 Step 3/4) are explicit "match the surrounding call style" instructions, not missing logic.

**3. Type consistency:** `simulateComplianceAsOf(externalId, asOf, deps): Promise<EmployeeComplianceSnapshot | null>` is identical in the logic (1.3), its test (1.1), and the route consumer (2.3). `SnapshotEvaluation` `{ measureId, name, complianceClass, status, method }` matches between the logic (1.3), the route JSON, the frontend `Snapshot` type (3.3), and both tests. `deps` is `{ engine, today, employees? }` everywhere. `ComplianceChip` takes `{ cell: { status, method } }` — the panel passes exactly that (3.3). The route path regex `^\/api\/employees\/([^/]+)\/simulate$` matches the test calls (2.1) and is confirmed not intercepted by `handleEmployees` (only `/profile`+`/search`).
