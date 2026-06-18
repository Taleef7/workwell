# AGENTS.md — WorkWell Measure Studio

Operating manual for any AI coding agent (Claude Code, Codex, Cursor, etc.) working in this repo. CLAUDE.md mirrors this with Claude-specific notes.

## What this project is
- Single-developer Next.js + TypeScript-backend (`backend-ts/`) monorepo. The original Java/Spring Boot backend was **retired** in #109 PR4 (`backend/` deleted) — `backend-ts` is the sole backend.
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- Phase (as of 2026-06-17): all planned sprints (0–7) are merged. **The #109 de-Java cutover is COMPLETE and the JVM is retired** — `twh.os.mieweb.org` is served by the TypeScript backend (`backend-ts/` → `twh-api-ts.os.mieweb.org`); rollback is redeploying an earlier `twh-api-ts` `sha-<SHA>`. See `CLAUDE.md` → Current Focus and `docs/JOURNAL.md` for the running status. `docs/sprints/` is historical context now, not an active queue.

## Read before any task
1. `docs/JOURNAL.md` — latest state of the project (newest entry on top). This is the current source of truth.
2. `CLAUDE.md` — current focus, hard rules, and build/verify commands
3. `README.md` — public project overview and API surface
4. `docs/sprints/README.md` — historical sprint index (all sprints merged; reference only)

`docs/archive/SPIKE_PLAN.md` and `docs/archive/PROJECT_PLAN_v1.md` are historical only — do not act on them.

## Feature work protocol
- Planned sprint work (0–7) is complete; new work is post-merge polish or follow-up features
- Work **one task at a time**; keep changes small and focused
- Where a sprint file defined acceptance criteria, every box must still pass before that work is considered done
- Create a feature branch per task: `fix/<slug>` or `feat/<slug>`
- Open a PR for review per task — do not batch unrelated changes; tightly coupled changes (e.g., a migration + the service that uses it) may share a PR
- **Stop and ask** before starting a new workstream — Taleef reviews before proceeding
- Update `docs/JOURNAL.md` with a dated entry for everything that ships

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived node-24 host; JVM-free CQL→ELM (build-time); PostgreSQL 16 (Neon, `Pg*Store` ceiling, `workwell_spike` schema; SQLite floor for tests/local). The Java/Spring backend was retired in #109 PR4 (ADR-008).
- CQL/FHIR: `@cqframework/cql` (JVM-free CQL→ELM build step) + `cql-execution` / `cql-exec-fhir` at runtime. The Java `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 path is history (CQF_FHIR_CR_REFERENCE.md).
- Frontend: Next.js 16 App Router + React 19, TypeScript, Tailwind 4, `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher; see ADR-004), Monaco. Import `@mieweb/ui` only from `"use client"` modules.
- AI: OpenAI via the `backend-ts` AI surfaces (deterministic fallbacks); MCP read-only tools served from the worker.
- Infra: MIE Create-a-Container + Neon prod (Fly.io + Vercel preview decommissioned — MIE TWH is the sole live stack); GitHub Actions CI + a self-heal reconciler; pnpm

## Hard rules
- Avoid new dependencies unless explicitly approved — if a sprint file calls for a dependency, it is pre-approved; anything else requires asking first
- One `backend-ts` app (`@mieweb/cloud` worker), modular packages — no microservices
- Application events + append-only DB audit log — no Kafka or external streaming
- Auth: JWT refresh token flow (HttpOnly cookie, token rotation, `/api/auth/refresh`) is approved and specified in Sprint 4. User accounts remain hardcoded — no SSO, no real user directory.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the mandatory default on the demo stack. Do not set `WORKWELL_EMAIL_SENDGRID_API_KEY` in any demo environment config.
- AI never decides compliance (docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes — if something in a sprint file doesn't match the codebase, stop and report before proceeding
- **Schema/DDL is owned by Taleef.** It is now the self-creating `workwell_spike` schema (`backend-ts/src/stores/postgres/schema-pg.ts` + the SQLite floor `schema.ts`); the old Java Flyway migrations were deleted with `backend/` in #109 PR4. Propose DDL changes and show them for approval — never edit those schema files autonomously without explicit instruction.

## Branch + ownership
- Backend agent owns `backend-ts/` only — never touch `frontend/`
- Frontend agent owns `frontend/` only — never touch `backend-ts/`
- Schema/DDL (`backend-ts/src/stores/postgres/schema-pg.ts` + the SQLite floor `schema.ts`) is Taleef-only — propose the change and present it; never edit autonomously
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
