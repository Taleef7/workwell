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
- Frontend: Next.js 14+ App Router + TypeScript + Tailwind + shadcn/ui + Monaco
- AI: Spring AI (Anthropic starter); MCP via `io.modelcontextprotocol/java-sdk`
- Infra: Docker Compose locally; Fly.io + Vercel + Neon for deploy; GitHub Actions CI; pnpm

## Hard rules
- Avoid new dependencies unless they are explicitly approved and documented
- One Spring Boot app, modular packages — no microservices
- Spring Application Events + DB audit log — no Kafka or external streaming
- Auth: user accounts remain hardcoded (no SSO, no real user directory). JWT refresh token flow (HttpOnly cookie, token rotation, `/api/auth/refresh`) is approved and implemented in Sprint 4 — this replaces the prior "stub auth only" constraint.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the default and must remain so on the demo stack. SendGrid wiring exists in the code (Sprint 6) but must not be activated unless `SENDGRID_API_KEY` is explicitly set in a non-demo environment.
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
- @docs/DEPLOY.md — Vercel + Fly + Neon setup, env vars, rollback
- @docs/MEASURES.md — the 4 demo measures in plain English
- @docs/ARCHITECTURE.md — system architecture diagrams + boundaries
- @docs/DATA_MODEL.md — schema invariants
- @docs/AI_GUARDRAILS.md — AI usage policy
- @docs/CQF_FHIR_CR_REFERENCE.md — proven library wiring from spike
- @README.md — quickstart

## Current Focus (as of 2026-05-21)

**All planned sprints merged. TWH consolidation complete. Sprint 7 (overdelivery) is next.**

Sprints merged (all into `main`):
- Sprint 0 (bugs) → PR #16
- Sprint 2 (data) → PR #17
- Sprint 1 (pipeline) → PR #18
- Sprint 3 (employee/SLA) → PR #19
- Sprint 4 (security) → PR #20
- Sprint 6 (admin) → PR #21
- Sprint 5 (tests/CI) → PR #22
- eCQM + TWH instance support → PR #46 (merged to main)

Post-merge work completed (all on `main`):
- Real-time run progress (spinner, live timer, auto-reload)
- AI integration health check fix (GET /v1/models)
- TWH consolidation: single MIE container, 47 CMS eCQMs seeded in catalog
- Fly.io decommissioned; MIE TWH is sole deployment

Current posture:
- **Live URL:** `https://twh.os.mieweb.org` — login: `admin@workwell.dev` / `Workwell123!`
- **Deployment:** MIE Create-a-Container only (`deploy-twh-mieweb.yml`); triggers on every push to `main`
- **Measure catalog:** 58 total — 4 OSHA active (CQL), 3 OSHA catalog, 4 HEDIS wellness active (CQL), 47 CMS eCQM Draft entries
- `main` is fully up to date; no open feature branches
- Schema migrations are owned by Taleef — stop and ask before writing any `V0xx__*.sql` file
- Sprint 7 spec is in `docs/sprints/SPRINT_07_overdelivery_features.md` — 5 issues (AI Draft CQL, AI Test Fixtures, Risk Scoring, MAT Export, Mobile Responsive)
- Treat `docs/archive/SPIKE_PLAN.md` as historical context only

