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
