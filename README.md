# WorkWell Measure Studio

WorkWell Measure Studio is a Spring Boot + Next.js monorepo scaffold for Summer 2026.
The current implementation focus is backend foundation, evaluation plumbing, and CI stability.

## Current Status

- Backend scaffold in place (`Spring Boot 3.3.5`, `Java 21`)
- Database migration baseline present (`Flyway V001`)
- JPA wiring and OpenAPI scaffolding configured
- MapStruct mapper setup configured
- Testcontainers-backed backend context test wired for local + CI

## Repository Layout

- `backend/` - Spring Boot service
- `frontend/` - Next.js app scaffold
- `docs/` - plan, journal, architecture, and research notes

## Local Development

### Backend

```bash
cd backend
./gradlew build
```

### Frontend

```bash
cd frontend
pnpm install
pnpm lint
```

## CI

GitHub Actions runs a two-job pipeline:

- `backend`: Java setup + `./gradlew build`
- `frontend`: Node setup + `pnpm install --frozen-lockfile` + `pnpm lint`

## Project Plan

See `docs/PROJECT_PLAN.md` for roadmap, scope, and architectural constraints.
