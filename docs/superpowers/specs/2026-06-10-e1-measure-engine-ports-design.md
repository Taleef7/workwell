# E1 — Reusable measure engine (ports/adapters) — Design

- **Date:** 2026-06-10
- **Epic:** #71 (sub-issues #79–#84)
- **Branch:** `feat/e1-measure-engine-ports`
- **Status:** Approved (design); implementation pending plan

## Goal

Make the CQL measure-evaluation core depend on **interfaces (ports)** for its inputs — patient
data, the subject directory, measure definitions, and evaluation config — instead of hard-wired
synthetic classes. The current synthetic demo becomes the **default adapter** behind those ports,
preserved unchanged. This is the seam every later epic (real FHIR data, YAML measures, outreach)
plugs into without a rewrite. See `docs/PLAN.md` principle 5.

## Non-goals (YAGNI)

- No new Gradle module. *(Decision 1 — same module + a no-Spring guard test.)*
- No `OutreachChannel` port yet — deferred to E5 where it has a real consumer. *(Decision 2.)*
- No rename of `DemoOutcome` / `DemoRunPayload` (avoid churn across 4 caller services).
- No YAML measure format — that is E2 (#72). E1 only collapses the spec duplication behind one port.
- No schema migrations. A DB-backed `EmployeeDirectory` is a *future* adapter; if it ever needs
  schema, that is stop-and-ask (Taleef-owned).

## Key realization

`CqlEvaluationService` is **already Spring-free and DB-free to construct** — existing tests do
`new CqlEvaluationService(new EvaluationPopulationProperties())` with no application context, no
JdbcTemplate, no `@Autowired` fields. The real couplings to break are exactly three:

1. `compile/CqlEvaluationService.java:48` — `new SyntheticFhirBundleBuilder()` hard-instantiated.
2. Static `SyntheticEmployeeCatalog.byId()` / `.allEmployees()` calls.
3. Measure spec bindings duplicated in `CqlEvaluationService.measureSeedSpecFor()` (~L486–594) and
   `MeasureService.ensure*Seed()`.

So E1 is a **surgical dependency-inversion refactor**, not a large extraction.

## Decisions (approved)

1. **Same Gradle module**, isolate the core in a `com.workwell.engine` package tree with **no Spring
   imports**, proven by a `EngineNoSpringContextTest` that constructs and runs the engine with plain
   `new` + synthetic adapters (no `ApplicationContext`). Rationale: matches CLAUDE.md "one app,
   modular packages — no microservices"; keeps CI sharding, Docker build, and the OneDrive
   binary-results workaround untouched; future extraction to a `:engine` module stays mechanical.
2. **Four ports now** (`PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`,
   `EvaluationConfigProvider`); `OutreachChannel` deferred to E5.

## Architecture

### Package layout (single module)
```
com.workwell.engine
  ├─ port/
  │    PatientDataProvider          bundleFor(EmployeeProfile, ExamConfig, LocalDate) -> Bundle
  │    EmployeeDirectory            allEmployees() -> List<EmployeeProfile>; byId(String)
  │    MeasureDefinitionProvider    forMeasure(String measureName) -> MeasureDefinition (nullable)
  │    EvaluationConfigProvider     complianceRate(String rateKey) -> double
  └─ synthetic/
       SyntheticPatientDataProvider        (wraps today's SyntheticFhirBundleBuilder logic)
       SyntheticEmployeeDirectory          (wraps today's SyntheticEmployeeCatalog list)
       SyntheticMeasureDefinitionProvider  (the measureSeedSpecFor() switch -> one place)
       PropertiesEvaluationConfigProvider  (wraps EvaluationPopulationProperties)
```

- `MeasureDefinition` is the neutral record that today's private `MeasureSeedSpec` becomes (rateKey,
  enrollment/waiver/exam codes + value sets, compliance window, useImmunization, observationBased).
  It moves to `engine.port` (or a shared `engine.model`) as the single source of truth.
- The **staged-distribution logic** (`seededInputsFor` / `seededInputFor` / target-outcome →
  `ExamConfig`) is demo-shaping concern and moves **into `SyntheticPatientDataProvider`** (or a
  helper it owns), out of the engine core. A real adapter will simply return real data and let the
  engine compute whatever it computes.

### Engine core
`CqlEvaluationService` keeps its algorithm (CQL→ELM compile, FHIR Library/Measure assembly,
`InMemoryFhirRepository`, `R4MeasureProcessor`, `Outcome Status` → bucket, evidence build). Its
constructor changes from `(EvaluationPopulationProperties)` to the **four ports**. No Spring
annotations required on the core; wiring lives in a `@Configuration`.

### Spring wiring (default = synthetic)
A `@Configuration` (e.g. `EngineConfig`) declares the four synthetic adapters as the default beans
and constructs `CqlEvaluationService` from them. `EvaluationPopulationProperties` remains the
`@ConfigurationProperties` source consumed by `PropertiesEvaluationConfigProvider`. A future real
adapter is added as an alternative bean selected by config/profile; the synthetic beans stay the
default so the live TWH demo is unchanged.

### Callers — unaffected
`AllProgramsRunService`, `CaseFlowService`, `MeasureImpactPreviewService`,
`SeedHistoricalRunsService` all inject `CqlEvaluationService` by type and call `evaluate(...)` /
`evaluateSubject(...)`. Those signatures are unchanged, so callers need **no edits**.

## Data flow (outcomes identical to today)
`EmployeeDirectory.allEmployees()` → order/seed via the synthetic adapter →
`PatientDataProvider.bundleFor(employee, examConfig, date)` → CQF evaluate →
`Outcome Status` define → bucket + `evidence_json`. Only the *source* of employees/bundle/spec is now
an interface.

## Testing strategy

1. **Characterization (golden-file) tests first** — before refactoring, capture today's exact output
   (outcome status + `evidence_json` `expressionResults`/`why_flagged` keys and values) for all 100
   employees × the 10 runnable measures into committed golden fixtures, asserted by a test. The
   existing `CqlEvaluationServiceTest` is the seed. This is the regression baseline reused by E2.
2. **No-Spring guard test** — `EngineNoSpringContextTest` constructs the engine with plain `new`
   wiring of the synthetic adapters and runs a full evaluation, asserting it works with no
   `ApplicationContext`. Satisfies sub-issue #83 acceptance without a separate module.
3. **Existing suite** — all 239 backend tests stay green; the two `evaluate`/`evaluateSubject`
   signatures and `evidence_json` shape are unchanged.

## Commit / PR plan (one PR, many small commits)

Branch `feat/e1-measure-engine-ports`, one PR closing #71 + #79–#84. Commit sequence:
1. `test(engine): golden-file characterization baseline for current outcomes` (#84, pre-refactor)
2. `feat(engine): introduce PatientDataProvider/EmployeeDirectory/MeasureDefinitionProvider/EvaluationConfigProvider ports` (#79)
3. `refactor(engine): SyntheticPatientDataProvider, inject into CqlEvaluationService` (#80)
4. `refactor(engine): SyntheticEmployeeDirectory behind EmployeeDirectory port` (#81)
5. `refactor(engine): single MeasureDefinitionProvider, remove spec duplication` (#82)
6. `refactor(engine): Spring-free core wiring + EngineNoSpringContextTest` (#83)
7. `test(engine): assert golden parity post-refactor + adapter config switch` (#84)
8. `docs(architecture,decisions): engine ports/adapters + ADR`

Splitting into 6 separate PRs would create intermediate states with duplicated/partial wiring, so a
single cohesive PR is correct here; commit granularity preserves reviewability.

## Acceptance criteria (epic #71)

- Engine core compiles + a test runs it with **no Spring context**.
- Golden-file parity: 100 employees × 10 measures byte-identical to pre-refactor output.
- All 239 backend tests green; CI green.
- Demo path (`twh.os.mieweb.org`) behavior unchanged (synthetic adapter is the default).
- Affected docs updated in the same PR (ARCHITECTURE module boundaries; ADR in DECISIONS).

## Risks & mitigations

- **Hidden behavioral drift during refactor** → golden-file baseline committed *before* any change;
  any diff fails the build.
- **`MeasureDefinition` move changes evidence ordering** (LinkedHashMap iteration) → keep insertion
  order identical; golden test asserts `expressionResults` list equality, which would catch it.
- **`@ConfigurationProperties` binding** → `PropertiesEvaluationConfigProvider` wraps the existing
  bean; no property keys change (`workwell.evaluation.compliance-rates`).
- **Scope creep into E2/rename** → explicitly out of scope here.
