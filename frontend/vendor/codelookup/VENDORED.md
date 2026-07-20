# Vendored: @mieweb/ui CodeLookup (Codify search)

**Source:** `github.com/mieweb/ui` `src/components/CodeLookup/` @ commit
`4aa24e32619aba2ca7a135a09d1b69498f439999` (main as of 2026-07-20) — the pinned SHA makes the
snapshot reproducible and lets a re-vendorer diff upstream changes against WorkWell's marked
`WORKWELL EDIT` deltas.
**Why vendored (the ADR-007 datavis precedent):** upstream deliberately does NOT ship this
component in the npm package — its `index.ts` notes the module worker
(`new Worker(new URL('./codify.worker.ts', import.meta.url))`) "needs bundler support that the
tsup library build doesn't have configured. Storybook (Vite) handles it natively." Next.js
bundles module workers natively too, so **consumer-side bundling is the designed consumption
path** until upstream ships it (the standing ask on issue #310: publish a stable release with
the Healthcare components — when that lands, this directory is deleted and imports flip to
`@mieweb/ui`).

**Local modifications (kept minimal, all in-file-marked):**
- `CodeLookup.tsx` imports: `../../utils/cn` → `@mieweb/ui/utils`; `../Card/Card` →
  `@mieweb/ui`; `../Icons` → `./icons` (a lucide-react re-export shim identical to upstream's).
- `icons.ts` + this file are local additions. Everything else is byte-identical upstream source
  (`CodeLookup.tsx` marker edits aside): `engine.ts`, `codify.worker.ts`, `context.tsx`,
  `index.ts`, `engine.test.ts`, `README.md`.

**Runtime data:** the shard index is MIE's own hosted Codify build —
`https://ui.mieweb.org/codify` (`{indexUrl}/{locale}/manifest.json`, CORS `*`, verified
2026-07-20). Override via `NEXT_PUBLIC_CODIFY_INDEX_URL`. Search runs entirely client-side in a
Web Worker over fetched shards (OPFS-cached); no WorkWell backend surface is involved and no
PHI ever leaves the browser — the search input is the only "data" and it goes nowhere.
