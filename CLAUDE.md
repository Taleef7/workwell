# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer TypeScript + Next.js monorepo (backend re-platformed off Java/Spring — #96 / ADR-008; JVM retired in #109 PR4)
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- Historical sprint window: May 2-17, 2026; active work is now post-merge closeout and polish

## Read first, every session
`docs/archive/SPIKE_PLAN.md` is the archived sprint plan and historical context. `docs/JOURNAL.md` is the current source of truth for recent work, and `README.md` is the public-facing overview.

`docs/archive/PROJECT_PLAN_v1.md` is archived. Do not act on it. But feel free to read it for more context on how we got here and what we're planning and building. It contains the original project proposal, initial architecture sketches, and early measure definitions that informed the spike plan.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived node-24 host; JVM-free CQL→ELM (build-time); PostgreSQL 16 (Neon, `Pg*Store` ceiling, `workwell_spike` schema; SQLite floor for tests/local). The Java/Spring backend was retired in #109 PR4 (ADR-008). CQL→ELM history: `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (`docs/archive/CQF_FHIR_CR_REFERENCE.md`) was the Java path.
- Frontend: Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher; see ADR-004) + Monaco
- AI: OpenAI via the backend-ts AI surfaces (deterministic fallbacks); MCP read-only tools served from the worker
- Infra: MIE Create-a-Container + Neon for deploy (Fly.io + Vercel public-preview stack decommissioned — MIE TWH is the sole live stack); GitHub Actions CI + a self-heal reconciler; pnpm

## Build & verify
- Backend: `cd backend-ts; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test` — ~2,021 tests as of 2026-08-26 (SQLite floor; the Pg-ceiling store contract runs against a local `postgres:16`, else self-skips). Gated in `ci.yml`.
- Frontend: `cd frontend; npm run lint; npm run build`
- Run the app: backend `cd backend-ts; pnpm dev`; frontend `npm run dev`

## Hard rules
- Avoid new dependencies unless they are explicitly approved and documented
- One backend-ts worker, modular `src/` packages — no microservices
- Application events + direct DB audit log (`audit_events` via the store layer; Spring Application Events were the Java-era mechanism, retired with the JVM) — no Kafka or external streaming
- Auth: user accounts remain hardcoded (no SSO, no real user directory). JWT refresh token flow (HttpOnly cookie, token rotation, `/api/auth/refresh`) is approved and implemented in Sprint 4 — this replaces the prior "stub auth only" constraint.
- Email: `WORKWELL_EMAIL_PROVIDER=simulated` is the default and must remain so on the demo stack. SendGrid wiring exists in the code (Sprint 6) but must not be activated unless `WORKWELL_EMAIL_SENDGRID_API_KEY` is explicitly set (with `WORKWELL_EMAIL_PROVIDER=sendgrid`) in a non-demo environment.
- AI never decides compliance (see docs/AI_GUARDRAILS.md). CQL engine is sole source of truth.
- Every state change writes `audit_event` — no exceptions
- No silent scope changes. If a stop condition triggers, document fallback in JOURNAL.md.
- Schema migrations are owned by Taleef — never written or applied by an agent without explicit instruction

## Branch + ownership
- Backend agent owns `backend-ts/` only
- Frontend agent owns `frontend/` only
- Schema/DDL is mine, never delegated — now the self-creating `workwell_spike` schema (`backend-ts/src/stores/postgres/schema-pg.ts` + the SQLite floor `schema.ts`); the old Java Flyway migrations were deleted with `backend/` in PR4
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
These are in context every session because each one is *load-bearing for a rule above*: a rule
whose criteria live in an unread file is unenforceable, and its absence is **silent**. Do not add
to this list without deleting from it — the whole point is that it stays small.
(`CQF_FHIR_CR_REFERENCE.md` was dropped 2026-08-10: it pinned Java-era Maven coordinates for a
backend retired in #109 PR4, and its stop condition died with the JVM. Now in `docs/archive/`.)

**The test for a line in any of these files is whether a session must not silently contradict it.**
Applied on 2026-09-01, that halved the set — 128k chars to 61k — by removing history and
non-binding snapshots rather than by compressing rules: CLAUDE.md's two "History — Current Focus"
blocks (~670 lines retelling DECISIONS.md and JOURNAL.md) and LOCKED_DECISIONS §5 (a dated audit its
own preamble called non-binding). `AI_GUARDRAILS.md` and `DATA_MODEL_CONTRACTS.md` were deliberately
left alone: every line in them is a rule the Definition of Done makes mandatory, and shaving a few
hundred tokens off a safety document is a bad trade against dropping one by accident.
- @docs/AI_GUARDRAILS.md — the "AI never decides compliance" hard rule lives or dies on this
- @docs/DATA_MODEL_CONTRACTS.md — idempotency + `evidence_json` + CSV contracts; Definition of Done makes these mandatory on EVERY PR
- @docs/ADR_INDEX.md — 69 ADR titles only, so a session knows a decision exists; bodies stay in DECISIONS.md
- @docs/LOCKED_DECISIONS.md — owner-locked decisions only (§4 per ADR-058, §4A per ADR-070). The
  dated §5 audit snapshot moved to `docs/archive/AUDIT_FACTS_2026-07-24.md` on 2026-09-01 — it bound
  nobody, which is the whole test for belonging in an always-loaded file

## Other docs to consult on demand
Read these when the task needs them. They are deliberately NOT `@`-imported: eagerly loading the set
cost ~89k tokens per session until 2026-07-29, whether or not any of it was relevant.
- `docs/guide/` — **the maintained explanation of the whole system** (10 chapters, mermaid per flow;
  ADR-066). The Definition of Done includes updating the affected chapter when behaviour it
  describes changes. Chapter 9 owns the volatile numbers, dated
- `docs/JOURNAL.md` — the running narrative; source of truth for recent work. Trimmed to 2026-08
  onward (~234k) on 2026-09-01; July and April–June moved **verbatim** to
  `docs/archive/JOURNAL_2026-07.md` and `docs/archive/JOURNAL_2026-04_06.md`. Still too big to import
- `docs/DECISIONS.md` — the ADR bodies that still GOVERN: decisions constraining what may be done next,
  plus design records for built features (55 of 69 as of 2026-08-30; titles already in context via
  ADR_INDEX). Split on 2026-08-05 — 20 bodies moved to `docs/archive/DECISIONS_ARCHIVE.md` as superseded
  or findings-in-ADR-form, 6 of which review #396 brought back as load-bearing design records, so 14
  remain archived. Every heading + a one-line pointer stays in `DECISIONS.md`, so an `ADR-0NN` reference
  anywhere still resolves and nothing was deleted.
- `docs/ROADMAP_2026-08-30.md` — **the APPROVED active plan** (the Maui pilot; owner decisions in context via LOCKED_DECISIONS §4A). `docs/ROADMAP_2026-08-04.md` is superseded as direction but **stays in docs/**: its §4 verification set remains the bar (locked decision 2). `docs/archive/ROADMAP_2026-07-24.md` is kept only for its §7 target architecture — **do not act on it**
- `docs/PROPOSALS_2026-08.md` — three feature proposals awaiting owner/MIE review (encounter-close quality check, "not seen in a while" view, deterministic next-due date). **None is approved or scheduled** — read it to know an idea has been written down, never as a work queue
- `docs/DEPLOY.md` — MIE Create-a-Container + Neon setup, env vars, rollback → prefer the `deploy` skill
- `docs/ARCHITECTURE.md` — system architecture + boundaries (the engine boundary is enforced mechanically by PR-1's containment test and PR-4's five boundary tests, so CI catches drift)
- `docs/DATA_MODEL.md` — §1–3: scope, core tables, full table schemas (derivable from `schema-pg.ts` / `schema.ts`)
- `docs/MEASURES.md` — the TWH measure catalog (63 measures) in plain English
- `docs/COMPLIANCE_API.md` + `docs/PACKAGES.md` — **the two contracts an integrator reads.** The versioned
  HTTP surface (ADR-061, with its stability statement) and the library surface: what `@work-well/*`
  publishes, the semver policy, and the positioning vs `fqm-execution`. Locked decision 5 makes these the
  primary deliverable, so read them before changing anything either one names
- `docs/STANDARDS_CONFORMANCE.md` — what we may and may not claim to conform to → prefer the `conformance` skill
- `docs/WEBCHART_API_ASSUMPTIONS_2026-07.md` + `docs/WEBCHART_FHIR_MAPPING.md` — Variant A is BUILT, Variant B is documented-not-built → prefer the `webchart` skill
- `docs/MCP.md` — MCP security boundary + tool posture → prefer the `mcp` skill
- `docs/PRODUCTION_READINESS_2026-07.md` — PHI/HIPAA posture, environment split, auth fork, tenancy, and the ordered production gap list (#261)
- `docs/archive/SPIKE_PLAN.md` — archived sprint context
- `README.md` — quickstart

## Do NOT read these unless I ask
~120 files / ~2.5 MB of dated, write-once records of finished work. They are history, not
instructions, and reading them burns context without changing what you should do. Consult
`docs/JOURNAL.md` for what happened instead.
- `docs/archive/superpowers/plans/` (47 files, 1.36 MB) and `docs/archive/superpowers/specs/` (39 files, 403k)
- `docs/archive/sprints/` (9 files, 269k — sprints 0–7 all merged; historical, not an active queue)
- `docs/archive/DECISIONS_ARCHIVE.md` (133k) — the 20 superseded/finding ADRs. Read a single one when a
  pointer in `DECISIONS.md` sends you there; never the file.
- the rest of `docs/archive/` — since the 2026-08-10 restructure (ADR-066) EVERYTHING dated,
  superseded or finished lives there: the old roadmaps and demo docs, `FABLE_REVIEW_2026-07-02/`,
  `new-instructions/`, `mieweb-ui-migration/`, and the 2026-08-08 system walkthrough (absorbed into
  `docs/guide/`)

## Current Focus (as of 2026-08-30 — the Maui pilot is the spearhead; `docs/ROADMAP_2026-08-30.md` is the APPROVED active plan)

**READ THIS BLOCK FIRST.** Everything earlier is condensed into "Where the project stands" below.
Driving ADR: **ADR-070**; locked decisions in `LOCKED_DECISIONS.md` §4A.

**What changed, in one paragraph.** WorkWell has its first real customer: a primary-care group on WebChart
(repo name **"the pilot group"**; deployment name **"Maui"** — the naming policy is locked: no client legal
or staff names in repo docs, source materials gitignored local-only) entering an **MSSP ACO** for
**PY2027** (measurement begins 2027-01-01). Its **proposed** quality set is APP
Plus-shaped; its six EMR-computable measures decode from MIPS IDs to **CMS122, CMS2, CMS165, CMS125,
CMS130** — all five vendored + MADiE-gated, two routed official in production, **but gated ≠ routable ≠
runnable**: the run pipeline derives runnable measures from the authored registry, CMS2/130/165 are
Draft/NOT_COMPILED catalog rows, and CMS130/165 have no `OFFICIAL_MEASURE_SEMANTICS` entry, so
**official-only onboarding is MM-1's substance** — plus **CMS137 (SUD initiation & engagement), which is
DOUBLY conditional: CMS-1848-P proposes REMOVING Quality ID 305 from APP Plus for PY2027 (confirm with
the ACO/final rule first), and if kept it is multi-rate with no authored counterpart, spiked before
promised**. The vendored artifacts are 2026-vintage (`effectivePeriod` 2026-only, unvalidated at
runtime) — PY2027 needs a re-vendor + full re-gate (MM-1d). The three non-computable members (two
claims-calculated, CAHPS) get informational tiles at most. The consumer's
shape from the 2026-08-27 working session: a quality staff organized **by provider panel** (never by
measure) needing patient-centric work lists and pre-filtered drill-downs; **cards that resolve, not
alert** (place-the-order pick lists + exception documentation — inside ADR-067's unchanged refusals, and
exceptions must be structured data CQL reads next run, never a WorkWell-side override); and an orders
problem that is MIE-side (**orders are local** — LOINC-on-order-rows mapping is MIE's work, WorkWell
consumes it).

**Milestones (`ROADMAP_2026-08-30.md` §5), cheap-first:** **MM-0** Maui instance + UX wins (second
deployment, "patient" terminology as deployment config extending the ADR-004 switcher, clickable
status-chip drill-downs, sandbox accounts — hardcoded per the auth rule, primary-care synthetic roster,
MIPS↔CMS crosswalk in the UI) → **MM-1** measure set (MM-1a confirm-305-then-spike; MM-1b official-only
onboarding incl. the flip-snapshot successor and extending `official-flip-config.test.ts`'s hardcoded
`WORKFLOWS` + TWH-only sidecar predicates; MM-1c **per-measure gated flips** — CMS2's 7 mismatches run
down and CMS130/165 swept BEFORE their flips, no known-unverified measure routed to the pilot; MM-1d
PY2027 re-vendor; MM-1e CMS137, conditional) → **MM-2** work lists & assignment (PCP attribution field —
schema is owner-owned; PCP/location filters; saved per-staff filters; attribution *semantics* deferred
until the ACO answers) → **MM-3** resolution actions (order pick lists **blocked on** MIE's order-mapping
docs — an offered order is a proposal and never changes compliance; exception path **blocked on** the
Nicole consultation for specifics) → **MM-4** encounter-time integration (**blocked on** MIE new-UI
access AND the ADR-067 CDS client-auth answer; a card stays a rendering of a completed evaluation —
freshness = evaluate sooner on ingest; the encounter must not get slower). **MM-0 SHIPPED 2026-08-31/09-01**
(#496–#500); **MM-1 is next.** The milestones deliver a SANDBOX — the pilot's production/PHI phase is a
separate `PRODUCTION_READINESS`-gated decision that nothing in M-M authorizes.

**What is demoted / deferred, named:** the versioned compliance API keeps existing but loses its
"contract MIE consumes" framing (LOCKED_DECISIONS §4 decision 5 SINCE-note); **M-E1 defers behind M-M**
(locked decision 6 stands long-term); ADR-058 decisions 1–4, the QRDA bridge, and the published
`@work-well/*` packages are untouched.

**Open externals (ROADMAP §7):** MIE — order-mapping documentation, new-UI source access, and the CDS
Hooks client-auth answer (WebChart's `iss` + JWKS — ADR-067's named gap);
Nicole — exceptions guidance; ACO — attribution basis + reporting mechanism (eCQM vs Medicare CQM vs
MIPS CQM) + whether measure 305 stays in the pilot's final set; CMS — the CY2027 **final** rule (~Nov
2026; same CMS-1848-P as the standing FHIR-timeline correction — it PROPOSES removing 305 and 493 from
APP Plus) and the PY2027 artifact publication — recheck the measure table and reporting mechanics after
the final rule lands.

---
## Where the project stands (condensed 2026-09-01)

Two "History — Current Focus" blocks used to sit here: the 2026-08-04 *engine is the product* plan and
the 2026-07-24 Nicole recalibration, ~670 lines retelling, in an always-loaded file, what
`docs/DECISIONS.md` holds as ADR bodies and `docs/JOURNAL.md` holds day by day — both in more detail
and both authoritative over the retelling. Removed 2026-09-01 for the reason the 2026-06→07-22 blocks
were removed on 2026-07-29: an always-loaded file pays for every line in every session. Recoverable
in full from `git show 5f29d373:CLAUDE.md`. What survives below is what is *not* history — standing
corrections, and things still open.

### Milestone status, one line each

| | State |
|---|---|
| **M-A** official-first execution | **cms122 + cms125 route CMS's published QI-Core artifacts on demo/production** (ADR-045/046). Eight measures MADiE-gated at 410/410. **Gated ≠ routable ≠ runnable** — the wave-2 measures have no authored counterpart, so `flip-snapshot`'s comparison cannot run for them. |
| **M-B** QRDA + Cypress | QRDA Category I **and** III both validate at **0 findings against the HL7 base ruler**. The certification loop runs end to end through the product API and reproduces Cypress's own expected counts exactly (64/64 and 150/150 subjects agreeing on every population, ADR-055/056). Cypress still grades it **red on measure-identity lineage** — it holds CMS125v14 (QDM), we run the QI-Core artifact — which **ADR-058 retired as a goal** rather than chased. |
| **M-C** packaging | **COMPLETE and PUBLISHED.** `@work-well/measure-engine` + `@work-well/measure-codegen` at `0.1.0` on the public registry with SLSA provenance (2026-08-07). Measure content is *injected*, never shipped (ADR-059). |
| Integration surface | CDS Hooks 2.0.1 service + hand-authored OpenAPI 3.1.1 at `/api/v1/openapi.json`, rendered at `/api-docs` (ADR-067/068, 2026-08-17). |
| **M-M** Maui pilot | **The active spearhead** (§ Current Focus above). **MM-0 is complete** — #496–#500 merged: ADR-070, deep-linked status chips, the Maui synthetic tenant, subject terminology as deployment config, and the deployment profile itself. **MM-1 is next.** |
| **M-E1** occupational content | Deferred behind M-M (locked decision 6 — deferred, not cancelled). |
| **M-D0/D1** | Re-aim at US Quality Core; run the Inferno **US Quality Core Test Kit** against the shim output. Not started. |

### Three standing corrections

These exist because each is a claim the project got wrong once and would otherwise repeat.

1. **The CMS FHIR-reporting timeline is CMS-attributable but PROPOSED.** The CY2027 PFS proposed rule
   (CMS-1848-P, July 2026) *seeks comment on* a two-year transition — FHIR reporting voluntary
   PY2028–29, mandatory PY2030 for applicable APP Plus measures, MIPS CQMs sunsetting ~PY2030. Cite it
   as proposed/under comment, **never as final** (final rule ~Nov 2026). *(This supersedes the older
   form, "~2030 is not CMS-attributable.")*
2. **"QI-Core STU7 = US Core 7 = WebChart's exact surface" is half right.** The equality holds, but
   **CMS's shipping content is authored on QI-Core 6**, and the direction of travel is US Quality Core
   0.5.0 over US Core 6.1.0.
3. **"Cypress CVU+ is the verification bar" is removed** — from `STANDARDS_CONFORMANCE.md` and from the
   `conformance` skill. The bar is the FHIR-column verification set (`ROADMAP_2026-08-04.md` §4).

### Open, named

- **#501** — the row-filtering and measure-set-scoping gaps the #500 review found and deliberately
  deferred (CSV export first; it is the one that leaves the application).
- **#377** — retire the authored cms122/125 subsets to the fidelity lab (locked decision 7).
- **#470** — a CDS invocation scans the subject's whole outcome history; stated as a limit in
  `CDS_HOOKS.md`, the fix is a per-measure store query.
- **#473 (owner)** — the TWH nightly Neon backup fails its S3 upload with `InvalidAccessKeyId`;
  regenerate the IAM key pair and update the two `WORKWELL_BACKUP_S3_*_TWH` secrets.
- **Still undiagnosed:** CMS125's 2 `Procedure`-only cases, CMS2's 7 `NUMER 1→0`, and CMS130/CMS165
  unswept (credentialed vendor workflow). MM-1c runs these down before those measures flip.
- **Deferred, not cancelled:** supplemental data (B8) — it moves no external number today.
- **Owner steps:** confirm with Doug/Nicole that certifying WorkWell's engine is not a business goal
  (the one input that would reopen locked decision 3); and migrate npm publishing off the 2FA-bypass
  token to **Trusted Publishing** (the workflow already has `id-token: write`; it would remove
  `NPM_TOKEN` entirely). A re-release starts with a version bump — npm never permits reusing one.

### Two traps that cost real time

Both live in the conformance harness's own header; repeated here because they are invisible until
they have already wasted an afternoon. `cqf-fhir-cr` retrieval is QI-Core **`meta.profile`-sensitive**
— an unstamped hand-PUT resource is silently never retrieved. And `$evaluate-measure` **caches per
subject for the server's life**, so every changed input needs a fresh container.

---

## History

Superseded status blocks (2026-06 → 2026-08-30) previously lived here and were removed — the
2026-06→07-22 set on 2026-07-29, the 2026-07-24 and 2026-08-04 sets on 2026-09-01 — because they
duplicated, in less detail, what `docs/JOURNAL.md` and `docs/DECISIONS.md` already record. For
anything before the Current Focus block above, read those two (JOURNAL newest entry on top). The full
removed text is recoverable from git history (`git show 5f29d373:CLAUDE.md`).
