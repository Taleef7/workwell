# E11.3 PR-2 — Configure Groups UI + roster segment surfacing (Design)

Date: 2026-06-25
Status: Approved (design)
Author: Taleef (with Claude)
Epic: E11 (#183) — sub-project 3, PR-2 (the frontend half). Closes E11 entirely. Surfaces the PR-1
segment backend in the UI: the vamsi8 **CONFIGURE GROUPS** editor + the GROUPS-aware roster (vamsi1/2).

## 1. Context

E11.3 PR-1 (merged #205, live) added the **segment** backend: a cohort (`role`/`site` predicate rule +
per-employee INCLUDE/EXCLUDE overrides) → an applicable measure-id rule-set, persisted in 3 tables behind
a `SegmentStore` port, with an ADMIN-gated audited `/api/segments` CRUD + `/preview`, a roster
`NOT_APPLICABLE` overlay + `?segment=` filter, and run-pipeline case-gating. Applicability gates case
creation + display only — never compliance (ADR-016). The demo seed ships 3 **enabled** cohorts, so the
overlay is already live; this PR puts a UI in front of it.

The frontend already has the patterns this reuses: the `/admin` tabbed console with lazy-loaded tabs
(`admin/page.tsx`), the compliance roster grid + `ComplianceChip` (`features/compliance/ComplianceChip.tsx`)
driven by `lib/status.ts`, capability-based RBAC (`lib/rbac.ts`), the cached API client
(`lib/api/client.ts` + `useApi`), the `RuleBuilderTab` form (`features/studio/components/`), the Cases
Modal + `@mieweb/ui` form controls, and the `osha-reference-combobox` searchable-picker pattern. **Gap:**
there is no employee directory list/search endpoint on the frontend (only `/api/employees/:id/profile`),
which the overrides picker needs.

## 2. Goal / non-goals

**Goal:** a complete **Configure Groups** admin editor (full CRUD over the hybrid model — rule + applicable
measures + INCLUDE/EXCLUDE overrides — with a live server-computed membership preview), plus the roster
made segment-aware (a `NOT_APPLICABLE` chip + a segment filter). Two small read-only backend endpoints
support the editor.

**Non-goals:** changing the segment data model or applicability semantics (PR-1 owns those); predicates
beyond `role`/`site`; bulk import of WebChart groups (E12+); a per-employee-screen segment editor (the
employee card already inherits the roster overlay read-only). No schema change.

## 3. Backend additions (2 read-only endpoints, no schema)

### 3.1 `GET /api/employees?q=&limit=`
Returns the synthetic directory as `{ externalId, name, role, site }[]` (from
`engine/synthetic/employee-catalog.ts` `EMPLOYEES`). Optional `q` filters name/externalId/role/site
(case-insensitive substring); optional `limit` (default all 100). Authenticated under `/api/**` (all
roles, read-only). Powers the overrides employee picker. Added to `handleEmployees`
(`backend-ts/src/routes/employees.ts`), which today matches only `/profile`, `/search`, `/simulate` — a
bare `GET /api/employees` (+ trailing-slash) is free to add. Read-time; no schema.

### 3.2 `POST /api/segments/preview`
Body `{ rule, overrides }` → `{ count, members: string[] }` (member externalIds). Dry-run membership over
`EMPLOYEES` using the backend's **exact** `matchesCohort` (so the preview can never drift from real
applicability) after the **same `validateRule`/`validateOverrides`** the CRUD route uses (400 on malformed).
**ADMIN-gated automatically** by the existing `{ method: "POST", pattern: rx("/api/segments/**"), access:
[A] }` rule; routed in `handleSegments` **before** the `POST /api/segments` create branch (match
`pathname === "/api/segments/preview"` first). Read-time; no schema; no audit (read-only).

## 4. Roster surfacing

### 4.1 `NOT_APPLICABLE` chip (`lib/status.ts`)
- Add `NOT_APPLICABLE: "Not Applicable"` to `COMPLIANCE_STATUS_LABELS`.
- Add a `NOT_APPLICABLE` branch to `complianceStatusClass` returning a **slate** class
  (`bg-slate-100 text-slate-600 dark:bg-slate-800/40 dark:text-slate-400`) — visually "out of scope,"
  distinct from the neutral `NA` ("no data") grey and from any alarm color.
- `ComplianceChip` + the employee compliance card render it automatically (no component change).

### 4.2 Segment filter (`app/(dashboard)/compliance/page.tsx`)
- A `<select>` next to the Panel selector, populated from `GET /api/segments` filtered to **enabled**
  segments (label = name), with an "All segments" default (empty value).
- On change: reset page to 1, set `segment` state, include `&segment=<id>` in the roster request (the
  backend scopes rows to the cohort + columns to the rule-set). When "All," omit the param (panel-scoped
  columns + the per-cell overlay, as today).

## 5. Configure Groups editor (`features/segments/`)

A new ADMIN-only **"Groups"** tab in `/admin`.

### 5.1 RBAC + tab
- `lib/rbac.ts`: add `canManageSegments(role) = isAdmin(role)` (mirrors the backend `/api/segments` write
  gate). The `/admin` page is already ADMIN-gated; the Groups tab + its actions use `canManageSegments`.
- `admin/page.tsx`: add `{ id: "groups", label: "Groups" }` to `ADMIN_TABS`; lazy-load the segment list +
  the measures catalog + the directory on first open (the existing `loadedTabs` pattern); render
  `<SegmentsAdmin/>`.

### 5.2 Components
- **`SegmentsAdmin`** — orchestrates: a "New group" button (opens the editor) + `SegmentsList`.
- **`SegmentsList`** — table over `GET /api/segments`: name · enabled (badge) · member count · applicable
  measures (names) · **Edit** / **Delete** (Delete confirms). Member count comes from a `POST
  /api/segments/preview` per row (the directory is 100 rows and there are only a handful of segments, so
  this is cheap; computed once on list load, refreshed after a save). Delete → `DELETE /api/segments/:id`
  (busts cache) → refresh.
- **`SegmentEditorModal`** — create/edit form (a `@mieweb/ui` `Modal`, mirrors the Cases scheduling modal):
  - **Fields:** `name` (Input, required), `description` (Textarea), `enabled` (toggle, default true).
  - **Rule builder:** a `match` ANY/ALL `Select` + a list of condition rows. Each row: `attr` (role|site
    `Select`), `op` (equals|contains|in `Select`), `value` — a single `Input` for equals/contains, and a
    multi-value input (chips or comma-split) for `in`. Add/remove rows. Client validation mirrors the
    backend op/value coupling (`in` → non-empty list; equals/contains → non-empty string).
  - **Applicable measures:** a checkbox multiselect over the **Active runnable** measures (from
    `GET /api/measures`, filtered `status === "Active"`; id + name). ≥1 required.
  - **Overrides:** a searchable employee picker (mirrors `osha-reference-combobox`, fed by
    `GET /api/employees?q=`) → add a subject as INCLUDE or EXCLUDE; the chosen overrides render as
    removable chips with an INCLUDE/EXCLUDE toggle. De-duped by externalId (last wins, matching the store).
  - **Live preview:** a debounced (~300ms) `POST /api/segments/preview { rule, overrides }` →
    "**N employees match**" + a small sample of names; re-runs as the rule/overrides change. Skips the
    call while the rule is invalid (shows the validation hint instead).
  - **Save:** `POST /api/segments` (create) or `PUT /api/segments/:id` (edit) with `{ name, description,
    enabled, rule, measureIds, overrides }`; on success bust cache, close, refresh the list + the roster
    segment-filter options. Surface backend 400s inline.
- **Hooks (`features/segments/hooks/`):** `useSegments` (list/create/update/delete via `useApi`),
  `useDirectory` (debounced `GET /api/employees?q=`), `usePreview` (debounced dry-run). Each is small +
  single-purpose.

### 5.3 Types
A `features/segments/types.ts` mirroring the backend `HydratedSegment`/`SegmentRule`/`SegmentCondition`/
`SegmentOverride`/`CreateSegmentInput` shapes (frontend-local; the API is untyped JSON).

## 6. Testing

- **Backend:** `GET /api/employees` (list + `q` filter + shape); `POST /api/segments/preview` (count +
  members via `matchesCohort`, ADMIN gate (403 for CM), malformed rule → 400, op/value-shape → 400).
- **Frontend** (repo frontend test setup — Vitest/RTL per `frontend/package.json`):
  - `status.ts` — `NOT_APPLICABLE` label + class.
  - roster page — segment `<select>` populates from enabled segments + adds `&segment=` to the request;
    `NOT_APPLICABLE` cell renders the slate chip.
  - `SegmentEditorModal` — add/remove condition rows; the `in`-vs-string value control switch; measures
    multiselect; overrides add/remove + mode toggle; debounced preview call fires; save posts the right
    body; client validation blocks an invalid rule.
  - `rbac` — `canManageSegments` ADMIN-only; the Groups tab/actions hidden for non-admins.
- `npm run lint` + `npm run build` (frontend) and `corepack pnpm@10 test` (backend) green.

## 7. Architecture / boundaries

- New frontend module `features/segments/` (list, editor modal, hooks, types) — one focused unit per file,
  consumed by a thin `admin/page.tsx` Groups tab. No change to the roster grid component beyond the filter
  control + the `status.ts` chip entry.
- Two backend endpoints are thin, read-only, reuse existing engine/synthetic + segment helpers — no new
  module, no schema, no audit.
- The editor authors the same `{ rule, measureIds, overrides }` the PR-1 store + `/api/segments` already
  accept; the preview reuses the same `matchesCohort`. CQL stays the sole compliance authority (ADR-008);
  segments configure applicability only (ADR-016) — the UI never sets status.

## 8. PR boundary

**One PR** (`feat/e11-3-segments-ui`): backend endpoints 3.1 + 3.2, then the roster surfacing (§4), then
the Groups editor (§5). Closes E11 (#183). After merge, `/admin → Groups` lets an operator author cohorts
and the roster shows the live applicable/N-A picture with a segment filter.

## 9. Risks

- **Preview chattiness** — debounce the dry-run (~300ms) + skip while the rule is invalid; the directory is
  100 rows so each call is trivial.
- **Measures source** — the multiselect needs measure id+name; `GET /api/measures` returns the full catalog
  (filter `status === "Active"` → the 14 runnable). If that list shape differs, adapt at build time.
- **Overrides drift** — the editor de-dupes overrides by externalId to match the store's replace-set
  semantics, so a save round-trips identically.
