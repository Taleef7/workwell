# Issue #96 — De-Java the WorkWell backend onto TypeScript / `@mieweb/cloud`

> **Status:** Execution plan (committed direction). Supersedes the local feasibility note
> `~/.claude/plans/hey-i-wanna-discuss-logical-beacon.md`.
> **Stakeholder:** Doug Horner (`horner`) — issue [#96](https://github.com/Taleef7/workwell/issues/96).
> **Owner:** Taleef. **Date:** 2026-06-12.
> **Governing ADR:** ADR-008 (`docs/DECISIONS.md`) — this stack change requires it per `CLAUDE.md`.
> **Companion analysis:** `docs/MIEWEB_CLOUD_REFACTOR_MEMO.md` (repo-grounded Spring footprint, answers
> to Doug's 9 questions, `RunStore`/`CaseStore`/`OutcomeStore`/`MeasureStore`/`AuditStore` contracts).
> **Tracking:** GitHub Project "WorkWell #96 — De-Java Re-platform"; epic sub-issues under #96.

## 1. What Doug asked for (#96)

Stop depending on Java/Spring Boot as the backend. Make `@mieweb/cloud` the **pluggable backend
layer** with Cloudflare-shaped contracts and runtime adapters (Cloudflare native / local Node /
SQLite / D1 / Postgres / S3-MinIO / Valkey). Application code calls **explicit repository contracts**
(`runStore.createRun(input)`, `runStore.claimNextQueuedRun(workerId)`, …); each backend adapter
implements them. Principle: **"SQLite/D1 define the portable floor; Postgres provides the performance
ceiling."** Use a lightweight ORM/query builder (Drizzle or Kysely) for schema/migrations/CRUD only —
**not** as the portability layer. **No JVM, Spring DI, Spring Data, or Spring MVC** required to run,
test, or deploy. Check out `mieweb/cloud` as a submodule so we can enhance it where needed.

Doug's second steer (planning thread): investigate a TS FHIR replacement (he named
`node-on-fhir/honeycomb`); deploy target = **Node container on MIE** (not Cloudflare Workers yet);
set up a project board.

## 2. Recommendation (one line)

**Strangler-fig re-platform onto `@mieweb/cloud`, with CQL Path C for the engine** — port the backend
to TypeScript module-by-module behind the *unchanged* frontend API contract, demote Java from a
runtime dependency to a build-time authoring tool (compile CQL→ELM offline, execute ELM in Node), and
co-develop the missing `@mieweb/cloud-postgres` adapter as we go.

> **Update 2026-06-12 — Phase-1 spike GO; going fully zero-Java (Doug's #96 end state).** The spike
> proved CQL Path C parity across **all 10 measures × 4 scenarios — 40/40 exact** vs the Java engine,
> and proved that **`@cqframework/cql`** (Kotlin-Multiplatform, pure Node, no JVM) translates all 10
> measures' CQL→ELM with that same 40/40 parity. So even the build-time translator runs in Node:
> **Java/Spring Boot leaves the project entirely — runtime, build, and authoring** — with no functional
> compromise. The `@cqframework/cql` beta is pinned and gated by the full-catalog parity harness
> (`backend-ts/spike/compare-all.mjs`); the Java translator is kept only as a transitional cross-check.
> See ADR-008 (2026-06-12 update) and `backend-ts/spike/README.md`.

Why this satisfies every constraint:
- **Don't give up work done** → strangler is incremental; nothing is deleted until its TS replacement
  passes parity. The frontend (already TS, decoupled via `frontend/lib/api/client.ts`) is untouched.
- **Follow Doug's end-state** → no JVM to run/test/deploy; app code calls Cloudflare-shaped contracts.
- **Low friction** → Path C is the *only* path that keeps the eCQM differentiator (real CQL + MAT
  export) **and** eventually removes Java from deploy.
- **Contribute upstream** → building `@mieweb/cloud-postgres` + hardening the storage contract is a
  direct contribution to `@mieweb/cloud` (still v0.0.0 PoC).

## 3. The reframing that de-risks the FHIR question

**WorkWell is not a FHIR server.** Postgres is the system of record (employees, runs, outcomes,
cases = plain relational data). FHIR R4 bundles are synthesized on the fly (`InMemoryFhirRepository`)
purely as transient input to the CQL engine; they are never persisted or served as a FHIR REST API.
So we do **not** adopt a TS FHIR *server*. `node-on-fhir/honeycomb` (Meteor 3 + React/MUI + MongoDB,
AGPL-3.0, no CQL engine) is a **poor fit** — it would replace the existing Next.js/`@mieweb/ui`
front end with an unrelated stack and still not solve CQL. Medplum is a monolithic platform, also
overkill. The "replace FHIR Java" task reduces to: (1) FHIR R4 **typing/bundle-building in TS**
(trivial, `@types/fhir`), and (2) the **measure-evaluation engine** (the genuine hard part).

## 4. The crux — CQL evaluation without a JVM at runtime

**Architecture: the engine is an explicit swappable compute binding, not the app framework.**
(Per the companion analysis `docs/MIEWEB_CLOUD_REFACTOR_MEMO.md`.) The worker calls an
`EvaluateMeasure` binding the way it calls an AI provider or vector backend — the portability layer is
JVM-free regardless, and a target with no CQL binding configured **raises `UnsupportedBindingError`,
never guesses a status** (same invariant as "AI never decides compliance; CQL `Outcome Status` is the
sole source of truth"). The three options below are **implementations of that one binding**, chosen on
Phase-1 parity evidence — the abstraction stands either way. E1/E2 already cut this seam: the eval core
is Spring-free behind 4 `engine.port` interfaces with a no-Spring/no-DB headless entrypoint.

The JS CQL ecosystem: `cql-execution` + `fqm-execution` execute **pre-compiled ELM JSON only**; they
do **not** translate CQL→ELM, and (per the memo) may not replicate `cqf-fhir-cr` measure-population
semantics exactly — which is precisely the parity risk Phase 1 buys down. CQL→ELM still needs the Java
`cql-to-elm` translator. Three binding implementations:

- **Path C — keep CQL, Java only at authoring (chosen):** run Java `cql-to-elm` offline at build
  time, commit ELM JSON + FHIRHelpers + ModelInfo + expanded value sets; execute in Node via
  `cql-execution`/`fqm-execution`. Java leaves the **runtime/deploy-required** path entirely. Preserves
  the real eCQM story. Cost: re-validate golden parity, accept JS `Number` precision caveats.
  - **Live CQL authoring is NOT sacrificed** (per "no compromise on functionality"). The Studio CQL
    compile gate stays. The CQL→ELM **translator** is the single piece that may remain Java "where
    absolutely necessary": delivered either as (a) a build-time compile step authors run via CLI/CI, or
    (b) an **optional authoring-only translation sidecar** the running app calls *only* when an author
    edits CQL — explicitly **not** required to run, test, or deploy the core app (satisfies Doug's
    "Java/Spring Boot should not be required to use, test, or deploy"). Decided in the Phase-1 spike;
    the WASM/J2CL `cql-to-elm` transpile is evaluated there as the route to zero-Java authoring too.
- **Path B — drop CQL for FHIRPath + TS rules:** zero Java anywhere, but abandons CQL/eCQM
  standards-compliance and MAT/HQMF export — i.e. gives up the differentiator. Rejected.
- **JVM evaluator sidecar — the fallback binding impl:** if Path C fails golden parity, the same
  `EvaluateMeasure` binding is implemented by the proven Java engine behind a thin transport
  (stdio/CLI locally, HTTP sidecar in server). Java is then "where absolutely necessary" — an explicit,
  swappable compute binding, **not** in the portability layer (app code, storage, auth, MCP, deploy
  orchestration all stay JVM-free), but Java does stay on the deploy path until E9/#78 lands.

**Phase 1 spike proves the Node-ELM binding against the Java engine's golden output before we commit
the months.** Either way the engine is consumed through the one binding interface, so the app code and
storage layers are written once and don't change when the binding implementation is chosen.

The eventual *zero-JVM* endgame (Node-ELM authoring **and** eval, no sidecar) ties to roadmap epic
**E9/#78 (CQL→SQL / transpile)** — tracked separately; until it lands, whichever binding impl wins is
surfaced honestly.

## 5. Keep vs. Transition vs. Retire

| Asset | Decision | Notes |
|---|---|---|
| Frontend (Next.js 16, `@mieweb/ui`, NITRO) | **KEEP 100%** | Already TS; talks via hand-written `fetch`. API URL+shape contracts are the strangler seam. |
| 10 measures' CQL source + golden-parity fixtures | **KEEP / reuse** | Become the spec *and* the test oracle for the new engine. |
| Postgres schema (21 Flyway migrations) | **KEEP shape** | Re-expressed as Drizzle/Kysely schema, same tables/columns. Migrations stay Taleef-owned. |
| Deploy pipeline (`deploy-twh-mieweb.yml`, GHCR, MIE container) | **KEEP shape** | Swap JVM image → Node image; same v1 Container Manager flow. |
| E1 ports/adapters design (ADR-005) | **KEEP concept** | `PatientDataProvider` / `EmployeeDirectory` / `MeasureDefinitionProvider` / `EvaluationConfigProvider` carry directly into TS interfaces. |
| ~14 REST controllers / 75–118 endpoints | **TRANSITION** | Worker-style TS handlers, identical request/response contracts. |
| `JdbcTemplate` persistence (~90 sites) | **TRANSITION** | Repository contracts over `CloudDatabase` (SQLite floor) + Postgres adapter. |
| JWT auth, 13 MCP tools, AI, SendGrid, exports, audit | **TRANSITION** | Mechanical TS rewrites; TS MCP SDK exists. |
| CQL **runtime** (`cqf-fhir-cr`, HAPI in-process) | **TRANSITION** | ELM-in-Node via `cql-execution`/`fqm-execution`. |
| JVM, Spring, Gradle (backend) | **RETIRE** (last) | Only after measure parity proven. Java survives as an offline ELM compiler. |

## 6. Phases (each = one epic sub-issue under #96)

### Phase 0 — Decision & scaffolding
- ADR-008 in `docs/DECISIONS.md` (done alongside this plan).
- Add `mieweb/cloud` as a git submodule.
- Stand up the project board + labels.
- Define the TS monorepo package layout (consumer of `@mieweb/cloud-types`; app worker; CLI target).

### Phase 1 — Vertical-slice spike (timeboxed ~1 week, GO/NO-GO gate) ⟵ most important
Build ONE slice end-to-end on a Node container, on *evidence* not vibes:
- Storage contract (`runStore.createRun/getRun/appendLog/claimNextQueuedRun`) over the `@mieweb/cloud`
  `CloudDatabase` (SQLite) seam, mirrored to a Postgres adapter; Drizzle/Kysely for schema/CRUD, raw
  adapter SQL for locking/queue-claim/JSONB-heavy reads.
- 3–4 endpoints matching the existing fetch-client contracts exactly.
- **One measure evaluated via Path C, checked against the Java engine's golden output** for the same
  employee fixtures (reuse `EngineGoldenParityTest` cases). This is the single most important proof.
- **Exit gate:** parity met + ergonomics acceptable → proceed. Else fall back to Java-eval-service.

### Phase 2 — Platform foundation (co-develop `@mieweb/cloud`)
- Build/contribute `@mieweb/cloud-postgres` (Postgres impl of the DB contract).
- Full repository-contract storage layer mirroring all 21 migrations.
- Per-target migration strategy (SQLite/D1 floor vs Postgres ceiling).
- JWT + refresh-cookie auth in TS (SameSite=None; Secure; rotation).
- `audit_event`-on-every-state-change invariant in TS.

### Phase 3 — Engine cutover (CQL Path C)
- Offline CQL→ELM compile pipeline (Java `cql-to-elm` at build time only).
- Node execution via `cql-execution`/`fqm-execution`.
- **All 10 runnable measures pass golden parity** (100 employees × 10 measures).
- Preserve the `evidence_json` shape exactly (`expressionResults` + `Outcome Status`).

### Phase 4 — API surface strangler port (module by module)
- Port endpoint groups behind the unchanged frontend contract, cut over per module:
  runs → cases → measures → programs → exports → admin → ai.
- 13 MCP tools re-implemented on the TypeScript MCP SDK (SSE, role gates, per-call audit).

### Phase 5 — Deploy cutover & JVM retirement
- Node container image; `deploy-twh-mieweb.yml` image swap.
- Shadow / parallel run, then flip `twh-api`.
- Remove Spring/Gradle backend.
- Update ARCHITECTURE / DEPLOY / DATA_MODEL / CQF reference docs + JOURNAL.

## 7. Sub-issue map

| # | Title | Phase | Labels |
|---|---|---|---|
| A | [Epic] ADR + project scaffolding + `mieweb/cloud` submodule | 0 | epic, replatform-96, infra |
| B | [Spike] Vertical slice: storage contract + 1 endpoint group + 1-measure golden parity (GO/NO-GO) | 1 | replatform-96, spike, backend, cql-engine |
| C | `@mieweb/cloud-postgres` adapter + storage repository contracts | 2 | replatform-96, mieweb-cloud, backend |
| D | Auth, audit & platform invariants in TS | 2 | replatform-96, backend, typescript |
| E | CQL→ELM offline compile + Node execution; 10-measure parity | 3 | replatform-96, cql-engine, backend |
| F | API strangler port — runs/cases/measures/programs | 4 | replatform-96, backend, typescript |
| G | API strangler port — exports/admin/ai + MCP tools | 4 | replatform-96, backend, ai |
| H | Deploy cutover to Node container + JVM retirement + docs | 5 | replatform-96, infra, documentation |

## 8. Honest risks / blast radius

- It is a **ground-up backend rewrite** (~19k LOC) **plus co-developing an immature PoC layer**
  (`@mieweb/cloud` is v0.0.0; `@mieweb/cloud-postgres` does not yet exist) — months, single developer.
- **Measure parity is the top risk** — it's the product's reason to exist; JS CQL has real gaps.
  Phase 1 is the cheap gate that buys down this risk before the expensive phases.
- **JSONB-vs-SQLite-floor mismatch** — the schema leans on Postgres JSON ops (`->`, `->>`,
  `jsonb_array_length`, `jsonb_set`, `jsonb_exists`). The "SQLite/D1 floor" forces schema/query rework
  or honest `UnsupportedBindingError`.
- 21 migrations, 13 MCP tools, JWT/cookie semantics, multipart evidence upload, run-log streaming,
  ~239 tests — all re-implemented.
- **Schema migrations remain Taleef-owned** — no agent writes `V0xx`/new migrations without explicit
  instruction.

## 9. Verification (per phase)

- TS slice runs as a Node container locally and on MIE Create-a-Container; health endpoint green.
- The existing Next.js frontend talks to the TS endpoints **unchanged** (same base-URL contract).
- **Golden parity:** chosen-path measure output equals the Java engine's `Outcome Status` + key
  `expressionResults` for the shared employee fixtures.
- `@mieweb/cloud` SQLite adapter and the Postgres adapter both pass the same storage-contract tests.

## 11. Vision-doc reconciliation (Doug's standing asks)

Folded in from `Workwell Vision Doc.md` so nothing from Doug's direction is dropped:

- **"Engineer from scratch, module by module, library by library; every module uses MIE's own
  components and is reusable for MIE's other internal projects/products."** The re-platform is not just
  "remove Java" — each layer ships as a reusable MIE package (Doug's `@mieweb/cloud-types` /
  `@mieweb/cloud` / `@mieweb/cloud-local` / `@mieweb/cloud-postgres` / `@mieweb/cloud-os` / `@mieweb/cli`
  / `@mieweb/test-app` decomposition), frontend on `@mieweb/ui`, backend on `@mieweb/cloud`. Reusability
  for MIE's other products is a design constraint, not a nice-to-have.
- **"Programming layer, no UI: given this patient and this YAML, are they compliant?" (ADR-006).** The
  headless evaluator must survive as a **first-class reusable TS artifact** — a Node equivalent of
  `HeadlessEvaluatorCli` / the `evaluateMeasure` Gradle task (`evaluate(patientBundle, measure.yaml)`),
  with no server and no DB. This is the cleanest embodiment of "the CQL part can be independent/
  reusable" and is an explicit Phase-3 deliverable (#106), not just an internal of the run pipeline.
- **MCP nginx SSE/504 caveat.** The remote MCP transport over `twh-api.os.mieweb.org/sse` is throttled
  by MIE nginx's default `proxy_read_timeout 60s` + buffering (diagnosed 2026-05-22). This is an
  MIE-ops config fix (`proxy_buffering off`, `proxy_read_timeout 3600s` on `^/(sse|mcp/)`), **independent
  of backend language** — porting MCP to the TS SDK (#108) does not resolve it. Re-flag with MIE ops at
  Phase-4b; local-backend workaround remains until then.
- **Harmonization context = the "why" for keeping eCQM/CQL.** The two charters
  (`docs/Harmonization charter for Health surveillance, Quality and immunity.pdf`, `docs/Quality
  Dashboards Working backwards … ecqm … medical surv.pdf`) frame WorkWell as the reusable eCQM-standard
  engine harmonizing eCQM / surveillance / preventive / immunization. This is precisely why Path C
  (keep CQL/eCQM standards + MAT export) is correct over Path B (drop CQL) — confirmed by Taleef.

## 10. Open items still tracked

- Storage floor stance: Postgres-primary + D1 best-effort vs. true SQLite/D1 floor — **decided in the
  Phase 1 spike on evidence.**
- Whether any endpoint groups can be retired rather than ported (dead-surface audit during Phase 4).

## 11. Build progress (live)

Phase status as of 2026-06-13 (each merged behind Codex review on its own PR; floor+ceiling store
contracts; per-PR JOURNAL entries carry the detail):

- **Phase 1 spike (#103)** — GO; run→evaluate→persist slice. ✅ merged.
- **Phase 2 storage (#104)** — Postgres ceiling adapter + shared store contract (floor+ceiling). ✅ merged.
- **Phase 2 auth (#105)** — JWT + PBKDF2 + login/refresh/logout + role gates + CORS + prod fail-fast. ✅ merged (PR #117).
- **Phase 3 engine (#106)** — CQL→ELM build-time compile + Node execution; ELM Explorer (live no-JVM compile). ✅ merged.
- **Phase 4 API strangler (#107)** — in progress, per module:
  - `runs` — read models (list/summary/logs/outcomes) + write pipeline (manual/rerun, synthetic
    generation, seeded distribution, PARTIAL_FAILURE). ✅ merged (PRs #118–#121). MEASURE/EMPLOYEE sync;
    ALL_PROGRAMS/SITE (async) + CASE pending.
  - `cases` — worklist + idempotent upsert ✅ (PR #122); case detail + why_flagged ✅ (PR #123);
    actions (assign/escalate) + audit timeline ✅ (PR #124); outreach (preview/send/delivery) ✅ (PR #125);
    rerun-to-verify (CASE scope) + run `totalCases` ✅ (closed_reason/closed_by columns, `countByLastRun`).
    **Functionally complete bar evidence upload/download, appointments, ai/explain, the
    `outreach_delivery_log` table, and the run-grid per-row caseId — all #108-adjacent.**
  - `measures` — **persisted store + read surface + authoring** ✅: catalog/detail/versions/
    activation-readiness read the store; `POST /api/measures` (create), `/:id/{approve,deprecate,status}`
    lifecycle with audit events (faithful gates — deprecate works on Active; approve/activate blocked on
    fixtures until the Tests tab). Pending: spec/CQL edits + test-fixture CRUD + version cloning +
    value-set governance.
  - `programs` — **complete** ✅: overview + sites, trend + top-drivers, risk-outlook (`/:id/risk-outlook`,
    upcoming due-soon + repeat non-compliers + per-site predicted compliance). Added the canonical
    `outcomes.evaluation_period` column (floor+ceiling+backfill) to enable repeat-non-complier streaks.
- **Phase 4b API strangler (#108)** — in progress: **exports** (runs/outcomes/cases/audit CSV) ✅.
  admin surface, AI surfaces, MCP tools pending.
- **Phase 5 deploy cutover (#109)** — not started (binding selection, Java retirement).

Test posture: `backend-ts` ~187 tests green (Postgres-harness skips without local Docker); `tsc --noEmit`
clean; the frontend fetch contract is unchanged throughout.
