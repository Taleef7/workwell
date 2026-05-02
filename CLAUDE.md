# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer Spring Boot + Next.js monorepo
- Goal: ship full WorkWell Measure Studio MVP scope by May 17, 2026, before internship starts May 18
- 16-day pre-internship sprint, two agents in parallel + me reviewing

## Read first, every session
`@docs/SPIKE_PLAN.md` is the canonical scope, schedule, daily rhythm, risks, rollback rules. If anything here conflicts with the spike plan, the plan wins. Always check the schedule table to confirm which spike we're in before starting work.

`docs/archive/PROJECT_PLAN_v1.md` is archived. Do not act on it. But feel free to read it for more context on how we got here and what we're planning and building. It contanins the original project proposal, initial architecture sketches, and early measure definitions that informed the spike plan.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: Java 21 + Spring Boot 3.x + Gradle Kotlin DSL + PostgreSQL 16 + Flyway
- CQL/FHIR: HAPI FHIR JPA + `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (see CQF_FHIR_CR_REFERENCE.md)
- Frontend: Next.js 14+ App Router + TypeScript + Tailwind + shadcn/ui + Monaco
- AI: Spring AI (Anthropic starter); MCP via `io.modelcontextprotocol/java-sdk`
- Infra: Docker Compose locally; Fly.io + Vercel + Neon for deploy; GitHub Actions CI; pnpm

## Hard rules (16-day sprint)
- No new dependencies after D5 (May 6, 2026)
- One Spring Boot app, modular packages — no microservices
- Spring Application Events + DB audit log — no Kafka or external streaming
- Stubbed auth — no production-grade auth this sprint
- Simulated email — no real delivery
- AI never decides compliance (see docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes. If a stop condition triggers, document fallback in JOURNAL.md.
- No UI changes after D14 EOD except bug fixes

## Branch + ownership
- Backend agent owns `backend/` only
- Frontend agent owns `frontend/` only
- Schema migrations (`backend/src/main/resources/db/migration/`) are mine, never delegated
- Feature branch per spike: `spike/s2-catalog`, etc.
- Merge after my review — no auto-merge

## Definition of done (every PR)
- Tests pass (idempotency + audit invariants are mandatory; rest smoke-only)
- CI green
- Affected docs updated in same PR (ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, DEPLOY)
- JOURNAL.md entry started for the day
- ADR added to DECISIONS.md if non-obvious
- Conventional commit with spike tag: `feat(measure): catalog CRUD [S2]`

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
- **Morning (15 min):** update Current focus below, brief agents, open JOURNAL.md skeleton
- **Throughout:** commit per ticket, push every 2h
- **End of day (30–45 min):** finalize JOURNAL.md, update affected docs, record YT short if UI changed visibly

Doc PR ships with code PR. Always.

## Stop and ask if
- A spike's stop condition (in SPIKE_PLAN.md) appears to trigger
- A library version doesn't match what CQF_FHIR_CR_REFERENCE.md says works
- A schema migration would break existing data
- An AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance" reasons
- The plan would slip more than half a day

## Other docs to consult on demand
- @docs/SPIKE_PLAN.md — 16-day schedule, per-spike acceptance, risks, rhythm
- @docs/DEPLOY.md — Vercel + Fly + Neon setup, env vars, rollback
- @docs/MEASURES.md — the 4 demo measures in plain English
- @docs/ARCHITECTURE.md — system architecture diagrams + boundaries
- @docs/DATA_MODEL.md — schema invariants
- @docs/AI_GUARDRAILS.md — AI usage policy
- @docs/CQF_FHIR_CR_REFERENCE.md — proven library wiring from spike
- @README.md — quickstart

## Current focus

Update before each session.

**Today:** D2 prep (Sat May 2, 2026) - begin S0 walking skeleton execution: ship /api/eval, wire frontend probe, and line up Fly + Vercel + Neon PG16 verification.

**Next:** D2 (Sun May 3, 2026) - finish deployed end-to-end S0 verification, then move to D3 S1a Audiogram vertical.

