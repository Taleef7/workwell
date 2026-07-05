# UX-11 — Roster mobile card layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the `/compliance` roster as per-employee cards on phones (below `md`) while keeping the existing table at `md`+.

**Architecture:** A new `RosterMobileCards` component (visible `md:hidden`) renders the same `roster.columns`/`roster.rows` as a list of cards; the existing table wrapper gets `hidden md:block`. CSS-only responsive switch (both in DOM, `display:none` keeps the hidden one out of view + the a11y tree). No backend, no new deps.

**Tech Stack:** Next.js 16 / React 19 / TypeScript / Tailwind / vitest + testing-library.

Spec: `docs/superpowers/specs/2026-07-05-ux11-roster-mobile-cards-design.md`. Branch `feat/ux11-roster-mobile-cards` (already created).

---

## File Structure

- **Create** `frontend/features/compliance/RosterMobileCards.tsx` — the mobile card list (header + `<dl>` measure→chip per employee, loading/empty states).
- **Create** `frontend/features/compliance/RosterMobileCards.test.tsx` — unit tests.
- **Modify** `frontend/app/(dashboard)/compliance/page.tsx` — `hidden md:block` on the table wrapper + render `<RosterMobileCards>` after it.
- **Modify** `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx` — scope the one duplicated-name query to the table.

---

## Task 1: `RosterMobileCards` component (TDD)

**Files:**
- Create: `frontend/features/compliance/RosterMobileCards.tsx`
- Test: `frontend/features/compliance/RosterMobileCards.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/features/compliance/RosterMobileCards.test.tsx`:

```tsx
import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { RosterMobileCards } from "./RosterMobileCards";
import type { RosterColumn, RosterRow } from "./types";

const columns: RosterColumn[] = [
  { measureId: "mmr", name: "MMR", complianceClass: "PERMANENT" },
  { measureId: "varicella", name: "Varicella", complianceClass: "PERMANENT" },
];
const rows: RosterRow[] = [
  {
    subject: { externalId: "emp-006", name: "Ada Lovelace", role: "Nurse", site: "HQ", tenantId: "twh", tenantName: "Total Worker Health" },
    cells: {
      mmr: { status: "COMPLIANT", method: "2 valid dose(s)" },
      // varicella intentionally omitted → NA fallback
    },
  },
];

describe("RosterMobileCards", () => {
  it("renders a card per employee with a name link and context subtext", () => {
    render(<RosterMobileCards columns={columns} rows={rows} loading={false} />);
    const link = screen.getByRole("link", { name: "Ada Lovelace" });
    expect(link).toHaveAttribute("href", "/employees/emp-006");
    expect(screen.getByText(/Total Worker Health/)).toBeInTheDocument();
    expect(screen.getByText(/HQ/)).toBeInTheDocument();
    expect(screen.getByText(/Nurse/)).toBeInTheDocument();
  });

  it("renders a chip per column and falls back to NA for a missing cell", () => {
    render(<RosterMobileCards columns={columns} rows={rows} loading={false} />);
    // MMR cell present
    expect(screen.getByText("Compliant")).toBeInTheDocument();
    expect(screen.getByText("2 valid dose(s)")).toBeInTheDocument();
    // varicella missing → NA fallback method text (rendered by ComplianceChip's sr-only detail)
    expect(screen.getByText(/Not evaluated/)).toBeInTheDocument();
    // both measure names appear as <dt> labels (regex — the <dt> also holds a perm/rec span,
    // so exact-match on "MMR" would miss the combined "MMR perm" text content)
    expect(screen.getByText(/^MMR/)).toBeInTheDocument();
    expect(screen.getByText(/^Varicella/)).toBeInTheDocument();
  });

  it("shows a loading state with no rows, and an empty state otherwise", () => {
    const { rerender } = render(<RosterMobileCards columns={columns} rows={[]} loading={true} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    rerender(<RosterMobileCards columns={columns} rows={[]} loading={false} />);
    expect(screen.getByText("No employees match these filters.")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run "features/compliance/RosterMobileCards.test.tsx"`
Expected: FAIL — `./RosterMobileCards` module not found.

- [ ] **Step 3: Implement `RosterMobileCards.tsx`**

Create `frontend/features/compliance/RosterMobileCards.tsx`:

```tsx
import React from "react";
import Link from "next/link";
import { ComplianceChip } from "./ComplianceChip";
import type { RosterColumn, RosterRow, RosterCell } from "./types";

const NA_FALLBACK: RosterCell = { status: "NA", method: "Not evaluated" };

/**
 * UX-11 — the `/compliance` roster as per-employee cards for phones (the wide table shows ~1.5
 * columns per screen). Same data as the table; hidden at `md`+ (the table takes over). Each card is
 * an employee header (name link + tenant · site · role) over a `<dl>` of measure → ComplianceChip,
 * so assistive tech gets an explicit measure→status pairing without the table's off-screen columns.
 */
export function RosterMobileCards({
  columns,
  rows,
  loading,
}: {
  columns: RosterColumn[];
  rows: RosterRow[];
  loading: boolean;
}) {
  if (loading && rows.length === 0) {
    return <p className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800 md:hidden">Loading…</p>;
  }
  if (rows.length === 0) {
    return <p className="rounded-lg border border-neutral-200 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800 md:hidden">No employees match these filters.</p>;
  }
  return (
    <ul className="space-y-3 md:hidden">
      {rows.map((r) => (
        <li key={r.subject.externalId} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
          <Link
            href={`/employees/${encodeURIComponent(r.subject.externalId)}`}
            className="font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {r.subject.name}
          </Link>
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {r.subject.tenantName} · {r.subject.site} · {r.subject.role}
          </div>
          <dl className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800/70">
            {columns.map((c) => (
              <div key={c.measureId} className="flex items-start justify-between gap-3 py-1.5">
                <dt className="text-sm text-neutral-700 dark:text-neutral-300">
                  {c.name}
                  <span className="ml-1 text-[10px] font-normal uppercase text-neutral-400">
                    {c.complianceClass === "PERMANENT" ? "perm" : "rec"}
                  </span>
                </dt>
                <dd className="text-right">
                  <ComplianceChip cell={r.cells[c.measureId] ?? NA_FALLBACK} className="items-end" />
                </dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx vitest run "features/compliance/RosterMobileCards.test.tsx"`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add "frontend/features/compliance/RosterMobileCards.tsx" "frontend/features/compliance/RosterMobileCards.test.tsx"
git commit -m "feat(ux11): RosterMobileCards — per-employee card layout for the compliance roster"
```

---

## Task 2: wire into the compliance page + fix the one duplicated-name test

**Files:**
- Modify: `frontend/app/(dashboard)/compliance/page.tsx`
- Modify: `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx`

- [ ] **Step 1: Import the component**

In `frontend/app/(dashboard)/compliance/page.tsx`, add the import next to the other `features/compliance` imports (after the `ComplianceChip` import, line ~12):

```ts
import { RosterMobileCards } from "@/features/compliance/RosterMobileCards";
```

- [ ] **Step 2: Hide the table below `md` and render the cards**

Change the table wrapper's opening `<div>` (currently `<div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">`) to add `hidden md:block`:

```tsx
      <div className="hidden overflow-x-auto rounded-lg border border-neutral-200 md:block dark:border-neutral-800">
```

Then, immediately AFTER that table wrapper's closing `</div>` (before the pagination footer `<div className="flex items-center justify-between …">`), add:

```tsx
      <RosterMobileCards columns={columns} rows={rows} loading={loading} />
```

(`columns`, `rows`, and `loading` are already in scope — `const columns = roster?.columns ?? []`, `const rows = roster?.rows ?? []`, and the `loading` state.)

- [ ] **Step 3: Update the one existing page test that now matches a duplicated name**

In `frontend/app/(dashboard)/compliance/__tests__/page.test.tsx`, the "renders the panel's columns and a chip per cell" test (line ~71) does:

```ts
    const row = screen.getByText("Ada Lovelace").closest("tr")!;
```

"Ada Lovelace" now also appears in the mobile cards, so `getByText` matches two elements. Scope it to the table (the cards are a `<ul>`, not a table):

```ts
    const row = within(screen.getByRole("table")).getByText("Ada Lovelace").closest("tr")!;
```

(`within` is already imported in this test file.)

- [ ] **Step 4: Run the compliance page + component tests**

Run: `cd frontend && npx vitest run "app/(dashboard)/compliance" "features/compliance/RosterMobileCards.test.tsx"`
Expected: all pass (the scoped table query resolves the ambiguity; cards tests green).

- [ ] **Step 5: Typecheck + lint + full vitest + build**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run && npm run build`
Expected: tsc clean; lint clean (the 1 pre-existing `test/mocks/next-font.ts` warning is unrelated); all vitest pass; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add "frontend/app/(dashboard)/compliance/page.tsx" "frontend/app/(dashboard)/compliance/__tests__/page.test.tsx"
git commit -m "feat(ux11): compliance roster shows cards on phones, table on md+"
```

---

## Task 3: docs + final verification

**Files:**
- Modify: `docs/JOURNAL.md` (new dated entry, newest on top)
- Modify: `docs/ARCHITECTURE.md` — the `/compliance` route bullet (§4) gets a clause about the responsive card layout.

- [ ] **Step 1: JOURNAL entry**

Prepend under `# Journal` in `docs/JOURNAL.md`:

```markdown
## 2026-07-05 — UX-11: compliance roster mobile card layout

The `/compliance` roster is a wide table (sticky Employee column + N measure columns) that shows only
~1.5 columns per phone screen. Added a per-employee **card** layout (`RosterMobileCards`) shown below the
`md` breakpoint; the existing table stays at `md`+. CSS-only responsive switch (`hidden md:block` table +
`md:hidden` cards) — `display:none` keeps the hidden layout out of the a11y tree, so AT + sighted users
each see exactly one. Each card is an employee header (name link + tenant · site · role) over a `<dl>` of
measure → `ComplianceChip`, giving an explicit measure→status pairing on mobile. Same data/filters/paging;
chips still come verbatim from the read model (ADR-008). New component + 3 unit tests; one existing page
test scoped to `getByRole("table")` for the now-duplicated name. No schema, no new deps; frontend tsc +
lint + vitest + build green.
```

- [ ] **Step 2: ARCHITECTURE note**

In `docs/ARCHITECTURE.md`, on the `/compliance` route bullet (§4 Frontend Route Surfaces), append: "On phones (below `md`) the grid renders as per-employee cards (`RosterMobileCards`) — same data, one layout in the a11y tree at a time (UX-11)."

- [ ] **Step 3: Final verification**

Run: `cd frontend && npx tsc --noEmit && npm run lint && npx vitest run && npm run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add docs/JOURNAL.md docs/ARCHITECTURE.md
git commit -m "docs(ux11): journal + architecture note for the roster mobile card layout"
```

---

## Self-review notes (for the implementer)

- The two layouts must render from the SAME `columns`/`rows`/cell-fallback so they never disagree. The NA fallback (`{ status: "NA", method: "Not evaluated" }`) matches the table's inline fallback exactly.
- Do NOT convert the table to cards or restructure it — only add the `hidden md:block` class and the sibling cards block.
- `ComplianceChip` renders NA/NOT_APPLICABLE as a de-emphasized dash with an `sr-only` detail (that's why the missing-cell test asserts on "Not evaluated" text, which lives in the sr-only span).
- Keep the shared header, filter bar, error alert, `sr-only` announcer, and pagination outside both layouts (they already are).
