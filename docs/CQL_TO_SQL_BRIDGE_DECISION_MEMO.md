# CQL → SQL Bridge — Decision Memo (E9 / #78)

- Date: 2026-06-19
- Epic: #78 (E9 — CQL→SQL bridge, Wave 3, **spike / decision memo only**)
- Status: **Decision memo — not a build commitment.** Frames the architectural fork for the
  maintainer + Doug (charter **Q2**). No code is proposed by this epic; the actual decision is
  Doug's and gated on the answers in §7.
- Audience: Doug (charter author) + the WorkWell maintainer.

## 1. The question

Doug wrote **"CQL → SQL"** in the harmonization charter. That phrase hides the single biggest
architectural fork in the WorkWell↔WebChart story (charter **Q2**):

> Do we **transpile CQL→SQL** so measures run *inside* WebChart's MariaDB report engine, **or** do we
> position the CQF/FHIR engine (what WorkWell already runs) as the replacement for hand-written SQL
> reports — **or** a hybrid of the two?

This memo lays out the three options, grounds them in the current reality on both sides, recommends a
direction, and ends with the concrete questions Doug must answer before any code is written.

## 2. The reality on both sides (so the options are grounded, not abstract)

**WebChart / WebChart-side reporting (the target):**
- WebChart runs on **MariaDB**; today's quality/surveillance reports are **hand-written SQL** against
  that operational schema. This is the "SQL reality" the charter refers to. Reports are authored and
  maintained per-measure by hand — exactly the cost CQL is meant to remove (author once in a
  standard language, run everywhere).
- MariaDB is a **transactional row-store**, not an analytics engine. It has no columnar/extension
  ecosystem comparable to Spark/Databricks/BigQuery, which matters a lot for option B below.

**WorkWell (what exists today):**
- A **FHIR-native, JVM-free CQL engine**: build-time CQL→ELM (`@cqframework/cql`, no JVM), executed
  by `cql-execution` + `cql-exec-fhir` over in-memory FHIR R4 bundles
  (`backend-ts/src/engine/cql/`).
- A **ports/adapters seam from E1 (ADR-005).** ADR-005's port *names* (`PatientDataProvider`,
  `EmployeeDirectory`, …) are Java-era; in the current TypeScript backend the concrete seam is the
  **data-bundle builder + engine binding**: the run pipeline calls
  `buildSyntheticBundle(employee, config, date)` (`backend-ts/src/engine/synthetic/fhir-bundle-builder.ts`,
  invoked at `run-pipeline.ts:201`) to produce an in-memory FHIR R4 bundle, then hands it to
  `engine.evaluate({ measureId, patientBundle, evaluationDate })` (the `EvaluateMeasureBinding`
  contract, `backend-ts/src/engine/evaluate-measure.ts`). The engine does **not** care where the
  bundle came from — today a synthetic builder; a **WebChart adapter that reads MariaDB and emits the
  same FHIR bundle shape is a drop-in replacement for that one call.** This is the pre-built hook for
  any WebChart integration.
- Declarative measure bindings as YAML (ADR-006) + a value-set resolver seam (E3.2).

**State of the art for CQL→SQL (researched, 2026-06):**
- **SQL-on-FHIR v2 (`ViewDefinition`)** — an HL7 spec that projects FHIR resources into **flat
  tabular SQL views** via FHIRPath. Mature: a 2025 *npj Digital Medicine* paper, and **multiple
  independent implementations across different platforms** (e.g. Aidbox, Pathling, and others — see
  the paper + the IG's implementer list). CQL/measure logic can be layered on top of these views.
  Deliberately constrained (≈FHIRPath-level), which is *why* it's portable. It presupposes a FHIR
  representation of the data.
- **CQL→SQL transpilers exist but are research-grade.** The most concrete is the **VA `cql-transpiler`**
  (`department-of-veterans-affairs/cql-transpiler`): it lowers **ELM → DBT/Jinja macros → a SQL
  dialect**. It currently supports **Azure Databricks SQL only, and only partially.** More broadly,
  the analytics-engine ecosystem where CQL and SQL-adjacent FHIR tooling is most mature (Cerner
  HealtheDataLab runs CQL on Spark clusters; Pathling is a Spark engine that *implements* SQL-on-FHIR
  v2 ViewDefinitions) targets **Spark/Hive/Databricks** — the substrate that tooling was built for —
  **not transactional MariaDB.** No production-grade CQL→MariaDB transpiler exists.

Sources: SQL-on-FHIR v2 IG (https://build.fhir.org/ig/FHIR/sql-on-fhir-v2/), npj Digital Medicine 2025
(https://www.nature.com/articles/s41746-025-01708-w), VA cql-transpiler
(https://github.com/department-of-veterans-affairs/cql-transpiler), cqframework/clinical_quality_language
(https://github.com/cqframework/clinical_quality_language).

## 3. Option A — FHIR-native adapter (CQF engine as the report engine)

Keep WorkWell's CQL/ELM engine as the execution engine. Integrate with WebChart by writing a **real
data adapter that replaces `buildSyntheticBundle`** (§2) — reading WebChart's MariaDB and emitting the
same FHIR R4 bundle the engine already consumes via `engine.evaluate(...)`. Measures author once in
CQL; WorkWell (not MariaDB) executes them; results flow back to WebChart.

- **Pros:** Reuses everything already built (E1 ports, JVM-free engine, YAML bindings, value-set
  resolver). Full CQL semantic fidelity (the reference engine runs the real ELM). Lowest
  build risk — it's an adapter, not a compiler. Standards-aligned (FHIR + CQL end to end).
- **Cons:** Execution lives **outside** MariaDB — WebChart calls out to the WorkWell engine rather
  than running a SQL report in-process. Per-subject in-memory evaluation doesn't match a set-based
  SQL report engine's performance model at large population scale. Requires a FHIR mapping of
  WebChart data (one-time adapter cost; the mapping is the real work).

## 4. Option B — CQL→SQL transpile (measures run inside MariaDB)

Transpile CQL (via ELM) into SQL that runs **inside WebChart's MariaDB report engine**, so a measure
becomes "just another SQL report."

- **Pros:** Matches the charter's literal phrasing and WebChart's existing report model; execution is
  in-database (no external engine call); set-based performance for large populations.
- **Cons:** **This is the research-grade, high-risk path.** The only concrete transpiler (VA) targets
  **Databricks, partially**; the field targets **analytics engines, not MariaDB**. A CQL→MariaDB
  transpiler would be a **net-new, from-scratch compiler** for a long tail of CQL semantics
  (temporal interval math, terminology/value-set membership, null/uncertainty semantics, nested
  queries) that don't lower cleanly to MariaDB SQL. High maintenance burden, divergence risk from the
  reference engine (two implementations of measure semantics = two answers), and MariaDB lacks the
  analytic primitives the existing transpilers lean on. **Not recommended as a wholesale path.**

## 5. Option C — Hybrid / pluggable executors (recommended shape)

Keep **CQL authoring + ELM + the FHIR-native engine as the single source of truth** for measure
*semantics*, and treat the **execution backend as a pluggable port** (WorkWell already has the seam).
Two executors coexist, selected per deployment/report:
1. **FHIR-native executor** (Option A) — the default, full-fidelity path; the compliance authority.
2. **A bounded SQL path for the specific reports that must live in MariaDB** — built on **SQL-on-FHIR
   v2 `ViewDefinition`s** (a standardized FHIR→tabular-SQL layer) rather than a bespoke CQL→MariaDB
   compiler. WebChart data is exposed as FHIR-shaped views; the report SQL runs over those views.

- **Pros:** Reuses the E1 seam; keeps one canonical semantics (the CQL/ELM engine) so the two paths
  can be **cross-checked** (the FHIR-native result is the oracle for the SQL path — the same
  golden-parity discipline E3.2 already used for value-set expansion). Lets the charter's "runs in the
  report engine" goal be met **incrementally, for the reports that need it**, without betting the
  program on a from-scratch CQL→MariaDB compiler. Standards-aligned (SQL-on-FHIR v2 is an HL7 spec
  with 8 implementations).
- **Cons:** Two execution paths to keep in parity (mitigated by golden cross-checks). SQL-on-FHIR v2
  still presupposes a FHIR view over WebChart data (same mapping cost as Option A) and is more
  constrained than full CQL (some measures won't lower; those stay FHIR-native-only).

## 6. Recommendation

**Adopt Option C, FHIR-native-first.** Concretely:
1. **Near-term integration = Option A:** implement a real WebChart data adapter (the drop-in
   replacement for `buildSyntheticBundle` feeding `engine.evaluate`, §2/§3) so measures run on real
   data through the existing engine. This is the lowest-risk, highest-reuse step and unblocks
   everything else. It is the path WorkWell's whole architecture (E1) was built for.
2. **Treat "CQL→SQL" as a bounded, opt-in second executor — via SQL-on-FHIR v2, not a bespoke
   transpiler.** Only the specific high-volume reports that *must* execute inside MariaDB get a
   `ViewDefinition`-based SQL path, with the FHIR-native engine as the parity oracle. **Do not** commit
   to a wholesale CQL→MariaDB transpiler (Option B) — the tooling is research-grade, MariaDB is the
   wrong execution substrate for it, and a second semantics implementation is a correctness liability.
3. **Revisit Option B only if** Doug's answers (§7) establish a hard requirement that *all* measures
   execute in-database in MariaDB at a scale the FHIR-native engine can't serve — in which case the
   honest scope is "fund a research project," not "ship a feature."

This keeps the program on its proven ports/adapters trajectory, honors the charter's intent (one
CQL authoring surface; measures *can* reach the report engine) without over-committing to the
riskiest interpretation of "CQL→SQL," and preserves a single canonical semantics.

## 7. Open questions for Doug (gate the fork — no code until these are answered)

1. **Execution locus:** does a measure *have* to run **inside MariaDB** (in-process SQL report), or is
   WebChart **calling out** to the WorkWell/CQF engine and ingesting results acceptable? (A vs the SQL
   side of C.)
2. **FHIR facade:** does WebChart already expose (or plan) a **FHIR API/representation** of its
   MariaDB data? If yes, both A and the SQL-on-FHIR path get much cheaper; if no, the FHIR mapping is
   the real cost on every option.
3. **Scope of "reports":** which reports must be SQL-native and at what **population scale / latency**?
   This determines whether any SQL path is even needed beyond the FHIR-native engine.
4. **"rxdb/SQL" reference:** what exactly does the charter's "rxdb" point to — a reporting replica, a
   specific WebChart reporting schema, or something else? It changes the adapter target.
5. **Acceptable substrate:** is a **separate analytics store** (where mature CQL→SQL tooling actually
   lives — Spark/Databricks) on the table, or is MariaDB a hard constraint? (If a separate store is
   acceptable, Option B's tooling becomes viable; against MariaDB it does not.)

## 8. What this epic delivers (and doesn't)

- **Delivers:** this memo — the framed fork + a recommendation + the questions that unblock Doug Q2.
- **Does not deliver:** any transpiler, adapter, or endpoint. Per #78 this is **spike / decision-memo
  only**; implementation waits on the §7 answers. When the fork is decided, the chosen path becomes a
  normal epic (brainstorm → spec → plan → build) and an ADR records the decision.
