# AGENTS.md — WorkWell Measure Studio

Operating manual for any AI coding agent (Claude Code, Codex, Cursor, etc.) working in this repo. CLAUDE.md mirrors this with Claude-specific notes.

## What this project is
- Single-developer Spring Boot + Next.js monorepo
- Goal: implement the gaps and improvements identified in `docs/sprints/` to showcase and overdeliver on the project's original vision
- Build phase: sprint-based feature implementation — see `docs/sprints/README.md` for the ordered work queue

## Read before any task
1. `docs/sprints/README.md` — sprint index and critical path. This is your active work queue.
2. The specific sprint file for the issue you're working on (e.g., `docs/sprints/SPRINT_00_critical_demo_fixes.md`)
3. `docs/JOURNAL.md` — latest state of the project
4. `README.md` — public project overview and API surface

`docs/archive/SPIKE_PLAN.md` and `docs/archive/PROJECT_PLAN_v1.md` are historical only — do not act on them.

## Sprint execution protocol
- Work **one sprint at a time**, in the order defined in `docs/sprints/README.md`
- Within a sprint, work **one issue at a time** from top to bottom
- Every issue has an **Acceptance Criteria** checklist — every box must pass before the issue is done
- Create a feature branch per issue: `fix/sprint-0-<slug>` or `feat/sprint-1-<slug>`
- Open a PR for review after each issue — do not batch multiple issues into one PR unless they are tightly coupled (e.g., a migration + the service that uses it)
- **Stop and ask** before starting the next sprint — Taleef reviews before proceeding
- Update `docs/JOURNAL.md` with a dated entry for everything that ships

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: Java 21, Spring Boot 3.x, Gradle Kotlin DSL, PostgreSQL 16, Flyway
- CQL/FHIR: HAPI FHIR JPA + `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (see CQF_FHIR_CR_REFERENCE.md)
- Frontend: Next.js 14+ App Router, TypeScript, Tailwind, shadcn/ui, Monaco
- AI: Spring AI (Anthropic), MCP via `io.modelcontextprotocol/java-sdk`
- Infra: Docker Compose local; Fly.io + Vercel + Neon prod; GitHub Actions; pnpm

## Hard rules
- Avoid new dependencies unless explicitly approved — if a sprint file calls for a dependency, it is pre-approved; anything else requires asking first
- One Spring Boot app, modular packages — no microservices
- Spring Application Events + DB audit log — no Kafka or external streaming
- Auth: JWT refresh token flow (HttpOnly cookie, token rotation, `/api/auth/refresh`) is approved and specified in Sprint 4. User accounts remain hardcoded — no SSO, no real user directory.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the mandatory default on the demo stack. Do not set `SENDGRID_API_KEY` in any demo environment config.
- AI never decides compliance (docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes — if something in a sprint file doesn't match the codebase, stop and report before proceeding
- **Schema migrations are owned by Taleef.** Write the SQL and show it for approval — never run `flyway migrate` autonomously or create a `V0xx__*.sql` file and apply it without explicit instruction.

## Branch + ownership
- Backend agent owns `backend/` only — never touch `frontend/`
- Frontend agent owns `frontend/` only — never touch `backend/`
- Schema migrations (`backend/src/main/resources/db/migration/`) are Taleef-only — write the SQL and present it; never apply autonomously
- Branch naming: `fix/sprint-0-<slug>`, `feat/sprint-1-<slug>`, etc.
- One PR per issue (or tightly coupled issue pair); merge after Taleef reviews
- No auto-merge under any circumstances

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
