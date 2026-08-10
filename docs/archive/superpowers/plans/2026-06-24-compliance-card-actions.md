# Per-Employee Compliance Card — Actions + Evidence Drill-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-employee "Individual Compliance Status" card actionable — a **Recalculate** button (synchronous EMPLOYEE run + full-profile refresh) and per-row **inline CQL evidence** (lazy-fetched, rendered with a shared evidence component reused on case-detail).

**Architecture:** One small read-only backend endpoint (`GET /api/outcomes/:outcomeId`) hydrates a roster cell's `evidenceRef`. The case-detail evidence JSX is extracted into a shared `CqlEvidence`/`CqlExpressionResults`/`CqlWhyFlagged` component (no duplication). The card gains a `load` refetch, a RBAC-gated Recalculate that reuses the existing audited `POST /api/runs/manual` EMPLOYEE path, and a lazy evidence fetch per expanded row. `useEmployeeProfile` exposes `refetch` so Recalculate refreshes the whole profile. No schema change; CQL stays the sole compliance authority (ADR-008).

**Tech Stack:** backend-ts (`@mieweb/cloud` worker, SQLite floor + Postgres ceiling, `node --test`); frontend (Next.js 16, React 19, Tailwind 4, Vitest + React Testing Library).

---

## File Structure

**Backend — create:**
- `backend-ts/src/routes/outcomes.ts` — `handleOutcomes` route (`GET /api/outcomes/:outcomeId`).
- `backend-ts/src/routes/outcomes.test.ts` — route test (seeded SQLite).
- `backend-ts/src/stores/sqlite/outcome-store-getbyid.test.ts` — store-method test.

**Backend — modify:**
- `backend-ts/src/stores/outcome-store.ts` — add `getOutcomeById` to the `OutcomeStore` interface.
- `backend-ts/src/stores/sqlite/outcome-store-sqlite.ts` — implement `getOutcomeById`.
- `backend-ts/src/stores/postgres/outcome-store-postgres.ts` — implement `getOutcomeById`.
- `backend-ts/src/worker.ts` — import + dispatch `handleOutcomes` after `handleCompliance`.

**Frontend — create:**
- `frontend/features/evidence/CqlEvidence.tsx` — shared CQL evidence component (3 exports).
- `frontend/features/evidence/CqlEvidence.test.tsx` — component test.

**Frontend — modify:**
- `frontend/app/(dashboard)/cases/[id]/page.tsx` — use the shared evidence components; drop the local `INTERNAL_DEFINES`/`isInternalDefine` + inline evidence JSX.
- `frontend/features/employee/hooks/useEmployeeProfile.ts` — expose `refetch`.
- `frontend/features/employee/components/IndividualComplianceStatus.tsx` — `load` refetch, Recalculate, evidence drill-in, `onRecalculated` prop.
- `frontend/features/employee/components/IndividualComplianceStatus.test.tsx` — updated/added tests.
- `frontend/app/(dashboard)/employees/[externalId]/page.tsx` — pass `onRecalculated={refetch}`.

**Docs — modify:**
- `docs/ARCHITECTURE.md` (§7 endpoints), `docs/JOURNAL.md` (dated entry).

---

## Task 1: `getOutcomeById` store method (interface + SQLite + Postgres)

**Files:**
- Modify: `backend-ts/src/stores/outcome-store.ts`, `backend-ts/src/stores/sqlite/outcome-store-sqlite.ts`, `backend-ts/src/stores/postgres/outcome-store-postgres.ts`
- Test: `backend-ts/src/stores/sqlite/outcome-store-getbyid.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/stores/sqlite/outcome-store-getbyid.test.ts`:

```typescript
/** getOutcomeById round-trip on the SQLite floor.
 *   node --import tsx --test src/stores/sqlite/outcome-store-getbyid.test.ts */
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

const dbPath = join(tmpdir(), `ww-outcome-getbyid-${crypto.randomUUID()}.sqlite`);
let outcomes: SqliteOutcomeStore;
let outcomeId = "";

before(async () => {
  const db = await createSqliteD1(dbPath);
  await db.exec(RUN_STORE_FLOOR_DDL.replace(/\n/g, " "));
  const runStore = new SqliteRunStore(db);
  outcomes = new SqliteOutcomeStore(db);
  const run = await runStore.createRun({
    scopeType: "MEASURE", scopeId: "mmr", triggeredBy: "test", requestedScope: { measureId: "mmr" },
    measurementPeriodStart: "2026-06-12T00:00:00.000Z", measurementPeriodEnd: "2026-06-12T00:00:00.000Z",
  });
  const rec = await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-001", measureId: "mmr", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [{ define: "Dose Count", result: 2 }] },
  });
  outcomeId = rec.id;
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("getOutcomeById returns the record with parsed evidence", async () => {
  const o = await outcomes.getOutcomeById(outcomeId);
  assert.ok(o, "expected a record");
  assert.equal(o!.status, "COMPLIANT");
  assert.equal(o!.subjectId, "emp-001");
  assert.deepEqual(o!.evidence, { expressionResults: [{ define: "Dose Count", result: 2 }] });
});

test("getOutcomeById returns null for an unknown id", async () => {
  assert.equal(await outcomes.getOutcomeById("00000000-0000-0000-0000-000000000000"), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/stores/sqlite/outcome-store-getbyid.test.ts`
Expected: FAIL — `getOutcomeById` is not a function.

- [ ] **Step 3: Add `getOutcomeById` to the `OutcomeStore` interface**

In `backend-ts/src/stores/outcome-store.ts`, inside `export interface OutcomeStore { … }`, add after the `listOutcomes(runId)` line:

```typescript
  getOutcomeById(id: string): Promise<OutcomeRecord | null>;
```

- [ ] **Step 4: Implement it on the SQLite floor**

In `backend-ts/src/stores/sqlite/outcome-store-sqlite.ts`, add this method to the `SqliteOutcomeStore` class, right after `listOutcomes` (it reuses the file's existing `toRecord` mapper and `OutcomeRow` type):

```typescript
  async getOutcomeById(id: string): Promise<OutcomeRecord | null> {
    const { results } = await this.db
      .prepare(
        `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
           FROM outcomes WHERE id = ?`,
      )
      .bind(id)
      .all<OutcomeRow>();
    const row = (results ?? [])[0];
    return row ? toRecord(row) : null;
  }
```

- [ ] **Step 5: Implement it on the Postgres ceiling**

In `backend-ts/src/stores/postgres/outcome-store-postgres.ts`, add this method to the class right after `listOutcomes` (it reuses the file's existing `T`, `isUuid`, `toRecord`, and `OutcomeRow`):

```typescript
  async getOutcomeById(id: string): Promise<OutcomeRecord | null> {
    // Native UUID column — a malformed id yields no rows on the floor; don't let Postgres throw.
    if (!isUuid(id)) return null;
    const { rows } = await this.pool.query<OutcomeRow>(
      `SELECT id, run_id, subject_id, measure_id, evaluation_period, status, evidence_json, evaluated_at
         FROM ${T} WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? toRecord(row) : null;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/stores/sqlite/outcome-store-getbyid.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors (every `OutcomeStore` implementer now satisfies the interface).

- [ ] **Step 8: Commit**

```bash
git add backend-ts/src/stores/outcome-store.ts backend-ts/src/stores/sqlite/outcome-store-sqlite.ts backend-ts/src/stores/postgres/outcome-store-postgres.ts backend-ts/src/stores/sqlite/outcome-store-getbyid.test.ts
git commit -m "feat(stores): OutcomeStore.getOutcomeById (floor + ceiling) for evidence drill-in"
```

Append to the commit body:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vj9GhN5vxoENWrwrU56GZz
```

---

## Task 2: `GET /api/outcomes/:outcomeId` route + worker registration

**Files:**
- Create: `backend-ts/src/routes/outcomes.ts`, `backend-ts/src/routes/outcomes.test.ts`
- Modify: `backend-ts/src/worker.ts`

- [ ] **Step 1: Write the failing test**

Create `backend-ts/src/routes/outcomes.test.ts`:

```typescript
/** Outcome evidence route — seed a minimal DB, call handleOutcomes, assert shape.
 *   node --import tsx --test src/routes/outcomes.test.ts */
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
import { handleOutcomes } from "./outcomes.ts";

const dbPath = join(tmpdir(), `ww-outcomes-route-${crypto.randomUUID()}.sqlite`);
let env: { DB: unknown };
let outcomeId = "";

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
  const rec = await outcomes.recordOutcome({
    runId: run.id, subjectId: "emp-001", measureId: "mmr", status: "COMPLIANT", evaluationPeriod: "2026-06-12",
    evidence: { expressionResults: [{ define: "Dose Count", result: 2 }] },
  });
  outcomeId = rec.id;
});
after(() => { try { rmSync(dbPath, { force: true }); } catch { /* best effort */ } });

test("non-outcomes path returns null (not this route)", async () => {
  assert.equal(await handleOutcomes(new Request("http://x/api/other", { method: "GET" }), env as never), null);
});

test("POST is not handled by this route", async () => {
  assert.equal(await handleOutcomes(new Request(`http://x/api/outcomes/${outcomeId}`, { method: "POST" }), env as never), null);
});

test("GET /api/outcomes/:id → { outcomeId, status, evidenceJson }", async () => {
  const res = (await handleOutcomes(new Request(`http://x/api/outcomes/${outcomeId}`, { method: "GET" }), env as never))!;
  assert.equal(res.status, 200);
  const body = (await res.json()) as { outcomeId: string; status: string; evidenceJson: { expressionResults: Array<{ define: string; result: unknown }> } };
  assert.equal(body.outcomeId, outcomeId);
  assert.equal(body.status, "COMPLIANT");
  assert.equal(body.evidenceJson.expressionResults[0]!.define, "Dose Count");
});

test("GET unknown outcome id → 404", async () => {
  const res = (await handleOutcomes(new Request("http://x/api/outcomes/00000000-0000-0000-0000-000000000000", { method: "GET" }), env as never))!;
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend-ts && node --import tsx --test src/routes/outcomes.test.ts`
Expected: FAIL — `./outcomes.ts` does not exist.

- [ ] **Step 3: Create the route `backend-ts/src/routes/outcomes.ts`**

```typescript
/**
 * Outcome evidence route — GET /api/outcomes/:outcomeId → { outcomeId, status, evidenceJson }.
 * Hydrates a roster cell's `evidenceRef` so the per-employee compliance card can show the CQL
 * expressionResults/why_flagged inline (the same evidence the case-detail page shows). Authenticated
 * read-only under the /api/** matrix (all roles). Read-only; no schema.
 */
import type { CloudDatabase } from "@mieweb/cloud";
import { getStores } from "../stores/factory.ts";

interface OutcomesEnv {
  DB: CloudDatabase;
  DATABASE_URL?: string;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleOutcomes(req: Request, env: OutcomesEnv): Promise<Response | null> {
  if (req.method !== "GET") return null;
  const url = new URL(req.url);
  const match = url.pathname.match(/^\/api\/outcomes\/([^/]+)$/);
  if (!match) return null;

  const outcomeId = decodeURIComponent(match[1]!);
  const stores = await getStores(env);
  const outcome = await stores.outcomes.getOutcomeById(outcomeId);
  if (!outcome) return json({ error: "not_found", outcomeId }, 404);
  return json({ outcomeId: outcome.id, status: outcome.status, evidenceJson: outcome.evidence });
}
```

- [ ] **Step 4: Register it in `backend-ts/src/worker.ts`**

Add the import next to the other route imports (near `import { handleCompliance } from "./routes/compliance.ts";`):

```typescript
import { handleOutcomes } from "./routes/outcomes.ts";
```

And add the dispatch immediately after the `handleCompliance` block (after `if (complianceResponse) return complianceResponse;`):

```typescript
  // Single outcome evidence — hydrates a roster cell's evidenceRef for the compliance card.
  const outcomesResponse = await handleOutcomes(req, env);
  if (outcomesResponse) return outcomesResponse;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend-ts && node --import tsx --test src/routes/outcomes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Typecheck**

Run: `cd backend-ts && node_modules/.bin/tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add backend-ts/src/routes/outcomes.ts backend-ts/src/routes/outcomes.test.ts backend-ts/src/worker.ts
git commit -m "feat(api): GET /api/outcomes/:outcomeId evidence endpoint (read-only, no schema)"
```

Append the same two trailer lines as Task 1.

---

## Task 3: Shared `CqlEvidence` component + case-detail refactor

Extract the case-detail evidence rendering into one component (3 exports) and reuse it on case-detail, removing the duplication. `CqlExpressionResults` + `CqlWhyFlagged` preserve the case-detail layout exactly (they slot into the same two places); `CqlEvidence` composes both for the card.

**Files:**
- Create: `frontend/features/evidence/CqlEvidence.tsx`, `frontend/features/evidence/CqlEvidence.test.tsx`
- Modify: `frontend/app/(dashboard)/cases/[id]/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/features/evidence/CqlEvidence.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CqlEvidence } from "./CqlEvidence";

describe("CqlEvidence", () => {
  it("renders non-internal defines and filters internal ones", () => {
    render(<CqlEvidence evidence={{ expressionResults: [
      { define: "Dose Count", result: 2 },
      { define: "Numerator", result: true },
      { define: "Outcome Status", result: "COMPLIANT" }
    ] }} />);
    expect(screen.getByText("Dose Count")).toBeInTheDocument();
    expect(screen.getByText("Outcome Status")).toBeInTheDocument();
    expect(screen.queryByText("Numerator")).not.toBeInTheDocument();
  });

  it("renders the why_flagged summary rows", () => {
    render(<CqlEvidence evidence={{ why_flagged: {
      last_exam_date: "2025-08-10", compliance_window_days: 365, days_overdue: 12,
      role_eligible: true, site_eligible: true, waiver_status: "NONE"
    } }} />);
    expect(screen.getByText("Last exam date")).toBeInTheDocument();
    expect(screen.getByText("2025-08-10")).toBeInTheDocument();
    expect(screen.getByText("Waiver status")).toBeInTheDocument();
  });

  it("shows a fallback when there is no evidence", () => {
    render(<CqlEvidence evidence={null} />);
    expect(screen.getByText("No evidence recorded.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run features/evidence/CqlEvidence.test.tsx`
Expected: FAIL — `./CqlEvidence` not found.

- [ ] **Step 3: Create `frontend/features/evidence/CqlEvidence.tsx`**

```tsx
import React from "react";

export interface EvidenceJson {
  expressionResults?: Array<Record<string, unknown>>;
  evaluatedResource?: Record<string, unknown>;
  why_flagged?: {
    last_exam_date: string | null;
    compliance_window_days: number;
    days_overdue: number | null;
    role_eligible: boolean;
    site_eligible: boolean;
    waiver_status: string;
    outcome_status?: string;
  };
}

const INTERNAL_DEFINES = new Set([
  "Patient",
  "Initial Population",
  "Numerator",
  "Numerator Exclusion",
  "Denominator",
  "Denominator Exclusion",
  "Denominator Exception",
]);
const isInternalDefine = (define: string): boolean => INTERNAL_DEFINES.has(define.trim());

function WhyFlaggedRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="font-medium text-neutral-800 dark:text-neutral-200">{value}</dd>
    </div>
  );
}

/** The non-internal CQL define results as define→result chips. Single source for case-detail + the
 *  per-employee compliance card. Display-only; never affects compliance (ADR-008). */
export function CqlExpressionResults({ results }: { results?: Array<Record<string, unknown>> }) {
  const rows = (results ?? []).filter((row) => !isInternalDefine(String(row.define ?? "")));
  if (rows.length === 0) {
    return <p className="text-xs italic text-neutral-500 dark:text-neutral-400">No evidence recorded.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const defineStr = String(row.define ?? "define");
        const resultStr = String(row.result ?? "");
        const isOutcomeStatus = defineStr === "Outcome Status";
        const isTrue = resultStr.toLowerCase() === "true";
        const isFalse = resultStr.toLowerCase() === "false";
        const isNull = resultStr === "null" || resultStr === "";
        const isDate = /^\d{4}-\d{2}-\d{2}/.test(resultStr);
        const isNumber = !isNaN(Number(resultStr)) && resultStr !== "" && !isDate;
        let chipClass = "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
        let chipLabel = resultStr || "—";
        if (isOutcomeStatus) {
          chipClass = "bg-amber-100 text-amber-900 font-semibold";
        } else if (isTrue) {
          chipClass = "bg-emerald-100 text-emerald-800";
          chipLabel = "✓ true";
        } else if (isFalse) {
          chipClass = "bg-red-100 text-red-800";
          chipLabel = "✗ false";
        } else if (isNull) {
          chipClass = "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 italic";
          chipLabel = "not found";
        } else if (isDate) {
          chipClass = "bg-blue-100 text-blue-800";
          chipLabel = `📅 ${resultStr.slice(0, 10)}`;
        } else if (isNumber) {
          const n = Number(resultStr);
          chipClass = n > 0 ? "bg-orange-100 text-orange-800" : "bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300";
        }
        return (
          <div
            key={`${defineStr}-${index}`}
            className="flex items-center justify-between gap-4 rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 px-4 py-3"
          >
            <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{defineStr}</p>
            <span className={`rounded-full px-3 py-1 text-xs ${chipClass}`}>{chipLabel}</span>
          </div>
        );
      })}
    </div>
  );
}

/** The why_flagged derived summary. Returns null when absent. */
export function CqlWhyFlagged({ whyFlagged }: { whyFlagged?: EvidenceJson["why_flagged"] }) {
  if (!whyFlagged) return null;
  return (
    <dl className="grid gap-2 text-xs text-neutral-700 dark:text-neutral-300 sm:grid-cols-2">
      <WhyFlaggedRow label="Last exam date" value={whyFlagged.last_exam_date ?? "None"} />
      <WhyFlaggedRow label="Window (days)" value={String(whyFlagged.compliance_window_days)} />
      <WhyFlaggedRow label="Days overdue" value={String(whyFlagged.days_overdue ?? 0)} />
      <WhyFlaggedRow label="Role eligible" value={whyFlagged.role_eligible ? "Yes" : "No"} />
      <WhyFlaggedRow label="Site eligible" value={whyFlagged.site_eligible ? "Yes" : "No"} />
      <WhyFlaggedRow label="Waiver status" value={whyFlagged.waiver_status} />
    </dl>
  );
}

/** Both halves together (define chips + why_flagged) — used by the per-employee compliance card. */
export function CqlEvidence({ evidence }: { evidence: EvidenceJson | null | undefined }) {
  return (
    <div className="space-y-3">
      <CqlExpressionResults results={evidence?.expressionResults} />
      <CqlWhyFlagged whyFlagged={evidence?.why_flagged} />
    </div>
  );
}
```

- [ ] **Step 4: Run the component test to verify it passes**

Run: `cd frontend && npx vitest run features/evidence/CqlEvidence.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor `cases/[id]/page.tsx` to use the shared components**

In `frontend/app/(dashboard)/cases/[id]/page.tsx`:

1. Add the import near the top:
```tsx
import { CqlExpressionResults, CqlWhyFlagged } from "@/features/evidence/CqlEvidence";
```
2. Delete the local `INTERNAL_DEFINES` set and the `isInternalDefine` function (lines ~17-29).
3. Replace **both** inline `expressionResults` rendering blocks (the mobile block ~608-616 and the desktop styled-chip block ~953-994) with:
```tsx
<CqlExpressionResults results={caseDetail.evidenceJson.expressionResults} />
```
4. Replace the inline `why_flagged` `<dl>` block (~1021-1030) with:
```tsx
<CqlWhyFlagged whyFlagged={caseDetail.evidenceJson.why_flagged} />
```
5. If the file's local `Row` helper is now unused after removing the why_flagged dl, delete it; if it is still referenced elsewhere in the file, leave it. (Grep the file for `<Row ` to decide.)

> Note: the mobile evidence view now uses the same chip styling as desktop — a deliberate consolidation (content is a superset; same define names + results). This is the intended single-source outcome.

- [ ] **Step 6: Run the case-detail tests + typecheck to confirm no regression**

Run: `cd frontend && npx vitest run "app/(dashboard)/cases" && npx tsc --noEmit`
Expected: PASS / no errors. If a case-detail test asserted the *old* mobile markup or a raw `"true"`/`"false"` result string that the chip now renders as `"✓ true"`/`"✗ false"`, update that assertion to the unified rendering (the define name + the chip label). Do not weaken a test — re-point it at the equivalent rendered text.

- [ ] **Step 7: Commit**

```bash
git add frontend/features/evidence/CqlEvidence.tsx frontend/features/evidence/CqlEvidence.test.tsx "frontend/app/(dashboard)/cases/[id]/page.tsx"
git commit -m "refactor(evidence): shared CqlEvidence component; case-detail reuses it (no duplication)"
```

Append the two trailer lines.

---

## Task 4: `useEmployeeProfile` refetch + card actions (Recalculate + evidence drill-in)

**Files:**
- Modify: `frontend/features/employee/hooks/useEmployeeProfile.ts`, `frontend/features/employee/components/IndividualComplianceStatus.tsx`, `frontend/app/(dashboard)/employees/[externalId]/page.tsx`
- Test: `frontend/features/employee/components/IndividualComplianceStatus.test.tsx`

- [ ] **Step 1: Expose `refetch` from `useEmployeeProfile`**

Replace the body of `frontend/features/employee/hooks/useEmployeeProfile.ts`'s `useEmployeeProfile` function (keep all the exported interfaces above it unchanged) with:

```tsx
export function useEmployeeProfile(externalId: string) {
  const api = useApi();
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!externalId) return;
    setLoading(true);
    setError(null);
    try {
      setProfile(await api.get<EmployeeProfile>(`/api/employees/${externalId}/profile`));
    } catch (e) {
      setError((e as Error).message ?? "Failed to load profile");
    } finally {
      setLoading(false);
    }
  }, [api, externalId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { profile, loading, error, refetch };
}
```

And update the import line at the top of the file from `import { useEffect, useState } from 'react';` to:

```tsx
import { useCallback, useEffect, useState } from 'react';
```

- [ ] **Step 2: Write the failing tests (rewrite the card test file)**

Replace the entire contents of `frontend/features/employee/components/IndividualComplianceStatus.test.tsx` with:

```tsx
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
const get = vi.fn();
const post = vi.fn();
const apiMock = { getWithHeaders, get, post };
vi.mock("@/lib/api/hooks", () => ({ useApi: () => apiMock }));

// All roles read the card; Recalculate is gated. Default to ADMIN (can recalc).
const authState = { role: "ROLE_ADMIN" as string | null };
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: authState.role ? { role: authState.role } : null }) }));

import { IndividualComplianceStatus } from "./IndividualComplianceStatus";

function rosterFor(panel: string, measureId: string, name: string, status: string, method: string, outcomeId = "oc-1") {
  return {
    data: {
      panel,
      columns: [{ measureId, name, complianceClass: "PERMANENT" }],
      rows: [{
        subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
        cells: { [measureId]: { status, method, evidenceRef: { runId: "run-7", outcomeId } } }
      }]
    },
    headers: new Headers({ "X-Total-Count": "1" })
  };
}

beforeEach(() => {
  authState.role = "ROLE_ADMIN";
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    if (url.includes("panel=immunizations")) return Promise.resolve(rosterFor("immunizations", "mmr", "MMR", "COMPLIANT", "2 valid dose(s)"));
    if (url.includes("panel=osha")) return Promise.resolve(rosterFor("osha", "audiogram", "Audiogram", "OVERDUE", "Overdue — last 2024-01-01", "oc-2"));
    return Promise.resolve(rosterFor("wellness", "cms122", "Diabetes HbA1c", "MISSING_DATA", "No record on file", "oc-3"));
  });
  get.mockReset().mockResolvedValue({ outcomeId: "oc-1", status: "COMPLIANT", evidenceJson: { expressionResults: [{ define: "Dose Count", result: 2 }] } });
  post.mockReset().mockResolvedValue({ runId: "run-emp", status: "COMPLETED" });
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("IndividualComplianceStatus", () => {
  it("merges all three panels into one RULE→STATUS→METHOD table", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    expect(await screen.findByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("Diabetes HbA1c")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("expanding a row lazy-fetches and renders the CQL evidence", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    const infoButtons = await screen.findAllByRole("button", { name: /info/i });
    await userEvent.click(infoButtons[0]);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/outcomes/oc-1"));
    expect(await screen.findByText("Dose Count")).toBeInTheDocument();
  });

  it("Recalculate posts an EMPLOYEE run, then refetches and notifies the parent", async () => {
    const onRecalculated = vi.fn();
    render(<IndividualComplianceStatus externalId="emp-001" onRecalculated={onRecalculated} />);
    await screen.findByText("MMR");
    getWithHeaders.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /recalculate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "EMPLOYEE", employeeExternalId: "emp-001" }));
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled()); // card reloaded
    expect(onRecalculated).toHaveBeenCalled();
  });

  it("hides Recalculate for roles that cannot run measures", async () => {
    authState.role = "ROLE_VIEWER";
    render(<IndividualComplianceStatus externalId="emp-001" />);
    await screen.findByText("MMR");
    expect(screen.queryByRole("button", { name: /recalculate/i })).not.toBeInTheDocument();
  });

  it("shows 'Evidence unavailable' when the evidence fetch fails", async () => {
    get.mockReset().mockRejectedValue(new Error("boom"));
    render(<IndividualComplianceStatus externalId="emp-001" />);
    const infoButtons = await screen.findAllByRole("button", { name: /info/i });
    await userEvent.click(infoButtons[0]);
    expect(await screen.findByText("Evidence unavailable.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run features/employee/components/IndividualComplianceStatus.test.tsx`
Expected: FAIL — no Recalculate button / no evidence fetch yet.

- [ ] **Step 4: Rewrite `IndividualComplianceStatus.tsx`**

Replace the entire file `frontend/features/employee/components/IndividualComplianceStatus.tsx` with:

```tsx
"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useApi } from "@/lib/api/hooks";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { CqlEvidence, type EvidenceJson } from "@/features/evidence/CqlEvidence";
import { PANEL_OPTIONS, type Roster, type RosterCell } from "@/features/compliance/types";

interface Row {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  cell: RosterCell;
}
interface EvidenceState {
  loading: boolean;
  evidence?: EvidenceJson;
  error?: boolean;
}

/** Single-person mirror of the roster grid: RULE → STATUS → METHOD over every applicable measure across
 *  all panels (one roster call per panel, filtered to this subject). Adds a Recalculate action (sync
 *  EMPLOYEE run) and a per-row Info expander that lazy-loads the CQL evidence. Read-only display of
 *  compliance; recalculation reuses the audited run path; never sets status (ADR-008). */
export function IndividualComplianceStatus({
  externalId,
  onRecalculated,
}: {
  externalId: string;
  onRecalculated?: () => void;
}) {
  const api = useApi();
  const { user } = useAuth();
  const canRecalc = canRunMeasures(user?.role);

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [recalcBusy, setRecalcBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceByOutcome, setEvidenceByOutcome] = useState<Record<string, EvidenceState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ q: externalId, pageSize: "200" });
    const results = await Promise.all(
      PANEL_OPTIONS.map(async (p) => {
        try {
          const { data } = await api.getWithHeaders<Roster>(`/api/compliance/roster?panel=${p.id}&${params.toString()}`);
          return data;
        } catch {
          return null; // one bad panel never blanks the card
        }
      })
    );
    const merged: Row[] = [];
    for (const roster of results) {
      if (!roster) continue;
      const match = roster.rows.find((r) => r.subject.externalId === externalId);
      if (!match) continue;
      for (const col of roster.columns) {
        const cell = match.cells[col.measureId];
        if (!cell) continue;
        merged.push({ measureId: col.measureId, name: col.name, complianceClass: col.complianceClass, cell });
      }
    }
    setRows(merged);
    setLoading(false);
  }, [api, externalId]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(
    async (measureId: string, cell: RosterCell) => {
      const willOpen = !(open[measureId] ?? false);
      setOpen((o) => ({ ...o, [measureId]: willOpen }));
      if (!willOpen || !cell.evidenceRef) return;
      const oid = cell.evidenceRef.outcomeId;
      if (evidenceByOutcome[oid]) return; // already fetched (or fetching)
      setEvidenceByOutcome((m) => ({ ...m, [oid]: { loading: true } }));
      try {
        const res = await api.get<{ evidenceJson: EvidenceJson }>(`/api/outcomes/${encodeURIComponent(oid)}`);
        setEvidenceByOutcome((m) => ({ ...m, [oid]: { loading: false, evidence: res.evidenceJson } }));
      } catch {
        setEvidenceByOutcome((m) => ({ ...m, [oid]: { loading: false, error: true } }));
      }
    },
    [api, open, evidenceByOutcome]
  );

  const recalculate = useCallback(async () => {
    if (!canRecalc) return;
    if (!window.confirm(`Recalculate compliance for ${externalId}? This re-evaluates every active measure for this employee.`)) return;
    setRecalcBusy(true);
    setError(null);
    try {
      await api.post<{ scopeType: string; employeeExternalId: string }, unknown>("/api/runs/manual", {
        scopeType: "EMPLOYEE",
        employeeExternalId: externalId,
      });
      await load();
      onRecalculated?.();
    } catch (e) {
      setError((e as Error).message ?? "Failed to recalculate.");
    } finally {
      setRecalcBusy(false);
    }
  }, [api, canRecalc, externalId, load, onRecalculated]);

  return (
    <section className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Individual Compliance Status</h2>
        {canRecalc ? (
          <button
            type="button"
            onClick={recalculate}
            disabled={recalcBusy}
            className="rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {recalcBusy ? "Recalculating…" : "Recalculate"}
          </button>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mb-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Loading compliance…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">No evaluated measures for this employee yet.</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase text-neutral-400">
              <th scope="col" className="py-1 pr-3 font-semibold">Rule</th>
              <th scope="col" className="py-1 pr-3 font-semibold">Status &amp; Method</th>
              <th scope="col" className="py-1 font-semibold"><span className="sr-only">Details</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = open[row.measureId] ?? false;
              const ev = row.cell.evidenceRef ? evidenceByOutcome[row.cell.evidenceRef.outcomeId] : undefined;
              return (
                <React.Fragment key={row.measureId}>
                  <tr className="border-t border-neutral-200 dark:border-neutral-800">
                    <td className="py-2 pr-3 align-top">
                      <span className="font-medium">{row.name}</span>
                      <span className="ml-1 text-[10px] uppercase text-neutral-400">{row.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
                    </td>
                    <td className="py-2 pr-3 align-top"><ComplianceChip cell={row.cell} /></td>
                    <td className="py-2 align-top">
                      <button
                        type="button"
                        aria-label={`Info: ${row.name}`}
                        onClick={() => void toggle(row.measureId, row.cell)}
                        className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
                      >
                        {isOpen ? "Hide" : "Info"}
                      </button>
                    </td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-neutral-50 dark:bg-neutral-900/40">
                      <td colSpan={3} className="px-3 py-2 text-xs text-neutral-600 dark:text-neutral-300">
                        <div>Method: {row.cell.method}</div>
                        <div>Compliance class: {row.complianceClass}</div>
                        {row.cell.evidenceRef ? (
                          <div className="mt-2">
                            {!ev || ev.loading ? (
                              <p className="italic text-neutral-400">Loading evidence…</p>
                            ) : ev.error ? (
                              <p className="italic text-neutral-400">Evidence unavailable.</p>
                            ) : (
                              <CqlEvidence evidence={ev.evidence} />
                            )}
                          </div>
                        ) : (
                          <div className="mt-1 italic text-neutral-400">Not evaluated.</div>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Pass `onRecalculated` from the employee page**

In `frontend/app/(dashboard)/employees/[externalId]/page.tsx`:
1. Change the profile hook destructure (line ~20) to capture `refetch`:
```tsx
  const { profile, loading, error, refetch } = useEmployeeProfile(externalId);
```
2. Change the mount (line ~79) to:
```tsx
      <IndividualComplianceStatus externalId={externalId} onRecalculated={refetch} />
```

- [ ] **Step 6: Run the card tests to verify they pass**

Run: `cd frontend && npx vitest run features/employee/components/IndividualComplianceStatus.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/features/employee/hooks/useEmployeeProfile.ts frontend/features/employee/components/IndividualComplianceStatus.tsx frontend/features/employee/components/IndividualComplianceStatus.test.tsx "frontend/app/(dashboard)/employees/[externalId]/page.tsx"
git commit -m "feat(compliance): per-employee card Recalculate + lazy CQL evidence drill-in (#191 follow-up)"
```

Append the two trailer lines.

---

## Task 5: Docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `docs/JOURNAL.md`

- [ ] **Step 1: Document the endpoint in `docs/ARCHITECTURE.md` §7 (External Interfaces)**

Add this bullet near the compliance roster entry:

```markdown
- Outcome evidence (compliance card): `GET /api/outcomes/:outcomeId` → `{ outcomeId, status, evidenceJson }`
  — hydrates a roster cell's `evidenceRef` so the per-employee compliance card shows the CQL
  `expressionResults`/`why_flagged` inline (the same evidence case-detail shows). Authenticated under
  `/api/**` (all roles), read-time, **no schema**. The card's **Recalculate** reuses the existing
  synchronous `POST /api/runs/manual` EMPLOYEE path (audited); display-only, never sets status (ADR-008).
```

- [ ] **Step 2: Add a `docs/JOURNAL.md` entry on top**

```markdown
## 2026-06-24 — Per-employee compliance card: Recalculate + CQL evidence drill-in

Finished the two E10.4 deferrals on the `/employees/[externalId]` Individual Compliance Status card
(`feat/compliance-card-actions`). **Recalculate** — a RBAC-gated button that fires the existing
synchronous EMPLOYEE run (`POST /api/runs/manual`, audited), then refetches the card and the whole
profile (`useEmployeeProfile` now exposes `refetch`). **Evidence drill-in** — each row's Info expander
lazy-loads the cell's outcome via a new read-only `GET /api/outcomes/:outcomeId` (`getOutcomeById` on the
floor + ceiling; no schema) and renders the CQL `expressionResults`/`why_flagged` through a new shared
`CqlEvidence` component, which **also replaces the duplicated inline evidence JSX on case-detail** (single
source). CQL stays the sole compliance authority — the endpoint is read-only and the card never derives
status (ADR-008). Simulate Compliance History stays deferred (its own issue, #197). Backend + frontend
suites green; lint + build clean.
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
git commit -m "docs(compliance): /api/outcomes/:id + card Recalculate/evidence drill-in (#191 follow-up)"
```

Append the two trailer lines.

---

## Self-Review

**1. Spec coverage:**
- §4.1 backend endpoint + store method → Tasks 1–2. ✅
- §4.2 shared `CqlEvidence` + case-detail refactor → Task 3. ✅
- §4.3 `useEmployeeProfile.refetch` + Recalculate + evidence drill-in + mount `onRecalculated` → Task 4. ✅
- §6 error/edge (recalc failure inline, evidence 404 → "unavailable", NA cells, RBAC hidden) → Task 4 code + tests. ✅
- §7 testing (store, route, CqlEvidence, card actions) → Tasks 1–4. ✅
- §8 guardrails (read-only, no schema, ADR-008) → honored throughout; documented Task 5. ✅
- §9 Simulate History deferred → issue #197 (not in this plan). ✅

**2. Placeholder scan:** none — every code step is complete. The two judgment notes (Task 3 Step 5 `<Row>` removal, Task 3 Step 6 test re-pointing) are explicit grep-and-decide instructions, not missing logic.

**3. Type consistency:** `getOutcomeById(id): Promise<OutcomeRecord | null>` is identical in the interface (Task 1.3), SQLite (1.4), Postgres (1.5), the route consumer (2.3), and the card's `get<{ evidenceJson: EvidenceJson }>` (4.4). `EvidenceJson` is exported from `CqlEvidence.tsx` (Task 3.3) and imported by the card (Task 4.4). The route returns `{ outcomeId, status, evidenceJson }` (2.3) — the card reads `.evidenceJson` (4.4) and the test asserts the same shape (2.1, 4.2). `onRecalculated?: () => void` matches between component (4.4), test (4.2), and mount (4.5).
