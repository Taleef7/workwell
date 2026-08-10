# Landing Page Simplification — Design Spec

Date: 2026-05-20
Owner: Taleef
Branch: `feat/ui-responsive-polish` (continuing) or new `feat/landing-simplify`
Scope: `frontend/app/page.tsx` only

## 1) Problem

The current `/` landing page is overcrowded:

- Every primary action repeats 3–5 times across header, hero CTA row, sandbox preview card, walkthrough section, and footer.
- Four distinct visual blocks (hero + sandbox preview card + 4 feature cards + walkthrough+video pair) compete for attention.
- Visual treatment (radial gradients, grid pattern, backdrop-blur on every surface, rotated stacked card) diverges from the calm, flat dashboard the page is selling.

The page should sell one action — **Open sandbox** — and otherwise get out of the way.

## 2) Goals

1. Each CTA appears at most once on the landing page (header counts as the navigation surface, not a CTA).
2. Page fits in one viewport on a 1080p laptop without scrolling.
3. Visual language reads as the same product as the dashboard: flat `bg-slate-50`, `border-slate-200` hairlines, `bg-slate-900` primary, no radial gradients, no backdrop blur, no grid overlay.
4. JSX shrinks materially — target ~90 lines, down from ~378.

Non-goals: changing copy voice, changing the Fraunces serif for the H1 (kept for parity with `/login`), changing `/sandbox` or `/login` routes.

## 3) Final structure

```
<main bg-slate-50>
  <header>
    [WW] WorkWell Measure Studio            Walkthrough   GitHub
  </header>

  <section hero>
    eyebrow:  PUBLIC SANDBOX · NO LOGIN REQUIRED
    h1:       A clean operating surface for occupational-health compliance.
    subhead:  Four measures, complete case management, and a full audit trail —
              one reviewable dashboard.

    [ Open sandbox → ]   Sign in →

    quiet link: Watch the 5-min walkthrough →

    hairline divider

    capability strip (text only, separated by middots):
      Programs & outcomes · Case worklist · CQL Measure Studio · Audit trail & exports
  </section>

  <footer>
    © WorkWell Measure Studio — compliance operations for occupational health.
  </footer>
</main>
```

No sandbox preview card. No feature card grid. No walkthrough section. No stats strip. No operating-notes pills.

## 4) Visual rules (aligned to dashboard layout)

- Page background: `bg-slate-50` (matches dashboard shell). No radial gradients, no grid pattern, no decorative blobs.
- Containers: `mx-auto max-w-5xl px-6` — landing is narrower than the 7xl it currently uses; the page is for reading, not laying out cards.
- No `backdrop-blur` anywhere on this page.
- Borders: `border-slate-200` only; no white-over-glass surfaces.
- Primary button: `rounded-xl bg-slate-900 text-white px-5 py-2.5 text-sm font-semibold hover:bg-slate-800`. Matches the active nav style in the dashboard sidebar (`bg-slate-900 text-white`).
- Secondary button: text-only link with chevron — `text-slate-700 hover:text-slate-950`. No pill, no border. (Reduces visual chrome and the sense of "lots of buttons".)
- Walkthrough link under CTAs: very quiet — `text-sm text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline`. No icon, no pill.
- Capability strip: single line, `text-sm text-slate-500`, items joined by ` · `. Wraps gracefully on narrow viewports (use flex-wrap with `gap-x-3 gap-y-1`).
- Header: minimal — logo block (same logo treatment as dashboard sidebar header), then two right-aligned **text** links: `Walkthrough` and `GitHub`. No buttons in the header at all.
- Footer: single line, `text-xs text-slate-500`, no link cluster (links live in the header).
- Typography: keep `Fraunces` for the H1 only. Subhead, eyebrow, links, and capability strip use the default sans.

## 5) Copy

| Slot | Text |
|---|---|
| Eyebrow | `Public sandbox · No login required` |
| H1 | `A clean operating surface for occupational-health compliance.` |
| Subhead | `Four measures, complete case management, and a full audit trail — one reviewable dashboard.` |
| Primary CTA | `Open sandbox` (chevron right) → `/sandbox` |
| Secondary CTA | `Sign in` (chevron right) → `/login` |
| Walkthrough | `Watch the 5-min walkthrough →` → YouTube URL, `target="_blank" rel="noopener noreferrer"` |
| Capability strip | `Programs & outcomes · Case worklist · CQL Measure Studio · Audit trail & exports` |
| Footer | `© WorkWell Measure Studio — compliance operations for occupational health.` |
| Header `Walkthrough` | text link to YouTube URL, new tab |
| Header `GitHub` | text link to repo URL, new tab |

## 6) Accessibility

- H1 remains the only `<h1>` on the page.
- All external links carry `rel="noopener noreferrer"` and `target="_blank"`.
- Header `Walkthrough` link has an accessible name including "video" (e.g., `aria-label="Watch product walkthrough video"`).
- Focus rings: `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2`.
- Color contrast: all body text ≥ slate-500 on slate-50 (≥ 4.5:1).
- No motion beyond simple `transition-colors`; no `hover:-translate-y-*`.

## 7) Responsive behavior

- ≥ `lg` (1024px+): single column, headline ~`text-6xl`, fits in one viewport.
- `sm`–`md`: headline `text-4xl`, capability strip wraps to 2 rows.
- `< sm`: header collapses to logo + 2 text links (no icons needed since text is already short).

## 8) Out of scope

- No changes to `/sandbox`, `/login`, dashboard layout, or any non-`page.tsx` file.
- No new shadcn components added — page uses raw Tailwind to stay tiny.
- No marketing tracking or analytics changes.
- No new lucide-react icons; existing ones are removed where unused.

## 9) Acceptance criteria

1. `frontend/app/page.tsx` line count ≤ 130.
2. Page contains exactly **one** `<Link href="/sandbox">`, **one** `<Link href="/login">`, **one** GitHub anchor, and **two** YouTube anchors (header nav `Walkthrough` link + inline "Watch the 5-min walkthrough" link under the CTAs, per design Q1 answer). Confirmed by grep / accessibility tree.
3. No `backdrop-blur`, no `radial-gradient`, no grid-pattern background utility on `app/page.tsx`.
4. Fraunces font is imported and applied to the `<h1>` only.
5. `pnpm lint` clean; `pnpm build` succeeds.
6. Visual smoke at 1440×900, 1024×768, 390×844 — no horizontal scrollbars, hero visible without scroll at 1440×900.

## 10) Implementation plan summary

1. Replace `frontend/app/page.tsx` with a slimmer component implementing the structure in §3 with the styles in §4.
2. Remove unused lucide imports (`BadgeCheck`, `Layers3`, `LayoutDashboard`, `LogIn`, `PlayCircle`, `ShieldCheck`, `Sparkles`, `Video` — keep `ArrowRight` and `ExternalLink`).
3. Keep `metadata`, `videoUrl`, `repoUrl`, and the Fraunces font import.
4. Verify with `pnpm lint` and `pnpm build` in `frontend/`.
5. Manual smoke on the three viewports above.
6. Commit on a feature branch, open PR against `main`.
