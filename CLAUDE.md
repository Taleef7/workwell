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
- Backend: `cd backend-ts; pnpm install --frozen-lockfile; pnpm typecheck; pnpm test` — ~785 tests (SQLite floor; the Pg-ceiling store contract runs against a local `postgres:16`, else self-skips). Gated in `ci.yml`.
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
- @docs/MEASURES.md — the TWH measure catalog (63 measures) in plain English
- @docs/ARCHITECTURE.md — system architecture diagrams + boundaries
- @docs/DATA_MODEL.md — schema invariants
- @docs/AI_GUARDRAILS.md — AI usage policy
- @docs/CQF_FHIR_CR_REFERENCE.md — proven library wiring from spike
- @docs/PRODUCTION_READINESS_2026-07.md — PHI/HIPAA posture, environment split, auth fork, tenancy, and the ordered production gap list (#261)
- @README.md — quickstart

## Current Focus (as of 2026-07-20 — Doug-directive wave; prior blocks below)

**2026-07-20 — Doug call (07-19) reset the near-term direction; Thursday 2026-07-23 demo call is
the target.** Three directives (transcripts local-only; D17's "CQL→SQL parked" is SUPERSEDED in
the questions doc): **(1) a FHIR shim we own over the WCDB** — new standalone top-level
**`wcdb-fhir-shim/`** package (plain `node:http` + `mysql2` — the ONLY package allowed a MariaDB
driver, ADR-034; backend-ts stays driver-free) serving the verified WebChart client contract
(`/fhir/metadata`, paged `Patient` with same-origin `link[next]`, per-resource `?patient=`
composition) directly from the dev-wcdb MariaDB (56 patients; compose profile `wcdb`, shim :8085,
db :33306) — a drop-in for the ADR-032 HAPI simulator, consumed via the existing
`WORKWELL_WEBCHART_BASE_URL` seam (acceptance = `hapi-live.test.ts` pointed at the shim);
**(2) CQL→SQL un-parked** ("very valuable to me") — #292 Phases 0–2 active: pure `generateSql`
beside `generateCql` (windowed-recency only; WCDB has no immunization table), `pnpm generate:sql`
→ committed `wcdb-fhir-shim/sql/*.sql`, shim `/compliance/{patientId}/{measureId}?start=&end=` +
cohort endpoint execute them, and a self-skipping parity live test (SQL vs CQL-over-shim-FHIR per
patient across 56) is the ADR-025 gate — CQL stays the sole authority (ADR-008);
**(3) MIE ecosystem** — Codify/`Healthcare/CodeLookup` (in MIE's Storybook, NOT exported by
`@mieweb/ui@0.6.1` — probe dev builds, else document + file the upstream publish ask) + propose
WorkWell components upstream (ChartDataTable, chip tier, RosterMobileCards, NitroGrid seam,
OshaReferenceCombobox). **Preflight verified:** wcdb boots, 56 patients, LOINC distinct-patient
coverage BMI 13 / systolic 9 / HbA1c 4 / LDL 1 ⇒ observation-based demo measures (hypertension
primary; obesity_bmi likely add; final gate at the codegen PR). **People:** Nicole = quality lead +
hiring gate (3–4×/week cadence), Bridget schedules (call, don't email), Doug owes an ELM working
session. Wave plan: `docs/superpowers/plans/2026-07-20-doug-wave.md`; spec:
`docs/superpowers/specs/2026-07-20-doug-wave-wcdb-shim-cql-sql-design.md`; ADR-034.

**STATUS 2026-07-20 EOD — the wave is BUILT; all gates green on first live runs (PRs #308–#315,
stacked, awaiting owner review+merge).** Shim live against dev-wcdb (hapi-live 4/4 incl.
fixture parity; hapi-app-live 1/1; CLI 27 real outcomes); **CQL→SQL parity-proven** —
`pnpm generate:sql` → committed `wcdb-fhir-shim/sql/*.sql` → shim `/compliance` API →
**ADR-025 golden gate GREEN (4 measures × 56 patients × 2 dates, zero divergence)**; **Codify is
LIVE in Studio** (Value Sets tab "Find a code" — vendored `frontend/vendor/codelookup/` from
mieweb/ui source per the ADR-007 playbook, zero new deps, searching MIE's hosted
`ui.mieweb.org/codify` index client-side; browser-verified: "breast cancer screening" → the
eCQM CMS125 entry in ~39 ms → form prefill; status/asks:
`docs/mieweb-ui-migration/CODELOOKUP_STATUS.md`). **All 12 Codex PR findings addressed** (spec
text, zero-date-only guard, COALESCE sums, threshold drift-guard test, calendar-date validation,
full 4×56×2 parity matrix, demo-doc fallbacks; 2 were pre-fixed). **The write loop is closed (PR #316,
Doug's WhatsApp additions):** `npm run ingest` in the shim takes AI-generated YAML patients into
the WebChart dev DB — every written field validated against WebChart's self-describing `model`
schema catalog (685 objects / 7,630 fields), fail-closed LOINC resolution, idempotent, exact
`--rollback`; live-verified 56→60→56 with CQL==SQL agreement on all four designed outcomes.
**Demo script:**
`docs/DEMO_2026-07-23.md` (5 beats incl. the full loop; fallbacks + the owner outreach
checklist — message Doug re attendees, intro note to Nicole, dry-runs Wed PM). Remaining: owner
PR reviews/merges (#308→#311→#312→#313→#314→#315→#316), Wed dry-runs, outreach.

## Prior focus (2026-07-16 — WebChart live-integration wave)

**2026-07-16 — Doug meeting (07-15) delivered #254 and unblocked M2.** Confirmed: **A1** — FHIR R4
is the integration surface; **A3** — auth is SMART (Backend Services, matching ADR-028); **D17** —
data flows **WebChart→WorkWell, CQL runs our side** (CQL→SQL parked; #292 triggers dormant);
**C13** — we hold a WebChartNow **trial instance** `teatea.webchartnow.com` (System Owner). Doug
also suggested a **HAPI FHIR server as a local WebChart simulator** (use official
`hapiproject/hapi` — already in `infra/docker-compose.yml`, port 8081; the `jamesagnew/hapi-fhir`
link is a stale personal fork) and directed us to **be self-sufficient**: remaining #254 items
(A2/A4–A8/B9–B12/C14–C16 — not discussed) become a documented assumption register, not blockers.
**Trial probe (2026-07-16):** FHIR + smart-configuration live; `private_key_jwt` RS384 only, scopes
`patient/*.rs`+`system/*.read` (⇒ `WORKWELL_WEBCHART_SCOPE=system/*.read`), grant list advertises
only `authorization_code` (client_credentials = live test); **client registration is
self-serviceable** at `webchart.cgi?f=admin&s=jwt`. **The wave (approved plan summarized in the
stacked PR descriptions, 7 PRs):** record answers (this PR) → HAPI fixture
loader (collection→transaction transform, PUT w/ deterministic ids) → `pnpm evaluate:webchart-live`
CLI + self-skipping HAPI parity test → teatea runbook (keypair, client registration, auth probe,
**realistic ~30-patient import generated from the synthetic corpus** via WebChart's import tooling)
→ **live WebChart tenant spec + implementation** (WebChart-backed tenant behind the E1/ADR-005
`EmployeeDirectory`/`PatientDataProvider` ports, inert-unless-configured — the app's dashboards
visualize live WebChart-derived compliance) → MIE product research doc (Enterprise Health ↔
WorkWell mapping + the assumption register). End state: teatea holds a realistic synthetic
population; the app fetches it live over FHIR, evaluates, persists audited outcomes, and
`/compliance`, `/programs`, `/programs/hierarchy` visualize it. Demo stack stays untouched (seam
unset ⇒ byte-identical; **no PHI ever**). Remaining owner steps: execute the teatea runbook; Neon
plan-upgrade decision (unchanged).

## Prior focus (2026-07-15 — HL7 Connectathon validation wave)

**2026-07-15 — the CMS Connectathon 7 research + validation wave is MERGED (PRs #293 + #294; Codex-implemented, review-gated).** Research record: `HL7 Connectathon/RESEARCH_FINDINGS_2026-07-15.md` (now tracked in-repo). **#293 — official MADiE test-case harness** (`pnpm test:official-cases`; content fetched gitignored, pinned @ upstream `ca4b495`, `-Ref` override): **121/121 official test cases pass — CMS122 55/55, CMS125 66/66** (`docs/OFFICIAL_TESTCASE_REPORT_2026-07.md`) — the project's first *external* ground truth. Found + filed **projecttacoma/fqm-execution#371** (date-only `measurementPeriodEnd` — including the `Measure.effectivePeriod.end` default — parsed as START-of-day, dropping Dec-31 events; harness normalizes to end-of-day, documented caveat) and fixed the same latent bug in the live literal-diff route (`literal-diff.ts` period end now `T23:59:59.999Z`). CMS122 bundle drift v0.5.000→v1.0.000 = **0/55 outcome changes** (re-vendoring is cosmetic, deprioritized). **#294 (ADR-031) — MeasureReport export conformance:** DENOM is now the **membership-label count** (score = `NUMER/(DENOM−DENEX)`; br-57509 ballot-branch semantics, caveat documented); cms122/cms125 `MISSING_DATA` maps **out-of-population** via the new `missingDataMeansOutOfPopulation` binding flag (their CQL encodes not-in-IPP as MISSING_DATA — other measures unchanged); `improvementNotation` is binding-driven with a **guard test** on the urn:workwell-canonical + compliance-numerator invariant (never ship the inverted cms122 numerator under the official CMS canonical); base-R4 adds (id, injectable generation `date`, contained `reporter`, Bundle `fullUrl`s); QRDA inherits the corrected counts. `quality_snapshots`/programs/roster are **byte-identical** (documented intentional divergence). **Connectathon backlog now tracked as issues (filed 2026-07-15):** VSAC manifest pinning + provenance, the CQL conformance harness, and the standards follow-ups bundle (fqm#371 watch, subset-vs-official-cases fidelity, DEQM profile tier). **Owner steps: send #254 — now including the new DEQM `$submit-data`/`$collect-data` + US Quality Core trajectory questions — and the Neon plan-upgrade decision.**

## Prior focus (2026-07-14 — pre-Doug-meeting closeout)

**2026-07-14 — owner-side closeout before the Wed 2026-07-15 Doug meeting.** Everything actionable
without MIE is now DONE: **#167 CLOSED** — the durable evidence bucket is live (ADR-030:
`workwell-twh-evidence` on AWS us-east-1, least-priv IAM, `resolveBucket` app seam — the 9th
inert-unless-configured seam `bucket-s3`, selected by the three `WORKWELL_BUCKET_S3_*` vars;
`@aws-sdk/client-s3` approved dep); **#270's second line of defence is live** (nightly
`backup-neon-nightly.yml` → `pg_dump workwell_spike` → `s3://workwell-twh-evidence/db-dumps/`, 30-day
lifecycle) and the **DR drill was executed** on a live Neon branch (delete → PITR restore → rows
returned — runbook §6 ✓). **Finding: the 6-hour Neon PITR window is the Free plan's MAXIMUM** (API
verified; protected branches also 0 on Free) — so retention + branch protection are one **plan-upgrade
(billing) decision**, not settings. **#268 closed** (PR #284 had fully shipped it — `Refs` not
`Closes`). The **decommissioned Vercel zombie** (`workwell-measure-studio.vercel.app`, broken app on a
dead Fly API) was **deleted**. Doc drift reconciled: catalog counts 60→63, live scale tenant is the
**N=5000 real-eval (72,100 All-Systems outcomes)** — the 1.68M fabricated seed was rolled back
2026-07-09 (#253); stale `phase1-spike`/skeleton strings removed from `worker.ts`. **Remaining owner
steps: send #254 (unchanged) + the Neon plan-upgrade decision.** Meeting asks: confirm #254
provisional answers, register the backend-services client, MIE engineer review of `engine/`, repo
ownership, C14/C15, #287 Phase-2 appetite.

## Prior focus (2026-07-13 — independence sprint)

**2026-07-13 — independence sprint. PRs #286 (docs) + #288 (E12 PR-2c) are MERGED; the ICE adapter
merged as PR #289 (ADR-029).** Rather than waiting on #254, the WebChart contract was **self-researched from public
sources and live-verified** (public FHIR R4 sandbox `fhirr4sandbox.webchartnow.com`; docs source
`github.com/mieweb/docs`): auth is **SMART Backend Services** (RS384 `private_key_jwt` + registered
JWKS, default scope `system/*.rs`), and there is **no `Patient/$everything` and no `_lastUpdated`** —
so **E12 PR-2c was built** (PR #288, ADR-028): `httpWebChartClient` rewritten to the verified contract
(per-resource `?patient=` composition, whole-patient degrade on any resource failure, page-boundary
dedupe, off-origin guard; WebCrypto only, no new deps). Sandbox dynamic registration is **not** openly
enabled → the sharpened #254 ask is *"register a WorkWell backend-services client (JWKS attached) or
enable RFC 7591"*.

**ICE forecasting is now REAL (ADR-029, PR #289 MERGED).** The inert
`iceForecaster` stub (E6/#76) is replaced by `realIceForecaster` against a self-hosted
`hlnconsulting/ice` sidecar: a dependency-free vMR/DSS codec (`ice-vmr.ts`), injectable transport +
**dose-history source** (the E12/WebChart drop-in), whole-forecast fallback to the simulated forecaster
on any failure, `forecast()` now **async**, and the seam relaxed to **`WORKWELL_IMMZ_ICE_BASE_URL`
alone** (a self-hosted sidecar has no API key). Demo stack unset ⇒ `ice=off`, byte-identical. Answers
#254 Q D18 ourselves. Two live-only contract facts are now regression-tested: the **request's**
`base64EncodedPayload` is an **array** (a bare string 400s), and a proposal's **vaccine group is on
`<observationFocus>`, not `<substanceCode>`** (ICE proposes a product — CVX 115 Tdap under group 200 —
so substance-keying loses TDAP for any subject with no DTP history). Suite 1260: 1255 pass / 0 fail /
5 skip (the live-ICE tests self-skip). Advisory only — CQL stays the sole authority (ADR-008/ADR-012).

**Live literal eCQM diff verified in production 2026-07-13:** `GET /api/measures/cms122/fidelity/diff`
returns `mode:"literal"` (VSAC OIDs were imported 2026-07-05; DEPLOY carries the ✓ banner). #263
redesigned (`$export _since` primary / content-hash fallback); **#287 filed** (calculation-level
"compliant anywhere = compliant everywhere" — display-only today).

**Design/ops docs landed the same day (PR #290):** **#263** delta-eval (owner-gated `eval_state` DDL;
two traps: a skipped subject must still get an outcome ROW or every read model silently breaks, and the
saving is ~21% not ~99% without status-boundary caching), **#287** cross-system credit (Doug's "compliant
anywhere" — two lenses, only one preserves `All = Σ tenants`; the real payoff is an audited Phase-2 write
path), **#270** backup/DR runbook (**the live Neon PITR window is SIX HOURS** and is the only recovery
mechanism — one bucket unblocks both #167 and a nightly dump).

**Owner steps:** send the updated #254 package before the Wed 2026-07-15 Doug meeting. **Decisions now
blocking further build:** the `eval_state` DDL; Neon retention + nightly dump + branch protection;
whether cross-system credit gets its Phase-2 case-closure write path. Research record:
`docs/INTEGRATION_RESEARCH_2026-07-13.md`.

## Prior focus (as of 2026-07-11, post-#284)

**Post-#280 wave merged (2026-07-11):** **PR #283** fixed the failing production deploy (MIE
Create-a-Container job-poll window enlarged 300 s→900 s + validated `DEPLOY_JOB_POLL_ATTEMPTS`;
`backend-ts/Dockerfile` multi-staged to a ~436 MB runtime — the image had outgrown the 300 s poll
window after #258's `fqm-execution` dep + the vendored MADiE bundle); **PR #281** merged the #264
observability minimum (failed-run alerts + seam inventory); **PR #284** merged #268 (durable
scheduler — cadence derived from persisted runs, survives container restart, no schema). Deploy is
green again. Details in `docs/JOURNAL.md` (2026-07-11).

**M1 engineering is CLOSED** (PRs #271–#279). **PR #280 MERGED** — production-faithful **CMS122v14 +
CMS125v14** eCQI subsets (2026): 12-month MP, age/sex/visit, VSAC OIDs, GMI, official Oct-1 mammogram
window, hospice/palliative/mastectomy DENEX; dual-coded synthetic + WebChart roster visit stamp for
CMS125. Residual Phase 2: 66+ LTC + frailty/AI. Journal: `docs/JOURNAL.md`. Strategy:
`docs/ROADMAP_2026-07-09.md`.

**Remaining M1 owner step (not code):** **#254 — send** `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`
to Doug/Dave and record answers. That unblocks **M2** (#262 live transport, #263 delta-eval design,
#187 real identity sources).

**Active milestones after M1 code:**
- **M2 — WebChart Live Integration** (contract-gated): #262, #263, #187
- **M3 — Production Readiness:** #264 observability, #265 auth/SSO, #267–#270 (PHI env / durable
  scheduler / real tenancy / backup-DR), #167 evidence bucket, #168 Proxmox onboot
- Optional pure-code while waiting on MIE: **#264**

**eCQM accuracy posture (honest):** only **two** CMS eCQMs are runnable Active — **CMS122v14** and
**CMS125v14**, both now **production-faithful official-subset** CQL (PR #280). Catalog **metadata** for
all 49 CMS IDs (v14 = 2026) verified in `docs/TERMINOLOGY_AUDIT_2026-07-08.md`. CMS122 still has the
full diagnostic ladder (structural + estimate + subset parity + literal fqm); CMS125 has structural
fidelity + production CQL (literal ELM optional later). **47 CMS Drafts are catalog-only** — not
evaluated. OSHA/HEDIS/vax are not CMS eCQMs. Do **not** claim full MAT multi-library submission packages
or bulk eCQI parity. Detail: `docs/MEASURES.md` → "eCQM accuracy posture".

**Key recorded positions:** Option B permanently inert behind a triple trigger (#78); E14 literal diff
via fqm + pre-shipped ELM (#258 / ADR-026); worker-pool for batch CLI only (#256); tiered evidence
auto-trim >20k (#257); incremental eval deferred until MIE Q A6; demo stack never receives PHI
(`docs/PRODUCTION_READINESS_2026-07.md`).

**#251 is closed** (superseded by #258). Full 120k real-CQL on Neon is **not planned** (cost; N=5000
proof is enough for scale honesty).

**Historical (2026-07-08): the full "Option A" arc — PR #252 (`feat/scale-batch-eval`), MERGED + deployed.** Three parts (newest first):

- **Real batch live-evaluation of the `mhn` (~120k) scale tenant — the headline.** Replaces the *fabricated* scale outcomes with real, chunked, **subject-major** CQL evaluation (`batchEvaluateScalePopulation`, `backend-ts/src/run/batch-evaluate-scale.ts`) behind a pluggable `ScaleSubjectGenerator` seam (`backend-ts/src/run/scale-generator.ts`). The default `webChartRealisticGenerator` emits **real LOINC/CVX/CPT codes routed through the WebChart terminology crosswalk** (13/14 measures; `hazwoper` has no real code and passes through), so the real adapter is exercised at scale. Bounded-memory (one chunk buffered), whole-batch resumable, per-subject error-isolated (failure ⇒ MISSING_DATA + error evidence), audited `SCALE_POPULATION_EVALUATED`. CLI: `pnpm seed:scale --mode evaluate` (**default**; `--mode fabricated` legacy one release; `--trim-evidence` / auto-trim for large N). **The `mhn|Lxx|Pxx|n` encoding + `aggregateScaleRun` are UNCHANGED**. Evaluate mode refuses over legacy fabricated seeds. **Phase 4 proof done (#253):** N=5000 real-eval on Neon (~68 ms/eval). Spec/plan: `docs/superpowers/{specs,plans}/2026-07-08-option-a-scale-batch-eval*`. Later M1: worker pool (#256), tiered evidence (#257).
- **E9 (#78) — the `MeasureExecutor` seam (ADR-025).** Measure execution is pluggable; `fhirNativeExecutor` = default + correctness oracle; `sqlPushdownExecutor` = inert stub. Descriptive only (ADR-008).
- **2026 terminology/standards currency sweep** (`docs/TERMINOLOGY_AUDIT_2026-07-08.md`). Catalog versions/MIPS/LOINC/CPT/OSHA verified; vaccine-CVX crosswalk currency fixed.

**Prior (2026-07-05 → 07-07): VSAC + E14 PR-3, the UX/perf backlog sweep, the WebChart dev-DB proof, and pre-E12 foreign-data correctness — all merged + deployed.** Session arc, newest first:
- **Foreign-data correctness pre-E12 (PR #250).** The two Fable "pre-E12" items that turn into wrong answers / attack surface the day real WebChart data arrives (the class the dev-DB proof just enabled): **L14** — AI-explain prompt fencing (`buildExplainUserPrompt`: per-request nonce'd BEGIN/END evidence markers labelled untrusted-data + an 8000-char cap; hardened system prompt) closing a prompt-injection surface; **L17** — an additive `inInitialPopulation?: boolean` on `MeasureOutcome` (read from the CQL "Initial Population" define) so an out-of-program subject is distinguishable from an enrolled-but-no-data MISSING_DATA on the CLI/ingress path. M19 (codegen degenerate-numeric validation) verified already-fixed. Descriptive only (ADR-008); no schema/deps. Docs: AI_GUARDRAILS §2.2, ARCHITECTURE §7.
- **WebChart dev-DB evaluation proof — offline (#246 CLOSED; PRs #247/#248/#249).** Proves the WebChart→FHIR adapter end-to-end on MIE's real seeded dev DB (`ghcr.io/mieweb/dev-wcdb`, ~56 patients) with **no live API and no MariaDB driver**, while PR-2c (live HTTP) stays deferred behind the `WebChartClient` seam. PR-1 an OH enrollment roster (`stampEnrollment`) closing the enrollment gap (WebChart carries no `urn:workwell:vs:*` program-membership Condition); PR-2 a driver-free dev-only export → committed WebChart-shaped FHIR fixtures + a deterministic per-patient e2e proof, crosswalk firmed to MIE's actual codes (LDL LOINC `2089-1`, systolic `8480-6`); PR-3 `pnpm evaluate:webchart-devdb` prints a per-measure outcome table (28 real non-MISSING_DATA outcomes). Descriptive only; no schema/deps. Docs: WEBCHART_FHIR_MAPPING §8.1.
- **Backlog sweep — #233 perf residual, E14 GMI, UX-3/7/13/14/15 (PRs #244 + #245).** Backend (#244): pushed the latest-population-run-per-measure reduction into SQL (`listLatestPopulationOutcomes`, ~20k→~2,100 rows shipped) + the CMS122 official-subset **GMI** numerator alternative (LOINC 97506-0, closing Fable L15). Frontend UX (#245): **UX-7** styled evidence dropzone + ephemeral-storage note; **UX-14** passive metadata-chip tier (`DeliveryChip`); **UX-15** Studio version-actions grouped into an accessible disclosure; **UX-3** optimistic panel caching + a ">3s / Crunching ~1.68M outcomes" hint on /compliance + /programs/hierarchy; **UX-13** "Global" label on the header selectors (the fuller per-page filter-bar refactor deferred as a design call). Descriptive/presentational; no schema/deps.
- **E14 PR-3 — real CMS122 execution outcome diff + live VSAC on-ramp (PRs #242 + #243; ADR-023/ADR-024).** `GET /api/measures/cms122/fidelity/diff` is now a **real, subject-by-subject execution diff**: build → harness-local VSAC enrich → evaluate WorkWell's `cms122` AND an official-**subset** measure fresh → diff with per-gate attribution. #242 landed the live VSAC resolver behind the `ValueSetResolver` port (`CompositeValueSetResolver`, key-gated inert-unless-configured; `pnpm resolve-valuesets` import CLI). A compile-feasibility spike proved the *literal* QICore CQL un-compilable under the pinned JVM-free translator, so the deliverable is a faithful official-subset (`cms122_official.cql`); revisit on a stable multi-model translator (ADR-024). Descriptive only; no schema/deps.

**Earlier arc (2026-07-04 → 07-05), all merged — kept for context:**
- **UX-11 — compliance roster mobile cards (PR #241).** `/compliance` renders per-employee cards below `md` (`RosterMobileCards`: name link + tenant·site·role + a `<dl>` of measure→`ComplianceChip`); the table stays at `md`+. CSS-only responsive (`display:none` keeps the hidden layout out of the a11y tree). No backend/schema/deps.
- **UX-8 — program-card trends onto monthly `quality_snapshots` (PR #240).** The `/programs` per-card trend was flat under daily scheduled runs; rewired to the monthly E16 snapshot series, **opt-in via `?granularity=month`** so only the card switches (the measure page stays per-run + keeps its E16 card). Scoped by tenant/site with a per-run fallback for <2 months **or a partial-month range** (`isWholeMonthRange`). Newest-first, `compliant/total` rate matching the headline (both Codex/review-driven). Additive `ProgramTrendPoint.period` + frontend `trendMeta`. **Known:** the default All-Systems trend is flat because the time-invariant 120k `mhn` scale tenant dominates the aggregate (per-tenant scopes vary correctly) — a documented demo-data property (DEPLOY.md), not a bug. No schema/endpoint/deps.
- **perf(#233) — roster + hierarchy latency ~5–6× faster warm (PRs #238 + #239).** `listOutcomesWithRun` was seq-scanning all ~1.7M `outcomes` to exclude the scale tenant (predicate on the joined `runs.triggered_by`); rewrote it to `o.run_id = ANY(<live run ids>)` → the `spike_outcomes_run_id_idx` bitmap scan (**3,242ms → 41ms** live, verified via `EXPLAIN ANALYZE` + COUNT parity). Memoized `aggregateScaleRun` (immutable COMPLETED `seed:scale` runs) + a per-immutable-run **roster cell cache** (skips the ~1.3MB `evidence_json` reload), made sound by a **`/api/runs/:id/evaluate` 409 on terminal runs** (enforces "terminal run = immutable", the invariant the runId-keyed caches rely on). Live warm: roster ~1.0s, hierarchy ~1.1s (from 5–13s). Residual (not done): a `DISTINCT(measure,run)` query for the last ~1s, and the Neon 0.25-CU cold-start (owner cost call). Issue #233 left open with these documented. No schema/deps.
- **WCAG 2.2 AA audit + remediation (PR #237).** Whole-`frontend/` code-level pass (5 parallel auditors): 0 critical, 1 High, ~40 mechanical, all fixed — the High was a keyboard-inaccessible OSHA-reference combobox → a real ARIA combobox; plus `aria-live`/`role=alert` (~19), contrast tokens (~15), focus rings, target sizes, admin ARIA tabs. Audit report: `docs/WCAG_AUDIT_2026-07-03.md`. A live NVDA/keyboard walk of the 5 core flows is the remaining human step.

**Earlier this session (2026-07-02 → 07-03), all merged:** **E15 complete** (PR-2 reconcile write path #224 + merge-picker #225 — `person_links` first E15 schema, override-aware `resolvePeople`, audited reconcile route); a **Fable correctness/security/scale hardening pass** (PRs #226–#232 — fully-audited population-run pipeline, state-aware case upsert, cycle-rollover closeout, bounded 120k run-detail reads, spike-store indexes, UTC-stable evidence dates); **E12 PR-2b — WebChart→FHIR adapter core** (PR #234 — terminology reconciliation + normalize + injectable `WebChartClient`; HTTP transport deferred to the MIE API-contract meeting; `docs/WEBCHART_FHIR_MAPPING.md`); and the **UI/UX Fable pass-3 + a11y** groundwork (PRs #235/#236). Fable review artifacts under `docs/FABLE_REVIEW_2026-07-02/`.

**Backlog status (verified 2026-07-07): the actionable polish backlog is drained.** Every genuinely-open, non-blocked item the prior focus block listed is now merged — **UX-7** and the UX-3/13/14/15 design-y [L]s shipped in #245, the **#233 perf residual** in #244, and **E14 PR-3 shipped** (#242/#243; it was previously listed blocked-on-VSAC-creds — the live VSAC on-ramp resolved that). Also already-closed from the Fable list: UX-9 (scale provider naming), UX-12 (`fmtCount`), UX-16 (unified `AccessDenied`), UX-18 (Scheduled trigger filter). The **5 remaining open issues are all blocked or owner-gated**: **#167** evidence S3/R2 BUCKET (owner-gated infra — **deferred by decision 2026-07-07**; it's evidence-*byte* persistence across container recreates, not code — the `CloudBucket` port already abstracts it, so it's a provision-bucket + secrets + deploy-config step); **#168** Proxmox `onboot` (MIE-side nice-to-have; the self-heal reconciler already covers reboot recovery); **#187** E15 PR-3 (real WebChart identity sources — needs E12 PR-2c); **#186** E14 residual (the *literal* QICore-CQL diff — needs a stable multi-model translator release); **#78** E9 — the *decision* + the `MeasureExecutor` seam are now **shipped** (ADR-025, 2026-07-08); what remains is **Option B**, the actual CQL→SQL transpiler, a research-grade epic gated on a concrete high-volume WebChart measure + the confirmed WebChart schema (same gate as E12 PR-2c) — **not code-actionable now**. **E12 PR-2c** (live WebChart HTTP transport) waits on the MIE API contract (Dave Carlson). With E9 decided, the remaining open items are all blocked/owner-gated — the next move is external input or an owner decision, not a build.

---

**Historical (2026-07-01): E15 PR-2 — identity reconcile write path** (branch `feat/e15-identity-reconcile`; merged as **PR #224**; ADR-022, #187). **First E15 schema:** owner-approved `person_links` table (floor + ceiling, `workwell_spike`; DATA_MODEL §3.26; self-creating DDL, applies on deploy) — a human-confirmed CONFIRMED/BROKEN assertion between two source records, pair-normalized (direction-independent), `PersonLinkStore` port (store-contract tested). `resolvePeople` is now **override-aware** (union-find: CONFIRMED unions, BROKEN splits); component `personId` = smallest record ref-key (unique per component). `POST /api/identity/people/:personId/reconcile` (`{action: CONFIRM_LINK|UNLINK, tenantId, externalId}`) — **CASE_MANAGER/ADMIN-gated** + audited (`IDENTITY_LINK_CONFIRMED/BROKEN`). Frontend: CM/ADMIN "unlink" action per linked system on `/people/[personId]`. **`/api/identity/**` + the `/people` nav are CASE_MANAGER/ADMIN** (the directory exposes national/MRN ids + DOB). Descriptive only (ADR-008); E13 reconciliation unaffected; reversible (`DELETE FROM person_links`). Whole-branch code review folded in (UNLINK breaks target vs all members, CONFIRM validates target exists, PII read-gate, audit semantic roles). **840 tests (839 pass / 1 pg-skip); frontend lint + build green. No new deps.** Deferred: a CONFIRM_LINK merge-picker UI (API-ready). **Next:** Codex rounds → merge.

**Merged (2026-07-01): E15 PR-1 — cross-system identity** (**PR #223 merged**; ADR-022, #187). The buildable-now synthetic-first person-identity layer: a pure read-time `backend-ts/src/identity/` module (`matchKey` deterministic grouping on a shared national/MRN id — the EMPI seam; `resolvePeople`/`duplicateCandidates`; `mergedComplianceTimeline` — outcomes unioned across linked systems, system-tagged, with a PRIOR→ACTIVE mobility annotation). Cross-system people modeled in the directory with **no schema/no count change** — a shared synthetic `nationalId`/`dateOfBirth` on two existing twh↔ihn pairs (`emp-006` "Omar Siddiq" moved twh→ihn = mobility subject; `emp-007`/`ihn-emp-002` = plain duplicate). `GET /api/identity/{people,people/:id,duplicates}` (authenticated read-only, wired in `worker.ts`). Frontend: new `/people` route (DUPLICATE badge + search) + `/people/[personId]` (mobility banner + merged timeline). **Descriptive only — never sets `Outcome Status` (ADR-008); E13 reconciliation preserved (guard test).** Reconcile write path = PR-2 (owner-gated); real WebChart sources = PR-3 (blocked on E12 PR-2 / MIE schema). **831 tests (830 pass / 1 pg-skip); frontend lint + build green. No schema, no new deps.** Four Codex P2s addressed (duplicate-worklist excludes moved, full merged timeline, UTC move dates, badge moved-vs-duplicate).

**Merged (2026-07-01): E16 PR-2 + PR-3 — quality-over-time history read API, backfill CLI, and UI** (**PR #222 merged — E16 complete**). Built on the merged PR-1 snapshot store (#221). **PR-2:** `GET /api/quality/history?measureId=&scopeLevel=&scopeId=&tenant=&from=&to=` (`routes/quality.ts`, bounded snapshot time-series read, `YYYY-MM` validation, authenticated read-only, wired in `worker.ts`) + `pnpm seed:quality-history [--months 12] [--as-of YYYY-MM]` (`run/backfill-quality-history.ts` + `run/cli/seed-quality-history*.ts`) — materializes **real evaluated** snapshots for past months (re-evaluates the directory as-of each month end reusing the Simulate #197 anchoring, folds `mhn` via bounded `aggregateScaleRun`), **superseding** the synthetic sine-wave `seed:trend-history` for the quality trend; audited `QUALITY_HISTORY_BACKFILLED`, idempotent + resumable at the month level, reversible (`DELETE FROM quality_snapshots`). **Scoping deviation:** `programTrend` (the /programs overview cards) stays on live per-run aggregation (safe fallback); the snapshot-backed trend lands at the presentation layer. **PR-3:** a "Quality over time (source of truth)" card on `/programs/[measureId]` (`QualityOverTime`) — scope selector (All Systems / per WebChart system) + as-of month picker + "compliance on month M" numerator/denominator KPI + snapshot-backed monthly area chart with `ChartDataTable` sr-only alternative. **817 tests (816 pass / 1 pg-skip); frontend lint + build + 107 vitest green. No schema change, no new deps.** Docs updated (ARCHITECTURE §4/§7, DATA_MODEL §3.24, DEPLOY, JOURNAL). Four Codex P2s across two review rounds folded in (partial-month resume, card refresh, `--as-of` month validation, UTC labels). **Owner step post-deploy:** run `pnpm seed:quality-history --months 12 --as-of 2026-06` against Neon to backfill live history.

**Merged (2026-06-30): E16 PR-1 — quality-over-time snapshot store** (**PR #221 merged**). Addresses Doug's June-24 *"your system is the source of truth for quality over time"* ask: a materialized **AGGREGATE** `quality_snapshots` table (NEW schema, floor + ceiling self-creating `CREATE … IF NOT EXISTS`; one row per measure × calendar month × scope `all→tenant→site→provider`; numerator/denominator + the 5 bucket counts) written by `materializeRun` on every completed population run (ALL_PROGRAMS/MEASURE) — hooked **best-effort** into `finishManualRun` after `finalizeRun` (covers sync + async + scheduler), the scale tenant folding in via the bounded `aggregateScaleRun` (**never** the 120k rows). Pure `buildSnapshotRows` core reconciles **All = Σ tenants = Σ sites = Σ providers**; idempotent on (measure_id, period, scope_level, scope_id); audited (`QUALITY_SNAPSHOT_MATERIALIZED`); aggregate-only (no per-employee row); **descriptive — CQL `Outcome Status` stays authoritative** (ADR-008/ADR-021). Keyed by `measure_id` (outcomes slug), not `measure_version_id`. **803 tests (802 pass / 1 pg-skip / 0 fail).** **Next:** PR-2 = `GET /api/quality/history` + as-of backfill CLI (replaces the synthetic sine-wave trend-history) + `/programs` trend rewired to snapshots; PR-3 = UI (scope selector + as-of month picker + "compliance on date D" KPI). Docs: ADR-021, DATA_MODEL §3.24, ARCHITECTURE `quality` module; plan in `~/.claude/plans/where-are-we-on-agile-hammock.md`.

**Latest (2026-06-30): housekeeping + a11y session.** Closed the **E11 epic (#183)** (all sub-PRs were merged/live; the tracking issue was just never closed). Opened **`feat/wcag-chart-a11y`** (in review) — the WCAG **chart accessible-alternatives** deferred from PR #210: a shared `ChartDataTable` (`frontend/components/chart-data-table.tsx`, `sr-only` captioned table) paired with each of the 3 Recharts charts (now `aria-hidden`), 6 unit tests, 105 vitest green + build green; no schema, no new deps. Drafted the **E15 (#187)** and **E9 (#78)** specs (both *Draft — pending owner review*): `docs/superpowers/specs/2026-06-30-e15-cross-system-identity-design.md` (synthetic-first PR-1 buildable now over the E13 directory; real EMPI blocked on E12 PR-2) and `docs/superpowers/specs/2026-06-30-e9-cql-sql-bridge-decision-memo.md` (recommends hybrid pluggable executors; awaiting Doug Q2).

**Latest (2026-06-29): E14 PR-2 (criteria-impact outcome diff, PR #217) and E13 PR-3 (scheduled cron recompute, PR #216 — closes E13) are merged + deployed. E13 PR-2 (population-scale 120k, PR #215), E13 PR-1 (multi-tenant rollup, PR #214), and everything before are also merged + live.** The June-15 demo produced a roadmap of epics E10–E15 (#182–#187, label `webchart-convergence`).

Most recent (the 2026-06-29 session), newest first:
- **E14 PR-2 — criteria-impact outcome diff (#186, PR #217 — merged + deployed):** `GET /api/measures/:id/fidelity/diff` — a pure criteria-impact analysis (`computeOutcomeDiff`, `backend-ts/src/standards/outcome-diff.ts`) that shows criterion-by-criterion how many subjects from the latest CMS122 population run would have different outcomes if the official eCQM criteria (currently OMITTED/SIMPLIFIED) were applied. 14 unit + integration tests; 785 pass, 1 pg-skip, 0 fail. Structural-first (ADR-018); full CQL execution diff deferred to PR-3 (blocked on VSAC credentials). Descriptive only (ADR-008); no schema, no new deps.
- **E13 PR-3 — scheduled cron recompute (#185, PR #216 — merged + deployed; closes E13):** wires the previously-inert `/api/admin/scheduler` to fire real audited `ALL_PROGRAMS` runs on a 24-hour interval. An in-process `setInterval` (5-min tick × 23.5h debounce), opt-in via `WORKWELL_SCHEDULER_ENABLED=true`. `SCHEDULER_RUN_TRIGGERED` audit event written **before** `planManualRun` (hard rule). `triggerType:"SCHEDULED"` on `GET /api/runs`. No schema, no new deps. 770 tests: 769 pass, 1 pg-skip, 0 fail.
- **E13 PR-2 Codex fixes + merge (PR #215 — merged + deployed):** Four Codex P2 review items resolved before merge: (1) **site filter** — `foldScaleCounts` now skips the scale fold when `?site=` is active (scale has its own location dimension; live-site filtering would add unfiltered 120k data); (2) **date window** — both `foldScaleCounts` (programs overview) and `buildHierarchyRollup` (hierarchy rollup) now filter `seed:scale` runs by `from`/`to` using the existing `day()` helper; (3) **React key dedup** — provider IDs in `buildScaleSubtree` are now location-qualified (`${locId}:${provId}`) so mhn providers `P00`–`P09` aren't shared across 24 locations in the hierarchy UI; (4) **partial-seed idempotency** — idempotency check now requires `r.status === "COMPLETED"`; seed flow changed to create RUNNING → write outcomes → `finalizeRun(COMPLETED)`, so a crash leaves a non-COMPLETED run that gets re-seeded next invocation. 765 tests: 764 pass, 1 pg-skip, 0 fail. **Owner step done:** `pnpm seed:scale --subjects 120000 --as-of 2026-06-26` seeded 1.68M mhn outcomes on Neon.
- **E13 PR-2 — population-scale tenant (120k) (#185, PR #215 — merged + deployed):** proves the rollup scales to a ~120k-subject tenant (`mhn` / "MetroHealth Network") on the live stack. Live-evaluating 120k×14 ≈ 1.68M CQL/run is infeasible, so the scale tenant is **generated, not live-evaluated** — seeded once on-demand by **`pnpm seed:scale`** (owner-run, NOT on deploy), its 120k subjects living **only** as `outcomes` rows whose `subject_id` encodes the hierarchy (`mhn|Lxx|Pxx|n`; `engine/synthetic/scale-structure.ts`). A new **`OutcomeStore.aggregateScaleRun(runId)`** does a single SQL `GROUP BY` → O(providers) rows, **never** the 120k per-subject rows (bounded memory; a test asserts the group count is independent of N). The hierarchy rollup + programs overview **exclude `seed:scale` runs from the in-memory scan** and build/fold `mhn` from the aggregation (`program/scale-rollup.ts`; **provider-leaf** — no 120k patient nodes; reconciles All = Σ tenants). `?tenant=mhn` isolates it. Roster excluded; CQL stays authoritative for live subjects (ADR-008/ADR-020). **No DDL, no new deps; reversible** (delete `seed:scale` runs+outcomes). Spec/plan: `docs/superpowers/specs/2026-06-26-e13-population-scale-design.md`, `docs/superpowers/plans/2026-06-26-e13-population-scale.md`.
- **E13 PR-1 — multi-tenant (multi-system) rollup (#185, PR #214 — merged + deployed):** a **tenant/system dimension** above enterprise→location→provider→patient, modeled **read-time in the synthetic directory** (no schema; ADR-019). A `Tenant`/`Enterprise` model + `tenantId` on `EmployeeProfile`/`Provider`; a second synthetic WebChart system **Indus Hospital Network** (`ihn`, 50 employees / 3 campuses) joins the existing **Total Worker Health** (`twh`, 100) — `EMPLOYEES` spans both so runs evaluate everyone. The rollup returns a single reconciling **"All Systems"** root (`level:"all"`) → tenant → enterprise → location → provider → patient (tenant-qualified maps; All = Σ tenants), with `?tenant=<id>` returning a tenant subtree. **Multi-tenant-everywhere** via an optional `?tenant=` filter on `/api/hierarchy/rollup`, `/api/compliance/roster` (rows carry `tenantId`/`tenantName`), `/api/programs/*`, plus a new `GET /api/tenants`; frontend **System** `<select>` on `/programs`, `/compliance`, `/programs/hierarchy`. Display/grouping only — CQL `Outcome Status` stays authoritative (ADR-008). No schema, no new deps; reversible. Backend typecheck + full test green; frontend lint + build + 99 vitest green. Spec/plan: `docs/superpowers/specs/2026-06-26-e13-multitenant-rollup-design.md`, `docs/superpowers/plans/2026-06-26-e13-multitenant-rollup.md`.
- **E14 PR-1 — standards fidelity diff (#186, PR #212):** a new `backend-ts/src/standards/` module that diffs WorkWell's authored eCQM measure against the **official spec**. A vendored, **sourced** CMS122v14 reference (official population criteria + ~21 VSAC value-set OIDs + provenance URLs — OIDs verified against the official QDM HTML after 3 Codex P2 corrections) + a pure `computeFidelity(ref)` → `FidelityReport` (COVERED/SIMPLIFIED/OMITTED per criterion + value-set fidelity + summary) → `GET /api/measures/:id/fidelity`; a `jurisdiction` measure-metadata field (default `US`) + a country-aware design memo. **Structural-first (ADR-018)** — official-CQL *execution*/outcome diff is deferred to PR-2 behind the E3.2 `ValueSetResolver` seam. Descriptive only (ADR-008); no schema, no new deps.
- **Deploy reliability (PR #211):** `deploy-mieweb-container.sh` now **polls** the post-create container status until `running` (~3 min / 18×) instead of a single eager read that raced startup (the `"offline, expected running"` false-failure). A separate transient MIE Container-Manager outage caused follow-on failures; a clean re-trigger of the main deploy recovered the stack and validated the fix.
- **WCAG accessibility pass (PR #210):** keyboard-accessible activation (`/runs` rows → real first-cell `<button>` preserving table semantics; ELM-Explorer AST select-target un-nested from its toggle), Studio **ARIA tab pattern** (roving tabIndex + arrow nav), `aria-live` run-status + AI-explain announcements, stable list keys. Verify-first found the app already largely accessible (all hand-written `<th>` had `scope="col"`). Chart accessible-alternatives split out as a follow-up. No new deps.
- **QA follow-ups closeout (PR #209):** **M1** — `nextActionFor` now keyed by `measureId` across all 14 runnable measures (was defaulting every non-OSHA measure to "audiogram") + a regression-guard test; **H2** — an inert `sendgridEmailService` + `resolveEmailService(env)` seam (simulated default; SendGrid stub only when configured) so code matches the docs, threaded into single-case outreach too; **evidence persistence** — documented that the `CloudBucket` port already abstracts it (a managed S3/R2 bucket is a deploy-config step, not code). No schema, no new deps.
- **E12 PR-1 — pluggable data ingress (#184, PR #208):** a `backend-ts/src/engine/ingress/` module above the unchanged engine — DB-less `evaluateBundle`/`evaluateBatch` (JSON-bucket, per-item error isolation), a `PatientDataSource` port + `resolveDataSource(env)` config selection, an inert `webChartDataSource` stub, and a CLI refactor to reuse it. Records the E9 (#78) **FHIR-native-first** fork (ADR-017). No schema, no new deps. **PR-2 (WebChart/MariaDB→FHIR adapter depth) is parked — it needs a reference to MIE's real WebChart schema.**

**Next:** E14 PR-3 (full official-CQL execution/outcome diff via ValueSetResolver — blocked on VSAC credentials); E12 PR-2 (WebChart/MariaDB→FHIR adapter — blocked on MIE schema); E15 (#187, cross-system identity — leans on E12+E13; spec drafted 2026-06-30). The deferred WCAG chart accessible-alternatives is in review on `feat/wcag-chart-a11y`. **E13 is fully closed (PRs #214/#215/#216):** all owner steps done — `pnpm seed:scale` seeded 1.68M mhn outcomes on Neon; `All Employees` segment widened to all 7 sites (audited); `ALL_PROGRAMS` run evaluated all 150 employees — live All Systems = 1,682,100 (ihn 700 + twh 1,400 + mhn 1,680,000).

**Earlier roadmap (E10–E11) — shipped + deployed:**
- **E10 — roster-centric compliance + measure taxonomy (#182):** a `complianceClass: PERMANENT|RECURRING` field + 3 permanent series-completion vaccine measures (`mmr`, `varicella`, `hepatitis_b_vaccination_series`) → **now 14 runnable / 63 catalog**; an "Individual Compliance Status" roster grid (`/compliance`, `GET /api/compliance/roster`) with an E10.5 display vocabulary (COMPLIANT/DUE_SOON/OVERDUE/MISSING_DATA/EXCLUDED/DECLINED/IN_PROGRESS/NA); a per-employee compliance card (Recalculate, evidence drill-in, Simulate Compliance History). No schema beyond the taxonomy field.
- **E11 — rule-builder + CQL-canonical decision + segments (#183):** **E11.1** ADR-015 — *CQL is canonical; rule-params compile to CQL* (rule→CQL codegen). **E11.2a/b/c** — codegen titer/grace/declination, the Studio **Rule Builder** tab, multi-alternative series + **live Hep B repointed to Heplisav-vs-traditional** (#204). **E11.3 PR-1 — risk-group SEGMENTS backend (#205, merged + deployed + verified live):** the first E11 schema (3 owner-gated tables `segments`/`segment_measures`/`segment_overrides`, floor + ceiling, `SegmentStore` port); a single pure applicability engine (`segment-applicability.ts`) gating the roster (`NOT_APPLICABLE` overlay + `?segment=` filter) + run-pipeline case creation — **never compliance** (ADR-016; CQL stays authoritative); ADMIN-gated audited `/api/segments` CRUD + `/preview`; 3 enabled demo cohorts (seed ships enabled → overlay live on the demo). Reversibility: zero enabled segments ⇒ everything applicable (pre-E11.3 behavior). Two Codex P2s addressed (per-operator value-shape validation + seed-once-before-any-consumer). Live-verified: tables self-created on Neon, overlay correct across panels.
- **E11.3 PR-2 — Configure Groups UI (#206, merged + deployed — closed E11):** the backend endpoint `POST /api/segments/preview` (ADMIN, read-only dry-run cohort membership for an unsaved rule; reuses `matchesCohort`/`validateRule`; shared `previewResponse` helper) + a `/admin → Groups` editor (`SegmentsAdmin`/`SegmentsList`/`SegmentEditorModal` — rule builder + applicable measures + INCLUDE/EXCLUDE overrides via the existing `/api/employees/search` + live preview; ADMIN-gated New/Edit/Delete via `canManageSegments`) + the roster `NOT_APPLICABLE` chip (`lib/status.ts`) + the `/compliance` segment filter (`?segment=`). No schema, no new deps. Verified green (backend 704 pass/1 pg-skip; frontend lint clean + 97 vitest pass + build). Two Codex follow-ups addressed (P2 trim scalar rule values before save; P3 doc currency). Spec/plan as historical context: `docs/superpowers/specs/2026-06-25-e11-3-segments-ui-design.md`, `docs/superpowers/plans/2026-06-25-e11-3-segments-ui.md`. **Next epics after E11:** E12 #184 (pluggable data adapters), E13–E15.

Open follow-ups (still tracked): a managed S3/R2 `BUCKET` so evidence upload persists (the `CloudBucket` port already abstracts it — a deploy-config + credentials step, **not code**; recipe in `docs/DEPLOY.md`). The WCAG **chart accessible-alternatives** (a hidden data-table/summary per Recharts chart) is now implemented and in review on `feat/wcag-chart-a11y` (no longer open once merged). **Closed this session (PRs #209/#210):** M1 (`nextActionFor` now measure-aware), H2 (inert `resolveEmailService`/SendGrid seam — code now matches docs), and the WCAG semantics pass (keyboard activation, ARIA tabs, `aria-live`, table-row semantics) — so these are no longer open.

**Earlier (2026-06-21): QA/UX hardening pass 2 (#181, merged + deployed; merge `b5d9f7c`).** A second QA pass on top of #180 — verified blocks 4–11 live, ran a 13-surface / 80-finding multi-agent UX/RBAC/perf audit, then fixed it all across 22 commits (no schema change, no new deps, keeps `@mieweb/ui`). Themes: **role-aware nav + action-button gating** (`frontend/lib/rbac.ts` mirrors `authorize.ts`) — fixes "every role sees every option then 403s" (**closes M2**); **backend correctness** — `programOverview/Trend` exclude in-flight runs (the Evaluations count no longer bounces) and `caseTimeline` is single-source `audit_events` (no duplicated timeline entries); **programs/measure-detail perf + charts** (progressive render, parallel fetches, dynamic padded y-domain, whole-card click); **cases** OVERDUE/outcome filter + page-size + table view; **runs** the missing MeasureReport/QRDA buttons + fixed Status/Scope/Trigger filters (lowercase values never matched the uppercase enums) + SEED column; **case detail** next-action CTA + assignee type-ahead + dark-mode + "CQL Evidence Explorer" rename; **admin** tabbed IA + wired the outreach delivery log to `CASE_OUTREACH_SENT` audit events (**closes M3**) + live AI integration tile keyed on `OPENAI_API_KEY` (**closes M4**) + grid-overflow fix; **new CM/ADMIN `/orders` page** surfacing the previously UI-less E7 order-proposal API; **employee-detail** 2-column redesign; a **global, durable run-progress indicator** (`RunStatusProvider` — survives nav + reload, fires `ww:run-complete`); a **conservative API GET dedup + 1.5s-TTL cache** busted on every write (replaces blanket `cache:"no-store"`); an **a11y pass** (`scope="col"` + input labels); and **bounded audit-ledger SQL reads** (`recentAuditEvents(limit)` / `auditEventsForCases(ids,limit)`) so the admin viewer + employee profile stop materializing the whole ledger. Three code reviews (initial, full-branch, maintainer PR review — 9 items fixed in `a5433f2`; 3 verified false positives left with evidence: measure-name resolution, `/api/runs` returning `runId`, the campaigns zero-recipient guard). **Still open: M1** `nextActionFor` mislabels non-OSHA measures as "audiogram" (`case-logic.ts`), **H2** SendGrid documented but absent in `backend-ts`, and a full WCAG audit beyond table/label basics. The synthetic-trend amplitude was bumped (needs a `pnpm seed:trend-history` re-seed to surface; the new chart auto-scale already reveals the existing ±6% live).

**(2026-06-21): full QA smoke test + synthetic trend-history feature (#180, merged + deployed).** An end-to-end adversarial QA pass of the live app (all 4 roles; report `docs/QA_SMOKE_TEST_2026-06-20.md`) confirmed a real, working, secure app; open follow-ups (not yet fixed): **M1** `nextActionFor` mislabels non-OSHA measures as "audiogram" (`case-logic.ts`), **M2** `/campaigns` silently 403s for AUTHOR/APPROVER, **M3/M4** admin outreach-delivery-log hardcoded `[]` + integration health static, **H2** SendGrid documented but absent in `backend-ts`, plus systemic accessibility debt. **H1 fixed live** — `adult_immunization` had never been in a population run (last ALL_PROGRAMS predated the E6 merge); an ALL_PROGRAMS run populated it (80% / 17 cases). **#180 — synthetic trend-history backfill** (`pnpm seed:trend-history` CLI + `backfillTrendHistory`) writes backdated weekly COMPLETED MEASURE runs so `/programs` trend charts vary instead of flat-lining; week-level idempotent, anchored before each measure's latest real run (overview never hijacked), audited (`TREND_HISTORY_SEEDED`), **no schema change**, seed runs labeled `SEED` (`GET /api/runs?triggerType=SEED`). Hardened across 9 Codex rounds + code-reviewer. **Seeded live on Neon: 132 runs + 13,200 outcomes; 10/11 measures now show varied trends** (audiogram flat-ish — pre-existing real runs fill the 10-point cap). Reversible (two-step schema-qualified rollback; see `docs/DEPLOY.md`). Design: `docs/superpowers/specs/2026-06-20-synthetic-trend-history-design.md`.

**#109 is fully closed: PR4 (#164) + the reconciler (#163) are merged to `main`, deployed, and verified in production (2026-06-18).** Post-merge E2E: the API smoke (`scripts/smoke-shadow.sh`) is 19 pass / 0 fail / 2 warn (the 2 warns are the documented ephemeral-BUCKET + MCP-SSE limitations), and the `/programs` dashboard renders live through the real browser path. Merged local feature branches deleted, remotes pruned, and the 366 MB leftover untracked `backend/` tree removed (recoverable via `git checkout 91182dd -- backend/`). **E2 — declarative YAML measures + headless evaluator (#72) — also shipped: the packaged headless evaluator CLI (`backend-ts/src/engine/cli/`, `pnpm evaluate --patient <bundle.json> --measure <id>`) merged in #165, deployed, and verified. Next: the following roadmap epic (#73).**

**The #109 deploy cutover is COMPLETE and the JVM is retired (PR4).** `https://twh.os.mieweb.org` is served by the de-Java TypeScript backend (`twh-api-ts`, `backend-ts/`) on the existing Neon Postgres via the `Pg*Store` ceiling (isolated `workwell_spike` schema). **The Java/Spring backend is gone — `backend/` is deleted, the Java build/deploy jobs and the `deploy-twh-ts-shadow.yml` workflow are removed, and `backend-ts` is the CI-gated (`ci.yml`, floor + Pg ceiling) sole backend.** Path: PR1 image (#155) → store-selection seam (#156) → shadow deploy + Neon-pooler `options` fix (#157/#158) → blue-green flip (#159) → pre-retirement hardening: CI gate (#161), observability + orphaned-run recovery (#162), self-heal reconciler (#163) → JVM retirement (PR4). #150 demo-readiness is fully closed (all 21 items). Reboot/crash recovery is handled by the self-heal reconciler (`reconcile-twh-mieweb.yml`), independent of Proxmox `onboot`. (The evidence-upload-is-ephemeral limitation noted here historically was closed 2026-07-14 — #167/ADR-030, the `bucket-s3` seam.) Plan/resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`.** (Strategic roadmap epics #71–#78 — E1 (#71), E2 (#72), and E3 (#73 — MeasureReport, value-set expansion, QRDA III, QI-Core) all merged + deployed; E4 (#74) is next.)

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
- **Next up:** **#109 is done (JVM retired).** Open follow-ups: ~~a managed S3/R2 `BUCKET`~~ (**done 2026-07-14** — #167/ADR-030, evidence is durable on `workwell-twh-evidence`); confirming Proxmox `onboot` with MIE (nice-to-have — the self-heal reconciler already covers reboot/crash recovery). **E2 (#72, headless evaluator CLI) and the full E3 epic (#73 — FHIR MeasureReport #89, value-set expansion #90, QRDA III #91, QI-Core #92) are complete, merged, and deployed.** **E4 — multi-level dashboards (#74, sub-issues E4.1 #93 + E4.2 #94) is complete on the `feat/issue-74-multi-level-dashboards` branch (deploys on merge to `main`):** the enterprise→location→provider→patient hierarchy is modeled in the synthetic employee directory with **no DB schema change** (finding: backend-ts has no `employees` table, so the #93 stop-and-ask gate was satisfied with no migration — ADR-010), a reconciling rollup read model + `GET /api/hierarchy/rollup`, and a drill-down UI at `/programs/hierarchy`. **E5 — outreach at scale (#75) is complete, merged + live:** multi-channel outreach via the `OutreachChannel` port (EMAIL/SMS/PHONE simulated adapters + an inert DataChaser stub — `resolveChannel` is simulated by default, DataChaser inert unless both `WORKWELL_OUTREACH_DATACHASER_*` env vars are set, mirroring SendGrid), bulk campaigns behind a `CampaignStore` port (audit-backed `OUTREACH_CAMPAIGN_COMPLETED` adapter — **no schema today**; Pg `outreach_campaigns`/`outreach_delivery_log` drop-in documented), `POST/GET /api/campaigns` (CASE_MANAGER/ADMIN-gated), a `/campaigns` launcher UI, and a channel selector on the case outreach action. Simulated by default; ADR-011. **E6 — immunization & forecasting (#76) is complete, merged (#177), deployed, and verified live (2026-06-19):** the `ImmunizationForecast` port (`simulatedForecaster` default over its own 3-series synthetic history; inert `iceForecaster` stub selected only when both `WORKWELL_IMMZ_ICE_*` env vars are set — Doug Q5 deferred behind it), `GET /api/immunization/forecast`, the `adult_immunization` runnable measure (real NCQA HEDIS **AIS-E** Td/Tdap, 10y window; CMS117 was pediatric-mismatched so AIS-E was chosen), contraindication→EXCLUDED + documented-refusal-kept-open, and an advisory forecast on `/cases/[id]`. **No schema** (ADR-012); forecast is advisory (CQL stays the sole compliance authority). Seeding is now an idempotent back-fill so catalog additions appear on the already-seeded live stack (Codex P1 fix). **E7 — order/action generation (#77) is complete, merged (#178), deployed, and verified live (2026-06-19):** the `order/` module — a pure, trigger-agnostic `proposeOrders` engine (Panel=Risk selection + risk→priority + in-batch/standing-order dedupe with urgent-priority merge), an action-evaluator order catalog (reuses the terminology_mappings seed), the `StandingOrderProvider` port (simulated default; inert `ehStandingOrderProvider` stub when `WORKWELL_EH_FHIR_*` set), and `ProposedOrder`→FHIR `ServiceRequest` mapping — exposed read-only via `GET /api/orders/proposals` (CASE_MANAGER/ADMIN; `domain|fhir`; derives only from terminal population runs). Advisory only (a human submits; CQL stays authoritative); **no schema**; the EH `OrderSubmitter` write path is named-but-deferred. ADR-013; Codex P2 ×2 addressed (terminal-run filter, severity merge). **Next roadmap epic: E9 — CQL→SQL bridge (#78), a spike / decision memo only (no code; tied to Doug Q2).** Resume guide: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`. `docs/JOURNAL.md` carries the running narrative. (A fuller strategy roadmap and the open strategic questions for Doug are kept as local-only working files on the maintainer's machine, not committed to the repo.) NITRO data-grid is now **unblocked** — vendored `@mieweb/datavis` source under `frontend/vendor/datavis` + `datavis-ace` from npm; live on `/measures`, `/runs`, `/admin` (ADR-007). Remaining `@mieweb/ui` form-control swap split out as issue #99. (Asking Doug to publish a built `@mieweb/datavis` to npm so `vendor/` can be dropped is still pending.)
- Schema migrations are owned by Taleef — stop and ask before writing any `V0xx__*.sql` file
- Treat `docs/archive/SPIKE_PLAN.md` as historical context only
