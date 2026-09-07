# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer TypeScript + Next.js monorepo (backend re-platformed off Java/Spring — ADR-008; the JVM was retired in #109 PR4)
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- The active spearhead is the Maui pilot — see "Current focus" below

## Read first, every session
`docs/JOURNAL.md` (newest entry on top) is the source of truth for recent work; `README.md` is the
public-facing overview. `docs/archive/SPIKE_PLAN.md` and `docs/archive/PROJECT_PLAN_v1.md` are archived
sprint context — read them for background, never act on them.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived node-24 host; JVM-free CQL→ELM (build-time); PostgreSQL 16 (Neon, `Pg*Store` ceiling, `workwell_spike` schema; SQLite floor for tests/local)
- Frontend: Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher; ADR-004) + Monaco
- AI: OpenAI via the backend-ts AI surfaces (deterministic fallbacks); MCP read-only tools served from the worker
- Infra: MIE Create-a-Container + Neon (the MIE TWH and Maui stacks are the live ones; Fly.io + Vercel are decommissioned); GitHub Actions CI + a self-heal reconciler; pnpm

## Build & verify
- Backend: `cd backend-ts; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test` (SQLite floor; the Pg-ceiling store contract runs against a local `postgres:16`, else self-skips). Gated in `ci.yml`.
- Frontend: `cd frontend; npm run lint; npm run build`
- Run the app: backend `cd backend-ts; pnpm dev`; frontend `npm run dev`

## Hard rules
- Avoid new dependencies unless they are explicitly approved and documented
- One backend-ts worker, modular `src/` packages — no microservices
- Application events + direct DB audit log (`audit_events` via the store layer) — no Kafka or external streaming
- Auth: user accounts remain hardcoded (no SSO, no real user directory). The JWT refresh token flow (HttpOnly cookie, token rotation, `/api/auth/refresh`) is approved and implemented.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the default and must remain so on the demo stack. SendGrid wiring exists in the code but must not be activated unless `WORKWELL_EMAIL_SENDGRID_API_KEY` is explicitly set (with `WORKWELL_EMAIL_PROVIDER=sendgrid`) in a non-demo environment.
- AI never decides compliance (see docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes. If a stop condition triggers, document fallback in JOURNAL.md.
- Schema migrations are owned by Taleef — never written or applied by an agent without explicit instruction

## Branch + ownership
- Backend agent owns `backend-ts/` only
- Frontend agent owns `frontend/` only
- Schema/DDL is mine, never delegated — the self-creating `workwell_spike` schema (`backend-ts/src/stores/postgres/schema-pg.ts` + the SQLite floor `schema.ts`)
- Use a feature branch per task, named `feat/<slug>` or `fix/<slug>`
- Merge after my review — no auto-merge
- Work **one task at a time**; keep changes small and focused
- One PR per task — do not batch unrelated changes. Tightly coupled changes (e.g. a schema change
  plus the service that uses it) may share a PR

## Definition of done (every PR)
- Tests pass (idempotency + audit invariants are mandatory; rest smoke-only)
- CI green
- Affected docs updated in same PR (docs/guide/ chapters, ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, DEPLOY)
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
- backend-ts modules: `backend-ts/src/<area>/` (measure, run, case, audit, fhir, engine, mcp, ai, admin, program, export, auth, config, stores, routes)
- Frontend routes under `app/(dashboard)/`
- Daily log: `docs/JOURNAL.md` (newest entry on top, dated YYYY-MM-DD)
- Decisions: `docs/DECISIONS.md` (numbered ADRs, dated)

## Daily rhythm
- **Morning:** review `docs/JOURNAL.md` and the current focus block before starting
- **Throughout:** keep changes small and verify what you touch
- **End of day:** make sure `docs/JOURNAL.md` and affected docs are current

## Stop and ask if
- A new workstream is about to start — I review before you proceed
- A spike's stop condition (in `docs/archive/SPIKE_PLAN.md`) appears to trigger
- A schema migration would break existing data
- An AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance" reasons
- The plan would slip more than half a day

## Always-loaded docs (`@`-imported — keep this list small)
Each is load-bearing for a rule above: a rule whose criteria live in an unread file is unenforceable,
and its absence is **silent**. Do not add to this list without deleting from it. **The test for a line
in any of these files is whether a session must not silently contradict it** — history, dated snapshots
and retellings of `DECISIONS.md` / `JOURNAL.md` fail it and come out whole; a rule is never compressed
to save tokens.
- @docs/AI_GUARDRAILS.md — the "AI never decides compliance" hard rule lives or dies on this. The verbatim prompt templates, model config and audit payload fields are on demand in `docs/AI_PROMPTS.md`
- @docs/DATA_MODEL_CONTRACTS.md — idempotency + `evidence_json` + CSV contracts; Definition of Done makes these mandatory on EVERY PR
- @docs/ADR_INDEX.md — ADR titles only, so a session knows a decision exists; bodies stay in DECISIONS.md
- @docs/LOCKED_DECISIONS.md — owner-locked decisions only (§4 per ADR-058, §4A per ADR-070)

## Other docs to consult on demand
Read these when the task needs them. They are deliberately NOT `@`-imported.
- `docs/guide/` — **the maintained explanation of the whole system** (10 chapters, mermaid per flow; ADR-066). The Definition of Done includes updating the affected chapter when behaviour it describes changes. Chapter 9 owns the volatile numbers, dated
- `docs/JOURNAL.md` — the running narrative; source of truth for recent work. Older months live **verbatim** in `docs/archive/JOURNAL_<period>.md`
- `docs/DECISIONS.md` — the ADR bodies that still GOVERN. 14 superseded/finding bodies live in `docs/archive/DECISIONS_ARCHIVE.md`; every heading + a one-line pointer stays in `DECISIONS.md`, so an `ADR-0NN` reference anywhere still resolves
- `docs/ROADMAP_2026-08-30.md` — **the APPROVED active plan** (the Maui pilot). `docs/ROADMAP_2026-08-04.md` is superseded as direction but **stays in docs/**: its §4 verification set remains the bar (locked decision 2). `docs/archive/ROADMAP_2026-07-24.md` is kept only for its §7 target architecture — **do not act on it**
- `docs/PROPOSALS_2026-08.md` — feature proposals awaiting owner/MIE review. **None is approved or scheduled** — read it to know an idea has been written down, never as a work queue
- `docs/DEPLOY.md` — MIE Create-a-Container + Neon setup, env vars, rollback, the flip runbook → prefer the `deploy` skill
- `docs/ARCHITECTURE.md` — system architecture + boundaries (the engine boundary is enforced mechanically by containment and boundary tests, so CI catches drift)
- `docs/DATA_MODEL.md` — §1–3: scope, core tables, full table schemas (derivable from `schema-pg.ts` / `schema.ts`)
- `docs/MEASURES.md` — the measure catalog in plain English, including the pilot's official measures and their flip blockers
- `docs/COMPLIANCE_API.md` + `docs/PACKAGES.md` — the versioned HTTP surface (ADR-061) and the published `@work-well/*` library surface. Read them before changing anything either one names
- `docs/STANDARDS_CONFORMANCE.md` — what we may and may not claim to conform to → prefer the `conformance` skill
- `docs/WEBCHART_API_ASSUMPTIONS_2026-07.md` + `docs/WEBCHART_FHIR_MAPPING.md` — Variant A is BUILT, Variant B is documented-not-built → prefer the `webchart` skill
- `docs/MCP.md` — MCP security boundary + tool posture → prefer the `mcp` skill
- `docs/PRODUCTION_READINESS_2026-07.md` — PHI/HIPAA posture, environment split, auth fork, tenancy, and the ordered production gap list (#261)
- `docs/CDS_HOOKS.md` — the card surface and its refusals (ADR-067)

## Do NOT read these unless I ask
Dated, write-once records of finished work. They are history, not instructions, and reading them burns
context without changing what you should do. Consult `docs/JOURNAL.md` for what happened instead.
- `docs/archive/superpowers/plans/` and `docs/archive/superpowers/specs/`
- `docs/archive/sprints/` (sprints 0–7, all merged)
- `docs/archive/DECISIONS_ARCHIVE.md` — read a single ADR when a pointer in `DECISIONS.md` sends you there; never the file
- the rest of `docs/archive/` — everything dated, superseded or finished lives there (ADR-066)

## Current focus (as of 2026-09-07)
**The Maui pilot (milestone M-M) is the spearhead.** `docs/ROADMAP_2026-08-30.md` is the APPROVED active
plan, ADR-070 drives it, and the owner decisions are `LOCKED_DECISIONS.md` §4A — read those, not a
retelling. Naming policy: repo documents say "Maui" and "the pilot group" only.
- **MM-0 shipped** (#496–#500). **MM-1 is in progress:** U1 (#526, ADR-072 — the runnable rule, the
  calendar measurement period, the flip gate) and U2 (#528, ADR-073/074/075 — the 20,000-patient
  corpus, multi-rate execution, outcome retention) merged 2026-09-05/06. Maui routes cms122 + cms125;
  cms2, cms130, cms165 and cms137 are `official-pending` until MM-1c's second-engine sweep and a
  `flip-gate` run clear each one. **No known-unverified measure is routed to the pilot**, the flip is a
  reviewed workflow edit (ADR-045), and **cms165 must not be routed** until real blood pressures are
  profile-stamped at ingest (ADR-076 d1 made profile trust per-measure, which is half the fix;
  `MEASURES.md` and issue #533 carry the other half). U3 (#529) and the MM-1 open-flag work of
  2026-09-07 (ADR-076, issues #530–#537) are the newest entries — read `docs/JOURNAL.md`, not this line.
- MM-2/3/4 are blocked on externals (ROADMAP §7). The milestones deliver a **sandbox**; the pilot's
  production/PHI phase is a separate `PRODUCTION_READINESS`-gated decision nothing in M-M authorizes.
- M-C (packaging) is complete and published; M-E1 (occupational content) is deferred behind M-M, not
  cancelled (locked decision 6). Open threads live in the newest JOURNAL entry's "still owner-owned"
  line and in GitHub issues, not here.

## Standing corrections
Each is a claim the project got wrong once and would otherwise repeat.
1. **The CMS FHIR-reporting timeline is CMS-attributable but PROPOSED.** The CY2027 PFS proposed rule
   (CMS-1848-P, July 2026) *seeks comment on* a two-year transition — FHIR reporting voluntary
   PY2028–29, mandatory PY2030 for applicable APP Plus measures, MIPS CQMs sunsetting ~PY2030. Cite it
   as proposed/under comment, **never as final** (final rule ~Nov 2026). The same rule proposes removing
   Quality IDs 305 (CMS137) and 493 from APP Plus for PY2027.
2. **"QI-Core STU7 = US Core 7 = WebChart's exact surface" is half right.** The equality holds, but
   **CMS's shipping content is authored on QI-Core 6**, and the direction of travel is US Quality Core
   0.5.0 over US Core 6.1.0.
3. **"Cypress CVU+ is the verification bar" is removed.** The bar is the FHIR-column verification set
   (`ROADMAP_2026-08-04.md` §4, locked decision 2).

Two traps from the conformance harness, invisible until they have wasted an afternoon: `cqf-fhir-cr`
retrieval is QI-Core **`meta.profile`-sensitive** — an unstamped hand-PUT resource is silently never
retrieved — and `$evaluate-measure` **caches per subject for the server's life**, so every changed input
needs a fresh container.

## History
Status blocks and milestone tables that used to sit here were removed (2026-07-29, 2026-09-01,
2026-09-06) because they retold, in less detail, what `docs/JOURNAL.md`, `docs/DECISIONS.md` and the
roadmap hold authoritatively. The removed text is recoverable from git (`git show 5f29d373:CLAUDE.md`
for the 2026-06→08 blocks, `git show 598ff25c:CLAUDE.md` for the 2026-08-30 Current Focus block).
