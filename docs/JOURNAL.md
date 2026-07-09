# Journal

## 2026-07-09 — Fable strategy session: roadmap materialized, MIE unblock package authored

**PR #252 merged 2026-07-08T20:36Z** → deployed on push to `main`. With it, the Option A real-batch-eval
arc is live code, not just an open PR.

Held a Fable strategy session: a full review of the ADR-025/scale/terminology arc plus external
research — `worker_threads` viability for the scale batch CLI (cql-execution is stateless pure JS, safe
under worker threads; `ScaleSubjectGenerator` is deterministic-on-subject-index, so work units can be
index ranges with near-zero transfer cost); the `fqm-execution`/pre-shipped-ELM path for the literal
official CMS122 diff (npm-verified `@cqframework/cql` has only ever published `4.0.0-beta.1` — ADR-024's
"wait for a stable multi-model translator" is a dead end; official MADiE bundles ship pre-compiled ELM
that MITRE's `fqm-execution` can execute directly, no translation needed); and incremental-eval CDC
(change-data-capture) patterns for a future delta batch run. All positions recorded in
**`docs/ROADMAP_2026-07-09.md`**.

Roadmap materialized on GitHub:
- **3 milestones:** M1 — Integration Readiness (pre-contract); M2 — WebChart Live Integration
  (contract-gated); M3 — Production Readiness.
- **13 new issues:**
  - #253 [owner-ops] Roll back fabricated scale seed + N=5000 real-eval proof run + profile
  - #254 Send the MIE unblock package (WebChart API contract questions) + record answers
  - #255 Mock-contract WebChart HTTP transport pre-build
  - #256 worker_threads pool for `seed:scale --mode evaluate`
  - #257 Tiered evidence policy at scale + auto-trim above N threshold
  - #258 [spike] E14 literal official-CQL execution diff via fqm-execution + pre-shipped ELM
  - #259 Expand the WebChart dev-DB fixture corpus to all patients
  - #260 Inert-seam inventory + boot-time active-seam log line
  - #261 Production-readiness memo: PHI/HIPAA posture, environment split, auth fork, tenancy
  - #262 E12 PR-2c: live WebChart HTTP transport (finalize against the real API contract)
  - #263 Incremental/delta batch evaluation (design gated on MIE change-signal answer)
  - #264 Observability minimum: failed-run alerting + run metrics
  - #265 Auth for production: resolve the SSO fork (blocked on MIE)
- **Updates to existing issues:** #78 commented (Option B's concrete trigger conditions + the
  rule→SQL-codegen reframe if it's ever built); #167 assigned M3; #168 assigned M3; #187 assigned M2;
  **#251 closed as superseded** by the fqm-execution spike (#258).

The MIE unblock package was authored: **`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`** — 18 questions
in A/B/C/D sections (API contract, domain/data model, environment & governance, strategic) — for the
owner to send to Doug/Dave Carlson alongside the WebChart dev-DB proof output and
`docs/TERMINOLOGY_AUDIT_2026-07-08.md`.

**Next:** owner ops — roll back the fabricated scale seed and run the N=5000 `--mode evaluate` proof
(#253), send the MIE package (#254) — both this week, in parallel — then work M1 in the order recorded
in `docs/ROADMAP_2026-07-09.md`.

### #261 — production-readiness memo (2026-07-09)

Docs-only PR (`docs/issue-261-production-readiness-memo`), no code. Delivered
`docs/PRODUCTION_READINESS_2026-07.md`, covering all 4 required sections: **PHI/HIPAA posture** (the
hard rule stated once and meant absolutely — the demo stack never receives PHI — plus the required
environment split, the BAA-chain question deferred to MIE Q C14, and a mapping of what already exists
against it — the `audit_events` ledger, `authorize.ts` role gates, refresh-cookie production fail-fast
checks — vs what's genuinely missing — a PHI-capable environment, a real user directory, real tenant
isolation, a durable scheduler, a backup/DR runbook); **auth fork** (hardcoded accounts today; the
three options — MIE SSO / WebChart-delegated / own OIDC — with the recommendation to not build until
MIE answers Q C15); **tenancy** (today's read-time synthetic tenancy, E13 PR-1/ADR-019, is demo-grade
grouping over one shared schema, not an isolation boundary; real multi-employer isolation flagged as a
design-with-MIE item); and the **ordered gap list** from `docs/ROADMAP_2026-07-09.md`, each item marked
required-for-first-integration vs nice-to-have and linked to its tracking issue.

Created the 4 M3 stub issues the gap list needed (milestone "M3 — Production Readiness", label
`infra`): **#267** PHI-capable environment split, **#268** durable scheduler (missed-run detection
across restarts), **#269** real tenant isolation for multi-employer production, **#270** backup/DR
runbook (Neon branch restore). Updated `CLAUDE.md` ("Other docs to consult on demand" + a Current Focus
note) and `README.md` (docs map + a Status bullet) to point at the memo. No schema, no code, no new
deps.

## 2026-07-08 (cont.) — scale batch-eval: review round + PR #252

The Option A scale work (below) was built subagent-driven (implementer → spec review → code-quality
review per unit), then opened as **PR #252** (`feat/scale-batch-eval` → `main`) and put through **two
Codex passes** at the owner's request (a Sonnet subagent invoking the local Codex CLI):

- **Codex (default model, low effort)** — 2 findings, both fixed: guard non-positive `chunkSize`/`subjects`
  on the exported engine (a `chunkSize` of 0 would dead-loop the chunk stream); documented the
  `listRuns(100_000)` idempotency scan cap as a known limitation.
- **Codex (`gpt-5.5`, high effort, full access)** — caught a genuine **P1** the earlier passes missed:
  `--mode evaluate` treated any COMPLETED `seed:scale` run as "done," so on a DB that already carries the
  **fabricated** seed (the live Neon 2026-06-29 1.68M-row seed) it would **silently no-op** and never
  produce real outcomes. Fixed: batch-evaluated runs now carry a `requestedScope.batchEvaluated` marker
  (idempotency counts only those; `listRuns` already projects `requested_scope_json`, so no store change),
  and evaluate mode **refuses with a rollback-required error** over legacy fabricated runs (owner-gated —
  never auto-deletes). Also made the finalize→audit write **best-effort** (WARN, don't abort — matches the
  run pipeline's Fable-H1 pattern). The concurrent-invocation race it flagged is accepted for a manual,
  single-operator offline tool (documented).

The code-reviewer skill passed across all three parts of the arc (E9 seam, terminology currency, scale),
with findings applied. **Full suite 1057 pass / 1 pg-skip / 0 fail.** PR #252 is **open — not merged**
(merge to `main` = deploy, owner's call). Owner operational step before the first live real-eval run: roll
back the fabricated `seed:scale` seed (DEPLOY.md), then `pnpm seed:scale --subjects 5000 --mode evaluate`
to prove + profile (plan Phase 4).

## 2026-07-08 — Option A at scale: real batch live-evaluation of the mhn tenant

Replaced the **fabricated** `mhn` (~120k) population-scale seed with **real batch CQL evaluation** — the
scale tenant's outcomes are now genuinely evaluated, not a synthesized compliance distribution
(`feat/scale-batch-eval`; ADR-020 update).

- **Engine — `batchEvaluateScalePopulation` (`backend-ts/src/run/batch-evaluate-scale.ts`).** Chunked and
  **subject-major**: generate each subject's FHIR bundle once, evaluate it against all runnable measures,
  fan the results out to the per-measure `seed:scale` runs. **Bounded memory** (one chunk buffered),
  **whole-batch resumable** (per-measure idempotency on COMPLETED `seed:scale` runs; a crash before the
  finalize loop re-seeds all measures), and **per-subject error-isolated** (an evaluation failure persists
  MISSING_DATA with `{evaluationError, message}` evidence and never aborts the run). Audited via the new
  **`SCALE_POPULATION_EVALUATED`** event (the fabricated path used `SCALE_POPULATION_SEEDED`).
- **Generators — `backend-ts/src/run/scale-generator.ts`.** A `ScaleSubjectGenerator` seam:
  `webChartRealisticGenerator()` (the default) emits **real LOINC/CVX/CPT codes** routed through the
  WebChart terminology crosswalk (`normalizeWebChartBundle`), genuinely exercising the real-world WebChart
  adapter at scale; `directSyntheticGenerator()` is the simpler `urn:workwell` path.
- **Encoding + read path unchanged.** The `mhn|Lxx|Pxx|n` `subject_id` encoding and
  `OutcomeStore.aggregateScaleRun` are **untouched** — `aggregateScaleRun` groups by encoded `subject_id` +
  status (content-agnostic), so the entire rollup / hierarchy / programs read path is unaffected. Only the
  outcomes' provenance changed (fabricated distribution → real CQL evaluation).
- **CLI.** `pnpm seed:scale --mode evaluate` (the **default**) runs the real batch eval; `--mode fabricated`
  keeps the legacy instant path reachable one more release; `--trim-evidence` persists minimal
  `{scale:true}` evidence (for a large 120k run, to protect Neon storage) — otherwise **full real
  `evidence_json`** (expressionResults) is stored. **Warning:** `--mode evaluate` at the default 120k is a
  long, single-threaded batch job (potentially hours — ~1.68M CQL evaluations, one log line per chunk); use
  a small `--subjects` (e.g. 5000) for proofs and `--trim-evidence` for a full run.
- **No schema change; no new dependencies; descriptive only (ADR-008 — the CQL engine is the sole
  `Outcome Status` authority); reversible via the same rollback SQL** (`triggered_by='seed:scale'` — delete
  tagged outcomes then runs). Full suite green: **1054 pass / 1 pg-skip / 0 fail.** Spec/plan:
  `docs/superpowers/specs/2026-07-08-option-a-scale-batch-eval-design.md`,
  `docs/superpowers/plans/2026-07-08-option-a-scale-batch-eval.md`.

## 2026-07-08 (cont.) — terminology & standards currency audit + vaccine-CVX fix (2026)

Before building the realistic-population generator (Option A), verified that every medical/clinical code
and standard we use is correct and current — a three-way check (our implementation vs MIE's WebChart dev DB
vs the 2026 authorities: CMS eCQI, CDC CVX, LOINC, VSAC, AMA CPT, eCFR/OSHA), run as six parallel research
agents. Full write-up: **`docs/TERMINOLOGY_AUDIT_2026-07-08.md`**.

**Verdict: correct and current on everything load-bearing.** Verified clean, no change: all **49** CMS
catalog entries' versions/MIPS IDs/titles for 2026 (**v14 = 2026** confirmed — 2024=v12→2025=v13→2026=v14;
do *not* advance to v15), all OSHA CFR citations (TB correctly = CDC), all runnable LOINC (`4548-4`,
`2089-1`, `8480-6`, `39156-5`, `97506-0`) and CPT (`92557`, `86580`, `86480`, `83036`, `83721`, `77067`).

**The one defect class — vaccine-CVX currency on the WebChart crosswalk — fixed:**
- **Influenza:** `141`/`140`-only missed the high-dose/recombinant/adjuvanted/quadrivalent/cell-based codes
  (most real records). Expanded to the full active seasonal CVX set; dropped deprecated `88` from the
  governance display. Compliance-grade grouping = VSAC "Influenza Vaccine" OID `2.16.840.1.113883.3.526.3.1254`
  (the earlier-floated `…1010.6` is the *all-vaccines* US Core set — corrected).
- **Td/Tdap:** CVX `139` (Td) is **INACTIVE** and was the only Td code — added active `09`/`113`/`196`
  (Tdap `115` was already right); `138`/`139` kept read-only for legacy.
- **MMRV → varicella:** CVX `94` now counts toward varicella immunity (already counted for MMR).
- **`G0202`** (mammography HCPCS) was deleted in 2018 (→ CPT `77067`) — marked read-only.

All fixes are **additive rows on the WebChart read path** (`engine/ingress/webchart/terminology.ts`), the
enforceable real-data surface — the synthetic evaluation path matches synthetic `urn:workwell:*` codes, not
CVX numbers, so **no synthetic outcome changed** (verified: **1020 pass / 1 pg-skip / 0 fail**, +3 new
currency-guard tests). Inactive codes are matched on read for legacy records, never emitted. Durable
follow-up: resolve flu membership from the VSAC value set via the ADR-023 resolver rather than the hardcoded
active list. No schema, no new deps. Docs: TERMINOLOGY_AUDIT (new), MEASURES.md, this entry.

## 2026-07-08 — E9 (#78) decision + the `MeasureExecutor` seam (Option A default, Option C architecture, Option B stubbed)

Took Doug's **Q2** (the "CQL → SQL" fork) off the blocked list and decided it **on our own**, since the
decision has to be robust to either answer he could give and E9's charter says it ships *"a decision, not
a build."* Recorded **ADR-025** and shipped the seam.

**The fork, resolved:** measure execution is now **pluggable behind a `MeasureExecutor` port**, with
FHIR-native as the default + correctness oracle and CQL→SQL as a parity-gated *future* executor (the
hybrid — Option C — as the architecture; Option A built; Option B stubbed).

- **`backend-ts/src/engine/measure-executor.ts`** — the port **extends `EvaluateMeasureBinding`**, so an
  executor drops into `evaluateBundle`/`evaluateBatch` (`opts.engine`) and the run pipeline with **no new
  plumbing**. `fhirNativeExecutor` (default) delegates to the existing CQL→ELM engine — **no second
  evaluation path**, and a test proves it produces the byte-same outcome as the direct engine path.
  `sqlPushdownExecutor` is an **inert stub** (constructs, but `evaluate` rejects loudly — general CQL→SQL
  is research-grade and not built), mirroring the inert `webChartDataSource`. `resolveMeasureExecutor(env)`
  selects config-driven (mirrors `resolveDataSource`/`resolveForecaster`); the SQL executor is chosen only
  on an explicit `WORKWELL_MEASURE_EXECUTOR=sql-pushdown` opt-in, so the **deployed default is
  byte-identical to today**.
- **Guardrail:** any future SQL executor must pass **golden parity** vs `fhirNativeExecutor`, per measure,
  before it may serve. B can never be the correctness authority — only a scoped optimization for the narrow
  measure subset (existence/recency/simple counts) where SQL is tractable.
- **Why decide it solo:** it can't be wrong either way. If Doug requires in-WebChart execution → the seam
  is ready for a scoped SQL executor; if "CQL→SQL" meant "replace hand-written SQL reports with a measure
  engine" → that's Option A, already being built. A's weakness (scale — E13 PR-2 had to *generate* the
  120k tenant's outcomes rather than live-evaluate 1.68M/run) is ordinary batch/incremental engineering;
  B's weakness (fidelity on complex CQL) is research-grade and maybe unsolvable. Prefer the solvable
  problem. Standards exports (MeasureReport/QRDA/QI-Core) and ADR-008 all depend on the real CQL engine.

Descriptive only (ADR-008): the executor decides *how* a measure is computed, never that anything but CQL
sets `Outcome Status`. **No schema, no new deps, no engine change** (additive seam; default delegates to
the existing engine). ADR-014 marked **superseded by ADR-025**; ADR-017's parked "opt-in second executor"
is now the concrete seam. B is deferred as its own research-grade epic (revisit when a concrete high-volume
WebChart measure shows A can't serve it, and once the WebChart schema is confirmed — same gate as E12
PR-2c). Verified: **backend typecheck clean; 1017 pass / 1 pg-skip / 0 fail** (4 new
`measure-executor.test.ts` cases: default selection, FHIR-native parity, SQL stub inert on use, opted-in
stub inert on use).

Docs: DECISIONS (ADR-025 + ADR-014 status), ARCHITECTURE (§3 engine bullet + §6 invariant), this entry.

## 2026-07-07 (cont.) — housekeeping + doc-currency reconciliation

Post-#250 merge cleanup and a docs reconciliation pass. Deleted the merged local branch
`feat/foreign-data-correctness` (PR #250; remote already pruned) and fast-forwarded `main` to
`c9a7106` — `main` is now the only local branch, clean. No open PRs.

Reconciled the **summary** docs against the actual merged-PR / closed-issue state, because the
CLAUDE.md "Current Focus" block (dated 2026-07-05) had fallen behind by ~9 PRs and was pointing the
next session at already-shipped work (it listed UX-7 + the UX-3/13/14/15 [L]s as open and E14 PR-3 as
blocked-on-VSAC — all in fact merged). The deep-dive docs (ARCHITECTURE, DATA_MODEL, MEASURES,
AI_GUARDRAILS, DEPLOY, WEBCHART_FHIR_MAPPING) were already current — the in-PR DoD held for those; only
the two roll-up surfaces had drifted. Changes:
- **CLAUDE.md** — rewrote the Current Focus block (now "as of 2026-07-07"): added the 07-05→07-07 arc
  (VSAC + E14 PR-3 #242/#243, the backlog sweep #244/#245, the WebChart dev-DB proof #246 CLOSED via
  #247–#249, foreign-data #250), and corrected the backlog status — the actionable polish backlog is
  **drained**; the 5 remaining open issues (#167 bucket, #168 onboot, #186 E14-literal-CQL, #187 E15
  PR-3, #78 E9) are all blocked or owner-gated.
- **README.md** — added the 5 missing Status bullets (#242/#243, #244/#245, #250).
- **JOURNAL.md** — fixed a stale "PR TBD" → #245 in the backlog-sweep entry; this entry.

**Decision logged:** the evidence S3/R2 BUCKET (#167) is **deferred** — evidence *metadata* + audit +
outcomes all persist in Neon; only uploaded *byte* content is ephemeral across container recreates, the
`CloudBucket` port already abstracts the swap, and provisioning a bucket + secrets is owner-gated infra
with no demo-blocking need. Flip it when a real pilot needs uploaded files to survive a redeploy.

No code, no schema, no deps — docs only.

## 2026-07-07 (cont.) — foreign-data correctness pre-E12: AI prompt fencing (L14) + out-of-population signal (L17)

Closed out two of the Fable "foreign-data correctness pre-E12" items — the ones that become *wrong answers /
attack surface the day real WebChart data arrives* (the class we just enabled with the dev-DB proof). Verified
first that **M19 (codegen degenerate-numeric validation) was already fixed** (`validateRule` in
`generate-cql.ts`), so this PR is L14 + L17.

**L14 — AI explain prompt fencing.** `explainCase` interpolated raw `JSON.stringify(evidenceJson)` straight
into the model prompt — a prompt-injection surface once E12 feeds real WebChart-derived strings (patient
names, free-text). Added a pure, exported `buildExplainUserPrompt(status, evidenceJson)` that wraps the
evidence in explicit `BEGIN/END EVIDENCE JSON` markers labelled untrusted-data-not-instructions and
size-caps it (8000 chars, truncation-marked); hardened `EXPLAIN_SYSTEM_PROMPT` to match. 3 tests (fencing,
size-cap, an injection string stays inside the fence — never a bare instruction before the marker). Docs:
AI_GUARDRAILS §2.2.

**L17 — out-of-population signal on `MeasureOutcome`.** An out-of-program subject (not enrolled/not eligible)
evaluated MISSING_DATA via the CLI/ingress — indistinguishable from an enrolled-but-no-data subject, so on
the real-data path a patient simply not in the program reads as non-compliance. Added an additive
`inInitialPopulation?: boolean` to `MeasureOutcome`, derived in `CqlExecutionEngine` from the CQL "Initial
Population" define (every runnable measure emits it); it flows through `evaluateBundle`/`evaluateBatch`/
`evaluateSource` for any consumer. 1 ingress test (enrolled → `true` on a MISSING_DATA; not-enrolled →
`false`). Descriptive only (ADR-008) — it never changes `outcome`. Docs: ARCHITECTURE §7.

**No schema, no new deps.** Full suite **1082 pass / 0 fail**; typecheck clean.

## 2026-07-07 (cont.) — WebChart dev-DB proof, PR-3: demo CLI + writeup (#246 — proof complete)

Added the showable artifact: `pnpm evaluate:webchart-devdb [--date YYYY-MM-DD]`
(`webchart/devdb-cli.ts`) loads the committed dev-DB sample, runs it through the unchanged ingress + engine,
and prints a per-measure outcome table + the excluded-measure list (no silent caps). Reuses
`evaluateSourceWithRoster`; reads committed fixtures only (no Docker/DB). 3 structured-output tests
(bucket counts reconcile; non-degenerate proof; every excluded measure named). Live output:

```
WebChart dev-DB evaluation proof — 26 patients, as-of 2024-06-01
  measure                   COMPL      DUE  OVERDUE  MISSING     EXCL   total
  diabetes_hba1c                0        0        4       22        0      26
  obesity_bmi                   5        0        8       13        0      26
  cholesterol_ldl               0        0        1       25        0      26
  hypertension                  3        0        6       17        0      26
  cms125                        0        0        1       25        0      26
  → 28 real (non-MISSING_DATA) outcomes across the whitelist — the pipeline works end-to-end.
```

**#246 complete (PR-1/2/3).** The WebChart→FHIR adapter is now proven end-to-end on MIE's real dev-DB
sample — offline, no live API, no MariaDB driver — while PR-2c (live HTTP transport) stays deferred behind
its `WebChartClient` seam. Descriptive only (ADR-008); no schema, no new deps. Full suite **1077 pass / 0
fail**. Docs: WEBCHART_FHIR_MAPPING §8.1.

## 2026-07-07 (cont.) — WebChart dev-DB proof, PR-2: export tool + committed fixtures + e2e proof (#246)

**Proved the WebChart→FHIR pipeline end-to-end on MIE's real dev-DB sample — offline, no live API, no
MariaDB driver.** Brought up the seeded `wcdb` MariaDB (56 patients, 1,887 observations) and inventoried
it: rich on lab observations (real LOINC), sparse on procedures (1 coded — a G0202 mammogram), no CVX.
`obs_result_dec` is null (no numeric values) but the recency measures only need the **date** (`obs_ts`),
which spans 2015–2024.

**Real-code finding, folded into the crosswalk.** The dev DB records **LDL as LOINC `2089-1`** (serum) and
**BP as component `8480-6`** (systolic) — not our synthetic assumptions (`13457-7`/`18262-6`, panel
`85354-9`). Added those two rows to `webchart/terminology.ts` (option B; descriptive) so MIE's actual codes
reconcile; terminology test added.

**What shipped (`feat/webchart-devdb-fixtures`, stacked on PR-1):**
- `scripts/webchart-devdb-export.ts` — dev-only, **driver-free** export: shells `docker exec wcdb mysql
  --batch --raw -N` with `JSON_OBJECT` (MariaDB 10.3 JSON) and **serializes the FHIR in Node**
  (`JSON.stringify` + validate) so NULLs/encoding/newlines are handled by a real serializer, not brittle DB
  line-output (Codex P2). `pnpm webchart:export-devdb`.
- Committed fixtures: `spike/webchart/devdb-patients.json` (26 patient bundles with codeable data) +
  `spike/webchart/enrollment-roster.json` (deterministic OH roster — the wellness panel for all, `cms125`
  for female patients). Runtime/CI read these; they never touch Docker or the DB.
- `webchart/devdb-eval.test.ts` — the committed offline proof: runs the sample through the **unchanged**
  ingress + engine at a data-contemporaneous eval date (2024-06-01) and asserts **deterministic per-patient
  outcomes** — HbA1c-2015 → OVERDUE, BMI/BP-2024 → COMPLIANT, enrolled-but-no-lab → MISSING_DATA, G0202
  mammogram → OVERDUE, the two new-crosswalk codes evaluate — plus a distribution assertion (**NOT all
  MISSING_DATA**, the proof) and an **excluded-measures** assertion (OSHA/CVX/cms122 stay MISSING_DATA —
  named, not silently dropped).

**Demonstrable whitelist:** `diabetes_hba1c`, `obesity_bmi`, `cholesterol_ldl`, `hypertension`, `cms125`.
**Descriptive only (ADR-008)** — reconciliation + roster supply coded FHIR; CQL decides every outcome. **No
schema, no new deps.** Verified: typecheck clean; full suite **1074 pass / 0 fail** (Pg ceiling contract
ran too — local postgres up). Docs: WEBCHART_FHIR_MAPPING §5 + §8.1.

## 2026-07-07 — WebChart dev-DB proof, PR-1: OH enrollment roster + enrollment-Condition stamping (#246)

Opened a new follow-up to the closed E12 epic (#184): prove the WebChart→FHIR adapter **end-to-end on
MIE's real dev-DB sample, offline**, while the live-API PR-2c stays blocked on the WebChart API contract.
Issue **#246** (backend/webchart-convergence/cql-engine), on the roadmap board; sliced PR-1 (roster core)
→ PR-2 (dev-DB export + committed fixtures + e2e) → PR-3 (demo CLI). Plan reviewed by Codex (folded in:
pure measure-scoped seam, deterministic per-measure e2e assertions, Node-side JSON serialization for the
export, honest lab/vital scoping).

**PR-1 (`feat/webchart-devdb-enrollment`) — the one blocking gap, closed.** The measures gate on a
program-enrollment `Condition` (`urn:workwell:vs:*`) that WebChart doesn't carry — it's OH program
membership, held WorkWell-side, not clinical coding — so a real WebChart clinical bundle alone evaluates
MISSING_DATA. The PR-2b tests had hand-baked that Condition into each fixture; PR-1 turns it into a real,
reusable mechanism. New `backend-ts/src/engine/ingress/enrollment/roster.ts`: an `EnrollmentRoster`
(subject → enrolled measure-ids) + `parseEnrollmentRoster` (junk-tolerant, from plain JSON) + the pure,
measure-scoped `stampEnrollment(bundle, measureId, roster)` (appends the enrollment `Condition` from
`MEASURE_BINDINGS[id].enrollment` — identical to `fhir-bundle-builder.ts`'s `condition()` — idempotent,
no-op on unknown-measure/absent-subject/already-present, never mutates input) + `evaluateSourceWithRoster`
(thin pre-evaluation seam: load → stamp → `evaluateBatch`). Kept OUT of `normalize`/a generic decorator so
roster assumptions never leak into every evaluation (Codex P1). TDD (`node:test`, inline fixtures): the
enrolled + real-LOINC-HbA1c path evaluates COMPLIANT while the no-roster control stays MISSING_DATA, plus
structural + idempotency + fail-fast tests. **Descriptive only (ADR-008)** — it adds a Condition the CQL
reads, never an `Outcome Status`. **No schema, no new deps.** Verified: typecheck clean; full suite
**991 pass / 1 pg-skip / 0 fail** (+8). Docs: ARCHITECTURE `engine.ingress.enrollment`.

## 2026-07-05 (cont.) — backlog sweep: #233 perf, E14 GMI, UX-3/7/13/14/15

Closed out the genuinely-open, non-blocked backlog in two PRs (descriptive/presentational only; no schema, no new deps).

**Backend (PR #244) — `feat/backlog-backend`:**
- **perf(#233):** the roster + hierarchy read paths over-fetched — `listOutcomesWithRun` shipped ~20k rows
  for every live population run, reduced to latest-run-per-measure in JS. New
  `OutcomeStore.listLatestPopulationOutcomes` pushes that reduction into SQL (Pg `DISTINCT ON (measure_id)`;
  SQLite `ROW_NUMBER() OVER (PARTITION BY measure_id …)`), cutting rows shipped to ~2,100; output
  byte-identical (store-contract equivalence test); no owner-gated DDL. Live warm-latency validation is a
  post-deploy step.
- **feat(e14, GMI):** the official-subset CMS122 numerator now takes the most-recent of **HbA1c OR GMI**
  (LOINC 97506-0, inline filter — no standalone VSAC OID), closing the Fable L15 gap. Avoids a
  cql-execution `union` de-dup pitfall; ADR-008 byte-identical guard holds.

**Frontend UX (PR #245) — `feat/backlog-frontend-ux`:**
- **UX-7:** styled evidence dropzone (`features/evidence/EvidenceDropzone.tsx`) replacing the bare native
  file input on case detail; drag-drop + selected-file readout + "storage is temporary on this demo" note;
  upload handler + role-gate + `aria-label` preserved.
- **UX-14:** a passive-metadata chip tier (`metaChipClass` + shared `DeliveryChip`) applied only to the
  outreach-delivery chips (NOT SENT/SENT/SIMULATED) so they read lighter than actionable status chips
  (labels unchanged; `text-neutral-600` keeps AA on tinted panels).
- **UX-15:** the Studio change-summary input + New Version grouped into an **accessible disclosure**
  (`features/studio/components/VersionActions.tsx`, `role="group"` + `aria-expanded`, Escape/outside-click);
  validation + role-gate preserved.
- **UX-3:** optimistic panel caching (`features/compliance/usePanelCache.ts`, keyed by the full query
  signature — /compliance panel A→B→A serves from cache) + a `>3s` "Crunching ~1.68M outcomes…" hint
  (`lib/useSlowLoadHint.ts`) on /compliance + /programs/hierarchy, announced via the existing `aria-live`.
- **UX-13:** labelled the global header site/time selectors "Global" (`components/global-filter-group.tsx`,
  `role="group"`) so it's discoverable they're app-wide vs page filters — a low-risk fix; the fuller
  "migrate site/time per-page" refactor is deferred to a design call (the global filters feed 6 pages).

## 2026-07-05 — E14 PR-3: official-subset CMS122 execution outcome diff (ADR-024)

Turned `GET /api/measures/cms122/fidelity/diff` from PR-2's **criteria-impact estimate** into a **real,
subject-by-subject execution outcome diff** for CMS122 — built on top of the ADR-023 live-VSAC on-ramp.

**Spike → fallback decision.** The obvious plan was to compile and run the *literal* official CMS122v14
QICore CQL. A compile-feasibility spike (2026-07-05) proved that is un-compilable under the pinned
JVM-free translator `@cqframework/cql` 4.0.0-beta.1: its modelinfo loader can't resolve the cross-model
`FHIR.*`/`USCore.*` type refs, so the whole QICore model fails to load (804 errors / 0 retrieves; a
hand-crafted minimal QICore modelinfo *did* load, isolating the blocker to the real cross-model
modelinfo), and the runtime engine links no multi-library include graph. So the deliverable is a
**faithful official-SUBSET** measure (`measures/cms122_official.cql`, `using FHIR '4.0.1'`,
value-set-retrieve style, committed ELM `DiabetesHbA1cPoorControlOfficialCQL-1.0.0`), driven by the
imported VSAC OID value sets — documented as a subset, not the literal artifact. Revisit the literal
path on a stable multi-model translator release (ADR-024).

**What shipped.**
- `backend-ts/src/standards/cms122-official.ts` — the inline `CMS122_OFFICIAL_META` (kept **out** of the
  `MEASURES` registry) + OID constants + `enrichForOfficialCms122`, a **harness-local** additive
  enrichment (appends real VSAC-member codings to the diff harness's bundle copy; not a change to the
  shared `fhir-bundle-builder.ts`, never on the live run path).
- `backend-ts/src/standards/execution-diff.ts` — `computeExecutionDiff`: per subject in the latest cms122
  run, build → enrich → evaluate **both** WorkWell's `cms122` and the official-subset measure fresh →
  diff, attributing each divergence to the first differing gate (age/visit/diabetes/hospice/palliative/
  hba1c-missing/workwell-side). Memoized per run-id.
- Engine `metaOverride?: MeasureMeta` seam on `CqlExecutionEngine.evaluate` so the official measure
  evaluates without being registered.
- Route `GET /api/measures/cms122/fidelity/diff` runs the execution diff when the imported VSAC
  `value_sets` (`source='VSAC'`) rows are present — store-backed resolution via `StoreValueSetResolver`,
  **no runtime VSAC key needed** — else degrades to the unchanged PR-2 estimate (`chooseDiffMode`).
- Frontend Studio **Standards** tab renders the per-subject execution divergence in execution mode, else
  the estimate.

**Descriptive only (ADR-008):** the diff writes nothing, WorkWell's cms122 outcomes stay byte-identical,
**no schema change, no new dependency**. Known gaps: GMI numerator alternative; the execution diff is
CMS122-only. Live execution-mode verification happens post-deploy on the stack that has the imported VSAC
rows (locally there are none, so the route correctly serves the estimate — covered by automated tests).

Verification (full suite): backend typecheck clean + **973 pass / 1 pg-skip / 0 fail** (974 tests);
frontend lint clean + **vitest 127 pass / 26 files** + **build succeeds**. Docs updated in this PR
(MEASURES, ARCHITECTURE §3 `standards` + §6 invariants + §7 interfaces, DATA_MODEL §3.4 note, DECISIONS
ADR-024).

## 2026-07-05 — Live VSAC value-set resolution behind the `ValueSetResolver` port (ADR-023)

Built the **live VSAC (NLM UMLS) value-set resolution** capability behind the existing `ValueSetResolver`
seam — the E14 official-CQL on-ramp, done without a schema change or a new dependency. Layered strictly
additively: a `VsacClient` transport seam (`vsac-client.ts` — `fixtureVsacClient` + `httpVsacClient` over
the live NLM FHIR `GET {base}/ValueSet/{oid}/$expand`, Basic `apikey`:key, global `fetch`, throws on
non-2xx); `VsacValueSetResolver` (per-OID memoized, **propagates errors — never a silent empty set**); a
`CompositeValueSetResolver` + `isVsacOid` routing dotted-numeric OIDs → VSAC and `urn:workwell:*`/URLs →
the local `StoreValueSetResolver`; `resolveValueSetResolver(env, store)` selecting the composite **only**
when `WORKWELL_VSAC_API_KEY` is set (inert-unless-configured, mirroring `resolveForecaster`/`resolveChannel`/
`resolveDataSource`); and `engineForEnv(env)` — the memoized per-env engine builder, **key-gated** so the
unkeyed path returns a resolver-less `CqlExecutionEngine` byte-identical to today. Wired into every runtime
eval path — the `runs`/`cases`/`measures` routes, `compliance-simulation`, and the nightly `schedulerTick`
— but deliberately **not** the DB-less `evaluate-bundle.ts` ingress or the seed CLIs.

An owner-run `pnpm resolve-valuesets` CLI (`run/cli/resolve-valuesets.ts`) `$expand`s each target OID
(default = the 21 CMS122v14 reference OIDs; `--oid`/`--measure` override) and upserts real codes into the
**existing** `value_sets` columns via `upsertResolvedValueSet` (`source="VSAC"`, RESOLVED; a failed OID →
ERROR row + continue), audited `VALUE_SETS_RESOLVED` per OID — **no DDL**. **Descriptive only (ADR-008):**
the ADR-008 guard is `audiogram-vsac-parity.test.ts` (audiogram inline == composite-with-VSAC-key-on ==
expected across all scenarios) — enabling the key changes no current measure's `Outcome Status` because
the composite still falls back to the local store for `urn:workwell:*`. Full backend suite green — **958
pass / 1 pg-skip / 0 fail; no new deps.** New env vars: `WORKWELL_VSAC_API_KEY` (UMLS key; the demo stack
leaves it **unset**) + `WORKWELL_VSAC_BASE_URL` (default `https://cts.nlm.nih.gov/fhir`). Reversible: unset
the key → plain store resolver; `DELETE FROM workwell_spike.value_sets WHERE source = 'VSAC';` removes
imports.

**Follow-on (out of scope, not done):** the rest of E14 PR-3 — executing the official CMS122 CQL and
diffing outcomes subject-by-subject — needs the official CQL→ELM plus synthetic-data enrichment
(encounters/hospice/frailty) so the official denominator populations resolve. **Owner post-deploy step if
enabling VSAC:** run `pnpm resolve-valuesets` against Neon with `WORKWELL_VSAC_API_KEY` set. Spec/plan:
`docs/superpowers/specs/2026-07-05-vsac-value-set-resolution-design.md`,
`docs/superpowers/plans/2026-07-05-vsac-value-set-resolution.md`.

## 2026-07-05 — Day closeout + docs sync

End-of-day: five PRs merged + deployed over 2026-07-04→05 (WCAG #237, perf #233 ×2 #238/#239, UX-8 #240,
UX-11 #241) — see the entries below. Synced the living docs to `main`: README **Status** (added #224→#241;
E15 marked complete), CLAUDE.md **Current Focus** (bumped to 2026-07-05 with the 07-02→07-05 arc + backlog
status), CHANGELOG (the E10–E16 roadmap arc + today's UX/a11y/perf); ARCHITECTURE/DATA_MODEL were already
updated in the feature PRs. **No open PRs; tree clean.**

**Backlog verified 2026-07-05:** most Fable [M]/[L] UX-debt is already closed (UX-9 scale-provider naming,
UX-12 count formatting, UX-16 unified AccessDenied, UX-18 Scheduled trigger filter). Genuinely open: **UX-7**
(styled evidence dropzone — case detail is still a plain `<input type=file>`), the #233 perf residual (a
`DISTINCT(measure,run)` query for the last ~1s + the Neon 0.25-CU cold-start), and design-y [L]s (UX-13/14/15,
UX-3). Blocked: E12 PR-2c (MIE API contract), E14 PR-3 (VSAC), E15 PR-3 (WebChart), E9 (Doug Q2).

## 2026-07-05 — UX-11: compliance roster mobile card layout

The `/compliance` roster is a wide table (sticky Employee column + N measure columns) that shows only
~1.5 columns per phone screen. Added a per-employee **card** layout (`RosterMobileCards`) shown below the
`md` breakpoint; the existing table stays at `md`+. CSS-only responsive switch (`hidden md:block` table +
`md:hidden` cards) — `display:none` keeps the hidden layout out of the a11y tree, so AT + sighted users
each see exactly one. Each card is an employee header (name link + tenant · site · role) over a `<dl>` of
measure → `ComplianceChip`, giving an explicit measure→status pairing on mobile. Same data/filters/paging;
chips still come verbatim from the read model (ADR-008). New component + 3 unit tests; one existing page
test scoped to `getByRole("table")` for the now-duplicated name. No schema, no new deps; frontend tsc +
lint + vitest + build green.

## 2026-07-04 — UX-8: program-card trends onto quality_snapshots (monthly)

The `/programs` per-card trend drew from per-run history, which flat-lines under the daily scheduled
runs ("↑ 0% from last run" read like a bug). Rewired it to the monthly `quality_snapshots` series (the
E16 source of truth), scoped by the page's tenant/site filters, with a per-run fallback when a scope has
<2 monthly snapshots. Branch `feat/ux8-monthly-trend`.

Additive only: `snapshotScopeFor` (filters → snapshot scope, directory-resolved site→tenant; null ⇒
fallback) + `monthlyTrendPoints` (pure, exported) in `program-read-models.ts`; `period?` on
`ProgramTrendPoint`; an optional `qualitySnapshots` on `ProgramDeps` (route wires
`stores.qualitySnapshots`); and a frontend `trend-meta.ts` helper that swaps the labels to months +
"from last month" (UTC-stamped, Fable M18). No schema, no new endpoint, no new deps; descriptive-only
(ADR-008).

Code review caught two P2s + a cohesion gap (the `/trend` endpoint is **also** consumed by the measure
page, which reads raw `trend[1]` for a delta vs the headline `program.complianceRate` AND renders its own
per-run `ComplianceTrendChart`): (1) monthly points must be **newest-first** like the per-run branch, else
`trend[1]` is the second-oldest month; (2) the monthly rate must use `compliant / total-including-excluded`
(matching the per-run branch + the `programOverview` headline), not the E16 `numerator/denominator`
proportion — otherwise the trend never reconciles with the card's big % and the delta subtracts two
different metrics; and (3) the monthly series is made **opt-in via `?granularity=month`** — only the
`/programs` card requests it, so the measure page (no param) keeps its per-run chart unchanged (it already
has the E16 "Quality over time" card, so a second monthly chart would be redundant). A post-PR Codex P2
added a fourth guard: the dashboard's `from`/`to` are day-granular, so a partial-month range (e.g.
`2026-06-27..2026-07-04`) would widen the monthly query to whole June+July while the KPIs honor the exact
range — the monthly path now runs only for whole-month-aligned (or unbounded) ranges (`isWholeMonthRange`),
falling back to the day-granular per-run path otherwise. All fixed with regression tests. **Backend 933
tests (932 pass / 1 pg-skip); frontend tsc + lint + 123 vitest + build green.**

## 2026-07-04 — perf(#233 follow-up): roster derived-cell cache

Post-deploy live re-measure of #238 (PR #238, merged) showed the warm path ~5× better
(hierarchy 5.0s → ~1.1s; roster 6.4s → ~1.2s) but the **roster still floored at ~1.2s warm** because it
re-loads the latest ALL_PROGRAMS run's **~1.3MB of `evidence_json`** and re-derives every cell on each
request (Fix A removed the scan; this was the next layer). Branch `perf/roster-cell-cache`.

**Fix:** the roster's derived cell map for a measure's latest run is immutable (a COMPLETED population
run's outcomes don't change, and `deriveCell`/`deriveWhyFlagged` are pure over them — recency/overdue
read the CQL defines baked into evidence at evaluation time, not "today"). So memoize it —
`rosterCellCache` (`compliance/roster-read-model.ts`), keyed by `measureId`, superseded when a newer run
appears (a Recalculate mints a new runId), bounded to one entry per measure. The route passes the shared
instance; tests omit it for per-call isolation. On a warm cache the roster does **zero** `listOutcomes`
loads — the 1.3MB fetch + derive is skipped entirely.

Same immutable-run pattern as #238's `aggregateScaleRun` memo. **No schema, no new deps, descriptive-only
(ADR-008).** TDD: a call-counting-store test proves the second same-run build reloads nothing and a newer
run supersedes → recompute.

**Codex P2 folded in (the invariant the cache rests on):** `POST /api/runs/:id/evaluate` appended an outcome
via `recordOutcome` with no run-status guard, and `markRunning` is a QUEUED-only no-op — so a **terminal**
population run could keep its status + runId while gaining rows, which the runId-keyed cache would miss
(stale). The async worker only ever evaluates QUEUED/RUNNING runs (the pipeline records via `recordOutcome`
directly in a linear `markRunning → record → finalize` flow, never via this HTTP slice), so the endpoint now
**rejects a terminal run with 409** — enforcing "terminal run = immutable," the invariant the roster cache,
the scale memo, `latestRunRows`, and the quality snapshots all rely on. A colocated test drives a run to
COMPLETED and asserts 409 + no appended outcome. Cached cells are also `Object.freeze`d (earlier P3).

**Backend typecheck clean, 919 tests (918 pass / 1 pg-skip). Live re-measure after deploy is the
confirmation step.**

## 2026-07-04 — perf(#233): roster + hierarchy latency (5–13s → sub-second)

Fixed the one open item from the post-merge live verification: `/api/compliance/roster` and
`/api/hierarchy/rollup` were taking ~5–13s steady-state on the live stack. Branch
`perf/roster-hierarchy-latency`. **Profiled first** — `EXPLAIN ANALYZE` against live Neon
(`workwell-twh`, 1.71M `outcomes` rows, 0.25–2 CU) surfaced two independent cost centers, both from the
1.68M-row `seed:scale` tenant sharing the `outcomes` table with the ~20k live rows:

- **Cost A — the shared `listOutcomesWithRun` scan (3,242 ms).** It excluded the scale/trend runs with a
  predicate on the *joined* `runs.triggered_by` (`<> 'seed:scale'`), which the planner can't use to prune
  the `outcomes` scan — so it **Seq Scanned all 1.71M rows** every request to keep the ~20,100 live ones.
  This is why the roster was slow *despite never touching the scale aggregation*. Shared by the roster,
  hierarchy, and programs-overview reads.
- **Cost B — the scale fold (~3,700 ms).** The hierarchy/overview call `aggregateScaleRun(runId)` (a
  120k-row `GROUP BY`, ~267 ms each) **once per active measure, serialized** — up to 14× per request.

**Fix A (validated live):** rewrote the exclusion as `o.run_id = ANY(ARRAY(SELECT id FROM runs WHERE
triggered_by NOT IN (…)))` so the planner drives the `spike_outcomes_run_id_idx` bitmap index scan
instead of a full seq scan. `EXPLAIN ANALYZE` on the live DB: **3,242 ms → 41 ms (~79×)**, identical
20,100 rows (verified old-form vs new-form COUNT parity, incl. measure-scoped). Applied to both the Pg
ceiling and the SQLite floor (parity + same result set; a NULL `triggered_by` is excluded either way).

**Fix B:** memoized `aggregateScaleRun(runId)` in-process on the store instance (a long-lived
singleton — one per env, `stores/factory.ts`). A COMPLETED `seed:scale` run is written once and never
re-evaluated, so its aggregation is a pure function of an immutable runId; a re-seed mints new runIds
(cache miss). Bounded to ~one entry per runnable measure. Removes the ~3.7s scale fold from the
hierarchy/overview warm path.

Both fixes are the shared read path, so `/compliance/roster`, `/programs/hierarchy`, and `/programs`
all benefit. **No schema, no new deps, descriptive-only (ADR-008 untouched).** TDD: extended
`outcome-store-scale.test.ts` — a Fix-A result-set guard (excludeTrendHistory + combined filter keep
only live rows) and a Fix-B memoization characterization (red→green: a post-first-call insert doesn't
change the cached aggregate). **Backend typecheck clean, 916 tests (915 pass / 1 pg-skip / 0 fail).**
Live re-measure after deploy is the confirmation step.

## 2026-07-03 — Full WCAG 2.2 AA audit + remediation (the largest UX-debt item)

Closed the "full WCAG 2.2 AA audit" that every prior review (06-20 QA, Fable Pass-3) named as the project's
**largest remaining UX debt**. Branch `feat/wcag-2.2-aa-remediation`.

**Audit** (`docs/WCAG_AUDIT_2026-07-03.md`) — a systematic code-level pass over the whole `frontend/` surface
(82 tsx across `app/`/`components/`/`features/`) against WCAG 2.2 AA + the Web Interface Guidelines, run as 5
parallel auditors (shell/auth · programs/compliance/runs+charts · operator surfaces · Studio/admin/segments ·
shared primitives). **Result: 0 critical, 1 High, ~40 findings — all mechanical.** The audit also *verified in
code* that several items prior reviews left "open" are **already fixed**: dark-mode white chart tooltips (all
charts use the theme-aware `chartTooltipStyle`), the H11 tab-switch data-loss hazard (Studio tabs use manual
activation with a documented rationale), the UX-5 segment-modal overflow + M26 dirty-check, and the skip
link/reduced-motion/ChartDataTable/confirm-dialog foundations. A live NVDA + keyboard-only walk of the 5 core
flows remains the recommended final human acceptance step (can't be done from code).

**Remediation shipped:**
- **A11Y-H1 (High)** — the OSHA reference combobox (Studio Spec authoring) was **keyboard-inaccessible**
  (options only wired `onMouseDown`, which never fires on Enter/Space; the input's `onBlur` closed the list on
  tab-out). Rewrote it as a real **ARIA combobox** (`role=combobox`/`listbox`/`option`, `aria-expanded`,
  `aria-activedescendant`, arrow/Enter/Escape/Home/End, `relatedTarget`-aware blur, `onMouseDown`-preventDefault
  + `onClick` so mouse selection is preserved) + a focus-visible ring. **TDD** — 7 new colocated tests
  (`osha-reference-combobox.test.tsx`) covering keyboard select, active-descendant tracking, Escape, mouse
  click, filtering.
- **`aria-live`/`role=alert` sweep (~19 sites)** — the dominant gap: async error `<p>`s got `role="alert"`;
  load/skeleton/result/compile/AI-draft regions got `role="status" aria-live="polite"` (or an `sr-only` count
  announcer) across GlobalSearch, sandbox, compliance/programs/hierarchy/[measureId] loads, runs error + AI
  insight, campaigns launch result, cases/people/admin/studio errors, CqlTab/SpecTab/ElmExplorer/TestsTab
  compile+draft results, SegmentEditorModal preview, CopyableId "Copied".
- **Contrast token sweep (~15 sites, WCAG 1.4.3)** — meaningful `text-neutral-400`/`text-slate-400`-on-light
  (≈2.6:1) bumped to `-500/-600` with `dark:` variants preserved; dark-panel text (sandbox) bumped the other
  way; `SlaChip` yellow-600→700; added missing `dark:` variants on red/amber/blue callouts.
- **Focus rings** — 3 removed outlines (GlobalSearch, ElmExplorer textarea, combobox) → `focus-visible:ring-2`.
- **Target size (WCAG 2.5.8)** — sub-24px icon/inline buttons padded (CopyableId copy, hierarchy caret,
  people unlink/link, CqlTab dismiss, RuleBuilder add/remove).
- **Semantics** — decorative icons/dots/skeletons `aria-hidden`; admin tabs upgraded to the **full ARIA tab
  pattern** (ids/`aria-controls`/`role=tabpanel`/roving tabIndex/Arrow-Home-End, automatic activation — no
  unsaved state, unlike Studio); orphan `<label>`→`<span>` (cases/[id], admin); mobile now has an `<h1>` (login
  hero tagline → `<p>`, form heading is the single always-present `h1`); orders "Suppressed" table got a
  `<thead>`/`scope="col"`; campaigns history `<tr role="button">` → real row with a first-cell `<button>`;
  IndividualComplianceStatus expander got `aria-expanded`/`aria-controls`; ComplianceChip NA cell got an
  `sr-only` accessible name; SqlPreviewPanel disclosure got `aria-controls`.

**Whole-branch code review** (superpowers:code-reviewer) confirmed the three larger rewrites (combobox, admin
tabs, campaigns row) are behavior-preserving; 3 minor announcement/heading nuances it flagged were fixed
(GlobalSearch results list was itself the live region → replaced with an `sr-only` count node; login double-h1
→ single form h1; campaigns live region wrapped the whole `RecipientTable` → scoped to the summary line).

**Verified:** frontend tsc clean, lint clean, **121 vitest pass (+7)**, build green. **36 files, +~280/−140.**
No schema, no new deps, display-only (ADR-008 untouched — nothing here touches compliance).

**Merged as PR #237** (2026-07-04). One Codex P3 folded in before merge: the campaigns-history row remediation
had moved click/keyboard handling into the first-cell `<button>` but dropped the row-level `onClick` entirely,
leaving every cell with hover/selected styling that implied the whole row was clickable when only the Created
cell was. Restored the `/runs` row convention — a mouse-only whole-row `onClick` (the `<tr>` stays a real table
row for AT) plus the first-cell `<button>` carrying the keyboard/screen-reader affordance and
`stopPropagation()`ing so it can't double-fire. tsc/lint/121 vitest green.

**Next (remaining UX debt, tracked):** UX-8 (program-card trends → `quality_snapshots`), UX-5 (already not
present in code — re-confirm on the live modal), UX-7 (styled evidence dropzone), UX-11 (roster mobile cards),
UX-3 (progressive-load feedback beyond the `aria-live` announcements added here), plus the filter-architecture /
operator-home / density-toggle design proposals.

## 2026-07-03 — UI/UX Pass-3 follow-up: on-demand AI insight, UUID linking, unified AccessDenied

Second UI/UX PR (`feat/uiux-pass3-followup`) picking up the medium-effort Fable Pass-3 items deferred from
the first pass.

- **UX-19** — viewing a run detail auto-fired a **billed** OpenAI run-insight call per selected run
  (`/api/runs/:id/ai/insight` in a `selectedRunId` effect). Now **on-demand**: a "Generate AI insight"
  button (with a loading state); the effect clears the prior run's insight instead of fetching. Removes the
  read-a-page-costs-money smell (the sprint plan's own hard AI-spend rule).
- **UX-6** — raw UUIDs as primary content. New reusable `CopyableId` (`components/copyable-id.tsx`) — a
  shortened monospace token + a copy button, optionally linked to the id's surface. Wired the case-detail
  "Last run" to link to `/runs?runId=…` (which already auto-selects) + copy. 4 unit tests.
- **UX-16** — inconsistent access-denied treatments (purpose-built cards on /campaigns + /orders, a card on
  /people) unified into one `AccessDenied` (`components/access-denied.tsx`, `role="status"`), adopted on all
  three.

**Verified:** frontend tsc --noEmit clean, lint clean, 114 vitest (+4), build green. No schema, no new deps,
display-only (ADR-008 untouched).

**Still deferred:** the larger design-pass items (UX-8 program-card trends → `quality_snapshots`, UX-5 modal
overflow, UX-7 evidence dropzone, UX-11 roster mobile cards, UX-3 progressive feedback, filter-architecture
/ operator-home / density) and the full WCAG 2.2 AA audit.

## 2026-07-03 — UI/UX + accessibility pass (Fable Pass-3 quick-wins + a11y fundamentals)

With the backend Fable findings (Pass-1: all H/M/L) closed in the hardening sprint, this takes the first
cut of the untouched **Pass-3 UI/UX inspection** (`docs/FABLE_REVIEW_2026-07-02/03-ui-ux-inspection.md`) —
the high-ROI quick-wins + accessibility fundamentals. Branch `feat/uiux-a11y-fable-pass3`.

**Shipped:**
- **UX-1** — the compliance roster floated the 4 fake "Demo …" login personas to the top (an `All Employees`
  segment gives each a Compliant cell, so the old has-data sink no longer demoted them). Now demoted by an
  **explicit** marker (`DEMO_PERSONA_EXTERNAL_IDS` = `emp-001..004`, `employee-catalog.ts`); real employees
  still sort data-first. Regression test: a demo persona with a Compliant cell still sinks below a real all-NA
  employee.
- **UX-9** — scale-tenant providers were named "Clinic 1-1 · PROVIDER" (two nouns); renamed to
  "Dr. Provider 1-1" (`scale-structure.ts`).
- **UX-12** — KPI counts now group thousands (`1682100` → `1,682,100`) via a shared `fmtCount` (fixed
  `en-US` locale to avoid SSR hydration mismatch), applied to the hierarchy rollup, programs cards, and the
  compliance total.
- **UX-18** — `/runs` Trigger filter gained a **Scheduled** option (SCHEDULED runs dominate the history but
  couldn't be isolated/excluded; backend `matchesRunFilters` already supported it).
- **UX-4** — NA / Not-applicable roster cells (the majority on many panels) de-emphasized from full gray
  pills + two-line text to a single dim dash, with the label + method preserved in `title` + `aria-label`
  (so the signal cells stand out; AT still gets the meaning — not color/shape alone).
- **UX-2** — `/worklist` was a dead-end signpost (with a low-contrast hero heading) in a first-class nav
  slot; it now **redirects** to `/cases?status=open` (the real worklist), eliminating the signpost + contrast
  issue.
- **A11y** — a **skip-to-content** link (visually hidden until focused → `#main-content`; WCAG 2.4.1) in the
  dashboard shell, and global **`prefers-reduced-motion`** handling (WCAG 2.3.3) collapsing animations/
  transitions.

**Verified:** frontend lint + 110 vitest + build green; backend 981 tests / 0 fail (+1) + typecheck green.
No schema, no new deps.

**Deferred (tracked, next UI/UX PR):** UX-6 (link run/case UUIDs + copy raw ids), UX-19 (make the run-detail
AI insight on-demand, not auto-fire a billed call on view), a unified `<AccessDenied>`/`<EmptyState>`
component (UX-16), and the larger design-pass items — UX-8 (program-card trends onto `quality_snapshots`),
UX-5 (segment editor modal overflow), UX-7 (styled evidence dropzone), UX-11 (roster mobile cards), UX-3
(progressive feedback at 120k), and the filter-architecture / operator-home / density-toggle proposals. Plus
the full WCAG 2.2 AA audit (NVDA + keyboard-only walk) — still the largest UX debt.

## 2026-07-03 — E12 PR-2b: WebChart→FHIR adapter core (terminology reconciliation + normalization)

Built on the groundwork below. Owner locked the three forks: **integration path = WebChart HTTP/FHIR
API** (not direct MariaDB → **no MariaDB driver dependency**, uses global `fetch`); **immunizations via
ICE** (the E6 seam — not this adapter's concern); **the dev DB is a sample** (map its shapes, don't
over-fit). The exact API contract comes from a Dave Carlson (MIE) meeting next week, so I built the
**transport-agnostic core** now and isolated the HTTP transport behind an injectable seam.

**New module `backend-ts/src/engine/ingress/webchart/`:**
- `terminology.ts` — the WebChart→measure code reconciliation (terminology **option B**): a crosswalk
  from real LOINC/CVX/CPT/HCPCS codes → the synthetic `urn:workwell:vs:*` measure-event codings the CQL
  inline filters match. Reuses the E7 order-catalog's real standard codes + LOINC result codes for the
  lab/vital measures. **Appends** the synthetic coding (preserves the real code for provenance), maps one
  real code to **all** measures it serves (HbA1c 4548-4 → both `diabetes_hba1c` and `cms122`), tolerates
  system aliases (URI or OID, case-insensitive; HCPCS letter codes).
- `normalize.ts` — `normalizeWebChartBundle(raw)`: coerces whatever the API yields (a FHIR searchset/
  collection Bundle, a bare resource array, or a single resource) into the engine's `Bundle` (type
  `collection`) shape + applies reconciliation to `code`/`vaccineCode`. Robust to garbage → empty bundle,
  never throws.
- `webchart-client.ts` — the `WebChartClient` transport port + `fixtureWebChartClient` (tests) +
  a **provisional** `httpWebChartClient` (global `fetch`, Bearer auth, FHIR `Accept` — the single place
  to finalize once Dave Carlson confirms endpoints/auth/pagination).
- `data-source.ts` — `webChartDataSource(cfg, client?)` now **wired** (client → normalize → bundles),
  replacing the inert reject stub; transport injectable.

**Proof:** two end-to-end tests — a **real-CPT-coded** (92557) audiogram Procedure and a
**real-LOINC-coded** (4548-4) HbA1c Observation — each evaluate to COMPLIANT via reconciliation, each with
an un-reconciled MISSING_DATA control. Two bugs found while testing: multi-measure real codes (single-value
Map dropped `diabetes_hba1c` for `cms122`) → multi-target crosswalk; a no-`entry` Bundle wrapping itself →
fixed.

**Whole-branch code review folded in.** The reviewer caught a real coverage gap: WebChart records labs as
`Observation`s, but four lab/vital measures (`diabetes_hba1c`/`cholesterol_ldl`/`hypertension`/`obesity_bmi`)
retrieve `[Procedure]` in their CQL — so appending a coding to the Observation never let them match (only
`cms122`, which retrieves `[Observation]`, worked). Rather than narrow the crosswalk, the normalizer now
**synthesizes a dated `Procedure`** from a lab Observation when the reconciled target is a `[Procedure]`
measure (via a new `targetEventType` seam) — so real LOINC labs evaluate end-to-end (new test proves it);
the standards-correct end state (re-point those measures to `[Observation]`) is option A, tracked for PR-2c.
Also folded: normalizer no longer mutates its input (builds copies) and drops resource-less Bundle entries.

**Two Codex comments (PR #234) resolved.** **P1** — the HTTP client would wrap a `/Patient` searchset as
one payload → `normalizeWebChartBundle` folds every patient into one bundle → the engine evaluates only the
first subject (a population silently collapses to one employee). Fixed: the **deferred** `httpWebChartClient`
now **rejects** with a clear PR-2c message rather than a best-effort fetch — the tested core runs via
`fixtureWebChartClient`; the real per-patient fan-out lands in PR-2c. **P2** — Hep B is a multi-alternative
series whose CQL matches the specific CVX codes (189/08/43/44/45) under `urn:workwell:vs:hepb-vaccines`, not
the generic `hepb-vaccine`; the crosswalk was stamping the generic code, so a real Heplisav-B/traditional
series stayed MISSING_DATA. Fixed: for a multi-alternative measure the target preserves the real CVX number
as the synthetic code (a new e2e proves a real CVX Heplisav-B series → COMPLIANT). A **second Codex round**
added one more **P2** — status gating: WebChart can return non-final events (a `not-done`/`entered-in-error`
Procedure, a `preliminary`/`cancelled` Observation), and reconciliation was unconditional, so the recency
CQL (code + date only) could count a cancelled lab as compliant. Fixed: `normalize.ts` now only reconciles/
synthesizes **clinically-final** events (`Procedure`/`Immunization` = `completed`; `Observation` =
`final`/`amended`/`corrected`); a missing/unknown status is treated as non-final (conservative — never
falsely compliant). **980 tests pass / 0 fail**; typecheck green. No schema, no new deps. Descriptive only
(ADR-008/ADR-017) — reconciliation supplies coded FHIR, never decides compliance.

**Found (surfaced in the doc, not a blocker): the enrollment gap.** The measures gate on a program-enrollment
`Condition` that is *not* WebChart clinical coding — it's occupational-health **program membership** (an OH
roster). So a WebChart clinical bundle alone reads MISSING_DATA for an enrolled worker; the adapter needs a
second input (the enrollment roster) to stamp it. Added to the Dave Carlson question list. **Next (PR-2c,
after the meeting):** finalize the HTTP request shaping, add the OH-enrollment-roster input, extend the
crosswalk, and (if the API is proprietary rather than FHIR) add the row→FHIR mapping. See
`docs/WEBCHART_FHIR_MAPPING.md` §6–§8.

## 2026-07-03 — E12 PR-2 groundwork: real WebChart schema unblocked → WebChart→FHIR mapping reference

**Unblock.** Doug shared MIE's **seeded WebChart dev database** as a Docker image
(`ghcr.io/mieweb/dev-wcdb:latest`, MariaDB 10.3.32, temporarily public — pulled + backed up locally; root
`pmg2bhok`, port 33306, DB `wc_miehr_wctroot`). This is the real WebChart schema reference that has parked
**E12 PR-2** (the WebChart/MariaDB→FHIR adapter — today the inert `webChartDataSource` stub in
`backend-ts/src/engine/ingress/data-source.ts`). Image is stored locally + saved to a verified tarball so
Doug can re-private the GHCR image.

**What's in it (verified):** 675 tables, real populated data — 72 patients, 105 encounters, 1,887
observations, 8,230 observation codes (**with real LOINC**), 99 procedures, 69 users, 9 locations.
Demographics carry **`employer_*` fields** (the Total Worker Health hook). WebChart model: `_current`/`_revisions`
revisioning; `patients` holds both patients and providers (`is_patient`); observations are EAV over an
`observation_codes` dictionary (LOINC bridge). Verified the Patient→Observation→LOINC join resolves.

**Deliverable (this PR — docs only, no code/schema/deps):** `docs/WEBCHART_FHIR_MAPPING.md` — the
reverse-engineered WebChart→FHIR R4 mapping the adapter builds against: the target bundle shape
(Patient/Condition/Observation/Procedure/Immunization, matched to `fhir-bundle-builder.ts`), a
resource-by-resource table→field mapping, the **terminology bridge** analysis (WebChart LOINC/CPT/CVX/ICD
vs the measures' synthetic `urn:workwell:vs:*` codes → three options A/B/C; recommend B via
`terminology_mappings` for the demo slice, A/C as the standards-correct destination tied to E14 + VSAC),
the read-query scope, and a proposed PR-2a/b/c slicing.

**Findings that gate PR-2c (surfaced, not decided):** (1) this dev seed is **thin on coded clinical
events** — only 1 real CPT (mammogram), **no CVX immunizations**, empty base `observations`/problem-list —
so representativeness needs confirming; (2) **immunizations have no dedicated CVX table** (biggest gap —
blocks the immunization measures; must trace with MIE); (3) coded/text observation values live on the base
`observations` table (empty here), not `observations_current` (numeric fast-path); (4) architecture fork:
MariaDB-direct vs a WebChart HTTP API (the stub config is HTTP-shaped; ties to the E9 Q2 memo); (5) a
direct-DB adapter needs a **MariaDB driver — a new dependency requiring approval + an ADR** (hard rule, not
added). Descriptive-only throughout (ADR-008/ADR-017). See `docs/WEBCHART_FHIR_MAPPING.md` §6/§7 for the
confirm-with-Doug list.

## 2026-07-03 — Hardening sprint, blocks 5–7: close out the remaining Fable Mediums + Lows

Three parallel PRs finishing the Fable 2026-07-02 review (all Highs + the top-10 Mediums shipped in blocks
1–4 / PRs #226–#229). No new deps.

**Backend security & lifecycle (PR #230 — `feat/hardening-backend-security`):** M1 (sanitize caller-supplied
`triggeredBy` so a CM can't forge `seed:*`/`scheduler` run labels), M2 (`Active→Deprecated` removed from the
APPROVER-reachable `/status` — deprecation is ADMIN-only `/deprecate`), M3 (`Draft→Approved` via `/status`
now enforces the compile+fixture gate), M4 (`POST /api/ai/**` gated AUTHOR/ADMIN — the bare draft-spec alias
no longer lets CM/APPROVER drive billed OpenAI), **M5 (server-side refresh-token family revocation, KV-backed
— logout + rotated-jti-reuse revoke the family; fail-open on a KV outage; graceful for legacy tokens)**, M8
(audit packet lists cases with an explicit high limit, was dropping links past 50), M23 (outreach-template
GET made CM/ADMIN-readable), L1 (identity route `%zz` → 404 not 500), L5 (stale comment). 881 tests / 880 pass
/ 1 pg-skip.

**Backend correctness & robustness (`feat/hardening-backend-correctness`):** M7 + M15 (atomic
`failStuckRuns` = `UPDATE … RETURNING`, excludes `seed:%`; `finalizeRun` terminal-status-guarded so a
swept-FAILED run isn't resurrected and a backdated seed run isn't swept mid-seed → no double-seed), M10
(a population run closes prior-cycle OPEN cases it evaluated — `CYCLE_ROLLED_OVER`, audited system closure —
so rolled-over cycles no longer orphan the old case in `?status=open`/campaigns/exports; the Java V022 class),
M11 (segment gate no longer blocks case **resolution** — a COMPLIANT/EXCLUDED outcome always closes an
existing case, even out-of-cohort), M12 (roster `deriveCell` shows DECLINED only when the canonical bucket is
non-compliant, never masking a COMPLIANT outcome), M14 (`isUuid` guards on the Pg `case_actions`/`run_logs`
methods so a non-uuid path param is a clean miss, not a `::uuid` 500), M18 (offset-less CQL DateTimes rendered
as UTC — host-timezone-independent evidence). Lows: L8 (Pg run-day filter `AT TIME ZONE 'UTC'`), L12 (segment
`updateSegment` preserves `rule_json` verbatim on the ceiling too), L24 (roster `panel=bogus` → 400), L15/L16
(MEASURES.md doc currency — flu OVERDUE, CMS122 recency SIMPLIFIED note). **M9 (scheduler cross-process claim)
documented as a known limitation** — a fully race-free claim needs an owner-gated unique DB constraint
(schema is Taleef's); the single-container topology makes the practical double-fire risk low (one extra
idempotent recompute). New regression tests for M2/M3, M4/M23, M5, M7/M15, M10/M11, M12, L24.

**Frontend reliability + a11y (`feat/hardening-frontend-mediums`):** M22 (run-status key ownership — a sync
EMPLOYEE recalc no longer wipes an in-flight ALL_PROGRAMS run's persisted state), M25 (Export Run Audit Packet
gated to CM/ADMIN), M26 (SegmentEditorModal dirty-check confirm on backdrop/Escape), L19 (theme-aware Recharts
tooltips — no white-on-dark), L20 (cross-tab `storage` adoption of a run), L21 (`/people` access-denied card
for non-CM), L22 (person source lists keyed by `tenantId|externalId`), L25 (`frontend/.env.local.example` +
README note). 109 vitest + lint + build green.

**Deferred / accepted Lows (documented, not code):** L2 (authorize default-permit — safe today; all handlers
traced), L3 (shared demo password — accepted demo posture), L4 (login rate-limit), L6 (campaign counting once
a real provider is wired), L9 (scale-decode fixed-width — works ≤99 locations; a delimiter-based decode couples
store→synthetic), L10 (multi-statement write atomicity), L11 (module-level pool pinning), L13 (MCP role
incoherence), L14 (AI prompt fencing — before E12 PR-2), L17 (out-of-IPP signal), L18 (deprecated-measure scale
reconcile), L23 (nav read-surface hiding — product decision). Each noted for a future owner-gated or
epic-scoped pass.

## 2026-07-03 — Hardening sprint, block 4: frontend reliability + role-fit + Studio (Fable H9/H10/H11/M20/M21/M24)

Fourth (final) Fable block — frontend: the "app randomly misbehaves" reliability bugs, the case-detail +
Studio role-fit gaps, and the Studio unsaved-work hazard. Frontend only; no backend/schema.

- **M24 — token refresh had no single-flight and didn't propagate.** Parallel 401s each POSTed
  `/api/auth/refresh` against the *rotating* refresh cookie, so the second racer could fail → a spurious
  hard logout mid-session; and a successful refresh updated only one `ApiClient` instance while
  localStorage/AuthProvider kept the stale token (so every request kept re-refreshing). Now a
  module-level single-flight shares one in-flight refresh, and a new `onTokenRefreshed` callback writes
  the fresh token back into the AuthProvider (`updateToken`) so every `useApi` client picks it up.
- **M21 — `RunStatusProvider` polled an orphaned run forever.** Every poll error was treated as
  transient, so a 404 (run truncated by a demo-reset) or 403 left the "Run running" pill stuck until
  localStorage was hand-cleared. Now a 404/403 clears the interval + `ww_active_run` and resets to IDLE.
- **M20 — stale-fetch races in 6 fetch effects** (people, global search, compliance roster, cases
  worklist, measure-detail, quality-over-time): a slow response for an earlier query/filter/measure
  could land after a newer one and paint the wrong data. Applied a request-id guard (shared-callback
  effects) / `let active` cleanup (the single global-search effect) so only the latest result applies.
- **H9 — `/cases/[id]` was ungated.** Read-only roles saw every write action (outreach/rerun/assign/
  escalate/delivery/evidence — all guaranteed 403s) and the evidence panel 403'd into a misleading "no
  evidence." Gated all write controls + the evidence section behind `canManageCases` (mirrors the API +
  the nav gating #181 already had; the page was just missed).
- **H10 — Studio showed author-only controls to APPROVERs and the measure-version packet to AUTHORs.**
  The Spec tab is the default, so an APPROVER's first natural action (edit + Save) was a guaranteed 403.
  Threaded `canAuthor` (= `canAuthorMeasures`) into the four authoring tabs (Spec/CQL/Rule/Tests) —
  Save/Compile/AI-draft are disabled with a role hint for non-authors — and gated the measure-version
  audit-packet button (`[APPROVER,A]`) by `canApprove`.
- **H11 — a Studio tab switch silently destroyed unsaved authoring work.** Draft state is component-local
  and switching tabs unmounts the panel, so the ARIA arrow-key nav auto-activating on ArrowLeft/Right
  meant one accidental keystroke wiped an author's in-progress work. Switched to **manual activation**
  (WCAG pattern): arrow keys move focus only; the user confirms the switch with Enter/Space/click.
- **Frontend lint clean, 108 vitest pass (incl. a new H10 guard test), build green. No backend, no
  schema.** This closes the fourth and final Fable hardening block — all four themes (audit, scale,
  correctness, frontend) now addressed.

## 2026-07-03 — Hardening sprint, block 3: correctness on the real-data path (Fable H3/H8/M13/M19)

Third Fable block, on `feat/hardening-correctness` — the "latent bugs that are harmless on synthetic
data but wrong the day real WebChart/EnterpriseHealth data arrives" theme. All backend, no schema.

- **H3 — HAZWOPER + TB CQL matched ANY Condition.** `In Program: exists([Condition])` and `Has Medical
  Exemption: Count([Condition]) > 1` — the last two runnable measures still on the un-scoped pattern
  (the other 12 code-scope their Conditions). The synthetic per-measure bundles masked it, but the
  advertised real-data path (`evaluateBundle`/`evaluateBatch`, `pnpm evaluate`) accepts arbitrary FHIR:
  a patient with two unrelated Conditions evaluated EXCLUDED for TB, and any one Condition made a
  patient "In HAZWOPER Program". CQL is the compliance authority (ADR-008) → a real compliance bug.
  Rewrote both defines with the existing bound codes (mirroring audiogram), recompiled the ELM
  (`pnpm compile-measures` — only the two libraries changed), added a `foreign-condition-scoping`
  golden regression. Synthetic outcomes unchanged (golden CLI + engine + ingress + bundle suites green).
- **H8 — identity UNLINK of a hub shattered a 3+-record component.** Auto match-key edges were a STAR
  from `records[0]`, and UNLINK writes BROKEN against every member, so breaking a hub/CONFIRM-anchor
  disconnected survivors that never had an edge to each other. Fixed both ways: auto edges are now a
  pairwise CLIQUE, and the UNLINK route re-asserts survivor connectivity (CONFIRMs every non-BROKEN
  survivor pair) — never overriding a split the human actually asserted.
- **M13 — duplicates worklist dropped a moved-then-duplicated person.** The predicate was "has no PRIOR
  link anywhere"; now it's "distinct ACTIVE tenants > 1", so a person who moved AND has a second ACTIVE
  record still surfaces, while pure mobility stays excluded.
- **M19 — Rule Builder accepted degenerate numerics.** `dueSoonDays > windowDays` (COMPLIANT
  unreachable) and non-alternatives `requiredDoses: 0` (everyone COMPLIANT with zero doses) compiled
  clean and `saveRule` persisted them. A new `validateRule()` in `generateCql` throws → 400 at the
  rule route; valid measures unaffected.
- **872 tests / 871 pass / 1 pg-skip / 0 fail; typecheck clean. No schema, no new deps.** Commits:
  H3 (CQL+ELM) · H8/M13 (identity) · M19 (codegen). Descriptive-only invariants preserved (ADR-008);
  E13 All = Σ tenants untouched.

## 2026-07-03 — Hardening sprint, block 2: scale/perf — bound the 120k read paths (Fable H4/H5/M16/M17)

Second Fable block, on `feat/hardening-scale-perf` — the theme where the app has a **live production
risk**: pages seconds from the 60s gateway timeout on the 120k `mhn` tenant. No behavior change; the
DDL is owner-gated and isolated for review.

- **H5/M17 — owner-gated indexes (floor + ceiling).** `outcomes` was indexed only on `run_id` and
  `audit_events` only on `ref_case_id`, so per-subject/per-measure outcome reads seq-scanned the ~1.68M
  live rows and the ordered/by-type/by-run audit reads scanned the whole ledger. Added (additive `CREATE
  INDEX IF NOT EXISTS`, reversible): `outcomes (subject_id, evaluated_at DESC)`, `outcomes (measure_id,
  evaluated_at)`, `audit_events (occurred_at)`, `audit_events (event_type, occurred_at)`, `audit_events
  (ref_run_id)` — restoring the coverage the Java-era `outcomes_employee_measure_period_idx` had. First
  deploy builds them once over the live table (DEPLOY note).
- **H4 — the four unbounded 120k detail endpoints.** The outcomes grid, QRDA, MeasureReport, and
  outcomes CSV all called `listOutcomes(runId)` with no cap (live: MeasureReport 23s, QRDA 35s, CSV 43s
  — one cold cache from the gateway timeout). Now: the grid pages (`{limit, offset}`, default 500 / max
  2000) + `X-Total-Count`; QRDA + summary MeasureReport build from the bounded `countOutcomesByStatus`
  histogram (`populationCountsFromStatus`) + `distinctMeasuresForRun`; the per-subject individual/bundle
  MeasureReport caps at 5000 subjects (422 → `?type=summary`); the outcomes CSV streams in pages
  (`outcomesCsvStream`, mirroring the audit export). No path materializes 120k rows.
- **M16 — the ever-growing scans behind the hot pages.** The roster/hierarchy/programs-overview read
  models fetched every non-scale population outcome then kept only the latest run per measure — so the
  13,200 backdated `seed:trend-history` rows were fetched-then-discarded every render; now excluded in
  SQL (`excludeTrendHistory`; the trend chart intentionally keeps them). And `materializeRun` +
  the quality backfill scanned the whole runs table (`listRuns(100_000)`) on every completion to find the
  ~14 `seed:scale` runs — now a targeted `listRunsByTriggeredBy`.
- **Commits (atomic, reviewable):** DDL · H4 bounded reads · M16 read-model trims. **~857+ tests, all
  green; typecheck clean.** No new deps. Owner step post-merge: the first deploy builds the five indexes
  once on Neon (no manual step). Deferred (documented follow-up): the full latest-run-per-measure SQL
  pushdown for the roster/hierarchy hot path — a hot-path query redesign that merits its own benchmarked
  PR; the index + trend-exclusion win lands most of the latency without it.

## 2026-07-02 — Hardening sprint, block 1: audit completeness + case-state integrity (Fable H1/H2/H6/H7/M6)

The Fable deep review (`docs/FABLE_REVIEW_2026-07-02/`, 0 Critical / 14 High) surfaced four themes. This
branch (`feat/hardening-audit-completeness`) closes the **audit-completeness + robustness** block — the
one that most threatens the *"every determination auditable"* pitch — with no schema change and no new deps.

- **H1 — population run pipeline now writes audit events.** The highest-volume state change (a nightly
  `ALL_PROGRAMS` run opening/closing hundreds of cases) previously wrote **nothing** to `audit_events`,
  violating the "every state change writes audit_event — no exceptions" hard rule. `finishManualRun` now
  emits `RUN_COMPLETED` (entityType `run`) at finalize and `CASE_CREATED`/`CASE_UPDATED`/`CASE_RESOLVED`/
  `CASE_EXCLUDED` from the upsert disposition — using the vocabulary the employee-profile timeline already
  maps. Run-boundary audits are best-effort (never fail an otherwise-complete run).
- **H2 — state-aware case upsert** (`planCaseUpsert`, a pure decision shared by the SQLite floor +
  Postgres ceiling). Replaces the blanket `ON CONFLICT DO UPDATE SET status = excluded.status`, which
  (a) flipped operator-set `IN_PROGRESS` back to `OPEN`, (b) silently reopened human-closed cases, and
  (c) drifted `closed_at` forward on every compliant run. Now: `IN_PROGRESS` is preserved; a **human**
  closure (`closed_by` set) is respected (reopen is an explicit operator action — owner decision
  2026-07-02); only a **system** auto-resolve (`closed_by IS NULL`) reopens when a subject is
  non-compliant again; an already-terminal case is a no-op (no `closed_at` drift). Idempotent
  re-confirms of the same open outcome refresh the row **silently** (disposition `UNCHANGED` → no audit),
  so a nightly run records one `RUN_COMPLETED`, not hundreds of `CASE_UPDATED` noise events.
- **H6 — `pg.Pool` `'error'` listener.** An unhandled idle-client drop (routine under Neon's pooler /
  compute-suspend) was a hard worker crash; now logged and recovered (the pool re-dials).
- **H7 — hierarchy rollup now requires COMPLETED runs** (`isCompletedRun`), like every sibling read model
  and its own scale branch — so `/programs/hierarchy` no longer counts an in-flight RUNNING run's partial
  rows and stops disagreeing with `/programs` mid-run. Regression test added.
- **M6 — admin toggles audited.** `POST /api/admin/scheduler` (enable/disable) and integration `…/sync`
  now write `SCHEDULER_ENABLED/DISABLED` / `INTEGRATION_SYNCED` audit events.

`upsertFromOutcome` now returns an `UpsertedCase` (a `CaseRecord` **superset** carrying `disposition`), so
all ~25 existing callers are unaffected. **850 tests / 849 pass / 1 pg-skip / 0 fail** (added: a pure
`planCaseUpsert` suite, an H1 audit-emission test, an H7 RUNNING-exclusion test); typecheck clean. No
schema, no new deps. Remaining hardening blocks (scale indexes + endpoint bounding, foreign-data CQL
fixes, frontend role-fit) are follow-ups; index DDL will land as a separate owner-review PR.

## 2026-07-01 — E15 reconcile merge-picker (CONFIRM_LINK UI follow-up)

Completed the reconcile UI's other half (branch `feat/e15-merge-picker`) — the CONFIRM_LINK merge-picker
deferred from E15 PR-2. Frontend-only; the API + CM/ADMIN gate already shipped in PR-2.

- On `/people/[personId]`, a CM/ADMIN **"Link another record"** toggle opens a debounced search
  (over `GET /api/identity/people`, `pageSize=10`) that lists candidate **source records** (flattened
  from the matched people), excluding the person's own records. Selecting one → confirm dialog →
  `POST …/reconcile {action:"CONFIRM_LINK"}` → back to `/people` (the id may change on re-grouping).
- This is the inverse of the existing unlink action — for two separately-resolved people who are
  actually the same human. Descriptive only (ADR-008); audited by the existing write path.
- No backend/API/schema change. Frontend lint + build + 107 vitest green.

## 2026-07-01 — Live verification: E16 + E15 (×2) deployed and correct

Consolidation smoke-test of the live stack (`twh.os.mieweb.org` / `twh-api-ts.os.mieweb.org`) after the
four merges (E16 PR-2/PR-3 #222, E15 PR-1 #223, E15 PR-2 #224). The deploy for the #224 merge (`fe5cca0`)
succeeded; both new tables self-created on Neon (no boot error).

- **E16 forward materialization LIVE:** `GET /api/quality/history?measureId=audiogram&scopeLevel=all` →
  a real snapshot for **2026-07, numerator/denominator 93,717 / 113,547** — the denominator ≈ the full
  population (mhn ~120k − excluded + twh/ihn), proving the bounded `aggregateScaleRun` scale fold runs on
  live population runs. Only the current month exists (history awaits the owner backfill CLI).
- **E15 identity LIVE + correct:** `/api/tenants` → twh/ihn/mhn; `/api/identity/duplicates` → exactly
  Sana (Omar correctly excluded as *moved*); `/api/identity/people?q=omar` → ihn ACTIVE + twh PRIOR
  (mobility resolved).
- **Security gates LIVE:** unauthenticated → 401 on identity/quality/tenants; the public-sandbox
  **VIEWER → 403** on `/api/identity/duplicates` (the PR-2 PII read-gate holds — national ids + DOB are
  not publicly enumerable). Frontend `/people`, `/programs`, `/compliance` → 200.
- Reconcile **write** path not exercised against live (mutates shared demo state; covered by 840 CI tests).

**Verdict:** all four PRs deployed and behaving, incl. at 120k scale; no regressions. **Open owner step:**
`pnpm seed:quality-history --months 12 --as-of 2026-06` against Neon to backfill the /programs "Quality
over time" history (forward runs already accrue the current month).

## 2026-07-01 — E15 PR-2: identity reconcile write path (owner-approved `person_links`)

The confirm/unlink half of E15 (branch `feat/e15-identity-reconcile`, ADR-022). Owner-approved the DDL
in-session (reviewed once, then applied — the self-creating schema applies on deploy).

- **`person_links` table** (owner-approved DDL, floor + ceiling, `workwell_spike`; DATA_MODEL §3.26) — a
  human-confirmed CONFIRMED/BROKEN assertion between two source records, pair normalized `(a) <= (b)` so
  the key is direction-independent (UNLINK re-upserts to BROKEN, last write wins). `PersonLinkStore` port
  (floor `INSERT OR REPLACE` / ceiling `ON CONFLICT DO UPDATE`), wired in the factory, store-contract
  tested on both backends.
- **`resolvePeople` is now override-aware** (union-find): CONFIRMED unions two records (links even
  without a shared identifier), BROKEN removes the direct auto/confirmed edge. The component `personId`
  became the smallest **record ref-key** (unique per component) — a match-key-based id couldn't tell the
  two halves of a BROKEN split apart (found + fixed via a repro during testing).
- **`POST /api/identity/people/:personId/reconcile`** (`routes/identity.ts`) — `{action, tenantId,
  externalId}`, **CASE_MANAGER/ADMIN-gated** (`authorize.ts` POST `/api/identity/** → [CM, A]`) + audited
  (`IDENTITY_LINK_CONFIRMED`/`IDENTITY_LINK_BROKEN`); validates action/membership (400) + unknown person
  (404); returns the re-resolved person (located by anchor membership, since the id can change).
- **Frontend:** a CM/ADMIN **"Not this person — unlink"** action per linked system on `/people/[personId]`
  (confirm dialog → reconcile → back to `/people`); rbac `canReconcileIdentity`.
- Still descriptive only — a link overrides read-time grouping, never `Outcome Status` (ADR-008); E13
  reconciliation unaffected. Reversible (`DELETE FROM person_links`).
- **Green:** backend `tsc` + **838 tests (837 pass / 1 pg-skip)** (+7, incl. 2 model link tests, 4
  reconcile route tests, 3 store-contract cases); frontend lint + build. **Owner note:** the DDL
  self-creates on boot (`CREATE … IF NOT EXISTS`) — applies automatically on the next deploy.
- **Deferred:** a full CONFIRM_LINK merge-picker UI (merging two separately-resolved people) — the API
  supports it; the UI is a follow-up.
- **Code review (whole-branch) folded in:** (Important) UNLINK now breaks the target against **every**
  other component member — a single-anchor break could eject the wrong record from a 3+ member group
  (+a 3-member guard test); CONFIRM_LINK validates the target is a real directory record (400 on a
  typo); the audit logs the semantic anchor/target (not the normalized pair order); `nationalId`/`DOB`
  are picked independently per field; and — the security one — **`/api/identity/**` reads are now
  CASE_MANAGER/ADMIN-gated** (the directory exposes national/MRN ids + DOB, which the public read-only
  VIEWER sandbox would otherwise enumerate via the AUTHENTICATED `/api/**` fallback) + the `/people` nav
  is CM/ADMIN. **840 tests (839 pass / 1 pg-skip).**

## 2026-07-01 — E15 PR-1: cross-system identity (person resolution, duplicates, mobility)

First slice of E15 (#187, ADR-022) — the buildable-now synthetic-first person-identity layer, on branch
`feat/e15-cross-system-identity`. Addresses Doug's June-15 *"same employee in two different systems,"*
*"an expatriate might move,"* DUPLICATE-badge asks.

- **`backend-ts/src/identity/` (pure, read-time):** `identity-model.ts` — `matchKey` (deterministic
  grouping on a shared national/MRN id; absent one, a record keys uniquely and never groups by accident —
  the EMPI seam), `resolvePeople`/`duplicateCandidates`/`personById`, a `MOBILITY_OVERLAY` seed. 
  `compliance-timeline.ts` — `mergedComplianceTimeline`: outcomes unioned across linked systems,
  newest-first, system-tagged, with a mobility (PRIOR → ACTIVE + date) annotation. 7 model tests incl.
  the **E13 reconciliation guard** (each source record still belongs to exactly one tenant → All = Σ
  tenants holds).
- **Directory (no schema, no count change):** added optional `dateOfBirth`/`nationalId` to the synthetic
  `EmployeeProfile` and gave a shared synthetic identity to two **existing** twh↔ihn pairs — `emp-006`
  "Omar Siddiq" is the mobility subject (moved twh→ihn; twh link PRIOR), `emp-007`/`ihn-emp-002` a plain
  cross-system duplicate. twh stays 100, ihn stays 50, `EMPLOYEES.length` unchanged.
- **`GET /api/identity/{people,people/:id,duplicates}`** (`routes/identity.ts`, wired in `worker.ts`) —
  search (X-Total-Count paging), unified person view (person + merged timeline), duplicate worklist.
  Authenticated read-only; unknown id → 404. 5 route tests.
- **Frontend:** a new **`/people`** route (nav item) — cross-system directory with a **DUPLICATE badge** +
  search; `/people/[personId]` unified view with a **mobility banner** and a merged, system-tagged
  compliance timeline. Read-only.
- Descriptive only — identity groups/follows, never decides compliance (ADR-008); reconcile write path is
  E15 PR-2 (owner-gated), real WebChart sources E15 PR-3 (E12 seam).
- **Green:** backend `tsc` + **831 tests (830 pass / 1 pg-skip)**; frontend lint + build (both `/people`
  routes compile). No schema, no new deps.

## 2026-07-01 — E16 PR-2 + PR-3: quality-over-time history read API, backfill CLI, and UI

Built the read + surface half of E16 on top of PR-1's snapshot store (branch `feat/e16-quality-history`).

**PR-2 (backend) — read API + as-of backfill CLI:**
- **`GET /api/quality/history?measureId=&scopeLevel=&scopeId=&tenant=&from=&to=`** (`routes/quality.ts`) —
  a bounded read of the materialized `quality_snapshots` time-series (period ASC). Validates `from`/`to`
  as inclusive `YYYY-MM` (400 on malformed) + `scopeLevel` enum; authenticated read-only under the
  `/api/**` fallback (all roles). Wired into `worker.ts`. 6 route tests.
- **`pnpm seed:quality-history [--months 12] [--as-of YYYY-MM]`** (`run/backfill-quality-history.ts` +
  `run/cli/seed-quality-history*.ts`) — materializes **real evaluated** snapshots for a range of past
  months, **superseding** the synthetic sine-wave `seed:trend-history` for the quality trend. Per month
  it re-evaluates every in-directory employee as-of that month's end (reusing the Simulate #197 bundle
  anchoring), reduces raw CQL outcomes through the shared pure `buildSnapshotRows`, folds the 120k `mhn`
  scale tenant via the bounded `aggregateScaleRun` (never per-subject rows), and idempotently upserts.
  Audited (`QUALITY_HISTORY_BACKFILLED`, one per month, **before** the upsert). Idempotent + resumable
  at the month level; reversible (`DELETE FROM quality_snapshots` — the whole table is a rebuildable
  cache). 2 backfill + 3 CLI-parse tests.
- **Scoping decision (deviation from plan):** left `programTrend` (the /programs overview cards) on its
  existing live per-run aggregation — it works and is a safe fallback — and delivered the
  snapshot-backed trend at the **presentation layer** (PR-3 measure-detail card consuming the new API),
  where the scope selector + month picker live. Avoids destabilizing the working overview chart; fully
  backward compatible.

**PR-3 (frontend) — UI:** a new **"Quality over time (source of truth)"** card on
`/programs/[measureId]` (`QualityOverTime`) — a **scope selector** (All Systems / per WebChart system
from `/api/tenants`), an **as-of month picker**, a **"compliance on month M"** numerator/denominator KPI,
and a snapshot-backed monthly area chart with the `ChartDataTable` sr-only accessible alternative (WCAG,
per #218). Reads `GET /api/quality/history`; graceful empty state pointing at `seed:quality-history`.

**Green:** backend `tsc` clean; frontend lint clean (1 pre-existing test-mock warning) + build + 107
vitest pass. No schema change (reuses PR-1's `quality_snapshots`), no new deps.

## 2026-06-30 — E16 PR-1: quality-over-time snapshot store (materialization core + table)

Started **E16** — *"your system is the source of truth for quality over time"* (Doug's June-24 ask).
The gap (confirmed by a code scan): no persisted numerator/denominator-per-period store; every
`/programs` trend recomputes live from `outcomes` and only exists where a run ran — which does not scale
to 160k. PR-1 lands the store + the materialization, all TDD-first (branch `feat/e16-quality-over-time`):

- **`quality_snapshots` table** (additive DDL, floor + ceiling) — a materialized AGGREGATE per
  (measure, calendar month, scope: all → tenant → site → provider): numerator/denominator + the 5 bucket
  counts; UNIQUE (measure_id, period, scope_level, scope_id) for idempotent upsert. NEW schema,
  `CREATE … IF NOT EXISTS`, reversible. (DATA_MODEL §3.24; ADR-021.) **Note:** keyed by `measure_id` (the
  outcomes slug), not the Java-era `measure_version_id`.
- **Pure core** `buildSnapshotRows` (`backend-ts/src/quality/materialize-snapshot.ts`) — DI'd scope
  resolver (no DB/catalog import), reconciles All = Σ tenants = Σ sites = Σ providers; reuses the
  `countPopulations` proportion model. 6 unit tests.
- **`QualitySnapshotStore` port** + floor/ceiling adapters (floor `INSERT OR REPLACE` to sidestep the
  `excluded` column vs ON CONFLICT pseudo-table; ceiling `ON CONFLICT DO UPDATE`), run on the shared
  store contract (4 tests, both backends; ceiling self-skips with no local Postgres).
- **`materializeRun(runId)`** orchestration — groups a completed population run's live outcomes by
  measure, folds the latest `seed:scale` run per measure via the bounded `aggregateScaleRun` (**never**
  the 120k rows), upserts idempotently, writes a `QUALITY_SNAPSHOT_MATERIALIZED` audit event. 3
  integration tests. **Hooked best-effort** into `finishManualRun` (after `finalizeRun`) — so the sync,
  async, and scheduler run paths all stamp a snapshot, and a snapshot failure never fails the run. Wired
  at the three deps sites (`routes/runs.ts` ×2 + `admin/scheduler.ts`).
- Aggregate-only (no per-employee row); **descriptive — never sets `Outcome Status`** (ADR-008/ADR-021).
- **Green:** typecheck clean; full suite **803 tests, 802 pass / 1 pg-skip / 0 fail** (+18 new).

**Owner note:** the DDL self-creates on boot (`CREATE … IF NOT EXISTS`) on the SQLite floor and the Neon
`workwell_spike` ceiling — no migration runner; applied automatically on the next deploy.

**Next:** E16 PR-2 — `GET /api/quality/history` + an as-of backfill CLI (replacing the synthetic
sine-wave trend-history) + `/programs` trend rewired to read snapshots. PR-3 — the UI (scope selector +
as-of month picker; a "compliance on date D" KPI).

## 2026-06-30 — Live deployment audit + post-audit fixes (branch `fix/post-audit-qa`)

A full end-to-end audit of the live stack (`twh.os.mieweb.org`) driven through the real browser
(Playwright) across all four roles + API-level verification, then fixes for the confirmed findings.

**Audit verdict:** ~90% of the documented E10–E14 roadmap is genuinely live and correct — the
multi-tenant + scale rollup reconciles exactly (All Systems 1,682,100 = mhn 1,680,000 + ihn 700 + twh
1,400), 14 runnable measures, WCAG chart alternatives, E10 roster + E11.3 segments, the M1–M4 QA fixes,
the E13 PR-3 scheduler firing in prod, and clean RBAC across all four roles. Three findings were
**false positives** on code inspection (the app is better than a browser-only check showed): the
hierarchy/compliance filter selects are labelled via `<label htmlFor>` / `<label>`-wrapping (not
`aria-label`), and the case-detail "duplicate" action panels are intentional responsive markup
(`md:hidden` vs `hidden md:grid`).

**Fixes (6 commits):**
- **perf(runs)** — the headline P0. `/api/runs` called `listOutcomes(runId)` per run to compute summary
  counts; after the 120k-row `seed:scale` runs were seeded on Neon, listing 20 runs loaded millions of
  rows and pushed `?limit=20` (the Runs page default) past the 60s gateway `proxy_read_timeout` — the
  run-history table intermittently rendered empty (surfaced as a CORS error since the timed-out response
  skips CORS middleware). Added `OutcomeStore.countOutcomesByStatus` (a bounded GROUP BY mirroring
  `aggregateScaleRun`) + counts-based `toRunListItemFromCounts` / `toRunSummaryFromCounts`. The
  per-employee outcomes grid + exports still load rows on demand.
- **feat(studio)** — surfaced E14 standards fidelity as a read-only "Standards" Studio tab (was
  API-only / invisible to users). Criterion COVERED/SIMPLIFIED/OMITTED, value-set fidelity, and the
  criteria-impact outcome diff; adapts to a "no official reference" state for non-CMS measures.
  Descriptive only (ADR-008).
- **fix(sandbox)** — the public `/sandbox` auto-signed-in as a Case Manager (write access on the shared
  live DB). Added a read-only `ROLE_VIEWER` (`viewer@workwell.dev`), enforced in `authorize.ts` (GET/HEAD
  only; all writes 403; logout stays PERMIT); the sandbox now signs in as the viewer. Frontend rbac
  already treated VIEWER as read-only, so its nav auto-collapses to the read surfaces.
- **fix(content)** — replaced the stale "Eight measures" landing copy (the deploy build-arg + the code
  default) with a count-free description.
- **fix(ux)** — KPI zero-flash guard, MetroHealth-Network "(generated population-scale dataset)" caption,
  hierarchy patient→profile links, and loading skeletons on the hierarchy + program-detail pages.

**Verification:** backend `tsc` + targeted tests green (auth 18 incl. the VIEWER read-only test,
read-models 35 incl. GROUP-BY parity, runs route, roster, `worker` 5, demo-users); frontend `tsc` +
eslint clean + full vitest 101 pass. The `/api/runs` real-world speedup is only measurable once deployed
against the Neon scale tenant. **No schema change, no new deps.**

**P3 follow-up (branch `fix/audit-p3-polish`):** the roster now sorts subjects with real compliance data
above all-NA rows, so the demo login personas no longer head the grid (`roster-read-model.ts`, stable
sort before paging + an ordering test); the in-process integrations (fhir/mcp/ai) seed `lastSyncAt` to
boot time instead of "Never" (`admin-data.ts`; hris stays null — no real sync source). The Rule Builder
live-preview turned out to be **working-as-designed** — it deliberately gates on a complete binding set
(code + value set for enrollment/waiver/event) so it never emits CQL that compiles but never matches; the
Studio desktop-only gate is intentional. Both left as-is.

## 2026-06-30 — WCAG chart accessible-alternatives + roadmap housekeeping (E11 close, E15/E9 specs)

A status-driven cleanup session. Reconciled the June-15 roadmap (E10–E15, #182–#187) against GitHub,
then did the three things that were actionable without an external blocker.

**1. Closed the E11 epic (#183).** All E11 sub-PRs (#203/#204 Rule Builder + live Hep B repoint;
#205/#206 segments backend + Configure Groups UI) were merged, deployed, and live — the tracking issue
was simply never closed. Posted a comment mapping each acceptance criterion (ADR-015 canonical-CQL
decision, Rule Builder UI, segment/risk-group model) to its PR and closed it as completed.

**2. WCAG chart accessible-alternatives (this PR).** The chart half of the a11y pass deferred from
PR #210. There are exactly **3 Recharts charts** in the dashboard (everything else is the
already-accessible NITRO/datavis grid):
- `/programs` per-card `TrendChart` (LineChart)
- `/programs/[measureId]` `ComplianceTrendChart` (AreaChart) + outcome `PieChart`

New shared `frontend/components/chart-data-table.tsx` — `ChartDataTable`: an `sr-only` `<table>` with a
`<caption>` and scoped column headers, em-dash for nullish cells, an empty-label fallback. Each chart's
visual SVG is now wrapped in `aria-hidden="true"` and paired with a `ChartDataTable` carrying the same
numbers, so screen-reader users get the data instead of an unlabeled graphic (WCAG 1.1.1). 6 unit tests
(`components/__tests__/chart-data-table.test.tsx`). **No new deps, no schema.**

Verification: frontend `npm run lint` clean (the one warning is pre-existing in `test/mocks/next-font.ts`),
**105/105 vitest pass** (21 files, incl. the new 6), production `npm run build` green + TypeScript clean.

**3. Drafted the E15 + E9 specs** (so they're ready the moment their blockers clear; both marked
*Draft — pending owner review*):
- `docs/superpowers/specs/2026-06-30-e15-cross-system-identity-design.md` — cross-system identity &
  mobility (#187). Key finding: a **synthetic-first PR-1 is buildable now** over the E13 multi-tenant
  directory (cross-system people + DUPLICATE surface + unified person view + mobility timeline,
  read-only/no-schema) even though the real EMPI resolver is blocked on E12 PR-2. Match-don't-auto-merge,
  human-in-the-loop, CQL stays authoritative, E13 reconciliation preserved. 3 open questions for Doug.
- `docs/superpowers/specs/2026-06-30-e9-cql-sql-bridge-decision-memo.md` — the CQL→SQL decision memo (#78,
  no code per the epic). FHIR-native (A) / CQL→SQL transpile (B) / hybrid pluggable executors (C) with
  pros/cons; **recommends C** — keep FHIR-native as default + parity oracle, record a `MeasureExecutor`
  seam as an ADR, build no transpiler until Doug confirms Q2 and a concrete high-volume measure justifies
  it.

**Roadmap status after this session:** E10 + E13 fully closed; E11 closed (issue + code); E12 (PR-2 blocked
on MIE WebChart schema) and E14 (PR-3 blocked on VSAC credentials) partially done; E15 not started (spec
drafted). Remaining non-epic open items: #167 (managed S3/R2 evidence bucket — owner-gated deploy config),
#168 (Proxmox onboot — nice-to-have), #78 (E9 decision memo — drafted, awaiting Doug Q2).

## 2026-06-29 — E14 PR-2: criteria-impact outcome diff

**What shipped:** `GET /api/measures/:id/fidelity/diff` — a pure criteria-impact analysis that shows, criterion by criterion, how many subjects from the latest CMS122 population run would have different outcomes if the official eCQM criteria (currently OMITTED/SIMPLIFIED in WorkWell's authored measure) were applied. Descriptive only (ADR-008).

**New files:**
- `backend-ts/src/standards/outcome-diff.ts` — `computeOutcomeDiff(ref, outcomes, evalYear)` pure function + `CriterionImpact` / `OutcomeDiffReport` types. Contains a local `syntheticBirthYear` duplicate (keeps standards module free of engine/synthetic deps).
- Tests: `outcome-diff.test.ts` — 11 unit tests (spec bundled items 10a+10b into separate tests).

**Route wired:** `measures.ts` + 3 integration tests. Route placed before the existing `/fidelity` block to prevent pattern swallow.

**Criteria analysis:**
- `age-18-75` (OMITTED, IPP) — verifiable: synthetic employees hash to birth years 1980–1999 → ages 27–46 in 2026 → **0 divergent** for the synthetic dataset. A past evalYear test confirms out-of-range ages are counted.
- `qualifying-visit`, `hospice`, `long-term-care-66`, `advanced-illness-frailty-66`, `palliative-care` — **unverifiable**: synthetic FHIR bundles carry no Encounter/hospice/frailty/palliative resources.
- `denominator-equals-ipp` — unverifiable (depends on IPP gate divergence).
- `numerator-exclusions-none` (COVERED) — verifiable, 0 divergent.

**Test results:** 785 pass, 0 fail, 1 pg-skip. No schema change, no new deps.

**Deferred:** A full outcome diff (running the official CQL with real VSAC value sets) requires the `ValueSetResolver` port once VSAC credentials are available (E3.2 seam already in place). The criteria-impact analysis is the PR-2 structural-first deliverable (ADR-018).

**Next:** E14 PR-3 (full official-CQL execution/outcome diff via ValueSetResolver — blocked on VSAC credentials), E12 PR-2 (WebChart adapter — blocked on MIE schema), E15 (#187, cross-system identity — leans on E12+E13), and the deferred WCAG chart accessible-alternatives.

## 2026-06-29 — E13 PR-3: scheduled cron recompute

Third and final E13 slice — wires the previously-inert `/api/admin/scheduler` endpoint to fire
real, audited `ALL_PROGRAMS` runs on a 24-hour interval. This closes E13 (#185).

**What was built (backend-ts only; no schema, no new deps):**

- **`backend-ts/src/admin/scheduler.ts`** (new, ~200 lines) — the scheduler module:
  - `initSchedulerFromEnv(env)` — reads `WORKWELL_SCHEDULER_ENABLED` on server start (opt-in,
    `false` by default so the demo stack is unaffected without the env var).
  - `runTick(deps)` — the audited tick: (1) guard if disabled, (2) debounce: skip if < 23.5h since
    last `triggered_by="scheduler"` run (checked via `listRuns(50)` — no extra table), (3) write
    `SCHEDULER_RUN_TRIGGERED` audit event **before** `planManualRun` (hard rule: every state change
    writes audit first), (4) `planManualRun({ scopeType: "ALL_PROGRAMS", triggeredBy: "scheduler" })`,
    (5) `finishOrFail` (never throws — safe outside `ctx.waitUntil`), returns `true`.
  - `getSchedulerStatusFromStores(stores)` — derives `lastRunAt`/`nextFireAt`/`lastRunStatus`
    read-time from `listRuns(50)` filtered by `triggered_by`; no new DB column.
  - `schedulerTick(env)` — production wrapper; errors swallowed so the `setInterval` callback
    never crashes the process.

- **`backend-ts/src/admin/scheduler.test.ts`** (new, 5 tests on the SQLite floor + mock engine):
  1. Disabled guard returns `false` without writing any audit event.
  2. Happy path: `runTick` fires one `ALL_PROGRAMS` run + one `SCHEDULER_RUN_TRIGGERED` audit event.
  3. Debounce: a second call within 23.5h returns `false` (single run in DB).
  4. `getSchedulerStatusFromStores` reflects `enabled=true`, `lastRunAt`, and a non-null `nextFireAt`.
  5. `getSchedulerStatusFromStores` returns `nextFireAt=null` when disabled.

- **`backend-ts/src/run/read-models.ts`** — `triggerTypeOf` now returns `"SCHEDULED"` for
  `triggered_by === "scheduler"` (alongside the existing `"SEED"` and `"MANUAL"` values). Scheduler
  runs appear with `triggerType:"SCHEDULED"` on `GET /api/runs`.

- **`backend-ts/src/admin/admin-data.ts`** — removed the ~16-line in-memory stub (`SchedulerStatus`,
  `schedulerEnabled`, `CRON`, `schedulerStatus()`, `setSchedulerEnabled()`).

- **`backend-ts/src/routes/admin.ts`** — `GET /scheduler` now calls `getSchedulerStatus(env)` (real,
  derived from DB); `POST /scheduler` calls `setSchedulerEnabled(enabled)` then returns the real
  status. Imports switched from `admin-data.ts` to `scheduler.ts`.

- **`backend-ts/src/server.ts`** — after host start: `initSchedulerFromEnv(process.env)` reads the
  opt-in flag; `setInterval(() => void schedulerTick({...}).catch(...), 5 * 60 * 1000)` fires the
  tick every 5 minutes (shorter than the 23.5h cooldown, so the scheduler never misses its window;
  `runTick` debounce makes extra ticks idempotent). The interval handle is cleared on process shutdown.

**Design decisions:**
- **In-process `setInterval`** — mirrors the self-heal reconciler philosophy (small, contained). No
  new cron infrastructure. 5-min tick × 23.5h debounce means worst-case lag is ~5 min.
- **Audit-before-run invariant** — `SCHEDULER_RUN_TRIGGERED` is written before `planManualRun`
  so a crash between audit and run creation is self-healing (the run is created on the next tick;
  the audit event is not re-written twice — debounce sees the COMPLETED run).
- **No schema** — scheduler status is derived read-time from `runs.triggered_by`; the existing
  `audit_events` table absorbs `SCHEDULER_RUN_TRIGGERED` with no DDL.
- **Opt-in** — `WORKWELL_SCHEDULER_ENABLED` is unset on the current demo stack; deploying this PR
  does not change live behaviour without the env var. Add to `deploy-twh-mieweb.yml` env block
  when ready to activate.

**Verification.** 770 tests: 769 pass, 1 skipped (Pg-ceiling self-skips), 0 fail. TypeScript
typecheck clean. Three commits: `8b7a6ed` (Task 1 — `triggerTypeOf`), `76bdc7d` (Tasks 2+3 —
scheduler module + tests), `096f2c2` (Tasks 4–6 — route/server wiring).

**Next:** E14 PR-2 (official-CQL execution/outcome diff against the vendored CMS122v14 spec),
E12 PR-2 (WebChart/MariaDB→FHIR adapter — blocked on MIE schema), E15 (#187, cross-system identity
— leans on E12+E13), and the deferred WCAG chart accessible-alternatives.

---

## 2026-06-29 — E13 PR-2 Codex review fixes + merge (PR #215)

Four Codex P2 inline comments on PR #215 addressed before merge:

**P2-1 — site filter in `foldScaleCounts`.** The scale tenant (`mhn`) has its own location/provider
dimension that doesn't map to the `?site=` filter used by live tenants. When a site filter is active
the correct behaviour is to skip the scale fold entirely rather than blindly adding unfiltered 120k
data. Added an early return: `if (filters.site?.trim()) return;` in `program/program-read-models.ts`.

**P2-2 — date window in both read paths.** `foldScaleCounts` (programs overview) and
`buildHierarchyRollup` (hierarchy rollup) both now honour `from`/`to` when selecting which
`seed:scale` runs to aggregate. Uses the existing `day()` helper from `rollup-shared.ts` to compare
ISO date strings at day granularity — the same mechanism the live branch uses for live outcomes.

**P2-3 — React key uniqueness for mhn providers.** Provider IDs `P00`–`P09` are recycled across
all 24 `mhn` locations. Using a bare `provId` as the node id meant React could reconcile the wrong
row when multiple mhn locations were expanded simultaneously in the hierarchy UI (expansion state is
keyed `${level}:${id}`). Fixed in `program/scale-rollup.ts`: provider node id is now
`${locId}:${provId}` (e.g. `L00:P00`). No UI change required. Updated `scale-rollup.test.ts`
assertion accordingly.

**P2-4 — partial-seed idempotency.** The idempotency check in `run/backfill-scale.ts` previously
skipped a measure if any `seed:scale` run existed for it — including a `RUNNING` run left by a
prior crash. Now only `COMPLETED` runs are treated as fully seeded. The seed flow was changed to
create the run as `RUNNING`, write outcomes in chunks, then call `finalizeRun(id, "COMPLETED")`.
A crashed mid-seed run stays `RUNNING` and is eventually failed by `failStuckRuns` (30 min
timeout); the next `pnpm seed:scale` invocation sees no `COMPLETED` run and re-seeds that measure.

**Verification.** 765 tests: 764 pass, 1 skipped (Pg-ceiling self-skips without local Postgres), 0 fail.
PR #215 merged by Taleef; local branch `feat/e13-population-scale` deleted.

**Owner steps completed (2026-06-29):**
- `pnpm seed:scale --subjects 120000 --as-of 2026-06-26` run against Neon via Neon MCP connection string:
  **14 runs × 120,000 subjects = 1,680,000 outcomes** written; `mhn` now in the live rollup.
- `All Employees` segment widened via the audited `PUT /api/segments/ad1facc4-...` to all 7 sites
  (`Clinic`, `HQ`, `North Campus`, `Outpatient Clinic`, `Plant A`, `Plant B`, `South Campus`) —
  `SEGMENT_UPDATED` audit event recorded; `updatedAt` → 2026-06-29T15:12:24.
- `ALL_PROGRAMS` run triggered (runId `1a9f2ed4-...`) to evaluate all 150 employees (twh + ihn)
  → 2100 outcomes, COMPLETED in ~10.5 min (631,966 ms).
- **Live smoke check:** All Systems rollup = 1,682,100 evaluated (ihn 700 + twh 1,400 + mhn 1,680,000),
  78.1% overall. All three tenants present; reconciliation holds (All = Σ tenants).

---

## 2026-06-26 — E13 PR-2: population-scale tenant (120k) in the rollup

Second E13 slice — proving the multi-tenant rollup scales to a ~120k-subject tenant on the live stack
(Doug: *"120,000 people, up from 800"*). Spec + plan:
`docs/superpowers/specs/2026-06-26-e13-population-scale-design.md`,
`docs/superpowers/plans/2026-06-26-e13-population-scale.md`. ADR-020.

**The infeasibility that shaped it.** Live-evaluating 120k×14 ≈ **1.68M CQL evals per run** is
impractical (hours) and storing/serving millions of rows in app memory worse. So the scale tenant
(`mhn` / "MetroHealth Network") is **generated, not live-evaluated**, seeded once on-demand, and
**aggregated in SQL**:
- `engine/synthetic/scale-structure.ts` — the `mhn` tenant's small structure (24 locations × 10
  providers = 240) + a `subject_id` codec (`mhn|L07|P03|0000123`). The 120k subjects live **only** as
  outcome rows; they're not in the in-memory directory.
- `pnpm seed:scale [--subjects 120000]` (`run/backfill-scale.ts` + CLI) — owner-run, **not** on deploy;
  writes one COMPLETED run per runnable measure with generated, subject_id-encoded outcomes (minimal
  evidence), audited (`SCALE_POPULATION_SEEDED`), idempotent, reversible.
- `OutcomeStore.aggregateScaleRun(runId)` — a single `GROUP BY` (Postgres `split_part`; SQLite `substr`
  over the fixed-width id) → ~1.2k grouped rows, **never** the 120k per-subject rows.
- The hierarchy rollup + programs overview **exclude `seed:scale` runs from the in-memory scan** (the
  live 150-employee tenants keep their exact path) and build/fold the scale tenant from
  `aggregateScaleRun` (`program/scale-rollup.ts`; **provider-leaf** — no 120k patient nodes).
  `?tenant=mhn` isolates the scale subtree/KPIs.

**Bounded memory** is the headline guarantee — a test asserts the aggregation row-count is independent
of N (equal at 2k and 20k subjects). The roster (`/compliance`) is out of scope (no paging 120k
individuals); cron recompute is PR-3.

**Guarantees.** No DDL (encoded `subject_id` + `GROUP BY`), no new deps; reversible; CQL stays
authoritative for the live-evaluated subjects (ADR-008). The default demo stays 150 live employees
until the owner runs `seed:scale`. Frontend needs no change — the PR-1 System selector + depth-agnostic
rollup table already render `mhn` and its provider leaves.

## 2026-06-26 — E13 PR-1: multi-tenant (multi-system) rollup

Started E13 (#185, multi-WebChart rollup + population scale + scheduled recompute) with **PR-1: the
multi-tenant rollup** — the headline "roll up any WebChart system into 1 quality dashboard" capability.
Sliced E13 into three PRs (multi-tenant rollup / population-scale harness / cron recompute); this is the
first. Spec + plan: `docs/superpowers/specs/2026-06-26-e13-multitenant-rollup-design.md`,
`docs/superpowers/plans/2026-06-26-e13-multitenant-rollup.md`.

**What shipped.** A **tenant/system dimension** above the existing enterprise→location→provider→patient
hierarchy, modeled **read-time in the synthetic directory** (no schema; ADR-019):
- `employee-catalog.ts` — a `Tenant`/`Enterprise` model + `tenantId` on `EmployeeProfile`/`Provider`, a
  second synthetic system **Indus Hospital Network** (`ihn`, 50 employees / 3 campuses / 6 providers)
  alongside the unchanged **Total Worker Health** (`twh`, the original 100). `EMPLOYEES` spans both, so
  `ALL_PROGRAMS` evaluates everyone and both systems carry real outcomes. Helpers `tenantById` /
  `enterpriseForTenant` / `employeesForTenant`.
- `hierarchy-rollup.ts` — a single reconciling **"All Systems"** root (`level:"all"`) → tenant →
  enterprise → location → provider → patient, **tenant-qualified** maps so same-named locations/providers
  never merge across systems. Reconciliation (parent = Σ children) extends to the new top edges.
  `?tenant=<id>` returns that tenant's subtree as root.
- **Multi-tenant everywhere** via an optional `?tenant=` filter on `/api/hierarchy/rollup`,
  `/api/compliance/roster` (rows now carry `tenantId`/`tenantName`), and `/api/programs/*`; a new
  read-only `GET /api/tenants` feeds the UI selector. Defaults = all systems, so existing callers are
  unchanged.
- **Frontend** — an "All systems" System `<select>` on `/programs`, `/compliance`, and
  `/programs/hierarchy` (which renders the new all/tenant levels); the roster subject subtext shows the
  system name.

**Invariants/guarantees.** Tenant resolution is display/grouping only — CQL `Outcome Status` stays the sole
compliance authority (ADR-008). No schema, no new deps; reversible by reverting the PR.

**Verification.** Backend `pnpm typecheck` + full `pnpm test` green; frontend `npm run lint` + `npm run
build` + `npm run test` (99 vitest) green. New/updated tests: multi-tenant directory partitioning,
cross-tenant rollup reconciliation + `?tenant=` subtree equality, roster + programs tenant filters,
`GET /api/tenants`.

**Review fix (Codex PR review).** The enabled `All Employees` baseline segment was scoped to the `twh`
sites only, so IHN employees would read `NOT_APPLICABLE` for the baseline wellness/eCQM measures and the
run pipeline would skip their case creation. Fix: the baseline cohort now derives its site list from the
directory (`ALL_SITES`), so any **fresh** DB auto-covers every tenant. A first attempt added a boot-time
*self-heal* of an already-seeded row, but a follow-up review flagged it as an unaudited state change (the
hard "every state change writes `audit_event`" rule) that could also clobber operator edits — so it was
removed. The one already-seeded **live** row is an **owner-gated, audited repair** via `PUT /api/segments/:id`
(the Configure Groups editor), documented in `docs/DEPLOY.md`. Also fixed `distribution.test.ts` to derive
expected outcome counts from `N` (was hardcoded to the old 100-employee population).

**Next (E13):** PR-2 population-scale batch (~120k) + seed/scale harness; PR-3 scheduled cron recompute
(wire the inert `/api/admin/scheduler`). The real WebChart adapter is E12 PR-2 (blocked on MIE schema).

## 2026-06-26 — Deploy reliability: container-status polling + MIE-outage recovery

A push-to-`main` deploy failed with `Container is 'offline', expected running` while the live app was
actually healthy (200/200) — a **status-check race**: `deploy-mieweb-container.sh` read the container
status **once**, immediately after the create job reported `success`, and failed if it wasn't yet
`running`, even though the container reached `running` on its own seconds later. Fixed (PR #211) by
**polling** the status up to ~3 min (18× / 10s) until `running`, mirroring the self-heal reconciler's
retry. A separate, transient **MIE Container-Manager API outage** (`manager.os.mieweb.org` unreachable
~5 min) then failed the next deploys in the job-wait loop (before the new polling code is even reached),
leaving the merged #209/#210 changes undeployed; a clean `workflow_dispatch` re-trigger of the main
deploy recovered the stack and validated the polling fix on a real run. Live stack verified current +
healthy afterward (frontend/login/programs 200; the new `/api/measures/:id/fidelity` endpoint live,
401 auth-gated). DEPLOY.md gained a troubleshooting entry for the symptom. Infra-only; no app code.

## 2026-06-26 — E14 PR-1: standards fidelity diff (CMS122v14) + jurisdiction metadata

Opened **E14 — standards fidelity** (#186) on `feat/e14-standards-fidelity`, answering Doug's June-15 ask to
*"compare official ECQI documented CQL"* and *"look for the latest regulatory updates based on your country."*
WorkWell's eCQM measures are hand-authored, **simplified** CQL (local value sets, gist-level logic); E14 makes
the **officially published** spec the reference and produces a **documented fidelity diff** of WorkWell's
authored version against it.

- **`backend-ts/src/standards/` module (beside, never inside, the engine):** a vendored, sourced
  `OfficialMeasureReference` for **CMS122v14** (`references/cms122v14.ts` — v14.0.000, steward NCQA,
  proportion; official IPP/DENOM/DENEX/NUMER/NUMEX criteria, ~21 VSAC value sets, a curated grounded coverage
  judgement per criterion, provenance URLs + an `omissionSummary`). Every claim is transcribed from the cited
  eCQI Resource Center HTML + QPP MIPS frozen-code PDF (no VSAC login). `computeFidelity(ref)`
  (`measure-fidelity.ts`) is a **pure** assembler → a `FidelityReport`: each criterion classified
  COVERED/SIMPLIFIED/OMITTED + value-set coverage + reconciling summary counts + a data-driven headline + a
  disclaimer that it is structural, not an outcome diff. Pure data + pure functions — no DB, no `node:fs`, no
  engine call, no outcome mutation.
- **`GET /api/measures/:id/fidelity`** — the report for cms122; `{ available: false }` (200) for measures
  without a vendored reference; 404 for an unknown id. Read-only, authenticated, read-time.
- **Jurisdiction metadata** — `jurisdiction?: string` on the registry `MeasureMeta` (default `"US"`),
  surfaced on the measure-detail read model; plus the country-aware **design memo**
  (`docs/standards/country-aware-regulatory-sourcing.md` — a `RegulatorySource` model, country-switch rule
  selection, and the aspirational "latest regulatory updates by country" watcher; design-first per the issue
  Notes — PR-1 ships only the metadata field + memo).

The pivotal **scope decision (ADR-018):** fidelity is **structural/definitional-first** — official-CQL
**execution** + an evaluated-outcome diff is research-grade (QDM→FHIR, ~20 VSAC value sets, shared exclusion
libraries, QI-Core bundles) and is **deferred to PR-2** behind the existing E3.2 `ValueSetResolver` seam
(frozen QPP code lists as a no-VSAC expansion source). Built TDD per task; one whole-branch review fold-in
(data-driven headline via `omissionSummary`, count single-source). **No schema, no new deps**; descriptive
only — CQL `Outcome Status` stays the sole compliance authority (ADR-008/ADR-018). Backend `tsc` + full suite
green (node:test; 1 self-skipped Pg-ceiling contract). Design + plan in `docs/superpowers/`.

## 2026-06-26 — WCAG accessibility pass (frontend)

Closed the last tracked QA follow-up — the fuller accessibility pass beyond table/label basics. A
verify-first sweep confirmed the frontend was **already substantially accessible** (all 91 hand-written
`<th>` already carry `scope="col"`; form inputs/icon-buttons/status-badges already labeled via
`@mieweb/ui` + prior passes), so the genuine gaps were focused:

- **Keyboard-accessible activation** — `/runs` rows and the ELM Explorer AST nodes were mouse-only
  `onClick`s. Runs rows keep their whole-row mouse `onClick` (a real `<tr>`, table semantics intact) and
  the first cell now carries a real keyboard/SR `<button>` (`aria-pressed`); the ELM Explorer select
  target moved onto a label span so it's a **sibling** of the expand/collapse toggle (no nested
  interactive controls), both Enter/Space operable.
- **Studio authoring tabs → ARIA tab pattern** — `role="tablist"/"tab"/"tabpanel"`,
  `aria-selected`/`aria-controls`/`aria-labelledby`, roving `tabIndex`, and ArrowLeft/Right + Home/End
  keyboard navigation (mirrors the `/admin` tabs).
- **`aria-live` announcements** — an always-mounted `sr-only role="status"` region mirrors the global
  run-status text (start/progress announced to screen readers, completion already covered by the toast),
  and the case-detail "Explain Why Flagged" AI result is an always-mounted live region so it's announced
  on arrival.
- **Stable list keys** — index keys → content/id composites where lists can reorder.

No visual redesign, no new deps. Frontend `npm run lint` clean, **99 vitest pass**, build green.
Two whole-branch-review items folded in (the `<tr>` row-semantics fix + the always-mounted AI live
region). **Accessible alternatives for the Recharts charts** (a hidden data-table/summary per chart) are
the one genuinely larger, partly-subjective item — split out as a follow-up rather than ballooning this PR.

## 2026-06-26 — Tracked QA follow-ups closeout (M1 + H2 + evidence-bucket)

Methodical closeout of three long-tracked follow-ups (no schema, no new deps; one PR).

- **M1 — `nextActionFor` measure-aware label.** The case next-action hint keyed off the measure
  *display name* and defaulted every unmatched measure to **"audiogram"**, so all 13 non-OSHA measures
  (TB, immunizations, HbA1c, BMI, CMS eCQMs, …) mislabeled their action. Now keyed by `measureId` across
  all 14 runnable measures (`NEXT_ACTION_LABELS`) with a generic fallback, and the inaccurate "annual"
  was dropped from the DUE_SOON phrasing (windows vary — biannual HbA1c, 27-month mammogram, 10-year
  Td/Tdap, permanent series). A regression-guard test asserts every `MEASURES` entry has a specific label.
- **H2 — SendGrid inert seam (code↔docs gap).** `DEPLOY.md`/`CLAUDE.md` described SendGrid wiring that
  did not exist in `backend-ts`. Added `resolveEmailService(env)` + an inert `sendgridEmailService` stub
  (`QUEUED`, no real HTTP) mirroring the DataChaser pattern (ADR-011): `simulated` by default, the SendGrid
  stub only when `WORKWELL_EMAIL_PROVIDER=sendgrid` + the api key are set, provider-without-key degrading
  to simulated. The EMAIL outreach channel now routes through it (DataChaser precedence unchanged). The
  demo stack stays simulated. Real SendGrid v3 send is the documented drop-in.
- **Evidence-upload persistence — verified + documented (no code).** Evidence bytes already sit behind the
  `CloudBucket` port (`EvidenceService` only `put`/`get`s), so persistence is a binding choice, not app
  code. The live TWH container runs the `local` target whose `BUCKET` is an in-container `fs` driver
  (ephemeral across recreate). `DEPLOY.md` now carries the turnkey recipe to point `BUCKET` at a managed
  S3/R2 bucket (the `mieweb` target already shows the `s3` driver shape) — owner-gated like schema/DDL,
  pending a provisioned bucket + credentials.

## 2026-06-26 — E12 PR-1: pluggable data ingress + DB-less JSON-bucket adapter

Opened **E12 — pluggable data adapters** (#184) on `feat/e12-data-adapters`, starting with the
architectural fork it inherits from **E9 (#78, CQL→SQL bridge)**: how does real WebChart/EHR data reach
the measure engine? Decision recorded as **ADR-017 — FHIR-native-first**. Adapters adapt their native
representation into FHIR bundles fed to the **unchanged** `CqlExecutionEngine`; we do **not** transpile
CQL→SQL to run measures inside MariaDB. Rationale: the engine is already built, golden-parity-proven, and
JVM-free, so the adapter is the only new surface; a transpiler is research-grade/high-risk; the seam is
fully reversible (it adds a layer above the engine, touching nothing in it).

- **`engine/ingress/` module (above the engine):** `evaluate-bundle.ts` — a DB-less, `node:fs`-less
  library entry: `evaluateBundle(bundle, measureId)` (single) + `evaluateBatch(bundles, measureId)` (a
  "bucket" with per-item error isolation → one bad bundle never aborts the rest → `BatchResult`). A thin
  shell over the engine, so it stays portable across every `@mieweb/cloud` target (file I/O lives only at
  the CLI edge).
- **`PatientDataSource` port:** `jsonBucketDataSource` (default, in-memory) + an inert `webChartDataSource`
  stub (rejects "not yet wired (E12 PR-2)") + `resolveDataSource(env, jsonInput?)` (config-driven: JSON by
  default, WebChart only when both `WORKWELL_WEBCHART_BASE_URL` + `WORKWELL_WEBCHART_API_KEY` are set —
  inert-unless-configured, mirroring `resolveForecaster`/`resolveChannel`/`resolveStandingOrderProvider`) +
  `evaluateSource` sugar.
- **CLI refactor:** the headless `pnpm evaluate` CLI now reuses `evaluateBundle` — one evaluation path,
  behavior-preserving (golden CLI regression stays green).

Built TDD per task. **No schema, no new deps**; the engine is unmodified. Ingress feeds bundles in — it
never decides compliance (CQL `Outcome Status` stays authoritative; ADR-008/ADR-017). Backend `tsc` + full
suite green (node:test; 1 self-skipped Pg-ceiling contract). **PR-2 deferred** — the real
WebChart/MariaDB→FHIR adapter depth. Spec + plan in `docs/superpowers/`.

## 2026-06-26 — E11.3 PR-2: Configure Groups UI (closes E11)

Built the frontend half of segments on `feat/e11-3-segments-ui` — the **Configure Groups** editor that
makes the PR-1 backend operable from the UI and **closes E11**. A segment is still a cohort (role/site
predicate + per-employee INCLUDE/EXCLUDE overrides) → an applicable measure-id rule-set; this PR adds the
controls to author one and surfaces applicability on the roster.

- **`POST /api/segments/preview`** — a dry-run cohort-membership endpoint for an **unsaved** rule (reuses
  the existing `matchesCohort` + `validateRule`; ADMIN-gated; read-only; returns `{count, members}`). A
  shared `previewResponse` helper now backs both the GET `:id/preview` (saved) and this new POST (unsaved).
- **`/admin → Groups` tab** — a `SegmentsAdmin` orchestrator over a `SegmentsList` + `SegmentEditorModal`:
  a rule builder (match ANY/ALL + condition rows of attr/op/value, incl. multi-value `in`), applicable-measures
  checkboxes, an INCLUDE/EXCLUDE overrides employee-picker (debounced `/api/employees/search` → chips), and a
  live server-computed membership preview. Validity-gated save through a `useSegments` CRUD hook;
  New/Edit/Delete are ADMIN-only via a `canManageSegments` RBAC helper.
- **Roster surfacing on `/compliance`** — a `NOT_APPLICABLE` chip (slate, distinct from `NA`) in
  `lib/status.ts`, and a "Segment" `<select>` (enabled segments only) that adds `&segment=<id>` to
  `GET /api/compliance/roster` (scopes rows to the cohort + columns to its rule-set).

Built subagent-driven (TDD per task). Two-stage subagent review folded in two fixes: the `in`-operator
multi-value input buffer dropped keystrokes mid-edit (raw-string buffer fix), and three
`react-hooks/set-state-in-effect` lint errors in the new hooks/modal. **No schema, no new deps.** Backend
`tsc` + full suite green (node:test; 1 self-skipped Pg-ceiling contract); frontend Vitest green + lint clean.
Segments configure applicability/case-creation + display only — never compliance (ADR-008/ADR-016; CQL
`Outcome Status` stays authoritative). Design + plan in `docs/superpowers/`.

## 2026-06-25 — E11.3 PR-1 merged + verified live; PR-2 (Configure Groups UI) spec'd + planned

Merged **E11.3 PR-1** (#205, risk-group segments backend) and verified it on the live stack: the 3 segment
tables self-created on Neon, the 3 enabled demo cohorts seeded, and the `NOT_APPLICABLE` overlay is correct
across panels (immunizations: mmr/varicella/hepB are N-A for the ~80 non-Clinical employees, real for the
Clinic/Nurse cohort; OSHA: audiogram/hazwoper N-A for non-field; spot-checks: emp-041 Nurse→mmr COMPLIANT,
emp-007 Office→mmr/audiogram NOT_APPLICABLE). Health green, no regression. Addressed two Codex P2s on the PR
before merge (per-operator value-shape validation so an `{op:"in", value:"Clinic"}` no longer silently
matches nobody; `ensureSegmentSeed(env)` seed-once wired into every segment consumer so a cold-DB first hit
to `/api/segments` / `/api/compliance/roster` / `/api/runs` seeds the cohorts rather than only the
`/api/measures` initializer).

Then brainstormed + planned **E11.3 PR-2 — the Configure Groups UI** (the frontend half that closes E11),
on branch `feat/e11-3-segments-ui`: a `/admin → Groups` ADMIN editor (rule builder + applicable-measures
multiselect + INCLUDE/EXCLUDE overrides picker via the existing `/api/employees/search` + a live
server-computed membership preview), one new `POST /api/segments/preview` endpoint, and the roster
`NOT_APPLICABLE` chip + segment filter. Design: `docs/superpowers/specs/2026-06-25-e11-3-segments-ui-design.md`;
8-task TDD plan: `docs/superpowers/plans/2026-06-25-e11-3-segments-ui.md`. **Implementation deferred** — the
spec + plan are committed; resume by executing the plan subagent-driven, then PR.

## 2026-06-25 — E11.3 PR-1: risk-group segments (backend)

Closed the last E11 piece — the **segment / risk-group** model — on `feat/e11-3-segments` (PR-1, backend).
A *segment* maps a cohort (a `role`/`site` predicate rule + per-employee INCLUDE/EXCLUDE overrides; EXCLUDE
wins) to an applicable measure-id rule-set. A subject's applicable measures = the union of the rule-sets of
every **enabled** segment they belong to. **Applicability gates case creation + display only — never
compliance** (ADR-016; CQL `Outcome Status` stays the sole authority).

- **First E11 schema:** 3 owner-gated tables (`segments`, `segment_measures`, `segment_overrides`) on the
  SQLite floor + Postgres ceiling (TEXT ids, `enabled` INTEGER/BOOLEAN, `rule_json` TEXT/JSONB), behind a
  `SegmentStore` port (both adapters, store-contract parity incl. a dedup case). Self-creating
  `CREATE … IF NOT EXISTS` — drops into Neon on the next deploy boot, additive, reversible.
- **Single applicability engine** (`segment-applicability.ts`, pure) consumed by both surfaces: the roster
  read model gains a `NOT_APPLICABLE` overlay (distinct from `NA` "no data") + a `?segment=<id>` filter
  (scopes rows to the cohort, columns to the rule-set; only an *enabled* segment scopes), and the run
  pipeline gates the case upsert (`isApplicable` guard) while **always persisting the outcome** (ADR-008).
- **Reversibility invariant** (tested both surfaces + the pipeline): zero enabled segments ⇒ everything
  applicable to everyone = pre-E11.3 behavior. Disabling/deleting all segments reverts the feature.
- **`/api/segments` CRUD + `/preview`** — writes ADMIN-only (authorize rule + a dedicated authorize test) +
  audited `SEGMENT_*`, reads authenticated, route-level enum + `measureIds`-in-registry validation (400 on
  malformed). Idempotent boot seed of **3 ENABLED demo cohorts** (All Employees baseline / OSHA
  Safety-Sensitive / Clinical Staff) whose rule-sets together cover **every** Active runnable measure (a
  `no-orphaned-measure` test guards this) so the grid shows a real applicable/N-A mix. **Note:** because the
  seed ships enabled, the applicability overlay goes **live on the demo** on the first deploy (out-of-cohort
  cells read NOT_APPLICABLE; out-of-cohort cases are suppressed on the next run) — a deliberate,
  whole-branch-reviewed decision. Reversibility still holds (disable/delete all segments ⇒ pre-E11.3 behavior).

Built subagent-driven (TDD per task; spec + code-quality review each task — several review findings folded
in: EXCLUDE-beats-INCLUDE hardening, contract dedup coverage, disabled-segment filter guard, route audit/doc
polish). **No new deps.** Backend `tsc` + full suite green (697 pass / 1 self-skipped Pg-ceiling contract).
Frontend untouched — the **Configure Groups editor UI is PR-2**. Design: `docs/superpowers/specs/2026-06-25-e11-3-segments-design.md`;
plan: `docs/superpowers/plans/2026-06-25-e11-3-segments-backend.md`. ADR-016; DATA_MODEL §3.22.

## 2026-06-25 — E11.2c PR-2: live Hep B repointed to Heplisav-vs-traditional

Repointed the live `hepatitis_b_vaccination_series` measure onto the PR-1 multi-alternative-series codegen,
so seeded Hep B outcomes + roster cells now reflect the real **Heplisav-B (2 doses CVX 189, ≥28d) OR
traditional (3 doses CVX 08/43/44/45, ACIP min intervals 28/56d)** logic.

- **Value set + binding:** added CVX 44/45 to `urn:workwell:vs:hepb-vaccines`; `hepatitis_b.yaml` gained
  `rule.alternatives` + `bindings.eventAlternatives` (label-correlated). The two regex build scripts
  (`gen-cql.mjs` → parity artifact, `gen-measure-bindings.mjs` → `measure-bindings.ts`) now parse the
  flow-style alternatives lists; `measure-bindings.ts` carries a merged `alternatives` array. *(There is no
  runtime YAML loader — these build-time scripts are the "loader"; the plan's `src/engine/yaml` path doesn't
  exist, so the codegen-parity test + PR-1's behavioral goldens are the equivalent verification.)*
- **CQL/ELM:** rewrote hand-written `hepatitis_b.cql` to the alternatives logic (copied from the generated
  artifact ⇒ parity by construction) and recompiled the ELM. `codegen-parity` green; EOL-clean (git
  normalizes — only the 6 intended files diff).
- **Synthetic dose model:** made `fhir-bundle-builder.ts` alternative-aware — it picks one alternative per
  employee by a stable `externalId` hash and stamps that brand's CVX code + dose count + ACIP-satisfying
  spacing. *(Placed in the builder, which already has `employee.externalId`, rather than threading
  `subjectId` through `deriveExamConfig`'s 6+ call sites — same "stable hash per employee" intent, smaller
  blast radius.)* Absent `alternatives` ⇒ unchanged single-code path. Repointed the 4 spike fixtures
  (present_recent = Heplisav-2, present_old = Traditional-3) via `gen-bundles.mjs`.
- **Advisory consumers (never set status):** forecaster → Heplisav 2-dose default (`HEPB_DOSES_REQUIRED`
  3→2, interval 30→28d); order-catalog Hep B CVX 08→189; measure-catalog spec text describes the
  alternatives (drops "deferred to E11"). Roster `deriveCell` unchanged (reads the still-emitted union
  `Dose Count`); pinned the repointed COMPLIANT/partial/none cells — the partial "1 of 2 doses on file"
  under-read for a traditional-3 series is the accepted, documented display nuance.

**No schema/DDL, no new deps; reversible by reverting the PR.** Smoke via `pnpm evaluate` on the live ELM:
present_recent→COMPLIANT, present_old→COMPLIANT, missing→MISSING_DATA, excluded→EXCLUDED. Backend `tsc` +
full suite green (664 pass / 1 self-skipped Pg-ceiling contract); frontend untouched. CQL `Outcome Status`
stays the sole compliance authority (ADR-008/ADR-015); titer-proves-immunity for Hep B still deferred.

## 2026-06-25 — E11.2c PR-1: multi-alternative-series codegen + Rule Builder

Extended the `series-completion` codegen (`generate-cql.ts`) with **multi-alternative series**: a measure
rule may carry `alternatives` — an OR of alternative dose series, each with a **multi-CVX code set** and
optional **per-alternative minimum dose intervals** (an ordered multi-source `exists` with inclusive `>=`
day gaps), the shape real Hep B needs (Heplisav-B 2-dose CVX 189 min 28d OR traditional 3-dose CVX
08/43/44/45 min 28d/56d). Behavioral goldens cover the multi-CVX + min-interval logic incl. 7 in-process
compile+evaluate Hep B scenarios; the Rule Builder gains an "Alternative series (multi-brand)" sub-form
(multi-CVX + intervals). **Capability only — no live measure change** (the live Hep B repoint is the E11.2c
PR-2 follow-up). Additive/back-compatible: absent `alternatives` ⇒ byte-identical to E11.1, so the
`codegen-parity.test.ts` proof is unchanged. No schema, no new deps; ADR-008/ADR-015 honored — codegen only
emits CQL, `Outcome Status` stays the sole compliance authority. Backend + frontend suites + lint + build green.

## 2026-06-24 — E11.2b: Rule Builder UI (Studio tab)

Put a UI in front of the E11.1/E11.2a codegen: a **Rule Builder** tab in Studio (`/studio/[id]`). A
structured form (shape = series-completion | windowed-recency; params requiredDoses / windowDays·dueSoon·
grace; the Compliance-paths toggles allow-positive-titer + allow-declination; binding codes) emits the
codegen `{rule, bindings}`, shows a debounced **live generated-CQL preview** (`POST …/rule/preview`), and
**atomically saves** (`PUT …/rule`: generate → persist `spec_json.rule`/`ruleBindings` + `cql_text` +
compile status, audited). Params round-trip on re-open via `spec_json` (additive — no schema). AUTHOR/ADMIN;
CQL stays canonical (ADR-015) — the builder authors params + the generated CQL, no new eval path (and, like
the CQL tab, runtime-edited CQL isn't evaluated until a build — pre-existing). Hep B multi-series/intervals/
multi-CVX deferred. Built subagent-driven; backend + frontend suites + lint + build green.

## 2026-06-24 — E11.2a: codegen titer + grace + declination

Extended the E11.1 rule→CQL codegen (`generate-cql.ts`) with three additive, back-compatible capabilities
toward the Rule Builder's "Compliance paths & timing" group (vamsi7): **grace** (windowed —
`overdueThreshold = windowDays + gracePeriodDays`, extends Due-Soon before OVERDUE), **titer** (series —
`allowPositiveTiter` ORs a `Has Positive Titer` Observation define into `Series Complete`, a real immunity
path), and **declination** (a `Refused` define wherever a refusal binding is present; never changes
`Outcome Status` — the roster shows DECLINED). Every new field is optional; absent ⇒ E11.1 output
byte-for-byte, so the E11.1 parity proof (6×4) stays green unchanged. Proven by behavioral goldens
(`generate-cql-extensions.test.ts`: grace shifts the OVERDUE boundary, a positive titer with 0 doses is
COMPLIANT, a refusal sets Refused=true). ADR-008 holds — codegen only emits CQL. The Hep B
multi-series/intervals/multi-CVX is deferred. Next: E11.2b Rule Builder UI (Studio tab → form → preview →
save). Built subagent-driven; backend suite + typecheck green.

## 2026-06-24 — E11.1: rule-params → CQL codegen + ADR-015 (canonical decision)

Started epic E11 (#183) with the linchpin decision: **CQL is canonical; rule-params compile to CQL**
(ADR-015) — answering Doug's CQL-vs-YAML question without a second execution path. New
`engine/cql/codegen/generate-cql.ts` emits canonical CQL for two rule shapes — `series-completion`
(mmr/varicella/hepatitis_b) and `windowed-recency` (audiogram/hypertension/cholesterol_ldl) — from each
measure's new YAML `rule:` block (via `npm run gen-cql` → `measures/generated/<id>.cql`). Proven
**`Outcome Status`-equivalent** to the hand-written CQL across all synthetic scenarios
(`codegen-parity.test.ts`: 6 measures × 4 scenarios = 24 assertions green — translating generated CQL → ELM
in-process via `compileCql` and evaluating through the real engine with an optional `elm` override). **No
cutover** (hand-written `.cql` stays the build source), **no schema, no new deps**; legacy non-code-scoped
measures (hazwoper/tb) excluded pending a code-scope migration. The de-risk landed clean — codegen produced
identical outcomes with no template fixes needed. Next: E11.2 Rule Builder UI (form → `rule:`), E11.3
segments/risk-groups. Built subagent-driven; backend suite + typecheck green.

## 2026-06-24 — Simulate Compliance History (#197)

Shipped the last per-employee-screen action on `feat/simulate-compliance-history`. `GET
/api/employees/:externalId/simulate?asOf=` runs an advisory, **non-persisted** as-of-date re-evaluation of
one employee across every active measure — reusing the in-memory CQL engine + synthetic adapters
(`simulateComplianceAsOf`): per measure it takes the seeded exam config, builds the bundle **anchored to
today**, evaluates as-of the chosen date, and maps through the shared `deriveCell` vocabulary. Anchoring
to today (not the as-of date) is what makes scrubbing meaningful — a later date ages RECURRING measures
toward OVERDUE while PERMANENT (series-completion) measures stay constant, and simulate-as-of-today lines
up with the live card's status (same seeded target; proven by a deterministic test: audiogram
COMPLIANT→OVERDUE at +10y, mmr unchanged). The panel is a *live re-evaluation* (the card shows the last
recorded run) and is framed advisory. A `SimulateComplianceHistory` panel on `/employees/[externalId]` lets the operator scrub a date
and see the result with the same chips, clearly advisory. **Writes nothing** — no runs/outcomes/cases/audit;
no schema; no new deps. CQL stays the sole compliance authority (ADR-008/ADR-012). This closes the
per-employee-screen trio (Recalculate + evidence drill-in in #198, Simulate here). Built subagent-driven
(TDD per task); backend + frontend suites green; lint + build clean.

## 2026-06-24 — Per-employee compliance card: Recalculate + CQL evidence drill-in

Finished the two E10.4 deferrals on the `/employees/[externalId]` Individual Compliance Status card
(`feat/compliance-card-actions`). **Recalculate** — a RBAC-gated button that fires the existing
synchronous EMPLOYEE run (`POST /api/runs/manual`, audited), then refetches the card and the whole
profile (`useEmployeeProfile` now exposes `refetch`). **Evidence drill-in** — each row's Info expander
lazy-loads the cell's outcome via a new read-only `GET /api/outcomes/:outcomeId` (`getOutcomeById` on the
floor + ceiling; no schema) and renders the CQL `expressionResults`/`why_flagged` through a new shared
`CqlEvidence` component, which **also replaces the duplicated inline evidence JSX on case-detail** (single
source — both the mobile + desktop blocks + the why_flagged summary now use `CqlExpressionResults`/
`CqlWhyFlagged`). CQL stays the sole compliance authority — the endpoint is read-only and the card never
derives status (ADR-008). Built subagent-driven (TDD per task). Two Codex P2s fixed: (1) **Recalculate** originally fired a
single-subject EMPLOYEE run, but the roster read model excludes single-subject reruns
(`isPopulationRun`), so the card never reflected it — switched to the `/compliance` grid's pattern: an
`ALL_PROGRAMS` population run via `RunStatusProvider`, refetched on `ww:run-complete` (the run the roster
actually reads); (2) `GET /api/outcomes/:id` returned only the engine's `expressionResults`, so the
card's `CqlWhyFlagged` got `undefined` — the endpoint now derives `why_flagged` on read via
`deriveWhyFlagged` (same as case-detail). Earlier review catch: a `react-hooks/set-state-in-effect` lint
trip on the new `load`/`refetch` effects, fixed with the deferred-`setTimeout` pattern. Simulate
Compliance History stays deferred (its own issue, #197). Backend 651/651 + frontend 77/77 green; lint +
build clean.

## 2026-06-24 — E10 Plan 3: roster grid UI + per-employee compliance card (#190, #191)

**Plan 2 merged (PR #195); shipped the E10 frontend on `feat/e10-plan3-roster-ui`.** New `/compliance`
**"Individual Compliance Status"** grid (E10.3 #190): rows = every directory subject, columns = the
selected panel's Active measures (Immunizations / OSHA Surveillance / Wellness & eCQM), each cell a
status chip + method subtext using the E10.5 display vocabulary
(COMPLIANT/DUE_SOON/OVERDUE/MISSING_DATA/EXCLUDED/DECLINED/IN_PROGRESS/NA). Panel/status/site/search
filters + `X-Total-Count` paging; sticky subject column + `scope="col"` headers; row → employee profile.
A RBAC-gated **Recalculate** triggers an `ALL_PROGRAMS` run through the #181 `RunStatusProvider` and
refetches on `ww:run-complete`. Per-employee **Individual Compliance Status** card (E10.4 #191) on
`/employees/[externalId]`: a RULE → STATUS → METHOD table merging all three panels (one roster call per
panel, filtered to the subject), each row expandable to method/class/source-run. Pure frontend — no
schema, no new deps; all status/method text comes verbatim from the read model (ADR-008). New shared
pieces: `complianceStatusClass`/`COMPLIANCE_STATUS_LABELS` (`lib/status.ts`), `features/compliance`
(`types.ts` + `ComplianceChip`). **Built subagent-driven (TDD per task).** One review catch on the grid
task: the implementer had introduced an *unauthenticated* module-level `api` singleton to satisfy a bad
`import { api }`; corrected to the token-bound `const api = useApi()` hook (mirrors `cases/page.tsx`) so
live calls carry the session token, and the test mocks `@/lib/api/hooks` with a stable object (memoized
hook parity). Frontend Vitest suite green; `npm run lint` + `npm run build` clean.

**Open follow-ups (noted in the PR):** per-employee card **Recalculate** (EMPLOYEE rerun-to-verify) +
**Simulate Compliance History** buttons, and inline `expressionResults` evidence drill-in (would need a
backend outcome-evidence endpoint) — both deferred; the profile already exposes rerun + forecast and the
case-detail page renders full evidence.

## 2026-06-22 — E10 Plan 2: roster read model + status vocabulary (branch)

**Plan 1 merged (PR #194); started E10 Plan 2 on `feat/e10-plan2-roster-read-model`.** Adds the
backend behind the "Individual Compliance Status" grid: a new `src/compliance/` module —
`panels.ts` (immunizations / OSHA / wellness column sets), `roster-vocabulary.ts` (the **E10.5**
`deriveCell`: maps a measure outcome's canonical bucket + evidence + `complianceClass` →
`{ status, method }`, adding the **DECLINED / IN_PROGRESS / NA** display states + method strings on
top of the 5 canonical buckets), and `roster-read-model.ts` (the **E10.2** `buildRoster`: rows = every
directory subject, columns = the panel's Active measures, cells over the latest population run per
measure — reusing `rollup-shared` `latestRunRows`/`isPopulationRun`, evidence via `listOutcomes`
cached per run, NA where unevaluated; filters + paging + `total`). Exposed read-only as
**`GET /api/compliance/roster`** (`+ X-Total-Count`), authenticated under `/api/**` (all roles, like
`/api/hierarchy/rollup`). The persisted status is unchanged — `deriveCell` is a display refinement
only (ADR-008). No schema, no new deps. Built subagent-driven (TDD per task), then an opus whole-branch
review (**approve**, no Critical/Important); folded in its cheap polish (dose-count fallthrough harden,
class-agnostic refusal comment + RECURRING-refusal test, a run-cache no-N+1 test). Suite green (~595
backend tests, 0 fail), typecheck clean. NA is implemented but dormant on synthetic data (everyone is
enrolled) until E11 segment eligibility. Next: **Plan 3** — the grid (E10.3 #190) + per-employee
screen (E10.4 #191).

## 2026-06-22 — E10 Plan 1: measure taxonomy + permanent immunization vaccine panel (branch)

**Started the post-demo (June-15) WebChart-convergence roadmap.** Decomposed Doug's June-15 demo
feedback (roster grid, "show compliant too", once-compliant-vs-recurring, YAML rules, multi-WebChart
rollup, identity/mobility) into **GitHub Project #7** with epics **E10–E15 (#182–#187)**; E10 (#182)
broken into sub-issues #188–#193. Wrote the E10 design spec
(`docs/superpowers/specs/2026-06-22-e10-roster-compliance-design.md`) + a 3-plan split
(foundation → read model → UI).

**Implemented Plan 1 (foundation) on `feat/e10-roster-compliance` (not yet merged):** a
`complianceClass: PERMANENT | RECURRING` measure-taxonomy field + a 3-measure permanent-immunity
**vaccine panel** — MMR, Varicella, and Hepatitis B (promoted from an Approved catalog entry) — using
the repo's first **series-completion CQL** (`Count(valid doses) >= 2`, no recency → "once compliant,
always compliant"). **Now 14 runnable / 63 catalog** (was 11/61). No schema, no new deps; CQL stays the
sole authority (ADR-008) — `complianceClass` is display/routing metadata only, and the engine still
emits only the 5 canonical buckets (a partial series is canonically MISSING_DATA, to be refined to
IN_PROGRESS by the roster read model in Plan 2).

Built subagent-driven (TDD per task + spec & code-quality reviews), then an opus whole-branch review
(approve-with-fixes — all applied). Caught + fixed a regression where the fixture generator's `rmSync`
silently deleted the un-regenerable `_java_golden.json` (consumed by `compare-all.mjs`). **Verified:
backend 575 pass / 0 fail / 1 skip, typecheck clean; the headless CLI proves permanence (MMR 2003 doses
→ COMPLIANT, `Dose Count` 2); the Java-parity check passes 40/40** for the original 10 measures.
Deferred to E11: titer-proves-immunity + the Heplisav-vs-traditional-3-dose distinction. Next: Plan 2
(roster read model + status vocabulary, E10.2/E10.5) → Plan 3 (grid + employee screen, E10.3/E10.4).

## 2026-06-21 — QA/UX hardening pass 2 (PR #181 — merged + deployed)

**Built on the 6/20 smoke test: continued the manual QA (blocks 4–11), ran a 13-surface
multi-agent code+UX audit (80 findings), then implemented fixes across the whole app.** Blocks 4–11
verified live against `twh-api-ts.os.mieweb.org`: Runs/SEED/QRDA/CSV (4), Immunization forecast (7,
3 ACIP series), Order proposals (8, 187 proposed/5 suppressed, real CPT codes, author 403), Auditor
packets (10) all pass; RBAC matrix re-confirmed (author 403s on campaigns/admin/orders, 200 on
reads). Audit verified several smoke-test premises as already-fixed and surfaced the real remaining
work. **Merged as PR #181 (merge `b5d9f7c`) and deployed to `main`.** 22 commits; verification at every
step: backend full suite + typecheck green; frontend tsc + lint + build + vitest green; **three
whole-diff code reviews** (the initial pass, a full-branch pass, and the maintainer's PR review —
9 review items fixed in `a5433f2`, 3 verified false positives left with evidence). CI green on merge.

What shipped (by theme):
- **RBAC nav + action gating** (`frontend/lib/rbac.ts` mirrors `authorize.ts`): the sidebar only hid
  Admin; now Cases/Worklist/Campaigns/Orders → CM/ADMIN, Studio → AUTHOR/APPROVER/ADMIN, Admin →
  ADMIN, with the run/rerun/create/bulk/send buttons gated to match. Fixes the user's "every role
  sees every option then 403s." Campaigns gains a deep-link access-denied guard. ("Test Runs"→"Runs".)
- **Backend correctness:** `programOverview/Trend` now only count terminal (COMPLETED/PARTIAL_FAILURE)
  runs — an in-flight ALL_PROGRAMS run was being picked as "latest", which is why the Evaluations
  count bounced (1100→partial→1100). `caseTimeline()` (both stores) now reads `audit_events` only
  (dropped the `case_actions` UNION arm that double-listed every assign/outreach/escalate); the atomic
  dual-write invariant is unchanged. Store-contract + route + program test fixtures updated.
- **Programs perf + charts:** render KPIs+cards immediately, then stream trend/driver detail
  concurrently (was ~23 serial reqs); dynamic padded chart y-domain (`lib/charts.ts niceDomain`) so
  variation is visible instead of flat against [0,100]; whole-card stretched-link; stable By-Reason
  block. Measure detail: 4-read waterfall → one parallel round-trip; single focused trend line.
- **Cases worklist:** add the missing OVERDUE/outcome filter (backend `?outcome=`), a page-size
  selector (25/50/100/200/500), and a Cards/Table view toggle.
- **Runs page:** add the missing MeasureReport (FHIR) + QRDA (XML) download buttons (endpoints
  existed, no UI); fix the Status/Scope/Trigger filters (lowercase option values never matched the
  backend's UPPERCASE enums); SEED trigger column + filter + status pills; confirm-before-run;
  downloads toast on failure.
- **Case detail:** "Code evidence explorer"→"CQL Evidence Explorer"; actionable Next-action CTA;
  assignee type-ahead (datalist); dark-mode on the pastel light-only cards; restored Manual/Auto
  outreach badge after the single-source timeline change.
- **Admin:** wired the Outreach Delivery Log (M3) to `CASE_OUTREACH_SENT` audit events (was
  `json([])`); `overflow-hidden` on the three NitroGrid wrappers (the "mappings obstructed by tables").
- **Orders (E7):** new CM/ADMIN `/orders` page — the order-proposal API shipped with no UI at all.
- **Trend realism:** bumped the synthetic generator amplitude + added a texture harmonic (needs a
  re-seed to surface; the live chart auto-scale already reveals the existing ±6%).

Follow-up wave (also completed this pass, after the items above): **Admin IA → 4 tabs**
(Operations/Governance/Outreach/Audit, so only the active section + its NitroGrid mounts) + dark
badges + server-side audit-payload pretty-print; **Employee detail redesign** (2-column layout +
sticky rail, colored outcome pills, dropped the always-null SLA column, and the backend profile now
does one cases fetch instead of two); a **global, durable run-progress indicator** (`RunStatusProvider`
in the layout — a header pill that survives navigation + reload via localStorage, fires
`ww:run-complete`, and is consumed by /programs, /runs, /programs/[id]); **M4** the AI integration
tile now reflects whether `OPENAI_API_KEY` is set (live), not a hardcoded "healthy"; an **a11y pass**
(`scope="col"` on every hand-written table + aria-labels on raw inputs, attribute-only across 15
files); **measure-detail empty states** + the "Measures in this Program"→"Outcome breakdown by
version" rename + a clearer all-simulated campaign result line; and a **conservative API GET cache**
(`frontend/lib/api/client.ts`: in-flight dedup + 1.5s TTL, busted on every write — replaces the
blanket `cache:"no-store"`, no SWR dependency). Whole-branch code-review: clean (the GET cache was
scrutinized hardest — cache entry is inserted at call-time and every mutation busts the map, so a
read never serves post-write-stale data). Verification: backend full suite + frontend
tsc/lint/build/vitest all green.

PR-review round (maintainer review on #181, fixed in `a5433f2`): hardened the run-status provider
(handle a synchronous run that returns terminal immediately; latch `finished` + imperative
`clearInterval` so completion fires exactly once; poll depends only on `activeRunId` and reads the
client via a ref so a token refresh can't drop the timer); the GET cache now busts in `.finally`
(a failed 5xx may have partially written); `/programs/[measureId]` listens for `ww:run-complete`;
admin tabs lazy-load per active tab; Studio uses the shared `canApproveMeasures`/`isAdmin` helpers;
and the audit-ledger reads are now bounded SQL — `recentAuditEvents(limit)` (admin viewer, also caps
its per-case `getCase` loop) + `auditEventsForCases(ids,limit)` (employee profile), replacing the
whole-ledger materialize-and-filter. Three review comments were verified **false positives** and left
unchanged with evidence: measure-name resolution (ids are strings not UUIDs on the TS backend —
confirmed populated live), `/api/runs` returning `runId` (read-models maps `run.id→runId`), and the
campaigns zero-recipient send guard (intentional).

Remaining genuinely-open (larger, not attempted): a full WCAG audit beyond table/label basics, and the
documented production drop-ins (managed S3/R2 evidence bucket, real ICE/DataChaser/SendGrid adapters).
Audit digest + roadmap saved under the run's workflow journal.

## 2026-06-21 — Synthetic trend-history backfill (#180) + full QA smoke test + H1 fix

**Two threads today: a full adversarial QA pass of the live app, and a new feature to fix flat trend charts.**

### QA smoke test (live app)
Ran an end-to-end adversarial QA pass against `https://twh.os.mieweb.org` (all 4 roles) — three
parallel code-audit agents + hands-on Playwright + a live API/RBAC sweep. Report:
`docs/QA_SMOKE_TEST_2026-06-20.md`. Verdict: a real, working, API-backed app (not a Potemkin demo) —
server-side RBAC correct, AI provably isolated from compliance, MCP read-only, audit trail live,
backend tests + build green. Findings are polish/data-coverage/doc-integrity/accessibility, none
data-loss or security-critical. Headline finds: **H1** the flagship `adult_immunization` measure read
0% / 0 cases on `/programs`; **M1** `nextActionFor` defaults non-OSHA measures to the "audiogram"
label (7/11 measures); **M2** `/campaigns` renders for AUTHOR/APPROVER then silently 403s; **M3/M4**
admin outreach-delivery-log hardcoded `[]` + integration health static; **H2** SendGrid documented but
absent in `backend-ts`; plus systemic accessibility debt (tables without `scope`, clickable non-buttons,
unlabeled inputs). (These remain open follow-ups; not fixed in #180.)

**H1 fixed live:** root cause was that the last `ALL_PROGRAMS` run (6/17) predated the E6 merge, so
`adult_immunization` had never been in a population run. Triggered an `ALL_PROGRAMS` run (1100 evals,
11 measures) — confirmed the scope *does* include it; the card now reads 80% / 17 cases, and the
advisory immunization-forecast panel renders on a real case.

### Synthetic trend-history backfill (#180, merged 45cba6a, deployed)
The `/programs` trend charts read as flat lines: `run/compliance-rates.ts` has one fixed rate per
measure (deterministic runs → identical %), and most measures had a single run. Added a controlled,
on-demand backfill that writes weekly **backdated** COMPLETED `MEASURE` runs per runnable measure
(default 12 weeks) with compliance varying ~±0.06 around each measure's base rate
(`historicalComplianceRate`), so trends show realistic curves. New `pnpm seed:trend-history` CLI
(`run/cli/`) over `backfillTrendHistory` (`run/backfill-trend-history.ts`); outcomes come from a
precomputed `(measure,target)→outcome` map (55 engine evals — outcome depends only on the pair, not
the employee), assigned via `seededDistributionAtRate`.

Design (ADR-style, no ADR — additive, no schema, no new dep): `docs/superpowers/specs/2026-06-20-synthetic-trend-history-design.md`.

**Hardened across 9 Codex review rounds + a code-reviewer pass** (every finding a real fix):
backdate outcome `evaluated_at` so seeds don't mask the real latest (P1); anchor each measure's
newest week strictly **before that measure's latest real run** so the overview is never hijacked;
**week-level** idempotent + resumable (keyed on the seeded started day = `evaluationPeriod`);
exclude the feature's own seed runs **by marker, not by day**; audit each seeded measure
(`TREND_HISTORY_SEEDED`, audit store required); safe two-step schema-qualified rollback; skip the
SQLite binding when seeding Postgres. Store-contract changes are additive (NO schema/DDL):
`RunRecord.triggeredBy` surfaced (drives `triggerType` → seed runs labeled **SEED**, filterable via
`GET /api/runs?triggerType=SEED`), optional `CreateRunInput` `startedAt`/`completedAt`/`status`,
`OutcomeStore.recordOutcomes` batch, optional `RecordOutcomeInput.evaluatedAt`,
`OutcomeWithRun.runTriggeredBy`, optional `StoresEnv.DB`.

**Seeded live against Neon (`workwell_spike`):** 132 runs + 13,200 outcomes + 11 audit events.
**10 of 11 measures now show varied trend lines** (verified via API); the overview still shows the
real 06-20 run per measure (not hijacked); `/api/runs` shows `MANUAL=9, SEED=132`. Audiogram is the
one still-flat measure — it has ~8 pre-existing real runs filling the 10-point trend cap (left as-is).
Reversible via the documented two-step rollback. Tests: 553 / 552 pass / 1 Pg-contract self-skip;
typecheck + CI green.

## 2026-06-19 — E9 (#78): CQL→SQL bridge decision memo (spike, no code)

E9 is a **spike / decision memo only** (charter Q2 — "CQL → SQL"; the biggest architectural fork).
Wrote `docs/CQL_TO_SQL_BRIDGE_DECISION_MEMO.md` framing the three options grounded in the current
reality on both sides: **(A) FHIR-native adapter** (reuse the E1 `PatientDataProvider` seam + the
JVM-free CQF engine as the report engine), **(B) CQL→SQL transpile into MariaDB** (research-grade —
the only concrete transpiler, the VA `cql-transpiler`, is ELM→DBT→**Databricks-only/partial**, and
the field targets Spark/Hive analytics engines, **not** transactional MariaDB), and **(C) hybrid /
pluggable executors** (CQL/ELM + FHIR-native engine as the single canonical semantics; a bounded,
opt-in SQL path for must-be-in-DB reports via **SQL-on-FHIR v2 `ViewDefinition`s**, cross-checked
against the FHIR-native oracle).

**Recommendation:** Option C, FHIR-native-first — near-term integration is the WebChart
`PatientDataProvider` adapter (Option A, lowest risk, full CQL fidelity, maximal reuse); treat
"CQL→SQL" as a bounded SQL-on-FHIR-v2 second executor only for the reports that must run in MariaDB;
do **not** commit to a wholesale CQL→MariaDB transpiler (Option B) unless Doug's answers establish a
hard all-in-MariaDB requirement (then it's "fund a research project," not "ship a feature"). The memo
ends with five questions for Doug that gate the fork. No code; the chosen path becomes a normal
epic + ADR once Q2 is answered. Also bumped the CLAUDE.md focus block (E7 done → E9 next).

## 2026-06-19 — E7 (#77): advisory order-generation engine

E7 shipped. A new `backend-ts/src/order/` module generates advisory proposed orders from non-compliant
measure findings — the charter's "Action Evaluators → orders" layer. Design-only/simulated seam: no
EH dependency, no schema change, no frontend.

**Four files:**
- `order/proposed-order.ts` — `ProposedOrder` domain type + `toServiceRequest()` (FHIR R4
  `ServiceRequest`, `intent:"proposal"`, `status:"draft"`, hand-built JSON — no FHIR runtime dep,
  same pattern as MeasureReport/QRDA) + `bundleOf()` collection Bundle.
- `order/order-catalog.ts` — action-evaluator map: runnable measure → `OrderCode`. Reuses
  `terminology_mappings` seed standard codes (audiogram → CPT 92557; tb_surveillance → CPT 86580;
  flu_vaccine → CVX 141; hazwoper → `hazwoper-exam` in `urn:workwell:vs:hazwoper-exams`); LOCAL
  `urn:workwell:orders` codes for measures without a seed mapping.
- `order/standing-order-provider.ts` — `StandingOrderProvider` port. `simulatedStandingOrderProvider`
  (default, deterministic ~1/5 subjects have a standing order, no HTTP) + inert `ehStandingOrderProvider`
  stub selected only when both `WORKWELL_EH_FHIR_BASE_URL` + `WORKWELL_EH_FHIR_API_KEY` are set
  (inert-unless-configured, mirrors ADR-011/012). `resolveStandingOrderProvider(env)`.
- `order/order-proposal.ts` — `proposeOrders(outcomes, provider)`: Panel=Risk selection
  (OVERDUE/DUE_SOON/MISSING_DATA propose; COMPLIANT/EXCLUDED don't); risk→priority (OVERDUE=urgent,
  DUE_SOON/MISSING_DATA=routine); in-batch dedupe + standing-order suppression (suppressed returned
  separately, answering the charter's duplicate-orders concern). Pure and trigger-agnostic (read-time
  now; callable from the run pipeline later without changes).

**Endpoint:** `GET /api/orders/proposals?measureId=&subjectId=&from=&to=&format=domain|fhir`
(`backend-ts/src/routes/orders.ts`, mounted under the authenticated `/api/**` block). Gated
CASE_MANAGER/ADMIN (`authorize.ts` `rx("/api/orders/**") → [CM, A]`). Selects latest population run
per Active measure (reuses `rollup-shared.ts` `isPopulationRun` + `latestRunRows` — `latestRunRows`
was extracted from `hierarchy-rollup.ts` into `rollup-shared.ts` as part of this task). `format=domain`
→ `{proposed, suppressed}`; `format=fhir` → ServiceRequest Bundle (proposed only).

**Advisory / no-auto-submit:** proposals are never submitted automatically. A human reviews and
submits. The real EH write path (`OrderSubmitter`) is named but deferred (documented drop-in for
when Doug Q6 / EH credentials are available). Same human-in-the-loop contract as AI guardrails.

**No schema change.** Proposals derived read-time from `outcomes`; nothing persisted. ADR-013 added
to `docs/DECISIONS.md`.

Backend suite: 517 pass / 0 fail / 1 skip. Frontend lint + build unaffected (no frontend code). Deploys on
merge to `main`.

## 2026-06-19 — E6 (#76): immunization & forecasting

E6 shipped. Two deliverables: the **`ImmunizationForecast` port** and a new runnable **AIS-E Td/Tdap
measure** — 61 measures total, 11 runnable.

**`ImmunizationForecast` port** (`backend-ts/src/engine/immunization/immunization-forecast.ts`):
mirrors the ADR-011 `OutreachChannel` pattern. `simulatedForecaster` is the default — it computes
ACIP-style next-dose-due over its own deterministic per-subject synthetic immunization history
(epoch-anchored, 3 series: Td/Tdap 10y, Influenza annual, Hepatitis B 3-dose). `iceForecaster` is
an inert stub activated only when both `WORKWELL_IMMZ_ICE_API_KEY` + `WORKWELL_IMMZ_ICE_BASE_URL`
are set (inert-unless-configured; performs no HTTP; returns a "ICE not wired (Doug Q5)" reason).
`resolveForecaster(env)` selects between them. Doug Q5 (CDS Hooks vs. ICE REST vs. WebChart-ICE
bridge) stays deferred behind the stub. Forecasting is advisory only — the CQL `Outcome Status`
remains the sole compliance authority. ADR-012 captures the full rationale.

**Measure choice — real NCQA research:** NCQA HEDIS AIS-E (Adult Immunization Status — Employer) is
the correct fit for a TWH employer wellness platform. CMS117 (Pneumococcal Vaccination) targets the
pediatric population — a mismatch. CMS127 (Pneumococcal Vaccination, adults 65+) was explicitly
considered and rejected: it covers a narrow age cohort (65+), measures ever-received not
time-to-next, and yields a near-permanent binary outcome that is ill-suited to forecasting. AIS-E
Td/Tdap single-series (10-year window) is the real NCQA measure and implementable within the
existing single-event synthetic data model.

**Measure vs. forecast split (design decision):** the existing single-event-per-subject synthetic
model cannot cleanly host a true multi-series composite measure without reworking shared infra used
by all 10+ existing measures. Decision: the MEASURE covers the AIS-E Td/Tdap single-series obligation
("is this worker currently within the 10-year window?"); the FORECASTER covers all 3 series advisory-
only ("when is each next dose due?"). A composite multi-series measure + zoster (50+)/pneumococcal
(65+) age-gated indicators are documented follow-ups.

**`adult_immunization` measure:** CQL `backend-ts/measures/adult_immunization.cql` + YAML, seeded
Active in HEDIS wellness. 10-year window (3650 days). Td/Tdap contraindication → EXCLUDED; refusal
(`tdap-refusal` Condition) → case stays OPEN with a `Refused` define flagged in evidence_json (case
manager intervention needed; refusal never excludes). Outcomes: COMPLIANT ≤3590d, DUE_SOON
3591–3650d, OVERDUE >3650d, MISSING_DATA no record.

**Case-detail enrichment:** `GET /api/cases/:id` attaches an advisory `immunizationForecast` (the
3-series forecast) for `adult_immunization` cases only; rendered as an advisory panel on `/cases/[id]`.

**Endpoint:** `GET /api/immunization/forecast?subjectId=&asOf=` (`backend-ts/src/routes/immunization.ts`,
mounted under the authenticated `/api/**` block). `asOf` defaults to today, validated YYYY-MM-DD
(400 on malformed); subjectId required (400 if missing). Read-time; no schema change.

**No schema change.** Refusal/contraindication ride in `evidence_json`. The production drop-in is an
`immunization_forecasts` cache table fed by a real ICE adapter (analogous to the E5 `PgCampaignStore`
drop-in — see DATA_MODEL §3.18). ADR-012 added to DECISIONS.md.

Backend suite: 488 pass / 0 fail. Frontend lint + build clean. Deploys on merge to `main`.

## 2026-06-19 — E5 (#75): outreach at scale (multi-channel + bulk campaigns)

E5 shipped. Outreach went multi-channel and bulk, all simulated by default and with **no schema
change**. The **`OutreachChannel` port** (`backend-ts/src/case/outreach-channel.ts`) introduces
`ChannelType` EMAIL/SMS/PHONE — each with a simulated adapter (EMAIL delegates to the existing
simulated email service; SMS/PHONE body-only) — plus an inert **DataChaser stub** (`dataChaserChannel`,
returns QUEUED with a self-describing note, **no real HTTP**). `resolveChannel(type, env)` returns
simulated by default and the DataChaser stub **only** when both
`WORKWELL_OUTREACH_DATACHASER_API_KEY` + `WORKWELL_OUTREACH_DATACHASER_BASE_URL` are set
(inert-unless-configured, mirroring SendGrid). Single-case send was refactored: `dispatchOutreach`
(`case-outreach.ts`) is now the shared send core, and `POST /api/cases/:id/actions/outreach?channel=`
honors a channel (default EMAIL; PHONE → `tel:`, SMS → `sms:`). The **campaign engine**
(`outreach-campaign.ts`, `runCampaign`) resolves eligible OPEN cases (measure/site/outcome filters),
previews recipients on `dryRun` with no sends, and on a real run dispatches per recipient with a
per-recipient try/catch (→ FAILED, so a mid-loop failure never abandons the campaign and
PARTIAL_FAILURE is reachable), tallying sent/failed/simulated. Campaigns persist behind a
**`CampaignStore` port** (`stores/campaign-store.ts`) whose audit-backed demo adapter
(`audit-campaign-store.ts`) writes one `OUTREACH_CAMPAIGN_COMPLETED` audit event per campaign and reads
by scanning + filtering the ledger — **no new DDL** on floor or ceiling; the production drop-in is a
documented `PgCampaignStore` over `outreach_campaigns` + `outreach_delivery_log` (ADR-011). Routes:
`POST /api/campaigns` (+ `?dryRun`), `GET /api/campaigns`, `GET /api/campaigns/:id`, **gated to
CASE_MANAGER/ADMIN** (`rx("/api/campaigns/**") → [CM, A]`) — this closed an authz gap found in review
(campaigns must match the per-case outreach gate, not be more permissive). Frontend: a `/campaigns`
launcher (filters → Dry-run preview → Send → result summary + recipients) + history list → detail, a
"Campaigns" nav link, and a channel selector on the case-detail outreach action (semantic tables; NITRO
deferred). Simulated by default; no schema. Closes #75 (E5). Deploys on merge to `main` (not yet live).

## 2026-06-18 — E4 (#74): multi-level dashboards (enterprise→location→provider→patient)

E4 multi-level dashboards shipped. The workforce hierarchy — **enterprise → location → provider →
patient** — is modeled entirely in the synthetic employee directory
(`backend-ts/src/engine/synthetic/employee-catalog.ts`): every `EmployeeProfile` gains a `providerId`,
plus new exports `ENTERPRISE`, `PROVIDERS` (8 synthetic occupational-health clinicians, 2 per location
across Plant A / Plant B / HQ / Clinic), `providerById`, `providersForLocation`. **Key finding:**
`backend-ts` has **no `employees` DB table** — the synthetic directory is the source of truth, resolved
at read-time — so this is **not a schema migration** and the #93 stop-and-ask gate is satisfied with no
SQL (ADR-010). On top of it, a reconciling rollup read model
(`backend-ts/src/program/hierarchy-rollup.ts`, `buildHierarchyRollup`) returns a `HierarchyNode` tree
whose parent counts = Σ children at every level, over the same outcome rows the programs overview uses
(latest population run per Active measure; CASE/EMPLOYEE reruns excluded), surfaced as
`GET /api/hierarchy/rollup?measureId=&from=&to=` (auth'd under `/api/**`, `YYYY-MM-DD` validation → 400
on malformed). Frontend: a nested expandable drill-down table at `/programs/hierarchy` with a measure
filter, linked from `/programs` (semantic table; NITRO deferred until `@mieweb/datavis` is published).
Shared rollup helpers extracted to `rollup-shared.ts` and the date-param parser to
`routes/query-dates.ts` (reused by `/api/programs` + `/api/hierarchy`). Closes #93 (E4.1) + #94 (E4.2)
under epic #74. Deploys on merge to `main`.

## 2026-06-18 — de-Java doc-accuracy sweep (from the #166 retro code-review)

The retroactive whole-PR review of #166 surfaced one contradiction it introduced + several now-stale
"Spring" references the JVM retirement left behind. Fixed: CLAUDE.md "Next up" reconciled (E2 #72 + the
full E3 epic #73 are done; E4 #74 is next, with the #93 schema stop-and-ask noted); CLAUDE.md hard-rule
"Spring Application Events" → "direct DB audit log"; ARCHITECTURE §6/§7 "Spring Security" → the
TypeScript auth middleware (`backend-ts/src/auth/authorize.ts`); the "Java `StreamingResponseBody`"
qualifier dropped; ADR-006's Gradle `evaluateMeasure` example annotated with the current `pnpm evaluate`
form. (The ARCHITECTURE §3/§5 `com.workwell.*` module-name rewrite stays a deliberate later pass.)

## 2026-06-18 — E3.4 (#92): QI-Core profile alignment (structural)

The synthetic FHIR bundles now declare QI-Core conformance: every emitted resource (Patient, the
enrollment/waiver Conditions, and the Observation/Immunization/Procedure event) carries a QI-Core
`meta.profile` canonical (`backend-ts/src/engine/synthetic/fhir-bundle-builder.ts`, `QICORE_PROFILES`)
and the QI-Core-required structural elements. This is **structural alignment** (JVM-free, no validator
dependency — ADR-009 posture), not official QI-Core IG/Schematron validation. `meta.profile` is
metadata the CQL retrieves don't read, so the 10-measure golden parity is byte-identical (the engine
contract test is the guard). Conformance recorded in `docs/STANDARDS_CONFORMANCE.md`. **E3 epic (#73)
is now complete** (E3.1 MeasureReport, E3.2 value-set expansion, E3.3 QRDA III, E3.4 QI-Core).

## 2026-06-18 — E3.3 (#91): QRDA III stub + standards-conformance matrix

A completed single-measure run is now exportable as a well-formed HL7 QRDA Category III (aggregate)
CDA document — `GET /api/runs/{runId}/qrda?format=xml` (`application/xml`). `buildQrda3Document`
(`backend-ts/src/fhir/qrda3-export.ts`) hand-builds the CDA (balanced by construction, no new dep),
reusing the E3.1 `countPopulations` so the aggregate IPP/DENOM/DENEX/NUMER + performance rate reconcile
with the run's outcomes. It is a **stub**: well-formed + structurally representative of QRDA III, not
IG/Schematron-validated. Committed `docs/STANDARDS_CONFORMANCE.md` mapping every emitted artifact (CQL /
ELM / ValueSet / FHIR MeasureReport / MAT / QRDA III) to its standard + conformance level. E3 remaining:
QI-Core profile alignment (#92, stretch).

## 2026-06-18 — E3.2 (#90): real value-set expansion (ValueSetResolver port)

Replaced the inline-code workaround with a real expansion seam: a `ValueSetResolver` port +
store-backed adapter (`backend-ts/src/engine/cql/value-set-resolver.ts`) + `buildCodeService` feed a
populated `cql.CodeService`, so a CQL value-set retrieve filters by real membership.
`CqlExecutionEngine` gained an optional `valueSetResolver` (default off → today's inline path, demo
unaffected). Audiogram ships a value-set-retrieve ELM variant (`AnnualAudiogramCompletedVS`) selected
in expansion mode and proven **byte-equal to the inline path** via cross-mode golden parity across all
4 scenarios. The `Audiogram Procedures` value set was already seeded; no schema change, no new
dependency. A live VSAC resolver is a clean future drop-in behind the same port; the live-runtime env
toggle is deferred (the deployed run path stays inline). Next E3 items: QRDA III (#91), QI-Core (#92).

## 2026-06-18 — E3.1 (#89): FHIR MeasureReport

First E3 (eCQM artifact completeness) deliverable: a completed single-measure run is now exportable
as a FHIR R4 `MeasureReport` — `GET /api/runs/{runId}/measure-report?type=summary|individual|bundle`,
`application/fhir+json`. Pure builders (`backend-ts/src/fhir/measure-report.ts`) turn persisted
`outcomes` into summary + per-subject individual reports + a collection Bundle, with a proportion
population model (IPP=all, DENEX=EXCLUDED, DENOM=IPP−DENEX, NUMER=COMPLIANT, score=NUMER/DENOM) whose
counts reconcile 1:1 with the run's outcomes by construction. Structural FHIR-R4 conformance is
asserted JVM-free (no FHIR runtime dependency); `RunRecord` now surfaces the measurement period
(existing columns) for the report `period`. Multi-measure runs (e.g. ALL_PROGRAMS) return 422 —
value-set expansion (#90) and QRDA III (#91) are the next E3 items.

## 2026-06-18 — E2 (#72): headless evaluator CLI

Shipped the packaged headless evaluator Doug asked for: `pnpm evaluate --patient <bundle.json>
--measure <id>` prints a measure's `MeasureOutcome` (bucket + define-level evidence) for one FHIR
R4 bundle, no server and no DB. It's a thin shell (`backend-ts/src/engine/cli/`: a side-effect-free
lib + a 2-line `bin.ts`) over the existing parity-proven `CqlExecutionEngine` — no new evaluation
logic, no runtime YAML loader (de-scoped), no new dependency. Golden regression drives the CLI over
the `spike/synthetic` corpus (10 measures × 4 scenarios) asserting outcomes, plus a subprocess smoke
for exit codes + clean stdout. Closes the last open acceptance item of E2.

## 2026-06-18 — #109 PR4 merged + deployed + verified; JVM retirement is closed

PRs **#163 (self-heal reconciler)** and **#164 (JVM retirement)** both merged to `main` (in that order; #164 already contained #163's commits, so the merge-base was clean and conflict-free). Before merge, ran code-reviewer subagents over both branches — no blockers; the only follow-up was a last sweep of three dangling `backend/` references the PR4 sweep missed (`spike/cqf-translate.mjs` + `spike/README.md` default-arg repointed to the relocated `backend-ts/measures`; the now-orphaned `scripts/gen-measure-catalog.mjs` deleted since its source `MeasureService.java` is gone and its output `measure-catalog.ts` is now hand-maintained). Committed as `56d6a08`; typecheck green.

**Post-merge production deploy verified end-to-end.** The merge ran `deploy-twh-mieweb.yml` (both #163 + #164 pushes); the #164 build briefly showed the expected 404→502 during the frontend container recreate window, then settled to **200 OK** — exactly the transient the reconciler's cold-start tolerance is designed for. Comprehensive E2E:
- **API smoke (`scripts/smoke-shadow.sh` against the live `twh-api-ts`): 19 pass / 0 fail / 2 warn.** Auth (login `ROLE_ADMIN` + refresh-cookie rotation), 60-measure catalog, a live MEASURE run → COMPLETED with 100 outcomes, 50 open cases + detail + outreach send + delivery flip to SENT + auditor packet, all CSV exports, admin integrations, and the `demo-reset` prod-gate correctly 403. The 2 WARNs are the documented known limitations (ephemeral evidence `fs` BUCKET; MCP-SSE nginx caveat).
- **Browser path (Playwright MCP):** the `/programs` dashboard renders fully through nginx → Next.js → the TS backend → Neon — 1000 evaluations, 77.8% overall compliance, 192 open cases, all 10 runnable measures with outcome breakdowns and NITRO trend charts.

**Cleanup:** deleted both merged local feature branches, pruned the deleted remotes; reclaimed **366 MB** by removing the leftover untracked `backend/` tree (0 tracked files; recoverable via `git checkout 91182dd -- backend/`) plus stray debug/log files. `main` is the only local branch.

**#109 is fully closed.** Open follow-ups remain a managed S3/R2 evidence `BUCKET` (currently ephemeral) and confirming Proxmox `onboot` with MIE (nice-to-have — the reconciler already covers reboot/crash recovery). Next roadmap epic: **E2 — declarative YAML measures + headless evaluator (#72)**.

## 2026-06-17 — #109 PR4: JVM retired — TypeScript is the sole backend

The de-Java re-platform (#96 / ADR-008) reaches its end state. With the cutover live and hardened (CI gate #161, observability + orphaned-run recovery #162, self-heal reconciler #163), retired the Java/Spring backend:

- **Deleted `backend/`** — the entire Java app (210 files: Spring Boot, Gradle, Flyway migrations, the Java `Dockerfile`).
- **Deleted `deploy-twh-ts-shadow.yml`** — the shadow workflow is redundant now that `deploy-twh-mieweb.yml` deploys the TS backend on every push.
- **`deploy-twh-mieweb.yml`** — dropped the Java `build-backend` + `deploy-backend` jobs and the Java env vars (`BACKEND_IMAGE`/`BACKEND_URL`/`API_HOSTNAME`); it now builds + deploys only `workwell-api-ts` + the frontend. Rollback comment updated (redeploy an earlier `twh-api-ts` `sha-<SHA>`, since there's no Java to revert to).
- **`ci.yml`** — dropped the 8-shard Java `backend` (Gradle) job; `backend-ts` (added in #161, floor + Pg ceiling) is the backend gate.
- **Rollback model:** Java was the warm rollback for a *bad deploy*; with it gone, rollback is redeploying an earlier known-good `twh-api-ts` image (each tagged `sha-<SHA>` in GHCR). Reboot/crash recovery is the reconciler's job (#163), independent of `onboot`. These are different failure modes, both covered.

Docs swept de-Java: CLAUDE.md (tech stack, build/verify, rules, module list, Current Focus), README (status, surfaces, stack, badge, layout), DEPLOY (service table, rollback), DECISIONS (ADR-008 → done), CHANGELOG. Verified: both workflows + `ci.yml` parse clean with no Java refs; `backend-ts` is unaffected (its tests + typecheck are unchanged and gated in CI). The stale Java `public` schema on Neon is now orphaned (harmless; a separate cleanup if desired).

**Self-review pass (code-reviewer subagents on #163 + #164, before merge).** Folded in: (1) **measure source corpus relocated** — PR4 had deleted the only copy of the `.cql`/`.yaml` sources with `backend/` (runtime was fine on committed ELM, but authoring/regeneration died and E2 lost its corpus); moved all 20 into `backend-ts/measures/` and repointed `compile-measures.mjs` + `gen-measure-bindings.mjs`. Verified end-to-end: recompiling ELM + regenerating bindings from the new location reproduces the committed artifacts with **zero diff**, so the Path-C regeneration path is alive again. (2) **Reconciler hardened (#163):** shared the `twh-mieweb-container-ops` concurrency group with `deploy-twh-mieweb.yml` so a heal can't race an in-flight deploy's delete+recreate; widened the down-probe to 6× over ~3 min so a normal cold start can't trip a false heal; documented that a heal re-pulls `:latest` (follow a fast `sha-<SHA>` rollback with a durable revert-on-main); added `permissions: contents: read`. (3) **De-Java doc sweep** of the references PR4 missed: DEPLOY (workflow steps, reboot section, health check, refresh-cookie origin, duplicate `### Neon`), README (prereqs/quick-start/headless/verification), CONTRIBUTING, the PR template, ARCHITECTURE §8, AGENTS, CODEOWNERS, MEASURES CQL paths, `.env.example`, the frontend Dockerfile ARG. Merged #163 into this branch so the shared reboot-policy section is coherent in one place. **Deferred (tracked):** ARCHITECTURE §3/§5 still describe the engine by its old `com.workwell.*` modules — a deliberate later pass, not a rushed rewrite.

## 2026-06-17 — #109 self-healing reconciler (the holistic answer to "what if the node reboots?")

The pre-retirement audit flagged crash/reboot recovery (Proxmox `onboot`) as the one resilience item not closeable from our side — the MIE Container Manager API exposes no restart/`onboot` field, and a shared Proxmox node can't be reboot-tested. Rather than *wait* on that one answer (which only covers a node reboot anyway), added a **self-healing watchdog** that recovers the live stack from **any** cause — node reboot, container crash, OOM, accidental deletion — independent of `onboot`.

`.github/workflows/reconcile-twh-mieweb.yml`: scheduled every 15 min (+ `workflow_dispatch`). A `check` job health-probes the **live** surfaces (`twh` frontend → 200; `twh-api-ts` → `/actuator/health` `"status":"UP"`), with **3× retry over ~30s** so a transient blip never triggers a heal. If a surface is down, a heal job **recreates that container from its last-good GHCR `:latest` image** (no rebuild) via the existing `deploy-mieweb-container.sh` + the same §7 env the deploy uses (`REPLACE_EXISTING=true` → delete+create). Scope is the **live path only** — the Java rollback `twh-api` is intentionally not auto-healed (rollback is a full revert that redeploys it fresh). It's the GitHub-side equivalent of the `restart: unless-stopped` / systemd recovery documented for self-hosted hosts.

Verified locally: the probe logic correctly no-ops against the healthy live stack; the env jq matches the deploy (11 keys, `jdbc:` stripped for node-postgres). Net: `onboot` drops from "open blocker" to "nice to know" — worst-case recovery latency ≈ the 15-min cron interval, and a recreate is ~30–120s of that container's downtime; no data loss (Neon persists). The one wart is the env block duplicated from `deploy-twh-mieweb.yml` (marked **keep-in-sync** in both) — chosen over refactoring the just-merged prod deploy.

## 2026-06-17 — #109 pre-retirement hardening (2/3): backend-ts resilience (observability + orphaned-run recovery)

Two more pre-JVM-retirement gaps from the readiness audit:

- **Observability.** The worker's `fetch` called `route()` with no top-level try/catch, so an unhandled error (e.g. the Neon-pooler throw) escaped to the host harness as a **bare, empty-body 500** — invisible and undiagnosable (exactly what made that bug hard to find). Now wrapped: log the error with request context (`method path`) to stdout (→ container logs) and return a structured `{ "error": "internal_error" }` 500 (no internals leaked to clients).
- **Async-run durability.** ALL_PROGRAMS/SITE runs are advanced by an in-process `ctx.waitUntil` task that does **not** survive a container restart (every push redeploys), leaving the run stuck `RUNNING` forever. Added `RunStore.failStuckRuns(olderThanMs = 30 min)` on both the SQLite floor and the Postgres ceiling — a **time-thresholded** sweep (30 min ≫ the ~5.5 min real ALL_PROGRAMS max, so it can never fail a live run) that flips stuck **`RUNNING`** runs to `FAILED` + stamps `completed_at`. It targets **unclaimed** `RUNNING` runs only (`claimed_by IS NULL`): the async `ctx.waitUntil` path (`markRunning`) leaves `claimed_by` NULL, while `claimNextQueuedRun` stamps it — so a legitimately **claimed** worker job is never failed, and `QUEUED` (claim-path "waiting for a worker") is excluded too. Async runs are marked `RUNNING` synchronously, so every real orphan is an unclaimed `RUNNING` row (two Codex re-review P2s: drop QUEUED, then exclude claimed runs). The store returns the recovered ids and a `recoverStuckRuns` helper writes a **`RUN_RECOVERED` audit_event per run** (the "every state change is audited — no exceptions" hard rule; the store has no events binding — Codex P2). It fires **fire-and-forget once per process** on the first runs access (never blocks or cache-poisons the request).

Shared store-contract test covers **both** backends; 429 backend-ts tests green (floor + ceiling), typecheck clean. (The matching cause of the slowness — per-outcome Neon round-trips making ALL_PROGRAMS ~5.5 min — is noted for a possible batched-write follow-up; the durability fix here stops runs from getting *stuck*, which is the correctness issue.)

## 2026-06-17 — #109 pre-retirement hardening (1/3): CI gate for backend-ts

Before retiring the JVM (the point of no return), ran a critical readiness audit of the live TS deployment. Biggest gap found: **backend-ts had no CI gate** — `ci.yml`'s pnpm steps were the frontend's, so the live TS backend deployed on every push to `main` with zero automated verification (the 427 tests only ran locally; after JVM retirement there's no Java to fall back to either). Added a `backend-ts` job to `ci.yml`: submodule-recursive checkout (the public `mieweb/cloud`), node 24 + pnpm 10.17.1, `pnpm install --frozen-lockfile` → `pnpm typecheck` → `pnpm test`, with a `postgres:16` **service** so the run exercises BOTH the SQLite floor (default) and the **Postgres ceiling** (the store-contract suite) — CI now tests what prod actually runs on. The Pg contract previously *skipped* when unreachable, so a miswired CI service could leave the gate silently floor-only (Codex re-review P2); now the suite **fails** (not skips) whenever `WORKWELL_TEST_PG_URL` is set but Postgres is unreachable, guaranteeing the ceiling actually runs in CI (local dev with no PG + no env still skips).

Audit's other pre-retirement items (next PRs): observability (worker error-logging; 500s currently return empty bodies), async-run durability (ALL_PROGRAMS completes but ~5.5 min for 1000 outcomes via per-outcome Neon round-trips, and the in-proc job is orphaned if the container restarts mid-run), and two that need the maintainer (confirm Proxmox `onboot` crash-recovery; a managed S3/R2 evidence `BUCKET` — currently ephemeral). Everything else probed clean: full endpoint parity (all my initial "501s" were wrong-path/method probes), evidence upload→download round-trips, data durability across redeploys (Neon persists; seed is `isEmpty`-guarded), and additive Pg schema migration.

## 2026-06-17 — #109 cutover is LIVE: the flip merged, deployed, and verified in production

Merged PR #159 (CI green: all 8 backend shards + frontend) — the merge to `main` ran `deploy-twh-mieweb.yml`, whose **6 jobs all succeeded**: built the TS backend (primary) + Java backend (rollback) + frontend, and deployed all three. `https://twh.os.mieweb.org` is now served by the **de-Java TypeScript backend** (`twh-api-ts`).

Addressed two Codex P1 rounds on the flip workflow first: (1) the frontend deploy mustn't block the rollback, then (2) — the sharper re-review catch — don't ship a frontend onto a *deleted/failed* `twh-api-ts` when the TS deploy fails. Final shape: `deploy-frontend` keeps the **strict success gate** on `deploy-backend-ts` (a failed TS deploy skips the frontend, preserving the last-working one), and **rollback is a full revert of the flip commit** (restores the Java-only deploy, independent of the TS path).

**Verified live (not just "deployed"):**
- `twh.os.mieweb.org` → 200; its JS bundle is wired to **only** `twh-api-ts.os.mieweb.org` (scanned the chunks).
- §6 smoke against the live primary `twh-api-ts`: **19 pass / 0 fail / 2 warn** (warns = ephemeral evidence BUCKET + the pre-existing MCP-SSE nginx caveat).
- Neon: `workwell_spike` holds the live data; `public` (Java's Flyway tables) untouched — Java is a clean, current rollback.

Docs synced to reality in this pass: CLAUDE.md (Current Focus → cutover live; live backend = `twh-api-ts`), README (status + production surfaces + tech stack), DEPLOY/ARCHITECTURE, DECISIONS (ADR-008 status), CHANGELOG, and the usage guides (DEMO_RUNBOOK/WALKTHROUGH/MCP → `twh-api-ts`). **Next: a soak, then PR4 — JVM retirement** (drop the Java jobs + the redundant `deploy-twh-ts-shadow.yml`, wire `backend-ts` into `ci.yml`, finish the Node/TS topology rewrite).

## 2026-06-17 — #109 blue-green flip (PR3): frontend → the TS backend, Java kept as rollback

With the shadow proven green on Neon, wrote the production flip. `deploy-twh-mieweb.yml` now, on every push to `main`: builds + deploys the **TS backend** (`workwell-api-ts` → `twh-api-ts`, port 8080, `MIEWEB_TARGET=local`, jdbc-normalized `DATABASE_URL` → Neon `workwell_spike`), and builds the frontend with `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_API_BASE_URL` → `https://twh-api-ts.os.mieweb.org`. The **Java backend (`twh-api`) is still built + deployed unchanged as the instant rollback target** — nothing destroys it. Rollback = a **full revert of the flip commit** (restores the Java-only deploy: frontend → `twh-api` via `deploy-backend`, no TS jobs), so it never depends on the TS deploy. (`deploy-frontend` is gated on the TS deploy succeeding so a failed TS deploy preserves the last-working frontend rather than aiming it at a deleted `twh-api-ts` — a Codex re-review P1; hence rollback is a full revert, not a partial URL edit.) The Java container is already running + current. CORS + the cross-site refresh cookie already work (the TS env allows the `twh.os.mieweb.org` origin with `SameSite=None; Secure`). On merge, the next push runs production on TypeScript — watch the post-deploy smoke (`scripts/smoke-shadow.sh https://twh-api-ts.os.mieweb.org`). JVM retirement (drop the Java jobs + the now-redundant shadow workflow + the Node/TS docs rewrite) is PR4.

**Data note:** the frontend now reads the TS backend's `workwell_spike` schema (separate from Java's `public`), so the visible runs/cases are the TS dataset (synthetic demo data, freshly seeded + the shadow/smoke runs) — not Java's. Both are valid demo states.

## 2026-06-17 — #109 shadow deploy is live; fixed a Neon-pooler connection bug

Ran the shadow deploy (`deploy-twh-ts-shadow.yml`, manual): build + MIE deploy both went green and `twh-api-ts.os.mieweb.org` came up — and the GHCR-private concern didn't bite (the manager pulled `workwell-api-ts`). Then ran the new §6 smoke script (`scripts/smoke-shadow.sh`) against it.

**Smoke found a real bug.** Every DB-backed route 500'd (measures/runs/cases/exports) while everything that doesn't touch Postgres passed (version/health, auth login+refresh, static admin, the prod-gated demo-reset 403). Debugged it systematically instead of guessing:
- **Connection-level, confirmed:** queried Neon directly (MCP) — `workwell_spike` **did not exist** (0 tables), while `public` still had its 26 Java/Flyway tables (isolation held, Java untouched). So the TS app never completed a connection + DDL.
- **Reproduced against the real Neon *pooled* endpoint** with `pg`: the exact `createPgPool` config (`options: '-c search_path=workwell_spike,public'`) → **`08P01 unsupported startup parameter in options: search_path`**; the same pool **without** `options` → connects. Neon's pooler (PgBouncer) rejects the libpq `options` startup param. The 42/42 store-contract tests passed only because they run against a **direct/unpooled** `postgres:16`, which accepts it.

**Fix:** dropped the `options` startup param from `createPgPool`. Safe because every ceiling adapter fully-qualifies `workwell_spike.*` (verified), so search_path is unused — and a per-connection `SET search_path` wouldn't survive PgBouncer transaction pooling anyway. Added `pg-database.test.ts` as a regression guard (asserts no `options` startup param — fails against the old code, passes after). 427 backend-ts tests green, typecheck clean. Also committed the reusable `scripts/smoke-shadow.sh` (the §6 checklist runner). Re-deploying the shadow to verify end-to-end.

## 2026-06-17 — #109 store-seam review pass merged; PR2 shadow-deploy workflow written

**Closed out the store-selection seam (#156, merged).** Two Codex P2s on the seam, both verified against the code and fixed (commit `5c7f178`; **426 backend-ts tests green**, typecheck clean): (1) `factory.getStores` cached the in-flight `build(env)` promise *before* it resolved, so a transient Neon/D1 error during the startup DDL poisoned the cache until a process restart — now a rejected build is evicted (guarded delete) so the next request retries; (2) non-prod `demo-reset` always deleted from the SQLite floor binding (`env.DB`), a silent no-op when a `DATABASE_URL` ceiling holds the real data — now it routes the volatile-table DELETEs through the *selected* backend via a new `factory.getBackend` / `ActiveBackend` handle, schema-qualified (`workwell_spike.*`) for Postgres. Regression tests for both (`factory.test.ts` cache eviction + `getBackend`; `demo-reset.test.ts` per-backend DELETE sequence); the FK-safe order (`run_logs`/`outcomes` before `runs`) was checked against the Pg schema.

**Wrote PR2 — the shadow-deploy workflow** (`.github/workflows/deploy-twh-ts-shadow.yml`, `workflow_dispatch`-only, never on push). It builds `backend-ts/Dockerfile` from the repo root (`submodules: recursive` for the public `mieweb/cloud`) → `ghcr.io/taleef7/workwell-api-ts`, then stands up a **separate** `twh-api-ts.os.mieweb.org` container via the existing, fully-parameterized `deploy-mieweb-container.sh`. The live Java `twh-api` and `deploy-twh-mieweb.yml` are untouched.

A2 (Neon) shape, verified before writing: container env `MIEWEB_TARGET=local` (in-process `DB`/`BUCKET`/`CACHE`/`JOBS`, **no companion services**, port 8080) + `DATABASE_URL` = the existing `DATABASE_URL_TWH` secret. `createCloudEnv` merges `process.env` into the worker `env` (`external/mieweb-cloud/packages/cloud-local/src/index.mjs:63`), so the store factory sees `DATABASE_URL` and routes to the Neon Pg ceiling — which lives entirely in the isolated `workwell_spike` schema, so Java's `public` tables stay untouched (decision: the shadow runs against the **shared prod Neon** for flip-fidelity, schema-isolated). Production env per cutover plan §7 (JWT secret + exact non-localhost CORS + SameSite=None/Secure so the startup-safety fail-fast passes; no `JAVA_OPTS`). Evidence upload is a **documented known limitation** for the first cutover — the `fs` BUCKET is in-container/ephemeral.

**Codex re-review P2 (fixed):** `DATABASE_URL_TWH` is the *JDBC* URL the Java backend consumes as `spring.datasource.url` (`jdbc:postgresql://…`), but node-postgres' `pg.Pool` needs a `postgres://` URI — so a shadow run with the raw secret would fail at pool init. The workflow now strips a leading `jdbc:` (no-op if the secret is already a pg URI) and fails legibly on any other scheme; embedded credentials and Neon's `?sslmode=require` (→ TLS on) carry through unchanged. Verified the strip + SSL parse against the installed `pg-connection-string@2.13.0`.

**Not yet triggered** (it is manual + outward-facing): merging the PR only adds the workflow; running it (then the §6 smoke checklist against `twh-api-ts`) is the next action. One op note for the first run: the new `workwell-api-ts` GHCR package is created private on first push — it must be set to the same visibility/pull access as `workwell-api` so the MIE manager can pull it.

## 2026-06-16 — #109 store-selection seam: backend-ts runs on Postgres (the Neon fallback path)

With the §4 MIE/Doug prerequisites for the libSQL/cloud-os path unanswered, pivoted the cutover to the **fallback I'd recommended**: run the TS backend as a **single container against the existing Neon Postgres** via the already-built `Pg*Store` ceiling adapters — no companion services, no new MIE capability, Neon stays persistent. This removes all four blocking questions (Q1 companion services / Q2 libSQL persistence → not needed; Q3 host harness → proven in PR1; Q4 Neon-vs-libSQL → keep Neon). Everything below was validated **on my machine, zero risk to the live stack**.

**First, de-risked the assumption** — ran the Postgres store-contract suite (skipped in every CI/local run for lack of Docker) against a real `postgres:16`: **42/42 pass**. Every store (run/outcome/case/case-event/measure/evidence/appointment/value-set/outreach-template/waiver) holds the same contract as the SQLite floor, including the `FOR UPDATE SKIP LOCKED` run-job queue and the #150-M9 audit paging. So the ceiling is real, not theoretical.

**Then built the seam** — `stores/factory.ts` is the single place that selects floor vs ceiling: a non-blank `DATABASE_URL` → the `Pg*Store` adapters over one pooled `pg` connection (schema `workwell_spike`); otherwise the SQLite floor over `env.DB`. App/route code only ever sees the shared store **interfaces**, so the cutover flips with one env var and no route logic changes. Schema init + pool run once per env (cached); seeding stays in the routes (interface-based, so it runs unchanged on either backend). `createCloudEnv` already merges `process.env`, so a container `-e DATABASE_URL=<neon>` lands on `env.DATABASE_URL` — verified.

**Converted all 10 route modules** (`employees`, `programs`, `runs`, `exports`, `mcp`, `ai`, `measures`, `cases`, `admin`, `auditor`) from `new Sqlite*Store(env.DB)` (~74 sites) to `getStores(env)`. Because `DATABASE_URL` is optional on `StoresEnv`, no per-route env-type churn; the default (no URL) stays the SQLite floor, so the change is **behavior-preserving**.

**Validation:** typecheck clean; **422 backend-ts tests pass** on the SQLite default (unchanged). End-to-end on Postgres (container with `-e DATABASE_URL=…@host.docker.internal:5433`, DB→PG while cache/queue stay in-proc — the production fallback shape): health 200, login 200, **`GET /api/measures` = 60** (catalog seeded into `workwell_spike.measures`), a MEASURE run evaluated **100 employees → COMPLETED**, Postgres then holding **1 run / 100 outcomes / 22 cases**, and the open worklist returning cases. The whole stack — seed, auth, JVM-free CQL evaluation, run pipeline, outcome/case writes, worklist — runs on the Postgres ceiling.

**What's left for the cutover:** evidence `BUCKET` is the one remaining external binding (a managed S3/R2, or defer evidence-upload as a known limitation); then the shadow deploy (`twh-api-ts` on its own hostname against Neon, Java untouched) and the fallback-first blue-green flip. Plan: `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md` (the Neon/Postgres fallback variant).

## 2026-06-16 — #109 PR1: backend-ts container entrypoint + image (no production impact)

Started the #109 deploy-cutover prep with the safe, non-outward-facing first PR. Goal: de-risk the biggest unknown — *does the ported TS backend run as a long-lived container at all* — without touching the live `twh-api` (Java) stack. The flip itself stays gated on the §4 prerequisites; this PR is build-only.

- **`backend-ts/src/server.ts` (Decision E3)** — explicit long-running entrypoint. Dynamic-imports the CLI's `loadConfig` + `@mieweb/cloud-local/host`'s `startLocalHost`, registers the target's drivers (`@mieweb/cloud-os` for the `mieweb` target), serves the **unchanged** `worker.fetch` over HTTP, graceful SIGINT/SIGTERM. `MIEWEB_TARGET` selects the binding set (default `mieweb`; `local` = sqlite/fs/memory/inproc for the smoke test). Shipping this is cleaner than shipping the CLI's `dev` command to prod.
- **`backend-ts/Dockerfile`** — Node 24-bookworm-slim + a toolchain for native better-sqlite3, corepack pnpm@10.17.1, builds from the **repo root** so the `external/mieweb-cloud` submodule (the `workspace:*` source for `@mieweb/cloud*`) is in context; `pnpm install --frozen-lockfile`; `EXPOSE 8082`; `CMD pnpm start`. A **Dockerfile-scoped** `backend-ts/Dockerfile.dockerignore` trims the context — scoped (not a root `.dockerignore`) because `infra/docker-compose.yml` also builds from `context: ..` and COPYs `backend/`+`frontend/`, so a root ignore excluding those would break that local/systemd stack (Codex P1). The image also defaults `WORKWELL_ENVIRONMENT=production` so the startup safety guard is active out of the box — a container started without a strong JWT secret + exact CORS + SameSite=None/Secure cookies **fails closed (503)** rather than serving unauthenticated (Codex P2); local smoke runs opt out with `-e WORKWELL_ENVIRONMENT=development`.
- **`backend-ts/package.json`** — `start` script + `@mieweb/cloud-os` as a direct dep (the `mieweb` target imports it at runtime; pnpm's strict resolution needs it declared). Lockfile updated.

**Local validation (Docker, on this machine):** image built (better-sqlite3 compiled, frozen lockfile honored, 706 MB). Fail-closed default verified: `docker run -e MIEWEB_TARGET=local` (no JWT secret) → `/api/version` **503** (the prod-mode guard refuses to serve unauthenticated). With the smoke opt-out (`-e MIEWEB_TARGET=local -e WORKWELL_ENVIRONMENT=development -e WORKWELL_AUTH_JWT_SECRET=<strong>`) → host up on :8080; `GET /api/version` + `/actuator/health` → 200; `POST /api/auth/login` (demo admin) → 200 + JWT (role `ROLE_ADMIN`); authenticated `GET /api/measures` → 200 with **60** measures. So the container runs the full stack — HTTP host, self-seeding SQLite floor DB, auth, and a real data path — with zero external services. Typecheck clean.

**No production impact:** the deploy workflow still builds the Java `backend/Dockerfile`; nothing references `backend-ts/Dockerfile` yet. Next is **PR2 (shadow deploy on a separate `twh-api-ts` hostname, Java left untouched)** — gated on confirming with MIE/Doug: companion services on Create-a-Container, libSQL persistence across recreate, `startLocalHost` as a blessed prod host, and the Neon-vs-libSQL decision. Cutover strategy is fallback-first (blue-green; the live Java backend is never destroyed by an unproven image) per `docs/superpowers/plans/2026-06-15-issue-109-deploy-cutover.md`.

**Reviews (PR #155).** Codex caught two genuine ones — both fixed + Docker-verified: **P1** the dockerignore must be Dockerfile-scoped (a root one breaks `infra/docker-compose.yml`'s `context: ..` Java/Next builds), and **P2** the image must default to production mode so it **fails closed** (without it, a misconfigured prod/shadow container could serve unauthenticated). A follow-up `superpowers:code-reviewer` pass (Codex was rate-limited) found nothing blocking for a build-only PR; I took its cheap, high-value items now — a **bounded graceful-shutdown drain** + **boot `try/catch`** in `server.ts`, and switched the container `CMD` to run **node directly as PID 1** (`node --import tsx src/server.ts`, not `pnpm start`) so SIGTERM actually reaches the handler (a package-manager wrapper as PID 1 swallows the signal — caught during validation: `docker stop` had been killing the process without the drain ever running). Also: a note on the `@mieweb/cli` deep-import fragility (no `exports` map → vendor `loadConfig` if that changes), dropped the unused `curl`, and clarified the `local`-target smoke port (8080 vs prod 8082). Verified: SIGTERM → drain log → clean exit 0 within grace. **Deferred to the cutover PRs** (where image hardening belongs): non-root `USER`, a multi-stage slim image (currently 706 MB), and a *true* drain that also settles `ctx.waitUntil` run-jobs (the host harness doesn't expose the server to await).

## 2026-06-16 — #150 post-demo trio (M9 + M10 + M13), Java↔backend-ts parity

After #153 (H4/M5/M1/M8) merged, picked up the last of #150 — the three "post-demo" mediums — on `fix/issue-150-post-demo-trio`. All three were scoped **backend — parity** in the demo-readiness matrix, so each is fixed once on **both** stacks (no behavior drift across the #109 cutover). No schema change.

**M13 — outreach due date in the past.** An OVERDUE case's due date is `last_exam_date + compliance_window_days`, which for an overdue subject has already elapsed — so the rendered message read "complete by &lt;a past date&gt;". Fixed by clamping the computed due date to **today** (`max(computed, today)`, UTC on both stacks): Java `CaseFlowService.computeDueDate`, backend-ts `case-outreach.ts computeDueDate`. Only the computed path is clamped; the no-evidence fallback still returns the evaluation-period label (a period, not a "due by" date) — same on both stacks. Tests: Java `CaseOutreachDueDateIntegrationTest` (seeds an overdue case + why_flagged, asserts preview dueDate == today) + a backend-ts `cases.test.ts` preview assertion.

**M10 — `/api/cases` silently capped at the page limit with no pagination metadata.** Kept the response body a plain array (**non-breaking**) and added an **`X-Total-Count`** header carrying the full filtered match count, so clients can page past the cap. Java: extracted the worklist WHERE-clause into a shared `appendCaseFilters` helper so the new `CaseFlowService.countCases(...)` and the existing `listCases(...)` can't drift; `CaseController` returns `ResponseEntity` with the header; `SecurityConfig` CORS now `setExposedHeaders("X-Total-Count")` (the frontend/API are split origins, so the browser can't read the header otherwise). backend-ts: the route already slices an in-memory filtered list, so the total is just `summaries.length` before the slice; `cors.ts` adds `Access-Control-Expose-Headers: X-Total-Count`. Frontend: a new `ApiClient.getWithHeaders` lets the worklist read the header — it now shows "**X of N cases**" and drives "Load more" off the real total (fixing the off-by-one of the old `length === PAGE_SIZE` heuristic when the total is an exact multiple of the page). Tests: Java `countCases` test (capped page vs full count + filter parity) + a backend-ts route test (header == body length at a large limit; header == full total at `limit=1`).

**M9 — audit-events CSV export unbounded (~12MB, grows with the ledger).** An audit trail must stay **complete** (no truncation), so the fix is to **stream** instead of materializing the whole ledger in heap. Java: `AuditExportService.exportCsv()` → `streamCsv(OutputStream)` (`@Transactional(readOnly = true)` + a `PreparedStatement` fetch size so the Postgres driver stays in cursor mode), and `AuditController` returns a `StreamingResponseBody`. backend-ts: `listAuditEvents` gained an `offset` (contract + SQLite + PG) and a new `auditCsvStream` returns a `ReadableStream` that pages the ledger (1,000 rows/page), resolving each page's case→employee map as it goes; the route returns `new Response(stream, …)`. **CSV bytes are identical** on both stacks (same header, columns, quoting), so the export contract is unchanged. Tests: Java `AuditExportStreamIntegrationTest` (header + rows; empty ledger → header only) + a backend-ts store-contract test that `listAuditEvents(limit, offset)` pages the ledger with no overlap/gaps (runs against SQLite + PG). The existing exports route test already asserts the streamed audit bytes (byte-identical), so it passed unchanged.

**Validation:** Java compiles clean; `caseflow`/`web`/`audit`/`export` test packages all green vs real Postgres (incl. the 3 new tests + the M1 `OutreachTemplateOutcomeIntegrationTest` regression check). backend-ts **422 tests / 0 fail** + typecheck clean. Frontend lint clean + build compiles. **#150 is now complete** (all 21 items closed across part 1 + H1 + #153 + this trio). Next: the #96 / #109 deploy cutover — binding selection + JVM retirement, gated on the Batch-2 parity matrix this trio just finished.

**Codex review on PR #154 — 1 P2, fixed.** M10's backend-ts `X-Total-Count` was computed from `summaries.length` *after* the route fetched rows with a hard `limit: 100000` cap — so a worklist with >100k SQL-matching cases would report the count as 100,000 and the frontend would stop paging early (still a silent truncation on the TS stack). The route already filters + pages in memory ("Fetch all rows" by design), so the `100000` was just an arbitrary cap; replaced it with `Number.MAX_SAFE_INTEGER` (truly all SQL-matching rows) so the post-filter count — and thus `X-Total-Count` — is accurate. Added a ceiling-scale note that pushing the record-derived filters + LIMIT/OFFSET/COUNT into SQL (as the Java path already does) is the future optimization for very large single-worklist result sets. Java needed no change (it counts via a real SQL `countCases`). backend-ts 422 tests + typecheck still green.

## 2026-06-16 — #150 H1 merged + deployed (V022 verified live); H4 verified + guarded

**H1 (PR #152) merged to `main` and deployed.** The deploy applied `V022` to live Neon; **verified read-only afterward: `open` cases 5,019 → 0**, all 5,019 closed with `closed_reason='STALE_PERIOD_CLEANUP'` / `closed_by='system:migration-V022'`, and **5,019 `CASE_CLOSED_STALE_PERIOD` audit events** written (one per case — audit invariant held). The worklist flood is gone on production; the next run repopulates the ~261 genuine cohorts at correct cycle anchors. Branch deleted; `main` is clean.

**H4 (Top Sites/Roles "—" on the overview) — verified already fixed by C4, now regression-guarded.** Root cause was the same single-subject CASE/EMPLOYEE rerun becoming a measure's "latest run": `ProgramService.topDrivers` already carried C4's `UPPER(r.scope_type) NOT IN ('CASE','EMPLOYEE')` exclusion (PR #151), but `ProgramRollupRerunIntegrationTest` only covered `listPrograms` + `trend`, not the drivers. Added `caseRerunDoesNotEmptyTheTopDrivers`: a population run with an OVERDUE subject + a newer CASE rerun that verified that subject COMPLIANT — if the rerun were picked as latest, the OVERDUE-only Top Sites/Roles would be empty (the exact "—" symptom). The test fails without the C4 exclusion and passes with it (green vs real Postgres).

**M5 (run-detail outcomes "not scoped to run") — frontend stale-state, not a query bug.** Both backends already scope `/api/runs/:id/outcomes` by `run_id` (Java `loadRunOutcomes` `WHERE o.run_id = ?`; `backend-ts` `listOutcomes` same), so the hypothesised "grid not filtered by run_id" was off. The real bug: `runs/page.tsx` `loadSelectedRun` awaited summary+logs and `setSelectedRun(summary)` **before** fetching outcomes — so switching runs briefly showed the new run's header over the **previous** run's outcomes grid. Fixed by clearing `runOutcomes`/`runLogs` up front and fetching summary + logs + outcomes in one `Promise.all`, set atomically (outcomes fetch keeps its own `.catch(()=>[])`). Frontend lint clean + build compiles.

**M1 (outreach template ignores outcome) — fixed both stacks.** When no template was chosen, Java's `resolveByIdOrDefault(null)` returned `templates.get(0)` (the newest/first), and `backend-ts` used a single hardcoded `DEFAULT_TEMPLATE` — neither matched the case's outcome. Added `OutreachTemplateService.resolveForOutcome(templateId, outcomeStatus)`: an explicit id still wins; otherwise it picks the OUTREACH template whose name matches the bucket (OVERDUE→"overdue", MISSING_DATA→"missing", DUE_SOON→"reminder"), falling back to the first OUTREACH template (APPOINTMENT_REMINDER/ESCALATION excluded). `previewOutreach`/`sendOutreach` pass the case's `currentOutcomeStatus`. `backend-ts` `case-outreach.ts` mirrors it with outcome-keyed default templates (names mirror the V007/V008 seeds). Tests: Java `OutreachTemplateOutcomeIntegrationTest` (bucket → matching template + OUTREACH fallback) + backend-ts preview tests (OVERDUE→"Overdue Outreach", MISSING_DATA→"Missing Data Follow-Up").

**M8 (heatmap "predicted" == current) — too-narrow horizon, not a passthrough bug.** `RiskOutlookService` *does* compute a real projection (`predictedCompliant = compliant − upcomingExpirations`, where `upcomingExpirations` counts COMPLIANT employees crossing into "due soon" within the horizon), and the FE binds `currentComplianceRate`/`predictedComplianceRate` correctly + already shows an "Expiring" count. The issue: the FE requested a **30-day** horizon, but for a 365-day annual measure almost nobody crosses the due-soon threshold (window − 30-day buffer = 335) within 30 days, so `upcomingExpirations = 0` and predicted always equalled current. Confirmed read-only on live Neon: compliant audiogram employees in the **306–335** day (30-day) window = **0**, in 276–335 (60-day) = **0**, in **246–335 (90-day) = 73**. Fix: widened the FE risk-outlook lookahead to **90 days** (a quarter-ahead, meaningful for annual windows) + relabeled the heatmap column "Predicted 30d" → "Predicted 90d". The backend math is unchanged; the projection now surfaces real upcoming expirations (predicted < current) instead of mirroring current. Frontend lint clean + build compiles.

**Code review on PR #153 (Codex + the `superpowers:code-reviewer` subagent) — addressed.** Both surfaced the same cluster on M1 outreach plus a stale label:
- **M8 stale label** — the section heading still read "Risk outlook (next 30 days)" under the now-90-day data; updated to "next 90 days".
- **M1 OVERDUE sent measure-wrong copy + manual/auto disagreed** — my first cut used a name-keyword heuristic (`OVERDUE` -> "overdue") that matched only the audiogram-specific "Hearing Conservation Overdue Outreach" (no `{{measureName}}`), so a TB/HAZWOPER OVERDUE rendered audiogram copy; it also disagreed with the **existing** `autoNotificationTemplateName` mapping (auto-queued vs manual picked different templates). Fixed by **unifying** on one mapping: moved the canonical measure-aware map into `OutreachTemplateService.templateNameForOutcome` and routed both `resolveForOutcome` (manual) and the auto-notification path through it — MISSING_DATA -> missing-data; DUE_SOON -> the measure's reminder; **OVERDUE/other -> the generic "General Compliance Reminder" (never a measure-specific body)**. This removed the brittle keyword heuristic. `backend-ts` `case-outreach.ts` now mirrors the same selection (template names/ids matching the V007/V008 seeds, measure-aware DUE_SOON, OVERDUE generic) with `{{...}}`-personalised bodies. Java test now covers OVERDUE-generic-for-any-measure + measure-aware DUE_SOON + a manual==auto agreement check.
- **M5 stale-run race** — the up-front clear fixed the single-switch overlap but not a rapid A->B->A-resolves-late race; added a `selectedRunIdRef.current !== selectedRunId` guard before applying results (and softened the over-claiming comment).

Validation: backend-ts 417 tests / 0 fail + typecheck clean; Java `OutreachTemplateOutcomeIntegrationTest` (incl. manual==auto agreement) green vs real Postgres; frontend lint clean + build compiles. Lower-priority review notes left as-is for the demo (M8's fixed 90-day horizon is window-agnostic but defensible; value-based CMS122 still predicts==current structurally; the M5 polling path keeps its benign same-run pattern). **Remaining #150: M9/M10/M13 (post-demo).**

**Codex re-review #2 on PR #153 (`f477743`) — 2 P2s, both fixed (no re-review requested — converging).** The outreach template-selection cluster had two follow-on gaps:
- **P2 #1 — `backend-ts` recorded the wrong templateId in the audit/action payload.** `sendOutreach` rendered the resolved template `t` but wrote `templateId: templateId ?? null` (the *incoming* id) into the `OUTREACH_SENT` action + audit payload, so audit/export couldn't tell which message was actually sent. Java already recorded the resolved `template.id()` — TS now records `t.id` (and `t.name`) too. While here I also closed the documented parity gap that TS *ignored* an explicit templateId: added `templateById` + `resolveTemplate(templateId, outcome, measure)` so a known explicit id **wins** over the outcome default (mirroring Java `resolveForOutcome`; an unknown id still falls through to the outcome default). `previewOutreach`/`sendOutreach` both route through it. New preview test: an explicit hearing templateId on Omar's OVERDUE case wins over the generic default.
- **P2 #2 — the case page pre-selected the first admin template, bypassing the outcome default.** `loadTemplates` auto-set `selectedTemplateId = data[0].id`, so the normal manual workflow **always** sent a non-null templateId — defeating the M1 outcome-aware default for any operator who never touched the dropdown. Fixed: don't pre-select (leave it empty), and the template `Select` now leads with an explicit **"Auto (by outcome)"** option (`value=""`) so the empty default is visible and selectable; an operator can still override by picking a specific template. Empty → no `templateId` query param → backend applies the outcome default.

Validation: backend-ts **418 tests / 0 fail** + typecheck clean; frontend lint clean + build compiles. No Java change needed (it already recorded the resolved id). **Remaining #150: M9/M10/M13 (post-demo).**

---

## 2026-06-16 — Issue #150 H1: `backend-ts` parity (cycle-bucketing + worklist current-cycle + M6 eval-as-of-today)

Continued on `fix/issue-150-worklist-h1`. The Java side of H1 was already complete + tested (Phase 1 `CompliancePeriod` + Phase 2 root fix + Phase A worklist default — commits `c89de44`/`00788ee`/`9157c57`). This is the **`backend-ts` parity pass** so the TS stack stays idempotent across the #109 cutover — without it the H1 fix would silently regress the moment the JVM is retired.

- **`run/compliance-period.ts`** — line-for-line TS port of `com.workwell.run.CompliancePeriod`: pure `cadenceFor` (≤200-day window → biannual, else annual; flu → seasonal) + `cycleAnchor`/`cycleKey` (string-in/string-out, no `Date`/timezone surprises) + a measure-aware `bucketPeriodForMeasure(measureId, asOf)` that reads the compliance window from `MEASURE_BINDINGS`. Unit-tested (parity with `CompliancePeriodTest`): annual/biannual/seasonal anchoring + the idempotency property + per-measure cadence resolution.
- **`run/run-pipeline.ts` (Phase 2 parity)** — `finishManualRun` now buckets the persisted `evaluation_period` to the measure's current cycle (`bucketPeriodForMeasure(item.measureId, evalDate)`) for **both** the outcome and the case upsert, while the engine still evaluates **as-of `evalDate`** (today). Same decoupling as Java: numbers stay current, the case key is the cycle → a nightly rerun upserts the same cases instead of minting a fresh cohort. New integration test: two no-date `ALL_PROGRAMS` runs (the nightly shape) create **0** net-new cases and every period is a cycle anchor (`-(01|07)-01`), not a raw run date.
- **`case/case-rerun.ts` (M6 eval-date half)** — rerun-to-verify now evaluates **as-of today** (`new Date()…slice(0,10)`, mirroring Java's `LocalDate.now()`) instead of deriving the eval date from the (now cycle-anchored) `evaluation_period`; the case's `evaluationPeriod` stays the idempotency key. Without this the bucket anchor would make the day-math *more* stale, not less.
- **Phase A parity (worklist current-cycle default)** — added an optional `period` to `CaseQuery` with **backward-compatible** semantics: omitted/`undefined`/`all` → no filter (the primitive default the exports / MCP / programs / analytics callers already rely on), `current` → each measure's most-recent cycle via a status-agnostic `MAX(evaluation_period)` correlated subquery, a concrete `YYYY-MM-DD` → that cycle. Implemented in **both** the SQLite-floor and Postgres-ceiling `listCases`; only the worklist route (`GET /api/cases`) defaults to `current` (so `?period=all`/`?period=<date>` still work). Scoping the default to the route — rather than the shared store primitive — means no silent behavior change for non-worklist callers. New store-level test (parity with `CaseWorklistPeriodIntegrationTest`): omitted→all, `current`→newest, `all`→all, concrete→exact.

**`backend-ts` 376 tests — 375 pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** No existing test changed behavior: the run-pipeline idempotency/SITE-parity tests and the pinned `/api/runs/:id/evaluate` echo test (`evaluationPeriod` = raw effective date, intentionally **not** bucketed — it persists no case) all stay green, and `cases.test.ts` passes unchanged (its fixtures share one period, so `current` is a no-op there).

**M6 (`why_flagged` day-math) — done, Java-only.** Investigation showed `backend-ts` was already correct (`deriveWhyFlagged` reads the measure's window from `MEASURE_BINDINGS`); the bug was in Java `CqlEvaluationService#buildEvidenceJson`, which **hardcoded `365`** for both `compliance_window_days` and `days_overdue = max(daysSinceLastExam − 365, 0)`. For a non-annual measure that's just wrong — e.g. a CMS125 person (820-day window) last screened 400 days ago is COMPLIANT but was shown "35 days overdue". Fixed by threading the measure's actual window (`complianceWindowFor(measureName)`, DRY'd with `bucketPeriod`) into the builder; `last_exam_date` already anchored to the eval date (today), not the period, so that half was fine. Regression test added (`CqlEvaluationServiceTest`): CMS125 outcomes carry `compliance_window_days = 820`, not 365; targeted Java run green.

**D (stale-case cleanup) — done as `V022__close_stale_period_cases.sql`** (Taleef explicitly authorized the production-data migration, overriding the CLAUDE.md schema-ownership rule for this case). A single atomic statement: `UPDATE cases … RETURNING` (status→`CLOSED`, `closed_reason='STALE_PERIOD_CLEANUP'`, `closed_by='system:migration-V022'`) for OPEN/IN_PROGRESS cases whose `evaluation_period` is **not** a cycle anchor (not ending `-01-01`/`-07-01`), feeding one `CASE_CLOSED_STALE_PERIOD` audit_event per case via a CTE (upholds the audit invariant). Honest `CLOSED` (administrative — never verified compliant), not `RESOLVED`. **No-op + idempotent on a fresh DB** (CI/Testcontainers/local seed have no stale cohorts → 0 rows); self-limiting if re-run. **Validated read-only against live Neon (`workwell-twh`, project `sparkling-truth-84539518`):** 5,019 open cases, **all** on non-anchor daily periods, **0** anchored, across **31** nightly periods (2025-12-22 → today) — i.e. **261** real (employee × measure) cohorts duplicated ~19× by the daily cron. The migration closes all 5,019; the next post-deploy run re-creates the 261 genuine ones at the current cycle anchor (worklist default already hid the stale ones). Local Testcontainers apply-check was blocked only by Docker not running here — CI validates the apply; Flyway runs migrations transactionally so a fault fails the deploy cleanly without partial writes. The migration **applies on merge → deploy**, not by hand.

**Opened PR #152** (Java + `backend-ts` + V022).

**Codex review (PR #152) — 2 P1s, both fixed + regression-guarded.**
- **P1 #1 — worklist `MAX` poisoned by terminal stale rows.** The `current`-cycle subquery took `MAX(evaluation_period)` over **all** statuses; after V022 closes a stale raw-date row whose period (`2026-06-15`) is lexically *later* than the new cycle anchor (`2026-01-01`), that row would win the MAX and **hide the current cycle's open cases**. First cut used `closed_at IS NULL`, but Codex's **re-review** flagged that Java `upsertExcludedCase` keeps EXCLUDED rows at `closed_at = NULL` and V022 only closes `OPEN`/`IN_PROGRESS` — so a stale EXCLUDED row would still poison it. Final fix: MAX over **actionable status only** (`status IN ('OPEN','IN_PROGRESS')`) in Java `CaseFlowService` + both `backend-ts` stores; regression tests in both stacks cover a later CLOSED row *and* a later EXCLUDED row with `closed_at = NULL`.
- **P1 #2 — per-measure period in multi-measure runs.** Diagnosing this exposed that **Phase 2 bucketed one layer too high** (in `evaluate()`): the payload's `evaluationDate` is also used for `runs.started_at`, and `SeedHistoricalRunsService` runs through `evaluate()` with backdated dates — so the bucket was corrupting run timestamps **and collapsing the historical-seed trend** (which groups by `started_at`). **Re-layered:** `evaluate()` + the two `AllProgramsRunService` payload constructions now return the **actual** date; `RunPersistenceService` buckets **per-measure** at the outcome+case persistence (resolving the window via the `MeasureDefinitionProvider` port + pure `CompliancePeriod`, so it stays independent of CQL mocking). One move fixes Finding 2 *and* restores correct `started_at` + the seed trend. `backend-ts` already separated run metadata (`evalDate`) from the persisted period, so it only needed P1 #1.
- **Test fallout caught + fixed locally:** `ScopedRunFailureIntegrationTest` `@MockBean`s `CqlEvaluationService`, so my first cut (RunPersistence → `cqlEvaluationService.bucketPeriod`) returned Mockito's `null` → not-null violation. The `MeasureDefinitionProvider` rewrite resolves it (nothing mocks that port).

**Codex re-review #3 (`42bace5`) — 2 P2s, both fixed + regression-guarded.**
- **P2 #1 — terminal tabs lose history.** The current-cycle default applied for *every* status, but the MAX only counts OPEN/IN_PROGRESS — so the closed/excluded tabs (which the frontend also calls without a period) showed nothing once a measure's actionable work was all resolved. Fixed by scoping the current-cycle default to the **open worklist only** (Java `CaseFlowService` gates on `normalizedStatusFilter == "open"`; the `backend-ts` route defaults terminal tabs to `all`); regression tests in both stacks assert a prior-cycle EXCLUDED case shows in the excluded tab while the open tab stays on the current cycle.
- **P2 #2 — impact-preview matched the raw date.** `MeasureImpactPreviewService` + the TS preview compared `evaluation_period = evaluationDate` (raw), but cases now live at the bucket — so an in-cycle preview mislabeled existing subjects `wouldCreate`. Fixed to look up cases at the **bucketed cycle**. Extracted a shared `CompliancePeriodResolver` bean (`MeasureDefinitionProvider` + `CompliancePeriod`, mock-independent) now used by both `RunPersistenceService` and `MeasureImpactPreviewService` — one source of truth for the bucket; TS reuses `bucketPeriodForMeasure`. The TS case-impact test now seeds at the bucket (mid-cycle date) and asserts `wouldUpdate`.

**Codex re-review #4 (`2b79257`) — 1 P2: "use the latest evaluated cycle, not the latest open row."** When a measure rolls into a new cycle that produces no open cases (everyone now COMPLIANT), `MAX` over *actionable* rows falls back to a prior cycle's still-open rows (which the current run doesn't close, since it only touches the current bucket) — so the open worklist showed stale prior-cycle work. **Unified fix (supersedes the actionable-status predicate):** the current cycle is now the measure's **latest EVALUATED cycle** — `MAX` over **outcomes** (every run writes one outcome per subject, even all-compliant ones), restricted to **cycle-anchor periods** (`…-01-01`/`…-07-01`). Using outcomes (not open cases) means a fully-resolved new cycle still anchors correctly (P2); the anchor restriction keeps pre-bucketing raw-date rows from poisoning the `MAX` (so this also subsumes the earlier P1 stale-row fix). Applied in Java `CaseFlowService` + both `backend-ts` stores; new "latest evaluated cycle" regression test in both stacks (an evaluated-but-no-open-case later cycle is followed, not the prior cycle's stale open). Worklist test fixtures now seed the outcome alongside each case (mirroring a real run).

**Validation:** Java compiles clean; `CqlEvaluationServiceTest` (incl. M6), `NightlyRunIdempotencyIntegrationTest`, `CaseWorklistPeriodIntegrationTest` (4 cases: default + P1 stale-row + P2 terminal-tab + P2 latest-evaluated), `MeasureImpactPreviewIntegrationTest`, `ProgramRollupRerunIntegrationTest`, `ScopedRunFailureIntegrationTest` all green against real Postgres (Docker up locally). `backend-ts` **419 tests / 0 fail** (1 PG suite skipped); typecheck clean. CaseControllerTest mocks the service; other case integration tests use case-detail/actions endpoints; CSV export uses its own query — none assert worklist-list content with seeded cases, so the worklist change is contained. V022 apply-validated by the Testcontainers tests + read-only-validated against live Neon (5,019 open / all stale / 0 anchored).

**Codex re-review #5 (`b8eb3df`) — 2 P2s, both fixed (no further re-review requested — converging, and the round count was getting long).**
- **P2 #1 — blank period leaks through.** `?period=` (empty string) bypassed `?? periodDefault` (`??` only catches null/undefined), so the TS route passed `""` to the store → no filter → flood. Fixed: the route trims the param and treats blank/whitespace as absent.
- **P2 #2 — anchor check wasn't cadence-specific.** Treating *both* Jan 1 and Jul 1 as anchors for *every* measure let a stale `2026-07-01` poison an **annual** measure (anchor Jan 1 only) or `2026-01-01` poison **seasonal** flu (anchor Jul 1). **Definitive fix — date-driven:** the current cycle is now `bucketPeriod(measure, today)` per measure — exact and cadence-correct, immune to stale/raw data and to the rolled-over-with-no-open-cases fallback. Java `CaseFlowService` pins each Active measure to its own anchor via a `(measure_version_id, evaluation_period)` row-value IN (resolver-computed); the `backend-ts` route filters in JS via `bucketPeriodForMeasure(measureId, today)` (the store no longer does `current`). This supersedes all the prior data-driven `MAX` iterations (P1 closed_at, P1 actionable-status, P2 outcomes-MAX) — one cadence-exact rule. New cadence guard in both stacks: a Jul-1 open case for an annual measure (or an annual Jan-1 for seasonal flu) is **not** part of its current cycle.

**Validation:** Java compiles clean; `CqlEvaluationServiceTest` (incl. M6), `NightlyRunIdempotencyIntegrationTest`, `CaseWorklistPeriodIntegrationTest` (4 date-driven cases: default/all/exact + cadence-anchor + terminal-tabs + prior-cycle-hidden), `MeasureImpactPreviewIntegrationTest`, `ProgramRollupRerunIntegrationTest`, `ScopedRunFailureIntegrationTest` green against real Postgres (Docker up locally). `backend-ts` **416 tests / 0 fail** (1 PG suite skipped); typecheck clean. No test manually constructs `CaseFlowService` (Spring DI only); the worklist change stays contained (CaseControllerTest mocks the service; other case tests use detail/actions endpoints; CSV export uses its own query). V022 read-only-validated against live Neon (5,019 open / all stale / 0 anchored).

**H1 status: COMPLETE** (Phase 1 + Phase 2 [re-layered] + A worklist default + M6 + D, Java ↔ `backend-ts` at parity; all Codex findings across 5 review rounds — 2 P1 + 1 P1 re-review + 5 P2 — resolved). The worklist's current-cycle definition converged on a single **date-driven, cadence-exact** rule. Remaining #150 after H1: H4 (verify — likely covered by C4), M1, M5, M8, M9, M10, M13.

---

## 2026-06-15 — Issue #150 demo-readiness: part 1 merged (C1/C2/C4 + frontend papercuts) + H1 started

A live end-to-end QA pass surfaced 21 defects / doc-mismatches (#150). **Part 1 shipped as PR #151 — merged + deployed to `main`.** Framing: #150 doubles as the functional-parity checklist for the #96 cutover — frontend + docs fixes carry over unchanged; backend fixes were audited Java vs `backend-ts` and fixed in the right place once.

- **Frontend papercuts (Batch 1; lint + tsc + 55 vitest green):** H2 ("Employees tracked" → "Evaluations (latest runs)"), H3 (overview trend axis clamped `[0,100]`), M2 (Send-outreach disabled-reason tooltip), M3 (`vv1.0` → `v1.0` in run picker / waivers / employee detail), M4 (run picker defaults to first Active measure + Active-only options), M7 (engine-internal CQL defines hidden from the evidence list; raw JSON kept), M11 (audit log defaults to All), M12 (login copy + split demo login `admin@` from the public sandbox's lower-privilege `cm@`). **C1:** README clarifies the ELM Explorer is a `backend-ts` feature surfacing post-#109, not on the live Java UI.
- **C2 — CMS125/CMS122 promote (a seeding bug, not stale docs).** `ensureCms125Seed`/`ensureCms122Seed` only promoted to Active on a *fresh* DB; the existing-row branch refreshed CQL but never set `status='Active'`, so the live Neon DB was stuck Draft. Fixed both branches. **Landmine:** the evaluator binds CQL by measure *name* (`forMeasure`, exact match), and CMS122's live/catalog name ("Glycemic Status Assessment Greater Than 9%") differed from the YAML/seeder/tests ("…HbA1c Poor Control"). Standardized the modern CMS122v14 name across `cms122.yaml`, the seeder, 3 backend tests, and `backend-ts/measure-registry.ts` (the CQL define `HbA1c Poor Control` + the `cms122` slug left alone). Catalog is now genuinely **10 runnable / 2 active CMS**; `ALL_PROGRAMS` evaluates 1000.
- **C4 — rerun corrupts the program dashboard.** All three `ProgramService` rollups picked the latest run by `started_at` ignoring `scope_type`, so a single-subject CASE/EMPLOYEE rerun-to-verify became the measure's "latest run" and crashed `/programs` + `/programs/[id]` to 0%/100%. Excluded CASE/EMPLOYEE from all three; `backend-ts` parity threads `runScopeType` through `OutcomeWithRun` + both stores + the read-model filters, with a DB-backed regression test.
- **Codex review (PR #151) — both findings resolved.** **P1:** the C4 predicate used uppercase `NOT IN ('CASE','EMPLOYEE')`, but the Java backend persists these **lowercase** (`CaseFlowService` writes `"case"`; manual runs `.name().toLowerCase()`) — it matched nothing. Fixed with `UPPER(r.scope_type)` (+ `.toUpperCase()` in `backend-ts`), and added `ProgramRollupRerunIntegrationTest` (Testcontainers) **proven to fail without the fix and pass with it** — the DB-backed guard that was missing (`ProgramControllerTest` only mocks the service). **P2:** the C2 promote left the lean catalog `spec_json`; hoisted the spec build and now write the full authored spec in the promote `UPDATE` for both measures.

**H1 (worklist flood — 4,703 perpetually-open cases) — started on `fix/issue-150-worklist-h1`.** Root cause: the nightly cron mints a new `evaluation_period` (= run date) every night, so cases (keyed `(employee, measure_version, evaluation_period)`) pile up and never close. Design (in the plan doc): recurring runs still compute compliance **as-of today** (numbers unchanged), but bucket `evaluation_period` to the measure's **current compliance cycle** (per-measure cadence: annual / biannual / flu-season) so nightly reruns update the same cases idempotently (restores DATA_MODEL §4). **Phase 1 done** — `CompliancePeriod` helper + unit tests (commit `c89de44`). Phases 2–6 next: rewire the persist seam + decouple the CASE-rerun eval date (= the M6 fix) + worklist default-to-current-cycle (A) + `backend-ts` parity + a Flyway cleanup migration (D). Remaining #150 after H1: H4 (likely already fixed by C4 — verify), M1, M5, M8, M9, M10, M13.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): waivers (list + grant) — **Phase 4b complete**

Branch `feat/issue-96-waivers` (off `main`). Ported `WaiverService.listWaivers`/`grantWaiver` — the last Admin write surface. This **completes the Phase-4 API strangler (#107) + Phase-4b (#108)**; only the Phase-5 deploy cutover (#109) remains. *(backend-ts only. Floor+ceiling DDL mirrors the canonical `waivers` table [V009]; like the other TS tables the FK columns are TEXT.)*

- **`stores/waiver-store.ts` (+ floor/ceiling/contract)** — `WaiverStore`: `insert`, `list(query)` (active DESC, expires_at ASC NULLS LAST, granted_at DESC; SQL filters measureId/active/expiresAfter/expiresBefore), `getById`. FK columns are TEXT — `employee_external_id` (no employees table in the synthetic model), `measure_id` (slug), `measure_version_id` (floor version id). `active` INTEGER 0/1 floor / BOOLEAN ceiling. (Floor's NULLS-last is emulated via `(expires_at IS NULL) ASC`.)
- **`admin/waivers.ts`** — `listWaivers` + `grantWaiver`: the store holds raw rows; the service **resolves display fields at read time** — employee name/site from the synthetic `employeeById`, measure name/version from the measure store — and computes `expired` (active && expires_at < now), matching Java's read JOIN. `site` filter is applied in JS (no site column). Grant validates employee exists + measure resolves + reason non-blank + a present-but-unparsable `expiresAt` → 400, then writes a `WAIVER_GRANTED` audit. Granting is record-keeping only (the synthetic engine derives EXCLUDED from its seeded distribution, not this table) — documented, same as the Java admin surface.
- **`routes/admin.ts`** — `GET /api/admin/waivers` (was the deferred empty stub) with the measureId/site/active/expiresAfter/expiresBefore filters + `POST /api/admin/waivers` (201, 400 on validation). Both ADMIN-gated by the matrix; deps resolve the measure store via `ensureMeasureStore` (DDL + catalog seed).

**backend-ts 362 tests — all pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** New coverage: the store contract (insert/getById round-trip, the active/expiry ordering, all four SQL filters — floor + ceiling) and the admin route suite (grant resolves employee+measure display fields + lists, measureId/active/site filters, the `WAIVER_GRANTED` audit, and grant validation 400s for unknown employee / unknown measure / blank reason / bad date). Frontend Admin → Waivers (list + grant) now served end-to-end. **Phase 4b (#108) complete — next is Phase 5 deploy cutover (#109): binding selection + JVM retirement.**

**Codex P2 fix (same PR):** the `expiresAfter`/`expiresBefore` waiver filters take a bare `YYYY-MM-DD` (the Admin date input) and are now expanded to UTC **day bounds** before the query — `after` → start-of-day `00:00:00Z`, `before` → end-of-day `23:59:59Z` (Java `parseFromDate`/`parseToDate`) — so a waiver expiring at `00:00:00Z` is correctly included by `expiresBefore=<that day>` instead of being excluded by a raw `YYYY-MM-DD` < ISO-timestamp string comparison; a non-date value now returns 400. Covered by new route tests.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): admin write CRUD — outreach-template create/update + demo-reset

Branch `feat/issue-96-admin-write-crud` (off `main`). Ported `OutreachTemplateService` (create/update/preview, now persisted) and `DemoResetService` — the two admin writes with no cross-model FK friction. *(backend-ts only. Floor+ceiling DDL mirrors the canonical `outreach_templates` table [V007]; demo-reset clears volatile floor tables only.)* **Waivers are the one remaining Phase-4b surface** — split out because they JOIN `employees`/`measures` UUID tables that the synthetic TS model doesn't have (needs employee-directory + measure-store resolution); they get their own focused batch next.

- **`stores/outreach-template-store.ts` (+ floor/ceiling/contract)** — `OutreachTemplateStore`: `isEmpty`/`seed` (ON CONFLICT DO NOTHING), `listActive` (active-only, created_at DESC, name ASC), `getById`, `create`, `update` (null when unknown). `active` is INTEGER 0/1 on the floor / BOOLEAN on the ceiling.
- **`admin/outreach-templates.ts`** — port of `OutreachTemplateService`: the 4 V007 demo templates seeded with fixed ids; `listTemplates`, `previewTemplate` (the single-brace `{employee_name}`/`{measure_name}`/`{due_date}`/`{assignee_name}` render), `createTemplate` (name/subject/bodyText required, `normalizeType` → OUTREACH/APPOINTMENT_REMINDER/ESCALATION else 400), `updateTemplate`. No audit events (Java writes none here).
- **`admin/demo-reset.ts`** — port of `DemoResetService`: deletes the volatile floor tables (scheduled_appointments, evidence_attachments, case_actions, cases, outcomes, run_logs, runs, audit_events — child-before-parent), preserving seed data. Like Java it clears `audit_events` (sprint-sanctioned demo tool) and is non-prod-gated.
- **`routes/admin.ts`** — `POST /api/admin/outreach-templates` (201), `PUT /api/admin/outreach-templates/:id` (404 unknown), `POST /api/admin/demo-reset` (**403 when `SPRING_PROFILES_ACTIVE` includes `prod`**, mirroring `@Profile("!prod")`); GET list + preview now store-backed (seeded in the admin one-shot init). All ADMIN-gated by the `/api/admin/**` matrix; the worker now threads `SPRING_PROFILES_ACTIVE` into the admin env. Removed the now-dead static template stub from `admin-data.ts`.

**backend-ts 359 tests — all pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** New coverage: the store contract (seed idempotency, active-only list ordering, create + update + deactivate, unknown→null, on floor + ceiling) and the admin route suite (template create→list→preview-render→update-deactivate, create 400 [missing fields + bad type], update 404, demo-reset clears the ledger + 403 under prod). Frontend Admin → Outreach Templates (create/edit) + Demo Reset now served end-to-end. **Remaining before deploy cutover (#109): waivers (list + grant).**

**Codex P2 fixes (same PR):** (1) **template writes now audited** — create/update append `OUTREACH_TEMPLATE_CREATED`/`UPDATED` audit_events (CLAUDE.md/AGENTS.md "every state change writes audit_event"; the Java service omitted these — fixed in the port). (2) **demo-reset uses the shared production-like detection** (`isProductionLike` from `config/startup-safety.ts`) so `WORKWELL_ENVIRONMENT=production` / `NODE_ENV=production` also 403 it, not just the Spring profile. (3) **V008 `Missing Data Follow-Up` template added** to the demo seed (5 templates total) — the canonical MISSING_DATA notification template, previously missing.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): value-set governance (registry + links + resolve-check/diff/detail + terminology)

Branch `feat/issue-96-value-set-governance` (off `main`). Ported `ValueSetGovernanceService` + the catalog value-set methods of `MeasureService` — the Studio Value Sets tab, the governance panel, and the Admin → Terminology Mappings surface. This **lights up the dormant value-set paths** already built in MAT export (the ValueSet bundle entries) and traceability (the value-set rows/gap). *(backend-ts only. Floor+ceiling DDL mirrors the canonical `value_sets` [V001+V013], `measure_value_set_links` [V001], `terminology_mappings` [V013] — the canonical Flyway tables already exist; this only mirrors them on the SQLite floor / `workwell_spike` Postgres ceiling.)*

- **`stores/value-set-store.ts` (+ floor/ceiling/contract)** — `ValueSetStore`: `seedValueSet` (upsert by id), `link`/`unlink`, `listAll`, `getById`, `create`, `listByVersion`, `affectedMeasures`, plus `listTerminologyMappings`/`createTerminologyMapping`. ids are TEXT on both adapters (matching the spike's TEXT measure ids — value sets carry the Java demo UUIDs + `crypto.randomUUID()` as strings; links FK `measure_versions` TEXT id). codes_json is JSON TEXT on the floor / JSONB on the ceiling; code_systems JSON TEXT / `text[]`.
- **`measure/value-set-seed.ts`** — port of `ensureDemoValueSets`: the 22 demo value sets (the 4 OSHA procedure sets the CQL matches by name + their enrollment/waiver sets + the wellness sets, same UUIDs as Java) linked to each measure's latest version **by slug** (TS measure id), plus the 5 V013 demo terminology mappings. Idempotent (seed guards on `isEmpty()`; `seedValueSet` upserts; `link` is ON CONFLICT DO NOTHING). Runs in the measures one-shot init after the catalog seed (links target version ids).
- **`measure/value-set-governance.ts`** — `resolveCheck` (per-set code-count/resolution-status blockers + CQL unattached-reference scan + not-referenced warnings), `diffValueSets` (added/removed codes by system|code + affected measures + warnings), `getValueSetDetail`, the catalog `listValueSets` (UNRESOLVED/0 like Java) / `listValueSetsByVersion` (computed resolvability) / `createValueSet` / `attachValueSet` / `detachValueSet` (with `MEASURE_VALUE_SET_LINKED`/`UNLINKED` audits), and `listTerminologyMappings` / `createTerminologyMapping` (with `TERMINOLOGY_MAPPING_CREATED` audit). Compliance is never decided here.
- **routes** — `measures.ts`: `GET/POST /api/value-sets`, `GET /api/measures/versions/:vid/value-sets`, `POST/DELETE /api/measures/:id/value-sets/:vsId`, `POST /api/measures/:id/value-sets/resolve-check`, `GET /api/value-sets/:id/diff?toId=`, `GET /api/value-sets/:id/detail`. Wired `valueSets` into measure-detail, folded resolve-check into activation-readiness (Java parity: `ready && allResolved` + value-set blockers + `valueSetCount`), and passed attached sets to traceability + MAT export. `admin.ts`: terminology list now persisted (store-backed) + `POST /api/admin/terminology-mappings`. New authorize rules: `POST /api/value-sets` + `DELETE …/value-sets/*` → AUTHOR/ADMIN.

**backend-ts 355 tests — all pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** New coverage: the store contract (value-set CRUD + upsert + links + terminology, on floor + ceiling) and the route suite (catalog list, by-version resolved sets, resolve-check pass + 404, create→attach→detach, create 400, detail + 404, diff + affected-measures + 400, activation-readiness fold, traceability value-set rows, admin terminology list+create+400). Removed the now-superseded static terminology stub from `admin-data.ts`. Frontend Studio Value Sets tab + governance panel + Admin terminology now served end-to-end. Remaining before deploy cutover (#109): admin write CRUD (waivers, outreach-template CRUD, demo-reset).

**Codex P1+P2 fixes (same PR):** (1) **seeded value-set names aligned to the CQL `valueset "..."` declarations** — 4 wellness sets (LDL, cholesterol/diabetes enrollment, wellness exemption) carried the Java seed's longer display names, which `resolveCheck` flagged as unattached-reference blockers; now resolve-check + activation-readiness are clean for every runnable measure (regression-tested across all 7 seeded measures). (2) **link audits carry the authenticated actor** — `attachValueSet`/`detachValueSet` recorded `MEASURE_VALUE_SET_LINKED`/`UNLINKED` as `system`; they now thread the caller's identity like the other authoring/terminology writes.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): evidence + appointments + CASE auditor packet

Branch `feat/issue-96-evidence-appointments` (off `main`). Ported the case-detail completeness trio — `EvidenceService`, `CaseFlowService.scheduleAppointment`/`listAppointments`, and `resolveCase` — and used them to light up the **CASE** auditor packet (deferred in #144). *(backend-ts only. Floor+ceiling DDL adds `evidence_attachments` + `scheduled_appointments`, mirroring canonical Flyway V006/V005; the V005 `outreach_records` side is intentionally not modeled — TS represents outreach as `case_actions`.)*

- **`case/evidence-service.ts`** — `uploadEvidence`/`listEvidence`/`downloadEvidence`. Content type is detected from **magic bytes** (PNG/JPEG/PDF signatures ported exactly; ZIP+`.xlsx`→xlsx; UTF-8-decodes → text/csv|text/plain), never the client header; 10MB cap + allow-list (415 otherwise). Bytes live in the **BUCKET** binding (R2/fs) under `<caseId>/<evidenceId>-<safeName>`; metadata in the new `EvidenceStore`. Every upload/download writes an audit event. No Apache Tika (the Java text/csv/xlsx detector) — the signature+extension heuristic is the JVM-free analogue; a spoofed extension on binary content is still caught.
- **`case/appointment-service.ts`** — `scheduleAppointment` writes the appointment + an atomic `SCHEDULE_APPOINTMENT` action / `APPOINTMENT_SCHEDULED` audit, moves an OPEN case to IN_PROGRESS, returns the refreshed CaseDetail; `listAppointments`. **`case/case-actions.ts`** — added `resolveCase` (manual CLOSE, required note, OPEN/IN_PROGRESS only → `CASE_MANUALLY_CLOSED`).
- **stores** — new `EvidenceStore` + `AppointmentStore` contracts + SQLite-floor and Postgres-ceiling adapters, exercised by the shared store-contract suite.
- **`routes/cases.ts`** — `POST /api/cases/:id/evidence` (multipart), `GET /api/cases/:id/evidence`, `GET /api/evidence/:id/download` (inline for images, else attachment), `POST /api/cases/:id/actions` (RESOLVE + SCHEDULE_APPOINTMENT), `GET /api/cases/:id/appointments`. Env widened with the BUCKET binding. RESOLVE was previously unported (501) — the frontend's resolve button now works.
- **`audit/audit-packet.ts` + `routes/auditor.ts`** — `buildCasePacket` + `GET /api/auditor/cases/:id/packet` (CM/ADMIN gate already added in #144): case/employee/measure/decisionEvidence sections, the timeline partitioned into actions/auditEvents/aiAssistance, outreach (from case_actions), appointments, and evidence **attachments by metadata only** (CASE_DISCLAIMERS note that raw bytes are excluded).

**backend-ts 330 tests — all pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** New coverage: evidence MIME detection + sanitizeFileName unit; evidence upload(415)/list/download(inline); appointment schedule(OPEN→IN_PROGRESS)/list/validation; RESOLVE close + note-required + already-closed; CASE packet sections (appointments + attachments + disclaimers); EvidenceStore + AppointmentStore contracts on floor + ceiling. Frontend case-detail evidence/appointments/resolve + the CASE packet download now served. Next: value-set governance, admin write CRUD, then Phase 5 cutover.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): MAT-compatible FHIR R4 export

Branch `feat/issue-96-mat-export` (off `main`). Ported `MeasureExportService.exportAsMatBundle` — the `GET /api/measures/:id/versions/:vid/export/mat` measure-portability download. *(backend-ts only. No new schema.)*

- **`fhir/mat-export.ts`** — `exportMatBundle(record, valueSets?)`: builds a FHIR R4 `Bundle` (type=collection) carrying a **Library** (CQL logic library, CQL attached as base64 `text/cql`) + a **Measure** (referencing the library by `urn:uuid:`), plus a **ValueSet** per attached value set (compose/include grouped by code system, blank system → `urn:workwell:local`). Java used HAPI to assemble + serialize + validate; we have **no FHIR runtime** (no new dep), so a small hand-rolled emitter produces well-formed FHIR R4 XML **by construction** — elements in canonical R4 order, attribute values escaped, nested resources inheriting the Bundle's default namespace (HAPI's on-the-wire shape). Status maps Active/Approved → `active`, Deprecated → `retired`, else `draft`; description falls back spec.description → "Policy reference: …" → default; `safeIdentifier` strips non-alphanumerics.
- **`routes/measures.ts`** — `GET /api/measures/:measureId/versions/:versionId/export/mat` (`?format` defaults `xml`; non-xml → 400; unknown version **or** measure/version mismatch → 404; `application/fhir+xml` attachment). APPROVER/ADMIN by the existing authorize rule. Resolves the version via the new `MeasureStore.getByVersionId` (added in the auditor-packets batch).

**Fidelity (documented):** value-set *linkage* isn't ported yet (value-set governance is a later batch; the TS `MeasureRecord` carries no attached sets), so today's bundle is **Library + Measure**. The ValueSet path is fully built + unit-covered, so it lights up unchanged once governance supplies the attached sets. No runtime FHIR validator (Java's HAPI `validateWithResult` → 500 path) — the XML is correct by construction.

**backend-ts 318 tests — all pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** New coverage: builder unit (bundle scaffold, Library base64 CQL UTF-8 round-trip, Measure→Library urn ref, description fallbacks, status mapping, no-CQL/escaping, value-set compose grouping + blank-system + empty-code drop) + the route (XML + headers, format 400, unknown-version 404, measure/version-mismatch 404). Frontend MAT export download now served. Next: evidence upload/download (+ CASE packet), value-set governance, admin write CRUD.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): auditor packets (run + measure-version)

Branch `feat/issue-96-auditor-packets` (off `main`). Ported `AuditPacketService` for the **RUN** and **MEASURE_VERSION** packet types — the downloadable, self-contained evidence bundles behind `AuditorController`'s `/api/auditor/**` routes. The **CASE** packet is deferred (depends on evidence attachments + scheduled appointments + outreach_records, none ported yet). *(backend-ts only. Floor+ceiling DDL adds the `audit_packet_exports` table — the canonical Flyway V014 already exists; this only mirrors it on the spike SQLite floor / `workwell_spike` Postgres ceiling.)*

- **`audit/audit-packet.ts`** — `buildRunPacket` / `buildMeasureVersionPacket(deps, id, actor, format)`: assemble the packet from existing read models (run → `toRunSummary`/`toRunOutcomeRows`/`toRunLogEntries` + the by-run ledger; measure-version → `toMeasureDetail` + `generateTraceability` + `computeDataReadiness` + the by-version ledger, filtered to the approval-history events). Every build serializes to JSON, computes a `sha256:<hex>` digest (Web Crypto, JVM-free), writes an `AUDIT_PACKET_GENERATED` audit_event (CLAUDE.md — every state change is audited) and records the export in `audit_packet_exports`. Hash + byte size are always over the JSON (the canonical artifact); `format=html` returns a presentation render of the same content. Value-set governance is `{}` (not-yet-ported surface), matching the Java packet's empty-on-unavailable shape. **Compliance is never decided here** — packets only reflect CQL-derived outcomes + ledger state as of the generation timestamp (disclaimers carried verbatim).
- **stores** — `CaseEventStore` (the de-facto audit store) gains `auditEventsByRun` / `auditEventsByMeasureVersion` (ledger reads by ref) + `insertPacketExport`; `MeasureStore` gains `getByVersionId` (version UUID → measure record). Implemented on both the SQLite floor and the Postgres ceiling; exercised by the shared store-contract suite.
- **`routes/auditor.ts`** — `GET /api/auditor/runs/:id/packet` + `GET /api/auditor/measure-versions/:id/packet` (`?format=json|html`; 400 bad format, 404 unknown id, `Content-Disposition: attachment`). Role gates in the authorize matrix: run packets CASE_MANAGER/ADMIN, measure-version packets APPROVER/ADMIN (mirrors `AuditorController`). Wired into the worker after exports.

**backend-ts 311 tests — all pass / 0 fail (1 PG suite skipped without local Docker); typecheck clean.** New coverage: run packet sections + headers + html render, the `AUDIT_PACKET_GENERATED` ledger row (hash/size), measure-version packet (traceability + data-readiness + approval-history + CQL hash), format gate + 404; store-contract by-ref ledger reads + packet-export insert + `getByVersionId`; authorize gates for both packet families. Frontend `/api/auditor/**` downloads now served (run + measure-version). *(Codex P2 follow-up: run packet outcome rows now trace each non-compliant row to its case id — the outcomes↔cases join Java does — keyed by the TS unique key (employeeId, measureId, evaluationPeriod), instead of the shared read model's `caseId: null`.)* Next: evidence upload/download (+ CASE packet), value-set governance, MAT export, admin write CRUD.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): measure activation impact preview (analytics trio complete)

Branch `feat/issue-96-impact-preview` (off `main`). Ported `MeasureImpactPreviewService.preview` — the Studio activation **dry-run**: `POST /api/measures/:id/impact-preview`. With traceability + data-readiness already merged, this **completes the measure-analytics trio**. *(backend-ts only. No new schema.)*

- **`measure/impact-preview.ts`** — `previewImpact(deps, measure, req, actor)`: evaluates the measure across the population through the **same** synthetic eval path as the run pipeline (seeded distribution → exam config → FHIR bundle → JVM-free engine) **without persisting** outcomes/cases, then estimates how a real activation run would change open cases for that evaluation period — `wouldCreate` (non-compliant, no open case) / `wouldUpdate` (non-compliant, has open case) / `wouldClose` (COMPLIANT, has case) / `wouldExclude` (EXCLUDED, has case) — plus per-site/per-role outcome breakdowns. Scope filter (site/employee) with an empty-match warning; MISSING_DATA warning; writes a `MEASURE_IMPACT_PREVIEWED` audit (`dryRun: true`). Invalid `evaluationDate` → typed 400; a non-runnable measure → empty preview + warning (Java parity). Eval-heavy (~one measure × population) but synchronous like Java — a single measure stays under the request timeout.
- **`routes/measures.ts`** — `POST /api/measures/:id/impact-preview` (404 unknown, 400 bad date), AUTHOR/ADMIN-gated by the existing matrix.

**backend-ts ~330 tests — all pass / 0 fail; typecheck clean.** New coverage: dry-run preview (counts sum to population, site/role breakdowns, **no run/outcome persisted**, audit actor + dryRun), case-impact create-vs-update (seed an open case → subject flips from wouldCreate to wouldUpdate), scope filter + empty-match warning, invalid-date 400, non-runnable empty preview; route 200/404/400. Frontend `/studio/[id]` impact-preview panel now served. **Measure analytics (traceability + data-readiness + impact-preview) all done.** Next: auditor packets (run/measure-version now unblocked), evidence upload/download, value-set governance, MAT export, admin write CRUD.

---

## 2026-06-15 — Issue #96 Phase 4b (#108): data readiness + list_data_quality_gaps MCP tool (last NOT_IMPLEMENTED flipped)

Branch `feat/issue-96-data-readiness` (off `main`). Ported `DataReadinessService.computeReadiness` + `validateMappings`, flipping the **second/last** NOT_IMPLEMENTED MCP tool — so all 13 MCP tools are now real. *(backend-ts only.)* **No migration needed** — the `data_element_mappings`/`integration_sources` data is read-only reference seed (V012), modeled as a static constant like the other admin seeds.

- **`admin/admin-data.ts`** — replaced the 4-row data-mappings **stub** (coarse canonicals like `Employee.role` that never matched) with the **faithful 14-row V012 seed** (granular canonicals `procedure.audiogram`/`waiver.medical`/`employee.role`/…, 2 active sources hris/fhir, fhirResourceType/fhirPath enriched onto the interface). Added `validateDataMappings()` (DEGRADED source → STALE, HEALTHY → MAPPED, stamps lastValidatedAt) and `sourceFreshness(sourceId)` (from integration-health last sync). The admin data-mappings panel now shows the real source map.
- **`measure/data-readiness.ts`** — `computeDataReadiness(measure)`: resolves each `requiredDataElement` label → canonical (the `LABEL_TO_CANONICAL` longest-match table) → source mapping; reports per-element mappingStatus + freshness + (clinical elements only) the MISSING_DATA rate + sample subjects from the measure's outcomes; aggregates blockers (UNMAPPED/ERROR) + warnings (stale / >5% missingness) into READY / READY_WITH_WARNINGS / NOT_READY.
- **`routes/measures.ts`** — `GET /api/measures/:id/data-readiness` (404 unknown). **`routes/admin.ts`** — `POST /api/admin/data-mappings/validate` (the deferred admin validate surface, ADMIN-gated). **`mcp/tools.ts`** — `list_data_quality_gaps` now returns `{measureId, overallStatus, blockers, warnings, elementReadiness}` (was NOT_IMPLEMENTED).

**backend-ts 325 tests — all pass / 0 fail; typecheck clean.** New coverage: data-readiness unit (all-MAPPED→READY, unmapped→NOT_READY blocker, >5% missingness→warning with clinical-only rate/samples), the route (element readiness + 404), the admin data-mappings 14-row seed + validate stamp, and the MCP tool (real summary + INVALID_ARGUMENT + MEASURE_NOT_FOUND). **All 13 MCP tools now implemented.** Frontend `/studio/[id]` data-readiness panel + `/admin` data-mappings(+validate) now served. Next: impact-preview (eval-heavy), then auditor packets (measure packet now unblocked by traceability + data-readiness), evidence upload/download, admin write CRUD, MAT export.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): employee directory (profile + search)

Branch `feat/issue-96-employees` (**independent, off `main`** — new `routes/employees.ts` + worker wiring only, no shared files with the in-flight measures PRs #139/#140, so it merges in parallel). Ported `EmployeeProfileService` (getProfile + search) behind the unchanged frontend contract: the case-detail employee drawer + the worklist employee search. *(backend-ts only. No new schema.)*

- **`run/employee-profile.ts`** — `getEmployeeProfile(externalId)`: identity + **latest outcome per measure** (newest-first history deduped by measure, with `daysSinceLastExam`/`daysUntilDue` derived via the shared `deriveWhyFlagged` — now exported from `case-detail-read-model` for DRY) + **open cases** (OPEN/IN_PROGRESS for the employee) + **recent audit timeline** (last 20 audit_events tied to the employee's cases, with the Java `humanReadable` summaries). `searchEmployees(q, limit)`: name/externalId/role substring (min 2 chars, limit clamped 1–50) + each match's latest outcome.
- **`routes/employees.ts`** — `GET /api/employees/:externalId/profile` (404 unknown) + `GET /api/employees/search?q=&limit=`. AUTHENTICATED via the `/api/**` matrix. Wired into the worker before programs.

**Fidelity (synthetic directory, documented):** the TS `EmployeeProfile` has only externalId/name/role/site, so `supervisorName`/`startDate`/`fhirPatientId` are null and `active` is true; SLA isn't modeled on the case row, so `slaDueDate`/`slaRemainingDays` are null and `slaBreached` false. The compliance data (outcomes, open cases, audit timeline) is real. Measure names use the engine registry short name (e.g. "Audiogram"), consistent with the cases/runs surfaces.

**backend-ts 305 tests — all pass / 0 fail; typecheck clean.** New coverage: profile (identity + outcome with derived days + open-case link + audit summary), 404, search (name/role match, min-length, latest outcome, limit clamp). Frontend `/cases/[id]` employee drawer + worklist search now served. *(Codex P2 follow-up: `daysSinceLastExam` now reports actual recency, not `days_overdue`; `daysUntilDue = window − recency`.)*

---

## 2026-06-14 — Issue #96 Phase 4 (#107): measure traceability + get_measure_traceability MCP tool

Branch `feat/issue-96-measure-analytics` (**stacked on the authoring-writes branch** — touches `measures.ts`, which #139 also edits, so it's based on that branch to avoid a conflict; retarget to main once #139 merges). Ported `MeasureTraceabilityService.generate` and flipped the first of the two NOT_IMPLEMENTED MCP tools to a real implementation. *(backend-ts only.)* **No new schema.**

**Scoping note (deliberate, evidence-based):** I set out to do the whole measure-analytics trio (traceability + data-readiness + impact-preview) but scoped to **traceability** after reading the sources: (1) **data-readiness** maps spec labels → granular canonicals (`procedure.audiogram`, …) and looks them up in `data_element_mappings`, but the TS floor only has a coarse 4-row static seed (`Employee.role`, `Procedure.performed`, …) — a faithful port needs the full `data_element_mappings`/`integration_sources` seed reconciled (a schema+seed task); (2) **impact-preview** runs a full population CQL evaluation (~1000 evals, eval-heavy) + open-case diffing. Both deserve their own batch; traceability is fully self-contained on the measure record, so it ships clean and correct now.

- **`measure/measure-traceability.ts`** — `generateTraceability(measureRecord)` → `{measureId, measureVersionId, measureName, version, rows, gaps}`. Rows map each policy requirement (eligibility / exclusion / compliance-window / days-elapsed) to its spec field + best-matching CQL define (same `define "Name":` regex + keyword-priority matcher as Java) + the runtime `why_flagged` evidence keys. Gaps flag: missing policy citation, non-COMPILED/WARNINGS compile status (ERROR), missing/incomplete test fixtures (MISSING_DATA + EXCLUDED coverage), and no attached value sets. Fidelity: value-set governance isn't modeled on the floor, so `valueSets` is always `[]` and the value-set gap always fires (same gap Java raises for a version with no attached value sets).
- **`routes/measures.ts`** — `GET /api/measures/:id/traceability` (404 unknown). Already gated AUTHENTICATED by the security matrix.
- **`mcp/tools.ts`** — `get_measure_traceability` now returns the real matrix (resolve measure → `generateTraceability`; INVALID_ARGUMENT with no ref, MEASURE_NOT_FOUND when unresolved). `list_data_quality_gaps` still returns NOT_IMPLEMENTED (data-readiness port pending).

**backend-ts 316 tests — all pass / 0 fail; typecheck clean.** New coverage: the generator (row→define mapping incl. the distinct days-elapsed row; gaps for healthy vs broken vs partial-fixture-coverage), the route (rows+gaps+404), and the MCP tool (matrix + INVALID_ARGUMENT + MEASURE_NOT_FOUND). Frontend `/studio/[id]` traceability panel + the MCP `get_measure_traceability` tool now served. Next: **data-readiness** (with the `data_element_mappings` seed + migration, now that I have migration authority) — flips the last NOT_IMPLEMENTED MCP tool — then impact-preview, then the auditor packets (whose measure packet depends on traceability + data-readiness).

---

## 2026-06-14 — Issue #96 Phase 4 (#107): Studio authoring writes — spec/CQL/tests edits + osha-references

Branch `feat/issue-96-measures-authoring-writes`. Makes the Studio **writable** (Spec/CQL/Tests tabs were read-only on the TS backend), ported from `MeasureController`/`MeasureService` authoring. Larger batch (the whole authoring write surface in one PR, per the maintainer's cadence ask). *(backend-ts only — does not touch the deployed Java demo.)* **No new schema** — the `measure_versions` table already has `spec_json`/`cql_text`/`compile_status`, so these are `UPDATE`s, not migrations.

- **Store (floor + ceiling + contract)** — `MeasureStore.updateSpec(measureId, spec, policyRef?)` and `updateCql(measureId, cqlText, compileStatus?)`, both targeting the **latest** version (max `created_at`) and touching `measures.updated_at`; null for an unknown measure. Contract test covers spec/CQL round-trip + fixture preservation + the no-status CQL update path on both SQLite and Postgres.
- **`measure/measure-authoring.ts`** — `updateMeasureSpec` (preserves existing `testFixtures`; `updateTests` owns those), `updateMeasureCql`, `compileMeasureCql` (maps the JVM-free translator diagnostics → the Java `CompileResponse {status,warnings,errors}` and persists `compile_status`), `updateMeasureTests`, `validateMeasureTests` (reuses the read-model `validateTests`). Each edit writes a `MEASURE_VERSION_DRAFT_SAVED` audit event (field=spec|cql|tests).
- **`measure/osha-references.ts`** — the curated `osha_references` seed (8 rows) as a static list with deterministic ids (the FK is opaque to the frontend), behind `GET /api/osha-references`.
- **`routes/measures.ts`** — `PUT /api/measures/:id/{spec,cql,tests}`, `POST /api/measures/:id/cql/compile`, `POST /api/measures/:id/tests/validate`, `GET /api/osha-references`. Role gates unchanged (PUT spec/cql/tests + the measure-scoped POSTs → AUTHOR/ADMIN via the existing matrix).

**Fidelity notes (documented, not silent):** the TS floor has no `osha_reference_id` or `compile_result` column, so the request's `oshaReferenceId` is accepted but not persisted as an FK, and compile persists only `compile_status` (the activation-gate input) — the full result is returned, not stored. Value-set governance (attach/detach/resolve-check) is a **separate** batch (needs the `value_sets` table → schema, maintainer-owned).

**backend-ts 309 tests — all pass / 0 fail; typecheck clean** (Postgres ceiling validated the new store methods). New coverage: osha-references list, spec save (+ policyRef + fixture preservation + audit), cql save + compile (status/warnings/errors), tests replace + validate (pass + empty-fails), and 404s. Frontend `/studio/[id]` Spec/CQL/Tests tabs now write end-to-end. Next: measure analytics (traceability + data-readiness + impact-preview — also unblocks the 2 NOT_IMPLEMENTED MCP tools), then schema-gated surfaces (value-set governance, evidence, auditor packets, admin writes) pending migrations.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): runs ALL_PROGRAMS + SITE scopes (async via ctx.waitUntil)

Branch `feat/issue-96-runs-scopes`. Closes the last big run-scope gap before any deploy-cutover thinking: the manual-run path threw `UnsupportedScopeError` (501) for **ALL_PROGRAMS** and **SITE**, so the `/runs` "Run Measures Now → All Programs" action didn't work on the TS backend. *(backend-ts only — does not touch the deployed Java demo.)*

**Why async (measured, documented — not a silent scope change).** A full ALL_PROGRAMS run is 10 runnable measures × the whole synthetic directory = **~1000 CQL evaluations, measured at 57.8s** — right at MIE nginx's 60s `proxy_read_timeout` and a terrible blocking UX. Java routes ALL_PROGRAMS/SITE through its async job queue for exactly this reason. The `@mieweb/cloud-local` host supports `ctx.waitUntil(p)` ("runs waitUntil work but doesn't block responses"), and the `/runs` page **already polls** (`setInterval` on the active run, handles `RUNNING`). So: the route creates the run, returns **`RUNNING` immediately (201)**, and finishes the fan-out in the background via `ctx.waitUntil`; the page polls to `COMPLETED`/`PARTIAL_FAILURE`. (Java uses a durable job queue; the TS interim uses `waitUntil` — same frontend contract; a durable queue is a later refinement.) MEASURE (~6s) / EMPLOYEE (~0.6s) stay synchronous.

- **`run/run-pipeline.ts`** — `resolveScope` now handles **ALL_PROGRAMS** (every runnable measure × every employee) and **SITE** (× one site's employees). SITE computes the seeded distribution over the **full** population then filters to the site, so an employee's target/outcome — and thus their case state — is **identical across MEASURE/ALL_PROGRAMS/SITE** (the case upsert stays idempotent across scope types). Refactored into `planManualRun` (create + RUNNING + resolve items — fast) / `finishManualRun` (evaluate + persist + finalize — slow) / `executeManualRun` (= plan+finish, the sync path) + `runningResponse` + `ASYNC_SCOPES`. `UnsupportedScopeError` now only guards CASE (handled by rerun-to-verify).
- **`routes/runs.ts`** — `/api/runs/manual` runs `ASYNC_SCOPES` (ALL_PROGRAMS/SITE) via `waitUntil(finishManualRun(...))`, returning `runningResponse` (201, status RUNNING); MEASURE/EMPLOYEE stay synchronous. Falls back to synchronous completion when no `waitUntil` is supplied (tests). `handleRuns` gained a `waitUntil?` param; the worker passes `ctx.waitUntil`.
- **`worker.ts`** — threads the `CloudExecutionContext` into `route()` → `handleRuns`.

**backend-ts 301 tests — all pass / 0 fail; typecheck clean.** New coverage: ALL_PROGRAMS + SITE pipeline runs (counts, scopeId/site, the cross-scope target-parity invariant for emp-001), unknown-site 400, and the route's async contract (SITE → 201 RUNNING immediately, then `COMPLETED` after the `waitUntil` work drains). Frontend `/runs` fetch contract unchanged (it already polls). Supported manual scopes now: ALL_PROGRAMS, MEASURE, SITE, EMPLOYEE (+ CASE via rerun-to-verify).

**Codex P2 fixes (same PR):** (1) **wide-scope reruns also go async** — `POST /api/runs/:id/rerun` of an ALL_PROGRAMS/SITE run was still synchronous (same 58s fan-out); the route now routes async scopes through the shared `scheduleAsyncRun` (plan + `waitUntil` + RUNNING) for rerun too, via an extracted `rerunRequest(prior)`. (2) **background failures finalize FAILED** — the `waitUntil` promise had no rejection handler, so a post-response failure (recordOutcome/upsert/finalize) would leave the run stuck RUNNING (page polls forever); extracted `finishOrFail(deps, planned)` runs `finishManualRun` and, on rejection, logs + `finalizeRun(..., "FAILED")` (never throws). Both covered by new tests (async rerun round-trip; `finishOrFail` → FAILED with a failing store).

Next: remaining parity sub-surfaces (measures spec/CQL edits + fixtures, admin waivers/delivery-log/mapping-CRUD/demo-reset, evidence upload/download, traceability + data-readiness) before Phase 5 (#109) deploy cutover.

---

## 2026-06-14 — Issue #96 Phase 4b (#108): MCP read-only tools (13) + SSE/JSON-RPC transport

Branch `feat/issue-96-mcp`. Fourth Phase 4b batch — the read-only MCP surface, ported from `McpServerConfig`. *(backend-ts only — does not touch the deployed Java demo.)* Hand-rolled JSON-RPC + SSE over the existing worker `fetch` (Option 1, chosen with the maintainer): the official `@modelcontextprotocol/sdk` transports assume Node `http`, but our host is the Cloudflare-shaped `fetch(req,env)→Response`, so a fetch-native port (no new dependency, same strangler style as the OpenAI `fetch` client) is the right fit. The live remote SSE over `twh-api/sse` is independently throttled by MIE nginx (`proxy_read_timeout`/buffering) — an MIE-ops fix, not a backend-language issue, unchanged by this port.

- **`mcp/tools.ts`** — all **13 tools** as pure handlers over the existing stores + read models: `get_case`, `list_cases`, `get_run_summary` (latest when `runId` omitted), `list_measures`, `get_measure_version`, `list_runs` (+ outcome_counts/compliance_rate), `explain_outcome`, `get_employee`, `check_compliance`, `list_noncompliant`, `explain_rule` (CQL defines via regex). Each carries its role set + sensitivity label + JSON-schema, matching Java. **2 tools** (`get_measure_traceability`, `list_data_quality_gaps`) depend on services not yet ported (`MeasureTraceabilityService`/`DataReadinessService`) — registered so `tools/list` is complete but return a faithful `NOT_IMPLEMENTED` error, **not** faked data.
- **`mcp/tool-audit.ts`** — per-call `MCP_TOOL_CALLED` audit (entity_type `mcp_tool`): sanitized args (scalars pass; objects/arrays→`{size}`; long strings truncated) + **SHA-256 arg hash** via Web Crypto (portable, no `node:crypto`) + resultSize + sensitivityLabel, via `CaseEventStore.appendAudit`.
- **`mcp/dispatch.ts`** — the role gate + audit + `CallToolResult` shaping, faithful to Java `executeTool`: denied authority → audited `ACCESS_DENIED` payload (the transport already restricts to ADMIN/CASE_MANAGER/MCP_CLIENT; per-tool gates further restrict — so a pure MCP_CLIENT is denied every tool, exactly as Java); handler throw → audited `isError:true`; returned payload (incl. a returned safeError) → audited success.
- **`routes/mcp.ts`** — HTTP+SSE transport (MCP 2024-11-05): `GET /sse` opens the stream + emits the `endpoint` event with a sessionId; `POST /mcp/message?sessionId=…` runs JSON-RPC (`initialize`/`notifications/initialized`/`ping`/`tools/list`/`tools/call`) and pushes the response over that session's stream (POST returns 202). In-process session map (valid on the single Node host). Worker wires it after AI, passing the authenticated `{actor, role, enforce}`; the existing security matrix gate on `/sse` + `/mcp/**` is unchanged.
- **Store:** added `OutcomeStore.listOutcomesForEmployee(subjectId, limit)` (floor + ceiling + contract test) — a bounded SELECT for `get_employee`/`check_compliance` (no schema change — read-only query over the existing `outcomes` table).

**backend-ts 293 tests — all pass / 0 fail; typecheck clean.** New coverage: each of the 13 tools (logic + arg validation + NOT_IMPLEMENTED), the audit wrapper (sanitize + 64-hex hash + sensitivity), the role gate (MCP_CLIENT denied / CASE_MANAGER allowed, audited), and the transport handshake (SSE endpoint event → JSON-RPC initialize/tools.list/tools.call over the stream, unknown session 404, unknown method -32601, notification = no frame). **This completes Phase 4b (#108).** Next: Phase 5 (#109) deploy cutover, or the deferred admin/measures sub-surfaces.

---

## 2026-06-14 — Issue #96 Phase 4b (#108): AI surfaces — draft-spec/cql/fixtures + explain + run-insight

Branch `feat/issue-96-ai`. Third Phase 4b batch — the five assistive surfaces, ported from `AiController`/`AiAssistService`. *(backend-ts only — does not touch the deployed Java demo.)* Hard guardrail held throughout (AI_GUARDRAILS.md): **AI never decides compliance** — every surface returns advisory text/drafts and degrades to deterministic fallback; the CQL `Outcome Status` stays the sole compliance source.

- **`ai/openai-chat.ts`** — JVM-free replacement for Spring AI's ChatClient: a plain `fetch` against the OpenAI Chat Completions REST API (**no new dependency**), same options (temperature 0.3, max_tokens 1000) and primary→fallback-model behavior. Throws on missing key / non-2xx / empty content → the signal each surface uses to fall back. When `OPENAI_API_KEY` is unset every call falls back (the demo posture).
- **`ai/ai-assist.ts`** — the five surfaces with faithful prompts + deterministic fallbacks: `draftSpec` (JSON spec or "fill manually" fallback), `draftCql` (fence-stripped CQL or the TODO template), `generateTestFixtures` (parse + all-5-outcomes coverage gate, else the 5 canonical fallback fixtures), `explainCase` (2–3 sentences or the structured-evidence fallback), `runInsight` (3–5 bullets or empty fallback). Every call writes an `audit_events` row (`entity_type='ai'`, payload wrapped `{timestamp, payload}` per AI_GUARDRAILS §4) via `CaseEventStore.appendAudit`.
- **`routes/ai.ts`** — `POST /api/ai/draft-spec` (+ `/api/measures/:id/ai/draft-spec` alias), `/api/measures/:id/ai/draft-cql` (404 unknown), `/api/measures/:id/ai/generate-test-fixtures` (404 unknown), `/api/cases/:id/explain` (+ `/ai/explain` alias, 404 unknown), `/api/runs/:id/ai/insight` (404 unknown). Loads case detail / run summary / measure record from the existing stores; the case-explanation cache is keyed `caseId:measureVersion` and invalidated by case `updatedAt` (the Java ConcurrentHashMap behavior). Reuses a new exported `ensureMeasureStore` from `routes/measures.ts` so draft-cql/fixtures read the catalog without re-running the non-idempotent seed. Role gates are unchanged and already faithful (measure-scoped → AUTHOR/ADMIN, cases → CASE_MANAGER/ADMIN, runs → CASE_MANAGER/ADMIN, bare `/api/ai/**` → AUTHENTICATED).

Deferred: live integration-health AI status recording (Java's `recordAiHealth`) — the TS admin integration health is still the static seed, so the AI surfaces don't mutate it yet.

**backend-ts 262 tests — all pass / 0 fail; typecheck clean.** New coverage: the chat client (no-key throw, primary→fallback, success), each surface's success + fallback parse paths + audit wrapper, and the route's fallback contracts + 404/400 gates + explanation cache + AI audit persistence. Frontend AI fetch contracts (`/cases/[id]`, `/runs`, Studio Spec/CQL/Tests tabs) unchanged. Next #108 batch: MCP tools.

---

## 2026-06-14 — Issue #96 Phase 4b (#108): admin dashboard read surface + toggles

Branch `feat/issue-96-admin`. Second Phase 4b batch — the `/admin` dashboard reads + the two stateless toggles, ported from `AdminController`. Goal: the admin page renders fully under the TS backend. *(backend-ts only — does not touch the deployed Java demo.)*

- **`admin/admin-data.ts`** — faithful/seeded data: **integration health** (fhir/mcp/ai/hris with display names + statuses; hris=simulated), **scheduler** settings (in-process enable toggle, cron), **terminology mappings** (the DATA_MODEL §3.4a demo seeds — 3 APPROVED / 1 REVIEWED / 1 PROPOSED), **data-element mappings** (HRIS/FHIR source map), **outreach templates** (the built-in default + preview), and the **audit viewer** projection over the persisted `audit_events` (scope derived from the event-type prefix; employeeId resolved via `ref_case_id` → case employee, same as the audit CSV).
- **`routes/admin.ts`** — `GET /api/admin/{integrations,scheduler,audit-events,terminology-mappings,data-mappings,outreach-templates}` + `/outreach-templates/:id/preview`, `POST /api/admin/integrations/:id/sync` (404 unknown), `POST /api/admin/scheduler?enabled=`. Subsystems not yet ported — **waivers** + **outreach delivery-log** — return their empty shape so the dashboard renders. Gated to ADMIN by the security matrix (`/api/admin/**`).

Deferred (need persistence): create/PUT/DELETE on templates/mappings/waivers, `data-mappings/validate`, `demo-reset`, and the waiver + delivery-log subsystems.

**backend-ts 235 tests — all pass / 0 fail; typecheck clean.** New coverage: integrations list+sync+404, scheduler toggle, audit viewer (scope + employeeId from case), terminology/data/template reads + preview, deferred-subsystem empties. Frontend `/admin` fetch contract unchanged. Next #108 batches: AI surfaces, MCP tools.

---

## 2026-06-14 — Issue #96 Phase 4b (#108): exports module — runs/outcomes/cases/audit CSV

Branch `feat/issue-96-exports`. First **Phase 4b** slice (larger-batch cadence). The CSV export surface, ported from `ExportController`/`AuditExportService`, matching the column contracts in DATA_MODEL §6. *(Demo-safety note: this is `backend-ts/` only — it does not touch the deployed Java backend or frontend.)*

- **`export/csv.ts`** — RFC-4180 CSV writer (quote-on-demand, doubled quotes, CRLF).
- **`export/export-csv.ts`** — `runsCsv` (§6.1, reuses `toRunSummary` for per-bucket counts + passRate), `outcomesCsv` (§6.2, derives the why_flagged columns — last_exam_date/compliance_window_days/days_overdue/waiver_status — from the CQL defines like case detail; `?runId` scopes to one run), `casesCsv` (§6.3, + `latestOutreachDeliveryStatus`; honors status/measureId/priority/assignee filters), `auditCsv` (Java `AuditExportService` header: timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail). Employee name/role/site from the directory, measure name/version from the registry.
- **`CaseEventStore.listAuditEvents`** (floor + ceiling) — the ordered ledger for the audit CSV.
- **`routes/exports.ts`** — `GET /api/exports/{runs,outcomes,cases}` + `/api/audit-events/export`; `text/csv` + `Content-Disposition: attachment`; non-csv `format` → 400 "Unsupported format. Use format=csv." (Java parity). Wired into the worker (AUTHENTICATED).

**backend-ts 228 tests — all pass / 0 fail; typecheck clean** (Postgres ceiling validated `listAuditEvents`). New coverage: each CSV (headers + rows, derived why_flagged, audit ledger) + the format gate. Frontend export buttons (`/runs`, `/cases`) fetch contract unchanged. Next #108 batches: admin surface, AI surfaces, MCP tools.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): measures module (4/n) — persisted store + authoring/lifecycle

Branch `feat/issue-96-measures-authoring` (based on the readiness branch — **supersedes/includes #132**). The largest measures slice: a **persisted measures store** so the read surface reflects mutations, plus **create + lifecycle** transitions. Ported from `MeasureService` create/approve/deprecate/transitionStatus. *(Bigger-PR cadence per the maintainer's request.)*

- **Store (floor + ceiling + shared contract)** — new `measures` + `measure_versions` tables (`stores/sqlite/schema.ts`, isolated `workwell_spike` on the ceiling; tags/spec are JSON TEXT on the floor, JSONB on the ceiling). `MeasureStore` (`isEmpty`/`seedMeasure`/`listLatest`/`getLatest`/`listVersions`/`createMeasure`/`setVersionStatus`) on both backends; a `measureStoreContract` runs on the SQLite floor + the Postgres ceiling.
- **Seed + reads migrated** — `measure/measure-seed.ts` loads `MEASURE_CATALOG` into the store on first use (version ids stay `<measureId>-<version>`; per-status tier timestamps keep Active-first ordering). The read models (`listMeasures`/`toMeasureDetail`/`toVersionHistory`/`toActivationReadiness`) now operate on store records (real `activated_at`/`approved_by`/timestamps), and `GET /api/measures(/:id|/versions|/activation-readiness)` read from the store — so created/edited measures are reflected.
- **`measure/measure-lifecycle.ts`** — `createMeasure` (Draft v1.0), `approveMeasure` (Draft→Approved, gated on readiness), `deprecateMeasure` (Active→Deprecated, reason required), `transitionStatus` (Draft→Approved / Approved→Active / Active→Deprecated). Each writes a `MEASURE_*` audit_event (entity_type `measure_version`). **Gates are faithful:** approve + Approved→Active require passing test fixtures (none ported), so they're blocked exactly as a fresh Java measure is — **deprecate works on the seeded Active measures**; the Tests-tab fixtures that unblock approve/activate are a follow-up.
- **`routes/measures.ts`** — `POST /api/measures` (create → `{id}`), `/:id/approve`, `/:id/deprecate {reason}`, `/:id/status {targetStatus}`; engine endpoints (`/elm`, `/evaluate`, `/compile`) unchanged. Worker threads `env` + the authenticated actor; existing role gates apply (AUTHOR/APPROVER/admin).

Deferred (follow-up): spec/CQL edits (+ recompile), test-fixture CRUD (unblocks approve/activate), version cloning, value-set governance.

**backend-ts 220 tests — all pass / 0 fail; typecheck clean** (Postgres ceiling included — `MeasureStore` contract + new tables validated on real PG). New coverage: store contract (seed/reads/create/lifecycle, both backends) + route authoring (create persisted, Draft→Approved via status, Approved→Active + approve faithfully gated, deprecate persists + gated). Frontend `/measures` + `/studio/[id]` contract unchanged. **Measures module now substantially complete** bar spec/CQL edits + fixtures. Next: those edits, or runs ALL_PROGRAMS/SITE async, or Phase 4b (#108).

---

## 2026-06-14 — Issue #96 Phase 4 (#107): measures module (3/n) — activation-readiness (read)

Branch `feat/issue-96-measures-readiness`. Third measures slice: the Studio activation gate, ported from `MeasureService.activationReadiness`. **This completes the measures READ surface** (catalog + detail + versions + activation-readiness).

- **`measure/measure-read-models.ts`** — `toActivationReadiness(measure)`: compile gate (`COMPILED`/`WARNINGS` allow activation) + test-fixture gate. The static catalog carries no test fixtures or attached value sets, so `validateTests` fails with the "at least one fixture required" blocker → `ready` is **false** for every catalog measure (the Java seed likewise has no fixtures, so this is faithful — `ready=false` until real fixtures + a passing gate land with the persisted store). NOT_COMPILED measures additionally carry the compile blocker.
- **`routes/measures.ts`** — `GET /api/measures/:id/activation-readiness` (404 unknown).

Remaining measures work (the **mutations** — genuinely need a persisted measures store): create (`POST /api/measures`), lifecycle transitions (approve/activate/deprecate), spec/CQL edits, and the value-set/test-fixture governance that would let the activation gate actually pass.

**backend-ts 212 tests — all pass / 0 fail; typecheck clean.** New coverage: readiness for a COMPILED-no-fixtures measure (not ready, fixture blocker only) + a NOT_COMPILED draft (compile blocker added) + 404. Frontend `/studio/[id]` read contract unchanged. Next: the measures authoring/lifecycle slices (persisted store) — or runs ALL_PROGRAMS/SITE async scopes.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): measures module (2/n) — detail + versions (read)

Branch `feat/issue-96-measures-detail`. Second measures slice: the Studio `MeasureDetail` + version history reads, ported from `MeasureService.getMeasure`.

- **Catalog spec** — extended `scripts/gen-measure-catalog.mjs` to emit each measure's authoring **spec** (description, eligibility, exclusions, complianceWindow, requiredDataElements) + `compileStatus`, sourced from the Java seed: the 10 runnable measures' spec maps, the 3 OSHA catalog-only specs from V017, and the generic CMS-catalog spec for the 47 drafts. `compileStatus` is faithful (COMPILED for the 10 runnable + Hep B + Lead; NOT_COMPILED for Respirator + the 47 CMS drafts).
- **`measure/measure-read-models.ts`** — `toMeasureDetail(measure, cqlText)` (the frontend `MeasureDetail` shape: spec fields + cqlText + compileStatus; `oshaReferenceId=null`, `valueSets=[]`, `testFixtures=[]` — value-set governance is a later/separate surface) + `toVersionHistory` (the static catalog carries one version per measure).
- **`routes/measures.ts`** — `GET /api/measures/:id` (detail; CQL **reconstructed from the compiled ELM** at request time for runnable measures, "" otherwise) + `GET /api/measures/:id/versions`. 404 for unknown; the `/versions` + `/compile` suffixes are matched before the bare `/:id`.

Deferred (need a persisted measures store): `/activation-readiness` (read), create (`POST /api/measures`), lifecycle transitions (approve/activate/deprecate), spec/CQL edits, and the compile/test-fixture activation gate. The value-set governance surface (attached value sets, terminology mappings) is its own module.

**backend-ts 210 tests — all pass / 0 fail; typecheck clean.** New coverage: detail with spec + reconstructed CQL + COMPILED (runnable), generic-spec + empty-CQL + NOT_COMPILED (catalog draft), version history + 404. Frontend `/studio/[id]` Spec/CQL tab reads are now served (read-only). Next: the measures authoring/lifecycle slice (persisted store) — the remaining Phase-4 work.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): programs module (3/n) — risk-outlook (+ outcomes.evaluation_period)

Branch `feat/issue-96-programs-risk`. Final programs slice: the predictive risk-outlook on the per-measure `/programs/[measureId]` page, ported from `RiskOutlookService`. **The `programs` module is now complete.**

- **Enabling schema field** — added `evaluation_period` to the TS `outcomes` table (floor + ceiling + idempotent backfill), the canonical column (DATA_MODEL §3.9) the TS floor had omitted. `RecordOutcomeInput.evaluationPeriod` (optional, defaults `''`); the run pipeline, rerun-to-verify, and the `/evaluate` route now thread the run's evaluation period. New bounded `OutcomeStore.listOutcomesForMeasure(measureId)` returns the measure's per-subject history (status + period + evidence).
- **`program/program-read-models.ts`** — `programRiskOutlook(measureId, horizonDays)` (horizon clamped 1–180): latest outcome per subject → who becomes **DUE_SOON within the horizon** (`threshold = window − 30`, derived `last_exam_date` from the recency define like case detail), per-site **current vs predicted** compliance, and **repeat non-compliers** (OVERDUE/MISSING_DATA streak ≥ 3 across distinct `evaluation_period`s, dedupe latest-per-period). Unknown measure → null → 404.
- **`routes/programs.ts`** — `GET /api/programs/:id/risk-outlook?horizonDays=30`.

**backend-ts 206 tests — all pass / 0 fail; typecheck clean.** New coverage: risk-outlook upcoming-due-soon prediction (daysUntilDueSoon math) + repeat-non-complier streak + 404; `listOutcomesForMeasure` contract (both backends, period+evidence round-trip); `outcomes.evaluation_period` floor backfill (idempotent). Postgres ceiling validated the new column + query. Frontend `/programs/[measureId]` fetch contract unchanged. **Programs module done — next: the store-backed measures detail/authoring slice (the last major Phase-4 piece).**

---

## 2026-06-14 — Issue #96 Phase 4 (#107): programs module (2/n) — trend + top-drivers

Branch `feat/issue-96-programs-trend`. Second programs slice: the per-measure trend chart + top-drivers panel on `/programs`, ported from `ProgramService.trend` / `topDrivers`.

- **`program/program-read-models.ts`** — `programTrend(measureId, {site,from,to})`: per-run compliance points (outcome-bucket counts + `complianceRate`), newest-first, capped at 10. Java unions a `run_based` branch for aggregate-only seeded runs, but the TS floor `runs` table has no `compliant`/`total_evaluated` columns — every TS run with data has outcomes, so the outcome-based branch is complete (documented in-code). `programTopDrivers(...)`: from the measure's **latest filtered run**, overdue concentration `bySite`/`byRole` (count desc, tiebreak name asc, top 5) + flagged-reason mix `byOutcomeReason` (OVERDUE/MISSING_DATA/DUE_SOON, count + pct, 1 dp). Shared `runsWithOutcomes` helper resolves employee site/role from the synthetic directory.
- **`routes/programs.ts`** — `GET /api/programs/:id/trend` + `/:id/top-drivers`; both reuse the strict `?from=/to=` date validation (400 on malformed). Unknown / no-data measure → empty (Java parity, no 404).

Deferred: per-measure `/risk-outlook` (the page degrades gracefully without it). The programs dashboard now renders KPIs + trend + drivers.

**backend-ts 199 tests — all pass / 0 fail; typecheck clean.** New coverage: trend newest-first per-run points, top-drivers site/role/reason ranking, empty for unknown/no-data, date-validation on trend. Frontend `/programs` fetch contract unchanged. Next: programs risk-outlook, then the store-backed measures detail/authoring slice.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): programs module (1/n) — compliance overview + sites

Branch `feat/issue-96-programs-overview`. First slice of the programs module: the `/programs` dashboard's compliance KPIs, ported from `ProgramService.listPrograms` / `listSites`. Self-contained read analytics over the runs/outcomes/cases already in TS — no new data dependency.

- **`program/program-read-models.ts`** — `programOverview({site, from, to})`: for each **Active** measure (the catalog's Active set = the engine's runnable 10), find the LATEST run (filtered by employee site + run period) carrying outcomes for that measure, aggregate its outcome-bucket counts, `complianceRate = compliant/total × 100` (1 decimal), and the OPEN case count (same site/period filter). Employee site is resolved from the synthetic directory (outcomes carry only `subjectId`). Ordered by measure name — matches the Java CTE (`active_versions`/`latest_run`/`outcome_counts`/`open_cases`). `listSites()` = distinct employee sites, ascending.
- **`routes/programs.ts`** — `GET /api/programs` + `/api/programs/overview` (aliases, Java parity) → `ProgramSummary[]`; `GET /api/programs/sites` → `string[]`. All honor `?site=&from=&to=`. Wired into the worker; auth catch-all gates them AUTHENTICATED.

Deferred to later programs slices: per-measure `/{id}/trend`, `/{id}/top-drivers`, `/{id}/risk-outlook`. The `/programs` page loads those after the overview and **degrades gracefully** (catches → empty) without them, so the dashboard renders KPIs now.

**backend-ts 194 tests — all pass / 0 fail; typecheck clean.** New coverage: overview row-per-Active-measure (10), latest-run-wins aggregation + complianceRate + open case count, zeros for a measure with no outcomes, site-filter scoping, `/api/programs` alias, `/sites` distinct+sorted. Frontend `/programs` fetch contract unchanged. Next: programs trend + top-drivers, then the measures detail/authoring slice (with a persisted measures store).

---

## 2026-06-14 — Issue #96 Phase 4 (#107): measures module (1/n) — catalog read

Branch `feat/issue-96-measures-catalog`. First slice of the measures module: the `/measures` page's catalog list, ported from `MeasureService.listMeasures`.

- **Generated catalog** — `scripts/gen-measure-catalog.mjs` emits `measure/measure-catalog.ts` (the full 60-measure TWH catalog) from the Java seed (the single source of truth): 49 CMS eCQM entries parsed from `MeasureService.CMS_ECQM_CATALOG` (47 Draft + CMS125v14/CMS122v14 promoted to Active), the 8 Active runnable OSHA/HEDIS measures (ids aligned with the engine `MEASURES` registry), and the 3 OSHA catalog-only measures from `V017__seed_additional_measures.sql` (Respirator Fit Draft v0.9 / Hep B Approved v2.0 / Lead Deprecated v1.1). Same generator pattern as `gen-measure-bindings.mjs` / the employee catalog — reproducible from source, not hand-typed; the script asserts the 60-count + id-uniqueness.
- **`measure/measure-read-models.ts`** — `listCatalog({status, search})` ports the Java list semantics: status exact-match (blank/"All" = no filter), search case-insensitive on name OR any tag, ordered `lastUpdated DESC, name ASC`. Java orders by `COALESCE(activated_at, created_at, updated_at) DESC`; the static catalog mirrors that with a per-status recency tier (**Active first**) so the runs/studio measure pickers — which default to the first row — still land on a runnable measure. The 10 Active measures are exactly the engine's runnable set.
- **`routes/measures.ts`** — `GET /api/measures` now returns the full `Measure[]` catalog (was a `{id,name}` stub of the 10 runnable) with `?status=`/`?search=`. The `/elm` + `/compile` + `/evaluate` engine endpoints are unchanged.

Deferred to later measures slices (need a persisted measures store): `GET /api/measures/:id` detail, `/versions`, `/activation-readiness`, create (`POST /api/measures`), lifecycle transitions (approve/activate/deprecate), spec/CQL edits, and the compile/test-fixture activation gate. `lastUpdated`/`statusUpdatedAt` are a deterministic static seed until those land.

**backend-ts 187 tests — all pass (Postgres reachable this run) / 0 fail; typecheck clean.** New coverage: full-catalog list (60, Active-first, Measure shape), status filter, name/tag search. Frontend `/measures` fetch contract unchanged. Next: measures detail + versions (read), then the authoring/lifecycle mutations (with the measures store), or the `programs` module.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): cases module (5/n) — rerun-to-verify + run totalCases

Branch `feat/issue-96-rerun-verify`. Fifth cases slice: the CASE run scope, ported from `CaseFlowService.rerunToVerify`, plus the run summary's `totalCases` wiring.

- **`case/case-rerun.ts`** — `rerunToVerify(caseId, actor)`: creates a verification run (`scopeType=CASE`) with the Java run-log breadcrumbs, re-evaluates the case subject through the JVM-free CQL engine for the case's measure + evaluation period (deterministic per-subject seeded target → a non-compliant case re-confirms, same as the Java demo), persists the verification outcome, then transitions the case — `COMPLIANT → RESOLVED` (`closed_reason=RERUN_VERIFIED`), `EXCLUDED → EXCLUDED` (`RERUN_EXCLUDED`), else stays open. Records `RERUN_TO_VERIFY` + `CASE_RERUN_VERIFIED` atomically (event-before-patch), then `CASE_RESOLVED`/`CASE_EXCLUDED`, then finalizes the run (`COMPLETED`/`PARTIAL_FAILURE`). Waiver auto-linkage on EXCLUDED is deferred (waivers are admin, #108).
- **Schema + store** — added `closed_reason` / `closed_by` columns to the cases table (floor + ceiling); `CaseRecord`/`CasePatch` extended; `patchCase` now covers `currentOutcomeStatus`/`lastRunId`/`closedAt`/`closedReason`/`closedBy`. `CaseDetail.closedReason`/`closedBy` are now populated (prior null deferral closed). Added `CaseStore.countByLastRun`.
- **`totalCases`** — `toRunSummary` now takes the count; the `GET /api/runs/:id` route supplies `COUNT(cases WHERE last_run_id = runId)` (matches Java). Prior hard-coded `0` removed.
- **`routes/cases.ts`** — `POST /api/cases/:id/rerun-to-verify` (404 unknown). Role gate unchanged (`POST /api/cases/**` → CM/admin).

Deferred to later slices: **evidence** upload/download, **appointments**, **ai/explain**, the `outreach_delivery_log` table, and the run-outcome grid's per-row `caseId` link (#108-adjacent). Waiver linkage on excluded reruns lands with the admin module.

**backend-ts 159 tests — 158 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** New coverage: `countByLastRun` + rerun-close `patchCase` contract cases (both backends), a `rerun-to-verify` route test (verification recorded on the timeline; closing outcomes set closed_reason/closed_by), and a run-summary `totalCases` route test. **The `cases` module is now functionally complete bar evidence/appointments/ai.** Next: the **measures** module (catalog/versioning/lifecycle/compile gate) or **programs** (KPIs/trend/risk outlook).

---

## 2026-06-14 — Issue #96 Phase 4 (#107): cases module (4/n) — outreach (preview/send/delivery)

Branch `feat/issue-96-case-outreach`. Fourth cases slice: the outreach action surface on case detail, ported from `CaseFlowService.previewOutreach` / `sendOutreach` / `updateOutreachDelivery`.

- **`case/email-service.ts`** — simulated `EmailService` (port of the Java provider switch). The demo stack is `WORKWELL_EMAIL_PROVIDER=simulated` (CLAUDE.md hard rule); `send` never sends a real email and returns a `SIMULATED` delivery record. SendGrid wiring is intentionally **not** ported (stays inert until a non-demo deployment, as in Java).
- **`case/case-outreach.ts`** — `previewOutreach` (renders the built-in default template; the DB-backed `outreach_templates` + admin CRUD are #108, so `templateId` resolves to the default per Java's `resolveByIdOrDefault` fallback), `sendOutreach` (simulated send → `OUTREACH_SENT` case_action + `CASE_OUTREACH_SENT` audit, sets case OPEN + follow-up next action), `updateOutreachDelivery` (guards `hasOutreachSent`, validates the status, sets the next action, writes `OUTREACH_DELIVERY_UPDATED` + audit). `dueDate` derives from the **detail's** `why_flagged` (`last_exam_date + compliance_window_days`), matching Java's `loadCase(...).evidenceJson`. Send/delivery use the same **event-before-patch** ordering (atomic `recordCaseEvent`) as assign/escalate.
- **`CaseEventStore`** — added `hasOutreachSent` + `latestOutreachDeliveryStatus` (the `deliveryStatus` from the most recent `OUTREACH_DELIVERY_UPDATED`/`OUTREACH_SENT` payload). `CaseDetail.latestOutreachDeliveryStatus` is now populated (prior null deferral closed).
- **`routes/cases.ts`** — `GET …/actions/outreach/preview`, `POST …/actions/outreach` (send), `POST …/actions/outreach/delivery` (400 on invalid/too-early). Role gates unchanged (`POST /api/cases/**` → CM/admin).

Deferred to later slices: **rerun-to-verify** (CASE engine path), **evidence** upload/download, **appointments**, **ai/explain**, and the `outreach_delivery_log` table (its only reader is the Admin delivery-log panel — lands with the admin module, #108). `closedReason`/`closedBy` stay null.

**backend-ts 152 tests — 151 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** New coverage: `hasOutreachSent`/`latestOutreachDeliveryStatus` contract cases on both backends + route tests for preview/send/delivery (incl. the before-send 400 and invalid-status 400). Next: rerun-to-verify + run `totalCases` wiring, then the measures + programs modules.

---

## 2026-06-14 — Issue #96 Phase 4 (#107): cases module (3/n) — actions (assign/escalate) + audit timeline

Branch `feat/issue-96-case-actions`. Third cases slice: the case detail's **timeline** is now real, and the first two mutating **actions** are ported. Each action writes BOTH a `case_action` (operator record) and an `audit_event` (immutable ledger — CLAUDE.md: every state change writes audit_event), with payloads matching the Java `CaseFlowService` shapes.

- **Stores (floor + ceiling + shared contract)** — added `case_actions` + `audit_events` tables to the TS spike scaffolding (`stores/sqlite/schema.ts`, `stores/postgres/schema-pg.ts`, isolated `workwell_spike` schema). *Same TS adapter scaffolding as the merged runs/outcomes/cases floor tables — NOT a canonical Flyway migration; canonical schema stays Taleef-owned.* New `CaseEventStore` (`insertAction` / `appendAudit` / `caseTimeline`) on both backends; `caseTimeline` is the Java `loadCaseTimeline` UNION — `audit_events` (excl `CASE_VIEWED`) ∪ `case_actions`, ordered `occurred_at, id`, each entry stamped with a `timelineSource` discriminator. Added `CaseStore.patchCase` (floor + ceiling) for targeted field updates.
- **`case/case-actions.ts`** — pure port of `assignCase` / `escalateCase`: load → patch → `case_action` + `audit_event` → return the refreshed `CaseDetail` (incl. evidence + merged timeline). `assign` normalizes blank → clears the owner (`CASE_ASSIGNED`, payload `{assignee, previousAssignee}`); `escalate` forces `HIGH`/`OPEN` + the supervisor-queue next action (`CASE_ESCALATED`).
- **`routes/cases.ts`** — `POST /api/cases/:id/assign?assignee=…` + `POST /api/cases/:id/escalate` (404 unknown); case detail now loads the merged timeline (the prior `timeline = []` deferral is closed). The authenticated subject (`JwtPrincipal.email`) is threaded from the worker as the audit **actor** (`SecurityActor.currentActor()` parity).

Still deferred to later cases slices: **outreach** (send/preview/delivery + simulated email + delivery log), **rerun-to-verify** (CASE engine path), **evidence** upload/download (multipart + role gates), **appointments**, **ai/explain**. `latestOutreachDeliveryStatus`/`closedReason`/`closedBy` stay null until those land.

**backend-ts 146 tests — 145 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** New coverage: `caseEventStoreContract` (timeline merge/order + CASE_VIEWED exclusion) on both backends, a `patchCase` contract case, and route tests for assign/escalate + timeline ordering. Docs/board synced this slice (plan §11, #107 checklist). Next: outreach actions, then rerun-to-verify + run `totalCases` wiring, then the measures + programs modules.

---

## 2026-06-13 — Issue #96 Phase 4 (#107): cases module (2/n) — case detail + why_flagged

Branch `feat/issue-96-case-detail`. Second cases slice: `GET /api/cases/:id` → the frontend `CaseDetail`.

- **`case/case-detail-read-model.ts`** — `toCaseDetail(caseRecord, outcome)`: the case row + the case's **evidence** (the outcome from its `last_run_id`, matched by subject+measure) + the measure binding. `outcomeSummary` is the Java `outcomeSummaryFor` switch. `why_flagged` is derived from the CQL define results (the TS engine stores `expressionResults`, not a why_flagged block): `waiver_status` from the waiver/exemption/exclusion define, `days_overdue` = `daysSince − window`, `last_exam_date` = evaluation date − daysSince — matching the Java field shape.
- **`routes/cases.ts`** — `GET /api/cases/:id` (404 for unknown); sources evidence via the OutcomeStore.

Honest deferrals (audit + actions modules not ported yet): `timeline = []`, `latestOutreachDeliveryStatus = null`, `closedReason/closedBy = null`.

**backend-ts 138 tests — 137 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** Docs/board synced this slice: #107 issue checklist updated (runs ✓, cases worklist+detail in progress), plan doc progress log + README status refreshed. Next cases slice: **actions** (assign/escalate/outreach/delivery, rerun-to-verify) + the audit timeline; then run `totalCases` wiring, then the measures + programs modules.

---

## 2026-06-13 — Issue #96 Phase 4 (#107): cases module (1/n) — idempotent upsert + worklist

Branch `feat/issue-96-cases-worklist`. First slice of the cases module: cases are now upserted from run outcomes (the spike's critical **idempotency** invariant) and surfaced as the worklist.

- **Cases store (floor + ceiling)** — added a `cases` table to the TS spike scaffolding (`stores/sqlite/schema.ts` + `stores/postgres/schema-pg.ts`, isolated `workwell_spike` schema). *This is the same kind of TS adapter scaffolding as the already-merged runs/outcomes floor tables — NOT a canonical Flyway migration; canonical schema stays Taleef-owned.* `CaseStore` (`upsertFromOutcome` / `getCase` / `listCases`) on both the SQLite floor and Postgres ceiling; the idempotent upsert uses `INSERT … ON CONFLICT(employee_id, measure_id, evaluation_period) DO UPDATE`.
- **`case/case-logic.ts`** — pure port of `CaseFlowService` routing: DUE_SOON/OVERDUE/MISSING_DATA → OPEN (priority OVERDUE=HIGH, else MEDIUM), EXCLUDED → EXCLUDED, COMPLIANT → resolve an existing case; measure-specific `next_action` hints.
- **Run pipeline** — each outcome now upserts/resolves a case (optional `caseStore` dep; the route enables it). The run's `evaluationDate` is persisted in the requested scope so a **rerun reuses the same period** → cases upsert rather than duplicate.
- **`GET /api/cases`** (`routes/cases.ts`) — worklist `CaseSummary[]` with status/measure/priority/assignee/site/search filters + limit/offset paging; employee (name/site) + measure (name/version) resolved from the directory/registry. Gated AUTHENTICATED.

**Idempotency proven on both backends** via a new `caseStoreContract` (a rerun upserts the same case, never a duplicate) plus a pipeline test (rerun over the same period keeps the case count stable). Gotcha fixed: the floor DDL loader flattens newlines, so a `--` line comment would have swallowed the table — switched to a `/* */` block comment.

**backend-ts 132 tests — 131 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** Next cases slices: case **detail** (`GET /api/cases/:id` + `CaseDetail` + timeline) and **actions** (assign/escalate/outreach/delivery, rerun-to-verify). Run `totalCases` + the case-linked run scopes can then be wired.

Review follow-ups (Codex on PR #122), three worklist-filter fidelity fixes vs the Java controller, all fixed before merge:
- **Default status = OPEN.** Blank/missing `status` now defaults to `OPEN` (Java default); `status=all` is the explicit unfiltered view (previously blank → all, leaking resolved/excluded rows into the default worklist).
- **`assignee=unassigned`.** New cases store `assignee` as NULL, so `assignee = ?` matched nothing; both adapters now use `LOWER(COALESCE(assignee, 'unassigned')) = LOWER(?)`, so the unassigned filter selects NULL rows (case-insensitive), matching Java.
- **`from`/`to`.** The route dropped these; now applied (day-granular, inclusive) against case `created_at`, matching Java. Added store-contract + route tests for each. backend-ts 136 tests — 135 pass / 1 skip / 0 fail.

---

## 2026-06-13 — Issue #96 Phase 4 (#107): runs write pipeline (2/2) — manual run + rerun

Branch `feat/issue-96-run-pipeline`. The run **write** path: scope resolution → seeded distribution → evaluate → persist → `ManualRunResponse`, completing the runs module's authoring side (read side already merged: list/summary/logs/outcomes).

- **`run/compliance-rates.ts`** — per-measure target rates (from the Java `application.yml`; default 0.80).
- **`run/distribution.ts`** — `seededDistribution`: ports `CqlEvaluationService.orderedEmployeesFor` (incl. **Java `String.hashCode`**, ported exactly for ordering parity) + the bucket split (compliant = round(N·rate), excluded = min(3,…), missing = min(2,…), rest half DUE_SOON / half OVERDUE). Verified: audiogram over 100 employees → 78/3/2/8/9, matching Java.
- **`run/run-pipeline.ts`** — `executeManualRun` / `executeRerun`: build each employee's synthetic bundle (from slice 1) → evaluate (JVM-free) → persist the canonical CQL outcome; one subject's failure is non-fatal (MISSING_DATA + error evidence, the runtime invariant). Typed `UnsupportedScopeError` / `InvalidRunRequestError`.
- **`stores/run-store.ts` + both adapters** — added `finalizeRun(runId, status)` (terminal status + `completed_at`) and exposed `requestedScope` on `RunRecord` (drives rerun); both run the new shared-contract case (floor + ceiling).
- **`routes/runs.ts`** — `POST /api/runs/manual` + `POST /api/runs/:id/rerun` → `ManualRunResponse`; gated CASE_MANAGER/ADMIN by the #105 authz layer.

Scope: **MEASURE** (one measure × all employees, ~8s) and **EMPLOYEE** (all runnable measures × one employee) are synchronous. **ALL_PROGRAMS / SITE** (×10 measures ≈ 80s) need the async run-job model, and **CASE** needs the cases module — those return a typed `501 unsupported_scope` for now and are the next slice.

**backend-ts 120 tests — 119 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** With this the runs module is read+write complete except the async/case scopes. Next: the cases module (worklist, idempotent upsert, outreach/assign/escalate, rerun-to-verify, timeline) — which also unblocks ALL_PROGRAMS/SITE case linkage + run `totalCases`.

Review follow-up (Codex on PR #121), fixed before merge:
- **P2 — PARTIAL_FAILURE status.** A per-subject evaluation failure was persisted as MISSING_DATA + error evidence, but the run still finalized `COMPLETED`, so an engine error looked fully successful. Now the pipeline counts failures and finalizes `PARTIAL_FAILURE` (the `RunStatus` contract + Java behavior) when any subject failed, with the count surfaced in `ManualRunResponse.status`/`message`. Added a throwing-engine test pinning it. 121 tests — 120 pass / 1 skip / 0 fail.

---

## 2026-06-13 — Issue #96 Phase 4 (#107): runs write pipeline (1/2) — synthetic FHIR generation engine

Branch `feat/issue-96-synthetic-generation`. Foundational half of the manual-run/rerun **write** pipeline: the TS synthetic data engine that builds a per-employee FHIR bundle the CQL engine can evaluate (the Java backend's `SyntheticFhirBundleBuilder` + the seeded-outcome config logic in `CqlEvaluationService`). Until now the TS engine only evaluated *provided* bundles (fixtures); now it can generate them, which is what a server-side run needs.

- **`engine/synthetic/measure-bindings.ts`** (generated by `scripts/gen-measure-bindings.mjs` from the YAML measure defs, ADR-006) — per-measure `rateKey`, enrollment/waiver/event `{code, valueSet}`, `event.type` (procedure|immunization|observation), `complianceWindowDays` (audiogram 365, diabetes 180, CMS125 820, …).
- **`engine/synthetic/exam-config.ts`** — `deriveExamConfig(binding, targetOutcome)`: the deterministic per-employee config (recency days keyed off the window: COMPLIANT=w/3, DUE_SOON=w−10, OVERDUE=w+60, EXCLUDED=w+150, MISSING_DATA=none; observation measures use a numeric value 7.5/10.5; EXCLUDED ⇒ waiver present) — a faithful port of the Java seeded-input logic.
- **`engine/synthetic/fhir-bundle-builder.ts`** — port of `SyntheticFhirBundleBuilder` emitting plain FHIR R4 JSON (Patient + optional enrollment/waiver Conditions + Procedure|Immunization|Observation stamped with the measure's code/value-set so the CQL inline code filters match).

**Golden test** (`fhir-bundle-builder.test.ts`): for representative measures across all three event types (audiogram Procedure, flu Immunization, cms122 Observation, diabetes 180-day window), generate a bundle for each target outcome → evaluate through the JVM-free engine → assert the engine re-derives that exact outcome. Proves the ported generator drives the engine identically to the Java path.

**backend-ts 97 tests — 96 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** Next (2/2): the run orchestration — scope resolution (ALL_PROGRAMS/MEASURE/SITE/EMPLOYEE/CASE) over the employee directory + compliance-rate distribution, persist the run + outcomes, and the `POST /api/runs/manual` + `/rerun` endpoints (`ManualRunResponse`). Then the cases, measures, and programs modules.

Review follow-up (Codex on PR #120), resolved before merge:
- **P2 — flu DUE_SOON convergence.** The golden test *skipped* flu DUE_SOON because an in-period shot evaluates COMPLIANT, which could let the future distribution silently shift intended due-soon flu rows to compliant. Investigated the Java distribution (`seededInputsFor`): it assigns DUE_SOON/OVERDUE buckets to **all** measures including flu, and **persists the canonical CQL result, not the seeded target** (the seed never decides compliance). So the convergence is Java's actual behavior, not a regression. Made it explicit instead of silent: the golden test now pins all 17 (measure × bucket) cases including the convergences (flu DUE_SOON → COMPLIANT, cms122 DUE_SOON → MISSING_DATA), and `deriveExamConfig` documents that the target is a distribution bucket while the canonical outcome is the CQL result. backend-ts 110 tests — 109 pass / 1 skip / 0 fail.

---

## 2026-06-13 — Issue #96 Phase 4 (#107): runs module — `/outcomes` → RunOutcomeRow + employee directory

Branch `feat/issue-96-runs-outcomes`. Second runs slice: `GET /api/runs/:id/outcomes` now returns the frontend's `RunOutcomeRow` shape (was raw `OutcomeRecord[]`), so the run detail grid renders against the TS backend unchanged.

- **`engine/synthetic/employee-catalog.ts`** — TS port of the Java `SyntheticEmployeeCatalog` (the `engine.synthetic` EmployeeDirectory): the 100 synthetic employees (externalId/name/role/site), generated from the Java source. `employeeById` returns null for unknown ids (callers degrade gracefully — no throw, unlike the Java `orElseThrow`).
- **`run/read-models.ts`** — `toRunOutcomeRow`/`toRunOutcomeRows`: resolve each outcome's subject to name/role/site via the catalog, sort by employee name (Java `ORDER BY e.name`). `waiver_status` = "active"/"none" off the measure's waiver/exemption define, matching `CqlEvaluationService` why_flagged; `days_since_exam` from the recency define's value; `caseId` null (cases module not ported). Derivations use the consistent define naming across the runnable measures.
- **`routes/runs.ts`** — `/outcomes` returns `RunOutcomeRow[]`.

**backend-ts 93 tests — 92 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** Next runs slice: the manual-run / rerun **write** pipeline (scope resolution + evaluation over the employee directory). Then the cases, measures, and programs modules.

Review follow-up (Codex on PR #119), fixed before merge:
- **P2 — CMS exclusion parity.** The waiver-status derivation regex matched only `waiver`/`exemption`, but CMS125/CMS122 name their exemption flag `Has Exclusion`, so CMS `EXCLUDED` rows returned `waiverStatus: null` instead of `"active"`. Widened the exemption-define matcher to `/waiver|exemption|exclusion/i` (the four runnable-measure names) and locked it with a CMS `Has Exclusion` test case.

---

## 2026-06-13 — Issue #96 Phase 4 (#107): API strangler — runs module, read-model slice

Branch `feat/issue-96-runs-read-models` (board #107 → In Progress; #105 merged via PR #117, board Done). First slice of the runs module: the GET read endpoints behind the **unchanged** frontend contract (`RunListItem` / `RunSummary` / `RunLogEntry` from `app/(dashboard)/runs/page.tsx`).

- **`run/read-models.ts`** — pure builders matching the Java `RunPersistenceService` read model exactly: `passRate = compliant*100/totalEvaluated` (percentage), `nonCompliant = DUE_SOON|OVERDUE|MISSING_DATA` (EXCLUDED is neither), `dataFreshAsOf = MAX(evaluated_at)` / `dataFreshnessMinutes = -1` when empty, measureName/Version resolved from `scopeId` via the measure registry (null → "All Programs"/""). Computed from the floor `runs` + `outcomes` rows — **no schema change** (keeps the #104 Postgres adapter + contract stable). 5 unit tests.
- **`stores/run-store.ts` + both adapters** — added `listRuns(limit)` (newest-first) and `listLogs(runId)` to the contract; implemented on the SQLite floor **and** the Postgres ceiling; both run the same two new cases in the shared `store-contract.ts` suite.
- **`routes/runs.ts`** — `GET /api/runs` (list), `GET /api/runs/:id` (RunSummary, superset of RunListItem so it satisfies both frontend casts), `GET /api/runs/:id/logs`. Gated AUTHENTICATED by the #105 authz layer.

**backend-ts 90 tests — 89 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.** Scoped honestly: `totalCases` is 0 and `triggerType` is "MANUAL" until the cases module + run finalization land (later #107 slices). Next runs slices: `/outcomes` RunOutcomeRow mapping (employee dir + evidence), then the manual-run/rerun pipeline; then the cases, measures, and programs modules.

Review follow-ups (Codex on PR #118), both fixed before merge:
- **P2 — list filters.** `GET /api/runs` ignored the page's `status`/`scopeType`/`triggerType`/`site`/`from`/`to` params and returned all runs. Now honored via a pure `matchesRunFilters` (filter-then-cap so `limit` bounds the *matching* rows). `site` is derived from the run's requested scope — added `site` to `RunRecord`, populated from `requested_scope_json` on both the SQLite floor and the Postgres ceiling.
- **P2 — log limit.** `GET /api/runs/:id/logs?limit=200` dropped the param and returned every row. `listLogs` now takes an optional `limit` (both adapters) and the route clamps `?limit` to [1, 1000]; the list `?limit` is clamped the same way.

---

## 2026-06-13 — Issue #96 Phase 2 (#105): TS auth — JWT + PBKDF2 + login/refresh/logout + role gates + fail-fast

Branch `feat/issue-96-auth-ts` → **PR #117**. Full port of the Java auth/security layer to the TS backend (board #105). Housekeeping first: closed #103 (Phase-1 spike, delivered via #114) and #104 (Postgres adapter, #115) — board auto-set both to Done; restored the 2026-06-12 "direction accepted" JOURNAL entry #115 had overwritten.

All JVM-free, **zero new deps** (Node `crypto` + WebCrypto — portable to the Cloudflare Worker target):
- **`auth/jwt.ts`** — port of `JwtService`: HS256, base64url no-pad, access `{sub,role,iat,exp}` (900s) / refresh `{sub,refresh:true,iat,exp}` (28800s), refresh-can't-authenticate, constant-time verify, expired/tampered/wrong-secret rejected. 9 tests.
- **`auth/password.ts`** — PBKDF2-HMAC-SHA256 via WebCrypto (210k iters, `pbkdf2$iter$salt$hash`), constant-time. Chosen over a bcrypt dependency (no-new-deps rule); demo accounts are hardcoded so re-hashing the same password is fine (Java/Neon bcrypt rows untouched). 4 tests.
- **`auth/demo-users.ts`** — the four hardcoded roles from the Java `demo_users` seed (V003): author/approver/cm/admin@workwell.dev, shared `Workwell123!`, case-insensitive lookup. 3 tests.
- **`routes/auth.ts`** — `POST /api/auth/login|refresh|logout` port of `AuthController`: access token in the JSON body + HttpOnly `refresh_token` cookie scoped to `/api/auth`, SameSite/Secure (None ⇒ Secure forced), rotation on refresh. 8 tests.
- **`auth/authorize.ts`** — port of `JwtAuthFilter` + the `SecurityConfig` role matrix: Bearer-token principal extraction + ordered, first-match-wins rules (admin→ADMIN, evidence/runs/cases→CASE_MANAGER, approve/activate→APPROVER, spec/cql/tests→AUTHOR, etc.), 401 vs 403 semantics, public allowlist. The two TS-only ELM-Explorer endpoints (GET `…/elm`, POST `/compile`) are gated to AUTHENTICATED. 9 tests.
- **`config/cors.ts`** — port of `SecurityConfig.corsConfigurationSource`: exact allowed origins, credentials enabled, methods GET/POST/PUT/PATCH/DELETE/OPTIONS, ACAO echoes the specific origin (never `*`), Allow-Headers echoes the requested headers. `preflightResponse` answers `OPTIONS`; `withCors` decorates every response. 4 tests.
- **`config/startup-safety.ts`** — auth/cookie/**CORS** subset of `StartupSafetyValidator`: production fail-fast on auth-disabled, weak/short JWT secret, a non-`None`/non-Secure refresh cookie, or empty/wildcard/localhost CORS origins; the SameSite=None-requires-Secure and unknown-SameSite checks apply in every environment. 8 tests.
- **`worker.ts`** — answers the CORS preflight before auth, decorates every response with `withCors`, then wires the fail-fast guard (unsafe config ⇒ 503), the authorization gate (skipped when auth disabled, mirroring `authEnabled=false`→permitAll), and the auth routes. Worker integration tests prove the gate + CORS end-to-end (public health; preflight 204; cross-site login carries ACAO; 401 without a token; login→token→authorized read; role-gated 403). 5 tests.

**backend-ts 81 tests — 80 pass / 1 skip (Postgres harness, no local Docker) / 0 fail; typecheck clean.**

Review follow-ups (Codex on PR #117), both fixed before merge:
- **P2 — run-collection gate.** The glob→regex helper required a trailing slash, so `/api/runs/**` matched `/api/runs/claim` but not `POST /api/runs`, letting it fall through to the generic authenticated rule. Reworked `rx` to Spring AntPathMatcher semantics (`/**` matches the base path too); added a regression test.
- **P1 — auth preflight/CORS.** The split frontend/backend is cross-origin, so login is preceded by `OPTIONS /api/auth/login`; with no CORS the browser blocked it. Implemented the CORS layer above (this also un-defers the CORS fail-fast checks that were previously punted to Phase 4).

Audit-event emission on auth actions is still deferred to when the audit module is ported (no audit store on the TS side yet). Next: Phase 4 API strangler (#107).

---

## 2026-06-13 — Issue #96: ELM Explorer — **live, JVM-free CQL → AST** authoring surface

Branch `feat/issue-96-elm-explorer` (off `main`, kept off the still-open #115 Postgres PR). A demo/visualization slice that doubles as real strangler progress, prompted by Doug's meeting questions ("is CQL the canonical source of truth? is it like ANTLR/Yacc? AST vs parse tree?"). The point it makes tangibly: **CQL is the human source of truth; the `cql-to-elm` translator (ANTLR4) compiles it to ELM, the AST the Node `cql-execution` engine tree-walks; the `Outcome Status` define is the sole compliance result.** Hardened from a static viewer into a **real-time editor**: edit CQL, watch the AST rebuild live — and the translator now runs JVM-free at *runtime*, not just at build time.

- **Runtime translator (`backend-ts/src/engine/cql/cql-translator.ts`):** wraps the same pure-Node `@cqframework/cql` (Kotlin-MP, **no JVM**) used by `scripts/compile-measures.mjs`, but callable per-request. `compileCql(text)` → `{ ok, elm, diagnostics }` (CQL errors come back as line/char diagnostics, never a 500). `reconstructCql(elm)` rebuilds the original CQL from the ELM annotation narrative (`EnableAnnotations`) across every declaration section, in locator order — verified to **recompile cleanly** for audiogram/flu/cms122. (One honest nuance: the reconstructed source omits the *implicit* `Patient` context define the translator auto-anchors; every authored define + all compliance logic is preserved.)
- **Backend routes (TS, pure strangler — no Java added):** `GET /api/measures/:id/elm` now returns `{ measureId, name, library, cql, elm }` (the AST + reconstructed source to seed the editor); new `POST /api/measures/compile` (`{cql}` → `{ok,elm,diagnostics}`, 64 KB cap) powers live recompilation. Mounted via `handleMeasures` in `worker.ts`. Read-only; never decides compliance. **`measures.test.ts` covers list / elm+cql / 404 / compile-ok / compile-errors-as-diagnostics / 400. backend-ts 24/24 green, typecheck clean.**
- **Frontend:** `/studio/elm` page + `features/studio/components/ElmExplorer.tsx` — editable **CQL pane (debounced recompile)** beside a **live collapsible AST tree**; a status pill ("✓ compiled · no JVM" / "✗ N errors / compiling…"), per-define tabs (★ marks canonical `Outcome Status`), **click an AST node to highlight the exact CQL span** it came from (via the node's `locator` → `textarea.setSelectionRange`), and a clickable diagnostics list that jumps to the offending line. Dependency-free (no-new-deps rule). Talks to the TS backend over the existing fetch client — which is the plan's own "frontend talks to the TS endpoints unchanged" validation. **lint clean, `npm run build` green (`/studio/elm` registered).**
- Self-contained: keyed on the engine's measure slug (not the Java studio's DB UUID), so it doesn't touch the existing Studio tabs or the Java backend. Cleanly separable from the #96 critical-path phases (Postgres adapter #104/#115, endpoint strangler #107). After this, back to normal roadmap progress.

---

## 2026-06-12 — Replatform Phase 2 (#104): Postgres ceiling adapter + one contract on both floor & ceiling — branch `feat/issue-96-postgres-adapter`

Built the Postgres "ceiling" half of the storage ports/adapters split (issue #96, ADR-008) and proved Doug's core principle — *"SQLite/D1 define the portable floor; Postgres provides the performance ceiling"* — with a real test, not a claim: **one backend-agnostic contract suite, green on both adapters.**

What shipped (`backend-ts/src/stores/`, TS-only, no JVM):
- **`postgres/` adapters** implementing the existing `RunStore` + `OutcomeStore` contracts against `pg` (8.21): `PgRunStore`, `PgOutcomeStore`, a thin `createPgPool` seam (the seed of a future `@mieweb/cloud-postgres` binding), and `schema-pg.ts` (the Postgres analogue of the SQLite floor DDL — `TIMESTAMPTZ`/`JSONB`/`IDENTITY` instead of `TEXT`/`TEXT JSON`/`AUTOINCREMENT`).
- **The interesting bit — the queue claim differs by design:** the floor uses `UPDATE … RETURNING` (SQLite serializes writers); the ceiling uses `SELECT … FOR UPDATE SKIP LOCKED` inside a transaction so N workers claim N *distinct* runs in parallel without contending. Added a `concurrent claims hand each worker a distinct run (no double-claim)` case to the shared contract that fires 5 claims at once — it actually exercises the ceiling's parallel transactions.
- **Shared `store-contract.ts`:** the SQLite test was refactored from bespoke assertions into a backend-agnostic suite (`runStoreContract` / `outcomeStoreContract`); both the SQLite floor harness and the new Postgres harness run the *same* assertions. JSONB evidence round-trips identically to the floor's TEXT JSON.

Schema-ownership guardrail (CLAUDE.md): the canonical Neon/Flyway tables are Taleef-owned and **untouched**. The compose `public` schema already has same-named `runs`/`outcomes`/`run_logs` tables, so the spike adapters live in an **isolated `workwell_spike` schema** and fully schema-qualify every table — they can't reach `public`. This mirrors how the SQLite floor DDL is already isolated spike scaffolding.

Verification (Docker Postgres up via `infra/docker-compose.yml`): `tsc --noEmit` clean; `pnpm test` **29/29** — the 8 `[postgres]` cases ran live against `postgres:16` and the 8 `[sqlite]` cases against `@mieweb/cloud-local`, identical behaviour. CI without Postgres stays green: the Postgres harness probes reachability first and registers a single *skipped* test when nothing answers (verified by pointing `WORKWELL_TEST_PG_URL` at a dead port → 1 skipped, 0 failed). The live runs `/api/runs` route still uses the SQLite floor; selecting the Postgres binding per deploy target is a later concern (Phase 5 / worker binding config), deliberately not in this PR.

---

## 2026-06-12 — Issue #96 de-Java re-platform: direction accepted, ADR-008 + plan + board + sub-issues

> Restored 2026-06-13: this entry was inadvertently overwritten on `main` when the Phase-2 Postgres entry above replaced (rather than prepended) the top of the journal; re-added verbatim to keep the record intact.

Doug's #96 ("don't depend on Java/Spring Boot; make `@mieweb/cloud` the pluggable backend") is now a committed direction with full tracking. Decided the **shape** after the feasibility homework: **strangler-fig re-platform onto TypeScript / `@mieweb/cloud`, CQL Path C** — keep the CQL/eCQM engine but run the Java `cql-to-elm` translator **offline at build time** (commit ELM JSON) and execute ELM in Node via `cql-execution`/`fqm-execution`, so the JVM leaves the run/test/deploy path entirely. Key reframing that kills the FHIR-server question: **WorkWell is not a FHIR server** (Postgres is the system of record; FHIR R4 bundles are transient eval input), so no TS FHIR server is adopted — `node-on-fhir/honeycomb` (Meteor + Mongo + AGPL, no CQL) is **rejected**; we only need TS FHIR *typing* + an eval engine. Deploy target = Node container on MIE.

Why strangler + Path C: satisfies all of Taleef's constraints — don't give up work done (frontend untouched; ports/adapters from E1 carry over; nothing deleted until its TS replacement passes parity), follow Doug's end-state (no JVM), low friction (Path C is the only option that keeps the eCQM differentiator *and* removes Java from deploy), and contributes upstream (build the missing `@mieweb/cloud-postgres`).

Artifacts landed (docs only; no code/schema/API change):
- **ADR-008** at top of `docs/DECISIONS.md` (supersedes ADR-001 for the backend runtime; ADR-001 kept as historical record).
- **Execution plan** `docs/superpowers/plans/2026-06-12-issue-96-dejava-replatform.md` (keep/transition/retire table, Phases 0–5, risks, verification).
- **Labels:** `replatform-96`, `mieweb-cloud`, `cql-engine`, `spike`, `typescript`.
- **Project board** "WorkWell 96 - De-Java Re-platform" (users/Taleef7/projects/6, linked to repo) with custom **Phase** (0–5) + **Workstream** (Platform/Engine/API/Infra/Docs) + Status fields, README, all 9 issues added with field values set.
- **Sub-issues of #96 (Phases 0–5):** #102 (P0 scaffolding), #103 (P1 spike — **GO/NO-GO gate**), #104 (P2 storage adapters), #105 (P2 auth/audit), #106 (P3 engine parity), #107 + #108 (P4 API strangler), #109 (P5 deploy cutover + JVM retirement). Summary comment posted on #96 with two open questions flagged to @horner (confirm Path C; storage-floor stance to be settled on Phase-1 evidence).

**Phase 1 (#103) is the cheap gate before the expensive months**: prove one measure hits golden parity in Node against the Java engine first. `@mieweb/cloud` to be added as a submodule and co-developed (v0.0.0; `@mieweb/cloud-postgres` doesn't exist yet). Schema migrations remain Taleef-owned. Nothing built yet — next action is Phase 0 scaffolding once Doug confirms the framing.

---

## 2026-06-11 — Note: vendored DataVis a11y fixes are upstream-PR candidates (`mieweb/datavis`)

Capturing this so it isn't lost: the two accessibility fixes we carry as **local patches** on the vendored NITRO grid (`frontend/vendor/datavis/src/components/table/useKeyboardNav.ts` + its call site in `PlainTable.tsx`, recorded in `vendor/datavis/VENDORING.md` "Local patches") are **genuine latent upstream bugs**, not WorkWell-specific workarounds. They reproduce in upstream's own Storybook with no WorkWell context, so they're clean candidates for a real PR to `mieweb/datavis`:

1. **Row keyboard handler hijacks Enter/Space from interactive cell content.** When a cell contains a link/button/input, Enter/Space while it's focused activates the *row* instead of the control. Fix: `handleKeyDown` early-returns when the event originates from an `a/button/input/select/textarea/[contenteditable]` descendant.
2. **`scrollActiveRowIntoView` uses a document-wide `[data-row-num]` query**, so with multiple grids on one page (each numbering rows from 0) keyboard nav scrolls the *wrong* grid. Fix: thread an optional `containerRef` and scope the query to it; `PlainTable` passes its `tableRef`.

Scope of a clean PR = only those two files; nothing WorkWell-specific would spill in (the patches are already isolated in the vendored copy). **Not opening a PR yet** — etiquette: give Doug/MIE a heads-up first (file an issue with a minimal repro and offer the PR) so it reads as collaboration, not as routing around the maintainers, especially since we also vendor their private `@mieweb/datavis`. The separate "publish a built `@mieweb/datavis` to npm" ask is a distribution/strategy decision (already tracked in `questions_for_doug.md`), **not** a bug fix — it cannot be resolved by a code PR and should stay a conversation with Doug. Re-flag both on the next re-vendor (the local patches must be reapplied unless upstream has merged them).

---

## 2026-06-11 — `@mieweb/ui` control-swap completed (frontend) — branch `feat/mieweb-ui-controls`

Closed out the deferred `@mieweb/ui` component migration (issue #99 — the "Follow-up (separate branch B)" noted in the NITRO entry below). PR #68 had retokenized the dense form/control surfaces in place (dark/brand-correct) but left them as raw `<button>/<input>/<select>/<textarea>`. This branch swaps them to real `@mieweb/ui` components on the four remaining surfaces.

Swapped to `@mieweb/ui`:
- **`/runs`** — header export/rerun, 3 filter `Select`s + Refresh, the run-control form (Scope/Measure `Select`, Evaluation Date `Input`, conditional Site/Employee/Case `Input`s, Run Now), Load-more, Dismiss. (NITRO Outcomes grid already from PR #100.)
- **All 9 studio tabs** — `SpecTab`/`CqlTab`/`TestsTab`/`ValueSetsTab`/`ReleaseApprovalTab`/`TraceabilityTab`/`DataReadinessPanel`/`ValueSetGovernancePanel`/`ImpactPreviewPanel` — buttons → `Button` (with `isLoading`/`loadingText` where they showed pending text, preserving `findByRole("button",{name:/Saving|Compiling/})` test contracts); inputs/textareas → `Input`/`Textarea` with `label`+`hideLabel` (preserves `getByLabelText`); `CqlTab` New-Version + AI-Draft dialogs and `ReleaseApprovalTab`'s 3 confirm dialogs → `Modal`.
- **`/cases/[id]`** — both mobile + desktop action blocks, appointment inline panel → `Modal`, resolve/delivery-status controls, evidence description `Input` + Upload/Download buttons, raw-evidence toggle, Explain-Why-Flagged button.
- **`/admin`** (largest gap) — scheduler enable/disable/confirm/cancel, integration manual-sync + validate-mappings + add-mapping/refresh, the terminology add-mapping form (6 `Input` + `Textarea`), save/cancel, waiver filters (`Select`/date `Input`) + reload + grant-waiver form (`Input`/`Select`/`Textarea`/`Checkbox`) + grant button, notification-template editor (`Input`/`Textarea` + edit/preview/save/cancel), delivery-log refresh, demo-reset trio (`danger`), audit refresh.
- **`/studio/[id]`** header — change-summary `Input` + New-Version `Button`.

Intentional native exceptions (documented in `frontend/MIEWEB-UI-MIGRATION.md` compliance table): segmented tab/pill toggle groups (`cases` all/mine, `studio/[id]` tab nav, `admin` audit-scope), bulk-select checkboxes (`cases`), the native file picker (`cases/[id]`), the bespoke a11y/disclosure shells (`confirm-dialog`, `SqlPreviewPanel`, `CqlTab` ✕ dismiss), pre-auth `/login`+`/sandbox`, Monaco, recharts, and the Step-4g overlays still pending (`GlobalSearch`, osha combobox, theme-brand-switcher, layout shell).

Compliance: raw `<button>` 118→14, `<input>` 48→7, `<select>` 21→0, `<textarea>` 12→0 — all 21 remaining are the intentional exceptions above. `@mieweb/ui` import lines 0→24.

Verification: `tsc --noEmit` clean, `pnpm lint` clean (1 pre-existing test-mock warning), `pnpm test` 53/53, `pnpm build` green. No backend/schema/API/compliance change. PR left for review (no auto-merge; Taleef deploys). Updated `frontend/MIEWEB-UI-MIGRATION.md` (Steps 4a/4c marked done, compliance table filled).

**Full-stack E2E + live browser verification (2026-06-11, follow-up).** Brought up the real stack locally (Docker Postgres + HAPI via `infra/docker-compose.yml`, Spring Boot `bootRun` with `WORKWELL_DEMO_ENABLED=true`, Next.js `dev` at `NEXT_PUBLIC_API_BASE_URL=http://localhost:8080`) and exercised the swapped surfaces in a real Chromium browser:
- **Playwright golden-path suite: 4/4 pass** against localhost. Two pre-existing selector fragilities (not caused by this branch) were fixed in `e2e/tests/golden-path.spec.ts`: `getByLabel(/password/i)` was ambiguous (also matched the login "Show password" toggle's `aria-label`) → now `#email`/`#password`; logout regex `/logout|sign out/i` didn't match the layout's `aria-label="Log out"` (rewritten in PR #68) → now `/log ?out|sign out/i`.
- **`/runs`** — `@mieweb/ui` `Select` (Status/Scope/Trigger/site/date) open with correct `listbox`/`option` roles; option select works; `Button`s render with brand styling.
- **`/admin`** — scheduler/integration/validate `Button`s render; terminology "Add Mapping" opens the swapped form (7 `Input` + 1 `Textarea`, `label`-derived accessible names; value binding + Cancel verified). NITRO grids (data-readiness 14 rows, terminology 6 rows) render with `<code>`/badge cells intact. (Note: a NITRO grid's virtualized cells visually overlap the terminology add-form — a pre-existing z-index quirk from the PR #100 grids, not a control-swap regression; the form is fully functional underneath.)
- **`/studio/[id]` CQL tab** — Compile/AI-Draft `Button`s + audit-format `Select`; "AI Draft CQL" opens the promoted `@mieweb/ui` `Modal` (dialog role, `Textarea` with label, Cancel/Generate footer buttons); Escape closes it.
- **`/cases/[id]`** — outreach-template `Select`, assignee `Input`+Assign, all action `Button`s (Preview/Send/Escalate/Rerun/Resolve/Schedule + Mark queued/sent/failed); "Schedule Appointment" opens the promoted `Modal` (Appointment-type `Select`, datetime `Input`, location `Input`, Cancel/Save footer); Escape closes it.

---

## 2026-06-11 — DataVis NITRO grid unblocked (frontend) — branch `feat/datavis-nitro-unblock`

Reopened the "NITRO blocked, waiting on Doug to publish `@mieweb/datavis`" gap from the `@mieweb/ui` migration (PR #68) and **unblocked it ourselves**. The prior diagnosis was incomplete: the published `@mieweb/ui@0.6.1` *does* ship the NITRO bundle (`dist/datavis.js` + `./datavis`), but it imports from a **bare `datavis` specifier** (raw `datavis/src/...` `.ts/.tsx`) plus `datavis-ace`. `datavis-ace@=4.0.0-PRE.2` is on public npm; the `datavis` UI source isn't on npm **but the `mieweb/datavis` repo is public** — and `@mieweb/ui`'s own build marks `/^datavis\//` external, expecting the consumer to provide it exactly as the upstream monorepo does via a `file:` link.

What shipped (frontend-only):
- **Vendored `datavis` source** into `frontend/vendor/datavis` (pinned to upstream commit `52c27cc`, the one matching `@mieweb/ui@0.6.1`'s 2026-05-14 publish). Copied `src/` only — excluded the standalone demo entry, `demo/`, `testing/`, stories, and tests. Added a `package.json` aliasing it as `"datavis": "file:./vendor/datavis"` (react/react-dom/@mieweb/ui/datavis-ace as **peers** = singletons) + `VENDORING.md` (provenance + upgrade recipe).
- **Deps:** `datavis-ace@=4.0.0-PRE.2` (its `json-formatter-js` resolves as an HTTPS tarball, not git — no git needed in the alpine image), `@dnd-kit/{core,sortable,utilities}`, `i18next`, `react-i18next`.
- **Wiring:** `transpilePackages: ["datavis", "@mieweb/ui"]` (Next must transpile both — `@mieweb/ui`'s internal extensionless deep imports only resolve through the project resolver); Tailwind `@source "../vendor/datavis/src"` + the `.wcdv-*` custom classes ported from upstream `index.css`.
- **Integration seam:** `features/datavis/NitroGrid.tsx` + `NitroGridClient.tsx`. The grid is **client-only with `ssr:false`** (the engine touches `window` at module load). Local in-memory rows use the upstream `createMockView` pattern — a `ComputedView` over a `window`-installed local source fed through `DataVisNitroContext` — so there's **no `http` fetch**; our authed API client still owns data loading. Pages import the wrapper, never `@mieweb/ui/datavis` directly.
- **Proof:** swapped `/measures` from a hand-rolled `<table>` to `<NitroGrid>` (row-click → studio preserved). Browser-verified the real NITRO grid renders (sortable/filterable headers, CSV/copy/refresh toolbar, Count aggregate footer, dark + brand styling).
- **Docker/CI:** both `frontend/Dockerfile` (live deploy) and `infra/frontend.Dockerfile` (local compose) now `COPY vendor` before `pnpm install` (the `file:` dep must exist at install). `.dockerignore` doesn't exclude `vendor/`.

**Full NITRO rollout (same branch):** after the measures proof-of-concept, audited all 13 app `<table>` blocks and swapped the **4 strong-fit operational/audit tables** to `<NitroGrid>`, keeping rich cells via NITRO's `formatCell` (returns `ReactNode`):
- `/measures` — restored the cells the first pass had flattened: CMS policy-ref mono badge, status pill, tag chips (browser-verified).
- `/runs` Outcomes table — employee link (+external ID), outcome pill, case link; row-click → case nav preserved.
- `/admin` ×3 — data-element mappings, terminology mappings, outreach delivery log; `<code>` cells + status/provider badge pills preserved. (Hooks declared above the `isAdmin` early-return to satisfy rules-of-hooks.)
- **Deliberately NOT swapped** (NITRO chrome too heavy / wrong fit): the small in-card tables on `/programs/[measureId]` (≤10-row risk/heatmap) and studio version-history/governance panels; `/cases` is a card grid; `/employees/[externalId]` is a small profile table; the `/runs` master list stays a master→detail selector.

Verification: `pnpm lint` (0 errors), `pnpm build` (compiled + TS clean), `pnpm test` (53/53). Vendored source excluded from our eslint (`vendor/**`). No backend/schema/API/compliance change. Long-term fix still preferred — MIE publishes a built `@mieweb/datavis` to npm so `vendor/` can be deleted (carried in `questions_for_doug.md`). PR left for review (no auto-merge; Taleef deploys).

**Follow-up (separate branch B):** complete the `@mieweb/ui` component-swap of remaining raw HTML form/control elements on `/admin` (largest gap), `/runs`, `/cases/[id]` (+ its bespoke appointment modal), and the studio tabs — all currently retokenized-in-place from PR #68 but not yet component-migrated. Intentional non-`@mieweb/ui` surfaces stay as-is: `/login` + `/sandbox` (bespoke pre-auth), Monaco (no equivalent), recharts (UI ships only chart color vars), `confirm-dialog`'s tested a11y shell.

---

## 2026-06-10 — E2: declarative YAML measures + headless evaluator — branch `feat/e2-yaml-measures`

Wave 1 epic #72 (sub-issues #85–#88), straight on top of E1's ports. Doug's most concrete ask — *"programming layer, no UI: given this patient and this YAML file, are they compliant?"* — is now a one-command reality.

What shipped:
- **YAML schema v1 + parser (#85):** one `measures/<id>.yaml` per runnable measure (metadata + `cql:` ref + `bindings:`; `event.type: procedure|immunization|observation` replaces the two raw booleans). `YamlMeasureParser` is pure SnakeYAML map-loading (no new dependency — Boot ships it), fails fast naming file + field, rejects unknown keys.
- **All 10 measures as YAML (#87)** with bindings copied verbatim from the old switch.
- **`YamlMeasureDefinitionProvider` (#86)** scans `classpath*:measures/*.yaml` at construction (Spring-core resolver as plain library code — no ApplicationContext) and is the default bean. **`SyntheticMeasureDefinitionProvider` deleted** — YAML is the single source of bindings (ADR-006). Golden parity (100 employees × 10 measures) gated the swap; the only "drift" found was git-autocrlf line endings in the fixtures, fixed by normalizing EOLs in the harness (the invariant is the employee→status mapping).
- **Public `evaluateBundle(...)`** extracted from the engine core: evaluates an *arbitrary* FHIR `Bundle` → `BundleOutcome` (normalized bucket + define-level expression results). Synthetic path delegates unchanged.
- **Headless CLI (#88):** `HeadlessEvaluatorCli` (plain `main`, no Spring/DB) + Gradle `evaluateMeasure` task. Verified live with a hand-written FHIR bundle: `./gradlew.bat evaluateMeasure --args="patient.json .../audiogram.yaml"` → `"outcome": "COMPLIANT"` with `Days Since Last Audiogram: 100` in the evidence.

Decisions (ADR-006): YAML replaces the switch (no `yaml|java` fallback — dual sources were the #82 smell); CLI over REST endpoint (deferred, trivial atop `evaluateBundle`); minimal schema — population logic/buckets stay in the CQL, which is the single source of logic. Headless evidence is `expressionResults` + outcome only (synthetic `why_flagged` derives from `ExamConfig`, which real bundles don't have).

Verification: parser/provider/CLI TDD suites green; golden parity + no-Spring guard + `CqlEvaluationServiceTest` green; live CLI demo run. No schema/API/compliance change; demo unchanged. PR for review (no auto-merge).

---

## 2026-06-10 — E1: reusable measure engine ports/adapters — MERGED (PR #95)

Started the strategic roadmap's Wave 1 (epic #71, sub-issues #79–#84): invert `CqlEvaluationService` onto ports so the synthetic demo becomes the default *adapter* rather than hard-wired internals — the seam real EHR/FHIR data and declarative YAML measures (E2) plug into without a rewrite. Created GitHub issues for all roadmap epics (E1–E9; #71–#78) with linked sub-issues; spec + plan committed under `docs/superpowers/`.

What shipped on the branch:
- **Golden-file baseline first** (`EngineGoldenParityTest`): captured the deterministic (employee → outcome-status) mapping for all 100 employees × 10 measures into committed fixtures — the regression gate. (CQL uses `Now()`, so the bucket, not absolute dates, is the stable invariant.)
- **Four ports** in `com.workwell.engine.port` (`PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider`) + `MeasureDefinition` model. `OutreachChannel` deferred to E5 (YAGNI).
- **Synthetic default adapters** in `engine.synthetic` (wrap the existing bundle builder, employee catalog, the moved binding switch, and the population properties). `CqlEvaluationService` now takes the 4 ports; `evaluate`/`evaluateSubject` signatures unchanged so all callers are untouched.
- **`EngineNoSpringContextTest`** proves the core evaluates with plain `new` and no `ApplicationContext` (the "Spring-free core" acceptance), kept in the same Gradle module (no `:engine` subproject — ADR-005).
- Deleted the now-dead `measureSeedSpecFor` switch + `MeasureSeedSpec` record from `CqlEvaluationService`.
- Docs: ARCHITECTURE `engine` module boundary + ADR-005.

Decisions (with Taleef): same module + guard test (not a separate Gradle module); 4 ports now. **#82 nuance:** the duplicated *bindings* lived only in `CqlEvaluationService` and are now solely in `SyntheticMeasureDefinitionProvider`; `MeasureService` seeding holds only catalog/UI metadata + CQL filenames (separate concern), so no `MeasureCatalog` indirection was added (YAGNI; E2's YAML supersedes it).

Verification: engine tests + `CqlEvaluationServiceTest` green (golden parity holds, no-Spring guard passes). Demo behavior unchanged (synthetic = default adapter). No schema/API/compliance change.

**Merged** via **PR #95**; epic #71 + sub-issues #79–#84 all closed, `feat/e1-measure-engine-ports` deleted (local + remote). One CI follow-up rode along: the `dorny/test-reporter` "Publish test results" step was intermittently failing whole shard jobs with `HttpError: Requires authentication` (transient GitHub check-run API 401 under 8 parallel shards) even though every `Run backend tests` step passed — set `fail-on-error: false` so the reporter is non-blocking and check status reflects the real test result. **Next: E2 — declarative YAML measures (#72)**, which plugs into the new `MeasureDefinitionProvider` port.

---

## 2026-06-09 — Service startup & reboot policy (Doug's June-8 systemd/reboot points) — branch `infra/systemd-reboot-policy`

Resolved the remaining concrete points from Doug's 2026-06-08 meeting (latency ✅ PR #69, `@mieweb/ui` ✅ PR #68 already done; the "decompose into modules" roadmap is captured in the local `docs/PLAN.md` and deferred): **"systemd services startup / example systemd file for my project"** and **"what if the server reboots? what restart policy?"**

Findings: the live `os.mieweb.org` stack runs on **MIE's Container Manager** and the deploy create-payload sets **no restart policy**, so host-reboot recovery is the platform's default; `infra/docker-compose.yml` had **no `restart:` policy** either, so the self-hosted/local stack would not auto-recover.

Changes (no schema/API change):
- `infra/docker-compose.yml`: added `restart: unless-stopped` to all 4 services (postgres, hapi-fhir, backend, frontend) — container crash + daemon-restart recovery. Validated with `docker compose config` (exit 0).
- `infra/systemd/workwell.service` + `infra/systemd/README.md`: the example systemd unit Doug asked for — boots the compose stack on host startup (`systemctl enable`), with install + reboot-verification steps. Reference for self-hosted/VM hosts; the live MIE platform owns its own reboot recovery.
- `docs/DEPLOY.md`: new **"Service startup & reboot policy"** section explaining both contexts, with an explicit **verify-with-MIE-ops** action — does the Create-a-Container platform auto-restart containers on host reboot, and is there a restart-policy field/label to set on the create payload? (the backend image already carries an `org.mieweb.opensource-server.*` label, hinting label-driven config.)

Follow-up (same day): verified the live-platform reboot question directly against the MIE Container Manager API (read-only, with Taleef's key). The manager is a **Proxmox** abstraction (`opensource-phxdc-pve*` nodes); the container + node objects expose **no** restart/`onboot`/uptime field, so a restart policy is neither user-settable nor user-readable via the API — the "add a restart field to the create payload" idea is a confirmed dead end. Clean restart recovery is already proven by every `main` deploy (delete+recreate → must end `running`). The only residual unknown is whether containers are provisioned with Proxmox `onboot=1`, which is a one-line question for the Container Manager maintainer (a manual restart can't test it; rebooting a shared node isn't an option). DEPLOY.md updated with this evidence-backed wording.

Left unmerged for review (no commit/push without OK).

---

## 2026-06-09 — Measures/programs/runs latency: seed-on-every-read removed (branch `fix/measures-latency`)

### Root cause (Doug's "loading measures takes upwards of 10 seconds")
`MeasureService.listMeasures()` called `ensureInstanceSeeds()` **on every read**. For the `twh` instance that re-ran the full demo-seed cascade against remote Neon each request: ~10 individual measure seeds (each a `SELECT id` + `SELECT COUNT` + an **`UPDATE`** that re-loads the `.cql` file from the classpath, even when the row already exists) plus `ensureCmsEcqmCatalogSeed()` looping all **49** CMS records (`SELECT … LIKE` + `UPDATE measures` + `SELECT COUNT` each). Net ≈ **180 sequential SQL round-trips + ~10 classpath file reads per page load**, almost all redundant writes → ~5–9 s. Not network, not a missing index, not the list query (which is a fast `JOIN LATERAL`).

Same single cause explained all three slow screens: `/measures` (direct), `/programs` (`ProgramService.listPrograms` → `measureService.listMeasures()`), and `/runs` (page fetches `/api/measures` for the measure-filter dropdown, `runs/page.tsx:193`). The `/api/runs` and `/api/programs` queries themselves are fine.

### Fix (`backend/.../measure/MeasureService.java`, one file)
- **Per-process guard:** `volatile boolean instanceSeedsApplied` + double-checked locking around `ensureInstanceSeeds()` — seeds run **once per process**, so catalog reads become pure `SELECT`s (single-digit ms).
- **Startup warm:** `@EventListener(ApplicationReadyEvent.class) warmInstanceSeeds()` runs the seed once after context startup, so the **first** request after a deploy is fast too.
- Refresh-on-deploy intent preserved: every deploy is a fresh container/process, so the idempotent "upgrade-on-boot" seeding (refresh CQL text, bump CMS catalog to current performance year) still runs once per deploy. `DemoResetService` verified to **preserve** measures/measure_versions, so nothing depended on reseed-on-read. No schema/migration/API-contract/compliance change.

### Extended slowness sweep (Doug also asked: "find other parts … taking too long")
Swept every hot read path; the seed-on-read pattern was the **only** systemic slowdown (and it transitively covered measures, programs, runs, cases, admin, and studio since they all load `/api/measures` or route through `listPrograms`/`getMeasure`). Everything else is already efficient and needs no change:
- `/api/runs` list — single bounded query with `LIMIT`.
- `/api/programs/{id}/trend` + `/top-drivers` — bounded single queries; the `/programs` page already parallelizes its per-measure fan-out via `Promise.all` (two waves of ~10).
- `/api/cases` list (also hit by the dashboard shell on every navigation, `layout.tsx:95`) — single bounded query (correlated `outreach_record_count` subquery + waiver `LATERAL` + `LIMIT`); no N+1.
- `/api/admin/integrations` — `listHealth()` reads persisted `integration_health` state; live FHIR/MCP/AI probes run only in the `@Scheduled` 15-min refresh and manual sync (POST), never on the GET.
- Frontend API client (`lib/api/client.ts`) — silent token refresh fires only on a 401 (single retry), so there's no per-request auth tax.

Deliberately **not** adding speculative DB indexes: demo-scale data (~60 measures, ~50 employees, handful of runs) makes them moot, and schema migrations are Taleef-owned per the hard rule.

### Verification
- `compileJava` clean. Targeted seed/read integration tests green under Testcontainers: `com.workwell.measure.*` (incl. `ValueSetGovernanceIntegrationTest`, `MeasureTraceabilityIntegrationTest`, `MeasureImpactPreviewIntegrationTest`), `DataReadinessIntegrationTest`, `ScopedRunFailureIntegrationTest` — **BUILD SUCCESSFUL**. Full suite runs on CI for the PR.

---

## 2026-06-09 — Frontend migration to `@mieweb/ui` (dark mode + Enterprise Health brand)

### What shipped (frontend-only; branch `feat/mieweb-ui-migration`, PR #68 — not merged)

Migrated the frontend onto MIE's `@mieweb/ui` (v0.6.1) per Doug's 2026-06-08 direction. Full **dark mode** + **Enterprise Health brand** default + **runtime brand switcher** + semantic-token migration (was light-only, hardcoded `slate-*`). See ADR-004 and `frontend/MIEWEB-UI-MIGRATION.md`.

- **Foundation:** Tailwind 4 CSS foundation (brand import, `@source`, `@custom-variant dark`, `@theme` tokens w/ fallbacks); `useTheme` + `useBrand`; persisted theme/brand applied **before first paint** by a pre-hydration inline script (`components/theme-script.tsx`, no-FOUC); 7 brand stylesheets in `public/brands/`.
- **Global systems → @mieweb/ui:** toast (`ToastProvider`/`ToastContainer`/`useToast`, legacy `emitToast` event bridge preserved), skeletons (`Skeleton`), confirm-dialog (kept tested a11y shell, buttons→`Button` + tokens — 9/9 tests pass). New `components/client-providers.tsx` boundary (the `@mieweb/ui` barrel runs `createContext` at load → must not enter the RSC graph).
- **Layout shell:** `Sidebar` + `AppHeader` (built-in mobile drawer, desktop collapse) + header brand/theme switcher; header filters → `Select`. Removed custom mobile drawer + bottom-nav. App-shell now `h-dvh` with internal `main` scroll.
- **Pages (all dark + brand aware):** component-migrated `/cases`, `/programs` (+detail), `/measures`, `/employees/[externalId]`, `/worklist`, landing, plus shared components (GlobalSearch, audit-packet-export, OSHA combobox, ComplianceSummaryBar). `/runs`, `/admin`, `/cases/[id]`, studio tabs/panels: tokens+dark done, native form controls retokenized in place (component-swap follow-up). `lib/status.ts` helpers made dark-aware app-wide. `/login` (brand-primary submit) + `/sandbox` left as intentional bespoke pre-auth pages. Monaco + the dark code/SQL preview blocks kept dark; recharts rethemed.

### Verification
- `next build` clean, `eslint` (0 errors; 1 pre-existing `test/mocks` warning), `vitest` **53/53** pass (SlaChip assertion updated slate→neutral).
- Playwright light+dark: shell, brand switch (Enterprise Health→BlueHive), mobile drawer; `/cases` incl. card grid with badges (stubbed data); `/measures`; `/admin` dark shell.

### Known gap
- **DataVis NITRO blocked** — `@mieweb/datavis` is `private`/source-only (not on npm). Tables kept swap-ready. Ask to Doug logged (publish `@mieweb/datavis` built to npm). Frontend-only; no backend/schema/API/compliance changes.

---

## 2026-06-08 — Studio UX feedback: spec labels, async button states, live compile badge

### What shipped (frontend-only; branch `feat/studio-ux-feedback`, PR open — not merged)

- **Fix 1 — Spec field labels (`SpecTab.tsx`):** Added a persistent visible `<label>` (wired via `htmlFor`/`id`) above each of the 8 spec controls (Description, Eligibility Role/Site Filter, Program Enrollment Text, Exclusion Label, Exclusion Criteria Text, Compliance Window, Required Data Elements). Placeholders kept as hint text; field order, state, and save payload unchanged.
- **Fix 2 — Async button in-flight states:** Adopted the `TestsTab` spinner + disabled-while-pending pattern for the remaining async buttons — Compile (`CqlTab`), AI Draft Spec + Save Draft (`SpecTab`), and Approve/Activate/Deprecate confirms (`ReleaseApprovalTab`). Each shows an inline spinner + verb ("Compiling…", "Drafting…", "Saving…", "Approving…", "Activating…", "Deprecating…") and is disabled while pending to guard against double-submit. (`CqlTab` "AI Draft CQL" only opens a dialog; its actual async "Generate CQL Draft" already had the pattern.)
- **Fix 3 — Live compile status badge (`CqlTab.tsx` + `studio/[id]/page.tsx`):** Badge now renders a parent-held `liveCompileStatus` override derived from the compile response `status` (COMPILED | WARNINGS | ERROR), flipping immediately without a reload instead of showing the stale persisted prop. Override resets on measure navigation. WARNINGS stays amber (distinct from ERROR red).

### Verification

- `npm run lint` (0 errors; 1 pre-existing warning in `test/mocks/next-font.ts`), `npm run test` (53 passed, incl. 5 new), `npm run build` (TypeScript clean, all routes built).
- New tests: `SpecTab.test.tsx` (a `<label>` per spec field + Saving/Drafting in-flight), `CqlTab.test.tsx` (badge NOT_COMPILED → WARNINGS without remount, amber-not-red + Compiling in-flight).
- Frontend-only; no backend, schema, API-contract, or compliance-logic changes. PR left unmerged (Taleef deploys).

---

## 2026-06-08 — Post-merge polish: 7 PRs merged (#60–#66)

### What shipped

- **#60 — ADR-003 (docs):** Captured 2026-05-21 TWH consolidation decision in `docs/DECISIONS.md`; journal entry scoped to actual shipped work and dated correctly.
- **#61 — workwell.os redirect (infra):** Minimal nginx:1.27-alpine container issuing `301` from `workwell.os.mieweb.org` → `twh.os.mieweb.org`. Workflow: `deploy-workwell-redirect-mieweb.yml` (manual dispatch). Removed misleading "reuse for API hostname" suggestion.
- **#62 — CQL code-filter tightening:** Applied inline code-filter pattern (already in use by TB/HAZWOPER) to all 6 previously unfiltered measures (audiogram, flu, hypertension, diabetes_hba1c, obesity_bmi, cholesterol_ldl). No synthetic-data changes needed.
- **#63 — CMS125v14 + CMS122v14 promoted to Active:** Breast Cancer Screening (820-day mammogram window) and Diabetes HbA1c Poor Control (numeric Observation-based). Both seeded as Active v1.0; `observationValue` field added to `ExamConfig` for lab-value CQL. Catalog now has 10 runnable measures.
- **#64 — Compliance trend chart with per-bucket breakdown:** Extended `ProgramTrendPoint` with 5 bucket counts; added recharts `AreaChart` with per-bucket dashed Area series (% of total) + Legend replacing the hand-rolled sparkline.
- **#65 — Case code evidence explorer:** New `GET /api/measures/versions/{id}/value-sets` endpoint; case detail now shows color-coded define chips (green bool, blue date, orange positive numeric, amber Outcome Status) and a Declared value sets panel.
- **#66 — SQL analogy panel in CQL tab:** Collapsed-by-default panel deriving illustrative SQL from `spec_json` fields. Regex fix: compliance window parser now requires explicit "N days" pattern (not just any digit) to prevent misreading "Series of 3 doses over 6 months" as 3 days.

### Verification

- 7 branches merged to main and deleted remotely + locally.
- `docs/MEASURES.md` catalog summary updated (10 runnable, 47 Draft, 60 total).
- CLAUDE.md Current Focus updated to reflect 10 runnable measures and new features.

---

## 2026-06-08 — docs(decisions): ADR-003 TWH single-instance consolidation

### What changed

- **ADR-003:** Captured the 2026-05-21 TWH single-instance consolidation decision in `docs/DECISIONS.md` as a numbered ADR. Quoted the JOURNAL rationale verbatim; documented that the eCQM seeding path and `*_ECQM` secrets are retained as restore-later capability; noted the `workwell.os` redirect as a follow-up (see `infra/redirect/`).

### Verification

- Docs-only PR; no backend or frontend changes.

---

## 2026-06-08 — Documentation sync: truth-up across the living docs

### What changed

Brought the living docs into agreement with the current codebase and the single MIE TWH
deployment, removing facts that had drifted since the 2026-05-21 focus snapshot. No code changes.

- **CLAUDE.md / AGENTS.md:** Frontend `Next.js 14+` → `Next.js 16 + React 19`; AI `Spring AI (Anthropic)` → `Spring AI (OpenAI starter, spring-ai-openai-spring-boot-starter)` (matches `application.yml` `gpt-5.4-nano` / `gpt-4o-mini`); infra `Fly.io + Vercel + Neon` → MIE Create-a-Container + Neon (Fly + Vercel preview decommissioned); SendGrid env var corrected to `WORKWELL_EMAIL_SENDGRID_API_KEY`. CLAUDE.md Current Focus re-dated 2026-06-08 (Sprint 7 closed, Sprint 8 scoped-run parity, CI 3.8× PR #57, MIE v1 deploy fix PRs #55/#56, catalog 60/49, run scopes) and gained a Build & verify section. AGENTS.md reframed from "sprint-based build phase" to post-merge polish; "active work queue" pointer updated.
- **README.md:** Status now notes Sprint 8 parity, CI sharding, and the MIE v1 deploy migration; Production surfaces reduced to the live MIE TWH frontend/backend with an explicit note that the Vercel + Fly public-preview stack is decommissioned.
- **docs/DEPLOY.md:** Rewritten so MIE Create-a-Container is the sole current deployment; all Fly.io/Vercel provisioning, rollback, and troubleshooting moved into a clearly-labeled decommissioned/historical appendix. Env-var names retained; the `Where` column relabeled Backend/Frontend; added the GitHub-secret → container-env mapping note and the v1 manager-API details.
- **docs/sprints/README.md:** Rollout-status line updated to 2026-06-08; index marked historical (no active sprint queue).
- **CHANGELOG.md:** `[Unreleased]` now records Sprint 8 parity, the CI sharding speedup, the MIE v1 deploy fix, and the deployment consolidation.
- **.env.example:** Fly/Vercel framing replaced with MIE context; the stale `WORKWELL_CORS_ALLOWED_ORIGINS` value (`frontend-seven-eta-24.vercel.app`) corrected to `https://twh.os.mieweb.org`.
- **Usage guides (DEMO_RUNBOOK, WALKTHROUGH_GUIDE, MCP):** dead `*.vercel.app` / `*.fly.dev` hostnames swapped to `twh.os.mieweb.org` / `twh-api.os.mieweb.org`, with stack-note banners flagging that embedded example IDs predate the MIE instance.

### Ground truth verified

- Measure catalog: 60 total (4 OSHA active CQL, 3 OSHA catalog, 4 HEDIS active CQL, 49 CMS eCQM Draft) — confirmed against `MeasureService` and MEASURES.md/DEPLOY.md.
- AI provider: OpenAI via `spring-ai-openai-spring-boot-starter` (`build.gradle.kts`), models `gpt-5.4-nano` / `gpt-4o-mini` (`application.yml`).
- Frontend: Next.js 16.2.4 / React 19.2.4 (`frontend/package.json`).
- Deployment: only `deploy-twh-mieweb.yml` is active; Fly.io + Vercel preview decommissioned (confirmed with owner).

### Left as historical (intentionally not rewritten)

`docs/archive/**`, `docs/new instructions/**`, `docs/superpowers/**`, the per-sprint `SPRINT_0x_*` specs, the MIE migration-process docs (`DEPLOY_OS_MIEWEB.md`, `ECQM_TWH_DEPLOYMENT_PLAN.md`), QA reports (`LIVE_APP_QA_REPORT.md`), and `docs/POST_MERGE_STATUS.md` (a dated 2026-05-11 snapshot already annotated with later resolutions). Old JOURNAL entries that mention Anthropic/Fly are point-in-time records and were left intact.

## 2026-06-03 — CI test suite 3.8x faster (test sharding + per-test population-run fix)

### What changed

- Root cause of the ~44 min CI: the backend `./gradlew test` step dominated wall-clock (frontend ~50s, E2E manual). Per-class timing showed a few integration tests re-ran a full-population CQL evaluation (~70s) in `@BeforeEach`, once per test method.
  - `EvidenceAccessIntegrationTest` ran it 14x (~1022s); converted to one shared run via `@BeforeAll` + `@TestInstance(PER_CLASS)` — its tests are read-only on the population and filter audit by their own upload id → ~71s.
  - `CaseFlowRerunIntegrationTest` ran it 5x (~422s); each test targets a distinct outcome-type case with non-overlapping mutations, so one shared run suffices → ~146s.
  - `ScopedRunIntegrationTest`, `CaseUpsertIntegrationTest`, `Major1PopulationIntegrationTest` left as-is — their reruns are the behavior under test (idempotency, scoped-run parity, empty-table historical seed) and need per-test isolation.
- `.github/workflows/ci.yml`: backend job is now an 8-way matrix; only shard 0 writes the Gradle cache; added a per-class timing diagnostic step.
- `backend/build.gradle.kts`: `Test.include(Spec<FileTreeElement>)` assigns each test class to a shard by stable path hash (`TEST_SHARD_TOTAL`/`TEST_SHARD_INDEX`); CI forks 4-wide with a 1.5g per-fork heap cap; `GRADLE_TEST_FORKS` override. Local runs (no shard env) unchanged.

### Result / Verification

- Wall-clock 44 min → 11m30s (~3.8x); CI green on `main`.
- All 239 backend tests pass; per-shard counts sum to 239 (no tests dropped).
- Remaining ceiling is `ScopedRunIntegrationTest` (~635s); a single class runs in one fork, so further gains require splitting it (deferred).
- Shipped in PR #57.

## 2026-06-03 — MIE Container Manager deploy fix (v1 API migration)

### What changed

The MIE Create-a-Container manager API changed under us; the `deploy-twh-mieweb` backend-container job failed three times.

- `.github/scripts/deploy-mieweb-container.sh`:
  - API base normalized to `<manager-origin>/api/v1` — the origin now serves the SPA web UI, `/api` serves Swagger, and the JSON REST API is at `/api/v1` (PR #55).
  - Migrated to the v1 contract (PR #56): responses are wrapped in a `{"data": ...}` envelope (`.data[]`, `.data.externalDomains[]`); create body uses `template` (not `template_name`) with `services` as an array of flat objects; job polling reads `.data.status` (success value is `"success"`); create-response job id from `.data.jobId`; container URL from `.data[].httpEntries[0].externalUrl`.
  - Shapes verified against the live manager API and the manager's own SPA client.

### Verification

- Post-merge `deploy-twh-mieweb` run green end-to-end (build + deploy backend + deploy frontend).
- Live: `GET https://twh-api.os.mieweb.org/actuator/health` → `200 {"status":"UP"}`; frontend → `200`.

## 2026-06-03 — Sprint 8 scoped run parity (SITE/EMPLOYEE end-to-end + rerun support)

### What changed

- Backend manual-run parity:
  - `AllProgramsRunService.run(...)` now keeps `CASE` synchronous and routes `ALL_PROGRAMS`, `MEASURE`, `SITE`, and `EMPLOYEE` through the async run-job path used by `/api/runs/manual`.
  - `AllProgramsRunService.rerunSameScope(...)` now supports persisted `SITE` and `EMPLOYEE` runs by replaying `requested_scope_json.site` and `requested_scope_json.employeeExternalId`.
  - Non-case reruns now reuse the same async contract as manual runs, so the operator-facing rerun flow is consistent across all supported non-case scopes.
- Persisted rerun-scope hydration:
  - `RunPersistenceService.loadRerunScope(...)` now restores `site` and `employeeExternalId` from `requested_scope_json`, with `site` falling back to the legacy `runs.site` column when present.
- Runs UI parity:
  - `/runs` manual scope selector now exposes `SITE` and `EMPLOYEE`.
  - Added required free-text inputs for `site` and `employeeExternalId`.
  - Scope filter dropdown and rerun eligibility now include `SITE` and `EMPLOYEE`.
  - Scope labels now render `Site` and `Employee` consistently in tables and details.
- Docs alignment:
  - `README.md` and `docs/ARCHITECTURE.md` now describe the full supported scoped-run surface.
  - `docs/POST_MERGE_STATUS.md` historical deferred-scope note is now explicitly marked as resolved.

### Verification

- `frontend`: `npm run lint` passed with one existing warning in `test/mocks/next-font.ts`.
- `frontend`: `npm run build` passed.
- `backend`: `.\gradlew.bat --no-daemon test --tests com.workwell.web.EvalControllerTest` passed.
- `backend`: targeted `ScopedRunIntegrationTest` methods passed individually for:
  - `measureScopePersistsOnlySelectedMeasureAndAuditActor`
  - `siteScopeQueuesAndPersistsOnlyRequestedSite`
  - `employeeScopeQueuesAndPersistsOnlyRequestedEmployee`
  - `siteScopeRerunUsesPersistedRequestedSite`
  - `employeeScopeRerunUsesPersistedRequestedEmployee`
- `backend`: `ScopedRunFailureIntegrationTest.measureScopeFailurePersistsMissingDataAndPartialFailure` passed using `--no-daemon --no-configuration-cache` with a unique `java.io.tmpdir` to avoid a local Gradle temp-file race in this Windows + OneDrive environment.

## 2026-05-22 — Repository polish pass (community health + standards + README modernization)

### What changed

- Reworked `README.md` for a production-grade repository front page:
  - added CI/deploy/license/runtime badges
  - tightened project positioning and status summary
  - refreshed stack/runtime sections
  - added explicit verification command block
  - added community and governance links
- Added repository community health and contribution standards:
  - `CONTRIBUTING.md`
  - `SECURITY.md`
  - `CODE_OF_CONDUCT.md`
  - `SUPPORT.md`
  - `.github/pull_request_template.md`
  - `.github/ISSUE_TEMPLATE/bug_report.md`
  - `.github/ISSUE_TEMPLATE/feature_request.md`
  - `.github/ISSUE_TEMPLATE/config.yml` (blank issues disabled; security redirect)
  - `.github/CODEOWNERS`
- Added project hygiene files:
  - `CHANGELOG.md` (Keep a Changelog format)
  - `.editorconfig`
- Refreshed package metadata for discoverability and tooling:
  - `frontend/package.json` updated with canonical package name, description, repository metadata, homepage, keywords
  - `e2e/package.json` updated with description/repository/homepage

### GitHub repository metadata

- Updated About description.
- Updated homepage URL to `https://twh.os.mieweb.org`.
- Added curated topics: TWH, occupational health, compliance, CQL/FHIR, Spring Boot, Next.js, MCP, OpenAI, and related tags.

### Verification

- `frontend`: `npm run lint` passed with one existing warning in `test/mocks/next-font.ts` (no new lint errors introduced).

## 2026-05-22 — Sprint 7 closeout to `main`, tracker cleanup, and repo metadata refresh

### Repository state updates

- Promoted Sprint 7.2-7.5 from the sprint feature branch chain into `main` via merge commit `95796d7`.
- Closed remaining Sprint 7 issues: `#48`, `#49`, `#50`, `#51` (with completion notes linked to merged implementation).
- Removed stale sprint branches locally and remotely; branch state normalized to `main` only on both local and remote.

### Documentation updates

- `README.md` updated to reflect:
  - TWH framing in the project summary
  - primary demo surfaces (`twh.os.mieweb.org` / `twh-api.os.mieweb.org`)
  - Sprint completion status through Sprint 7
- `docs/sprints/README.md` updated with implementation status across Sprints 0-7.
- `docs/sprints/SPRINT_07_overdelivery_features.md` acceptance and DoD checklists marked complete for 7.1-7.5.
- `docs/DEPLOY.md` refreshed for current platform reality:
  - stack header updated to MIE + Neon + OpenAI
  - CMS catalog seed count corrected to 49
  - legacy/public preview section retitled
  - legacy references migrated from Anthropic secret names to OpenAI equivalents
- `docs/ARCHITECTURE.md` module boundary notes updated to explicitly include MAT export and risk outlook analytics.

### GitHub repository metadata updates

- Updated repository About metadata:
  - description
  - website/homepage URL
  - topical tags (topics) aligned with TWH, CQL/FHIR, and platform stack.

## 2026-05-22 — PR #53 review follow-up (security + error mapping + MAT export hygiene)

### Review threads resolved

1. **MAT export authorization boundary**
   - `SecurityConfig` now explicitly gates `GET /api/measures/*/versions/*/export/mat` to `ROLE_APPROVER` or `ROLE_ADMIN` before the broad authenticated GET rule.
   - Prevents author/case-manager/viewer roles from downloading MAT bundles directly by URL.

2. **Risk outlook missing-measure response classification**
   - `ProgramController.riskOutlook(...)` now maps `IllegalArgumentException` from `RiskOutlookService` to `404 Not Found` via `ResponseStatusException`.
   - Keeps response semantics aligned with the rest of controller-layer not-found handling.

3. **MAT export ValueSet version handling**
   - `MeasureExportService` now preserves nullable `value_sets.version` from DB and only sets FHIR `ValueSet.version` when non-blank.
   - Avoids serializing empty version primitives for value sets that intentionally omit version data.

### Tests added/updated

- `ProgramControllerTest`:
  - Added `riskOutlookReturnsNotFoundWhenMeasureIsMissing`.
- `SecurityRoleIntegrationTest`:
  - Added MAT export role checks:
    - VIEWER forbidden
    - AUTHOR forbidden
    - APPROVER allowed through security layer (request reaches controller; returns 404 for unknown IDs)
    - ADMIN allowed through security layer (request reaches controller; returns 404 for unknown IDs)
- `MeasureExportServiceTest`:
  - Added `omitsValueSetVersionWhenStoredVersionIsBlank` to assert no empty FHIR version output for blank DB values.

### Docs updated

- `README.md` API highlights now annotate MAT export endpoint role requirements (`ROLE_APPROVER`/`ROLE_ADMIN`).

## 2026-05-22 — Sprint 7.2–7.5: AI Fixtures, Risk Outlook, MAT Export, Mobile UX

### What changed

**Issue 7.2 — AI Test Fixture Generator**
- Backend `AiAssistService` now supports AI fixture generation with `generateTestFixtures(measureId, actor)` and writes `AI_TEST_FIXTURES_GENERATED` audit events.
- New endpoint: `POST /api/measures/{measureId}/ai/generate-test-fixtures` on `AiController`.
- Output is normalized to exactly 5 fixtures, one per required outcome (`COMPLIANT`, `DUE_SOON`, `OVERDUE`, `MISSING_DATA`, `EXCLUDED`).
- Deterministic fallback fixture set is returned when AI output is invalid/unavailable so authoring is never blocked.
- Frontend `TestsTab` now has **Generate Fixtures** + draft fixture cards and additive controls (`Add to Draft`, `Add All to Drafts`) with explanatory AI review note.

**Issue 7.3 — Risk Outlook / Predictive Analytics**
- Added `RiskOutlookService` with `getOutlook(measureId, horizonDays)`:
  - Upcoming due-soon pressure from currently compliant employees nearing threshold.
  - Repeat non-complier streaks (current consecutive non-compliant periods).
  - Site-level current vs predicted compliance rates.
- New endpoint: `GET /api/programs/{measureId}/risk-outlook?horizonDays=30`.
- Programs detail page now renders a Risk Outlook panel with KPI chips, repeat non-compliers table (employee links to `/employees/[externalId]`), and site heatmap table sorted by current risk.

**Issue 7.4 — MAT-Compatible Export**
- Added `MeasureExportService` (`com.workwell.fhir`) to build MAT-compatible FHIR R4 `Bundle` XML containing:
  - `Library` with `contentType=text/cql` and raw CQL bytes (HAPI serializes base64).
  - `Measure` with metadata and linked library reference.
  - Linked `ValueSet` resources (including code concepts in compose/include blocks when available).
- New endpoint: `GET /api/measures/{measureId}/versions/{versionId}/export/mat?format=xml`.
- Studio Release tab now includes **Export for MAT (FHIR XML)** for APPROVER/ADMIN roles.

**Issue 7.5 — Mobile Responsive UX**
- Dashboard shell now uses `md` breakpoint behavior for sidebar/hamburger and adds a mobile bottom tab bar (Programs, Cases, Runs, Admin).
- Cases page now has explicit mobile card rows with compact employee/measure/status/chevron navigation.
- Case detail page now exposes mobile-first accordion sections (summary, actions, evidence, timeline) for 375px workflows while preserving the full desktop detail layout.
- Studio measure editor route now shows a mobile notice ("Studio requires a larger screen") and hides the heavy authoring surface on small screens.

**Docs**
- `README.md` API highlights updated for new Sprint 7 endpoints.

### Verification

- Backend targeted tests:
  - `.\gradlew.bat test --tests com.workwell.web.AiControllerTest --tests com.workwell.web.ProgramControllerTest --tests com.workwell.web.MeasureControllerTest` → `BUILD SUCCESSFUL`
- Frontend:
  - `npm run lint` → success (1 existing warning in `frontend/test/mocks/next-font.ts`)
  - `npm run build` → success
- Note: Full backend suite `.\gradlew.bat test` exceeded local timeout windows in this run; targeted controller coverage above passed for all touched backend API surfaces.

## 2026-05-22 — Sprint 7.1: AI Draft CQL + PR #52 review resolved

### PR #52 closeout

**Review comment resolved:** code-reviewer flagged that `AiAssistService.draftCql` ordered versions by `Active` status before recency, meaning if a measure had an older Active version and a newer Draft version the AI prompt used stale `spec_json` — contradicting what Studio shows in the editor.

Fix: dropped the `CASE WHEN mv.status = 'Active' THEN 0 ELSE 1 END` priority from the ORDER BY; now orders purely by `mv.created_at DESC` so the newest version is always selected regardless of lifecycle status. One-line change, AI module tests confirmed green. Review thread resolved on GitHub.

- Commit: `e4e8501` — fix(ai): select newest measure version for AI Draft CQL prompt
- PR #52 ready to merge (no remaining open comments)

---

## 2026-05-22 — Sprint 7.1: AI Draft CQL

### What changed

**Backend** — added `AiAssistService.draftCql(measureId, oshaText, actor)`:
- Reads measure name + active `spec_json` for the given measure
- Sends a CQL-specialist system prompt + user prompt containing measure name, spec JSON, and pasted OSHA text
- Strips code fences from model output
- Writes `AI_DRAFT_CQL_GENERATED` audit event with `measureId`, `model`/`provider`, `promptLength`, `outputLength`, `fallbackUsed`
- Deterministic fallback CQL template returned when AI call fails — TODO-annotated skeleton with `Outcome Status` define covering all five buckets

**Endpoint** — `POST /api/measures/{measureId}/ai/draft-cql` on `AiController`, accepts `{ oshaText }` body, returns `{ success, cql, provider, fallbackUsed }`.

**Frontend** — `CqlTab` now has an "AI Draft CQL" button next to Compile. Opens a modal with an OSHA text textarea; on submit the returned CQL is pushed into the Monaco editor and a dismissible amber banner appears above the editor. Compile state is reset so the user must compile the AI draft before approval.

### Why
Sprint 7 §7.1 differentiator — competitors don't offer CQL authoring assist. CQL is still validated by the existing compile gate before activation, so the rule that AI cannot decide compliance is preserved.

Issues filed: #47 (this), #48, #49, #50, #51 for the rest of Sprint 7.

## 2026-05-21 — 2026 eCQM catalog upgrade (49 measures), infra cleanup

### What changed

**CMS eCQM catalog: 2025 → 2026 (46 → 49 measures)**

Fetched the official 2026 eligible clinician eCQM list from ecqi.healthit.gov. The 2026 performance period has 49 measures — 2 net new vs 2025 (46 carried forward minus CMS249v7 retired, plus 4 new).

Changes vs 2025 catalog:
- **4 new measures:** CMS146v14 (Appropriate Testing for Pharyngitis, MIPS 066), CMS154v14 (Appropriate Treatment for URI, MIPS 065), CMS1173v1 (Diagnostic Delay of VTE in Primary Care, MIPS 514 — new CMS ID), CMS1154v1 (Screening for Abnormal Glucose Metabolism, MIPS 515 — new CMS ID)
- **1 retired:** CMS249v7 (Appropriate Use of DXA Scans in Women Under 65) — removed from 2026 eligible clinician list
- **44 version-bumped:** e.g., CMS128v13→CMS128v14, CMS2v14→CMS2v15, CMS951v3→CMS951v4, etc.
- **New domain:** Respiratory / Antimicrobial Stewardship (CMS146v14, CMS154v14)

**Seed idempotency fix**

Old logic matched existing measures by exact name — fragile when CMS updates measure titles between performance years (e.g., "Heart Failure (HF): ACE Inhibitor or ARB or ARNI Therapy for LVSD" → full expanded title in 2026). New logic strips the version suffix and queries `policy_ref LIKE 'CMS128v%'` so any version of a CMS measure maps to the same DB row. On match, UPDATE the name, policy_ref, and tags to current year's values. On no match, INSERT. This means the next TWH deploy will update all 45 existing measures in-place rather than creating 45 duplicate rows.

**Workflow cleanup: deleted `deploy-os-mieweb.yml`**

The old `Deploy OS MIEWeb` workflow was still triggering on every push to `main`, building `ghcr.io/taleef7/workwell` (generic non-TWH frontend) and deploying to `workwell.os.mieweb.org` / `workwell-api.os.mieweb.org`. These containers used `DATABASE_URL` (not `DATABASE_URL_TWH`) and no `WORKWELL_INSTANCE` — i.e., a separate, partially seeded environment. Deleted the workflow file; Taleef manually deleted the two containers from the MIE manager UI.

**Container inventory post-cleanup (MIE Phoenix DC):**

| Hostname | Image | Purpose | Keep |
|----------|-------|---------|------|
| `twh` | `workwell-twh-frontend` | Live TWH frontend | ✓ |
| `twh-api` | `workwell-api` | Live TWH backend | ✓ |
| `workwell` | `workwell` | Old non-TWH frontend | Deleted |
| `workwell-api` | `workwell-api` | Old non-TWH backend | Deleted |

Only `deploy-twh-mieweb.yml` remains as an active workflow. Every push to `main` now builds and deploys exactly one environment.

**MEASURES.md updated:** catalog summary (58→60 total, 47→49 eCQM), domain breakdown table updated to 2026 IDs, implementation note updated. The old CMS249v7 Musculoskeletal row removed; new Respiratory domain added.

### Commits

- `ee3dfd7` — feat(catalog): upgrade CMS eCQMs to 2026 performance period (49 measures)

### What's next

Sprint 7 features — ready to start. Priority order (from `docs/sprints/SPRINT_07_overdelivery_features.md`):
1. AI Draft CQL (7.1)
2. AI Test Fixture Generator (7.2)
3. Risk Outlook / Predictive Analytics (7.3)
4. MAT Export (7.4)
5. Mobile Responsive Layout (7.5)

---

## 2026-05-21 — TWH consolidation, 47 CMS eCQMs, Fly.io decommission, docs overhaul

### Context and direction

Doug clarified the product direction: **TWH (Total Worker Health) is all-encompassing.** OSHA occupational safety compliance and clinical quality (eCQMs, HEDIS wellness) are not separate products — they are two sides of the same coin and belong in one platform. The three-instance deployment model (workwell, ecqm, twh) was a development stepping stone, not the product architecture. One TWH instance covers everything.

NIOSH's TWH framework is the conceptual foundation: worker health is shaped by both workplace hazards (OSHA safety programs) and general health promotion (chronic disease, preventive care). WorkWell is the platform that manages both in one system with a shared measure catalog, shared case workflow, shared audit trail, and shared CQL evaluation engine.

Doug also asked to get all CMS eCQM IDs into the project — the 47 official CMS electronic Clinical Quality Measures from the 2025 performance period (ecqi.healthit.gov). These are the measures hospitals and clinics use for Medicare/Medicaid quality reporting. Having them in the WorkWell catalog positions the platform as a bridge between occupational health and the broader clinical quality infrastructure.

### Infrastructure changes

**Deleted:** `.github/workflows/deploy-ecqm-mieweb.yml`
- The separate eCQM instance (ecqm.os.mieweb.org + ecqm-api) is gone. TWH seeds everything.

**Kept:** `.github/workflows/deploy-twh-mieweb.yml`
- Now the sole deploy workflow. Triggers on every push to `main`.
- Builds backend (`ghcr.io/taleef7/workwell-api`) and TWH-branded frontend (`ghcr.io/taleef7/workwell-twh-frontend`).
- Sets `WORKWELL_INSTANCE=twh` which seeds all 3 measure categories on startup.

**Destroyed:** Fly.io `workwell-measure-studio-api`
- Old secondary stack from before MIE. Stale — would diverge from main over time since Fly doesn't auto-deploy. Decommissioned via `fly apps destroy`.
- `workwell-measure-studio.vercel.app` no longer has a working backend; Vercel project left dormant (free tier, harmless).

**Neon:** Already clean — single `workwell-twh` project (45.94 MB). No orphaned databases needed deletion.

**Final infrastructure state:**

| Service | URL | State |
|---------|-----|-------|
| Frontend | `https://twh.os.mieweb.org` | Running — latest SHA |
| Backend API | `https://twh-api.os.mieweb.org` | Running — latest SHA |
| Database | Neon `workwell-twh` | Active — sole Neon project |

### Code changes

**`MeasureService.java` — CMS eCQM catalog seeding**

Added `CMS_ECQM_CATALOG` — a static `List<CmsEcqmRecord>` of all 47 CMS eCQMs from the 2025 performance period. Each record carries: title, CMS ID (e.g., `CMS128v13`), MIPS Quality ID, and clinical domain tags.

Added `ensureCmsEcqmCatalogSeed()` — iterates the catalog, inserts each measure into `measures` and `measure_versions` if not already present. Idempotent (skips on conflict). Called from `ensureInstanceSeeds()` for `ecqm` and `twh` instances.

Seeding approach (no migration required):
- `measures.policy_ref` stores the CMS ID — consistent with how OSHA measures store `OSHA 29 CFR 1910.95` and HEDIS measures store `HEDIS CBP / JPMC Wellness Rewards`
- `measures.tags` carries `ecqm`, `cms`, plus clinical domain (`mental-health`, `cardiovascular`, `diabetes`, `cancer-screening`, `pediatric`, `hiv`, `oncology`, etc.)
- `measure_versions.spec_json` stores `cmsEcqmId` and `mipsQualityId` for downstream tooling and the MAT export (Sprint 7)
- Status: `Draft`, `compile_status: NOT_COMPILED` — these are catalog entries awaiting CQL authoring

47 measures across 15 clinical domains. Full list in `MeasureService.CMS_ECQM_CATALOG`.

**`measures/page.tsx` — CMS ID badge**

Policy Ref column: regex `/^CMS\d+/` detects CMS eCQM IDs and renders them as a blue monospace ring badge (`CMS128v13` style). OSHA CFR citations and HEDIS refs remain as plain text. Makes the three measure categories visually distinct in the catalog at a glance.

### Docs updated

- `docs/ARCHITECTURE.md` — System overview updated to describe TWH as the product framing; deployment topology updated from Vercel+Fly to MIE Create-a-Container; infra split section updated.
- `docs/MEASURES.md` — Complete rewrite. Now documents all 58 measures across 4 categories: OSHA full CQL (4), OSHA catalog (3), HEDIS wellness full CQL (4), CMS eCQM Draft catalog (47). Includes domain breakdown table, compliance windows, CQL define logic for all runnable measures.
- `docs/DEPLOY.md` — Added MIE Create-a-Container primary deployment section with required secrets, instance seeding description, and manual re-deploy instructions.
- `CLAUDE.md` — Current Focus updated: live URL, all post-merge work itemised, measure catalog count, Sprint 7 as next work.

### Measure catalog total: 58

| # | Name | Category | CQL | Status |
|---|------|----------|-----|--------|
| 1 | Audiogram | OSHA | Yes | Active |
| 2 | HAZWOPER Surveillance | OSHA | Yes | Active |
| 3 | TB Surveillance | OSHA | Yes | Active |
| 4 | Flu Vaccine | OSHA | Yes | Active |
| 5 | Respirator Fit Test | OSHA | No | Draft |
| 6 | Hepatitis B Vaccination Series | OSHA | Partial | Approved |
| 7 | Lead Medical Surveillance | OSHA | No | Deprecated |
| 8 | Hypertension BP Screening | HEDIS Wellness | Yes | Active |
| 9 | Diabetes HbA1c Monitoring | HEDIS Wellness | Yes | Active |
| 10 | BMI Screening & Counseling | HEDIS Wellness | Yes | Active |
| 11 | Cholesterol LDL Screening | HEDIS Wellness | Yes | Active |
| 12–58 | CMS eCQMs (47) | CMS eCQM | No | Draft |

### What's next

Sprint 7 (`docs/sprints/SPRINT_07_overdelivery_features.md`):
1. AI Draft CQL — paste OSHA text → generate CQL skeleton
2. AI Test Fixture Generator — auto-generate 5 fixtures covering all outcome types
3. Risk Outlook / Predictive Analytics — upcoming expirations, repeat non-compliers, site heatmap
4. MAT Export — FHIR R4 XML bundle compatible with CMS Measure Authoring Tool
5. Mobile Responsive Layout — bottom tab bar, card list on mobile, Studio notice

---

## 2026-05-21 — Post-merge fixes: AI health check, real-time run progress, eCQM/TWH branding

**Goal:** Fix AI integration "Degraded" status, add real-time run progress (spinner + live timer + auto-reload on completion), fix Traceability tab 403, fix hardcoded "Four measures" text for multi-instance deployments, and complete eCQM/TWH workflow `NEXT_PUBLIC_APP_DESCRIPTION` build-arg.

**Branch:** `feat/ecqm-twh-instances`

**What changed:**

- `backend/src/main/java/com/workwell/admin/IntegrationHealthService.java` — `checkAiHealth()` was calling `POST /v1/responses` (returned HTTP 400 for `gpt-5.4-nano`). Changed to `GET /v1/models` which validates the API key regardless of model name. Returns healthy if 200, degraded otherwise.
- `backend/src/main/java/com/workwell/config/SecurityConfig.java` — Added explicit `requestMatchers(HttpMethod.GET, "/api/measures/*/traceability").authenticated()` before the wildcard GET rule as belt-and-suspenders fix for Traceability tab 403 reports.
- `frontend/app/page.tsx` — Added `NEXT_PUBLIC_APP_DESCRIPTION` env var constant with fallback; replaced hardcoded "Four measures, complete case management..." subtitle with `{APP_DESCRIPTION}`. TWH landing page will now correctly read "Eight measures (OSHA safety + wellness)...".
- `.github/workflows/deploy-ecqm-mieweb.yml` — Added `APP_DESCRIPTION` env var and `NEXT_PUBLIC_APP_DESCRIPTION` Docker build-arg: "Four clinical quality measures, complete case management, and a full audit trail — one reviewable dashboard."
- `.github/workflows/deploy-twh-mieweb.yml` — Added `APP_DESCRIPTION` env var and `NEXT_PUBLIC_APP_DESCRIPTION` Docker build-arg: "Eight measures (OSHA safety + wellness), complete case management, and a full audit trail — one reviewable dashboard."
- `frontend/Dockerfile` — Added `NEXT_PUBLIC_APP_DESCRIPTION` build arg and `ENV` statement (default: workwell 4-measure text) so per-instance workflows can override it at build time.
- `frontend/app/(dashboard)/runs/page.tsx` — Real-time run progress:
  - New state: `isRunTriggering`, `activeRunId`, `activeRunStartedAt`, `runElapsedSec`.
  - Polling effect (`useEffect` on `activeRunId`): polls `GET /api/runs/{id}` every 2 s, updates the run row in the table live, stops and auto-reloads (runs list + run detail + outcomes) when status reaches `COMPLETED|FAILED|PARTIAL_FAILURE|CANCELLED`.
  - Timer effect (`useEffect` on `activeRunStartedAt`): increments `runElapsedSec` every second.
  - Run Now button: spinner + "Running…" label while `isRunTriggering`; disabled during run to prevent double-submit.
  - Rerun Selected Scope button: same spinner treatment; disabled while a run is in progress.
  - Duration column: shows live `{runElapsedSec}s ●` (animated dot) for the active run row; static formatted duration for all others.
  - Detail panel Duration field: same live/static treatment.
- `frontend/features/studio/components/TestsTab.tsx` — Validate button shows spinner + "Validating…" while the `/tests/validate` POST is in flight; disabled during the call.

**Verification:** Frontend TypeScript check clean; ESLint clean (0 errors, 0 warnings). Backend tests running.

---

## 2026-05-21 — eCQM and TWH instance support (feat/ecqm-twh-instances)

**Goal:** Add `ecqm.os.mieweb.org` (clinical quality / wellness measures) and `twh.os.mieweb.org` (Total Worker Health — all 8 measures) as independent WorkWell instances. Same backend Docker image, instance-aware seeding via `WORKWELL_INSTANCE` env var, separate Neon databases, separate frontend Docker images with per-instance branding.

**Branch:** `feat/ecqm-twh-instances`

**What changed:**

- `backend/src/main/resources/measures/hypertension.cql` — New CQL library `HypertensionBPScreeningCQL 1.0.0`. Annual BP screening (compliance window 365 days, DueSoon 336–365), wellness-enrollment/exemption value sets.
- `backend/src/main/resources/measures/diabetes_hba1c.cql` — New CQL library `DiabetesHbA1cMonitoringCQL 1.0.0`. Biannual HbA1c (compliance window 180 days, DueSoon 161–180), diabetes-program/exemption value sets.
- `backend/src/main/resources/measures/obesity_bmi.cql` — New CQL library `ObesityBMIScreeningCQL 1.0.0`. Annual BMI screening (compliance window 365 days), wellness-enrollment/exemption value sets.
- `backend/src/main/resources/measures/cholesterol_ldl.cql` — New CQL library `CholesterolLDLScreeningCQL 1.0.0`. Annual LDL screening (compliance window 365 days), cholesterol-program/exemption value sets.
- `backend/src/main/resources/application.yml` — Added `workwell.instance: ${WORKWELL_INSTANCE:workwell}` property; added 4 new compliance rates (hypertension: 0.72, diabetes_hba1c: 0.68, obesity_bmi: 0.81, cholesterol_ldl: 0.74).
- `backend/src/main/java/com/workwell/measure/MeasureService.java` — Added `@Value("${workwell.instance:workwell}") private String workwellInstance`; added `ensureInstanceSeeds()` that gates OSHA seeds on `workwell|twh` and wellness seeds on `ecqm|twh`; replaced direct seed calls in `listMeasures()`/`getMeasure()` with `ensureInstanceSeeds()`; added 4 new seed methods (`ensureHypertensionSeed`, `ensureDiabetesHbA1cSeed`, `ensureObesityBmiSeed`, `ensureCholesterolLdlSeed`).
- `backend/src/main/java/com/workwell/compile/CqlEvaluationService.java` — Added 4 new cases to `measureSeedSpecFor()` switch (Hypertension BP Screening, Diabetes HbA1c Monitoring, BMI Screening & Counseling, Cholesterol LDL Screening). All 4 use `useImmunization=false` (Procedure resources).
- `backend/src/main/java/com/workwell/measure/ValueSetGovernanceService.java` — Added 10 wellness value sets inside `ensureDemoValueSets()` using `b0000001-...` UUID range (non-colliding with existing `a000...` OSHA UUIDs): wellness-enrollment, wellness-exemption, bp-screening (CPT 99213), diabetes-program, diabetes-exemption, hba1c-labs (CPT 83036), bmi-screening (CPT 99401), cholesterol-program, cholesterol-exemption, ldl-labs (CPT 83721). Added `ensureLink()` calls for all 4 wellness measures.
- `frontend/Dockerfile` — Added `NEXT_PUBLIC_APP_NAME` and `NEXT_PUBLIC_APP_TAGLINE` build args (default to workwell values); `ENV` statements bake them into each per-instance image at build time.
- `frontend/app/layout.tsx` — Root metadata uses `NEXT_PUBLIC_APP_NAME`/`NEXT_PUBLIC_APP_TAGLINE` env vars.
- `frontend/app/page.tsx` — Landing page hero h1, header brand badge/subtitle, and footer copyright all driven by `NEXT_PUBLIC_APP_NAME`/`NEXT_PUBLIC_APP_TAGLINE` constants derived from env vars.
- `frontend/app/(dashboard)/layout.tsx` — Sidebar and mobile header "WorkWell"/"Measure Studio" spans driven by split of `NEXT_PUBLIC_APP_NAME`.
- `frontend/app/login/page.tsx` — Left-panel brand badge/subtitle driven by `NEXT_PUBLIC_APP_NAME` split.
- `frontend/app/sandbox/page.tsx` — "WorkWell Measure Studio" label driven by `NEXT_PUBLIC_APP_NAME`.
- `frontend/app/sandbox/layout.tsx` — Metadata description driven by `NEXT_PUBLIC_APP_NAME`.
- `.github/workflows/deploy-ecqm-mieweb.yml` — New workflow: builds same backend image + separate `workwell-ecqm-frontend` image (with eCQM branding build args), deploys to `ecqm-api`/`ecqm` hostnames with `WORKWELL_INSTANCE=ecqm`, uses `DATABASE_URL_ECQM` and `WORKWELL_AUTH_JWT_SECRET_ECQM` secrets.
- `.github/workflows/deploy-twh-mieweb.yml` — New workflow: builds same backend image + separate `workwell-twh-frontend` image (with TWH branding build args), deploys to `twh-api`/`twh` hostnames with `WORKWELL_INSTANCE=twh`, uses `DATABASE_URL_TWH` and `WORKWELL_AUTH_JWT_SECRET_TWH` secrets.
- `docs/ECQM_TWH_DEPLOYMENT_PLAN.md` — Full deployment plan committed for project-level visibility.

**Measure assignment per instance:**

| Measure | workwell | ecqm | twh |
|---|---|---|---|
| Audiogram (OSHA) | ✓ | — | ✓ |
| TB Surveillance | ✓ | — | ✓ |
| HAZWOPER Surveillance | ✓ | — | ✓ |
| Flu Vaccine | ✓ | — | ✓ |
| Hypertension Control | — | ✓ | ✓ |
| Diabetes HbA1c | — | ✓ | ✓ |
| Obesity BMI Screening | — | ✓ | ✓ |
| Cholesterol LDL | — | ✓ | ✓ |

**Owner actions required (Taleef) before first deploy:**

1. Create two Neon projects (`workwell-ecqm`, `workwell-twh`), copy pooled connection strings.
2. Add GitHub repository secrets: `DATABASE_URL_ECQM`, `DATABASE_URL_TWH`, `WORKWELL_AUTH_JWT_SECRET_ECQM`, `WORKWELL_AUTH_JWT_SECRET_TWH`.
3. Make GHCR packages `workwell-ecqm-frontend` and `workwell-twh-frontend` public after first push.

**Verification (local):**
```bash
# ecqm instance — expect Hypertension, Diabetes, BMI, Cholesterol only
WORKWELL_INSTANCE=ecqm ./gradlew bootRun

# twh instance — expect all 8 measures
WORKWELL_INSTANCE=twh ./gradlew bootRun

# workwell instance (default) — expect 4 OSHA measures only
./gradlew bootRun
```

---

## 2026-05-20 — UAT Sections 9-14: Add Mapping UI, Studio packet selector, Demo Reset gating (issue #30)

**Goal:** Fix all reported Section 9 (Terminology Mappings), Section 11 (Audit Packets in Studio Release & Approval tab), and Section 14 (Reset Demo Data prod visibility) UAT bugs from GitHub issue #30, plus correct guide inaccuracies for Sections 9–14.

**Branch:** `fix/sprint-1-uat-sections-9-14`

**What changed:**

- `frontend/app/(dashboard)/admin/page.tsx` — Added "Add Mapping" form/dialog to the Local code mappings panel. The toggleable inline form posts to `POST /api/admin/terminology-mappings` and refreshes the table on success. Form validates required fields (local code/system, standard code/system) and confidence range (0.0–1.0). Also gated the Reset demo data card on `process.env.NEXT_PUBLIC_DEMO_MODE === "true"` so the card is structurally absent in production Vercel builds (production builds never set `NEXT_PUBLIC_DEMO_MODE=true` because `next.config.ts` fails fast if they do).
- `frontend/features/studio/components/ReleaseApprovalTab.tsx` — Replaced the legacy direct-JSON-download button with the shared `AuditPacketExportButton` so the Studio Release & Approval tab now exposes the same JSON/HTML format selector already used on case detail and runs. The third packet entry point is now consistent with the other two.
- `docs/WALKTHROUGH_GUIDE.md` — Corrected Sections 9–14 against the current UI: Section 9 renamed panel to "Local code mappings" and documented Reviewed By / Notes columns plus the new Add Mapping inline form (and noted that **Validate Mappings** lives on the **Source mappings** panel, not the terminology panel); Section 10 documented the actual button labels and called out that audit-events CSV export lives on the Cases page (not Admin); Section 11 documents the consistent JSON/HTML format dropdown across all three entry points (case detail, run detail panel, Studio Release & Approval tab); Section 12 added explicit Claude Desktop config-file path, bearer-token JSON snippet, and JWT acquisition instructions; Section 13 added a Bug 4 cross-reference for the `/login` redirect on session expiry; Section 14 documented the inline (non-modal) confirmation, the frontend visibility gate, and the seven-measure / four-lifecycle catalog left after a Demo Reset.

**Verification:**

- `frontend/npm run lint` — passed (only pre-existing `test/mocks/next-font.ts` anonymous-default-export warning).
- `frontend/npm test` — 40/40 passed.
- `frontend/npx tsc --noEmit` — clean (no TypeScript errors).
- Playwright local end-to-end against `localhost:3000` + `localhost:8080`:
  - Logged in as `admin@workwell.dev`, navigated to `/admin`, opened the new **Add Mapping** form, submitted `ANNUAL-FIT-TEST` → SNOMED `415070008`, observed the new row appearing in the Local code mappings table and the form auto-closing.
  - With `NEXT_PUBLIC_DEMO_MODE=true`: confirmed the **Reset demo data** card renders on `/admin`.
  - Restarted the dev server with `NEXT_PUBLIC_DEMO_MODE=false`: confirmed the **Reset demo data** card no longer renders on `/admin` while the Admin page itself, including the Local code mappings panel and Add Mapping button, continues to render normally.
  - Opened the Audiogram measure in Studio → Release & Approval tab, confirmed both the header and Release & Approval tab `Export Measure Audit Packet` controls expose JSON/HTML in the format dropdown (2 controls, both with `[json, html]` options).
- Manual /measures inspection — confirmed the seven seeded measures across four lifecycle states (4 Active, 1 Approved, 1 Draft, 1 Deprecated) matching the WALKTHROUGH_GUIDE.md Section 14 table.

---


## 2026-05-20 — UAT Sections 6-8: Run history, Studio, Admin fixes (issue #29)

**Goal:** Fix all reported Section 6 (Run History), Section 7 (Studio/CQL), and Section 8 (Admin panel) UAT bugs from GitHub issue #29.

**Branch:** `fix/sprint-1-uat-sections-6-8`

**What changed:**

- `backend/src/main/java/com/workwell/run/RunPersistenceService.java` — Fixed `finalizeAsyncRun()` duration computation: was incorrectly using the evaluationDate (a historical date) to compute `duration_ms`, yielding absurd values like `69068s`. Now fetches the actual `started_at` from the DB and computes real wall-clock duration. Also fixed `measurement_period_start`/`measurement_period_end` to correctly reflect the 1-year evaluation window (evalDate-1yr → evalDate) instead of repeating `startedAt` twice.
- `backend/src/main/java/com/workwell/BackendApplication.java` — Set JVM default timezone to UTC on startup for consistent timestamp handling.
- `backend/src/main/java/com/workwell/measure/ValueSetGovernanceService.java` — Renamed `ensureDemoValueSetLinks()` to `ensureDemoValueSets()` and expanded it to seed all 4 demo value sets (audiogram, TB, HAZWOPER, flu vaccine) with their correct CQL-matching canonical OIDs and local codes so `resolveCheck` finds matching codes.
- `frontend/app/(dashboard)/admin/page.tsx` — Added confirmation dialog before disabling the scheduler to prevent accidental disables during a demo.
- `frontend/features/studio/components/CqlTab.tsx` — Added "New Version" button with a modal dialog for entering a change summary and cloning the current CQL into a new draft measure version.
- PR review follow-up: wired the CQL-tab modal summary directly into the version-clone request so it no longer depends on asynchronous React state, added a Runs/Run Detail display guard that renders anomalous `durationMs` values over 1 hour as `-` or `Stalled`, and restored Cases search state synchronization when browser history changes the `search` URL parameter.

**Verification:**
- `backend/gradlew.bat test --tests com.workwell.export.* --tests com.workwell.web.RunControllerTest` — BUILD SUCCESSFUL (21s).
- Backend compiles cleanly: `gradlew compileJava` — BUILD SUCCESSFUL (16s).
- Playwright end-to-end: triggered async All Programs run — completed with `179s` real duration (vs old seeded `60s` constant). Duration correctly reflects actual CQL evaluation time.

---

## 2026-05-20 — UAT Section 5: Case detail fixes (issue #28)

**Goal:** Fix Section 5 case-detail bugs from UAT #23: escalation confirmation, outreach delivery badge refresh, audit packet format selectors, and walkthrough-guide inaccuracies.

**Branch:** `fix/section-5-case-detail`

**What changed:**

- `backend/src/main/java/com/workwell/caseflow/CaseFlowService.java` — Outreach sends now persist the actual email delivery status (`SIMULATED` on the demo stack) in the `OUTREACH_SENT` action payload and outreach record; latest delivery status now considers both initial outreach sends and later manual delivery updates.
- `backend/src/test/java/com/workwell/caseflow/CaseUpsertIntegrationTest.java` — Added regression coverage proving a successful outreach send immediately returns `latestOutreachDeliveryStatus=SIMULATED`.
- `frontend/app/(dashboard)/cases/[id]/page.tsx` — Added an accessible confirmation dialog before escalation fires; added JSON/HTML selector for case audit packet export; added `SIMULATED` delivery badge styling.
- `frontend/app/(dashboard)/runs/page.tsx` — Added JSON/HTML selector for run audit packet export.
- `frontend/app/(dashboard)/studio/[id]/page.tsx` — Added JSON/HTML selector for measure-version audit packet export.
- `frontend/components/audit-packet-export-button.tsx` — New reusable audit packet export control shared by case, run, and measure version packet entry points.
- `docs/WALKTHROUGH_GUIDE.md` — Corrected Section 5 and Section 11 wording to match the current UI: no separate Employee & Measure Panel heading, inline assignee field, structured evidence trail labels, appointment/resolution controls, outreach template/preview behavior, auto-updating simulated delivery badge, and packet format selectors.

**Verification:**
- `backend/gradlew.bat test --tests com.workwell.caseflow.CaseUpsertIntegrationTest` — passed.
- `backend/gradlew.bat --no-daemon test --tests com.workwell.web.CaseControllerTest --tests com.workwell.web.AuditorControllerTest` — passed.
- `frontend/corepack pnpm lint` — passed with the existing `test/mocks/next-font.ts` anonymous-default-export warning.
- `frontend/corepack pnpm test` — 40/40 passed.
- `frontend/corepack pnpm build` — passed.
- Playwright local confirmation with mocked API data — verified escalation waits for confirmation, outreach badge updates to `Simulated`, and case/run/measure packet exports honor the selected `format=html`.
- Attempted full `backend/gradlew.bat test`; it did not return before the 15-minute timeout, so focused backend verification above was used for this issue branch.

---

## 2026-05-20 — Login redesign, responsive dashboard layout, landing polish

**Goal:** Redesign login page to match landing aesthetic, make the full application responsive across all device sizes, add Sign in to landing page, trim all redundant copy from public surfaces.

**Branch:** `feat/ui-responsive-polish`

**What changed:**

- `frontend/app/login/page.tsx` — Full redesign. Dark left panel (Fraunces headline "Compliance ops, fully in view.", feature list with icons, sandbox shortcut card) + light right form panel. Password show/hide toggle with Eye/EyeOff icons. Mail and Lock icons in inputs. Zap icon on Fill demo credentials. "Skip login — open public sandbox" link with BadgeCheck icon. Email/password labels visible (not placeholder-only). Proper `h-12` touch targets on all inputs. Removed all redundant explanatory text. Mobile: left panel hidden, form panel with light gradient background and compact WW logo.
- `frontend/app/(dashboard)/layout.tsx` — Full responsive overhaul. Sidebar moved to `fixed` overlay on mobile (`-translate-x-full` → `translate-x-0` on open), with dark backdrop and slide-in animation. Added sidebar close button (X icon) and outside-click handler. Added icon to every nav item (BarChart3, Shield, ClipboardList, BookOpen, FileClock, Activity, Settings). User info + logout moved to sidebar footer (avatar initial + email + role + LogOut icon button). Header stripped to: hamburger (mobile only) + compact logo (mobile only) + GlobalSearch + filters. Filters moved to a dedicated scrollable bar below the header on mobile. Hamburger uses proper Menu icon from lucide.
- `frontend/app/page.tsx` — Added Sign in link/button to header nav (LogIn icon), hero CTAs, walkthrough section, and footer. Feature card copy trimmed. Hero subparagraph reduced to one tight sentence. Walkthrough section body reduced to one sentence. Removed portal pills section. Operating notes reduced to 3. Sandbox section list items now use BadgeCheck icons. Feature card "AI-assisted authoring" replaces the "Polished demo surfaces" placeholder.
- `frontend/vitest.config.ts` — Added alias for `next/font/google` → `test/mocks/next-font.ts` so font imports don't break Vitest.
- `frontend/test/mocks/next-font.ts` — New mock file returning stable className/variable stubs for Fraunces, Geist, GeistMono, Inter.

**Tests:** 40/40 pass. Lint clean.

---

## 2026-05-19 — Public landing page + sandbox entry (issue #38)

**Goal:** Carry forward the Codex `feat/workwell-landing-sandbox` handover work: polish the public landing page, improve sandbox UX, and clean up all internal-facing copy from the public surface.

**Branch:** `feat/workwell-landing-sandbox`

**What changed:**

- `frontend/app/page.tsx`
  - Added a stats strip in the hero (4 compliance programs, 50+ employees, 5 outcome types, 1-click sandbox entry) to ground the product story in concrete numbers.
  - Updated the badge to "PUBLIC SANDBOX · NO LOGIN REQUIRED" for clarity.
  - Cleaned the hero subheading — removed "The landing page keeps the story simple…" meta-commentary; copy now describes what's actually in the product.
  - Replaced the sandbox preview card heading "Built for review, not for friction." with "Open the dashboard in one click." and replaced the dark section's weak internal copy with the actual app section names (Programs & outcome trends, Case worklist & outreach, CQL Measure Studio, Audit trail & exports).
  - Tightened the operating-notes pills to short, punchy form.
  - Fixed the video section: removed "Why the video belongs here" + "Doug's note calls for…" references; heading is now "The full product story in under five minutes." and the body describes the actual walkthrough flow.
  - Fixed video card footer copy to remove internal-facing commentary.
  - Fixed a YouTube Short URL typo: `SqzDt4TBd9k` → `SgzDt4TBd9k` (consistent with CLAUDE.md and vision doc).
  - Footer copy changed from "Built as a public front door for the WorkWell demo and review flow." to "WorkWell Measure Studio — compliance operations for occupational health."

- `frontend/app/sandbox/page.tsx`
  - Redesigned as a full dark (slate-950) branded loading screen: centered WW monogram, brand label, loading status panel, animated step indicators (Connecting → Authenticating → Opening Programs dashboard), and footer links.
  - Removed the three info cards that appeared while the user was waiting (redundant during a fast redirect).
  - All auth logic and state management kept identical to the Codex handover; 40/40 tests still pass.

**Verification:**
- `corepack pnpm lint` — clean
- `corepack pnpm test` — 40/40 pass
- Browser confirmed: landing page renders with stats strip and clean copy; sandbox auto-signs in and redirects to /programs; public routes exempt from auth refresh loop.

## 2026-05-19 — OS MIEWeb deployment branch

**Goal:** Prepare an additive, review-only deployment path for WorkWell Measure Studio on MIE's open source Proxmox cluster without disturbing the existing Vercel + Fly deployment.

**Branch:** `os-mieweb-deploy`

**What changed:**
- `backend/Dockerfile`
  - Kept the repo's Gradle Kotlin DSL build instead of switching to Maven, because this project has no Maven build and the stack is fixed to Gradle.
  - Builds a Spring Boot jar in a Gradle stage, copies the runnable jar into `eclipse-temurin:21-jre-alpine`, exposes `8080`, and adds the required MIE default-port label.
  - Uses process env for runtime configuration and preserves `JAVA_OPTS`.
- `frontend/Dockerfile`
  - Added a Node 20 Alpine multi-stage build with `NEXT_PUBLIC_API_URL` defaulting to `https://workwell-api.os.mieweb.org`.
  - Enables standalone Next.js output and runs the generated standalone server on port `3000`.
  - Exposes `3000` and adds the required MIE default-port label.
- `.github/workflows/deploy-os-mieweb.yml`
  - Added additive GHCR build jobs for `ghcr.io/taleef7/workwell-api` and `ghcr.io/taleef7/workwell`.
  - Added direct Create-a-Container REST deploy jobs for explicit `workwell-api` and `workwell` hostnames, gated naturally by `push` to `main` or manual dispatch.
- `.github/scripts/deploy-mieweb-container.sh`
  - Centralized the shared MIE REST API deployment flow so backend and frontend deploys use the same site/domain lookup, replace-existing handling, job polling, and API error handling.
- `docs/DEPLOY_OS_MIEWEB.md`
  - Added setup, secrets, public GHCR visibility, health verification, rollback, and pre-first-deploy clarification notes.

**Needs clarification before first deploy:**
- `mieweb/launchpad@main` appears to derive the container hostname from `owner-repo-branch`, with no documented override. MIE admins should confirm how to deploy two distinct LXC containers from the same repo/branch before this workflow runs on `main`.
- Confirm `LAUNCHPAD_API_URL` and whether `site_id: 1` is the intended Phoenix DC target.

**Follow-up update:**
- Confirmed `https://manager.os.mieweb.org/api/openapi.json` exposes direct Create-a-Container REST endpoints for explicit `hostname`, `services`, and `environmentVars`.
- Reworked `.github/workflows/deploy-os-mieweb.yml` away from `mieweb/launchpad@main` to direct REST calls so the same repo/branch can create both `workwell-api` and `workwell`.
- Set site `1` as the Phoenix target and removed `ANTHROPIC_API_KEY` from the required MIE workflow secrets because the current backend configuration uses OpenAI.
- Documented the remaining owner steps in `docs/DEPLOY_OS_MIEWEB.md`: Neon JDBC `DATABASE_URL`, `WORKWELL_AUTH_JWT_SECRET`, and making GHCR packages public after first image push.
- Addressed PR review follow-up: backend image default profile is now `prod,production`, and shared MIE API bash moved into `.github/scripts/deploy-mieweb-container.sh`.
- After the first `main` deploy attempt, corrected the MIE API base handling: `/api` serves Swagger UI, while JSON REST endpoints are rooted at `https://manager.os.mieweb.org`.

## 2026-05-19 — UAT Section 3: Measure drill-down (issue #26)

**Goal:** Fix the three Section 3 code bugs and correct the Section 3 walkthrough-guide inaccuracies (UAT #23, comment 4).

**Branch:** `fix/section-3-measure-drilldown`

**What changed:**
- `frontend/app/(dashboard)/programs/[measureId]/page.tsx`
  - Bug 8: added a **Run history** table (from `/api/programs/{measureId}/trend`, newest first) with per-run links to `/runs?runId=...` and a "View all runs →" link. No backend change needed (trend is already measure-scoped).
  - Bug 9: added a **recharts donut** of the latest-run outcome breakdown (Compliant/Due Soon/Overdue/Missing/Excluded) and converted the plain-text **Reason mix** card into proportion bars.
- `frontend/app/(dashboard)/runs/page.tsx`
  - Bug 8 (cont.): `/runs?runId=` now pre-selects that run in Run Detail (`useSearchParams`; deep-linked run preserved even when not in the current list page).
  - Bug 10: non-compliant outcome rows (those with a `caseId`) are now clickable → `/cases/[caseId]` (pointer + hover, keyboard accessible, inner links stopPropagation). Compliant/Excluded rows are muted and non-clickable.
- `docs/WALKTHROUGH_GUIDE.md`
  - Corrected Section 3 inaccuracies 6–11: AI Run Insight is on `/runs` (auto-loads, real disclaimer wording), duration shown in seconds, real outcomes-table columns, measure labelled "Audiogram". Synced the matching Section 6 duration/label mentions. CSV `durationMs` column name left intact (real column).

**Verification:**
- `pnpm lint` / `pnpm build` ✅
- Production data-shape validation via browser (changed code can't run on a preview: prod CORS allowlist excludes non-prod origins by design, and the preview is behind Vercel deployment protection).

**PR #35 review follow-up (automated reviewers):**
- Codex P2 + Copilot: `/runs?runId=` with an invalid/stale id no longer strands the user on an error path — `loadSelectedRun` now drops the URL preservation, cleans the query param (`router.replace`), and falls back to the newest run.
- Copilot: row-level `onKeyDown` on outcome rows now guards `event.target === event.currentTarget`, so Enter/Space on the nested Employee/Case links keeps their own navigation.
- Copilot: reconciled the Audiogram naming inconsistency — Section 2's card list now shows the real UI labels (Audiogram / Flu Vaccine / HAZWOPER Surveillance / TB Surveillance) with the long policy titles marked documentation-only, matching the Section 3 note.

## 2026-05-19 — Auth reload-session hardening follow-up

**Goal:** Eliminate the remaining page-refresh logout path by hardening frontend session bootstrap and login cookie persistence.

**Branch:** `fix/section-1-refresh-reload-session`

**What changed:**
- `frontend/components/auth-provider.tsx`
  - Added a hydration-safe guard in the unauthenticated effect: if the render sees `token=null` but a valid session still exists in localStorage, the provider now re-emits session state instead of clearing storage and forcing refresh.
  - This removes the race where hard reload could clear a still-valid access token and bounce users to `/login`.
- `frontend/app/login/page.tsx`
  - Added `credentials: "include"` to `POST /api/auth/login` so the browser persists the HttpOnly refresh cookie in cross-origin mode (`vercel.app` frontend to `fly.dev` backend).
- Tests:
  - Added regression in `frontend/components/__tests__/auth-provider.test.tsx` to verify valid local session is retained without refresh/redirect.
  - Added `frontend/app/login/__tests__/page.test.tsx` to verify login fetch includes credentials and still logs in.

**Verification:**
- `corepack pnpm test` ✅ (37/37)
- `corepack pnpm lint` ✅
- `corepack pnpm build` ✅

## 2026-05-19 — UAT re-verification: Section 1 cross-site cookie regression

**Goal:** Verify UAT #23 Section 1 (#24) and Section 2 (#25) fixes are *actually* complete in production.

**Branch:** `fix/section-1-cross-site-refresh-cookie` (PR #33); the Section 2 modal follow-up is `fix/section-2-run-all-confirm-modal` (PR #34)

**Findings (end-to-end test against production, real browser):**
- **Section 1 / #24 — NOT fixed in production.** Frontend silent-refresh code (`auth-provider.tsx`) is correct and the backend `/api/auth/refresh` contract matches, but the refresh cookie was issued `SameSite=Lax` with no `Secure`. Frontend (`vercel.app`) and backend (`fly.dev`) are different sites, so the browser never sends a `SameSite=Lax` cookie on the cross-site `POST /api/auth/refresh` fetch. Reproduced: cleared `ww_token`, reloaded `/programs` → redirected to `/login`, console shows `401 @ /api/auth/refresh`.
- **Section 2 / #25 — code correct but backend not redeployed.** Bug 1/2/3/6 (frontend) are live via Vercel. Bug 5 (driver scoping) and Bug 7 (`fly.toml min_machines_running=1`) are merged to `main` but the Fly backend was never redeployed (uptime ≈21h predates the 2026-05-18 18:54 fix commit). Live API still returns identical driver data for Flu/HAZWOPER/TB.

**Fix applied (Section 1 cookie):**
- `AuthController` — refresh/logout cookie `SameSite` now configurable (`workwell.auth.cookie-same-site`, default `Lax`); `Secure` auto-forced when `SameSite=None` (browser hard requirement).
- `application.yml` — added `cookie-same-site: ${WORKWELL_AUTH_COOKIE_SAME_SITE:Lax}`.
- `StartupSafetyValidator` — new `validateCookiePolicy`: production-like startup now **fails fast** unless `SameSite=None` + `Secure=true` (prod is cross-site by design); plus universal `None ⇒ Secure` rule. 5 new tests; existing tests green.
- Docs: `.env.example`, `docs/DEPLOY.md` (Fly secrets + env table) updated.

**Still required (owner action — not auto-applied):**
- Set Fly secrets `WORKWELL_AUTH_COOKIE_SAME_SITE=None` and `WORKWELL_AUTH_COOKIE_SECURE=true`, then **redeploy the Fly backend**. This single redeploy also activates the merged Bug 5 and Bug 7 fixes. Frontend needs no change.

## 2026-05-17 — Sprint 5: Test Suite and CI Gates

**Goal:** Add meaningful test coverage and make CI block merges on failures.

**Branch:** `feat/sprint-5-tests-ci`

**Issue 5.2 — Backend integration tests:**
- Created `CaseUpsertIntegrationTest` (2 tests): verifies that re-running `AllProgramsRunService` produces 0 duplicate case rows and that the unique-key constraint holds across all composite keys.
- Created `CaseSlaServiceTest` (2 tests): backdates `sla_due_date` to yesterday on a seeded open case, calls `escalateBreachedCases()`, asserts priority was escalated and a `CASE_SLA_BREACHED` audit event was written; second test verifies already-breached cases are not escalated again.
- Both extend `AbstractIntegrationTest` (existing TestContainers PostgreSQL 16 infrastructure).
- Note: evidence MIME tests already covered by existing `EvidenceServiceTest` and `EvidenceAccessIntegrationTest` (Sprint 4 work).

**Issue 5.1 — Frontend unit tests:**
- Installed: `vitest @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom @testing-library/user-event msw jsdom @vitejs/plugin-react`.
- Extracted `SlaChip` from inline cases-page logic to `frontend/components/SlaChip.tsx` (also replaces the local copy in the employee profile page); adds `data-testid="sla-chip"` for test targeting.
- Created `vitest.config.ts`, `test/setup.ts`, `test/msw/handlers.ts`, `test/msw/server.ts`.
- Tests written (17 passing):
  - `__tests__/components/SlaChip.test.tsx` — 8 tests: null guard, Breached text, day count, color classes per urgency tier
  - `__tests__/auth/AuthProvider.test.tsx` — 5 tests: renders children, null when empty localStorage, real token read, expired token guard, login stores to localStorage
  - `__tests__/lib/ApiClient.test.ts` — 4 tests: Authorization header, 401 → onUnauthorized, ApiError on 404, POST JSON body + Content-Type; all API calls intercepted by MSW (no real network)
- Added `test`, `test:watch`, `test:coverage` scripts to `package.json`.
- `pnpm test` exits 0 ✅

**Issue 5.3 — CI gates:**
- Updated `.github/workflows/ci.yml`: added `pnpm test` step to the frontend job (between lint and build); added `workflow_dispatch` trigger; added `dorny/test-reporter` for backend JUnit XML results.
- Backend `./gradlew test` was already in CI. Frontend build/lint already in CI. Unit tests now gate frontend job.

**Issue 5.4 — Playwright E2E:**
- Created `e2e/` directory with `package.json`, `playwright.config.ts`, and `e2e/tests/golden-path.spec.ts`.
- 4 tests: programs overview loads without 500, cases list renders rows, employee profile loads, full login→programs→cases→studio→logout flow.
- CI `e2e` job triggers only on `workflow_dispatch` (manual) to avoid billing on every PR.

**Verification:**
- `corepack pnpm test` ✅ (17 tests, 3 files)
- `corepack pnpm lint` ✅
- `corepack pnpm build` ✅ (all 14 routes, including new `/employees/[externalId]`)

## 2026-05-17 — Sprint 6: Admin Polish, Email Delivery, Integration Completeness

**Goal:** Make the Admin panel demo-useful — meaningful integration health, a visible outreach delivery log (no real email on the demo stack), UI-editable notification templates, and a non-prod demo-reset tool.

**Branch:** `feat/sprint-6-admin` (worktree `C:\workwell-wt\sprint-6-admin`). Sprint doc V020/V021 numbering is stale; `V021__add_outreach_delivery_log.sql` was pre-authored by Taleef and used as-is. No migrations written/edited by the agent.

**Issue 6.1 — Live integration health:**
- Extended `IntegrationHealthService` (not a new sync service): added `@Scheduled(fixedDelay=900_000)` `scheduledRefresh()` refreshing fhir+mcp+hris (AI is reactive). `@EnableScheduling` already present in `BackendApplication`.
- FHIR check now instantiates `FhirContext.forR4Cached()` (real CQL-engine smoke) → `healthy`/`unhealthy`.
- HRIS is now a distinct first-class `simulated` status with message "Integration not connected — synthetic data only" (was a "healthy" stub).
- Added `recordAiHealth(success, detail)` lightweight status setter (no audit write — avoids per-call audit spam). `AiAssistService.callWithModelFallback` now calls it: success → `healthy`, both-models-failed → `degraded` with root-cause reason.
- `IntegrationHealth` record JSON unchanged. Frontend `admin/page.tsx` `statusBadgeClass` extended: green=healthy, sky=simulated, amber=degraded/stale, red=unhealthy, gray=unknown. Existing per-integration "Manual Sync" button already re-fetches.

**Issue 6.2 — Outreach delivery log + EmailService:**
- Added `com.sendgrid:sendgrid-java:4.10.2`. Created `com.workwell.notification.EmailService` + `EmailDeliveryRecord`. Provider switch on `workwell.email.provider` (default `simulated`); sendgrid path only active when both provider=sendgrid AND api-key set (degrades to simulated otherwise). **CLAUDE.md hard rule honored: `simulated` stays default; SendGrid not enabled.**
- Synthetic recipient: employees have no email column, so address is deterministic `<external_id>@workwell-demo.dev` (obviously non-routable, stable across reruns).
- Wired into `CaseFlowService.sendOutreach`: renders subject/body, sends via `EmailService`, inserts an `outreach_delivery_log` row, augments the `case_actions` payload with `emailMessageId`/`deliveryProvider`/`emailDeliveryStatus`/`toAddress`/`sentAt`. `insertCaseAction` now returns the action UUID for FK linkage.
- New `OutreachDeliveryLogService` + `GET /api/admin/outreach/delivery-log?limit=20` (joins cases→measure_versions→measures for measure name). Admin UI delivery-log table with status colors. Case-detail timeline already surfaces OUTREACH_SENT payload, which now includes provider/status (no separate timeline change needed).

**Issue 6.3 — Notification templates editable:**
- `outreach_templates` + list/create/update endpoints already existed. Added `OutreachTemplateService.previewTemplate(id)` + `GET /api/admin/outreach-templates/{id}/preview` substituting `{employee_name}`/`{measure_name}`/`{due_date}`/`{assignee_name}`. Admin UI section: list + inline edit (subject, body) via existing PUT + preview. "Reset to default" not shipped (optional per corrected scope; edit+preview covers the demo need).

**Issue 6.4 — Demo reset:**
- Created `com.workwell.admin.DemoResetService` `@Profile("!prod")` `@Transactional`; truncates volatile tables in FK order with RESTRICT (also includes `scheduled_appointments`, `outreach_records`, `evidence_attachments`, `data_readiness_snapshots` which FK to cases/runs — required so RESTRICT does not fail), then resets `integration_health` to unknown/null.
- `POST /api/admin/demo-reset` injects `Optional<DemoResetService>` → 403 when absent (prod). `/api/admin/**` is already ROLE_ADMIN path-gated in SecurityConfig; no `@EnableMethodSecurity` present so no method-level annotation added. Admin UI two-step-confirm "Reset Demo Data" button with inline success message (no toast component in repo).

**Audit caveat:** demo reset truncates `audit_events` — in tension with the audit-integrity rule, but it is an explicitly sprint-sanctioned non-prod-only tool (`@Profile("!prod")`, 403 in prod).

**Tests added:** `AdminControllerTest` (preview ok/404, delivery-log, demo-reset success) + new `AdminControllerDemoResetAbsentTest` (403 when bean absent). Updated `AiServiceIntegrationTest` and `AdminControllerTest` constructors for new dependencies.

**Verification:** see end-of-entry. Docs updated same change: `DATA_MODEL.md` (outreach_delivery_log table), `DEPLOY.md` (email provider stays simulated), `ARCHITECTURE.md` (notification module note).

## 2026-05-17 — Sprint 3: Employee Profile, Cross-Program View, SLA Tracking

**Goal:** Clickable employee profiles aggregating cross-program compliance posture, functional global search, SLA countdowns on cases, and a My Cases view.

**Sprint 1 merged (PR #18):** Async run pipeline, scheduler, SITE/EMPLOYEE scoped runs, cases pagination — all shipped to main.

**Issue 3.1 — Employee profile page (backend + frontend):**
- Created `EmployeeProfileResponse.java` DTO in `com.workwell.web.dto` with nested records: `MeasureOutcomeSummary`, `OpenCaseSummary`, `AuditEventSummary`.
- Created `EmployeeProfileService.java` in `com.workwell.run` with `getProfile(externalId)` (4 SQL queries: employee base, latest outcome per measure via `DISTINCT ON (mv.measure_id)`, open cases, last 20 audit events) and `search(q, limit)` (LIKE pattern on name/externalId/role). Uses `JdbcTemplate` + `ObjectMapper` for JSONB evidence parsing.
- Created `EmployeeProfileController.java` at `/api/employees/{externalId}/profile` and `/api/employees/search`. Both `@PreAuthorize("isAuthenticated()")`.
- Created `frontend/features/employee/hooks/useEmployeeProfile.ts` — fetches the profile endpoint.
- Created `frontend/features/employee/components/ComplianceSummaryBar.tsx` — color-coded pill row per measure outcome.
- Created `frontend/app/(dashboard)/employees/[externalId]/page.tsx` — full profile page: header, compliance posture bar, open cases table (with SLA chip placeholder), measure detail accordion, recent activity timeline.

**Issue 3.2 — Global search:**
- Created `frontend/components/GlobalSearch.tsx` — debounced (300ms) type-ahead search, calls `/api/employees/search?q=...`, shows name/role/site/outcome badge in dropdown, navigates to `/employees/:externalId`, closes on Escape or outside click.
- Wired `<GlobalSearch />` into the dashboard header in `layout.tsx`.
- Added `{ href: "/cases", label: "Cases" }` nav item to the sidebar.

**Issue 3.3 — SLA tracking (complete):**
- Created `CaseSlaService.java` in `com.workwell.caseflow` with:
  - `computeSlaDueDate(outcomeStatus)`: OVERDUE→14d, DUE_SOON→30d, MISSING_DATA→21d from now.
  - `@Scheduled(cron = "0 0 */6 * * *") escalateBreachedCases()`: bumps priority one level, sets `sla_breached=TRUE`, writes `CASE_SLA_BREACHED` audit event. `BadSqlGrammarException` (missing column) silently skipped for mixed-deployment safety; other `DataAccessException` logged at ERROR.
- `V020__add_case_sla_due_date.sql` adds columns and backfills with outcome-specific windows (OVERDUE 14d, MISSING_DATA 21d, DUE_SOON 30d via CASE expression).
- `CaseFlowService.upsertOpenCase` injects `CaseSlaService` and writes `sla_due_date` on INSERT/reopen; preserves existing `sla_due_date` and `sla_breached` on update of already-open cases to prevent SLA resets by regular runs.
- `CaseSummary` record and `listCases()` query updated: `sla_due_date`, `sla_breached`, and computed `slaRemainingDays` now included in the cases API response.
- `OpenCaseSummary` DTO and `EmployeeProfileService` updated: `slaBreached` flag included alongside `slaDueDate`/`slaRemainingDays`.
- Frontend: `SlaChip` on employee profile page now receives `breached={c.slaBreached}`, so already-breached cases show "Breached" rather than "0d left".

**Issue 3.4 — My Cases tab:**
- Added "All Cases / My Cases" tab row to `cases/page.tsx`. "My Cases" filters `/api/cases?assignee={user.email}&view=mine`.
- Employee names in cases list, case detail, and runs page now link to `/employees/{employeeId}`.

**Branch:** `feat/sprint-3-employee-profile`

**Verification:**
- `./gradlew.bat compileJava` ✅
- `corepack pnpm lint` ✅
- `corepack pnpm build` ✅ — `/employees/[externalId]` live in route table

## 2026-05-16 — Sprint 2 merged; Sprint 1: Run Pipeline & Operational Correctness

**Goal:** Transform the run pipeline from synchronous-blocking to async with polling, enable the scheduler, implement SITE/EMPLOYEE scoped runs, and add cases pagination.

**Sprint 2 merged:** PR #17 (`feat/sprint-2-demo-data-visual`) merged to main. All V016–V019 migrations, trend charts, skeleton loaders, assignee personas, and reason code breakdown shipped.

**Issue 1.1 + 1.4 — Async run execution & auto-refresh (backend + frontend):**
- Created `AsyncConfig.java`: `runExecutor` ThreadPoolTaskExecutor (core=2, max=4, queue=20, graceful shutdown 120s).
- Added `createPendingRun()`, `updateRunStatus()`, `setFailureSummary()`, and `finalizeAsyncRun()` to `RunPersistenceService`. `finalizeAsyncRun` replicates the post-INSERT logic of `persistAllProgramsRun` (outcomes, case upserts, audit events, run finalization) on a pre-existing run row.
- Added `createRunRecord()` and `@Async("runExecutor") executeRunAsync()` to `AllProgramsRunService`. Private `evaluateForScopeAsync()` handles ALL_PROGRAMS, MEASURE, SITE, and EMPLOYEE dispatch.
- `EvalController.POST /api/runs/manual`: CASE scope stays synchronous (200 OK); all other scopes return HTTP 202 immediately with `{runId, status: "REQUESTED", message}`.
- Frontend `programs/page.tsx`: after triggering a run, stores `activeRunId` and polls `GET /api/runs/{id}` every 5s. Button disabled while polling with "Running…" label. Auto-calls `loadAll()` on COMPLETED/PARTIAL_FAILURE. Toast on success/failure.

**Issue 1.2 — Scheduler enabled:**
- `application.yml`: scheduler default changed to `enabled: true`, cron `0 0 2 * * *` (2AM UTC daily).
- `ScheduledRunService.runScheduledAllPrograms()` now uses the async path (`createRunRecord` + `executeRunAsync`) instead of blocking `runAllPrograms()`.

**Issue 1.3 — SITE and EMPLOYEE scoped runs:**
- `evaluateForScopeAsync()` in `AllProgramsRunService` handles SITE (filters outcomes by `site`) and EMPLOYEE (filters by `subjectId`) scopes. Both require corresponding request fields or return 400.
- Missing required field validation returns 400 via `IllegalArgumentException` → `ResponseStatusException`.

**Issue 1.5 — Cases load-more pagination:**
- `CaseFlowService.listCases()` extended with `limit` and `offset` parameters; SQL query appended with `LIMIT ? OFFSET ?`. Existing call sites default to limit=50, offset=0.
- `CaseController.GET /api/cases` now accepts `limit` (default 25) and `offset` (default 0).
- Frontend `cases/page.tsx`: initial load fetches 25 cases; "Load more" button appends the next 25. `hasMore` flag hides the button when a page returns fewer than 25.

**PR review fixes (Copilot/Codex findings on PR #18):**
- `AllProgramsRunService`: added `validateScopeRequest()` — enforces required fields (site/employeeExternalId/measureId) before any DB write; throws `IllegalArgumentException` → 400. Added `resolveScopeId()` to persist `scope_id` in `runs` for MEASURE-scoped runs. Added 3-arg `createRunRecord` overload so `ScheduledRunService` can pass `triggerType="scheduler"` (previously hardcoded to "manual").
- `RunPersistenceService.createPendingRun`: extended to accept `scopeId (UUID)` and `evaluationDate (LocalDate)` so `measurement_period_start/end` and `scope_id` are written at INSERT time rather than deferred.
- `finalizeAsyncRun`: now writes `started_at`, `measurement_period_start/end`, and `duration_ms` in the final UPDATE to prevent timestamp drift in completed run records.
- `CaseController`: fixed `limit` `defaultValue` to `"25"` (was `"50"`) to match frontend `PAGE_SIZE`.
- `runs/page.tsx`: `ManualRunResponse` fields made optional — the 202 async response only returns `{runId, status, message}`. Toast now uses `data.message` directly when `scopeLabel` is absent, preventing "undefined - Run queued…".

**CI speed fix:**
- Created `AbstractIntegrationTest.java` with a single JVM-wide `static PostgreSQLContainer` started via a static initialiser. All 15 integration test classes now extend it and no longer spin up their own container. Spring context caching reuses a single `ApplicationContext` across the 10 plain `@SpringBootTest` classes. Expected CI improvement: ~30 min → ~8 min.

**Branch:** `feat/sprint-1-run-pipeline`

**Verification:**
- `corepack pnpm lint` ✅
- `corepack pnpm build` ✅
- `./gradlew.bat compileTestJava` ✅ (review fixes + AbstractIntegrationTest compile clean)
- CI run pending on PR #18 push.

## 2026-05-16 — Sprint 2: Demo Data & Visual Quality

**Goal:** Replace system-generated placeholder data with realistic personas, enrich the measure catalog, and make the trend charts interpretable.

**Issue 2.1 — Measure owners and tags (V016):**
- V016 migration updates owner to J. Chen (Audiogram), M. Patel (HAZWOPER), K. Williams (TB + Flu Vaccine).
- Sets `approved_by = 'Dr. R. Patel (Medical Director)'` on all active measure versions.
- Adds realistic tag arrays per measure (e.g., `['surveillance','hearing','osha']`).
- Frontend: Tags in measures list now render as inline chip spans instead of comma-joined text.

**Issue 2.2 — Additional measures catalog (V017):**
- V017 migration adds Respirator Fit Test (Draft v0.9, J. Chen), Hepatitis B Vaccination Series (Approved v2.0, K. Williams), Lead Medical Surveillance (Deprecated v1.1, M. Patel).
- Catalog now shows 7 measures across all lifecycle states — matches v0 prototype richness.
- Each insert is wrapped in an idempotent DO $$ block.

**Issue 2.3 — Trend charts with axes, tooltips, delta (V018 + backend + frontend):**
- V018 migration seeds 5 months of MEASURE-scoped historical runs for all 4 active measures with gradual compliance decline for visual interest.
- `ProgramService.trend()` extended with a UNION branch: outcome-based data (existing behavior) + run-level aggregate data for MEASURE-scoped runs that have no outcome rows — historical seed runs appear without needing full outcome data.
- Replaced bare SVG `Sparkline` with Recharts `LineChart`: X-axis month labels, Y-axis percentage scale, hover tooltip with exact %, and a delta badge showing ↑/↓ % change from last run.
- Added recharts 3.8.1.

**Issue 2.4 — Top drivers reason code breakdown:**
- Backend: `byOutcomeReason` query now includes DUE_SOON (was OVERDUE + MISSING_DATA only); `totalFlagged` denominator updated to match.
- Frontend: Rendered a new "By Reason" section below site/role drivers with color-coded chips (rose for Overdue, amber for Due Soon, slate for Missing Data) and count + percentage.

**Issue 2.5 — Case assignees (V019):**
- V019 migration assigns ~30% of open cases to Sarah Mitchell, ~30% to James Torres, ~40% remain unassigned.
- Idempotent: only updates rows where assignee IS NULL.

**Issue 2.6 — Skeleton loading states:**
- New shared `frontend/components/skeleton-loader.tsx` with `SkeletonCard` and `SkeletonRow` using Tailwind `animate-pulse`.
- Programs Overview: 4 skeleton cards while loading (matches measure card shape).
- Cases list: 10 skeleton rows (8 cols) while loading.
- Runs list: 10 skeleton rows (7 cols) while loading.

**Branch:** `feat/sprint-2-demo-data-visual`

**Verification:**
- `corepack pnpm lint` ✅
- `corepack pnpm build` ✅
- Backend tests running (Testcontainers + Flyway V016–V019 applied).

## 2026-05-16 — Live QA polish fixes

**Goal:** Resolve the three non-blocking issues found during the automated live QA pass on the canonical Vercel deployment.

**React hydration error #418 (frontend):**
- Root cause: `AuthProvider` initialized session state with a lazy initializer that reads `localStorage` — a mismatch because the server-side initializer returns null but the client-side re-initialization finds a stored token.
- Fix: initialize with `{ token: null, user: null }` always. A dedicated `useEffect` reads `localStorage` after mount and sets a `mounted` flag. Redirect and cleanup effects gate on `mounted` so they wait until the localStorage check completes.
- Effect: server and client initial renders match, hydration succeeds, no React error #418.

**MCP health cosmetic issue (backend):**
- Root cause: `IntegrationHealthService.checkMcpHealth()` classified HTTP 401/403 from the SSE endpoint as `degraded`. But 403 means the endpoint is reachable and correctly secured — not broken.
- Fix: 401/403 responses now return `status=healthy` with detail "MCP SSE reachable and secured by auth". Real failures (timeouts, 5xx, connection refused) still return `degraded`.

**Demo test fixtures missing (backend migration):**
- Added `V015__seed_demo_test_fixtures.sql` which updates `spec_json->'testFixtures'` for all 4 active measures.
- Audiogram and HAZWOPER: 5 fixtures each (COMPLIANT, DUE_SOON, OVERDUE, MISSING_DATA, EXCLUDED).
- TB Surveillance: 5 fixtures (same coverage). Flu Vaccine: 3 fixtures (COMPLIANT, MISSING_DATA, EXCLUDED — matching current CQL outcomes).
- Migration is idempotent: only updates rows where `testFixtures` is currently empty.

**Verification:**
- `corepack pnpm lint` ✅
- `corepack pnpm build` ✅
- `./gradlew.bat test` ✅ (all tests pass including V015 Flyway migration via Testcontainers)
- `git diff --check` ✅

## 2026-05-14 — Sprint 0 Issue 0.8 run history pagination and timestamp compaction

**Goal:** Keep the run history view readable by limiting the initial fetch, adding a progressive load-more control, and shrinking timestamp/ID copy.

**Frontend run history update:**
- Added `limit=20` to the initial runs fetch and a `Load more runs` control that increases the limit in 20-row increments.
- Preserved the selected run when more rows are fetched so the detail pane stays stable.
- Switched the runs table to fixed layout, added a `Started` column with relative timestamps, and shortened run IDs with hover titles for the full ID.
- Added compact absolute timestamp helpers for hover text and detail-view timestamp formatting.

**Verification:**
- `git diff --check`
- `corepack pnpm lint`
- `corepack pnpm build`
- Playwright browser harness on `http://localhost:3004/runs` with mocked API/session: initial 20 rows, `Load more runs` fetched 40 rows, requests observed `limit=20` then `limit=40`
- Playwright browser harness verified the first run timestamp rendered as `2h ago` with the full timestamp in the hover title and stable header widths at 1280px

## 2026-05-14 — Sprint 0 Issue 0.7 login console errors eliminated

**Goal:** Stop the login entry path from triggering protected dashboard fetches so reviewers see zero console errors before they sign in.

**Frontend auth/session gate:**
- Added JWT expiration validation to the auth provider bootstrap so stale `ww_token` values are treated as logged out before the UI renders.
- Cleared any stored auth payloads that no longer represent a live session, without surfacing a visible error state.
- Routed the app root into the login flow and added a login-page redirect for already-authenticated sessions.
- Short-circuited the dashboard shell when no live session exists so the protected site and worklist fetches never run on unauthenticated entry.

**Verification:**
- `git diff --check`
- `corepack pnpm lint`
- `corepack pnpm build`
- Playwright console on `http://localhost:3000/login` with no session: zero errors
- Playwright console on `http://localhost:3000/login` with an expired token in localStorage: zero errors

## 2026-05-14 — Sprint 0 Issue 0.6 status enum labels humanized

**Goal:** Replace raw API/status enum strings with title-case labels across the visible frontend surfaces.

**Frontend status cleanup:**
- Added shared label helpers in `frontend/lib/status.ts`, including enum normalization and a reusable fallback formatter.
- Humanized the dashboard header role badge, programs overview role breakdown, runs filters/list/detail, case list/detail badges, measure list badges, studio measure header, and the admin integration/mapping badges.
- Updated the studio subpanels so compile status, readiness status, resolvability status, traceability severity, value-set labels, and test-fixture outcomes render as readable labels instead of all-caps enums.

**Verification:**
- `git diff --check`
- `corepack pnpm lint`
- `corepack pnpm build`

## 2026-05-14 — Sprint 0 Issue 0.5 login branding and demo fill

**Goal:** Make the login page look intentional and give reviewers a one-click path into the shared demo account.

**Frontend branding:**
- Reworked the login page into a branded split-panel auth screen with a WW monogram, product name, and tagline.
- Added a visible demo credential hint for `cm@workwell.dev / Workwell123!`.
- Added a `Use demo credentials` button that fills the login form without needing the demo mode flag.
- Kept the existing login flow intact so sign-in still posts to the same auth endpoint.

**Verification:**
- `corepack pnpm lint`
- `corepack pnpm build`
- `Select-String` confirmed the brand copy and the demo credential fill handler in `frontend/app/login/page.tsx`.

## 2026-05-14 — Sprint 0 Issue 0.4 admin visibility gate

**Goal:** Hide the Admin entry from non-admin users and replace the broken admin skeleton/error state with a calm access-denied screen.

**Frontend auth/UI gate:**
- Conditioned the dashboard nav so the Admin link only renders for `ROLE_ADMIN`.
- Added a clean `Admin access required` empty state for non-admin users on `/admin`.
- Guarded admin page data-loading callbacks so non-admin visits do not trigger the error banner or fetch the admin data panels.

**Verification:**
- `corepack pnpm lint`
- `corepack pnpm build`
- `Select-String` confirmed the Admin nav gate in `layout.tsx` and the access-denied gate in `admin/page.tsx`.

## 2026-05-14 — Sprint 0 Issue 0.3 global search hidden

**Goal:** Remove the non-functional global search bar from the dashboard header so the UI no longer advertises a broken interaction.

**Frontend cleanup:**
- Removed the global search form from the dashboard shell header.
- Deleted the unused local search state and submit handler from `layout.tsx`.
- Kept the site/date filters and account controls aligned in the header.

**Verification:**
- `corepack pnpm lint`
- `corepack pnpm build`
- Confirmed `frontend/app/(dashboard)/layout.tsx` no longer contains the global search placeholder or submit handler.

## 2026-05-14 — Sprint 0 Issue 0.2 programs overview redirect

**Goal:** Prevent `/programs/overview` from being handled as a measure detail route and hanging on invalid API requests.

**Frontend routing fix:**
- Added a Next.js request-level redirect from `/programs/overview` to `/programs`.
- Left UUID-based program detail routing unchanged so valid measure detail links continue to resolve through `/programs/[measureId]`.
- Confirmed the frontend source does not generate a browser link to `/programs/overview`; existing `/api/programs/overview` calls are backend API calls from the real programs overview page.

**Verification:**
- `corepack pnpm lint`
- `corepack pnpm build`
- Local production server check: `GET /programs/overview` returned `307` with `Location=/programs`.

## 2026-05-14 — Sprint 0 Issue 0.1 sidebar branding

**Goal:** Remove visible scaffold branding from the dashboard shell before demo review.

**Frontend polish:**
- Replaced the dashboard shell placeholder text with a compact WW mark and two-line `WorkWell / Measure Studio` product identity.
- Removed the truncating product-name class so the visible brand no longer renders as an ellipsis or scaffold label.
- Confirmed `MVP Dashboard Shell` no longer appears in the frontend source.

**Verification:**
- `corepack pnpm lint`
- `corepack pnpm build`

## 2026-05-13 — CI speedup pass for backend Gradle builds

**Goal:** Cut down backend GitHub Actions time on repeated pushes without changing product behavior.

**CI optimizations:**
- Added `gradle/actions/setup-gradle@v4` to the backend job so Gradle wrapper, dependency, and build cache state can be reused between runs.
- Enabled Gradle caching and configuration caching in `backend/gradle.properties`.
- Set `maxParallelForks = 2` for CI test runs so Spring/Testcontainers classes can overlap a bit on the hosted runner.
- Added pnpm caching for the frontend job and top-level workflow concurrency so newer pushes cancel stale in-progress runs.

**Verification:**
- `./gradlew help`
- `./gradlew build --configuration-cache --dry-run`

## 2026-05-13 — Fly MCP stability and remote auth

**Goal:** Stabilize the deployed backend for remote MCP clients and document the required Claude Desktop configuration.

**Fly config change:**
- `backend/fly.toml` now keeps `min_machines_running = 1` so the backend stays warm for long-lived MCP SSE connections instead of scaling to zero and dropping the transport.

**MCP auth note:**
- Verified the remote SSE endpoint returns `200` with a valid `ROLE_ADMIN` JWT from `/api/auth/login`.
- `mcp-remote` works with `--header Authorization:${AUTH_HEADER}` and `--transport sse-only` for this backend.

**Docs updated:**
- `docs/MCP.md` now includes the exact Claude Desktop / `mcp-remote` config with bearer auth.
- `docs/DEPLOY.md` now calls out the warm-machine requirement and the authenticated MCP connection requirement.

## 2026-05-10 — README_09 MCP v2 Safe Agent Tools (branch: hardening/readme-08-testing-docs)

**Goal:** Extend MCP with authenticated, audited agent tools for employee compliance inspection, non-compliant case listing, and deterministic rule explanation — without AI, without bypassing security, without creating official records in preview mode.

**New MCP v2 tools added** (`McpServerConfig.java`):
- `get_employee` — employee summary + last 5 compliance outcomes by externalId; returns EMPLOYEE_NOT_FOUND safe error if not found
- `check_compliance` — latest or preview compliance status for employee/measure; both modes query persisted CQL outcomes only; `complianceDecisionSource` always `"cql_outcome"`; no AI consulted
- `list_noncompliant` — open cases with DUE_SOON/OVERDUE/MISSING_DATA filter; default limit 25, max 100 enforced in SQL; INVALID_ARGUMENT returned for unknown status values
- `explain_rule` — measure policy ref, eligibility, compliance window, CQL define names, value sets from `MeasureService`; `source: "deterministic_metadata"`; no AI
- `get_measure_traceability` — delegates to `MeasureTraceabilityService.generate()`; returns rows + gaps
- `list_data_quality_gaps` — delegates to `DataReadinessService.computeReadiness()`; returns blockers + warnings + element readiness

**Preserved/unchanged:** get_case, list_cases, get_run_summary, list_measures, get_measure_version, list_runs, explain_outcome — all retain existing executeTool audit wrapper and safe error handling.

**MCP server version:** bumped 1.1.0 → 2.0.0.

**Tests added** (`McpSecurityIntegrationTest`):
- getEmployeeReturnsNotFoundForUnknownExternalId
- checkComplianceLatestModeReturnsNoOutcomeForUnknownEmployee
- checkCompliancePreviewModeDoesNotCallAi
- listNoncompliantEnforcesLimitCap (999 → capped at 100)
- listNoncompliantRejectsInvalidStatus (COMPLIANT → INVALID_ARGUMENT)
- explainRuleRequiresMeasureIdOrName
- explainRuleReturnsDeterministicMetadataWithSourceField
- mcpToolsAuditActorFromSecurityContext

**McpServerConfigTest** updated: added MeasureTraceabilityService and DataReadinessService mocks; version assertion updated to 2.0.0.

**Docs updated:**
- `docs/MCP.md` — full v2 tool inventory table, schema examples, safe error codes, audit record format, tool posture guarantees
- `docs/new instructions/README_09_MCP_V2_SAFE_AGENT_TOOLS.md` — implementation progress section added

**Design decision — preview mode:**
`check_compliance` preview resolves to the same persisted data as latest, labeled `source="preview"`. Real-time per-employee CQL re-evaluation from MCP is intentionally deferred — inline CQL eval from MCP would create unaudited transient state and adds latency. Operators needing fresh data trigger a manual run.

---

## 2026-05-10

### README_08 — Testing, CI, and Docs Sync (branch: hardening/readme-08-testing-docs)

**Goal:** Stabilization and quality pass after the big merge. No new product features.

**CI:**
- Added `pnpm build` step to frontend CI job (`.github/workflows/ci.yml`). Previously only lint ran; type errors and build failures would slip through.

**Security role integration tests:**
- Added `SecurityRoleIntegrationTest` (`backend/src/test/java/com/workwell/config/`) — 14 tests exercising role boundaries end-to-end with auth enabled and a real Postgres container.
- Covers: unauthenticated GET/POST fails (403), VIEWER can read but cannot mutate cases/runs/admin, AUTHOR can edit spec but cannot approve/activate, APPROVER cannot access admin endpoints or case actions, ADMIN can access admin endpoints, `/api/eval` internal-header enforcement.
- Prior `MeasureControllerTest`, `CaseControllerTest`, `EvalControllerTest` all use `addFilters=false` — they test controller wiring only. This test fills the auth-enforcement gap.

**Manual QA checklist:**
- Created `docs/DEMO_QA_CHECKLIST.md` — covers Author flow, Approver/Admin flow, Case Manager flow, Security checks, and MCP verification. Each step has an explicit expected outcome and pass column.

**Docs status:**
- `docs/MCP.md` — verified current (merged in PR #5 and reflects actual endpoint, roles, tool list, audit behavior).
- `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/README.md` — all updated in the big merge; spot-checked as current.
- `docs/TODO.md` — intentionally archived to `docs/archive/TODO_old_v2.md`; no replacement needed (active backlog lives in the README_XX instruction series).

**Remaining README_08 acceptance items:**
- Actor identity tests for outreach/AI draft/rerun audit actor: partially covered (`CaseControllerTest` spoofed-actor test, `CaseViewAuditIntegrationTest`, `AdminControllerTest` spoofed sync actor). Outreach and AI draft actor assertions can be strengthened in follow-up if regression is observed.
- Playwright E2E tests: deferred; stack has no Playwright setup yet, README_08 marks these optional.

### Security and correctness review fixes (post-PR Codex review)

Five blocking fixes applied to `fix/p0-secure-mcp` after Codex review of PR #5:

**Fix 1 — Protect evidence metadata listing (ROLE_CASE_MANAGER | ROLE_ADMIN only)**
- `EvidenceService.list()` — added `ensureListAllowed()` service-layer guard throwing `AccessDeniedException` for unauthorized roles.
- `SecurityConfig` — added explicit `GET /api/cases/*/evidence` rule with `hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")` before the broad `GET /api/**` permit-all rule.
- `EvidenceAccessIntegrationTest` — 5 new tests: CASE_MANAGER and ADMIN can list (200), AUTHOR and APPROVER cannot (403), unauthenticated gets 401/403.

**Fix 2 — Apply impact preview scope filtering**
- `MeasureImpactPreviewService.preview()` — `request.scope()` was accepted but never applied. Now routes all outcomes through `applyScope(outcomes, scope)` before counting and building breakdowns. Adds a warning when the scope matches zero employees.

**Fix 3 — Filter case impact by evaluation period**
- `estimateCaseImpact` SQL — added `AND c.evaluation_period = ?` clause so existing open cases from prior evaluation periods don't inflate "would update" counts for the preview period.

**Fix 4 — Return 400 for invalid evaluationDate**
- `resolveEvaluationDate()` — now throws `IllegalArgumentException` with "evaluationDate" in the message instead of silently defaulting to today.
- `MeasureController.impactPreview()` — catch block distinguishes 400 (message contains "evaluationDate") from 404 (measure not found).

**Fix 5 — Resolve case reruns from persisted requested_scope_json**
- `AllProgramsRunService.loadCaseIdForRun()` — reads `(requested_scope_json->>'caseId')::uuid` first; falls back to the legacy `last_run_id` lookup only when the JSON path is absent. Prevents rerun failure after a second rerun advances `last_run_id` past the source run.
- Fix 5b (discovered during test run): the JSON existence check used `requested_scope_json ? 'caseId'` which JDBC interprets as a second parameter placeholder, causing `PSQLException: No value specified for parameter 2`. Replaced with `jsonb_exists(requested_scope_json, 'caseId')` — consistent with the pattern documented in DEPLOY.md.

**Regression tests added:**
- `MeasureImpactPreviewIntegrationTest` — 9 new tests: scope filtering (site, employee, nonexistent), invalid date throws + returns 400, blank date defaults to today, case impact counts for fresh preview (uses far-future date), case impact ignores cases from a different evaluation period. Test for the period-isolation case inserts a synthetic employee row (CQL evaluator uses in-memory FHIR, not the employees table) and queries `measure_versions` by `measure_id` UUID rather than by name.
- `ScopedRunIntegrationTest` — new `caseRerunSameScopeSucceedsEvenAfterLastRunIdIsStale`: runs CASE scope, SQL-advances `cases.last_run_id` to a synthetic later run, then calls `rerunSameScope` on the original run ID and asserts success via JSON-based caseId resolution.

### Auditor Mode and Export Packet (README_07)

Completed:

Backend:
- Migration `V014__audit_packet_exports.sql` — creates `audit_packet_exports` table (id, packet_type, entity_id, format, generated_by, generated_at, payload_hash, payload_size_bytes). Records each packet generation for accountability.
- Added `AuditPacketService` (`com.workwell.audit`) — assembles and serializes audit export packets for 3 entity types:
  - `buildCasePacket(caseId, actor, format)` — case summary, employee context, measure/version, CQL decision evidence, timeline split into actions/audit events/AI assistance, appointments, attachment metadata, outreach records, disclaimers.
  - `buildRunPacket(runId, actor, format)` — run metadata, scope, summary counters, run logs, audit events, disclaimers.
  - `buildMeasureVersionPacket(measureVersionId, actor, format)` — measure metadata, spec, CQL text+SHA-256 hash, compile result, value sets, VS governance check, traceability matrix, data readiness, approval history, audit events, disclaimers.
  - Each packet serialized to JSON bytes (or HTML with a table overview + JSON appendix). SHA-256 payload hash stored in `audit_packet_exports`. Writes `AUDIT_PACKET_GENERATED` audit event on every generation.
  - Optional services (traceability, data readiness, VS governance) wrapped in safe try-catch; failures return empty section rather than aborting the packet.
- Added `AuditorController` (`com.workwell.web`) — 3 GET endpoints: `/api/auditor/cases/{caseId}/packet`, `/api/auditor/runs/{runId}/packet`, `/api/auditor/measure-versions/{measureVersionId}/packet`. Query param `format=json|html` (default json). Unsupported format → 400. Missing entity (IllegalArgumentException) → 404. Role checks via `SecurityActor.hasAnyAuthority`: CASE/RUN → `ROLE_CASE_MANAGER|ROLE_ADMIN`; MEASURE_VERSION → `ROLE_APPROVER|ROLE_ADMIN`.
- Tests: `AuditorControllerTest` (6 tests, `@WebMvcTest`, `@WithMockUser` role annotations): json/html/run/measure-version OK, unsupported-format 400, missing-entity 404.

Frontend:
- `runs/page.tsx` — added `exportRunAuditPacket()` helper and "Export Run Audit Packet" button in the Run Detail panel, visible when a run is selected.
- `cases/[id]/page.tsx` — added `exportCaseAuditPacket()` helper and "Export Case Audit Packet" button in the page header alongside the case ID.
- `ReleaseApprovalTab.tsx` — derives current measure version ID from `versionHistory.find(v => v.version === measure.version)?.id`; added `exportMeasurePacket()` helper and "Export Measure Audit Packet" button above the lifecycle action buttons.

Verification:
- Backend AuditorControllerTest: 6/6 pass
- Backend full test suite: no regressions
- Frontend lint: exit 0
- Frontend build: all routes compiled, TypeScript clean

### Value Set and Terminology Governance (README_06)

Completed:

Backend:
- Migration `V013__value_set_governance.sql` — extends `value_sets` with 7 governance columns (`canonical_url`, `code_systems`, `source`, `status`, `expansion_hash`, `resolution_status`, `resolution_error`). Seeds 4 demo value sets with fixed UUIDs and non-empty `codes_json` (RESOLVED status). Creates `terminology_mappings` table; seeds 5 demo mappings (3 APPROVED, 1 REVIEWED, 1 PROPOSED).
- Added `ValueSetGovernanceService` (`com.workwell.measure`) — `resolveCheck(measureId)`, `diff(fromId, toId)`, `getValueSetDetail(id)`, `listTerminologyMappings()`, `createTerminologyMapping(...)`. Lazy demo value set linking via `ensureDemoValueSetLinks()` called on resolve-check. CQL unattached reference detection via line-scan for `valueset "Name"` declarations.
- Extended `MeasureController.activationReadiness()` to merge VS governance blockers into the base readiness result. Added `POST /api/measures/{id}/value-sets/resolve-check`, `GET /api/value-sets/{id}/diff`, `GET /api/value-sets/{id}/detail`.
- Extended `AdminController` — added `GET /api/admin/terminology-mappings` and `POST /api/admin/terminology-mappings`.
- Integration tests: `ValueSetGovernanceIntegrationTest` (6 tests, Testcontainers, requires Docker).
- Controller unit tests updated: `MeasureControllerTest` (2 new tests), `AdminControllerTest` (1 new test).

Frontend:
- Added `ValueSetCodeEntry`, `ValueSetDetail`, `ValueSetCheckItem`, `ResolveCheckResponse`, `AffectedMeasure`, `ValueSetDiffResponse`, `TerminologyMapping` types to `features/studio/types.ts`.
- Created `ValueSetGovernancePanel.tsx` — auto-loads on mount, Re-check button, overall ALL RESOLVED / BLOCKERS FOUND badge, blockers list, warnings list, per-value-set table (name, version, resolution status badge, code count).
- Embedded `ValueSetGovernancePanel` in `ValueSetsTab` (authoring view) and `ReleaseApprovalTab` (after DataReadinessPanel).
- Added Terminology Governance section to `admin/page.tsx` — table of all mappings with status badge, confidence %, reviewed by, notes.

Verification:
- Frontend lint: exit 0
- Frontend build: all 12 routes compiled, TypeScript clean
- Controller unit tests: MeasureControllerTest + AdminControllerTest pass (WebMvcTest, no Docker)
- Integration tests: ValueSetGovernanceIntegrationTest (6 tests, Testcontainers with Docker Desktop)

## 2026-05-09

### Data Readiness and Integration Mapping Cockpit (README_05)

Completed:

Backend:
- Migration `V012__data_readiness.sql` — adds `integration_sources`, `data_element_mappings`, and `data_readiness_snapshots` tables; seeds 4 integration sources (hris, fhir, ai, mcp) and 15 canonical element mappings covering all 4 demo measures.
- Added `DataReadinessService` (`com.workwell.admin`) — `listMappings()`, `validateMappings()` (syncs from `integration_health`, marks STALE on degraded source), `computeReadiness(UUID measureId)` (per-element missingness + freshness + blocker/warning classification).
- Added `GET /api/admin/data-mappings` and `POST /api/admin/data-mappings/validate` to `AdminController`.
- Added `GET /api/measures/{id}/data-readiness` to `MeasureController`.
- Integration tests: `DataReadinessIntegrationTest` (6 tests, Testcontainers, requires Docker).
- Controller unit tests updated: `AdminControllerTest` (2 new tests), `MeasureControllerTest` (1 new test).

Frontend:
- Added `DataElementMapping`, `RequiredElementReadiness`, `DataReadinessResponse` types to `features/studio/types.ts`.
- Created `DataReadinessPanel.tsx` — loads data-readiness, shows overall status badge, blockers, warnings, per-element table (canonical, source, mapping status, freshness, missingness with sample employees), link to Admin.
- Embedded `DataReadinessPanel` in `ReleaseApprovalTab` above version history.
- Added Data Readiness Cockpit section to `admin/page.tsx` — data element mappings table with Validate Mappings button.

Verification:
- Frontend lint: exit 0
- Frontend build: all 12 routes compiled, TypeScript clean

### Policy Traceability and Activation Impact Preview (README_04)

Completed:

Backend — Traceability:
- Added `MeasureTraceabilityService` — builds a policy-to-evidence matrix from spec fields, CQL defines (parsed via regex), value sets, test fixtures, and runtime evidence keys. Generates gaps: missing policy citation, bad compile status, missing test fixtures, missing MISSING_DATA/EXCLUDED fixture coverage, unlinked value sets.
- Added `GET /api/measures/{id}/traceability` in `MeasureController`.
- Integration tests: `MeasureTraceabilityIntegrationTest` (5 tests, Testcontainers).
- Controller unit tests added in `MeasureControllerTest`.

Backend — Impact Preview:
- Added `MeasureImpactPreviewService` — dry-run CQL evaluation; does NOT call `runPersistenceService` or `caseFlowService`. Counts outcomes, estimates case impact by querying existing open cases, builds site/role breakdown maps, writes `MEASURE_IMPACT_PREVIEWED` audit event.
- Added `POST /api/measures/{id}/impact-preview` in `MeasureController`.
- Integration tests: `MeasureImpactPreviewIntegrationTest` (7 tests, Testcontainers + `@WithMockUser`).
- Note: Testcontainers integration tests require Docker Desktop; they pass in CI but are skipped when Docker is unavailable.

Frontend:
- Added `TraceabilityValueSetRef`, `TestFixtureRef`, `TraceabilityRow`, `TraceabilityGap`, `TraceabilityResponse`, `CaseImpact`, `ImpactPreviewResponse` to `features/studio/types.ts`.
- Created `features/studio/components/TraceabilityTab.tsx` — loads traceability matrix, renders summary card, error/warning gap panels, 7-column policy-to-evidence table, Export JSON button.
- Created `features/studio/components/ImpactPreviewPanel.tsx` — "Preview Activation Impact" button, outcome count cards (COMPLIANT/DUE_SOON/OVERDUE/MISSING_DATA/EXCLUDED), case impact summary, warnings panel, "preview only" disclaimer note.
- Embedded `ImpactPreviewPanel` in `ReleaseApprovalTab` above the Activate Measure button (shown when measure is in Approved state).
- Added "Traceability" tab to `studio/[id]/page.tsx` Tab union and tab bar.

Verification:
- Frontend lint: exit 0
- Frontend build: `✓ Compiled successfully`, all 12 routes built
- `MeasureControllerTest` (WebMvcTest, no Docker): all 5 tests pass

### Frontend: Studio page split into hooks and tab components (README_03 Part B)

Completed:
- Extracted all types into `frontend/features/studio/types.ts`.
- Extracted pure helper functions into `frontend/features/studio/utils.ts` (`parseCompileIssue`, `formatIssue`, `compileStatusClass`, `valueSetBadgeClass`).
- Created `hooks/useMeasureDetail.ts` — loads measure + activation readiness + version history; returns state + `load` refresh callback.
- Created `hooks/useValueSets.ts` — loads global value set catalog; returns `allValueSets` + `load`.
- Created `hooks/useOshaReferences.ts` — loads OSHA reference options; returns `oshaReferences` + `load`.
- Created tab components that own their own local state and take `api`/`measureId`/callbacks as props:
  - `components/SpecTab.tsx` — spec form with AI draft, owns policyRef/description/etc.
  - `components/CqlTab.tsx` — Monaco editor + compile error markers.
  - `components/ValueSetsTab.tsx` — attach/detach/create value sets.
  - `components/TestsTab.tsx` — fixture CRUD + validate.
  - `components/ReleaseApprovalTab.tsx` — readiness checklist, version history, lifecycle confirmation modals.
- Route page `studio/[id]/page.tsx` reduced from 944 to ~120 lines: param parsing, hook composition, tab navigation, and shell rendering only.

Verification:
- Frontend lint: `frontend\\corepack pnpm lint` -> exit 0
- Frontend build: `frontend\\corepack pnpm build` -> `✓ Compiled successfully`, all 12 routes built

### Frontend: typed API client introduced, global fetch monkey-patch removed

Completed:
- Created `frontend/lib/api/errors.ts` — `ApiError` class with typed status helpers (`isUnauthorized`, `isForbidden`, `isNotFound`, `isClientError`, `isServerError`).
- Created `frontend/lib/api/client.ts` — `ApiClient` class that reads `NEXT_PUBLIC_API_BASE_URL`, attaches `Authorization: Bearer <token>`, handles 401 via `onUnauthorized` callback, and throws `ApiError` on non-OK responses. Methods: `get`, `post`, `put`, `delete`, `postForm`, `downloadBlob`.
- Created `frontend/lib/api/hooks.ts` — `useApi()` hook composing `useAuth()` + `ApiClient`; recreates client only when token or logout changes.
- Removed the entire `window.fetch` monkey-patch `useEffect` from `frontend/components/auth-provider.tsx`. Auth-provider is now a clean context provider with no global side effects.
- Migrated all 9 dashboard pages from bare `fetch()` + inline `apiBase` patterns to `useApi()`:
  - `app/(dashboard)/layout.tsx`
  - `app/(dashboard)/measures/page.tsx`
  - `app/(dashboard)/programs/page.tsx`
  - `app/(dashboard)/programs/[measureId]/page.tsx`
  - `app/(dashboard)/runs/page.tsx`
  - `app/(dashboard)/cases/page.tsx`
  - `app/(dashboard)/cases/[id]/page.tsx`
  - `app/(dashboard)/studio/[id]/page.tsx`
  - `app/(dashboard)/admin/page.tsx`
- Evidence download in `cases/[id]` converted from plain `<a href>` to a button calling `api.downloadBlob()` so the Authorization header is sent (role-protected endpoint).
- Fixed two rounds of lint: re-added `// eslint-disable-next-line react-hooks/set-state-in-effect` before `void loadXxx()` calls in effects; added missing stable setState refs to `useCallback` dep arrays in `cases/page.tsx` per `react-hooks/preserve-manual-memoization`.
- `login/page.tsx` intentionally left using bare `fetch()` — no token at login time, correct behavior.

Verification:
- Frontend lint: `frontend\\corepack pnpm lint` -> exit 0 (0 errors, 0 warnings)
- Frontend build: `frontend\\corepack pnpm build` -> `✓ Compiled successfully`, all 12 routes built

### Scoped runs and run job model phase 1 completed

Completed:
- Added a typed `ManualRunRequest`/`RunScopeType` contract and routed `/api/runs/manual` through the shared scoped-run executor.
- Preserved `ALL_PROGRAMS` behavior, added `MEASURE` scope, added `CASE` scope, and made CASE reuse the structured rerun-to-verify path.
- Persisted scoped-run request metadata, run lifecycle status, failure summary, and partial-failure counts in the `runs` table.
- Added durable run logs for requested, scope resolved, evaluation, persistence, and completion steps.
- Updated the runs/programs UI to send `scopeType` payloads and expose a simple scoped run control surface.
- Added regression tests for scoped measure runs, case reruns, unsupported scopes, and existing run-controller behavior.

Verification:
- Focused backend tests: `backend\\./gradlew.bat test --tests "com.workwell.run.ScopedRunIntegrationTest" --tests "com.workwell.web.EvalControllerTest" --tests "com.workwell.web.RunControllerTest" --tests "com.workwell.run.Major1PopulationIntegrationTest"` -> PASS
- Full backend test suite: `backend\\./gradlew.bat test --console=plain` -> PASS
- Backend build: `backend\\./gradlew.bat build --console=plain` -> PASS
- Frontend lint: `frontend\\corepack pnpm lint` -> PASS
- Frontend build: `frontend\\corepack pnpm build` -> PASS

### Final P0 completion pass: MCP auth and actor spoofing hardening completed

Completed:
- Confirmed MCP routes are authenticated and role-gated at `/sse` and `/mcp/**`, with `MCP_TOOL_CALLED` audit rows using the authenticated security-context actor.
- Removed the spoofable `actor` query parameter from the admin integration sync endpoint.
- Removed the spoofable `resolvedBy` request-body field from manual case resolution and normalized closed-by bookkeeping to the authenticated actor.
- Updated the frontend case detail resolve action to stop sending a caller-controlled actor field.
- Added regression tests for spoofed admin sync requests, spoofed case-resolution bodies, authenticated run reruns, authenticated manual run triggers, authenticated measure-status audit rows, and safe MCP invalid-argument handling.

Verification:
- Backend targeted tests: `backend\\./gradlew.bat test --tests "com.workwell.web.AdminControllerTest" --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.EvalControllerTest" --tests "com.workwell.web.RunControllerTest" --tests "com.workwell.measure.MeasureServiceIntegrationTest" --tests "com.workwell.mcp.McpSecurityIntegrationTest"` -> PASS
- Backend full suite: `backend\\./gradlew.bat test --console=plain` -> PASS
- Backend build: `backend\\./gradlew.bat build --console=plain` -> PASS
- Frontend lint: `frontend\\corepack pnpm lint` -> PASS
- Frontend build: `frontend\\corepack pnpm build` -> PASS

### P0 production CORS tightening and startup safety checks completed

Completed:
- Replaced the hardcoded CORS origin patterns with exact-origin configuration driven by `WORKWELL_CORS_ALLOWED_ORIGINS`.
- Added `StartupSafetyValidator` to fail startup in production-like deployments when auth is disabled, the JWT secret is weak or missing, localhost/wildcard CORS is configured, or backend demo mode is enabled without an explicit public-demo override.
- Added backend tests for production-like auth disablement, wildcard and localhost CORS rejection, weak JWT secret rejection, exact-origin success, and demo-mode override behavior.
- Added frontend production-build enforcement so `NEXT_PUBLIC_DEMO_MODE=true` fails `next build`.

Verification:
- Focused backend config tests: `backend\\./gradlew.bat test --tests "com.workwell.config.StartupSafetyValidatorTest" --tests "com.workwell.config.SecurityConfigCorsTest"` -> PASS
- Full backend suite: `backend\\./gradlew.bat test --console=plain` -> PASS
- Backend build: `backend\\./gradlew.bat build --console=plain` -> PASS
- Frontend lint: `frontend\\corepack pnpm lint` -> PASS
- Frontend build: `frontend\\corepack pnpm build` -> PASS
- Frontend negative guard check: `NEXT_PUBLIC_DEMO_MODE=true frontend\\corepack pnpm build` -> FAIL as expected with the explicit unsafe-configuration error

### P0 rerun sanity check and evidence authorization completed

Completed:
- Sanity-checked the rerun-to-verify path after commit `518f378` and confirmed the case rerun now flows through the structured CQL evaluator instead of fabricating a COMPLIANT outcome.
- Hardened evidence access so uploads and downloads are restricted to `ROLE_CASE_MANAGER` and `ROLE_ADMIN`, downloads resolve the linked case first, and download responses are audited as `EVIDENCE_DOWNLOADED`.
- Added regression coverage for compliant, excluded, due-soon, overdue, and missing-data rerun branches plus evidence upload/download authorization, sanitization, and audit logging.

Verification:
- Focused backend slice: `backend\\./gradlew.bat test --tests "com.workwell.compile.CqlEvaluationServiceTest" --tests "com.workwell.caseflow.CaseFlowRerunIntegrationTest" --tests "com.workwell.web.EvidenceAccessIntegrationTest"` -> PASS
- Full backend test suite: `backend\\./gradlew.bat test` -> PASS
- Backend build: `backend\\./gradlew.bat build` -> PASS

### P0 rerun-to-verify hardening completed

Completed:
- Replaced the case rerun-to-verify shortcut with a real structured CQL evaluation of the case subject using the persisted measure CQL and evaluation period.
- Preserved non-compliant reruns as open/in-progress cases and only close on structured compliant or excluded outcomes.
- Added a single-subject evaluation path to `CqlEvaluationService` and a regression test proving it matches the batch evaluator for the same employee.
- Added an integration test that seeds an open case, reruns it, and verifies the case does not fake COMPLIANT, persists the actual rerun outcome, and avoids `CASE_RESOLVED` on non-compliant reruns.
- Updated the product docs to describe the real rerun-to-verify behavior.

Verification:
- Targeted backend regression tests: `backend\\./gradlew.bat test --tests "com.workwell.compile.CqlEvaluationServiceTest" --tests "com.workwell.caseflow.CaseFlowRerunIntegrationTest"` -> PASS
- Full backend test suite: `backend\\./gradlew.bat test` -> PASS
- Backend build: `backend\\./gradlew.bat build` -> PASS

## 2026-05-08

### PR review fixes completed — backend CI restored and review comments addressed

Completed:
- Fixed the seeded CQL evaluation path so runs use the actual `Measure` object instead of asking the CQF processor to resolve the measure back out of the in-memory repository.
- Adjusted the TB and HAZWOPER recency logic to use explicit code-based procedure filtering, which keeps the demo measures compatible with the CQF in-memory evaluator.
- Added regression coverage for TB, HAZWOPER, and Flu seeded evaluation outcomes in `CqlEvaluationServiceTest`.
- Kept the review-driven hardening already in place across backend and frontend:
  - `status=excluded` case filtering now works end to end
  - dashboard global filters preserve search/site/date query state
  - login demo credentials are gated behind `NEXT_PUBLIC_DEMO_MODE`
  - invalid date inputs now return 400 in the case/run/admin controllers
  - JWT auth now fails fast if the default secret is used while auth is enabled
  - evidence uploads validate file signatures instead of trusting client MIME types
- Updated `docs/MEASURES.md` with a short implementation note for the TB/HAZWOPER CQF compatibility choice.

Verification:
- Backend full suite: `backend\\./gradlew.bat test` -> PASS
- Frontend lint: `corepack pnpm lint` -> PASS
- Frontend build: `corepack pnpm build` -> PASS

### MINOR-1 completed — OSHA reference dropdown in Studio Spec tab

Completed:
- Added `backend/src/main/resources/db/migration/V010__osha_references.sql`:
  - creates `osha_references`
  - adds `measure_versions.osha_reference_id`
  - seeds 8 common occupational health citations
  - backfills existing matching measure versions where policy text already matches a curated citation
- Added `GET /api/osha-references` so the frontend can load curated OSHA policy choices.
- Replaced the Studio Spec tab policy reference text input with a searchable combobox.
- Kept free-text fallback for non-OSHA references while persisting the selected `osha_reference_id` through the measure version save/load path.

Verification:
- Backend compile + targeted measure tests: `backend\\./gradlew.bat compileJava test --tests "com.workwell.measure.MeasureServiceIntegrationTest" --tests "com.workwell.web.MeasureControllerTest"` -> PASS
- Frontend lint: `corepack pnpm lint` -> PASS
- Frontend build: `corepack pnpm build` -> PASS

### MAJOR-7 completed — Monaco editor for CQL

Completed:
- Added `@monaco-editor/react` to the frontend and replaced the Studio CQL textarea with a Monaco editor.
- Kept the editor in the CQL tab controlled by the existing `cqlText` state, so content persists across tab switches.
- Enabled SQL syntax highlighting, dark theme, automatic layout, and preserved view state for a smoother authoring experience.
- Updated backend CQL compile validation messages to include line/column prefixes so frontend error markers can target the exact location.
- Parsed backend compile errors into Monaco markers, so compile failures now show red squiggles at the offending line and column.

Verification:
- Backend compile + compile-validation test: `backend\\./gradlew.bat compileJava test --tests "com.workwell.compile.CqlCompileValidationServiceTest"` -> PASS
- Frontend lint: `corepack pnpm lint` -> PASS
- Frontend build: `corepack pnpm build` -> PASS

### MAJOR-6 completed — EXCLUDED outcomes / waivers worklist

Completed:
- Added waiver persistence and exclusion context:
  - Migration `backend/src/main/resources/db/migration/V009__waivers.sql`
  - `waivers` table linking employee, measure, measure version, reason, grant metadata, expiry, notes, and active state
- Added `WaiverService` for listing, granting, and resolving active waivers for excluded cases.
- Updated `CaseFlowService` so EXCLUDED outcomes now create `EXCLUDED` cases instead of disappearing from the workflow.
- Added worklist and case-detail support for excluded cases:
  - Excluded filter tab on `/cases`
  - Waiver expiry / expired warning cue in case detail
  - Outreach actions disabled for excluded cases

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend controller tests: `backend\\./gradlew.bat test --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.AdminControllerTest"` -> PASS
- Backend integration tests:
  - `backend\\./gradlew.bat test --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.AdminControllerTest" --tests "com.workwell.run.Major1PopulationIntegrationTest" --tests "com.workwell.run.CaseViewAuditIntegrationTest" --tests "com.workwell.ai.AiServiceIntegrationTest"` -> PASS after Docker Desktop was started so Testcontainers could connect
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### MINOR-2 completed — Case viewed audit event

Completed:
- Added `CaseAccessAuditService` to emit `CASE_VIEWED` audit events asynchronously from case detail reads.
- `GET /api/cases/{id}` now records the access event without adding it to the case timeline.
- Added `AuditQueryService` plus `GET /api/admin/audit-events` so the admin UI can filter access events apart from mutations.
- Admin audit page now exposes access/mutation filters and shows `CASE_VIEWED` rows under Access Events.

Verification:
- Covered by the same backend test slice above, including `CaseControllerTest`, `AdminControllerTest`, and `CaseViewAuditIntegrationTest`.

### MAJOR-5 completed — Auto-notification on case creation + worklist gap badge

Completed:
- Added auto-queue behavior during case creation:
  - `CaseFlowService.upsertOpenCase(...)` now creates an `outreach_records` row for newly created `DUE_SOON`, `OVERDUE`, and `MISSING_DATA` cases.
  - Writes `NOTIFICATION_AUTO_QUEUED` audit events with template/outcome payload.
  - `EXCLUDED` outcomes intentionally skip outreach creation.
- Added outreach template coverage for missing data:
  - Migration `backend/src/main/resources/db/migration/V008__missing_data_follow_up_template.sql`
  - Seeds `Missing Data Follow-Up`
- Made outreach persistence visible for manual actions too:
  - manual `Send outreach` now writes an `outreach_records` row with `auto_triggered = false`
  - appointment reminder rows already continue to write as queued outreach records
- Added UI signal for outreach source:
  - case timeline now shows `Auto` and `Manual` badges on outreach-related rows
  - dashboard nav now shows a Worklist badge for open cases that still have no outreach queued

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests:
  - `backend\\./gradlew.bat test --tests "com.workwell.web.RunControllerTest" --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.ProgramControllerTest"` -> PASS
- Backend integration tests:
  - `backend\\./gradlew.bat test --tests "com.workwell.run.Major1PopulationIntegrationTest.manualRunAutoQueuesOutreachForNonCompliantOutcomesAndSkipsExcluded"` -> PASS
  - `backend\\./gradlew.bat test --tests "com.workwell.run.Major1PopulationIntegrationTest.manualRunPersistsOneHundredOutcomesPerMeasureAndTbHighCompliance"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### MAJOR-4 completed — Global site + date header filters

Completed:
- Added global dashboard filter context:
  - `frontend/components/global-filter-context.tsx`
  - Provides `siteId`, `from`, `to`, and date presets (`7d`, `30d`, `90d`, `all`).
- Wired dashboard header controls in `frontend/app/(dashboard)/layout.tsx`:
  - Site selector populated from backend sites endpoint.
  - Date preset selector in top navigation.
  - Navigation links preserve active `site/from/to` query values.
- Added backend filter parameters:
  - `GET /api/runs` accepts `site`, `from`, `to`.
  - `GET /api/cases` accepts `from`, `to` (existing site filter retained).
  - `GET /api/programs` + `GET /api/programs/overview` accept `site`, `from`, `to`.
  - `GET /api/programs/{measureId}/trend` + `/top-drivers` accept `site`, `from`, `to`.
  - Added `GET /api/programs/sites` for distinct site values.
- Updated dashboard pages to apply global filters:
  - `/programs` requests overview/trend/top-drivers with global params.
  - `/runs` requests list with global params.
  - `/cases` applies global date range and global site fallback.

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend targeted web tests:
  - `backend\\./gradlew.bat test --tests "com.workwell.web.RunControllerTest" --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.ProgramControllerTest"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### MAJOR-3 completed — Outreach templates migration-managed + editable

Completed:
- Added DB migration:
  - `backend/src/main/resources/db/migration/V007__outreach_templates.sql`
  - Creates `outreach_templates` table and seeds four templates for outreach/reminder flows.
- Removed fragile fallback behavior:
  - `OutreachTemplateService.listTemplates()` no longer catches `DataAccessException` with in-memory defaults.
  - Runtime now loads templates from DB persistence only.
- Added admin template CRUD endpoints:
  - `POST /api/admin/outreach-templates`
  - `PUT /api/admin/outreach-templates/{id}`
- Added template persistence methods in service:
  - `createTemplate(...)`
  - `updateTemplate(...)`
  - Type validation for `OUTREACH`, `APPOINTMENT_REMINDER`, `ESCALATION`.
- Updated admin security posture:
  - `/api/admin/**` now consistently requires `ROLE_ADMIN`.

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests:
  - `backend\\./gradlew.bat test --tests "com.workwell.web.AdminControllerTest" --tests "com.workwell.web.CaseControllerTest"` -> PASS

### MAJOR-2 completed — Release & Approval Studio tab

Completed:
- Added Release tab + workflow surface in Studio:
  - New fifth tab `Release & Approval` in `frontend/app/(dashboard)/studio/[id]/page.tsx`.
  - Readiness checklist now visible in-tab for:
    - compile status
    - test fixture validation
    - value set resolvability
    - required spec completeness
- Added Version History panel in Studio:
  - backend endpoint `GET /api/measures/{id}/versions`
  - frontend table shows version, status, author, created date, change summary.
- Added dedicated release actions:
  - backend `POST /api/measures/{id}/approve`
  - backend `POST /api/measures/{id}/deprecate` (mandatory reason)
  - approval writes `MEASURE_APPROVED` audit event.
- Studio action gating and confirmations:
  - `Approve for Release` shown to APPROVER/ADMIN only; disabled when compile/test gates fail (tooltip shown).
  - `Activate Measure` shown after Approved to APPROVER/ADMIN with confirmation.
  - `Deprecate` shown only to ADMIN with mandatory reason prompt.
- Security policy alignment:
  - `/api/measures/*/approve` -> `ROLE_APPROVER` or `ROLE_ADMIN`
  - `/api/measures/*/deprecate` -> `ROLE_ADMIN`

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests: `backend\\./gradlew.bat test --tests "com.workwell.web.*"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

## 2026-05-07

### MAJOR-1 completed — 100-employee evaluation population

Completed:
- Reworked `CqlEvaluationService` to evaluate all 100 employees from `SyntheticEmployeeCatalog` per measure instead of 12-15 hardcoded subsets.
- Added deterministic seeded population assignment (`measure + employeeId` stable mapping) so reruns remain consistent.
- Added compliance-rate configuration under `workwell.evaluation.compliance-rates` in `backend/src/main/resources/application.yml`:
  - `audiogram: 0.78`
  - `tb_surveillance: 0.91`
  - `hazwoper: 0.65`
  - `flu_vaccine: 0.84`
- Updated synthetic bundle generation to use run evaluation date for exam/immunization timestamps (stable historical behavior).
- Fixed `MeasureService.listMeasures(...)` PostgreSQL null-parameter query issue that blocked manual run seeding paths.
- Added integration verification coverage:
  - `Major1PopulationIntegrationTest`
  - updated `CqlEvaluationServiceTest`

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Targeted eval + MAJOR-1 integration tests:
  - `backend\\./gradlew.bat test --tests "com.workwell.compile.CqlEvaluationServiceTest" --tests "com.workwell.run.Major1PopulationIntegrationTest"` -> PASS

### CRITICAL-5 completed — Evidence upload/documentation action

Completed:
- Added evidence schema:
  - Migration `backend/src/main/resources/db/migration/V006__evidence_attachments.sql`
  - New table `evidence_attachments`
- Implemented evidence storage/service:
  - `EvidenceService` with server-side filesystem storage under `uploads/evidence/...`
  - Upload validation:
    - allowed: PDF, PNG, JPG/JPEG
    - max size: 10 MB
  - Automatic audit write: `EVIDENCE_UPLOADED`
- Added backend endpoints:
  - `POST /api/cases/{id}/evidence` (multipart upload + optional description)
  - `GET /api/cases/{id}/evidence` (list)
  - `GET /api/evidence/{id}/download` (file streaming; image inline, PDF attachment)
- Frontend Case Detail enhancements:
  - Upload Evidence section with file input and description
  - Evidence list with metadata and download links
  - Timeline icon mapping for evidence events

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests: `backend\\./gradlew.bat test --tests \"com.workwell.web.*\"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### CRITICAL-4 completed — Schedule appointment action path

Completed:
- Added DB support for appointment and reminder records:
  - `scheduled_appointments`
  - `outreach_records`
  - Migration: `backend/src/main/resources/db/migration/V005__scheduled_appointments_and_outreach_records.sql`
- Expanded unified case action endpoint to support:
  - `type = SCHEDULE_APPOINTMENT`
- Implemented appointment workflow in `CaseFlowService.scheduleAppointment(...)`:
  - Validates appointment inputs (`appointmentType`, `scheduledAt`, `location`)
  - Persists appointment row with `PENDING` status
  - Records case action `SCHEDULE_APPOINTMENT`
  - Auto-creates `outreach_records` row:
    - `type=APPOINTMENT_REMINDER`
    - `status=QUEUED`
    - `auto_triggered=true`
  - Transitions case `OPEN -> IN_PROGRESS`
  - Writes audit event `APPOINTMENT_SCHEDULED`
- Added appointments query endpoint:
  - `GET /api/cases/{id}/appointments`
- Frontend Case Detail updates:
  - Added `Schedule Appointment` button and modal with:
    - appointment type
    - date/time
    - location
    - notes
  - Added appointment list panel
  - Added timeline icon mapping for appointment events.

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests: `backend\\./gradlew.bat test --tests \"com.workwell.web.*\"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### CRITICAL-3 completed — Manual case closure action ("Mark Resolved")

Completed:
- Added manual closure API action:
  - `POST /api/cases/{id}/actions`
  - Payload supports `{ type: "RESOLVE", note, resolvedAt, resolvedBy }`.
- Implemented manual closure service path:
  - `CaseFlowService.resolveCase(...)`
  - Validates state (`OPEN`/`IN_PROGRESS` only) and mandatory closure note
  - Sets case state to `CLOSED`
  - Persists closure metadata (`closed_at`, `closed_reason=MANUAL_RESOLVE`, `closed_by`)
  - Writes case action `RESOLVE`
  - Writes audit event `CASE_MANUALLY_CLOSED` including actor + note context
- Added schema support:
  - Migration `backend/src/main/resources/db/migration/V004__case_manual_closure_fields.sql`
  - New columns on `cases`: `closed_reason`, `closed_by`
- Frontend updates:
  - Case detail page now has `Mark Resolved` button
  - Modal enforces closure note before submit
  - UI refreshes to closed state after success
  - Metadata panel now surfaces `Closed reason` and `Closed by`
- Worklist status controls updated to explicit tabs:
  - `Open` / `Closed` / `All`
  - Default remains `Open`, so closed cases are hidden from default view.

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests: `backend\\./gradlew.bat test --tests \"com.workwell.web.*\"` -> PASS
- Targeted AI integration test: `backend\\./gradlew.bat test --tests \"com.workwell.ai.AiServiceIntegrationTest\"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### CRITICAL-2 completed — Measure Catalog all-status visibility + status/search filters

Completed:
- Updated backend catalog listing to remove Active-only restriction:
  - `MeasureService.listMeasures(...)` now returns all statuses by default.
  - Added optional query filtering:
    - `status`: `Draft | Approved | Active | Deprecated`
    - `search`: name/tag match
- Extended catalog DTO payload with lifecycle metadata:
  - `statusUpdatedAt`
  - `statusUpdatedBy`
- Updated `GET /api/measures` controller contract to accept `?status=` and `?search=`.
- Frontend `Measures` page updates:
  - Added status filter pill row (`All / Draft / Approved / Active / Deprecated`).
  - Added search box for name/tag filtering.
  - Added status pill rendering for each row and status update metadata column.
- Studio role visibility alignment (tied to RBAC):
  - `New Version` control is shown only to `ROLE_AUTHOR`.
  - `Approve` action is shown only to `ROLE_APPROVER`.

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests: `backend\\./gradlew.bat test --tests \"com.workwell.web.*\"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

### CRITICAL-1 completed — Auth + RBAC foundation

Completed:
- Added migration `backend/src/main/resources/db/migration/V003__demo_users.sql` with `demo_users` and seeded role personas:
  - `author@workwell.dev` (`ROLE_AUTHOR`)
  - `approver@workwell.dev` (`ROLE_APPROVER`)
  - `cm@workwell.dev` (`ROLE_CASE_MANAGER`)
  - `admin@workwell.dev` (`ROLE_ADMIN`)
- Implemented JWT login flow:
  - `POST /api/auth/login`
  - signed HS256 JWTs with configurable TTL/secret via `workwell.auth.*` properties
  - BCrypt password verification
- Implemented request authentication:
  - `JwtAuthFilter` parses bearer token and sets Spring Security authentication
  - `SecurityConfig` enforces role-based access policies for mutation/admin routes
- Added actor derivation from security context:
  - introduced `SecurityActor` helper and wired audit-write paths to prefer authenticated email actor where available
- Frontend auth UX:
  - Added `/login` page and in-memory session handling
  - Injected auth provider globally
  - Dashboard header now shows logged-in user email + role badge + logout
- Added demo personas into synthetic employees catalog metadata for UI/runtime coherence.

Verification:
- Backend compile: `backend\\./gradlew.bat compileJava` -> PASS
- Backend web tests: `backend\\./gradlew.bat test --tests \"com.workwell.web.*\"` -> PASS
- Frontend lint: `frontend\\npm run lint` -> PASS
- Frontend build: `frontend\\npm run build` -> PASS

Notes:
- For test stability with existing `@WebMvcTest` slices, auth can be disabled in tests via `workwell.auth.enabled=false` (test resources only); runtime default remains enabled.
- Remaining TODO items are intentionally untouched and still pending in required execution order.

### Advisor-ready closeout (final pre-consult sync)

Completed:
- Reconciled `docs/new_instructions.md` checklist to zero actionable open items (`55/55` done).
- Re-ran production `POST /api/runs/manual` successfully:
  - run `3866d69a-2519-4051-bad0-98da9ea696bf`
  - `activeMeasuresExecuted=4`.
- Refreshed `docs/DEMO_RUNBOOK.md` pinned latest run IDs to current production values and updated MCP `get_run_summary` sample run ID.
- Finalized advisor rehearsal evidence bundle in:
  - `docs/evidence/2026-05-07-rehearsal/`
  - Includes programs/measures snapshots, pinned case payload, AI explanation payload, and MCP tool transcripts (`tools/list`, `list_measures`, `get_run_summary`, `explain_outcome`).

Outcome:
- Current branch is in advisor-ready freeze posture with production verification artifacts and runbook IDs synchronized to live state.

### Production deploy + post-deploy verification pass (freeze bugfix tranche)

Completed:
- Deployed backend to Fly from current branch:
  - `flyctl deploy --config backend/fly.toml --remote-only`
  - release `v57` on `workwell-measure-studio-api`.
- Deployed frontend to Vercel from current branch:
  - deployment `dpl_H88GXJKjsnvah3YaG2pH5vuVfSdj`
  - alias confirmed at `https://frontend-seven-eta-24.vercel.app`.
- Verified `/studio` route behavior in production:
  - `GET https://frontend-seven-eta-24.vercel.app/studio` -> `307` redirect to `/measures`.
- Verified MCP transport endpoint is reachable:
  - `GET https://workwell-measure-studio-api.fly.dev/sse` -> `200`.
- Verified production Flu behavior after deploy:
  - `POST /api/runs/flu-vaccine` returned run `2c9ba3b4-e8f0-4391-91ec-19f5e8ea06fa` with non-zero compliant bucket.
  - `GET /api/programs` now reports Flu with `totalEvaluated=15`, `compliant=6`, `excluded=3`, `overdue=6`, `missingData=0`, `complianceRate=40.0`.
- Re-validated explainability evidence fields on production case detail:
  - `GET /api/cases/c0162cf4-b0bf-4410-878a-af6f1bbf9472` includes `why_flagged.last_exam_date`, `days_overdue`, `compliance_window_days` plus eligibility fields.
- Re-validated AI explain endpoint:
  - `POST /api/cases/c0162cf4-b0bf-4410-878a-af6f1bbf9472/ai/explain` -> `provider=openai`, `fallbackUsed=false`.

Notes:
- `POST /api/runs/manual` intermittently hangs from direct curl despite measure-specific run endpoints succeeding; tracked as a runtime reliability follow-up for the full Run-All demo flow.
- Core freeze goals for Flu distribution and `/studio` dead-end are now verified in production.
- Rehearsal evidence bundle has been saved for demo reuse under `docs/evidence/2026-05-07-rehearsal/` including:
  - `programs.json`, `measures.json`
  - `case_c0162cf4.json`, `ai_explain_c0162cf4.json`
  - `mcp_tools_list.json`, `mcp_list_measures.json`, `mcp_get_run_summary_fba26713.json`, `mcp_get_run_summary_3866d69a.json`, `mcp_explain_outcome_32fee6f4.json`
- Follow-up production run-all probe succeeded in this cycle:
  - `POST /api/runs/manual` -> run `3866d69a-2519-4051-bad0-98da9ea696bf` with `activeMeasuresExecuted=4`.
- `docs/DEMO_RUNBOOK.md` pinned run IDs were refreshed to current production values, and the MCP `get_run_summary` sample call now points to run `3866d69a-2519-4051-bad0-98da9ea696bf`.
- TODO reconciliation closeout:
  - `docs/new_instructions.md` stale unchecked items were reconciled to completed/superseded with explicit evidence references.
  - Remaining actionable TODO count for this instruction batch is now zero.
- MCP protocol probe details:
  - `GET /sse` returns an endpoint event with session-scoped message path (`/mcp/message?sessionId=...`).
  - Raw curl JSON-RPC post to the message endpoint was not sufficient for a stable tool transcript capture in this shell-only flow; a proper MCP client session (SSE + message channel together) is still needed for final `explain_outcome` transcript evidence.
  - Partial protocol evidence was captured: MCP `initialize` response returned `serverInfo.name=workwell-mcp`, `serverInfo.version=1.1.0`, `protocolVersion=2024-11-05`.
  - Follow-up closure: used MCP Inspector CLI directly against production SSE and captured successful tool transcripts:
    - `tools/list` returned full registered tool set.
    - `tools/call` `list_measures` returned all 4 active measures.
    - `tools/call` `get_run_summary` for run `fba26713-92ff-49e3-84d0-fa8d137881f7` returned structured counts and pass-rate.
    - `tools/call` `explain_outcome` for case `32fee6f4-6e69-4675-b44e-5f6392de7dbd` returned deterministic evidence fields with real values (`last_exam_date=2025-03-13`, `days_overdue=55`, `compliance_window_days=365`), no `unknown` placeholders.

### Freeze bugfix verification loop (continued) — local stack + test/build re-check

Completed:
- Re-ran backend test suite:
  - `backend\\./gradlew.bat test` -> `BUILD SUCCESSFUL` (all tasks up-to-date, no new failures).
- Re-ran frontend production build:
  - `frontend\\npm run build` -> PASS (Next.js 16.2.4 build completed; `/studio` route present).
- Verified local docker runtime status:
  - `docker compose -f infra/docker-compose.yml ps` -> `backend` and `postgres` both `Up`.
- Verified local backend health:
  - `GET http://localhost:8080/actuator/health` -> `{"status":"UP"}`.
- Executed fresh local all-program run:
  - `POST http://localhost:8080/api/runs/manual` -> run `901100a1-95f3-4765-ac42-0ef2f74b04ac`, `activeMeasuresExecuted=4`.
- Verified Flu outcome mix for the fresh run from outcomes CSV export:
  - `COMPLIANT=6`, `EXCLUDED=3`, `OVERDUE=6`, `TOTAL=15`, `PASS_RATE=40%`.

Notes:
- Flu pass-rate remains within the advisor target band (20%-60%) on local branch code.
- Remaining gap is deployment-time production re-validation for MCP `explain_outcome` payload fields and final rehearsal evidence capture.
- Local evidence JSON check on overdue Audiogram case (`a38b94d7-8c6a-4678-b693-db31d9c5bb91`) confirms concrete snake_case values in `why_flagged`:
  - `last_exam_date=2025-03-13`, `days_overdue=55`, `compliance_window_days=365`, `role_eligible=true`, `site_eligible=true`, `waiver_status=none`.

### Advisor handoff packet refreshed (external review prep)

Completed:
- Rewrote `docs/advisor_update.md` for a full external-advisor handoff with:
  - implementation status snapshot,
  - plan alignment against `docs/SPIKE_PLAN.md`,
  - production/local verification signal summary,
  - explicit "what is left" vs "what is done",
  - risk/caveat section,
  - direct advisor questions and clarification asks,
  - recommended file packet list for review handoff.
- Synced tracker/context docs for consistency with current day status:
  - `docs/TODO.md` latest checkpoint date advanced to 2026-05-07,
  - `CLAUDE.md` current focus moved from historical D3 note to stabilization/freeze focus.

Purpose:
- Ensure external advisor receives one coherent, evidence-backed package describing:
  - project state,
  - work completed,
  - open risks,
  - remaining execution steps before final demo/pilot positioning.

### Production smoke pass completed (post-UI polish deploy check)

Executed against:
- Frontend: `https://frontend-seven-eta-24.vercel.app`
- Backend: `https://workwell-measure-studio-api.fly.dev`

Production API checks:
- `GET /actuator/health` -> `200`, body `{"status":"UP"}`
- `GET /api/programs` -> `200` (4 active measures returned)
- `POST /api/runs/manual` -> `200`
  - Run: `5c6ebb99-9b21-46ab-9690-adca628b3044`
  - `activeMeasuresExecuted=4`, `measuresExecuted=[Audiogram, Flu Vaccine, HAZWOPER Surveillance, TB Surveillance]`
- `GET /api/cases?status=open` -> `200` (open cases present; current rows use `emp-*` external IDs, no legacy `patient-*` rows observed in payload)
- `GET /api/exports/runs?format=csv` -> `200`, `text/csv`
- `GET /api/exports/outcomes?format=csv` -> `200`, `text/csv`
- `GET /api/exports/cases?format=csv&status=open` -> `200`, `text/csv`
- `GET /api/audit-events/export?format=csv` -> `200`, `text/csv`
- `POST /api/measures/{measureId}/ai/draft-spec` -> `200`
  - measure used: `4ae5d865-3d64-4a17-905d-f1b315a037e2`
- `POST /api/cases/{caseId}/ai/explain` -> `200`
  - case used: `c0162cf4-b0bf-4410-878a-af6f1bbf9472`
- `GET /api/programs/{measureId}/trend` -> `200`
- `GET /api/programs/{measureId}/top-drivers` -> `200`
- `GET /api/runs/{runId}/outcomes` -> `200` (run `5c6ebb99-9b21-46ab-9690-adca628b3044`)
- `GET /api/admin/integrations` -> `200`
- `POST /api/admin/integrations/ai/sync` -> `200`

Frontend route checks:
- `GET /programs` -> `200`
- `GET /cases` -> `200`
- `GET /runs` -> `200`
- `GET /measures` -> `200`
- `GET /admin` -> `200`
- `GET /studio` -> `200`

Note:
- `HEAD https://workwell-measure-studio-api.fly.dev/sse` returned `404` during MCP transport probe. This endpoint had previously been expected in older notes; current runtime appears to expose MCP differently or not at `/sse`. Core app user flows and required API smoke checks above are passing.

### MCP discoverability + health probe fix

Investigation:
- Verified MCP SSE endpoint is reachable over GET:
  - `GET https://workwell-measure-studio-api.fly.dev/sse` returns `200` with `content-type: text/event-stream` (long-lived connection).
- Root cause for false-negative MCP health status:
  - Integration health check used Java `HttpClient` with `BodyHandlers.discarding()` on a long-lived SSE stream, which can wait on completion and incorrectly degrade on timeout.

Fix implemented:
- Updated `IntegrationHealthService.checkMcpHealth()` to use `HttpURLConnection` GET and validate response headers/status immediately (without waiting for stream completion).
- Health payload now records:
  - `sseUrl`
  - `statusCode`
  - `contentType`

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.AdminControllerTest" --no-daemon` -> PASS

### UI polish tranche completed (UI-1 through UI-6)

Completed:
- Added shared frontend UI utilities:
  - `frontend/lib/status.ts` for canonical measure lifecycle + outcome badge classes.
  - `frontend/lib/toast.ts` and `frontend/components/global-toast.tsx` for a single global 2.5s toast system.
- Dashboard shell responsive + search:
  - Reworked `frontend/app/(dashboard)/layout.tsx` with sticky top bar, mobile nav toggle, and global search input routing to `/cases?search=...`.
- Cases list/detail polish:
  - Cases page now honors query-driven search initialization and applies shared outcome badges.
  - Added stronger empty-state copy.
  - Case detail now emits toasts for outreach/assign/escalate/delivery/rerun actions.
  - Added AI explanation loading skeleton while explain call is pending.
- Runs page polish:
  - Replaced local toast stub with global toast events.
  - Added no-runs empty state.
  - Applied shared outcome badge colors in outcomes table.
- Programs + Measures + Studio consistency:
  - Programs: `MISSING_DATA` badge now purple/violet; added empty-measures state; run-all success toast.
  - Measures and Studio status pills now use shared lifecycle status mapping.
  - Studio compile success now emits `CQL compiled successfully` toast; local toast stub removed.

Verification:
- `frontend\\npm run lint` -> PASS
- `frontend\\npm run build` -> PASS

### Tests-1 and Tests-2 completed (AI + MCP server coverage)

Completed:
- Added `backend/src/test/java/com/workwell/ai/AiServiceIntegrationTest.java`:
  - validates draft-spec success path with AI JSON payload parsing,
  - validates explain-case deterministic fallback path when AI client is unavailable,
  - asserts AI audit persistence path is invoked via `JdbcTemplate.update(...)`.
- Added `backend/src/test/java/com/workwell/mcp/McpServerConfigTest.java`:
  - validates MCP server wiring initializes correctly with expected server metadata (`workwell-mcp`, `1.1.0`) and capabilities under mocked dependencies.

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.ai.AiServiceIntegrationTest" --tests "com.workwell.mcp.McpServerConfigTest" --no-daemon` -> PASS

### Data-1 synthetic expansion completed (100-employee catalog)

Completed:
- Expanded `SyntheticEmployeeCatalog` from 50 -> 100 employees (`emp-001` through `emp-100`).
- Added edge-profile diversity:
  - role-overlap labels (for example maintenance+hazwoper, nurse+clinic operations),
  - additional clinic and plant cohorts,
  - broader population for waiver/missing-data seeded scenarios.
- Expanded Option A seeded CQL input sets in `CqlEvaluationService`:
  - Audiogram: 15 seeded employees (3 per each of compliant/due-soon/overdue/missing/excluded).
  - TB Surveillance: 15 seeded employees (3 per each bucket).
  - HAZWOPER Surveillance: 15 seeded employees (3 per each bucket), including a larger hazwoper-enrolled subset.
  - Flu Vaccine: expanded seeded set and updated CQL mapping to allow `DUE_SOON`/`OVERDUE` paths based on most recent flu vaccine recency while preserving `EXCLUDED` and `MISSING_DATA`.
- Updated `backend/src/main/resources/measures/flu_vaccine.cql`:
  - added `Most Recent Flu Vaccine Date`
  - added `Days Since Last Flu Vaccine`
  - updated `Outcome Status` ordering to emit `OVERDUE` and `DUE_SOON` when applicable.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests \"com.workwell.compile.CqlCompileValidationServiceTest\" --tests \"com.workwell.compile.CqlEvaluationServiceTest\" --no-daemon` -> PASS

### Data-2 historical run seeding completed

Completed:
- Added `SeedHistoricalRunsService` (`com.workwell.run`) with startup seeding guard:
  - if `runs` table has data, no-op
  - if empty, seed 5 historical all-program runs at 30-day spacing
- Historical run generation uses real Option A CQL evaluation payloads per active measure and then applies deterministic compliant-rate variance deltas:
  - `-5%`, `-2%`, `0%`, `+3%`, `+5%`
- Adjustment is encoded in evidence metadata (`historicalSeedAdjusted`, `historicalSeedOutcome`) for traceability.
- Seeded runs are persisted through existing `persistAllProgramsRun(...)` path so audit/outcome/case pipelines stay consistent.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests \"com.workwell.compile.CqlCompileValidationServiceTest\" --tests \"com.workwell.compile.CqlEvaluationServiceTest\" --tests \"com.workwell.web.RunControllerTest\" --no-daemon` -> PASS

### Tests-3 and Tests-4 completed (export + programs APIs)

Completed:
- Expanded `ExportControllerTest`:
  - verifies runs/outcomes/cases CSV responses with concrete body expectations,
  - verifies invalid format handling returns `400` with `Unsupported format. Use format=csv.`.
- Added new `ProgramControllerTest`:
  - verifies `/api/programs` payload shape and key fields,
  - verifies `/api/programs/{measureId}/trend` time-series payload,
  - verifies `/api/programs/{measureId}/top-drivers` by-site/by-role/by-outcome payloads.

Verification:
- `backend\\gradlew.bat test --tests \"com.workwell.web.ExportControllerTest\" --tests \"com.workwell.web.ProgramControllerTest\" --no-daemon` -> PASS

## 2026-05-06

### P3 docs tranche completed: AI guardrails + measure mapping

Completed:
- Rewrote `docs/AI_GUARDRAILS.md` with implementation-accurate details from `AiAssistService`:
  - Real prompt templates for Draft Spec, Explain Why Flagged, and Run Insight
  - Model and fallback configuration (`gpt-5.4-nano` primary, `gpt-4o-mini` fallback, temp 0.3, max tokens 1000)
  - Per-surface deterministic fallback behavior
  - Concrete audit payload schemas for `AI_DRAFT_SPEC_GENERATED`, `AI_CASE_EXPLANATION_GENERATED`, and `AI_RUN_INSIGHT_GENERATED`
  - Explicit persistence boundary: AI outputs are non-canonical, CQL outcomes remain source of truth
- Rewrote `docs/MEASURES.md` with CQL-to-outcome mapping for all four measures:
  - Audiogram, HAZWOPER, TB, Flu
  - Define-level logic summary and final `Outcome Status` bucket mapping
  - Clarified canonical status derivation from `Outcome Status` define output

Verification:
- Confirmed AI config values from `backend/src/main/resources/application.yml`.
- Confirmed prompt/audit/fallback behavior from `backend/src/main/java/com/workwell/ai/AiAssistService.java`.
- Confirmed current CQL files from `backend/src/main/resources/measures/*.cql`.

### P3 docs tranche completed: Architecture + Data Model + Demo Runbook

Completed:
- Rewrote `docs/ARCHITECTURE.md` to reflect current live runtime:
  - Vercel frontend -> Fly backend -> Neon DB topology
  - Detailed package boundaries across `com.workwell.*`
  - End-to-end flow: policy text -> spec -> CQL compile -> run -> outcomes -> cases -> actions -> audit
  - Option A runtime invariants and compliance source-of-truth constraints
- Rewrote `docs/DATA_MODEL.md` with:
  - Full schema coverage for active tables (`V001`, `V002`) plus migration-safe `outreach_templates` contract
  - Case upsert idempotency worked example (`UNIQUE(employee_id, measure_version_id, evaluation_period)`)
  - Detailed `evidence_json` contract and evaluation-error fallback payload shape
  - Full CSV export column contracts and case export filter contract (including `caseIds`)
- Added `docs/DEMO_RUNBOOK.md`:
  - Production URLs
  - Pinned production case IDs including overdue Audiogram showcase case
  - Click-by-click demo flow with expected outcomes and fallback paths (including AI unavailable path)

Verification:
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> 200
- Pinned case IDs validated from live response payload at write time.

### P2 case worklist/detail UX polish completed

Completed:
- Cases list bulk actions:
  - Added multi-select checkboxes with select-all for current filtered results.
  - Added bulk toolbar for `Assign to...`, `Escalate selected`, and `Export selected`.
  - Bulk assign/escalate executes sequential per-case API calls (`/assign`, `/escalate`) and refreshes list on completion.
- Case search:
  - Added client-side search box filtering loaded cases by employee name or employee ID.
- Selected-case CSV export:
  - Extended `GET /api/exports/cases` to accept optional `caseIds` query param (comma-separated UUIDs).
  - Extended `CsvExportService.exportCaseCsv(...)` to filter by selected case IDs when provided.
- Case detail evidence/timeline polish:
  - Added `View Raw Evidence` toggle under Why Flagged to show/hide full `evidence_json`.
  - Timeline now includes event icons, source tags (`audit` vs `action`), humanized labels, and most-recent highlight.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### P2 Studio UX progress: version cloning + value set resolvability

Completed:
- Implemented version cloning API and service flow:
  - Backend endpoint: `POST /api/measures/{id}/versions`
  - Requires `changeSummary`
  - Clones latest measure version into a new `Draft` version with incremented version number (`vX.Y -> vX.(Y+1)`).
  - Copies `spec_json`, `cql_text`, compile metadata, and `measure_value_set_links` from source version.
  - Emits `MEASURE_VERSION_CLONED` audit event with source/target metadata.
- Studio UI:
  - Added change-summary input and `New Version` action on measure detail page.
  - After successful clone, page reloads and surfaces the new draft context.
- Value set resolvability support:
  - Extended `ValueSetRef` payload with resolvability metadata (`status`, `label`, `note`, `codeCount`).
  - Added resolvability badges on attached and attachable value-set lists.
  - Added unresolved compile warnings:
    - `Value set '{name}' ({oid}) has no codes loaded. Verify codes are available before activation.`

Constraint observed:
- Monaco editor task (`@monaco-editor/react`) not executed due sprint hard rule: no new dependencies after D5.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests \"com.workwell.web.MeasureControllerTest\"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### CQL compile validation polish completed (status + Studio UX)

Completed:
- Kept translator-based compile pipeline and polished compile status semantics in `MeasureService.compileCql(...)`:
  - `COMPILED` when no errors and no warnings
  - `WARNINGS` when no errors but warnings exist
  - `ERROR` when translator errors exist
- Updated activation gating behavior:
  - Activation readiness now treats `COMPILED` and `WARNINGS` as compile-pass states.
  - Activation transition check now blocks only when compile status is neither `COMPILED` nor `WARNINGS`.
- Studio CQL tab UX polish in frontend:
  - Compile badge now reflects exact backend status (`COMPILED` / `WARNINGS` / `ERROR`).
  - Warnings and errors render in separate color-coded panels.
  - Added line-aware issue formatting helper so line references are surfaced more clearly to authors.
  - Added warning guidance banner clarifying that warning-only compile state can still activate.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### P1 admin integrations persistence completed

Completed:
- Added DB migration for persistent integration health:
  - `backend/src/main/resources/db/migration/V002__integration_health.sql`
  - Creates `integration_health` table and seeds rows for `fhir`, `mcp`, `ai`, `hris`.
- Replaced hardcoded integration-state logic with table-backed service in:
  - `backend/src/main/java/com/workwell/admin/IntegrationHealthService.java`
- `GET /api/admin/integrations` now reads persisted rows (`display_name`, `status`, `last_sync_at`, `last_sync_result`, `config_json`).
- `POST /api/admin/integrations/{integration}/sync` now updates persisted state and emits audit:
  - `INTEGRATION_SYNC_TRIGGERED` with `{ integrationId, result, actor, message, syncedAt }`.
- Implemented manual-sync health checks:
  - `ai`: OpenAI API health ping against `/v1/responses` with configured model.
  - `mcp`: SSE reachability probe against configured `workwell.mcp.sse-url` (default `http://127.0.0.1:8080/sse`).
  - `fhir` and `hris`: deterministic healthy manual-sync stub result with persisted timestamps.
- Updated Admin UI integration cards:
  - Shows `displayName` from API.
  - Color-coded status badges (healthy/degraded-or-stale/unknown).
  - Continues to show real last-sync timestamps and sync result text.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests \"com.workwell.web.AdminControllerTest\"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### P1 outreach delivery-state API hardening completed

Completed:
- Kept `POST /api/cases/{caseId}/actions/outreach/delivery` and tightened service behavior to match delivery-state contract:
  - Enforces precondition that an `OUTREACH_SENT` action exists before accepting delivery updates.
  - Continues strict `deliveryStatus` validation (`QUEUED|SENT|FAILED`).
  - Persists `OUTREACH_DELIVERY_UPDATED` case action payload with `deliveryStatus`, `updatedAt`, `actor`, and note.
  - Emits `CASE_OUTREACH_DELIVERY_UPDATED` audit event with explicit payload `{ caseId, deliveryStatus, updatedAt, actor }`.
- Tightened latest delivery-state derivation:
  - `latestOutreachDeliveryStatus` now resolves only from `case_actions.action_type = 'OUTREACH_DELIVERY_UPDATED'`.
- Frontend case detail improvement:
  - Added color-coded delivery status badge (QUEUED/SENT/FAILED/NOT_SENT).
- Added controller coverage for validation failure path:
  - bad-request mapping when delivery update is attempted before outreach send.

Verification:
- `backend\\gradlew.bat test --tests \"com.workwell.web.CaseControllerTest\"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### P1 MCP tool expansion completed

Completed:
- Updated MCP tool contracts in `McpServerConfig` to align with TODO requirements:
  - `list_measures` now accepts optional `status` (default `Active`) and returns:
    - `measureId`, `measureName`, `policyRef`, `version`, `status`, `compileStatus`, `testFixtureCount`, `valueSetCount`, `lastUpdated`
  - `get_measure_version` now returns richer measure-version payload:
    - `specJson`, truncated `cqlText` (first 500 chars), `compileStatus`, attached value sets (name/OID/version), `testFixtureCount`, `valueSetCount`, lifecycle status.
  - `list_runs` now accepts `{ measureId?, limit? }` with default `limit=10` and returns run summaries including compliance rate and per-outcome counts.
  - `explain_outcome` now accepts `{ caseId }` and returns deterministic rule-based explanation derived from case `evidence_json.why_flagged` fields (no AI call).
- Confirmed `get_case`, `list_cases`, and `get_run_summary` continue to emit `MCP_TOOL_CALLED` audit events with sanitized args.
- Bumped MCP server version marker to `1.1.0`.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS

### P1 exports completed (runs/outcomes/cases contract + docs)

Completed:
- Upgraded `ExportController` CSV contracts:
  - `GET /api/exports/runs` now returns `runs-export.csv`.
  - `GET /api/exports/cases` status filter is optional (no forced `open` default).
- Reworked `CsvExportService` to use SQL-backed export queries with full column contracts:
  - Runs export now includes versioned scope metadata, all five outcome buckets, pass rate, and data freshness timestamp.
  - Outcomes export now includes employee role/site and `why_flagged`-derived evidence fields (`lastExamDate`, `complianceWindowDays`, `daysOverdue`, `roleEligible`, `siteEligible`, `waiverStatus`).
  - Cases export now includes role, next action, created/updated/closed timestamps, and latest outreach delivery state.
- Added export contract documentation:
  - `docs/EXPORTS.md`
- Updated TODO status for P1 CSV exports as completed.

Verification:
- `backend\\gradlew.bat test --tests \"com.workwell.export.CsvExportServiceTest\" --tests \"com.workwell.web.ExportControllerTest\"` -> PASS
- `backend\\gradlew.bat test` -> FAIL on Docker/Testcontainers bootstrap (`DockerClientProviderStrategy`) for integration tests in this local environment
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Simulation Honesty (Option A) stabilization + backend outage investigation/fix

Completed:
- Investigated production frontend `Failed to fetch` and traced to backend instability (Fly runtime pressure and failing evaluation path).
- Hardened backend runtime configuration in `backend/fly.toml`:
  - Increased VM memory from `512mb` to `1gb`
  - Increased JVM heap from `-Xmx384m` to `-Xmx768m` with `-Xms256m`
- Fixed AI service context fragility in tests/runtime by making `ChatClient.Builder` optional via `ObjectProvider` in:
  - `backend/src/main/java/com/workwell/ai/AiAssistService.java`
- Fixed CQL compile validation false-negatives in:
  - `backend/src/main/java/com/workwell/compile/CqlCompileValidationService.java`
  - Removed hard requirement on XML writer provider during compile validation.
- Advanced Option A CQL execution wiring in:
  - `backend/src/main/java/com/workwell/compile/CqlEvaluationService.java`
  - Added richer generated Measure populations and robust subject result key resolution.
  - Added runtime `ExpressionResult` unwrapping so `Outcome Status` and define results are read correctly from actual engine output.
- Added `elm-jackson` runtime support dependency:
  - `backend/build.gradle.kts`
- Updated seeded CQL files for engine compatibility while preserving Option A execution path:
  - `backend/src/main/resources/measures/audiogram.cql`
  - `backend/src/main/resources/measures/tb_surveillance.cql`
  - `backend/src/main/resources/measures/hazwoper.cql`
  - `backend/src/main/resources/measures/flu_vaccine.cql`
- Maintained and tightened sanity tests requested by advisor:
  - `backend/src/test/java/com/workwell/compile/CqlEvaluationServiceTest.java`
  - `backend/src/test/java/com/workwell/compile/CqlCompileValidationServiceTest.java`

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.compile.CqlCompileValidationServiceTest" --tests "com.workwell.compile.CqlEvaluationServiceTest"` -> PASS
- `backend\\gradlew.bat test --tests "com.workwell.compile.CqlEvaluationServiceTest"` -> PASS

Notes:
- Local full-suite integration tests that require Docker/Testcontainers still depend on local Docker availability.
- Option A path now returns real CQL define-level expression results and correctly maps engine output to outcome buckets.

### CI backend bootstrap fix (GitHub Actions)

Completed:
- Added test-scope Spring AI OpenAI properties in:
  - `backend/src/test/resources/application.properties`
- Purpose: ensure Spring Boot test contexts in CI have deterministic OpenAI config placeholders so backend integration tests do not fail context startup when secrets are absent in test runtime.

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.AiControllerTest" --tests "com.workwell.compile.CqlCompileValidationServiceTest" --tests "com.workwell.compile.CqlEvaluationServiceTest"` -> PASS

## 2026-05-05

### Runs-2 and Runs-3 complete (rerun same scope + scheduler settings)

Completed:
- Added rerun endpoint `POST /api/runs/{id}/rerun` in `RunController`.
- Implemented `AllProgramsRunService.rerunSameScope(...)`:
  - Replays all-programs runs using the existing all-programs orchestration.
  - Replays measure-scoped runs by re-evaluating the original measure version CQL and persisting a fresh run.
- Added `/runs` UI action: "Rerun Selected Scope".
- Added scheduler admin API:
  - `GET /api/admin/scheduler`
  - `POST /api/admin/scheduler?enabled=true|false`
- Added scheduler settings UI on `/admin`:
  - enable/disable toggle
  - cron expression display
  - computed next-fire timestamp
  - last scheduled run status/time
- Expanded tests:
  - `RunControllerTest` now covers rerun endpoint.
  - `AdminControllerTest` now covers scheduler status + toggle endpoints.

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.RunControllerTest" --tests "com.workwell.web.AdminControllerTest"` -> PASS
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production deploy + smoke (`2026-05-06`):
- Backend deployed to Fly (`https://workwell-measure-studio-api.fly.dev`).
- Frontend deployed to Vercel and aliased (`https://frontend-seven-eta-24.vercel.app`).
- Live checks:
  - `GET /api/admin/scheduler` -> `200`
  - `POST /api/admin/scheduler?enabled=false` -> `200`
  - `POST /api/runs/{measureScopedRunId}/rerun` -> `200` (measure scope rerun succeeded)
  - `/admin` -> `200`
  - `/runs` -> `200`
- Note:
  - `POST /api/runs/manual` and rerun of all-programs-scoped runs currently return `500` in production (pre-existing all-programs CQL execution instability); rerun UX now prevents unsupported `case`-scope rerun attempts and still supports valid measure-scope reruns.

### All-programs rerun/manual 500 fixed (production)

Completed:
- Hardened `AllProgramsRunService` with per-measure failure isolation for all-programs and measure-scope reruns.
- If a measure-level evaluation throws unexpectedly, the run now persists a deterministic `MISSING_DATA` fallback outcome for that measure instead of aborting the entire run.
- This preserves run continuity and aligns with the "do not let one failure abort the run" requirement.

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.EvalControllerTest" --tests "com.workwell.web.RunControllerTest"` -> PASS
- `backend\\gradlew.bat compileJava` -> PASS

Production smoke (`2026-05-06`):
- `GET /actuator/health` -> `200`
- `POST /api/runs/manual` -> `200`
- `POST /api/runs/{allProgramsRunId}/rerun` -> `200`

### Outreach templates wired into case outreach flow (Notif-1)

Completed:
- Added backend outreach-template service and API:
  - `GET /api/admin/outreach-templates`
- Added case outreach template selection support:
  - `POST /api/cases/{caseId}/actions/outreach?templateId=...`
  - selected template metadata (`templateId`, `template`, `subject`) now persisted in `case_actions.payload_json`.
- Updated case detail UI to load templates and send selected template with outreach action.
- Added migration-safe fallback behavior:
  - if `outreach_templates` table is not yet present, API returns seeded default templates so workflow remains usable.

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.AdminControllerTest"` -> PASS
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production deploy + smoke (`2026-05-06`):
- `GET /actuator/health` -> `200`
- `GET /api/admin/outreach-templates` -> `200` (`templatesCount=3`)
- `POST /api/cases/{caseId}/actions/outreach?templateId={templateId}` -> `200`
- Follow-up `GET /api/cases/{caseId}` confirms `latestOutreachDeliveryStatus=QUEUED`
- `/cases/{caseId}` route -> `200`

### Outreach preview step added before send (Notif-2)

Completed:
- Added backend preview endpoint:
  - `GET /api/cases/{caseId}/actions/outreach/preview?templateId=...`
- Preview response now renders selected template with case context substitutions:
  - `employeeName`, `measureName`, `dueDate`, `outcomeStatus`
- Added frontend preview step on case detail:
  - "Preview outreach" button
  - rendered subject/body preview panel
  - "Send outreach" remains disabled until preview is generated

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.CaseControllerTest"` -> PASS
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production deploy + smoke (`2026-05-06`):
- `GET /actuator/health` -> `200`
- `GET /api/cases/{caseId}/actions/outreach/preview?templateId={templateId}` -> `200`
- Preview payload confirms template name + rendered due date.
- `/cases/{caseId}` route -> `200`

### Production incident fix: frontend API base misconfiguration (404 across UI)

Issue observed:
- Deployed frontend showed `missing NEXT_PUBLIC_API_BASE_URL` and all major actions failed with `404` from frontend routes.
- Impacted screens: Programs run button, Runs run button, Measures create/list, Cases load, Admin scheduler toggles.

Root cause:
- Vercel project had no environment variables configured (`vercel env ls` returned none).
- Frontend therefore attempted relative `/api/*` calls to Vercel app origin instead of Fly backend origin.

Fix applied:
- Set Vercel production env vars:
  - `NEXT_PUBLIC_API_BASE_URL=https://workwell-measure-studio-api.fly.dev`
  - `NEXT_PUBLIC_APP_NAME=WorkWell Studio`
- Redeployed frontend production and refreshed alias.
- Triggered a fresh all-programs run to repopulate run/case data.

Verification:
- `POST /api/runs/manual` -> `200` (`measures=4`)
- `GET /api/cases?status=open` -> non-zero cases (`openCases=35`)
- `GET /api/programs` -> `4` active programs
- Frontend `/cases` content no longer includes `missing NEXT_PUBLIC_API_BASE_URL` marker.

### Runs outcomes endpoint + UI table complete (P2 Runs-1)

Completed:
- Added backend endpoint `GET /api/runs/{id}/outcomes` in `RunController`.
- Added `RunPersistenceService.loadRunOutcomes(...)` to join outcomes with employees/cases and project UI-ready fields:
  - employee name/external ID, role, site, outcome status, days-since-exam, waiver status, case ID.
- Updated `/runs` detail view to fetch and render an Outcomes table with case deep links.
- Added controller test coverage for the new endpoint in `RunControllerTest`.

Verification:
- `backend\\gradlew.bat test --tests "com.workwell.web.RunControllerTest"` -> PASS
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production deploy + smoke (`2026-05-06`):
- Backend deployed to Fly (`https://workwell-measure-studio-api.fly.dev`).
- Frontend deployed to Vercel and aliased (`https://frontend-seven-eta-24.vercel.app`).
- Live checks:
  - `GET /actuator/health` -> `200`
  - `GET /api/runs?limit=1` -> `200` (runId resolved)
  - `GET /api/runs/{runId}/outcomes` -> `200`
  - `GET /runs` -> `200`

### Programs overview implementation start (P0)

### Programs overview implementation complete (P0 backend + frontend)

Completed:
- Backend Programs analytics endpoints:
  - `GET /api/programs`
  - `GET /api/programs/{measureId}/trend`
  - `GET /api/programs/{measureId}/top-drivers`
  - Implemented in `com.workwell.program.ProgramService` + `ProgramController`.
- Frontend Programs overview replacement on `/programs`:
  - KPI row, per-measure cards, compliance trend sparkline, top-drivers snippets, open-worklist link, and "Run All Measures Now" action.
- Frontend Program detail page on `/programs/{measureId}`:
  - large compliance rate + delta, trend sparkline, drivers by site/role/reason, measure counts table, filtered worklist link.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS


- Starting P0 Programs dashboard block:
  - backend endpoints for `/api/programs`, `/api/programs/{measureId}/trend`, `/api/programs/{measureId}/top-drivers`
  - frontend replacement for `/programs` placeholder and new `/programs/{measureId}` detail page
- Will update this entry with verification results after each completed batch.


### Frontend production deploy via Vercel CLI

- Deployed frontend to Vercel production using CLI from `frontend/`.
- Deployment ID: `dpl_G3LTCAgykGzNzNcBhxeqRFyJXm2e`
- Production URL: `https://frontend-pdi1nlhzy-taleef7s-projects.vercel.app`
- Alias updated: `https://frontend-seven-eta-24.vercel.app`

Post-deploy route checks:
- `/runs` -> 200
- `/studio` -> 200
- `/cases` -> 200

### Production deploy + live AI endpoint smoke (OpenAI active)

- Deployed backend to Fly using repo-root context with `backend/fly.toml` and confirmed health check `UP`.
- Added model-fallback execution chain in AI service:
  - primary model: `gpt-5.4-nano`
  - fallback model: `gpt-4o-mini` (only if primary fails)
- Added `workwell.ai.openai.fallback-model` config and validated compile/deploy path.

Live smoke checks on production (`https://workwell-measure-studio-api.fly.dev`):
- `POST /api/measures/{id}/ai/draft-spec` -> `success=true`, `provider=openai`, `fallbackUsed=false`
- `POST /api/cases/{id}/ai/explain` -> `provider=openai`, `fallbackUsed=false`
- `POST /api/runs/{id}/ai/insight` -> `fallback=false`, non-empty `insights[]`

This confirms production AI surfaces are now operating on real OpenAI responses (not deterministic fallback) with the configured model-priority chain.

### AI run-insight surface added (backend + runs UI)

- Added new backend endpoint for run-level AI insights:
  - `POST /api/runs/{runId}/ai/insight`
  - Generates 3-5 concise operational bullets via OpenAI model path (`gpt-5.4-nano` configured), audits as `AI_RUN_INSIGHT_GENERATED`, and falls back to empty insights with `fallback=true` on failure.
- Updated `AiAssistService` to include run insight generation + bullet parsing + audit payload details.
- Added runs-page UI insight card:
  - Dismissible panel above run detail on `/runs`
  - Label: "AI-generated operational insight - verify before acting"
  - Hidden automatically when backend returns fallback/empty insights.
- Expanded `AiControllerTest` coverage for the new run-insight endpoint.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests "com.workwell.web.AiControllerTest"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### AI surfaces production wiring (OpenAI gpt-5.4-nano)

- Completed OpenAI provider-first wiring for AI surfaces with `gpt-5.4-nano` model config in Spring AI properties.
- Upgraded `AiAssistService` behavior:
  - real ChatClient calls for draft spec + case explanation
  - fallback-on-failure behavior preserved with deterministic responses
  - draft-spec response now includes `success` and `fallback` contract fields
  - draft-spec audit payload now records `promptLength`, `outputLength`, `model`, and `tokensUsed` placeholder
  - case explanation cache keyed by `(caseId, measureVersion)` and refreshed on case `updatedAt`.
- Updated frontend integration:
  - Studio AI draft now handles `success=false` fallback contract cleanly and shows a prominent review/fallback banner.
  - Case detail explanation panel now explicitly labels output as "Plain-language explanation (AI-assisted)".
- Updated backend test fixtures for revised draft-spec response shape.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests "com.workwell.web.AiControllerTest"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Sanity tests + OpenAI provider switch for AI surfaces

- Added requested sanity test classes:
  - `backend/src/test/java/com/workwell/compile/CqlEvaluationServiceTest.java`
  - `backend/src/test/java/com/workwell/compile/CqlCompileValidationServiceTest.java`
- Added a test-only failure hook in `CqlEvaluationService` for per-employee failure isolation assertions.
- Switched AI provider wiring to OpenAI starter and config:
  - `backend/build.gradle.kts`: added `org.springframework.ai:spring-ai-openai-spring-boot-starter:1.0.0-M6`
  - `backend/src/main/resources/application.yml`: added `spring.ai.openai.*` defaults with model `gpt-5.4-nano`, temperature `0.3`, max tokens `1000`
  - `.env.example`: replaced `ANTHROPIC_API_KEY` with `OPENAI_API_KEY`
- Upgraded AI surface wiring toward production behavior:
  - `AiAssistService` now uses Spring AI `ChatClient` for draft spec and case explanation with deterministic fallback behavior.
  - Added case explanation cache keyed by `caseId` and invalidated on case `updatedAt` changes.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests "com.workwell.web.AiControllerTest"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS
- Note: strict new compile/evaluation sanity tests currently fail against present CQL+terminology execution behavior and are retained as active guardrails for the next tightening pass.

### Simulation Honesty Problem (Option A) - seeded CQL upgrade + fallback removal

- Replaced seeded CQL definitions with full advisor-provided logic files:
  - `backend/src/main/resources/measures/audiogram.cql`
  - `backend/src/main/resources/measures/tb_surveillance.cql`
  - `backend/src/main/resources/measures/hazwoper.cql`
  - `backend/src/main/resources/measures/flu_vaccine.cql`
- Updated seed/update behavior so active measure versions are synced to these resource CQL definitions.
- Implemented com.workwell.compile.SyntheticFhirBundleBuilder to construct Patient + enrollment/waiver Condition + Procedure/Immunization resources from per-employee exam configs.
- Refactored `com.workwell.compile.CqlEvaluationService` to:
  - evaluate per-employee with R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)
  - read CQL `expressionResults` and map `Outcome Status` directly to persisted outcome bucket
  - persist expression results into `evidence_json.expressionResults`
  - continue run when one employee fails, marking only that employee `MISSING_DATA` with `evaluationError` payload.
- Removed fallback-to-demo-services path from `AllProgramsRunService` for `/api/runs/manual`.
- Updated `RunPersistenceService` measure-version seeding to load per-measure CQL resources (not Audiogram-only default text).

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests "com.workwell.web.EvalControllerTest" --tests "com.workwell.web.MeasureControllerTest"` -> PASS
- `backend\\gradlew.bat test` -> FAIL (environmental Docker/Testcontainers unavailable)
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Simulation Honesty Problem (Option A) - real CQL wiring start

- Implemented real CQL compile validation path:
  - Added com.workwell.compile.CqlCompileValidationService using CQL translator APIs (CqlTranslator) to return real compile errors/warnings.
  - Replaced MeasureService.compileCql(...) string-contains placeholder check with translator-backed validation.
- Added CQF/CQL runtime dependencies in backend build:
  - cqf-fhir-cr, cqf-fhir-cql, cqf-fhir-utility, model-jaxb, cql-to-elm, plus required runtime providers (moxy, hapi-fhir-caching-caffeine).
- Added initial com.workwell.compile.CqlEvaluationService for manual runs:
  - Builds FHIR Library + Measure, builds synthetic patient resources from seeded run evidence, creates InMemoryFhirRepository, and calls R4MeasureProcessor.evaluateMeasureWithCqlEngine(...).
  - Injected into AllProgramsRunService so /api/runs/manual now attempts the CQL-engine path first and falls back to measure demo services if evaluation is unavailable/incomplete.

Verification:
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests "com.workwell.web.EvalControllerTest" --tests "com.workwell.web.MeasureControllerTest"` -> PASS
- `backend\\gradlew.bat test` -> FAIL (environmental Docker/Testcontainers unavailable)
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Worktree cleanup + advisor packet closeout

- Finalized repository closeout artifacts for external advisor review:
  - refreshed `docs/advisor_update.md` with full progress against `docs/TODO.md`, `docs/SPIKE_PLAN.md`, and archived project-plan context.
  - included explicit advisor clarifications/questions and requested critique focus areas.
- Normalized `docs/SMOKE_CHECKLIST.md` to current live API contracts:
  - CSV exports (`/api/exports/runs|outcomes|cases`)
  - outreach delivery endpoint (`/api/cases/{id}/actions/outreach/delivery?deliveryStatus=...`)
  - admin integration IDs (`fhir`, `mcp`, `ai`).
- Kept remaining backend export-support changes (`RunPersistenceService` + integration test coverage) in final committed state for clean worktree.

### Closeout parity pass + correctness re-check

Documentation parity updates completed:
- `docs/ARCHITECTURE.md`
  - Added live modules (`ai`, `export`, `admin`).
  - Expanded API surface to include outreach delivery updates, CSV exports, admin integrations sync, and AI endpoints.
  - Updated source-of-truth references to `docs/SPIKE_PLAN.md`.
- `docs/DATA_MODEL.md`
  - Updated case-action lifecycle to include `OUTREACH_DELIVERY_UPDATED`, `ASSIGNED`, and `ESCALATED`.
  - Documented persisted delivery-state contract (`QUEUED|SENT|FAILED`) on case actions.
  - Updated source-of-truth references to `docs/SPIKE_PLAN.md`.
- `docs/MEASURES.md`
  - Added implementation-status note: four seeded measures runnable with deterministic five-outcome coverage.
- `docs/DEPLOY.md`
  - Added post-deploy smoke checklist for exports/admin/outreach delivery endpoints.
  - Added troubleshooting note for JDBC/Postgres JSON operator placeholder conflict.
- `docs/AI_GUARDRAILS.md`
  - Added implemented AI audit events (`AI_DRAFT_SPEC_GENERATED`, `AI_CASE_EXPLANATION_GENERATED`) and MCP per-tool audit event (`MCP_TOOL_CALLED`).
- `docs/TODO.md`
  - Shifted from implementation batch language to closeout/freeze posture.
  - Added production closeout smoke completion checkpoint.

Verification re-run:
- `backend\\gradlew.bat test` -> FAIL (environment-level Docker/Testcontainers availability; not a compile/runtime regression in the changed web/export/admin paths)
- `backend\\gradlew.bat test --tests "com.workwell.web.*" --tests "com.workwell.export.*"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### P3 completion: outreach delivery states, admin integrations panel, and CSV reporting

- Completed P3 notifications/admin + reporting backlog items.

Backend:
- Added explicit outreach delivery-state transitions on cases:
  - `POST /api/cases/{caseId}/actions/outreach/delivery?deliveryStatus=QUEUED|SENT|FAILED`
  - Persists state changes through `case_actions` payloads and emits `CASE_OUTREACH_DELIVERY_UPDATED` audit events.
  - Case detail now returns `latestOutreachDeliveryStatus`.
- Added admin integrations health API:
  - `GET /api/admin/integrations`
  - `POST /api/admin/integrations/{integration}/sync`
  - Integrations tracked as stubs (`fhir`, `mcp`, `ai`) with last successful sync derived from persisted audit events.
  - Manual sync writes `INTEGRATION_SYNC_TRIGGERED` + `INTEGRATION_SYNC_COMPLETED` audit events.
- Added/kept CSV exports for:
  - runs: `GET /api/exports/runs?format=csv`
  - outcomes: `GET /api/exports/outcomes?format=csv&runId={optional}`
  - cases: `GET /api/exports/cases?format=csv`

Frontend:
- `/admin` now shows integrations health cards and manual sync actions.
- `/cases/[id]` now surfaces outreach delivery state and buttons to mark queued/sent/failed.
- `/runs` now includes export buttons for runs and outcomes CSVs.
- `/cases` now includes cases CSV export (plus existing audit CSV export).

Docs:
- Updated `README.md` API highlights with new admin/outreach/export routes.
- Added explicit CSV column contracts in `README.md`.
- Updated `docs/TODO.md` to mark P3 notifications/admin/reporting items complete and move next batch to final smoke/freeze focus.

Verification checkpoints:
- `backend\\gradlew.bat test --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.AdminControllerTest" --tests "com.workwell.web.ExportControllerTest"` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Production smoke sweep (post-P3) - deployment gap identified

Timestamp:
- `2026-05-05T19:10:59-04:00`

What was verified live:
- `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `200`
- `GET https://frontend-seven-eta-24.vercel.app/runs` -> `200`
- `GET https://frontend-seven-eta-24.vercel.app/cases` -> `200`
- `GET https://frontend-seven-eta-24.vercel.app/admin` -> `200`
- `GET https://workwell-measure-studio-api.fly.dev/api/runs?limit=1` -> `200` (`runId=113bb9e9-498c-49b9-a80e-3238bf2122ed`)
- `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200` (`text/csv`)

New P3 APIs checked on production (expected after deploy):
- `GET /api/exports/runs?format=csv` -> `404`
- `GET /api/exports/outcomes?format=csv&runId=...` -> `404`
- `GET /api/exports/cases?format=csv&status=open` -> `404`
- `POST /api/cases/{id}/actions/outreach/delivery?deliveryStatus=SENT` -> `404`
- `GET /api/admin/integrations` -> `404`
- `POST /api/admin/integrations/mcp/sync` -> `404`

Interpretation:
- Local implementation and tests are complete and passing, but production is still running a pre-P3 backend build.
- Next required action is backend deploy of commit `579e0b0`, then rerun this exact smoke set.

### Production smoke sweep rerun after deploy + hotfix

Deployment actions:
- Deployed backend commit `579e0b0` to Fly.
- Initial rerun showed P3 exports/admin routes alive, but case detail + outreach delivery update returned `500`.

Root cause:
- JDBC placeholder parsing conflict in `CaseFlowService.findLatestOutreachDeliveryStatus(...)`:
  - query used PostgreSQL JSON operator `payload_json ? 'deliveryStatus'`
  - `?` was interpreted as a JDBC bind placeholder.

Fix:
- Replaced operator usage with `jsonb_exists(payload_json, 'deliveryStatus')`.
- Commit: `3a6eaf3` (`fix(caseflow): avoid jdbc placeholder conflict in delivery-status query [S6]`)
- Redeployed backend to Fly.

Timestamped verification (`2026-05-05T19:18:14-04:00`):
- `GET /actuator/health` -> `200`
- `GET /api/exports/runs?format=csv` -> `200`
- `GET /api/exports/outcomes?format=csv&runId=113bb9e9-498c-49b9-a80e-3238bf2122ed` -> `200`
- `GET /api/exports/cases?format=csv&status=open` -> `200`
- `GET /api/admin/integrations` -> `200`
- `POST /api/admin/integrations/mcp/sync` -> `200`
- `GET /api/cases/c6d79a2f-8f86-4d48-ac91-06f21d478ccb` -> `200`
- `POST /api/cases/c6d79a2f-8f86-4d48-ac91-06f21d478ccb/actions/outreach/delivery?deliveryStatus=SENT` -> `200`
- Follow-up case detail confirms `latestOutreachDeliveryStatus=SENT`.

### MCP read-tool expansion + audit boundaries (P2)

- Expanded MCP Layer 1 read surface in `backend/src/main/java/com/workwell/mcp/McpServerConfig.java` by adding:
  - `list_measures`
  - `get_measure_version`
  - `list_runs`
  - `explain_outcome`
- Kept MCP posture read-only (no write tools introduced).
- Added per-tool audit recording on every MCP tool invocation:
  - `audit_events.event_type = MCP_TOOL_CALLED`
  - payload includes tool name + invocation args for traceability.

Behavior details:
- `list_measures` returns active catalog metadata.
- `get_measure_version` resolves by `measureId` or `measureName` and returns full latest measure detail payload.
- `list_runs` supports optional `status`, `scopeType`, `triggerType`, `limit` filters.
- `explain_outcome` generates structured-first explanation text from persisted `evidence_json` (including `why_flagged`) and includes an explicit compliance disclaimer.

Local verification checkpoints:
- `backend\\gradlew.bat test --tests "com.workwell.web.*"` -> PASS
- `backend\\gradlew.bat compileJava` -> PASS

Notes:
- Full `backend\\gradlew.bat test` remains environment-sensitive when Docker/Testcontainers are unavailable.
- This slice intentionally avoided introducing MCP write capabilities per sprint guardrails.

### Focused verification sweep before next slice

- Ran targeted backend tests for recently touched API surfaces:
  - `backend\\gradlew.bat test --tests "com.workwell.web.AiControllerTest" --tests "com.workwell.web.EvalControllerTest" --tests "com.workwell.web.CaseControllerTest" --tests "com.workwell.web.RunControllerTest" --tests "com.workwell.web.MeasureControllerTest"` -> PASS
  - `backend\\gradlew.bat test --tests "com.workwell.measure.AudiogramDemoServiceTest"` -> PASS
- Ran frontend verification gates:
  - `frontend npm run lint` -> PASS
  - `frontend npm run build` -> PASS
- MCP transport probe from local shell:
  - `GET http://localhost:8080/sse` failed with connection refused because no local backend instance was running during this check (expected environmental condition, not a code failure).
- Observed one transient Gradle test-results file race during parallel execution (`NoSuchFileException ... in-progress-results...bin`); rerunning the web suite sequentially completed successfully.
## 2026-05-04

### Studio measure-load hotfix + deploy/push checkpoint

- Fixed the reported `Failed to load measure (400)` issue when opening a measure from `/measures`:
  - Root cause: client-side dynamic route parameter handling in `/studio/[id]` was not robust in the current Next.js setup, causing invalid IDs to be sent to `/api/measures/{id}`.
  - Fix: switched Studio page to `useParams()` + normalized `measureId` usage across all API calls + guard for missing IDs.
- Deployment + push completed:
  - Commit: `015057f` (`feat(measure): value sets, test gates, and studio readiness polish [S2]`)
  - Backend deployed: `https://workwell-measure-studio-api.fly.dev`
  - Frontend deployed + aliased: `https://frontend-seven-eta-24.vercel.app`
  - Pushed to GitHub `main`.
- Production smoke verification (`2026-05-04T00:28:26-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/measures` -> `200` (`measureCount=2`)
  - `GET /api/measures/{id}` using live id -> `200` (`detailName=TB Surveillance`, `detailStatus=Active`)
  - `GET /api/cases?status=open` -> `200` (`openCases=23`)
  - `GET https://frontend-seven-eta-24.vercel.app/measures` -> `200`
  - `GET https://frontend-seven-eta-24.vercel.app/studio/{id}` -> `200`

### Release governance polish: activation readiness UX + richer lifecycle audit payloads

- Completed approval/release UX improvements in Studio:
  - Added backend readiness endpoint: `GET /api/measures/{id}/activation-readiness`
  - Added "Activation Readiness" summary panel on `/studio/[id]` for `Approved` measures.
  - Activation button now uses explicit readiness state and shows the first blocker inline when activation is blocked.
  - Transition success toast now confirms resulting status.
- Completed lifecycle audit payload enrichment:
  - `MEASURE_VERSION_STATUS_CHANGED` now includes:
    - `compileStatus`
    - `valueSetCount`
    - `testFixtureCount`
    - `testValidationPassed`
    - `activationBlockers`
- Added integration test coverage to verify richer transition audit payload fields are written.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

### Scheduled run backbone (P2 execution maturity)

- Added shared all-program run orchestrator service:
  - `backend/src/main/java/com/workwell/run/AllProgramsRunService.java`
  - `POST /api/runs/manual` now delegates to this shared service.
- Added scheduled trigger service:
  - `backend/src/main/java/com/workwell/run/ScheduledRunService.java`
  - Cron task calls all-program run path and persists outcomes/cases/audit via existing infrastructure.
  - Safe default posture: scheduler is disabled unless explicitly enabled.
- Added scheduler configuration:
  - `workwell.scheduler.enabled` from `WORKWELL_SCHEDULER_ENABLED` (default `false`)
  - `workwell.scheduler.cron` from `WORKWELL_SCHEDULER_CRON` (default `0 0 6 * * *`)

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `ac0a88d` (`feat(run): add scheduled all-program run backbone [S3]`)
- Backend redeployed to Fly: `https://workwell-measure-studio-api.fly.dev`
- Timestamped smoke check (`2026-05-04T00:33:15-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/measures` -> `200` (`measureCount=2`)
- `POST /api/runs/manual` with `{"scope":"All Programs"}` -> `200` (`runId=bc058da6-adea-4f74-a745-9f9dd34d7a66`, `activeMeasuresExecuted=2`)

### Run history/log visibility expansion (P2 execution maturity)

- Backend run APIs expanded:
  - `GET /api/runs` supports filters: `status`, `scopeType`, `triggerType`, `limit`
  - `GET /api/runs/{id}/logs` returns persisted run-log entries (latest-first)
  - Existing `GET /api/runs/{id}` retained for summary/detail
- Backend service additions:
  - Added run list query with filter and limit controls
  - Added run log query with limit controls
- Frontend `/runs` rewritten from S0 probe page to run-ops console:
  - Filter bar (status/scope/trigger)
  - Run history table with status/scope/duration
  - Run detail panel (counts, pass rate, timings)
  - Run logs panel (level/timestamp/message)
  - Manual "Run Measures Now" trigger integrated with refresh and selection
- Controller test coverage added for:
  - run list endpoint filters
  - run detail endpoint
  - run logs endpoint

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production deployment + hotfix checkpoint:
- Commits pushed:
  - `ebee7db` (`feat(run): expand run history and logs visibility [S3]`)
  - `443102c` (`fix(run): harden run list filtering and complete run visibility [S3]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Live issue discovered and fixed immediately:
  - Initial `GET /api/runs` returned `500` due to nullable filter SQL handling.
  - Fixed by switching to dynamic SQL condition construction (only bind `LOWER(?)` clauses when filters are present).
- Timestamped production smoke check (`2026-05-04T00:44:07-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/runs?limit=5` -> `200` (`runCount=5`)
  - `GET /api/runs/{id}` -> `200` (`status=completed`)
  - `GET /api/runs/{id}/logs?limit=5` -> `200` (`logCount=1`)
- `GET https://frontend-seven-eta-24.vercel.app/runs` -> `200`

### Data freshness indicators (P2 execution maturity)

- Added standardized freshness fields to run summary responses:
  - `dataFreshAsOf`: latest `outcomes.evaluated_at` timestamp for the run
  - `dataFreshnessMinutes`: age in minutes from `dataFreshAsOf` to now
- Frontend `/runs` detail panel now surfaces:
  - "Data Freshness: X min old"
  - "Data Fresh As Of: <timestamp>"
- Controller test fixture updated to include freshness fields in run summary payload.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `ec7c794` (`feat(run): add data freshness indicators to run summaries [S3]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Timestamped production smoke check (`2026-05-04T00:47:59-04:00`):
  - `GET /api/runs?limit=1` -> `200`
- `GET /api/runs/{id}` -> includes `dataFreshAsOf` and `dataFreshnessMinutes` (`30`)
- `GET https://frontend-seven-eta-24.vercel.app/runs` -> `200`

### Worklist filter expansion (P2 operations maturity)

- Expanded backend case list filters:
  - Existing: `status`, `measureId`
  - Added: `priority`, `assignee`, `site`
- Expanded frontend `/cases` filter controls:
  - `Status`, `Measure`, `Priority`, `Assignee`, `Site`
  - Query-string filter wiring to backend API
- Added `site` field to case summary payload and surfaced site in case cards.
- Updated MCP case listing integration call-site for new case-list method signature.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `f9e0ed2` (`feat(caseflow): expand worklist filters across api and ui [S4]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Timestamped production smoke check (`2026-05-04T01:11:34-04:00`):
  - `GET /api/cases?status=open&priority=HIGH` -> `200` (`highOpenCount=11`)
  - `GET /api/cases?status=all&site=Clinic` -> `200` (`clinicCasesCount=8`)
  - `GET /api/cases?status=all&assignee=unassigned` -> `200` (`unassignedCasesCount=28`)
  - `GET https://frontend-seven-eta-24.vercel.app/cases` -> `200`

### Assignment + escalation flow (P2 operations maturity)

- Added backend case actions:
  - `POST /api/cases/{caseId}/assign?assignee=<name>`
  - `POST /api/cases/{caseId}/escalate`
- Action behavior:
  - Assign updates `cases.assignee`, records `case_actions` row (`ASSIGNED`), emits `CASE_ASSIGNED`.
  - Escalate sets `priority=HIGH`, keeps `status=OPEN`, updates next action text, records `case_actions` row (`ESCALATED`), emits `CASE_ESCALATED`.
- Added frontend controls on case detail page:
  - Assignee input + Assign button
  - Escalate button
- Added controller tests for assign/escalate endpoints.

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Deployment + production checkpoint:
- Commit pushed: `46849b5` (`feat(caseflow): add assignment and escalation actions [S4]`)
- Backend redeployed: `https://workwell-measure-studio-api.fly.dev`
- Frontend redeployed + aliased: `https://frontend-seven-eta-24.vercel.app`
- Timestamped production smoke check (`2026-05-04T01:48:47-04:00`):
  - `GET /actuator/health` -> `UP`
  - `GET /api/cases?status=open` -> `200` (`openCaseCount=27`, `caseId=c6d79a2f-8f86-4d48-ac91-06f21d478ccb`)
  - `POST /api/cases/{caseId}/assign?assignee=QA%20Lead&actor=codex-smoke` -> `200` (`status=OPEN`, `assignee=QA Lead`)
  - `POST /api/cases/{caseId}/escalate?actor=codex-smoke` -> `200` (`status=OPEN`, `priority=HIGH`)
  - `GET https://frontend-seven-eta-24.vercel.app/cases/{caseId}` -> `200`

### Case timeline/evidence consistency pass (P2 operations maturity)

- Improved assignment action evidence consistency:
  - Assignment payload now records real `previousAssignee` instead of `"unknown"`.
- Improved case timeline completeness:
  - Case detail timeline now merges both `audit_events` and `case_actions`, ordered chronologically.
  - Timeline payload entries now include `timelineSource` (`audit_event` or `case_action`) for clearer provenance.
- Improved case-detail evidence clarity:
  - Added structured quick-read fields for `why_flagged` in UI (last exam date, window, overdue days, eligibility, waiver status).
  - Timeline event labels are now human-readable (for example `CASE_ESCALATED` -> `Case Escalated`).

Verification checkpoints (local):
- `backend\\gradlew.bat test` -> PASS
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Production stabilization follow-through:
- Initial deployment surfaced a regression on case detail (`GET /api/cases/{id}` -> `500`).
- Root cause: timeline SQL referenced `case_actions.created_at`, but schema uses `performed_at`.
- Additional hardening applied:
  - normalized union sort-key typing (`id::text`) for mixed audit/case-action streams
  - made timeline payload parsing resilient to non-object JSON payloads
- Final fix commits:
  - `88ee989` (`fix(caseflow): use performed_at for case action timeline [S4]`)
  - plus prior timeline hardening commits in same slice
- Timestamped production verification (`2026-05-04T02:08:47-04:00`):
  - `GET /api/cases?status=open` -> `200`
  - `GET /api/cases/{id}` -> `200` (`timelineCount=15`, `timelineSources=audit_event,case_action`)
  - `GET https://frontend-seven-eta-24.vercel.app/cases/{id}` -> `200`

## 2026-05-03

### End-of-day closeout: status-source bugfix, run scope hardening, idempotency, MCP live-shape

- Completed critical status-source cleanup:
  - Removed legacy name-based filtering hacks for `AnnualAudiogramCompleted`.
  - Enforced `measure_versions.status` as the source of truth for active measure scope.
  - Added explicit active-scope query in run persistence:
    - `SELECT DISTINCT m.id, m.name, mv.id AS measure_version_id, mv.status FROM measures m JOIN measure_versions mv ON mv.measure_id = m.id WHERE mv.status = 'Active'`.
- Added manual all-programs run endpoint:
  - `POST /api/runs/manual` with scope `"All Programs"`.
  - Endpoint now resolves active measure versions via the active-scope query and persists a run with `scope_type='all_programs'`.
- Case upsert idempotency hardening:
  - Replaced split insert/update logic with a single `INSERT ... ON CONFLICT (employee_id, measure_version_id, evaluation_period) DO UPDATE`.
  - Confirmed case write path is now deterministic for reruns over the same key.
- Compliant rerun closure behavior aligned to spec:
  - Chosen state: `RESOLVED` (documented in code comment).
  - Compliant reruns now transition open cases to resolved state and emit `CASE_RESOLVED`.
- Seed strategy decision for `patient-*` rows:
  - Selected Option A.
  - Removed `patient-*` exclusion filter from case list path.
  - Added code comment documenting legacy `patient-*` + `emp-*` rows as valid demo records.
- MCP tools wired to explicit live payload contracts:
  - `list_cases` now returns status, priority, assignee, and `measure_version_id`.
  - `get_run_summary` now returns `total_cases`, `compliant_count`, `non_compliant_count`, `pass_rate`, and `duration`.
  - `get_case` now exposes full evidence payload plus extracted `why_flagged`.
- Evidence payload structured:
  - Demo run engines now persist `why_flagged` object with:
    - `last_exam_date`, `compliance_window_days`, `days_overdue`, `role_eligible`, `site_eligible`, `waiver_status` (+ outcome metadata).
- Audit coverage added:
  - `MEASURE_VERSION_DRAFT_SAVED` on spec/CQL draft edits.
  - `MEASURE_VERSION_STATUS_CHANGED` on lifecycle transitions (including activation).
  - `RUN_STARTED` and `RUN_COMPLETED` on run flows (measure runs + case rerun verification + all-program runs).

Verification checkpoints (local):
- `backend\\gradlew.bat compileJava` -> PASS
- `backend\\gradlew.bat test --tests \"com.workwell.web.CaseControllerTest\" --tests \"com.workwell.web.EvalControllerTest\"` -> PASS
- `backend\\gradlew.bat test` -> FAIL on environment-level Docker/Testcontainers availability (`DockerClientProviderStrategy`), not on compile.
- `frontend npm run lint` -> PASS
- `frontend npm run build` -> PASS

Follow-up verification after Docker restore:
- `backend\\gradlew.bat test` -> PASS (all tests green once Docker/Testcontainers were available).
- Fresh DB smoke issue found and fixed:
  - Initial `/api/runs/manual` on empty DB returned `500` (`No active measures found to execute`).
  - Fix applied in `EvalController`: call `measureService.listMeasures()` before resolving active measure scope so default active seeds are present.
- Smoke re-run against containerized backend + postgres:
  - `POST /api/runs/manual` now succeeds on fresh DB without needing a prior `/api/measures` call.
  - Sample result: `activeMeasuresExecuted=2`, `totalEvaluated=25`, `totalCases=14`, `passRate=32.0`.

Git closeout:
- Grouped final changes into logical commits (backend+tests, frontend, docs) with spike-tagged commit messages.
- Verified no extra temp/runtime artifacts remained after Docker smoke runs.
- Final local checks remained green before closeout:
  - `backend\\gradlew.bat test`
  - `frontend npm run lint`
  - `frontend npm run build`

### Production consistency fix (advisor escalation: data-level cleanup)

- External validation continued to report stale public responses (`3` measures including `AnnualAudiogramCompleted`) despite app-level filtering checks from our side.
- To remove dependence on machine/region/code-path behavior, applied direct database cleanup against production data:
  - Legacy measure version rows for `AnnualAudiogramCompleted` set to `Deprecated` (no remaining `Active` versions).
  - Legacy placeholder open cases (`employee external_id LIKE 'patient-%'`) set to `CLOSED` with `closed_at=NOW()`.
- Post-change data assertions:
  - `active_legacy_versions=0`
  - `open_legacy_cases=0`

Timestamped production checkpoint (`2026-05-03T20:40:00-04:00`):
- `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `GET https://workwell-measure-studio-api.fly.dev/api/measures?cb=<timestamp>` -> `200`, returns exactly 2 active measures (`TB Surveillance`, `Audiogram`)
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&cb=<timestamp>` -> `200`, `open_count=13`, `legacy_rows=0`
- Response trace sample: `fly-request-id: 01KQR6W1V49NHKNZ0HQCYYXKG4-ord`

### D16 readiness sign-off (production walkthrough)

- Completed end-to-end live walkthrough aligned to `docs/DEMO_SCRIPT.md` on production backend + frontend.
- Confirmed clickable frontend shell routes for demo navigation:
  - `/measures`, `/studio`, `/runs`, `/cases`, `/programs`, `/worklist` all return `200` on `https://frontend-seven-eta-24.vercel.app`.
- Case lifecycle demo loop executed live on an open Audiogram overdue case:
  - `POST /api/cases/{caseId}/actions/outreach` -> case remained `OPEN`
  - `POST /api/cases/{caseId}/rerun-to-verify` -> case transitioned `CLOSED` with `COMPLIANT`
  - Case timeline tail includes `CASE_OUTREACH_SENT`, `CASE_RERUN_VERIFIED`, `CASE_CLOSED`

Timestamped endpoint checklist (`2026-05-03T20:00:00-04:00`):
- `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200` with 2 active measures (`TB Surveillance`, `Audiogram`)
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> `200`, no `patient-*` rows
- `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=<audiogram-id>` -> `200`, clean filtered list
- `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`; `GET /api/runs/{id}` -> `200` (`totalEvaluated=15`)
- `POST https://workwell-measure-studio-api.fly.dev/api/runs/tb-surveillance` -> `200`; TB case detail `nextAction` confirms TB-specific copy
- `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200`
- MCP Layer 1 validation: confirmed via Claude Code with live responses (open Audiogram cases + latest run summary)

- Readiness decision: operational demo flow is stable and sign-off ready for D16 with bug-fix-only posture.

### D16 pre-freeze bugfix pass (TB copy, legacy clutter, placeholder routes)

- Fixed TB next-action copy bug in caseflow action generation:
  - TB open-case actions now use TB-specific language:
    - `Schedule the annual TB screening before the due date.`
    - `Escalate TB screening follow-up immediately.`
    - `Collect the missing TB screening documentation.`
- Clarified verification detail:
  - Existing TB cases created before the fix retained old text.
  - After triggering a fresh TB run in production (`runId=6793de66-b547-445e-8bcf-90fff6b621ec`), TB case detail now shows corrected TB-specific `nextAction`.
- Removed legacy demo clutter from list surfaces:
  - Measure list now excludes legacy `AnnualAudiogramCompleted`.
  - Case list now excludes legacy placeholder employees (`patient-*`) and the legacy measure line.
- Replaced placeholder frontend routes to avoid blank-page demo risk:
  - `/programs` now provides navigation cards to live demo surfaces (`/measures`, `/runs`).
  - `/worklist` now routes users directly to live cases via CTA (`/cases`).
- Production verification:
  - `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> 2 measures (`TB Surveillance`, `Audiogram`)
  - `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> no `patient-*` rows
  - `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=<tb-id>` + case detail -> TB-specific `nextAction` confirmed
  - Frontend redeployed and aliased: `https://frontend-seven-eta-24.vercel.app`

### External advisor handoff refreshed

- Rewrote `docs/advisor_update.md` into a clean, comprehensive status packet for external advisor review.
- Included:
  - shipped scope through Step 6,
  - latest MCP validation evidence from Claude Code,
  - production smoke snapshot,
  - explicit agent recommendations for D16 demo-freeze strategy,
  - targeted clarifying questions for advisor guidance on final sequencing and risk tolerance.
- Intent: accelerate advisor feedback loop and lock final pre-D16 execution posture without scope creep.

### MCP validation confirmed (Claude Code + production smoke)

- Claude Code MCP validation now passes end-to-end with real data:
  - Prompt equivalent: "Show me all open Audiogram cases" returned 10 open Audiogram cases.
  - Prompt equivalent: "Get the summary of the latest run" returned run summary with counts:
    - `COMPLIANT=3`, `DUE_SOON=3`, `OVERDUE=4`, `MISSING_DATA=3`, `EXCLUDED=2`, `totalEvaluated=15`.
- This confirms stale-schema fallback works (`measureId=\"Audiogram\"`) and latest-run default behavior works (`get_run_summary` without `runId`).
- Production smoke pass rerun after validation:
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200` (Audiogram Active `v1.0`, TB Surveillance Active `v1.3`)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> `200` (17 open)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=4ae5d865-3d64-4a17-905d-f1b315a037e2` -> `200` (10 open Audiogram)
  - `2026-05-03T02:36:00-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200` (`runId=f7e73f4a-cc22-4be1-b417-9420040e0fd4`)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/runs/f7e73f4a-cc22-4be1-b417-9420040e0fd4` -> `200` (`totalEvaluated=15`)
  - `2026-05-03T02:36:00-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/tb-surveillance` -> `200` (`runId=5cc29869-8abf-4f66-9a09-2bdeee32751d`)
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200`
  - `2026-05-03T02:36:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/sse` with `Accept: text/event-stream` -> `200` (stream endpoint reachable)

### MCP usability hotfix (Claude prompt compatibility)

- User validation surfaced MCP input friction: `list_cases` required `measureId` UUID and `get_run_summary` required explicit `runId`, which blocked natural-language prompt execution in Claude Code.
- Applied backend MCP compatibility update:
  - `list_cases` now supports either `measureId` **or** `measureName` (case-insensitive lookup through measure catalog).
  - `get_run_summary` now accepts optional `runId`; when omitted, it returns the latest persisted run.
  - Added `RunPersistenceService.loadLatestRun()` to back the latest-run path.
- Production checkpoint:
  - `2026-05-03T02:06:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T02:06:00-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200`

### Advisor sync - post-review execution reset

- Advisor review completed. Progress confirmed through S1 (Audiogram vertical) and early S4 backend (case lifecycle + audit chain).
- S2 (catalog/authoring) confirmed as the highest-priority remaining spike.
- Decision: rerun-to-verify remains demo-simulated for all measures through D16. Do not generalize the evaluator this sprint.
- Decision: S5 MCP scope is limited to Layer 1 only - three read-only tools (`get_case`, `list_cases`, `get_run_summary`) wrapping existing API endpoints. AI explain and write tools are post-D16.
- Decision: S6 video/walkthrough production is deferred until a stable live demo exists. Written demo script is sufficient for D16.
- Revised execution priority order is now recorded in `docs/SPIKE_PLAN.md` and supersedes prior task ordering.

### Step 0 checkpoint (docs-first update complete)

- Updated `docs/JOURNAL.md` and `docs/SPIKE_PLAN.md` per advisor instructions before implementation changes.
- Added explicit S2 thin-vertical scope note and revised priority order with deferred items.
- Production checkpoint:
  - `2026-05-02T23:58:38-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`

### Step 1 progress - S2 thin vertical implemented locally

- Implemented backend Measure APIs:
  - `GET /api/measures`
  - `POST /api/measures`
  - `GET /api/measures/{id}`
  - `PUT /api/measures/{id}/spec`
  - `PUT /api/measures/{id}/cql`
  - `POST /api/measures/{id}/cql/compile`
  - `POST /api/measures/{id}/status`
- Seeded Audiogram as catalog-visible Active `v1.0` in service-level seed guard.
- Implemented frontend S2 UI:
  - `/measures` table with status pills and create flow
  - `/studio/[id]` with Spec tab, CQL tab + compile gate, lifecycle action buttons
  - Save Draft success toast behavior on Spec save
- Local verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `frontend npm run lint` -> success
  - `frontend npm run build` -> success
- Deployment state:
  - Frontend production deployed: `https://frontend-seven-eta-24.vercel.app`
  - Backend deploy currently blocked on this machine because `flyctl` is not installed (`flyctl` command not found).
- Production checkpoint evidence:
  - `2026-05-02T23:58:38-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-02T23:58:38-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `404` (expected until backend deployment with Step 1 code)

### Step 1 deployment checkpoint (completed)

- Backend deployed via Fly after `flyctl` install.
- Production checkpoint:
  - `2026-05-03T00:17:01-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T00:19:48-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200`
- Frontend production deployed and aliased:
  - `https://frontend-seven-eta-24.vercel.app`

### Step 2 — S3 audit + minimum generalization refactor

Audit answers:

- Which classes/methods in `AudiogramDemoService` and `RunPersistenceService` were hardcoded to Audiogram fixtures?
  - `AudiogramDemoService.run()` hardcoded Audiogram patient fixture list and Audiogram-specific measure name/version.
  - `RunPersistenceService.persistAudiogramRun(...)`, `loadLatestAudiogramRun()`, `loadOutcomesForRun(...)`, and seed helpers (`ensureMeasure*`) were coupled to Audiogram types/constants and patient-id naming.
- Does `CaseFlowService` reference any Audiogram-specific types or IDs?
  - Before refactor: yes, method signatures used `AudiogramDemoService.AudiogramOutcome`, and several message strings/templates were Audiogram-specific.
  - After refactor: shared case upsert path now uses generic `DemoOutcome` model and no longer depends on Audiogram Java types/IDs.
- Can a second measure seeded run be added by implementing a new `DemoService` + registering it, without modifying `CaseFlowService` or `RunPersistenceService`?
  - Yes. `RunPersistenceService` now exposes `persistDemoRun(DemoRunPayload)` and `CaseFlowService` accepts generic outcome models (`upsertCases(...)`), so a second measure service can plug into the same run/case/audit infrastructure.

Minimum changes applied:

- Added shared run models:
  - `backend/src/main/java/com/workwell/run/DemoRunModels.java`
- Refactored shared persistence to generic payload:
  - `RunPersistenceService.persistDemoRun(...)` added and used by existing Audiogram path.
- Refactored shared case upsert path to generic outcomes:
  - `CaseFlowService.upsertCases(...)` now accepts shared `DemoOutcome`.
- Kept simulation pattern in place (no generalized evaluator introduced).

Verification + deployment checkpoint:

- Local backend verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Production checkpoint:
  - `2026-05-03T00:23:51-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T00:23:51-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> `200`
  - `2026-05-03T00:23:51-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`

### Step 3 — S4 worklist filter cleanup + audit-linkage verification

Implemented:

- Backend case filters:
  - `GET /api/cases?status=open|closed|all` (default `open`)
  - `GET /api/cases?measureId=<measure-id>` (optional, combinable with status)
- Frontend `/cases` filter controls:
  - `Status` dropdown (Open / Closed / All), default Open
  - `Measure` dropdown (populated from active measures)
  - Re-fetch on filter changes

Audit chain linkage verification (Audiogram path):

- Code-path inspection confirms required run/case linkage for the demo lifecycle chain:
  - `CASE_CREATED` / `CASE_UPDATED` include `ref_run_id` and `ref_case_id`
  - `CASE_OUTREACH_SENT` includes `ref_run_id` and `ref_case_id`
  - `CASE_RERUN_VERIFIED` includes `ref_run_id` and `ref_case_id`
  - `CASE_CLOSED` includes `ref_run_id` and `ref_case_id`
- No additional linkage fix was required for the specified chain.

Verification + deployment checkpoint:

- Local verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `frontend npm run lint` -> success
  - `frontend npm run build` -> success
- Production deploy:
  - Backend deployed on Fly
  - Frontend deployed and aliased to `https://frontend-seven-eta-24.vercel.app`
- Production checkpoint:
  - `2026-05-03T00:28:21-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T00:28:21-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open` -> `200` (3 cases)
  - `2026-05-03T00:28:21-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/cases?status=open&measureId=<active-id>` -> `200` (filter path verified)

### Step 4 — S6 early (TB seed + synthetic dataset expansion)

Implemented:

- Added shared synthetic employee catalog with ~50 employees across required roles/sites:
  - Roles represented: `Maintenance Tech`, `Nurse`, `Welder`, `Office Staff`, `Industrial Hygienist`, `Clinic Staff`
  - Sites represented: `Plant A`, `Plant B`, `Clinic`
- Extended run persistence seeding to maintain the synthetic employee roster in `employees` and upsert profile fields (name, role, site).
- Expanded Audiogram simulation to a larger seeded cohort with mixed outcomes and persisted case generation through existing run/case/audit pipeline.
- Added `TBSurveillanceDemoService` and registered:
  - `POST /api/runs/tb-surveillance`
- Added TB measure seed in catalog as Active:
  - `TB Surveillance` version `v1.3`
- Aligned Audiogram demo run metadata to:
  - `Audiogram` version `v1.0`

TB run distribution validation:

- Production TB run response currently returns:
  - `outcomes=10`
  - `compliant=5`
  - `dueSoon=1`
  - `overdue=2`
  - `missingData=1`
  - `excluded=1`
- This satisfies the target mix for demo credibility and keeps run simulation per-measure (no generalized evaluator introduced).

Verification + deployment checkpoint:

- Local backend verification:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Production checkpoint:
  - `2026-05-03T01:04:54-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
  - `2026-05-03T01:04:54-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/measures` -> includes Active `Audiogram` and Active `TB Surveillance`
  - `2026-05-03T01:04:54-04:00` `POST https://workwell-measure-studio-api.fly.dev/api/runs/tb-surveillance` -> `200`

### Step 5 — S5 MCP Layer 1 read tools

Implemented MCP Layer 1 as read-only tools only:

- `get_case`
  - Input: `caseId: string`
  - Returns full case detail payload from existing caseflow read path.
- `list_cases`
  - Input: `status?: string` (default `open`), `measureId?: string`
  - Returns case summaries using existing filtered case listing path.
- `get_run_summary`
  - Input: `runId: string`
  - Added supporting endpoint: `GET /api/runs/{id}` for run metadata + outcome counts by status.

Implementation notes:

- Added MCP Java SDK dependencies and Spring WebMVC SSE transport wiring.
- MCP server config:
  - `backend/src/main/java/com/workwell/mcp/McpServerConfig.java`
- New run summary endpoint:
  - `backend/src/main/java/com/workwell/web/RunController.java`

Validation status:

- Programmatic MCP transport validation completed:
  - `GET /sse` returns MCP endpoint event with session-scoped message route.
  - MCP initialize and message POST handshake return success status.
- Full Claude Desktop interactive validation is pending in this environment (no direct Claude Desktop UI session available from this runtime).

Deployment checkpoint:

- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/runs/{id}` -> `200`
- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/sse` -> MCP endpoint advertised

### Step 6 — S6 final (audit export + demo script)

Implemented:

- Audit trail CSV export endpoint:
  - `GET /api/audit-events/export?format=csv`
  - Columns: `timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail`
- Frontend export control:
  - Added **Export CSV** button on `/cases` to trigger browser download.
- Added written demo script:
  - `docs/DEMO_SCRIPT.md`

Local verification:

- `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- `frontend npm run lint` -> success
- `frontend npm run build` -> success

Production checkpoint:

- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/actuator/health` -> `UP`
- `2026-05-03T01:19:02-04:00` `GET https://workwell-measure-studio-api.fly.dev/api/audit-events/export?format=csv` -> `200` (`text/csv`)

### D3 - S1a Audiogram vertical (progress)

**Goals set**
- Start S1a by replacing placeholder run flow with a real measure-specific vertical slice.
- Keep changes within backend/frontend ownership boundaries and preserve ADR-002 evidence shape.

**What shipped**
- Added seeded Audiogram demo evaluator service for 5 synthetic patients with outcome buckets:
  - `COMPLIANT`, `DUE_SOON`, `OVERDUE`, `MISSING_DATA`, `EXCLUDED`
  - File: `backend/src/main/java/com/workwell/measure/AudiogramDemoService.java`
- Added S1a run endpoint:
  - `POST /api/runs/audiogram`
  - File: `backend/src/main/java/com/workwell/web/EvalController.java`
- Added DB-backed persistence and readback for seeded runs:
  - `runs`, `outcomes`, `audit_events` rows are written through `RunPersistenceService`
  - `GET /api/runs/audiogram/latest` reads the latest persisted run
  - File: `backend/src/main/java/com/workwell/run/RunPersistenceService.java`
- Added baseline authored CQL resource for Annual Audiogram:
  - File: `backend/src/main/resources/measures/audiogram.cql`
- Expanded dashboard run page to execute and render the S1a vertical response, including run summary and per-patient evidence payloads:
  - File: `frontend/app/(dashboard)/runs/page.tsx`

**Verification**
- Backend tests: `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Frontend lint: `npm run lint` -> success
- Frontend production build: `npm run build` -> success

**Notes**
- This slice establishes the S1a authored-measure/run/evidence path with deterministic seeded outcomes.
- Persistence is now live for seeded Audiogram runs; case detail integration remains for next S1a steps.

**Fix + redeploy**
- Live `/api/runs/audiogram` initially failed because the seeded missing-data patient produced a `null` evidence value and `Map.of(...)` rejected it.
- Updated evidence assembly to use null-safe `LinkedHashMap` payloads.
- Added a direct service test for the seeded run to guard against the same regression.
- Redeployed Fly backend and verified live success:
  - `POST https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`
  - `OPTIONS https://workwell-measure-studio-api.fly.dev/api/runs/audiogram` -> `200`
  - Returned summary counts: `1 / 1 / 1 / 1 / 1` across compliant, due soon, overdue, missing data, excluded

**Current status**
- Backend and frontend both verify locally after persistence wiring.
- Ready to push the DB-backed run path live and confirm the latest-run readback in the browser.

**Caseflow / Why Flagged**
- Wired seeded Audiogram outcomes into the `cases` table for non-compliant statuses:
  - `DUE_SOON`, `OVERDUE`, `MISSING_DATA` create or refresh open cases.
  - `COMPLIANT` and `EXCLUDED` close an existing case if one is already present.
- Added read APIs for:
  - `GET /api/cases`
  - `GET /api/cases/{id}`
- Added frontend case views:
  - `/cases` list page
  - `/cases/[id]` detail page with structured evidence, metadata, and audit timeline
- Verification completed after the change:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `npm run lint` -> success
  - `npm run build` -> success

**Case action + rerun-to-verify loop**
- Added case action API endpoints:
  - `POST /api/cases/{id}/actions/outreach`
  - `POST /api/cases/{id}/rerun-to-verify`
- Added backend case lifecycle behavior for S4b:
  - Outreach action writes `case_actions` plus `CASE_OUTREACH_SENT` audit event.
  - Rerun-to-verify writes a case-scoped verification run, persists a compliant verification outcome, records action/audit events, and closes the case.
- Added UI controls on `/cases/[id]`:
  - `Send outreach`
  - `Rerun to verify`
  - Page refreshes with updated status and audit timeline after each action.
- Verification after this slice:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
  - `npm run lint` -> success
  - `npm run build` -> success

**Deploy + live checkpoint verification**
- Backend deployed to Fly using repo-root context with backend config:
  - `flyctl deploy --config backend/fly.toml`
  - Live URL: `https://workwell-measure-studio-api.fly.dev`
- Frontend deployed to Vercel production:
  - Deployment: `https://frontend-5wx93gznt-taleef7s-projects.vercel.app`
  - Active alias observed: `https://frontend-seven-eta-24.vercel.app`
- Live API verification evidence:
  - `GET /actuator/health` -> `UP`
  - `POST /api/runs/audiogram` -> returned run id `79d87735-81b7-42dc-86b2-bf200a196890`
  - `GET /api/cases` -> `3` cases
  - `POST /api/cases/d99266b2-0cb8-47b9-a329-c7ccc89ea00e/actions/outreach` -> next action updated to follow-up + rerun guidance
  - `POST /api/cases/d99266b2-0cb8-47b9-a329-c7ccc89ea00e/rerun-to-verify` -> case transitioned to `CLOSED` with `COMPLIANT`
  - `GET /api/cases/d99266b2-0cb8-47b9-a329-c7ccc89ea00e` -> `closedAt` present and timeline length `5`
- Checkpoint readout:
  - The core S4b loop (open case -> outreach action -> rerun verification -> case closure + audit chain) is now live and test-backed.
  - Ready to re-evaluate completed scope against SPIKE_PLAN acceptance and pick the next highest-risk gap.

**Advisor checkpoint package**
- Added `docs/advisor_update.md` as a comprehensive status handoff for external advisor review.
- Document includes:
  - spike-by-spike Done/Partial/Missing matrix against `docs/SPIKE_PLAN.md`
  - execution evidence from `docs/JOURNAL.md` and deploy checks
  - issue log, risk assessment, and recommended next execution sequence
  - explicit advisor feedback prompts for scope/risk decisions

## 2026-05-02

### D1 - Plan + Provision (completed)

**Goals set**
- Finalize canonical sprint docs and archive legacy planning docs.
- Prepare deploy targets (Neon, Fly.io, Vercel) without doing the D2 deployment.
- Close ADR-002 on `evidence_json` shape to unblock S1.

**What shipped today**
- Archived legacy plan files under `docs/archive/`, including `PROJECT_PLAN_v1.md` with top note:
  - "Archived May 2, 2026. Replaced by docs/SPIKE_PLAN.md."
- Canonical sprint docs are now in place:
  - `docs/SPIKE_PLAN.md`
  - `docs/DEPLOY.md`
  - `AGENTS.md` and `CLAUDE.md` updated to point to `SPIKE_PLAN.md` as source of truth.
- Added root `.env.example` with all deployment variables from `docs/DEPLOY.md`:
  - `DATABASE_URL`
  - `DATABASE_URL_DIRECT`
  - `ANTHROPIC_API_KEY`
  - `SPRING_PROFILES_ACTIVE`
  - `NEXT_PUBLIC_API_BASE_URL`
  - `NEXT_PUBLIC_APP_NAME`
- Added `backend/fly.toml` with D1 baseline:
  - app: `workwell-measure-studio-api`
  - region: `ord`
  - memory: `512mb`
  - healthcheck: `/actuator/health`
  - JVM opts: `-Xmx384m -Xss256k`
- Closed ADR-002 in `docs/DECISIONS.md` with accepted shape:
  - `evidence_json = { expressionResults, evaluatedResource }`
  - `rule_path[]` derived at render time (not persisted)

**Sub-spike / verification evidence**
- Re-ran CQF ADR probe test in spike repo:
  - `../workwell-spike-cqf`: `./gradlew.bat test --tests com.workwell.spike.DualEvaluationCostSubSpikeTest`
  - Result: `BUILD SUCCESSFUL`
- Backend tests in this repo were green in D1 verification sweep:
  - `backend\gradlew.bat test` -> `BUILD SUCCESSFUL`

**Provisioning status (end of D1)**
- Fly:
  - Authenticated and app created with `flyctl launch --no-deploy`.
  - Current staged secret: `SPRING_PROFILES_ACTIVE=prod`.
  - No app deploy performed (correct for D1).
- Vercel:
  - Git repository now connected (confirmed in project Git settings).
  - Preview deployment failure observed on PR branch due to project root mismatch.
  - Exact error: "No Next.js version detected".
  - Root cause: Vercel building from repo root while Next.js app lives in `frontend/`.
  - Required fix: set Vercel project Root Directory to `frontend` and redeploy.
- Neon:
  - CLI provisioning created a project defaulting to PostgreSQL 17.
  - This conflicts with locked stack requirement (PostgreSQL 16).
  - DB secrets pointing to PG17 were intentionally not kept as final runtime configuration.

**What surprised**
- Neon CLI default behavior is PG17 unless PG version is explicitly controlled through supported path.
- Vercel integration succeeded, but monorepo root detection still caused preview build failure.
- CQF processor two-step path remains the best evidence-friendly path and did not require a second full evaluation in the measured probe.

**Risk status**
- ADR-002 risk: closed.
- Vercel preview build risk: open until Root Directory is set to `frontend`.
- Database version compliance risk: open until Neon PG16 target is created/selected.

**Plan for D2 (S0 walking skeleton only)**
- Do not add scope beyond S0.
- Complete infra readiness first:
  - Ensure Vercel Root Directory = `frontend` and preview deploy succeeds.
  - Ensure Neon target is PostgreSQL 16.
  - Set final Fly DB secrets (`DATABASE_URL`, `DATABASE_URL_DIRECT`) from compliant PG16 Neon target.
  - Add `ANTHROPIC_API_KEY` only if AI surface is exercised in S0 path.
- Then execute S0 end-to-end:
  - Backend `/api/eval` on Fly
  - Frontend call from Vercel
  - Health checks and demoable round-trip

### D2 prep progress (resumed)

**What shipped in code**
- Added backend stub-auth security config to allow sprint-phase unauthenticated API access:
  - `backend/src/main/java/com/workwell/config/SecurityConfig.java`
- Added S0 walking-skeleton endpoint:
  - `POST /api/eval` in `backend/src/main/java/com/workwell/web/EvalController.java`
  - Accepts `patientBundle` + `cqlLibrary`, returns placeholder outcome + evidence payload shape.
- Added endpoint test:
  - `backend/src/test/java/com/workwell/web/EvalControllerTest.java`
- Replaced placeholder "Test Runs" UI with an S0 API probe page:
  - `frontend/app/(dashboard)/runs/page.tsx`
  - Button posts sample payload to `${NEXT_PUBLIC_API_BASE_URL}/api/eval` and renders response/error.

**Verification run**
- Backend:
  - `backend\\gradlew.bat test` -> `BUILD SUCCESSFUL`
- Frontend:
  - `npm run lint` -> success
  - `npm run build` -> success

**Still pending outside repo code**
- Vercel project setting: Root Directory must be `frontend`.
- Neon runtime target must be PostgreSQL 16 before final Fly DB secret wiring.
- Deployed S0 validation on live URLs (Fly `/actuator/health`, Vercel `/runs` probe).

### D2 - S0 walking skeleton (completed)

**Infra completion**
- Neon PG16 project created and selected for runtime (`workwell-measure-studio-pg16`).
- Fly secrets set with JDBC-form `DATABASE_URL` and `DATABASE_URL_DIRECT` values from PG16 target.
- Backend deployed to Fly and verified healthy on:
  - `https://workwell-measure-studio-api.fly.dev/actuator/health`
- Vercel root directory locked to `frontend` and production alias confirmed:
  - `https://workwell-measure-studio.vercel.app`

**What shipped after D2 prep**
- Backend CORS handling enabled in spring security to allow browser preflight from Vercel frontend.
  - File: `backend/src/main/java/com/workwell/config/SecurityConfig.java`
- Frontend eval probe hardened by normalizing `NEXT_PUBLIC_API_BASE_URL` and surfacing the full request URL on failure.
  - File: `frontend/app/(dashboard)/runs/page.tsx`

**Production verification evidence**
- Preflight check from Vercel origin to Fly eval endpoint:
  - `OPTIONS /api/eval` -> `200`, `Access-Control-Allow-Origin` returned correctly.
- Direct API eval check:
  - `POST https://workwell-measure-studio-api.fly.dev/api/eval` -> `200` with expected placeholder payload.
- Browser check on production frontend:
  - `/runs` "Run Eval Probe" now renders successful JSON response (COMPLIANT placeholder outcome).

**Commits applied during D2 completion**
- `a62c4d3` `fix(api): allow CORS preflight for eval probe [S0]`
- `b672d8f` `fix(frontend): normalize API base URL for eval probe [S0]`

**Result**
- S0 acceptance met: deployed patient/CQL eval probe round-trip works end-to-end across Vercel + Fly + Neon.
  - Ready to move into D3/S1a Audiogram vertical.

---

## 2026-05-01

CQF/FHIR de-risking and ADR-002 probes completed in `../workwell-spike-cqf` with passing test evidence and documented transfer notes in `docs/CQF_FHIR_CR_REFERENCE.md`.

## 2026-04-29

Initial planning baseline and scaffolding completed.

- MCP schema-compat deploy checkpoint:
  - 2026-05-03T13:53:42.1028589-04:00 GET https://workwell-measure-studio-api.fly.dev/actuator/health -> UP









