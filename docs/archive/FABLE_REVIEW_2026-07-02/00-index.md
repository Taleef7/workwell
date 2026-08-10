# Fable Deep Review — WorkWell Measure Studio

**Date:** 2026-07-02 · **Reviewer:** Claude Fable 5 (autonomous multi-pass engagement)
**Target:** live stack `twh.os.mieweb.org` / `twh-api-ts.os.mieweb.org` + full repo at `main` (52a211e)

## Executive verdict

**WorkWell is a genuinely working, well-engineered product whose prototype phase is complete — and this review found zero Critical defects.** The core invariant (ADR-008: CQL `Outcome Status` is the sole compliance authority) held under adversarial hunting across every module. The multi-tenant reconciliation invariant verified **exactly** on live production data (0 mismatches across every hierarchy level and all six outcome buckets at 1,682,100 evaluated). RBAC survived a 102-probe live matrix without a single bypass. All static gates are green (backend 840/840 non-skipped tests, frontend lint/test/build). Console and network hygiene on the live UI is spotless.

The findings that matter cluster into four themes, all fixable without architectural change:
1. **The audit ledger is incomplete exactly where volume is highest** — the population run pipeline writes no run/case audit events (H1) and silently clobbers operator case state (H2). For a product whose pitch is *"every determination auditable,"* this is the top priority.
2. **The read path doesn't yet scale to the 120k tenant the write path proudly supports** — missing indexes and unbounded queries produce live 5–12s hot pages and 23–43s artifact endpoints one cold cache from the 60s gateway timeout (H4/H5/M16/M17).
3. **Latent compliance-correctness bugs on the future real-data path** — two measures match *any* Condition (H3), and the rule-builder accepts silently-wrong numeric params (M19). Harmless on synthetic data; wrong answers the day WebChart data arrives. Fix before E12 PR-2.
4. **Role-fit gaps on two frontend surfaces** — case detail and Studio show write controls that guaranteed-403 for read roles (H9/H10), the class PR #181 fixed elsewhere.

Strategically (Pass 4): **the project has run out of high-value synthetic work.** ~90% of the E1–E16 roadmap is live and verified; every remaining integration has a built, inert seam waiting on Doug/MIE (WebChart schema, VSAC key, Q2 data-path decision, R2 bucket, ICE, DataChaser). The recommended path is one 2–3-week hardening sprint (the four themes above) in parallel with pressing the five external asks.

## Scorecard

| Dimension | Grade | Basis |
|---|---|---|
| Correctness | **B+** | No Criticals; invariants verified live; but unaudited run pipeline (H1), case-state clobber (H2), 2 wrong CQL defines (H3), RUNNING-run leak (H7), UNLINK shatter (H8) |
| Security | **A−** | 102-probe RBAC matrix clean; VIEWER + PII gates hold live; server-derived actors; safe CORS/JWT fundamentals. Deductions: lifecycle-gate bypasses (M2/M3), non-revoking refresh rotation (M5), spoofable triggeredBy (M1), shared demo password (L3) |
| Functional completeness | **A** | Every advertised surface works with real data end-to-end (32-story matrix, §Pass 2); scheduler firing live; standards artifacts reconcile; 13 months of real quality history |
| UX / design | **B+** | Coherent, credible enterprise design system, clean IA, instant 6-brand theming; deductions for role-fit 403 surfaces, /worklist stub, demo-persona float, density ergonomics |
| Accessibility | **B−** | Chart data tables + ARIA tabs + aria-live genuinely shipped; but hard contrast failure (/worklist), keyboard data-loss hazard (H11), no systemic WCAG 2.2 audit yet — still the largest UX debt |
| Performance | **C+** | Most reads sub-second and the #219 P0 fix holds; but 5–12s hot pages every hit, 23–43s unbounded artifact paths, ever-growing scans (H4/H5/M16/M17) |
| Code quality | **A−** | 840 tests, disciplined ports/adapters + floor/ceiling parity, pure read models, atomic case-action dual-writes; deductions: non-atomic sweeps/multi-writes, unbounded store methods, missing contract coverage on event stores |
| Strategic readiness | **B+** | Prototype claims proven; deployment posture solid (self-heal, blue-green history); gated on ~5 external unlocks + 1 hardening sprint (Pass 4 staged plan) |

## Findings rollup

| Severity | Pass 1 (code) | Pass 3 (UX) | Total |
|---|---|---|---|
| **Critical** | 0 | 0 | **0** |
| **High** | 11 (H1–H11) | 3 (UX-1–UX-3) | **14** |
| **Medium** | 26 (M1–M26) | 9 (UX-4–UX-10, UX-18, UX-19) | **35** |
| **Low** | 25 (L1–L25) | 9 (UX-11–UX-17, UX-20, UX-21) | **34** |
| **Total** | 62 | 21 | **83** |

Reconciliation against prior audits (`docs/JOURNAL.md`, `QA_SMOKE_TEST_2026-06-20.md`, PR #181): **1 REGRESSED** (UX-1 — roster demo-persona demotion no longer effective), **4 STILL-OPEN** (H9/H10 as remnants of the #181 M2 class; L3 demo-password posture; the systemic WCAG audit), everything else **NEW** — this review reached code paths and scale conditions prior audits did not. No previously-closed item was found re-reported as open.

## Top 10 actions (if only ten things get fixed)

1. **H1** — emit run + case audit events from the population pipeline (the hard-rule violation).
2. **H2** — state-aware case upsert (stop clobbering IN_PROGRESS / manual closures).
3. **H4 + H5 + M17** — bound the four 120k endpoints; add the three owner-gated index sets.
4. **H3** — fix HAZWOPER/TB Condition scoping + foreign-bundle golden tests (pre-E12).
5. **H6** — one-line `pool.on("error")` (prevents whole-worker crashes).
6. **H9/H10** — role-gate case detail + Studio write controls.
7. **H7** — completed-run filter in the hierarchy rollup.
8. **H8 + M13** — identity clique edges + ACTIVE-tenant duplicate predicate (pre-E15 PR-3).
9. **M16** — push latest-run filtering into SQL (stops the invisible month-over-month slowdown).
10. **M24 + M21** — single-flight token refresh + orphaned-run poll release (the two "app randomly misbehaves" frontend bugs).

## Reports

- [01 — Code & Bug Review](01-code-bug-review.md) — 62 findings (11 H / 26 M / 25 L) + 11 verified-solid areas
- [02 — Functional & Acceptance Verification](02-functional-acceptance.md) — 32-story matrix, 102-probe RBAC table, per-surface acceptance, live latency data
- [03 — UI/UX Inspection](03-ui-ux-inspection.md) — 21 findings, systemic accessibility section, prioritized upgrade list, 49 screenshots (`screenshots/`)
- [04 — Strategy & Roadmap](04-strategy-roadmap.md) — goal-state analysis, build-gaps vs externally-blocked split, staged Stage 0–4 plan, prioritized asks for Doug

## Method

Six parallel code-review agents (auth/RBAC, run+case+audit, stores, read models/identity/quality, engine/CQL/AI/MCP, frontend) with every High independently re-verified in source by the coordinating reviewer; live login as all 5 roles; 102-probe RBAC matrix + 11 write-gate probes + adversarial-input probes; timed latency measurement; full-tree reconciliation and MeasureReport population checks on production data; reversible-only writes (campaign dry-run, AI explain); a two-session Playwright walk (49 screenshots: 16 desktop surfaces, 5 mobile, dark mode, brand switcher, console/network capture); a local SQLite-floor boot; and full static gates. Shared-demo discipline held: no destructive ops, no schema changes, no real sends, no reconcile writes; the only mutations were the app's own audit events (AI explain/insight) and this review's report files.

## Open questions / asks for the human

1. **Owner-gated DDL sign-off** — H5/M17 need three `CREATE INDEX IF NOT EXISTS` sets (schema is owner-only per CLAUDE.md). Want a prepared PR?
2. **Product decision on H2** — should a nightly run be allowed to reopen a manually-closed case at all? The fix differs by answer.
3. **L3** — keep the shared `Workwell123!` password on write-capable roles of a publicly-linked sandbox?
4. **UX-19** — was auto-firing the run-insight AI call per run view intentional (vs. on-demand)?
5. The five external asks (WebChart schema, VSAC key, Q2 decision, R2 bucket, ICE/DataChaser access) are consolidated and prioritized in Pass 4 §5 — ready to take to Doug as-is.
