# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer Spring Boot + Next.js monorepo
- Goal: stakeholder demo + internal pilot path + open-source reference
- 13-week project (May 18 – Aug 14, 2026)

## Read first, every session
@docs/PROJECT_PLAN.md is the canonical scope, schedule, tech stack, tickets, and AI guardrails. If anything here conflicts with the plan, the plan wins. Always check §12 "13-Week Roadmap" to confirm which phase we're in before starting work.

## Tech stack (immutable without an ADR in docs/DECISIONS.md)
- Backend: Java 21 + Spring Boot 3.x + Gradle Kotlin DSL + PostgreSQL 16 + Flyway
- CQL/FHIR: HAPI FHIR JPA + `org.opencds.cqf.fhir:cqf-fhir-cr`
- Frontend: Next.js 14+ App Router + TypeScript + Tailwind + shadcn/ui + Monaco
- AI: Spring AI (Anthropic starter); MCP via `io.modelcontextprotocol/java-sdk`
- Infra: Docker Compose; GitHub Actions CI; pnpm

## Hard "do nots" (MVP)
- No microservices — one Spring Boot app with modular packages
- No Kafka or external event streaming — Spring Application Events + DB audit log
- No production-grade auth — stubbed roles only
- No real email delivery — simulate
- No new dependency without justification in the PR description
- No AI auto-deciding compliance (see plan §18)
- No bypassing the audit log — every state change writes an `audit_event`

## Definition of done (every PR)
- Tests pass (unit + integration where touched)
- CI green
- Relevant docs updated (ARCHITECTURE.md, DATA_MODEL.md, MEASURES.md as applicable)
- `docs/JOURNAL.md` entry for the day
- ADR added to `docs/DECISIONS.md` if the choice was non-obvious
- Idempotency-critical changes (case upsert, rerun behavior) have explicit tests

## Working style
- Use plan mode for any task touching >2 files
- Confirm before destructive actions (`rm`, force-push, migration drops)
- Commit messages reference ticket: `feat(measure): catalog CRUD [T1]`
- Ask before guessing — the cost of asking is way less than the cost of building wrong
- Prefer many small commits over few large ones

## File conventions
- Java packages: `com.workwell.<module>` (measure, valueset, compile, run, caseflow, audit, fhir, integrations, ai, mcp, notification, config, security, web)
- Frontend routes under `app/(dashboard)/`
- Daily log: `docs/JOURNAL.md` (newest entry on top, dated YYYY-MM-DD)
- Decisions: `docs/DECISIONS.md` (numbered ADRs, dated)

## Other docs to consult on demand
- @docs/MEASURES.md — the 4 demo measures in plain English
- @docs/ARCHITECTURE.md — system architecture diagrams + boundaries
- @docs/DATA_MODEL.md — schema invariants
- @docs/AI_GUARDRAILS.md — AI usage policy
- @README.md — quickstart

## Current focus
Update this section before each session, or ask Claude to update it when phase changes.

**Today:** Pre-internship prep (Apr 29 – May 17). Internship Week 1 starts May 18 with Phase 0 (foundation) per plan §13.