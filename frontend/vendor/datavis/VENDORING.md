# Vendored `@mieweb/datavis` (NITRO data grid)

This directory is a **vendored copy** of the MIE DataVis NITRO grid source, consumed by
`@mieweb/ui/datavis`. It exists so WorkWell can use the NITRO data grid without waiting for
MIE to publish `@mieweb/datavis` to npm.

## Why this is needed

The published `@mieweb/ui` package ships the NITRO bundle (`dist/datavis.js` + the `./datavis`
export), but that bundle imports raw source from a **bare `datavis` specifier**, e.g.:

```js
import { DataGrid } from 'datavis/src/components/DataGrid';
import { useView } from 'datavis/src/adapters/use-data';
import { Source, ComputedView } from 'datavis-ace';
```

`@mieweb/ui`'s build marks `/^datavis\//` as external, expecting the consumer to provide the
`datavis` package — exactly as the upstream monorepo does via `"datavis": "file:./packages/datavis"`.
`datavis-ace` (the runtime engine) **is** on public npm; the `datavis` UI source is **not**, but the
repo is public. We mirror the monorepo by vendoring the source and aliasing it as a `file:` dep.

## Provenance

- **Source repo:** https://github.com/mieweb/datavis (public)
- **Pinned commit:** `52c27ccc4f2ae0413eabb2845e02b238ee1f7b85` ("Fix various issues with the floating header.", 2026-05-14)
- **Chosen to match:** `@mieweb/ui@0.6.1` (published 2026-05-14), the version this app depends on.
- **What was copied:** the `src/` tree only. Excluded: `src/main.tsx` (standalone demo entry),
  `src/demo/`, `src/testing/`, and all `*.stories.tsx` / `*.test.ts(x)` (need Storybook/Vitest/demo
  tooling and are not part of the library surface).

## How it is wired into the app

1. `frontend/package.json` → `"datavis": "file:./vendor/datavis"` plus the runtime peers
   (`datavis-ace@=4.0.0-PRE.2`, `@dnd-kit/*`, `i18next`, `react-i18next`, `lucide-react`).
2. `frontend/next.config.ts` → `transpilePackages: ["datavis", "@mieweb/ui"]` so Next transpiles
   the raw `.ts/.tsx` and resolves the extensionless deep imports.
3. `frontend/app/globals.css` → `@source "../vendor/datavis/src"` (Tailwind class generation) and
   the `.wcdv-*` custom classes copied from the upstream `src/index.css`.
4. `frontend/features/datavis/NitroGrid*.tsx` → the single integration seam. Pages import the
   client-only `NitroGridClient` (SSR disabled — the engine touches `window` at module load),
   never `@mieweb/ui/datavis` directly.
5. `Dockerfile` / `infra/frontend.Dockerfile` → copy `vendor/` before `pnpm install` (the `file:`
   dep must exist at install time).

## Local patches (reapply on re-vendor)

These are local accessibility fixes applied on top of the pinned commit. They are latent
upstream bugs that our multi-grid + interactive-cell usage surfaces; reapply (or, better, upstream
them) when re-vendoring. Both live in `src/components/table/useKeyboardNav.ts` (+ its call site in
`PlainTable.tsx`):

1. **Ignore key events from interactive cell content.** `handleKeyDown` returns early when the
   event originates from an `a/button/input/select/textarea/[contenteditable]` descendant, so
   Enter/Space on a focused in-cell link (e.g. the employee/case links on `/runs` Outcomes) follows
   the link instead of activating the row.
2. **Scope scroll-into-view to the focused grid.** `useKeyboardNav` takes an optional
   `containerRef`; `scrollActiveRowIntoView` queries within it instead of `document`, so pages with
   multiple grids (e.g. `/admin` ×3, each numbering rows from 0) scroll the right grid's row.
   `PlainTable.tsx` passes its `tableRef`.

## Upgrading

When bumping `@mieweb/ui`, re-vendor `datavis` from the commit matching the new release:

1. Find the `@mieweb/ui` publish date: `npm view @mieweb/ui@<version> time`.
2. Pick the `datavis` commit at/just before that date.
3. Replace `src/` here with that commit's `src/` (keep the same exclusions), update the pinned
   commit above, **reapply the Local patches above** (unless upstream has fixed them), and re-run
   `pnpm install`, lint, build, and the NITRO render check.

> The deep import paths inside `@mieweb/ui/dist/datavis.js` (e.g. `datavis/src/components/DataGrid`)
> must still exist in the re-vendored source — that is the contract to verify on every upgrade.
> The long-term fix is for MIE to publish a built `@mieweb/datavis` to npm, which would let us drop
> this directory entirely.

## License

See `LICENSE` (copied from upstream). This is MIE source code, used under its terms.
