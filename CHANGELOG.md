# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/) intent for release communication.

## [Unreleased]

### Added
- DataVis **NITRO** data grid unblocked and rolled out: consumed via `@mieweb/ui/datavis` + a vendored `datavis` source (`frontend/vendor/datavis`, aliased `file:`) and `datavis-ace@=4.0.0-PRE.2`. Live on `/measures`, `/runs` (Outcomes), and `/admin` (data mappings, terminology mappings, delivery log) through the client-only `features/datavis/NitroGrid` wrapper; rich cells preserved via `formatCell`. See ADR-007 + `frontend/vendor/datavis/VENDORING.md`. (Remaining `@mieweb/ui` form-control swap split out as issue #99.)
- Scoped-run parity (Sprint 8): `SITE` and `EMPLOYEE` manual runs and same-scope reruns now route through the async run-job path, matching `ALL_PROGRAMS`/`MEASURE`; the `/runs` UI exposes the new scopes.

### Removed
- **Java/Spring backend retired (#109 PR4):** `backend/` (the Java app + Gradle + Flyway), the Java `Dockerfile`, the Java build/deploy jobs in `deploy-twh-mieweb.yml`, the Java `backend` job in `ci.yml`, and the now-redundant `deploy-twh-ts-shadow.yml` are all deleted. `backend-ts` (TypeScript on `@mieweb/cloud`) is the **sole** backend, CI-gated (`ci.yml`, SQLite floor + Postgres ceiling). Rollback is now redeploying an earlier known-good `twh-api-ts` image. The `.cql`/`.yaml` measure source corpus was **relocated** (not lost) from `backend/` into `backend-ts/measures/`, with the build-time CQL→ELM + bindings generators repointed there.

### Changed
- **De-Java cutover (#109):** `https://twh.os.mieweb.org` is served by the TypeScript backend (`backend-ts/` → `https://twh-api-ts.os.mieweb.org`) on Neon Postgres via the `Pg*Store` ceiling (isolated `workwell_spike` schema), behind the unchanged Next.js fetch contract. Cutover path: container/image (#155) → store-selection seam (#156) → shadow deploy + Neon-pooler `options` fix (#157/#158) → blue-green flip (#159) → pre-retirement hardening (CI gate #161, observability + orphaned-run recovery #162, self-heal reconciler #163) → **JVM retirement (PR4)**. A self-heal reconciler (`reconcile-twh-mieweb.yml`) recovers the live stack from reboot/crash independent of Proxmox `onboot`. Known limitation: evidence upload is ephemeral (in-container `fs` BUCKET) pending a managed S3/R2 bucket.
- CI backend test suite ~3.8× faster (44m → 11m30s) via 8-way test sharding plus a per-class population-run fix (PR #57).
- Deployment consolidated onto MIE Create-a-Container; the Vercel + Fly.io public-preview stack is decommissioned. Living docs (README, DEPLOY, ARCHITECTURE, CLAUDE, AGENTS, sprint index) reconciled to the single live MIE TWH stack.
- Repository standards polish: badges, contribution/security/support docs, community templates, and metadata alignment.

### Fixed
- MIE Container Manager deploy migrated to the v1 API contract (`/api/v1` base, `{"data": ...}` envelope, `template`/`services` create body, `.data.status` polling) after the manager API changed (PRs #55, #56).

### Docs
- Synced CLAUDE.md, AGENTS.md, README, DEPLOY, and the sprint index to the post-Sprint-7 / Sprint-8 state (measure catalog 60/49, Next.js 16 + React 19, OpenAI Spring AI starter, MIE-only deployment).

## [2026-06-30]

### Added
- **WCAG chart accessible-alternatives (PR #218):** a shared `ChartDataTable` (`frontend/components/chart-data-table.tsx`) — a screen-reader-only captioned `<table>` with scoped column headers — is now rendered beside each of the 3 dashboard Recharts charts (the `/programs` per-card `TrendChart` line chart, and the `/programs/[measureId]` `ComplianceTrendChart` area chart + outcome `PieChart`). Each chart's visual SVG is marked `aria-hidden="true"`, so assistive tech reads the underlying numbers instead of an unlabeled graphic (WCAG 1.1.1 non-text content). Completes the chart half of the a11y pass deferred from PR #210. 6 unit tests. No schema, no new deps.
- **E15 (#187) + E9 (#78) design specs (drafts):** `docs/superpowers/specs/2026-06-30-e15-cross-system-identity-design.md` (cross-system identity & mobility — a synthetic-first PR-1 is buildable over the E13 directory; the real EMPI resolver is blocked on E12 PR-2) and `docs/superpowers/specs/2026-06-30-e9-cql-sql-bridge-decision-memo.md` (the CQL→SQL decision memo — recommends hybrid pluggable executors; awaiting Doug Q2). Both marked *Draft — pending owner review*.

### Fixed
- **`aria-hidden-focus` avoided on the now-hidden charts (PR #218):** Recharts v3 defaults `accessibilityLayer=true` (a focusable `<svg>` with `role="application"`) and Pie defaults `rootTabIndex=0`; wrapping the charts in `aria-hidden="true"` would otherwise leave focusable elements inside a hidden subtree (an axe `aria-hidden-focus` violation + keyboard focus-order regression). The built-in keyboard layers — now redundant since the `sr-only` table is the accessible alternative — are disabled (`accessibilityLayer={false}` on the Line/Area/Pie charts + `rootTabIndex={-1}` on the Pie). Found by the whole-PR `code-reviewer` pass.

### Docs
- Closed the **E11 epic (#183)** (all sub-PRs #203–#206 were already merged + live; the tracking issue was never closed). Reconciled `CLAUDE.md`, `README.md`, `docs/ARCHITECTURE.md` (§4 chart-a11y note), and `docs/JOURNAL.md` to the 2026-06-30 state.

## [2026-06-25]

### Added
- **Live Hepatitis B repointed to Heplisav-vs-traditional (E11.2c PR-2, #183):** the live `hepatitis_b_vaccination_series` measure now uses the E11.2c multi-alternative codegen — **Heplisav-B** (2 doses CVX 189, ≥28 days apart) **OR** the **traditional** schedule (3 doses CVX 08/43/44/45, ACIP minimum intervals 28/56 days). The value-set seed gained CVX 44/45; `hepatitis_b.yaml` gained `rule.alternatives` + `bindings.eventAlternatives`; the two regex build scripts (`gen-cql.mjs`, `gen-measure-bindings.mjs`) parse them, with `measure-bindings.ts` carrying a merged `alternatives` array. The hand-written + generated Hep B CQL/ELM were regenerated (parity by construction); the synthetic dose model (`fhir-bundle-builder.ts`) is alternative-aware (picks one alternative per employee by a stable `externalId` hash, stamps its CVX/dose-count/spacing); the 4 spike fixtures were repointed (present_recent = Heplisav-2, present_old = Traditional-3). Advisory consumers follow (forecaster Heplisav-2 default `HEPB_DOSES_REQUIRED` 3→2; order-catalog CVX 08→189; catalog spec text). Roster `deriveCell` unchanged (reads the still-emitted union `Dose Count`); the partial "1 of 2 doses on file" under-read for a traditional-3 series is the accepted, documented display nuance. **No DB schema change, no new deps; reversible by reverting the PR.** Hep B's live compliance semantics shift to Heplisav-vs-traditional by design; CQL `Outcome Status` stays the sole compliance authority (ADR-008/ADR-015). Titer-proves-immunity for Hep B remains deferred. Smoke (`pnpm evaluate`, live ELM): present_recent→COMPLIANT, present_old→COMPLIANT, missing→MISSING_DATA, excluded→EXCLUDED.
- **Multi-alternative-series codegen capability + Rule Builder UI (E11.2c PR-1, #183 / PR #203):** the rule→CQL generator (`backend-ts/src/engine/cql/codegen/generate-cql.ts`) now supports a `series-completion` rule carrying `alternatives` — an OR of alternative dose series, each with its own multi-CVX code set (`bindings.eventAlternatives`, correlated by `label`) and optional per-alternative minimum dose intervals (an ordered multi-source `exists` with inclusive `>=` day gaps). The Rule Builder gains an "Alternative series (multi-brand)" sub-form (label / required doses / CVX codes / optional min intervals, hydrated by label) emitting `rule.alternatives` + `bindings.eventAlternatives` through the existing E11.2b preview/save endpoints. Proven by codegen unit tests (incl. negative validation: missing alternative codes, bad interval length, `requiredDoses >= 1`) + 7 in-process compile+evaluate Hepatitis B behavioral goldens (inclusive-28d boundary COMPLIANT, 27d-gap MISSING_DATA, mixed-brand neither-complete MISSING_DATA, contraindication EXCLUDED). **Capability only — no live measure changed** (the live Hepatitis B repoint to Heplisav-B-vs-traditional is the follow-up PR-2). Additive + back-compatible (absent `alternatives` ⇒ byte-identical to E11.1; the `codegen-parity.test.ts` proof is unchanged). No DB schema change, no new deps; CQL stays canonical (ADR-015) and `Outcome Status` remains the sole compliance authority (ADR-008).

## [2026-06-21]

### Added
- **Synthetic trend-history backfill (PR #180):** `pnpm seed:trend-history [--weeks 12] [--as-of YYYY-MM-DD]` (`backend-ts/src/run/cli/`) writes backdated weekly COMPLETED `MEASURE` runs per runnable measure so the `/programs` + `/programs/[measureId]` trend charts show realistic variation instead of flat lines. Compliance varies ~±0.06 around each measure's base rate; outcomes come from a precomputed `(measure,target)→outcome` map. Idempotent and resumable at the week level (a rerun or larger `--weeks` fills only missing weeks). On-demand / offline tool — **not** wired into the request-path startup. Audited (one `TREND_HISTORY_SEEDED` audit event per seeded measure). Reversible rollback (delete tagged outcomes, then runs — `triggered_by = 'seed:trend-history'`).

### Changed
- Run read model surfaces `triggered_by`: seed runs (`triggered_by='seed:trend-history'`) are labeled `triggerType="SEED"` (real operator runs stay `MANUAL`) on `/api/runs`, filterable via `GET /api/runs?triggerType=SEED`. Each measure's newest synthetic week is anchored strictly before that measure's latest real run, so the programs overview (latest-run-per-measure) is never hijacked by synthetic data. **No schema/DDL change** — existing columns only; additive store-contract changes are optional `createRun` backdating fields (`startedAt`/`completedAt`/`status`), an `OutcomeStore.recordOutcomes` batch insert, and an optional `RecordOutcomeInput.evaluatedAt`.

## [2026-05-22]

### Added
- Sprint 7.2 AI test fixture generation endpoint and Studio integration.
- Sprint 7.3 risk outlook analytics endpoint and programs UI widget.
- Sprint 7.4 MAT-compatible FHIR R4 export endpoint and export controls.
- Sprint 7.5 mobile-responsive navigation and caseflow UX updates.

### Fixed
- MAT export authorization boundary enforced to `ROLE_APPROVER` / `ROLE_ADMIN`.
- `risk-outlook` missing-measure handling mapped to `404`.
- MAT ValueSet export omits blank version primitives; export validation hardening.

### Docs
- Sprint 7 implementation closeout reflected across README, sprint docs, and journal.
