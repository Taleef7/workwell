# WCAG 2.2 AA Audit — WorkWell Measure Studio (frontend)

**Date:** 2026-07-03 · **Scope:** full `frontend/` React/Next.js surface (82 tsx files across `app/`, `components/`, `features/`)
**Method:** 5 parallel code-level auditors, one per slice (shell/auth · programs/compliance/runs+charts · operator surfaces · Studio/admin/segments · shared primitives), each applying WCAG 2.2 AA + the [Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines). Every finding is code-evidenced with a `file:line`. This closes the "full WCAG 2.2 AA audit" tracked as the largest remaining UX-debt item in the 2026-07-02 Fable review (`docs/FABLE_REVIEW_2026-07-02/03-ui-ux-inspection.md`, Accessibility §).

> **Live screen-reader run-through (NVDA) + a keyboard-only walk of the 5 core flows are still the recommended final acceptance step** and cannot be done from code alone. This audit is the exhaustive static pass that precedes it; it should catch essentially all of the programmatic (name/role/value, contrast, keyboard-wiring) defects before a human SR pass.

## Headline

**No critical, one High.** The a11y foundation shipped in PRs #210/#218 and the 07-03 quick-wins pass held up well under adversarial reading — several items the Fable review flagged as open are **already fixed in code** (see "Already resolved" below). The remaining debt is **systemic but mechanical**, concentrated in two themes:

1. **Async status/error regions aren't announced** (missing `aria-live`/`role="status"`/`role="alert"`) — ~19 sites, the single dominant gap. Every "silent skeleton", compile result, AI-draft banner, and error `<p>` that a sighted user sees but a screen-reader user does not.
2. **Low-contrast text tokens** (`text-neutral-400`/`text-slate-400` on white ≈ 2.6:1) — ~15 sites, all failing 1.4.3's 4.5:1.

Plus one true keyboard-inaccessibility (the OSHA combobox), a cluster of small ARIA-pattern gaps, three removed focus outlines, sub-24px targets, and decorative icons missing `aria-hidden`.

## Findings by theme

### High
| # | Location | SC | Issue |
|---|----------|----|-------|
| A11Y-H1 | `components/osha-reference-combobox.tsx:119,81` | 2.1.1 / 4.1.2 | Option `<button>`s wire only `onMouseDown` (never fires on keyboard Enter/Space) and the input's `onBlur` closes the list on tab-out — **keyboard users cannot reach or select any option**. Not a real ARIA combobox (no `role=combobox`/`aria-expanded`/`listbox`/`option`). Used in Studio Spec authoring. |

### Medium — async regions not announced (4.1.3)
`GlobalSearch.tsx:108` (results) · `sandbox/page.tsx:98` (error/loading) · `compliance/page.tsx:262` (roster load) · `programs/hierarchy:193` (load) · `programs/page.tsx:242,205` (skeleton + run-in-progress) · `programs/[measureId]:489` (load) · `runs/page.tsx:768` (error → `role=alert`), `:882` (AI insight) · `campaigns/page.tsx:411` (result summary) · `cases/page.tsx:580` (error) · `cases/[id]:484` (error) · `people/page.tsx:128` (error) · `admin/page.tsx:684` (error) · `studio/[id]:184` (shared error) · `CqlTab.tsx:324,332,200` (compile results + draft banner) · `SpecTab.tsx:102` (draft banner) · `ElmExplorer.tsx:230` (compile status) · `TestsTab.tsx:208,151` · `SegmentEditorModal.tsx:383` (match count) · `copyable-id.tsx:58` ("Copied")

### Medium — text contrast (1.4.3 / 1.4.11)
`text-neutral-400`/`text-slate-400`/`text-slate-600`-on-light below 4.5:1, and a few dark-mode-variant gaps:
`GlobalSearch:121,137` · `login:251,265` · `sandbox:130,139` · `layout:238` (logout glyph, 1.4.11) · `programs:291,341,409` · `[measureId]:220,356,360,365,398,669` · `employees:59,134,146,187,192` · `orders:252` · `cases/[id]:484` (red-700 no `dark:`), `:926` (amber-800 no `dark:`) · `RuleBuilderTab:274,347` · `StandardsTab:174,180,218,219,226` · `DataReadinessPanel:132,150` · `SlaChip:19` (yellow-600 ≈ 3.4:1) · `ComplianceSummaryBar:24` · `runs:883,890` (blue callout no `dark:`, cosmetic)

### Medium — ARIA-pattern gaps
`admin/page.tsx:686` incomplete tab pattern (no `aria-controls`/tab `id`/`tabpanel`/roving tabIndex/arrow nav) · `SegmentEditorModal.tsx:335` employee search not a combobox · `IndividualComplianceStatus.tsx:181` expander missing `aria-expanded`/`aria-controls` · `campaigns/page.tsx:489` `<tr role="button">` overrides row/cell semantics · `orders/page.tsx:245` suppressed table has no `<thead>`/`<th scope="col">`

### Medium — focus indicators removed (2.4.7)
`GlobalSearch.tsx:104` · `ElmExplorer.tsx:256` (textarea) · `osha-reference-combobox.tsx:72` — all `outline-none` with only a weak color-only `focus:border-*` replacement.

### Low — target size < 24px (2.5.8)
`copyable-id.tsx:55` · `programs/hierarchy:242` (caret 20px) · `people/[personId]:241,298` · `CqlTab.tsx:204` · `RuleBuilderTab.tsx:262,270`

### Low — decorative icons missing `aria-hidden` (1.1.1)
`GlobalSearch.tsx:85` · systemic decorative lucide icons (`login:173`, `theme-brand-switcher:38`, feature icons) · `runs:843,914` (activity dot)

### Low — misc semantics
`login/page.tsx:102` h1 lives only in the `lg:`-only brand panel → mobile skips h1 (1.3.1/2.4.6) · `cases/[id]:749` orphan `<label>Assignee</label>` (no `htmlFor`) · `admin:928` `<label>` wraps a static `<div>` · `skeleton-loader.tsx:5` no `aria-hidden`/`aria-busy` · `login:214` focus not moved to first error on submit (3.3.1) · `ComplianceChip.tsx:23` NA name via `aria-label` on a non-interactive `<span>` → use an `sr-only` span · `SqlPreviewPanel.tsx:91` `aria-expanded` without `aria-controls` · `people/[personId]` inline actions.

## Already resolved (verified in code this pass — do NOT re-flag)

- **Charts:** all 4 Recharts charts are `aria-hidden` + `accessibilityLayer={false}`, paired with an `sr-only` captioned `ChartDataTable`, and use the **theme-aware** `chartTooltipStyle(theme)` — the dark-mode white-tooltip bug (Fable UX-10/L19) is **not present**.
- **Studio tabs:** full ARIA tab pattern (`tablist`/`tab`/`tabpanel`, `aria-selected`, `aria-controls`, roving tabIndex, Arrow/Home/End) with **manual activation** and a documented rationale — the H11 tab-switch data-loss hazard is **already handled**.
- **Segment editor modal:** has the M26 dirty-check (`window.confirm` on backdrop/Escape/Cancel), `role="alert"` on errors, labelled inputs, and **no internal `overflow-x`** — Fable UX-5 is **not present in code**.
- **Skip link** (`layout.tsx:179`, sr-only→`#main-content`, `<main tabIndex=-1>`), **global `prefers-reduced-motion`** (`globals.css`, `!important` on `*`), **`confirm-dialog.tsx`** (`role=alertdialog`, `aria-modal`, focus trap + return-focus + Escape), **`ChartDataTable`** (real `<table>`/`<caption>`/`scope=col`), and login inputs (`<label htmlFor>` + `autocomplete` + no paste-block) are all correct.
- Status/priority/outcome **chips pair color + text** everywhere (roster, cases, programs, runs) — no info-by-color-alone in chips. The evidence file input **has** `aria-label="Evidence file"` (UX-7's a11y half is mitigated; the styling half remains a UX item).

## Remediation plan (this PR)

Grouped, low-risk, no schema/deps. Ordered by value:
1. **A11Y-H1** — make the OSHA combobox keyboard-operable (real ARIA combobox: `onClick` on options, `relatedTarget`-aware blur, `role`s, arrow/Enter/Escape, focus ring). TDD.
2. **`aria-live` sweep** — add `role="status"`/`aria-live="polite"` to load/result regions and `role="alert"` to async error `<p>`s (a small shared `<StatusRegion>`/`<FormError>` helper keeps it consistent).
3. **Contrast token sweep** — bump `neutral-400`/`slate-400` meaningful text to `-500/-600` (light) and add missing `dark:` variants; `SlaChip` yellow-600→700.
4. **Focus rings** — replace the 3 removed outlines with `focus-visible:ring-2`.
5. **Target sizes** — pad the sub-24px icon/inline buttons.
6. **Decorative `aria-hidden`** + **misc semantics** (orphan labels, mobile h1, expander `aria-expanded`, admin tab pattern, orders/campaigns table semantics, skeleton `aria-hidden`).

Deferred to the follow-on UX-debt pass (design work, not conformance): UX-8 (program-card trends → `quality_snapshots`), UX-7 (styled evidence dropzone), UX-11 (roster mobile cards), UX-3 (progressive-load feedback beyond the `aria-live` announcement added here).
