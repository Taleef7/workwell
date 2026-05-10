# AGENTS.md — WorkWell Measure Studio

Operating manual for any AI coding agent (Claude Code, Codex, Cursor, etc.) working in this repo. CLAUDE.md mirrors this with Claude-specific notes.

## What this project is
- Single-developer Spring Boot + Next.js monorepo
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- Historical sprint window: May 2-17, 2026; active work is now post-merge maintenance and polish

## Read before any task
`@docs/archive/SPIKE_PLAN.md` is the archived sprint plan. Use `docs/JOURNAL.md` for the latest state and `README.md` for the public project overview.

`docs/archive/PROJECT_PLAN_v1.md` is archived. Do not act on it. But feel free to read it for more context on how we got here and what we're planning and building. It contains the original project proposal, initial architecture sketches, and early measure definitions that informed the spike plan.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: Java 21, Spring Boot 3.x, Gradle Kotlin DSL, PostgreSQL 16, Flyway
- CQL/FHIR: HAPI FHIR JPA + `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (see CQF_FHIR_CR_REFERENCE.md)
- Frontend: Next.js 14+ App Router, TypeScript, Tailwind, shadcn/ui, Monaco
- AI: Spring AI (Anthropic), MCP via `io.modelcontextprotocol/java-sdk`
- Infra: Docker Compose local; Fly.io + Vercel + Neon prod; GitHub Actions; pnpm

## Hard rules
- Avoid new dependencies unless they are explicitly approved and documented
- One Spring Boot app, modular packages — no microservices
- Spring Application Events + DB audit log — no Kafka or external streaming
- Stubbed auth — no production-grade auth in the demo stack
- Simulated email — no real delivery
- AI never decides compliance (docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes. Stop conditions and fallbacks documented in JOURNAL.md.
- Keep UI changes surgical; only bug fixes or explicitly requested polish

## Branch + ownership
- Backend agent owns `backend/` only
- Frontend agent owns `frontend/` only
- Schema migrations (`backend/src/main/resources/db/migration/`) are human-only — never delegated
- Use a feature branch for follow-up work
- Merge after human review — no auto-merge

## Definition of done (per PR)
- Tests pass; idempotency + audit invariants have real tests, rest is smoke-only
- CI green
- Affected docs updated in same PR (ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, DEPLOY)
- JOURNAL.md entry started for the day
- New ADR in DECISIONS.md if decision was non-obvious
- Commit format: `<type>(<scope>): <summary>` — keep it conventional and readable

## Working style
- Use plan mode for tasks touching >2 files
- Stop and confirm before destructive ops: `rm -rf`, force-push, schema drops, secret rotation
- Commit per logical unit, not per file
- Push to GitHub at least every 2 hours during active work
- If unsure, ask. Cost of asking < cost of building wrong.
- Prefer many small commits over few large ones

## File conventions
- Java packages: `com.workwell.<module>` (measure, valueset, compile, run, caseflow, audit, fhir, integrations, ai, mcp, notification, config, security, web)
- Frontend routes: `app/(dashboard)/...`
- Daily log: `docs/JOURNAL.md`, newest entry on top, dated YYYY-MM-DD
- Decisions: `docs/DECISIONS.md`, numbered ADRs

## Daily rhythm (human-facing, but agents should respect cadence)
- **Morning:** review `CLAUDE.md`, `docs/JOURNAL.md`, and task-specific docs before starting
- **Throughout:** keep changes small, update docs with behavior changes, verify what you touch
- **End of day:** make sure `docs/JOURNAL.md` reflects what changed

## Stop and ask if
- A spike's stop condition (in `docs/archive/SPIKE_PLAN.md`) appears to trigger
- A library version doesn't match what CQF_FHIR_CR_REFERENCE.md says works
- Schema migration would break existing data
- AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance"
- The plan would slip more than half a day

## Reference docs
- @docs/archive/SPIKE_PLAN.md
- @docs/DEPLOY.md
- @docs/MEASURES.md
- @docs/ARCHITECTURE.md
- @docs/DATA_MODEL.md
- @docs/AI_GUARDRAILS.md
- @docs/DECISIONS.md
- @docs/CQF_FHIR_CR_REFERENCE.md
- @README.md
