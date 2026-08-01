# Wave-2 flip gate: measures with no authored oracle (CMS2, CMS951)

Status: PROPOSAL (not yet decided). This proposal answers the open question recorded in ADR-047:
what should replace the authored-versus-official comparison when the measure is routable but WorkWell
does not have an authored implementation to compare.

## Context

ADR-047 separates three facts that had previously been allowed to collapse into one word, "onboarded":
an official artifact can be vendored, the artifact can pass the external MADiE test-case gate, and the
product can safely evaluate that artifact for a real roster. CMS2 and CMS951 satisfy the first two
facts. The current six-measure official gate reports CMS2 at 36/36 and CMS951 at 55/55, within the
278/278 total recorded by the gate. Both measures pass `officialRoutingProblems()`. Neither is named by
`WORKWELL_OFFICIAL_MEASURES`, which currently names only `cms122,cms125`.

The MADiE result is important and remains a permanent gate, but it is artifact-level evidence. The
module that runs it says explicitly that it is diagnostic-only: `backend-ts/src/standards/official-cases.ts`
does not serve the request path, worker entrypoint, engine ingress, or production run pipeline. A green
36/36 or 55/55 therefore proves that the vendored artifact agrees with the steward's expected vectors
on the steward's cases. It does not prove that WorkWell's roster produces bundles containing the
resources that CMS2 or CMS951 reads, that the run planner schedules either measure, or that cases and
reports display either measure correctly.

The current flip command cannot fill that gap. `backend-ts/src/run/cli/official-flip-snapshot.ts` creates
a `CqlExecutionEngine` at line 127, calls its authored `evaluate()` at line 130 for every subject, then
evaluates the official artifact. `CqlExecutionEngine.evaluate()` looks up `MEASURES[input.measureId]`
and throws `unknown measure '<id>'` when the lookup is absent (`backend-ts/src/engine/cql/cql-execution-engine.ts:84-87`).
CMS2 and CMS951 are absent from both the authored `MEASURES` registry and the generated
`MEASURE_BINDINGS` map. The command therefore has no authored distribution, no authored actionable
count, and no per-subject before/after comparison for either measure. This is not a weak comparison;
it is a comparison with no left-hand side.

The current verdict logic makes the problem explicit. `MeasureSnapshot` records `authoredActionable`
and `officialInIpp`; `renderSnapshot()` emits **DO NOT FLIP** when the official IPP is zero but authored
actionable subjects exist, and **INCONCLUSIVE** when both sides are empty. For an official-only measure,
`authoredActionable` would be meaningless even if a caller forced it to zero. A zero official IPP could
mean a genuinely ineligible cohort, a missing clinical resource, an unbuilt synthetic profile, or a
measure that was never scheduled. The old labels must not be retained with a fabricated authored zero.

The deeper blocker is in the run planner. `backend-ts/src/run/run-pipeline.ts:158` defines
`RUNNABLE_MEASURE_IDS = Object.keys(MEASURES)`. The `EMPLOYEE`, `ALL_PROGRAMS`, and `SITE` branches
derive their measure lists from `RUNNABLE_MEASURE_IDS` (`run-pipeline.ts:214-261`), so they would build
zero CMS2 or CMS951 work items. The direct `MEASURE` branch does something different: it validates the
single requested id against `MEASURES` and rejects it outright when it is absent. Consequently, setting
`WORKWELL_OFFICIAL_MEASURES=cms2,cms951` today would pass the router's construction-time artifact
checks but schedule no CMS2 or CMS951 work under any scope. The wave-2 flip is not merely inert on this
stack's data in the ADR-045 sense; it is currently a no-op because nothing ever evaluates either
measure.

The synthetic path has the same assumption in a different form. The request-path bundle construction
at `run-pipeline.ts:172-175` calls `deriveExamConfig(MEASURE_BINDINGS[item.measureId]!, ...)` and
`buildSyntheticBundle`. The population-scale path in `backend-ts/src/run/scale-generator.ts:42-51`
also refuses a measure without a binding before calling the synthetic builder. `MEASURE_BINDINGS` is
generated, not hand-maintained: `backend-ts/scripts/gen-measure-bindings.mjs` reads
`backend-ts/measures/*.yaml` and emits the TypeScript map. That map currently supplies synthetic event
stamping and authored fallback semantics; it is not an appropriate place to invent authored CQL for an
official-only measure.

The vendored ELM makes the data question concrete. CMS2's Initial Population is age 12 or older at the
start of the measurement period plus a qualifying encounter; its numerator uses depression-screening
Observations and, for a positive screen, a follow-up plan. CMS951's Initial Population in this checkout
requires a patient with active diabetes overlapping the start of the measurement period and an outpatient
visit during the measurement period; its numerator requires an eGFR plus either a uACR or urine albumin
and urine creatinine within four days. Those are clinical resources and clinical facts, not WorkWell
program-membership Conditions. The exact ELM inspection was done against
`backend-ts/measures/official/cms2/bundle.json` and `backend-ts/measures/official/cms951/bundle.json`.

This is why the CMS122/CMS125 WebChart findings cannot be copied forward. CMS125's known issue was
`us-core-sex` and a qualifying visit; CMS122's seed issue was absent Conditions; the mammography issue
was a CPT/LOINC representation mismatch. CMS2 and CMS951's WebChart coverage has not been measured in
this session because the run-pipeline gate has not yet been discharged. Measuring that coverage is a
required purpose of the official-only flip gate, not a fact to infer from the CMS122/CMS125 work.

Some downstream semantics are already correct and should not be reopened. `OFFICIAL_MEASURE_SEMANTICS`
has human-reviewed, `numeratorMeansCompliant: true` entries for both CMS2 and CMS951 in
`backend-ts/src/wiring/official-measure-semantics.ts`. `backend-ts/src/fhir/measure-report.ts` derives
canonical, improvementNotation, and population membership from `evidence.official` when it exists;
the `MEASURE_BINDINGS` improvement-notation fallback is used only when official evidence is absent.
The ADR-046 trio is therefore already done for these two measures. It is not a reason to add placeholder
bindings or an authored implementation.

The catalog is a separate problem. `backend-ts/src/measure/measure-catalog.ts` has `cms2v15` and
`cms951v4` entries, both Draft and NOT_COMPILED, with generic "CQL authoring pending" descriptions and
empty eligibility, exclusion, and required-data fields. The official machinery keys artifacts and
semantics on bare `cms2` and `cms951`. No direct catalog-to-official join for these two ids was found in
the backend source: the router and artifact loader use the bare routing ids, while catalog consumers
use the versioned ids. The mismatch does not currently stop construction, but it does matter to an
operator reading the Studio and to any future join.

CMS68 is excluded from this proposal in one sentence: it is an episode-of-care measure with
`populationBasis: "Encounter"`, and `officialRoutingProblems()` already refuses it because the executor
maps one population vector per subject while episode support is unbuilt.

## Question 1: evidence gate with no authored oracle

The gate must distinguish three responsibilities. Artifact validation asks whether the official package
is executable and externally checked. Data-readiness validation asks whether the target stack actually
produces and evaluates subjects. Clinical review asks whether the official evidence represents the
measure's intended branches on that stack. None of these may set or override `Outcome Status`; the CQL
official artifact remains the compliance authority, and every persisted case/run state transition remains
audit-backed.

### What the current command can and cannot claim

`flip-snapshot` already gets several mechanical details right and those should survive an extension. The
official side uses `evaluateBatch` followed by per-subject fallback, matching the run pipeline rather
than silently dropping subjects. It reports the outcome distribution, official IPP count, and subject
divergence. `official-flip-snapshot-bin.ts` makes the three sources explicit:

* `live` reads the configured WebChart tenant through the real ingress and requires a tenant-specific
  roster; it is the only current source that can answer a tenant question.
* `fixture` reads the committed 56-patient dev-DB sample and is reproducible but says nothing about a
  tenant.
* `synthetic` runs five designed corpus probes, one per intended outcome; it is an agreement/branch
  check, not the distribution of the demo/production employee directory.

For CMS2/CMS951, `live` and `fixture` can become useful only after the official-only execution path can
accept these ids. The existing `synthetic` source must not silently change meaning. A full synthetic
directory source should be added under a distinct name, such as `synthetic-directory`, so a report cannot
be mistaken for the five-probe structural check.

### Options

#### Option 1: MADiE plus the existing construction-time routing checks

This option treats the 36/36 and 55/55 MADiE gates, the vendored artifact, terminology pin, scoring type,
population basis, semantics table, and `officialRoutingProblems() === []` as the complete flip gate.

**Pros.** It uses the project's external answer key, is reproducible in CI, keeps the official-first
posture, and requires no new product-surface tool. It correctly establishes that the artifact is not an
unvalidated local rewrite.

**Cons.** It proves nothing about WorkWell's roster, synthetic bundle generation, WebChart mapping, run
planning, or case presentation. It would license a flag that currently creates no run work items. It
also cannot distinguish a zero-IPPs cohort from a missing Observation, Condition, or Encounter. ADR-047
already rejected this as the whole answer, so accepting it here would merely rename the open question.

#### Option 2: author a minimal diagnostic CQL oracle for each flip

This option creates a small, non-production authored implementation for CMS2 and CMS951 solely to
restore the dual-engine comparison. It would be labelled diagnostic and never become the compliance
authority.

**Pros.** It restores the existing `DO NOT FLIP`/`INCONCLUSIVE` shape, exposes per-subject divergence,
and can be run over the same bundles and the same source modes as the official side.

**Cons.** This directly contradicts the current-focus framing in `CLAUDE.md`: self-authored CQL is the
product value only where no official definition exists, specifically the occupational/OSHA and
HEDIS-insight work, while CMS2 and CMS951 already have official definitions. Authoring a second
implementation for either measure would invert that principle rather than extend it. It would also create
an ongoing maintenance obligation whenever CMS updates the measure, without a CMS or NCQA stewardship
relationship of the kind contemplated for occupational-measure stewardship. Finally, the hand-authored
oracle would need its own validation story: nothing certifies that it represents CMS2/CMS951 intent, so
it would need a MADiE-style external check or at minimum documented clinical review. Once that check exists,
maintaining the second implementation buys little over reviewing the official artifact's own MADiE result
directly. The proposal rejects this option.

#### Option 2a: independently-authored expected vectors over designed bundles

This option adds a small set of hand-designed bundles whose expected population results are written in
advance from the clinical facts, without deriving them from the official artifact's implementation. The
official artifact's actual output is compared with those expected vectors.

**Pros.** It is a narrower and cheaper independent check than a full parallel measure. A handful of
designed positive, negative, exclusion, and missing-data cases can establish concrete expectations for
important branches without creating a second production implementation.

**Cons.** It still requires a reviewer to derive each expected answer independently and to maintain the
cases as the official measure and terminology evolve. It covers only the designed bundles, not the full
live or synthetic roster, and therefore cannot replace review of real official-only output. It is useful as
an optional complement to Option 4's sign-off packet, not as its replacement.

#### Option 3: use distribution, time-series, or external epidemiology as the replacement oracle

This option treats the official COMPLIANT/OVERDUE/EXCLUDED distribution, changes over repeated dates,
and an expected prevalence range as the flip decision. A large shift or implausible rate would stop the
flip.

**Pros.** It works without authored CQL, is cheap to repeat, and can catch an accidental all-compliant,
all-overdue, or all-out-of-population result. It is useful as a regression alarm after the first run.

**Cons.** WorkWell has no external subject-level ground truth for these measures. A plausible depression
screening or kidney-evaluation rate can still be caused by the wrong resource shape, a wrong value set,
or a missing cohort. A distribution can show that something is unusual; it cannot prove that the
official evidence is correct or that the roster is complete. It must remain a diagnostic signal, never a
pass/fail gate and never a substitute for evidence review.

#### Option 4: official-only measurement plus a human review packet

This option extends `flip-snapshot` to detect the absence of an authored counterpart and to run only the
official artifact. It combines the MADiE/artifact floor, source-specific official coverage, distribution
sanity checks, and a deterministic human-review packet containing official population results and the
FHIR resources that support them.

**Pros.** It measures the path that will actually run, works for both synthetic and live stacks, does not
invent a second compliance engine, and gives a clinical reviewer a bounded evidence-review responsibility
without making the reviewer or the tool authoritative over `Outcome Status`. It turns the current
"nothing to compare" fact into a visible report rather than a fabricated zero. It preserves ADR-043's
separation between runtime result reporting and the human flip decision.

**Cons.** It is slower and less mechanically decisive than a dual-engine comparison. Human review is
subject to sampling error and requires a reviewer who can inspect FHIR and the measure's plain-English
case descriptions. It cannot establish correctness for every possible FHIR combination, and it does not
remove the need for the permanent MADiE gate or the later QRDA/Cypress verification bar. Option 2a can
strengthen the packet with a few independently reasoned expected vectors, but it does not close this
assurance gap for the full source.

### Recommendation

We recommend Option 4. Option 2a may add a small set of independently reasoned expected vectors to the
review packet, but it does not replace review of the official-only source output. The official-only report
should replace the current authored verdict path with an explicit, non-authoritative state machine and a
reproducible review protocol:

1. `BLOCKED` is emitted whenever any prerequisite or completeness check fails. The report must name the
   failed check and preserve its output:

   * Run `pnpm test:official-cases` for the requested measure. CMS2 must show 36/36 expected cases and
     CMS951 must show 55/55, with the pass count equal to the expected count, failed count `0`, and
     skipped count `0`. A missing gate, a failed case, a count mismatch, or any nonzero skipped count is
     `BLOCKED`.
   * Check the vendored manifest and terminology sidecar for the artifact version, SHA-256, and
     terminology identity, and record the returned problem list from `officialRoutingProblems()`. A
     missing artifact or terminology identity, or any returned problem (the required result is `[]`), is
     `BLOCKED`.
   * Run the `flip-snapshot official-only` preflight for the requested source. Its official-only runnable
     descriptor output must contain the bare requested id and a source profile; if the measure is absent,
     it is `BLOCKED`, even if the artifact gate is green.
   * The same run must report the requested source's subject and bundle counts. A source that cannot
     produce bundles, has a bundle-load failure, or produces zero bundles when the selected source is
     expected to contain subjects is `BLOCKED`; the report must retain the source error rather than
     converting it to an empty IPP.
   * Record the command's batch-error and per-subject fallback results. A batch error is not by itself a
     block when fallback evaluates every affected subject, but any unrecovered batch error, subject error,
     missing population result, or other gap that leaves the required sample incomplete is `BLOCKED`.

2. `REVIEW_REQUIRED` is emitted only after all of those checks pass and the official executor has produced
   a complete result for the requested source. The extended report must contain the fields below before a
   human can act on it. When the official IPP count is zero it must add `NO_IPP_OBSERVED`; that flag is a
   request to explain the zero, not an all-clear and not the old `INCONCLUSIVE` verdict.

3. `HUMAN_APPROVED` or `HUMAN_DO_NOT_FLIP` may be recorded only by Taleef as the project owner and
   decision-maker. Recording `HUMAN_APPROVED` requires the same owner review required by the flip PR's
    reviewed-and-merged workflow under `docs/DEPLOY.md` and ADR-045's reviewed, merged, revertable
    framing. Neither the evaluator nor a mechanical check may infer either verdict. The human
   decision remains outside the evaluator, and `Outcome Status` remains the official CQL result.

4. The sign-off artifact must be a dated Markdown file under `docs/evidence/`, following the existing
   `docs/evidence/PR9C_FLIP_SNAPSHOT_2026-07-30.md` naming precedent, for example
   `docs/evidence/WAVE2_<MEASURE>_FLIP_REVIEW_<DATE>.md`. It must be committed in the same PR that flips
   the measure and contain the command outputs/counts for every `BLOCKED`-condition check, the full
   official-only report read by the reviewer, the reviewed subject sample and branch cross-references to
   the MADiE case descriptions, and the explicit `HUMAN_APPROVED` or `HUMAN_DO_NOT_FLIP` verdict with a
   one-paragraph rationale. The flip PR description must link to this file, as PR-9c linked to its
   flip-snapshot evidence file. If a review decision is later persisted, its creation and every state
   transition still require an `audit_events` row; this proposal does not design that schema.

The minimum review sample is one subject for every observed outcome bucket in the source and one subject
for every distinct combination of IPP admission and numerator branch reachable from the vendored ELM's
populations, whenever the source contains that combination. This is a branch-coverage rule rather than an
arbitrary subject count: it requires a positive and negative reading of each branch that actually appears,
while avoiding a claim that a fixed number of subjects represents every FHIR combination. If the source's
IPP is empty, there is no positive case to validate. The reviewer must instead confirm a named, checked
cause in the report, such as no subject carrying a qualifying encounter for CMS2, no subject aged 12 or
older at measurement-period start, no active diabetes overlapping measurement-period start for CMS951,
or no qualifying outpatient visit. The report must show the corresponding subject/resource counts; an
unexplained zero is not reviewable.

For CMS2, the sample must distinguish the age/encounter IPP admission, a qualifying screening Observation
with its defined code and status, a positive-screen branch with a follow-up-plan resource dated on the
same day as the positive screen, a negative-screen branch with the valid screening Observation and no
positive follow-up requirement, and a documented exception or exclusion branch. For CMS951, it must
distinguish the active-diabetes fact overlapping measurement-period start plus outpatient-visit admission,
the eGFR-plus-uACR branch, the eGFR-plus-urine-albumin-plus-urine-creatinine branch, a missing or
out-of-window kidney-laboratory branch, and a documented exception or exclusion branch. Each branch is
represented only when the source contains it; otherwise the reviewer records why it is absent.

For every measure and source, the extended report should compute and print the following rather than
trying to manufacture an authored side:

| Evidence | Required report | What it proves | What it cannot prove |
|---|---|---|---|
| External gate | measure id, pass/expected counts, failed and skipped counts, artifact version/SHA-256, terminology identity | The published artifact agrees with its external case vectors | That the WorkWell roster reaches the artifact |
| Source coverage | source name, target stack, measurement period, requested/produced subject and bundle counts, bundle-load failures, batch errors, recovered fallback count, unrecovered errors, and evidence-completeness count | The intended source was actually read and the run-shaped evaluation completed | That the source contains every clinical fact the measure needs |
| Official populations | IPP, denominator, exclusions, exceptions, numerator counts, population-branch counts, and per-subject `evidence.official.populationResults` | What the official artifact computed for these bundles | That the computed answer is clinically correct without review |
| Outcome distribution | COMPLIANT, OVERDUE, DUE_SOON, MISSING_DATA, and EXCLUDED counts, plus evaluation errors and the `NO_IPP_OBSERVED` flag when applicable | Whether the result is empty, degenerate, or materially different from a previous snapshot | Correctness or prevalence |
| Clinical sample | deterministic subject ids, outcome and branch labels, population results, and the underlying FHIR resources or resource references | A human can compare the retrieved resources with the measure's case description | Full-population proof; unsampled branches remain unreviewed |

The reviewer checks the official evidence against the underlying FHIR resources and the plain-English
MADiE descriptions; the reviewer does not edit a status. A report missing any required field or sample
branch remains `BLOCKED`, not `REVIEW_REQUIRED`.

### Assurance limitation

This is a reduction in assurance relative to the authored-versus-official comparison established by
ADR-043 and used for every flip through CMS122/CMS125. It is not a like-for-like substitute. The ADR-043
gate has a known answer, authored CQL, to diff against, so disagreement is detectable. An official-only
human sample has no independent answer to diff against: it can catch gross defects such as nothing being
retrieved, the wrong resource type being used entirely, or an empty IPP where a positive cohort is expected,
but it cannot catch a plausible-looking wrong answer that agrees with itself. In particular, a legitimately
zero IPP leaves the reviewer with no positive case to validate; `NO_IPP_OBSERVED` flags that condition but
does not resolve whether the zero is correct.

Three partial compensations have different limits. The permanent MADiE artifact-level gate proves that
the published artifact agrees with the steward's own cases, but proves nothing about whether WorkWell's
data reaches it. Distribution and branch-coverage sanity checks catch degenerate or implausible results,
but prove nothing about correctness. The human clinical sample against FHIR evidence and MADiE case prose
is the closest available positive check, but remains bounded by its sample and the reviewer's clinical
skill. None of these checks may set or override `Outcome Status`.

The existing source split transfers with these explicit limits. `live` remains the tenant-facing source
and must refuse an unset WebChart seam or a roster matching no returned subject. `fixture` remains a
reproducible diagnostic sample. The five-probe `synthetic` source remains a branch/agreement corpus, not
the production roster. The new `synthetic-directory` source must exercise the same employee directory
and official-only bundle profile that demo/production will use. A report that labels a five-probe result
as a roster forecast would recreate the vacuous-guard defect ADR-044 corrected.

The command must continue to be descriptive-only: it writes no outcome, case, or compliance state and
does not persist a review decision. If a future review record is persisted, its creation and every later
state transition must write an `audit_events` row. No evaluator or heuristic may approve a sample, classify
a subject, or set `Outcome Status`; the report may only display structured official evidence for the human
reviewer under the existing review controls.

## Question 2: product-surface onboarding

The official artifact is already routable, but the product is not yet official-only capable for these
ids. The following surfaces are the boundary we must discharge before a flip is meaningful.

### Surfaces enumerated

| Surface | Current assumption and verified location | Meaning of onboarded |
|---|---|---|
| Official router | `backend-ts/src/wiring/executor-router.ts:20-70,214-275` validates eight artifact/configuration properties: MADiE coverage, artifact and id, scoring, population basis, semantics, terminology, capped sets, absent sets, and non-empty expansions. CMS2/CMS951 pass. | Keep the eight checks. Add no runtime refusal for a data gap; the router remains an artifact/configuration gate, not a roster-readiness oracle. The official-only runtime descriptor must be accepted by the router without pretending it has authored CQL. |
| Run planner | `run-pipeline.ts:158` derives `RUNNABLE_MEASURE_IDS` from authored `MEASURES`; all four scope branches and the direct measure validation depend on it. | Add official-only ids to an explicit execution registry/descriptor union and make every scope select them only when the configured engine is official. A non-routed official-only id must not fall through to `CqlExecutionEngine`; it must be omitted or rejected as not enabled. The direct `MEASURE` scope must resolve an official name and source profile without `MEASURES[measureId]`. |
| Run bundle construction | `run-pipeline.ts:172-175` and `scale-generator.ts:42-51` require `MEASURE_BINDINGS` and `deriveExamConfig`; the non-null assertion is a hard failure for an absent binding. | Implement the official-only profile contract below in a separate profile registry or bundle builder. CMS2 and CMS951 must each expose distinct IPP, positive, negative/missing-data, and exception/exclusion shapes for fictitious synthetic employees. Do not add fake authored semantics to the generated binding table or reuse these profiles to stamp live WebChart data. |
| Binding generation | `measure-bindings.ts` is marked AUTO-GENERATED; `scripts/gen-measure-bindings.mjs` reads `measures/*.yaml`. | If an official-only profile is represented in generated data, extend the source/generator deliberately and document that it is a bundle-generation descriptor, not an authored CQL registration. A hand edit to the generated file is not an acceptable onboarding step. A separate official-profile registry is preferable because its fields are clinical resource shapes, not occupational enrollment/event bindings. |
| WebChart roster stamping | `engine/ingress/enrollment/roster.ts:1-52,196-251` uses a fail-closed `ROSTER_ELIGIBLE_MEASURES` allowlist for genuine OH program membership and deliberately excludes clinical facts such as CMS122 diabetes. | Do not add CMS2 or CMS951 to `ROSTER_ELIGIBLE_MEASURES`. The CMS2 ELM uses age and qualifying encounter plus depression-screen data; the CMS951 ELM uses active diabetes and an outpatient visit plus lab data. The roster may select which WorkWell measures to display, but it must not stamp these clinical Conditions, screening Observations, diagnoses, visits, eGFR, uACR, or urine creatinine. Staging-shaped live coverage must be measured from real WebChart data. |
| Catalog/spec tab | `measure-catalog.ts:59,77` exposes `cms2v15` and `cms951v4` as Draft/NOT_COMPILED with generic pending text and empty data requirements. | Preserve the versioned catalog identity for UI/history unless an owner approves a data migration. Add an explicit static mapping to official execution ids `cms2` and `cms951`, rewrite the spec with the official name, population, exclusions, compliance window, required FHIR elements, and artifact version, and mark the lifecycle state consistently with the official-only execution model. Do not make the UI imply authored CQL exists. |
| MeasureReport and QRDA identity | `fhir/measure-report.ts:271-317` derives the trio from official evidence; `official-measure-semantics.ts` already has correct entries for CMS2/CMS951. | Nothing new for this trio. Keep evidence-first canonical, improvementNotation, and membership. The official evidence must be present before this path is used; never reintroduce a `MEASURE_BINDINGS` fallback for a routed outcome. |
| Case disposition | `case/case-logic.ts:17-67` is status-driven and measure-agnostic for disposition/priority, but `NEXT_ACTION_LABELS` only has CMS122/CMS125 and older measures. | Add human-reviewed labels for CMS2 and CMS951, while retaining `Outcome Status` as the sole compliance input. CMS2 actionable text should describe depression screening/follow-up; CMS951 should describe kidney health evaluation. Every CREATED, UPDATED, REOPENED, RESOLVED, and EXCLUDED state change continues to emit an audit event; an idempotent unchanged confirmation is not a state change. |
| Case detail | `case/case-detail-read-model.ts:15,68,92,155` reads name/version from authored `MEASURES`, defaults the binding window to 365 days, and derives `why_flagged` from authored expression results. | Resolve official name/version from the official descriptor/catalog mapping, use official measurement-period metadata, and render official population evidence rather than an empty authored `why_flagged`. Do not fabricate `last_exam_date`, a waiver, or a compliance explanation from missing authored defines. |
| `/api/measures` and Standards | `routes/measures.ts:77-81,364-432,494-553` uses authored `MEASURES`/ELM for CQL, direct evaluation, ELM retrieval, and fidelity tiers; the literal diff constructs its own authored engine. | Show official-only measures as official artifacts with no authored CQL/dual-engine diff. Direct evaluation must route through the official executor when enabled, or state that the measure is not available on an authored-only diagnostic path. The fidelity tab must not report an authored comparison that does not exist. |
| `/simulate` and employee snapshots | `routes/compliance-simulation.ts:38-39` calls `simulateComplianceAsOf`; `run/employee-compliance-snapshot.ts:52-62` loops over `Object.keys(MEASURES)` and uses `MEASURE_BINDINGS`. | Include official-only measures only through the same routed engine and official bundle profile as a real run. Preserve the distinction between an official result and a missing authored simulation; never pad the list with a fake CQL result. |
| Scale and history jobs | `run/batch-evaluate-scale.ts`, `run/backfill-scale.ts`, `run/backfill-quality-history.ts`, and `run/backfill-trend-history.ts` derive measure lists/bundles from authored registries and bindings. | Decide explicitly whether the official-only descriptor is supported by each job. For a target stack that evaluates the synthetic directory, the scale batch needs the official profile and evidence-first aggregation; authored trend/backfill code must not run CMS2/CMS951 under false binding semantics. Unsupported historical jobs should refuse with a named reason, not silently omit the measures. |
| Direct ingress and routes | `engine/ingress/evaluate-bundle.ts` rejects ids absent from `MEASURES`; `routes/measures.ts` has the same guard. The router's own comment notes that seed CLIs, scale paths, DB-less ingress, and headless paths can construct engines directly. | Centralize the official-only dispatch decision or make each direct path explicitly official-aware. A route that cannot carry official evidence must reject CMS2/CMS951 clearly; it must not invoke an authored engine that throws or return a made-up status. |
| MCP and read models | `mcp/tools.ts`, `run/read-models.ts`, `routes/identity.ts`, and `run/employee-profile.ts` use `MEASURES` for names, versions, run labels, and identity rows. | Use the same official descriptor/catalog mapping for display and version. `mcp/tools.ts` already prefers official population evidence when explaining a routed outcome, but it must receive a real measure name and must not invent recency/window text from an authored binding. |
| Incremental evaluation | `run/incremental/incremental-eval.ts:127-168` hashes authored ELM unless the engine declares official logic. | Declare the official artifact identity for CMS2/CMS951 before any cache reuse is enabled. The logic version must change on artifact/terminology changes, and same-day official rows must obey the existing no-copy-forward safety policy. This is not a reason to bypass evidence or audit. |

The CMS2/CMS951 ELM reading also answers the roster question directly. These are not the kind of
WorkWell program-membership facts that `ROSTER_ELIGIBLE_MEASURES` exists to stamp. CMS2's qualifying
encounter and screening result must come from the clinical bundle; CMS951's active diabetes, outpatient
visit, and kidney laboratories must come from the clinical bundle. The distinction is the same fail-closed
principle that keeps CMS122 out of the allowlist, even though the actual CMS2/CMS951 resource shapes are
different from CMS122's Condition-only problem.

### Synthetic profile contract and deferred design work

The official-only synthetic profiles must be named data shapes, not a generic "clinical facts" placeholder.
Each profile is a separate source-profile entry referenced by the official descriptor and is used only for
synthetic employees. It must produce the following distinct relationships:

* **CMS2.** The IPP-admission profile has a patient aged 12 or older at measurement-period start and a
  qualifying Encounter inside the measurement period. The positive-screen profile adds a depression-screening
  Observation with the defined screening code, a valid status, a positive result, and a follow-up-plan
  resource dated on the same day as that positive screen. The negative-screen profile has the defined
  screening Observation with a valid status and a negative result, without treating a follow-up plan as
  required for that branch. The non-IPP profile removes or invalidates the age/qualifying-Encounter
  admission. The documented-exception/exclusion profile contains the exception or exclusion resource
  relationship recognized by the vendored ELM. The profile labels must retain which branch was intended so
  the snapshot can compare it with the official population result.
* **CMS951.** The IPP-admission profile has an active-diabetes clinical fact overlapping measurement-period
  start and an outpatient Encounter inside the measurement period. One numerator profile contains an eGFR
  observation and a uACR observation within the defined window. A second numerator profile contains an eGFR,
  urine-albumin, and urine-creatinine observation triple within that window, with each lab dated so the
  relationship is testable. The negative/missing-data profile has no qualifying kidney evaluation or has a
  required lab outside the window. The non-IPP profile removes or invalidates the active-diabetes or
  outpatient-visit admission. The documented-exception/exclusion profile contains the exception or exclusion
  resource relationship recognized by the vendored ELM. These are separate profiles even when they share
  the same patient and visit scaffolding.

The exact LOINC and SNOMED code lists, value-set expansions, Observation statuses, exception resources,
and exact FHIR JSON shapes are **DEFERRED DESIGN WORK** for the onboarding PR. That PR must cross-reference
the vendored ELM value-set OIDs against VSAC and complete terminology using the process established by
ADR-041 and ADR-053, then obtain the owner's decision on any code or resource ambiguity. This proposal
settles the branch and resource relationships; it does not hand-enter a code list or sketch DDL.

### Options

#### Option 1: place official-only ids into the authored registries with placeholders

**Pros.** It is the smallest apparent change to `RUNNABLE_MEASURE_IDS`, existing UI lists, and tests.
Existing bundle helpers and case code continue to compile against the same maps.

**Cons.** A placeholder library would make `CqlExecutionEngine` appear to support a measure it cannot
execute. A placeholder binding would invent enrollment, compliance windows, or FHIR event semantics.
It would make the current non-null assertions pass while silently describing the wrong engine, precisely
the kind of vacuous coverage this repository rejects. We reject it.

#### Option 2: add a parallel official execution descriptor and make consumers choose an engine

The descriptor is a typed execution/product contract, not a second compliance engine. Its minimum fields
are:

| Field | Type and shape | Source or required owner-side seam |
|---|---|---|
| `officialId` | `string`, the bare routing id (`cms2` or `cms951`) | The official artifact loader and router; this is the id accepted by official execution. |
| `catalogId` | `string`, the versioned catalog id (`cms2v15` or `cms951v4`) | `backend-ts/src/measure/measure-catalog.ts`; add an explicit static mapping to `officialId` to close the current bare-id/versioned-id mismatch. |
| `engine` | literal `"official"` | The dispatch union; absence of an authored `MEASURES` entry must be structural, not represented by a placeholder. |
| `displayName` and `versionLabel` | `string` values | Reviewed catalog/spec content, exposed to cases, reports, identity rows, and Standards. |
| `artifactVersion` and `artifactSha256` | `string` values | The vendored manifest alongside the official artifact; these are read from the manifest, never hand-entered in a run or review packet. |
| `measurementPeriod` | `{ start: ISODate, end: ISODate, derivation: string }` | Use the run's explicit measurement-period input. If it is absent, apply the reviewed official period rule stored beside the descriptor; never fall back to an authored `MEASURE_BINDINGS` window or an implicit 365-day default. |
| `populationSemanticsRef` | `string`, the bare semantics key | `backend-ts/src/wiring/official-measure-semantics.ts`; the key must resolve to the reviewed CMS2/CMS951 entry. |
| `sourceProfile` | `{ source: "synthetic-directory" | "live" | "fixture", profileId: string }` | A reference to the source-profile registry and bundle-generation strategy. Generation logic does not live inline in the descriptor, and live profiles never stamp synthetic clinical facts. |
| `caseDisplayLabels` | `{ nextAction: Record<string, string>, population: Record<string, string> }` | Human-reviewed labels alongside `case/case-logic.ts` and the case/read-model consumers, keyed by official population/status identifiers. |

The descriptor must be present in the official-only runnable union before any run scope can select the
measure, and it must not contain authored CQL or be added to `MEASURES`. The onboarding PR must add the
descriptor, its source-profile entries, and the explicit catalog mapping together so the run planner,
synthetic generator, catalog, cases, direct routes, and incremental evaluator consume one contract.

**Pros.** It preserves the authored engine boundary, makes the official-only state explicit, and lets
the run planner, synthetic generator, catalog, cases, direct routes, and incremental evaluator share one
truth. It makes an accidental authored call structurally difficult. It also lets official-only support
be added to the production path without making the Standards lab claim a diff.

**Cons.** It adds a second metadata seam that must be kept in sync with the artifact and catalog. The
descriptor needs tests for every consumer, and some legacy endpoints must explicitly refuse or change
their response shape. The cost is real, but it is the cost of acknowledging that an official artifact is
not an authored measure.

#### Option 3: leave product onboarding out of scope and flip only after a separate future migration

**Pros.** It keeps the current code untouched and avoids deciding how official evidence should be shown
in cases, simulations, and the catalog.

**Cons.** It leaves the flip as a no-op and makes the environment flag misleading. It also moves the
most important safety question into an unbounded future task. This is not a safe flip sequence and does
not answer ADR-047.

### Recommendation

We recommend Option 2, with one explicit rule: the parallel descriptor is an execution/product contract,
not a second compliance engine. The onboarding work should:

1. Define official-only runtime metadata for CMS2 and CMS951 and make the run planner's measure union
   explicit. The union must be selected by the configured execution mode; an official-only id must never
   be passed to `CqlExecutionEngine`.
2. Add official synthetic bundle profiles for the demo/production employee directory, with clinical
   resource shapes that exercise the official ELM. Synthetic facts are allowed for synthetic employees,
   but the profile must not be reused to stamp live WebChart data.
3. Keep CMS2/CMS951 out of `ROSTER_ELIGIBLE_MEASURES`; use live WebChart resources for their clinical
   gates and measure the gap with the official-only `live` snapshot.
4. Preserve catalog ids while adding an explicit bare-id mapping and replacing the two placeholder
   specs with reviewed official content. If persisted measure rows require a migration, that migration
    is owner-only and is not assigned by this proposal.
5. Leave ADR-046's report trio unchanged. Extend case/read-model/MCP metadata only so that official
   evidence is displayed accurately; no surface may infer compliance from a label or heuristic.
6. Audit every state transition introduced by official outcomes. Run completion, case creation, case
   updates, closures, exclusions, and any persisted human review decision must retain an `audit_events`
   row. A read-only snapshot remains non-persistent.
7. Treat unsupported scale, backfill, fidelity, and simulation paths as explicit refusals or official-aware
   paths. Silent omission is not onboarding.

The authored CMS122/CMS125 subsets retire to the fidelity/Standards lab after their flips under locked
decision #4. There is no analogous retirement for CMS2/CMS951 because there is no authored subset to
retire. The official-only descriptor is the product surface for these measures, not a temporary authored
shadow.

## Question 3: sequencing

The existing five-step checklist in `docs/DEPLOY.md` under “Flipping a measure to official execution —
pre-flip checklist (ADR-043)” remains the right checklist. Wave-2 extends steps 1-3; it does not replace
the checklist and does not move enforcement into runtime refusal.

### Options

#### Option 1: add CMS2/CMS951 to `WORKWELL_OFFICIAL_MEASURES` immediately

**Pros.** It is one workflow edit and exercises the router quickly.

**Cons.** The run planner schedules zero work items today. After the planner is fixed, the synthetic
builder still lacks the clinical resources and the WebChart gap is unmeasured. The environment would
claim a flip while no subject is evaluated, which is the exact failure this proposal is intended to stop.
Reject.

#### Option 2: one PR per measure, each carrying a copy of the official-only substrate

**Pros.** CMS2's screening resources and CMS951's kidney labs can be reviewed independently, and a
problem in one measure does not block the other.

**Cons.** The run-planner, descriptor, snapshot, case, catalog, and workflow mechanisms would be
duplicated or partially landed twice. It encourages a measure-specific exception rather than a reusable
official-only state and makes it easier for the second PR to omit a surface the first one fixed.

#### Option 3: one coupled onboarding PR followed by a narrowly scoped flip PR

The first PR carries the shared official-only execution/product substrate and both measures' data
profiles. The second PR carries only the reviewed environment flip for the measure or measures whose
evidence packets are complete.

**Pros.** Making a measure runnable, building its target bundles, exposing its official evidence, and
checking its case/report identity are tightly coupled changes: a partial set creates a no-op or a false
UI. They therefore belong in one coherent onboarding task under the repository's one-PR rule. The
workflow flag is a separate operational decision and remains easy to review, revert, and compare against
ADR-045. CMS2 and CMS951 share the substrate PR but retain separate evidence and human approval rows;
one may be flipped without claiming the other is ready.

**Cons.** The onboarding PR is broader than a single measure's code diff, and the team must maintain a
clear no-flag state while it lands. The separate flip PR adds a merge boundary between readiness and
deployment, which is deliberate operational friction.

### Recommendation

We recommend Option 3.

#### Onboarding PR: make the wave-2 state real

The onboarding PR should contain the official-only descriptor, run-planner union, official synthetic
profiles, official-aware direct paths, catalog mapping/spec content, case/read-model/MCP display support,
incremental identity handling, and the extended `flip-snapshot` report. It should include tests that
prove CMS2 and CMS951 appear in each intended run scope only when routed, that a non-routed official-only
id never reaches the authored engine, that generated synthetic bundles contain the intended clinical
shapes, and that official evidence drives reports/cases. It should leave `WORKWELL_OFFICIAL_MEASURES`
unchanged. No test may call a MADiE result proof of run-pipeline behavior; the official-cases harness and
the product-path tests must remain separate.

The new snapshot tests must include the negative paths: no authored oracle, no official IPP, incomplete
bundle/source, official executor refusal, batch omission with successful per-subject fallback, and a
non-empty official population with no authored comparison. Each test must state what it cannot catch.
In particular, a synthetic branch probe cannot catch a live WebChart mapping gap; a non-zero IPP count
cannot catch a wrong numerator resource; and a plausible distribution cannot prove clinical correctness.

#### Evidence before the flip

For each measure and target stack, run the unchanged five-step checklist with these wave-2 additions:

1. **Gate floor.** Confirm MADiE counts and errors, with `skipped 0`, the artifact identity, terminology
   sidecar, and `officialRoutingProblems() === []`. A green artifact gate is necessary, not sufficient.
2. **Target source.** Use `synthetic-directory` for demo/production after the official profile exists,
   `live` for a WebChart tenant with its actual roster, and `fixture` only as a named reproducible
   diagnostic. Record the subject count, IPP count, population counts, status distribution, errors, and
   evidence completeness.
3. **Numerator and evidence review.** Inspect a deterministic sample of official population results
   against the underlying FHIR resources, including the CMS2 and CMS951 branches listed in Question 1.
   The reviewer records approval or rejection; the tool does not.
4. **Workflow delivery.** Edit the value in `deploy-twh-mieweb.yml` and the matching value in
   `reconcile-twh-mieweb.yml` to the same list. Do not hand-set the container. Keep staging unset until
   a separate live-WebChart evidence packet approves that stack; demo/production and staging do not have
   the same source.
5. **Post-deploy check.** Redeploy, grep for `OFFICIAL_ROUTING_MISCONFIGURED`, confirm the official
   measure execution log, run a real population scope, inspect run logs and cases, and confirm the
   resulting evidence/report identity. Health 200 alone is not enough. Any case state change must have
   its audit event.

#### Flip PR: change only the reviewed routing configuration

The flip PR should add CMS2/CMS951 to the production workflow's `WORKWELL_OFFICIAL_MEASURES` value and
the reconciler's identical value, with the same ordering and no staging change unless staging has its own
completed evidence packet. It should not add a code fallback, a placeholder authored library, a runtime
    refusal, a database migration, or an inferred judgement.

Its structural test should follow ADR-045's `official-flip-config.test.ts` pattern: parse the values that
the workflows actually ship, assert that every shipped id is MADiE-gated, vendored, proportion-scored,
semantically defined, and free of routing problems, and assert that the deploy and reconciler ship the
same value. Keep the structural half always-running and keep the terminology half sidecar-dependent and
wired into the existing official-cases CI job. Continue to syntax-check workflow run blocks.

The test must not pin the literal set of measures. It should validate the property that whatever the
workflow ships is routable and correctly mirrored. CMS2/CMS951 readiness is established by their separate
official-only evidence packets, not by hardcoding the expected list in a test. The flip command remains
descriptive and exits zero; the human review and PR decision are the enforcement point, consistent with
ADR-043 and ADR-044.

## What this does not resolve

This proposal does not create an authored oracle and does not claim that official-only snapshot agreement
with itself is correctness. The external MADiE gate remains the artifact's answer key; the human sample
review is the missing WorkWell-data check; neither proves all possible FHIR combinations.

It does not measure CMS2/CMS951's live WebChart coverage in this documentation task. Until the official-only
run path exists, a zero live IPP count is not interpretable. The first live run must report whether the
missing resource is age, encounter, active diabetes, outpatient visit, screening Observation, follow-up,
eGFR, uACR, urine albumin, or urine creatinine, rather than collapsing the result to "no eligible people".

It does not make the five-probe synthetic source into a roster forecast, and it does not make an
epidemiological plausibility range a compliance oracle. Both remain useful diagnostics with explicit
blind spots.

It does not propose a schema or DDL change. If a future implementation decides to persist a run warning,
 review decision, or official metadata field, the owner must design and approve the schema change; this
 proposal does not assign or sketch that migration.

It does not allow heuristics, case labels, distributions, catalog state, or human-entered prose to set or
override `Outcome Status`. Every compliance status remains the official CQL result carried in evidence;
every persisted state change remains auditable.

If the product team wants the Standards tab to compare an official artifact with a local diagnostic
implementation,
that is a separate decision and would revisit the official-first posture. This proposal recommends no such
comparison. The only additional documentation that may be needed after approval is an extension of
`docs/DEPLOY.md` and the relevant catalog/spec guidance; this proposal intentionally does not edit those
files.
