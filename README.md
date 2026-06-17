# WorkWell Measure Studio

[![CI](https://github.com/Taleef7/workwell/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Taleef7/workwell/actions/workflows/ci.yml)
[![Deploy](https://github.com/Taleef7/workwell/actions/workflows/deploy-twh-mieweb.yml/badge.svg?branch=main)](https://github.com/Taleef7/workwell/actions/workflows/deploy-twh-mieweb.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Java 21](https://img.shields.io/badge/Java-21-007396?logo=openjdk&logoColor=white)](backend/build.gradle.kts)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](frontend/package.json)
[![Open Issues](https://img.shields.io/github/issues/Taleef7/workwell)](https://github.com/Taleef7/workwell/issues)

WorkWell Measure Studio is a Spring Boot + Next.js monorepo for **Total Worker Health (TWH)** compliance operations. It combines measure authoring, deterministic CQL evaluation, case management, audit trails, admin tooling, and exportable evidence in one operational platform.

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

- All planned sprints (**0–7**) are implemented and merged to `main`; Sprint 7 issues `#47`–`#51` are closed.
- Sprint 8 scoped-run parity, the 8-way CI test-sharding speedup (~3.8×), the MIE Container Manager v1 API deploy migration, and the `@mieweb/ui` frontend migration (PR #68) are all merged.
- **Strategic roadmap underway** (tracked as GitHub issues `#71`–`#78`): the engine is being decomposed into reusable ports/adapters so real EHR/FHIR data can plug in later. **E1 — reusable measure engine ports/adapters (PR #95, epic #71) is merged.**
- **De-Java re-platform — LIVE** (issue `#96`, ADR-008): the backend was ported off Java/Spring Boot onto a TypeScript / `@mieweb/cloud` stack (`backend-ts/`), strangler-fig behind the **unchanged** Next.js fetch contract, CQL Path C (build-time CQL→ELM, JVM-free Node execution). As of the **#109 deploy cutover (PR #159, 2026-06-17)**, `https://twh.os.mieweb.org` is served by the TypeScript backend (`https://twh-api-ts.os.mieweb.org`) running on the existing Neon Postgres via the `Pg*Store` ceiling; the Java backend (`https://twh-api.os.mieweb.org`) stays deployed as the instant rollback target. The full ported surface is live: runs (incl. ALL_PROGRAMS/SITE async via `ctx.waitUntil`), cases, measures (catalog + detail + create/lifecycle + Spec/CQL/Tests authoring), programs, exports, admin (reads + toggles + write CRUD), AI surfaces, the 13 MCP tools, auditor packets, MAT export, measure analytics, and value-set governance. ~427 `backend-ts` tests green. Cutover path: engine + JVM-free ELM Explorer (#106), auth/CORS (#105), SQLite-floor + Postgres-ceiling storage (#104), the Phase-4/4b API strangler (#108), then container/image (#155) → store-selection seam (#156) → shadow deploy + Neon-pooler fix (#157/#158) → blue-green flip (#159). **Remaining: a soak, then PR4 — JVM retirement.** Known limitation: evidence upload is ephemeral (in-container `fs` BUCKET) pending a managed S3/R2 bucket. Plan + resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`; narrative in `docs/JOURNAL.md`.
- Default branch: `main` (feature branches deleted after merge).

## Production surfaces

- Live frontend: `https://twh.os.mieweb.org`
- Live backend API (primary): `https://twh-api-ts.os.mieweb.org` — the TypeScript backend (`backend-ts/`)
- Backend API (rollback): `https://twh-api.os.mieweb.org` — Java/Spring, still deployed as the instant rollback target (retired in #109 PR4)

> As of the #109 cutover (PR #159) the frontend is served by the **TypeScript** backend; Java is the rollback. The earlier Vercel + Fly.io public-preview stack (`workwell-measure-studio.vercel.app`, `workwell-measure-studio-api.fly.dev`) is **decommissioned**. MIE TWH is the sole live deployment.

## Technology stack

- Backend (live primary): TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived Node host, JVM-free CQL (build-time CQL→ELM), Neon PostgreSQL 16 (`Pg*Store` ceiling)
- Backend (rollback, pending retirement): Java 21, Spring Boot 3.x, Gradle Kotlin DSL, PostgreSQL 16, Flyway
- Frontend: Next.js 16 App Router, TypeScript, Tailwind 4, `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher), Monaco
- CQL/FHIR: build-time CQL→ELM (TS); HAPI FHIR + `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (Java)
- Infra: MIE Create-a-Container (primary), Neon, GitHub Actions

## Repository layout

- `backend/` API, CQL evaluation, caseflow, exports, security, MCP
- `frontend/` dashboard, Studio, admin, login, UX surfaces
- `docs/` architecture, data model, deploy, runbooks, sprint and journal history
- `e2e/` Playwright tests

## Quick start

### Prerequisites

- Java 21
- Node.js 20+
- npm (or pnpm if installed locally)

### Backend

```bash
cd backend
./gradlew.bat test
./gradlew.bat bootRun
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

Measure bindings are declarative YAML files (`backend/src/main/resources/measures/*.yaml`, one per
runnable measure, sibling to its CQL). The engine can answer compliance for an arbitrary FHIR R4
patient bundle with no server and no database:

```bash
cd backend
./gradlew.bat evaluateMeasure --args="path/to/patient-bundle.json src/main/resources/measures/audiogram.yaml"
```

```json
{
  "subjectId" : "demo-patient-1",
  "measure" : "Audiogram",
  "outcome" : "COMPLIANT",
  "evidence" : { "expressionResults" : [ { "define" : "Days Since Last Audiogram", "result" : 100 }, "..." ] }
}
```

## Verification commands

```bash
# backend
cd backend
./gradlew.bat test

# frontend
cd ../frontend
npm run lint
npm run test
npm run build
```

## Key routes

- `/programs` compliance overview
- `/programs/[measureId]` trend, drivers, risk outlook
- `/runs` run history and detail
- `/cases` case worklist and filters
- `/cases/[id]` evidence, actions, timeline
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

For full API surface and behavioral notes, see docs linked below.

## Documentation map

- [Architecture](docs/ARCHITECTURE.md)
- [Data Model](docs/DATA_MODEL.md)
- [Measures](docs/MEASURES.md)
- [Deploy Guide](docs/DEPLOY.md)
- [Exports](docs/EXPORTS.md)
- [Sprint Index](docs/sprints/README.md)
- [Journal](docs/JOURNAL.md)
- [Changelog](CHANGELOG.md)

## Engineering and governance notes

- AI assist is constrained by `docs/AI_GUARDRAILS.md`; compliance remains CQL-derived only.
- Public API audit actor is always security-context derived.
- Evidence download/upload operations are role-gated and audited.
- Production startup enforces auth, JWT, and CORS safety checks.

## Community and contribution

- [Contributing Guide](CONTRIBUTING.md)
- [Security Policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Support](SUPPORT.md)

## License

Licensed under the [Apache License 2.0](LICENSE).
