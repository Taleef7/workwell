# @mieweb/ui Migration Report — WorkWell Measure Studio (frontend)

> Auto-generated migration report. Documents all changes made during the @mieweb/ui integration.
> **Use every section below.** Do not reorganize, merge, or skip sections — the structure enables cross-project comparison.
>
> Living document — created before any code change (per execution-plan), updated after each step.
> Design spec: `docs/superpowers/specs/2026-06-08-mieweb-ui-migration-design.md`. Reference method: `docs/mieweb-ui-migration/`.

## Project Profile

| Attribute | Value |
|-----------|-------|
| Framework | Next.js 16.2 (App Router) |
| React | 19.2 |
| CSS | Tailwind CSS 4 + `@tailwindcss/postcss` |
| Previous UI library | hand-rolled (CVA + clsx + tailwind-merge); `@base-ui/react` installed but unused in source |
| Component library | @mieweb/ui 0.6.1 — **482 named exports** |
| Package manager | pnpm 10 (via corepack: `corepack pnpm@10`) |
| Source dirs | `app/` (routes), `components/` (shared), `features/` (studio, employee), `lib/` |
| UI wrappers dir | none (no `components/ui/`) — primitives inline per file |
| Theme system | added — `useTheme` (`.dark` + `data-theme`) + `useBrand` (`data-brand` + `<link>`); was light-only/hardcoded |
| Brand | Enterprise Health (default) + runtime switcher |

## @mieweb/ui Export Availability

[Verified exports needed for THIS project. Filled as components are evaluated.]

| Component | Available | Notes |
|-----------|-----------|-------|
| Button | ✅ | In barrel. Variant renames expected: default→primary, destructive→danger |
| Modal | ✅ | In barrel. Replaces `confirm-dialog`; `open`/`onOpenChange` |
| Table | ✅ | In barrel. Basic styled table (small/static tables) |
| Sidebar | ✅ | In barrel. Dashboard layout shell |
| Badge | ✅ | In barrel. Replaces SlaChip + status spans |
| DataVis NITRO | ⏳ | Data grids; via `@mieweb/ui/datavis`; needs peer `datavis-ace@4.0.0-PRE.2` — validate in pilot |
| Card / Tabs / AppHeader / Toast / Skeleton / Select / Dropdown / Tooltip / CommandPalette | ⏳ | Evaluate at their steps |
| ThemeProvider | ⏳ | Using custom `useTheme` instead (no new dep) |

## Wrapper File Audit

[Project has NO `components/ui/` wrapper directory — primitives are hand-rolled inline per file. There are no shadcn-style wrapper files to delete. Shared custom components are audited in Pattern Audit → Custom Systems and in the per-step notes instead.]

| # | File | @mieweb/ui Replacement | App Imports? | Status |
|---|------|------------------------|-------------|--------|
| — | (none — no `components/ui/`) | — | — | N/A |

## Pattern Audit

### Raw HTML Elements Replaced

| # | File | Element | Replacement | Status |
|---|------|---------|-------------|--------|
| | _(to fill during Step 4)_ | | | |

### Badge/Pill Patterns (Styled Spans)

| # | File | Description | Replacement | Status |
|---|------|-------------|-------------|--------|
| | _(to fill during Step 4d)_ | | | |

### Card Patterns (Styled Divs)

| # | File | Description | Replacement | Status |
|---|------|-------------|-------------|--------|
| | _(to fill during Step 4d)_ | | | |

### Custom Systems (Toast, Sidebar, etc.)

| System | Original Implementation | New Implementation | Status |
|--------|------------------------|-------------------|--------|
| Toast | `components/global-toast.tsx` | @mieweb/ui `ToastProvider`/`ToastContainer`/`useToast` | ✅ Phase 1a — event bridge kept (`emitToast`); `ToastProvider` provides context only, so `ToastContainer` is rendered from `useToast()` in `GlobalToast`. New client boundary `client-providers.tsx`. |
| Confirm dialog | `components/confirm-dialog.tsx` | @mieweb/ui `Button` + dark-aware tokens | ✅ Phase 1a — **kept** the tested a11y shell (`role=alertdialog`, focus-trap, scroll-lock, `[aria-hidden]` backdrop) which Modal (`role=dialog`) does not replicate; migrated buttons → `Button` + colors → neutral tokens. 9/9 tests still pass. |
| Layout shell | `(dashboard)/layout.tsx` sidebar + header + mobile nav | @mieweb/ui `Sidebar`(+`Provider`/`Header`/`Content`/`Nav`/`NavItem`/`Footer`/`Toggle`/`MobileToggle`) + `AppHeader`(+`Section`) + `Select` filters + `ThemeBrandSwitcher` | ✅ Phase 1b — full rewrite. Sidebar owns mobile drawer+backdrop (custom drawer machinery, outside-click, mobile bottom-nav all removed). Desktop collapse via `SidebarToggle`. Brand/theme switcher now live in header. |
| Global search | `components/GlobalSearch.tsx` | @mieweb/ui `CommandPalette` (evaluate) | ⏳ Step 4g |
| OSHA combobox | `components/osha-reference-combobox.tsx` | @mieweb/ui `Select` or Tier-2 keep | ⏳ Step 4c |
| Skeleton loader | `components/skeleton-loader.tsx` | @mieweb/ui `Skeleton` | ✅ Phase 1a — `SkeletonCard`/`SkeletonRow` export names + signatures preserved; internals rebuilt on `Skeleton` (dark-aware). |
| Theme + brand | none (light-only) | `useTheme` + `useBrand` + `AppThemeInitializer` | ✅ Step 2/3 |

## Steps Completed

[Check off each step that was performed, with brief notes]

- [x] Step 1: Install @mieweb/ui — v0.6.1, **482** named exports (pnpm 10 via corepack). Peers intact (`monaco-editor`, `@testing-library/dom` in `.pnpm`); `datavis-ace` deferred to NITRO pilot. `dist/` ships prebuilt (build script ignored — not needed for consumers). Baseline `next build` green.
- [x] Step 2: CSS Foundation — `globals.css` rewritten: Enterprise Health brand import (`layer(theme)`), `@source "../node_modules/@mieweb/ui/dist"`, `@custom-variant dark` (data-theme + .dark), full `@theme` token block w/ hex fallbacks (7 scales + semantic + chart), Geist fonts preserved. Added `lib/useTheme.ts` (`useSyncExternalStore`; sets `.dark` + `data-theme`). PostCSS already `@tailwindcss/postcss`. Build green. ⚠ Cosmetic: brand's Jost `@import` is ignored inside `layer(theme)` → app keeps Geist (font fidelity = follow-up).
- [x] Step 3: Brand Switching — copied 7 brand CSS files to `public/brands/`; added `scripts/copy-brand-css.mjs` + `sync:brands` npm script; `lib/useBrand.ts` (`useSyncExternalStore`; injects `/brands/{brand}.css` `<link>`, sets `data-brand`, default `enterprise-health`); `components/app-theme-initializer.tsx` restores saved theme+brand on load; wired into root layout (`<html suppressHydrationWarning data-theme="light">`). Switcher **UI** deferred to Phase 1 (lives in AppHeader). Build + lint green.
- [ ] Step 4a: Buttons — [count replaced, count raw HTML converted] — pending (~118 raw `<button>`)
- [x] Step 4b: Dialog/Modal — `confirm-dialog` migrated to @mieweb/ui `Button` + dark tokens; tested a11y shell kept (Modal's `role=dialog` ≠ the asserted `role=alertdialog`/focus-trap). 9/9 tests pass.
- [ ] Step 4c: Form Elements — pending (~48 input / 21 select / 12 textarea)
- [ ] Step 4d: Data Display — pending (Badge, Card, Tabs; NITRO grids vs Table)
- [x] Step 4e: Feedback — Toast (`ToastProvider`+`ToastContainer`+`useToast`, event bridge preserved) and Skeleton (`SkeletonCard`/`SkeletonRow` rebuilt on `Skeleton`). Build + 53/53 tests green.
- [x] Step 4f: Navigation — `(dashboard)/layout.tsx` rebuilt on @mieweb/ui `Sidebar` + `AppHeader` + `ThemeBrandSwitcher`. Header site/date filters now @mieweb/ui `Select` (partial Step 4c). Build + lint green.
- [ ] Step 4g: Overlays — pending (Dropdown, Tooltip, CommandPalette)
- [ ] Step 4h: Evaluate & Decide — pending (keep Monaco, recharts; osha combobox)
- [ ] Step 5: Icon Migration — already lucide-react (expect ≈ no-op) — pending verify
- [ ] Step 6: Clean Up — pending (cn bridge; remove `@base-ui/react`)
- [ ] Step 7: Accessibility Pass — pending
- [ ] Step 8: Testing & Verification — pending (build passing so far; numbers at end)
- [ ] Step 9: Gap Detection — pending
- [ ] Step 10: Migration Report — in progress (this file, updated per step)

## Post-Migration Import Map

[For each feature file that imports UI components, show what it imports and from where. To fill as files migrate.]

| Feature File | Imports from @mieweb/ui | Imports from local | Notes |
|-------------|------------------------|-------------------|-------|
| | _(to fill from Step 4)_ | | |

## Files Modified

| File | Change Summary |
|------|---------------|
| `frontend/app/globals.css` | Replaced 2-var stub with full @mieweb/ui CSS foundation (brand import, `@source`, `@custom-variant dark`, `@theme` token block + fallbacks) |
| `frontend/app/layout.tsx` | `<html suppressHydrationWarning data-theme="light">`; render `<AppThemeInitializer/>`; body class now token-driven (dropped hardcoded `bg-slate-50 text-slate-900`) |
| `frontend/package.json` | Added `@mieweb/ui@^0.6.1` dependency + `sync:brands` script |
| `frontend/pnpm-lock.yaml` | Lockfile entry for `@mieweb/ui` (+80/-3) |
| `frontend/app/layout.tsx` | (Phase 1a) Providers moved into `ClientProviders` client boundary (was inline `AuthProvider`+`GlobalToast`); root layout no longer imports `@mieweb/ui` directly |
| `frontend/lib/toast.ts` | (Phase 1a) `emitToast(message, variant?)` — optional `ToastVariant`, default `success` |
| `frontend/components/global-toast.tsx` | (Phase 1a) Reimplemented as bridge: `useToast()` + `ToastContainer` (top-right); listens to `workwell:toast` |
| `frontend/components/confirm-dialog.tsx` | (Phase 1a) Buttons → `Button`; colors → neutral dark-aware tokens; a11y shell unchanged |
| `frontend/components/skeleton-loader.tsx` | (Phase 1a) `"use client"`; internals rebuilt on `Skeleton` |
| `frontend/app/(dashboard)/layout.tsx` | (Phase 1b) **Full rewrite** onto @mieweb/ui `Sidebar` + `AppHeader`; removed custom mobile drawer + bottom-nav; nav via `router.push`; fixed app-shell (`h-dvh overflow-hidden`, `main` scrolls); 4 raw `<select>` → `Select` |

## Files Created

| File | Purpose |
|------|---------|
| `frontend/MIEWEB-UI-MIGRATION.md` | This migration report |
| `docs/mieweb-ui-migration/execution-plan.md` | Vendor 10-step plan (reference copy) |
| `docs/mieweb-ui-migration/component-policy.md` | Vendor component policy (reference copy) |
| `docs/mieweb-ui-migration/tailwind4-integration.md` | Vendor Tailwind 4 / CSS-var reference copy |
| `frontend/lib/useTheme.ts` | Dark/light hook (sets `.dark` + `data-theme`) |
| `frontend/lib/useBrand.ts` | Runtime brand switcher hook (default Enterprise Health) |
| `frontend/components/app-theme-initializer.tsx` | Restores saved theme+brand on every page load |
| `frontend/scripts/copy-brand-css.mjs` | Syncs brand CSS → `public/brands` (`pnpm sync:brands`) |
| `frontend/public/brands/*.css` | 7 brand CSS files (bluehive, ccme, enterprise-health, mieweb, ozwell, waggleline, webchart) |
| `frontend/components/client-providers.tsx` | (Phase 1a) Client boundary wrapping `ToastProvider` + `AuthProvider` + `GlobalToast` |
| `frontend/components/theme-brand-switcher.tsx` | (Phase 1b) Header control: brand `Select` + light/dark toggle (`useBrand`/`useTheme`) |

## Files Deleted

| File | Reason |
|------|--------|
| _(to fill — e.g. `@base-ui/react` removal at Step 6)_ | |

## Compliance Summary

[Before = audited 2026-06-08 on `app/ components/ features/` (excludes node_modules + tests). After = filled at Step 8.]

| Metric | Before | After |
|--------|--------|-------|
| Raw `<button>` elements | 118 | _TBD_ |
| Raw `<input>` elements | 48 | _TBD_ |
| Raw `<select>` elements | 21 | _TBD_ |
| Raw `<textarea>` elements | 12 | _TBD_ |
| Raw `<table>` elements (blocks) | ~10 | _TBD_ |
| shadcn/local wrapper files | 0 (none) | 0 |
| `@mieweb/ui` import lines | 0 | _TBD_ |
| Total dependencies (prod+dev) | 27 (11+16) | 28 (12+16) so far |

## Known Gaps

[Components kept local because no @mieweb/ui equivalent exists. To finalize at Step 9.]

| Component | Reason Kept | File(s) |
|-----------|-------------|---------|
| Monaco (CQL editor) | No equivalent — specialized | `features/studio/components/CqlTab.tsx` |
| recharts | @mieweb/ui ships chart color vars only, not chart components | `app/(dashboard)/programs/page.tsx`, `programs/[measureId]/page.tsx` |
| Brand font (Jost) | EH brand's `@import` of Jost is dropped inside `layer(theme)` — app keeps Geist | `app/globals.css` (font-fidelity follow-up) |

## Notes

[Issues encountered, workarounds, variant mappings, follow-ups.]

- **Decisions (2026-06-08):** Enterprise Health brand default + switcher · NITRO for data grids, basic Table for small/static · full token migration + dark mode · phased on `feat/mieweb-ui-migration`.
- **Install/tooling:** `pnpm` not on PATH → use `corepack pnpm@10` (project store is v10; `@latest`=pnpm 11 errors with `ERR_PNPM_UNEXPECTED_STORE`). npm registry reachable; `raw.githubusercontent.com` blocked in sandbox (use `gh api`).
- **Peer pitfall (resolved):** do NOT pass `--no-auto-install-peers` — it rewrote `pnpm-lock.yaml` and pruned project peers (`monaco-editor`, `@testing-library/dom`), breaking editor+tests. Fix was `git checkout -- frontend/package.json frontend/pnpm-lock.yaml` then a clean `pnpm add`. `datavis-ace` intentionally NOT installed yet (deferred to NITRO pilot).
- **Variant renames to watch (component-specific):** Button `default`→`primary`, `destructive`→`danger`; Badge keeps `default`, uses `danger`. No `asChild` on Button.
- **API shape changes:** Select compound children → `options` array (`onValueChange(value)`); Avatar → props-based (`src`,`name`); Dropdown → `trigger` prop + `DropdownItem icon=`.
- **No new theme dep:** custom `useTheme`/`useBrand` via `useSyncExternalStore` (satisfies `react-hooks/set-state-in-effect`; no `next-themes`).
- **Brand load:** default Enterprise Health comes from the static `globals.css` import; `AppThemeInitializer` re-applies saved brand on load (minor redundant fetch for default users — acceptable; no-FOUC inline script is a later option).
- **⚠ Server-component pitfall (Phase 1a):** the `@mieweb/ui` barrel evaluates `React.createContext` at module load (Toast/Sidebar/CommandPalette contexts). Importing it from a **Server Component** (root `app/layout.tsx`) breaks `next build` at page-data collection with `TypeError: _.createContext is not a function`. **Rule: only import `@mieweb/ui` from `"use client"` modules.** Fix was the `client-providers.tsx` boundary; `skeleton-loader.tsx` also marked `"use client"` defensively.
- **Toast architecture (Phase 1a):** `ToastProvider` provides context only — it does **not** render a viewport. You must render `<ToastContainer toasts onDismiss position />` yourself from `useToast()`. The legacy `emitToast()` window-event contract is preserved via a bridge in `GlobalToast`, so no call sites changed (37 `emitToast` calls across 11 files).
- **confirm-dialog kept, not Modal:** spec said `confirm-dialog → Modal`, but the component has a 9-test a11y contract (`role=alertdialog`, custom Tab focus-trap wrap, scroll-lock, `[aria-hidden]` backdrop) that @mieweb/ui `Modal` (`role=dialog`, own focus handling) would regress. Decision: keep the shell, migrate buttons→`Button` + tokens. Revisit wholesale-Modal only if a11y parity is verified.
- **Layout shell behavior changes (Phase 1b) — needs a visual smoke:** (1) **mobile breakpoint moved md(768)→lg(1024)** — Sidebar = off-canvas drawer below 1024px (tablets now get the drawer); (2) **mobile bottom-nav removed** — replaced by the Sidebar drawer opened via the header hamburger (`SidebarMobileToggle`); (3) **nav uses `router.push`** not `<Link>` (SidebarNavItem `href` renders a full-reload `<a>`), so client nav is kept but **route prefetch is dropped** — revisit if nav feels slow; (4) **fixed app-shell** — outer `h-dvh overflow-hidden`, `main` is the scroll container (was window scroll); (5) **desktop sidebar collapse** added (`SidebarToggle`, persisted by @mieweb/ui to `localStorage` key `sidebar-collapsed`).
