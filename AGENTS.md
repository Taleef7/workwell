# Repository Guidelines

## Project Structure & Module Organization
This repository is planned as a Spring Boot + Next.js monorepo. Canonical scope and architecture live in `docs/PROJECT_PLAN.md` (use this first).  
Current key docs:
- `docs/PROJECT_PLAN.md`: roadmap, tickets, constraints, stack
- `docs/MEASURES.md`: demo measure definitions
- `CLAUDE.md`: working rules and definition of done
- `graphify-out/`: generated knowledge graph artifacts

Target code layout (from plan):
- `backend/` for Java services (`com.workwell.<module>`)
- `frontend/` for Next.js App Router UI
- `docs/` for architecture, data model, AI guardrails, journal

## Build, Test, and Development Commands
Use the planned toolchain: Java 21, Node 20, pnpm, Docker Compose.

Typical commands (once scaffolded):
- `docker compose up` - start local stack (Postgres, HAPI FHIR, backend, frontend)
- `cd backend && ./gradlew test` - run backend unit/integration tests
- `cd backend && ./gradlew bootRun` - run Spring Boot API locally
- `cd frontend && pnpm dev` - run Next.js app locally
- `cd frontend && pnpm test` - run frontend tests

## Coding Style & Naming Conventions
- Java: package pattern `com.workwell.<module>` (e.g., `measure`, `run`, `caseflow`, `audit`).
- TypeScript/React: App Router under `app/(dashboard)/`.
- Use descriptive names: `MeasureVersion`, `RunSummary`, `AuditEvent`.
- Prefer small, focused modules; avoid cross-module leakage.
- Do not introduce new dependencies without explicit PR justification.

## Testing Guidelines
- Backend: JUnit 5 (+ Testcontainers where integration behavior matters).
- Frontend: standard Next.js/TypeScript test stack when scaffolded.
- Add tests for all behavior changes; prioritize idempotency-critical flows (case upsert, rerun determinism).
- Naming: mirror feature names (e.g., `MeasureLifecycleServiceTest`, `run-summary.spec.ts`).

## Commit & Pull Request Guidelines
- Commit format: `type(scope): summary [Ticket]` (example: `feat(measure): catalog CRUD [T1]`).
- Keep commits small and reviewable.
- PRs should include: purpose, linked ticket/issue, test evidence, and doc updates for affected areas.
- If UI changes, include screenshots; if design decisions are non-obvious, add an ADR entry in `docs/DECISIONS.md`.

## Security & Guardrails
- MVP constraints: no microservices, no Kafka, no production auth, no real email delivery.
- AI may draft/specify, but must never auto-decide compliance outcomes.
- Every state-changing workflow must write an `audit_event`.

## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Before answering architecture or codebase questions, read graphify-out/GRAPH_REPORT.md for god nodes and community structure
- If graphify-out/wiki/index.md exists, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code files in this session, run `graphify update .` to keep the graph current (AST-only, no API cost)
