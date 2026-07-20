# Codify / CodeLookup integration status

**Date:** 2026-07-20 (updated same-day: **IMPLEMENTED**) · **Context:** Doug directive 3
(2026-07-19 call): "your system should be using that Codify… it takes terms and turns them into
codes." Tracking issue: #310.

## Status: LIVE in Studio (vendored per the ADR-007 precedent — the designed consumption path)

The **Studio → Value Sets tab** now carries a "Find a code (Codify)" search
(`frontend/features/studio/components/CodifyCodeSearch.tsx` wrapping the vendored component in
`frontend/vendor/codelookup/` — provenance + local-edit markers in `VENDORED.md` there). Search
runs entirely client-side in a Web Worker over MIE's own hosted shard index
(`https://ui.mieweb.org/codify`, `Access-Control-Allow-Origin: *`, verified 2026-07-20; override
via `NEXT_PUBLIC_CODIFY_INDEX_URL`). Picking a result prefills the value-set form (author reviews
before saving — Codify assists authoring, never writes).

**Browser-verified 2026-07-20** on `/studio/cms125` → Value Sets: index loads ("Offline index
ready"), searching **"breast cancer screening"** returns **"Breast cancer screening (mammography)
— eCQM CMS125"** in ~39 ms (the `quality` domain maps Doug's exact transcript phrase to the very
measure we run), and selection prefills OID `CMS.125` + the name.

## Why vendored (not an npm import)

- Stable `@mieweb/ui@0.6.1` does not ship the component; dev prereleases ship only the
  **injection seam** (`CodeLookupProvider` with a `component` prop). Upstream's own
  `src/components/CodeLookup/index.ts` documents why: the module worker
  (`new Worker(new URL('./codify.worker.ts', import.meta.url))`) "needs bundler support that the
  tsup library build doesn't have configured. Storybook (Vite) handles it natively." Next.js
  bundles module workers natively too — **consumer-side bundling is the designed path.**
- No new dependencies: Card/`cn` come from stable `@mieweb/ui`; the icon shim re-exports from
  `lucide-react` (already a direct dep). ~66 KB of upstream TS vendored byte-faithful, edits
  marked `// VENDORED EDIT`; upstream `engine.test.ts` runs in our vitest suite.

## Standing upstream asks (issue #310 — unchanged, now lower-pressure)

1. Publish a stable `@mieweb/ui` release with the Healthcare components (when the barrel exports
   `CodeLookup`, delete `frontend/vendor/codelookup/` and flip the import — the `datavis`
   playbook).
2. Confirm `https://ui.mieweb.org/codify` as a supported index host (or the canonical URL), and
   whether an Enterprise Health `programs.json` protocol sidecar exists (employer-specific
   required orders/periodicity — squarely WorkWell's territory).

## Follow-ups (filed under #310)

- Admin → terminology-mappings form: same component for the standard-code half of a mapping.
- `preferDomains: ['occupational','quality']` tuning + a drill-down for "measure orders".
- Upstream-contribution candidates to offer `@mieweb/ui`: ChartDataTable (a11y chart tables),
  the ComplianceChip/DeliveryChip chip-tier system, RosterMobileCards, the NitroGrid SSR-safe
  seam, OshaReferenceCombobox.
