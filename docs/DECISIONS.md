# Decisions

Architecture decision records, newest first. Condensed on 2026-09-23 to what was decided and why; the
full original text of any ADR is in git history (`git show a387cb52:docs/DECISIONS.md`, and
`git show a387cb52:docs/archive/DECISIONS_ARCHIVE.md` for the ones that had been archived).

Code cites numbered sub-decisions (`ADR-074 d13`, `ADR-046 decision 3`, `ADR-060 §5`); those numbers are
the originals and are kept as they were. One ADR number was assigned during the condensing: ADR-033,
whose record had lost its heading (see its status line).

## ADR-087: The dashboard resolves winning runs once and skips needless sorts
*2026-09-21 · Accepted*

**Decision.** Memoize the "which runs win" probes, read folded rows unordered over a narrow projection, and warm read models at boot. Extends ADR-084.
d1. The winners probe is memoized in `stores/probe-cache.ts`, keyed by the candidate run list and scoped per database handle (not per store instance, not module-global). No TTL.
d2. `recordOutcome`, `recordOutcomes` and `compactOlderThan` invalidate the memo on both stores. A `finalizeRun` status flip is a known, narrow, uninvalidated case (named, not fixed).
d3. `listOutcomes` accepts `order: "none"` for callers that fold rows; paged reads keep their ordering. `aggregateOfficialRun` is one unordered read per (run, measure) over `listOutcomeMembershipsForRun` and reports `producedOfficialEvidence`, decided by any evaluated row, not the first.
d4. `officialMeasureRate` memoizes `null` results too.
d5. Read models are warmed at boot, off the request path, retried once on failure, never after shutdown begins. `warmReadModels` returns a result so the retry and the boot log line are truthful.
**Why.** `/programs` was failing (503 at the 30 s statement timeout) because each read model re-walked the winners and re-sorted a measure's evidence many times, and every deploy left the caches cold. An `outcomes (run_id, measure_id)` index is recommended but is owner schema and not written here.

## ADR-086: Preparation never invents codes, and the corpus never knows the future
*2026-09-21 · Accepted*

**Decision.** Normalization may add a missing system to a recognised code but never supplies or replaces a code, and a corpus bundle holds only facts recorded by its as-of. Applies ADR-037.
d1. `prepareForQiCore` normalizes a coded field only when it is present, cannot bind, and its code is in that field's own complete value set, writing the same code back with the system. Absent stays absent; unrecognised codes are left alone.
d1a. Normalizing one array entry (e.g. `Condition.category`) keeps the other entries and their text/extensions; an entry that cannot be normalized passes through unchanged.
d2. A profile-required field the source never supplied is not invented; the resource goes unretrieved. `Encounter.class` is no longer supplied for QRDA-I imports.
d3. The QRDA-I importer derives `clinicalStatus`: `<high>` with a value is `resolved`, with any `nullFlavor` is `active`, absent or unparseable gives nothing. `times()` now reports three states, not two.
d4. A corpus bundle holds only facts whose recorded date (the value passed to `provenanceFor`) is on or before its as-of; a resource and its Provenance leave together.
d5. Tests assert d1–d3 change no corpus result and that a year-end cutoff equals an unbounded one.
Owner decision 2026-09-22 (#637): d4 did move reported numbers, because the nightly's cutoff is today, so pilot rates are year to date. That stays; the corpus gets prior-year history instead of scoring the nightly at 12-31.
**Why.** Defaults were inventing, and even overwriting, clinical status on third-party documents, and the corpus emitted future-dated events.

## ADR-085: Long runs yield the event loop, and MEASURE runs are scheduled
*2026-09-21 · Accepted*

**Decision.** Loops WorkWell owns yield a macrotask after each subject; on the official path the lever is chunk size; a MEASURE-scope manual run is scheduled and returns a run id.
d1. The run pipeline's per-subject loop (`run/run-pipeline.ts`) and the engine's DB-less batch shell (`engine/ingress/evaluate-bundle.ts`) yield a macrotask after every subject by default: `setImmediate` where it exists, else `setTimeout(0)`. A microtask yield does not help.
d2. Yield after every bundle, not every Nth. `yieldEvery` can be raised, or set to `0` to disable.
d3. The policy is injected (`EvaluateBundleOptions.yieldEvery`), never read from `process.env` inside the engine (ADR-059).
d4. Official-routed measures evaluate a whole chunk in one `fqm-execution` call we cannot yield inside, so d1 does not remove that stall. The levers are `WORKWELL_RUN_CHUNK_SIZE` (the chunk's DB write is a real yield) or a worker thread (filed separately).
d5. MEASURE joins `ASYNC_SCOPES`: `/api/runs/manual` returns 201 RUNNING with a run id. EMPLOYEE stays synchronous. The `configuredMeasure` clause is removed.
**Why.** During the nightly every endpoint stalled because CPU-bound awaits never reached the poll phase, and a 20,000-patient MEASURE run always hit the 60 s gateway as a 504 with no run id, inviting duplicate retries.

## ADR-084: Statement timeout is a role default; filter in SQL where possible
*2026-09-19 · Accepted*

**Decision.** Move work-list filters into SQL where the database can see the data, return page and total from one statement, and enforce the statement timeout as a Postgres role default.
d1. `CaseQuery` gains current cycle, frozen outcome status, `OUTREACH_SENT` presence and created-at day window in SQL. `site`, `search` and oversized panel selections stay in JS (directory-only data). `sqlPageBlockedBy` returns the blocking reason.
d2. `listCasesPage` returns rows plus `COUNT(*) OVER ()`; an empty page takes a bounded separate count instead of answering 0.
d3. The current cycle in SQL is a table of (measure, period) pairs plus a fallback anchor that excludes the named measures.
d4. On scoped profiles the fast path needs every case subject in the directory; this is checked from data (`distinctCaseSubjectIds`) per process and after every run, and a violation disables the fast path with a log line.
d5. `ALTER ROLE <app role> SET statement_timeout = '30s'`, run per Neon project on the direct URL and verified through the pooled one (`DEPLOY.md`). Neon silently drops startup-packet timeouts, rejects `options=-c`, `query_timeout` is not used.
d6. Outcome compaction opts out via `withStatementTimeoutDisabled`: `BEGIN`, `SET LOCAL`, work and `COMMIT` on one checked-out client, never a session `SET`. It must ship before the role default.
d7. Pool `max: 10` stays, so the queue forms where a timeout exists.
**Why.** The open-case badge loaded every active case to return one count, and pool starvation surfaced as silent 60 s gateway 504s. A conformance test keeps the SQL and in-memory loaders in agreement.

## ADR-083: An exception is data the measure reads; staff closures change no number
*2026-09-18 · Accepted*

**Decision.** A workflow closure is not a measure exception. WorkWell never records an official-measure exception, and a staff-closed case is still counted by CQL.
d1. A workflow closure (`cases.closed_*`) is free text no measure reads; an exception is structured data in the evaluated bundle. A human-closed case's `current_outcome_status` is frozen at closure (`planCaseUpsert` no-ops when `closed_by` is set), and a person can close only an OPEN or IN_PROGRESS case.
d2. For authored measures a WorkWell waiver is legitimate as a coded `Condition` with a `urn:workwell:*` code, but nothing projects the `waivers` table into bundles yet (#577, not pilot work).
d3. For the six official measures an exception (DENEX or DENEXCEP) is a coded chart resource in the artifact's own value set; out of population is not an exception. cms2 alone has a denominator exception. No official-measure exception mutation in WorkWell, no `overrideReasons` on cards, and CDS `overridden` feedback is never an exception.
d4. "Dismiss with a reason" is display only: a "Closed by staff" state on the roster, work list, programs rollups, cases CSV and MCP `list_cases`, worded from what the winning run says today.
d5. Deferred: the official exception path (#565, WebChart write API), which exception forms clinicians use, cms2's refusal mapping (first once writes land), and the authored waiver projection (#577).
**Why.** Closing a case hid it from the work list while the measure still counted the patient; a WorkWell-marked exception would violate ADR-008 undetectably. Closure kind comes from `closed_by` (`closureKindOf`); CDS cards deliberately ignore closures.

## ADR-082: The ACO's attributed list is immutable; the sandbox refuses real ones
*2026-09-16 · Accepted*

**Decision.** An attributed list is an immutable, revisioned assertion by an outside party, reported per measurement year; a synthetic sandbox refuses to store a real one.
d1. No UPDATE or DELETE in `SubjectListStore`, routes or UI; a re-import or manual resolution of a non-match creates `revision + 1`.
d2. A list is an attribution, a panel an assignment; neither is a denominator.
d3. NOT_FOUND members are kept for review; a partial unique index allows one MATCHED row per subject, so a second identifier for a patient lands AMBIGUOUS.
d4. On a synthetic directory, an identifier outside the deployment's namespace (Maui `pat-NNN`/`pat-NNNNN`, default `emp-NNN`) refuses the whole upload, reporting a count, never values; on a live directory import is 403 until the PHI phase. All `/api/subject-lists/**` methods need CASE_MANAGER/ADMIN.
d5. `measurementYear` is required, no default; each measure's run is chosen by measurement period (`RunStore.listPopulationRunsForPeriod`), never start date. Compaction refuses per measure; 409 only when every selected run is exposed.
d6. `missingFromRun` is reported beside the rates, never subtracted; not-scored buckets are disjoint (error, out of population, in no rate, then scored). Score = `numer / (denom − denex − denexcep)`, with DENEX and DENEXCEP reported separately.
d7. The CSV carries patient-level rows under a test-pinned header; the JSON summary is recomputable from them; supplied text is neutralised against formula injection.
**Why.** The ACO asked for measures over the patients it attributes, a different population from the directory, and a real attribution file must not reach the sandbox before PHI-phase controls exist.

## ADR-081: The repeat-non-complier streak is retired
*2026-09-15 · Accepted*

**Decision.** `repeatNonCompliers` is retired: the key stays in the API response as `[]`, the measure page's tile and table are removed, and `programRiskOutlook` reads only the winning run, memoized under the winners' `runKey`, with `today` and `horizonDays` applied per request. It returns only if the aggregate snapshot store (ADR-021) gains a per-subject dimension or the owner approves an indexed per-period query on `outcomes`.
**Why.** A streak needs three distinct evaluation periods, but nightly runs of an annual measure share one period and a 400-day retention window (ADR-073) holds at most two, so the list was always empty while its history scan caused a 504.

## ADR-080: Provider panels assign new cases, and assignment source is recorded
*2026-09-12 · Accepted*

**Decision.** WorkWell owns a provider-to-staff `panel_assignments` table (owner-approved schema) that assigns new cases, and `cases.assignment_source` records who chose each assignee.
d1. `assignment_source` is `PANEL`, `OPERATOR` or NULL. A NULL source with an assignee counts as operator-owned; clearing an assignee clears its source.
d2. The panel owner is applied on case insert only (`UpsertCaseInput.panelAssignee`), never on update or reopen. A run reads the map once at loop start and at finish reconciles providers whose owner changed mid-run, for the subjects it evaluated. Panel reads are best-effort.
d3. Mapping a panel moves only active cases that are unassigned or `PANEL`-sourced, via pure `planPanelBackfill`. The compare-and-set guards assignee and source; a source-only change is a change. Re-saving a mapping still sweeps unassigned cases (`changed` vs `backfilled`).
d4. Un-mapping a panel leaves its open cases assigned.
d5. The work list opens on "My panel" for a mapped viewer, else the whole practice; an explicit URL choice wins. `?panel=me` resolves server-side; no panel means an empty, active filter.
d6. A panel is assignment, never an attributed population or denominator.
d7. Owner decision: the mapping stays in WorkWell, not WebChart departments; MIE data could only seed it through a reviewed import.
**Why.** The practice works by provider panel and was re-assigning every new case by hand; recording the source stops an automatic rule from overruling a person. Backfill audits before each chunk's update, so a lost compare-and-set can leave an event for an unapplied move.

## ADR-079: Record out-of-population and remove it from rate denominators
*2026-09-10 · Accepted*

**Decision.** Owner decisions (schema and #546's order-proposal reading): persist the out-of-population flag and exclude those subjects from every population rate.
d1. `outcomes.out_of_population` is nullable, written from the executor's `inInitialPopulation` for official-routed measures. `false` only when the official logic placed the subject in the population; authored, copy-forward and errored rows stay NULL, read as not out of population. A one-time backfill (`docs/DEPLOY.md`) resolves NULLs from evidence.
d2. `ProgramSummary`/`ProgramTrendPoint` carry `notInPopulation`; `missingData` is the remainder; `denominator = total − excluded − notInPopulation`, subtracting only persisted `MISSING_DATA` rows. `totalEvaluated` still counts every row; top-drivers drops these.
d3. Every population-rate surface moves together (overview, both trends, top-drivers, hierarchy, risk-outlook sites, order proposals); the monthly snapshot trend is not served for official measures. Run-level surfaces keep `passRate = compliant / totalEvaluated`; the runs CSV appends `notInPopulation`.
d4. Order proposals read population membership, not active cases.
d5. "Out of population" means outside every rate's initial population (`outsideEveryRate`, `fhir/measure-report.ts`).
**Why.** Out-of-population subjects were counted as missing data, so rates read far too low (CMS125 18% vs 72%) and orders were proposed to people the measure does not concern.

## ADR-078: The sandbox routes all six ACO measures; out-of-population opens no case
*2026-09-08 · Accepted*

**Decision.** Owner decision, recorded in `LOCKED_DECISIONS.md` §4A.2. Amends ADR-043.
d1. The Maui sandbox routes cms122, cms125, cms2, cms130, cms165 and cms137; `deploy-maui-mieweb.yml` and `reconcile-maui-mieweb.yml` must agree. cms130 and cms165 gates run in `flip-gate.yml`.
d2. When the executor reports `inInitialPopulation: false`, no case opens; an active one is system-closed with `closed_reason='OUT_OF_POPULATION'`, audited `CASE_RESOLVED`, reopenable later. It is never re-derived from evidence, so authored MISSING_DATA still opens cases. The outcome stays MISSING_DATA; CDS cards follow the same rule.
d3. The locked conditions move to the PHI phase: cms137 is un-routed if the final rule drops Quality ID 305; cms165 on real data needs ingest-stamped profiles and final BP status (#591).
**Why.** The owner wants every measure the pilot group sent working in the sandbox, which runs on a generated corpus, not WebChart data; out-of-population cases would otherwise fill the work list.

## ADR-077: Refuse reports from incomplete rows; show the evidence rate separately
*2026-09-08 · Accepted*

**Decision.** Exports are refused for unreportable or possibly compacted runs, and the dashboard shows the evidence's rate apart from the workflow rate. Amends ADR-031, ADR-073 and ADR-074 d12.
d1. `src/run/reportable.ts` (COMPLETED, PARTIAL_FAILURE) gates every MeasureReport variant, QRDA I and QRDA III before any row is read; UI export buttons mirror it.
d2. Completeness evidence is the ledger: `compactOutcomes`, the only deletion path, writes `OUTCOMES_COMPACTION_STARTED` with its cutoff first; an export of a run started before the furthest cutoff is 409 `run_compacted`, checked before and after the reads.
d3. The keep set holds, per (subject, measure, period), the newest usable row (from a reportable run, not an error) and the newest row regardless, plus every case-cited row; in-flight runs are never compacted.
d4. `POPULATION_SCOPES` = MEASURE, ALL_PROGRAMS; SITE, CASE and EMPLOYEE runs never replace the population snapshot.
d5. The dashboard measure rate comes from `createRateAggregator` (the MeasureReport reducer), shown apart from the workflow-status rate; no improvement is computed between them.
d6. An evaluation error is in no population: counted in `evaluationErrors` (and `unmeasured`), exported as `x-workwell-evaluation-errors`, no individual MeasureReport, `populationsSource: "evaluation-error"`.
d7. The roster separates OUT_OF_POPULATION, MISSING_DATA and evaluation failure; `GET /api/runs/:id/reconciliation` states a terminal run's counts in subject-measure pairs.
**Why.** Failed runs exported as "complete", a one-clinic run replaced the practice snapshot, compaction silently changed old scores, and a workflow number was labelled as the CMS rate.

## ADR-076: Profile trust is per measure; operator next actions survive reruns
*2026-09-07 · Accepted*

**Decision.** Facts that were global settings or overwritten each run become per-measure or per-case, and silent drops are reported.
d1. `trustMetaProfile` is set per measure in `OFFICIAL_MEASURE_SEMANTICS`; only cms165 sets it (default false). It relies on the corpus stamping profiles, so cms165 cannot run over WebChart data until blood pressures are profile-stamped at ingest (#591).
d2. `cases.next_action_source`: `patchCase` marks OPERATOR, `upsertFromOutcome` marks SYSTEM, rerun-to-verify passes SYSTEM explicitly. An OPERATOR action stands while the outcome status is unchanged; when the status moves, the computed action takes over and ownership reverts to SYSTEM.
d3. A run WARNs how many distinct subjects (and evaluations) the segment gate dropped, with measures and sites, and never mutates a segment.
d4. Retention ships only with `spike_outcomes_keepset_idx` and `spike_cases_cited_outcome_idx`; Maui sets 400 days; `official-flip-config.test.ts` asserts a window implies both. The keep-set query stays `DISTINCT ON`.
**Why.** Ignoring profiles misread cms165's blood pressures, runs overwrote operators' next actions nightly, and the segment gate dropped subjects without trace.

## ADR-075: The pilot roster is a generated corpus, evaluated in subject chunks
*2026-09-06 · Accepted*

**Decision.** The Maui roster is a seeded generated corpus that never pre-decides outcomes; runs evaluate it in subject chunks. Sandbox only.
d1. `patientAt(seed, index)` emits clinical facts at published rates, never a result; the seam's `target` is an inert `COMPLIANT`.
d2. One SplitMix64 stream per `(seed, index)`; bump `CORPUS_GENERATOR_VERSION` on draw changes; CI pins a digest of the first 100.
d3. The first 48 records keep the old fixture identities; their clinical data is generated.
d4. `composeDeploymentDirectory` builds Maui from `corpusDirectory(seed, size)`, lazily; `WORKWELL_MAUI_CORPUS_SIZE` defaults to 48, Maui sets 20000.
d5. Chunks of `WORKWELL_RUN_CHUNK_SIZE` subjects (default 500), each persisted by one `recordOutcomes`; optional `bundleForSubject` shares a bundle across measures.
d6. Outcomes commit per chunk; case upserts follow per item outside that transaction.
d7. Whole-roster, never per chunk: ADR-043's empty-population check, active-case snapshot, cycle rollover, terminal audit event.
d8. Identity uses fixed `CORPUS_IDENTITY_YEAR` (2027); clinical facts follow the run's measurement year.
d9. Patients carry `us-core-sex`/`-race`/`-ethnicity` and an active `Coverage` with a payer `Organization`.
d10. Each resource carries the profile its artifact retrieve names.
d11. Each shared denominator exclusion has data that can fire it; pregnancy is dropped.
d12. The pinned digest moved; fixture identities did not.
d13. Age gates follow each artifact's anchor (CMS2/CMS137 at period start); SUD episode draws are capped at Nov 14; diabetes is `qicore-condition-encounter-diagnosis`.
**Why.** The 48-row fixture was built from the answers, so it exposed no measure defect; the pipeline was sized for 150 people.

## ADR-074: Multi-rate measures are read on every rate
*2026-09-06 · Accepted*

**Decision.** A multi-rate measure (CMS137: Initiation, Engagement) is evaluated and reported on every rate, never rate 1 alone. The compliance API adds an additive `rates` block; its `populations` stays rate 1.
d1. Every rate is read (`OfficialSubjectResult.rates: FqmPopulationResult[][]`); single-rate is length one.
d2. The workflow bucket is the worst MEASURING rate: COMPLIANT only if every rate whose denominator holds the subject is met; out-of-population rates are ignored.
d3. All rates persist in `evidence_json.official`, which reports read; the outcome enum does not grow.
d4. MeasureReport emits one group per rate, with `Group_1`/`Group_2` ids on multi-rate reports only.
d5. A subject who cannot supply every rate is counted in none; an unreadable rate contributes zeros, never a copy of rate 1.
d6. Superseded by d8 (QRDA III used to refuse a multi-rate measure with 501).
d7. The MADiE gate compares every rate and names the one that diverged.
d8. QRDA III emits every group and every stratum (Reporting Stratum V2); stratified documents, cms125 included, are not yet re-validated.
d9. Strata persist as `evidence_json.official.strata`, keyed by `Measure.group.stratifier.id`, and appear as a `stratifier` per group in MeasureReports.
d10. Summary MeasureReport and QRDA III sum paged reads; the 5,000-subject `run_too_large` cap applies only to the per-subject bundle.
d11. `aggregateByRate` reports `unmeasured` (subjects in no rate); summary MeasureReport and QRDA III return it as the `X-WorkWell-Unmeasured-Subjects` header.
d12. Export provenance (official memberships vs authored status histogram) is read from the first evaluated row, skipping errored ones. (ADR-077 d1 extends the reportable set.)
d13. OVERDUE wording names the missed rate: `officialDisplayFor(evidence)` picks the first rate the subject is in the denominator of (not excluded or excepted) whose numerator is a miss under `numeratorMeansCompliant`; every reader, `next_action` and the CDS card included, passes it. `expressionResults` use `official:<Rate label>:<population>`, labels from `OFFICIAL_MEASURE_SEMANTICS[id].rateLabels`.
d14. The flip gate reads the deployment's own roster (amends ADR-072 d6) via `composeDeploymentDirectory` + `compositeBundleSource`, in `WORKWELL_RUN_CHUNK_SIZE` chunks; `--subjects` caps it (default 2,000).
**Why.** In 8 of CMS137's 45 steward cases the rates disagree; reading rate 1 alone marks patients who initiated treatment but never engaged as compliant, hiding the gap.

## ADR-073: Outcome rows live in a retention window; history is the aggregate
*2026-09-06 · Accepted*

**Decision.** `WORKWELL_OUTCOME_RETENTION_DAYS` sets a window beyond which per-subject `outcomes` rows are deleted. Unset means off. Durable history is the quality-over-time snapshot store (ADR-021), which compaction never touches.
d1. Unset everywhere by default (TWH keeps full history), and not to be set until the Postgres keep-set index exists. (ADR-076 d4: Maui ships 400 days together with `spike_outcomes_keepset_idx` and `spike_cases_cited_outcome_idx`.)
d2. Never deleted: the newest row per `(subject, measure, evaluation period)` at any age; every row any case (open or closed) cites, matched on `(run_id, subject_id, measure_id)`; every run row and its counts. Both exclusions are evaluated in SQL. (ADR-077 d3 adds the newest USABLE row alongside the newest overall, and exempts in-flight runs.)
d3. Compaction runs after the quality snapshot, never before; the scheduler enforces the order.
d4. The ledger precedes the delete: `OUTCOMES_COMPACTION_STARTED` (cutoff, window) is written before `compactOlderThan`, `OUTCOMES_COMPACTED` (cutoff, rows deleted, duration, window) after; one event per pass. (ADR-077 d2 makes the intent event the evidence behind 409 `run_compacted`.)
d5. `backfill-trend-history` refuses to run under a retention window.
d6. A run older than the window shows a notice that its per-subject results may be compacted and its counts are survivors; it does not claim how many rows went.
**Why.** The pilot writes roughly 100,000 outcome rows a night, and the aggregate already answers the historical question. The window is calibrated for a sandbox and needs revisiting before a real performance year.

## ADR-072: Runnable means authored or official-routed; eCQMs score calendar years
*2026-09-05 · Accepted*

**Decision.** One pure function decides whether a measure runs on a deployment, and an officially routed measure is scored over the calendar year of the evaluation date, not a rolling 365-day window. CMS165 caveat: under `trustMetaProfile: false` its profile-only BP retrieve misreads; ADR-078 routes it in the sandbox on stamped profiles, and real BPs need profile stamps before PHI.
d1. `classifyRunnable(id, env)` returns `authored` | `official` | `official-pending` | `invalid`. Runnable = authored (registry + synthetic binding) or official-only (vendored in `measures/official/` + `OFFICIAL_MEASURE_SEMANTICS` entry + listed in `WORKWELL_OFFICIAL_MEASURES`); both ⇒ `official`. `env` is a parameter, not a `process.env` read.
d2. `official-pending` (vendored with semantics, not routed here) is a valid answer, not an error.
d3. Subject bundles come from the `SubjectBundleSource` seam; official-only measures get QI-Core shapes from `official-only-bundles.ts`.
d4. Official-routed measures use the evaluation date's calendar year (`normalizePeriodEnd`), recorded on the run row and in `evidence_json.official`. `planManualRun` switches only if every measure in the run is official-routed. TWH's cms122/cms125 moved too.
d5. A stale artifact vintage becomes a run WARN via `effectivePeriodWarning`.
d6. Measures with no authored counterpart are gated by `official-flip-gate` (MADiE deck, roster, artifact `effectivePeriod`, each able to fail alone), not `flip-snapshot`; it is descriptive (exit 0) and routing stays a workflow edit. (See ADR-074 d14.)
**Why.** cms2/cms130/cms165 were gated but could not run, because the runnable set came from the authored registry. A rolling window scores a period the eCQM's steward never defined.

## ADR-071: Official-only measures use the manifest's bare id
*2026-09-01 · Accepted*

**Decision.** The catalog ids for cms2, cms130 and cms165 are the vendored manifest's bare `catalogId`, with `policyRef` and the version string keeping the CMS version (`CMS2v15`). `seedMeasureStore` deprecates a legacy versioned row (`cms2v15` etc.) once, with one `MEASURE_DEPRECATED` audit event, and only if it still carries the exact seed fingerprint (an edited row stays as a Draft); nothing is deleted. `OFFICIAL_MEASURE_SEMANTICS` gains `cms130` and `cms165` (numerator ⇒ COMPLIANT).
**Why.** The official executor requires the requested id to equal the manifest's `catalogId`. An alias layer would have to be applied on every read, filter, upsert and rerun to protect data that did not exist.

## ADR-070: The Maui patient pilot becomes the spearhead
*2026-08-30 · Accepted*

**Decision.** Milestone M-M, the Maui pilot (a primary-care group on WebChart entering an MSSP ACO for PY2027), is the spearhead; the plan is `docs/ROADMAP_2026-08-30.md` and the locked set is `LOCKED_DECISIONS.md` §4A. The milestones deliver a sandbox; the production/PHI phase is a separate `PRODUCTION_READINESS`-gated decision.
d1. M-M supersedes M-E1 (deferred, not cancelled). Cheap-first: MM-0 (second deployment, patient terminology, status-chip drill-downs, sandbox accounts, primary-care roster, MIPS↔CMS crosswalk) before externally blocked work.
d2. The catalog is the ACO's computable set: CMS122, CMS2, CMS165, CMS125, CMS130, plus CMS137 only if Quality ID 305 survives and after a multi-rate spike. No known-unverified measure is routed to the pilot, and PY2027 needs a re-vendor and re-gate. (Since ADR-072/ADR-078: official-only onboarding is built and the sandbox routes all six.)
d3. Cards resolve, not alert, inside ADR-067's refusals: order suggestions only on APPROVED terminology mappings; an offered order is a proposal that never changes compliance (the gap closes when the result arrives and CQL re-evaluates); exceptions are structured data the measure reads next run.
d4. The versioned compliance API is demoted to a kept, served surface; the integration contract is the card/CDS surface plus the Maui deployment, and no work is justified by the API alone.
d5. Naming: repo documents say "Maui" and "the pilot group" only, with no client-side names or client documents; pilot accounts are pseudonymous; source materials stay local-only and gitignored.
**Why.** Five of the ACO's six EMR-computable measures were already vendored and MADiE-gated, and the pilot's quality staff need panel-centric work lists and cards that close gaps rather than raise alerts.

## ADR-069: Population membership follows the CQM IG formulas per subject
*2026-08-25 · Accepted*

**Decision.** `normalizeMembership` applies the CQM IG (`hl7.fhir.uv.cqm` v1.0.0) subject-based membership formulas to each subject's flags, so the existing score arithmetic `numer / (denom − denex − denexcep)` becomes exact without changing.
d1. Two stages: subset clamps (`numer/denex/denexcep ⊆ denom ⊆ ipp`) stay alerted, since a violation means an unreadable writer. The IG interaction folds are silent: `numer := numer ∧ ¬denex ∧ ¬numex`; `denexcep := denexcep ∧ ¬denex ∧ ¬numer_RAW`, using the raw (subset-clamped) numerator, not the NUMEX-folded one.
d2. The fold is per subject, not at the score, verified over all 64 flag combinations. Population counts still report populations as evaluated (DENOM includes DENEX'd subjects).
d3. NUMEX (`numerator-exclusion`) is an input folded into `numer` in both evidence shapes, not a reported population in `PopulationMembership`. A results array with only `numerator-exclusion` is still an unreadable writer (alert, `null`, status-rule fallback).
d4. The formulas are pinned verbatim in `src/fhir/cqm-membership-formulas.test.ts` with an independent in-test oracle.
**Why.** Marginal arithmetic matches the spec only if per-subject flags already encode the interactions. Ours did not (a score could exceed 1.0, NUMEX was skipped), though no current writer emits those combinations.

## ADR-068: A hand-authored OpenAPI document for the promised API only
*2026-08-17 · Accepted*

**Decision.** WorkWell serves a hand-authored OpenAPI 3.1.1 document for the promised surface only, guarded by a routed-path contract test and a Redocly lint. Adding a route to that surface means adding it to the document, or CI fails.
d1. `GET /api/v1/openapi.json`, built by `backend-ts/src/openapi/spec.ts`; public (PERMIT).
d2. Scope: `/api/v1/compliance`, the three `/cds-services` operations, the document itself, health and version (seven operations). Internal `/api/**` routes are excluded, and the document says so.
d3. Hand-authored (no zod, `@hono/zod-openapi` or TypeSpec), with the contract test as its required other half.
d4. Every documented `(path, method, status)` must be produced by a real request through the worker (else `documented but NOT ROUTED`); the reverse direction covers only statuses some probe produces.
d5. Redocly lints it in CI: top-level version pinned, telemetry off, no ignore file; remaining warnings are explained in `spec.ts`.
d6. OpenAPI 3.1.1, not 3.2 (renderers silently treat 3.2 as 3.1).
d7. The reference page is hand-rolled and public at `frontend/app/api-docs`, with a copyable `curl` instead of a try-it console.
**Why.** The repo claimed an OpenAPI document it did not serve and omitted the one contract it does. Hand-authoring avoids new dependencies, and the contract test catches drift.

## ADR-067: CDS Hooks cards render finished evaluations, via our own mapping
*2026-08-17 · Accepted*

**Decision.** The worker serves CDS Hooks as a spec (no `cqf-fhir-cr` at runtime); cards render persisted outcomes and never trigger an evaluation.
d1. One service, `patient-view`.
d2. Cards render outcomes of a FINALIZED run only; a card is as fresh as the last run.
d3. No `prefetch` is declared (`usageRequirements` says so); `fhirServer`, `fhirAuthorization`, `prefetch` are ignored.
d4. An absence is an `info` card (including an unresolved id); an empty list means evaluated and compliant.
d5. `critical` and `systemActions` are never emitted; `critical` cannot be represented in the card type.
d6. Suggestions only where the order code has an APPROVED terminology mapping (read from the store). The card predicate (`dispositionFor(...) === "OPEN"`) and proposal predicate (`AT_RISK`) must stay one set; a test pins it.
d7. The outcome-to-card mapping is ours (none is published), recorded as local in `STANDARDS_CONFORMANCE.md`.
d8. Discovery is public; invoke and feedback need `ROLE_MCP_CLIENT`, `CASE_MANAGER` or `ADMIN` via explicit rules (non-`/api` paths otherwise permit).
d9. Auth is WorkWell's bearer token; the spec's JWT profile is a named gap.
d10. Feedback needs no schema change: `card.uuid`/`suggestion.uuid` derive from `(runId, subjectId, measureId)` and are recorded verbatim.
d11. A failed evaluation (`evaluationError`) gets an `info` "could not be evaluated" card with no suggestion.
d12. Suggested resources reference the hook's `patientId`, not the internal subject id.
d13. Feedback fails loudly (503 with `recorded`/`of`) and is bounded (100 entries, 8,000-char `userComment`).
**Why.** CDS Hooks is plain JSON over HTTPS the worker can serve without Java; WorkWell is supplementary to WebChart, so it informs but never blocks an encounter or changes a chart itself.

## ADR-066: Docs split into a maintained guide and a dated archive
*2026-08-10 · Accepted*

**Decision.** Documentation is split into a maintained explanatory guide and a dated archive of records.
d1. `docs/guide/` is the maintained explanation: ten chapters, each with a mermaid diagram. Updating the affected chapter is part of every PR's Definition of Done.
d2. Volatile numbers (test counts, gate counts, routing state) live only in chapter 9, each with its date and reproducing command.
d3. *Superseded 2026-09-23 (owner): `docs/archive/` was deleted; git history is the archive, and finished work is deleted rather than moved.* `OFFICIAL_TESTCASE_REPORT_2026-07.md` stays in `docs/evidence/` because CI regenerates it.
d4. `CQF_FHIR_CR_REFERENCE.md` leaves the always-loaded set.
**Why.** A doc that explains and a doc that records go stale at different speeds. Mixing them left explanation scattered and records posing as explanation.

## ADR-065: Authored regulatory measures are verified by traceability and adversarial tests
*2026-08-07 · Accepted*

**Decision.** An authored regulatory measure with no external oracle is verified by a traceability document plus boundary and adversarial test cases, and packaged so an organisation could steward it. The first is OSHA 1910.95 standard threshold shift (`docs/measures/OSHA_1910_95_STS.md`). This shows the measure computes what we read the CFR to require, not that the reading is right, and `STANDARDS_CONFORMANCE.md` says so.
d1. The CQL author also writes the test cases, which is normal for a measure nobody else defines; the deliverable is a measure that could be stewarded.
d2. Scope is one obligation, STS detection `(g)(10)(i)`; the traceability doc lists the other 1910.95 obligations as not implemented, with reasons.
d3. Where the regulation is discretionary, refuse rather than default silently: no age correction (stated visibly), and incomplete data yields `MISSING_DATA`.
d4. Determinability is asymmetric: a positive STS is definitive from one ear, while a negative finding needs both ears complete.
d5. Thresholds use real LOINC codes from panel 89015-2; the cohort uses ICD-10-CM Z57.0 as a documented proxy for noise exposure, with employer assertion accepted.
d6. It is NOT in the measure registry (so not in `RUNNABLE_MEASURE_IDS`); it is verified through `evaluate({ elm, metaOverride })` because the synthetic corpus cannot produce its data.
**Why.** OSHA publishes regulations, not computable artifacts, so no external oracle exists. Adversarial cases found real under-detection bugs that would have inflated the apparent compliance rate.

## ADR-064: One shared UCUM validator for every CQL translator
*2026-08-05 · Accepted*

**Decision.** Every CQL-to-ELM translator passes a UCUM service to `LibraryManager` (its fourth argument), so CQL with quantity literals translates.
d1. One validator in `src/measure/ucum.ts`, shared by the runtime translator, `scripts/compile-measures.mjs` and the conformance harness. `compile-measures` therefore runs under `node --import tsx`.
d2. It does not live in `@work-well/measure-engine`, which executes pre-compiled ELM and never translates.
d3. A UCUM grammar plus an atom/prefix table (`METRIC_ATOMS`, `NON_METRIC_ATOMS`), not a new dependency. It refuses unrecognised atoms; a false rejection is fixed by adding the atom. `mg/kg/d` is valid UCUM, and a test pins it.
d4. The old behaviour stays reachable as `NO_UCUM_SERVICE` so the regression test can show it failing.
**Why.** The default UCUM service throws, so any unit-bearing CQL failed to translate (including in the Studio's ELM Explorer), yet no committed measure used a unit and every gate stayed green. Rejecting unknown units gives the author a visible error instead of a wrong number later.

## ADR-063: Packages are verified by packing and consuming the tarball
*2026-08-05 · Accepted*

**Decision.** A package is publishable when its packed tarball installs and runs outside the workspace. The scope is `@work-well/*` (amended 2026-08-06: npm refuses the `@workwell` org because an unrelated unscoped `workwell` package exists).
d1. Packages build to `dist/`; `publishConfig` repoints `exports`/`types`/`main` at `dist/` at pack time only. That is a pnpm feature, so pack with pnpm, not npm. In the tree, `exports` still names `src/index.ts`.
d2. `scripts/verify-publish.mjs` (`pnpm verify:publish`) packs tarballs, installs them with plain `npm install` in a temp dir, runs the engine on `example-consumer`'s content and typechecks a TS consumer against the packed declarations. It is CI's `packages` job on every PR.
d3. Publishing is manual: `publish-packages.yml` is `workflow_dispatch` only, defaults to a dry run (which does not exercise the token), and refuses without `NPM_TOKEN`.
d4. `official-executor` is not published; its package boundary is the ADR-026 `fqm-execution` quarantine.
d5. Positioning: the engine composes `fqm-execution` rather than competing with it. No performance or conformance comparison is claimed.
d6. Pre-1.0 with a stricter reading than semver: removals, retypes and semantic changes take the minor; integrators pin `~0.1.0`; 1.0 waits for a consumer outside MIE.
**Why.** Inside the workspace, packages resolve from source, so nothing showed whether `files`, `dependencies` or the emitted JS work for a registry consumer. npm publishing cannot be undone (versions are never reusable), so verification must not depend on publishing.

## ADR-062: Codegen leaves the engine; an app-independent consumer proves the split
*2026-08-05 · Accepted*

**Decision.** CQL generation is split from the evaluation engine, and a consumer package that shares no code with the app shows the engine works without WorkWell's content.
d1. `generate-cql.ts` moves to `@work-well/measure-codegen`, with zero dependencies, and the engine no longer exports codegen. `src/engine/`'s allowlist admits it for `cql/codegen/generate-sql.ts`.
d2. `@work-well/example-consumer` is a test, not a sample: one dependency, its own measure (`tetanus-booster.cql` + ELM) and bundle, asserting its outcomes and that `audiogram` is unknown. It resolves the engine through `workspace:*`, so it proves a consumer outside the app, not outside the repo. Every consumer must supply `FHIRHelpers-4.0.1` in `elmLibraries` (pinned by a test).
**Why.** Codegen (authoring time) and the engine (runtime) shared a directory, not code. An import-graph assertion proves the source tree's shape, not that a consumer can use the package. `measure-engine-api.test.ts` also checks `.mjs`/`.js` under `scripts/`, since `tsc` does not.

## ADR-061: The compliance API names its evidence source and 404s on absence
*2026-08-05 · Accepted*

**Decision.** `GET /api/v1/compliance/{subject}/{measure}?start&end&mode` is a versioned contract (`docs/COMPLIANCE_API.md`) for one subject's compliance on one measure; `v1` fields are never removed or retyped. Since ADR-070 d4 it is a kept, served surface, not the contract MIE consumes.
d1. `/api/v1/` in the path, with exactly one route under it; everything else under `/api/` is internal. The generic `/api/**` AUTHENTICATED rule covers it, and a test asserts the 401.
d2. The response carries `populationsSource`, derived from the same `officialMembership` call `membershipFor` uses, so it cannot disagree with the numbers. An authored measure measures only `initialPopulation`; its other populations are inferred from status.
d3. `latest` with nothing persisted is a 404 saying which absence it is (with `pendingRuns`), never an empty 200. It serves only COMPLETED or PARTIAL_FAILURE runs and reports `runId`.
d4. `preview` routes through `routedEngineForEnv`, returns 501 on a WebChart-configured deployment, and is limited to CASE_MANAGER/ADMIN.
d5. No new evidence reader: it uses `membershipFor` and `officialReportIdentity` (`src/fhir/measure-report.ts`), and a test asserts agreement with `buildIndividualMeasureReport`.
d6. Every answered request, 404s included, writes a `COMPLIANCE_API_READ` audit event (best-effort; a failure logs loudly).
d7. `period` is the answer's measurement window; `filter` echoes the caller's bounds.
**Why.** "No run covered this subject" must never read as "compliant", and a consumer must be able to tell measured eCQM membership from status-inferred booleans.

## ADR-060: The CQL conformance harness keeps translator and engine failures separate
*2026-08-05 · Accepted*

**Decision.** `pnpm cql-tests` runs the HL7 `cqframework/cql-tests` suite through our translator (`@cqframework/cql`) and engine (`cql-execution`). It reports only if every case in the corpus lands in exactly one outcome bucket.
Decision 1 — `translation-error` is its own outcome and is never folded into `fail`. The runner has seven outcomes and reports all of them.
Decision 1b — an `invalid` case is executed when it translates. It counts as refused if it fails at translation or at runtime, which is the `cql-tests-runner` rule.
Decision 2 — cases are graded in CQL (`define Passed: Actual ~ Expected`) and run unfiltered, with no patient. This added data-free `evaluateExpressions` to the engine package. Cases compared in JS instead are counted and baselined.
Decision 3 — the SkipList is the capability set we claim, and it is empty. Adding an entry needs a PR that says why.
Decision 4 — the CI gate fails on any per-case regression against a committed baseline, keyed on `file/group/name`, that stores only non-passing cases. A move between two non-passing outcomes is reported but does not fail. A baseline in the older format is refused.
Decision 5 — ADR-048's `*-cli.ts` split is dropped because it buys nothing. `engine-boundary.test.ts` now allows `node:` based on reachability from the production request path, which is derived rather than listed, instead of on the `-cli.ts` filename.
**Why.** The published `cql-execution` results used the Java translator, so the gap in our JS translator is exactly what is being measured. Merging the two would blame the engine for translator gaps, and a threshold can stay green while passes trade places.

## ADR-059: The engine package receives measure content injected and ships none
*2026-08-05 · Accepted*

**Decision.** `@work-well/measure-engine` depends only on `cql-execution` and `cql-exec-fhir`, and it ships no WorkWell measures, ELM or corpus expansions. The app wires those in one place: `createWorkwellEngine()` in `src/engine/cql/workwell-engine.ts`. This answers the question ADR-052 left open; ADR-052's decided half stands.
Decision 1 — content is injected. The `CqlExecutionEngine` constructor requires `MeasureContent = { measures, elmLibraries, expansionFallback? }`, with no empty default, so `new CqlExecutionEngine()` is a compile error.
Decision 2 — the app's remaining content (`measure-registry.ts`, `bundled-ecqm-expansions.ts`, `elm/`) stays under `src/engine/` and does not move.
Decision 3 — `fhirNativeExecutor` and `resolveMeasureExecutor` require their engine binding. They no longer build a shared engine lazily.
Decision 4 — offline expansion requires an `expansionFallback` to be supplied, not just eCQM-shaped OIDs. Without one, a consumer gets the base library: a limited answer, not a silently wrong one.
Enforcement: `packages/measure-engine/src/package-boundary.test.ts` allows no third dependency, no `node:` builtin, no `Buffer`/`process`/`__dirname`/`require(`, and no import of WorkWell content by name. `src/engine/measure-engine-api.test.ts` allows no deep import past `index.ts` and requires every imported name to exist in `index.ts`. `engine-boundary.test.ts` stops `src/engine/` from importing `cql-execution` or `cql-exec-fhir` directly.
**Why.** No consumer of a measure engine wants WorkWell's catalog or fixtures. An empty catalog would return MISSING_DATA for everyone, with no signal.

## ADR-058: The verification bar is FHIR-column checks, not relabelling for Cypress
*2026-08-04 · Accepted*

**Decision.** QRDA III is an HQMF/QDM-identity format, and our QI-Core measures have no QDM identity, so Cypress cannot grade our documents. We do not relabel, and we do not build a QDM engine. This supersedes the "Cypress CVU+ green" bar in locked decision 2.
1. Every export's measure identity comes from the artifact that produced the outcome (reaffirms ADR-046 decisions 3 and 4).
2. A green obtained by relabelling would add no evidence and would put a false provenance claim into an outbound document.
3. The bar is a named set of FHIR-column checks (`ROADMAP_2026-08-04.md` §4), each with a stated scope and limit. Examples: the FHIR validator with the DEQM STU5 package on our MeasureReports, and cross-execution against Java `cqf-fhir-cr`. `fqm-testify` and `deqm-test-server` are not independent because both wrap `fqm-execution`.
4. A Cypress Calculation Check green is retired as a goal, and no QDM execution path will be built. Revisit only if MIE makes certification of WorkWell's engine a business goal.
5. The QRDA I/III machinery is kept as an interoperability bridge, not a certification target.
6. Supplemental data (RACE/ETHNICITY/SEX/PAYER) is deferred, not cancelled. Build it when a receiver reads it or alongside DEQM supplemental data.
**Why.** Cypress extracts nothing from a document whose measure identity is not the QDM one it holds. The QI-Core artifact has no per-population UUIDs to relabel with, and no maintained FHIR-lineage grader exists. No FHIR-column check produces a certificate, so every claim must name who graded what.

## ADR-057: The live WebChart path derives us-core-sex and the imaging mammogram Observation
*2026-08-03 · Accepted*

**Decision.** For data from a third-party WebChart FHIR server, `src/engine/ingress/webchart/normalize.ts` derives the two elements the SQL mappers add (closes ADR-042 decision 3). `us-core-sex` comes from `Patient.gender`, for `male`/`female` only; it never overwrites a server's extension and is tagged `derived-from-gender`. A LOINC imaging `Observation` comes from a `completed` CPT/HCPCS mammography `Procedure` on a two-code allowlist, matched via `codingKey`. It is skipped when a usable `24606-6` Observation exists for that subject and day. The gate is `live-official-parity.test.ts`.
**Why.** Reading a server's own `female` as not-female is also an inference, and a worse one: it silently empties official CMS125 and marks screened women OVERDUE. Deriving the elements turns a roster-wide, invisible failure into a rare individual one that an operator can review.

## ADR-056: QRDA I batch import and an import-only finalize route
*2026-08-03 · Finding (historical)*
`POST /api/runs/:id/import` groups documents into people only by shared `<recordTarget>` identifiers and reports demographic conflicts without resolving them. `POST /api/runs/:id/finalize` finalizes only a run created with `requestedScope.importDriven` in which every outcome carries `qrda1Import` evidence. A cross-lineage measure id is accepted only as an explicit, recorded `assertMeasureIdentifiers`.

## ADR-055: QRDA I import maps each QDM datatype to what the ELM retrieves
*2026-08-03 · Finding (historical)*
Each QDM datatype is imported as the FHIR type the official artifacts' ELM actually retrieves, not from a QDM→QI-Core table. `<translation>` codes become extra codings, system URLs match the vendored expansions exactly, and negated acts are skipped. After these changes the importer matched Cypress's expected populations on every patient in two archives.

## ADR-054: CMS130 and CMS165 onboarded on their first credentialed vendor run
*2026-07-31 · Finding (historical)*
Both were added to `OFFICIAL_GATED_MEASURES` and the MADiE/deploy vendor lists after one credentialed `vendor-official-measure.yml` dispatch each. Their terminology was complete and their MADiE decks were fully green. Routing was left unchanged.

## ADR-053: The vendor step reports value sets the upstream bundle never shipped
*2026-07-31 · Accepted*

**Decision.** A value set the ELM retrieves but the upstream bundle does not ship is "absent", which is different from "capped". It is detected, sourced from VSAC with the same credentialed flag, and reported by name. The MADiE gate (`runOfficialMeasureCases`) swaps in our terminology only for the OIDs the bundle does not ship; everything else still runs on upstream's. `supplementedOids` marks the measures where this happens.
Decision 1 — the vendor step compares the value sets the ELM retrieves against those the bundle ships, in one direction only, and reports the missing ones. It no longer writes a manifest that looks complete.
Decision 2 — absent value sets are not recorded in the manifest. `absentValueSets` recomputes them at runtime from the ELM and the sidecar.
Decision 3 — `--complete-terminology` completes both capped and absent sets but keeps them apart. (The old name `--complete-capped-expansions` is still accepted.) An absent set is checked only against VSAC's `expansion.total`, and an empty expansion is refused. `completion.valueSets[].reason` is written only as `absent-upstream` (with `declaredTotal: null`); a missing `reason` means capped.
Decision 4 — routing's verdict does not change. `officialRoutingProblems` now names the absent OID and says re-pinning will not fix it.
**Why.** "Complete terminology" only ever meant every code the bundle declared. A value set the bundle never declared (CMS138's tobacco screening set) was invisible and looked like an expander failure.

## ADR-052: Synthetic, ingress, immunization and CLI code are app content
*2026-07-31 · Accepted*

**Decision.** Under `src/engine/`, `synthetic/`, `ingress/`, `immunization/` and `cli/` are app content and never part of the engine package. `cql/codegen/generate-sql-cli.ts` is app-side too. ADR-059 answered this ADR's open question, whether the package ships WorkWell's measure content: it does not.
1. `synthetic/`, `ingress/`, `immunization/` and `cli/` are APP content, not package content.
2. `CORE_ENTRY_POINTS` is the published API, and app imports are checked against it. (Since ADR-059 the list is deleted. The API is the package's `index.ts`, checked by `src/engine/measure-engine-api.test.ts`.)
**Why.** Shipping the whole directory would publish our fixtures, such as the fictional employee directory `synthetic/employee-catalog.ts`, as API.

## ADR-051: QRDA I import maps documents into the unchanged engine
*2026-07-31 · Finding (historical)*
`POST /api/runs/:id/evaluate` accepts `{ measureId, qrda1 }`. `qrda1-import.ts`, with the hand-rolled `cda-parse.ts`, maps QDM entries back into FHIR for the existing engine. An unreadable document gets a 400, and untranslated datatypes are named and persisted in `evidence.qrda1Import`. QRDA I only works for measures in real terminology.

## ADR-050: QRDA Category I carries patient data, checked against the HL7 base IG
*2026-07-30 · Accepted*

**Decision.** A QRDA I is a patient-data document that the receiver recalculates from. It carries QDM entries translated from the subject's evaluated FHIR bundle and no population membership. It is measured against HL7 QRDA I R1 STU 5.3 (US Realm), not the CMS Hospital IG. This supersedes ADR-049's central claim.
1. `backend-ts/scripts/qrda-schematron-check.py` checks against the base IG by sorting Schematron findings into groups. The base-HL7 groups (`CONF:1198/3343/4509/1098/81/67-*`, plus CMS_0105–0113 and CMS_0115–0120) are our bar. Other `CONF:CMS-*` findings are Hospital-only. Anything it cannot classify counts as an error.
2. Population membership is removed. It is exported only by MeasureReport and QRDA III.
3. The Patient Data section carries real QDM entries built by `src/fhir/qdm-entries.ts`. A resource that cannot be classified is skipped, not guessed, and retracted records are excluded.
4. We do not claim the CMS document template (`…24.1.3`).
5. Missing header data is filled with `nullFlavor`, never invented: an `assignedAuthoringDevice` author, the WorkWell instance as custodian, race/ethnicity `UNK`, and no `legalAuthenticator`.
6. A document without a bundle is still emitted but flagged (`conformant`/`nonConformant`). A bundle is never reconstructed from an outcome.
Roster-derived evidence (the synthesized encounter) is not re-stamped at export. The omission is stated in the section text and in `caveats`, which is separate from `conformant`.
**Why.** Category I has no place for population membership: the receiver recalculates, per §170.315(c)(2). CMS122/CMS125 are Eligible Clinician measures, so the Hospital IG is the wrong standard.

## ADR-049: QRDA I reported population membership (superseded)
*2026-07-30 · Superseded by ADR-050*
Its central claim, that QRDA I reports per-subject population membership, was wrong. Three things survive: the sha-checked measure identity (`qrdaMeasureReference`), the 409 refusal to export a run that is not finished, and the rule that a document states its own limits in prose.

## ADR-048: The CQL translator moved out of the engine tree
*2026-07-30 · Finding (historical)*
`cql-translator.ts`, the ELM Explorer's live-compile path, moved to `src/measure/`. That leaves the engine depending only on `cql-execution` and `cql-exec-fhir`. The `*-cli.ts` split it planned was later dropped (ADR-060 decision 5).

## ADR-047: A measure is onboarded only when its MADiE gate passes
*2026-07-30 · Accepted*

**Decision.** Vendoring is not onboarding. An official measure is onboarded when its MADiE deck passes in the gate, and gated, routable and routed are separate steps. (At the time CMS2, CMS68 and CMS951 passed and CMS138 failed. Of those three, only CMS2 and CMS951 are routable.)
1. Onboard exactly the measures the gate passes.
2. Do not commit a vendored but capped artifact. Measures that need VSAC completion wait for a credentialed vendor run.
3. `OFFICIAL_GATED_MEASURES` drives the gate harness, not a hardcoded pair.
4. The compared population vector includes DENEXCEP.
5. `OfficialMeasureId` is derived from the gate map (`keyof typeof MEASURES`), not from a hand-written union.
6. `officialRoutingProblems` refuses an episode-of-care measure (`populationBasis: "Encounter"`, e.g. CMS68) at construction. Such a measure is gated but not routable.
7. Nothing is routed by this change.
**Why.** A vendored artifact proves nothing; the MADiE deck does. CMS68's deck could not catch per-encounter counting, because every case has one episode, so that case is refused rather than trusted.

## ADR-046: Report canonical, improvementNotation and membership come from the outcome's evidence
*2026-07-30 · Accepted*

**Decision.** For an official-routed outcome, the MeasureReport canonical, `improvementNotation` and population membership, and the QRDA measure identity, all come from the outcome's own `evidence.official`. They never come from the environment at export time. Authored reports are unchanged. The outcomes CSV's `measureVersion` follows the same rule (`evidence.official.version`).
1. All three come from `evidence.official`, not from `WORKWELL_OFFICIAL_MEASURES` at export time.
2. `improvementNotation` comes from the human-reviewed `OFFICIAL_MEASURE_SEMANTICS` (`official-measure-semantics.ts`), not from the artifact. A routed measure with no recorded semantics emits `WORKWELL_ALERT` instead of guessing.
3. The official canonical is claimed only when the vendored artifact's `sha256` matches the outcome's `artifactSha256`. Otherwise it falls back to `urn:workwell:measure:<id>:official:<version>`.
4. QRDA III carries the official eMeasure identity, read from the vendored bundle: the version-specific UUID as `id/@extension` under root `2.16.840.1.113883.4.738`, the version-independent UUID as `setId/@root`, and `versionNumber`. If these are absent it falls back to WorkWell's urn.
5. The flip guard (`official-flip-config.test.ts`) checks the notation in the built report, not the binding table.
**Why.** A report describes the run it was built from. Labelling it from current config or a newer artifact claims a provenance that never existed. QRDA III has no notation field, so the identity is what tells a receiver the direction (cms122's numerator is poor control).

## ADR-045: Official routing is switched by a reviewed, test-gated workflow edit
*2026-07-30 · Accepted*

**Decision.** `WORKWELL_OFFICIAL_MEASURES` is set in the deploy workflow, and the self-heal reconciler carries the same value. It is never set by hand on the container. `official-flip-config.test.ts` reads the shipped value and fails on any measure that is not routable. Rollback is a one-line edit and a redeploy. A misconfiguration does not fail boot: grep for `OFFICIAL_ROUTING_MISCONFIGURED` after a deploy.
1. Flip cms125 only (cms122 waited for ADR-046). A measure whose official numerator means failure may not ship with `improvementNotation: "increase"`.
2. The flag is set in the workflow, not on the container.
3. A test parses the flag out of the deploy workflows. It asserts every id is MADiE-gated, vendored and proportion-scored, and that with the sidecar there are no `officialRoutingProblems`.
4. That test is split in two. The structural half always runs; the terminology half needs the sidecar and runs in CI's `official-cases` job.
5. `reconcile-twh-mieweb.yml` ships the same value as the deploy workflow, and a test asserts it.
6. Capped expansions are excused only when the working tree is capped (PRs without the VSAC secret).
7. Every workflow `run:` block is syntax-checked with `bash -n` by `.github/scripts/workflow-run-blocks.test.sh`, which has a minimum-block floor.
8. The test does not pin which measures are flipped, only that whatever ships is routable.
**Why.** A flip changes what the compliance engine is, so it must be reviewed and revertable. A reconciler carrying a different value would silently change routing during self-heal.

## ADR-044: Mammograms are dual-stamped for both engines; flip-snapshot compares engines before a flip
*2026-07-30 · Accepted*

**Decision.** The WebChart SQL→FHIR crosswalk emits each screening mammogram both as its CPT/HCPCS `Procedure` and as a derived LOINC `24606-6` imaging `Observation`, so authored and official CMS125 both see it. `pnpm flip-snapshot` is the pre-flip comparison tool.
1. The crosswalk dual-stamps. The Observation has `category ~ imaging` and `status = final`, and is emitted in both `wcdb-fhir-shim/src/fhir-mapping.ts` and `backend-ts/scripts/webchart-devdb-export.ts`.
2. The Observation is served from `/Observation`, and `/Procedure` is untouched.
3. This is normalization, not fabrication: it comes only from a real row, keeps that row's date, and uses an explicit code allowlist. It is non-inflating only because both numerators are `exists(...)`; it is not safe for counting or most-recent-value measures.
4. The flip gate gets a command, `pnpm flip-snapshot`.
5. `--source live` reads the configured tenant (`WORKWELL_WEBCHART_*`) and refuses if that is unset. The committed sample is `--source fixture`.
6. `--source live` requires `--roster` and refuses a roster that enrolls nobody.
7. The report names its source for every measure. The default, `--source synthetic`, is five designed probes, not a roster forecast.
8. The official side is evaluated batch-then-fallback, the same way a run does it.
9. The snapshot gives a verdict (including INCONCLUSIVE) but gates nothing, and it exits 0.
**Why.** Official CMS125 reads only LOINC imaging Observations. A WebChart CPT mammogram therefore marked a screened woman OVERDUE and escalated her case to HIGH, and nothing detected it.

## ADR-043: A whole roster outside the population is warned, never refused mid-run
*2026-07-30 · Accepted*

**Decision.** When an officially routed measure puts a whole multi-subject roster outside its initial population, the run keeps the outcomes and their evidence and logs a `WARN`. The run is never failed. Enforcement happens at the flip gate instead.
1. The executor reports and does not refuse: `evaluateBatch` returns the out-of-population outcomes with evidence intact.
2. The run pipeline writes a best-effort `WARN` to `run_logs` that names both possible causes. It is decided after the evaluation loop from the final per-subject outcomes, not in the batch pre-pass.
3. Only officially routed measures are checked, meaning `logicVersionFor` returns `official-fqm:…`. `undefined` membership means unknown.
4. The check applies only to more than one subject (`> 1`).
5. Enforcement is at the flip gate: `devdb-official-eval.test.ts` plus the DEPLOY.md pre-flip step (step 2), which confirms a non-zero initial population on the tenant's own data.
6. cms122's official routability depends on the stack. It works on the synthetic roster and is useless on WebChart-configured staging, and it stays in the flip list.
**Why.** An empty initial population can be the correct answer for some cohorts, and cohorts change from run to run. A runtime refusal would corrupt valid runs with a false positive the operator cannot fix.

## ADR-042: Close the WebChart–official population gap by mapping, not refusal
*2026-07-30 · Accepted*

**Decision.** WebChart data gets the `us-core-sex` element official CMS125's initial population reads, and official routing over it is guarded by a per-subject parity test, not a startup refusal. ADR-057 later reversed decision 2 for the live third-party path.
1. Emit `us-core-sex` from WebChart `patients.sex` alongside `Patient.gender`, as the SNOMED concept id (the ELM compares against `248152002`, so an extension carrying "F" reads as absent). Change both mapping sites together: `wcdb-fhir-shim/src/fhir-mapping.ts` and `backend-ts/scripts/webchart-devdb-export.ts`.
2. Assert `us-core-sex` only where the source system records a sex value; `normalizeWebChartBundle` does not synthesize it from a third-party server's `gender`, so such a roster reads out-of-population for CMS125 (fail closed).
3. No construction-time refusal keyed on `WORKWELL_OFFICIAL_MEASURES` and the WebChart seam both being set.
4. The guard is a live-path parity gate (`devdb-official-eval.test.ts`): official vs authored outcomes per subject over the committed fixture through `evaluateBatch`, asserted as a divergence map (empty = routing is inert for this data).
5. A separate test strips the extension and asserts official collapses to all MISSING_DATA while authored is unaffected, pinning the cause by removal.
Consequence 3 (the mammography numerator gap) was closed by ADR-044 and ADR-057; consequence 5 (none of this reaches a live third-party WebChart server) was surfaced by ADR-043 and closed by ADR-057.
**Why.** A predicate keyed on "both env vars are set" stays true after the mapping is fixed, so it would refuse a correct configuration; the cms125 initial-population gap was one missing field.

## ADR-041: Complete VSAC-capped official expansions at vendor time, pinned, or not at all
*2026-07-29 · Accepted*

**Decision.** A value set upstream ships capped at 1000 codes is completed from VSAC only at vendor time, into the hash-pinned terminology sidecar; the runtime never falls back to VSAC. Any failure leaves upstream's codes as shipped, the manifest keeps its `truncated` entry, and routing keeps refusing the measure.
1. Completion runs in `vendor-official-measure.mjs` behind `--complete-capped-expansions`; the sidecar stays the only terminology the runtime reads, pinned by SHA-256 in the committed manifest.
2. Only OIDs upstream actually capped are re-expanded; every other value set comes from the bundle unchanged.
3. Expansions are pinned to `Library/ecqm-fhir-update-2025`, never VSAC's latest-active.
4. Completed codes are deduped and sorted by `system|code` in code-point order before writing, because byte order is part of the hashed artifact.
5. Every failure (no flag, no key, VSAC unreachable after a bounded retry) warns and returns; `truncated` is recomputed from the codes actually present.
6. A VSAC expansion that is short of the declared total (counted after dedupe), or that does not contain every upstream-shipped code, is rejected rather than merged.
7. The vendor-time credential is its own secret, `WORKWELL_VSAC_API_KEY_VENDOR`, separate from the runtime `WORKWELL_VSAC_API_KEY_TWH`.
**Why.** A half-expanded exclusion set does not error; it silently leaves subjects in the denominator. The cap is upstream licensing policy, so waiting will not fix it.

## ADR-040: The engine declares its logic identity; the cache never infers it
*2026-07-28 · Accepted*

**Decision.** For an officially routed measure, the incremental-evaluation cache takes `logic_version` from the engine rather than hashing WorkWell's authored ELM. Official-routed outcomes are currently written to `eval_state` but never reused.
1. `RoutedEngine` has an optional `logicVersionFor(measureId)`: the artifact identity for a routed measure, `undefined` (meaning authored) otherwise. The cache consults it first and falls back to the ELM hash.
2. The identity travels on the engine object, not as a separate `RunPipelineDeps` field each caller must remember to pass.
3. The identity is a readable composite, `official-fqm:<version>:<artifactSha>:<terminologySha>`, disjoint by prefix from the authored `sha256:<hex>`.
4. The terminology digest is part of the identity, since a re-fetched sidecar can change outcomes with the bundle unchanged.
5. An official-routed outcome is reusable only on its own evaluation date; `computeNextTransition`'s authored-terms rules (PERMANENT, boundary tables) never apply to it.
6. For now an official-routed outcome is not reused at all, because `logic_version` does not cover adapter code that changes answers. Rows are still committed (write-only). Exit: the identity gains an adapter digest, or the adapter stops changing; re-enabling is deleting one branch in `plan`.
7. Officialness is decided once in `plan` and carried to `commit` on the required field `EvaluatePlan.engineDeclaredLogic`.
**Why.** Otherwise the cache would copy authored outcomes forward for a measure now running official CQL, and a reused outcome looks exactly like a computed one.

## ADR-039: The shadow diff evaluates exactly what the runtime evaluates
*2026-07-27 · Finding (historical)*

**Decision.** The literal diff (`standards/literal-diff.ts`) now uses the runtime's own measurement period, plain bundle, copy-preparation, `officialMeasureSemantics` and `outcomeFromPopulations`, is offered for any vendored measure, and memoizes by `measureId|runId`; the subset tier stays cms122-only and the fidelity lab keeps its enrichment.
**Why.** The diff had used a different period and enriched inputs, so it forecast divergence the flip would never produce.

## ADR-038: Corpus codes are verified against the official artifact's terminology
*2026-07-27 · Finding (historical)*

**Decision.** Every code the synthetic corpus stamps must be a member of the official expansion of the value set it is registered under (`CANONICAL_CODE_VALUE_SETS`, checked by `wiring/corpus-membership.test.ts`), one constant per value set; the corpus dual-stamps (CPT Procedure plus LOINC Observation mammogram; `gender` plus `us-core-sex`) and may author a Condition onset, while preparation and `stampEnrollment` may not.
**Why.** 12 of 24 corpus codes sat in the wrong value set, invisible because one table supplied both the stamped code and the offline expansion.

## ADR-037: Prepare bundles for QI-Core by normalization, never fabrication
*2026-07-27 · Accepted*

**Decision.** Official execution passes bundles through one QI-Core preparation, `wiring/qicore-preparation.ts`, which normalizes structure but never invents clinical facts. Harness-local code enrichment for the diff must never move into the runtime.
1. One preparation function, used by both the literal diff and the runtime executor.
2. The runtime prepares a copy, so the authored engine's outcome is byte-identical whether or not official routing is on.
3. Normalization, never fabrication: no invented `onsetDateTime`; `clinicalStatus`/`verificationStatus` are replaced only when no coding in them names a system; `category` and Encounter `class` are filled only when absent.
4. The literal diff uses the artifact's own terminology (ADR-036) with no fallback; without the sidecar, `literalDiffAvailable()` is false and the route degrades to the subset tier, visibly in its `mode` field.
5. Both deploy workflows (production and staging) vendor terminology into the build context. A missing sidecar is not fail-soft; the fetch retries transport errors and 5xx with backoff but never a 4xx.
**Why.** QI-Core retrieves are stricter than our plain FHIR (unprepared synthetic bundles put nobody in the initial population), but synthesizing clinical data at evaluation time would be fabrication.

## ADR-036: Official terminology is the artifact's own, fetched at build and hash-pinned
*2026-07-27 · Accepted*

**Decision.** Officially routed measures expand value sets only from the artifact's own expansions, written at vendor time to a gitignored sidecar and pinned by hash in the committed manifest. Our VSAC import (`pnpm resolve-valuesets`) has no role in official execution.
1. `vendor-official-measure.mjs` writes the expansions to `measures/official/<catalogId>/terminology.json` at the same pinned upstream commit as the ELM.
2. The sidecar is fetched at build and never committed (licensed CPT/SNOMED content in a public repo).
3. The committed `manifest.json` records the sidecar's SHA-256; a sidecar that does not match is refused at load.
4. The expander is keyed by measure, not by a flat OID map.
5. The MADiE reduction check runs the reduced artifact plus its own sidecar through the same `expandArtifactTerminology` the router uses, and records which terminology mode ran.
6. A missing sidecar refuses routing (`officialRoutingProblems`) as one build step naming the fix (`pnpm vendor:official`).
7. A VSAC-capped expansion of a value set the measure's ELM actually retrieves also refuses routing (completion: ADR-041).
**Why.** fqm treats an unexpandable value set as empty, which silently reads every subject out-of-population, and the gate had validated a terminology path production never took.

## ADR-035: Incremental evaluation is an opt-in cache that never changes answers
*2026-07-24 · Accepted*

**Decision.** With `WORKWELL_INCREMENTAL_EVAL=true`, the live-tenant pipeline may skip re-running CQL for a subject whose data and logic are unchanged. Reuse decides only whether to re-ask the engine; any uncertainty is a miss and a full evaluation. The parity suite (`run/incremental/parity.test.ts`) is the acceptance bar. Official-routed measures follow ADR-040.
1. Reuse the evaluation, never skip the outcome row: a reused subject gets a copy-forward row (prior status, date-corrected evidence, new run id).
2. Two tiers: `data_hash` + `logic_version` gate reuse; `next_transition_at` extends it across days only for measures whose status is a monotone step function of days-since-event, with the threshold table golden-verified against the real engine. Seasonal `flu_vaccine` and period-based `cms122`/`cms125` get same-day reuse only.
3. Copy-forward evidence advances each `"Days Since …"` define by the elapsed days.
4. Inert unless configured, and scoped to `finishManualRun`; the scale batch path and default stack never write `eval_state`.
5. `eval_state` is a pure cache, reversible with `DELETE FROM eval_state`.
Also binding: a backdated run (`evalDate < source_eval_date`) always re-evaluates, and `logic_version` hashes the executed library plus the referenced value sets' `expansion_hash`.
**Why.** Most of a recurring population run recomputes answers that cannot have moved.

## ADR-034: The WCDB FHIR shim is a standalone package that owns the MariaDB driver
*2026-07-20 · Accepted*

**Decision.** `wcdb-fhir-shim/` is a standalone dev/demo package: a FHIR R4 facade over the WebChart MariaDB dev database plus a compliance API that runs generated SQL. `mysql2`, `yaml` and runtime `tsx` are approved for this package only; backend-ts stays driver-free. CQL→SQL generation (`generateSql`) is pure templating in backend-ts, committed as reviewed, freshness-tested `.sql` in `wcdb-fhir-shim/sql/`; wiring SQL into the app still needs per-measure golden parity (ADR-025). The shim is never deployed, has no auth, holds synthetic data only, and never sets compliance. Its YAML ingest CLI is transactional, reversible only via its `<file>.ingested.json` manifest, limited to local `wc_*` targets, and logged to an append-only `ingest-audit.log`.
**Why.** Doug asked for our own FHIR facade and for SQL running against WebChart itself, while backend-ts is deliberately driver-free and the executor port is bundle-in and DB-less.

## ADR-033: Inject a schema-free live WebChart directory into population read models
*2026-07-17 · Accepted · number assigned 2026-09-23: this record lost its heading inside ADR-034 on 2026-07-20 and was restored as ADR-033*

**Decision.** Live WebChart subjects are named through a per-worker, atomically replaced last-known-good registry of identity profiles (`wc|Patient.id`, name, birth date, fixed `wc`/`WebChart`/`wc-provider-1` placement), not a new table; clinical bundles are never cached. Each population read loads its outcome rows and builds one `directoryForRows(rows)` snapshot (static catalog, registry, and a minimal profile for unknown `wc|` ids) used for the whole operation. A successful population fetch replaces the registry; a failed fetch aborts the run before any outcomes, and read models ignore FAILED runs. `wc|` CASE reruns return a non-mutating 409.
**Why.** Outcomes carry only subject ids, so the static directory dropped live subjects from every read model, and a persisted directory would need owner-gated DDL and could make stale data look current.

## ADR-032: A local HAPI FHIR server stands in for WebChart
*2026-07-16 · Accepted*

**Decision.** The official `hapiproject/hapi` image (R4, port 8081, in `infra/docker-compose.yml`) is the local WebChart simulator, loaded from the committed dev-DB fixtures by `pnpm load:hapi` (`hapi-transform.ts`: `PUT` with preserved patient ids and deterministic minted ids, so reloads are idempotent). HAPI stays unauthenticated. HAPI proves real-HTTP behaviour locally and in CI; the teatea trial proves real auth and live-instance behaviour.
**Why.** The live transport had only run against in-process shims, and the remote trial is read-only and rate-limited by courtesy, so it is unsuitable as a dev/CI target.

## ADR-031: MeasureReport counts use membership labels and per-measure semantics
*2026-07-15 · Accepted*

**Decision.** Exports treat populations as membership labels: exclusion members stay in DENOM and subtract only in the score. Since the 2026-07-24 amendment, `membershipFor(outcome, measureId)` uses `evidence_json.official.populationResults` verbatim when present and falls back to the status rule in point 2; `denominator-exception` is emitted and subtracted in MeasureReport and QRDA III only when non-zero; `populationCountsFromStatus` stays authored-only.
1. `countPopulations`, the status-histogram path, individual memberships, the FHIR score and the QRDA rate all use `DENOM = IPP`; `EXCLUDED` counts in both DENOM and DENEX; the score denominator is `DENOM - DENEX`, guarded above zero.
2. Per-measure export semantics live in the YAML-generated `MEASURE_BINDINGS`: every measure declares `improvementNotation` (all `increase` at the time); only `cms122`/`cms125` declare `missingDataMeansOutOfPopulation: true` (MISSING_DATA maps to all-zero populations).
3. MeasureReport claims `urn:workwell:measure:*`; switching to a CMS canonical requires changing numerator orientation and improvement notation together (guard test).
4. Add base-R4 `MeasureReport.id`, generation `date`, a contained WorkWell Organization `reporter` and `urn:uuid:*` `fullUrl`s, without claiming DEQM profiles.
Later: ADR-046 derives canonical, improvementNotation and membership together from the outcome's evidence; ADR-077 d6 puts an evaluation error in no population.
**Why.** The QM IG ballot-branch clarification counts exclusions inside DENOM, and a generic status mapping mis-counted out-of-population subjects for the CMS measures.

## ADR-030: Durable evidence storage is an app-level S3 seam
*2026-07-14 · Accepted*

**Decision.** `resolveBucket(env)` (`backend-ts/src/case/resolve-bucket.ts`) builds an S3-backed `CloudBucket` via `createS3Bucket` only when `WORKWELL_BUCKET_S3_BUCKET`, `WORKWELL_BUCKET_S3_ACCESS_KEY_ID` and `WORKWELL_BUCKET_S3_SECRET_ACCESS_KEY` are all set; otherwise the fs `BUCKET` binding serves unchanged. Region defaults to us-east-1; `endpoint` is for non-AWS S3 and switches to path-style; `createIfMissing: false`, because bucket provisioning is owner-gated. `@aws-sdk/client-s3` is an approved direct dependency. The same bucket holds the nightly schema dump from `backup-neon-nightly.yml`.
**Why.** `mieweb.jsonc` bindings are literal JSON with no env substitution, so the binding cannot carry credentials, and in-container fs storage was lost on every container recreate.

## ADR-029: Immunization forecasting uses a self-hosted ICE sidecar behind the port
*2026-07-13 · Accepted*

**Decision.** `engine/immunization/ice-forecaster.ts` is a real HTTP adapter for HLN's self-hosted ICE (`hlnconsulting/ice`), run as a long-lived sidecar, with a hand-rolled vMR codec (`ice-vmr.ts`) and no new dependencies.
1. The adapter speaks the DSS contract: `/api/resources/evaluate` and `/api/resources/evaluateAtSpecifiedTime`.
2. The seam is selected by `WORKWELL_IMMZ_ICE_BASE_URL` alone; `WORKWELL_IMMZ_ICE_API_KEY` is an optional bearer that never selects it. Unset means the simulated forecaster.
3. Any failure (transport, non-2xx, timeout, unparseable body, missing vaccine group) falls back to `simulatedForecaster` for the whole forecast, never a half-ICE mix.
4. The port's `forecast()` is async; selection lives in `resolve-forecaster.ts`.
5. Forecasts stay advisory and never set an `Outcome Status`.
Operational rules: a 3 s request timeout plus a 60 s circuit breaker; ICE's clock is always pinned (`evaluateAtSpecifiedTime`, `specifiedTime = asOf`); ICE `CONDITIONAL` is not shown as DUE; `dosesRequired` follows the CVX we report (HepB = 3). The request's `base64EncodedPayload` is an array, and a proposal's vaccine group is read from `<observationFocus>`, not `<substanceCode>`.
**Why.** ICE is self-hostable and ACIP-maintained, so the stub could be replaced without waiting on MIE; porting its rule base to TypeScript is infeasible.

## ADR-028: WebChart transport follows its verified public FHIR contract and SMART auth
*2026-07-13 · Accepted*

**Decision.** `httpWebChartClient` implements WebChart's verified contract, with auth behind a `WebChartAuthProvider` port. `isWebChartConfigured` requires `WORKWELL_WEBCHART_BASE_URL` plus either the API key or client id + private key; unset means the JSON source.
1. Population via `GET /fhir/Patient` (`link[next]` paging) plus paged per-patient `GET /fhir/{Observation|Condition|Procedure|Immunization|Encounter}?patient={id}`, composed into one collection Bundle.
2. SMART Backend Services (`smartBackendServicesAuth`: discovery or `tokenUrl` override, RS384 `private_key_jwt`, token cache, single-flight refresh, one retry on 401) when `WORKWELL_WEBCHART_CLIENT_ID` + `WORKWELL_WEBCHART_PRIVATE_KEY` are set; the static bearer `WORKWELL_WEBCHART_API_KEY` stays for fixtures, tests and proxies. Signing uses WebCrypto only.
3. Any per-resource fetch failure degrades the whole patient to the Patient-only bundle (MISSING_DATA downstream); the off-origin pagination guard covers resource searches too.
4. Pagination uses standard `_count` + `link[next]`; `Group/$export` is future scope.
**Why.** WebChart's public sandbox showed the real contract (SMART Backend Services, no `Patient/$everything`), so there was no reason to wait for MIE to restate it.

## ADR-027: Production CMS122/CMS125 ran eCQI v14 faithful-subset CQL
*2026-07-10 · Superseded by the flip (ADR-045/ADR-046)*

**Decision.** Production cms122/cms125 ran hand-authored faithful subsets of eCQI CMS122v14/CMS125v14 with committed offline VSAC expansions and dual-coded synthetic data. Production now runs CMS's own artifacts, and the subsets retire to the standards lab (#377).
**Why.** The earlier toy day-count rules could not support the claim of running real eCQMs.

## ADR-026: fqm-execution runs CMS's pre-compiled ELM, quarantined in one package
*2026-07-09 · Accepted*

**Decision.** Official measure bundles run from their shipped pre-compiled ELM on `fqm-execution` pinned to `1.8.5`, with no CQL translation. fqm is declared only in `@work-well/official-executor` and loaded through a lazy `await import`, off the worker's cold-start and request path until something calculates. Tests enforce that no other manifest declares fqm, no other source imports it, and every fqm reference in the executor entry is a dynamic `import(...)`. The CMS122 artifact is vendored from `cqframework/dqm-content-qicore-2025` at `measures/official/cms122/` with a manifest, reduced to `application/elm+json`; `measures/official/NOTICE.md` records the terms of codes embedded in the ELM. Supersedes ADR-024's "revisit when the translator matures" clause.
**Why.** Official bundles already carry ELM for every library and the only JVM-free translator release cannot compile them; the lazy boundary keeps fqm's heavy dependency tree off the request path while allowing it in production.

## ADR-025: Measure execution is pluggable behind a MeasureExecutor seam
*2026-07-08 · Accepted*

**Decision.** One `MeasureExecutor` port (`measure-executor.ts`, extending `EvaluateMeasureBinding`) is selected by `resolveMeasureExecutor(env)`. The default `fhirNativeExecutor` adapts data to FHIR bundles and runs the CQL engine; it is the correctness oracle. `sqlPushdownExecutor` is an inert stub that rejects loudly, selected only by `WORKWELL_MEASURE_EXECUTOR=sql-pushdown`. Any future SQL executor must pass per-measure golden parity against `fhirNativeExecutor` before serving. A live route switched onto this seam must pass the env-built engine, `resolveMeasureExecutor(env, await engineForEnv(env))`, or it silently loses VSAC expansion. Supersedes ADR-014's deferral.
**Why.** General CQL→SQL does not map to portable SQL and can never be the correctness authority, but a seam keeps a scoped per-measure SQL executor possible if WebChart needs one.

## ADR-024: Official CMS122 fidelity via a hand-authored faithful subset
*2026-07-05 · Superseded by ADR-026 and ADR-027*

**Decision.** Ran a hand-authored official-subset `cms122_official.cql` beside WorkWell's cms122 for a subject-by-subject diff (`execution-diff.ts`), kept out of `MEASURES` via a `metaOverride` seam, because the JVM-free translator could not compile the literal QI-Core CQL.
**Why.** ADR-026 runs the official pre-compiled ELM directly; the subset survives only as the cms122 subset tier.

## ADR-023: Live VSAC value-set resolution behind the ValueSetResolver port
*2026-07-05 · Accepted*

**Decision.** For authored measures (official ones use ADR-036), live VSAC expansion is on only when `WORKWELL_VSAC_API_KEY` is set: `engineForEnv(env)` then attaches a `CompositeValueSetResolver` that sends VSAC OIDs (bare or `urn:oid:`, normalized to bare) to `VsacValueSetResolver` over `httpVsacClient` (`$expand`, paged) and everything else to the local `StoreValueSetResolver`. Without the key, or before `value_sets` is seeded, the engine has no resolver. The keyed path builds a fresh engine and resolver per evaluation so edits are never stale, and VSAC errors propagate rather than becoming empty sets. `pnpm resolve-valuesets` (owner-run, not on deploy) upserts expansions into `value_sets` (`source='VSAC'`), audited `VALUE_SETS_RESOLVED`; the runtime does not read those rows as a cache.
**Why.** Real eCQM value sets need authoritative NLM expansion, but turning it on must not move any current measure's outcome.

## ADR-022: Cross-system identity is a read-time layer that matches but never auto-merges
*2026-07-01 · Accepted*

**Decision.** `backend-ts/src/identity/` resolves a `Person` at read time over source records grouped by a deterministic match key (a shared national/MRN identifier; with none, a record stands alone). Records spanning tenants are duplicate candidates; `mergedComplianceTimeline` unions their outcomes with a mobility annotation. Reads: `GET /api/identity/people`, `/people/:id`, `/duplicates`. Matches are suggestions; only a human links, via `POST /api/identity/people/:personId/reconcile` (`CONFIRM_LINK | UNLINK`, CASE_MANAGER/ADMIN, audited `IDENTITY_LINK_*`), stored in `person_links` as CONFIRMED or BROKEN pairs, last write wins. A component's `personId` is its smallest record ref-key. Identity never recomputes compliance or re-aggregates tenant counts.
**Why.** One person can be a patient in several systems whose records are not obviously the same, so a human must confirm links, and history must follow a person across a move.

## ADR-021: Quality over time is a materialized aggregate snapshot store
*2026-06-30 · Accepted*

**Decision.** After every population run (ALL_PROGRAMS/MEASURE) finalizes, write one `quality_snapshots` row per (measure, calendar month, scope: all/tenant/site/provider) with numerator, denominator and the five bucket counts, using `countPopulations` (numerator = COMPLIANT, denominator = IPP − EXCLUDED). The scale tenant folds in through `aggregateScaleRun`. Writes are idempotent on UNIQUE (measure_id, period, scope_level, scope_id), last write wins, audited `QUALITY_SNAPSHOT_MATERIALIZED`, and best-effort (hooked after `finalizeRun`, never failing the run). Aggregate only, never per subject; All = Σ tenants = Σ sites = Σ providers.
**Why.** Trends were recomputed live from `outcomes`, which exists only for dates a run executed and does not scale to 160k patients.

## ADR-020: Population scale via encoded subject ids and SQL aggregation
*2026-06-26 · Accepted*

**Decision.** The ~120k-subject `mhn` scale tenant exists only as `outcomes` rows whose `subject_id` encodes the hierarchy (`mhn|Lxx|Pxx|nnnnnnn`, codec in `scale-structure.ts`), seeded on demand by `pnpm seed:scale` (never on deploy) and aggregated by one SQL `GROUP BY` in `OutcomeStore.aggregateScaleRun(runId)`. In-memory rollups exclude `seed:scale` runs; the subtree stops at provider and the roster excludes it. Since 2026-07-08 the outcomes come from real batch CQL evaluation (`batchEvaluateScalePopulation`; `--mode evaluate` is the default); encoding, aggregation and rollback are unchanged. Writes are audited (`SCALE_POPULATION_SEEDED` / `SCALE_POPULATION_EVALUATED`); rollback deletes the `triggered_by='seed:scale'` runs and outcomes.
**Why.** 120k subjects cannot be materialized in app memory, so the one path that must scale is an O(providers) SQL aggregate.

## ADR-019: Multi-tenant rollup lives in the read-time synthetic directory
*2026-06-26 · Accepted*

**Decision.** A tenant/system level sits above enterprise → location → provider → patient, modeled only in the synthetic directory (`employee-catalog.ts`: `Tenant`, `tenantId` on `EmployeeProfile`/`Provider`), with no schema change. `hierarchy-rollup.ts` returns an "All Systems" root (`level:"all"`) over tenant nodes; accumulation keys are tenant-qualified so same-named nodes never merge across systems, and parent = Σ children at every level. Rollup, roster and programs endpoints take an optional `?tenant=<id>` (default all); `GET /api/tenants` feeds the selector. Tenant resolution is display and grouping only.
**Why.** Compliance from several WebChart systems must roll up into one dashboard, and outcomes persist only `subjectId`, so the hierarchy can be resolved in code without a migration.

## ADR-018: Standards fidelity started structural, deferring official-CQL execution
*2026-06-26 · Overtaken by official-CQL execution (ADR-025/ADR-026)*

**Decision.** Shipped a sourced structural fidelity report of each authored measure against the official definition (`GET /api/measures/:id/fidelity`, `backend-ts/src/standards/`) and deferred executing official CQL; `jurisdiction` became measure metadata (default `"US"`).
**Why.** The deferral is overtaken: CMS's published artifacts now execute, first diagnostically (ADR-026) and then in production.

## ADR-017: Real EHR data enters as FHIR bundles into the unchanged engine
*2026-06-26 · Accepted*

**Decision.** Data sources adapt native data into FHIR bundles through the `PatientDataSource` ingress port (`backend-ts/src/engine/ingress/`), and the existing CQL engine evaluates them; measures are not transpiled to SQL to run inside WebChart. The ingress library (`evaluateBundle`, and `evaluateBatch` with per-item error isolation) imports no DB and no `node:fs`, and the headless CLI reuses it. `resolveDataSource(env)` picks JSON by default; the WebChart source is inert unless configured (real transport: ADR-028).
**Why.** The engine was already built, parity-proven and JVM-free, while a CQL→SQL transpiler is research-grade and would fork the execution path.

## ADR-016: Segments decide applicability, never compliance
*2026-06-25 · Accepted*

**Decision.** A segment maps a cohort (a `role`/`site` predicate rule `{match: ANY|ALL, conditions}` plus per-subject INCLUDE/EXCLUDE overrides, EXCLUDE winning) to a list of measure ids; a subject's applicable measures are the union over every enabled segment they belong to. Applicability gates only case creation and display (`NOT_APPLICABLE`); CQL still evaluates and persists every outcome. The single definition is `segment/segment-applicability.ts`. With zero enabled segments every measure applies to everyone. Stored in `segments`, `segment_measures`, `segment_overrides` behind `SegmentStore`; `/api/segments` writes are ADMIN-only and audited `SEGMENT_*`.
**Why.** Risk groups change what work is created and shown, not what CQL decides, and disabling all segments must fully revert the feature.

## ADR-015: CQL is canonical; rule params compile to CQL
*2026-06-24 · Accepted*

**Decision.** CQL/ELM is the only execution and standards layer. A measure's optional YAML `rule:` block is the authoring surface for parametric measures, compiled deterministically to CQL by `generate-cql.ts` and then to ELM through the normal pipeline; a measure with no `rule:` keeps its hand-written `.cql`. Shapes: `series-completion` and `windowed-recency`, extended additively with grace (`gracePeriodDays`), titer (`allowPositiveTiter`), declination (a `Refused` define that never changes `Outcome Status`) and multi-alternative series with per-alternative CVX sets and minimum dose intervals. Absent fields yield byte-identical output, and `codegen-parity.test.ts` proves generated CQL is `Outcome Status`-equivalent to the hand-written CQL (at E11.1 there was no cutover: the hand-written `.cql` stayed the build source).
**Why.** Non-CQL authors can change thresholds through params while there is still one execution path and no second evaluator.

## ADR-014: CQL→SQL bridge recommendation, left to Doug
*2026-06-19 · Superseded by ADR-025*

**Decision.** Recommended a hybrid, FHIR-native-first approach (a real WebChart data adapter feeding the CQL engine, SQL only as a bounded parity-checked opt-in executor, no wholesale CQL→MariaDB transpiler) but left the decision to Doug.
**Why.** No decision came back; ADR-025 settled it by building the executor seam with the SQL path inert.

## ADR-013: Order proposals are advisory, deduplicated, and never auto-submitted
*2026-06-19 · Accepted*

**Decision.** `proposeOrders(outcomes, provider)` (`order/order-proposal.ts`) proposes one order per subject per measure for OVERDUE (`urgent`), DUE_SOON and MISSING_DATA (`routine`) outcomes, never for COMPLIANT or EXCLUDED, using the measure-to-code map in `order-catalog.ts`. Subjects with a qualifying standing order (from the `StandingOrderProvider` port: simulated by default, an inert EH stub only when `WORKWELL_EH_FHIR_BASE_URL` + `WORKWELL_EH_FHIR_API_KEY` are set) are returned as `suppressed`. `GET /api/orders/proposals` (CASE_MANAGER/ADMIN; `format=domain|fhir`) returns `{proposed, suppressed}` or a Bundle of `ServiceRequest` (`intent:"proposal"`, `status:"draft"`). Read-time only: nothing is persisted or submitted; a future `OrderSubmitter` is the named write path.
**Why.** Submitting orders from a compliance system without human review breaks the human-in-the-loop rule, and duplicate orders are a patient-safety risk.

## ADR-012: Immunization forecasting is an advisory port; AIS-E Td/Tdap is the measure
*2026-06-19 · Accepted*

**Decision.** The `ImmunizationForecast` port (`engine/immunization/immunization-forecast.ts`) forecasts next doses for Td/Tdap, influenza and Hepatitis B; `resolveForecaster(env)` serves the simulated forecaster by default (the real ICE adapter is ADR-029). Forecasts are advisory everywhere and never set a case or `Outcome Status`. Compliance is the separate `adult_immunization` measure (NCQA AIS-E Td/Tdap, 3650-day window; COMPLIANT ≤3590 days, DUE_SOON to 3650, then OVERDUE): contraindication → EXCLUDED, and a documented refusal stays open, flagged by a `Refused` define. `GET /api/immunization/forecast?subjectId=&asOf=` serves forecasts; case detail attaches one for `adult_immunization` cases only.
**Why.** A composite multi-series measure would have required reworking the single-event synthetic model every measure shares; splitting "is this worker current?" from "when is the next dose due?" avoids that.

## ADR-011: Outreach goes through a multi-channel port; campaigns are audit-backed for now
*2026-06-19 · Accepted*

**Decision.** `OutreachChannel` (`case/outreach-channel.ts`) supports EMAIL, SMS and PHONE with simulated adapters by default; `resolveChannel(type, env)` selects the inert DataChaser stub only when `WORKWELL_OUTREACH_DATACHASER_API_KEY` + `WORKWELL_OUTREACH_DATACHASER_BASE_URL` are set. `dispatchOutreach` is the shared send core for single-case outreach (`POST /api/cases/:id/actions/outreach?channel=`, default EMAIL) and campaigns. A campaign persists behind a `CampaignStore` port as one `OUTREACH_CAMPAIGN_COMPLETED` audit event (no DDL); a `PgCampaignStore` is the drop-in once real sends and owner-approved schema land. `POST /api/campaigns` is CASE_MANAGER/ADMIN.
**Why.** A campaign is created state and cannot be derived, but real tables were not worth adding while sends are simulated and schema is owner-gated.

## ADR-010: Provider is the attributed clinician, modeled in the synthetic directory
*2026-06-18 · Accepted*

**Decision.** The hierarchy is enterprise → location (`site`) → provider → patient, where provider is the attributed clinician strictly nested under one location. It lives only in the synthetic directory (`EmployeeProfile.providerId`, `ENTERPRISE`, `PROVIDERS`, `providerById`, `providersForLocation`), with no DB table or migration. `buildHierarchyRollup` (`program/hierarchy-rollup.ts`) is a read model over the latest population run per Active measure, served at `GET /api/hierarchy/rollup` and shown at `/programs/hierarchy`; parent totals equal the sum of children at every level. A relational org-hierarchy table would be a schema change and a fresh stop-and-ask.
**Why.** There is no `employees` table (outcomes persist only `subjectId`), so the hierarchy fits as read-time structure, and quality measures roll up by attributed provider.

## ADR-009: eCQM artifacts are emitted JVM-free; QRDA III began as a stub
*2026-06-18 · Partly superseded by ADR-058 (the QRDA III stub half; JVM-free emission stands)*

**Decision.** eCQM artifacts (FHIR MeasureReport, QRDA III) are hand-built with no FHIR/CDA runtime or Java validator, with counts from one shared `countPopulations`; that half still holds. The "QRDA III is an unvalidated stub" half is overtaken: QRDA I/III now validate at 0 findings against the HL7 base ruler (ADR-058 decision 5).
**Why.** The stack is JVM-free with a no-new-dependency rule, and the reference validators are Java tools.

## ADR-008: Re-platform the backend onto TypeScript and @mieweb/cloud, JVM-free
*2026-06-12 · Accepted*

**Decision.** The backend is TypeScript on `@mieweb/cloud` with no Java, JVM or Spring in runtime, build or authoring (done 2026-06-17; `backend/` deleted in #109 PR4). CQL stays: the pinned `@cqframework/cql` beta translates CQL→ELM in Node, ELM executes in Node, and a golden-parity harness gates every translator bump or measure change. The engine is a swappable `EvaluateMeasure` binding; a target without one raises `UnsupportedBindingError` rather than guessing a status. SQLite/D1 are the portable floor, Postgres the ceiling and system of record; FHIR bundles are transient inputs (not a FHIR server). The `evidence_json` contract, audit on every state change, case idempotency and "AI never decides compliance" carry forward; migrations stay owner-owned. Supersedes ADR-001.
**Why.** Doug (#96) required the backend to run, test and deploy without Java/Spring, and a Node CQL→ELM translator matched the Java engine exactly.

## ADR-007: Vendor the @mieweb/datavis NITRO grid source
*2026-06-11 · Accepted*

**Decision.** The `datavis` source is vendored at `frontend/vendor/datavis` (pinned to upstream `52c27cc`, matching `@mieweb/ui@0.6.1`) and aliased as `"datavis": "file:./vendor/datavis"`, with `transpilePackages: ["datavis", "@mieweb/ui"]` and a Tailwind `@source` for it; provenance and re-vendor steps are in `frontend/vendor/datavis/VENDORING.md`. Pages use the client-only `features/datavis/NitroGrid*` wrapper (`ssr:false`, local in-memory data), never `@mieweb/ui/datavis` directly. NITRO serves the operational and audit tables; small in-card tables stay semantic. Vendored code is excluded from eslint. Supersedes ADR-004's deferral of NITRO.
**Why.** `@mieweb/ui` ships the NITRO bundle but imports a bare `datavis` specifier that is not on npm, and the upstream repo is public.

## ADR-006: Measures are declared in YAML and run by a headless evaluator
*2026-06-10 · Accepted*

**Decision.** Each runnable measure is a `measures/<id>.yaml` beside its `.cql`: metadata (`id`, `name` = exact catalog name, `version`, `title`, `policyRef`, `tags`), a `cql:` file reference and `bindings:` (enrollment/waiver/event codes and value sets, `event.type: procedure|immunization|observation`, `complianceWindowDays` default 365). YAML is the only source of bindings, with no fallback; population logic and thresholds stay in CQL. A headless evaluator takes any FHIR bundle and a measure and returns the outcome plus define-level `expressionResults`: `pnpm evaluate --patient <bundle.json> --measure <id>`. Headless evidence has no `why_flagged`.
**Why.** Doug asked for a programming layer with no UI ("given this patient and this YAML file, are they compliant?"), and bindings had lived in a hardcoded switch.

## ADR-005: The measure engine reads its inputs through ports
*2026-06-10 · Accepted*

**Decision.** The engine takes its inputs through four ports (`PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider`), with the synthetic demo as the default adapter set and real-data adapters added behind the same seam. The engine core must construct and run without framework wiring, and a golden (employee → outcome) parity test gated the refactor.
**Why.** The evaluation service was hard-wired to synthetic data and a per-measure switch, which blocked real EHR data and declarative measures.

## ADR-004: Adopt @mieweb/ui as the frontend component library
*2026-06-09 · Accepted*

**Decision.** The frontend uses `@mieweb/ui` components with Enterprise Health as the default brand, a runtime brand switcher (`useBrand` loads `/brands/{brand}.css`), semantic tokens and dark mode (`useTheme` sets `.dark` + `data-theme`, persisted; status colours in `lib/status.ts` carry `dark:` variants). `@mieweb/ui` may only be imported from `"use client"` modules (boundary: `components/client-providers.tsx`). Monaco and recharts stay; `/login` and `/sandbox` stay bespoke. Tables: ADR-007.
**Why.** Doug directed WorkWell onto MIE's own component library so the work is reusable across MIE products.

## ADR-003: One all-encompassing TWH instance replaces three
*2026-05-21 · Accepted*

**Decision.** WorkWell runs as a single TWH deployment covering OSHA safety, HEDIS wellness and the CMS eCQM catalog in one seeded database, catalog, case workflow and audit trail (`WORKWELL_INSTANCE=twh`, `deploy-twh-mieweb.yml`). The separate `workwell` and `ecqm` instances were removed; the eCQM seed path and `*_ECQM` secrets are kept to restore later. Production is `https://twh.os.mieweb.org` (frontend) and `https://twh-api.os.mieweb.org` (backend), and every push to `main` deploys it. ADR-070 later adds a separate Maui pilot deployment.
**Why.** Doug clarified that occupational safety and clinical quality are one product under NIOSH's Total Worker Health framework.

## ADR-002: evidence_json keeps define-level results; the rule path is derived
*2026-05-01 · Accepted*

**Decision.** Evaluation evidence stores the CQL engine's define-level `expressionResults`; the rule path is derived at render time from define names and results and never persisted, and "Why Flagged" renders `expressionResults` deterministically first, with AI wording as optional polish. The original Java two-step `R4MeasureProcessor` flow retired with the JVM (ADR-008); the current stored and read shapes are in `DATA_MODEL_CONTRACTS.md` §5.
**Why.** An explanation must trace to what CQL actually computed, not to a separately maintained rule path.

## ADR-001: Single Spring Boot deployable with modular packages
*2026-04-29 · Superseded by ADR-008*

**Decision.** The MVP backend was one Spring Boot deployable organized by domain packages rather than microservices.
**Why.** ADR-008 retired the JVM and deleted `backend/`; the one-worker, modular-packages, no-microservices rule survives in CLAUDE.md.
