# UX-11 — Roster mobile card layout

**Date:** 2026-07-05
**Status:** Approved (autonomous — owner delegated full permissions) — ready for implementation plan
**Ticket:** UX-11 [L] (Fable review `03-ui-ux-inspection.md`)

## Problem

The `/compliance` "Individual Compliance Status" roster is a wide table: a sticky
Employee column + N measure columns. On a phone (`03-ui-ux-inspection.md` shots 40–44)
only ~1.5 columns are visible per screen — the operator scrolls horizontally to read one
employee's statuses. The page is otherwise mobile-usable (filters stack, table scrolls
in-container), so this is a targeted, low-priority polish: a per-employee **card** layout
serves phones better.

## Goal

On narrow screens, render each employee as a card (name + context header, then a
measure→status list) instead of a horizontally-scrolling table row. On `md`+ screens the
existing table is unchanged. Same data, same filters/paging, same accessible status text
(chips come verbatim from the read model — ADR-008; the UI never re-derives status).

## Non-goals

- No change to the data contract, filters, paging, recalculate, or the table layout at `md`+.
- No new dependency, no backend change.
- Not addressing the other `[L]` items (UX-12 count formatting, UX-13 filter bar, etc.).

## Design

### Responsive strategy — CSS, both layouts in the DOM

Use the standard Tailwind responsive-table pattern:

- The existing table wrapper gets `hidden md:block` (visible at `md`+ only).
- A new **`RosterMobileCards`** block gets `md:hidden` (visible below `md` only).

Both render from the same `roster.columns` / `roster.rows`. `hidden` = `display:none`,
which removes the hidden layout from the **accessibility tree** and from view, so screen
readers and sighted users each see exactly one layout — no double-announce, no hydration
flash (unlike a JS media-query switch on a client-rendered page). The extra DOM is
negligible: rows are server-paged (≤200/page).

### `RosterMobileCards` component

New file `frontend/features/compliance/RosterMobileCards.tsx`:

```
RosterMobileCards({ columns, rows, loading }: { columns: RosterColumn[]; rows: RosterRow[]; loading: boolean })
```

- Renders a `<ul class="space-y-3 md:hidden">` of cards, one `<li>` per employee.
- **Card header:** the employee name as a `<Link href="/employees/<externalId>">` (same
  target as the table), with a `tenantName · site · role` subtext line — identical content
  to the table's sticky cell.
- **Measure list:** a `<dl>` with one row per column — `<dt>` = measure name + the
  `perm`/`rec` class tag (as in the table header), `<dd>` = `<ComplianceChip cell={cell} />`.
  The `<dl>` gives assistive tech an explicit measure→status pairing (better than a bare
  table cell with no per-row header on mobile). Cell fallback matches the table:
  `r.cells[c.measureId] ?? { status: "NA", method: "Not evaluated" }`.
- **Loading / empty states** mirror the table: `loading && rows.length === 0` → "Loading…";
  `rows.length === 0` → "No employees match these filters." (so the two layouts never
  disagree about state).
- Reuses the existing `ComplianceChip` (de-emphasized NA/NOT_APPLICABLE dash included) and
  the shared `RosterColumn`/`RosterRow`/`RosterCell` types from `features/compliance/types`.

### Page wiring (`app/(dashboard)/compliance/page.tsx`)

- Wrap the existing `<div class="overflow-x-auto …"><table>…</table></div>` with
  `hidden md:block` (add to the wrapper's className).
- After it, render `<RosterMobileCards columns={columns} rows={rows} loading={loading} />`.
- The header, filter bar, error alert, `sr-only` status announcer, and the pagination
  footer are layout-independent and stay as-is (shared by both layouts).

## Accessibility

- One layout in the a11y tree at a time (`display:none` on the other).
- Cards use a list (`<ul>`/`<li>`) + a definition list (`<dl>`/`<dt>`/`<dd>`) so each status
  is programmatically associated with its measure name.
- `ComplianceChip`'s existing accessible text (labels + `sr-only` detail for the NA dash) is
  unchanged.

## Testing

- **New** `frontend/features/compliance/RosterMobileCards.test.tsx` (vitest + testing-library):
  - renders one card per row with the employee name linked to `/employees/<id>` and the
    `tenantName · site · role` subtext;
  - renders a chip per column (asserts a known status label + method text present) and uses
    the NA fallback for a missing cell;
  - `loading` with no rows → "Loading…"; empty rows → "No employees match these filters.".
- **Update** `app/(dashboard)/compliance/__tests__/page.test.tsx`: the "renders … a chip per
  cell" test does `screen.getByText("Ada Lovelace").closest("tr")` — now that the name also
  appears in the mobile cards, scope that query to the table:
  `within(screen.getByRole("table")).getByText("Ada Lovelace").closest("tr")`. (`getByRole("table")`
  matches only the desktop layout; the cards are a `<ul>`, not a table.) No other page test
  changes — the rest query roles/labels/buttons that are single.

## Rollback

Additive and reversible by reverting the PR: remove the `RosterMobileCards` block + the
`hidden md:block` wrapper class and the table returns to being always-visible. No schema, no
data change.
