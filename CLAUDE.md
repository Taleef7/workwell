# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer TypeScript + Next.js monorepo (re-platformed off Java/Spring — ADR-008)
- A clinical-quality-measure engine for MIE's WebChart. The active work is the Maui pilot sandbox — see "Current focus"

## Read first, every session
The GitHub milestone **"Ready for January"** (`gh issue list --milestone "Ready for January"`) is the work.
`docs/JOURNAL.md` (newest entry on top) is the short log of recent changes; `README.md` is the public overview.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived node-24 host; JVM-free CQL→ELM (build-time); PostgreSQL 16 (Neon, `Pg*Store` ceiling, `workwell_spike` schema; SQLite floor for tests/local)
- Frontend: Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + `@mieweb/ui` (ADR-004) + Monaco
- AI: OpenAI via the backend-ts AI surfaces (deterministic fallbacks); MCP read-only tools served from the worker
- Infra: MIE Create-a-Container + Neon (the TWH and Maui stacks are live); GitHub Actions CI + a self-heal reconciler; pnpm

## Build & verify
- Backend: `cd backend-ts; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test` (SQLite floor; the Pg-ceiling store contract runs against a local `postgres:16`, else self-skips). Gated in `ci.yml`.
  - CI shards `pnpm test` across three runners (`scripts/test-shards.mjs`). A **new Pg-dependent test file must live under `src/stores/postgres/`**, or `pnpm test:shards:verify` fails the build.
- Frontend: `cd frontend; npm run lint; npm run build`
- Run the app: backend `cd backend-ts; pnpm dev`; frontend `npm run dev`

## Hard rules
- Avoid new dependencies unless they are explicitly approved and documented
- One backend-ts worker, modular `src/` packages — no microservices
- Application events + direct DB audit log (`audit_events` via the store layer) — no Kafka or external streaming
- Auth: user accounts remain hardcoded (no SSO, no real user directory). The JWT refresh flow (HttpOnly cookie, rotation, `/api/auth/refresh`) is approved and implemented.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the default and must remain so on the demo stacks. SendGrid must not be activated unless `WORKWELL_EMAIL_SENDGRID_API_KEY` is set (with `WORKWELL_EMAIL_PROVIDER=sendgrid`) in a non-demo environment.
- AI never decides compliance (see docs/AI_GUARDRAILS.md). The CQL engine is the sole source of truth.
- Every state change writes an `audit_event` — the rule, **not yet everywhere true (#598, open)**. Write new code **audit-first** (the event before the mutation). Some paths are still mutate-first: run-boundary ones by design, outreach and the identity links pending owner decisions — `DATA_MODEL_CONTRACTS` §4 lists them. #598 stays open until the cross-store `applyCaseAction` primitive exists.
- No silent scope changes; if a plan's stop condition triggers, record the fallback in JOURNAL.md
- Schema migrations are owned by Taleef — never written or applied by an agent without explicit instruction

## Branch + ownership
- Schema/DDL is Taleef's, never delegated — `backend-ts/src/stores/postgres/schema-pg.ts` + the SQLite floor `schema.ts`
- Feature branch per task, named `feat/<slug>` or `fix/<slug>`; one PR per task (tightly coupled changes may share one)
- Merge after Taleef's review — no auto-merge

## Definition of done (every PR)
- Tests pass (idempotency + audit invariants are mandatory; rest smoke-only) and CI is green
- A doc is updated only where the behaviour it describes changed
- A few lines in `docs/JOURNAL.md`
- Conventional commit with a clear scope: `fix(worklist): …`

## Working style
- Plan mode for any task touching >2 files
- Confirm before destructive ops (`rm -rf`, force-push, schema drops, secret rotation)
- Ask before guessing — cost of asking < cost of building wrong

## Stop and ask if
- A new workstream is about to start
- A schema migration would break existing data
- An AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance" reasons

## Always-loaded docs (`@`-imported — keep this list small)
- @docs/AI_GUARDRAILS.md — the "AI never decides compliance" rule. Prompt templates are on demand in `docs/AI_PROMPTS.md`
- @docs/DATA_MODEL_CONTRACTS.md — idempotency + `evidence_json` + CSV contracts, mandatory on every PR
- @docs/ADR_INDEX.md — ADR titles only; the entries are in DECISIONS.md
- @docs/LOCKED_DECISIONS.md — owner-locked decisions (§4, §4A)

## Other docs, on demand
- `docs/guide/` — the readable explanation of the whole system (10 chapters)
- `docs/DECISIONS.md` — every ADR, condensed; an `ADR-0NN` or `ADR-0NN dN` reference anywhere resolves there
- `docs/ROADMAP_2026-08-30.md` — the approved plan (the Maui pilot). `docs/ROADMAP_2026-08-04.md` keeps only its §4 verification set (still the bar, locked decision 2) and §6
- `docs/OPEN_QUESTIONS.md` — questions waiting on the pilot group, the ACO or the owner
- `docs/DEPLOY.md` + `docs/BACKUP_DR_RUNBOOK.md` — the runbooks → prefer the `deploy` skill
- `docs/ARCHITECTURE.md` — the compact module/boundary reference
- `docs/MEASURES.md` — the measure catalog in plain English
- `docs/COMPLIANCE_API.md`, `docs/PACKAGES.md`, `docs/CDS_HOOKS.md`, `docs/MCP.md` — the external surfaces. Read before changing anything they name
- `docs/STANDARDS_CONFORMANCE.md` — what we may and may not claim → prefer the `conformance` skill
- `docs/WEBCHART_API_ASSUMPTIONS_2026-07.md` + `docs/WEBCHART_FHIR_MAPPING.md` → prefer the `webchart` skill
- `docs/PRODUCTION_READINESS_2026-07.md` — PHI/HIPAA posture and the production gap list (#261)
- Table schemas: `backend-ts/src/stores/postgres/schema-pg.ts` (the SQLite floor mirrors it)

`docs/archive/` was deleted on 2026-09-23. A reference to it anywhere (code comments, old docs) resolves
from git history: `git show before-docs-trim:docs/archive/<file>`.

## Current focus
**The Maui pilot sandbox, before PY2027 starts on 2027-01-01.** The work is the "Ready for January"
milestone; asks blocked on MIE, the practice or the ACO carry the `waiting` label; minor findings are the
checklist in #655. The plan is `docs/ROADMAP_2026-08-30.md` (ADR-070) and the owner decisions are
`LOCKED_DECISIONS.md` §4A. The sandbox routes all six ACO measures — cms122, cms125, cms2, cms130, cms165,
cms137 (ADR-078). It is a sandbox: the pilot's real-data (PHI) phase is a separate decision gated by
`PRODUCTION_READINESS`. Naming policy: repo documents say "Maui" and "the pilot group" only.

## Standing corrections
Each is a claim the project got wrong once and would otherwise repeat.
1. **The CMS FHIR-reporting timeline is an RFI.** The CY2027 PFS proposed rule (CMS-1848-P) *seeks comment
   on* FHIR reporting voluntary PY2028–29, mandatory PY2030 for applicable APP Plus measures. Cite it as
   **sought comment on**, never as proposed or final (final rule ~Nov 2026). MIPS CQMs are proposed to be
   **extended** for PY2027+; sunsetting traditional MIPS after PY2028 is a *different* proposal. The same
   rule proposes removing Quality IDs 305 (CMS137) and 493 from APP Plus for PY2027.
2. **"QI-Core STU7 = US Core 7 = WebChart's exact surface" is half right.** CMS's shipping content is
   authored on QI-Core 6; the direction of travel is US Quality Core 0.5.0 over US Core 6.1.0.
3. **Cypress CVU+ is not the verification bar.** The bar is the FHIR-column verification set
   (`ROADMAP_2026-08-04.md` §4, locked decision 2).

Two conformance-harness traps: `cqf-fhir-cr` retrieval is QI-Core **`meta.profile`-sensitive** (an
unstamped resource is silently never retrieved), and `$evaluate-measure` **caches per subject for the
server's life**, so every changed input needs a fresh container.
