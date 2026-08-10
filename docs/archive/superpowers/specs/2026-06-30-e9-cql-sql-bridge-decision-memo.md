# E9 — CQL → SQL bridge — Decision memo

Date: 2026-06-30
Epic: E9 (#78) — CQL→SQL bridge (WebChart) — spike / decision memo only
Status: Draft decision memo — pending Doug **Q2** confirmation (no code until the fork is decided)
Author: Drafted with Claude for Taleef / Doug review
Relates to: ADR-017 (FHIR-native-first, E12) · E12 (#184, adapters) · E13 PR-2 (#185, SQL aggregation at scale)

> **This epic ships a decision, not a build.** Per the epic body: *"Full transpilation is research-grade;
> this is a decision memo, not a build commitment… No code until the fork is decided."* The recommendation
> below is actionable the moment Doug confirms intent on **Q2**.

## 1. The fork (why this exists)

Doug wrote **"CQL → SQL"** in the charter. WebChart stores clinical data in **MariaDB**, and its existing
quality/report tooling is **hand-written SQL** running inside that engine. WorkWell evaluates measures with
a **CQF/CQL engine in Node** (build-time CQL→ELM, JVM-free). So the architectural question — the biggest
fork in the roadmap (Doug **Q2**) — is:

> Do we **transpile CQL→SQL** so measures run *inside* WebChart's MariaDB report engine, **or** position the
> **CQF/FHIR engine as the replacement** for hand-written SQL reports (data adapted *out* to FHIR), **or** a
> **hybrid** that supports both behind one seam?

This is a memo because getting it wrong is expensive in opposite directions: betting on full CQL→SQL
transpilation is a research project; betting purely on FHIR-native egress may not fit WebChart's
data-gravity / "run where the data lives" reality at population scale.

## 2. Grounding facts (what we already know / have decided)

- **ADR-017 (E12) already chose FHIR-native-first.** WorkWell's adapters feed FHIR bundles to the
  *unchanged* engine; `PatientDataSource` + `resolveDataSource(env)` are the pluggable ingress seam, with an
  inert `webChartDataSource` stub awaiting E12 PR-2 (the real WebChart/MariaDB→FHIR mapping, blocked on
  MIE's schema). So the FHIR-native path is **the default and is partially built**.
- **E13 PR-2 proved SQL-side aggregation scales** — `aggregateScaleRun` does a single `GROUP BY` over
  120k encoded rows, O(providers) memory. That was *aggregation of already-computed outcomes*, not measure
  *evaluation* in SQL — but it demonstrates the team can push set work into the DB when the shape allows.
- **Full CQL→SQL transpilation is genuinely research-grade.** CQL's interval/temporal algebra, FHIRPath
  navigation, terminology/value-set membership, and null-handling (three-valued logic) do not map cleanly
  onto portable SQL. Mature open-source CQL→SQL transpilers do not exist at production fidelity; partial
  subsets do (simple existence/recency measures transpile; complex eCQMs do not).
- **The charter's "rxdb/SQL reality"** must be confirmed with MIE before committing: exactly how WebChart
  exposes clinical data (MariaDB schema, any document/rxdb layer, whether a FHIR façade exists) determines
  what is even feasible. **This is the gating unknown for any build.**

## 3. Options

### Option A — FHIR-native adapter (extend ADR-017)
WebChart MariaDB → FHIR bundles (E12 adapter) → existing CQF/CQL engine in Node. Position the CQF engine as
the replacement for hand-written SQL reports.

- **Pros:** Reuses the entire proven engine; **zero transpilation risk** (one correctness source of truth);
  full eCQM fidelity (any measure that compiles, runs); already the chosen direction and partially built;
  standards-aligned (FHIR/QI-Core, MeasureReport, QRDA all already work).
- **Cons:** **Data egress** — pulls patient data out of WebChart into the engine; doesn't "run where the
  data lives"; at large live populations, materializing FHIR bundles + per-subject evaluation is the cost
  center (E13 PR-2's 120k case sidestepped this by *generating* outcomes, not live-evaluating them); least
  literal fit to Doug's "CQL→SQL" words.

### Option B — CQL→SQL transpile
Compile CQL (or its ELM) to SQL that runs inside WebChart's MariaDB report engine.

- **Pros:** Data **never leaves** WebChart; runs where the data lives; scales with the DB; the most literal
  fit to the charter note and to WebChart's existing SQL-report paradigm; potentially huge throughput for
  simple high-volume measures.
- **Cons:** **Research-grade for general CQL** — temporal/interval semantics, FHIRPath, value-set
  expansion, and 3-valued logic don't port cleanly; realistically only a **constrained measure subset**
  (existence / recency / simple counts) is transpilable; every transpiled measure needs **golden parity**
  vs the FHIR engine to be trustworthy; high build + maintenance + verification cost; ties WorkWell to
  MariaDB SQL dialect specifics.

### Option C — Hybrid: pluggable executors (recommended)
One **`MeasureExecutor` seam** (mirroring the existing `resolveDataSource`/`resolveForecaster`/
`resolveChannel` port pattern): the **FHIR-native engine is the default and the correctness source of
truth**; a **SQL-pushdown executor** is an *opt-in, per-measure* path for the narrow set of measures where
SQL is tractable and volume justifies it — and is **only trusted when it passes golden parity** against the
FHIR engine for that measure.

- **Pros:** Keeps FHIR-native as default/authority (honors ADR-017, no fidelity regression); lets CQL→SQL
  be introduced **incrementally and safely**, one measure at a time, gated by parity; matches the codebase's
  established "port + inert-stub + config-select" idiom; answers Doug's charter intent *without betting the
  project on full transpilation*; the SQL executor can start as an inert stub (like `webChartDataSource`)
  until a concrete measure demands it.
- **Cons:** Two execution paths to maintain; a real **parity-verification burden** for any SQL-pushed
  measure; only pays off if a concrete high-volume WebChart measure actually needs DB-side evaluation —
  otherwise it's latent complexity.

## 4. Recommendation

**Adopt Option C as the decision, but build nothing beyond the seam until two conditions hold:** (1) Doug
confirms on **Q2** that running measures *inside* WebChart (vs. adapting data out to the CQF engine) is a
real product requirement, and (2) a **concrete, high-volume WebChart measure** exists that the FHIR-native
path can't serve economically.

Concretely:

1. **Default = Option A (FHIR-native).** It's already chosen (ADR-017), partially built, and full-fidelity.
   Finish it via E12 PR-2 when MIE's schema lands. This is the path of record.
2. **Record Option C as the architectural decision (a new ADR):** measure execution is pluggable behind a
   `MeasureExecutor` port; FHIR-native is the default and the parity oracle; a SQL-pushdown executor is a
   future opt-in, **per-measure, parity-gated** drop-in. Ship the *decision* and the *seam shape* now; ship
   no transpiler.
3. **Scope CQL→SQL, if ever pursued, to a deliberately narrow subset** — existence/recency/simple-count
   measures (e.g. the OSHA surveillance recency measures) — never general eCQMs. Each transpiled measure
   must pass a golden-parity test vs the FHIR engine before it's allowed to serve.

This honors the charter's "CQL→SQL" intent as a *future capability* without committing the project to a
research-grade transpiler, and it doesn't regress the standards-fidelity work (E3/E14) that depends on the
real CQL engine.

## 5. Why not just A or just B

- **Not pure A:** if MIE's hard requirement is "the quality engine must run inside WebChart at the data,"
  pure egress doesn't satisfy it, and we'd want the door C keeps open.
- **Not pure B:** committing to CQL→SQL as *the* engine throws away the proven CQF path, the standards
  exports (MeasureReport/QRDA/QI-Core), and full eCQM fidelity — to chase a transpiler that can't cover the
  complex measures. Unacceptable risk for the demo and for correctness (ADR-008).

## 6. What this memo does **not** decide (needs MIE / Doug)

- **Q2 confirmation:** is in-WebChart execution a real requirement, or is "CQL→SQL" shorthand for "replace
  our hand-written SQL reports with a measure engine" (which Option A already does)?
- **WebChart data reality:** the actual MariaDB schema + whether any FHIR façade or document/rxdb layer
  exists — the gating feasibility input for *both* A's adapter and B's transpiler. (Same blocker as E12
  PR-2.)
- **Which measures**, if any, have the volume/latency profile that would justify a SQL-pushdown executor.

## 7. Suggested next step (no code)

Take this memo to Doug with the single question framed as: *"Is the goal to run the measure engine **inside
WebChart's database**, or to **replace hand-written SQL reports** with a measure engine fed from WebChart's
data? The first points at a constrained CQL→SQL pushdown; the second is the FHIR-native adapter we're
already building."* His answer collapses the fork. Until then: **default A, decision C, build nothing in
B.**
