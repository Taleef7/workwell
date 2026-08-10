# @mieweb/ui Frontend Migration — Design Spec

- **Date:** 2026-06-08
- **Author:** Taleef (with Claude)
- **Status:** Draft — awaiting review
- **Origin:** Doug 2026-06-08 meeting ("Mieweb UI", "use nitro for all tables")
- **Source of method:** `github.com/mieweb/ui` → `lessons/` (`execution-plan.md`, `component-policy.md`, `tailwind4-integration.md`, `adopting-mieweb-ui.md`)

---

## 1. Context & scope

Doug's 2026-06-08 direction includes adopting **`@mieweb/ui`** (MIE's themeable React component library — `ui.mieweb.org`, npm `@mieweb/ui@0.6.1`, public registry, 126+ components, Tailwind 4, dark mode, brand theming incl. **Enterprise Health**) and using **DataVis NITRO** ("nitro") for tables. This migrates the WorkWell frontend onto `@mieweb/ui`, replacing hand-rolled primitives, raw HTML tables, and the hardcoded `slate-*` palette.

This is the **UI track only** — the first concrete slice of the broader "decompose into reusable, MIE-native modules" direction, and it satisfies "every part uses MIE's own components" for the UI layer. The **headless compliance-engine extraction** and **infra/systemd** items from the same meeting are separate, deferred efforts (not in this spec).

Frontend-only per ownership rules (`frontend/`). No backend changes.

## 2. Goals / Non-goals

**Goals**
- All UI primitives sourced from `@mieweb/ui`: zero raw `<button>/<input>/<select>/<textarea>` and zero hand-rolled modal/card/badge markup in app code.
- Data-grid tables use **DataVis NITRO**; small/static tables use `@mieweb/ui` **`Table`**.
- Full **semantic-token theming + dark mode + Enterprise Health brand** (default) with a runtime **brand switcher**.
- App stays functionally identical — import-only behavior change, every handler preserved; the live demo keeps working throughout.
- Permanent migration record: `frontend/MIEWEB-UI-MIGRATION.md` (vendor template).

**Non-goals**
- No backend changes; no new features or redesign (visual parity — colors may shift to the `@mieweb/ui` palette, layouts/flows unchanged).
- Keep Monaco (CQL editor) and recharts (retheme only) — not migrating those away.
- Not the compliance-engine extraction or infra/systemd work.

## 3. Current state (audit)

| Attribute | Value |
|---|---|
| Framework | Next.js 16.2 App Router |
| React | 19.2 |
| CSS | Tailwind 4 + `@tailwindcss/postcss` ✅ |
| Icons | `lucide-react` ✅ (Step 5 ≈ no-op) |
| Package manager | pnpm |
| Source dirs | `app/` (routes), `components/` (shared), `features/` (studio, employee), `lib/` |
| UI wrappers dir | none — primitives are inline/hand-rolled; `@base-ui/react` installed but **unused** in source |
| Theme | **light-only**, hardcoded `slate-*/white/rose-*`, no dark mode, no theme provider |

**`globals.css` today:** `@import "tailwindcss"` + a 2-variable stub (`--background/--foreground`) + body styles. No `@source`, no `@custom-variant dark`, no `@mieweb-*` tokens, no brand import → CSS foundation is effectively greenfield. `postcss.config.mjs` already uses `@tailwindcss/postcss` ✅.

**Baseline counts (Before column for the report):**
- Raw `<button>`: **~118** across 25 files (1 is a test)
- Raw `<input>/<select>/<textarea>`: **~81** across 16 files
- Raw `<table>` blocks: **~10** — routes (`programs`, `programs/[measureId]`, `runs`, `cases`, `cases/[id]`, `measures`, `admin`, `employees/[externalId]`) + studio panels (`ReleaseApprovalTab`, `TraceabilityTab`, `ValueSetGovernancePanel`, `DataReadinessPanel`)
- recharts: 2 files (`programs`, `programs/[measureId]`) — keep, retheme
- Monaco: `CqlTab` — keep

**Shared components / custom systems → mapping:**

| Current | → `@mieweb/ui` |
|---|---|
| `(dashboard)/layout.tsx` sidebar + sticky header + mobile bottom-nav + filter selects | `Sidebar` + `AppHeader` (+ `Select`) |
| `components/global-toast.tsx` | `Toast` / ToastContainer |
| `components/confirm-dialog.tsx` | `Modal` |
| `components/skeleton-loader.tsx` | `Skeleton` |
| `components/SlaChip.tsx` + status spans | `Badge` |
| `components/GlobalSearch.tsx` | `CommandPalette` (evaluate) or keep + `Input` |
| `components/osha-reference-combobox.tsx` | `Select` (or keep as Tier-2 combobox) |
| `components/audit-packet-export-button.tsx` | `Button` |
| Studio tabs; card divs | `Tabs`; `Card`/`CardContent` |

## 4. Decisions (locked 2026-06-08)

1. **Brand:** Enterprise Health default **+ runtime brand switcher** (`BrandInitializer` + `useBrand`).
2. **Tables:** DataVis NITRO for **data grids** (cases, runs, outcomes, measures, employees, worklist); basic `Table` for **small/static** tables (summaries, key-value, studio panels).
3. **Theming:** full semantic-token migration **+ dark mode** + brand switching.
4. **Process:** write this spec, then execute **phased** on `feat/mieweb-ui-migration`, validating each step.

**Sub-decision (no new dep):** use a small custom `useTheme` hook (vendor-provided snippet) rather than `next-themes`, per the "avoid new dependencies" rule. Use `@mieweb/ui`'s `ThemeProvider` if Storybook confirms it manages `data-theme`/dark; else the custom hook.

## 5. Approach — vendor-prescribed, report-first

Follow `lessons/execution-plan.md` **in order**, never batching, validating after each step, **no commit/push without explicit ok**. Create `frontend/MIEWEB-UI-MIGRATION.md` **first** using the exact 17-checkbox template, updated after every step. Copy the 3 reference files into `docs/mieweb-ui-migration/` for reproducibility.

> Report location: vendor says "project root." This monorepo's frontend project root is `frontend/`, and all audit greps target `app/ components/ features/` — so the report lives at `frontend/MIEWEB-UI-MIGRATION.md`.

**The 10 steps (mapped to our repo):**
- **Pre-flight** — branch `feat/mieweb-ui-migration`; confirm clean baseline (`pnpm lint`, `pnpm build`, `pnpm test`).
- **Step 1 Install** — `pnpm add @mieweb/ui` (public npm v0.6.1). Add NITRO peer `datavis-ace@4.0.0-PRE.2` (+ `./datavis` entry). Skip AGGrid peers (not used) unless NITRO needs them — verify. Confirm barrel import works.
- **Step 2 CSS foundation** — rewrite `globals.css`: `@import '@mieweb/ui/brands/enterprise-health.css' layer(theme)`, `@import 'tailwindcss'`, `@source "../node_modules/@mieweb/ui/dist"`, `@custom-variant dark (...)`, full `@theme` block **with hex fallbacks** (from `tailwind4-integration.md`), keep font vars. Add `useTheme` (sets both `.dark` class **and** `data-theme` attr). postcss already correct (optionally add autoprefixer).
- **Step 3 Brand switching** — copy `node_modules/@mieweb/ui/dist/brands/*.css` → `frontend/public/brands/`; add a `predev`/`prebuild` (or CI) copy step; `useBrand` (default `enterprise-health`); `BrandInitializer` in root layout inside the theme provider; a brand-switcher control on a settings/admin surface.
- **Step 4 Component swaps** (validate after each): 4a buttons (~118, **layout shell first**) · 4b dialog→`Modal` · 4c forms (~81; `Select` compound→`options` API) · 4d data display (`Badge`/`Card`/`Tabs`/`Avatar`) + **tables (NITRO vs `Table`)** · 4e feedback (`Toast`/`Skeleton`/`Spinner`/`Progress`/`Alert`) · 4f nav (`Sidebar`/`AppHeader`/`Breadcrumb`/`Pagination`) · 4g overlays (`Tooltip`/`Dropdown`/`CommandPalette`) · 4h evaluate/keep (Monaco, recharts, osha combobox).
- **Step 5 Icons** — already lucide; audit only (optionally switch to `@mieweb/ui` `*Icon` aliases).
- **Step 6 Cleanup** — `cn` bridge (`lib/utils.ts` re-export `{ cn } from '@mieweb/ui'`); remove unused deps (`@base-ui/react` definitely; evaluate `clsx`/`tailwind-merge`/`class-variance-authority`/`tw-animate-css`).
- **Step 7 a11y pass** — ARIA on icon-only buttons/inputs/modals; keyboard nav.
- **Step 8 Test/verify** — `tsc --noEmit`, `pnpm lint`, `pnpm build`, `pnpm test` (vitest), Playwright (`e2e/`); visual smoke light/dark/2 brands; fill compliance numbers.
- **Step 9 Gaps** — document Tier-2 keeps + non-`@mieweb` CSS vars.
- **Step 10 Report** — finalize all sections (Files Modified/Created/Deleted, Compliance Summary with real numbers, Known Gaps, Notes).

## 6. Theming strategy (the large, hidden half)

CSS foundation per Step 2, then **token migration app-wide** (done per-file alongside that file's component swap to avoid double-touching):

| Hardcoded today | → token |
|---|---|
| `bg-white` | `bg-card` / `bg-background` |
| `bg-slate-50` | `bg-background` / `bg-muted` |
| `text-slate-900/950` | `text-foreground` |
| `text-slate-500/400` | `text-muted-foreground` |
| `border-slate-200` | `border-border` |
| `bg-slate-900 text-white` (active nav, brand chip) | `bg-primary text-primary-foreground` |
| `bg-rose-100 text-rose-700` (gap badge) | `Badge variant="danger"` |
| status colors (compliant/overdue/due-soon/missing) | `success` / `destructive` / `warning` / `info` tokens |

Dark mode toggle on header/admin; validate against the vendor dark-mode regression checklist. **No-FOUC:** set a default `data-theme` on `<html>` and run `BrandInitializer` early to avoid hydration flash in the App Router.

## 7. Tables strategy

- **DataVis NITRO** (`DataVisNitroSource` + `DataVisNitroGrid`, from the `@mieweb/ui` `./datavis` entry) for sort/filter/column grids: **cases, runs, outcomes, measures, employees, worklist**. Needs `datavis-ace@4.0.0-PRE.2`.
- **Basic `Table`** for small summary/key-value tables and studio panels unless they need grid features.
- **Riskiest integration** (pinned pre-release peer + data-source API) → validate NITRO in the **pilot page** before rolling to all grids. Fallback: basic `Table` for grids first if NITRO is painful (revisit decision Q2).

## 8. Phasing (execution order on the branch)

- **Phase 0** — Pre-flight + Step 1 install + Step 2 CSS foundation + Step 3 brand infra → app boots with EH brand + dark mode, nothing visually broken. *(validate)*
- **Phase 1** — Layout shell (`Sidebar`/`AppHeader`) + global systems (toast, confirm-dialog, skeleton) → theme context app-wide. *(validate)*
- **Phase 2 — PILOT** — `/cases` end-to-end (buttons + NITRO grid + badges + filters + tokens + dark). Proves the full pattern incl. NITRO. *(validate → checkpoint with Taleef)*
- **Phase 3** — Remaining pages in batches (programs, programs/[id], runs, cases/[id], measures, studio + tabs, admin, employees, worklist, login, sandbox, landing). *(validate per page)*
- **Phase 4** — Cleanup (Step 6) + a11y (Step 7).
- **Phase 5** — Verify (Step 8) + gaps (Step 9) + finalize report (Step 10) + docs.

## 9. What we keep

- **Monaco** (`@monaco-editor/react`) — CQL editor, no equivalent. Theme its container to tokens; sync its light/dark theme to the toggle.
- **recharts** — keep; retheme series to `--mieweb-chart-1..5`; verify dark-mode legibility. (`@mieweb/ui` provides only chart color vars.)
- **Tier-2 gaps** (e.g. osha combobox if `Select` can't match) — build in `@mieweb/ui` style (CVA, forwardRef, tokens, a11y).

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| New deps (`@mieweb/ui` + NITRO peer `datavis-ace@4.0.0-PRE.2`, pinned pre-release) | Doug-directed → approved; record ADR. Validate NITRO in pilot; pin our version; watch pre-release breakage. |
| Public-npm reachability in CI / MIE build | Public registry → low risk; verify in CI early. |
| Dark-mode token churn large, easy to miss spots | Compliance audit + dark-mode regression checklist; tokens+components together per file. |
| Vitest tests assert current markup → breakage | Update tests alongside swaps. Check Playwright `e2e/` story/test IDs. |
| SSR/hydration of theme/brand (localStorage) | Default `data-theme` on `<html>` + early `BrandInitializer`; avoid FOUC/mismatch. |
| `Select` compound→`options` API change | Verify each `Select` (layout filters, studio) renders + fires `onValueChange`. |
| Live demo must keep working | Phased + validate-per-step; feature branch; merge only when green after review. |
| Bundle size (datavis/mermaid via peers) | Install peers only for components used; check build size. |

## 11. Verification gates (every phase)

`pnpm lint` · `npx tsc --noEmit` · `pnpm build` · `pnpm test` (vitest) · Playwright where relevant · visual smoke (light/dark + 2 brands) · compliance audit trending to zero raw elements.

## 12. Definition of done (per CLAUDE.md)

- Tests pass; CI green.
- Docs updated same PR: ARCHITECTURE (frontend surfaces + theming), README (stack `+ @mieweb/ui`), DECISIONS (ADR: adopt `@mieweb/ui` + NITRO), DEPLOY (brand-CSS copy step if it affects the build), and `frontend/MIEWEB-UI-MIGRATION.md` complete.
- JOURNAL.md entry for 2026-06-08.
- Conventional commits (e.g. `feat(ui): adopt @mieweb/ui CSS foundation + EH brand`).
- Branch `feat/mieweb-ui-migration`; merge after Taleef review; **no auto-merge; no commit/push without explicit ok**.
- Vision Doc (local) Jun 8 entry updated with this plan summary.

## 13. Deliverables / artifacts

- `frontend/MIEWEB-UI-MIGRATION.md` (living report).
- `docs/mieweb-ui-migration/{execution-plan,component-policy,tailwind4-integration}.md` (copied references).
- `frontend/app/globals.css` rewritten; `frontend/postcss.config.mjs` (autoprefixer optional).
- `frontend/lib/useTheme.ts`, `frontend/lib/useBrand.ts`, `frontend/components/brand-initializer.tsx`.
- `frontend/public/brands/*.css` + build copy step.
- Component + token swaps across ~30 files.

## 14. Prerequisites / open items

- Verify `datavis-ace@4.0.0-PRE.2` installs cleanly (NITRO). If painful → basic `Table` for grids first.
- Verify CI / MIE build pulls from public npm (expected fine).
- Confirm `@mieweb/ui` `ThemeProvider` behavior in Storybook (does it own `data-theme`/dark?) → else custom `useTheme`.
