# `$cql` Evaluation Service — first external grading by `cql-tests-runner` (2026-08-25)

**What ran.** HL7's own conformance client, [`cqframework/cql-tests-runner`](https://github.com/cqframework/cql-tests-runner)
(cloned at its 2026-08-24 head), drove WorkWell's new `POST /$cql` route (#474) over live HTTP:
runner → local auth-injecting proxy (the runner sends no Authorization header; the endpoint is
deliberately bearer-gated) → the worker under `MIEWEB_TARGET=local`. Corpus: the same
`cqframework/cql-tests` sidecar the ADR-060 in-process harness uses (16 files), via the runner's
`CQL_TESTS_PATH` override. Engine metadata declared in the run config: WorkWell measure-engine
(`cql-execution` 3.3.2), JS translator `@cqframework/cql` 4.0.0-beta.1.

**Headline.**

| | total | pass | fail | skip | error |
|---|---|---|---|---|---|
| **This run (runner-graded, over HTTP)** | 1,823 | **1,589** | 223 | **11** | 0 |
| Published reference JS submission (cql-execution 3.3.0, Java translator, `cql-tests-results`) | — | 1,533 | 81 | **113** | 4 |
| ADR-060 in-process harness (our own grader, same corpus) | 1,835 | 1,622 | 155\* | 0 | 4\* |

\* ADR-060 keeps translation errors (12), runtime errors (4) and the invalid-case buckets in separate
columns by design; the runner folds everything into pass/fail. The two gradings are therefore not
row-comparable — the point of this table is that the runner's own grading of our service lands in the
same band as our self-grading, and **passes more cases with 102 fewer skips than the published JS
reference submission**. The 11 skips here are the runner's own (library-style tests needing
`Library/$evaluate`, which this service does not yet expose); our SkipList is empty, per the ADR-060
posture that skipping the weak clusters would delete the finding.

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
transport or serialization additions so far as inspected: 27 of the 223 are `invalid` cases the stack
accepts and evaluates (the translator-diagnostics gap ADR-060 recorded), and the heavy files are
arithmetic (Long semantics, decimal precision on aggregates), intervals, and lists (`Slice`
unimplemented upstream — now a published CQL 2.0 function). The logical / nullological / conditional
files — the constructs our measure CQL is built from — are at 0 fails, as in ADR-060. **Not yet done:**
a case-by-case diff of runner-graded vs ADR-060-graded outcomes to separate genuine
serialization-mapping losses from the known engine gaps; that diff is the natural next artifact and
should happen before any external submission of these numbers.

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
