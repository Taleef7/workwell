# WorkWell Measure Studio

[![CI](https://github.com/Taleef7/workwell/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Taleef7/workwell/actions/workflows/ci.yml)
[![Deploy](https://github.com/Taleef7/workwell/actions/workflows/deploy-twh-mieweb.yml/badge.svg?branch=main)](https://github.com/Taleef7/workwell/actions/workflows/deploy-twh-mieweb.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-backend--ts-3178C6?logo=typescript&logoColor=white)](backend-ts/package.json)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](frontend/package.json)
[![Open Issues](https://img.shields.io/github/issues/Taleef7/workwell)](https://github.com/Taleef7/workwell/issues)

WorkWell Measure Studio is a TypeScript + Next.js monorepo for **Total Worker Health (TWH)** compliance operations (backend re-platformed off Java/Spring — #96 / ADR-008; JVM retired in #109 PR4). It combines measure authoring, deterministic CQL evaluation, case management, audit trails, admin tooling, and exportable evidence in one operational platform.

## At a glance

- Lifecycle-managed measures: `Draft -> Approved -> Active -> Deprecated`
- CQL compile + fixture validation gates before activation
- Scoped run pipeline: `ALL_PROGRAMS`, `MEASURE`, `SITE`, `EMPLOYEE`, `CASE`
- Case operations: outreach, assign/escalate, rerun-to-verify, timeline audit
- AI assist for CQL drafting and test fixture generation (never compliance decisions)
- MAT-compatible FHIR R4 export for measure portability
- Risk outlook analytics for upcoming exposure and repeat non-compliance patterns
- Built on MIE's `@mieweb/ui` component library: dark mode + Enterprise Health brand with a runtime brand switcher, plus the DataVis NITRO data grid on the large operational/audit tables

## Status

- **Option A at scale — real batch live-evaluation of the `mhn` (~120k) tenant (`feat/scale-batch-eval`).** The population-scale tenant's outcomes are now produced by **real batch CQL evaluation** (`batchEvaluateScalePopulation`, `backend-ts/src/run/batch-evaluate-scale.ts`) instead of a fabricated compliance distribution — subject-major, bounded-memory, whole-batch resumable, per-subject error-isolated (failure ⇒ MISSING_DATA), audited `SCALE_POPULATION_EVALUATED`. The default generator emits real LOINC/CVX/CPT codes through the WebChart terminology crosswalk, exercising the real adapter at scale. `pnpm seed:scale --mode evaluate` is now the **default** (`--mode fabricated` keeps the legacy instant path one more release; `--trim-evidence` for a large run). The `mhn|Lxx|Pxx|n` `subject_id` encoding + `aggregateScaleRun` (and thus the whole rollup/hierarchy read path) are **unchanged** — only the outcomes' provenance changed. Descriptive only (ADR-008/ADR-020); no schema, no new deps; same rollback SQL. Full suite 1054 pass / 1 pg-skip / 0 fail. See `docs/JOURNAL.md`.
- **E9 (#78) — measure-execution `MeasureExecutor` seam; the CQL→SQL fork decided on our own (ADR-025).** The charter's biggest architectural fork (Doug's Q2) resolved without waiting: measure execution is now pluggable behind one port (`backend-ts/src/engine/measure-executor.ts`) that **extends `EvaluateMeasureBinding`**, so an executor drops into `evaluateBundle`/`evaluateBatch` with no new plumbing. `fhirNativeExecutor` is the **default + correctness oracle** (delegates to the existing CQL→ELM engine — no second evaluation path, parity-tested); `sqlPushdownExecutor` is an **inert stub** (Option B / CQL→SQL is research-grade, not built — constructs but rejects on use, mirroring the inert `webChartDataSource`); `resolveMeasureExecutor(env)` selects config-driven (SQL only on an explicit `WORKWELL_MEASURE_EXECUTOR=sql-pushdown` opt-in, so the deployed default is byte-identical to today). Any future SQL executor must pass **golden parity** vs the FHIR-native oracle, per measure, before it serves. Descriptive only (ADR-008); no schema, no new deps, no engine change. ADR-014 superseded; ADR-017's parked "opt-in second executor" is now the concrete seam. 1017 backend tests (1017 pass / 1 pg-skip). See `docs/JOURNAL.md`.
- **Foreign-data correctness pre-E12 — AI prompt fencing (L14) + out-of-population signal (L17) (PR #250 — merged).** The two Fable "pre-E12" items that become wrong answers / attack surface once real WebChart data flows in. **L14:** `explainCase` no longer interpolates raw evidence JSON into the model prompt — `buildExplainUserPrompt` wraps it in per-request nonce'd `BEGIN/END EVIDENCE JSON` markers labelled untrusted-data-not-instructions and size-caps it (8000 chars), a prompt-injection guard for the day E12 feeds real WebChart-derived strings (AI_GUARDRAILS §2.2). **L17:** an additive `inInitialPopulation?: boolean` on `MeasureOutcome` (read from the CQL "Initial Population" define) distinguishes an out-of-program subject from an enrolled-but-no-data MISSING_DATA on the CLI/ingress path (ARCHITECTURE §7). Descriptive only (ADR-008); no schema, no new deps. See `docs/JOURNAL.md`.
- **WebChart dev-DB evaluation proof — offline (#246; PRs #247/#248 + demo CLI).** Proves the WebChart→FHIR adapter end-to-end on MIE's real seeded WebChart dev DB (`ghcr.io/mieweb/dev-wcdb`, ~56 patients) with **no live API and no MariaDB driver**, while the live HTTP transport (E12 PR-2c) stays deferred behind its `WebChartClient` seam. **PR-1** an OH enrollment roster (`stampEnrollment`) that closes the enrollment gap (WebChart carries no `urn:workwell:vs:*` program-membership Condition); **PR-2** a driver-free dev-only export (`docker exec … mysql`, JSON serialized in Node) → committed WebChart-shaped FHIR fixtures + a deterministic per-patient e2e proof, and the crosswalk firmed to MIE's *actual* codes (LDL LOINC `2089-1`, systolic BP `8480-6`); **PR-3** `pnpm evaluate:webchart-devdb` prints a per-measure outcome table (28 real non-MISSING_DATA outcomes over the whitelist). Descriptive only (ADR-008); no schema, no new deps. See `docs/WEBCHART_FHIR_MAPPING.md` §8.1.
- **Backlog sweep — #233 perf residual + E14 GMI numerator + UX-3/7/13/14/15 (PRs #244 + #245 — merged).** Backend (#244): the latest-population-run-per-measure reduction is pushed into SQL (`listLatestPopulationOutcomes`, ~20k → ~2,100 rows shipped, output byte-identical) and the CMS122 official-subset numerator now takes the most-recent of **HbA1c OR GMI** (LOINC 97506-0), closing Fable L15. Frontend UX (#245): **UX-7** styled evidence dropzone + ephemeral-storage note; **UX-14** passive metadata-chip tier (`DeliveryChip`); **UX-15** Studio version-actions grouped into an accessible disclosure; **UX-3** optimistic panel caching + a ">3s / Crunching ~1.68M outcomes" hint on `/compliance` + `/programs/hierarchy`; **UX-13** "Global" label on the header selectors (the fuller per-page filter-bar refactor deferred as a design call). Descriptive/presentational (ADR-008); no schema, no new deps. See `docs/JOURNAL.md`.
- **E14 PR-3 — real CMS122 execution outcome diff + live VSAC on-ramp (PRs #242 + #243 — merged; ADR-023/ADR-024).** `GET /api/measures/cms122/fidelity/diff` is now a **real, subject-by-subject execution diff**: for each subject in the latest cms122 run it builds → harness-locally VSAC-enriches → evaluates **both** WorkWell's authored `cms122` and an official-**subset** CMS122 measure fresh → diffs, attributing each divergence to the first differing official gate. #242 landed the live VSAC (NLM UMLS) resolver behind the `ValueSetResolver` port (`CompositeValueSetResolver`, key-gated inert-unless-configured; the owner-run `pnpm resolve-valuesets` import CLI). A compile-feasibility spike proved the *literal* multi-library QICore CQL un-compilable under the pinned JVM-free translator, so the deliverable is a faithful official-subset (`measures/cms122_official.cql`); revisit on a stable multi-model translator release (ADR-024). Descriptive only (ADR-008); no schema, no new deps. See `docs/JOURNAL.md`.
- **UX-11 — compliance roster mobile card layout (PR #241 — merged).** On phones (below `md`) the `/compliance` roster renders as per-employee cards (`RosterMobileCards`: name link + tenant · site · role + a `<dl>` of measure → `ComplianceChip`) instead of a wide table that showed ~1.5 columns per screen; the table stays at `md`+. CSS-only responsive (`display:none` keeps the hidden layout out of the a11y tree). Same data/filters/paging; chips verbatim from the read model (ADR-008). No backend, no schema, no new deps. See `docs/JOURNAL.md`.
- **UX-8 — program-card trends onto monthly `quality_snapshots` (PR #240 — merged).** The `/programs` per-card trend flat-lined under the daily scheduled runs; rewired it to the monthly E16 snapshot series (opt-in via `?granularity=month`, so only the card switches while the measure page stays per-run), scoped by the tenant/site filters with a per-run fallback when a scope has <2 months (or a partial-month range). Newest-first, `compliant/total` rate matching the headline. Additive `ProgramTrendPoint.period`; frontend `trendMeta`. No schema, no new endpoint, no new deps. See `docs/JOURNAL.md`.
- **perf(#233) — roster + hierarchy latency ~5–6× faster warm (PRs #238 + #239 — merged).** The shared `listOutcomesWithRun` was seq-scanning all ~1.7M `outcomes` rows to exclude the scale tenant; rewrote it to `run_id = ANY(<live run ids>)` (index scan, 3,242ms → 41ms live) + memoized `aggregateScaleRun` (immutable scale runs). The roster additionally caches its derived cells per immutable run (skips the ~1.3MB `evidence_json` reload), guarded by a `/evaluate`-on-terminal-run 409. Live warm: roster ~1.0s, hierarchy ~1.1s (from 5–13s). No schema, no new deps. See `docs/JOURNAL.md`.
- **WCAG 2.2 AA audit + remediation (PR #237 — merged).** A code-level pass over the whole `frontend/` surface (5 parallel auditors): 0 critical, 1 High, ~40 mechanical. Fixed the High (keyboard-inaccessible OSHA-reference combobox → a real ARIA combobox) plus an `aria-live`/`role=alert` sweep (~19 sites), a contrast-token sweep (~15 sites), focus rings, target sizes, and semantics (admin ARIA tabs, table-row semantics, mobile `<h1>`). No new deps. See `docs/WCAG_AUDIT_2026-07-03.md`.
- **UI/UX Fable pass-3 + a11y (PRs #235 + #236 — merged).** Role-aware papercuts, on-demand (un-billed) AI run-insight, UUID-linking (`CopyableId`), a unified `AccessDenied`, and the a11y semantics groundwork the WCAG pass built on. See `docs/JOURNAL.md`.
- **Fable correctness/security/scale hardening pass (PRs #226–#232 — merged).** The population-run pipeline is now fully audited (`RUN_COMPLETED` + per-case events), case upsert is state-aware (preserves IN_PROGRESS, respects human closures), cycle-rollover closes stale-period cases, bounded run-detail reads at 120k scale, spike-store indexes, UTC-stable evidence dates, and a batch of frontend mediums. See `docs/JOURNAL.md`.
- **E12 PR-2b — WebChart→FHIR adapter core (PR #234 — merged).** The transport-agnostic adapter (`backend-ts/src/engine/ingress/webchart/`): terminology reconciliation (real LOINC/CVX/CPT → the synthetic measure-event codings), bundle normalization, and an injectable `WebChartClient` seam (the HTTP transport is deferred until the MIE API contract). Descriptive only (ADR-008/ADR-017); no schema, no new deps. See `docs/WEBCHART_FHIR_MAPPING.md`.
- **E15 PR-2 + merge-picker — identity reconcile write path (PRs #224 + #225 — merged; E15 complete).** The confirm/unlink half of cross-system identity (ADR-022). The first E15 schema — an owner-approved `person_links` table (floor + ceiling, `workwell_spike`; self-creating DDL) recording human-confirmed CONFIRMED/BROKEN assertions between two source records (pair-normalized; `PersonLinkStore` port). `resolvePeople` is override-aware (union-find). `POST /api/identity/people/:personId/reconcile` — CASE_MANAGER/ADMIN-gated + audited (`IDENTITY_LINK_CONFIRMED`/`IDENTITY_LINK_BROKEN`); frontend adds CM/ADMIN unlink + a CONFIRM_LINK merge-picker. Descriptive only (ADR-008); reversible (`DELETE FROM person_links`; cleared on demo reset). No new deps. See `docs/JOURNAL.md`.
- **E15 PR-1 — cross-system identity (PR #223 — merged).** A pure read-time person-identity layer (`backend-ts/src/identity/`, ADR-022): resolves one person across ≥1 WebChart systems by a deterministic shared-identifier match key (the EMPI seam), surfaces DUPLICATE candidates (same person in >1 system), and builds a merged, system-tagged compliance timeline with a mobility annotation (history follows a person across a move). `GET /api/identity/{people,people/:id,duplicates}` (authenticated read-only) + a new `/people` route (DUPLICATE badge + search + unified person view + mobility banner). Cross-system people are modeled in the synthetic directory with **no schema and no count change** (shared synthetic `nationalId`/`dateOfBirth` on two existing twh↔ihn pairs); E13 reconciliation (All = Σ tenants) is preserved by a guard test. Match-don't-auto-merge — the reconcile write path is E15 PR-2 (owner-gated); real WebChart sources are PR-3 (E12 seam). Descriptive only (ADR-008); no new deps. 831 backend tests (830 pass / 1 pg-skip); frontend lint + build green. See `docs/JOURNAL.md`.
- **E16 PR-2 + PR-3 — quality-over-time history API, backfill CLI, and UI (PR #222 — merged; E16 complete).** On top of PR-1's snapshot store (#221): `GET /api/quality/history` (bounded snapshot time-series read, `YYYY-MM`-validated, authenticated read-only); `pnpm seed:quality-history [--months 12] [--as-of YYYY-MM]` — materializes **real evaluated** snapshots for past months (superseding the synthetic `seed:trend-history` for the quality trend), audited, idempotent + resumable, reversible; and a "Quality over time (source of truth)" card on `/programs/[measureId]` with a scope selector, as-of month picker, "compliance on month M" numerator/denominator KPI, and a snapshot-backed chart (+ `ChartDataTable` alternative). Descriptive only (ADR-008/ADR-021); no schema change (reuses PR-1's `quality_snapshots`), no new deps. 817 backend tests (816 pass / 1 pg-skip); frontend lint + build + 107 vitest green. See `docs/JOURNAL.md`.
- **WCAG chart accessible-alternatives (PR #218).** Completes the chart half of the a11y pass deferred from PR #210: a shared `ChartDataTable` (`frontend/components/chart-data-table.tsx`) renders a screen-reader-only captioned data table beside each of the 3 dashboard Recharts charts (now `aria-hidden`), so assistive tech gets the underlying numbers instead of an unlabeled graphic (WCAG 1.1.1). Recharts v3's default-focusable keyboard layers are disabled under `aria-hidden` (`accessibilityLayer={false}` + Pie `rootTabIndex={-1}`) to avoid an `aria-hidden-focus` regression. 6 unit tests; lint + 105 vitest + build green. No schema, no new deps. Bundles the **E15 (#187)** and **E9 (#78)** roadmap design specs (drafts) and closes the **E11 epic (#183)**. See `docs/JOURNAL.md`.
- **E14 PR-2 — criteria-impact outcome diff (PR #217 — merged + deployed).** `GET /api/measures/:id/fidelity/diff` — a pure criteria-impact analysis (`computeOutcomeDiff`, `backend-ts/src/standards/outcome-diff.ts`) showing criterion-by-criterion how many subjects from the latest CMS122 population run would have different outcomes if the official eCQM criteria were applied. Structural-first (ADR-018); full CQL execution diff deferred to PR-3 (blocked on VSAC credentials). Descriptive only (ADR-008); no schema, no new deps. 785 tests pass. See `docs/JOURNAL.md`.
- **E13 PR-3 — scheduled cron recompute (PR #216 — merged + deployed; closes E13).** Wires the previously-inert `/api/admin/scheduler` to fire real audited `ALL_PROGRAMS` runs on a 24-hour interval. In-process `setInterval` (5-min tick × 23.5h debounce), opt-in via `WORKWELL_SCHEDULER_ENABLED=true`. `SCHEDULER_RUN_TRIGGERED` audit event written before `planManualRun` (hard rule). `triggerType:"SCHEDULED"` on `GET /api/runs`. No schema, no new deps. See `docs/JOURNAL.md`.
- **E13 PR-2 — population-scale tenant (PR #215 — merged + deployed).** Proves the multi-tenant rollup scales to ~120k subjects (`mhn` / "MetroHealth Network"): generated outcomes with encoded `subject_id` (`mhn|Lxx|Pxx|n`), SQL `GROUP BY` aggregation (`aggregateScaleRun`) — O(providers) rows, never the 120k per-subject rows. On-demand seed via `pnpm seed:scale`, idempotent, reversible; provider-leaf rollup (`scale-rollup.ts`). 4 Codex P2 fixes included (site filter, date window, React key dedup, partial-seed idempotency). No DDL, no new deps; ADR-020. **Owner step done:** `pnpm seed:scale --subjects 120000 --as-of 2026-06-26` — 1.68M outcomes seeded on Neon; live All Systems = 1,682,100. See `docs/JOURNAL.md`.
- **E13 PR-1 — multi-tenant (multi-system) rollup (PR #214 — merged + deployed).** A tenant/system dimension above the existing hierarchy, modeled read-time in the synthetic directory (ADR-019): two WebChart systems (`twh` 100 employees + `ihn` Indus Hospital Network 50 employees); a single reconciling "All Systems" root; `?tenant=` scoping everywhere; `GET /api/tenants`; System `<select>` on `/programs`, `/compliance`, `/programs/hierarchy`. No schema, no new deps. See `docs/JOURNAL.md`.
- **E14 PR-1 — standards fidelity diff (PR #212 — merged + deployed).** A `backend-ts/src/standards/` module that diffs WorkWell's authored eCQM measure against the **official spec**: a vendored, sourced **CMS122v14** reference (official population criteria + ~21 VSAC value-set OIDs + provenance, verified against the official QDM HTML) + `computeFidelity` → `GET /api/measures/:id/fidelity` (COVERED/SIMPLIFIED/OMITTED per criterion + value-set fidelity), plus a `jurisdiction` metadata field and a country-aware design memo. **Structural-first (ADR-018)**; official-CQL execution/outcome diff deferred to PR-2. Descriptive only (ADR-008); no schema, no new deps. See `docs/JOURNAL.md`.
- **WCAG accessibility pass (PR #210 — merged + deployed).** Keyboard-accessible activation, Studio ARIA tab pattern (roving tabIndex + arrow nav), `aria-live` status announcements, table-row semantics, stable list keys. Verify-first (the app was already largely accessible). Chart accessible-alternatives split to a follow-up (now done in PR #218). No new deps. See `docs/JOURNAL.md`.
- **QA follow-ups closeout (PR #209 — merged + deployed).** **M1** measure-aware next-action labels (was defaulting non-OSHA measures to "audiogram"); **H2** an inert SendGrid email seam (`resolveEmailService(env)`, simulated default) so code matches the docs; **evidence persistence** documented as a `CloudBucket`-port deploy-config step. No schema, no new deps. Plus a **deploy-reliability fix** (PR #211): the MIE deploy script polls container status until `running` instead of racing startup. See `docs/JOURNAL.md`.
- **E12 PR-1 — pluggable data ingress (PR #208 — merged + deployed).** A `backend-ts/src/engine/ingress/` module above the unchanged engine: DB-less `evaluateBundle`/`evaluateBatch` (JSON-bucket, per-item error isolation), a `PatientDataSource` port + `resolveDataSource(env)` selection, an inert `webChartDataSource` stub, CLI reuse. Records the E9 FHIR-native-first fork (ADR-017). No schema, no new deps. PR-2 (real WebChart/MariaDB→FHIR adapter) is parked pending MIE's schema. See `docs/JOURNAL.md`.
- **E11.3 PR-2 — Configure Groups UI (PR #206 — merged + deployed; closes E11).** An ADMIN `/admin → Groups` editor (rule builder + applicable measures + INCLUDE/EXCLUDE overrides + live membership preview) + a `POST /api/segments/preview` dry-run endpoint + the roster `NOT_APPLICABLE` chip and `?segment=` filter. ADMIN-gated writes; applicability gates case-creation + display only — **never compliance** (ADR-008/ADR-016). No schema, no new deps. With this, **all of E11 is merged + live.** See `docs/JOURNAL.md`.
- **E11.3 PR-1 — risk-group SEGMENTS backend (PR #205 — merged + deployed + verified live).** A cohort (role/site predicate rule + per-employee INCLUDE/EXCLUDE overrides) → an applicable measure-id rule-set, persisted in 3 owner-gated tables behind a `SegmentStore` port (floor + ceiling). A single pure applicability engine gates the roster (a `NOT_APPLICABLE` overlay + a `?segment=` filter) and run-pipeline case creation — **never compliance** (ADR-016; CQL `Outcome Status` stays authoritative). ADMIN-gated audited `/api/segments` CRUD; 3 enabled demo cohorts (the overlay is live on the demo). Reversible: zero enabled segments ⇒ everything applicable. No new deps. See `docs/JOURNAL.md`.
- **Live Hep B repointed to Heplisav-vs-traditional (E11.2c PR-2, #204 — merged + deployed).** The live `hepatitis_b_vaccination_series` measure now uses the E11.2c multi-alternative codegen: **Heplisav-B (2 doses CVX 189, ≥28d) OR traditional (3 doses CVX 08/43/44/45, ACIP min intervals 28/56d)**. The synthetic dose model picks one alternative per employee (stable hash) and stamps its CVX/count/spacing; advisory consumers (forecaster, order-catalog, catalog spec) follow. **No schema change, no new deps; reversible by reverting the PR.** CQL `Outcome Status` stays the sole compliance authority (ADR-008/ADR-015). See `docs/JOURNAL.md`.
- **Multi-alternative-series codegen + Rule Builder UI (E11.2c PR-1, PR #203 — merged).** The CQL rule→codegen supports an OR of alternative dose series with multi-CVX code sets + per-alternative ACIP minimum dose intervals, plus a Rule Builder "Alternative series (multi-brand)" authoring sub-form. Capability only — no live measure change; additive + back-compatible (absent `alternatives` ⇒ identical to E11.1), no schema, no new deps. CQL stays canonical (ADR-015); `Outcome Status` is the sole compliance authority (ADR-008).
- **QA/UX hardening pass 2 (PR #181) — merged + deployed.** Role-aware nav + action gating, programs/case-detail/runs/admin UX + perf fixes, a new `/orders` page (E7 UI), a global run-progress indicator, a conservative API GET cache, an accessibility pass, and bounded audit-ledger queries — no schema change, no new deps. See `docs/JOURNAL.md`.
- All planned sprints (**0–7**) are implemented and merged to `main`; Sprint 7 issues `#47`–`#51` are closed.
- Sprint 8 scoped-run parity, the 8-way CI test-sharding speedup (~3.8×), the MIE Container Manager v1 API deploy migration, and the `@mieweb/ui` frontend migration (PR #68) are all merged.
- **Strategic roadmap underway** (tracked as GitHub issues `#71`–`#78`): the engine is being decomposed into reusable ports/adapters so real EHR/FHIR data can plug in later. **E1 — reusable measure engine ports/adapters (PR #95, epic #71) is merged.**
- **De-Java re-platform — DONE; JVM retired** (issue `#96`, ADR-008): the backend was ported off Java/Spring Boot onto a TypeScript / `@mieweb/cloud` stack (`backend-ts/`), strangler-fig behind the **unchanged** Next.js fetch contract, CQL Path C (build-time CQL→ELM, JVM-free Node execution). As of the **#109 deploy cutover**, `https://twh.os.mieweb.org` is served by the TypeScript backend (`https://twh-api-ts.os.mieweb.org`) on the existing Neon Postgres via the `Pg*Store` ceiling, and the Java backend has been **retired** (`backend/` deleted in PR4). The full ported surface is live: runs (incl. ALL_PROGRAMS/SITE async via `ctx.waitUntil`), cases, measures (catalog + detail + create/lifecycle + Spec/CQL/Tests authoring), programs, exports, admin (reads + toggles + write CRUD), AI surfaces, the 13 MCP tools, auditor packets, MAT export, measure analytics, and value-set governance. ~427 `backend-ts` tests green. Cutover path: engine + JVM-free ELM Explorer (#106), auth/CORS (#105), SQLite-floor + Postgres-ceiling storage (#104), the Phase-4/4b API strangler (#108), then container/image (#155) → store-selection seam (#156) → shadow deploy + Neon-pooler fix (#157/#158) → blue-green flip (#159). **#109 PR4 retired the JVM:** `backend/` deleted, the Java build/deploy jobs + the shadow workflow removed, `backend-ts` CI-gated (floor + Pg ceiling) as the sole backend, and a self-heal reconciler (`reconcile-twh-mieweb.yml`) recreates a down container from `:latest` independently of Proxmox `onboot`. Known limitation: evidence upload is ephemeral (in-container `fs` BUCKET) pending a managed S3/R2 bucket. Plan + resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`; narrative in `docs/JOURNAL.md`.
- Default branch: `main` (feature branches deleted after merge).

## Production surfaces

- Live frontend: `https://twh.os.mieweb.org`
- Live backend API: `https://twh-api-ts.os.mieweb.org` — the TypeScript backend (`backend-ts/`), the **sole** backend (Java retired in #109 PR4)

> As of the #109 cutover the frontend is served by the **TypeScript** backend; the Java/Spring backend has been retired (`backend/` deleted). The earlier Vercel + Fly.io public-preview stack (`workwell-measure-studio.vercel.app`, `workwell-measure-studio-api.fly.dev`) is **decommissioned**. MIE TWH is the sole live deployment.

## Technology stack

- Backend: TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived Node host, JVM-free CQL (build-time CQL→ELM), Neon PostgreSQL 16 (`Pg*Store` ceiling; SQLite floor for tests/local)
- Frontend: Next.js 16 App Router, TypeScript, Tailwind 4, `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher), Monaco
- CQL/FHIR: build-time CQL→ELM (JVM-free)
- Infra: MIE Create-a-Container (primary) + a self-heal reconciler, Neon, GitHub Actions

## Repository layout

- `backend-ts/` API worker, CQL→ELM engine, caseflow, exports, security, MCP, store adapters (SQLite floor + Postgres ceiling)
- `frontend/` dashboard, Studio, admin, login, UX surfaces
- `docs/` architecture, data model, deploy, runbooks, sprint and journal history
- `e2e/` Playwright tests

## Quick start

### Prerequisites

- Node.js 20+
- pnpm (via Corepack) for the backend; npm for the frontend

### Backend

```bash
cd backend-ts
pnpm install
pnpm typecheck
pnpm test
pnpm dev
```

### Frontend

```bash
cd frontend
npm install
npm run lint
npm run build
npm run dev
```

## Headless evaluation (patient + YAML → compliant?)

Measure bindings are declarative YAML files (`backend-ts/measures/*.yaml`, one per runnable measure,
sibling to its CQL). A packaged headless CLI answers compliance for an arbitrary FHIR R4 patient
bundle with **no server and no database** — run it from `backend-ts/`:

```bash
pnpm evaluate --patient ./patient-bundle.json --measure audiogram --date 2026-06-12 --pretty
```

`--measure` is a registry id (`audiogram`, `hazwoper`, `tb_surveillance`, `flu_vaccine`, `hypertension`,
`diabetes_hba1c`, `obesity_bmi`, `cholesterol_ldl`, `cms125`, `cms122`, `adult_immunization`); `--date` defaults to today.
It's a thin shell (`backend-ts/src/engine/cli/`) over the same `CqlExecutionEngine` the run pipeline uses.
Output is the `MeasureOutcome` JSON:

## Seed synthetic trend history (so `/programs` charts vary)

`pnpm seed:trend-history` backfills backdated weekly COMPLETED runs per runnable measure so the
`/programs` + `/programs/[measureId]` trend charts show realistic variation instead of flat lines —
on-demand, idempotent, **not** auto-run on deploy (`backend-ts/src/run/cli/`):

```bash
pnpm seed:trend-history --weeks 12 --as-of 2026-06-21
```

Seeded runs are labeled `SEED` (real operator runs stay `MANUAL`), are anchored strictly before each
measure's latest real run so the programs overview is never affected, and add no schema. See
[Deploy Guide](docs/DEPLOY.md) for the reversible rollback SQL.

## Seed the population-scale tenant (so the rollup aggregates ~120k)

`pnpm seed:scale` populates the **`mhn` "MetroHealth Network" ~120k-subject tenant** so the
`/programs/hierarchy` rollup + `/programs` KPIs aggregate a real population-scale system (E13 PR-2).
The subjects are **generated demo data** (not live-evaluated) living only as `outcomes` rows whose
`subject_id` encodes the hierarchy (`mhn|Lxx|Pxx|n`) — **no schema**; the rollup aggregates them in SQL
(`GROUP BY`), so app memory never holds the 120k rows. On-demand, idempotent, **not** auto-run on
deploy (`backend-ts/src/run/cli/`):

```bash
pnpm seed:scale --subjects 120000 --as-of 2026-06-26
```

Reversible (delete the `seed:scale` runs+outcomes — see the [Deploy Guide](docs/DEPLOY.md)).

```json
{
  "subjectId" : "demo-patient-1",
  "measure" : "Audiogram",
  "outcome" : "COMPLIANT",
  "evidence" : { "expressionResults" : [ { "define" : "Days Since Last Audiogram", "result" : 100 }, "..." ] }
}
```

The same DB-less evaluation is also a **library** entry (E12 PR-1, #184) — `evaluateBundle(bundle, measureId)`
for a single JSON/FHIR object and `evaluateBatch(bundles, measureId)` for a "bucket" of them (per-item error
isolation), both from `backend-ts/src/engine/ingress`, with no server or DB.

## Verification commands

```bash
# backend
cd backend-ts
pnpm typecheck
pnpm test

# frontend
cd ../frontend
npm run lint
npm run test
npm run build
```

## Key routes

- `/compliance` Individual Compliance Status roster grid (every employee × the selected panel's measures; chip + method per cell)
- `/programs` compliance overview
- `/programs/[measureId]` trend, drivers, risk outlook
- `/programs/hierarchy` enterprise→location→provider→patient drill-down
- `/runs` run history and detail
- `/cases` case worklist and filters
- `/cases/[id]` evidence, actions, timeline; advisory immunization-forecast panel for `adult_immunization` cases
- `/campaigns` bulk outreach campaign launcher and history
- `/measures` catalog
- `/studio/[id]` measure authoring
- `/admin` integration and scheduler controls

## API highlights

- `POST /api/measures/{id}/ai/draft-cql`
- `POST /api/measures/{id}/ai/generate-test-fixtures`
- `GET /api/programs/{measureId}/risk-outlook?horizonDays=30`
- `GET /api/measures/{measureId}/versions/{versionId}/export/mat?format=xml`
- `POST /api/runs/manual`
- `POST /api/runs/{id}/rerun`
- `GET /api/cases?status=open`
- `GET /api/exports/runs?format=csv`
- `GET /api/auditor/cases/{caseId}/packet?format=json|html`
- `GET /api/runs/{runId}/measure-report?type=summary|individual|bundle`
- `GET /api/runs/{runId}/qrda?format=xml`
- `GET /api/hierarchy/rollup?measureId=&from=&to=`
- `POST /api/campaigns` (+ `?dryRun`) · `GET /api/campaigns` · `GET /api/campaigns/:id` (CASE_MANAGER/ADMIN)
- `GET /api/immunization/forecast?subjectId=&asOf=` (advisory; authenticated; read-time; no schema)
- `GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir` (CASE_MANAGER/ADMIN; advisory; read-time; no schema)

For full API surface and behavioral notes, see docs linked below.

## Documentation map

- [Architecture](docs/ARCHITECTURE.md)
- [Data Model](docs/DATA_MODEL.md)
- [Measures](docs/MEASURES.md)
- [Deploy Guide](docs/DEPLOY.md)
- [Exports](docs/EXPORTS.md)
- [Standards Conformance](docs/STANDARDS_CONFORMANCE.md)
- [Sprint Index](docs/sprints/README.md)
- [Journal](docs/JOURNAL.md)
- [Changelog](CHANGELOG.md)

## Engineering and governance notes

- AI assist is constrained by `docs/AI_GUARDRAILS.md`; compliance remains CQL-derived only.
- Public API audit actor is always security-context derived.
- Evidence download/upload operations are role-gated and audited.
- Production startup enforces auth, JWT, and CORS safety checks.
- Value-set expansion is pluggable: a `ValueSetResolver` port feeds the CQL `CodeService` (store-backed today, VSAC-ready), with the inline-code path as the config-selectable default (E3.2 / #90).

## Community and contribution

- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Support](SUPPORT.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
