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
