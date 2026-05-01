# Journal

## 2026-04-29

Planning baseline completed in `docs/PROJECT_PLAN.md`; scaffold landed in commit `53e65cf`; spike plan documented in `docs/superpowers/plans/2026-04-29-cqf-fhir-cr-spike.md`; open risks captured around Phase 2 integration depth, Missing Data vs Overdue branching, and AI guardrail enforcement.

## 2026-05-01

### cqf-fhir-cr Risk Spike — COMPLETED

**What changed:** Executed full `R4MeasureService` evaluation spike in `../workwell-spike-cqf/`. CQL measure (`HasRecentProcedure`) evaluated against two synthetic patients in `InMemoryFhirRepository`. Results verified correct: compliant patient numerator=1, non-compliant patient numerator=0. `evaluatedResource` list in MeasureReport traces which Procedure drove the decision.

**Versions confirmed working:**
- `org.opencds.cqf.fhir:cqf-fhir-cr:3.26.0` (latest stable; NOT 4.x — Maven Central UI was misleading)
- `cqf-fhir-cql:3.26.0`, `cqf-fhir-utility:3.26.0` (same version track)
- HAPI FHIR 8.4.0 (transitive — higher than plan expected)

**Plan corrections discovered:**
1. Entry point is `R4MeasureService`, not `R4MeasureProcessor` — simpler constructor, simpler evaluate() signature
2. `org.opencds.cqf.fhir.api.Repository` deprecated → use `ca.uhn.fhir.repository.IRepository`
3. `Library.content.setData()` takes raw bytes (not pre-base64) — double-encoding silently breaks CQL parsing
4. `InMemoryFhirRepository.update()` preserves resource ids; `.create()` assigns new ids and breaks patient lookup
5. Three mandatory runtime extras: `hapi-fhir-caching-caffeine`, `eclipse.persistence.moxy`, `fhirContext.setValidationSupport()`
6. `evaluatedResource` in MeasureReport = free `evidence_json` data — no custom extraction needed

**Bonus finding:** `measureScore` (0.0–1.0) computed automatically for proportion measures.

**Re-run:** `cd ../workwell-spike-cqf && ./gradlew run`

**Why:** De-risk Phase 2 (Week 5–7) before internship. Full findings → `../workwell-spike-cqf/SPIKE_REPORT.md`.

**Risks remaining:**
- HAPI 8.4.0 vs Spring Boot 3.3.5 — check version compat before Week 5 (expect forced resolution needed)
- `cqf-fhir-cr-hapi` (HAPI JPA repository wrapper) not yet tested — 15-min sub-spike before Week 5
- All 4 demo measures not validated — only "has recent Procedure" pattern tested
- Not load-tested at 200+ employees × 4 measures

## 2026-05-18
- What changed:
- Why:
- Verification:
- Risks/next:

### cqf-fhir-cr-hapi Sub-spike - COMPLETED (2026-05-01)

**What changed:** Ran a JPA-path sub-spike in `../workwell-spike-cqf/` to verify `cqf-fhir-cr-hapi` and confirm wiring compatibility with `R4MeasureService`.

**Findings:**
- Maven Central artifact exists: `org.opencds.cqf.fhir:cqf-fhir-cr-hapi` (latest `4.6.0`; `3.26.0` available on same coordinate line).
- On the `3.26.0` line, `RepositoryConfig` constructs `HapiFhirRepository`, and `HapiFhirRepository` implements `ca.uhn.fhir.repository.IRepository`.
- Proof executed on HAPI JPA test harness (`BaseJpaR4Test`) with `HapiFhirRepository` + same `HasRecentProcedure` measure:
  - `patient-with-procedure` numerator=1
  - `patient-without-procedure` numerator=0

**Verification:** `cd ../workwell-spike-cqf && ./gradlew test --tests com.workwell.spike.HapiJpaPathSubSpikeTest`

**Risks/next:**
- No Phase 2 pivot needed for repository interface compatibility.
- Version policy still needs decision before integration (`3.26.0` line vs latest `4.6.0` line).

### CQF reference extraction + ADR-002 define-results probe (2026-05-01)

**What changed:** Added `docs/CQF_FHIR_CR_REFERENCE.md` as a load-bearing Week 5 reference extracted from spike artifacts (`../workwell-spike-cqf/SPIKE_REPORT.md`, `SPIKE_NOTES.md`) and refreshed with current Maven metadata.

**Captured in reference doc:**
- Confirmed coordinates: `org.opencds.cqf.fhir:cqf-fhir-cr` and `org.opencds.cqf.fhir:cqf-fhir-cr-hapi`
- Compatible pin: `3.26.0`; latest noted: `4.6.0`
- Minimal real wiring snippet for `R4MeasureService` + required runtime deps
- 6 plan corrections table (`Plan assumed` vs `Reality`)
- JPA bridge confirmation (`RepositoryConfig` -> `HapiFhirRepository implements IRepository`)
- Exact classpath gotcha symptom and exact dependency exclusion fix

**ADR-002 probe result (important):**
- `R4MeasureService.evaluate(...)` alone does not expose a define map on `MeasureReport`.
- `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` exposes per-subject `EvaluationResult.expressionResults` (define/value pairs).
- Probe output included:
  - `EXPR_KEYS=[Denominator, Initial Population, Numerator, Patient]`
  - `EXPR_VALUE=Numerator => true`

**Why:** Prevent Week 5 re-discovery churn, especially the model-provider classpath conflict and evidence-shape uncertainty.

### ADR-002 dual-evaluation cost probe (2026-05-01)

**What changed:** Ran a focused sub-spike in `../workwell-spike-cqf/` to answer whether `MeasureReport` and define-level `expressionResults` can be produced in one call, or if this implies double evaluation cost.

**Verified behavior (`cqf-fhir-cr:3.26.0`):**
- `R4MeasureService.evaluate(...)` returns only `MeasureReport`.
- `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` returns only `CompositeEvaluationResultsPerMeasure`.
- No single public method returns both artifacts together.

**Important nuance (cost):**
- Processor path can still avoid a second full CQL execution:
  1. `evaluateMeasureWithCqlEngine(...)` (heavy eval, yields expression map)
  2. `evaluateMeasure(..., compositeResults)` (report materialization from captured results)
- Rough single-patient timing from probe test:
  - `serviceEvaluateMs=5`
  - `engineEvalMs=2`
  - `reportBuildFromCompositeMs=0`

**Evidence artifact:** `../workwell-spike-cqf/src/test/java/com/workwell/spike/DualEvaluationCostSubSpikeTest.java` and `../workwell-spike-cqf/SPIKE_REPORT.md` section `Sub-spike: dual-evaluation cost`.

**Decision impact:** ADR-002 remains **Proposed** for now (not one-call-both). Week 5 can choose simpler `R4MeasureService` baseline or processor two-step path based on real run-load context.
- 2026-05-01: ADR-002 promoted to **Accepted** with composite two-step pipeline as canonical; Project Plan risk marked closed and Why Flagged scope updated to structured-first, AI-optional.
- 2026-05-01: Brief B/C reconciliation applied to scaffold and docs (backend/infra/frontend deltas plus ARCHITECTURE, DATA_MODEL, AI_GUARDRAILS, and ADR-001 alignment updates).
