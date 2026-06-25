# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer TypeScript + Next.js monorepo (backend re-platformed off Java/Spring — #96 / ADR-008; JVM retired in #109 PR4)
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- Historical sprint window: May 2-17, 2026; active work is now post-merge closeout and polish

## Read first, every session
`@docs/archive/SPIKE_PLAN.md` is the archived sprint plan and historical context. `docs/JOURNAL.md` is the current source of truth for recent work, and `README.md` is the public-facing overview.

`docs/archive/PROJECT_PLAN_v1.md` is archived. Do not act on it. But feel free to read it for more context on how we got here and what we're planning and building. It contains the original project proposal, initial architecture sketches, and early measure definitions that informed the spike plan.

## Tech stack (immutable without ADR in docs/DECISIONS.md)
- Backend: TypeScript on `@mieweb/cloud` (`backend-ts/`) — a Cloudflare-style worker on a long-lived node-24 host; JVM-free CQL→ELM (build-time); PostgreSQL 16 (Neon, `Pg*Store` ceiling, `workwell_spike` schema; SQLite floor for tests/local). The Java/Spring backend was retired in #109 PR4 (ADR-008). CQL→ELM history: `org.opencds.cqf.fhir:cqf-fhir-cr` 3.26.0 (CQF_FHIR_CR_REFERENCE.md) was the Java path.
- Frontend: Next.js 16 App Router + React 19 + TypeScript + Tailwind 4 + `@mieweb/ui` (dark mode + Enterprise Health brand + runtime brand switcher; see ADR-004) + Monaco
- AI: OpenAI via the backend-ts AI surfaces (deterministic fallbacks); MCP read-only tools served from the worker
- Infra: MIE Create-a-Container + Neon for deploy (Fly.io + Vercel public-preview stack decommissioned — MIE TWH is the sole live stack); GitHub Actions CI + a self-heal reconciler; pnpm

## Build & verify
- Backend: `cd backend-ts; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test` — ~430 tests (SQLite floor; the Pg-ceiling store contract runs against a local `postgres:16`, else self-skips). Gated in `ci.yml`.
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
- Use a feature branch for follow-up work
- Merge after my review — no auto-merge

## Definition of done (every PR)
- Tests pass (idempotency + audit invariants are mandatory; rest smoke-only)
- CI green
- Affected docs updated in same PR (ARCHITECTURE, DATA_MODEL, MEASURES, DECISIONS, DEPLOY)
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
- A spike's stop condition (in `docs/archive/SPIKE_PLAN.md`) appears to trigger
- A library version doesn't match what CQF_FHIR_CR_REFERENCE.md says works
- A schema migration would break existing data
- An AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance" reasons
- The plan would slip more than half a day

## Other docs to consult on demand
- @docs/archive/SPIKE_PLAN.md — archived sprint context
- @docs/DEPLOY.md — MIE Create-a-Container + Neon setup, env vars, rollback
- @docs/MEASURES.md — the TWH measure catalog (60 measures) in plain English
- @docs/ARCHITECTURE.md — system architecture diagrams + boundaries
- @docs/DATA_MODEL.md — schema invariants
- @docs/AI_GUARDRAILS.md — AI usage policy
- @docs/CQF_FHIR_CR_REFERENCE.md — proven library wiring from spike
- @README.md — quickstart

## Current Focus (as of 2026-06-25)

**Latest (2026-06-25): the post-demo WebChart-convergence roadmap (board #7) is well underway — E10 + all of E11 are merged + live; E11.3 PR-2 is spec'd + planned but NOT yet built.** The June-15 demo produced a roadmap of epics E10–E15 (#182–#187, label `webchart-convergence`). Shipped + deployed since:
- **E10 — roster-centric compliance + measure taxonomy (#182):** a `complianceClass: PERMANENT|RECURRING` field + 3 permanent series-completion vaccine measures (`mmr`, `varicella`, `hepatitis_b_vaccination_series`) → **now 14 runnable / 63 catalog**; an "Individual Compliance Status" roster grid (`/compliance`, `GET /api/compliance/roster`) with an E10.5 display vocabulary (COMPLIANT/DUE_SOON/OVERDUE/MISSING_DATA/EXCLUDED/DECLINED/IN_PROGRESS/NA); a per-employee compliance card (Recalculate, evidence drill-in, Simulate Compliance History). No schema beyond the taxonomy field.
- **E11 — rule-builder + CQL-canonical decision + segments (#183):** **E11.1** ADR-015 — *CQL is canonical; rule-params compile to CQL* (rule→CQL codegen). **E11.2a/b/c** — codegen titer/grace/declination, the Studio **Rule Builder** tab, multi-alternative series + **live Hep B repointed to Heplisav-vs-traditional** (#204). **E11.3 PR-1 — risk-group SEGMENTS backend (#205, merged + deployed + verified live):** the first E11 schema (3 owner-gated tables `segments`/`segment_measures`/`segment_overrides`, floor + ceiling, `SegmentStore` port); a single pure applicability engine (`segment-applicability.ts`) gating the roster (`NOT_APPLICABLE` overlay + `?segment=` filter) + run-pipeline case creation — **never compliance** (ADR-016; CQL stays authoritative); ADMIN-gated audited `/api/segments` CRUD + `/preview`; 3 enabled demo cohorts (seed ships enabled → overlay live on the demo). Reversibility: zero enabled segments ⇒ everything applicable (pre-E11.3 behavior). Two Codex P2s addressed (per-operator value-shape validation + seed-once-before-any-consumer). Live-verified: tables self-created on Neon, overlay correct across panels.
- **E11.3 PR-2 — Configure Groups UI (NOT built yet):** spec + plan committed on branch **`feat/e11-3-segments-ui`** (`docs/superpowers/specs/2026-06-25-e11-3-segments-ui-design.md`, `docs/superpowers/plans/2026-06-25-e11-3-segments-ui.md`). Adds one backend endpoint (`POST /api/segments/preview`) + a `/admin → Groups` editor (rule builder + measures + INCLUDE/EXCLUDE overrides via the existing `/api/employees/search` + live preview) + the roster `NOT_APPLICABLE` chip + segment filter. **Resume here:** execute the PR-2 plan subagent-driven, then PR. Closes E11. **Next epics after E11:** E12 #184 (pluggable data adapters), E13–E15.

Open follow-ups (pre-E10, still tracked): **M1** `nextActionFor` mislabels non-OSHA measures as "audiogram" (`case-logic.ts`); **H2** SendGrid documented but absent in `backend-ts`; a full WCAG audit beyond table/label basics; a managed S3/R2 BUCKET so evidence upload persists (currently ephemeral).

**Earlier (2026-06-21): QA/UX hardening pass 2 (#181, merged + deployed; merge `b5d9f7c`).** A second QA pass on top of #180 — verified blocks 4–11 live, ran a 13-surface / 80-finding multi-agent UX/RBAC/perf audit, then fixed it all across 22 commits (no schema change, no new deps, keeps `@mieweb/ui`). Themes: **role-aware nav + action-button gating** (`frontend/lib/rbac.ts` mirrors `authorize.ts`) — fixes "every role sees every option then 403s" (**closes M2**); **backend correctness** — `programOverview/Trend` exclude in-flight runs (the Evaluations count no longer bounces) and `caseTimeline` is single-source `audit_events` (no duplicated timeline entries); **programs/measure-detail perf + charts** (progressive render, parallel fetches, dynamic padded y-domain, whole-card click); **cases** OVERDUE/outcome filter + page-size + table view; **runs** the missing MeasureReport/QRDA buttons + fixed Status/Scope/Trigger filters (lowercase values never matched the uppercase enums) + SEED column; **case detail** next-action CTA + assignee type-ahead + dark-mode + "CQL Evidence Explorer" rename; **admin** tabbed IA + wired the outreach delivery log to `CASE_OUTREACH_SENT` audit events (**closes M3**) + live AI integration tile keyed on `OPENAI_API_KEY` (**closes M4**) + grid-overflow fix; **new CM/ADMIN `/orders` page** surfacing the previously UI-less E7 order-proposal API; **employee-detail** 2-column redesign; a **global, durable run-progress indicator** (`RunStatusProvider` — survives nav + reload, fires `ww:run-complete`); a **conservative API GET dedup + 1.5s-TTL cache** busted on every write (replaces blanket `cache:"no-store"`); an **a11y pass** (`scope="col"` + input labels); and **bounded audit-ledger SQL reads** (`recentAuditEvents(limit)` / `auditEventsForCases(ids,limit)`) so the admin viewer + employee profile stop materializing the whole ledger. Three code reviews (initial, full-branch, maintainer PR review — 9 items fixed in `a5433f2`; 3 verified false positives left with evidence: measure-name resolution, `/api/runs` returning `runId`, the campaigns zero-recipient guard). **Still open: M1** `nextActionFor` mislabels non-OSHA measures as "audiogram" (`case-logic.ts`), **H2** SendGrid documented but absent in `backend-ts`, and a full WCAG audit beyond table/label basics. The synthetic-trend amplitude was bumped (needs a `pnpm seed:trend-history` re-seed to surface; the new chart auto-scale already reveals the existing ±6% live).

**(2026-06-21): full QA smoke test + synthetic trend-history feature (#180, merged + deployed).** An end-to-end adversarial QA pass of the live app (all 4 roles; report `docs/QA_SMOKE_TEST_2026-06-20.md`) confirmed a real, working, secure app; open follow-ups (not yet fixed): **M1** `nextActionFor` mislabels non-OSHA measures as "audiogram" (`case-logic.ts`), **M2** `/campaigns` silently 403s for AUTHOR/APPROVER, **M3/M4** admin outreach-delivery-log hardcoded `[]` + integration health static, **H2** SendGrid documented but absent in `backend-ts`, plus systemic accessibility debt. **H1 fixed live** — `adult_immunization` had never been in a population run (last ALL_PROGRAMS predated the E6 merge); an ALL_PROGRAMS run populated it (80% / 17 cases). **#180 — synthetic trend-history backfill** (`pnpm seed:trend-history` CLI + `backfillTrendHistory`) writes backdated weekly COMPLETED MEASURE runs so `/programs` trend charts vary instead of flat-lining; week-level idempotent, anchored before each measure's latest real run (overview never hijacked), audited (`TREND_HISTORY_SEEDED`), **no schema change**, seed runs labeled `SEED` (`GET /api/runs?triggerType=SEED`). Hardened across 9 Codex rounds + code-reviewer. **Seeded live on Neon: 132 runs + 13,200 outcomes; 10/11 measures now show varied trends** (audiogram flat-ish — pre-existing real runs fill the 10-point cap). Reversible (two-step schema-qualified rollback; see `docs/DEPLOY.md`). Design: `docs/superpowers/specs/2026-06-20-synthetic-trend-history-design.md`.

**#109 is fully closed: PR4 (#164) + the reconciler (#163) are merged to `main`, deployed, and verified in production (2026-06-18).** Post-merge E2E: the API smoke (`scripts/smoke-shadow.sh`) is 19 pass / 0 fail / 2 warn (the 2 warns are the documented ephemeral-BUCKET + MCP-SSE limitations), and the `/programs` dashboard renders live through the real browser path. Merged local feature branches deleted, remotes pruned, and the 366 MB leftover untracked `backend/` tree removed (recoverable via `git checkout 91182dd -- backend/`). **E2 — declarative YAML measures + headless evaluator (#72) — also shipped: the packaged headless evaluator CLI (`backend-ts/src/engine/cli/`, `pnpm evaluate --patient <bundle.json> --measure <id>`) merged in #165, deployed, and verified. Next: the following roadmap epic (#73).**

**The #109 deploy cutover is COMPLETE and the JVM is retired (PR4).** `https://twh.os.mieweb.org` is served by the de-Java TypeScript backend (`twh-api-ts`, `backend-ts/`) on the existing Neon Postgres via the `Pg*Store` ceiling (isolated `workwell_spike` schema). **The Java/Spring backend is gone — `backend/` is deleted, the Java build/deploy jobs and the `deploy-twh-ts-shadow.yml` workflow are removed, and `backend-ts` is the CI-gated (`ci.yml`, floor + Pg ceiling) sole backend.** Path: PR1 image (#155) → store-selection seam (#156) → shadow deploy + Neon-pooler `options` fix (#157/#158) → blue-green flip (#159) → pre-retirement hardening: CI gate (#161), observability + orphaned-run recovery (#162), self-heal reconciler (#163) → JVM retirement (PR4). #150 demo-readiness is fully closed (all 21 items). Reboot/crash recovery is handled by the self-heal reconciler (`reconcile-twh-mieweb.yml`), independent of Proxmox `onboot`. Known limitation: evidence upload is ephemeral (in-container `fs` BUCKET) until a managed S3/R2 bucket is wired. Plan/resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`.** (Strategic roadmap epics #71–#78 — E1 (#71), E2 (#72), and E3 (#73 — MeasureReport, value-set expansion, QRDA III, QI-Core) all merged + deployed; E4 (#74) is next.)

> Rollback (Java retired): redeploy an earlier known-good `twh-api-ts` image — `workflow_dispatch` on `deploy-twh-mieweb.yml` with `replace_existing=true` at an earlier `sha-<SHA>` (each build is tagged in GHCR). See `docs/DEPLOY.md` → Rollback.

History (all on `main`):
- Sprints 0–6 → PRs #16–#22; eCQM + TWH instance support → PR #46
- Sprint 7 overdelivery (AI Draft CQL, AI Test Fixtures, Risk Scoring, MAT Export, Mobile Responsive) → issues #47–#51, closed
- Sprint 8 scoped-run parity: `SITE`/`EMPLOYEE` manual runs + rerun now route through the async run-job path
- CI test suite 3.8x faster via 8-way test sharding (44m → 11m30s) → PR #57
- MIE Container Manager deploy migrated to the v1 API envelope → PRs #55, #56
- Post-merge polish pass → PRs #60–#66: ADR-003, workwell.os redirect, CQL code-filter tightening, CMS125+CMS122 promoted to Active, compliance trend per-bucket chart, case code evidence explorer, SQL analogy panel
- `@mieweb/ui` frontend migration → PR #68; measures/programs/runs latency fix → PR #69; systemd + reboot-policy docs → PR #70
- **Roadmap Wave 1 — E1: reusable measure engine ports/adapters → PR #95** (epic #71 + sub-issues #79–#84, closed). `CqlEvaluationService` now runs behind `PatientDataProvider`/`EmployeeDirectory`/`MeasureDefinitionProvider`/`EvaluationConfigProvider`; synthetic adapters are the default (ADR-005). Roadmap epics tracked as issues #71–#78.
- **Demo-readiness (#150) — part 1 (PR #151) + H1 (PR #152) both merged + deployed.** A live QA pass found 21 defects/doc-mismatches. Part 1 shipped: frontend papercuts (H2/H3/M2/M3/M4/M7/M11/M12), **C2** CMS125/CMS122 promoted to Active (seeding-bug fix + CMS122 name reconciled to the modern "Glycemic Status Assessment Greater Than 9%" since the evaluator binds CQL by measure name), **C4** program rollups exclude single-subject CASE/EMPLOYEE reruns. **H1 (worklist flood) + M6 + D shipped in PR #152:** per-measure compliance-cycle case bucketing (nightly reruns idempotent), worklist defaults to each measure's current cycle, M6 `why_flagged` uses the measure's real compliance window, and **migration `V022` closed the ~5,019 pre-bucketing stale-period cases on live Neon**. The worklist's current-cycle definition is **date-driven + cadence-exact** (`bucketPeriod(measure, today)` per measure) — Java `CaseFlowService` row-value IN, `backend-ts` route JS filter (`bucketPeriodForMeasure`); this converged after 5 Codex review rounds (2 P1 + 1 P1 re-review + 5 P2, all resolved). Java↔`backend-ts` at parity. **#150 is now fully closed (all 21 items):** H4/M1/M5/M8 shipped in PR #153, and the M9/M10/M13 post-demo trio in PR #154 — both merged + deployed. Running narrative in `docs/JOURNAL.md`; plan in `docs/superpowers/plans/2026-06-15-issue-150-demo-readiness.md`.

Current posture:
- **Live URL:** `https://twh.os.mieweb.org` — login: `admin@workwell.dev` / `Workwell123!`
- **Live backend:** `https://twh-api-ts.os.mieweb.org` — the **TypeScript** backend (`backend-ts/`), the **sole** backend (Java retired in PR4).
- **Deployment:** MIE Create-a-Container only (`deploy-twh-mieweb.yml`); triggers on every push to `main`. Builds + deploys the TS backend and the frontend (pointed at `twh-api-ts`). A self-heal reconciler (`reconcile-twh-mieweb.yml`, every 15 min) recreates a down container from `:latest`. The earlier Fly.io + Vercel public-preview stack is decommissioned; MIE TWH is the sole live stack.
- **Measure catalog:** 63 total — 4 OSHA active (CQL), 2 OSHA catalog, 5 HEDIS wellness active (CQL — incl. `adult_immunization` AIS-E Td/Tdap, #76), 3 permanent immunization-panel active (CQL series-completion — MMR/Varicella/Hep B, E10.6), 2 CMS eCQM active (CMS125v14 breast cancer, CMS122v14 diabetes HbA1c), 47 CMS eCQM Draft entries; **14 runnable measures total** (the 3-measure immunization panel landed via the E10 Plan-1 branch `feat/e10-roster-compliance`)
- **Supported run scopes:** `ALL_PROGRAMS`, `MEASURE`, `SITE`, `EMPLOYEE`, `CASE`
- **Next up:** **#109 is done (JVM retired).** Open follow-ups: a managed S3/R2 `BUCKET` so evidence upload persists (currently ephemeral); confirming Proxmox `onboot` with MIE (nice-to-have — the self-heal reconciler already covers reboot/crash recovery). **E2 (#72, headless evaluator CLI) and the full E3 epic (#73 — FHIR MeasureReport #89, value-set expansion #90, QRDA III #91, QI-Core #92) are complete, merged, and deployed.** **E4 — multi-level dashboards (#74, sub-issues E4.1 #93 + E4.2 #94) is complete on the `feat/issue-74-multi-level-dashboards` branch (deploys on merge to `main`):** the enterprise→location→provider→patient hierarchy is modeled in the synthetic employee directory with **no DB schema change** (finding: backend-ts has no `employees` table, so the #93 stop-and-ask gate was satisfied with no migration — ADR-010), a reconciling rollup read model + `GET /api/hierarchy/rollup`, and a drill-down UI at `/programs/hierarchy`. **E5 — outreach at scale (#75) is complete, merged + live:** multi-channel outreach via the `OutreachChannel` port (EMAIL/SMS/PHONE simulated adapters + an inert DataChaser stub — `resolveChannel` is simulated by default, DataChaser inert unless both `WORKWELL_OUTREACH_DATACHASER_*` env vars are set, mirroring SendGrid), bulk campaigns behind a `CampaignStore` port (audit-backed `OUTREACH_CAMPAIGN_COMPLETED` adapter — **no schema today**; Pg `outreach_campaigns`/`outreach_delivery_log` drop-in documented), `POST/GET /api/campaigns` (CASE_MANAGER/ADMIN-gated), a `/campaigns` launcher UI, and a channel selector on the case outreach action. Simulated by default; ADR-011. **E6 — immunization & forecasting (#76) is complete, merged (#177), deployed, and verified live (2026-06-19):** the `ImmunizationForecast` port (`simulatedForecaster` default over its own 3-series synthetic history; inert `iceForecaster` stub selected only when both `WORKWELL_IMMZ_ICE_*` env vars are set — Doug Q5 deferred behind it), `GET /api/immunization/forecast`, the `adult_immunization` runnable measure (real NCQA HEDIS **AIS-E** Td/Tdap, 10y window; CMS117 was pediatric-mismatched so AIS-E was chosen), contraindication→EXCLUDED + documented-refusal-kept-open, and an advisory forecast on `/cases/[id]`. **No schema** (ADR-012); forecast is advisory (CQL stays the sole compliance authority). Seeding is now an idempotent back-fill so catalog additions appear on the already-seeded live stack (Codex P1 fix). **E7 — order/action generation (#77) is complete, merged (#178), deployed, and verified live (2026-06-19):** the `order/` module — a pure, trigger-agnostic `proposeOrders` engine (Panel=Risk selection + risk→priority + in-batch/standing-order dedupe with urgent-priority merge), an action-evaluator order catalog (reuses the terminology_mappings seed), the `StandingOrderProvider` port (simulated default; inert `ehStandingOrderProvider` stub when `WORKWELL_EH_FHIR_*` set), and `ProposedOrder`→FHIR `ServiceRequest` mapping — exposed read-only via `GET /api/orders/proposals` (CASE_MANAGER/ADMIN; `domain|fhir`; derives only from terminal population runs). Advisory only (a human submits; CQL stays authoritative); **no schema**; the EH `OrderSubmitter` write path is named-but-deferred. ADR-013; Codex P2 ×2 addressed (terminal-run filter, severity merge). **Next roadmap epic: E9 — CQL→SQL bridge (#78), a spike / decision memo only (no code; tied to Doug Q2).** Resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`. `docs/JOURNAL.md` carries the running narrative. (A fuller strategy roadmap and the open strategic questions for Doug are kept as local-only working files on the maintainer's machine, not committed to the repo.) NITRO data-grid is now **unblocked** — vendored `@mieweb/datavis` source under `frontend/vendor/datavis` + `datavis-ace` from npm; live on `/measures`, `/runs`, `/admin` (ADR-007). Remaining `@mieweb/ui` form-control swap split out as issue #99. (Asking Doug to publish a built `@mieweb/datavis` to npm so `vendor/` can be dropped is still pending.)
- Schema migrations are owned by Taleef — stop and ask before writing any `V0xx__*.sql` file
- Treat `docs/archive/SPIKE_PLAN.md` as historical context only
