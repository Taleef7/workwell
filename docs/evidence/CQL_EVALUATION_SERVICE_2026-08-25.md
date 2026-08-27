# `$cql` Evaluation Service — first external grading by `cql-tests-runner` (2026-08-25)

**What ran.** HL7's own conformance client, [`cqframework/cql-tests-runner`](https://github.com/cqframework/cql-tests-runner)
(cloned at its 2026-08-24 head), drove WorkWell's new `POST /$cql` route (#474) over live HTTP:
runner → local auth-injecting proxy (the runner sends no Authorization header; the endpoint is
deliberately bearer-gated) → the worker under `MIEWEB_TARGET=local`. Corpus: the same
`cqframework/cql-tests` sidecar the ADR-060 in-process harness uses (16 files), via the runner's
`CQL_TESTS_PATH` override. Engine metadata declared in the run config: WorkWell measure-engine
(`cql-execution` 3.3.2), JS translator `@cqframework/cql` 4.0.0-beta.1.

**Headline.**

| | total graded | pass | fail | skip | error |
|---|---|---|---|---|---|
| **This run (runner-graded, over HTTP, corpus at the 2026-08 sidecar)** | 1,823 | **1,589** | 223 | **11** | 0 |
| Published reference JS submission (cql-execution 3.3.0, Java translator, run 2026-04-02, `cql-tests-results`) | 1,731 | 1,533 | 81 | **113** | 4 |
| ADR-060 in-process harness (our own grader, same sidecar corpus; **corrected 2026-08-26**) | 1,823 | 1,612 | 155\* | 0 | 4\* |

\* ADR-060 keeps translation errors (12), runtime errors (4) and the invalid-case buckets in separate
columns by design; the runner folds everything into pass/fail. **No row here is like-for-like with any
other** (#481 review): the reference submission graded a corpus ~92 cases smaller (its April 2026
snapshot vs our sidecar), so its raw pass count is not comparable — and on pass-rate over cases graded
it is *higher* (88.6% vs 87.2%), which any external use of these numbers must say. The defensible
headline is the **skip discipline**: this run's 11 skips are the runner's own (library-style tests
needing `Library/$evaluate`, not yet exposed) against the reference's 113, and our SkipList is empty,
per the ADR-060 posture that skipping the weak clusters would delete the finding. *(This table
originally showed the harness row as 1,835 / 1,622 with a "12-case delta unexplained" note — the diff
resolved it as a defect in OUR harness: it parsed through XML comments and graded 12 tests upstream
had disabled. Corrected figures above; full account in
[`CQL_RUNNER_HARNESS_DIFF_2026-08-26.md`](CQL_RUNNER_HARNESS_DIFF_2026-08-26.md).)*

**Per-file** (runner grading):

| file | pass | fail | skip |
|---|---|---|---|
| CqlAggregateFunctionsTest | 48 | 2 | 0 |
| CqlAggregateTest | 8 | 1 | 0 |
| CqlArithmeticFunctionsTest | 178 | 58 | 0 |
| CqlComparisonOperatorsTest | 245 | 16 | 0 |
| CqlConditionalOperatorsTest | 9 | 0 | 0 |
| CqlDateTimeOperatorsTest | 281 | 35 | 1 |
| CqlErrorsAndMessagingOperatorsTest | 3 | 1 | 0 |
| CqlIntervalOperatorsTest | 367 | 44 | 0 |
| CqlListOperatorsTest | 199 | 33 | 10 |
| CqlLogicalOperatorsTest | 39 | 0 | 0 |
| CqlNullologicalOperatorsTest | 22 | 0 | 0 |
| CqlQueryTest | 10 | 2 | 0 |
| CqlStringOperatorsTest | 80 | 2 | 0 |
| CqlTypeOperatorsTest | 33 | 2 | 0 |
| CqlTypesTest | 20 | 8 | 0 |
| ValueLiteralsAndSelectors | 47 | 19 | 0 |

**Reading the 223 fails.** The clusters match ADR-060's known translator/engine findings, none in our
transport or serialization additions so far as inspected: 29 of the 223 are `invalid` cases the stack
accepts and evaluates *(the full join says 29; a first pass estimated 27)* — the
translator-diagnostics gap ADR-060 recorded — and the heavy files are
arithmetic (Long semantics, decimal precision on aggregates), intervals, and lists (`Slice`
unimplemented upstream — now a published CQL 2.0 function). The logical / nullological / conditional
files — the constructs our measure CQL is built from — are at 0 fails, as in ADR-060. **The
case-by-case diff HAS now been produced**
([`CQL_RUNNER_HARNESS_DIFF_2026-08-26.md`](CQL_RUNNER_HARNESS_DIFF_2026-08-26.md)): the 41
runner-fails-harness-passes cases contain **zero engine-wrongness** — 38 are DateTime
timezone-rendering (a CQL-partial-DateTime vs FHIR-required-offset spec tension), 1 is
Date-rendered-as-DateTime (#482 family), and 2 are real Long serialization defects (#488) — so these
numbers are safe to cite together, with the timezone cluster named.

**A defect this run caught that no unit test could.** The route initially passed a shared
module-level headers object into every `Response`; the local host layer writes the computed
`Content-Length` into the object it is handed, so the first response's length poisoned every
subsequent response (measured: a 321-byte `Parameters` served under `Content-Length: 78`; clients
hang on shorter bodies and hit trailing-garbage parse errors on longer ones). Fixed by constructing
fresh headers per response (`jsonHeaders()` in `src/routes/cql-evaluation.ts`, with the incident
recorded in its docblock). The failure was invisible to every route test — in-process `Response`
objects never traverse the host's serialization layer.

**Raw results:** the runner's `local_results/202608251540_results.json` (local scratch; not
committed — the numbers above are the record, and the run is reproducible: runner at its README
defaults + `CQL_TESTS_PATH` at the sidecar + any bearer-injecting proxy).

---

## Re-run 2026-08-27 — after #482/#488 (declared result types): 1,589 → **1,606 pass**, zero regressions

Same runner, same sidecar corpus, same proxy setup, against the serializer reading the ELM-declared
result type (`EnableResultTypes`, `cql-result-parameters.ts`). **pass 1,606 · fail 206 · skip 11**
(88.6% of graded). All 17 status changes are fail→pass; the case-by-case decomposition:

- **10 Long arithmetic cases** (`AbsLong`, `Negate1L`, `NegateNeg1L`, `Multiply2LBy3L`,
  `Subtract1LAnd1L`, `Modulo4LBy2L`, `TruncatedDivide10LBy3L`, `Power2LTo2L`, `Power2LTo3L`,
  `ProductLong`) — the engine's Long arithmetic computes the CORRECT value for every one of these;
  the failures were serialization identity (a Long shipped as `valueInteger`/`valueDecimal`, which
  the runner's BigInt comparison refuses). This corrects the 2026-08-26 diff's bucketing for **9 of
  the 10**: they sat in the 149 `fail‖fail` "engine gap" cluster, but the in-process harness failed
  them for its own reason (upstream represents a Long LITERAL as a string while Long ARITHMETIC
  returns a number, so the harness's native comparison sees `"100" ≠ 100`) — a representation
  inconsistency, not wrong arithmetic. The tenth, `Negate1L`, was already correctly placed in the
  41 `pass‖fail` cluster (the diff's finding 3, cluster 3) and is simply fixed. The
  genuinely-lossy Long cases (`NegateMaxLong` — the engine coerces the literal string through
  `Number`; `1L + 2L` string concatenation) still fail, and are upstream `cql-execution` gaps
  (ADR-060), now precisely separated from the serialization losses.
- **2 numeric-interval cases** (`DecimalIntervalExcept1to3`, `ExpandPer0D1`) — #482 exactly: the
  whole-number heuristic labeled Decimal intervals Integer and closed-normalized open boundaries by
  step 1 (`[1.0, 4.0)` shipped as `[1, 3]`; true coverage `[1, 3.99999999]`).
- **5 cases measured for the first time** (`QuantityIntervalExcept1to4`, `ExceptDateTimeInterval`,
  `ExceptDateTime2`, `ExceptTimeInterval`, `ExceptTime2`) — these flips are NOT from this change:
  the 2026-08-25 acceptance run predated the #481 review round's quantity/temporal
  closed-normalization fixes (the old actuals show raw open boundaries), so the published 1,589
  slightly understated the merged #481 code. This re-run is the first HTTP measurement of the tree
  as merged.

**One reclassification, no code change:** `CqlAggregateTest/RolledOutIntervals` (the "Date rendered
as DateTime" case, #488 item 3) is NOT a serializer defect. The test's own CQL casts through
`List<Interval<DateTime>>`, our engine faithfully produces day-precision DateTime boundaries, and
`@2012-01-01T` is the correct CQL rendering of that value — the corpus writes the expected output as
`Date` literals and the runner string-compares, while the in-process harness passes it via the
Date→DateTime equivalence conversion. It joins the timezone cluster as a grader-semantics artifact.
Raw results: `local_results/202608271111_results.json` (local scratch).
