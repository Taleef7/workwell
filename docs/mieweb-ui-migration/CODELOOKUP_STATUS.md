# Codify / CodeLookup integration status

**Date:** 2026-07-20 · **Context:** Doug directive 3 (2026-07-19 call): "your system should be
using that Codify… it takes terms and turns them into codes." Tracking issue: #310.

## Probe result (2026-07-20)

- **Installed `@mieweb/ui@0.6.1` (stable): CodeLookup is NOT exported.** No healthcare subpath;
  `dist/components/` has no clinical component dirs; `index.d.ts` has no Codify symbols.
- **Dev prerelease `@mieweb/ui@0.6.1-dev.167`: CodeLookup IS exported** (scratch-install verified):
  `CodeLookup`, `CodeLookupProvider`, `useCodeLookupConfig`, `CodifyResult`, plus
  `HealthSurveillance` and `ProblemList`. The Storybook at ui.mieweb.org carries the full
  Healthcare set (CodeLookup, Assessment, AllergyList, ConditionEditor, HealthSurveillance,
  MedicationList, OrderEditor, PresentingProblems, ProblemList).
- **CodeLookup API** (from `index.d.ts`): client-side search over sharded Codify indexes —
  `indexUrl` (serves `{indexUrl}/{locale}/manifest.json` + shards), `domains` /
  `searchDomains` / `preferDomains` over
  `'condition' | 'med' | 'lab' | 'procedure' | 'vaccine' | 'occupational' | 'quality'`,
  a `programsUrl` sidecar for employer-specific protocols (required orders, periodicity),
  and `onSelect(result: CodifyResult)`. The `occupational` + `quality` domains and the
  employer-protocol sidecar are squarely WorkWell's territory.

## Decision (this wave): document + upstream ask, do NOT integrate yet

Two blockers make integration the wrong 3-hour bet before the 2026-07-23 demo:

1. **Release channel.** Wiring CodeLookup requires bumping the whole frontend from stable `0.6.1`
   to a `-dev.*` prerelease — a destabilization risk across every `@mieweb/ui` surface days before
   a demo. (Vendoring per the ADR-007 datavis precedent is the documented fallback, but vendoring
   a component that is *already published in prereleases* is worse than asking for a release.)
2. **Index hosting.** CodeLookup consumes a hosted Codify shard index (`indexUrl`); we don't yet
   know MIE's canonical public/internal index URL (the `mieweb/codify` repo's serving story).

**The ask to Doug/MIE (mirrors the standing `@mieweb/datavis` publish ask):** publish a stable
`@mieweb/ui` release that includes the Healthcare components, and point us at the canonical Codify
`indexUrl` (+ whether an employer `programs.json` sidecar exists for Enterprise Health).

## Integration design (ready to build the day the release lands)

- **Studio → Value Sets tab** (`frontend/features/studio/components/ValueSetsTab.tsx`): a
  CodeLookup box beside the manual OID/name form — search "breast cancer screening" → `onSelect`
  prefills code/system/display for the value-set entry. Domains: `lab, procedure, condition,
  vaccine`; `preferDomains: ['occupational','quality']`.
- **Admin → terminology mappings** (`app/(dashboard)/admin/page.tsx` + `routes/admin.ts`): same
  component for the standard-code half of a local→standard mapping.
- Client-boundary note: import via the existing `client-providers.tsx` pattern (`@mieweb/ui` runs
  `createContext` at module load — client components only).
- No backend `/api/terminology/search` needed for v1 — CodeLookup searches client-side from the
  shard index; the VSAC resolver (ADR-023) remains the authority for value-set *membership*.

## Upstream-contribution candidates (the reusability half of the directive)

Proposed to offer `@mieweb/ui` (generic, EMR-agnostic, already shipped in WorkWell):
`ChartDataTable` (sr-only accessible chart tables, WCAG 1.1.1), the `ComplianceChip`/`DeliveryChip`
chip-tier system, `RosterMobileCards` (responsive table→cards), the `NitroGrid` SSR-safe dynamic
loader seam, `OshaReferenceCombobox` (generic searchable combobox pattern).
