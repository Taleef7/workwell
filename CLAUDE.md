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
- @docs/LOCKED_DECISIONS.md — owner-locked decisions + verified audit facts from ROADMAP_2026-07-24 §4–5

## Other docs to consult on demand
Read these when the task needs them. They are deliberately NOT `@`-imported: eagerly loading the set
cost ~89k tokens per session until 2026-07-29, whether or not any of it was relevant.
- `docs/JOURNAL.md` — the running narrative; source of truth for recent work (~832k chars — never import)
- `docs/DECISIONS.md` — numbered ADR bodies (the titles are already in context via ADR_INDEX)
- `docs/ROADMAP_2026-07-24.md` — the APPROVED active plan (§4–5 are already in context via LOCKED_DECISIONS)
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

## Current Focus (as of 2026-07-24 — Nicole recalibration; approved strategic roadmap)

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

**STATUS (2026-07-27): §7.4 PR-1 → PR-8a shipped; nothing is flipped.** `WORKWELL_OFFICIAL_MEASURES` is
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
measures are ROUTABLE.** Nothing is routed: `WORKWELL_OFFICIAL_MEASURES` is still unset everywhere.
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
CVU+ remains the verification bar and has not run.

**Still ahead of the flip:** PR-9c (the flip itself, on the demo/production stack only) plus its
precondition above. Production leaves every `WORKWELL_WEBCHART_*` unset, so the seam gates staging only.
(The PR-8b corpus finding is closed — see PR-8c above.)

---

## History

Superseded status blocks (2026-06 → 2026-07-22) previously lived here and were removed 2026-07-29
because they duplicated, in less detail, what `docs/JOURNAL.md` already records. For anything before
the Current Focus block above, read `docs/JOURNAL.md` (newest entry on top) and `docs/DECISIONS.md`.
The full removed text is recoverable from git history or `CLAUDE.md.doctor-backup`.
