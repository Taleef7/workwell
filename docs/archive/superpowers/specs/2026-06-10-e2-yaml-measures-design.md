# E2 — Declarative YAML measures + headless evaluator — Design

- **Date:** 2026-06-10
- **Epic:** #72 (sub-issues #85–#88)
- **Branch:** `feat/e2-yaml-measures`
- **Builds on:** E1 (PR #95, ADR-005) — the `MeasureDefinitionProvider` port and Spring-free engine core
- **Status:** Approved (design); implementation pending plan

## Goal

Answer Doug's most concrete ask — *"programming layer, no UI: given this patient and this YAML file,
are they compliant?"* — by (1) making YAML files the declarative source of measure bindings behind
the existing `MeasureDefinitionProvider` port, and (2) adding a headless, Spring-free CLI that takes
a FHIR Bundle JSON + a measure YAML and prints the compliance bucket + evidence.

## Decisions (approved 2026-06-10)

1. **YAML replaces the hardcoded switch.** `YamlMeasureDefinitionProvider` becomes the default bean;
   `SyntheticMeasureDefinitionProvider` (the 10-case switch) is **deleted** once golden parity holds.
   Single source of truth — the same principle that drove E1's #82. No `yaml|java` fallback flag
   (that would reintroduce dual sources).
2. **Headless entrypoint = plain-Java CLI, no Spring** (run via a Gradle `JavaExec` task). A REST
   endpoint is deferred (YAGNI) — it can be added in minutes later because the CLI core is the same
   `evaluateBundle` engine method.
3. **Minimal schema** — only fields the engine actually reads, plus identity metadata. Population
   logic and bucket thresholds stay in the CQL (`Outcome Status` define), which is already the single
   source of logic. The schema documents an extension path for E3 (MeasureReport, real value-set
   expansion); no dead/aspirational fields now.

## YAML schema (v1)

One file per runnable measure at `backend/src/main/resources/measures/<id>.yaml`, sibling of its
`.cql` file.

```yaml
# audiogram.yaml
id: audiogram                       # required; short slug, matches file stem
name: Audiogram                     # required; EXACT catalog name used by run paths / DB measures.name
version: 1.0.0                      # required
title: Annual Audiogram Completed   # optional display title
policyRef: OSHA 29 CFR 1910.95      # optional
tags: [surveillance, hearing, osha] # optional
cql: audiogram.cql                  # required; sibling CQL file
bindings:                           # required; maps 1:1 onto engine MeasureDefinition
  rateKey: audiogram                # required (synthetic compliance-rate key)
  enrollment: { code: hearing-enrollment, valueSet: "urn:workwell:vs:hearing-enrollment" }   # required
  waiver:     { code: audiogram-waiver,   valueSet: "urn:workwell:vs:audiogram-waiver" }     # required
  event:      { code: audiogram-procedure, valueSet: "urn:workwell:vs:audiogram-procedures",
                type: procedure }   # required; type: procedure | immunization | observation
  complianceWindowDays: 365         # optional; default 365
```

Mapping to `MeasureDefinition`: `event.type: procedure` → `useImmunization=false, observationBased=false`;
`immunization` → `useImmunization=true`; `observation` → `observationBased=true`. This replaces the
two raw booleans with one intent-revealing field; the record itself is unchanged.

Validation (fail fast with file + field in the message): required fields present; `event.type` one of
the three values; `complianceWindowDays` positive integer if present. Unknown top-level keys are
rejected (typo protection).

## Components

### 1. `engine/yaml/YamlMeasureParser` (#85)
Pure SnakeYAML (2.2, already on the runtime classpath via Spring Boot — **no new dependency**).
Parses one YAML document into a small `YamlMeasure` record: metadata (id, name, version, title,
policyRef, tags), `cqlFile`, and the materialized `MeasureDefinition`. No Spring imports. Loads via
`Yaml.load` into `Map<String,Object>` (safe; no arbitrary type instantiation).

### 2. `engine/yaml/YamlMeasureDefinitionProvider` (#86)
Implements the E1 `MeasureDefinitionProvider` port. On construction, loads every
`classpath*:measures/*.yaml` using Spring-core's `PathMatchingResourcePatternResolver` — plain
library code that needs **no ApplicationContext**, so the E1 no-Spring guard discipline holds (the
guard test constructs it with `new`). Indexes by `name` (the exact string callers pass, e.g.
`"Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)"`). Duplicate names → fail fast. `@Component`
(replaces the deleted synthetic provider as the default bean), consistent with how `engine.synthetic`
adapters are wired.

### 3. Engine extension: public `evaluateBundle(...)` (#88 prerequisite)
Extract the inner evaluation of `CqlEvaluationService.evaluateEmployee` (Library/Measure assembly,
`InMemoryFhirRepository`, `R4MeasureProcessor`, expression-result extraction) into a public method:

```java
/** Headless evaluation of an arbitrary FHIR bundle. Returns the normalized outcome bucket
 *  plus the define-level expression results (the evidence core). */
public BundleOutcome evaluateBundle(String measureName, String measureVersion, String cqlText,
                                    LocalDate evaluationDate, Bundle bundle, String subjectId)
// BundleOutcome = record(String subjectId, String outcomeStatus, List<Map<String,Object>> expressionResults)
```

Internally this wraps the same private evaluation core the synthetic path uses (so outcome
normalization/`unwrapExpressionResult` are shared, not duplicated); the synthetic path's own flow and
evidence construction are untouched — behavior identical, enforced by the golden gate. The CLI feeds `evaluateBundle` an **arbitrary** parsed FHIR Bundle.
Headless evidence = `expressionResults` + `Outcome Status` (+ subject id). The synthetic
`why_flagged` block is **not** produced headlessly — it derives from `ExamConfig`, which doesn't
exist for real bundles; documented, not a gap.

### 4. `engine/cli/HeadlessEvaluatorCli` (#88)
Plain `public static void main(String[] args)`:

```
usage: HeadlessEvaluatorCli <patient-bundle.json> <measure.yaml> [--date YYYY-MM-DD]
```

- Bundle parsed with HAPI's JSON parser (`FhirContext.forR4Cached().newJsonParser()`); subject id
  taken from the Bundle's `Patient` resource (error if absent).
- Measure YAML read from the filesystem path; its `cql:` resolved as a sibling file, falling back to
  classpath `measures/<cql>`.
- Constructs the engine exactly like `EngineNoSpringContextTest` (plain `new`, synthetic adapters for
  the unused ports) and calls `evaluateBundle`.
- Prints `{ "subjectId", "measure", "outcome", "evidence" }` JSON to stdout (Jackson, already on
  classpath). Exit codes: 0 success, 1 usage/input error, 2 evaluation error.
- Gradle task in `backend/build.gradle.kts`:
  `./gradlew.bat evaluateMeasure --args="patient.json src/main/resources/measures/audiogram.yaml"`
  (JavaExec on `sourceSets.main.runtimeClasspath`).

### 5. Ten YAML files + deletion of the switch (#87)
All 10 runnable measures expressed as YAML, values copied exactly from the switch. Then the switch
class is deleted and all its construction sites (guard test, golden test, `CqlEvaluationServiceTest`
helper) construct `YamlMeasureDefinitionProvider` instead.

## Data flow

- **App path (unchanged outcomes):** run/caseflow → `CqlEvaluationService.evaluate(...)` →
  `measureDefinitionProvider.forMeasure(name)` (now YAML-backed) → synthetic bundle → CQF → bucket.
- **Headless path (new):** CLI → YAML parser → CQL text → HAPI-parsed Bundle → `evaluateBundle` →
  bucket + evidence JSON on stdout.

## Error handling

- Parser: descriptive `IllegalArgumentException` naming file + field; provider startup fails fast on
  malformed YAML or duplicate `name` (a broken measure file should fail deploy, not silently vanish).
- Unknown measure name at runtime → provider returns `null` → existing engine behavior (empty run /
  "Unsupported measure") is preserved.
- CLI: human-readable error to stderr + nonzero exit; never a stack-trace-only death for usage errors.

## Testing

1. **Golden gate (existing, #87):** `EngineGoldenParityTest` — 100 employees × 10 measures must stay
   byte-identical with the YAML provider in place. This is the acceptance test that YAML == switch.
2. **Parser unit tests (#85):** happy path per event type; missing required field; bad `event.type`;
   unknown key; defaulting of `complianceWindowDays`.
3. **Provider tests (#86):** loads all 10 from classpath; lookup by exact name; null for unknown;
   duplicate-name failure.
4. **No-Spring guard (updated):** `EngineNoSpringContextTest` constructs `YamlMeasureDefinitionProvider`
   with `new` — proves the YAML path also needs no ApplicationContext.
5. **CLI E2E smoke (#88):** invoke `main` (or its testable core) with a temp bundle JSON + the real
   audiogram YAML; assert valid JSON with an expected outcome for a constructed bundle (e.g. recent
   procedure → COMPLIANT). This is the executable proof of "patient + YAML → compliant".

## Commit / PR plan (one PR, small commits)

Branch `feat/e2-yaml-measures`, one PR closing #72 + #85–#88:
1. `feat(engine): YAML measure schema parser (#85)` (TDD: parser tests first)
2. `feat(engine): YamlMeasureDefinitionProvider loading measures/*.yaml (#86)`
3. `feat(engine): 10 measures as YAML; delete hardcoded switch; golden parity (#87)`
4. `refactor(engine): extract public evaluateBundle for arbitrary FHIR bundles`
5. `feat(engine): headless evaluator CLI + gradle evaluateMeasure task (#88)`
6. `docs: ADR-006 + ARCHITECTURE + README CLI demo + JOURNAL`

## Acceptance criteria (epic #72)

- YAML schema documented (this spec + ADR-006); loader validates with clear errors.
- All 10 measures as YAML → golden regression byte-identical; switch deleted.
- `./gradlew.bat evaluateMeasure --args="<bundle.json> <measure.yaml>"` prints bucket + evidence with
  no Spring context and no DB.
- Full backend suite green on CI; live demo unchanged.

## Non-goals (YAGNI)

- No REST endpoint for headless eval (deferred; trivial atop `evaluateBundle`).
- No population-map / bucket-threshold YAML fields (logic stays in CQL until E3 needs otherwise).
- No real value-set expansion (E3 / #90), no MeasureReport (E3 / #89), no schema migrations, no new
  dependencies.
- The 47 Draft CMS catalog entries get no YAML — only the 10 runnable measures.

## Risks & mitigations

- **Name-key mismatch between YAML and callers** → golden test fails loudly (it evaluates by the
  exact catalog names); names copied verbatim from the deleted switch.
- **Classpath scanning inside the Boot fat jar** → `PathMatchingResourcePatternResolver` handles
  `jar:` URLs; CI + a boot-run smoke confirm.
- **Headless evidence differs from app evidence** → intentional and documented (no `ExamConfig`
  headlessly); golden gate only covers the app path, which is unchanged.
- **SnakeYAML loading safety** → plain-`Map` loading only; no custom type instantiation.
