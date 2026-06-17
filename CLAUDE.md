# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer Spring Boot + Next.js monorepo
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- Historical sprint window: May 2-17, 2026; active work is now post-merge closeout and polish

## Read first, every session
`@docs/archive/SPIKE_PLAN.md` is the archived sprint plan and historical context. `docs/JOURNAL.md` is the current source of truth for recent work, and `README.md` is the public-facing overview.

`docs/archive/PROJECT_PLAN_v1.md` is archived. Do not act on it. But feel free to read it for more context on how we got here and what we're planning and building. It contains the original project proposal, initial architecture sketches, and early measure definitions that informed the spike plan.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: Java 21 + Spring Boot 3.x + Gradle Kotlin DSL + PostgreSQL 16 + Flyway
- CQL/FHIR: HAPI FHIR JPA + `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (see CQF_FHIR_CR_REFERENCE.md)
- Frontend: Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher; see ADR-004) + Monaco
- AI: Spring AI (OpenAI starter, `spring-ai-openai-spring-boot-starter`); MCP via `io.modelcontextprotocol/java-sdk`
- Infra: Docker Compose locally; MIE Create-a-Container + Neon for deploy (Fly.io + Vercel public-preview stack decommissioned — MIE TWH is the sole live stack); GitHub Actions CI; pnpm

## Build & verify
- Backend: `cd backend; .\gradlew.bat test` — 239 tests; CI shards 8-way. **Never run two backend `gradlew test` concurrently** (shared temp binary-results race).
- Frontend: `cd frontend; npm run lint; npm run build`
- Run the app: backend `.\gradlew.bat bootRun`; frontend `npm run dev`

## Hard rules
- Avoid new dependencies unless they are explicitly approved and documented
- One Spring Boot app, modular packages — no microservices
- Spring Application Events + DB audit log — no Kafka or external streaming
- Auth: user accounts remain hardcoded (no SSO, no real user directory). JWT refresh token flow (HttpOnly cookie, token rotation, `/api/auth/refresh`) is approved and implemented in Sprint 4 — this replaces the prior "stub auth only" constraint.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the default and must remain so on the demo stack. SendGrid wiring exists in the code (Sprint 6) but must not be activated unless `WORKWELL_EMAIL_SENDGRID_API_KEY` is explicitly set (with `WORKWELL_EMAIL_PROVIDER=sendgrid`) in a non-demo environment.
- AI never decides compliance (see docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes. If a stop condition triggers, document fallback in JOURNAL.md.
- Schema migrations are owned by Taleef — never written or applied by an agent without explicit instruction

## Branch + ownership
- Backend agent owns `backend/` only
- Frontend agent owns `frontend/` only
- Schema migrations (`backend/src/main/resources/db/migration/`) are mine, never delegated
- Use a feature branch for follow-up work
- Merge after my review — no auto-merge

## Definition of done (every PR)
- Tests pass (idempotency + audit invariants are mandatory; rest smoke-only)
- CI green
- Affected docs updated in same PR (ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, DEPLOY)
- JOURNAL.md entry started for the day
- ADR added to DECISIONS.md if non-obvious
- Conventional commit with a clear scope: `feat(measure): catalog CRUD`

## Working style
- Plan mode for any task touching >2 files
- Confirm before destructive ops (`rm -rf`, force-push, schema drops, secret rotation)
- Commit per ticket, push every 2 hours
- Ask before guessing — cost of asking < cost of building wrong
- Many small commits over few large ones

## File conventions
- Java packages: `com.workwell.<module>` (measure, valueset, compile, run, caseflow, audit, fhir, integrations, ai, mcp, notification, config, security, web)
- Frontend routes under `app/(dashboard)/`
- Daily log: `docs/JOURNAL.md` (newest entry on top, dated YYYY-MM-DD)
- Decisions: `docs/DECISIONS.md` (numbered ADRs, dated)

## Daily rhythm
- **Morning:** review `docs/JOURNAL.md` and the current focus block before starting
- **Throughout:** keep changes small and verify what you touch
- **End of day:** make sure `docs/JOURNAL.md` and affected docs are current

## Stop and ask if
- A spike's stop condition (in `docs/archive/SPIKE_PLAN.md`) appears to trigger
- A library version doesn't match what CQF_FHIR_CR_REFERENCE.md says works
- A schema migration would break existing data
- An AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance" reasons
- The plan would slip more than half a day

## Other docs to consult on demand
- @docs/archive/SPIKE_PLAN.md — archived sprint context
- @docs/DEPLOY.md — MIE Create-a-Container + Neon setup, env vars, rollback
- @docs/MEASURES.md — the TWH measure catalog (60 measures) in plain English
- @docs/ARCHITECTURE.md — system architecture diagrams + boundaries
- @docs/DATA_MODEL.md — schema invariants
- @docs/AI_GUARDRAILS.md — AI usage policy
- @docs/CQF_FHIR_CR_REFERENCE.md — proven library wiring from spike
- @README.md — quickstart

## Current Focus (as of 2026-06-16)

**The active track is the de-Java re-platform (#96) → the #109 deploy cutover, now on the Neon/Postgres fallback path. #150 demo-readiness is fully closed (all 21 items). #109 progress: PR1 (container entrypoint + image) is merged (#155); the store-selection seam (PR #156, open) makes the TS backend run on the existing Neon Postgres via the `Pg*Store` ceiling — proven end-to-end (42/42 Pg store tests, 422 backend-ts tests green on SQLite, full stack validated on Postgres in a container). Remaining cutover steps: evidence `BUCKET`, shadow deploy (`twh-api-ts`, Java untouched), blue-green flip, JVM retirement. Plan + resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`. The live stack is still 100% Java — nothing outward-facing has flipped.** (Strategic roadmap epics #71–#78 — E1 merged, E2 (#72) deferred behind the cutover.)

History (all on `main`):
- Sprints 0–6 → PRs #16–#22; eCQM + TWH instance support → PR #46
- Sprint 7 overdelivery (AI Draft CQL, AI Test Fixtures, Risk Scoring, MAT Export, Mobile Responsive) → issues #47–#51, closed
- Sprint 8 scoped-run parity: `SITE`/`EMPLOYEE` manual runs + rerun now route through the async run-job path
- CI test suite 3.8x faster via 8-way test sharding (44m → 11m30s) → PR #57
- MIE Container Manager deploy migrated to the v1 API envelope → PRs #55, #56
- Post-merge polish pass → PRs #60–#66: ADR-003, workwell.os redirect, CQL code-filter tightening, CMS125+CMS122 promoted to Active, compliance trend per-bucket chart, case code evidence explorer, SQL analogy panel
- `@mieweb/ui` frontend migration → PR #68; measures/programs/runs latency fix → PR #69; systemd + reboot-policy docs → PR #70
- **Roadmap Wave 1 — E1: reusable measure engine ports/adapters → PR #95** (epic #71 + sub-issues #79–#84, closed). `CqlEvaluationService` now runs behind `PatientDataProvider`/`EmployeeDirectory`/`MeasureDefinitionProvider`/`EvaluationConfigProvider`; synthetic adapters are the default (ADR-005). Roadmap epics tracked as issues #71–#78.
- **Demo-readiness (#150) — part 1 (PR #151) + H1 (PR #152) both merged + deployed.** A live QA pass found 21 defects/doc-mismatches. Part 1 shipped: frontend papercuts (H2/H3/M2/M3/M4/M7/M11/M12), **C2** CMS125/CMS122 promoted to Active (seeding-bug fix + CMS122 name reconciled to the modern "Glycemic Status Assessment Greater Than 9%" since the evaluator binds CQL by measure name), **C4** program rollups exclude single-subject CASE/EMPLOYEE reruns. **H1 (worklist flood) + M6 + D shipped in PR #152:** per-measure compliance-cycle case bucketing (nightly reruns idempotent), worklist defaults to each measure's current cycle, M6 `why_flagged` uses the measure's real compliance window, and **migration `V022` closed the ~5,019 pre-bucketing stale-period cases on live Neon**. The worklist's current-cycle definition is **date-driven + cadence-exact** (`bucketPeriod(measure, today)` per measure) — Java `CaseFlowService` row-value IN, `backend-ts` route JS filter (`bucketPeriodForMeasure`); this converged after 5 Codex review rounds (2 P1 + 1 P1 re-review + 5 P2, all resolved). Java↔`backend-ts` at parity. **#150 is now fully closed (all 21 items):** H4/M1/M5/M8 shipped in PR #153, and the M9/M10/M13 post-demo trio in PR #154 — both merged + deployed. Running narrative in `docs/JOURNAL.md`; plan in `docs/superpowers/plans/2026-06-15-issue-150-demo-readiness.md`.

Current posture:
- **Live URL:** `https://twh.os.mieweb.org` — login: `admin@workwell.dev` / `Workwell123!`
- **Deployment:** MIE Create-a-Container only (`deploy-twh-mieweb.yml`); triggers on every push to `main`. The earlier Fly.io + Vercel public-preview stack is decommissioned; MIE TWH is the sole live stack.
- **Measure catalog:** 60 total — 4 OSHA active (CQL), 3 OSHA catalog, 4 HEDIS wellness active (CQL), 2 CMS eCQM active (CMS125v14 breast cancer, CMS122v14 diabetes HbA1c), 47 CMS eCQM Draft entries; **10 runnable measures total**
- **Supported run scopes:** `ALL_PROGRAMS`, `MEASURE`, `SITE`, `EMPLOYEE`, `CASE`
- **Next up:** finish the **#109 deploy cutover** on the Neon/Postgres fallback path — evidence `BUCKET` (managed S3/R2 or defer), then the shadow deploy (`twh-api-ts` on its own hostname against Neon, live Java untouched), the blue-green flip (repoint the frontend; Java stays alive as instant rollback), and JVM retirement. Resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md` (STATUS UPDATE section at the top). E2 — declarative YAML measures + headless evaluator (#72) — is deferred behind the cutover. `docs/JOURNAL.md` carries the running narrative. (A fuller strategy roadmap and the open strategic questions for Doug are kept as local-only working files on the maintainer's machine, not committed to the repo.) NITRO data-grid is now **unblocked** — vendored `@mieweb/datavis` source under `frontend/vendor/datavis` + `datavis-ace` from npm; live on `/measures`, `/runs`, `/admin` (ADR-007). Remaining `@mieweb/ui` form-control swap split out as issue #99. (Asking Doug to publish a built `@mieweb/datavis` to npm so `vendor/` can be dropped is still pending.)
- Schema migrations are owned by Taleef — stop and ask before writing any `V0xx__*.sql` file
- Treat `docs/archive/SPIKE_PLAN.md` as historical context only
