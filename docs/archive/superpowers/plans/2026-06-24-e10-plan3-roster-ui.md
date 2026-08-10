# E10 Plan 3 — Roster Grid UI + Per-Employee Compliance Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the E10 frontend — a new `/compliance` "Individual Compliance Status" roster grid (E10.3 / #190) and a per-employee compliance card on the employee profile (E10.4 / #191), both consuming the already-shipped `GET /api/compliance/roster` API and the E10.5 display-state vocabulary.

**Architecture:** Pure frontend, no backend or schema change. A new dashboard route renders a panel-scoped grid (rows = every directory subject, columns = the panel's Active measures, cells = status chip + method subtext) driven by `api.getWithHeaders` + `X-Total-Count` paging, with a "Recalculate" button that triggers an `ALL_PROGRAMS` async run via the existing `RunStatusProvider` (#181) and refetches on the `ww:run-complete` event. The employee profile gains an "Individual Compliance Status" card that fetches the roster for all three panels filtered to that subject and renders a RULE → STATUS → METHOD table. All status/method text comes verbatim from the API (the read model owns the vocabulary; the UI never re-derives compliance — ADR-008).

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind 4, `@mieweb/ui`; Vitest + React Testing Library + jsdom (`frontend/test/setup.ts`); the `api` client (`frontend/lib/api/client.ts`); `useRunStatus()` (`frontend/components/run-status-provider.tsx`); `rbac.ts` capability helpers.

**Scope decision (documented):** The per-employee card's per-row "Info" expander surfaces the cell's `method`, `complianceClass`, the source run id, and a link to the open case (when one exists in the profile). Full inline `expressionResults` drill-in is intentionally **out of scope** here — the case-detail page already renders that, and pulling raw evidence into the card would require a new backend outcome-evidence endpoint (backend/owner change). This keeps Plan 3 strictly frontend + no new API.

---

## File Structure

**Create:**
- `frontend/features/compliance/types.ts` — TS mirror of the roster API contract (`PanelId`, `DisplayState`, `RosterColumn`, `RosterCell`, `RosterRow`, `Roster`, `PANEL_OPTIONS`).
- `frontend/features/compliance/ComplianceChip.tsx` — presentational chip: status pill (color + label) + method subtext. One source of truth for rendering a roster cell.
- `frontend/features/compliance/ComplianceChip.test.tsx` — unit test.
- `frontend/app/(dashboard)/compliance/page.tsx` — the roster grid page.
- `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx` — grid page test (RTL + mocked api).
- `frontend/features/employee/components/IndividualComplianceStatus.tsx` — per-employee RULE→STATUS→METHOD card.
- `frontend/features/employee/components/IndividualComplianceStatus.test.tsx` — card test.

**Modify:**
- `frontend/lib/status.ts` — add `COMPLIANCE_STATUS_LABELS` + `complianceStatusClass()` covering all 8 display states.
- `frontend/app/(dashboard)/layout.tsx` — add the `Compliance` → `/compliance` nav item (all roles).
- `frontend/app/(dashboard)/employees/[externalId]/page.tsx` — mount `<IndividualComplianceStatus />`.
- `docs/ARCHITECTURE.md` — §4 route surfaces: add `/compliance` + the employee-card note.
- `README.md` — Key routes: add `/compliance`.
- `docs/JOURNAL.md` — dated entry on top.

---

## Task 1: Compliance status vocabulary in `lib/status.ts`

The roster API returns 8 display states (`COMPLIANT|DUE_SOON|OVERDUE|MISSING_DATA|EXCLUDED|DECLINED|IN_PROGRESS|NA`). `outcomeStatusClass()` only styles the 5 canonical buckets. Add a compliance-specific label map + class function so chips render color **and** text for all 8.

**Files:**
- Modify: `frontend/lib/status.ts`
- Test: `frontend/lib/__tests__/status-compliance.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `frontend/lib/__tests__/status-compliance.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor } from "@/lib/status";

describe("compliance status vocabulary", () => {
  it("labels all 8 display states", () => {
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "COMPLIANT")).toBe("Compliant");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "DUE_SOON")).toBe("Due Soon");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "OVERDUE")).toBe("Overdue");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "MISSING_DATA")).toBe("Missing Data");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "EXCLUDED")).toBe("Excluded");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "DECLINED")).toBe("Declined");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "IN_PROGRESS")).toBe("In Progress");
    expect(labelFor(COMPLIANCE_STATUS_LABELS, "NA")).toBe("N/A");
  });

  it("gives each display state a distinct, dark-mode-aware class", () => {
    expect(complianceStatusClass("COMPLIANT")).toContain("emerald");
    expect(complianceStatusClass("DUE_SOON")).toContain("amber");
    expect(complianceStatusClass("OVERDUE")).toContain("rose");
    expect(complianceStatusClass("MISSING_DATA")).toContain("violet");
    expect(complianceStatusClass("EXCLUDED")).toContain("indigo");
    expect(complianceStatusClass("DECLINED")).toContain("orange");
    expect(complianceStatusClass("IN_PROGRESS")).toContain("blue");
    expect(complianceStatusClass("NA")).toContain("dark:");
    // normalization: lower/hyphen forms map the same
    expect(complianceStatusClass("in progress")).toBe(complianceStatusClass("IN_PROGRESS"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run lib/__tests__/status-compliance.test.ts`
Expected: FAIL — `complianceStatusClass`/`COMPLIANCE_STATUS_LABELS` are not exported.

- [ ] **Step 3: Append the implementation to `frontend/lib/status.ts`**

Add at the end of the file:

```typescript
export const COMPLIANCE_STATUS_LABELS: Record<string, string> = {
  COMPLIANT: "Compliant",
  DUE_SOON: "Due Soon",
  OVERDUE: "Overdue",
  MISSING_DATA: "Missing Data",
  EXCLUDED: "Excluded",
  DECLINED: "Declined",
  IN_PROGRESS: "In Progress",
  NA: "N/A"
};

// Color + text for every roster display state (E10.5). Reuses the 5 canonical-bucket hues from
// outcomeStatusClass and adds DECLINED (orange), IN_PROGRESS (blue), NA (faint). Dark-mode-aware.
export function complianceStatusClass(status: string): string {
  const normalized = normalizeEnumValue(status);
  if (normalized === "COMPLIANT") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300";
  if (normalized === "DUE_SOON") return "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300";
  if (normalized === "OVERDUE") return "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300";
  if (normalized === "MISSING_DATA") return "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300";
  if (normalized === "EXCLUDED") return "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300";
  if (normalized === "DECLINED") return "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300";
  if (normalized === "IN_PROGRESS") return "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300";
  return "bg-neutral-100 text-neutral-500 dark:bg-neutral-800/60 dark:text-neutral-400"; // NA / unknown
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run lib/__tests__/status-compliance.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/lib/status.ts frontend/lib/__tests__/status-compliance.test.ts
git commit -m "feat(compliance): roster display-state chip vocabulary (E10.5 UI, #190)"
```

---

## Task 2: Compliance types + `ComplianceChip` component

A single presentational component renders one roster cell (status pill + method subtext), reused by both the grid and the per-employee card. Plus a `types.ts` mirroring the API contract so both surfaces share one source of truth.

**Files:**
- Create: `frontend/features/compliance/types.ts`
- Create: `frontend/features/compliance/ComplianceChip.tsx`
- Test: `frontend/features/compliance/ComplianceChip.test.tsx`

- [ ] **Step 1: Create `frontend/features/compliance/types.ts`**

```typescript
// TS mirror of the GET /api/compliance/roster contract (backend-ts/src/compliance/*). Kept in sync by
// hand; the read model owns the vocabulary — the UI renders these strings verbatim (ADR-008).
export type PanelId = "immunizations" | "osha" | "wellness";

export type DisplayState =
  | "COMPLIANT"
  | "DUE_SOON"
  | "OVERDUE"
  | "MISSING_DATA"
  | "EXCLUDED"
  | "DECLINED"
  | "IN_PROGRESS"
  | "NA";

export interface RosterColumn {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
}

export interface RosterCell {
  status: DisplayState;
  method: string;
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
}

// Panel selector options (labels mirror the UW "Vaccine Compliance" panels + our OSHA/wellness split).
export const PANEL_OPTIONS: ReadonlyArray<{ id: PanelId; label: string }> = [
  { id: "immunizations", label: "Immunizations" },
  { id: "osha", label: "OSHA Surveillance" },
  { id: "wellness", label: "Wellness & eCQM" }
];
```

- [ ] **Step 2: Write the failing test**

Create `frontend/features/compliance/ComplianceChip.test.tsx`:

```tsx
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ComplianceChip } from "./ComplianceChip";

describe("ComplianceChip", () => {
  it("renders the status label and method subtext", () => {
    render(<ComplianceChip cell={{ status: "COMPLIANT", method: "2 valid dose(s)" }} />);
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("2 valid dose(s)")).toBeInTheDocument();
  });

  it("applies the display-state class and stays readable for NA", () => {
    const { container } = render(<ComplianceChip cell={{ status: "NA", method: "Not evaluated" }} />);
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toContain("neutral");
  });

  it("renders IN_PROGRESS with its blue chip", () => {
    const { container } = render(<ComplianceChip cell={{ status: "IN_PROGRESS", method: "1 of 2 doses on file" }} />);
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(container.innerHTML).toContain("blue");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd frontend && npx vitest run features/compliance/ComplianceChip.test.tsx`
Expected: FAIL — `./ComplianceChip` not found.

- [ ] **Step 4: Create `frontend/features/compliance/ComplianceChip.tsx`**

```tsx
import React from "react";
import { COMPLIANCE_STATUS_LABELS, complianceStatusClass, labelFor } from "@/lib/status";
import type { RosterCell } from "./types";

/** One roster cell: a status pill (color + text) with the method string beneath. Method text comes
 *  verbatim from the read model (E10.5); the UI never re-derives it. */
export function ComplianceChip({ cell, className = "" }: { cell: RosterCell; className?: string }) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <span
        className={`inline-flex w-fit items-center rounded-full px-2 py-0.5 text-xs font-semibold ${complianceStatusClass(cell.status)}`}
      >
        {labelFor(COMPLIANCE_STATUS_LABELS, cell.status)}
      </span>
      {cell.method ? (
        <span className="text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">{cell.method}</span>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run features/compliance/ComplianceChip.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/features/compliance/types.ts frontend/features/compliance/ComplianceChip.tsx frontend/features/compliance/ComplianceChip.test.tsx
git commit -m "feat(compliance): roster API types + ComplianceChip cell component (#190)"
```

---

## Task 3: `/compliance` roster grid page + nav item

The grid page: panel selector + status/site/search filters + page-size, a semantic table (sticky first column = subject, one column per panel measure, `scope="col"` headers, a11y), each cell a `<ComplianceChip>`, row click → `/employees/[externalId]`, `X-Total-Count` paging, and a **Recalculate** button (RBAC-gated) that triggers an `ALL_PROGRAMS` run and refetches on `ww:run-complete`.

**Files:**
- Create: `frontend/app/(dashboard)/compliance/page.tsx`
- Modify: `frontend/app/(dashboard)/layout.tsx`
- Test: `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx`:

```tsx
import React from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ api: { getWithHeaders: (...a: unknown[]) => getWithHeaders(...a), post: (...a: unknown[]) => post(...a) } }));

const startTracking = vi.fn();
vi.mock("@/components/run-status-provider", () => ({ useRunStatus: () => ({ isActive: false, startTracking }) }));

// All roles may read the roster; Recalculate is gated. Default the auth hook to ADMIN.
vi.mock("@/lib/rbac", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rbac")>();
  return { ...actual };
});
vi.mock("@/components/auth-provider", () => ({ useAuth: () => ({ user: { role: "ROLE_ADMIN" } }) }));

import CompliancePage from "../page";

const rosterImmun = {
  data: {
    panel: "immunizations",
    columns: [
      { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT" },
      { measureId: "varicella", name: "Varicella", complianceClass: "PERMANENT" }
    ],
    rows: [
      {
        subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
        cells: {
          mmr: { status: "COMPLIANT", method: "2 valid dose(s)" },
          varicella: { status: "IN_PROGRESS", method: "1 of 2 doses on file" }
        }
      }
    ]
  },
  headers: new Headers({ "X-Total-Count": "1" })
};

beforeEach(() => {
  getWithHeaders.mockReset().mockResolvedValue(rosterImmun);
  post.mockReset().mockResolvedValue({ runId: "run-9", status: "REQUESTED" });
  startTracking.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("CompliancePage", () => {
  it("renders the panel's columns and a chip per cell", async () => {
    render(<CompliancePage />);
    expect(await screen.findByText("Individual Compliance Status")).toBeInTheDocument();
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    expect(screen.getByRole("columnheader", { name: /MMR/ })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Varicella/ })).toBeInTheDocument();
    const row = screen.getByText("Ada Lovelace").closest("tr")!;
    expect(within(row).getByText("Compliant")).toBeInTheDocument();
    expect(within(row).getByText("In Progress")).toBeInTheDocument();
    expect(within(row).getByText("1 of 2 doses on file")).toBeInTheDocument();
  });

  it("refetches when the panel changes", async () => {
    render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(1));
    await userEvent.selectOptions(screen.getByLabelText(/Panel/i), "osha");
    await waitFor(() => {
      const lastUrl = String(getWithHeaders.mock.calls.at(-1)?.[0] ?? "");
      expect(lastUrl).toContain("panel=osha");
    });
  });

  it("Recalculate triggers an ALL_PROGRAMS run and tracks it", async () => {
    render(<CompliancePage />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: /Recalculate/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/runs/manual", { scopeType: "ALL_PROGRAMS" }));
    expect(startTracking).toHaveBeenCalledWith("run-9", "REQUESTED");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run "app/(dashboard)/compliance/__tests__/page.test.tsx"`
Expected: FAIL — `../page` not found.

- [ ] **Step 3: Create `frontend/app/(dashboard)/compliance/page.tsx`**

```tsx
"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { useRunStatus } from "@/components/run-status-provider";
import { useAuth } from "@/components/auth-provider";
import { canRunMeasures } from "@/lib/rbac";
import { COMPLIANCE_STATUS_LABELS } from "@/lib/status";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { PANEL_OPTIONS, type PanelId, type Roster } from "@/features/compliance/types";

const STATUS_FILTER_OPTIONS = Object.keys(COMPLIANCE_STATUS_LABELS);
const PAGE_SIZES = [25, 50, 100, 200];

export default function CompliancePage() {
  const { user } = useAuth();
  const { startTracking } = useRunStatus();
  const canRecalc = canRunMeasures(user?.role);

  const [panel, setPanel] = useState<PanelId>("immunizations");
  const [status, setStatus] = useState<string>("");
  const [site, setSite] = useState<string>("");
  const [q, setQ] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(50);

  const [roster, setRoster] = useState<Roster | null>(null);
  const [total, setTotal] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [recalcBusy, setRecalcBusy] = useState<boolean>(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("panel", panel);
      if (status) params.set("status", status);
      if (site.trim()) params.set("site", site.trim());
      if (q.trim()) params.set("q", q.trim());
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      const { data, headers } = await api.getWithHeaders<Roster>(`/api/compliance/roster?${params.toString()}`);
      setRoster(data);
      const matchTotal = Number(headers.get("X-Total-Count") ?? data.rows.length);
      setTotal(Number.isFinite(matchTotal) ? matchTotal : data.rows.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the compliance roster.");
      setRoster(null);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [panel, status, site, q, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch when a tracked run finishes (Recalculate or any run elsewhere).
  useEffect(() => {
    const onComplete = () => void load();
    window.addEventListener("ww:run-complete", onComplete);
    return () => window.removeEventListener("ww:run-complete", onComplete);
  }, [load]);

  const recalculate = useCallback(async () => {
    if (!canRecalc) return;
    if (!window.confirm("Recalculate compliance for all programs? This runs every active measure across the workforce.")) return;
    setRecalcBusy(true);
    try {
      const result = await api.post<{ scopeType: string }, { runId: string; status?: string }>(
        "/api/runs/manual",
        { scopeType: "ALL_PROGRAMS" }
      );
      startTracking(result.runId, result.status ?? "REQUESTED");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start the recalculation run.");
    } finally {
      setRecalcBusy(false);
    }
  }, [canRecalc, startTracking]);

  const columns = roster?.columns ?? [];
  const rows = roster?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Individual Compliance Status</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            Every employee across the selected panel — compliant and excluded included. The inverse of the worklist.
          </p>
        </div>
        {canRecalc ? (
          <button
            type="button"
            onClick={recalculate}
            disabled={recalcBusy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {recalcBusy ? "Starting…" : "Recalculate"}
          </button>
        ) : null}
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Panel</span>
          <select
            value={panel}
            onChange={(e) => { setPage(1); setPanel(e.target.value as PanelId); }}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            {PANEL_OPTIONS.map((p) => (<option key={p.id} value={p.id}>{p.label}</option>))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Status</span>
          <select
            value={status}
            onChange={(e) => { setPage(1); setStatus(e.target.value); }}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            <option value="">All statuses</option>
            {STATUS_FILTER_OPTIONS.map((s) => (<option key={s} value={s}>{COMPLIANCE_STATUS_LABELS[s]}</option>))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Site</span>
          <input
            value={site}
            onChange={(e) => { setPage(1); setSite(e.target.value); }}
            placeholder="All sites"
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
        </label>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Search</span>
          <input
            value={q}
            onChange={(e) => { setPage(1); setQ(e.target.value); }}
            placeholder="Name or ID"
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          />
        </label>
        <label className="flex flex-col text-xs font-medium">
          <span className="mb-1">Page size</span>
          <select
            value={pageSize}
            onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}
            className="rounded border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700"
          >
            {PAGE_SIZES.map((n) => (<option key={n} value={n}>{n}</option>))}
          </select>
        </label>
      </div>

      {error ? (
        <p role="alert" className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-neutral-50 dark:bg-neutral-900/60">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-neutral-50 px-3 py-2 text-left font-semibold dark:bg-neutral-900/60">
                Employee
              </th>
              {columns.map((c) => (
                <th key={c.measureId} scope="col" className="px-3 py-2 text-left font-semibold">
                  {c.name}
                  <span className="ml-1 text-[10px] font-normal uppercase text-neutral-400">{c.complianceClass === "PERMANENT" ? "perm" : "rec"}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={columns.length + 1} className="px-3 py-6 text-center text-neutral-500">No employees match these filters.</td></tr>
            ) : (
              rows.map((r) => (
                <tr key={r.subject.externalId} className="border-t border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900/40">
                  <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-2 text-left font-normal dark:bg-neutral-950">
                    <Link href={`/employees/${encodeURIComponent(r.subject.externalId)}`} className="font-medium text-blue-600 hover:underline dark:text-blue-400">
                      {r.subject.name}
                    </Link>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{r.subject.site} · {r.subject.role}</div>
                  </th>
                  {columns.map((c) => {
                    const cell = r.cells[c.measureId] ?? { status: "NA" as const, method: "Not evaluated" };
                    return (
                      <td key={c.measureId} className="px-3 py-2 align-top">
                        <ComplianceChip cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-neutral-500 dark:text-neutral-400">
        <span>{total} employee{total === 1 ? "" : "s"}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
          >
            Prev
          </button>
          <span>Page {page} of {totalPages}</span>
          <button
            type="button"
            onClick={() => setPage((p) => (p < totalPages ? p + 1 : p))}
            disabled={page >= totalPages}
            className="rounded border border-neutral-300 px-2 py-1 disabled:opacity-50 dark:border-neutral-700"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
```

> **Verified imports:** the auth hook is `useAuth` from `@/components/auth-provider` (confirmed in `layout.tsx:31`); `canRunMeasures(role)` is exported from `@/lib/rbac` (confirmed `rbac.ts:45`). Both `page.tsx` and the test mock above already use these exact paths — no change needed.

- [ ] **Step 4: Add the nav item in `frontend/app/(dashboard)/layout.tsx`**

In the `nav` array (after the `/cases`/`/worklist` group or wherever reads best), add — note: **no `roles` key** so every authenticated role sees it (roster read is all-roles). Use an imported lucide icon already in the file's import list, or add one (e.g. `ListChecks`) to the existing `lucide-react` import:

```typescript
  { href: "/compliance", label: "Compliance", icon: ListChecks },
```

Ensure `ListChecks` is added to the existing `import { ... } from "lucide-react";` line if not already imported.

- [ ] **Step 5: Run the page test to verify it passes**

Run: `cd frontend && npx vitest run "app/(dashboard)/compliance/__tests__/page.test.tsx"`
Expected: PASS (3 tests). If the auth/rbac import names differ, adjust per the Step 3 note until green.

- [ ] **Step 6: Commit**

```bash
git add "frontend/app/(dashboard)/compliance/page.tsx" "frontend/app/(dashboard)/compliance/__tests__/page.test.tsx" "frontend/app/(dashboard)/layout.tsx"
git commit -m "feat(compliance): /compliance roster grid + nav item (E10.3, #190)"
```

---

## Task 4: Per-employee "Individual Compliance Status" card

A card on the employee profile that fetches the roster for all three panels filtered to this subject (`?q=<externalId>&pageSize=1`), picks the exact-match row, merges columns + cells across panels, and renders a RULE → STATUS → METHOD table. Each row expands to show the method, compliance class, and source run id. Per-cell safety: a panel that fails to load is skipped (the card still renders the others).

**Files:**
- Create: `frontend/features/employee/components/IndividualComplianceStatus.tsx`
- Modify: `frontend/app/(dashboard)/employees/[externalId]/page.tsx`
- Test: `frontend/features/employee/components/IndividualComplianceStatus.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/features/employee/components/IndividualComplianceStatus.test.tsx`:

```tsx
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWithHeaders = vi.fn();
vi.mock("@/lib/api/client", () => ({ api: { getWithHeaders: (...a: unknown[]) => getWithHeaders(...a) } }));

import { IndividualComplianceStatus } from "./IndividualComplianceStatus";

function rosterFor(panel: string, measureId: string, name: string, status: string, method: string) {
  return {
    data: {
      panel,
      columns: [{ measureId, name, complianceClass: "PERMANENT" }],
      rows: [
        {
          subject: { externalId: "emp-001", name: "Ada Lovelace", role: "Nurse", site: "HQ" },
          cells: { [measureId]: { status, method, evidenceRef: { runId: "run-7", outcomeId: "o-1" } } }
        }
      ]
    },
    headers: new Headers({ "X-Total-Count": "1" })
  };
}

beforeEach(() => {
  getWithHeaders.mockReset().mockImplementation((url: string) => {
    if (url.includes("panel=immunizations")) return Promise.resolve(rosterFor("immunizations", "mmr", "MMR", "COMPLIANT", "2 valid dose(s)"));
    if (url.includes("panel=osha")) return Promise.resolve(rosterFor("osha", "audiogram", "Audiogram", "OVERDUE", "Overdue — last 2024-01-01"));
    return Promise.resolve(rosterFor("wellness", "cms122", "Diabetes HbA1c", "MISSING_DATA", "No record on file"));
  });
});
afterEach(() => vi.clearAllMocks());

describe("IndividualComplianceStatus", () => {
  it("merges all three panels into one RULE→STATUS→METHOD table", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    expect(await screen.findByText("Individual Compliance Status")).toBeInTheDocument();
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(3));
    expect(screen.getByText("MMR")).toBeInTheDocument();
    expect(screen.getByText("Audiogram")).toBeInTheDocument();
    expect(screen.getByText("Diabetes HbA1c")).toBeInTheDocument();
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("Overdue")).toBeInTheDocument();
  });

  it("expands a row to reveal the source run id", async () => {
    render(<IndividualComplianceStatus externalId="emp-001" />);
    await waitFor(() => expect(getWithHeaders).toHaveBeenCalledTimes(3));
    await userEvent.click(screen.getAllByRole("button", { name: /info/i })[0]);
    expect(await screen.findByText(/run-7/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run features/employee/components/IndividualComplianceStatus.test.tsx`
Expected: FAIL — `./IndividualComplianceStatus` not found.

- [ ] **Step 3: Create `frontend/features/employee/components/IndividualComplianceStatus.tsx`**

```tsx
"use client";

import React, { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { ComplianceChip } from "@/features/compliance/ComplianceChip";
import { PANEL_OPTIONS, type Roster, type RosterCell } from "@/features/compliance/types";

interface Row {
  measureId: string;
  name: string;
  complianceClass: "PERMANENT" | "RECURRING";
  cell: RosterCell;
}

/** Single-person mirror of the roster grid: RULE → STATUS → METHOD over every applicable measure across
 *  all panels. Consumes GET /api/compliance/roster (one call per panel, filtered to this subject) so the
 *  E10.5 vocabulary stays single-source. Read-only; advisory; never sets status (ADR-008). */
export function IndividualComplianceStatus({ externalId }: { externalId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const params = new URLSearchParams({ q: externalId, pageSize: "5" });
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
      if (cancelled) return;
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
    })();
    return () => { cancelled = true; };
  }, [externalId]);

  return (
    <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-3 text-base font-semibold">Individual Compliance Status</h2>
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
                        onClick={() => setOpen((o) => ({ ...o, [row.measureId]: !isOpen }))}
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
                        {row.cell.evidenceRef ? <div>Source run: {row.cell.evidenceRef.runId}</div> : null}
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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run features/employee/components/IndividualComplianceStatus.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the card on the employee page**

In `frontend/app/(dashboard)/employees/[externalId]/page.tsx`, add the import at the top:

```typescript
import { IndividualComplianceStatus } from "@/features/employee/components/IndividualComplianceStatus";
```

Render it just below the compliance summary bar / above the Open Cases table (the implementer should place it in the main content column where it reads best). The component takes the route param the page already has (the `externalId`):

```tsx
<IndividualComplianceStatus externalId={externalId} />
```

> **Note for the implementer:** confirm the exact variable name the page uses for the route param (the Explore map shows the page is `employees/[externalId]/page.tsx` driven by `useEmployeeProfile(externalId)`). Use that same identifier.

- [ ] **Step 6: Run the employee page's existing tests (if any) + the new card test to confirm no regression**

Run: `cd frontend && npx vitest run features/employee`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/features/employee/components/IndividualComplianceStatus.tsx frontend/features/employee/components/IndividualComplianceStatus.test.tsx "frontend/app/(dashboard)/employees/[externalId]/page.tsx"
git commit -m "feat(compliance): per-employee Individual Compliance Status card (E10.4, #191)"
```

---

## Task 5: Docs + full verification

**Files:**
- Modify: `docs/ARCHITECTURE.md`, `README.md`, `docs/JOURNAL.md`

- [ ] **Step 1: Update `docs/ARCHITECTURE.md` §4 (Frontend Route Surfaces)**

Add a `/compliance` bullet near `/cases`:

```markdown
- `/compliance`: "Individual Compliance Status" roster grid (E10.3) — every directory subject × the selected panel's (Immunizations / OSHA / Wellness & eCQM) Active measures, each cell a status chip + method subtext (E10.5 display vocabulary). Panel/status/site/search filters + `X-Total-Count` paging; row → `/employees/[externalId]`; a RBAC-gated **Recalculate** triggers an `ALL_PROGRAMS` run via `RunStatusProvider` and refetches on `ww:run-complete`. Read-only for all roles; consumes `GET /api/compliance/roster`.
```

And in the `/cases/[id]` / employees area note the new card:

```markdown
- `/employees/[externalId]`: adds an **Individual Compliance Status** card (E10.4) — a RULE → STATUS → METHOD table over every applicable measure across all three panels (consumes `GET /api/compliance/roster` filtered to the subject), each row expandable to the method/class/source-run. Advisory display only; never sets status (ADR-008).
```

- [ ] **Step 2: Update `README.md` Key routes**

Add under the Key routes list:

```markdown
- `/compliance` Individual Compliance Status roster grid (every employee × panel measures)
```

- [ ] **Step 3: Add a `docs/JOURNAL.md` entry on top**

```markdown
## 2026-06-24 — E10 Plan 3: roster grid UI + per-employee compliance card (#190, #191)

Shipped the E10 frontend on `feat/e10-plan3-roster-ui`. New `/compliance` "Individual Compliance
Status" grid (E10.3 #190): rows = every directory subject, columns = the selected panel's Active
measures (Immunizations / OSHA / Wellness & eCQM), each cell a status chip + method subtext using the
E10.5 display vocabulary (COMPLIANT/DUE_SOON/OVERDUE/MISSING_DATA/EXCLUDED/DECLINED/IN_PROGRESS/NA).
Panel/status/site/search filters + `X-Total-Count` paging; row → employee profile; RBAC-gated
**Recalculate** triggers an `ALL_PROGRAMS` run through the #181 `RunStatusProvider` and refetches on
`ww:run-complete`. Per-employee **Individual Compliance Status** card (E10.4 #191) on
`/employees/[externalId]`: a RULE → STATUS → METHOD table merging all three panels (one roster call per
panel, filtered to the subject), each row expandable to method/class/source-run. Pure frontend — no
schema, no new deps, all status/method text comes verbatim from the read model (ADR-008). New shared
pieces: `complianceStatusClass`/`COMPLIANCE_STATUS_LABELS` (`lib/status.ts`), `features/compliance`
(types + `ComplianceChip`). Frontend Vitest suite green; `npm run lint` + `npm run build` clean.
```

- [ ] **Step 4: Full frontend verification**

Run:
```bash
cd frontend && npx vitest run && npm run lint && npm run build
```
Expected: all Vitest tests PASS; lint clean; build succeeds. Fix anything red before committing.

- [ ] **Step 5: Commit**

```bash
git add docs/ARCHITECTURE.md README.md docs/JOURNAL.md
git commit -m "docs(compliance): /compliance grid + per-employee card (E10 Plan 3, #190, #191)"
```

---

## Self-Review Checklist (run after writing, before execution)

- **Spec coverage:** Section C (grid: panel selector, status/site/search filters, page-size, Recalculate, sticky col, scope=col, chips, row→employee) → Task 3. Section D (per-employee RULE→STATUS→METHOD card, Recalculate/forecast actions) → Task 4 (note: the per-employee **Recalculate** and **Simulate History** buttons from Section D are deferred — the profile page already has rerun + forecast surfaces; this card is read-only display. Flag this to the reviewer; add as a follow-up if the maintainer wants them on the card). Section E vocabulary → Tasks 1–2 (render side; the backend already owns derivation). 
- **Placeholder scan:** none — every code step is complete; the two "Note for the implementer" callouts are import-name confirmations, not missing logic.
- **Type consistency:** `Roster`/`RosterColumn`/`RosterCell`/`RosterRow`/`DisplayState`/`PanelId` are defined once in `features/compliance/types.ts` and imported everywhere; `ComplianceChip` takes `{ cell: RosterCell }` consistently in Tasks 2–4; `complianceStatusClass`/`COMPLIANCE_STATUS_LABELS` defined in Task 1 and consumed in Tasks 2–3.

## Open follow-ups (out of scope for Plan 3, note in the PR)
- Per-employee card **Recalculate** (EMPLOYEE rerun-to-verify) + **Simulate Compliance History** buttons (Section D) — deferred; the profile already exposes rerun + forecast elsewhere.
- Inline `expressionResults` evidence drill-in in the card expander — deferred to the existing case-detail evidence view (would need a backend outcome-evidence endpoint otherwise).
- Cell-level evidence drill-in on the grid (cell click → evidence) — deferred with the same rationale.
