# Pass 3 — UI/UX Inspection

**Fable Deep Review · 2026-07-02 · WorkWell Measure Studio**

Method: live Playwright walk of all 16 dashboard surfaces as admin at 1440×900, re-walk of 5 key surfaces at 390×844 (mobile), dark-mode + brand-switcher pass, 49 annotated screenshots in `screenshots/`; direct screenshot review by the coordinating reviewer; code-level accessibility verification (chart tables, ARIA patterns) from Pass 1. Cross-referenced against the WCAG work already shipped (PR #210 semantics pass, PR #218 chart data tables).

**Hygiene baseline (live):** fresh loads of /programs and /compliance produced **0 console errors, 0 console warnings, and 0 failed network requests** (~55 API calls, all 200) — rare at this product stage. Mobile: **no horizontal body scroll on any of the 5 surfaces tested** (documentElement.scrollWidth == 390; wide tables scroll inside their own containers); no overlapping elements; no sub-32px tap targets found in main content. The 6-brand runtime brand switcher (Enterprise Health / MIE Web / BlueHive / WebChart / Ozwell / WaggleLine) rethemes instantly with no reload and no console errors (`49-brand-mieweb-programs.png`). The admin Outreach Delivery Log is populated with the simulated sends (the #181 M3 fix verified live).

**Overall design verdict:** the app reads as a **credible, coherent enterprise product**, not a prototype. The `@mieweb/ui` system is applied consistently — clean typographic hierarchy (small-caps section labels, restrained weights), disciplined spacing, one accent family (plum/magenta), status-chip vocabulary reused identically across roster/cases/programs, and a dark theme that is 95% correct. The UX debt is concentrated in (a) role-fit (surfaces showing controls that 403 — filed as H9/H10/M25 in Pass 1), (b) a handful of unfinished corners (/worklist, native file input), and (c) data-density ergonomics at enterprise scale (walls of repeated chips, unlinked UUIDs). Nothing requires a redesign; the high-value work is targeted polish.

---

## Graded findings

### High

**UX-1 [H] Roster floats the fake "Demo" personas to the top of every panel — REGRESSED (intent of #219/#220)**
`06-compliance-roster.png`; live API confirms rows 1–4 = Demo Author/Approver/Case Manager/Admin. The sink heuristic (`roster-read-model.ts:165`) demotes only subjects with *no* data in the panel; since the All-Employees segment now gives every persona a Compliant Adult-Immunization cell, they never sink. First impression of the flagship roster is four fake users. **Fix:** demote by an explicit demo-persona marker (or `emp-001..004` role names), not by has-data.

**UX-2 [H] The `/worklist` page is an unfinished interstitial with an unreadable heading**
`39-worklist.png`. The hero banner's title renders dark-gray-on-black (WCAG 1.4.3 failure — effectively invisible), and the page's only content is prose telling the user to go to `/cases` plus two link cards. A first-class nav item (badged "50") should not lead to a signpost. **Fix:** make Worklist a filtered view of `/cases` (or drop the nav item); fix the banner text token.

**UX-3 [H] Long-running-page latency without progressive feedback at 120k scale**
`/programs/hierarchy` ~5–7s and `/compliance` first-hit ~12s (measured, Pass 2 §5) render skeletons but no progress/explanation; on the roster the panel switch re-pays the full cost. Users will read this as "broken" at enterprise demo scale. Backend fixes are H5/M16; frontend should add optimistic panel caching and a "crunching 1.68M outcomes" hint if any wait >3s remains.

### Medium

**UX-4 [M] Immunizations roster panel is a wall of "Not Applicable" chips for non-clinical staff**
`06-compliance-roster.png`, `41-mobile-compliance.png`. Correct per segment rules (immunization panel applies to Clinical Staff), but 4 of 5 columns × most rows render identical gray chips + identical two-line explanations — the signal (the one Compliant cell) drowns. **Fix:** de-emphasize NA cells to a single dim dash/dot with tooltip; or default the panel filter to the applicable cohort.

**UX-5 [M] Segment editor modal has internal horizontal overflow — fields and measure labels clipped**
`37-admin-groups-segment-editor-modal.png`. Description input and the right checkbox column are cut at the modal edge with an inner horizontal scrollbar; measure names truncate ("Adult Immunization Status (Td/Tda…"). Combined with the no-dirty-check close (M26) this is the weakest form in the app. **Fix:** widen the modal / two-column grid that wraps, `overflow-x` never on a form.

**UX-6 [M] Raw UUIDs presented as primary content**
Case detail shows "LAST RUN d314bc1c-9f71-40fe-a543-…" as plain text (`11-case-detail-top.png`); the case header shows the full case UUID. Neither is a link. Operators can't do anything with a UUID except lose confidence. **Fix:** render as "Run · Jul 2, 2026 (ALL_PROGRAMS)" linking to `/runs?runId=…`; move raw ids behind a copy icon.

**UX-7 [M] Evidence upload is a bare native file input + demo residue visible to all**
`11-case-detail-top.png`: unstyled "Choose File / No file chosen" control inside an otherwise polished card, and a leftover `ev.tmp.txt · 0 KB` QA upload from June is shown on a live case. Also worth surfacing in-UI that evidence storage is currently ephemeral (documented deploy limitation) — operators would otherwise trust it. **Fix:** styled dropzone component; clean the stray test file; an "evidence storage is temporary on this demo" note.

**UX-8 [M] Trend charts flat-line with "↑ 0% from last run" on several program cards**
`01-programs-desktop.png`, `45-dark-programs.png`. The per-card trend now draws from live run history whose daily scheduled runs barely move (78.0% flat), so the hero visualization communicates nothing and "↑ 0%" reads as a bug. The snapshot-backed Quality-over-time card (E16) solved this properly on the measure page. **Fix:** rewire card trends to `quality_snapshots` months (the E16 deviation note already anticipated this), or show a sparkline over months, not runs.

**UX-9 [M] Scale-tenant providers are named like clinics — "Clinic 1-1 · PROVIDER"**
`03-hierarchy-mhn-expanded.png`. In the mhn subtree the provider level is labeled "Clinic 1-1…Clinic 1-10" with a PROVIDER badge — two contradictory nouns on one row; demo viewers will read the hierarchy as broken. **Fix:** name synthetic scale providers like people ("Dr. Provider 1-1") in `scale-structure.ts`.

**UX-10 [M] Dark mode: white chart tooltips (live-confirmed) and hero-banner tokens**
`46-dark-programs-tooltip-white-bug.png` — hovering a trend point pops a bright-white tooltip with light border over the dark card (L19). Same hardcoded `contentStyle` in all four charts. The /worklist banner (UX-2) is the same token problem in reverse. Everything else in dark mode passed inspection (`45`, `47`, `48`).

**UX-18 [M] /runs Trigger filter has no "Scheduled" option — the most common run type can't be isolated or excluded**
`31-runs-detail-summary.png`. Options are All/Manual/Seed only, yet SCHEDULED runs (E13 PR-3) now dominate the history and display a "Scheduled" badge the filter can't select. Same class as the #181 filter fixes. **Fix:** add Scheduled (and arguably Queued/Cancelled to the Status filter).

**UX-19 [M] Merely viewing a run detail auto-fires a billed OpenAI run-insight call**
`38-admin-audit.png` — the audit ledger shows `AI_RUN_INSIGHT_GENERATED` (gpt-5.4-nano, fallbackUsed:false) timestamped at the exact moments the walk-through rendered two run details. A read-only page view triggering a paid AI call per selected run is a cost/perf smell (the sprint plan's own rule was a hard AI-spend cap; explain-why-flagged is cached — run insight showed no caching evidence for repeat views). **Fix:** load insight on demand (a button), or cache per (runId) like the case explanation.

### Low

- **UX-20 [L]** `seed:scale` runs show Duration "-" in the run list — cosmetic, reads as missing data next to real runs (`31`).
- **UX-21 [L]** Admin "Outreach" tab bundles Waivers + Templates + Delivery Log; waivers arguably belong under Governance. Minor IA nit (`35`).
- **UX-11 [L]** Mobile is genuinely usable (filters stack, tables scroll in-container — `40`–`44`) but the roster's sticky employee column + 5 measure columns leaves ~1.5 columns visible per screen; a per-employee card layout would serve phones better.
- **UX-12 [L]** KPI numbers are unformatted: "1682100" (`01`). Use locale grouping ("1,682,100") everywhere counts render.
- **UX-13 [L]** Global header selectors ("All Sites", "All time", brand) sit next to page-level System/Segment selectors with overlapping scopes; it is not discoverable which filter governs which surface. Consider one filter bar per page that includes site/time.
- **UX-14 [L]** `NOT SENT` outreach-delivery chip renders identical in weight to actionable status chips; state chips vs. metadata chips need a visual tier.
- **UX-15 [L]** The Studio "Change summary (required)" input + "New Version" button live in the page header far from the tab content (`28-studio-cms122-standards.png`); authors won't associate them. Group version actions into a menu.
- **UX-16 [L]** Access-denied treatments are inconsistent: purpose-built card on /campaigns and /orders, raw error string + skeleton on /people (L21), silent empty states elsewhere (H9). One `<AccessDenied>` component, used everywhere.
- **UX-17 [L]** The employee search in the top bar and GlobalSearch race/reopen issue (M20) shows results for a cleared query — feels haunted when it happens.

---

## Accessibility (systemic section)

**What is genuinely done (verified in code + shipped PRs):** all four Recharts charts are `aria-hidden` with `accessibilityLayer={false}` and paired sr-only captioned `ChartDataTable`s (PR #218 — verified at the JSX level in Pass 1); tables use `scope="col"`; run rows use real first-cell buttons preserving table semantics; Studio tabs implement the ARIA tab pattern with roving tabIndex; run status + AI responses announce via `aria-live` (PR #210). This is far better than typical for this product stage.

**What remains open (STILL-OPEN — the "systemic accessibility debt" from the 06-20 QA):**
1. **Contrast failures:** the /worklist hero heading (UX-2) is a hard WCAG 1.4.3 failure; small-caps section labels (`text-slate-400`-class grays on white) and the dim "no matching group" explanation text sit near the 4.5:1 boundary and should be audited token-by-token.
2. **Keyboard-flow hazards:** the ARIA tab pattern's automatic activation + unmount-on-switch destroys form state (H11) — an accessibility *and* data-loss issue; recommend manual activation. Modal focus-trap/return-focus behavior in the segment editor and campaign confirm was not verifiable this pass and needs a dedicated keyboard walk.
3. **Status communicated by color alone:** roster/case chips pair color+text (good), but chart series and the BY REASON bars rely on color; the sr-only tables mitigate for AT but low-vision sighted users get no pattern/shape redundancy (WCAG 1.4.1 borderline).
4. **Focus visibility** on the dense NITRO grids and roster cells was not systematically verified — schedule a focus-ring sweep.
5. **No skip-to-content link** observed in the shell; with a 12-item nav this taxes keyboard users on every page.
6. **Reduced-motion**: no `prefers-reduced-motion` handling found for chart animations/transitions.

A full WCAG 2.2 AA audit (screen-reader run-through with NVDA + keyboard-only walk of the five core flows) remains the right next step and is still the project's largest UX debt item — unchanged from the 06-20 assessment, though the chart/table/ARIA foundations shipped since have removed the worst of it.

## Concrete upgrade proposals (current → proposed → why)

**Quick wins (hours each):**
1. Number formatting (`1682100` → `1,682,100`) — instant credibility on every KPI.
2. Theme-aware chart tooltips + /worklist banner tokens — closes the two visible dark/contrast bugs.
3. Demo-persona demotion in the roster (UX-1) — the flagship grid leads with real people.
4. Link run/case UUIDs to their surfaces; copy-icon the raw ids.
5. NA-cell de-emphasis on the roster (UX-4) — turns a gray wall into a readable grid.
6. Rename scale providers (UX-9).

**Medium (a day or two each):**
7. Replace /worklist with a real filtered-cases view (or remove the nav item); it currently spends a top-level nav slot on a signpost.
8. Styled evidence dropzone + upload progress + "temporary storage" notice.
9. One `<AccessDenied>` + one `<EmptyState>` component adopted across all surfaces (kills H9's lying empty-state class too).
10. Program-card trends onto `quality_snapshots` (UX-8) — makes the landing page's hero visualization tell the E16 story ("source of truth for quality over time") instead of a flat line.
11. Roster mobile card layout (UX-11).

**Larger (worth a design pass):**
12. **Filter architecture**: unify header vs page filters into a single per-surface filter bar with visible active-filter chips ("System: All · Panel: Immunizations · 150 employees") — the single biggest IA clarity win.
13. **Operator home**: /programs is an analyst view; case managers land there too. A role-aware home (CM → triage queue with aging buckets; AUTHOR → drafts + compile status) would make each persona's first screen actionable.
14. **Density system**: the roster/hierarchy/orders tables would benefit from a compact-density toggle + column pinning (the vendored NITRO grid already supports much of this on /measures//runs — extend it to the roster).

## What already reads as impressive (keep and showcase)

The Standards fidelity tab (`28` — official-vs-authored criterion table with honest OMITTED/SIMPLIFIED calls) is the most differentiated screen in the product and demos the whole "transparent, standards-native" thesis; the Quality-over-time card with scope selector + numerator/denominator KPI; the 120k hierarchy drill-down reconciling in front of you; the compliance-history simulate scrubber; and a dark theme that (tooltips aside) is production-grade. These are the screens to lead demos with.
