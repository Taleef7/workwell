# Journal archive — July 2026

> Split out of `docs/JOURNAL.md` on 2026-09-01. **Verbatim**: no entry was edited, summarised
> or dropped. The journal had reached 1.17 MB / 311 entries, which made the file that is meant
> to be *the* readable narrative of recent work into something nobody scrolls and nothing can
> load.
>
> This file holds **110 entries** (2026-07-01 → 2026-07-31). Newest entry on top, same as the live journal. For
> anything more recent read `docs/JOURNAL.md`; for the decisions these entries produced read
> `docs/DECISIONS.md`.

## 2026-07-31 (M-B) — QRDA-I export bundle reads are scoped to run subjects (branch `fix/qrda-loadbundles-subject-scope`)

Closed the production timeout hazard recorded in the 2026-07-30 `feat/qrda1-patient-data` entry: `GET /api/runs/:id/qrda1` now re-reads only the run's known `wc|` subjects, using direct WebChart `Patient/{id}` reads and the existing per-resource composition. The route-level seam is covered so a run with a small subject set cannot silently regress to a whole-tenant Patient-list crawl.

The optional source/client methods preserve compatibility: JSON buckets filter locally, and fixture or older WebChart clients fall back to the existing full read. The full-crawl read used by population-run cohort discovery is unchanged and remains correct because that path does not know subject ids in advance; export data is still "as of NOW, not as of the run" per ADR-050.

Round 3 closes the silent-data-loss path on `_count`-rejecting servers by negotiating the capability inside scoped resource searches, logs every Patient-only fallback, and returns a specific export reason for degraded retrieval. A single non-404 Patient read now degrades only that subject and the batch continues. Near the 5000-subject refusal, scoped export still performs up to that many sequential reads: a STRICT IMPROVEMENT over the unbounded whole-tenant crawl, but not a complete large-scope solution without concurrency/streaming or true bulk `$export`.

## 2026-07-31 (M-C) — extraction proposal proposes resolutions for the content and test-edge gates (branch feat/measure-engine-extraction-proposal)

This is a DOCS-ONLY proposal for the later packages/measure-engine extraction; no package or source file was moved. Gate 1 recommends an injected content contract: WorkWell's catalog, WorkWell-authored compiled ELM, and synthetic-oriented value-set fallback belong in a separate sibling content package, while generic FHIRHelpers remains an engine asset and the engine keeps cql-execution + cql-exec-fhir only.

Gate 2 recommends restructuring the 10 out-of-closure edge rows across seven named test files: package tests use minimal fixtures and resolver doubles, while ingress, SQLite, SQL-codegen, and synthetic-corpus integration tests stay app-side. The decision proposal is at docs/proposals/MEASURE_ENGINE_EXTRACTION_PROPOSAL.md.

## 2026-07-31 (M-A) — CMS130 and CMS165 onboard clean on the first credentialed dispatch (branch `feat/onboard-cms130-cms165`)

This mirrors the CMS138 and CMS2/CMS68/CMS951 onboarding path, but the vendor machinery was already
complete. CMS130 and CMS165 each took **one** credentialed `vendor-official-measure.yml` dispatch. Unlike
CMS138, which needed VSAC sourcing for a value set upstream does not ship, and unlike CMS122/CMS125,
where capped `AdvancedIllness` expansion was a separate discovery and completion concern, these two
came back complete on the first try: the workflow's `--complete-terminology` flag handled the capped
AdvancedIllness-class expansions as part of normal vendoring.

**Measured.** CMS130 contains **31 value sets / 3172 codes**; CMS165 contains **33 value sets / 5024
codes**. Both vendor verifications reported `truncated: []` and `absent: []`, with no sourced supplement
and full `measure-bundle` provenance. The sparse-checkout case directories are **64 for CMS130** and
**68 for CMS165**.

**Onboarding only.** Both are now in `OFFICIAL_GATED_MEASURES`, but `WORKWELL_OFFICIAL_MEASURES` was not
touched and nothing is routed to either measure. **Routable ≠ routed**, the same framing ADR-047/053 use.
This builds on the **278/278** MADiE gate baseline across the six already-gated measures: cms2, cms68,
cms122, cms125, cms138, and cms951.

**Confirmed.** The [credentialed CI run](https://github.com/Taleef7/workwell/actions/runs/30718966633)
scored CMS130 64/64 and CMS165 68/68, with 0 unexpected mismatches and 0 errors for each; both manifests
reproduced byte-for-byte, and all six previously-gated measures reproduced their existing numbers with no
regression. `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md` has been regenerated from that run's own output and
committed.

## 2026-07-31 (M-A) — wave-2 flip gate proposal: what replaces the authored oracle for CMS2/CMS951 (branch `feat/wave2-flip-gate-proposal`)

This proposal answers ADR-047's open question for two measures that are MADiE-green and ROUTABLE but
have no authored engine to compare. The most important verified finding is deeper than a roster gap: a
targeted `MEASURE` request for `cms2` or `cms951` is rejected outright with an HTTP 400
(`InvalidRunRequestError`) before any run is created because the id is absent from `MEASURES`, while a
broad `EMPLOYEE`, `ALL_PROGRAMS`, or `SITE` run completes successfully but silently contains no
CMS2/CMS951 work item because those scopes build their work lists from `RUNNABLE_MEASURE_IDS` without
referencing the requested id. CMS2/CMS951 therefore receive no evaluations today, but the targeted and
broad scopes fail differently: the former is a loud, immediate client error and the latter is a quiet
omission. Their flip is not inert on the stack in the CMS122/CMS125 sense; it is a no-op until the
official-only measures become runnable.

The recommendation is to extend `flip-snapshot` with an official-only, source-labelled report and a
human clinical evidence review, replacing the meaningless authored verdict with `BLOCKED` or
`REVIEW_REQUIRED` and an explicitly human `HUMAN_APPROVED`/`HUMAN_DO_NOT_FLIP` decision. For product
onboarding, add a parallel official execution descriptor and real synthetic clinical profiles, keep
CMS2/CMS951 out of `ROSTER_ELIGIBLE_MEASURES`, and update catalog/case display metadata while leaving
ADR-046's evidence-derived reporting trio unchanged. For sequencing, land one coupled official-only
onboarding PR first, then a narrowly scoped flip PR that mirrors the workflow value in deploy and
reconcile, follows the same five-step checklist with wave-2 evidence extensions, and preserves ADR-045's
structural-plus-terminology test split without pinning the literal measure list.

## 2026-07-31 (M-A) — CMS138 onboarded: 0/47 → 47/47, and the gate learned a new kind of claim (branch `feat/onboard-cms138`)

Three things had to be true and only the first was: the value set had to be sourced, the artifact had to
be complete, and the deck had to be able to SEE it.

**Sourced.** The credentialed workflow from #365 ran `--complete-terminology` for CMS138 and pulled
`…3.526.3.1278` ("Tobacco Use Screening") from VSAC at the pinned release — **4 codes**, upstream ships
none. Its verification step confirmed the artifact complete (`truncated []`, `absent []`) before
uploading, and refused to upload anything less.

**Then the deck said 0/47 anyway**, with 47 errors, every one `Missing the following valuesets`. That
falsified ADR-053's own sentence — *"the real check on a sourced value set is the MADiE gate"* — and the
report explains why in its own words: *"ValueSets are consumed directly from each official measure
Bundle."* The gate runs on UPSTREAM's terminology, which is exactly what makes it an external check for
the other five and exactly what makes it blind here, since the bundle is the thing that lacks the set.
A complete sidecar sat beside it the whole time, unread.

**So the gate now supplements — but only what upstream omits.** `runOfficialMeasureCases` takes the
artifact's runtime terminology and narrows it to the OIDs the bundle does not ship. The narrowing lives
next to the `calculate` call, not at the call site, because the natural thing for a caller to do is pass
the whole cache — which would quietly convert this gate from "upstream's terminology" into "ours" for
every measure, deck still green, nothing to notice. With nothing missing, `calculate` takes three
arguments exactly as before; the pre-existing assertion that pins that still passes, which is what makes
the five complete measures provably unaffected.

**Measured: 47/47, 0 unexpected mismatches, 0 errors.** The gate is now **278/278** across six measures.

**What that 47/47 licenses is NOT what the other five carry, and everything here is built to stop it
being rounded off.** For that one value set the codes are ours; what stays upstream's is the ANSWER KEY
— the expected population vectors. So agreement is real evidence the four codes are right, and no
evidence at all about upstream's terminology. The run records `supplementedOids`, the mode becomes
`measure-bundle+sourced-supplement`, the CLI says so on stderr, and the report prints it on the measure's
own line rather than in a footnote.

**Smaller things worth keeping.** A test comment still asserted cms138 "scores 0/47 because one value
set will not expand" — the misdiagnosis ADR-053 corrected, living on where nobody looks. Two CLI test
doubles predated `supplementedOids` and threw on it, which surfaced as the CLI returning **exit 2** —
reading as "the configuration was refused" rather than "the fixture is incomplete". And I re-ran the
ADR-writing script by accident mid-session, duplicating ADR-053; caught by grepping the heading count
rather than by reading, which is the only reason it did not ship.

**Still not vendored: CMS130 and CMS165.** Their blockers are capped expansions, which the gate handles
today — no supplement needed. One dispatch each.

## 2026-07-31 (M-A) — the "owner step" was a tooling gap: credentialed vendoring gets a command (branch `feat/vendor-workflow-cms138`)

Three measures — CMS130, CMS165 (capped, ADR-041) and CMS138 (absent, ADR-053) — were recorded as
blocked on "an owner step with the VSAC key". **That framing was wrong, and the owner was right to push
back on it.** `WORKWELL_VSAC_API_KEY_VENDOR` has been a GitHub secret since 2026-07-29. What was missing
was not the credential but a way to run the vendor command in the one place the credential already
lives: CI has used it on every push for two days.

`vendor-official-measure.yml` is a `workflow_dispatch` job that vendors one measure with
`--complete-terminology` and uploads the two committable files as an artifact. It takes **`contents:
read`** and uploads nothing else — deliberately not a workflow that can push, because that is a standing
capability where this is a one-shot whose output a human reviews.

**The licensed-content boundary is the load-bearing part.** Three files land in the output directory and
only two may leave the runner: `bundle.json` and `manifest.json` are already committed to this public
repo, while `terminology.json` holds thousands of AMA CPT and SNOMED CT codes under an NLM licence and
is gitignored precisely so it is never redistributed (ADR-036) — an artifact URL is redistribution. The
difference is one `cp` line, and it would be invisible in review because an artifact is a zip nobody
opens. `vendor-workflow-safety.test.ts` therefore asserts named files, no wildcard, no recursive copy,
dispatch-only triggers, `contents: read`, and the fail-closed credential check. Mutation-checked against
`cp -r …/*` — the exact edit someone makes to "just grab everything" — which fails exactly one test.

Its first cut failed on its OWN comment: the workflow header explains why it does not take
`contents: write`, and the prohibition matched that sentence. A guard that cannot tell a rule from its
own rationale gets deleted rather than fixed, so it now scans non-comment lines only.

Also: `fetch-official-cases.ps1` now checks out CMS130/CMS138/CMS165 as **candidates** — sparse-checked
out but deliberately absent from `OFFICIAL_GATED_MEASURES`, since their artifacts are not vendored and
adding them to the gate would fail the deck. That is what lets `pnpm official:terminology-audit` read
their bundles at the pinned commit, which is how ADR-053's finding was made in the first place.

**Review (#365) found two more, both of the same family as the rest of this run.** (1) Dispatch inputs
were interpolated straight into `run:` scripts — including the step holding the VSAC credential, where
`$(...)` in an input would execute. Only write-access users can dispatch, which lowers the odds and not
the severity; inputs now pass through `env:` and are validated first. (2) **The completeness report read
the wrong field.** It warned on non-empty `truncated` — which an ABSENT value set never appears in — so
for CMS138, the one measure this was built for, it was warning-free by construction and the workflow
would have uploaded exactly the unroutable artifact it claims to reject. `completeTerminology` fails
closed and exits 0, so the vendor step succeeding says nothing. There is now a verification step running
the REAL runtime predicates (`absentValueSets` + `truncated`) before staging, and both new guards are
mutation-checked. Third instance this run of "a check that reads a field the failure does not appear in".

**GitHub requires a `workflow_dispatch` file to exist on the default branch before it can be
dispatched**, so this lands on its own rather than bundled with the vendored artifacts it produces. The
artifacts, the gate wiring and the MADiE verdict follow in the next PR — and for CMS138 that verdict is
the real check, because nothing in the vendoring can distinguish a correct expansion from a wrong one of
the right size.

## 2026-07-31 (M-A) — "will not expand" was the wrong sentence: upstream ships CMS138 one value set short (branch `fix/official-terminology-absent-valuesets`)

ADR-047's table reads *"CMS138 tobacco screening | **0/47, 47 errors** — one value set (…3.526.3.1278)
will not expand"*, and — to its credit — it did not claim to know why: *"Whether that is an upstream
packaging gap or something our reducer drops is unknown."* CLAUDE.md's summary dropped that hedge, and
"will not expand" points at our expander, our gitignored sidecar and our VSAC release pin. None of them
is the cause, and the first thing worth doing was to stop reading and measure. (My own first draft of
ADR-053 quoted CLAUDE.md's phrasing as ADR-047's words — the misattribution class review caught on #363
one PR earlier. Corrected against the text.)

**Measured, at pin `ca4b4951`:** CMS138's libraries **retrieve 32** value sets and its bundle **ships
31** ValueSet resources. `2.16.840.1.113883.3.526.3.1278` ("Tobacco Use Screening") is simply not in the
bundle. All five other measures are exact (26/26, 32/32, 15/15, 5/5, 26/26). Three follow-up checks
decided the remedy: upstream's own 2026-07-15 discrepancy report lists CMS138 under **no discrepancies**
across 5826 test cases, so their environment resolves it and the measure is fine; the only commit after
our pin changes no bundle, so **re-pinning is not the fix**; and their README names the NLM terminology
package as the source of full expansions — the same licensing boundary ADR-041 already hit as the
1000-code cap, in a different shape.

**The blind spot this exposed in our own vendoring.** `collectTerminology` enumerates the ValueSets a
bundle SHIPS. A value set the ELM retrieves but upstream never shipped produced no sidecar entry, no
`truncated` row and no warning — so the manifest read as terminology-complete while the artifact could
not run. The manifest's own sentence, *"a manifest with an empty `truncated` is a manifest whose sidecar
holds every code the bundle declared"*, is **true and narrow**: it says nothing about a value set the
bundle never declared, and `official-flip-config.test.ts` was reading it as a completeness record.

**Shipped (ADR-053).** The vendor step now diffs retrieved-vs-shipped and warns; `--complete-terminology`
(renamed from `--complete-capped-expansions`, old name still accepted — and that alias is *tested*
against the real CLI rather than claimed in a docblock) sources absent sets from VSAC as well as
completing capped ones; and `officialRoutingProblems` names the actual condition instead of "could not
be expanded". Capped and absent are never conflated: a capped set is checked against upstream's declared
total AND containment of upstream's codes, an absent one has neither baseline available, so it is held
to VSAC's own `expansion.total`, an empty expansion is refused outright, and the completion record
carries `reason: "absent-upstream"` with a `null` `declaredTotal`. The real oracle for a sourced set is
the MADiE gate — 0/47 with 47 errors today, and a wrong value set does not turn that green.

**Two decisions worth carrying.** (1) The absent list is **recomputed at runtime, never recorded** — it
is derivable from the artifact's ELM plus its sidecar, so a manifest field would be a second authority
that can disagree with the artifact it describes. Consequence: it applies retroactively to artifacts
vendored before it existed. (2)
`pnpm official:terminology-audit` is a **measurement, not a gate** — exit 0 whatever it finds, and
deliberately not in CI, because it reads the gitignored `.official-content` checkout and would otherwise
be a self-skipping job that reads as covered.

**The claim I got wrong, and how it was caught.** The first push said the change "moved no committed
byte", verified by re-vendoring cms2 to an empty `git diff`. The verification was real; the conclusion
did not follow. That cut also tagged CAPPED completions with `reason: "capped"` — and only cms122 and
cms125 carry a `completion` block, written by a *credentialed* run, recording exactly
`{oid, had, now, declaredTotal}`. CI's **"The committed artifact is reproducible from its pin"** step
failed, which blocks deploys and which no contributor can clear locally (the VSAC key is a GitHub
secret). cms2 could not have caught it: vendored without the credential, it has no completion block at
all — I checked the one artifact class the change could not affect. Fixed by emitting `reason` only for
`absent-upstream`, and guarded by a test comparing the record the code PRODUCES against the records
already COMMITTED, with a non-degeneracy assertion.

**What else the change broke, and what that taught.** Nine routing tests failed on a condition none of them
was about: `executor-router.test.ts` stubbed "terminology present" as `{ok: true, codesByOid: new
Map()}` — an artifact whose sidecar loads and holds nothing, which no real artifact can be. Once the
router could notice that, the stub meant "all 26 of this measure's value sets are absent". Fixed by
making the stub describe a COMPLETE artifact rather than by adding a third thing to remember to stub.
Separately, the parity test between the two implementations of "what does this ELM retrieve" (forced —
the vendor script runs as bare `node` on the deploy path and cannot import the workspace package) had to
move from `src/` to `scripts/`: `tsc` will not follow `src/` into a `.mjs`, and the alternative was a
hand-written `.d.mts` whose drift is the exact defect the parity test exists to catch.

**Not done, deliberately:** CMS138 is still **not vendored**. Sourcing the value set needs
`WORKWELL_VSAC_API_KEY_VENDOR`, so it folds into owner task #10 beside CMS130/CMS165 — and committing an
artifact that can never be routed is worse than committing none (ADR-047's call, unchanged). Evidence:
`docs/evidence/OFFICIAL_TERMINOLOGY_AUDIT_2026-07-31.md`. Suite 1742 pass / 0 fail / 15 skipped;
typecheck clean; every new guard mutation-checked.

## 2026-07-31 (M-C) — the app-side exclusions are decided; what the package does with CONTENT is not (branch `feat/measure-engine-package`)

M-C promises `@workwell/measure-engine` with two dependencies. The workspace and
`packages/official-executor` already exist, and `engine-boundary.test.ts` already proves `src/engine/` is
self-contained — so the open question was never "can it be lifted" but **what belongs in it**, which
task #4 called the published-API decision and which nothing had decided.

**Decided and enforced:** `synthetic/`, `ingress/`, `immunization/` and `cli/` are app content. Every
cross-area edge among **production** files runs app to core, with exactly one exception
(`cql/codegen/generate-sql-cli.ts`, a CLI entrypoint, so app-side too). That matters because
`synthetic/employee-catalog.ts` is a fictional employee directory and the most-imported module in the
tree — 51 call sites — so shipping the directory as the package would publish our fixtures as API.
`engine-core-boundary.test.ts` computes the core closure and asserts it reaches nothing outside the tree,
contains no app-area file, has no `node:` import, declares exactly `cql-execution` + `cql-exec-fhir`, and
that **the app imports the core only through the eleven declared entry points**. Every assertion is
mutation-checked.

**NOT decided, and review was right that this is the substantive half.** `cql-execution-engine.ts`
hard-imports our own 15-measure catalog, 17 compiled WorkWell ELM libraries (17 of the 29 closure
members) and a value-set table whose docblock opens "the codes **the synthetic corpus** stamps". The
argument used here to exclude `synthetic/` applies to those with equal force. ROADMAP §7.4 had scoped the
clean-core claim to a **9-file** closure; my first draft widened it to 29 without noticing, and
`LOCKED_DECISIONS` already records that `evaluate(input.elm, input.metaOverride)` supports
consumer-supplied measures — so the content is a default, not a necessity. Whether the package ships it
or takes it injected is task #4's real question, and it is deferred rather than answered.

**Three claims in my first draft were false, and are withdrawn rather than softened.** (1) That moving
`DEVDB_WHITELIST` is "what lets the package rule be no `node:` at all" — measured false: the identical
closure algorithm run against `main` gives a byte-identical 29-file, zero-`node:` closure, because the
closure contains no `ingress/` file for the constant to have been in. (2) That "the four `*-cli.ts` files
are now true leaves" — `generate-sql-cli.ts` still exports `WCDB_SQL_MEASURES` to two modules, and the
`node:` carve-out in `engine-boundary.test.ts` is untouched. (3) The ADR-048 "correction" **put a sentence
in quotation marks that ADR-048 does not contain**; ADR-048's counts were exact and it had already flagged
the production consumer, so my finding restated it rather than refuting it.

**Also corrected:** the "exactly one exception" claim covers production files only — there are seven more
core-to-app edges from test files plus two core tests reaching `stores/sqlite/**`, and the closure
structurally cannot see any of them. ADR-048 §5 already named that hazard, and it is the extraction's real
blocker. The move is bigger than stated: 29 closure members are 12 TS modules + 17 `.elm.json` data files,
"~87 import sites" is really 125 statements across 85 files, `cql/codegen/` does not move as a unit, and
`cql-libs.d.ts` must move although **no import can see it**. And the move will *not* "satisfy an
already-green test" — the test resolves paths from its own location, so both it and the API check need
rewriting as part of the move.

Review also caught four code defects: a non-`.ts` closure member was added without an existence check (so
a dropped ELM library grew the closure silently while the assertion message claimed the opposite); the
new API scan walked `node_modules`, where 39 of 40 files found under `packages/` were a vendored
dependency's `.d.ts` reached through a pnpm symlink that `statSync` throws on when dangling; and
`stripComments` can swallow an import after a `/*` inside a string literal — inert today, but
`generate-cql.ts` is in the closure and emits CQL, whose block-comment syntax is exactly that.

**`packages/measure-engine` does not exist yet.** What this PR buys is narrower than the first draft
claimed: between now and the move, the app cannot quietly acquire a core-internal import and the core
cannot quietly acquire an app or third-party dependency.

## 2026-07-31 (M-B) — QRDA Category I import exists, and the round trip caught the export lying (branch `feat/qrda1-import`)

`POST /api/runs/:id/evaluate` now accepts `{ measureId, qrda1 }`: a QRDA Category I document is
translated to FHIR and evaluated by the **unchanged** engine. That is §170.315**(c)(2)** "import and
calculate" literally, and it closes the half of the roadmap's proof chain we had not built.

Import is a **mapping**, not a second calculator — a second calculator is the thing that criterion is
meant to detect. The XML reader is hand-rolled (`cda-parse.ts`, ~180 lines) because CLAUDE.md forbids new
dependencies and Node ships no DOM parser; it is total on malformed input and decodes **only** the five
predefined entities plus numeric refs, so there is no entity table for an attacker to grow. Lookups match
the local name, since CDA appears in the wild both namespaced-by-default and prefixed.

**The round trip immediately caught a defect — in the EXPORT.** Driving the real route (evaluate a
bundle → export the document → feed the document back) produced a different answer for `audiogram`.
Cause: that measure's bundle binds synthetic **`urn:workwell:vs:*` value sets, which have no CDA code
system OID**, so every clinical resource was silently dropped and the export reported only "no QDM
patient data entries" — true, and the misleading half of the truth. The translator now returns *why*
each resource was dropped, and those reasons reach the non-conformance list.

The consequence is structural rather than a bug to fix later, and worth saying plainly:

> **A QRDA Category I is only a meaningful artifact for measures whose data is in real terminology** —
> LOINC, SNOMED, CPT, ICD. That is the official measures. WorkWell's authored measures cannot be
> exported as QRDA at all, and now say so.

That also sharpens locked decision #4 (retiring the authored cms122/125 subsets): the authored catalogue
is not QRDA-representable, so it cannot join the certification rehearsal either way.

**Verified against a document we did not write.** The CMS RY2026 sample imports cleanly — 1 subject, 6
resources, both eMeasure UUIDs — and **names all 47** QDM datatypes it does not translate rather than
dropping them silently. That test self-skips without `WORKWELL_QRDA1_SAMPLE` and says so in its skip
message, because the sample ships in the same manually-downloaded CMS zip as the Schematron.

**Review found five more, and one exposed a test whose NAME lied.** The refusal checked that the Patient
Data section *existed*, not that it had entries — so our own no-bundle export (the document that declares
itself non-conformant) imported to a Patient-only bundle and would have persisted a plausible
out-of-population outcome. The test covering it was called `import REFUSES our own no-bundle export` and
asserted the hollow bundle **came back**. Also: the requested measure was not checked against the
document (a CMS125 document posted as `cms122` was calculated *and persisted* as cms122); the
`untranslatedTemplates` qualification died with the HTTP response instead of being stored in evidence;
timezone offsets were discarded (`…230000-0500` is a different day *and year*); and an Observation
interval collapsed to an instant, dropping the end a temporal CQL predicate turns on.

**A second review pass found eight more, and the first was the whole feature being wrong on the measure
this stack actually routes.** The import wrote `Patient.gender` and no `us-core-sex` extension — and
official CMS125's initial population reads the extension, never `gender` (ADR-042). Measured: source
bundle in-IPP and COMPLIANT, round-tripped **out of the IPP** and MISSING_DATA. On demo/production, where
both measures are routed to official, `(c)(2)` would have calculated every imported subject
out-of-population, persisted it, and returned 201 with an empty gap list. The round trip could not see it
because it never runs the official engine, and the test meant to cover it asserted `gender === "female"`
**while citing ADR-042 in its comment** — naming the right hazard and measuring the wrong element. There
is now a test that asserts population membership itself, mutation-checked, and wired into the CI job that
has the terminology sidecar (the workflow warns in a comment that a sidecar test not listed there is
permanently skipped while reading as covered — which is exactly how this class recurs).

The parser needed three fixes and two of its own claims were false. A legal `>` inside an attribute
(`displayName="HbA1c > 9.0%"` is conformant XML) truncated the element, which then swallowed its siblings
and silently deleted the date and value from an HbA1c of 9.6 — the round trip *cannot* catch that,
because our own `esc()` escapes `>` so we never emit the input that breaks us. Unmatched close tags were
quadratic: **1 MB took 53 seconds** on this single-threaded host, an accidental DoS from a truncated
document, past nginx's 60 s timeout. And `descendants()` recursed, blowing the stack at ~5 000 levels —
a ~30 KB document — so "every branch is total" was true of the parser and false of its helpers.

Also: only ONE resource was imported per `<entry>` while the entry was reported fully translated (a
Result Organizer with two labs is standard CDA, so an HbA1c that is a panel's second component simply
vanished); two drop reasons named the wrong cause; the reason list was unbounded and duplicated (302
reasons, 3 unique, 31 KB per subject); and the date-only path had no validation, so `00000000` became
`"0000-00-00"` in a birth date that CMS125's IPP feeds to `AgeAt(...)`.

Still open for M-B: **Cypress CVU+ has not run.** It needs Docker and remains the bar.

## 2026-07-30 (M-B) — QRDA Category I was built inside-out; measuring against the right IG showed it (branch `feat/qrda1-patient-data`)

Yesterday's question — *"is CMS QRDA Category I applicable to Eligible Clinicians at all?"* — was filed
as a milestone-shaping unknown. Answering it cost an afternoon and invalidated the design shipped hours
earlier, which is the best possible outcome for a question that cheap.

**The answer is two-part.** What is Hospital-only is the **CMS** QRDA I IG — titled "for Hospital
Quality Reporting", governing IQR / Medicare PI / OQR — and its Schematron, which is the exact file #360
validated against. QRDA Category I **itself** is squarely in scope for ECs: §170.315**(c)(1)** "record
and export" and **(c)(2)** "import and calculate" both require it per §170.205(h)(2) = HL7 QRDA I R1 STU
5.3, setting-neutral, with (c)(1) in the Base EHR definition. Only **(c)(3)** "report" splits by setting
(Cat I inpatient, Cat III ambulatory). Cypress supports 56 EP/EC eCQMs with Cat I test data and validates
Cat I against the HL7 standard, explicitly *not* the extra CMS constraints. So: keep Category I, change
the ruler.

**Then measuring found something much worse than a wrong ruler.** QRDA Category I does not report
population membership *at all*. Not one of the four CMS RY2026 sample files contains an `IPOP`, `DENOM`,
`NUMER` or `MSRAGG` — the document carries the patient's clinical data and a measure reference, and the
receiver **recalculates**, which is what "(c)(2) import and calculate" literally says. ADR-049 shipped
Category III machinery (`…27.3.24`) in a Category I envelope *and* an empty Patient Data section, while
that section **SHALL** contain at least one entry (CONF:67-14567). It was inside-out on both axes.

**So the population assertions came out and the QDM entries went in.** `src/fhir/qdm-entries.ts` maps
the five datatypes CMS122/CMS125 consume: Encounter Performed, Diagnosis — inside a **Diagnosis Concern
Act**, a SHALL the first cut missed (CONF:4509-28885) — Laboratory Test Performed (result nested in a
Result observation, which is what `[Observation: "HbA1c"] where value > 9` actually reads), Diagnostic
Study Performed (outer `value`, SHALL even for a screening mammogram with no result — `nullFlavor="NA"`,
the CMS sample's own idiom), and Procedure Performed. An `Observation` routes on **`category`**, the
same discriminator CMS125's official numerator uses (ADR-044); one we cannot classify is **skipped, not
guessed**, because absent is visible and wrong-datatype is not.

**Result, measured:** 27 findings / 14 base-HL7 errors → **0 base-HL7 errors**, plus 4 CMS-hospital-only
findings that are *expected* because we deliberately stopped claiming the CMS document template
(`…24.1.3` = "QRDA Category I Report CMS" — claiming a template whose IG we don't conform to is a
misdeclaration). Without a bundle the document has exactly one base error, the missing entry, and says
so in prose.

**Two of #360's own findings are corrected, both by measurement rather than re-reading.** `<addr>` DOES
have a nullFlavor escape — element-level `<addr nullFlavor="NI"/>` fails CONF:81-7291/7292, but an
`<addr>` with **nullFlavor children** passes, so an address is **not** an ingest prerequisite (same for
`raceCode`/`ethnicGroupCode` via `UNK` — two SHALLs #360 never recorded at all). And the hypothesis that
re-targeting would shrink the gap list was **wrong**: only 3 of 27 findings were CMS-only; every
substantive gap was base HL7 all along.

**The measurement is now a command**, not an afternoon: `scripts/qrda-schematron-check.py` runs the
published Schematron and partitions failures by conformance-number prefix (base HL7 = our bar,
`CONF:CMS-*` = not). It is deliberately **not** in CI — it needs Python + lxml, which must not become
backend-ts dependencies — so the structural regressions it catches are pinned in TypeScript, each
assertion citing the CONF number it stands for. #360's numbers were right and unreproducible; that is
how one of them stayed wrong.

**Stated rather than smoothed over:** bundles are re-read **at export time**, so a subject whose record
changed since the run exports the current record. Making it as-evaluated means persisting bundles — a
schema change, and the owner's. They are **not** reconstructed from the persisted outcome, because
`deriveExamConfig`'s own contract says the target is a distribution *bucket* that can converge (CMS122
DUE_SOON → MISSING_DATA), so status → bundle is not injective. The synthetic default stack therefore
exports documents flagged `conformant: false`. QRDA I **import** still does not exist and **Cypress CVU+
has not run** — it needs Docker and remains the M-B bar.

**Review caught four defects, three P1, and one of them is the vacuous-guard shape again.** A live run
persists `subjectId` as `wc|<patientId>` while the bundle carries the bare `Patient.id`, so the bundle
lookup — the whole point of the change — could never match on the only path meant to produce conformant
documents. Also: an `entered-in-error` mammogram became a `Procedure, Performed` with
`statusCode="completed"` (now denylisted — a *denylist*, because real WebChart rows arrive
`status: "unknown"` and an allowlist would silently drop them), and a live subject's name came out as
`wc|123` because `employeeById` only knows the synthetic catalog.

**On the fourth we disagreed with the reviewer, deliberately.** It asked us to re-apply
`stampEnrollment` at export so a receiver reproduces our answer. That overlay includes a **synthesized**
CPT 99213 Encounter (ADR-042) — WebChart supplies none — and a QDM `Encounter, Performed` asserts the
encounter *happened*. Exporting it would be a silent false clinical assertion inside a regulatory
artifact, which is exactly what ADR-037 forbids. So we export real data and **name the omission**, and
`caveats` is kept as a separate field from `conformant`: a document missing roster evidence is still a
valid QRDA I, and one boolean must not mean two things.

**A second review pass changed what the headline number MEANS.** The partition classified every
`CONF:CMS-*` assert as "not our bar" — but CMS_0105–0113 (HL7 abstract datatype rules) and CMS_0115–0120
(NPI/TIN validity) carry CMS numbers while binding *any* conformant CDA. Demonstrated on the real
artifact: a lab result emitted as `value="not-a-number" nullFlavor="NI"` tripped only `a-CMS_0110` and
was reported as **0 base-HL7 errors, exit 0** — the number quoted in three documents. Now counted as
ours, with a negative control pinned in `docs/evidence/`. Deliberately *not* reclassified: **CMS_0121**
("a UTC offset should not be used"), which directly contradicts base HL7's CONF:81-10130 ("SHOULD include
time-zone offset") — the clearest evidence the partition earns its keep.

**Three more, and one is the vacuous-guard shape inside the fix for the previous vacuous guard.** FHIR
`Condition` has no `status` element — retraction lives in `verificationStatus` — so the retraction
denylist could not fire for the one datatype CMS122's denominator is built on. Also: `hl7Ts` throws by
design and `esc` called `.replace` on its input, so one MariaDB zero-date on subject 200 of 500 lost all
500 documents (each resource now translates inside its own try/catch — which is what the module's own
docblock already *claimed*, while implementing it for structural junk only); and `effectiveTime` had a
dead `abatementDateTime` branch plus two lossy ones.

Recorded rather than fixed: `loadBundles()` crawls the whole tenant, sequentially and uncached, and is
not scoped to the run's subjects — `MAX_INDIVIDUAL_REPORT_SUBJECTS` bounds the documents, not the fetch.
Fine on the dev fixture; it is the request that times out on a production tenant. And the endpoint's PHI
sensitivity changed materially — it used to emit population flags and now emits diagnoses, lab results
and procedures as CDA, behind JWT with no role gate and no audit event. Consistent with the other export
endpoints, so no rule is breached, but it is the owner's call under `PRODUCTION_READINESS_2026-07.md`
rather than something to inherit.

Full backend suite: **1651 pass / 0 fail / 14 skipped** (49 in the two QRDA files after both review rounds).

## 2026-07-30 (M-B) — QRDA Category I exists, and says in the document what it cannot do (branch `feat/qrda1-export`)

The roadmap audit recorded "**QRDA-I does not exist anywhere**". It does now: one CDA document per
subject, at `GET /api/runs/:id/qrda1`.

Three things carried over from work already done, and they mattered more than the XML. Membership is read
through `membershipFor`, so an official-routed outcome's populations come from `evidence.official` and
never the workflow status — for cms122 a status-derived document would have reported a poor-control
patient as OUT of the numerator, the exact inversion ADR-031 fixed for MeasureReport. The measure is
referenced by its published eMeasure UUIDs (ADR-046), because a receiver resolves numerator orientation
from that identity. And every population is emitted including the false ones, so "not in the numerator"
and "the numerator was not reported" stay distinguishable.

**The decision I spent the most care on is the Patient Data section, which is empty on purpose.** QRDA I's
job in a certification setting is to carry the QDM entries a receiving engine RECALCULATES from. We do not
export them. So the section ships with `nullFlavor="NI"` and a plain-English note saying exactly that —
because a section that *looked* populated would be a document that validates structurally and cannot do
the one thing it exists for, and an absent section would hide the gap. It is stated in the artifact, where
a recipient sees it, not only in a doc nobody opens.

**Conformance is unchanged in kind:** well-formed and structurally representative, the same level QRDA III
has carried since ADR-009. TemplateIds are not evidence. **Cypress CVU+ has not run** — it needs Docker,
which is unavailable here — so nothing in this PR may be called validated, and the conformance row says so.

Two smaller things. CDA primitives moved to `qrda-common.ts` rather than being copied, because the two
documents describe the same run and the certification loop compares them — a timestamp format drifting
between them would look like a validation finding nobody caused. And well-formedness is *tested*: this is
hand-built XML, so balance is a property to check, and CLAUDE.md forbids adding an XML parser without
approval — so the test carries a dependency-free tag-balance/escaping checker. Mutation-checked:
unbalancing a tag or dropping an `esc()` fails three tests.

Verified: typecheck clean; **1633 tests / 1619 pass / 0 fail / 14 skipped**.

## 2026-07-30 (later) — M-C step 1: the extraction debt is paid, and the extraction is not what it looked like (branch `feat/measure-engine-package`)

The engine-boundary test has carried an allowlist entry since PR-1 that described its own removal:
`@cqframework/cql` "is a real runtime dep of this tree TODAY. PR-2 moves `cql-translator.ts` to the app,
which is what restores the two-dependency package story." Done — four importers, plus its `resources/`
directory and a re-pointed `compile-measures.mjs`. The allowlist entry is deleted and its self-test
**inverted**: it used to assert the dep "must be permitted in cql-translator.ts", and now asserts it must
not be permitted anywhere in the engine tree. The manifest is real rather than aspirational.

**Then I measured what the extraction would actually publish, and it changed the shape of the work.**
Counting the app's imports from `engine/`:

| import | count |
|---|---:|
| `synthetic/employee-catalog.ts` | **50** |
| `cql/measure-registry.ts` | 32 |
| `synthetic/measure-bindings.ts` | 25 |
| `ingress/webchart/live-directory.ts` | 20 |
| `synthetic/exam-config.ts` | 19 |

**The largest single export of a wholesale `@workwell/measure-engine` would be a directory of 150 fake
employees.** Nobody installs a measure engine to get demo data. The roadmap already says the package is
"cql-execution+cql-exec-fhir only" — so `synthetic/` (5 files) and `ingress/` (15) are app concerns that
happen to live under `engine/`, and M-C is a **boundary split**, not the file move the task name implies.

**And my "good news" measurement was wrong** — review caught it, and it was the claim the whole conclusion
rested on. `cql/` does reach app-side code, transitively:
`cql/codegen/generate-sql-cli.ts` → `ingress/webchart/terminology.ts` → `synthetic/measure-bindings.ts`.
My grep looked for `synthetic/` and the specifier was `../../ingress/...`. The roadmap had already recorded
this exact edge and scoped its clean-core claim to a 9-file closure; I widened a true narrow claim into a
false broad one. Corrected: the eval core **minus the two `generate-sql` CLI files** is clean, and those
files are app composition that stays behind — the same call the roadmap already made for
`resolveDataSource`.

**Worse, this PR created two new engine→app edges and I did not notice.** Moving `cql-translator.ts` turned
two sibling imports in `cql/codegen/*.test.ts` into `../../../measure/` imports, so the engine's
YAML→CQL→ELM→evaluate parity gate came to depend on an app module. The boundary test deliberately exempts
test files ("the rule protects what would ship") — which is precisely the blind spot that let it through.
Both tests now live in `src/measure/` beside the compiler they exercise. The engine tree is self-contained
again, verified by grep rather than assumed.

**I stopped there deliberately.** Step 2 decides what a published package exports, and that is hard to
reverse once it is on a registry — it is a design review, not a mechanical rewrite, and bundling it into
an unattended PR would bake in a public surface nobody looked at. The measurement above is the input to
that decision; ADR-048 records it.

Verified: typecheck clean; 1623 tests / 1609 pass / 0 fail / 14 skipped; boundary test green with the
tightened rule.

## 2026-07-30 (later still) — M-A wave 2: three more measures onboarded, three refused (branch `feat/official-measures-wave2`)

Vendoring all six remaining priority measures took minutes. Deciding which could be **onboarded** took the
gate, and it disqualified half of them — for three different reasons, which is the useful part.

| measure | MADiE | outcome |
|---|---|---|
| CMS2 depression screening | **36/36** | onboarded |
| CMS68 current medications | **19/19** | onboarded |
| CMS951 kidney health eval | **55/55** | onboarded |
| CMS138 tobacco screening | **0/47, 47 errors** | refused — a value set will not expand |
| CMS130 colorectal screening | not run | capped expansion, needs the VSAC key |
| CMS165 controlling high BP | not run | **two** capped expansions, needs the key |

**CMS138 is the one worth dwelling on.** It vendors cleanly, loads cleanly, and produces 47 errors out of
47 cases: value set …3.526.3.1278 cannot be expanded from the artifact's own terminology, so official
execution would report every subject out-of-population. That is precisely the silent-empty-population
failure this whole line of work has been building guards against — and here the gate caught it before it
could become a config. There is no version of "ship it and watch".

**CMS130 and CMS165 are absent from the tree rather than committed capped.** Both need
`--complete-capped-expansions` with `WORKWELL_VSAC_API_KEY_VENDOR`, which exists only as a GitHub secret —
I can read that it exists, not what it is. Committing a capped artifact would put a permanently-unroutable
measure in the tree whose manifest CI would rewrite the moment it joined the vendor list. Owner step,
narrow and stated (task #10).

**Three things silently stopped meaning "the full gate" the moment a third measure existed**, and I only
found them by running it: `parseArgs` defaulted to a hardcoded `["cms122","cms125"]` and rejected anything
else; the sparse checkout fetched two measures' cases; and the committed-report predicate was
`measures.length === 2`. That last one is the dangerous one — a full five-measure run would have written
**nothing**, and CI's staleness check would then have compared it against a two-measure file. All three now
derive from `OFFICIAL_GATED_MEASURES`, and `OfficialMeasureId` is `keyof typeof MEASURES` rather than a
hand-maintained union that had to be edited in a second place.

**One guard fired exactly as designed and I want to record that it was right.** `official-artifacts.test.ts`
hardcodes the vendored list with the comment *"adding a measure should be a conscious edit here… a new
artifact appearing unannounced is a review event."* It failed my run. That is the guard doing its job, and
updating it is the conscious edit it demands.

**Routable is not routed.** These three have no authored counterpart, so `flip-snapshot`'s
authored-vs-official comparison — what every flip so far has been judged on — cannot run for them, and the
roster/catalog still assume an authored measure exists. What replaces that oracle is the question the next
flip has to answer, not one to hand-wave now.

Gate is now **231/231** across five measures. Verified: typecheck clean; 1622 tests / 1608 pass / 0 fail /
14 skipped; 54/54 workflow run-blocks parse.

## 2026-07-30 (later) — the reporting trio, and cms122 joins the flip (branch `feat/official-reporting-trio`)

PR-9c shipped cms125 alone because review found cms122 would emit a self-contradictory MeasureReport. This
discharges that, and cms122 is now routed too.

**The obligation was written in the codebase, in the file that had to honour it.** `measure-report.ts` has
said since PR-3: *"the measure that flips MUST switch all three together — canonical, improvementNotation,
and membership."* PR-3 made membership evidence-first and left the other two static. For cms122 that is not
cosmetic: its official numerator is **poor glycemic control**, so `increase` asserts higher-is-better about
a numerator counting harm — ~120 → ~27 on the 150-employee directory — and QRDA III has no notation element
at all, so there the inverted count would have shipped unmarked.

**All three now derive from the outcome's own `evidence.official`.** Deliberately not from the env flag:
a report describes the run it was built from, and a run's provenance does not change because someone later
flips a flag. Asking `WORKWELL_OFFICIAL_MEASURES` at export time would relabel every historical export the
day the config moves — the same reasoning `aggregateCountsForRun` already applied to counts, now applied to
the label as well.

Three details worth keeping:

- **The notation comes from `OFFICIAL_MEASURE_SEMANTICS`, not the artifact.** cms122's own artifact says
  `increase`, contradicting eCQI's description of the measure; the semantics table records that
  human-reviewed decision with its rationale. A routed measure with no recorded semantics alerts rather
  than guessing — guessing one way reports every failure as compliant.
- **The canonical is claimed only for the artifact that produced the outcome.** A re-vendor between run and
  export moves the sha, and the report falls back to a version-qualified urn. Labelling an old report with
  a new canonical asserts a provenance that never existed.
- **QRDA III got the measure IDENTITY, not a new element.** It has no notation field by design — a receiver
  derives direction from the measure identity — so emitting `urn:workwell:measure|cms122` over CMS's
  poor-control numerator was the actual defect. The counts were already right.

**The old guard could not have caught any of this**, and that is the reusable lesson: its fixtures carried
no official evidence, so it only ever exercised the authored path and passed while asserting
`"COMPLIANT is WorkWell's numerator"`. A test whose fixtures cannot reach the branch it names is the same
vacuous shape as a test that self-skips. The replacement builds a real summary report from a synthetic
official outcome for **every measure the workflows ship** and asserts the notation matches the semantics —
so cms122's exclusion was enforced by the guard, and its inclusion now is too. Mutation-checked: breaking
the derivation fails three tests across two files.

Verified: typecheck clean; **1612 tests / 1598 pass / 0 fail / 14 skipped**; 54/54 workflow run-blocks parse.

## 2026-07-30 (PR-9c) — the flip: CMS125 now runs CMS's published artifact (branch `feat/official-flip-pr9c`)

Everything since ADR-036 was building toward one line in a workflow file. It is set:
`WORKWELL_OFFICIAL_MEASURES="cms122,cms125"` on `deploy-twh-mieweb.yml`. **M-A is complete.**

**What made it decidable rather than a leap.** Two things, both from the last two PRs. ADR-044 closed the
mammography numerator gap — the last known way official could contradict authored on data this stack
holds. And `flip-snapshot` turned checklist step 2 from prose into a number: both measures admit **5 of 5**
corpus subjects to the official initial population and agree with authored on every one, across
COMPLIANT/OVERDUE/EXCLUDED. The evidence is committed at `docs/evidence/PR9C_FLIP_SNAPSHOT_2026-07-30.md`
rather than pasted into a PR comment, so the numbers this was approved on outlive the approval.

**cms122 goes too, and that is ADR-043 decision 6 paying off.** An earlier draft had removed it for
reading out-of-population over WebChart data. It does — but `deploy-twh-mieweb.yml` carries zero
`WORKWELL_WEBCHART_*`, so this stack evaluates the synthetic roster where cms122 scores normally. The
finding constrained staging, not the flip, and measuring both stacks separately is what kept a correct
measure from being dropped on a true observation about a different environment.

**The new guard is the interesting part.** Every check in this area validated a configuration a test
passed in; nothing validated the string that actually reaches production. So a future edit adding
`cms130` before it is vendored would deploy green, satisfy `/actuator/health` (deliberately DB-free, so it
answers 200 regardless), keep the self-heal reconciler quiet — and 500 every evaluating route, because
official routing refuses at engine construction, **per request**. `official-flip-config.test.ts` now parses
`WORKWELL_OFFICIAL_MEASURES` out of both deploy workflows and asserts everything named is gated, vendored,
proportion-scored and routing-clean. Mutation-checked: adding `cms130` fails it with the reason.

Split in two on purpose — the structural half is pure and always runs, the terminology half needs the
gitignored sidecar and is wired into CI's `official-cases` job. One combined test would have self-skipped
in `pnpm test` and read as covered, which is the defect class this branch has now been pulled up on four
times. I also deliberately did NOT pin *which* measures are flipped: that would make every future flip a
two-file change guarded by a test that only says "you changed what you changed".

**Verified the boring thing that would have been embarrassing:** the flag is added inside a `jq` program
in a single-quoted shell string, and I wrote `#` comments around it. jq does support comments — but I ran
the extracted program rather than assuming, and confirmed it still emits all 18 env entries with the new
one among them.

**The flip is inert on this stack's data**, and that is the expected result. No roster row changes. The
value is that official execution is running in production at all — the precondition for the remaining six
priority measures, and for saying WorkWell *executes* published eCQMs rather than reimplementing them.

Post-deploy checks are written into the evidence doc, and the first one matters most: **grep for
`OFFICIAL_ROUTING_MISCONFIGURED`**, because a green container is not evidence here. The nightly scheduler
is on, so the first scheduled ALL_PROGRAMS run will exercise the flip without anyone triggering it.

**Then my own reviewer found two BLOCKERS, and the first is the most embarrassing thing in this session.**

**The deploy step was a bash syntax error.** I put a comment inside the `jq` program — which lives in a
single-quoted shell string — and wrote `CMS's` and `WorkWell's`. The first apostrophe closes the quote.
I had "verified" the change by extracting the jq program and running it standalone, which bypasses the
shell quoting entirely: the program was always fine, the string containing it was not. `bash -n` on the
extracted run-block says `unexpected EOF while looking for matching '`.

What makes it worse than a red build: `build-backend-ts` would have succeeded and pushed a new `:latest`,
the deploy step would have died *before* the delete/recreate so the live container survived on the old
image — and then the 15-minute self-heal reconciler, which I had *just* taught to carry the flag, would
have recreated it from the new `:latest` and delivered the flip unattended while the deploy pipeline was
red. The exact silent-delivery class this PR exists to prevent, built by the two fixes interacting.
Nothing could have caught it: deploy workflows only run on push to main, and my new config test passed
3/3 because it validates the semantics of a line the shell would never execute.
`.github/scripts/workflow-run-blocks.test.sh` now `bash -n`s all 54 run-blocks in CI. Its own first
version reported "all parse" after checking **zero** — so it has a minimum-block floor now, which then
immediately earned its keep by catching that the extractor emitted Windows-style paths bash could not stat.

**cms122 is OUT of the flip, and the reason is in the codebase in writing.** `measure-report.ts:246-252`
says: *"the measure that flips MUST switch all three together — canonical, improvementNotation, and
membership."* cms122's official numerator means **failure** (HbA1c > 9%), but `measure-bindings.ts` still
declares `improvementNotation: "increase"`. Routing it would emit a MeasureReport claiming higher-is-better
over a poor-control numerator — ~120 → ~27 on the 150-employee directory — and QRDA III carries no
notation field at all, so the inverted count ships unmarked. The guard test that "pinned" this only ever
exercised the authored path, so it could not fail when official evidence arrived. cms125's trio is already
consistent, so it goes alone; `official-flip-config.test.ts` now refuses any measure whose official
numerator means failure while its notation says `increase`, which is what excludes cms122 — enforced,
not remembered.

I also had to correct the evidence doc: it claimed 35 tests where CI now runs 38, and said "the corpus
this stack evaluates" when the corpus is five probes and the stack evaluates 150 employees. The
conclusion (inert) survives — the roster figure is derivable because both paths call the same
`deriveExamConfig`/`buildSyntheticBundle` and cms125's bundle hardcodes everything that matters — but
"derived" and "measured" are not the same word and the doc now says which it is.

**Codex found the one that would have undone the whole thing.** `reconcile-twh-mieweb.yml` — the self-heal
that recreates twh-api-ts from `:latest` when the container goes down — builds its OWN mirrored env array,
and it did not carry `WORKWELL_OFFICIAL_MEASURES`. So the first health event after this flip would have
silently reverted both measures to authored CQL: container healthy, image unchanged, no signal anywhere.
The flip would have lasted exactly until the next incident. Fixed, and the guard now asserts the two
workflows ship the same *value* — not merely that both mention the flag, because a reconciler with a
different subset would flip measures on or off during an incident nobody initiated. Mutation-checked by
deleting the line.

It also caught that my new routability assertion would have gone red on **every fork and Dependabot PR**:
those contexts get no VSAC secret, so CI deliberately re-vendors without `--complete-capped-expansions`,
and `officialRoutingProblems` refuses a capped expansion by design. The capped class is now excused
exactly when the tree is actually capped; every other class is asserted always. A guard that fails
outside contributors for a condition unrelated to their change trains people to ignore it, which is the
same disease as a guard that cannot fire.

Still not done: the authored cms122/125 subsets retire to the fidelity lab next (locked decision #4,
deliberately not in the same change that starts the flip), and **Cypress CVU+ has still not run** — it
remains the verification bar.


## 2026-07-30 (later still) — the mammography numerator, and giving the flip gate a command (branch `feat/webchart-mammography-dual-stamp`)

The last thing standing between here and PR-9c was the numerator gap ADR-042 recorded and ADR-043 could not
see. It is the nastiest of the three WebChart↔official divergences because it is **silent by construction**:
the subjects it affects *are* in the initial population, so the ADR-043 WARN is correctly quiet while
official reports a woman who has been screened as OVERDUE — and `case-logic.ts` turns that into a
HIGH-priority "escalate mammogram follow-up immediately". A confident wrong answer on the ordinary case.

**The cause is two engines reading two resource types for one fact.** Authored `cms125.cql` retrieves
`[Procedure: "Mammography"]` and its value set carries CPT/HCPCS; official CMS125 retrieves
`isDiagnosticStudyPerformed([Observation: "Mammography"])` over **92 LOINC codes with no CPT in them**, and
additionally requires `category ~ imaging`. WebChart records mammograms as CPT `77067` / legacy `G0202`
procedures. Each single-representation fix fails, and they fail in *opposite* directions — which is why
"just emit the LOINC Observation" is wrong, and why a LOINC Observation without `category` looks like a fix
and changes nothing.

**So the crosswalk dual-stamps** — both representations of the one row, in both mapping sites, exactly as
`us-core-sex` did. What took the most care was writing down *why this is not fabrication* (ADR-037), and
turning that into three tested properties rather than an assurance: derived strictly from a real row, an
explicit code allowlist rather than a category sweep, and non-inflating because both numerators are
`exists(...)`. That third one has a real limit I made sure landed in `WEBCHART_FHIR_MAPPING.md` §3.6 rather
than in my head: **this pattern would double-count for a counting measure.** The next dual-stamp has to
re-check it.

**The fixture moved by one resource and no outcome.** Its only mammography record belongs to wc-49, who is
33 and outside the `[42..74]` IPP. That is exactly why the dual stamp is asserted *directly* on the fixture
instead of inferred from an unchanged distribution — an unchanged distribution here proves nothing. Docker
was down, so rather than skip it I replayed the generator's own insertion rule over the committed artifact
and verified the diff was precisely 28 lines of one Observation. Recorded as such in ADR-044: a re-export
when the dev DB is up should be a no-op, and if it isn't, the fixture is wrong.

**The second half of the PR is the part review earned.** #354's reviewer made the fair objection that
ADR-043 moved enforcement onto "the flip gate" while the half of that gate which can actually see a tenant
— confirm a non-zero initial population, take a before/after snapshot — shipped as prose with no command
and no artifact. That is the same vacuous-guard shape this branch has now been pulled up on three times
(#350, #352, #354), and it deserved a tool rather than a third promise. `pnpm flip-snapshot` evaluates a
measure through both engines over the same bundles and reports the before/after distribution, the official
IPP count, and every subject whose row would change.

**It renders a verdict and gates nothing, and that split is the whole design.** ADR-043 established that a
machine cannot tell "nobody qualifies" from "the data lacks an element the IPP reads" by shape alone. What
a machine *can* do is compute the comparison a human needs — official admits nobody while authored finds
actionable subjects in the same bundles ⇒ the cohort is not the explanation. So it says **DO NOT FLIP**
there, **INCONCLUSIVE** where both engines are blind, and exits 0 regardless. Wiring it into CI as pass/fail
would re-assert exactly the judgement ADR-043 rejected, so the ADR says not to.

**Running it produced the flip's evidence rather than an argument for it.** On the synthetic roster the
demo/production stack actually evaluates: cms122 and cms125 each admit **5 of 5** to the initial population
and agree with authored on every subject. Over WebChart data: cms125 admits 4 of 56 and agrees on all 56;
cms122 admits 0 of 56 and reports INCONCLUSIVE — a data gap, not a divergence. That is ADR-043 decision 6
confirmed by measurement instead of by reasoning about which stack has which seam.

**Then two review passes found four more, and the worst one was mine.** Codex caught that `--source
webchart` always loaded the committed fixture — so the command DEPLOY.md sends an operator to for "confirm
a non-zero initial population against the tenant's own data" could not see a tenant at all. Fixing that by
adding a real `--source live` **introduced a worse bug**, which my own reviewer then caught: `live` reused
the committed `enrollment-roster.json`, which is keyed by `wc-N` ids. `stampEnrollment` is a *silent no-op*
for any subject absent from the roster, so against a real tenant nobody would be enrolled, the roster's
synthesized CPT-99213 Encounter would never be stamped, authored CMS125's `Has Qualifying Visit` would fail
for everyone, `authoredActionable` would collapse to 0 — and the report would print **"the flip is inert
rather than wrong"** for a tenant whose official roster reads empty. A false all-clear on exactly the
configuration this work documents as broken. `--roster` is now required for `live`, and a roster enrolling
none of the returned subjects is refused.

Two more worth recording rather than quietly fixing. **`--source synthetic` is not a roster forecast** — it
is five designed corpus probes, and DEPLOY.md claimed it read "the corpus roster a seamless stack
evaluates". It doesn't: the demo/production stack evaluates the full employee directory through the run
pipeline, and the five probes collapse into three buckets anyway. The report now names its source under
every measure. And **`hapi-live.test.ts` was named three more times as the drift guard between the two
mapping copies, and cannot be one** — both its sides originate from the committed fixture, so it never
sees the shim or the export script's SQL. The `us-core-sex` docstring had *already* retracted that claim
for its own field; I reasserted it un-caveated for mammography. Retracted in all three places, and the
honest statement is that no shim-vs-generator comparison exists at all.

Also fixed: the code lookup now trims and upper-cases like the crosswalk does (a `" g0202"` row reconciled
for authored but would have skipped the dual stamp — the same false non-compliance, through a whitespace
seam); the REFUSED text no longer blames the data for construction failures; and five README claims that
were simply false (1597 tests, an 8-way sharded CI that does not exist, a two-dependency engine that is
four, a `skipped 0` CI assertion that was never written, and Node 20 where `package.json` requires 22.16 —
plus a Quick start missing the submodule init, so it could not work on a fresh clone).

Verified: typecheck clean both packages; shim 31/31; `devdb-official-eval` **11/11 with 0 skipped**
(including the four failure states, kept because three of them are how a future simplification reopens the
gap); flip-snapshot report tests 6/6, deliberately pure so they can never self-skip the way the
sidecar-gated suites did.

## 2026-07-30 (later) — the PR-9c precondition, and the refusal review was right to kill (branch `feat/official-ipp-refusal`)

ADR-042 shipped with a limit it could only assert in prose: both `us-core-sex` mapping fixes sit upstream of
the live FHIR transport, so a third-party WebChart FHIR server still supplies no extension and its whole
roster reads out-of-population for official CMS125 — **silently**, as 100% MISSING_DATA rather than an error.
`deploy-staging-mieweb.yml` sets `WORKWELL_WEBCHART_BASE_URL`, so staging is exactly where official routing
and a live seam coexist. PR-8f's retrieve check cannot see it: official CMS125 matched **236 LOINC
Observations** on the WebChart fixture and still put all 56 subjects out of the IPP, `retrieveSignal` true
throughout.

**I built a refusal. Review (Codex P1) killed it, correctly, and the argument is the substance of the day.**
The first cut threw inside `evaluateBatch` when a batch of >1 came back with nobody in the initial
population, reaching the run pipeline's existing batch-failure isolation. That **converts a valid result into
corruption**: for a site- or program-scoped CMS125 run over an all-male cohort, zero-in-IPP is the *correct*
answer, and a batch failure re-throws per subject — so every outcome becomes MISSING_DATA carrying an
`evaluationError` **in place of** its `official.populationResults` evidence, the blob MeasureReport and QRDA
read (ADR-031), with a `PARTIAL_FAILURE` terminal and the #264 alert. A zero-denominator MeasureReport is a
legitimate reportable artifact, not an engine failure.

The decisive point, and the one I had under-weighted when I flagged this as an acceptable trade: **cohort
composition varies by run**, so "stop routing this measure" is not a remedy an operator can apply. A guard
whose false positive recurs and whose prescribed fix does not exist is worse than the silence it replaces.
I had reasoned "a measure that can see nobody is a configuration error whichever cause it is" — true of a
fixed cohort, false of a live one.

**What shipped instead.** The executor reports honestly; the run pipeline emits a **`WARN`** in the batch
pre-pass naming both causes and pointing at `WEBCHART_FHIR_MAPPING.md` §3.1; the run still reports
`COMPLETED` with evidence intact. **Enforcement moved to the flip gate** — `devdb-official-eval.test.ts` plus
a pre-flip checklist — because that is the only place the two causes *can* be told apart: when authored
finds four actionable women in the same bundles official finds nobody in, "this cohort is ineligible" is
demonstrably false. That comparison is not available at runtime at acceptable cost — it would mean running
both engines for every subject of a measure whose purpose is to replace one (`literal-diff.ts` does exactly
this as a diagnostic, so "impossible" was too strong; "prohibitive per run" is the defensible claim). **The
honest conclusion is that this hazard is not runtime-detectable without false positives**, which is weaker
than what I opened with.

**A second defect, and then the review found that my fix for it rested on a false premise.** I had written —
in five places — that "the authored engine never sets `inInitialPopulation`", and concluded from that the
check needed no gate on official routing. **It sets it always.** `deriveInInitialPopulation`
(`engine/cql/cql-execution-engine.ts`) emits the field for every measure carrying a boolean
`Initial Population` define, which is all 16 of ours, and the function's own docstring says so — I had read
the *stub probe* in my test file and generalized from it to production. Ungated, an authored measure whose
cohort sat wholly outside its own IPP would be told nobody entered the **official** initial population and
pointed at `us-core-sex`, for a measure with no official artifact. It never fired only because the synthetic
roster happens to put somebody in every measure's IPP — a property of the fixture, not an invariant, so the
guard was resting on roster composition. Now gated on the engine's declared identity (`logicVersionFor` →
`official-fqm:`, ADR-040): asking the engine what it ran, rather than inferring it. The test that "proved"
the old rule tested a shape production never emits; the shape that *does* occur — authored reporting `false`
for everyone — is now the test. `undefined` still means unknown, but as ordinary defensiveness rather than
as a load-bearing invariant.

Everything here is mutation-checked rather than asserted: removing the official gate fails the authored
test, relaxing `> 1` to `> 0` fails the single-subject test, and restoring the pre-pass reading fails the two
roster-completeness tests — each exactly, with no collateral.

**I also got a scope decision wrong, and review caught it.** Running the check against the real artifacts
flagged *two* measures, and only one was the target: official cms122 over WebChart data puts all 56 subjects
out of the IPP (zero Conditions in the seed; cms122 is deliberately outside `ROSTER_ELIGIBLE_MEASURES`
because its "enrollment" is a diabetes *diagnosis* the roster must never fabricate). I concluded cms122
should leave the PR-9c flip list, wrote that into ADR-043, CLAUDE.md and this entry, and told the owner PR-9c
was now cms125-only.

**That was wrong, because it reasoned from the wrong stack.** `deploy-twh-mieweb.yml` — the demo/production
stack PR-9c actually flips — carries **zero** `WORKWELL_WEBCHART_*` references (verified). It evaluates the
**synthetic** roster, where `official-corpus-outcomes.test.ts` records official cms122 scoring
COMPLIANT/OVERDUE/EXCLUDED across all five targets and **agreeing with authored on every one**. So cms122
**stays in the flip list**. What the finding really establishes is narrower: routing official cms122 on the
**WebChart-configured staging** stack (11 `WORKWELL_WEBCHART_*`) produces nothing useful, and the WARN will
say so each run. My "nothing is lost — authored is equally blind" also held only over WebChart data; on the
synthetic roster authored is not blind, the two engines simply agree. A measured fact about one environment
got generalized into a plan change for another.

**What none of this catches,** stated because the gap is live: an IPP that IS satisfied while the numerator
reads the wrong shape. That is the mammography gap — official reports a screened woman OVERDUE, subjects
*are* in the population, and nothing fires. Dual-stamping the crosswalk is next, and since CMS125's numerator
is what is being flipped it is closer to a prerequisite than a follow-up.

**Codex found two more, and one of them was the check reading an incomplete roster.** The WARN concluded in
the batch pre-pass, off `prefetched` alone — but a subject the executor returns nothing for is *absent by
contract* and re-evaluated individually **later**, so the pre-pass judges a roster that is not finished yet.
Wrong in both directions: two out-of-IPP outcomes plus one omission warned even when the omitted subject
landed squarely in the population, and one out-of-IPP outcome plus two omissions stayed **silent** because
the sample failed its own `> 1` guard — the exact silence this ADR exists to end. Membership is a property of
the finished roster, so it now reads the final per-subject outcomes after the loop. Both directions are
pinned, and both fail against the pre-pass version (mutation-checked, not assumed). A bonus from moving it:
the check no longer depends on the batch path at all, so an official measure evaluated one subject at a time
is covered too.

**The second was my own overclaim, and it is the more embarrassing kind.** I wrote — in the code comment, in
the ADR, and in the PR — that carrying the warning into the run *message* meant "the run list and the POST
response show it." It does not. `RunRecord` has no message column, neither read model carries one, and every
`ALL_PROGRAMS`/`SITE` run — plus a `MEASURE` run on a WebChart-configured stack, *precisely* the
configuration this warning exists for — goes through `scheduleAsyncRun`, which answers with `RUNNING` and
discards the finishing response. So the message reaches the synchronous path only; elsewhere the warning
lives in `run_logs`, reachable via the run's log timeline but not on the list. I wrote a visibility claim
without checking the read models, in a PR whose whole subject is a failure that was invisible. Corrected
rather than quietly narrowed; persisting it needs a `runs` column and schema is owner-owned.

**Closing a gap this ADR opened in itself.** Moving enforcement to "the flip gate" makes the ADR only as
strong as that gate, and half of it did not exist: the test is real and CI-wired, but the "pre-flip checklist
step" was a phrase in the ADR and nowhere else — and `WORKWELL_OFFICIAL_MEASURES` had **no row at all** in
DEPLOY.md's environment reference, so the one variable this whole milestone turns on was undocumented for an
operator. Writing an unenforceable control into the decision that removes a runtime check is the same
vacuous-guard shape #350 and #352 were each pulled up on, one PR apart. Both are now written down:
`DEPLOY.md` §"Flipping a measure to official execution" — five steps per measure per stack, the
non-zero-IPP confirmation among them, the numerator caveat stated because membership parity is not
agreement, and a table separating the demo/production stack (no seam, synthetic roster, both measures score)
from staging (live WebChart, cms122 sees nobody).

## 2026-07-30 — PR-9b: what the official artifacts make of REAL WebChart data (branch `feat/official-webchart-baseline`)

PR-9a made cms122 and cms125 routable. This step was supposed to add a construction-time refusal — throw
when `WORKWELL_OFFICIAL_MEASURES` is set while the WebChart seam is configured — on the recorded basis
that the WebChart gap was "M-D-sized and wider than the two recorded CMS125 items." **Measuring first
killed that plan, and the measurement is the substance of the day.**

**The gap that mattered was one field.** Over the committed 56-patient dev-DB fixture, through the real
path (`normalizeWebChartBundle` → `stampEnrollment` → `evaluateBatch`), at EVAL 2024-06-01:

| | authored | official (before) | official (after) |
|---|---|---|---|
| cms125 | 52 MISSING_DATA, **4 OVERDUE** | 56 MISSING_DATA | 52 / **4 OVERDUE** |
| cms122 | 56 MISSING_DATA | 56 MISSING_DATA | unchanged |

Official CMS125's IPP is `AgeAt(end of MP) in [42..74] AND us-core-sex = SNOMED 248152002 AND exists
Qualifying Encounters`. Age passed — the four actionable subjects are 44–54 — and the encounter passed,
because the OH roster stamps a CPT 99213 office visit inside the period. The only failing conjunct was the
extension: **0 of 56 patients carried `us-core-sex`**, because both places that map WebChart's real
`patients.sex` column into FHIR emitted `Patient.gender` and stopped there. Fixing both and regenerating
the fixture from the dev DB produced a file **byte-identical but for 28 added extensions** (12 female / 16
male), roster untouched — so nothing else about the sample moved and the outcome change has one cause.

**Three candidates moved nothing for IPP membership**, but only one of them is genuinely inapplicable:
`Condition.onsetDateTime` (cms125's IPP reads no Condition at all — only its mastectomy exclusions do). The
LOINC mammography `Observation` and `Observation.category` moved no outcome **only because no in-IPP subject
in this fixture has a mammogram to find** — see the numerator section below, which is where review took
this apart. **Counting absent fields overestimates an IPP gap and underestimates a numerator one.** The
structural inventory that produced the "M-D-sized" note counted what was missing rather than testing what
the measures read; my first write-up then made the mirror-image error, reading "moved no outcome on this
fixture" as "retired".

**A self-inflicted measurement error worth recording.** The first probe stamped the extension as
`valueCode: "F"` and reported that four structural fixes together still left everyone out of population —
i.e. that the gap was *wider* than believed. The ELM compares against the SNOMED concept id, so a wrong
value is indistinguishable from an absent extension. Reading the artifact's actual ELM rather than
reasoning about US Core is what caught it, and it is why the committed test asserts an *outcome* rather
than the field's presence.

**cms122 has no divergence to gate, and the earlier framing was half a fact.** Official and authored are
both blind on all 56 — the seed carries zero Conditions and cms122 is deliberately outside
`ROSTER_ELIGIBLE_MEASURES`, because its "enrollment" is a diabetes *diagnosis* the roster must never
fabricate. So routing cms122 over this data changes nothing. The note that official cms122 "would read
out-of-population over live data too" was true but omitted that authored does the same — which is the half
that decides whether the flip changes anything.

**Why no refusal (ADR-042, decision 3).** "Both env vars are set" is a proxy for "this data cannot satisfy
the IPP": fix the mapping and the proxy stays true while the property goes false, so the check would refuse
a *correct* configuration until someone deleted it. A guard that must be removed to allow correct behaviour
is not fail-closed.

I also argued that the effect was harmless — four subjects moving `OVERDUE → MISSING_DATA`, both buckets
opening a case, "noisier, not rosier". **Review showed that is wrong on the axis operators actually triage
by,** and it checked `case-logic.ts` rather than taking my word: `dispositionFor` sends both to `OPEN`, so
the case *count* is identical and nothing got noisier — but `priorityFor` maps `OVERDUE → HIGH` and
`MISSING_DATA → MEDIUM`, and `nextActionFor` swaps *"Escalate mammogram follow-up immediately"* for
*"Collect the missing mammogram documentation"*. So the pre-fix behaviour downgraded four genuinely-overdue
screenings and pointed the operator at paperwork. That is rosier, and closer to ADR-038's hazard than I
allowed. The decision not to build the refusal stands on the predicate argument alone.

**What guards it instead.** `devdb-official-eval.test.ts` — official vs authored per subject over the
committed fixture, through the real ingress path, via `evaluateBatch` (the primitive a routed run uses).
The load-bearing assertion is a **divergence map**: empty means routing is inert for this data, populated
names every subject whose roster row would change and how. A second test **strips** the extension and
asserts official collapses to 56 MISSING_DATA while authored is unaffected — pinning the cause by removal,
which also preserves the pre-fix measurement as the historical record. Asserting the field is merely
*present* would prove the mapping emits it, not that it is what holds the agreement up.

**PR-8f's batch retrieve refusal does not fire on either measure**, confirmed by the batch returning all 56
subjects. It catches "retrieved nothing at all", and these retrieves matched plenty (236 LOINC
observations) — they just did not match the conjunct deciding membership. The ADR-038 lesson holds on real
data exactly as it did on the corpus.

**The review found two blocking problems, and one of them is the defect I caught on the previous PR.**

**(1) The gate never ran in CI.** Its `skip` predicate needs the gitignored terminology sidecar, and
`pnpm test` runs in a job that has none — so 4 of 6 tests skipped while the ADR and the conformance row
cited them as evidence. `ci.yml` warns about this failure *by name*, saying PR-8c already shipped two such
files and had to be told; ADR-038's own consequences say both its guards are "wired into the
`official-cases` CI job, not just written". I read neither before adding a sidecar-dependent file. This is
the same class as the vacuous guard I flagged on #350 one PR earlier, made by me. Reproduced by hiding the
sidecars (2 pass / 4 skip), fixed by adding the file to that job's step.

**(2) The numerator gap is open and fails toward a FALSE OVERDUE.** All four discriminating subjects are
OVERDUE because none has a mammogram, so the fixture cannot exercise either numerator — and the two engines
read different resource types: authored `[Procedure: "Mammography"]`, official
`isDiagnosticStudyPerformed([Observation: "Mammography"])`. The crosswalk emits CPT `77067` / HCPCS `G0202`
on a **`Procedure`**, and the official `Mammography` value set is **92 LOINC codes and nothing else**.
Measured on `wc-8` with one crosswalk-shaped mammogram inside the period: **authored COMPLIANT, official
OVERDUE** — a confident false non-compliance, which `case-logic.ts` turns into a HIGH-priority "escalate
mammogram follow-up immediately" for a woman already screened.

Verifying it corrected the review's own suggested remedy: a LOINC `Observation` alone **changes nothing**,
because `Status.isDiagnosticStudyPerformed` also requires `exists(category ~ imaging)` — which is why my
earlier probe found "`Observation.category` moved no outcome" and drew the wrong lesson from it. With the
category it flips the error the other way (official COMPLIANT, authored OVERDUE). **The remedy is
dual-stamping both representations**, as the synthetic corpus already does. All four states are now pinned
as tests, so the flip's real risk is a tracked expectation instead of an argument.

**Read the limits.** The oracle is our own authored engine, not an external expected answer, so agreement
is evidence the flip is safe *for this data* — not that either engine is right. Only **4 subjects carry
discriminating signal**, all in one bucket for one reason. The id-set comparison is what guards against a
collapsed distribution; the `assert.ok` non-degeneracy line is implied by it and is insurance, not the
guard — I had cited the wrong one in the ADR and the conformance row. One of the three IPP conjuncts is a
CPT 99213 `Encounter` the OH roster **synthesizes**, since WebChart supplies none, so this is not purely
EHR-sourced membership. Cypress CVU+ is still the verification bar and has not run. Nothing is routed.

**The residual limit nothing enforces.** Both changed mapping sites are upstream of the live FHIR
transport, so the fix does not reach a live third-party WebChart tenant — teatea still supplies no
`us-core-sex`, and `deploy-staging-mieweb.yml` sets `WORKWELL_WEBCHART_BASE_URL`, which is exactly where
official routing and a live seam can coexist. Review's sharpest point: for *that* path the seam-keyed
predicate I retired is still an accurate predicate, so decision 3 reasons about the configuration this PR
fixed and generalizes to one it did not. The limit is now stated in `WEBCHART_FHIR_MAPPING.md` §3.1 where a
tenant integrator will see it, and enforcing it is recorded as a **PR-9c precondition** rather than assumed
away.

**The two always-loaded doc updates were sequenced behind #351, and are now in.** `docs/ADR_INDEX.md` did
not exist on `main` until the context-diet PR merged, and both PRs rewrote CLAUDE.md, so editing either
earlier would have guaranteed a conflict for no benefit. With #351 merged (`1c0b47f`) this branch was
rebased — one expected `JOURNAL.md` conflict, both entries kept newest-first — and the follow-ups landed:
the ADR-042 line in `ADR_INDEX.md`, and a rewritten PR-9b block in CLAUDE.md's Current Focus that carries
the measured numbers, **both open gaps** (the numerator's false-OVERDUE and the live third-party path), and
the PR-9c precondition. The old text there described the refusal that measurement retired, so leaving it
would have pointed the next session at work that should not be done.

## 2026-07-29 (later) — context diet: the always-loaded doc set, and the second rule set that had drifted

**Not a code change — a context and doc-hygiene change.** Session memory was costing ~109,700 est.
tokens before anything was typed, and a second, silently-diverged copy of the hard rules was live.

**What was wrong.** `CLAUDE.md` was 83,308 chars, of which 64,732 were fourteen superseded
`## Prior focus` / `Historical` blocks — a lossy duplicate of this file. Worse, its "Other docs to
consult **on demand**" heading sat above nine `@`-imports, and `@` loads eagerly: ~356k chars
(~88,900 tokens) of ARCHITECTURE, DEPLOY, DATA_MODEL, MEASURES, README and friends were pulled into
every session whether or not they were relevant. The heading and the mechanism disagreed.

**Separately, `AGENTS.md` was a second rule set that had already drifted.** It mirrored CLAUDE.md's
twelve sections; all nine hard rules had been reworded and one had drifted **materially** — AGENTS.md
said a dependency named in a sprint file was "pre-approved", CLAUDE.md requires explicit approval for
any new dependency. Since Codex implements against AGENTS.md and Claude reviews against CLAUDE.md,
that is two agents working to different rules. CLAUDE.md's stricter rule is the live one; the
carve-out was moot anyway because `docs/sprints/` is archived, not an active queue. AGENTS.md also
carried its own eager `@`-import block including `docs/DECISIONS.md` (176k chars). It is now a 1,651-char
pointer to CLAUDE.md, and its unique content — one-task-at-a-time, `feat/<slug>`/`fix/<slug>` branch
naming, one-PR-per-task with the tightly-coupled exception, stop-and-ask before a new workstream — was
merged INTO CLAUDE.md first so nothing was lost.

**The new always-loaded set is five files, ~6.5k tokens, chosen on one rule:** inject a doc only when
its absence is *silent* — a rule whose criteria live in an unread file, or a locked decision a session
could contradict without knowing. `AI_GUARDRAILS.md` and `CQF_FHIR_CR_REFERENCE.md` are named inside
the hard rules and the stop-and-ask list. Three new extracts carry only the load-bearing part of a
big doc: `DATA_MODEL_CONTRACTS.md` (§4 idempotency + §5 `evidence_json` + §6 CSV — mandatory on every
PR by the Definition of Done; §3's 43k of table schemas stays on demand, being derivable from
`schema-pg.ts`), `ADR_INDEX.md` (40 ADR titles only — 1.1k tokens vs 44k for the bodies, enough for a
session to know a decision exists), and `LOCKED_DECISIONS.md` (ROADMAP §4–5, the owner-locked
decisions and verified audit facts). Each parent doc now points at its extract, so there is one
authoritative home per contract.

**Four episodic docs became skills** — description resident, body on invocation: `deploy`,
`webchart`, `conformance`, `mcp-surface`. Each front-loads the traps rather than the prose: the
secret-before-manifests trap, the Neon-quota outage that read green for four days, Variant A built vs
Variant B documented-not-built, the live-path gaps (0 Conditions / 0 Encounters / no `extension` / no
`Observation.category` across 56 dev-DB patients), and the never-reproduce-NCQA-specs guardrail.

**Doc freshness.** Supersession banners on `ROADMAP_2026-07-09.md`, `PLAN.md`, and the
`new instructions/` P0–P9 set (all three still cited elsewhere, so banner rather than move).
`docs/archive/PROJECT_PLAN.original.md` deleted — 61,015 chars, zero inbound references, 65 differing
lines against `PROJECT_PLAN_v1.md`. CLAUDE.md now names the ~120-file / ~2.5 MB write-once corpus
(`superpowers/plans`, `superpowers/specs`, `sprints`, `archive`, `FABLE_REVIEW`, `new instructions`,
`mieweb-ui-migration`) as do-not-read-unless-asked, so a session stops spelunking history.

**Result: ~109,700 → ~12,400 est. tokens** of always-resident memory; `CLAUDE.md` 83,308 → 21,470
chars, under the ~40k large-memory warning. **No code, tests, or CI touched.** One thing recorded
rather than smoothed over: **ADR-033 does not exist** — the sequence runs 031, 032, 034. Verified
absent from `DECISIONS.md`; noted in `ADR_INDEX.md` so 033 is not reused. Also honest about the
tradeoff: `ADR_INDEX.md` will go stale the moment ADR-042 lands (regeneration command is in its
header, `DECISIONS.md` remains authoritative), and `DATA_MODEL.md` is now two files to keep in sync.

**Codex review caught a defect the extraction itself introduced (P2).** `LOCKED_DECISIONS.md` §5 told
every session that CMS122 is "vendored at stale v0.5.000 (CMS125 not vendored)" and that official-first
"needs per-measure routing" — all superseded by PR-5/7a/7b/9a. Inside `ROADMAP_2026-07-24.md` that text
was plainly a **dated audit**; extracting it into an always-loaded file whose preamble says these are
"things a session must not silently contradict" **promoted stale observations to standing rules**, which is
the reverse of the intent. Fixed by splitting the file's authority: §4 (owner decisions) is binding, §5 is
labelled a dated snapshot where **the code wins on disagreement**, and each superseded bullet carries an
inline `SINCE` note. Two needed one — the official-path bullet (every deficiency now closed; cms122 and
cms125 are ROUTABLE, and still nothing is routed) and the engine-extractability bullet (PR-2 resequenced to
M-C, so `backend-ts/packages/` holds only `official-executor/`). Both verified against the tree, not
assumed. The general lesson worth keeping: **moving text into an always-loaded file changes its status**,
and dated findings need to say so louder once they are always in context.

## 2026-07-29 — PR-9a: completing the capped `AdvancedIllness` expansion (branch `feat/official-terminology-completion`)

The one build step PR-9 owed. `officialRoutingProblems` refuses cms122 and cms125 today because both
artifacts carry `AdvancedIllness` at **1000 of a declared 1997 codes**, retrieved by both ELMs, feeding
the 66+/advanced-illness DENEX in each. Nothing else stands between them and the flip.

**The first thing worth recording is what the research changed.** The cap had been carried as "VSAC caps
expansions at 1000" — in the routing refusal's own error message, in ADR-036, in the roadmap. That is not
where it comes from. `cqframework/dqm-content-qicore-2025`'s README says it outright: *"The value sets in
this repository are limited to expansions of 1000"*, because full expansions require an NLM licence. It
is **upstream policy, deliberate, and not a defect** — so there was never an upstream issue to file here,
and no version of this that gets fixed by waiting. Meanwhile VSAC's published `OperationDefinition` for
`$expand` does list `offset` and `count`, and `engine/cql/vsac-client.ts` has been paging them correctly
since #295. The capability was never missing. What was missing was a bridge between the two terminology
paths — and ADR-036 forbids the runtime having one, which is exactly right and is why this belongs at
vendor time.

**Shipped:** `vendor:official --complete-capped-expansions`. It re-expands only the OIDs upstream
actually capped (today one, two requests per measure — this is not an import), pinned to
`Library/ecqm-fhir-update-2025`: the release the upstream content repo itself names as its terminology
package, and the same eCQM release CVU+ validates the 2026 reporting period against, so M-A and M-B stay
on one terminology story rather than two. Completed codes are sorted `system|code` and deduped before
they are written, because the sidecar is pinned by hash and therefore its byte order *is* the artifact;
VSAC's page order is not a contract. Recorded in the manifest as a `completion` block naming the release,
because re-expanding at a different pin is a different artifact.

**Every failure path leaves upstream's codes exactly as shipped** — no flag, no key, VSAC unreachable
after the bounded retry — so `truncated` survives and routing keeps refusing. The one that is not
obvious, and the reason it is in the ADR: **a VSAC expansion that comes back SHORT of the declared total
is rejected rather than merged.** Merging it would swap upstream's 1000 codes for a different,
still-incomplete 800 — a narrowing dressed as a fix. Staying capped is loud; a wrong 800 is not.

**Review tightened both of those, and the first was a real hole rather than a wording quibble.** The
short check compared the RAW page total against `declaredTotal` while `canonicalize` deduped
afterwards, so a response padded with duplicate `system|code` pairs could clear the bar and then shrink
below it — replacing upstream's codes with a set that was short after all, which is precisely what the
guard exists to prevent. It compares distinct codes now. Second, a count cannot tell "the full version
of this set" from "a different set that happens to be bigger", so the completed expansion must now also
CONTAIN every code upstream shipped; that is the check that would catch a wrong release pin, and it is
also what settles the 2000-vs-1997 question below empirically — VSAC's 2000 do contain all 1000.

**Verified before the docs were written, which is the part that made it worth doing this way:**

- The no-flag path is **byte-identical** to the committed artifacts (`git diff --exit-code
  measures/official` green after re-vendoring both measures), so this lands as a genuine no-op.
- Against a stub VSAC serving 1997 codes in DESCENDING order across two pages: cms125 went 2043 → 3040
  codes, `truncated` → `[]`, the `completion` block appeared, and the written codes came out ascending —
  the sort is real, not incidental. Two consecutive runs produced the **same `terminology.sha256`**, so
  CI's reproducibility check stays an honest check rather than a coin flip.
- 11 new tests in `scripts/vsac-expansion.test.mjs` (the `test` glob now covers `scripts/**/*.test.mjs`).
  They are mostly failure directions: short-expansion rejected, no-key/no-flag/VSAC-down all leave the
  codes alone, a 4xx is not retried, a response with no `expansion` is refused rather than read as zero
  codes, and offset advances by the page's own length so a short page still terminates.

**Two tests had to stop asserting the blocker exists.** `official-terminology.test.ts` asserted
`cappedExpansions(cms122).length > 0` — true only while the cap is unfixed, i.e. a guard scheduled for
deletion by its own fix. The mechanism now runs against a synthetic manifest (never vacuous, never
state-dependent), and the real artifacts are checked for the invariant that holds in **both** states:
the manifest's caps, the sidecar's own `declaredTotal` shortfalls, and the routing decision all agree.
That last comparison is new, and it is the one that matters — a manifest claiming `truncated: []` over a
still-short sidecar would clear the refusal on a lie, and nothing looked for that before.

**Landing order is load-bearing and the sequencing is the risk, not the code.** CI runs the same vendor
command and then `git diff --exit-code measures/official`. Adding the `WORKWELL_VSAC_API_KEY_VENDOR`
secret **without** committing the re-vendored manifests means CI completes the expansion while Git still
records it as capped — red on every unrelated PR. The secret and the regenerated manifests land together;
the reproducibility step now says so in its own `::error::` message. The secret is deliberately distinct
from the runtime `WORKWELL_VSAC_API_KEY_TWH` even though both hold the same UMLS key: they serve the two
terminology authorities ADR-036 exists to keep apart.

**Owner step executed the same day (2026-07-29, later).** Secret set, both measures re-vendored with
the key, manifests committed. Results, in the order they were checked:

- `AdvancedIllness` completed **1000 → 2000 codes** in both artifacts; `truncated` → `[]`; a `completion`
  block records the pin. Bundle `sha256` unchanged in both, so only terminology moved.
- **Reproducible.** Two independent vendor runs, live VSAC both times: manifests *and* sidecars
  byte-identical. That is the property CI's `git diff --exit-code` depends on, and it was worth proving
  against the real service rather than the stub the branch was developed against.
- `pnpm test:official-cases` **121/121** (CMS122 55/55, CMS125 66/66, 0 unexpected, 0 errors).
- CI's four sidecar-dependent suites **24/24**, now actually executing instead of self-skipping.
- Full suite **1568 / 1554 pass / 0 fail / 14 skipped**. The `#256` worker-pool parity failure recorded
  below did **not** reproduce here (8/8 in isolation, 0 fail in the full run), which supports the
  environmental read: this host runs Node 24.
- `officialRoutingProblems(["cms122"])` and `(["cms125"])` both return **no problems**. The refusal that
  has blocked those two measures since PR-7b is cleared. Nothing is routed — `WORKWELL_OFFICIAL_MEASURES`
  remains unset on every stack.

**One thing did not match the plan, and it is worth keeping.** VSAC at `ecqm-fhir-update-2025` returns
**2000 codes for an OID the bundle declares as 1997**. The completion guard only rejects an expansion
that comes back SHORT, so 2000 passes and `truncated` empties correctly. But the gap says upstream
captured its `expansion.total` against a slightly different terminology snapshot than the release its own
README points at. Three extra codes widen a denominator exclusion by a hair. No official test case moved
and the corpus-outcomes check is unchanged, so there is nothing to fix — but "our terminology is not
identical to what the bundle declares" is exactly the kind of fact that is cheap to write down now and
expensive to rediscover during PR-9c's before/after distribution comparison.

**Superseded — the original owner step, kept for the sequencing note:** run the two
`--complete-capped-expansions`
commands in DEPLOY.md §"Step 1a" with the UMLS key, confirm `pnpm test:official-cases` stays 121/121
(its own analysis already reports "Value-set-cap effects: 0 observed", so a moved case would be the
finding rather than a failure), and commit the regenerated manifests + report alongside adding the
secret. Completing the expansion moves `manifest.terminology.sha256` and therefore `officialLogicVersion`
(ADR-040), invalidating cached `eval_state` rows for those measures — designed behaviour; the terminology
digest is in that identity for exactly this case.

**Verification:** typecheck clean; `pnpm test` **1553 pass / 1 fail / 14 skipped**. The one failure is
`PARITY (#256): --workers 2 produces the identical outcome set as --workers 1` — and it is **not this
branch**: it reproduces identically on a clean `main` tree with these changes stashed. Its shape is worth
recording because it looks alarming and is not — the workers *ran* (`evaluated ~6/6 subjects (2
workers)`) but every subject error-isolated to MISSING_DATA, i.e. in-worker evaluation threw rather than
the pool crashing. Most likely the `tsx` loader hook not reaching `node:worker_threads` on this
container's Node 22; CI runs Node 24, where the suite is green on `main`. Filed here rather than fixed
because it is environmental to the dev container and orthogonal to terminology vendoring — but if it ever
shows up on a CI runner it is a real correctness bug in the scale path, not a flake.

ADR-041 records the decisions. Still nothing routed: `WORKWELL_OFFICIAL_MEASURES` remains unset
everywhere, and PR-9b (the WebChart × official-routing refusal, and the live-path official gate that does
not exist yet) is next.

## 2026-07-28 (later) — PR-8 (remaining), part 2: measure-major batching + the retrieve check (branch `feat/official-measure-batching`)

The last item before PR-9. Two things shipped together because the second only becomes possible once the
first exists.

**The performance half turned out to be bigger than "an optimisation".** The adapter was single-subject
because that is the `EvaluateMeasureBinding` contract every caller uses, so each call handed fqm a batch
of exactly one — and fqm parses the artifact's ELM per CALL. Measured on the real vendored artifacts:

| | per-subject | batched | |
|---|---|---|---|
| cms122, N=25 | 4,249 ms (170 ms/subject) | 409 ms (16 ms/subject) | 10.4× |
| cms125, N=25 | 4,316 ms (173 ms/subject) | 342 ms (14 ms/subject) | 12.6× |
| cms122, N=100 | 17,145 ms (171 ms/subject) | 1,091 ms (11 ms/subject) | 15.7× |

The ratio grows with the roster because the parse is fixed cost. What makes this more than a speed-up is
the comparison it inverts: **171 ms/subject is ~2.5× SLOWER than the authored engine's ~68 ms**. Flipping
a measure without batching would have made a live-tenant run measurably worse, and the roadmap's risk
table had this filed as "benchmark before flip" rather than as a blocker. Batched, official execution is
*faster* than authored.

**The safety half is the one that would have been silent.** fqm does not error when every retrieve comes
back empty — it returns a complete-looking result with nobody in any population, which downstream is
indistinguishable from a genuinely ineligible roster. `hasRetrieveSignal` has existed in the package
since PR-4 and is already used by the MADiE harness, but it is only meaningful ACROSS subjects, so there
was nowhere to put it until batching existed. Now: a batch of more than one that matched nothing for
anybody refuses.

The `> 1` is load-bearing and is the owner's call. For a single subject "nothing retrieved" is a true and
ordinary answer — that is `/simulate` and rerun-to-verify on someone with no clinical data — so applying
it there would fail correct results. The known false positive is a roster of 2+ where genuinely nobody
has any clinical resource; failing loudly there is still the better error, because the measure's output
over that roster is meaningless either way.

Also worth stating so it is not over-claimed: this catches **"retrieved nothing at all", not "retrieved
the wrong thing"**. Every one of ADR-038's corpus defects — 12 of 24 codes in the wrong value set, the
missing `us-core-sex` extension, the mammogram recorded only as a Procedure — passed `hasRetrieveSignal`
cleanly while scoring the roster wrongly. This closes one door, and it is not the dangerous one.

### Two structural decisions

**A pre-pass, not a measure-major rewrite of the loop.** `finishManualRun`'s loop carries outcome
persistence, the incremental commit, the case upsert, its audit event and the counters, all
order-dependent and all correctness-critical. Restructuring it measure-major would put every measure's
bundles in memory at once (150 subjects × 14 measures) to benefit the measures that are actually routed,
of which there are currently none. The pre-pass holds one measure's bundles, drops them, and leaves the
authored path as literally the code that ships today — `evaluateBatch` resolves `undefined` and nothing
runs.

**One method, not `canBatch()` + a call.** The `undefined` resolution IS the predicate, decided by the
same `official` set the dispatch reads. And deliberately not inferred from `logicVersionFor(id) !==
undefined`: "has a declared logic identity" and "can be batched" coincide today, and a coincidence relied
on is a coincidence that breaks quietly. Same reasoning as ADR-040 §2, same reason it hangs off the
engine rather than being threaded through `RunPipelineDeps`.

`evaluate` is now a batch of one, which mattered more than expected — it means the four construction
refusals (artifact present, catalogId match, proportion scoring, recorded semantics) live on one path
instead of two that must agree. A test asserts each of them on the batch path specifically, because a
refusal that had lived only on the old single-subject path would now be gone entirely.

### Failure mode

Owner-decided: a failed batch fails **its own measure**, not the run. Every subject of it lands
MISSING_DATA carrying the batch's reason, the run ends PARTIAL_FAILURE — which is what fires the #264
alert channel — and other measures complete normally. That reuses the existing per-subject isolation
rather than inventing a failure channel, and avoids the alternative's real flaw: a FAILED run is ignored
by every read model, so one misconfigured measure would discard thirteen good ones *and* leave the prior
run silently authoritative.

### Review found a real defect, and my own test was complicit

**The batch results were keyed by fqm's `Patient.id`, and the pipeline looked them up by
`employee.externalId`.** Those are equal for every synthetic subject — `fhir-bundle-builder` stamps
`Patient.id = externalId` — and never equal for a live WebChart one, which the directory prefixes with
its tenant (`wc|123` for `Patient.id` `123`). So on a live official run the lookup would match nothing,
`prefetched` would stay empty, and every subject would fall through to `?? await engine.evaluate(...)`:
one batch pass **plus** N single passes, i.e. strictly slower than not batching at all — while the INFO
line claimed "N subjects evaluated in one official batch". The answers would still be right, so nothing
downstream could notice. It would have bitten precisely on the population official routing exists for.

The `subjectId` field was on the interface the whole time and simply never read; `evaluate` passing
`subjectId: ""` should have been the tell. `runBatch` now correlates fqm's key back to the caller's id,
and refuses outright when two subjects share a `Patient.id` rather than attributing one person's
compliance to another.

**My test would have passed against the broken code.** `batchProbe` returned
`new Map(subjects.map(s => [s.subjectId, ...]))` — it modelled the contract I *intended* rather than the
one implemented, and every adapter fixture used `subjectId === patientId`. The new test uses `wc|123`
against `Patient.id` `123`, which is the case that actually distinguishes them. Related: fixtures passing
`patientBundle: {}` are now realistic bundles carrying a Patient, because a bundle with no Patient is not
an input this code will ever see and pretending otherwise is what hid the coupling.

Three more, all mine:

- **A failed run-log write could turn a successful batch into a failed measure.** The success INFO line
  was awaited *inside* the try that catches evaluation failures, so a transient `run_logs` error became a
  `batchFailure` and every subject of that measure became MISSING_DATA — with valid results sitting
  unused in `prefetched`. An observability write must never author an outcome; the case-audit and
  quality-snapshot writes in this same file are best-effort for exactly this reason.
- **The subject list was built eagerly**, so the moment routing is on for one measure the pre-pass built
  bundles for all 14 and discarded 13/14 — reintroducing at the call site the cost the method exists to
  remove. It is a factory now, invoked only after the router confirms the measure is batchable.
- **`if (failed)` was a truthiness test on an `unknown` rejection.** A batch rejecting with `undefined`
  or `""` would be stored and then ignored, and each subject would fall through to a per-subject
  evaluation — which, being a batch of one, is exempt from the retrieve check. The refusal would have
  disabled itself. Normalized to an `Error` and tested with `.has()`.

Also hoisted the batch-failure check above the incremental reuse branch. Unreachable today (ADR-040 §6
means an official measure is never reused), but it is the difference between "wasteful" and "wrong" if
that policy is lifted: a reused subject would never see the refusal, and the misconfiguration would go
partially silent.

### Verification

- `pnpm test` — **1543 pass / 0 fail / 14 skipped** with the terminology sidecars present;
  **1532 / 0 / 25** with both moved aside. 1557 collected either way. `pnpm typecheck` clean.
- Five mutations, each caught by exactly the test that claims it and nothing else: disabling the
  pre-pass (3 tests), dropping the `> 1` guard (the single-subject test), removing the retrieve check
  (the refusal test), making the router batch unrouted measures (the routing test), and swallowing a
  batch failure (the isolation test).
- Perf measured by hand with a throwaway script over the real artifacts, not asserted in the suite —
  timing assertions are flaky and would have to be loose enough to prove nothing.
- Nothing routes officially. `WORKWELL_OFFICIAL_MEASURES` is unset everywhere and no measure is
  *routable* regardless: the capped `AdvancedIllness` expansion is still a construction-time refusal.

**PR-8 is now complete.** Remaining before PR-9's flip: the VSAC-capped `AdvancedIllness` expansion
(1000 of 1997 codes, an owner-run vendor step), and CMS125 over live WebChart data, which gets neither
ADR-038 fix and would still read out-of-population.

## 2026-07-28 — PR-8 (remaining), part 1: the `logic_version` landmine (branch `feat/official-logic-version`)

Took the `logic_version` override ahead of measure-major batching, because they are not the same kind of
item. Batching is performance with one safety net attached. This one is a wrong answer waiting for two
flags to line up:

`incremental-eval.ts` decides "has this measure's logic changed?" by hashing `ELM_LIBRARIES[libraryName]`
— the AUTHORED ELM. Route a measure to the official artifact and that ELM is still sitting there hashing
identically, so the fingerprint says *same logic* about two engines that answer differently, and the
`eval_state` cache copies **authored outcomes forward for a measure now running official CQL**.
Re-vendoring the artifact wouldn't invalidate them either — nothing in the fingerprint knows it exists.

What makes it worth taking first is the failure *mode*, not the probability. Every other input to that
fingerprint degrades pessimistically: lose a value-set hash and `logic_version` changes when it needn't,
costing a re-evaluation. This one degrades toward a wrong answer with no symptom, because a copied-forward
outcome is indistinguishable from a computed one at every layer that could look — the run completes, the
counts reconcile, the roster renders.

Both flags are off today. That is a coincidence with a deadline, not a safety property.

### The design decision worth naming

The roadmap sketched it as another field threaded into `IncrementalDeps` from each caller. That is the
exact shape of the bug PR-7b's review caught: a call site that forgot to pass the official flag, so the
nightly run used a different engine than the manual one — in a block of code that had already documented
that same mistake twice.

So the identity hangs off the **engine** instead: `RoutedEngine.logicVersionFor(measureId)`, resolved once
from the same artifacts the executor was built over, read by the pipeline off `deps.engine`. The logic
identity and the thing that computes the outcome are now the same object, so they cannot disagree, and a
future call site gets it without having to remember it. Verified the premise rather than assuming it —
all three `RunPipelineDeps` construction sites (`routes/runs.ts` ×2, the scheduler) already build via
`routedEngineForEnv`, and no production caller feeds an `engineForEnv` result into the pipeline.

Two deviations from the sketch, both deliberate (ADR-040):

- **Readable composite, not `sha256(...)`.** `official-fqm:<version>:<artifactSha>:<terminologySha>`.
  Every input is already a digest, so re-hashing buys no collision resistance — it only makes an
  `eval_state` row unreadable at the moment someone is asking which artifact produced it. The prefix is
  disjoint from the authored `sha256:<hex>` space by construction, so the two can never collide however
  the authored hash is later computed.
- **The terminology digest is in.** The sketch had version + artifact sha. Since ADR-036 the executor
  retrieves against the artifact's OWN expansions, fetched at build and pinned in the committed manifest —
  so a re-fetch at a different upstream ref moves value-set membership, and outcomes, with the bundle
  bytes unchanged. Version + sha alone would call that "same logic".

### Testing the claim rather than the code

The three cases that matter — flip on, flip off, re-vendor while still routed — run against the REAL CQL
engine and a real SQLite `eval_state`, in a setup with every *other* reason to re-evaluate removed: same
day, same subject, byte-identical bundle, terminal OVERDUE status so the clock can't force it. A baseline
test asserts that exact setup **does** reuse. So anything that re-evaluates in the three did so because of
`logic_version` and nothing else — which is the whole claim, since the authored ELM hashes the same before
and after a flip. Two more: an unrouted sibling measure keeps reusing while its neighbour is routed, and
an unchanged artifact still reuses (the identity is not a nonce).

### Review found the one place the bug could still live, and a second one next door

**The wiring line had no test at all.** The review proved it by deleting
`engineLogicVersion: (measureId) => deps.engine.logicVersionFor?.(measureId)` and running the whole
affected surface: 276 tests, all green. Both halves were covered — the router produces an identity, the
cache honours one — and nothing asserted the pipeline joins them. That is worse than an ordinary coverage
gap here, because the design's own argument is that collapsing N call sites into one removes the class of
bug where a caller forgets; the collapse is right, but the surviving line is then the only place it can
hide. Now covered at the pipeline with a real SQLite `eval_state`, asserting the persisted row's
`logic_version`, and confirmed load-bearing by re-running the mutation: it fails that test and nothing
else.

**`next_transition_at` was still authored-only.** `commit()` called `computeNextTransition`, which keys on
`MEASURE_BINDINGS` and reads a `"Days Since"` define out of authored evidence. Two branches would
over-reuse an official outcome — a `PERMANENT` binding returns `null` (terminal ⇒ *unbounded* across-day
reuse) before the boundary table is even consulted, and a `BOUNDARY_SAFE` measure would apply thresholds
derived from the authored CQL to an official status. Neither is sound: the official measurement period is
a rolling window (ADR-039), so the same bundle can score differently as the date moves and nothing is
terminal. Unreachable today — both cms measures are `RECURRING` and neither is boundary-safe, so they
already fall through to the same-day default — but that is a coincidence of classification, not a
property. Official outcomes are now same-day-only by construction, which changes no current behaviour and
also keeps `recomputeEvidenceAsOf` a no-op on official evidence (the delta can only ever be zero).

Also fixed: a silent `if (artifact)` skip in the identity loop, which — in the one function that produces
the identity, in a PR whose thesis is "this is the input whose absence is silent" — would have let
`evaluate` route officially while `logicVersionFor` said "authored". Unreachable (validation already
refused a missing artifact, and the load memoizes), and it throws now anyway.

### Codex found the boundary of what the identity can promise

One P2, and it is right: the identity covers the **artifact**, not the **code that runs it**. A same-day
redeploy changing `preparedForQiCore`, `officialMeasurementPeriod`, `officialMeasureSemantics` or
`outcomeFromPopulations` leaves official rows reusable although the adapter that produced them is gone.

That property is not new — the authored side hashes ELM, never `cql-execution-engine.ts` — and it has
always been fine there, because that engine is old and stable. The official adapter is the opposite: every
one of those four functions moves the answer, all of them shipped or changed within the last week, and
ADR-037 *measured* preparation alone swinging a roster from IPP=0 to IPP=25. So the same latency that made
the original hazard worth taking early applies here too.

I could not close it inside the identity. There is no build sha or package version to fold in — the worker
reports a literal `build: "workwell-api-ts"` and `package.json` is `0.0.0` — and a hand-bumped "adapter
contract" constant is precisely the remember-to-do-it failure this PR argued against two paragraphs
earlier. So the cache **declines an official-routed measure entirely** rather than guessing at which
adapter changes matter.

The cost is small and worth writing down so the decision can be revisited honestly: official rows are
already same-day-only, so the whole benefit forgone is *a second run on the same day skipping CQL* —
across-day reuse, the actual payoff, was never available to them. Rows are still committed (provenance,
and so re-enabling rebuilds no cache) but are write-only today. Exit condition named, not vague: a digest
covering the adapter's output surface, or that surface settling once PR-10..12 finish the remaining six.

It also cost a test honesty check. "Flipping ON re-evaluates" now passes for the *policy* reason whether or
not the identity works, so on its own it had gone vacuous; it now asserts the committed row carries the
artifact's identity, which is what the flip-OFF test compares against and what a re-enabled path reads.
The old "re-vendor still reuses when unchanged" assertion is deleted rather than adjusted — it asserted
behaviour the policy deliberately removes — and replaced by one that observes the re-vendor through the
recorded identity.

Three doc corrections, all mine: I wrote "four paths reach `finishManualRun`" when there are **three**
`RunPipelineDeps` construction sites (the fourth `routedEngineForEnv` call is `POST /api/runs/:id/evaluate`,
which never reaches the pipeline); DEPLOY.md advertised the incremental+official combination as safe
without noting that **no measure can be routed today** (the capped `AdvancedIllness` expansion refuses at
construction); and the identity's real shape has five colon-separated fields, not three, because both
manifest digests already carry their own `sha256:` prefix. Two claims narrowed rather than defended: the
identity tracks what the *manifest records* about the bundle (bundle bytes are not verified at load, only
diffed in CI), and "cannot disagree" is true of the runtime object, not of the type — `Pick<…,
"logicVersionFor">` is optional, so the compiler enforces nothing.

A second review pass then found the one place the code stopped following the PR's own argument: `commit`
re-derived "is this official?" by calling `engineLogicVersion` a *second* time, instead of reading the
fingerprint `plan` had already handed it. Not a defect — the router builds its map once at construction, so
the two evaluations cannot disagree — but ADR-040 §2 exists precisely to stop a fact and its consumer being
two things that must agree. The officialness now rides on `EvaluatePlan` (`engineDeclaredLogic`) and travels
with the fingerprint it governs. Making the field required, rather than defaulted, immediately paid for
itself: the compiler flagged the one test that hand-built a fingerprint literal, which is the shape of
caller that would silently get the wrong temporal bound.

The same pass asked for a cross-day reuse test on the same-day bound. I did not add that one — under the
never-reuse policy it would pass whether or not the bound exists, because `plan` declines official rows
before reaching the temporal gate. What is testable today is the *stored* bound, so the new test asserts it
against the authored row it would otherwise have been: same measure, same bundle, same date, same OVERDUE
status, and the only difference is who declared the logic — official bounded to its eval date, authored
`null`. Reverting the bound now fails three tests instead of one.

### Verification

- `pnpm test` — **1528 pass / 0 fail / 14 skipped**. With both terminology sidecars moved aside,
  **1517 / 0 / 25** — the two-configuration discipline from the PR-8a CI failure; 1542 tests collected
  either way, the delta being skips. None of the new tests depends on the gitignored sidecar (the
  terminology digest the identity reads lives in the **committed** manifest).
- Every new test mutation-checked, not just run: deleting the pipeline's wiring line, reverting the
  same-day bound, dropping `terminologySha` from the identity, making `logicVersionFor` return
  `undefined`, and disabling the never-reuse branch each fail exactly the test that claims to cover it,
  and nothing else.
- `pnpm test:official-cases` — **55/55 + 66/66**, evidence report byte-unchanged apart from its
  `Generated:` line, which was reverted so the diff shows only what this PR changed.
- `pnpm typecheck` clean. No schema change (`eval_state.logic_version` is already TEXT), no new deps,
  nothing routes officially.

**Still open for PR-8:** measure-major batching + the batch-level `hasRetrieveSignal`. **Still owed by
PR-9:** the VSAC-capped `AdvancedIllness` expansion (a routing refusal today), and CMS125 over live
WebChart data, which gets neither PR-8c fix.

## 2026-07-27 (night) — PR-8d: the shadow diff was not shadowing anything (branch `feat/official-diff-generalization`)

The remaining PR-8 list opened with "generalize the standards diff beyond its cms122 hardcode". That
turned out to be the smaller half. Diffing `standards/literal-diff.ts` against the thing it exists to
forecast — `wiring/official-executor-adapter.ts` — found three ways it was not forecasting it:

| | the diff did | the runtime does |
|---|---|---|
| measurement period | the CALENDAR YEAR | the registry's rolling window |
| the bundle | harness-ENRICHED (age-out / hospice / GMI injected) | the plain synthetic bundle |
| preparation | in place, WorkWell then evaluated on the mutated bundle | on a COPY, WorkWell sees the original |

For an as-of of 2026-07-27 those two periods share barely half their days, so anything they disagreed
about would have been reported as a *logic* divergence. The enrichment manufactured divergence on
purpose, which was right when the corpus could not reach the official populations at all and became
misleading the moment PR-8c fixed that: a shadow period that invents divergence forecasts divergence
that will not happen.

### The latent inversion

`officialOutcome` hardcoded `numerator ? OVERDUE : COMPLIANT`. That is cms122's reading — its numerator
is *poor glycemic control*. cms125's numerator is a completed mammogram, so the same line would have
reported every screened woman OVERDUE and every unscreened one COMPLIANT. It never fired because the
route gated the literal tier on `diffId === "cms122"` — which is also why "shadow period cms122/125" was
not actually possible: cms125 answered with the estimate and nothing said so. Now read from
`officialMeasureSemantics`, the same fail-closed table the runtime consults, and a measure with no
recorded semantics is *unavailable* for the tier rather than mapped under someone else's reading.

### Review caught two more, and one of them was the same bug again

**The memo was keyed on `runId` alone.** Safe while the tier was cms122-only; a correctness bug the
moment it wasn't. An `ALL_PROGRAMS` run writes every measure's outcomes under ONE run id, so requesting
cms122's diff and then cms125's returned the *identical object* — cms122's subjects and provenance under
cms125's URL. Exactly what I had just closed at the route, re-opened one layer down. Worse, my own new
cms125 test cleared the cache between calls, so it was working around the bug instead of exposing it.
Now keyed `measureId|runId` in both tiers, with a regression test that does not clear.

**`officialOutcome` was a second copy of the runtime's mapping, and the copies disagreed.** Out of the
initial population the diff said `OUT_OF_POPULATION`; the runtime and both authored measures say
`MISSING_DATA`. So a subject the two engines completely agree about was counted as a divergence,
attributed to the `initial-population` gate, in a headline claiming it diverges from official criteria —
a manufactured divergence arriving through a different door than the one I had just shut. Latent on
today's corpus (measured: zero out-of-population subjects across all 100 employees for both measures),
not latent for the six measures still to onboard or for live WebChart data. Now calls
`outcomeFromPopulations`.

Also: `chooseDiffMode` gated every measure's literal tier on **cms122's** VSAC store rows, which since
ADR-036 the literal path does not use at all — so a working literal diff silently reported
`mode: "estimate"` on any stack that never ran `pnpm resolve-valuesets`. And the subset tier turned out
to have only ONE reachable entry point for another measure, not two as I first wrote; the guard stays,
the claim is corrected.

### What this bought

The ADR-008 guard got stronger rather than weaker. With the diff feeding the authored engine the plain
bundle, it can now assert the property that matters — WorkWell's side of the diff equals a direct
evaluation of the same subject — where before the best available was self-consistency across two passes,
which is true of any deterministic function including a wrong one.

`pnpm test` **1517 pass / 0 fail / 14 skipped**, and **1506 / 0 / 25** with the terminology sidecars
moved aside — which caught a route test that had been asserting the estimate tier unconditionally and so
passed in CI while failing locally. `pnpm test:official-cases` 55/55 + 66/66, vendored artifact and
evidence report byte-unchanged. ADR-039.

**Still open for PR-8:** measure-major batching + a batch-level `hasRetrieveSignal`, and the
`logic_version` override.

## 2026-07-27 (evening) — PR-8c: the corpus the official measures can actually answer (branch `feat/official-corpus-fidelity`)

PR-8b ended with a finding and an attribution. The finding was right: with preparation alone, official
CMS122 scored the synthetic roster IPP=25 / DENOM=25 / **NUMER=0**, and since that measure's numerator is
*poor glycemic control*, the roster read as 100% compliant — a wrong answer shaped like good news. The
attribution was wrong: I wrote that "our bundles carry `urn:workwell:*` codes where the official numerator
retrieves real LOINC." They do not. The corpus has dual-stamped real codes since the 2026-07
production-faithful promotion, and I could have checked that in one grep before writing it down.

Took the corpus before the remaining PR-8 mechanics, because a shadow period run against data that cannot
exercise the numerator compares nothing and would have to be run twice.

### What was actually wrong — four things, all measured

1. **12 of 24 codes were members of a value set other than the one they were registered under.** SNOMED
   103735009 is in "Palliative Care Intervention" but not "Palliative Care Diagnosis". 385763009 is in
   "Hospice Care Ambulatory" but not "Hospice Encounter". CPT 77067 is not a member of the Mammography value set the official CMS125 numerator retrieves — all 92 of its members are LOINC.
2. **CMS125's initial population reads the `us-core-sex` extension**, not `Patient.gender`.
3. **CMS125's numerator retrieves `[Observation: "Mammography"]`.** The corpus emitted a Procedure, and all
   92 members of that value set are LOINC.
4. **Conditions carried no `onsetDateTime`.** `QICoreCommon.prevalenceInterval` is not merely conservative
   without one — it is inconsistent. CMS122's `prevalenceInterval Overlaps MP` returns true, because an
   unbounded interval overlaps everything; CMS125's `Start(prevalenceInterval) SameOrBefore End(MP)`
   returns null, because there is no start to compare.

Defect 1 is the one worth dwelling on, because **no measure test could have caught it**.
`bundled-ecqm-expansions.ts` supplies both the code stamped on the synthetic resource and the offline
expansion the authored CQL resolves. A wrong code is wrong in both places at once: the authored retrieve
still matches, every outcome is exactly as seeded, the suite is green. Internally consistent, externally
wrong — only an outside authority can see it, and the artifact's own terminology (ADR-036) is that
authority. That is now a test rather than a habit.

Effect, per measure, across the five synthetic targets, official artifact vs the outcome the corpus was
authored to produce:

| | before | after |
|---|---|---|
| cms122 | 4 of 5 (EXCLUDED scored **COMPLIANT** — the DENEX never fired) | **5 of 5** |
| cms125 | 0 of 5 (**every subject out-of-population**) | **5 of 5** |

### Decisions worth naming (ADR-038)

- **Dual representation, never replacement.** The mammogram is emitted as a CPT `Procedure` *and* a LOINC
  `Observation`; the patient carries `gender` *and* `us-core-sex`. Both halves are real — an EHR that
  performed a screening mammogram has an order record and a result. Replacing either would have moved
  authored outcomes, which is exactly what a change whose purpose is *comparability* must not do.
- **The corpus may author an onset; the preparation layer may not.** This qualifies ADR-037 rather than
  contradicting it, and the distinction is whose fact it is. `qicore-preparation.ts` receives data it did
  not create and must not invent a clinical date for it — that was a review finding on PR-8b and it was
  correct. The corpus invents the entire patient by construction; a fictional employee with diabetes was
  diagnosed on some fictional day, and declining to say when is not neutrality, it is an ill-formed record
  that happens to read as absent. It also retires a workaround: `cms122.cql` still carries the comment
  "presence-based (synthetic Conditions often lack onset periods)".
- **One constant per value set**, enforced. Three codes were each serving two sets while being a member of
  one, so whichever set you checked from, it looked right.

### Verification

- `pnpm test` — **1512 pass / 0 fail / 14 skipped**; with both terminology sidecars moved aside,
  **1501 / 0 / 25**. Running both configurations is the discipline adopted after the PR-8a CI failure,
  where three tests passed locally on a working tree CI did not have.
- `pnpm test:official-cases` — **55/55 + 66/66**, with the vendored artifact and the evidence report
  byte-unchanged.
- Two new guards: `wiring/corpus-membership.test.ts` (every canonical code is a member of the set it is
  registered under, no two codes share a set, the offline expansion is derived from that table) and
  `wiring/official-corpus-outcomes.test.ts` (the official artifact scores each target as authored, the
  authored path agrees, and the corpus is not degenerate). The last assertion is the important one: a
  corpus scored entirely COMPLIANT looks like success at every layer that can see it.

### Review found two blockers, and reversed one of my decisions

- **Both new guards were permanently skipped in CI.** They self-skip without the terminology sidecar,
  the sidecars are gitignored, and the job that runs `pnpm test` never fetches them — so the PR whose
  thesis is "enforced, not intended" enforced nothing. The `official-cases` job already carried a
  comment warning about exactly this for the sibling file, and I added two more without reading it.
  Both are now in that step.
- **The scale generator undid the fix on its own path.** `recodeEventToReal` replaced the coding of
  every `Procedure`/`Immunization`/`Observation` by resource TYPE, so it overwrote the new LOINC
  mammogram `Observation` with the CPT code and put the scale population straight back out of CMS125's
  numerator. `webChartRealisticGenerator` is the default for `seed:scale --mode evaluate` and produced
  the live `mhn` tenant's 70,000 outcomes — so this was the same "wrong answer nothing detects" one
  layer over. Now skips resources carrying no `urn:workwell:*` coding (there is nothing synthetic to
  translate), and the outcomes guard runs against **both** generators.
- **The onset I added to `stampEnrollment` was fabrication, and I had just written the rule it broke.**
  That function runs over real WebChart bundles from a roster that carries no dates; WorkWell does not
  know when an employee joined a program. It also changed a live subject's `data_hash` daily, defeating
  the across-day incremental reuse (ADR-035) whose stated payoff is the WebChart tenant. Removed — and
  nothing needed it, since official artifacts never retrieve a `urn:workwell:*` Condition. The drift
  guard now excepts that one field and asserts the difference in both directions.

Also fixed: a docstring in `qicore-preparation.ts` still asserting the cause ADR-038 says is wrong, two
references to a test file that does not exist, a non-degeneracy assertion sitting after the comparison
that implied it (dead code), a `!` that would throw instead of reporting with one sidecar present, and
"CPT 77067 is in no VSAC mammography set at all" narrowed to what is actually proven.

Authored outcomes are byte-identical throughout, and nothing routes officially —
`WORKWELL_OFFICIAL_MEASURES` stays unset. One drift guard failed and was right to: `stampEnrollment`
builds the WebChart enrollment Condition and is pinned byte-identical to the synthetic builder's, so
adding an onset on one side only broke it. Both now carry it, which matters beyond the test — that is
the Condition a live WebChart subject would be evaluated against.

**Still open for PR-8:** generalize the standards diff past its cms122 hardcode, measure-major batching
with a batch-level `hasRetrieveSignal`, and the `logic_version` override. **Still owed by PR-9:** the
VSAC-capped `AdvancedIllness` expansion (1000 of 1997), which is a routing refusal today.

## 2026-07-27 (later) — PR-8b: bundle preparation, and what it revealed (branch `feat/official-bundle-preparation`)

Started PR-8 by checking a claim rather than inheriting it. The router's docstring has said since PR-7b
that without `stampQiCoreStructure` "the whole population reads out-of-population" — true, and nobody had
ever run it. Measured against the vendored CMS122 artifact over 25 synthetic subjects:

| bundle | IPP | DENOM | NUMER |
|---|---|---|---|
| raw synthetic | **0** | 0 | 0 |
| + preparation | 25 | 25 | **0** |
| + preparation + harness enrichment | 22 | 22 | 4 |

The first row is the documented failure and it is real. **The second row is the one worth stopping for.**
With preparation alone, everyone is in the denominator and nobody in the numerator — and cms122's
numerator is *poor glycemic control*, so that renders as **100% compliant**. A wrong answer that looks
like good news, and nothing automatic catches it: `hasRetrieveSignal` passes, because retrieves did
match. It is strictly more dangerous than IPP=0, which at least announces itself.

The cause is that our corpus carries `urn:workwell:*` codes where the official numerator retrieves real
LOINC. The diff harness closes that with a local enrichment — and that enrichment must **never** move
into the runtime, because synthesising clinical codes at evaluation time is fabricating findings that
never happened. The real fix is a corpus that emits real codes, which the roadmap already schedules per
measure. So this is now written down as the gate on PR-9 rather than a surprise during it.

**What shipped:** one `wiring/qicore-preparation.ts` used by the diff AND the runtime executor — two
implementations could not be compared, and comparing them is the whole point of the shadow period. The
runtime prepares a COPY, so the authored outcome stays byte-identical whether or not routing is on
(ADR-008). The rule is normalization, never fabrication: structural metadata the QI-Core profiles require,
no code, no value, no date of a real event; fields already present are left alone, which is what makes it
safe over WebChart data too.

The literal diff was also the **last call site still expanding from our VSAC import** — PR-8a moved the
runtime and the gate, and missed this one. Now on the artifact's own terminology with **no fallback**: a
diff that expands different terminology than the runtime forecasts a configuration that will never exist,
which defeats the reason for running it before a flip. When the sidecar is absent the tier is reported
unavailable and the route degrades to subset **visibly, in `mode`**, instead of silently swapping sources.

**And a regression I nearly shipped.** That change would have downgraded the LIVE stack's
`mode:"literal"` to `"subset"`, because the deploy image had no sidecar — a shipped capability quietly
lost. The deploy workflow now vendors terminology into the build context (plain `node`, no package
manager on the deploy path; deliberately not fail-soft). Caught it by asking what the change does to
production rather than only whether the tests pass.

Verified in **both** configurations, which is the discipline I committed to after the last CI failure:
with the sidecar 1502 pass / 0 fail / 14 skipped, with both sidecars physically moved aside 1497 / 0 / 19.
Official gate 55/55 + 66/66, evidence report and vendored artifact byte-unchanged. ADR-037.


## 2026-07-27 — PR-8a: one terminology authority (branch `feat/official-terminology-authority`)

Sizing PR-8 turned up something worth stopping for: **the MADiE gate was not evidence about the runtime.**

Two of my own PRs did it, each defensible alone. PR-6a stripped `ValueSet` resources out of the vendored
`bundle.json` — a **licensing** decision, not a size one: 26 expansions carry thousands of AMA CPT and
SNOMED CT codes and this repo is public. PR-7a then filled the hole by expanding from our imported VSAC
`value_sets` rows at runtime. Meanwhile `official-cases.ts` kept validating against the **upstream
bundle's own** expansions. So the gate ran one terminology and production would run another, and
121/121 green proved nothing about the path that matters — the single thing that gate exists to do.

The approved plan had already ruled it out, in as many words (§7.3): *"Runtime never mixes two
terminology authorities."* I drifted from it and did not notice until I went looking for something else.

**The wrong fix, measured and rejected.** Restoring the ValueSets to `bundle.json` costs +605 KB
(cms122) and +464 KB (cms125) — affordable, and it would commit redistribution of licensed terminology
from a public repo. The vendor script's own header said so; I was most of the way to recommending it
before reading it. Fifth time this project a confident claim has been overturned by reading or running
the thing rather than reasoning about it.

**What shipped instead** — the shape §7.3 and the §8 risk table both prescribe ("public package =
fetch-at-build"):

- `vendor:official` writes the artifact's OWN expansions, at the same pinned commit as the ELM, to
  `measures/official/<id>/terminology.json` — **gitignored**, the same fetch-not-vendor pattern
  `.official-content/` already uses.
- The **committed** manifest records that file's SHA-256. Bytes that are not stored are still pinned: a
  regenerated sidecar hashes identically or is refused at load. That is what makes "fetched" as
  trustworthy as "vendored" without redistributing anything.
- The router expands from it, **keyed by measure, not by a flat OID map**. CMS122 and CMS125 share 23 of
  their canonicals, so a flat map works — until two artifacts are pinned at different commits and
  disagree about one, at which point whichever loaded first silently wins for both.
- The reduction check now executes the **runtime configuration**: our reduced artifact plus its own
  sidecar, built through the same `expandArtifactTerminology` the router calls, against upstream's
  artifact and upstream's ValueSets. **0/55 and 0/66 cases changed population vector.** Calling the
  production code path rather than re-deriving an equivalent cache is the point — an equivalent one can
  drift, which is how this happened in the first place.
- The report records which terminology mode ran, so a weaker check can never be read as the stronger.
- A missing sidecar is reported as ONE build step, not as 26 expansion failures. It would otherwise
  render as "26 of 26 value sets could not be expanded" — accurate, and it sends an operator hunting for
  26 terminology problems instead of running one command. The refusal's remedy text was also wrong:
  it named `pnpm resolve-valuesets`, which is now explicitly *not* what official execution uses.

The fqm boundary guard caught the new module importing the executor package directly and made me route
the one type it needs through the adapter instead — the third time that test has corrected me, and the
third time it was right.

**Side effect worth having:** PR-9 no longer waits on an owner-only UMLS import. The blocker was an
artifact of the split, not a real dependency.

**The review caught the guard that mattered most being missing.** I had written `cappedExpansions` with
the docstring "reported at boot so a shortfall is never silent" — and zero production callers. VSAC caps
expansions at 1000 codes; `AdvancedIllness` (`…1003.110.12.1082`) is capped at 1000 of 1997 in **both**
bundles, and it feeds the 66+/advanced-illness DENEX in each. The empty-set preflight cannot catch that,
because half-expanded is not empty — so a flip would have left excluded subjects in the denominator and
scored them, with no signal anywhere. It is now a routing refusal, filtered to the sets the ELM actually
retrieves. **cms122 and cms125 are consequently not routable today**, which is the correct answer: it
changes none of the 121 official cases, and "changes no test case" is not "changes no patient".

Six other findings from the same review, all fixed: the strongest assertions in the PR self-skipped in
CI (the sidecar-covers-every-canonical test now runs in the `official-cases` job, which fetches);
`runtimeTerminologyCache` collapsed three unlike causes into "sidecar not present", which could assert a
file was missing while it sat on disk; the CLI unit tests had quietly become non-hermetic, reading the
real 2.4 MB artifacts; `localeCompare` was deciding the byte order that the pin hashes (ICU collation
weights `.` by locale — now code-point); and the sidecar's lookup keys are re-derived with the package's
own `oidFromValueSetUrl` rather than the vendor script's copy of that rule.

**Two more from CI and Codex, after the first push.** The CI failure was mine and was the same class of
bug I had just fixed elsewhere: three router tests stubbed the capped-expansion check but not the
terminology load, so they passed on a machine with the sidecar and failed on one without. The two
working-tree-dependent stubs are now ONE object that gets spread — half-applying it is no longer
possible — and I verified the whole suite with the sidecars physically moved aside (1493/0/17), which is
what I should have done before pushing rather than trusting a machine that happens to have the file.

Codex was right that the cache step I added was vacuous: `vendor:official` fetches unconditionally, so
the cache would be restored and immediately overwritten while still paying both downloads. Fixed better
than by caching the output — the script now reads the bundle out of the `.official-content` sparse
checkout when it sits at the same pin, which CI already caches. Two ~17 MB pulls become zero,
reproducibility is untouched (a checkout OF an immutable pin is those bytes), and a ref mismatch falls
back to the network rather than guessing. Verified: byte-identical artifact from the cached path, and a
bogus `--ref` correctly declines the local copy.

**PR-9 obligations:** complete that capped expansion from VSAC at vendor time, and run the fetch in the
deploy workflow before `docker build` (the image needs the sidecar). Nothing routes officially today, so
nothing is broken meanwhile — and both omissions now fail closed at boot rather than silently, which is
the right failure.

ADR-036. `pnpm test`: **1496 pass / 0 fail / 14 skipped**; typecheck clean; `pnpm test:official-cases`
55/55 + 66/66 with the reduction check on the runtime configuration.


## 2026-07-25 (night) — PR-7b: the executor router, wired and dark (branch `feat/executor-router`)

`routedEngineForEnv(env)` replaces `engineForEnv(env)` at all 8 call sites — runs (3), cases, measures
(2), compliance-simulation, scheduler. Measures named in `WORKWELL_OFFICIAL_MEASURES` evaluate through
the official artifact; everything else is unchanged.

**With the flag unset it returns the authored engine ITSELF.** Identity, not equivalence — no dispatch,
no allocation, nothing to reason about on the path every environment is actually on. The parity test
asserts `routed === authored` rather than comparing two engines' outputs, because identity is a fact
where output-comparison is a claim about two code paths agreeing on the inputs someone thought to try.

**Everything is validated at construction, and construction throws.** A misconfiguration must not
survive to the first subject: by then a run is underway, outcomes are being written, and the failure
mode of most of these mistakes is silence. So the router refuses to exist unless every named measure is
covered by the MADiE gate, has a vendored artifact whose `catalogId` matches, has recorded numerator
semantics, and — the invisible one — has every value set its ELM retrieves expanding to a non-empty set.
All problems are reported at once, not the first: fixing them one redeploy at a time is how a
five-minute configuration becomes an afternoon.

`WORKWELL_OFFICIAL_MEASURES=all` is refused, because "all" is a measure name like any other and there is
no measure called that. Every flip stays a deliberate per-measure act.

**An explicit `elm`/`metaOverride` always stays authored**, even for a routed measure. The fidelity lab
evaluates an official-*subset* measure through that seam and the Rule Builder previews generated CQL the
same way; routing those to the official executor would silently run a different measure than the caller
asked for.

**Terminology expansion is now scoped to one run** — memoized per measure per executor instance, and the
instance lives exactly as long as the router, which is built per run like `engineForEnv`. That is the
middle of two bad options the adapter's review named: per-call was thousands of store reads in a
population run, per-process would freeze the snapshot and re-introduce the stale-expansion bug
`engine-factory.ts` documents at length. A rejected expansion is deliberately *not* cached, so one
transient store failure doesn't become a whole run of refusals.

`official-measures` joins the boot seam line as the 11th seam — and the only one that changes what a
measure *computes* rather than how or where. Which measures a container evaluated officially must be
answerable from a log, not inferred from a deploy config.

**The boundary guard corrected me again.** I pre-emptively added the router to the fqm consumer
allowlist; the guard failed because the router imports the *adapter*, not the package. Reverted, with
the reason written where the next person will look.

**Not yet safe to switch on**, and the module says so in its own docstring: it does not prepare bundles
(`stampQiCoreStructure`) or batch subjects measure-major. The flag existing and the flag being safe to
set are different things, and this delivers the first.

### Review round — the flag would have split the two run paths

Two criticals, and the first is the third instance of one bug this repo has already documented twice.

**The nightly run could never have routed officially.** `server.ts` hands `schedulerTick` an explicit
allowlist of `process.env` keys, and `WORKWELL_OFFICIAL_MEASURES` was not in it — while every field of
`OfficialMeasuresEnv` is optional, so it type-checked. Once flipped on, `POST /api/runs/manual` would
evaluate cms122 officially and the nightly `ALL_PROGRAMS` run — the one that actually populates
`/compliance`, `/programs` and `quality_snapshots` — would evaluate it with the authored CQL. Two
engines, two answers for one measure, latest-run-wins, `official-measures=on` on the boot line
throughout. The comments immediately above that allowlist describe the same bug happening to
`WORKWELL_WEBCHART_PRIVATE_KEY_B64` (#331) and `WORKWELL_INCREMENTAL_EVAL` (#263). A test now asserts
the keys are threaded, because three times is a pattern and comments have not stopped it.

**Validation was construction-time, and the roadmap said boot-loud.** I had rewritten that plan item to
match what I built, which is the "no silent scope changes" rule in reverse. `routedEngineForEnv` is
lazy, so a typo'd flag would boot clean, log `official-measures=on`, keep `/actuator/health` green (it
is deliberately DB-free, so the 15-minute reconciler reports healthy) and return `internal_error` from
every evaluating route — character for character the symptom profile of the four-day Neon outage that
DEPLOY.md's "Watch the right signal" section exists because of. Boot now runs the same validation and
emits a greppable `WORKWELL_ALERT OFFICIAL_ROUTING_MISCONFIGURED`.

Four more: **scoring** was the one adapter refusal that fired per-subject rather than at construction —
and the run pipeline error-isolates a per-subject throw into MISSING_DATA, so a cohort artifact would
have produced a *successful* run with every subject MISSING_DATA, the silent-empty-population failure
again through the door next to it. The `/evaluate` route constructed the router *after* marking the run
RUNNING, so a config error orphaned a run. The "instance lifetime is one run" claim was **false at three
read routes** (`/simulate` is a date scrubber — one construction per drag). And "all problems reported
at once" excluded the terminology preflight, which is serial and first-failure.

Two smaller corrections worth recording because they are the same failure mode as the licensing and
`Join-Path` claims: the `elm`/`metaOverride` escape hatch's docstring cited the fidelity lab and Rule
Builder as callers — **neither goes through the router**, so the guard is defensive rather than
load-bearing; and a test comment claimed it "deliberately does not load" the real calculator when it
very much did, which meant `assert.ok(err instanceof Error)` would have passed just as happily on a
`MODULE_NOT_FOUND` as on a real routing hit. It injects a calculator now.

Typecheck clean; full suite **1486 pass / 0 fail / 14 skipped**.


## 2026-07-25 (evening) — PR-7c: the terminology importer reads the artifact, not a hand-kept list (branch `feat/official-valueset-import`)

The smallest change that unblocks PR-9, and it exists because PR-7a's refusal exposed a list that had
been quietly wrong for months. `pnpm resolve-valuesets` has always chosen its targets from
`CMS122V14.valueSets` — 21 OIDs, maintained by hand. The vendored artifacts need more: **CMS122
references 26 canonicals, CMS125 references 32**, 35 distinct across both. So the official executor
refuses both measures on terminology today, and no amount of re-running the importer as configured would
have fixed it.

`--official <catalogId>` derives the target list from the artifact's own compiled ELM, which makes the
importer and the executor's refusal agree *by construction* — the same ELM that decides "this measure
cannot run without these" decides what gets fetched. A test asserts that equality for both measures
rather than trusting it. Rows are named from the ELM's CQL aliases ("Hospice Encounter", "Diabetes")
instead of bare OIDs, and the 23 canonicals the two measures share are expanded once.

It deliberately imports *everything* referenced, including the four SupplementalDataElements sets that
`calculateSDEs: false` never retrieves. They are cheap, and an importer that second-guesses which
references "really" matter is precisely how the two lists drifted apart in the first place.

Arithmetic worth recording because the test caught me: I asserted the union at 40 (26 + 32 − 18 shared).
It is **35**. The 18 was a different quantity entirely — how many of CMS125's 32 happen to be covered by
the 21 already imported — and I had carried it across from the PR-7a review into a place it did not
belong. 23 are shared.

The import itself still needs the UMLS key, which lives only as a GitHub secret, so running it stays an
owner action. `docs/DEPLOY.md` now carries the exact command.

Typecheck clean; full suite **1475 pass / 0 fail / 14 skipped**.


## 2026-07-25 (later still) — PR-7a: the official executor adapter, and the failure mode it refuses (branch `feat/official-executor-adapter`)

Roadmap §7.2/§7.3. The adapter that runs a measure by executing the **official published artifact**
instead of WorkWell's authored CQL — Nicole's first correction made executable. It implements the same
`EvaluateMeasureBinding` the authored engine does, so PR-7b's router dispatches per measure with no
signature change downstream. **Nothing routes here yet**; the flag lands in 7b, the shadow comparison in
PR-8, the flip in PR-9.

**The failure this adapter exists to refuse.** `buildValueSetCache` emits a canonical it cannot expand as
*empty but present*, because fqm aborts the whole batch on a genuinely missing value set. Empty is the
right call for a diagnostic and a catastrophe in production: a retrieve against an empty set matches
nothing, so a measure whose OIDs were never imported reports **every subject out-of-population** — which
reads downstream exactly like a genuinely ineligible roster. Nothing errors, nothing alerts, the numbers
are just wrong. So the adapter expands *first* and throws if any referenced set comes back empty, naming
the OIDs and the CLI that fixes it.

**That is not hypothetical — it blocks BOTH measures today.** `pnpm resolve-valuesets` defaults to the 21
CMS122 reference OIDs and has only ever imported those. Measured against the vendored artifacts:
**CMS122 references 26 (5 missing), CMS125 references 32 (14 missing)** — so the first draft of this
entry, which said CMS125 was uniquely blocked and implied CMS122 was ready to flip, was wrong in both
directions. Without the preflight, flipping either would produce a clean-looking run in which nobody was
eligible. The refusal is also deliberately **broader than strictly necessary**: four of CMS122's five
gaps are SupplementalDataElements value sets that `calculateSDEs: false` never retrieves. That is the
safe direction, and the fix — import them — is cheap and correct anyway. `requiredOids(artifact)` is
exported so the import CLI can be pointed at an artifact rather than a hand-kept OID list; wiring that is
the obvious next step and an owner action before PR-9.

**The numerator's meaning cannot be derived, so it is a reviewed table.** `official-measure-semantics.ts`
records, per measure, whether being in the numerator is the good outcome, with the reasoning. The
tempting derivation — `Measure.improvementNotation` — is *wrong*: CMS122's artifact declares `increase`
even though its numerator is poor glycemic control. PR-5 deliberately recorded that discrepancy rather
than correcting it during vendoring, and a test now asserts the contradiction so nobody later
"simplifies" the table by reading the artifact. Getting this backwards reports every poorly-controlled
diabetic as compliant. A measure with no entry is **refused**, not defaulted — there is no safe default
in either direction.

**Vocabulary, per the roadmap: the five-bucket enum does not grow.** Out-of-IPP → `MISSING_DATA` paired
with `inInitialPopulation: false` (the L17 signal — "out of scope" vs "eligible, no data"); DENEX and
**DENEXCEP** both → `EXCLUDED`, which is what unblocks CMS68-class measures with zero enum change, since
the only question this vocabulary answers is whether someone needs chasing. The reporting distinction
survives losslessly in the new `evidence_json.official.populationResults`, which is what MeasureReport and
QRDA read (ADR-031/PR-3). `DUE_SOON` is never emitted — official CQL has no forecast define and inventing
one would be authoring logic on top of the steward's.

**Two smaller decisions worth recording.** The measurement period matches the authored path (12 months
back from the evaluation date) rather than the artifact's `effectivePeriod`, so PR-8's shadow diff
isolates the *logic* difference instead of confounding it with a period change; whether production should
use an eCQM's calendar period is a real question left to PR-9. And evidence keeps only the measure's
**own** library statements: a full CMS122 evaluation returns 419, which at ~25 KB per outcome row against
~1–3 KB for an authored measure is not something to put on a database that has already caused one outage.

**PR-3's warning was right, and the first cut of this adapter tripped it.** That PR shipped the exporter
half months-of-work early and said explicitly that `populationResults` must arrive in one of two shapes,
with a third being *rejected and alerted* rather than tolerated. The adapter first persisted the reduced
code→boolean map — a third shape. `officialMembership` refuses it ("missing a required boolean") and
degrades the report to status-derived membership, which is exactly the failure evidence-first exporting
exists to prevent, and nothing would have said so. It now persists fqm's population **array verbatim**
(also better: the reduced map drops duplicate population types, legal for ratio measures), and a
round-trip test runs the adapter's output straight through `officialMembership`. A shape assertion would
not have caught this; only the round trip does.

The fqm boundary guard caught the new consumer immediately and made me add it to the allowlist by hand —
which is the point. This is the **first production-path** consumer of the executor package; the three
before it were two diagnostics and a file loader.

### Review round — the safety narrative had two holes in it

Both found by review, both verified by running them, and both produce **the exact silent
empty-population failure this adapter's whole design is organized around** — which is the uncomfortable
part: the preflight was written to refuse that outcome, and the same outcome was reachable through two
other doors.

1. **`trustMetaProfile: true` was backwards.** The reasoning ("official artifacts retrieve by QICore
   profile") is true of the artifact and wrong as a configuration for *our* bundles. With it on,
   cql-exec-fhir filters every retrieve to resources whose `meta.profile` contains the exact templateId:
   the ELM asks for `qicore-condition-problems-health-concerns` and `qicore-observation-lab`, while
   `fhir-bundle-builder.ts` stamps `qicore-condition` and `qicore-observation-clinical-result`. Nothing
   matches; every subject leaves the denominator. For a WebChart bundle, which carries no `meta.profile`
   at all, the Patient retrieve *throws*. The repo's own precedent said so: `literal-diff.ts` runs this
   same artifact over these same bundles with the default (false).
2. **The terminology refusal wasn't airtight.** `buildValueSetCache` catches whatever the expander
   throws and substitutes an empty expansion, and the callback recorded emptiness only on the success
   path — so a *throwing* expander (the likeliest production trigger: a transient store read failure)
   sailed through with no refusal. Probed it directly: `empty recorded: [] → refusal would NOT FIRE`.

Four more real defects came with them. `outcomeFromPopulations` never read the **denominator**, so a
subject in the IPP but out of the denominator was called OVERDUE and given a case, while the exporter's
`normalizeMembership` clamps the same person out — roster and MeasureReport disagreeing about one human.
Evidence recorded fqm's `final`, which is the enum `TRUE|FALSE|NA|UNHIT` rather than a value, and
CMS122's root library defines *"Most Recent Glycemic Status Date"* — which `deriveWhyFlagged` matches on
name and slices as a date, so the roster would have read **"Last completed TRUE"**; define names are now
prefixed `official:` to defeat that anchored match. No scoring guard existed, so a `cohort` artifact
(no numerator population) would have mapped every subject to one bucket. And my hand-rolled
`subtractMonths` clamped where the engine's overflows, giving the two paths different measurement
periods on a leap day — matching the engine's quirk beats improving on it when the entire purpose is
comparability.

### Second review round — the evidence design was built on a premise that is false

The one that matters, and it inverted the design. The intent was to persist fqm's per-statement results
the way the authored engine persists CQL defines. **They cannot carry values, because of PR-6a.**
Stripping ELM annotations removes `localId`; fqm resolves a statement's `raw` value *by* `localId`, so
`raw` is always `undefined` and `final` collapses to `NA | UNHIT | FALSE`. Measured on the committed
CMS122 artifact over six MADiE cases: **0 of 96 root statements ever read `TRUE`** — including for
subjects the measure places in the numerator. A numerator member would have persisted:

```jsonc
"expressionResults": [{ "define": "official:Numerator", "result": "FALSE" }],
"official": { "populationResults": [{ "populationType": "numerator", "result": true }] }
```

Two contradictory statements in one regulatory record, and the **false** half is what the Evidence
Explorer, the auditor packet, and the AI explain prompt render. So `expressionResults` is now derived
from the population results instead: it cannot contradict `official.populationResults` because it *is*
`official.populationResults`, and the existing evidence surfaces get something true to show.

This retroactively narrows a PR-6a claim. That PR said stripping "keeps fqm's named `statementResults`,
the shape PR-7 persists", enforced by a per-measure count in the evidence report. The count is real and
the names survive — but the count is **invariant under stripping**, so it never could have caught this.
Names and count survive; values do not. Both the vendor script's header and `measures/official/README.md`
now say that, in those words.

Six smaller things came with it: the terminology refusal produced a raw `TypeError` instead of its own
diagnostic when an expander returned a non-array (fails closed either way, but loses the message naming
the OIDs and the CLI); it counted failing OIDs against canonical URLs, under-reporting when two
canonicals share an OID; the `denominator` guard used `=== false` where every neighbour uses `=== true`,
so an absent key fell through to the numerator branch — a guess, in a file whose whole discipline is
refusing to guess; and the claim that the 121/121 gate "exercises `trustMetaProfile: false` for our own
data shape" was wrong (the MADiE harness starts false and **retries true**, so the green run lands on
true for profile-tagged test bundles — it proves nothing either way about our bundles).

Two consequences of this PR's mapping are now written into the PR-7b obligations block rather than left
to be rediscovered: `roster-vocabulary.ts` renders **every** EXCLUDED as "Contraindication / exemption on
file" though this adapter routes three distinct conditions there, and renders OVERDUE as "no record on
file" — which for cms122 is the factual opposite, since OVERDUE means a *recorded* HbA1c above 9%.

Typecheck clean; full suite **1474 pass / 0 fail / 14 skipped**.

## 2026-07-25 (later) — PR-6a: the gate pays for itself — 86% smaller artifacts, proven neutral (branch `feat/strip-elm-annotations`)

The first thing the new gate was built to decide. `--strip-elm-annotations` has existed in
`pnpm vendor:official` since PR-5 but stayed off, because `localId` is what fqm-execution uses for clause
coverage and an unproven size optimisation is exactly what the deploy job-poll window has already been
burned by once (PR #283). With the gate green there was finally a way to *ask* rather than argue.

Re-vendored both measures with the flag: **16.0MB raw → 2.4MB vendored, 86% smaller** (it was 10.5MB
unstripped). Re-ran the gate: **121/121, and the reduction check reports 0/55 (CMS122) and 0/66 (CMS125)
cases changed population vector.** All 8 priority measures now project to **~19MB of deploy image
instead of ~80MB**, which is what makes the remaining six safe to land.

**What that check does and does not compare, precisely.** It executes our stripped artifact against the
**full upstream bundle** over the same 121-case deck. So it proves *stripped ≡ upstream*, not directly
*stripped ≡ unstripped* — the second follows by transitivity through the previous commit's report, which
recorded 0/55 + 0/66 for the unstripped artifact against the same upstream. Worth stating because this
PR overwrites that file, so half the chain now lives only in git history. It also compares **population
membership only** (the four codes), and reads `detailedResults[0]`, which is fine for two single-group
measures and would silently compare group 0 alone the day a multi-group measure is vendored.

**Probed what is actually lost rather than assuming**, since PR-7 will persist fqm's output as
`evidence_json.official` and a surprise there would be found late. With annotations stripped, a CMS122
case returns `populationResults` complete with `criteriaExpression`/`populationId`, and **419 named
`statementResults` with `final` values** (CMS125: 423) — the shape PR-7 needs. Gone: `clauseResults`
(already `0` — `calculateClauseCoverage` and `calculateHTML` are both off), per-statement `localId`, and
`locator`, which is what fqm error text uses to point at a position in the ELM, so a runtime failure in
an official measure can no longer be localized. That last one is a real if small diagnostic cost.

**The statement-result claim is now enforced rather than written down.** A one-off probe frozen as prose
in three files is exactly how a future re-vendor or fqm bump breaks PR-7 with the gate still green — so
the reduction check counts statement results per measure, the report records the number, and a
default-suite test fails if it ever reads zero. Getting that count right took three wrong answers first:
de-duplicating by bare statement name reads **138** and by library-qualified name **150**, because these
measures include 9–10 libraries that reuse names like `Numerator` and `SDE Sex`; and taking the *maximum*
across subjects (Codex) lets one subject with an empty payload hide behind fifty-four healthy ones while
the floor stays green — the very failure the floor exists to catch. It records the **minimum**, so a
non-zero count means every subject produced a payload. That reads **419** and **423**, matching an
independent count of the ELM statement definitions.

The flag stays opt-in at the CLI — an unstripped artifact is one command away if clause-level debugging
is ever needed — but every measure vendored for production use passes it, and the README says so.

**One thing regenerating the report exposed: it was evidence about nothing in particular.** With the
stripped artifacts in place, the report came out **byte-identical** apart from its date — which is the
neutrality result, and also the problem. Every reduction setting produces a *v1.0.000* artifact, and the
report only ever named the version, so re-vendoring at different settings would have left the committed
evidence looking equally green while proving nothing about the bytes that ship. The reduction check now
records the artifact it executed:

> Artifact proven: `sha256:c0d99a8e…` (2.4 MB, ELM annotations stripped). Compared on population
> membership (…) only; the artifact also returned 419 named statement results per subject.

The hash is computed in the CLI over the file on disk rather than read from `manifest.json` — quoting
the manifest's own hash back would make the evidence circular. The descriptive *"stripped"* label can
only come from the manifest, so it is reported **only when the manifest's hash matches the bytes we just
hashed**: corroboration, not authority. A manifest describing some other artifact, or an unreadable one,
renders "unverified" — the first cut printed an affirmative *"retained"*, which is a false claim about a
stripped artifact, and the accompanying comment described a behaviour the code did not have.

A default-suite guard then pins each measure's reduction-check section to its committed artifact, so
re-vendoring without re-proving fails locally, and CI's staleness check catches it too. Verified by
appending one byte: the guard fails with the on-disk hash in the message.

Typecheck clean; full suite **1456 pass / 0 fail / 14 skipped**.

## 2026-07-25 — PR-6: the official MADiE gate runs in CI, and PR-5's reduction proof is discharged (branch `feat/madie-ci-gate`)

Roadmap §7.4 PR-6. A new `official-cases` CI job fetches the pinned upstream content and runs
`pnpm test:official-cases`, so the project's only **external** ground truth — the measure stewards' own
expected results — gates every push instead of being a command someone remembers to run. It is a
separate job rather than part of `pnpm test` because it clones ~34MB from GitHub; a developer offline
still gets a green local run, and CI always pays the cost. The job also fails if the **committed
evidence report is stale**, so `docs/OFFICIAL_TESTCASE_REPORT_2026-07.md` cannot drift from what the
harness actually produces.

**THE RULE is now enforced in code, not prose, in two places.** "No measure enters
`WORKWELL_OFFICIAL_MEASURES` without a green gate" was a sentence in the roadmap.
`official-gate.test.ts` makes half of it a test, in the default suite, with no network: the gated set
must be **exactly** the vendored artifact set. Both failure directions are real — vendor an artifact and
forget to gate it and it could be flipped to official with no external validation at all (precisely what
the rule exists to prevent); gate one with no artifact and CI fails confusingly. Verified by planting an
ungated `cms165/` artifact: the test fails. It also pins each gated measure's upstream name to its
manifest (a mismatch would surface as a silent "no cases found" in CI). The other half is
`ungatedOfficialMeasures()` in `wiring/official-routing.ts` — the **routing edge the rule is actually
about**: it rejects a flag value naming a measure the gate does not cover, which is what PR-7's router
will throw on.

**PR-5's open proof is discharged.** That PR argued reduction-neutrality from mechanism and left the
end-to-end proof to this one. Ran it: **121/121 (CMS122 55/55, CMS125 66/66)** with
*"0/55"* and *"0/66 cases changed population vector; 0 drift errors"* — dropping CQL source, ELM XML,
narratives and ValueSet expansions during vendoring changes nothing either measure computes. Combined
with the Codex fix that made drift fail the command, a bad `vendor:official` now fails CI instead of
shipping quietly.

### Review round — two ways this gate was quietly toothless, and one claim the runner refuted

Self-review found defects of a kind only a real run surfaces, which is uncomfortable for a PR whose
entire value proposition is *"the gate runs"*:

1. **The report check would have gone red the day after every regeneration.** The harness stamps
   `**Generated:** <today>` into the report, so `git diff --quiet` on it compares a timestamp, not
   results. A gate that fails for a reason nobody caused is a gate people learn to ignore — the worst
   possible outcome. It passed on the first run only because the report had been regenerated that same
   day. The comparison now strips that one line, verified in both directions locally (date-only change →
   pass; a changed result → fail).
2. **The drift check only ran for CMS122**, so PR-5's neutrality claim covered one of the two vendored
   artifacts. It now runs per measure, which is how the CMS125 `0/66` line above exists at all.

The third finding was **wrong, and the runner log is what said so** — worth recording because it is the
same failure mode as PR-5's false licensing claim, caught the same way. Review flagged
`Join-Path $PSScriptRoot "..\.official-content"` as a Linux path bug (.NET treats only `/` as a
separator on Unix, so the backslash is a legal filename character and the whole string is one segment).
Plausible, and false: the first run's log reads `Cloning into '…/backend-ts/.official-content'` and the
harness went on to run 121/121. PowerShell's filesystem provider normalizes the backslash before
`GetFullPath` ever sees it. The multi-argument form is kept anyway — it does not depend on which layer
normalizes — but as hardening, not as a fix for a break that never happened.

Two vacuity holes closed alongside: a per-measure **case-count floor** (`REQUIRED_OFFICIAL_CASE_COUNTS`)
so an upstream reorg that stops the sparse-checkout patterns matching cannot report a smaller green
number and exit 0, and report assertions that check the *numbers* rather than whether the string
"CMS122" appears somewhere (the renderer emits a heading per measure, so a measure with zero cases would
have matched). Plus: `OFFICIAL_GATED_MEASURES` derived from the harness's own measure table instead of a
parallel literal, `timeout-minutes: 20`, the pinned content cached, and the failure artifact no longer
uploaded when the *fetch* failed — publishing the committed report as "the failing evidence" shows green
results for a run that never happened.

**Next, and now cheap:** with the gate green and the content already fetched, prove
`--strip-elm-annotations` (measured 79% smaller — 9.8MB → 2.1MB of ELM per measure) the same way. That
is the unlock before the remaining six measures take the image toward ~80MB.

Typecheck clean; full suite **1454 pass / 0 fail / 14 skipped**.

## 2026-07-24 (late) — PR-5: vendored official artifacts at v1.0.000, and a licensing rule (branch `feat/vendor-official-measures`)

Roadmap §7.4 PR-5. `measures/official/<catalogId>/{bundle.json,manifest.json}`, written by
`pnpm vendor:official`. CMS122 re-vendored **v0.5.000 → v1.0.000** and CMS125 vendored for the first
time; `cms122v14/` deleted along with the `OFFICIAL_CMS122` constant. That hardcoding **was** the
staleness bug — the version lived in a filename and a literal, so nothing could notice upstream had
moved on. It now lives in a manifest, with a SHA-256 over the bytes we actually execute.

**A licensing rule came out of inspecting the upstream bundles, and it binds the remaining six.** Each
ships all 26 ValueSets with full expansions, and those expansions contain **AMA CPT** and SNOMED CT
codes. This repo is public and Apache-2.0, so redistributing them is not on. Vendoring therefore keeps
**only `Measure` + `Library` (`application/elm+json`)**; terminology continues to come from our own VSAC
import at runtime, under our UMLS licence. Checking the previously-committed v0.5.000 bundle showed it
already contained no ValueSets — the right thing was being done incidentally, and is now explicit,
documented, and asserted by a test. 16MB raw → ~10MB vendored per measure.

**The size lever is measured but deliberately not pulled.** `--strip-elm-annotations` removes ELM
`annotation`/`locator`/`localId` for a **79% cut** (9.8MB → 2.1MB of ELM on CMS122), which matters
because all 8 measures at the current setting is ~80MB and the deploy job-poll window has already had
to be raised once for image growth (PR #283). It stays off until PR-6's MADiE suite proves it
outcome-neutral: `localId` is what fqm uses for clause coverage, so this is exactly the kind of thing
to prove rather than assume.

**Two things repurposed rather than deleted.** The official-cases CLI's "draft drift" check used to
compare the fetched bundle against our stale v0.5.000; both sides are now v1.0.000, so it proves
something better — that stripping CQL, ELM XML, narratives and value sets changes no population result.
And the literal-diff test asserted `version === "0.5.000"` as a literal; it now reads the manifest, so
the test cannot re-acquire the staleness it was written to catch.

**Finding for PR-7:** CMS122's official artifact declares `improvementNotation: increase`, even though
it is the inverse measure (numerator = poor glycemic control, so a lower rate is better and eCQI
describes it as decrease-is-improvement). The manifest records what the artifact declares rather than
correcting it during vendoring — PR-7 owns what an exported report claims, and whether this is worth
raising upstream the way fqm#371 was.

The real-fqm end-to-end literal-diff test and the ADR-008 guard both pass against the new v1.0.000
artifact. Typecheck clean; full suite **1448 pass / 0 fail / 14 skipped**.

**Review round (PR #336) — I asserted a licensing guarantee that was false.** The claim "no licensed
terminology is vendored" was wrong, and worse, I had enshrined it in a test name and four docs, in a
public Apache-2.0 repo. Verified directly: the compiled ELM embeds **CPT 97802/97803/97804 with their
AMA descriptions plus 7 SNOMED direct-reference codes** (cms125: 31 SNOMED), because the official CQL
declares those codes inline — they cannot be stripped without changing the measure. The retained
`Measure.copyright` carries both the AMA notice and NCQA's clause that commercial use *"including but
not limited to vendors using or embedding the measures and specifications into any product or service
to calculate measure results for customers"* requires NCQA approval. This is **not a regression** (the
old v0.5.000 bundle carried the same codes), but converting an incidental state into an explicit,
test-enforced, false guarantee is worse than saying nothing. What is actually true: **no ValueSet
resources or expansions are vendored**, which removes the bulk (26 expansions × thousands of codes) but
not the residue. Corrected everywhere it was asserted, and added **`measures/official/NOTICE.md`**
recording the terms and routing the NCQA commercial-use question to the owner as the legal question it
is, rather than an engineering one.

Other fixes: **`.gitattributes`** marks the artifacts `-text` — Git's heuristic would CRLF-convert them
on a Windows clone and break the SHA-256 integrity test while CI stayed green; **loadOfficialArtifact**
now distinguishes ENOENT (absent, cached quietly) from a real read failure (alerted, **not** cached —
PR-7 routes production execution through here, and a cached null would silently fall back to authored
CQL for the life of the worker, so two containers could report different results for the same measure);
**catalogId is validated** before any filesystem access (`new URL()` normalizes `..`, and PR-7 makes the
id operator-supplied) with a test that asserts rejection rather than absence-of-throw; the artifact test
now **cross-checks manifest ↔ the Measure resource** (the SHA only pinned manifest↔bytes, so a
hand-edited version would have passed everything, and the literal-diff assertion had become a
manifest-compared-to-itself tautology); **literal-diff provenance now reads the bundle it actually
executes**, since an injected bundle was being reported under the vendored artifact's identity; the
bundle is emitted as `type: "collection"` (dropping `fullUrl`/`request` makes it a non-conformant
transaction Bundle); `--ref` must be a 40-char SHA (a branch name would produce an unreproducible
artifact); the size warning is mirrored into `Dockerfile.dockerignore`, the file production actually
reads; and ADR-026 records that the artifact changed **source repository**, not just version
(`ecqm-content-cms-2025` → `dqm-content-qicore-2025`), which the "v0.5.000 → v1.0.000" framing hid.
**Honest scope note:** outcome-neutrality of the reduction is argued from mechanism (fqm matches
libraries by `resourceType`, reads scoring from group extensions, and never reads `fullUrl`) and proven
end-to-end only by the drift check, which is not yet a CI gate — that is PR-6. **Codex found a third hole neither review caught:** `exitCodeForRuns` read only
`run.summary`, so the reduction-drift check could report changed population vectors and the command
would still **exit 0** — meaning PR-6's CI gate would have been built on a command that cannot fail for
the one thing the drift check exists to prove. Fixed, with a test pinning both failure modes; the
existing fixture's `changedCases: 3` was also semantically stale (it meant "expected drift from the old
v0.5.000 draft"; now any change means our reduction altered a result) and is now 0. Codex's other two
were already fixed in the prior commit, except that ADR-026's original body still read as current before
a reader reached the amendment — the stale bullets now carry inline SUPERSEDED markers rather than being
rewritten, preserving the decision record. Full suite
**1450 pass / 0 fail / 14 skipped**.


## 2026-07-24 (evening) — PR-4: `@workwell/official-executor`, the fqm quarantine as a package (branch `feat/official-executor-package`)

Roadmap §7.4 PR-4. ADR-026 quarantined `fqm-execution` (axios/handlebars/moment/lodash) behind a
**file-allowlist** arch test, because those deps must never reach the worker's cold-start or request
path. That allowlist could not survive official-first execution, where fqm legitimately becomes a
*production* evaluation path (PR-7) — so the quarantine is now **structural**: the dependency lives in
`backend-ts/packages/official-executor` (`@workwell/official-executor`, pinned 1.8.5) and nowhere else,
and that package's entry imports it only through a lazy `await import`.

**What the package owns** — the fqm-facing machinery that was **duplicated across both call sites** and
could silently have drifted: the lazy calculator loader, the executable-bundle check (a Measure + ELM on
*every* Library), ELM value-set introspection, the `valueSetCache` builder (empty-but-present on a failed
expansion — a missing value set aborts the whole batch), the calculate options, and `calculateOfficial`
batching. Two of those options are load-bearing and easy to get wrong: `calculateHTML: false` (fqm 1.8.5
has **no** `disableHTMLGeneration` — a plausible name that silently does nothing) and the **fqm#371**
date-only-period-end fix (parsed as start-of-day, dropping the period's last day; without it the CMS125
MADiE deck scores 64/66). Both now have exactly one definition.

**What deliberately stays in the app:** reading vendored bundle bytes (the package is filesystem-free, so
the vendoring convention stays PR-5's business), VSAC expansion (injected `expand(oid)`), and the
population→`OutcomeStatus` mapping (WorkWell policy, not measure execution).

**Three tests replace the one allowlist**, each harder to defeat than a grep: **manifest** (no workspace
package but the executor may declare fqm), **app tree** (no `src/` file — nor any other package's source
— imports it directly), and a **lazy-import check** (every fqm reference in the package entry, comments
stripped, must be the dynamic `import(...)` form, plus a positive assertion that the app cannot even
*resolve* fqm under pnpm's strict linking).

Also lands the `packages/*` workspace member and the `pnpm test` glob covering it — the scaffolding PR-2
reuses when `measure-engine` extracts. The real-fqm end-to-end literal-diff test and the ADR-008 guard
both still pass, so the official path is provably unchanged. Typecheck clean; full suite **1436 pass /
0 fail / 14 skipped** (+10).

**Review round (PR #335) — the guard I called "structural" was a line-based grep.** The review's P1 was
that test 3/3 detected static imports **line by line**, so the shape any formatter produces once the
import list grows —
`import {` / `  Calculator,` / `} from "fqm-execution";` — has no single line matching both predicates and
sails through. Worse, the runtime `require.cache` assertion that would have caught it was wrapped in
`if (fqmEntry !== null)`, and fqm is deliberately unresolvable from the app — so that branch never ran,
here or in CI. **PR-7 is the most likely author of exactly that import.** Rewritten to scan the whole
source (comments stripped) with the same multi-line-capable regex test 2/3 uses, assert every fqm
reference is the dynamic `import(...)` form, and assert non-resolvability *positively* instead of
treating it as a reason to skip. Verified by planting the defeating multi-line import: it now fails.
Fixing it immediately exposed the sibling bug — test 2/3 then flagged the illustrative comment inside
test 3/3, so both now strip comments (the lesson the engine-boundary guard already learned). Tests 1 and
2 also generalized to **all** workspace packages, so PR-2's `measure-engine` cannot quietly take the
dependency on. Other fixes: `isExecutableMeasureBundle` narrowed unsoundly (a null entry passed the
guard, then `referencedValueSetUrls` threw on it — and PR-5 is about to feed it two new bundles);
unparseable ELM now **fails fast** as it did pre-extraction, rather than degrading to an opaque
"ValueSet not found" inside the fqm batch; `populationMembership` restored to **first-wins** duplicate
resolution (matching the `.find()` it replaced — ratio measures can repeat a populationType);
`calculateOfficial` gained the `trustMetaProfile` override its second consumer needed; the `as never`
casts and the app's duplicate `FqmCalculationOptions`/`FqmPopulationResult` declarations are gone (that
duplication was precisely the drift the extraction exists to end); and `tsconfig` now typechecks package
sources, which previously included no package test file at all. Five doc inaccuracies corrected, incl. a
`DISCLAIMER` string that **ships in the API response** still calling fqm "diagnostic-only", and a
Dockerfile comment claiming fqm is a backend-ts dependency — `pnpm list --prod --depth 3` confirms it
survives the deploy prune transitively through the workspace package. Full suite 1440 pass / 0 fail / 14 skipped. Two further escapes, both found by Codex and neither by me: **(a) nothing guarded who may
import the PACKAGE** — a route or run-pipeline module could import `@workwell/official-executor` and call
`loadCalculator()`, putting the heavy graph on a request path with all guards green; the executor-import
allowlist was written into roadmap §7.1 and simply not implemented. **(b) the package scan read only
`index.ts`**, so a helper module with a static fqm import, imported by `index.ts`, would load the graph at
cold start unseen — and the `createRequire` rooted in `src/` could not resolve a dependency nested beside
`packages/`, so the cache assertion skipped rather than ran. Now five guards: manifest, app tree, **every**
package source file, module graph (resolving **from the package**, so the cache check runs unconditionally,
while asserting the app cannot resolve it), and a **consumer allowlist**. Both escapes verified caught by
planting them. The allowlist also corrected a wrong assumption of mine: `run/cli/official-cases.ts` does
NOT import the package — it goes through `standards/official-cases.ts`, which is the layering the list
exists to preserve. Full suite **1442 pass / 0 fail / 14 skipped**.


## 2026-07-24 (later still) — PR-3: evidence-first population membership (branch `feat/measure-report-ipp-generalization`)

Roadmap §7.4 PR-3, the last exporter change that must land **before** the official flip so shadow diffs
run against a clean exporter. ADR-031 keyed out-of-population off a hand-written per-measure binding flag
(`missingDataMeansOutOfPopulation`, set on cms122/cms125 only). That does not scale to the eight incoming
official measures — each would need a flag guessed from its CQL — and it structurally cannot express
DENEXCEP/NUMEX, nor survive an inverse measure (cms122's numerator is poor control, so an official NUMER
subject carries the workflow status OVERDUE).

**`membershipFor(outcome, measureId)` now reads `evidence_json.official.populationResults` first** and
uses it verbatim — the measure's own logic reporting its own populations, authoritative over any status
heuristic. Absent that evidence (every measure today) the ADR-031 rule applies unchanged, so this is
**behavior-neutral until the flip**; malformed evidence degrades to the status rule rather than throwing
inside an export. `denominator-exception` is emitted and subtracted from the effective score denominator
in **both** MeasureReport and QRDA III — but only when non-zero, so authored exports stay byte-identical.
QRDA III was fixed in the same pass: it hardcoded four populations and `denom - denex`, so it would have
silently disagreed with MeasureReport the moment exceptions existed.

**Two findings recorded rather than acted on.** (1) The obvious reading of "key off persisted
`inInitialPopulation`" is a trap: **every** measure defines `"Initial Population"` and it is already
persisted, but adopting it would change exported IPP/DENOM for the 12 OSHA/HEDIS measures (audiogram's
IPP is `In Hearing Conservation Program or Has Active Waiver` — non-enrolled subjects inflate today's
denominator) **and** break the documented 1:1 reconciliation with the histogram path. Real correctness
finding, but it deserves its own decision, not a silent side effect — recorded in the ADR-031 amendment.
(2) `populationCountsFromStatus` (the bounded `GROUP BY status` histogram behind 120k `seed:scale`
summaries) has no per-subject evidence, so it is now explicitly scoped to authored measures.

**PR-2 resequenced.** A dependency-closure scan settled what `packages/measure-engine` actually is: **29
files (9 TS + 20 ELM) reaching nothing outside `src/engine/`** — exactly §7.1's list. `resolveDataSource`
+ the WebChart adapter would inflate it to 38 and drag in the whole synthetic corpus (via
`webchart/terminology.ts` → `synthetic/measure-bindings.ts`), so by the PR-1 precedent they stay behind
as app composition. The physical move is a ~53-file import rewrite with zero externally-visible value,
and PR-1's containment test freezes the boundary so it cannot regress while it waits — so it now lands
with M-C, carrying PR-4's workspace scaffolding. Also noted: the four `*-cli.ts` files export library
values consumed by 8+ modules, so "move the CLIs out" is a real refactor, not a `git mv`.

Typecheck clean; full suite **1415 pass / 0 fail / 14 skipped** (+7 tests, no regressions).

**Review round (PR #334).** A differential harness (main vs branch, 16 measure ids × 11 status strings ×
17 evidence shapes, plus empty-list and zero-denominator cases) confirmed the byte-identity claim on
every surface incl. QRDA XML — and found four real gaps, all fixed:
**(1) the production aggregate path could never see official evidence.** `routes/runs.ts` builds both
QRDA III and the summary MeasureReport from the status histogram, so at the flip the summary and the
per-subject bundle would have reported *inverted* numerators for the same cms122 run — and QRDA III,
the artifact M-B feeds to Cypress/CVU+, would have carried the status-derived numbers. My code comment
named the trap but nothing enforced it. Added `src/wiring/official-routing.ts`
(`WORKWELL_OFFICIAL_MEASURES`, the PR-7 allowlist landed early as a read-only guard) and routed
official measures to the evidence-aware row path, bounded by the same subject cap (422 over it, rather
than emitting a wrong regulatory artifact). A test now *pins* the divergence instead of describing it.
**(2) shape drift between the two halves of the contract:** the reader accepted only a keyed object,
while everywhere else in the repo fqm population results are an **array** of `{populationType, result}`
— the most natural writer would have been silently rejected. Now both shapes are accepted, the type is
exported, and PR-7's obligation is written into the roadmap.
**(3) silent-misread hazards:** a partially-spelled payload (`denominator` instead of `denom`) used to
read as all-false (DENOM 0 / NUMER 0, no signal) — now rejected; `official` present-but-unreadable is
now **loud** (`WORKWELL_ALERT OFFICIAL_POPULATION_RESULTS_UNREADABLE`) because for an inverse measure a
silent degrade turns the artifact into its opposite; and membership violating `numer ⊆ denom ⊆ ipp` is
clamped + alerted rather than emitted as a non-conformant report Cypress would reject.
**(4) the `improvementNotation`/canonical coupling** that `measure-report.ts` explicitly forbids
breaking is now a *stated PR-7 obligation*: official membership inverts cms122's numerator, so canonical
+ notation must flip with it. Also corrected six-vs-eight measure counts, the "16 measures" claim (16
`.cql` artifacts, 14 runnable), and a stale ARCHITECTURE line claiming QRDA aggregates via
`countPopulations`. Full suite **1426 pass / 0 fail / 14 skipped**.


## 2026-07-24 (later) — Nicole recalibration → strategic plan approved → engine-boundary severance (extraction PR-1, branch `feat/engine-boundary-severance`)

**The Nicole meeting reset the near-term direction** —
the sharpest external correction the project has had: (1) for official CMS eCQMs, **download and run the
official published CQL**, don't reauthor ("if the CQL exists, use it… other than maybe as an educational
exercise"); (2) the real EHR proof path is **QRDA-I ingest → calculate → regenerate QRDA-I/III → Cypress
→ ONC** (MADiE is authoring tooling, not how an EHR verifies); (3) her 8 priority measures: **CMS2, 68,
122, 125, 130, 138, 165, 951** (MIE is ONC-certified on ~33/49); (4) self-authored CQL is the value
exactly where no official definition exists — occupational/OSHA + HEDIS-insight (payer black-box) — and
MIE could steward occupational measures through the NCQA community process; (5) DEQM/quality-on-FHIR is
the direction but CMS/QPP has no endpoints yet (~2030). CQI WG meets Fridays.

**Strategic plan written + owner-approved same day** (deep-research pass over the Vision Doc charters,
the prior Doug meetings, Connectathon research, two codebase audits, and an architecture design agent) —
**committed in-repo as `docs/ROADMAP_2026-07-24.md`** (supersedes ROADMAP_2026-07-09.md as the active
direction; working copy also at `~/.claude/plans/snappy-herding-journal.md`). Headlines: 5 milestones — **M-A official-first execution**
(promote the fqm-execution literal machinery to a per-measure-routed `officialMeasureExecutor` behind
`WORKWELL_OFFICIAL_MEASURES`, MADiE cases as permanent CI gates, authored cms122/125 subsets retire to
the fidelity lab), **M-B QRDA-I/III + Cypress CVU+ validated loop**, **M-C pnpm-workspace extraction
publishing `@workwell/*`** (measure-engine w/ only cql-execution+cql-exec-fhir deps; official-executor as
the fqm quarantine package), **M-D WebChart breadth + the compliance API contract**, **M-E occupational
content pack published in the community `dqm-content` shape + CQI WG cadence**. Verified en route: all 8
priority measures have official QICore v1.0.000 artifacts + MADiE test cases in
`cqframework/dqm-content-qicore-2025`; Cypress/CVU+ is open-source and Docker-runnable; QI-Core STU7 = US
Core 7 = exactly WebChart's verified FHIR surface. Two-track posture is deliberate: execute on the
FHIR/QI-Core column, report on the current QRDA column; QDM appears only as a translation at the QRDA
boundary.

**Extraction PR-1 shipped (this branch) — sever the engine's app-layer imports, zero behavior change:**
(1) new narrow **`ValueSetSource`** port in `engine/cql/value-set-resolver.ts` — the engine consumed
exactly one method (`listAll()`) of the 30-method `ValueSetStore`; the store satisfies the port
structurally so no call site changed; (2) **`UnconfiguredEngine`** (the only `@mieweb/cloud` consumer on
the eval surface, zero importers) moved to `src/wiring/unconfigured-engine.ts`; (3)
**`engine-factory.ts` + test moved to `src/wiring/`** (git mv — it is app composition, the one
`getStores` value-coupling; 5 importers repointed); (4) new **`engine/engine-boundary.test.ts`** arch
guard (fqm-isolation pattern): no production file under `src/engine/` may import `stores/` or
`@mieweb/*`. After this the engine tree reaches **nothing outside itself** — verified by an exhaustive
specifier scan of all 43 production files, not just the two severed targets. Its third-party surface is
`cql-execution` + `cql-exec-fhir` (the evaluation core) **plus two items of extraction debt PR-2 clears**:
`@cqframework/cql/cql-to-elm` in `cql/cql-translator.ts` (the ELM Explorer — reached from
`routes/measures.ts`, so a real runtime dep today; PR-2 moves that file to the app) and `node:fs`/`path`/`url`
confined to the four `*-cli.ts` entrypoints. Typecheck clean; full suite **1408 pass / 0 fail / 14 skipped**
(byte-identical outcomes).

**Review round (PR #333, Codex P2 — a real hole, fixed).** The guard matched two import *shapes*
(`from "x"` and `import("x")`), so a side-effect `import "@mieweb/cloud";` or a CJS `require("../stores/…")`
would have restored a forbidden runtime dependency **while the test stayed green** — an arch fence that
silently passes is worse than none. Rewrote it to extract EVERY module specifier (static `from`,
side-effect `import "x"`, dynamic `import("x")`, `require("x")`, `export … from "x"`, quote-agnostic) and
test the specifier itself against the forbidden targets. The matcher is now **unit-tested against all
nine forms plus six clean controls** (including `@mieweb/cloud` mentioned in prose, and `restores/` which
must not match `stores/`), and a planted-violation probe confirmed the tree walk fails end-to-end on the
exact form the original regex missed. Also stripped the Windows trailing separator so violation labels
read `src/engine/x.ts`, not `src/engine//x.ts`.

**Self-review round (whole-branch) — the guard became a CONTAINMENT rule.** The review's headline finding
was that forbidding two specifier *targets* is the wrong rule for a package boundary: it passes a one-hop
indirection. `import { engineForEnv } from "../wiring/engine-factory.ts"` inside the engine was green —
yet `wiring/engine-factory.ts` imports `getStores` and `wiring/unconfigured-engine.ts` imports
`@mieweb/cloud`, so the extraction is blocked while the fence built to prevent exactly that says fine.
Rewrote it to the rule PR-2 actually needs: **every relative import must resolve inside `src/engine/`**
(path-resolved, so `./../../` and non-normalized forms can't dodge it) **and every bare import must be on
an allowlist that IS the package's dependency manifest** (an interpolated `${…}` specifier is rejected as
unverifiable). Probes confirmed both new classes now fail: the wiring indirection and an undeclared
`axios`. Comment stripping was added because the old matcher tripped on doc comments that quote import
paths — a real false positive in a repo this comment-heavy. Second finding, also real: the claim
*"runtime coupling is exactly cql-execution + cql-exec-fhir"* was **false today** — an exhaustive scan of
all 43 production files found `@cqframework/cql/cql-to-elm` (in `cql-translator.ts`, reached from
`routes/measures.ts`) and `node:fs`/`path`/`url` in four `*-cli.ts` files. Rather than soften the docs,
the allowlist **pins both as scoped exceptions** (translator: that one file; `node:*`: `*-cli.ts` only),
which converts ARCHITECTURE's "file I/O only at the CLI edge" from prose into an enforced invariant, and
ROADMAP §7.4 PR-2 now explicitly owns clearing both. Also: pinned the tree-walk count (a walk finding half
the tree used to pass), documented `UnconfiguredEngine` as deliberately unreferenced (the refusal contract
for an unwired target — zero importers on `main` too, so not a regression), and corrected 1407→1408 across
CLAUDE.md/README/JOURNAL.

## 2026-07-24 — #263 incremental/delta batch evaluation, Phases 2a + 2b (branch `feat/263-incremental-eval`)

Built the incremental-evaluation feature end-to-end on a feature branch (owner said "proceed with #263";
owner decisions taken up front: **live tenants only** — exclude the synthetic scale tenant; **build
`next_transition_at`** status-boundary caching; **recompute evidence** at copy time; DDL approved). The
whole thing is **inert unless `WORKWELL_INCREMENTAL_EVAL=true`** (the 10th boot-inventory seam) and
scoped to the live-tenant run pipeline (`finishManualRun`) — the demo/default stack and the scale path
are byte-identical. Descriptive only: reuse decides only WHETHER to re-run CQL, never the answer
(ADR-035).

**Verified the design against the real code first** (owner asked me to double-check architectural fit)
and found three corrections worth recording: (1) persisted evidence is exactly `{ expressionResults }` —
the design/DATA_MODEL `why_flagged`/`evaluatedResource` shape is Java-era aspirational; `why_flagged` is
DERIVED on read by `deriveWhyFlagged`, which reads `days_overdue` from the stored `"Days Since"` define,
so copy-forward must recompute exactly that define. (2) `next_transition_at` is only *provably safe* for
measures whose status is a monotone step function of days-since-event — `flu_vaccine` (seasonal) and
`cms122`/`cms125` (period-based) are EXCLUDED (same-day-hash only), or a stale copy could ship a wrong
status. (3) Wiring only `finishManualRun` gives the "exclude scale" decision for free.

**Phase 2a — pure change-signal functions (`backend-ts/src/run/incremental/`), all golden-tested:**
`canonical-hash` (data_hash over the canonicalized evaluated bundle), `logic-version` (ELM + VS-expansion
hash), `evidence-copy-forward` (advances each `"Days Since"` by elapsed days — same-day copy is
byte-identical), and `next-transition` (BOUNDARY_SAFE threshold table **golden-verified against the real
`CqlExecutionEngine`** — all 8 windowed measures flip exactly where tabled, first try). 38 tests.

**Phase 2b — store + wiring + parity:** owner-approved `eval_state` DDL (floor + ceiling, DATA_MODEL
§3.27), `EvalStateStore` port + 2 adapters + store-contract (5 tests), `factory.ts` wiring, the
`IncrementalCache` orchestrator, copy-forward in `finishManualRun` (reuse-or-evaluate + never cache an
engine-failure), run accounting (evaluated-vs-skipped in the `RUN_COMPLETED` payload + run log line),
env-threaded through routes + scheduler + `server.ts`, and the 10th seam in the inventory. The
**parity suite** (`parity.test.ts`, the acceptance criterion) runs the real engine + real SQLite
`eval_state`/`outcomes` against fixed bundles (modelling real WebChart data whose exam dates don't shift
per run date) and proves all six §8 scenarios: same-day byte-identical reuse, across-day reuse with
date-corrected evidence matching a full run, boundary-crossing re-evaluation with the correct status
flip, data-change + logic-version invalidation, terminal (OVERDUE) reuse across a year, and PERMANENT
reuse. 7/7.

Typecheck clean; full `pnpm test` **1406 pass / 0 fail / 14 skipped**. Opened **PR #332**. Both an
independent code-reviewer (superpowers) and Codex reviewed it and **converged on the same two P1s**, now
fixed pre-merge (commit after the two feat commits):
- **Backdated-run reuse** — the `next_transition_at` scheme assumes the clock only moves forward; a rerun
  of an *older* run (reusing its persisted `evaluationDate`) after the cache advanced would copy a
  future-computed status backward (July's OVERDUE into a June rerun). Fixed: reuse now requires
  `evalDate >= source_eval_date`; parity test added.
- **`logic_version` coverage** — it hashed only the base ELM, so a VSAC toggle/re-import or an operator
  value-set edit wouldn't invalidate reuse for an expanding measure. Fixed: hash the engine-selected
  library (base vs `expansionLibrary`) + fold in referenced value sets' store `expansion_hash`; threaded
  `expansionActive`/`valueSets` through routes + scheduler; byte-identical on the demo path; 4 unit tests.
Plus two LOWs (silent `plan()` failures → run WARN; canonical-hash over-strip → level-scoped). Both Codex
threads replied + resolved; self-review summary posted on the PR. Tier 1 (`Group/$export?_since=`)
stays MIE-gated and unbuilt. Ready for owner merge.

## 2026-07-24 — staging is LIVE; the multi-line PEM does not survive the container env transport

The staging env (#329) went from merged-but-dormant to **deployed and serving**. Two findings, one of
which invalidates a documented assumption and one of which is a real transport bug.

**The MIE hosting ask was never needed.** DEPLOY.md listed "confirm with Doug/Dave that MIE will host a
second container set" as owner step 1, blocking the first dispatch on a human round-trip. But the deploy
provisions containers *programmatically* through the same Container Manager API and `LAUNCHPAD_*` secrets
production already uses — so it was a quota question testable in five minutes, not a permission question.
Dispatched from `main` @ `8bb9685`: all four jobs green, `twh-staging` + `twh-staging-api-ts` created,
both 200, **production untouched** (`twh` + `twh-api-ts` still 200, seam still `webchart=off`). Step 1 is
now struck from the runbook. Courtesy note to Doug/Dave, not a gate.

**Neon staging:** `workwell-staging` / `damp-hill-78058027` — PG16, us-east-1, 0.25–2 CU, deliberately
matching production on all three. The first attempt (created via MCP, which exposes no version parameter)
came out **PG17 on a fixed 1 CU** and was deleted: a staging env on a different Postgres major cannot
validate planner-dependent work, and #233's whole fix was coaxing the PG16 planner onto
`spike_outcomes_run_id_idx`. The console path (explicit PG16) is the one to use — same trap DEPLOY.md
already documents for `neonctl`.

**Then the live run failed in 985 ms: `Invalid keyData`.** The key and the code were both already proven
— the same file drove a successful 392-subject live run locally on 07-23 — so the only new variable was
the GitHub-secret → Container-Manager transport. A multi-line PEM does not survive it.

Worth recording *how* the diagnosis narrowed, because the first hypothesis was wrong. Newlines arriving
escaped as literal `\n` looked like the obvious culprit, and the parser's `\s+` strip genuinely doesn't
remove backslash-n. But reproducing that shape throws `Invalid character` from `atob` — a *different*
error than the one staging reported. `Invalid keyData` comes from `importKey`, meaning base64 decoding
had already **succeeded**. That only fits **truncation at the first newline**: body → empty string →
`atob("")` → 0 bytes → `Invalid keyData`. The error message was the evidence; taking it literally is what
distinguished the two hypotheses.

**Fixes (branch `fix/webchart-key-b64-transport`):**
- **`WORKWELL_WEBCHART_PRIVATE_KEY_B64`** — the key travels base64-encoded, single-line, so there is no
  newline between the secret store and `crypto.subtle.importKey`. Takes precedence over the raw var;
  the GitHub secret stays a plain PEM and the workflow does the encoding (`base64 -w0`).
- **A malformed `_B64` throws instead of degrading to inert.** `isWebChartConfigured` keys on the
  *presence* of a key, not its validity — otherwise a bad encoding reads `webchart=off` and the deploy
  looks healthy while the live integration is silently switched off. Wrong answers must be loud.
- **`Invalid keyData` is no longer the symptom.** `pemToPkcs8` rejects an implausibly short body with a
  message naming the variable, the likely truncation, and the fix. That message is the whole cost of this
  incident, repaid.
- Escaped-`\n` tolerance kept as belt-and-braces — explicitly *not* the staging cause, and labelled so in
  both the code and the test, since a comment that misattributes a bug is worse than no comment.

28/28 on the two affected suites; typecheck clean; seam inventory 30/30.

## 2026-07-23 — WebChart population-enumeration completeness (the shipped `gt1900` query undercounted 20%)

Phase-5 real-server hardening surfaced a real bug in the just-merged live path. Probing teatea while
auditing the 14-measure live evaluation: `Patient?birthdate=gt1900-01-01` returns **28**, but
`Patient?birthdate=ge1900-01-01` returns **32** and `Patient?birthdate=le3000-01-01` returns **35** — so
the `gt1900-01-01` enumeration I used in Phase 2/3 and shipped in the staging workflow (#329) **silently
dropped 7 of 35 patients** (4 born exactly 1900-01-01 + 3 with default/garbage pre-1000 birthdates). This
is exactly the "demographic guess drops subjects" hazard Codex flagged on #328 — and it was live.

**Fixes (branch `fix/webchart-population-completeness`):**
- **Client completeness guard** (`webchart-client.ts`): `listPopulation` now captures the searchset's
  `Bundle.total` and, if it fetches fewer Patients than reported, **throws on an authoritative run**
  (`failOnPartialPage`) / warns otherwise — so a paging truncation can never "succeed" over a partial
  population (which would close out cases for the missing subjects). It can't detect a query that
  *under-matches* (total reflects the query), so the docs point at `Group/$export` as the only
  provably-complete enumeration.
- **Corrected the shipped query**: staging workflow + DEPLOY.md now use a **wide upper bound**
  `birthdate=le3000-01-01` (catches all birthdates incl. default/early ones → teatea's full 35) instead
  of `gt1900-01-01`, and instruct operators to cross-check `Bundle.total`.
- **Live-verified**: the corrected query lists **35** (was 28).

**Code review (PR #330) — 2 High + 4 Medium/Low addressed; the review caught a bug I'd have shipped.**
- **H1 — the fix mirrored the original bug at the other end.** `le3000-01-01` is an arbitrary bound;
  FHIR dates run to **9999-12-31**, and `9999-12-31` is one of the most common EMR "unknown birthdate"
  sentinels — the same family of garbage values as the pre-1000 dates that caused the incident. Moved to
  the full range **`birthdate=le9999-12-31`** (workflow, DEPLOY.md, both client docstrings). Live-checked:
  same 35 today, but strictly wider and no arbitrary constant. Also removed two false claims ("catches all
  birthdates"; "teatea's **full** 35" — 35 is the largest any query returns, not confirmed ground truth).
- **H2 — the guard was defeatable, and the population pollutable.** `patientsFromSearchset` admitted
  *every* Patient in `entry[]` regardless of `search.mode`, unlike its resource-side twin. An
  `_include`d Patient would be evaluated as a population subject **and** pad the fetched count to mask a
  genuine shortfall (`Bundle.total` counts matches only). Added the match-mode filter + a test.
- **H3 — the guard's premise was unrecorded.** Nothing in-repo showed WebChart returns `Bundle.total`
  (the existing probe reads it from a request teatea 400s). **Verified + recorded 2026-07-23: teatea
  returns a numeric `total` (35)**, so the guard is genuinely live there. `bundleTotal` now also warns on
  a present-but-non-numeric total instead of silently disabling itself.
- **M1 (partial)** — the failure message now carries `distinct / match-entries / pages / total` so an
  operator can tell a real truncation from cross-page repeats or an estimated `total`; an over-report
  (fetched > total) warns rather than passing silently. A retry + env escape hatch remain follow-ups.
- **M2** — the shared mock never emitted `total`, so the guard was inert in every pre-existing test.
  `searchsetPage` now emits it (FHIR-correct), so the whole suite exercises the happy path, plus 3 new
  tests: accurate multi-page must NOT trip it, the `_include` case, and cross-page duplicates.
- **M3/L1** — swept stale `gt1900-01-01` examples out of `data-source.ts` + the plan doc (marked
  SUPERSEDED), and softened the `Group/$export` claim: WebChart advertises only **Group**-level export
  (a curated cohort, not provably everyone), and **teatea exposes no `$export` at all** (verified: no
  operations advertised; `Patient/$export` → 404, `/$export` → 403). Complete enumeration stays an open
  item, stated honestly in DEPLOY.md rather than hand-waved.

Suite after the review fixes: typecheck clean, conformance **28/28**.

## 2026-07-23 — staging deploy workflow for a live-WebChart (teatea) environment

Added `.github/workflows/deploy-staging-mieweb.yml` — a **`workflow_dispatch`-only** deploy of a
**separate, non-demo** staging stack that runs the app **live against the teatea WebChart trial**
(synthetic data, no PHI), so the real WebChart FHIR integration (#262) is exercised on a deployed URL
independent of any real-PHI environment (#267, still MIE-gated on C14/BAA). It is distinct from the demo
stack in every way and **cannot touch it**: hostnames `twh-staging` / `twh-staging-api-ts`, a **separate
Neon project** via `DATABASE_URL_STAGING`, distinct `*_STAGING` secrets, `staging-*` image tags, its own
`twh-staging-mieweb-container-ops` concurrency group, and no push trigger. The WebChart seam is configured
→ teatea; the scheduler is **off** (the 2026-07-22 Neon idle-cost lesson). `docs/DEPLOY.md` documents the
one-time owner setup (MIE hosting confirmation, the staging Neon project, the `*_STAGING` secrets incl. the
RS384 private key). Owner-gated — nothing deploys until the secrets are provisioned and it is dispatched;
the demo stack leaves every `WORKWELL_WEBCHART_*` unset and is unaffected.

**Codex review (PR #329) — 2 P1 + 1 P2 addressed:** (P1) the deploy job now refuses to run when
`DATABASE_URL_STAGING` resolves to the **same host** as the production DB (`DATABASE_URL_TWH`), so a
copy-paste can't contaminate the demo database. (P1) this journal entry. (P2) the workflow now sets
`WORKWELL_WEBCHART_PATIENT_SEARCH` (teatea 403s a bare `/Patient` and the PR #328 client refuses to guess
a demographic filter), and DEPLOY.md records that dispatching depends on the PR #328 client code.

## 2026-07-23 (afternoon) — live WebChart productionization: `_count` capability fallback shipped + proven end-to-end against teatea

Followed the registration success (below) with the plan's Phase 1 + Phase 2
(`docs/superpowers/plans/2026-07-23-webchart-live-productionization.md`).

**Phase 1 — the one real code gap, fixed.** `httpWebChartClient` listed the population with
`Patient?_count=N` and set `_count` on every per-patient search. A real WebChart server rejects both:
teatea 403s a bare `GET /Patient` and 400s `_count` (verified 2026-07-23), so a live run failed on the
very first page (fatal under `failOnPartialPage`). The client now **probes the standard shape and, on a
400/403 first Patient page, falls back once** — drops `_count`, enumerates via an accepted indexed search
(`birthdate=gt1900-01-01`, overridable via `cfg.patientSearch`) — for the list AND the per-patient
searches. `WebChartNonRetryableError` now carries the HTTP status so the capability quirk (400/403) is
distinguished from a genuine outage (still thrown loudly). Operators can pin the profile up front via
`WORKWELL_WEBCHART_DISABLE_COUNT` / `WORKWELL_WEBCHART_PATIENT_SEARCH`. **Standard servers (HAPI, the WCDB
shim) never hit the fallback — byte-identical**, guarded by a test asserting the first request still
carries `_count` and no enumeration. 6 new conformance tests over a teatea-like server; full backend
suite **1349 tests, 1335 pass, 0 fail, 14 self-skip**; typecheck clean. Branch
`feat/webchart-count-capability-fallback` (not merged — owner reviews).

**Phase 2 — proven live against teatea (read-only CLI, `pnpm evaluate:webchart-live`).** The population
listed clean — **28 patients over SMART Backend Services**, which by itself proves the Phase-1 fallback
fired (teatea's `_count`/bare-`/Patient` rejections would otherwise have failed the first page). Evaluated
through the unchanged CQL engine as-of 2026-07-23: **20 real (non-MISSING_DATA) outcomes across 5
measures** — diabetes_hba1c 4 OVERDUE, obesity_bmi 11 OVERDUE, cholesterol_ldl 1 OVERDUE, cms125 4
OVERDUE (24 MISSING each; the recency windows age real-but-old observations to OVERDUE, expected). Also:
the login-trust "Acardi, Sergio" mystery is solved — it's simply Patient id 46 in the population.

**Phase 3 (real-server hardening) — the BP finding, diagnosed live and FIXED.** `hypertension` returned
**0 real outcomes (all 28 MISSING_DATA)** while every other observation measure worked. A read-only live
diagnostic against teatea showed real BP is a **panel Observation** (LOINC `85354-9`, systolic/diastolic
in `component[]`, no top-level value) with **`status: "unknown"`**. The measure is recency-only
(retrieves a `[Procedure]` by `.performed`, no value read) and the crosswalk already maps `85354-9` → the
synthetic `bp-screen` Procedure — so the **sole blocker was the normalize status gate**, which accepted
only `final|amended|corrected` and dropped `unknown` before reconciliation. FHIR `unknown` = "source
doesn't know the workflow status", NOT an invalidity marker (`cancelled`/`entered-in-error`), and real
WebChart exports legitimate BP panels that way — so `normalize.ts` now accepts `unknown` **for
Observations only** (Immunization has no `unknown` in R4; a `unknown` Procedure stays ambiguous; a truly
*missing* status is still non-final, conservatively). Guarded by 2 new tests (an `unknown` BP panel
reconciles + synthesizes the dated Procedure; `cancelled`/`entered-in-error`/`registered`/`preliminary`
still don't). **Live re-run: hypertension 0 → 7 OVERDUE; total 20 → 27 real outcomes across 5 measures.**
Demo/synthetic path unaffected (synthetic data carries `final` statuses). Branch
`feat/webchart-count-capability-fallback`.

**Phase 3 capstone — a local teatea-backed `ALL_PROGRAMS` run, verified through the real run pipeline +
dashboard-backing endpoints.** Booted the local backend with the WebChart seam → teatea, logged in, and
triggered a live `ALL_PROGRAMS` run. It fetched the 28 teatea patients live (Phase-1 fallback), evaluated
them (Phase-3 BP fix), and persisted: **totalEvaluated 2492 = 2100 synthetic (twh 100 + ihn 50 = 150 × 14)
+ 392 live wc (28 × 14)**. The dashboard data layer then surfaced it: `GET /api/tenants` lists **`wc` =
"WebChart (teatea.webchartnow.com)"**; `GET /api/compliance/roster?tenant=wc` returns 28 wc rows with
real chips (hypertension **8 OVERDUE / 20 MISSING**, obesity_bmi 12 OVERDUE, etc.); and
`GET /api/hierarchy/rollup` **reconciles All Systems = Σ tenants (evaluated 178 = 100 + 50 + 28)** with the
`wc` tenant folded in and `openCases: 0` (the wc case-creation guard holding — no live cases). So the full
prod path — live WebChart fetch → CQL engine → persisted audited outcomes → roster/hierarchy read models —
works against a real WebChart server. (A browser screenshot would add visual confirmation; the data layer
the frontend consumes is definitively proven.)

**Next: Phase 4** — a **separate** deployed staging env wired to teatea (new Neon project + MIE containers
+ `*_STAGING` secrets incl. the private key; scheduler off / DB-free-gated). Owner-gated on MIE hosting
confirmation + secret provisioning. The demo stack stays seam-off throughout; branches remain unpushed
pending review.

## 2026-07-23 — teatea WebChart client registered self-service; LIVE authenticated FHIR confirmed (A3 answered)

**WorkWell is now authenticated against a real WebChart instance and pulling live FHIR data over the
verified SMART Backend Services contract — self-served, end to end.** Dave gave superuser access on the
`teatea.webchartnow.com` trial and pointed us at the FHIR App Setup form + Inferno docs; we completed
the registration and verified the token + read path ourselves during the meeting window.

**Keypair + JWKS.** Local RS384 keypair (private `~\.workwell\webchart-teatea.key`, PKCS#8 PEM —
**never committed, never pasted, never logged**); the matching public key is published as a JWKS at a
gist raw URL (kid `workwell-2026-07`, single RSA key, `alg: RS384`). Registered on teatea via
`webchart.cgi?f=admin&s=jwt` → **FHIR App Setup**: Connection Type = FHIR Backend Services (JWT),
Client ID `workwell`, **JSON Web Key Set URL = the gist raw URL** (WebChart fetches the JWKS from the
URL — you paste the URL, not the JSON), Entity Chart = Tamsal (audit attribution). One caution worth
recording: do **not** paste Inferno's own JWKS (from the g(10) harness docs) — that key set belongs to
the test harness; using it would let Inferno authenticate as us. Our client must present **our** gist
JWKS, matching our local private key.

**A3 ANSWERED — the biggest M2 unknown is resolved.** `pnpm webchart:probe-auth` (the one-shot probe)
ran `private_key_jwt` (RS384) → `client_credentials` grant and **GRANT SUCCEEDED**: `token_type: Bearer`,
`expires_in: 108000` (30 h), scope expanding to the per-resource `system/<Resource>.read` list +
`system/*.read`. This is despite teatea's `/.well-known/smart-configuration` advertising **only**
`authorization_code` in its grant list — so a **manually-registered backend-services client DOES receive
a client_credentials grant** even though discovery doesn't advertise it. That was the single largest open
question gating live transport (M2 / #262).

**Live authenticated FHIR reads verified** (with the granted Bearer, per-resource `?patient=`
composition — the exact ADR-028 contract `httpWebChartClient` was built for): `Patient/12` → 200 (US
Core); `Observation?patient=12` → **total 239**; `Condition?patient=12` → 2; `Immunization?patient=12`
→ 4; `Encounter?patient=12` → 6. Population enumeration: **`Patient?birthdate=gt1900-01-01` → total 28**
(teatea's whole population). Every per-patient resource composition works live; only the population
*listing* query shape needs adaptation.

**Two live quirks (teatea-specific) — the one real code follow-up.** teatea rejects `_count` as an
*invalid search parameter* (400 "invalid search parameters") and **403s a bare unparameterized
`GET /Patient`** ("doesn't have update permission" — a mislabeled deny). Our `httpWebChartClient` pages
the Patient list with `_count`, so it needs a small post-demo adaptation: fall back to an accepted
indexed search (`Patient?birthdate=gt1900-01-01` returns everyone) or make the listing query
configurable — before a live teatea-backed population run. The per-patient composition path is
unaffected. (Filed as a follow-up; see the plan below.)

**Registration state on teatea** (superuser view): FHIR Apps shows 1 record — domain `workwell`, desc
TWH, JWK Set Url = our gist, Connected Chart Tamsal; a new `workwell` FHIR-type Login Trust now exists
(its "Associated Patient" column reads "Acardi, Sergio" — unexplained; ask Dave). **Open questions for
Dave while access lasts:** (1) is bulk `Group/$export` the intended population-enumeration path for
backend clients, or can unfiltered `/Patient` search / `_count` be enabled? (2) what is the
"Acardi, Sergio" associated patient on the login trust? (3) does the superuser access persist for future
self-serve registrations?

**Guardrails unchanged.** teatea is a **trial instance with synthetic data** — no PHI. The demo Neon
stack keeps all `WORKWELL_WEBCHART_*` **unset** (seam off, byte-identical). The private key stays local;
the probe's success output is whitelisted (token_type / scope / expires_in only) and never prints the
token or key.

**Meeting outcomes (2026-07-23, with Doug / Nicole / Dave / Doug's team).** (1) **teatea trial extended
30 days → ~3 months** — Dave is arranging it via Cornwell, so the live integration has real runway (not
weeks). (2) Dave's config guidance: **feed teatea's CapabilityStatement to the AI to drive
configuration** (it's the authoritative source for supported search params — grounds the `_count`
fallback design), and consider a WorkWell **admin-configurable WebChart endpoint** (system URL + FHIR
endpoint + our `workwell` domain) so pointing at a WebChart system is config, not a redeploy. (3) Dave to
**zip + share WebChart's layout-manager folder** — schema mapping for FHIR output; feeds the **CQL→SQL /
WCDB shim track (ADR-034/#292)**, not this live-FHIR path. (4) Doug asked Taleef to **attend the HL7
Clinical Quality Information (CQI) Work Group** (for Nicole) and report back; Nicole to share the link.
(5) Strategic horizon surfaced: payer / prior-auth interoperability (Da Vinci CRD/DTR/PAS, Inferno,
Drummond; clearinghouses Availity/Change/Edifecs; vendors Smile/Onyx/ZeOmega/Medplum) — context, not
current scope.

**Next: the productionization plan** — `docs/superpowers/plans/2026-07-23-webchart-live-productionization.md`
(Phase 1 `_count`/`/Patient` capability fallback → Phase 2 live teatea CLI proof → Phase 3 live-tenant
real-server verification → Phase 4 a **separate** deployed staging env wired to teatea; the demo stack
stays seam-off throughout, CI never touches teatea).

## 2026-07-22 (evening) — removed the admin demo credential from the production login

Demo-prep finding: the **public production** login page (`twh.os.mieweb.org/login`) displayed
`admin@workwell.dev` with a one-click **"Fill demo credentials"** button. The demo password is
documented publicly in the README, so that was a one-click login to the production **admin** account
for anyone on the internet.

Cause: only the field *prefill* (`useState(demoMode ? DEMO_EMAIL : "")`) was gated behind demo mode;
the "Fill demo credentials" button and the "Demo: …" hint rendered **unconditionally**, so they
leaked into the production build (which is built with `NEXT_PUBLIC_DEMO_MODE` off — setting it `true`
fails the prod build). Gated both behind `demoMode`. Production now shows a clean sign-in:
email/password + the read-only public-sandbox link — which is safe to keep, since the sandbox signs
in as `viewer@workwell.dev` = **ROLE_VIEWER** (verified read-only: reads 200, every write 403, admin
403). The demo-fill convenience remains on local demo-mode builds.

Not a bug (confirmed while investigating): the sandbox itself works — it failed in a screenshot only
because the backend was in an auth-*disabled* state at that instant (login 503 → the frontend renders
a generic "Invalid email or password"); with auth enabled the viewer login returns 200. And the
hardcoded accounts are by design (CLAUDE.md: accounts are hardcoded, no SSO) — the issue was
*advertising* the admin one on a public page, not its existence.

Regression guard: with demo mode off the login page must render neither the button, the admin
address, nor the "Demo:" hint (the sandbox link stays); a complementary test asserts they DO render
with demo mode on. The test forces `NEXT_PUBLIC_DEMO_MODE` off and re-imports a fresh module so it
passes even when the suite runs under the supported local `NEXT_PUBLIC_DEMO_MODE=true` config (Codex
P2). Frontend build compiles clean; 180 frontend tests pass. PR #326.

## 2026-07-22 (evening) — made the live WebChart roster demoable in the UI (real chips, not N/A)

Demo-prep finding: with the WebChart shim seam configured, a population run correctly fetched and
CQL-evaluated the 56 dev-DB patients (the shim's own `/compliance` API proves real outcomes), but
`/compliance` (System = WebChart) rendered **every cell grey NOT_APPLICABLE**. Cause: the demo
`All Employees` segment derives its site list from the static directory (twh/ihn sites only), and the
live tenant places every subject at the fixed site `WebChart`, added at *runtime* — so the boot-time
seed never covered it and the applicability overlay greyed out all 56.

**Fix:** export `WEBCHART_LIVE_SITE` from `live-directory.ts` and fold it into the baseline seed's
site list. On any **fresh** DB (a local demo, a new instance) WebChart subjects are now applicable and
the roster shows their real per-measure chips (OVERDUE / MISSING_DATA / COMPLIANT) with no manual
admin step. Byte-identical when the seam is off (no subject carries that site) and irrelevant on the
live Neon stack (seam off). An **already-seeded** DB keeps its old baseline — seeding is
name-idempotent and never auto-mutates an operator's segment — so the owner-gated `/admin → Groups`
repair (add site `WebChart`, audited `SEGMENT_UPDATED`) still applies there.

**Display applicability ≠ case eligibility (Codex P2).** Making wc subjects applicable also flowed
into `finishManualRun`'s case-creation gate, which reuses the same `isApplicable`. That would have
opened cases for noncompliant `wc|` outcomes — but rerun-to-verify returns a non-mutating 409 for
`wc|` subjects, so those cases would be un-closeable, and it contradicts the documented "no live cases
by default." (That behavior had been an accidental side-effect of the NOT_APPLICABLE overlay, never an
explicit guard.) Added an explicit guard in the run pipeline: a `wc|` subject is display-applicable
but never opens a case; the outcome is still persisted (CQL stays authoritative, ADR-008). A
regression test proves a noncompliant wc subject with zero segments persists its outcome but creates
no case.

Verified end-to-end against the shim: fresh boot → `ALL_PROGRAMS` run → 56 `wc|` rows with real
statuses, hierarchy reconciling **All Systems = 206 = twh 100 + ihn 50 + wc 56**. Suite: 1,342 tests,
0 failures. Docs: MEASURES.md (baseline covers the live site; the manual repair is now scoped to
already-seeded DBs) and DEMO_2026-07-23.md (machine-prep hardened — start clean, pre-warm blocks the
local host ~2–3 min so do it before the call and last, select the Wellness panel, never trigger a run
live). PR #325.

## 2026-07-22 — LIVE OUTAGE: Neon compute quota exhausted by idle scheduler polling

**The live stack had been down for four days and nothing told us.** Every DB-backed page on
`twh.os.mieweb.org` (`/programs`, `/compliance`, `/cases`, `/measures`, `/runs`) rendered
`{"error":"internal_error"}`. `/api/tenants` still worked, which was the tell — it is the one
route that touches no database.

**Root cause — HTTP 402 from the Neon pooler:** *"Your account or project has exceeded the compute
time quota."* Not a code bug in any of the failing routes; the compute simply refused to start, so
every query failed and the worker surfaced its generic 500.

**Why the quota burned.** `schedulerTick` ran every 5 minutes and, *before* it ever checked whether
the scheduler was enabled or due, executed `ensureSegmentSeed` → `getStores` → `engineForEnv` →
`listSegments` → `getLastRunByTriggeredBy` — 4–5 DB round trips, ~1,300 queries/day, to evaluate a
**23.5-hour** debounce. Neon suspends after ~5 minutes idle; the tick period was also 5 minutes, so
the compute was re-woken at exactly the moment it would have slept. **It never suspended and billed
24/7.** The `schedulerEnabled` check living inside `runTick` rather than at the top of
`schedulerTick` meant an opted-*out* deployment paid the same cost.

The arithmetic matches the outage date precisely: 0.25 CU × 24 h = **6 CU-hours/day**, against the
Free plan's **100 CU-hours/project/month**, starting 2026-07-01 ⇒ exhausted on **day ~17 = 07-18**.
`compute_last_active_at` is 2026-07-18T04:34Z. Idle polling consumed the entire monthly allowance
with zero user traffic.

**Fix (PRs #322 + #323, both merged + deployed).** A DB-free due gate, `shouldSkipTickWithoutDb()`, is now the first statement
in `schedulerTick`. It returns early when the scheduler is disabled, or when an in-memory
`nextDueAtMs` says the next run is still hours away — so a tick that cannot fire costs **zero**
database round trips and never wakes a suspended compute. The cache is deliberately **not**
persisted: `null` means "consult the DB", so a restart re-derives cadence from the persisted
scheduler runs and **#268 durability is untouched**. `setSchedulerEnabled` invalidates it so the
admin toggle still takes effect promptly. Tick period widened 5 → 15 min as defence in depth (it
must stay above the DB's idle-suspend timeout).

**Cost and concurrency are two gates, not one** (both corrected in review — Codex P1 + P2 on the
follow-up PR; the first cut conflated them):

- **`nextDueAtMs` — the cost gate.** Booked only *after* `planManualRun` has persisted the run. The
  first cut booked it as soon as the tick decided to fire, i.e. before `appendAudit`/`planManualRun`
  had written anything. A transient DB error there would leave the gate booked 23.5 h ahead while
  `schedulerTick`'s `catch` swallowed the exception — **silently losing a day's recompute with no run
  to show for it**, and doing so precisely when the database is flaky, which is the condition the
  guardrail exists to survive. The cache summarises durable state, so it may never run ahead of it.
  `schedulerTick`'s `catch` also clears it, so any failure returns the scheduler to "ask the DB".
- **`tickInFlight` — the concurrency gate.** The cost gate cannot bound overlap: if a tick stalls
  inside its writes for longer than the timer period (the Postgres pool sets no query timeout, so a
  hung DB does exactly that), the next callback finds the gate unbooked and proceeds — and both ticks
  may already have read "no prior run", so both create an ALL_PROGRAMS run when the DB recovers. A
  separate single-flight flag spans the cadence read *and* the writes, released in `finally`. It
  bounds overlap **within a process** only; the cross-process claim still needs the owner-gated DB
  mutex documented at the debounce (Fable M9).

Net: ~1,300 DB round trips/day → **~1–2**. Idle compute ~182 CU-hours/month → **~0**. All six
pre-existing scheduler tests (cadence, restart durability, missed-cycle backfill, audit invariant)
still pass unchanged; five new tests pin the guardrail. Suite: **1,336 tests, 0 failures.**

**Two process gaps this exposed, both worth more than the bug:**
1. **The self-heal reconciler reported `success` every 15 minutes throughout.** It probes
   `/actuator/health`, which is DB-free (`worker.ts:197`) — so our only always-on monitor is
   structurally incapable of detecting a total database outage. It said green for four days.
2. **The nightly `pg_dump` failed five nights running (07-18 → 07-22) and nobody looked.** That was
   the one true signal. Last good dump: **2026-07-17**.

Gap 2 is now closed: `backup-neon-nightly.yml` raises a **GitHub issue** on failure (commenting on
the existing one rather than piling up a duplicate per night) and **closes it automatically** on
recovery. It reuses the DB connection that job already makes daily, so it costs no extra compute —
a dedicated deep-health-check workflow was considered and rejected on that basis. Gap 1 is left
deliberately open: adding a DB query to the 15-minute reconciler would rebuild the exact
compute-pinning loop this incident was caused by.

The 07-21 E2E sweep passed because it ran against local stacks, not the live one — a green sweep and
a dead production site coexisted comfortably.

**Data was never at risk:** 258 MB still resident in Neon (branch auto-archived 07-19, restores on
access) plus the 07-17 S3 dump.

**Resolution (same day).** Upgraded to **Neon Launch** (pay-as-you-go, no monthly minimum,
$0.106/CU-hour) with a spending limit — this forced the long-pending plan decision. The archived
branch restored on first access with **everything intact**: 180 runs, 126,692 outcomes, 629 cases,
hierarchy reconciling at All Systems = 72,100. All previously-500 routes verified 200. Autoscaling
was capped back to **2 CU** (Launch had silently raised the ceiling 2 → 8) and the nightly backup
re-run green, closing the 5-day gap.

**Three review findings, all real, all fixed** (Codex on #322/#323 — worth recording because each
was a *different* failure mode introduced by the fix for the previous one):
1. **P1** — the due cooldown was booked before the run was persisted, so a transient DB error would
   silently lose a day's recompute. Now booked after `planManualRun`.
2. **P2** — that fix opened a concurrency window: a stalled tick let the next one through and both
   could create a run. Cost and concurrency are two gates; added `tickInFlight`.
3. **P1** — the new backup alerting called `gh` in a workflow with no `actions/checkout`, so it
   would have failed with *"not a git repository"* on every real failure — an alerting step that
   never alerts. Fixed with `GH_REPO`; verified by reproducing the no-git-context condition.

**Still open (owner):** raise history retention 6 h → 7 days (≈$0.02/month at the current 4 MB per
6 h of history, billed $0.20/GB-month) to close #270's PITR gap.

## 2026-07-21 (afternoon) — closed the sweep's two code findings + #295 VSAC release pinning

Post-demo-prep work, four branches, none of it on the Thursday demo path.

**Upstream: fqm-execution#371 acknowledged.** Chris (hossenlopp) confirmed the date-only
`measurementPeriodEnd` bug we filed on 07-15 — *"All uses of fqm-execution manually pass in the
measurement period, hence why this was overlooked"* — labelled it `bug` and backlogged it. We
replied offering the PR with a proposed scope (normalize the date-only end where the period is
resolved so it covers both the caller path and the `Measure.effectivePeriod.end` default; leave
`measurementPeriodStart` alone; three tests) and the evidence we can validate against — our MADiE
harness goes 119/121 → 121/121 with the normalization. Awaiting their answer; our own workaround
(`literal-diff.ts`, `official-cases.ts`) stays until it lands. Tracked on #297.

**The Playwright sweep is now in the repo** (`test/e2e-ui-sweep-suite`). The 07-21 E2E pass ran a
maintained UI suite and recorded it green, but only `golden-path.spec.ts` was ever tracked — the
seven sweep specs lived untracked on the machine, so a fresh clone could not reproduce the
verification. Committed with their shared helper; `npx playwright test --list` discovers 35 tests
across 8 files. (`audit-helpers.ts` was left untracked: nothing imports it and it duplicates
`helpers.ts` — orphaned scaffolding, not worth committing as dead code.)

**Both LOW findings from the adversarial sweep are fixed.**
- *Unknown `scopeType` → 400, not 501* (`fix/run-manual-unknown-scope-400`). `resolveScope`'s
  default branch conflated "a real scope this path declines" (CASE → rerun-to-verify; SITE=WebChart)
  with "not a scope at all". The body is unvalidated JSON cast to `ManualRunRequest`, so garbage
  reaches it at runtime despite the type; it now validates against `RUN_SCOPE_TYPES` up front. Both
  deliberate 501s keep their regression coverage.
- *`PUT /api/measures/:id/spec` validates its body* (`fix/measure-spec-validation`). This is a
  REPLACE endpoint — `updateMeasureSpec` rebuilds the spec from the body and coerces absent fields
  to `""`/`[]`, which is right for the Spec tab (it always posts the whole form) but meant an empty
  or unrecognized body **silently erased the measure's spec behind a 200**. The sweep did exactly
  that to the local audiogram. A pure `validateSpecUpdate` now rejects a body naming none of the
  seven spec fields, and type-checks the ones present. Replace semantics unchanged. Worth noting how
  the bug proved itself: the destructive probes in the new test broke two *unrelated* pre-existing
  tests (traceability, data-readiness) while the fix was absent — that is the blast radius, and both
  pass again.

**#295 — VSAC release pinning + version provenance + drift detection** (`feat/vsac-manifest-pinning-295`,
first four work items). `resolve-valuesets` expanded with no pin, so VSAC served *latest-active*: a
republish silently changed our expansions — and therefore the CMS122/CMS125 literal-diff results —
with nothing recorded to notice it by. Now: `--manifest`/`--expansion` (mutually exclusive) forwarded
to every `$expand`; `ValueSet.version` written to the row it used to null out, with
`expansion.identifier`/`timestamp` + the pin in the `VALUE_SETS_RESOLVED` audit payload;
`expansion_hash` upgraded to SHA-256 over the members *and* the version provenance; and a re-import
whose hash differs writes a distinct **`VALUE_SET_EXPANSION_CHANGED`** event. Two deliberate calls:
**no default manifest** — the right one tracks the measure year being evaluated (v14 = 2026), an
owner/standards decision rather than something to guess, so an unpinned run warns instead; and drift
comparison is **algorithm-scoped** — writing the doc surfaced that comparing the new `sha256:` hash
against legacy `h<hex>` rows would flag drift on *every* pre-existing row at first import, a false
alarm that teaches operators to ignore the signal, so the two are never compared. No DDL, no new
store method (drift reads the catalog once via `listAll`). Descriptive only (ADR-008/ADR-023) — the
audiogram cross-mode parity guard still passes.

Still open on #295: the design call reconciling runtime live-expansion against imported rows, and
verifying the exact eCQM manifest canonical before the next live import.

Deferred deliberately until after Thursday: security response headers (a global response-surface
change plus a CSP two days before a demo is a bad trade) and #296, the `cqframework/cql-tests`
conformance harness — the biggest item on the list and the likeliest source of the next upstream
finding, but multi-day.

**Codex review round on all four PRs (#318–#321), every finding addressed before merge.** Two were
real correctness holes, not nits: (1) the spec guard triggered on *any* of seven "spec fields", but
`oshaReferenceId` is audit-only (not persisted), so `{ oshaReferenceId }` alone still passed and
blanked the spec — the presence check now requires a *persisted* field. (2) The VSAC drift hash
included `expansion.identifier`, which FHIR R4 does not require stable across identical expansions, so
a fresh identifier fired a false `VALUE_SET_EXPANSION_CHANGED`; and the ERROR path nulled the
`expansion_hash`, destroying the drift baseline across a transient failure — both fixed (hash is
members + `ValueSet.version` only; an ERROR carries the last-good hash forward), with the
success→failure→changed-success sequence now tested. The three e2e P2s (clear demo-prefilled creds
before the empty-input assertion; deep-link the run by `?runId=` so history can't hide it; skip the
direct-API-probe tests when the backend is unreachable rather than throwing) were test-robustness and
were taken. The journal P1s are this reconciliation — the morning findings line above is marked
superseded.

## 2026-07-21 — full E2E test pass; fixed a self-contradicting parity band-coverage assertion

Ran a comprehensive end-to-end pass over the merged wave (local full stack: backend :8080,
frontend :3000, dev-wcdb :33306, shim :8085) — regression floor (backend `pnpm test` + shim tests,
both green), two independent adversarial API/RBAC/security sweeps, a Playwright UI sweep, and the
full demo loop live (shim FHIR contract, `generate:sql` freshness, `/compliance` per-patient +
cohort, the ADR-025 parity gate, and the 56→60→56 ingest write loop with all four designed verdicts
exact and manifest-exact rollback).

**One real, demo-relevant bug found and fixed** (`wcdb-sql-parity-live.test.ts`): the DUE_SOON
non-vacuity assertion (added in the gpt-5.6 sweep) was **self-contradicting**. Its own notice tells
you to `npm run ingest` and re-run the suite for DUE_SOON coverage — but the assertion evaluated at
`PARITY_DATE = 2024-06-01`, while the ingest fixtures (`patients.example.yaml`) are authored as-of
**2026-07-23** (Marcus's DUE_SOON BP obs is dated 2025-08-08 — *in the future* at the 2024 seed
date ⇒ MISSING_DATA there). So ingest-then-re-run went **red** on band coverage even though SQL==CQL
parity was perfect. Fix: the seed's three reachable bands (COMPLIANT/OVERDUE/MISSING_DATA) stay
asserted at `PARITY_DATE`; DUE_SOON moved to a new **INGEST-FIXTURE PARITY** test that runs only
when the fixtures are present (population > seed) and self-skips with a notice on the bare seed. That
new test evaluates at a `FIXTURE_DATE = 2026-07-23` constant and asserts **per-patient SQL==CQL AND
DUE_SOON present** — so it now hardens the demo's exact claim ("ingest 4, and CQL and SQL agree —
Zainab COMPLIANT, Marcus DUE_SOON, Priya OVERDUE, Omar MISSING_DATA"). Verified both ways: bare seed
(56) → 4/4 with test 4 self-skipping; post-ingest (60) → 4/4 proving the claim; typecheck clean.

**Adversarial sweeps: DEMO-SAFE.** RBAC matrix matches `authorize.ts` exactly on every surface ×
role (no gate bypass), unauth → 401 everywhere, invalid/refresh-as-access tokens → 401, refresh
rotation + reuse-detection work, CORS rejects foreign origins, no secrets in the client bundle, the
shim gate is correctly two-tier fail-closed (404 no-SQL / 409 has-SQL-uncertified), and every
malformed-input probe returned 400/404 with no 500 and no stack trace. Only LOW/INFO items (tracked
for post-demo, not blocking): `PUT /api/measures/:id/spec` accepts an unvalidated body (silently
blanks spec fields — a probe dirtied the local audiogram spec, restored by an in-memory-store
restart); `POST /api/runs/manual` returns 501 (not 400) for an unknown scope; no security response
headers (`X-Content-Type-Options`/`X-Frame-Options`/CSP). **[Superseded — the first two shipped the
same afternoon (PRs #319, #320; see the entry above); only the security-headers item remains open.]**

## 2026-07-20 (night) — Codex gpt-5.6 review sweep over the whole wave (#308–#316), all findings fixed

A second, deeper Codex pass (gpt-5.6-sol, high reasoning, one review per stacked PR against its
stack parent) surfaced **8 P1 + 14 P2 + 1 P3**; every finding was fixed at its origin branch and
cascade-merged up the stack. Highlights, by theme: **fail-closed everywhere** — the shim's
compliance endpoints now 409 any measure not on a `PARITY_CERTIFIED` allowlist (ADR-025 belt-and-
braces), and the parity suite FAILS (never skips) when its env var is set but the shim is
unreachable; **ingest hardened** — manifest-exact rollback (a natural-key collision with a real
WebChart patient can never be deleted), one transaction per run, `--dry-run`/`--rollback` mutual
exclusion, a local-`wc_*`-only target guard, an append-only `ingest-audit.log`, strict YAML value
typing, and model-catalog **type** validation (declared `data_type` per written field); **gate
depth** — the drift guard pins all four measures to their hand-written CQL band literals, the
freshness + parity suites reject orphaned SQL artifacts, non-vacuity asserts (band coverage + a
date-shift requirement) close the "passes on a corpus that can't fail" hole; **Codify corrected**
— the picked code now lands IN the created value set (`POST /api/value-sets` accepts validated
`codes[]` via the existing `setCodes`; the prefilled OID is an honest local urn, not Codify's
record key), the vendored component gains stale-response invalidation, worker-failure error
states + Retry, and the index-URL override is actually deployable (Dockerfile ARG + workflow
build-arg). Docs corrected in-PR (spec scope, seam env pair, ordering-vs-ADR-025 note; ADR-034
addendum records `yaml`/`tsx`). Everything re-verified: shim 27/27, backend typecheck + touched
suites green, frontend lint/vitest 178/178/build green, live parity 3/3 against the rebuilt
container, and the full ingest loop re-run live (56→60→56, designed verdicts exact). Resolution
comments posted on all seven PRs.

## 2026-07-20 (evening) — YAML patient ingest into WebChart + model-catalog validation (PR-8)

Doug's late WhatsApp additions ("ask ai to generate patient data in yaml → ingest → we can put
into webchart"; "look at the table named model … it describes every object and field … easier to
port") closed the loop the wave had left read-only. The shim gains `npm run ingest` (`ingest.ts` +
CLI + the `yaml` package as its second dependency): a small YAML patient schema (an AI-generated
`patients.example.yaml` ships with the generation prompt in its header), inserted into
`patients` + `observations_current` with LOINCs resolved fail-closed against `observation_codes`
(codes are never invented), idempotent by natural key, and exactly reversible via `--rollback`.
Before any write, every touched field is validated against **WebChart's own `model` schema
catalog** (`model-metadata.ts`; 685 objects / 7,630 fields in the dev seed) — Doug's
portability point made operational rather than a talking point.

**Live-verified end-to-end:** ingest → population 56→60 → the four designed outcomes band exactly
as authored (Zainab COMPLIANT, Marcus DUE_SOON@349d, Priya OVERDUE, Omar MISSING_DATA) → **CQL and
the generated SQL agree on all four** → re-run skips (idempotent) → rollback restores 56. 21 shim
tests (5 new files' worth), typecheck green. Demo script gains beat 5 ("the full loop"); the live
acceptance suites still pin the 56-patient seed, so the demo rolls back before running them.
Dev-database only; no PHI; the deployed stack is untouched.

## 2026-07-20 (later) — Codify LIVE in Studio; all Codex review findings addressed

**Codify is implemented, not just probed** (reversing the earlier same-day defer — the owner asked
for it in, and two discoveries made it safe): MIE's Codify shard index is publicly served with open
CORS at `ui.mieweb.org/codify`, and upstream's own source comments establish **consumer-side
bundling as the designed path** (the tsup npm build can't ship the module worker; "Storybook (Vite)
handles it natively" — so does Next). So `frontend/vendor/codelookup/` vendors the component
byte-faithful from `mieweb/ui` (ADR-007 datavis playbook; marked edits only re-point `cn`/Card to
stable `@mieweb/ui` and the icon re-export to `lucide-react` — **zero new deps**), wrapped by
`CodifyCodeSearch` (`next/dynamic` ssr:false) in the **Studio → Value Sets** tab: pick a code →
the value-set form prefills. **Browser-verified end-to-end**: on `/studio/cms125`, searching
Doug's exact phrase "breast cancer screening" returns **"Breast cancer screening (mammography) —
eCQM CMS125"** in ~39 ms and prefills the form. Upstream engine tests run in our vitest suite
(178 pass); lint + production build green (the module worker bundles). Standing asks on #310
narrow to: ship the npm release (then the vendor dir is deleted) + bless the index host.

**All 12 Codex PR findings addressed** (beyond the earlier code-review pass): spec text corrected
(wc-{pat_id} ids; the numerator is the CQL compliant cutoff — implementation was already right);
codegen date-guard narrowed to zero-dates-only (valid pre-1901 events band OVERDUE on both paths),
cohort SUMs COALESCE'd, and a **threshold drift-guard test** pins `WCDB_SQL_MEASURES` to the YAML
rule blocks / CQL band literals; the compliance API rejects non-calendar dates (2026-02-31 → 400);
the parity date-sensitivity test now runs **every** SQL measure at the shifted date (the claimed
4 × 56 × 2 matrix is literally what runs — re-verified green live); demo-doc fallback commands
fixed (HAPI path starts + repoints properly; the CLI line repeats its executable). Two findings
were already fixed pre-review (Dockerfile `sql/` COPY; parity-list derivation). The demo prep
block now records the two local-dev env requirements the browser dry-run surfaced
(`WORKWELL_AUTH_*` pair; `NEXT_PUBLIC_API_BASE_URL`).

## 2026-07-20 — Doug wave BUILT: shim live, CQL→SQL parity-proven, Codify probed (PRs #308–#315)

The whole wave shipped same-day as a stacked PR chain, every gate green on first live runs:

**Shim (#311).** `wcdb-fhir-shim/` — plain `node:http` + `mysql2` (the only MariaDB-driver home,
ADR-034) serving the verified WebChart contract straight from dev-wcdb SQL. The existing
`hapi-live.test.ts` acceptance passed against it **4/4 including bucket-for-bucket parity** with
the committed-fixture evaluation; `hapi-app-live.test.ts` passed (full in-app ALL_PROGRAMS run,
56 `wc|` subjects across roster/hierarchy/quality); `evaluate:webchart-live` produced 27 real
non-MISSING_DATA outcomes (hypertension 3/0/6/47, obesity_bmi 5/0/8/43, diabetes_hba1c 0/0/4/52,
cholesterol_ldl 0/0/1/55 as-of 2024-06-01). Compose profile `wcdb` (shim :8085, db :33306);
default stack untouched. One real-HTTP lesson: node's 5s keepAliveTimeout races undici's pooled
sockets (mid-suite ECONNRESET) — raised to 65s.

**CQL→SQL (#312, #313, #314 — #292 activated).** `generateSql` beside `generateCql` (pure
templating; the new `loincCodesForMeasure` crosswalk export is the shared code list), committed
artifacts in `wcdb-fhir-shim/sql/` (freshness-tested), `pnpm generate:sql` as the live demo
moment; the shim's compliance API (`/compliance/{patientId}/{measureId}` + cohort) executes them
with bound params only. **The ADR-025 golden-parity gate is GREEN: 4 measures × 56 patients × 2
evaluation dates, zero SQL-vs-CQL divergence** (`wcdb-sql-parity-live.test.ts`, self-skipping on
`WCDB_SHIM_PARITY_BASE_URL`). Windowed-recency only by design (no WCDB immunization table ⇒
series SQL unprovable there). Note: the suspected `WORKWELL_WEBCHART_ENROLLMENT_JSON` doc drift
was a false positive (the var exists in `run-pipeline.ts`).

**Codify (#310, this PR).** CodeLookup IS published — in `@mieweb/ui@0.6.1-dev.*` prereleases
only (verified by scratch-install: `CodeLookup`/`CodifyResult`/`HealthSurveillance`; shard-index
API with `occupational`+`quality` domains and an employer `programs.json` sidecar). Decision:
document + ask (a dev-prerelease bump days before the demo is the wrong risk) —
`docs/mieweb-ui-migration/CODELOOKUP_STATUS.md` carries the probe evidence + ready integration
design (Studio Value Sets tab, admin terminology mappings); Thursday asks = a stable release with
Healthcare components + the canonical Codify `indexUrl`. Demo script for the call (+ fallbacks +
owner outreach checklist): `docs/DEMO_2026-07-23.md`.

## 2026-07-20 — Doug call: three directives; Doug-wave planned (ADR-034)

Doug's 2026-07-19 call reset the near-term
direction. Directive 1: build our **own FHIR R4 shim server** directly over the WebChart MariaDB
dev DB (dev-wcdb, 56 synthetic patients) — the layered/swappable-API contract made concrete; the
app consumes it through the existing `WORKWELL_WEBCHART_BASE_URL` seam, making the shim a drop-in
for the ADR-032 HAPI simulator. Directive 2: **CQL→SQL is un-parked** ("very valuable to me") —
generate SQL from CQL measures + the WCDB schema, run it against the WebChart database, return
numerator/denominator behind a simple compliance API; this activates #292 Phases 0–2 with the
ADR-025 parity gate intact (CQL engine over the shim's FHIR output = the golden oracle). Directive
3: adopt MIE's **Codify** terminology surface (`Healthcare/CodeLookup`) and propose WorkWell
components upstream to `@mieweb/ui`. The 07-15 D17 answer is superseded in the questions doc.

Planned as a 7-PR stacked wave targeting the Thursday 2026-07-23 call (Dave + wider group;
Nicole is the quality lead to win): docs gate (ADR-034 — standalone `wcdb-fhir-shim/` package owns
`mysql2`; backend-ts stays driver-free; SQL generation pure in backend-ts, committed artifacts,
shim executes) → shim scaffold + Patient paging → clinical endpoints (acceptance = the existing
`hapi-live.test.ts` 56-patient parity suite pointed at the shim) → `generateSql` codegen +
`pnpm generate:sql` → shim compliance API → SQL-vs-CQL parity live test → Codify spike + demo
script. Preflight done: wcdb container boots; 56 patients; LOINC coverage counted (BMI 13 /
systolic 9 / HbA1c 4 / LDL 1 distinct patients ⇒ observation-based demo measures, final set gated
at the codegen PR). Spec: `docs/superpowers/specs/2026-07-20-doug-wave-wcdb-shim-cql-sql-design.md`;
plan: `docs/superpowers/plans/2026-07-20-doug-wave.md`.

## 2026-07-17 — PR #307 review hardening: fail-closed paging and complete live identity reads

The review pass made authoritative WebChart population replacement fail closed: the in-app run now
opts into strict Patient pagination, so any later-page transport failure finalizes FAILED before an
outcome or directory swap and leaves the prior successful population authoritative. The read-only
`evaluate:webchart-live` CLI retains the transport's lenient default. Scheduled ALL_PROGRAMS runs now
receive the same runtime WebChart env/client path as manual runs, and synchronous hosts finalize live
preparation failures instead of stranding RUNNING rows.

Live employee-profile links and case-worklist name/site filters now resolve through the configured,
restart-safe directory, and roster/hierarchy tenant labels consistently include the configured host
(`WebChart (<host>)`). The risk-outlook query's `successfulPopulationOnly: true` behavior is also now an
owned correctness decision: risk outlook reads terminal successful population runs only, matching the
other population read models and avoiding unbounded per-run evidence hydration. This query-scope
alignment does not introduce a new architectural seam, so ADR-033 remains sufficient.

## 2026-07-17 — Live WebChart tenant run pipeline and restart-safe read models (PR 6a + 6b)

Completed the two-part live-tenant implementation behind the existing inert WebChart seam. PR 6a keeps
planning network-free, loads configured populations in background execution, refreshes one per-worker
identity directory, applies the enrollment override/default policy, evaluates the normalized bundles
through the unchanged CQL engine, and exposes the conditional `wc` tenant. A population-fetch failure
writes no outcomes, finalizes FAILED with operational metadata, and cannot supersede the prior successful
population. Configured `SITE=WebChart` remains a controlled deferral.

PR 6b threads one persisted-row-derived directory snapshot through roster, programs, hierarchy, case
detail, and quality materialization. Unknown persisted `wc|` ids survive a restart with raw Patient-id
names; full names return after the next successful directory refresh. `All Systems = Σ tenants` and
all/tenant/site/provider quality scopes include live rows. `wc|` CASE rerun-to-verify now returns a
controlled 409 before run, outcome, case, or audit mutation—no stale bundle reuse and no fabricated
`MISSING_DATA`. Existing twh/ihn-only groups still exclude the `WebChart` site from case creation; the
owner can add it to All Employees at `/admin → Groups`, producing audited `SEGMENT_UPDATED`.

Focused RED/GREEN tests cover restart rehydration, full-name refresh, FAILED-run exclusion, program
site/tenant filters, hierarchy reconciliation, quality scopes, direct/route rerun immutability, and a
self-skipping HAPI app flow (dedicated test env plus two-second metadata probe). CQL remains the sole
`Outcome Status` authority. No schema/DDL, dependency, frontend behavior, secret, PHI, or clinical-cache
change was introduced (ADR-008/ADR-033).

## 2026-07-16 — teatea runbook executed live: registration is MIE-gated, seed contract verified

Ran the teatea trial runbook (`WEBCHART_TEATEA_RUNBOOK_2026-07-16.md`) end-to-end as System Owner.
Two decisive outcomes:

**§§2–3 (client registration + auth probe) are blocked on MIE — proven, not assumed.** The SMART
Backend Services client registry is the `login_trusts` table, reachable only via the **superuser**-gated
JWT / Login-Trusts screen. WebChart "superuser" is **not** the SuperUser security role and **not** the
`Manage Login Trusts` ACL — both were set and the screen still returned "Super user access required";
superuser is an MIE-issued session unlock (master password) held by MIE's internal accounts. **RFC 7591
is off** (`/register` + `/oauth/register` return the login HTML; no `registration_endpoint`), and the
Application-Entities editor is DICOM, not an OAuth registry. A second independent research pass over the
public `mieweb/docs` sources reached the same conclusion. The sharpened MIE ask (register `workwell-backend`
with our hosted JWKS, or grant superuser + the FHIR App Editor) is now recorded in the runbook §3 and the
#254 answer log. §5 (live evaluation) is blocked behind this — nothing to read until a client exists.

**§4 (synthetic seeding) contract verified live and the generator fixed.** teatea's Data Import →
Chart Data CSV "Validate File" dry-run established the real contract: **`patients.zip_code` is required**
(`12345`/`12345-6789`) on every row (the sole cause of the first run's 451 validation issues), partition
`MR` is valid, and all `patients.*` demographic columns validate. `scripts/generate-webchart-import.ts`
now emits a synthetic demo ZIP; typecheck green. The seed is ready to upload, but its payoff — a live FHIR
read-back — still waits on the registration above, so the actual upload + `pnpm evaluate:webchart-live`
run are deferred until MIE unblocks auth (no point seeding a population we can't yet read over FHIR).
Keypair (§1) generated and kept in `~\.workwell\` (never committed). Docs-only change here; no runtime,
schema, dependency, PHI, or Outcome Status behavior touched (ADR-008).

## 2026-07-16 — MIE manager outage: bounded, method-safe deploy retries

The WebChart stack's final deploy exposed a pre-existing failure mode in
`deploy-mieweb-container.sh`: when `manager.os.mieweb.org:443` was unreachable, the first
`GET /sites` inherited curl's long platform timeout and then failed permanently, even though safe
reads can be retried. The request boundary now applies 10-second connect/30-second overall limits
and retries transient **GET** transport failures six times with bounded backoff.
State-changing POST/DELETE calls remain single-attempt because retrying a lost response could
duplicate or mis-handle an already-applied operation. A no-network shell regression test runs in
CI. This changes deployment tooling only: no runtime, dependency, schema, PHI, or Outcome Status
behavior.

## 2026-07-16 — WebChart live-integration six-PR prerequisite stack merged

Merged the six-PR follow-through stack bottom-up: Doug's confirmed contract and trial findings
(#298), the idempotent HAPI FHIR simulator loader and ADR-032 (#299), the real-HTTP live CLI with
HAPI bucket-for-bucket parity (#300), the owner-only teatea runbook and supporting probe/import
tooling (#301), the schema-free live `wc` tenant design (#302), and the MIE product/assumption
register (#303). The stack adds no runtime behavior to the deployed demo unless the WebChart seam
is explicitly configured; CQL remains the sole Outcome Status authority and no schema or
dependency changes were introduced. Two gates remain open: **owner sign-off on the #302 design
before PR 6 may be implemented**, and **owner execution of the teatea runbook before live trial
observations may be recorded**.

## 2026-07-16 — MIE product research + the #254 assumption register (self-sufficiency doc)

`docs/MIE_PRODUCT_RESEARCH_2026-07-16.md` executes Doug's "know our products, stop waiting on us"
directive. §1 maps the landscape (WebChart = the ONC-certified platform EHR; **Enterprise Health =
the occupational-health EHR built ON it** — surveillance programs, immunizations, OSHA
recordkeeping, case management; NoMoreClipboard = the PHR line; BlueHive = a third-party network,
not MIE). §2 fixes WorkWell's position in one sentence: **the standards-based CQL/eCQM layer over
EH-shaped data** — WorkWell complements EH's native panel due/decertification logic by pulling data
over FHIR and computing portable standards-based compliance (authorable CQL measures,
evidence-carrying outcomes, audit-first case workflow, eCQM exports), with a module-level
EH↔WorkWell seam mapping. §3 is the register: every still-open #254 item now carries a working
assumption + falsifier + the live surface that verifies it (A2/A5 land automatically when the
teatea runbook runs; B9's WorkWell-side roster is promoted to *the working design*; C14/C15/C16
stay flagged as genuinely MIE-gated production questions, not trial blockers). A8 requires a real
coded FHIR Condition for cms122, and B11 keeps MRNs system-local until a shared authority is proven.
§4 names the
deployability shape: the whole live integration is env-var configuration on one seam — *configure,
don't build* — with the PHI environment split still the production gate. Cross-linked from the
#254 Answer log so that doc stays the single index.

## 2026-07-16 — teatea runbook: auth probe + import-file generator (owner steps packaged)

Everything the owner needs to bring the teatea trial live, in one PR. **Runbook**
(`docs/WEBCHART_TEATEA_RUNBOOK_2026-07-16.md`): RS384 keypair generation (Node one-liner, keys stay
in `~\.workwell\`, never the repo), client registration at the admin JWT screen
(`webchart.cgi?f=admin&s=jwt` — the smart-configuration's `management_endpoint`), the
`client_credentials` probe, population seeding, live evaluation, and exactly what to record back
into the #254 answer log (A2 pagination / A3 grant+lifetime / A4 rate signals / A5 observation
shape). **Auth probe** (`pnpm webchart:probe-auth`): reuses `smartBackendServicesAuth` unchanged —
discovery → the RS384 `private_key_jwt` grant → an authorized `GET /fhir/Patient?_count=1` — with
targeted hints per OAuth error code (`unsupported_grant_type` ⇒ the sharpened MIE ask;
`invalid_client` ⇒ registration/JWKS mismatch). Token-response output is a non-secret whitelist
(token_type/scope/expires_in); key/assertion/token are never printed.

**Import generator** (`pnpm generate:webchart-import`): a deterministic ~30-patient synthetic
cohort emitted in MIE's own documented Data-Migration CSV formats — verified from the `mieweb/docs`
repo sources (the rendered docs 403 automated fetches; the markdown sources + published spec sheets
don't): Chart Data CSV (demographics, `@patient_mrns.MR` creates charts), Clinical Encounter CSV
(office visits — the eCQM qualifying-visit gate), Observation Import (18 fixed columns, `YYYYMMDD`,
**keyed on observation name not LOINC** — the runbook's spot-check verifies the FHIR read-back
carries the intended LOINC via the instance compendium), and Injections CSV (CVX codes, the
verified 18-column header). Five repeating clinical profiles guarantee every outcome bucket;
mammograms ride the manual checklist (WebChart has no procedure CSV — completed CPT 77067 orders).
Mammogram eligibility uses date-exact age at the requested `--as-of`, including the 42/74 boundary
birthdays, so pinned generation remains deterministic and aligned with the CQL age gate.
Smoke-run: 30 patients → 24 visits, 102 observations, 78 immunizations, 7 mammograms. Three
flagged format caveats (exact `patients.sex` header, `part:MR` id-type, name→LOINC mapping) are
first-small-upload checks, not blockers. No new deps; no schema; descriptive only (ADR-008).
Owner steps: execute the runbook §§1–5, record results.

## 2026-07-16 — `evaluate:webchart-live`: the transport's first real-HTTP proof (bucket-for-bucket parity)

The live-evaluate CLI closes the gap ADR-028 left open: `httpWebChartClient` had only ever run
against in-process shims. New `live-cli.ts` (`pnpm evaluate:webchart-live`) drives the unchanged
roster+crosswalk+engine pipeline over real HTTP — `--list-patients` emits a roster-template JSON on
stdout (human table on stderr, so `> roster.json` yields a valid file), `--roster/--date/--measures`
evaluate (one population fetch reused across measures), `--page-size` forces genuine multi-page
`link[next]` pagination, and an unconfigured seam **fails fast** rather than silently falling back
to the JSON source. Two pure extractions, both covered by existing tests: the fixed-width table +
date validation into `report-table.ts` (devdb output byte-identical), and `webChartConfigFromEnv`
out of `resolveDataSource` (behavior-preserving; the CLI needs it to construct the client with
options).

**Verified live against the loaded HAPI simulator: the parity headline holds.** At `--page-size 10`
(6 real pages) the per-measure bucket counts are **deep-equal to the committed-fixture path** — 56
patients, 31 real non-MISSING_DATA outcomes, identical table to `evaluate:webchart-devdb --date
2024-06-01`. HTTP in, identical outcomes out: server-minted pagination, the off-origin guard,
per-resource `?patient=` composition, and the Authorization header all exercised for real. New
`hapi-live.test.ts` pins that as a 4-test live suite gated on the **dedicated**
`WORKWELL_WEBCHART_LIVE_TEST_BASE_URL` + a 2s reachability probe (the ice-live pattern; verified to
self-skip when unset), plus 10 CI tests for the CLI (`live-cli.test.ts`: parsing, config/roster
fail-fast gates, fixture-client e2e, and a per-patient evaluation failure that exits 1 rather than
reporting a reduced successful population). No new deps; no schema; read-only + descriptive
(ADR-008). Next: the teatea runbook + auth probe + import generator (wave PR 4).

## 2026-07-16 — HAPI "fake WebChart" loader (ADR-032): dev-DB fixtures → local FHIR R4 server

Wired the previously-unused `hapi-fhir` compose service into the workflow as the local WebChart
simulator Doug suggested. New pure transform `hapi-transform.ts` (CI-tested, 8 tests) converts each
committed dev-DB fixture *collection* Bundle into a *transaction* Bundle of `PUT {type}/{id}`
entries: patient ids (`wc-5`) preserved because the enrollment roster keys on them (a POST's
server-assigned id would silently break stamping into all-MISSING_DATA), and id-less clinical
resources get deterministic minted ids (`{patientId}-{type}-{ordinal}`) so re-loads update in place
instead of duplicating (a duplicate Immunization would double-count doses). New thin CLI
`pnpm load:hapi` (`scripts/load-hapi-fixtures.ts`) POSTs the transactions and fails loudly on any
non-2xx entry.

Live-verified end-to-end: `docker compose up -d hapi-fhir` → first `pnpm load:hapi` = **56
patients, 293 resources, 293 created**; second run = **293 updated, 0 created** (idempotent, no
growth); `GET /fhir/Patient?_summary=count` → 56; `GET /fhir/Observation?patient=wc-5` → 2. Docs:
ADR-032 (division of labor: HAPI = local real-HTTP + rich-data proof, teatea = real-contract auth
proof), WEBCHART_FHIR_MAPPING §8.3. No new deps (global fetch); no schema; descriptive only
(ADR-008). Next: the live-HTTP evaluate CLI + self-skipping HAPI parity test (wave PR 3).

## 2026-07-16 — Doug meeting recorded: #254 delivered, M2 unblocked, WebChart live-integration wave planned

The 2026-07-15 Doug meeting answered the #254 package's load-bearing questions and this entry
records them (details inline in `docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` + its Answer log):
**A1 confirmed** — the FHIR R4 API is the integration surface; **A3 confirmed** — auth is SMART
(Backend Services; exactly the ADR-028 contract the transport already implements); **D17 answered**
— data flows WebChart→WorkWell and CQL runs on our side (CQL→SQL is parked; the #292 Option B
triggers stay dormant); **C13 answered** — we now hold a WebChartNow **trial instance**,
`teatea.webchartnow.com`, with the System Owner role. Doug also suggested standing up a **HAPI FHIR
server as a local WebChart simulator** over the dev-DB data (the official `hapiproject/hapi` image
already sits unwired in `infra/docker-compose.yml`; the `jamesagnew/hapi-fhir` repo he pointed at
was verified to be a stale personal fork of upstream HAPI, no MIE code), and directed us to be
self-sufficient on the rest: the un-discussed items (A2 pagination, A4–A8, B9–B12, C14–C16) move to
a documented assumption register with live verification where observable, rather than re-blocking
on MIE.

Live probe of the trial (2026-07-16, unauthenticated, both 200): the FHIR base
`/webchart.cgi/fhir/` serves an R4 4.0.1 CapabilityStatement (35 resources, US Core + Bulk Data
IG), and `.well-known/smart-configuration` advertises `private_key_jwt` + **RS384 only**, scopes
`patient/*.rs` + `system/*.read` (so the runbook sets `WORKWELL_WEBCHART_SCOPE=system/*.read`
against our `system/*.rs` default), and `grant_types_supported: ["authorization_code"]` only —
whether a registered backend client can use `client_credentials` is the wave's key live test. The
big operational discovery: **client registration is self-serviceable** — the
`management_endpoint` is the WebChart admin JWT screen (`webchart.cgi?f=admin&s=jwt`), where a
System Owner uploads a public JWK and grants scopes. No waiting on MIE for trial credentials.

Wave plan (approved; summarized in the stacked PR descriptions): this docs PR → HAPI fixture
loader → `pnpm evaluate:webchart-live` CLI + self-skipping HAPI parity test → teatea runbook (keys,
registration, auth probe, and a **realistic ~30-patient import generated from the synthetic
corpus** through WebChart's import tooling) → a **live WebChart tenant** spec + implementation
(behind the E1/ADR-005 `EmployeeDirectory`/`PatientDataProvider` ports, inert-unless-configured) so
the app's own dashboards visualize live WebChart-derived compliance → the MIE product research doc
(Enterprise Health ↔ WorkWell mapping + assumption register). Docs-only today: questions doc,
CLAUDE.md focus block, this entry. The "send #254" owner step is retired — delivered and discussed.

## 2026-07-15 — Connectathon D1+D2 MeasureReport conformance fixes (ADR-031)

Corrected the two verified export-only defects from
`HL7 Connectathon/RESEARCH_FINDINGS_2026-07-15.md` §3 and added the cheap base-R4 metadata. Population
elements now report membership-label counts: DENOM includes DENEX, while FHIR/QRDA scores use
`NUMER / (DENOM - DENEX)` with a non-positive guard. Individual `EXCLUDED` membership is therefore
IPP=1/DENOM=1/DENEX=1, and individual populations continue to sum exactly to the summary.

The YAML-generated measure binding now owns two export semantics. All 14 runnable measures explicitly
declare `improvementNotation: increase`; `missingDataMeansOutOfPopulation: true` is set only on
`cms122` and `cms125`, whose authored CQL emits `MISSING_DATA` for `not Initial Population`. That status
maps to all-zero populations for those two measures in the per-row, bounded histogram, and individual
paths; OSHA/HEDIS-style missing-data membership is unchanged. A guard test couples the compliance-
oriented numerator (including inverted CMS122) to the `urn:workwell:measure:*` canonical and forbids an
accidental official-CMS claim without reorientation.

MeasureReports now carry UUID ids, a request-scoped report-generation date, and a contained static
Organization reporter (`WorkWell Measure Studio`); collection Bundle entries carry matching
`urn:uuid:*` `fullUrl`s. The route accepts an injected generation timestamp so timestamp assertions are
deterministic and every report within a bundle shares one value; the run's measurement timeframe remains
in `period`. No DEQM profile is claimed. This remains a base-R4, structurally conformant export; the adopted DENOM
interpretation follows the unambiguous worked arithmetic on ballot branch `br-57509` and is documented
as a clarification that is not yet published normative QM IG text.

Review follow-up also aligned the external-interface architecture entry with ADR-031 and documented the
intentional quality-snapshot divergence: snapshots keep their internal effective denominator
`total − excluded` and retain `MISSING_DATA` for every measure. Accepted export limitation: pipeline
evaluation failures are persisted as `MISSING_DATA` with `evidence_json.evaluationError`, so CMS122/125
FHIR/QRDA exports currently cannot distinguish such a failure from verified not-in-IPP and omit both
from IPP/DENOM; evidence-aware differentiation is a future refinement.

No dependency, schema, CQL, stored-outcome, or compliance-decision change (ADR-008). Verification:
typecheck clean; focused MeasureReport builders 8/8 plus the route-level generation-time regression 1/1;
full backend suite **1,298 total — 1,293 pass / 5 expected skip / 0 fail**.

## 2026-07-15 — Official MADiE CMS122/CMS125 offline diagnostic harness

Added an offline, no-server/no-DB/no-VSAC diagnostic CLI that runs the official 2025-AU MADiE
test cases from `cqframework/dqm-content-qicore-2025` (source revision
`ca4b49516de4cbed9f92bfb7c35d97b1bf1022ab`) through the pinned `fqm-execution` 1.8.5 literal
path. The content is fetched into ignored `backend-ts/.official-content/` by a Windows-long-path-safe
sparse-clone script and is never committed. The CLI batches each measure's patient bundles into one
calculator call, reads the expected MeasureReport period and embedded expanded ValueSets, normalizes
a date-only period end to inclusive end-of-day before Calculator execution, compares the
four raw population memberships, and writes the full 121-case Markdown report only for the default
two-measure run.

- **Official results.** CMS122 matched all 55/55 committed MeasureReports. For the six UUIDs called
  out as bad expecteds by the source repository, `fqm-execution` returned numerator 0, matching the
  committed expected files; it did not reproduce that repository's separately reported numerator 1.
  Those six remain an open JS-vs-Java question pending reconciliation of the January discrepancy
  report with the reportedly clean regenerated 2026-07-14 report. CMS125 matched **66/66** after the
  primary harness normalized the official date-only end to `2026-12-31T23:59:59.999Z`; combined
  agreement is **121/121** with no loader/calculation errors.
- **Inclusive-day finding applied to both diagnostic surfaces.** `fqm-execution` 1.8.5 parses a
  date-only period end as start-of-day; the un-normalized CMS125 run scored 64/66 because two
  qualifying mastectomies occur at `2026-12-31T23:59:59Z`. The live
  `/api/measures/cms122/fidelity/diff` literal tier passed the same date-only Dec 31 value and could
  silently truncate that day; it now passes end-of-day while retaining the correct date-only Jan 1
  start. The relevant ValueSets are complete, and the capped Advanced Illness expansion is unrelated.
- **Draft drift check.** The vendored CMS122 v0.5.000 draft, evaluated with the official bundle's
  ValueSets, changed 0/55 population vectors versus official v1.0.000.
- **Isolation preserved.** `fqm-execution` remains diagnostic-only. Its exact import allowlist now
  contains `standards/literal-diff.ts` and `standards/official-cases.ts`; the architecture test still
  rejects imports from the run pipeline, engine ingress, and `worker.ts`. No dependency, schema, or
  worker change was made; the only live diagnostic-path change is the corrected literal period end.

Verification: `corepack pnpm typecheck` clean; focused harness/CLI/literal tests 17/17; full backend
suite 1,294 tests (1,289 pass, 5 skip, 0 fail). The primary official command exited 0 with CMS122
55/55 and CMS125 66/66, generated exactly 121 case rows and one normalization caveat, and retained
the 0/55 draft drift result. A real `--measure cms122` run left the committed report SHA-256 unchanged.

## 2026-07-14 — Pre-meeting closeout: durable evidence bucket LIVE (#167/ADR-030), nightly DB backups (#270), DR drill executed, Neon plan-cap finding, tracking + doc-drift cleanup

Everything owner-actionable without MIE, closed out the day before the Doug meeting. The one
remaining owner step is unchanged: **send #254.**

- **#167 CLOSED — evidence is durable (ADR-030).** Provisioned `workwell-twh-evidence` (AWS
  us-east-1: public-access-blocked, versioning on, 30-day lifecycle on `db-dumps/`; least-privilege
  IAM user `workwell-twh-app` — List/Get/Put/DeleteObject on this bucket only, policy smoke-tested
  incl. cross-bucket deny). The documented "point the BUCKET binding at the s3 driver" recipe turned
  out **unreachable**: the `@mieweb/cloud` config loader parses `mieweb.jsonc` bindings as literal
  JSON (no env substitution), so a committed binding can't carry credentials. The durable backend is
  instead selected **at app level** — `resolveBucket(env)` (`backend-ts/src/case/resolve-bucket.ts`),
  mirroring the `DATABASE_URL` store override: ALL THREE of `WORKWELL_BUCKET_S3_BUCKET` +
  `_ACCESS_KEY_ID` + `_SECRET_ACCESS_KEY` set ⇒ `createS3Bucket` (`@mieweb/cloud-os`, the same
  adapter the mieweb target uses; `createIfMissing:false` — the app's IAM deliberately cannot create
  infra); unset ⇒ the injected fs binding, byte-identical. Memoized per worker (failed construction
  not sticky). The **9th inventory seam** (`bucket-s3`, #260 pattern — predicate-reusing, boot-line
  visible). **`@aws-sdk/client-s3` is an approved dependency add** — it is `@mieweb/cloud-os`'s own
  declared optionalDependency for exactly this adapter, promoted to a direct dep so the s3 path works
  on the `local` target the live container runs. Secrets `WORKWELL_BUCKET_S3_*_TWH` mapped in
  `deploy-twh-mieweb.yml` **and** the keep-in-sync `reconcile-twh-mieweb.yml`.
- **#270 second line of defence LIVE + the drill executed + a plan-cap finding.** New
  `backup-neon-nightly.yml` (03:17 UTC): `pg_dump --schema=workwell_spike -Fc` over the **direct**
  (de-`-pooler`ed) Neon connection → `s3://workwell-twh-evidence/db-dumps/` (30-day lifecycle).
  Attempting the runbook's other two §2 decisions live surfaced the real constraint: the Neon API
  rejects both `history_retention_seconds: 604800` (*"max: 21600"*) and protecting `production`
  (`BRANCHES_PROTECTED_LIMIT_EXCEEDED`) — **the 6-hour PITR window IS the Free plan's maximum and
  Free allows zero protected branches**, so runbook §2 items 1+3 collapse into one owner/billing
  decision: upgrade the Neon plan (Launch = 7-day restore + protected branches). The **§6 drill was
  executed** on live Neon, zero production impact: branch `drill-2026-07-14` → backend booted against
  it (schema + authed tenants/runs reads real) → 2 `terminology_mappings` rows deleted → branch
  restored to `^self@T0` (Neon requires `--preserve-under-name` for self-restore) → rows returned
  5/5, outcomes intact (118,292) → both drill branches deleted.
- **Tracking + estate cleanup.** **#268 closed** — PR #284 (merged 2026-07-11) covered the full scope
  (persisted-run-derived debounce, missed-cycle backfill, first-tick fire, audit invariant, 5 tests)
  but said `Refs` not `Closes`; same pattern as #183. The **decommissioned Vercel preview project
  was deleted** (`workwell-measure-studio.vercel.app` had still been serving the old frontend against
  the dead Fly backend — a publicly reachable broken copy; now 404; the v0 design storyboard project
  is kept, it's referenced by the archived SPIKE_PLAN).
- **Doc-drift reconciliation + stale-string cleanup.** `worker.ts`: the Phase-0 "skeleton" header,
  the 501 hint ("endpoint groups are ported in Phase 4"), and `build:"phase1-spike"` (still served
  live by `/api/version`) were all a month stale → header describes the completed strangler, the 501
  hint points at ARCHITECTURE §7 (501 contract kept stable), version/health read
  `build:"workwell-api-ts"` / no phase field. Catalog counts 60→63 (CLAUDE.md, DEPLOY.md incl. the
  pre-E10 seeding list). The three "✓ 1,680,000 outcomes live" callouts (CLAUDE.md/DEPLOY/DATA_MODEL
  §3.23) updated: the fabricated seed was rolled back 2026-07-09 for the #253 proof — **live is the
  N=5000 real-eval, All Systems = 72,100** (verified today via SQL on the drill branch).
  PRODUCTION_READINESS gap rows 3+8 updated; ARCHITECTURE §10 seam table + boot line carry
  `bucket-s3`.

Suite: typecheck clean; resolve-bucket (6) + seam-inventory (all 9 seams) + cases + worker tests
green locally; full suite on CI. Post-merge verification: live `/api/version` shows the new build
string; a `workflow_dispatch` of `backup-neon-nightly.yml` proves the first dump lands in S3.

**Remaining owner steps:** send #254 (tomorrow's meeting); decide the Neon plan upgrade; the
`eval_state` DDL (#263) and #287 Phase-2 write path remain deliberate decisions, not forgotten work.

## 2026-07-13 — Three design/ops documents: delta-eval (#263), cross-system credit (#287), backup/DR (#270)

Docs only — no code, no DDL. Each surfaced something that changes the shape of the work, which is the
point of writing them before building.

- **#263 — incremental/delta evaluation** (`docs/superpowers/specs/2026-07-13-e263-incremental-evaluation-design.md`).
  Two findings, both of which would have been expensive to discover in code. (1) **A skipped subject
  must still get an outcome ROW:** every read model is "the outcomes of the latest population run per
  measure" (`latestRunRows`), so writing rows only for re-evaluated subjects would silently drop
  unchanged employees from the roster, break the rollup's `All = Σ tenants` invariant, and collapse
  quality-snapshot denominators. Design: **skip the evaluation, copy the prior outcome forward** — write
  volume unchanged, we save the ~68 ms/eval CQL (the cost that actually matters, #253), and no read
  model needs to know the feature exists. (2) **The saving is not ~99%:** the *clock* changes for
  everyone daily even when the data doesn't, so a data-only hash would serve a stale COMPLIANT for weeks
  on any RECURRING measure. Data-invariance covers only the 3 PERMANENT measures (~21%); the mechanism
  that recovers the real saving is **status-boundary caching** (`next_transition_at`), named and put to
  the owner as an explicit decision rather than assumed. Owner-gated `eval_state` DDL proposed (§6);
  **no code until it is signed off** (the issue's own acceptance criteria).
  Two Codex findings folded in: the **Tier-1 candidate set is not just "the patients WebChart exported"**
  (the OH enrollment roster is stamped WorkWell-side, so a subject's evaluated input can change with
  *zero* WebChart resources changed — `_since` may skip the FETCH, never the HASH), and the **copied
  evidence goes stale even when the status doesn't** (date-dependent defines like `Days Since Last
  Audiogram` would show day-N arithmetic under a day-N+30 timestamp).
- **#287 — cross-system credit** (`…-e287-cross-system-credit-design.md`). Doug's *"if they are compliant
  anywhere, are they compliant everywhere"*, display-only today. **Two lenses hide behind one sentence**:
  record-scoped credit-shared (denominators unchanged) vs person-scoped dedup. Doug asked for the former,
  and **only it preserves `All = Σ tenants`**. Credit may only combine outcomes sharing
  `(measure, evaluation_period)` — a bucket is a function of the evaluation date, not a durable fact —
  which is what makes RECURRING credit safe, and RECURRING is precisely Doug's own example (a flu shot).
  **Credit is only as trustworthy as the identity match beneath it:** today a bad match mis-groups a
  timeline (embarrassing); with credit it mis-states compliance (dangerous), so credit flows only across
  E15 match-key groups and human-CONFIRMED links (ADR-022 preserved). The real payoff is a **write path**
  (stop chasing someone who already got the shot) — scoped as an audited, opt-in Phase 2 with its own
  sign-off.
- **#270 — backup & DR runbook** (`docs/BACKUP_DR_RUNBOOK.md`). Read from the **live** Neon project, not
  assumed: `history_retention_seconds = 21600` — **the PITR window is six hours**, and it is the *only*
  recovery mechanism (no scheduled dump, no snapshot schedule). A destructive change noticed the next
  morning is **unrecoverable**. Tolerable for synthetic demo data; a compliance-grade incident the moment
  real data lands. **Provisioning one bucket unblocks both #167 (evidence) and a nightly DB dump**, which
  makes #167 materially more valuable than it looks on the M3 list. Also: restore procedures (incl. the
  classic failure — a restore that mints a *new* branch needs `DATABASE_URL_TWH` repointed or the app
  keeps writing to the damaged one), an RPO/RTO table, what's regenerable vs what a backup actually
  protects (the audit ledger, real case state, human `person_links` decisions — all small), and a
  zero-risk restore drill on a Neon branch.

**Owner decisions now blocking further build on these tracks:** the `eval_state` DDL; Neon retention +
the nightly dump + branch protection; and whether cross-system credit gets its Phase-2 case-closure write
path.

## 2026-07-13 — ICE forecasting is real: the inert stub is replaced by a live sidecar adapter (ADR-029)

`iceForecaster` had been an inert stub since E6 (#76) — it answered "ICE not wired (Doug Q5)" for
every series, because the transport question was parked with MIE. The same-day research pass proved
ICE is **self-hostable today** (HLN's official, ACIP-maintained `hlnconsulting/ice` image), so the
stub is now a **real adapter** and #254 Q D18 is answered without MIE.

- **`ice-vmr.ts` (new, pure):** the OpenCDS DSS codec — string-template vMR `CDSInput` builder + DSS
  envelope + tolerant `CDSOutput` proposal parser. **No new deps** (the hand-rolled-XML pattern the
  QRDA stub already uses). Golden-tested against a real captured response
  (`backend-ts/spike/ice/dss-response.json`).
- **`ice-forecaster.ts` (new):** `realIceForecaster` — `POST /api/resources/evaluate`, or
  `/evaluateAtSpecifiedTime` when an as-of date must move ICE's own clock (verified: a 2020 as-of
  shifts the influenza due-date from 2026-07-01 to 2019-07-01). Injectable transport, injectable
  **dose-history source** (the E12/WebChart drop-in seam), bounded timeout, and a **whole-forecast**
  deterministic fallback to `simulatedForecaster` on ANY failure — the advisory panel degrades, it
  never errors the case read (ADR-012). A half-ICE/half-simulated forecast would mix two schedules.
- **Port + seam:** `forecast()` is now **async**; selection moved to `resolve-forecaster.ts` (above
  both port and adapter, so the adapter imports the port without a cycle). `isIceConfigured` relaxes
  to **BASE_URL-only** — a self-hosted sidecar has no API key (the key stays optional, for an
  authenticating proxy, and never selects the seam alone). Demo stack unset ⇒ `ice=off`, byte-identical.
- **`infra/docker-compose.yml`** gains an opt-in `ice` service (3 GB cap); `ice-live.test.ts` runs
  against a real container and self-skips without the env var (the Pg-ceiling pattern).

**Two contract facts the live engine taught us that no doc we found states** (both now regression-tested,
both would have shipped as silent bugs against a mock):
1. The **request's** `base64EncodedPayload` is an **ARRAY** — a bare string is `400 Bad Request`.
   (`atob()` silently coerced the one-element array when reading the canonical payload, hiding this.)
2. A proposal's **vaccine group is on `<observationFocus>`, not `<substanceCode>`** — ICE proposes a
   concrete *product* for some groups (CVX 115 Tdap under focus group 200 DTP). Keying on the substance
   loses TDAP for any subject with **no DTP history** — i.e. the normal adult occupational-health case —
   and, per the all-or-nothing fallback, silently degraded the *whole* forecast to simulated. Caught only
   because the live test's fallback was made to **throw** instead of pass.

Live output for a real subject (`emp-006`, ICE 2.57.2): TDAP OVERDUE `ICE RECOMMENDED (DUE_NOW,
ADMINISTER_TDAP_OR_TD)`, INFLUENZA OVERDUE due 2026-07-01, HEPB OVERDUE (dose 3 of the traditional
series). **ICE disagreeing with a WorkWell measure is expected, not a defect** — ICE scores full ACIP,
a measure scores its own authored rule; CQL stays the sole compliance authority (ADR-008/ADR-012).

Suite: **1260 tests — 1255 pass / 0 fail / 5 skip** (the live-ICE tests skip without the env var).
No schema, no new deps. Plan: `docs/superpowers/plans/2026-07-13-ice-forecaster-adapter.md`.

## 2026-07-13 — E12 PR-2c: verified-contract WebChart transport (SMART Backend Services + per-resource composition)

Built on the same day's public-sources research (PR #286, merged — the research record is
`docs/INTEGRATION_RESEARCH_2026-07-13.md`; its journal entry is directly below this one):
`httpWebChartClient` no longer implements the #255 *assumed* mock contract — it
implements WebChart's **real, publicly verified FHIR contract** (ADR-028), un-blocking PR-2c's
request shaping from #254:

- **`smart-backend-auth.ts` (new):** SMART Bulk Backend Services behind a `WebChartAuthProvider`
  port — `.well-known/smart-configuration` discovery (or `WORKWELL_WEBCHART_TOKEN_URL` override),
  RS384 `private_key_jwt` client assertion signed via **WebCrypto** (portable, mirrors
  `auth/password.ts`; no `node:crypto`, **no new deps**), `client_credentials` token exchange, token
  cache with expiry skew, single-flight refresh, `invalidate()` for 401 handling. 10 tests including
  real signature verification against an in-test generated keypair. The legacy static bearer mode is
  retained (`staticBearerAuth`).
- **Per-resource composition (no `$everything`):** each patient is composed from paged
  `GET /fhir/{Observation|Condition|Procedure|Immunization|Encounter}?patient={id}` searches into one
  collection Bundle; **any per-resource failure degrades the whole patient** to the fallback bundle
  (MISSING_DATA — partial clinical data never evaluates); the off-origin pagination guard now covers
  resource searches (protects the OAuth token). 401 → invalidate + one immediate retry.
- **Config/seams:** `isWebChartConfigured` accepts BASE_URL + (API_KEY **or**
  CLIENT_ID+PRIVATE_KEY); new env vars `WORKWELL_WEBCHART_CLIENT_ID/_PRIVATE_KEY/_TOKEN_URL/_SCOPE`
  (DEPLOY.md table); deployed default stays inert (no env → JSON source, byte-identical).
- **Conformance suite reworked** to the verified contract: fixture-vs-HTTP **golden outcome parity
  across every dev-DB measure**, SMART one-token-per-batch + 401 re-exchange, per-resource
  429/malformed/persistent-failure isolation, off-origin guards (population + resource), empty
  population. Plan: `docs/superpowers/plans/2026-07-13-e12-pr2c-smart-transport.md`.

Residual #254-gated: credentials/registration (a sandbox dynamic-registration attempt is the next
step), pagination semantics, `Group/$export _since`. Descriptive only (ADR-008/ADR-017); no schema,
no new deps.

## 2026-07-13 — Independent integration research: WebChart public FHIR contract + self-hostable ICE (docs only)

Rather than staying blocked on #254 answers ahead of the 2026-07-15 Doug meeting, ran a
public-sources research pass and recorded it in **`docs/INTEGRATION_RESEARCH_2026-07-13.md`**
(new). Headlines:

- **WebChart has a public, certified FHIR R4 API** (R4 4.0.1, US Core 7.0.0, SMART App Launch
  2.2, Bulk Data 2.0, Inferno g10) documented in `github.com/mieweb/docs`, with a **live public
  sandbox** (`fhirr4sandbox.webchartnow.com` — CapabilityStatement + smart-configuration fetched
  and verified 2026-07-13) that documents **dynamic client registration** incl. the SMART
  **Backend Services** server-to-server flow (`client_credentials` + RS384 `private_key_jwt` +
  JWKS, `system/*.rs`).
- **Two corrections to the #255 mock contract** for E12 PR-2c: (1) auth is SMART Backend
  Services, **not** a static bearer API key; (2) there is **no `Patient/$everything` and no
  `_lastUpdated`/history** — per-patient pulls compose from per-resource `?patient={id}`
  searches, and the incremental candidate for #263 is `Group/$export?_since=` (unverified) with
  content-hashing as the fallback. Pagination remains genuinely undocumented (kept as an open
  #254 question).
- **WebChart itself is not runnable locally** (closed-source; `dev-wcdb` is the DB only), and
  Doug's "MIE open-source server" is `mieweb/opensource-server` — the Proxmox Create-a-Container
  platform we already deploy on, not WebChart.
- **ICE is self-hostable today:** official HLN Docker image (`hlnconsulting/ice`, release 2.57.2
  of 2026-07-08, actively ACIP-maintained), REST DSS endpoint over vMR payloads; ~3–5 days to a
  real TS adapter behind the existing `ImmunizationForecast` port. A Java→TS port of ICE is
  assessed infeasible (continuously-updated Drools rule base).
- **Two internal gaps surfaced** (one later corrected): (1) ~~the VSAC import was never run on
  live Neon~~ — **corrected on double-check (2026-07-13):** the 21 OIDs were imported 2026-07-05;
  only the DEPLOY "✓ Done" banner was missing (added on the PR-2c branch), and the live diff was
  **verified returning `mode: "literal"`** (150 subjects / 15 divergent / 0 errors); (2) Doug's
  "compliant anywhere = compliant everywhere" (2026-06-24) is **display-only** today — E15 merges
  the timeline but quality calculations never credit cross-system events (ADR-022 by design);
  filed as **#287**.

**`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md` updated:** A1/A2/A3/A6/C13/D18 now carry dated
**provisional answers (confirm/correct)** blocks + an answer-log entry — the package now reads
"here's what we found, confirm the residuals" instead of a blank questionnaire. Remaining
genuinely MIE-gated: pagination, `$export _since`, A4/A5/A7/A8, B9–B12, C14–C16, D17.

**Executed same-day (see the respective branches/PRs):** E12 PR-2c built + reviewed + PR'd
(**PR #288**, branch `feat/e12-pr2c-smart-transport`, ADR-028 — suite 1227/1227 green incl. the live
Pg ceiling); **ICE spike PROVEN** — the official `hlnconsulting/ice` Docker image ran locally and
returned 17 real vaccine-group forecasts + 60 dose evaluations for the canonical test payload
(`docs/superpowers/specs/2026-07-13-ice-sidecar-spike.md`); **#263** redesign comment posted
($export _since primary / content-hash fallback); **#287** filed (calculation-level cross-system
credit — Doug's "compliant anywhere" ask is display-only today). **Remaining owner step:** send the
updated #254 package (the VSAC/Neon step turned out to be already done — see the correction above).

## 2026-07-11 — Deploy fix, observability merge, durable scheduler (PRs #283, #281, #284)

Three PRs merged to `main`; the production deploy is green again.

- **Deploy fix (#282 / PR #283).** The `deploy-twh-mieweb.yml` MIE Create-a-Container step had been
  failing on every push since #280: the backend image grew (the `fqm-execution` dependency from #258
  plus the ~8.5 MB vendored `measures/official/` MADiE bundle) on top of a single-stage, unpruned
  Dockerfile, so the GHCR image pull + Proxmox `vzcreate` exceeded the deploy script's 300 s job-poll
  window and timed out (`Timed out waiting for deploy job`). Both images always built fine — the
  failure was purely the deploy step. Fix, two parts: (1) `.github/scripts/deploy-mieweb-container.sh`
  raises the job-poll window from 30 → 90 attempts (300 s → 900 s), overridable via a validated
  `DEPLOY_JOB_POLL_ATTEMPTS` env var (positive integer, capped at 360; a bad value fails fast rather
  than producing an empty poll loop that could report a deploy green without polling); (2)
  `backend-ts/Dockerfile` converted to a multi-stage build (toolchain-heavy builder → slim
  production-deps runtime), final image ~436 MB. Verified: full backend suite green, image builds and
  boots. Post-merge the deploy ran green.

- **#264 observability (PR #281).** Failed-run alerts + seam inventory — a FAILED/PARTIAL_FAILURE
  population run (and scheduler-tick errors / stuck-run recovery) now emits exactly one alert: an
  always-on `WORKWELL_ALERT` console line plus an optional webhook (`WORKWELL_ALERT_WEBHOOK_URL`,
  inert-unless-configured). Best-effort — never fails the run.

- **#268 durable scheduler (PR #284).** The in-process `setInterval` scheduler lost its 24 h debounce
  on container restart (the first-fire gate lived in an in-memory `_enabledAtMs`), so a cycle missed
  while the container was down was never backfilled. The gate is removed; cadence is now derived
  entirely from the already-persisted last SCHEDULED run — a restart resumes the correct ~23.5 h
  countdown, a missed cycle fires on the next tick, and a fresh enable with no history fires on the
  first tick. No new schema; the `SCHEDULER_RUN_TRIGGERED`-before-run audit invariant is preserved.
  `SchedulerStatus.nextFireAt` now reports the imminent next-tick time for a no-history scheduler
  instead of a stale 06:00 UTC estimate.

Housekeeping: merged branches deleted, agent worktrees removed, remote-tracking refs pruned.

## 2026-07-10 — #264 Codex P2 follow-ups (PR #281)

- **Scheduler env:** `server.ts` now passes `WORKWELL_ALERT_WEBHOOK_URL` (+ VSAC keys) into
  `schedulerTick` so the nightly path is not console-only when the webhook is configured.
- **Webhook timeout:** `webhookAlertChannel` aborts after 3s (`AbortSignal`) so a hung sink cannot
  stall `finishManualRun` / the scheduler tick; `emitAlert` still swallows the failure.

## 2026-07-10 — #264 observability minimum (failed-run alerts + metrics)

M3 production-readiness item: silent FAILED/PARTIAL_FAILURE population runs are no longer silent.

- **`AlertChannel` seam** (`backend-ts/src/run/alert-channel.ts`): always-on console channel emits one
  structured `console.error` line prefixed `WORKWELL_ALERT` + JSON payload; optional webhook channel
  (`WORKWELL_ALERT_WEBHOOK_URL`, plain `fetch` POST) inert-unless-configured.
- Wired into `finishManualRun` (PARTIAL_FAILURE), `finishOrFail` (FAILED), `schedulerTick` catch
  (SCHEDULER_TICK_ERROR), and stuck-run recovery (RUN_RECOVERED). Best-effort — alert failure never
  fails the run (Fable-H1 pattern).
- Seam inventory (#260) extended with `alert-webhook`; boot log line gains `alert-webhook=off|on`.
- Run metrics on `/api/runs` already had duration / evaluated / per-status counts — verified, no API gap.
- DEPLOY.md: reconciler history via GitHub Actions tab; env-var table row for the webhook.

No schema, no new deps. Tests: alert-channel unit + pipeline integration (exactly-one / none / best-effort).

## 2026-07-10 — PR #280 MERGED + housekeep

**PR #280** (`feat(ecqm): production-faithful CMS122v14 + CMS125v14`) **merged to `main`**
(`aa3cf2c`, squash). Remote feature branch deleted on merge; local branch cleaned. Operator docs
(`CLAUDE.md`, `README.md`, this journal) updated so eCQM posture matches production-faithful
subsets for **both** CMS122 and CMS125 (no longer “CMS125 simplified only”).

No open feature branches left. Next bottleneck remains **#254** (send MIE package) — not code.

## 2026-07-10 — PR #280 CI + Codex P1 (CMS125 visit + eCQM test parity)

Addressed CI red + Codex review on `feat/ecqi-faithful-cms122-cms125`:

- **Codex P1:** `stampEnrollment` for `cms125` now also stamps a CPT 99213 office-visit Encounter
  (evaluationDate-anchored inside the 12-month MP) so WebChart roster paths satisfy eCQI IPP visit gate
  without fabricating mammograms. Idempotent; cms122 still never roster-stamps a diabetes dx.
- **Dev-DB proof:** wc-49 is age 33 → honest `MISSING_DATA` under age 42–74; age-in-band OVERDUE are
  wc-8/36/45/47; whitelist non-MISSING total **31** (was 28 under simplified CMS125).
- **CLI goldens:** cms122/cms125 use dual-coded synthetic builder (spike fixtures predate VSAC/visit).
- **Execution-diff:** production ≡ official-subset ELM → expect `totalDivergent === 0` (parity).
- **Literal ADR-008:** determinism on the harness (enriched) path — not unenriched base.
- Bundled Mammography expansion includes legacy HCPCS G0202 for WebChart rows.

No schema/deps.

## 2026-07-10 — production-faithful CMS122v14 + CMS125v14 (eCQI 2026)

Promoted both runnable CMS eCQMs from simplified day-count / local-code CQL to **eCQI CMS*v14
(2026) faithful-subset production logic** (branch `feat/ecqi-faithful-cms122-cms125`):

- **CMS122:** age 18–75, visit-in-MP, VSAC diabetes, period-bounded HbA1c **or GMI (LOINC 97506-0)**,
  hospice + palliative DENEX; `periodMonths: 12`. Missing assessment = numerator → OVERDUE.
- **CMS125:** female 42–74, visit-in-MP (incl. virtual), mammogram in official **Oct 1 year−2 → end of
  MP** window (VSAC Mammography), mastectomy + hospice + palliative DENEX; no DUE_SOON.
- Dual-coded synthetic builder (VSAC/LOINC/CPT + urn:workwell); bundled offline VSAC expansions so
  evaluation works without a live VSAC key; engine expands 2.16.* OIDs with store/VSAC fallback.
- Structural fidelity for **both** measures; CMS122 literal fqm tier retained (diagnostic).
- **Stayed on v14 / 2026** (not v15/2027): v15 is next-year roll-forward; population criteria essentially
  unchanged; catalog/demo year is 2026. Residual Phase 2: 66+ LTC + frailty/AI DENEX.

Verified against eCQI QDM HTML 2026-07-10. No schema. ADR-008: CQL Outcome Status still sole authority.

## 2026-07-10 — docs currency + eCQM accuracy posture

Post-wave operator docs brought current so agents stop reading “M1 still open / #253 next”:

- `CLAUDE.md` Current Focus → **2026-07-10**: M1 engineering closed; remaining owner step **#254**;
  eCQM honesty summary; historical Option A block kept.
- `README.md` Status, `docs/ROADMAP_2026-07-09.md` milestone/issue status columns + sequencing strike-throughs.
- `docs/MEASURES.md` → new **“eCQM accuracy posture”** table: catalog metadata verified for 49 CMS IDs;
  deep official-logic fidelity is **CMS122-only**; CMS125 simplified/no ladder; 47 Drafts not evaluated;
  recommended next accuracy work (CMS125 fidelity package first, then CMS122 authored gaps, then
  product-picked Draft promotions — never bulk “make all eCQIs”).

No code/schema/deps.

## 2026-07-10 — roadmap wave closeout (#271–#279)

Closed the 2026-07-09 roadmap-wave PR stack. Review fixes (Codex) were already on the branches before
merge: off-origin WebChart pagination guard (#274 P1), invalid `0000-00-00` birthDate sanitization
(#273), stale worker-pool exit ignore (#275), `calculateHTML: false` for fqm literal tier (#277), and
M3 issue list #267–#270 in CLAUDE/roadmap (#271).

**Merged (squash, owner-authorized):** #276 (N=5000 proof docs) → #272 (seam inventory) → #273
(dev-DB full corpus) → #274 (mock WebChart transport) → #275 (worker pool) → #279 (tiered evidence
#257; reopened as #279 after stacked #278 closed when its base branch deleted) → #277 (fqm literal
diff #258) → #271 (production-readiness memo #261). Wave PRs from this set are closed; `gh pr list`
shows 0 open. Agent worktrees under `.claude/worktrees/` pruned; feature branches deleted.

**M1 engineering outcome:** integration-readiness code is on `main` (mock HTTP transport, worker
pool, tiered evidence, full fixture corpus, seam inventory, literal CMS122 path, production memo).
Remaining M1 owner step: **#254 send MIE question package**. M2 (#262/#263/#187) stays
contract-gated; M3 (#264–#270, #167, #168) is production hardening.

Deleted `docs/HANDOFF_2026-07-10.md` with this closeout.

## 2026-07-09 — #259 WebChart dev-DB fixtures expanded to all patients

Expanded the offline WebChart dev-DB fixture corpus from the codeable-data subset to all 56 `is_patient=1`
rows. `scripts/webchart-devdb-export.ts` now emits sparse Patient-only bundles instead of skipping
patients without LOINC observations or coded procedures, and the generated OH enrollment roster now covers
all 56 subjects. The sparse fixtures are intentional live-adapter edge cases: enrolled patients with no
matching clinical data evaluate to CQL-authored `MISSING_DATA`; no evaluation logic, normalization
semantics, terminology mapping, schema, or dependencies changed.

The dev-DB golden tests now hard-assert the 56-patient corpus, sweep every patient across the
`evaluate:webchart-devdb` whitelist and named-excluded measures, keep the existing real-code per-patient
assertions, and pin a Patient-only subject (`wc-14`) to `MISSING_DATA` as the no-data proof. The CLI
summary remains 28 real (non-`MISSING_DATA`) whitelist outcomes, now over 56 patients; docs updated in
`WEBCHART_FHIR_MAPPING.md` §8.1.

## 2026-07-09 — Fable strategy session: roadmap materialized, MIE unblock package authored

### #258 — literal official-CQL diff spike (2026-07-09)

**Gate PASSED (posted to #258 before any code):** the official CMS122v14 MADiE FHIR bundle
(`cqframework/ecqm-content-cms-2025` @ `30a62701`, measure `CMS122FHIRDiabetesAssessGreaterThan9Percent`
v0.5.000, QICore 6.0.0) carries base64 `application/elm+json` for the Measure + **all 9 chained
libraries** — `MISSING ELM: NONE`. A feasibility probe then ran the literal artifact end-to-end via
`fqm-execution` against a plain-FHIR patient (IPP/DENOM/DENEX/NUMER all computed) — the ADR-024
translator blocker is irrelevant because **no translation happens**; the pre-compiled ELM executes on
the `cql-execution`/`cql-exec-fhir` stack the repo already uses. Shipped: **`fqm-execution@1.8.5`
pinned, diagnostic-only (ADR-026** — imported solely by `standards/literal-diff.ts`, arch-tested by
`fqm-isolation.test.ts`); the vendored bundle (`backend-ts/measures/official/cms122v14/`, provenance
README; redundant `elm+xml` blobs stripped 13.4→8.9 MB); `computeLiteralDiff` (valueSetCache from the
imported VSAC rows — no runtime key; `trustMetaProfile:false`; a harness-local `stampQiCoreStructure`
normalizing Conditions to QICore active/confirmed + in-past onset — fields WorkWell's cms122 ignores,
byte-identical guard test; population-level gate attribution; memoized per run-id); and the
**three-tier `chooseDiffMode` ladder** `literal → subset → estimate` with an additive `mode` response
field (the old subset report's `mode:"execution"` renamed `"subset"`; runtime literal failure degrades
to subset). Empirical finding worth recording: the literal QICore retrieves require
`clinicalStatus`/`verificationStatus` with proper system URIs + a prevalence-period onset — without the
stamp every subject reads out-of-population. Verified: backend **1065 pass / 1 pg-skip / 0 fail**;
frontend lint + vitest + build green (StandardsTab now discriminates `subset|literal`). Closes #251 as
superseded. Docs: ADR-026, MEASURES.md, ARCHITECTURE.md (`standards` + §7).

### #255 — mock-contract WebChart transport (2026-07-09)

Implemented the M1 pre-build of the live WebChart HTTP transport (`feat/issue-255-mock-webchart-transport`),
making E12 PR-2c a days-size diff once MIE's contract answers land. `httpWebChartClient`
(`backend-ts/src/engine/ingress/webchart/webchart-client.ts`) is now a **real transport built against our
own assumed FHIR R4 contract** — documented in the new `docs/WEBCHART_API_ASSUMPTIONS_2026-07.md` (two
variants: A = true FHIR R4, implemented; B = proprietary REST over `wc_miehr_*`, documented fallback only —
every assumption cross-referenced to its MIE question A1–A8/B9–B11/C13–C16 in
`docs/MIE_INTEGRATION_QUESTIONS_2026-07-09.md`). The client: paged `GET /fhir/Patient?_count=` population
listing (searchset `link[relation=next]` traversal), per-patient `GET /fhir/Patient/{id}/$everything`
(one payload per patient — never a collapsed multi-patient bundle), `Authorization: Bearer` auth,
AbortController timeouts, bounded 429/5xx retry-with-backoff, and per-patient failure degradation to a
Patient-only bundle + `OperationOutcome` marker (the subject isolates as MISSING_DATA; the batch never
aborts — mirrors `evaluateBatch`). Global `fetch` only — **no new deps, no schema**. A new named
conformance suite (`webchart/mock-http-conformance.test.ts`) serves the 26 committed dev-DB patient
bundles through an in-test `fetch` shim and asserts the mock-HTTP path's per-subject outcomes are
**identical to the fixture-client path** for every whitelisted + excluded measure (the `devdb-eval.test.ts`
goldens), plus the 5 failure-mode tests (timeout, 429-then-success, partial page, malformed resource,
empty population). Deployed default is byte-identical: `resolveDataSource` still selects JSON unless BOTH
`WORKWELL_WEBCHART_*` envs are set (explicit unset/blank-env test added). `normalize.ts`/`terminology.ts`
semantics untouched. Docs: ARCHITECTURE `engine.ingress.webchart`, WEBCHART_FHIR_MAPPING §8.2, the new
assumptions doc. Built by Codex (gpt-5.5 high) under orchestration; verified locally green. Descriptive
only (ADR-008/ADR-017); read-only ingress — no audit-event surface.

### #253 — N=5000 real-eval proof (2026-07-09)

The Phase-4 proof of the Option A batch engine, run live on Neon (owner-authorized #253). Precondition
verified first: the 2026-06-29 fabricated 1.68M-row seed was rolled back — 0 `seed:scale` runs before
the run. `pnpm seed:scale --subjects 5000 --as-of 2026-06-26 --mode evaluate` (full evidence, no trim):

- **Completed: 14 runs × 5,000 subjects = 70,000 real CQL evaluations** — all 14 runs COMPLETED with
  the `requestedScope.batchEvaluated` marker; 14 `SCALE_POPULATION_EVALUATED` audit events; 70,000
  outcomes verified on Neon.
- **Wall-clock ~79.5 min; ≈68 ms/evaluation overall.** The first two 500-subject chunks ran under
  heavy host CPU contention (4 parallel build agents + their test suites): ~604 s / ~619 s per chunk
  ≈ 86–88 ms/eval; the remaining eight chunks averaged ~443 s ≈ **63 ms/eval** once contention eased —
  so the plan's ~60 ms estimate holds on a quiet machine.
- **Distribution is multi-bucket and per-measure realistic** (e.g. audiogram 3,900/275/275/275/275
  across COMPLIANT/DUE_SOON/OVERDUE/MISSING_DATA/EXCLUDED; PERMANENT measures mmr/varicella/hep-B
  correctly emit no DUE_SOON/OVERDUE — partial series land MISSING_DATA; cms122 emits no DUE_SOON by
  design). mhn COMPLIANT = 54,850 (78.4%), exactly Σ of the per-measure COMPLIANT counts. Full table
  on issue #253.
- **Live rollup reconciles:** All Systems = 72,100 = ihn 700 + twh 1,400 + mhn 70,000; mhn = Σ 24
  locations = Σ 240 providers = 70,000; `?tenant=mhn` isolates the subtree; the roster still excludes
  mhn.
- Storage: full (untrimmed) evidence averaged ~630 bytes/outcome — `workwell_spike.outcomes` is now
  80 MB (DB 202 MB total).
- **Decision: a full 120k run on Neon is NOT planned.** ~30+ h single-threaded, and the storage cost
  (~1 GB+ of evidence even before indexes) against the project's ~512 MB Neon branch headroom makes it
  a bad trade. The worker-thread pool (#256) and the tiered evidence policy (#257) are the
  prerequisites if it is ever done.

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

### #256 — worker pool (2026-07-09)

`seed:scale --mode evaluate` gains a **hand-rolled `node:worker_threads` pool** (`--workers <n>`, default
4, clamped to `availableParallelism()-1`; issue #256, design followed exactly). Work units are
`(start, end)` **subject-index ranges** — never FHIR bundles or cql-execution objects across the thread
boundary; each worker loads ELM/bindings/crosswalk once, regenerates each subject's bundle IN-worker via
the same deterministic-on-index `ScaleSubjectGenerator` (reconstructed from its `kind` string), evaluates
all 14 measures, and returns plain-JSON rows. The **main thread does every DB write** (the shared
`persistChunk` → `recordOutcomes`), so resume/idempotency (per-measure COMPLETED `seed:scale` +
`requestedScope.batchEvaluated`), the legacy-fabricated refusal, `SCALE_POPULATION_EVALUATED` audit, and
the status-only `aggregateScaleRun` read path are all **unchanged**. `--workers 1` (or 0) takes the
prior single-threaded code path unchanged (escape hatch + parity baseline). Crash isolation: a worker
error/non-zero exit replaces the worker and re-queues its chunk once; a second crash fails that chunk's
subjects soft to MISSING_DATA with `{evaluationError}` evidence. New: `run/scale-eval-pool.ts` (pure
orchestration, fake-worker unit-tested: exactly-once, retry-once, soft-fallback, DB-write rejection) +
`run/scale-eval-worker.ts` (thread entry); the sequential/worker paths share one pure
`evaluateScaleSubjectMeasure` so a worker row is byte-identical to a sequential row. **Parity test**
(real threads): `--workers 2` produces the identical (subject, measure, status) set as `--workers 1`.
**Measured** (N=500 × 14 = 7,000 real CQL evals, ~99 ms/eval sequential, 32-core host): 693.6s → 187.5s
(4 workers, **3.70×**) → 136.3s (8 workers, **5.09×**). The pool lives ONLY on the batch CLI path —
`worker_threads` is imported nowhere reachable from `worker.ts` (grep-verified). No new deps; no schema;
CQL stays the sole `Outcome Status` authority (ADR-008). Docs: DEPLOY.md long-run warning, ARCHITECTURE
seed:scale bullet. Branch `feat/issue-256-worker-pool`.

### #260 — seam inventory (2026-07-09)

Implemented the M1 issue: a boot-time inventory of the repo's ~7 "inert-unless-configured" seams
(sendgrid, datachaser, ice, eh-fhir, webchart, sql-executor, vsac). `describeSeams(env)`
(`backend-ts/src/config/seam-inventory.ts`) reports each seam's active/inactive state by calling a
newly-extracted, exported predicate per seam (`isSendgridConfigured`, `isDataChaserConfigured`,
`isIceConfigured`, `isEhFhirConfigured`, `isWebChartConfigured`, `isSqlPushdownSelected`,
`isVsacConfigured`) — each `resolve*` function was refactored to call its own predicate rather than
inline the env check twice, so nothing is duplicated. One boot log line in `worker.ts`
(`logSeamInventoryOnce`, guarded like the existing auth-handler memo so it fires once per worker
instance, not once per request): `seams: sendgrid=off datachaser=off ice=off eh-fhir=off webchart=off
sql-executor=off vsac=off`. New "Inert-seam inventory" table in ARCHITECTURE.md §10 (module path,
activating env var(s), default state, last-verified 2026-07-09, activation test file per seam).
`seam-inventory.test.ts` covers all 7 seams' on/off transitions (including the both-vars-required pairs
for datachaser/ice/eh-fhir/webchart) plus the all-off/all-on log-line shapes; the 6 pre-existing
per-seam test files (email-service, outreach-channel, immunization-forecast, standing-order-provider,
data-source, resolve-value-set-resolver) all still pass unchanged, confirming the predicate extraction
is a pure, behavior-preserving refactor. No schema, no new deps, no behavior change to any seam.
**1080 tests (1079 pass / 1 pg-skip / 0 fail).**

### #257 — tiered evidence policy + auto-trim (2026-07-09)

`seed:scale --mode evaluate` evidence persistence is now **tiered by actionability** (#257, stacked on
the #256 worker-pool branch — same file). Full `evidence_json` (~1–3 KB/outcome) at 120k×14 is GB-scale
on the cost-capped Neon, and the old all-or-nothing `--trim-evidence` was OPT-IN — a forgotten flag on a
big run was the predictable failure mode. Now: (1) **auto-trim** engages when `--subjects > 20000` and
`--trim-evidence` was not explicitly passed (notice printed); **`--full-evidence`** explicitly overrides
(the two flags together are a usage error); the pure `resolveTrimEvidence` in `run/cli/seed-scale.ts` is
unit-tested at the exact threshold (20,000 → no trim; 20,001 → auto-trim). (2) **Tiered trim** replaces
all-or-nothing (`applyEvidenceTier` in `run/batch-evaluate-scale.ts`, applied identically by the
sequential loop and the #256 worker): OVERDUE / DUE_SOON / MISSING_DATA keep FULL evidence (load-bearing
for cases/worklists; an evaluation-error MISSING_DATA keeps its `{evaluationError}` payload), COMPLIANT /
EXCLUDED get minimal `{scale:true}`, and a deterministic ~1% subject-index sample (`idx % 100 === 0`)
keeps full evidence across ALL buckets for audit spot-checks. Guard test proves a trimmed run's
`aggregateScaleRun` groups are identical to an untrimmed run's (status-only reads — the rollup provably
unchanged). Descriptive only (ADR-008): the tier reads the CQL-decided status, never sets it. No new
deps; no schema (existing `evidence_json` column). Long-term home for large evidence payloads is the
#167 managed-bucket work (noted in DEPLOY/DATA_MODEL). Docs: DEPLOY.md scale-seed section, DATA_MODEL
§3.23. Branch `feat/issue-257-tiered-evidence` (stacked on `feat/issue-256-worker-pool`).

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
