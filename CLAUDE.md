# CLAUDE.md — WorkWell Measure Studio

## What this is
- Single-developer TypeScript + Next.js monorepo (backend re-platformed off Java/Spring — #96 / ADR-008; JVM retired in #109 PR4)
- Goal: keep the merged WorkWell Measure Studio MVP stable, showcaseable, and easy to review
- Historical sprint window: May 2-17, 2026; active work is now post-merge closeout and polish

## Read first, every session
`docs/archive/SPIKE_PLAN.md` is the archived sprint plan and historical context. `docs/JOURNAL.md` is the current source of truth for recent work, and `README.md` is the public-facing overview.

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
- Use a feature branch per task, named `feat/<slug>` or `fix/<slug>`
- Merge after my review — no auto-merge
- Work **one task at a time**; keep changes small and focused
- One PR per task — do not batch unrelated changes. Tightly coupled changes (e.g. a schema change
  plus the service that uses it) may share a PR

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
- A new workstream is about to start — I review before you proceed
- A spike's stop condition (in `docs/archive/SPIKE_PLAN.md`) appears to trigger
- A library version doesn't match what CQF_FHIR_CR_REFERENCE.md says works
- A schema migration would break existing data
- An AI call is being asked to return a compliance decision
- An audit log entry would be skipped for "performance" reasons
- The plan would slip more than half a day

## Always-loaded docs (`@`-imported — keep this list to five)
These five are in context every session because each one is *load-bearing for a rule above*: a rule
whose criteria live in an unread file is unenforceable, and its absence is **silent**. Total ~6.5k
tokens. Do not add to this list without deleting from it — the whole point is that it stays small.
- @docs/AI_GUARDRAILS.md — the "AI never decides compliance" hard rule lives or dies on this
- @docs/CQF_FHIR_CR_REFERENCE.md — the "library version doesn't match" stop condition needs it
- @docs/DATA_MODEL_CONTRACTS.md — idempotency + `evidence_json` + CSV contracts; Definition of Done makes these mandatory on EVERY PR
- @docs/ADR_INDEX.md — 40 ADR titles only, so a session knows a decision exists; bodies stay in DECISIONS.md
- @docs/LOCKED_DECISIONS.md — owner-locked decisions (§4, rewritten 2026-08-04 per ADR-058) + the dated 2026-07-24 audit facts (§5)

## Other docs to consult on demand
Read these when the task needs them. They are deliberately NOT `@`-imported: eagerly loading the set
cost ~89k tokens per session until 2026-07-29, whether or not any of it was relevant.
- `docs/JOURNAL.md` — the running narrative; source of truth for recent work (~832k chars — never import)
- `docs/DECISIONS.md` — numbered ADR bodies (the titles are already in context via ADR_INDEX)
- `docs/ROADMAP_2026-08-04.md` — **the APPROVED active plan** (owner decisions are in context via LOCKED_DECISIONS §4). Supersedes `ROADMAP_2026-07-24.md`, which is kept only for its §7 target architecture and the reasoning that got us here — **do not act on it**
- `docs/DEPLOY.md` — MIE Create-a-Container + Neon setup, env vars, rollback → prefer the `deploy` skill
- `docs/ARCHITECTURE.md` — system architecture + boundaries (the engine boundary is enforced mechanically by PR-1's containment test and PR-4's five boundary tests, so CI catches drift)
- `docs/DATA_MODEL.md` — §1–3: scope, core tables, full table schemas (derivable from `schema-pg.ts` / `schema.ts`)
- `docs/MEASURES.md` — the TWH measure catalog (63 measures) in plain English
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
- `docs/superpowers/plans/` (45 files, 1.33 MB) and `docs/superpowers/specs/` (39 files, 413k)
- `docs/sprints/` (9 files, 276k — sprints 0–7 all merged; historical, not an active queue)
- `docs/archive/` (245k), `docs/FABLE_REVIEW_2026-07-02/` (84k), `docs/new instructions/` (69k),
  `docs/mieweb-ui-migration/` (82k)

## Current Focus (as of 2026-08-04 — the engine is the product; `docs/ROADMAP_2026-08-04.md` is the APPROVED active plan)

**READ THIS BLOCK FIRST; everything below it from "2026-07-24" onward is HISTORY.** The 2026-07-24
recalibration and the M-A/M-B narrative that follows are accurate as a record of how we got here, but the
*direction* changed on 2026-08-04 (ADR-058, `docs/ROADMAP_2026-08-04.md`).

**What changed, in one paragraph.** M-B built the certification-shaped loop; it runs through the product API
over Cypress's own archive and emits Cypress's exact expected counts. Cypress graded it **red**, and reading
`projecttacoma/cqm-validators` gave the mechanism: `extract_results_by_ids` calls
`find_measure_node(measure.hqmf_id, doc)` and **returns `{}`** when the measure identity is not the one it
holds. Cypress has **CMS125v14** (QDM); we run **CMS125FHIR v1.0.000** (QI-Core). Two corrections follow
that were not obvious: the **45/53 supplemental-data errors are DOWNSTREAM of that short-circuit**, not an
independent gap (supplemental data is built only inside the matched node), so building it moves **no
external number**; and it is **not a two-id relabel**, because populations match on `@root` carrying a
per-population **UUID** and **the QI-Core artifact has none** — its populations are *named*
(`InitialPopulation_1`). **QRDA Category III is an HQMF/QDM-identity format**; the FHIR lineage has no
identity to carry there. And **no FHIR-lineage grader exists**: MITRE's `cvu-fhir` (Cypress ported to FHIR,
3,771 commits) was **last pushed 13 Apr 2023**; Cypress itself is active (v7.5.1, 30 Jul 2026) with zero
mentions of FHIR/QI-Core/dQM.

**The owner decisions (locked 2026-08-04, full text in `docs/LOCKED_DECISIONS.md` §4).** **(1) WorkWell is
SUPPLEMENTARY to WebChart and does NOT pursue ONC certification** — WebChart carries it (~33/49); no work is
justified by "certification needs it." **(2) The bar is the FHIR-column verification SET**
(ROADMAP §4), not one external pass/fail; **a Cypress Calculation Check green is RETIRED as a goal.**
**(3) No relabelling and no QDM engine** — ADR-046 d3/d4 reaffirmed; reopen only if MIE says certification of
WorkWell's engine is a business goal. **(4) QRDA I/III is KEPT as an interoperability bridge** (both types at
0 findings vs the HL7 base ruler; nothing deleted). **(5) The engine + packaging are the primary deliverable —
M-C is promoted to spearhead**, with the versioned compliance API as the contract MIE consumes.
**(6) The differentiator is the measures nobody publishes** (M-E occupational/OSHA).

**Nothing measured is withdrawn.** QRDA I and III stay at 0 findings against the HL7 base ruler; the 64/64
and 150/150 subject-level agreement against Cypress's own per-patient expected results stands (ADR-055).
What changed is which of those we call the bar.

**Done 2026-08-04 (B6, B7, M-E0 draft).** **B6** — our MeasureReports validate at **0 base-R4 errors**;
the DEQM STU5 gap is exactly **3 per report**, identical on official and authored paths, and pinned in
`measure-report.test.ts`. We deliberately claim **no DEQM `meta.profile`** — that stays owner-gated on the
gap reaching 0. **B7** — the official artifacts were cross-executed through HAPI's **`cqf-fhir-cr`**, the
first execution of our artifacts by an engine that is not ours (`fqm-testify` and `deqm-test-server` both
WRAP `fqm-execution`, so neither counts): **255/278 across six measures**, CMS68/CMS951/CMS138 at 100%.
The largest group of exceptions is **proven by construction** to one conjunct — `"Has Dementia
Medications"`, whose `medicationRequestPeriod()` needs a `dosageInstruction` the MADiE cases omit —
accounting for **14 of 23**. **M-E0's contribution is written**
(`docs/evidence/CONNECTATHON_DISCREPANCIES_2026-08-04.md`); submitting it is an owner calendar step.

**Two gotchas that cost real time and are documented in the harness:** `cqf-fhir-cr` retrieval is QI-Core
**`meta.profile`-sensitive** (an unstamped hand-PUT resource is silently never retrieved), and
**`$evaluate-measure` CACHES** per subject for the server's life — every changed input needs a fresh
container, and one published conclusion had to be re-proved cold after this was found.

**Next, in order:** **M-C** — the packaging spearhead (locked decision 5): physical `packages/measure-engine`
extraction, the versioned **compliance API**, `@workwell/*` publish. Then **M-D0/D1** (re-aim at US Quality
Core; run the Inferno **US Quality Core Test Kit** against the shim output) and **M-E1** (occupational
content pack). **Still undiagnosed:** CMS125's 2 `Procedure`-only cases, CMS2's 7 `NUMER 1→0`, and
CMS130/CMS165 unswept (credentialed vendor workflow). **Deferred, not cancelled:** supplemental data (B8).

**Three standing corrections.** "~2030" for CMS FHIR endpoints is **not CMS-attributable** (say "no
published date"). **"QI-Core STU7 = US Core 7 = WebChart's exact surface"** is half right: the equality
holds, but **CMS's shipping content is authored on QI-Core 6** and the direction is **US Quality Core 0.5.0
over US Core 6.1.0**. **"Cypress CVU+ is the verification bar"** is removed from `STANDARDS_CONFORMANCE.md`
and the `conformance` skill. **Open owner step:** confirm with Doug/Nicole that certifying WorkWell's engine
is not a business goal — the one input that would reopen decision 3.

---

## History — Current Focus as of 2026-07-24 (Nicole recalibration; SUPERSEDED 2026-08-04)

**2026-07-24 — the Nicole meeting reset direction; `docs/ROADMAP_2026-07-24.md` is the APPROVED active
plan (supersedes ROADMAP_2026-07-09.md).** Her corrections: **(1) run the OFFICIAL published CQL for
official CMS eCQMs — never reauthor** ("if the CQL exists, use it"); **(2)** the real EHR proof path is
**QRDA-I ingest → calculate → QRDA-I/III export → Cypress → ONC** (MADiE is authoring tooling, not EHR
verification); **(3)** priority measures **CMS2, 68, 122, 125, 130, 138, 165, 951** (MIE ONC-certified
~33/49); **(4)** self-authored CQL is the value only where no official definition exists — occupational/
OSHA + HEDIS-insight — and MIE could steward occupational measures through NCQA; **(5)** DEQM/FHIR
reporting is the direction but CMS/QPP has no endpoints (~2030). CQI WG = Fridays.

**Five milestones (details, architecture, and the PR-sized migration sequence in the roadmap doc):**
**M-A** official-first execution (promote the fqm-execution literal machinery to a per-measure-routed
`officialMeasureExecutor` behind `WORKWELL_OFFICIAL_MEASURES`; MADiE cases = PERMANENT CI gates; authored
cms122/125 subsets retire to the fidelity lab; all 8 measures verified present in
`cqframework/dqm-content-qicore-2025` w/ test cases) · **M-B** QRDA-I/III + Cypress **CVU+**-validated
loop (QRDA-I import AND export — the certification rehearsal; Cypress is open-source/Docker) · **M-C**
pnpm-workspace extraction publishing **`@workwell/*`** (`measure-engine` = cql-execution+cql-exec-fhir
only; `official-executor` = the fqm quarantine package; pitch Doug on `@mieweb/*` once proven) · **M-D**
WebChart breadth (Condition/Encounter/med paths via the #316 ingest loop) + the versioned **compliance
API** contract (Doug's question-shape) · **M-E** occupational content pack **published in the community
`dqm-content` shape** + NCQA stewardship + CQI WG Fridays. **Two-track posture:** execute on the
FHIR/QI-Core column (QI-Core STU7 = US Core 7 = WebChart's exact surface), report on the current QRDA
column; QDM only ever appears as a translation at the QRDA boundary. HEDIS guardrail: own spec text +
cases only, never reproduced NCQA specs (DUA).

**STATUS (2026-07-27 — SUPERSEDED by PR-9c/ADR-045 on 2026-07-30, which routed cms125; read this paragraph as history): §7.4 PR-1 → PR-8a shipped; nothing is flipped.** `WORKWELL_OFFICIAL_MEASURES` is
unset everywhere, so `routedEngineForEnv` returns `engineForEnv`'s own value **by identity** and every
measure still evaluates authored CQL. Shipped: engine-boundary severance (PR-1 — the containment test
that freezes the boundary; the physical `packages/measure-engine` extraction is **PR-2, resequenced
2026-07-24 to land with M-C** and NOT shipped), evidence-first MeasureReport membership (PR-3),
`packages/official-executor` — the sole home of `fqm-execution`, reached only by lazy `await import`
and policed by five boundary tests (PR-4), CMS122+CMS125 v1.0.000 vendored (PR-5), the **MADiE CI
gate** — 55/55 + 66/66, and no measure may be routed without it (PR-6), ELM-annotation stripping
(PR-6a), the official executor **adapter** (PR-7a), the **router** with construction-time validation
(PR-7b), `--official` terminology import (PR-7c), and **one terminology authority** (PR-8a / ADR-036 —
the artifact's OWN expansions, gitignored + fetched at build + pinned by a SHA-256 in the committed
manifest; the reduction check now executes the runtime configuration and agrees with upstream on all
121 cases).

**PR-8b shipped (ADR-037):** one `qicore-preparation` used by both the diff and the runtime executor
(measured — unprepared, the official artifact reads the whole roster out-of-population), the literal diff
moved onto the artifact's own terminology with no fallback, and the deploy workflow vendors terminology
into the build context. It surfaced a gate — preparation alone rendered the synthetic corpus **100%
compliant** for cms122 — which **PR-8c has now closed (ADR-038)**, taken ahead of the remaining PR-8
mechanics because a shadow run against a corpus that cannot exercise the numerator compares nothing.
PR-8b's stated cause was wrong: the corpus already dual-stamped real codes. The measured defects were
**12 of 24 codes being members of a value set other than the one they were registered under** (invisible
to every measure test, because one file supplies both the stamped code and the offline expansion the
authored CQL resolves — so both sides agreed), CMS125's IPP reading the **`us-core-sex` extension**
rather than `Patient.gender`, its numerator retrieving **`[Observation: Mammography]`** where we emitted
a Procedure, and Conditions carrying **no `onsetDateTime`** (which `prevalenceInterval` handles
inconsistently, not merely conservatively). Official-vs-authored agreement across the five synthetic
targets: **cms122 4/5 and cms125 0/5 → 5/5 and 5/5**, authored outcomes byte-identical, MADiE gate
unchanged. Guarded by a membership contract against the vendored terminology and an outcomes-as-authored
check that also refuses a degenerate all-one-bucket corpus (both wired into the `official-cases` CI job —
anything reading a sidecar self-skips in the job that runs `pnpm test`). **Covers the STATIC corpus
only:** review caught the scale generator overwriting the new LOINC mammogram Observation with CPT (fixed),
and **real WebChart data still gets neither CMS125 fix** (no `us-core-sex`, no LOINC mammography from the
crosswalk) — both now PR-9 blockers beside the capped `AdvancedIllness` expansion.

**PR-8d shipped (ADR-039)** — the diff is generalized to any vendored measure AND made a genuine shadow
of the runtime: it used the CALENDAR YEAR where the executor uses the registry rolling window, fed the
artifact a harness-ENRICHED bundle (which ADR-038 made unnecessary and misleading), and prepared in place
so WorkWell was evaluated on the mutated bundle — all three aligned behind one shared
`officialMeasurementPeriod`. It also fixed a latent inversion: `numerator ? OVERDUE : COMPLIANT` is
cms122 INVERSE reading and would have reported every screened woman in cms125 as overdue; now read from
the fail-closed semantics table. **PR-8e shipped (ADR-040)** — the **`logic_version` override**, taken ahead of the batching because it
was a correctness landmine rather than an optimization: `incremental-eval.ts` hashed the AUTHORED ELM, so
a measure flipped to official would keep the same `logic_version` and the `eval_state` cache would copy
authored outcomes forward for a measure now running the official artifact (and a re-vendor would not
invalidate them either) — the one fingerprint input whose absence is **silent**, where every other
degrades pessimistically. The **engine** now declares its own identity (`RoutedEngine.logicVersionFor` →
`official-fqm:<version>:<artifactSha>:<terminologySha>`), read by the pipeline off `deps.engine` rather
than threaded through each caller — that thread being the exact shape of the bug PR-7b's review caught.
Flip-on/flip-off/re-vendor all invalidate by construction (disjoint prefixes), tested against the real
engine + real SQLite `eval_state` with every other reason to re-evaluate removed. **PR-8f shipped —
PR-8 is COMPLETE**: measure-major batching + the batch-level retrieve refusal. `evaluateBatch` is the
executor's primitive and `evaluate` a batch of one (so the four construction refusals live on ONE path);
measured on the real artifacts **171 ms/subject one-at-a-time vs 11–16 ms batched** (10× at N=25, 16× at
N=100), which inverts the roadmap's "benchmark before flip" note — unbatched official execution is ~2.5×
SLOWER per subject than authored's ~68 ms, batched it is faster. A batch of **>1** matching no retrieve
for anybody now REFUSES rather than reporting a whole roster out-of-population (fqm's all-empty result is
indistinguishable from a genuinely ineligible roster); `>1` because for one subject "nothing retrieved"
is legitimate. It catches *retrieved nothing*, **not** *retrieved the wrong thing* — every ADR-038 corpus
defect passed it. A failed batch fails ITS measure (MISSING_DATA + PARTIAL_FAILURE + the #264 alert),
never the run. Wired as a pre-pass gated on `RoutedEngine.evaluateBatch` resolving non-`undefined` —
absent everywhere today, so the per-subject loop is unchanged.

**PR-9a shipped (ADR-041) — the capped `AdvancedIllness` expansion is now completable at vendor time.**
`vendor:official --complete-capped-expansions` re-expands the OIDs upstream capped (today one:
…1003.110.12.1082, 1000 of 1997, feeding a DENEX in both measures) from VSAC, pinned to
`Library/ecqm-fhir-update-2025` — the release the upstream content repo itself names, and the one CVU+
validates the 2026 period against. **Research corrected the stated cause:** the cap is not "VSAC caps at
1000" but *upstream policy* — the content repo's README says its value sets are limited to expansions of
1000 because full ones need an NLM licence — so there was never an upstream issue to file, and VSAC's
`$expand` has supported `offset`/`count` all along (`vsac-client.ts` has paged it since #295). Verified
against a stub VSAC: 2043 → 3040 codes (the real artifacts land at 3043), `truncated` → `[]`, codes written sorted despite descending
input, and **two runs produce the same `terminology.sha256`** so CI's reproducibility check stays honest.
Every failure path (no flag, no key, VSAC down, **or a VSAC expansion that comes back SHORT**) leaves
upstream's codes untouched so routing keeps refusing — a differently-incomplete set is the one outcome
worse than staying capped. **Inert until the secret exists**, deliberately: the no-flag path is
byte-identical to the committed artifacts. **OWNER STEP DONE 2026-07-29** — the
`WORKWELL_VSAC_API_KEY_VENDOR` secret is set and the re-vendored manifests are committed in the same
change (DEPLOY.md §"Step 1a"). `AdvancedIllness` is now **2000 codes in both artifacts**, `truncated` is
`[]`, and **`officialRoutingProblems(["cms122"])` and `(["cms125"])` both return no problems — the two
measures are ROUTABLE.** (As of that date nothing was routed; **cms125 was routed on 2026-07-30** — PR-9c / ADR-045.)
`test:official-cases` stayed **121/121** (55/55 + 66/66, 0 unexpected, 0 errors) and CI's four
sidecar-dependent suites pass against the completed expansion, including the corpus-outcomes check.
Two independent vendor runs against live VSAC produced **byte-identical manifests and sidecars**, so
CI's reproducibility gate holds. **One observation recorded rather than smoothed over:** VSAC at the
pinned release returns **2000 codes where the bundle declares 1997**. The guard only rejects a SHORT
expansion, so this passes; it means upstream's `expansion.total` was captured against a slightly earlier
terminology snapshot than `ecqm-fhir-update-2025`. What is verified: VSAC's 2000 codes CONTAIN all 1000
upstream shipped (a containment check added in review now enforces this at vendor time), and no official
case moved. What is NOT knowable: how the 2000 compare against upstream's full 1997, since 997 of those
were never shipped — so "three extra codes" is a size delta, not a measured difference in membership.
PR-9c's before/after distribution snapshot is where it would show up.
**PR-9b shipped (ADR-042) — and measuring first killed its planned shape.** It was specified as a
construction-time refusal (throw when `WORKWELL_OFFICIAL_MEASURES` and the WebChart seam are both set), on
the basis that the WebChart gap was "M-D-sized and wider than the two recorded CMS125 items." That basis was
a structural inventory — 0 Conditions, 0 Encounters, no `Patient.extension`, no `Observation.category` —
which counted what was ABSENT rather than testing what the measures READ, and **counting overestimates.**
Measured over the committed 56-patient dev-DB fixture through the real ingress path (EVAL 2024-06-01,
official MP 2023-06-01..2024-06-01, via `evaluateBatch`): cms125's **initial-population** gap was ONE field
— the official IPP is `age in [42..74] AND us-core-sex = SNOMED 248152002 AND exists Qualifying Encounters`;
age passed, the roster's CPT 99213 visit passed, and **0 of 56 patients carried `us-core-sex`** because both
sites mapping `patients.sex` into FHIR emitted only `Patient.gender`. Fixed in both
(`wcdb-fhir-shim/src/fhir-mapping.ts` + the by-design duplicate in `scripts/webchart-devdb-export.ts`) and
the fixture re-exported **byte-identical but for 28 added extensions**; official CMS125 now agrees with
authored on all 56 (52 MISSING_DATA / 4 OVERDUE). The SNOMED concept id is load-bearing — an extension
carrying `"F"` is indistinguishable from one absent, which cost a measurement pass. **cms122 has no
divergence at all:** official AND authored both return MISSING_DATA for all 56 (no Conditions in the seed;
cms122 is deliberately outside `ROSTER_ELIGIBLE_MEASURES` since its "enrollment" is a diabetes *diagnosis*
the roster must never fabricate) — so the earlier note that official cms122 "would read out-of-population
over live data too" was true but omitted that authored does the same, the half that decides whether the flip
changes anything. **No refusal was built:** a seam-keyed predicate stands in for "this data cannot satisfy
the IPP", and once the mapping is fixed the predicate stays true while the property goes false, so it would
refuse a *correct* config until someone deleted it. The guard is `devdb-official-eval.test.ts` instead — a
per-subject **divergence map** through the real ingress code, wired into the `official-cases` CI job (review
caught that it self-skipped without the gitignored sidecar, so 4 of 6 tests never ran in CI — the same
vacuous-guard class flagged on #350 one PR earlier).

**Two gaps stay OPEN, both recorded rather than smoothed over.** (1) **The NUMERATOR.** All four
discriminating subjects are OVERDUE for want of a mammogram, so the fixture cannot exercise either
numerator. Authored reads `[Procedure: "Mammography"]`; official reads
`isDiagnosticStudyPerformed([Observation: "Mammography"])` where the value set is **92 LOINC codes only**
and `Status.isDiagnosticStudyPerformed` also requires `category ~ imaging`; the crosswalk emits CPT
`77067`/HCPCS `G0202` on a **`Procedure`**. Measured: one crosswalk-shaped mammogram → authored COMPLIANT,
official **OVERDUE** — a false non-compliance that `case-logic.ts` escalates to HIGH ("escalate mammogram
follow-up immediately") for a woman already screened. A LOINC `Observation` alone fixes nothing (no
`category`); with it the error flips sides. **The remedy is dual-stamping both representations**, as the
corpus does (ADR-038). All four states are pinned as tests. (2) **The live third-party path.** Both changed
mapping sites sit upstream of the live FHIR transport, and `normalizeWebChartBundle` is untouched by design
— so teatea supplies no `us-core-sex` and its roster reads out-of-population, while
`deploy-staging-mieweb.yml` sets `WORKWELL_WEBCHART_BASE_URL`. For *that* path the retired seam-keyed
predicate is still accurate, so ADR-042 decision 3 generalized from the config it fixed to one it did not.
Stated in `WEBCHART_FHIR_MAPPING.md` §3.1 where an integrator will see it, and enforcing it is a **PR-9c
precondition**. Also on the record: the roster **synthesizes** one of the three IPP conjuncts (the CPT 99213
Encounter), so this is not purely EHR-sourced membership, and with 52 of 56 outcomes MISSING_DATA only **4
subjects carry discriminating signal** — the oracle is our own authored engine, not external truth. Cypress
CVU+ remains the verification bar. **(SINCE 2026-08-02: CVU+ has now run against the QRDA EXPORT — see the
M-B block below. It has NOT been run as the import→evaluate→export loop locked decision #2 names, and it
has never been pointed at this WebChart parity question, so this paragraph's "not external truth" stands.)**

**The PR-9c precondition is DISCHARGED (ADR-043) — as an OBSERVATION, not a refusal, and it changed the
flip's scope.** The hazard: a whole roster out of the official initial population is silent, and PR-8f's
retrieve check provably cannot see it (official CMS125 matched 236 LOINC Observations on real WebChart data
and still put all 56 subjects out of the IPP; `retrieveSignal` was true throughout). **First cut refused
inside `evaluateBatch`; review killed it and was right.** For a site-scoped CMS125 run over an all-male
cohort zero-in-IPP is the CORRECT answer, and a batch failure replaces every subject's
`official.populationResults` evidence — what MeasureReport/QRDA read (ADR-031) — with an `evaluationError`,
marks the run `PARTIAL_FAILURE` and alerts. Decisively: **cohort composition varies by run**, so "stop
routing this measure" is not a remedy an operator can apply. So the executor reports honestly, the run
pipeline emits a **`WARN`** naming both causes, the run still reports `COMPLETED` with evidence intact, and
the check is **gated on official routing** via the engine's declared identity (`logicVersionFor` →
`official-fqm:`, ADR-040). That gate is load-bearing and was missing at first: the stated basis — "the
authored engine never sets `inInitialPopulation`" — is **FALSE** (`deriveInInitialPopulation` emits it for
every measure with a boolean `Initial Population` define, all 16 of ours), so ungated an authored measure
whose cohort sat wholly outside its own IPP would be told nobody entered the *official* IPP and pointed at
`us-core-sex`. It never fired only because the synthetic roster puts somebody in every measure's IPP — a
fixture property, not an invariant. The WARN reads the **final per-subject
outcomes after the evaluation loop**, not the batch pre-pass — review (#354) showed a pre-pass conclusion
judges an INCOMPLETE roster, since an omitted subject is re-evaluated individually later, and is wrong both
ways (warns when the omitted subject is in the population; stays silent when the batched sample is 1). It is
therefore no longer gated on the batch path. **Its reach is narrower than first claimed:** the run *message*
is returned on the SYNCHRONOUS response only — every `ALL_PROGRAMS`/`SITE` run, and a `MEASURE` run on a
WebChart-configured stack (the very configuration this exists for), goes through `scheduleAsyncRun` and
discards it; `RunRecord` has no message column and neither read model carries one, so there the warning is
`run_logs` + the run's log timeline, not the run list. Persisting it needs an owner-owned `runs` column. **Enforcement lives at the FLIP GATE**
(`devdb-official-eval.test.ts` + a **written pre-flip checklist**, now in `DEPLOY.md` §"Flipping a measure to
official execution" — confirm a non-zero initial population against the tenant's own data; the ADR first
named that checklist without one existing, and the `WORKWELL_OFFICIAL_MEASURES` env row was missing from
DEPLOY.md entirely). That is the only place the two causes can be told apart — when authored finds four
actionable women in the same bundles official finds nobody in, "this cohort is ineligible" is demonstrably
false. Not available at runtime at acceptable cost — it would mean running both engines for every subject of a
measure meant to replace one (`literal-diff.ts` does it as a diagnostic, not per run). **cms122's
routability is STACK-DEPENDENT, and it STAYS in the flip list** (a first draft of ADR-043 removed it; review
caught that as wrong). Official cms122 over **WebChart** data puts all 56 out of the IPP — zero Conditions in
the seed, and cms122 is deliberately outside `ROSTER_ELIGIBLE_MEASURES` because its "enrollment" is a
diabetes *diagnosis* the roster must never fabricate — but **PR-9c flips the demo/production stack, which
has NO WebChart seam** (`deploy-twh-mieweb.yml` carries zero `WORKWELL_WEBCHART_*`, verified), so it
evaluates the SYNTHETIC roster where official cms122 scores across all five corpus targets and agrees with
authored. The finding is therefore about **staging** (11 `WORKWELL_WEBCHART_*`): routing official cms122
there produces nothing useful, and the WARN says so each run. **What none of this catches:** an IPP that IS
satisfied while the numerator reads the wrong shape — the open mammography gap, where official reports a
screened woman OVERDUE and nothing fires.

**The mammography numerator gap is CLOSED (ADR-044), and the flip gate now has a command.** The crosswalk
**dual-stamps**: a screening-mammogram row emits the CPT/HCPCS `Procedure` it always did AND a LOINC
`Observation` (`24606-6`) with `status=final` + `category ~ imaging`, in both mapping sites, served from
`/Observation` so `/Procedure` is byte-identical for the authored engine. Each single representation fails
in the OPPOSITE direction (Procedure → official false-OVERDUE; Observation → authored OVERDUE; Observation
without `category` → still blind), so all four states stay pinned as tests. **Normalization, not
fabrication (ADR-037)**, on three tested properties: derived strictly from a real row, an explicit code
allowlist rather than a category sweep, and non-inflating because both numerators are `exists(...)` — the
last of which **would double-count for a counting measure**, stated in `WEBCHART_FHIR_MAPPING.md` §3.6. The
fixture moved by exactly one resource and **no outcome** (its only mammogram belongs to wc-49, age 33,
outside the IPP), so the dual stamp is asserted directly rather than inferred. It was NOT re-exported from
the dev DB (Docker down) — the generator's insertion rule was replayed and the diff verified; a re-export
should be a no-op. **`pnpm flip-snapshot`** makes pre-flip checklist steps 2+4 executable — the gap review
caught in ADR-043, whose tenant-facing half was prose with no tooling. It evaluates both engines over the
same bundles and reports before/after distribution, official IPP count, and every changed subject; it
renders **DO NOT FLIP** / **INCONCLUSIVE** but **gates nothing and exits 0**, because the discrimination is
the one ADR-043 says a machine cannot make — do not wire it into CI as pass/fail. **Measured:** on the
SYNTHETIC roster (what the demo/production stack evaluates) cms122 and cms125 both admit **5/5** to the IPP
and agree with authored; over WebChart data cms125 admits 4/56 agreeing on all 56, cms122 admits 0/56 and
reports INCONCLUSIVE (data gap, not divergence) — ADR-043 decision 6 confirmed by measurement.

**PR-9c + ADR-046 SHIPPED — `WORKWELL_OFFICIAL_MEASURES="cms122,cms125"` is set on BOTH
`deploy-twh-mieweb.yml` and `reconcile-twh-mieweb.yml`, so BOTH measures now evaluate CMS's published
QI-Core artifacts on demo/production. M-A is COMPLETE for the two vendored measures.** Set in the WORKFLOW, not on the container: `CONTAINER_ENV_VARS_JSON` is a fixed `jq`
array and the deploy deletes-and-recreates, so a hand-set value is wiped — which makes the flip a reviewed,
revertable change rather than an operator action. **Decided on measurement:** cms125 admits **5/5** corpus subjects
to the official initial population and agrees with authored on every one (evidence at
`docs/evidence/PR9C_FLIP_SNAPSHOT_2026-07-30.md` — note that is FIVE PROBES, not the 150-employee roster;
the roster figure is derived, not measured). **cms122 joined it once ADR-046 discharged the reporting trio** — its official numerator means FAILURE
(poor glycemic control), so its MeasureReport now declares `decrease` and CMS's canonical, and its QRDA III
carries the official eCQM identity rather than `urn:workwell:measure|cms122`. All three derive from the
outcome's own `evidence.official`, never from the env flag, so a historical export cannot be relabelled by a
later config change; a re-vendor that moves the artifact sha falls back to a version-qualified urn rather
than claiming a canonical the run never used. `official-flip-config.test.ts` asserts the BUILT REPORT for
every shipped measure. **The flip is INERT on this stack's
data** (no roster row changes) — the value is that official execution runs in production at all.

**New guard, because nothing validated the string that actually ships:** `official-flip-config.test.ts`
parses `WORKWELL_OFFICIAL_MEASURES` out of both deploy workflows and asserts every id is MADiE-gated,
vendored, proportion-scored and routing-clean. Split deliberately — a pure structural half that always
runs, plus a sidecar half wired into CI's `official-cases` job, because one combined test would self-skip
in `pnpm test` and read as covered. It does NOT pin *which* measures are flipped (that would guard only
"you changed what you changed"). **A misconfiguration does NOT refuse at boot** — the throw is at engine
construction, per request, while the DB-free `/actuator/health` stays 200, so grep the logs for
`OFFICIAL_ROUTING_MISCONFIGURED`; a green container is not evidence. `WORKWELL_SCHEDULER_ENABLED=true`
here, so the nightly ALL_PROGRAMS run exercises the flip unprompted. Rollback = remove the line + redeploy
(ADR-040 makes `eval_state` invalidate by construction).

**M-A WAVE 2 (ADR-047): CMS2, CMS68 and CMS951 are vendored, MADiE-gated and ROUTABLE — none is routed.**
**CMS138 joined them 2026-07-31 (ADR-053) — the gate is now 278/278 across SIX measures.**
**CMS130 and CMS165 joined the gate 2026-07-31 too (ADR-054) — both vendored clean on the first credentialed dispatch; their credentialed MADiE CI gate passed: CMS130 scored 64/64 and CMS165 68/68 (0 unexpected mismatches, 0 errors each), and both manifests reproduced byte-for-byte.** The following pre-ADR-054 status is historical.
The gate was **231/231** across five measures (55+66+36+19+55, 0 unexpected, 0 errors) and drives the
harness, the sparse checkout and the committed-report predicate off `OFFICIAL_GATED_MEASURES` instead of a
hardcoded pair — all three silently stopped meaning "the full gate" the moment a third measure existed.
**Three of the six did NOT onboard, each for a different reason:** CMS138 scores **0/47 with 47 errors**
(diagnosed 2026-07-31, see below); CMS130 and CMS165 have capped expansions needing
`WORKWELL_VSAC_API_KEY_VENDOR`, which is a GitHub secret only, so they are **not vendored at all** rather
than committed capped and permanently unroutable (owner step, task #10). **Routable ≠ routed:** these
three have no authored counterpart, so `flip-snapshot`'s authored-vs-official comparison — what every flip
so far was judged on — cannot run for them, and the roster/catalog still assume an authored measure exists.

**ADR-053 — CMS138's cause was NOT "the value set will not expand"; that sentence names a symptom and
points at the wrong system** (ADR-047 recorded it and explicitly did not claim a cause: *"whether that is
an upstream packaging gap or something our reducer drops is unknown"* — a hedge CLAUDE.md's summary had
dropped). Measured at pin `ca4b4951` by `pnpm official:terminology-audit`: CMS138's ELM
**retrieves 32** value sets and its bundle **ships 31** — `…3.526.3.1278` ("Tobacco Use Screening") is
absent from the bundle, so there is nothing to expand. The other five are exact (26/26, 32/32, 15/15,
5/5, 26/26). Upstream's own 2026-07-15 discrepancy report lists CMS138 under **no discrepancies** across
5826 cases, so the measure is fine — their environment holds the NLM terminology package their README
names; **re-pinning does not help** (the one newer commit changes no bundle), so VSAC is the remedy and
vendoring CMS138 folds into owner task #10. **Our own blind spot:** `collectTerminology` enumerated the
value sets a bundle SHIPS, so an absent one produced no sidecar entry, no `truncated` row and no warning
— the manifest read as terminology-complete while the artifact could not run, and
`official-flip-config.test.ts` was reading `truncated: []` as a completeness record it never was ("every
code the bundle DECLARED" says nothing about a set the bundle never declared). Now: the vendor step
diffs retrieved-vs-shipped and warns; `--complete-terminology` (renamed from
`--complete-capped-expansions`, old name still accepted **and tested**) sources absent sets too, never
conflated with capped ones (no containment or declared-total baseline exists for an absent set, so it is
held to VSAC's own total, an empty expansion is refused, and the record carries
`reason: "absent-upstream"`); and routing names the real cause instead of "could not be expanded".
Routing already refused it, so **no live hazard was closed** — the diagnosis changed, not the verdict.
The absent list is **recomputed at runtime, never recorded**, so it applies retroactively. **The
"moved no committed byte" claim was WRONG as first pushed** and CI caught it: tagging capped completions
`reason: "capped"` changed `manifest.json` for a *credentialed* re-vendor and failed the deploy-blocking
"reproducible from its pin" gate — verified locally against cms2, which has no completion block, i.e. the
one artifact class the change could not affect. `reason` is now emitted only for `absent-upstream`, and a
test pins the produced key set against the COMMITTED artifacts. CMS138 is **still not vendored**,
deliberately. Evidence: `docs/evidence/OFFICIAL_TERMINOLOGY_AUDIT_2026-07-31.md`.

**M-B: a QRDA Category I EXPORT exists (ADR-049) and was then rebuilt inside-out (ADR-050), because the
milestone-shaping question got answered.** ADR-049's `GET /api/runs/:id/qrda1` reported per-subject
population membership with an empty Patient Data section, measured against the CMS 2026 Cat I Schematron.
**Both halves were wrong, and measurement — not re-reading — found it.** (1) The **CMS** Cat I IG is titled
"for Hospital Quality Reporting" (IQR/PI/OQR) — so that Schematron is the wrong ruler for the EC measures we
route — but **Cat I itself is squarely in scope**: §170.315**(c)(1)** record-and-export and **(c)(2)**
import-and-calculate both require it per §170.205(h)(2) = **HL7 QRDA I R1 STU 5.3**, setting-neutral, (c)(1)
in the Base EHR definition; only **(c)(3)** splits by setting (Cat I inpatient, Cat III ambulatory). Cypress
covers 56 EP/EC eCQMs with Cat I test data and validates against the HL7 standard, *not* the CMS extras.
(2) **QRDA Cat I does not report population membership at all** — zero `IPOP`/`DENOM`/`NUMER`/`MSRAGG` in any
of the four CMS RY2026 samples; the receiver RECALCULATES, which is what (c)(2) literally says. So ADR-049
shipped Cat III machinery (`…27.3.24`) in a Cat I envelope while the Patient Data Section QDM **SHALL** carry
≥1 entry (CONF:67-14567). **Now:** membership is gone from Cat I (it lives in MeasureReport + Cat III);
`src/fhir/qdm-entries.ts` translates the five datatypes CMS122/125 consume from the evaluated FHIR bundle
(Encounter Performed; Diagnosis inside a **Diagnosis Concern Act**, CONF:4509-28885; Lab Test Performed with
the nested Result; Diagnostic Study Performed with an outer `value`, CONF:4509-29332; Procedure Performed),
routing `Observation` on **`category`** — CMS125's own numerator discriminator (ADR-044) — and **skipping**
what it cannot classify rather than guessing. The CMS document template `…24.1.3` is no longer claimed.
**Measured: 27 findings / 14 base-HL7 errors → 0 base-HL7 errors** (+4 CMS-hospital-only, expected); with no
bundle, exactly 1 (the missing entry), and the section says so in prose. **Two #360 findings corrected:**
`<addr>` DOES have a nullFlavor escape — at the **child** level, so an address is **not** an ingest
prerequisite (same for `raceCode`/`ethnicGroupCode` via `UNK`, two SHALLs #360 never recorded); and the
hypothesis that re-targeting would shrink the gap list was **wrong** — only 3 of 27 findings were CMS-only.
The measurement is now a command (`scripts/qrda-schematron-check.py`, partitioning failures base-HL7 vs
`CONF:CMS-*`), deliberately **NOT in CI** (needs Python+lxml, which must not become deps) — its regressions
are pinned in TypeScript with each assertion citing its CONF number. **Stated, not smoothed:** bundles are
re-read **at export time** (as-evaluated would mean persisting them — a schema change, owner's call) and are
**not** reconstructed from the persisted outcome, since `deriveExamConfig`'s target is a distribution *bucket*
that can converge (CMS122 DUE_SOON → MISSING_DATA); so the synthetic default stack exports documents flagged
`conformant: false`. **QRDA I IMPORT now exists (ADR-051)** — `POST /api/runs/:id/evaluate` takes `{measureId, qrda1}` and evaluates the
imported bundle through the UNCHANGED engine (§170.315(c)(2) "import and calculate"; a second calculator is what that
criterion detects, not something to build). Hand-rolled `cda-parse.ts` because CLAUDE.md forbids new deps and Node has no
DOM parser — total on malformed input, decodes ONLY the five predefined entities + numeric refs (no entity table to grow).
An unreadable document is a 400 naming the reason, never a silent empty bundle (the ADR-043 hazard). Untranslated QDM
templates are NAMED in the response — the CMS RY2026 sample carries **47** against our five datatypes, and imports cleanly
otherwise (1 subject, 6 resources, both eMeasure UUIDs). **The round trip caught a defect in the EXPORT:** `audiogram`'s
bundle binds synthetic `urn:workwell:vs:*` value sets with **no CDA code system OID**, so every clinical resource was
silently dropped while the export reported only "no QDM patient data entries". Now the translator returns WHY each
resource was dropped. **Structural consequence: a QRDA Category I is only meaningful for data in REAL terminology**
(LOINC/SNOMED/CPT/ICD) — i.e. the official measures; the authored catalogue is not QRDA-representable at all, which also
sharpens locked decision #4.

**CVU+ HAS NOW RUN, and QRDA Category I passes the HL7 base ruler clean (2026-08-02, PRs #380/#381).** 22
submissions of 12 generated documents to a local Cypress v7.5.1 (image digest matching the recorded pin).
First pass: **240 findings** — and the headline was about our own instrument. ADR-050's "0 base-HL7 errors"
was confirmed EXACTLY (the `Cat1R53` Schematron ran and returned zero on all 10 Category I documents, and
the CMS ruler cost exactly **+4** per document, reproducing ADR-050's partition from outside) — but
`qrda-schematron-check.py` validates **Schematron only, no XSD**, and CVU+ runs the CDA schema first, where
every Category I document failed 6–10 times. Not a guard that could not fire; a guard whose SCOPE was
narrower than the claim it was cited for. Three defects accounted for all 76 exactly: `@root` carrying a
URN where CDA's `uid` admits only an OID or UUID (56), the eCQM version STRING in an `INT` (10), and a
`<text>` misplaced after `setId`/`versionNumber` (10). All fixed and **re-measured: Category I 76 → 0**
against the HL7 base ruler, XSD and Schematron alike. Roots are four **hardcoded UUIDs** (owner decision) —
WorkWell holds no registered OID arc and asserting an unregistered OID is a false claim of a registered
identity; if MIE assigns an arc, `qrda-common.ts` is the only place that changes. The AUTHORED path
deliberately still emits `urn:workwell:measure` and a test pins it as the ONLY invalid root, because
ADR-046 decision 3 and ADR-051 make that document non-conformant BY DESIGN.

**QRDA Category III followed it to 0 the same day (#384).** 48 findings → 0 against the HL7 base ruler.
The interesting defect: every required element was PRESENT and every rule about them still failed, because
Aggregate Count `…27.3.3` sat on the OUTER observation with `…27.3.24` inside — so the validator applied
Aggregate Count's rules to the wrong element (3 findings per population, 12 per document) and validated the
element that satisfied them as nothing at all. Correct nesting is Measure Data `…27.3.5` wrapping Aggregate
Count `…27.3.3`. The whole CDA header was also absent (`recordTarget` carries `<id nullFlavor="NA"/>` —
the document is about a population), and `…27.1.2` was claimed with a wrong extension, so **the HL7 ruler
stayed silent precisely because it matched no rule at all**. Both document types now validate clean.

**THE CALCULATION CHECK COMPARISON HAS NOW RUN — offline, and it found a defect in our IMPORTER, not our
engine (2026-08-03).** The #386 oracle reproduces once teardown deletes `CQM::IndividualResult`s (that
alone was the 128-then-93 irreproducibility), and every number is now DERIVED: results = patients ×
(1 unstratified row + 1 for the patient's own stratum), archive documents = patients + 1 clinical split +
`rand(1..3)` duplicates — so the document count legitimately VARIES between rebuilds while the expected
results do not. Measured against
Cypress's own expected results over its 214 generated patients: **IPP 64=64 and 150=150, DENOM 64=64 and
150=150, CMS125 NUMER 2=2**; per subject **41/64 and 122/150 agree on every population**, and every
difference is one direction — `DENEX: cypress=1 workwell=0` (CMS122's numerator 54 vs 31 is exactly its 23
missed exclusions falling through, which for an INVERSE measure means the numerator). **`Denominator` is an
`ExpressionRef` to `Initial Population` in both artifacts, so DENOM restates IPP — one agreement, not
two**; and fqm zeroes NUMER whenever DENEX is true for a proportion measure, so the numerator cannot be
read apart from the exclusions. Run against BOTH archives (66/68 and 152/153 documents): every graded
number identical. **Two import causes, each MECHANISM confirmed by construction (n=1 subject apiece via
the harness's `--inject`; that they account for ALL 51 differing subjects is inferred from the datatype
inventory, not measured):** we translate five QDM datatypes while the exclusion logic reads
Assessment Performed, Intervention Performed/Order, Medication Active, Symptom and Device Order (adding one
dropped Assessment back flips a subject to Cypress's exact answer); and `concept()` reads only the primary
`<code>` from six mapped code systems, dropping 4 of CMS125's 10 Procedure entries for being ICD-10-PCS —
two of which carry the SNOMED translation the exclusion value set contains. **A FOURTH prerequisite the
#386 review could not see from the tree: identity resolution.** The augmented duplicate and the clinical
split each get a new Cypress MRN; only the **Medicare Beneficiary Identifier** survives both, and
`POST /api/runs/:id/evaluate` keys off the first `<id>` extension — so nothing in the product path resolves
68 documents to 64 people. Prerequisite 11.2 is measured at **zero subjects moved** (the bundle's period is
**CY2024**, not 2026). Evidence: `docs/evidence/CVU_CALCULATION_CHECK_SPIKE_2026-08-02.md` Part 3; harness
`scripts/cvu/c2-calculation-check.ts` + `scripts/cvu/c2/`.

**THE IMPORTER IS FIXED AND THE NUMBERS NOW MATCH EXACTLY (2026-08-03, ADR-055).** IPP 64=64 and
150=150, DENOM identical, NUMER 31=31 and 2=2, DENEX 32=32 and 47=47 — **64/64 and 150/150 subjects agree
on every population**, reproduced against a second, independently generated archive. Three fixes, each
forced by a measurement: six QDM datatypes mapped to what the artifacts' ELM actually **retrieves**
(Intervention Performed → Procedure, Intervention Order → ServiceRequest, Device Order → DeviceRequest,
Medication Active → MedicationRequest, Symptom + Assessment → Observation — never off a QDM-to-QI-Core
table, because an answer that retrieves nothing is indistinguishable from a patient with no data);
`<translation>` read as an ADDITIONAL coding with a widened code-system map (4 of CMS125's Procedures were
ICD-10-PCS and vanished whole); and `Encounter.hospitalization.dischargeDisposition`, which alone
accounted for the last 9 subjects in each measure. **Symptom inverts code and value while Assessment does
not.** Mutation-checked one fix at a time — which caught a **vacuous assertion of my own** (a test
forbidding a `SPLY`-coded DeviceRequest could not fail). No export change: `qdm-entries.ts` can only emit
what our bundles carry, so import/export are now asymmetric by design and the round trip cannot reach the
new mappers. Suite 1807, 0 fail; the MADiE gate never reaches the importer.

**THE LOOP NOW RUNS THROUGH THE PRODUCT API, AND CYPRESS CANNOT READ WHAT IT PRODUCES (2026-08-03,
ADR-056).** Two routes that existed nowhere: `POST /api/runs/:id/import` (a BATCH, resolved to people
first — identity is inherently cross-document, so a per-document import cannot do it at any effort) and
`POST /api/runs/:id/finalize` (refuses any run whose outcomes do not ALL carry `qrda1Import` evidence —
finalizing a population run from outside would mark a partial roster COMPLETED and make it exportable).
Grouping is **deterministic and identifier-only**, chosen on a measurement: a name+birthdate pass changes
nothing on any of the four Cypress archives, so it is not worth the risk of merging two people.
Demographic conflicts inside a merged group are REPORTED, never resolved. Measured end to end: CMS125 153
documents → 150 subjects → `{"IPP":150,"DENOM":150,"DENEX":47,"NUMER":2}`; CMS122 68 → 64 →
`{"IPP":64,"DENOM":64,"DENEX":32,"NUMER":31}` — Cypress's expected results exactly. **Submitted, and it
is RED for two reasons that are not our arithmetic.** `ExpectedResultsValidator` extracted
`reported_results: {"PopulationSet_1" => {}, …}` — **nothing** — because Cypress's bundle is the **QDM
lineage** (CMS125v14) and we run and report the **QI-Core** one (v1.0.000): different eMeasure UUID, set
id and population identifiers, so `extract_results_by_ids` finds none of ours. **Zero population
mismatches is NOT a pass here** — `check_population` compares only when the extraction is non-empty, so an
unreadable document produces no population errors at all. Plus 45/53 supplemental-data errors: QRDA III
wants RACE/ETHNICITY/SEX/PAYER per population and we emit none (the input is there — Payer is in every
document and the importer drops it). Relabelling is not the fix: ADR-046 decision 3 forbids claiming an
eMeasure identity the run did not use. Evidence: `docs/evidence/CVU_C2_SUBMISSION_2026-08-03.md`.

**Still missing for M-B — the bar is NOT met.** *(SUPERSEDED 2026-08-04 by ADR-058 — that bar is RETIRED.
The paragraph is an accurate record of the 2026-08-03 state; read "a green C2" as a goal we no longer hold,
and both QDM-lineage routes as ones locked decision 3 now forbids. Two of its claims were also corrected:
supplemental data is DOWNSTREAM of the identity short-circuit rather than a co-equal second cause, and the
lineage fix is not a relabel because the QI-Core artifact has no per-population UUIDs.)* Locked decision #2 asks for the loop to come back GREEN.
It runs, over a third party's archive, producing numbers measured correct against Cypress's own
per-patient expected results (#388: 64/64 and 150/150 subjects agreeing on every population). It is red on
**measure-identity lineage** and **supplemental data**. A green C2 needs either a QDM-lineage reporting
path — a real decision, not a patch: it means reporting an identity for logic we did not execute, or
vendoring and executing the QDM artifacts — or Cypress bundles in the FHIR lineage, which CMS does not
publish for C2.

**Still open:** the authored cms122/125 subsets retire to the fidelity lab (locked decision #4 — issue
#377); the LIVE third-party WebChart path is CLOSED (2026-08-03, ADR-057 — `normalizeWebChartBundle` derives
`us-core-sex` from `gender` through a two-value allowlist and the LOINC imaging Observation from a
CPT/HCPCS mammography Procedure, both tagged, both suppressed when the server supplies them;
`live-official-parity.test.ts` strips them from the fixture to reproduce the live shape and pins 4 of 56
in the official IPP with normalization, 0 without); **no
supplemental data anywhere in the chain** (import drops Patient Characteristic Payer and never reads
race/ethnicity from `<recordTarget>`; the Cat III emits none — **now DEFERRED as ROADMAP B8**, since it
moves no external number today); only `PopulationSet_1` is compared, so a stratum-only disagreement is
invisible; and the **QDM-vs-QI-Core lineage decision** above, which was **TAKEN on 2026-08-04 as ADR-058** —
the bar moved to the FHIR column rather than the label moving to the QDM one.

---

## History

Superseded status blocks (2026-06 → 2026-07-22) previously lived here and were removed 2026-07-29
because they duplicated, in less detail, what `docs/JOURNAL.md` already records. For anything before
the Current Focus block above, read `docs/JOURNAL.md` (newest entry on top) and `docs/DECISIONS.md`.
The full removed text is recoverable from git history or `CLAUDE.md.doctor-backup`.
