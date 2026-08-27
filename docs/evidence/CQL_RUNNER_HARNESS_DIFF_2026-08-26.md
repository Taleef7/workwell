# Runner-vs-harness case diff — and the harness defect it found (2026-08-26)

> **Updated 2026-08-27 (#482/#488):** the serializer now reads the ELM-declared result type, and the
> runner re-run moved the HTTP headline **1,589 → 1,606 pass, zero regressions**
> (`CQL_EVALUATION_SERVICE_2026-08-25.md`, re-run section, has the 17-case decomposition). Two
> corrections to this document's buckets: **(1)** the 149 `fail‖fail` cluster contained **9 Long
> arithmetic cases whose arithmetic was CORRECT** — the runner side failed on serialization identity
> (fixed), and the harness side failed on upstream's own representation split (a Long literal is a
> string, Long arithmetic returns a number), so they were never engine-wrongness (the tenth Long
> flip, `Negate1L`, was already correctly attributed in cluster 3 of finding 3 below); **(2)** finding 3's
> cluster 2 (`RolledOutIntervals`, "Date rendered as DateTime") is **reclassified as a
> grader-semantics artifact, not a serializer defect** — the test's own cast makes the static type
> `Interval<DateTime>`, the engine faithfully produces day-precision DateTimes, and `@2012-01-01T`
> is the correct rendering of that value; the corpus writes `Date` literals and the runner
> string-compares. Cluster 3's `Negate1L` is fixed; `NegateMaxLong` remains, precisely attributed to
> the engine's `Number` coercion (upstream, ADR-060).

**What this is.** The case-by-case reconciliation `CQL_EVALUATION_SERVICE_2026-08-25.md` named as the
prerequisite before any external submission of the `$cql` numbers: every test in
`cqframework/cql-tests` (pin `727219f4`), graded by HL7's `cql-tests-runner` over live HTTP on one
side and by the ADR-060 in-process harness on the other, joined per case and classified. Two
questions answered: where do the two graders disagree, and is any disagreement the engine being
wrong versus the serialization or the grading?

## Finding 1 — the "12-case delta" was OUR defect: the harness graded commented-out tests

The unexplained 1,835-vs-1,823 case-count difference decomposes exactly:

- **A file-name artifact, zero substance:** the runner reports `CqlQueryTest` where the harness
  reports `CqlQueryTests` — 12 cases match under the rename.
- **12 genuinely harness-only cases** (`CqlTypesTest` ×11, `CqlDateTimeOperatorsTest/Now/Issue34A`)
  are **commented out in the corpus XML** — upstream deliberately disabled them
  (`<!-- REPLACED BY … -->`). The runner's real XML parser respects comments; the harness's regex
  reader matched through `<!-- -->` and graded them as live. **ADR-060's "1,835 cases, nothing
  skipped" therefore included 12 dead tests; the true corpus at the pin is 1,823.**

**Fixed in this change:** `parse-tests.ts` strips comments before matching (pinned by two new
harness tests, RED first — a commented-out test and a commented-out group), `EXPECTED_CASES` moves
1,835 → 1,823 with the reason in its docblock (the refuse-to-report guard fired on the fix, which is
that guard working), and the baseline regenerates. Corrected headline: **1,612 pass · 155 fail ·
12 translation-error · 4 runtime-error · 11 invalid-refused · 29 invalid-accepted, of 1,823** —
the deltas from the published ADR-060 figures are exactly the dead cases (pass −10,
invalid-accepted −2; no live case moved).

## Finding 2 — the status matrix, and what each off-diagonal cell is

After normalizing the file rename, all 1,823 runner cases join a harness case (0 unmatched):

| harness ‖ runner | count | classification |
|---|---|---|
| pass ‖ pass | 1,571 | agree |
| fail ‖ fail | 149 | agree — the known engine/translator gaps (ADR-060) |
| **pass ‖ fail** | **41** | **serialization/grading losses — the target list, dissected below** |
| invalid-accepted ‖ fail | 29 | consistent: we evaluate CQL the corpus calls invalid; the runner grades the answer wrong |
| translation-error ‖ skip | 11 | consistent: the runner's own skips (library-style tests wanting `Library/$evaluate`) are exactly our translation errors |
| fail ‖ pass | 6 | runner-lenient / harness-strict — dissected below |
| invalid-refused ‖ pass | 11 | consistent: refusing an invalid case IS the pass condition for the runner (6 at translation, 5 at runtime) |
| runtime-error ‖ fail | 4 | consistent: the four known runtime errors |
| translation-error ‖ pass | 1 | `CqlTypeOperatorsTest/ToConcept/CodeToConcept1` — open; see below |

## Finding 3 — the 41 `pass‖fail` losses contain ZERO engine-wrongness

Every one is the transport/serialization/grading layer, in three clusters:

1. **38 — timezone rendering on DateTime.** The corpus expects `@2005-05-10T10` (a DateTime
   constructed with no offset); over HTTP we serve `@2005-05-10T10-04:00`, and the runner
   string-compares. Two sub-shapes: the engine (`cql-execution`) attaches the evaluation timezone to
   offset-less DateTimes, and our serializer renders it — which FHIR *forces*: `valueDateTime` with
   hours **requires** an offset, so a faithful "no offset" round-trip is unrepresentable in the wire
   format. Plus 2 cases of `+00:00` where the corpus writes `Z`. The in-process harness compares by
   CQL `~`, which is offset-aware-but-equivalent, so these grade pass there. **This is a genuine
   spec tension between CQL partial DateTimes and FHIR serialization, worth raising on the track**
   — every FHIR-transport engine should be failing these the same way.
2. **1 — Date rendered as DateTime** (`CqlAggregateTest/RolledOutIntervals`): interval-of-`Date`
   boundaries serialized with a trailing `T`. Same family as #482 (interval point types from the
   compiled ELM rather than value-shape heuristics).
3. **2 — Long serialization defects, ours, real** (`Negate1L`, `NegateMaxLong`): the `L` marker is
   lost (Long collapses to a JSON number), and `-9223372036854775807L` serializes as
   `-9223372036854776000` — **precision loss in JS number space**. Filed as the serialization
   follow-up (#488): a Long outside the safe-integer range must not pass through `Number`.

## Finding 4 — the 6 `fail‖pass` cases grade US BETTER over HTTP than in-process

- **3 decimal-precision cases** (`PopStdDev`, `StdDev`, `Subtract2And11D`): raw actual
  `1.4142135623730951` vs expected `1.41421356` — the runner's comparator tolerates trailing
  precision; the harness is strict. The known decimal-precision-on-aggregates finding stands; the
  runner would hide it.
- **2 interval-Except cases**: the engine returns `[1, 4)`; our serializer's **closed-normalization**
  ships `Interval[1, 3]`, which string-matches the expectation — the serializer's spec-correct
  boundary normalization *fixed* a comparison the harness's weaker JS-comparison path flags. The
  harness side is the deficient grader here (its own report prints the "16 compared in JS" caveat).
- **1 null-boundary case** (`TestIntersectNull`): the harness renders the boundary as
  `[object Object]` — a harness display defect, not an engine one.

**Open (1 case):** `CodeToConcept1` — translation-error in-process yet passing over HTTP; the
suspected difference is the harness's own expected-value comparison line rather than the expression,
not yet confirmed.

## What this changes for external use of the numbers

The runner-graded headline (1,589 / 1,823 over HTTP) and the corrected in-process headline
(1,612 / 1,823) now reconcile case-for-case: the gap is **38 timezone-rendering cases + 1 Date
rendering + 2 Long serialization − 6 runner-lenient − 11 refusal-counting − the invalid/error
bucketing differences** — with no unexplained residue and no case anywhere in which the engine
computed a wrong value that the in-process harness called right. The numbers are now safe to cite
together, with the timezone cluster named as a transport-layer artifact when quoting the HTTP rate.

Raw inputs: the runner's `local_results/202608251540_results.json` (local scratch, 2026-08-25 run)
against `.cql-tests-results/results.json` regenerated at the same pin on 2026-08-26; join key
`(testsName normalized, groupName, testName)`.
