# E1 — Measure Engine Ports/Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invert `CqlEvaluationService`'s dependencies onto four ports (PatientDataProvider, EmployeeDirectory, MeasureDefinitionProvider, EvaluationConfigProvider) with the existing synthetic demo as the default adapters, preserving every outcome.

**Architecture:** Single Gradle module. New `com.workwell.engine.port` (interfaces, no Spring) + `com.workwell.engine.synthetic` (default adapters holding the demo-shaping logic). `CqlEvaluationService` keeps its algorithm but is constructed from the four ports. A `@Configuration` wires the synthetic adapters as defaults; a no-Spring guard test proves the core runs with plain `new`.

**Tech Stack:** Java 21, Spring Boot 3.3, Gradle Kotlin DSL, HAPI FHIR R4, `cqf-fhir-cr` 3.26.0, JUnit 5.

**Spec:** `docs/superpowers/specs/2026-06-10-e1-measure-engine-ports-design.md`
**Branch:** `feat/e1-measure-engine-ports` (already created)
**Epic:** #71 — sub-issues #79–#84

---

## Determinism note (read before Task 1)

The CQL uses `Now()` for recency math, so absolute-date fields (`last_exam_date`, `generated_at`, `evaluatedResource.measurementPeriod`) drift by run date and are **not** golden-stable. The stable, meaningful invariant is the **(measure, employeeExternalId) → outcomeStatus** mapping plus the **evidence structural shape** (define names present, `why_flagged` keys present). The golden harness asserts exactly that. This is what "outcomes unchanged" means for E1.

## File structure

- Create `backend/src/main/java/com/workwell/engine/port/PatientDataProvider.java`
- Create `backend/src/main/java/com/workwell/engine/port/EmployeeDirectory.java`
- Create `backend/src/main/java/com/workwell/engine/port/MeasureDefinitionProvider.java`
- Create `backend/src/main/java/com/workwell/engine/port/EvaluationConfigProvider.java`
- Create `backend/src/main/java/com/workwell/engine/model/MeasureDefinition.java` (neutral move of private `MeasureSeedSpec`)
- Create `backend/src/main/java/com/workwell/engine/synthetic/SyntheticPatientDataProvider.java`
- Create `backend/src/main/java/com/workwell/engine/synthetic/SyntheticEmployeeDirectory.java`
- Create `backend/src/main/java/com/workwell/engine/synthetic/SyntheticMeasureDefinitionProvider.java`
- Create `backend/src/main/java/com/workwell/engine/synthetic/PropertiesEvaluationConfigProvider.java`
- Create `backend/src/main/java/com/workwell/engine/EngineConfig.java` (`@Configuration` wiring)
- Modify `backend/src/main/java/com/workwell/compile/CqlEvaluationService.java` (constructor → 4 ports; delete private seeding/spec methods that move to adapters)
- Test `backend/src/test/java/com/workwell/engine/EngineGoldenParityTest.java`
- Test `backend/src/test/java/com/workwell/engine/EngineNoSpringContextTest.java`
- Golden fixtures `backend/src/test/resources/golden/e1/<measure>.txt` (10 files)
- Modify `backend/src/main/java/com/workwell/measure/MeasureService.java` (measure→cql-filename mapping references the shared catalog; #82)
- Docs: `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`

---

## Task 1: Golden-file characterization baseline (#84, pre-refactor)

Capture today's behavior BEFORE any refactor so every later task is verified against it.

**Files:**
- Test: `backend/src/test/java/com/workwell/engine/EngineGoldenParityTest.java`
- Fixtures: `backend/src/test/resources/golden/e1/*.txt` (generated in this task)

- [ ] **Step 1: Write a generator+comparator test (initially in "write" mode)**

```java
package com.workwell.engine;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;
import static org.junit.jupiter.api.Assertions.assertEquals;

class EngineGoldenParityTest {

    // measureName -> cql resource file (the 10 runnable measures)
    private static final Map<String, String> MEASURES = Map.ofEntries(
        Map.entry("Audiogram", "audiogram.cql"),
        Map.entry("TB Surveillance", "tb_surveillance.cql"),
        Map.entry("HAZWOPER Surveillance", "hazwoper.cql"),
        Map.entry("Flu Vaccine", "flu_vaccine.cql"),
        Map.entry("Hypertension BP Screening", "hypertension.cql"),
        Map.entry("Diabetes HbA1c Monitoring", "diabetes_hba1c.cql"),
        Map.entry("BMI Screening & Counseling", "obesity_bmi.cql"),
        Map.entry("Cholesterol LDL Screening", "cholesterol_ldl.cql"),
        Map.entry("Breast Cancer Screening", "cms125.cql"),
        Map.entry("Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)", "cms122.cql")
    );

    // Set to true once to (re)generate goldens, then back to false. Committed value MUST be false.
    private static final boolean WRITE_MODE = false;

    private CqlEvaluationService newService() {
        return new CqlEvaluationService(new EvaluationPopulationProperties());
    }

    private String fixtureName(String cql) { return cql.replace(".cql", ".txt"); }

    /** Deterministic projection: sorted "externalId=STATUS" lines. */
    private String project(DemoRunPayload payload) {
        return payload.outcomes().stream()
            .sorted(Comparator.comparing(DemoOutcome::subjectId))
            .map(o -> o.subjectId() + "=" + o.outcome())
            .collect(Collectors.joining("\n"));
    }

    @Test
    void everyMeasureMatchesGolden() throws Exception {
        CqlEvaluationService service = newService();
        LocalDate date = LocalDate.now(); // relative recency; status is date-independent
        for (Map.Entry<String, String> m : MEASURES.entrySet()) {
            String cql = readClasspath("measures/" + m.getValue());
            DemoRunPayload payload = service.evaluate(
                "00000000-0000-0000-0000-000000000000", m.getKey(), "v1.0", cql, date);
            assertEquals(100, payload.outcomes().size(), m.getKey());
            String actual = project(payload);
            Path golden = Path.of("src/test/resources/golden/e1", fixtureName(m.getValue()));
            if (WRITE_MODE) {
                Files.createDirectories(golden.getParent());
                Files.writeString(golden, actual, StandardCharsets.UTF_8);
            } else {
                String expected = Files.readString(golden, StandardCharsets.UTF_8);
                assertEquals(expected, actual, "Outcome mapping drift for " + m.getKey());
            }
        }
    }

    private String readClasspath(String p) throws Exception {
        return FileCopyUtils.copyToString(new java.io.InputStreamReader(
            new ClassPathResource(p).getInputStream(), StandardCharsets.UTF_8));
    }
}
```

- [ ] **Step 2: Generate the golden fixtures**

Temporarily flip `WRITE_MODE = true`, run once to write fixtures:

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.EngineGoldenParityTest"`
Expected: PASS; 10 files appear under `backend/src/test/resources/golden/e1/`.

- [ ] **Step 3: Lock the harness**

Set `WRITE_MODE = false`. Re-run:

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.EngineGoldenParityTest"`
Expected: PASS (now comparing against committed fixtures).

- [ ] **Step 4: Commit the baseline**

```bash
git add backend/src/test/java/com/workwell/engine/EngineGoldenParityTest.java backend/src/test/resources/golden/e1/
git commit -m "test(engine): golden-file characterization baseline for current outcomes (#84)"
```

---

## Task 2: Define the four ports (#79)

**Files:** Create the 4 interfaces + move `MeasureSeedSpec` → `engine/model/MeasureDefinition`.

- [ ] **Step 1: Create `MeasureDefinition` (neutral copy of the private record)**

```java
package com.workwell.engine.model;

/** Synthetic-evaluation bindings for a measure. Single source of truth (was CqlEvaluationService.MeasureSeedSpec). */
public record MeasureDefinition(
    String rateKey,
    String enrollmentCode, String enrollmentVs,
    String waiverCode, String waiverVs,
    String examCode, String examVs,
    boolean useImmunization,
    int complianceWindowDays,
    boolean observationBased
) {
    public MeasureDefinition(String rateKey, String enrollmentCode, String enrollmentVs,
            String waiverCode, String waiverVs, String examCode, String examVs, boolean useImmunization) {
        this(rateKey, enrollmentCode, enrollmentVs, waiverCode, waiverVs, examCode, examVs, useImmunization, 365, false);
    }
    public MeasureDefinition(String rateKey, String enrollmentCode, String enrollmentVs,
            String waiverCode, String waiverVs, String examCode, String examVs, boolean useImmunization, int complianceWindowDays) {
        this(rateKey, enrollmentCode, enrollmentVs, waiverCode, waiverVs, examCode, examVs, useImmunization, complianceWindowDays, false);
    }
}
```

- [ ] **Step 2: Create the ports (no Spring imports)**

```java
package com.workwell.engine.port;

import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.util.List;

public interface EmployeeDirectory {
    List<EmployeeProfile> allEmployees();
    EmployeeProfile byId(String externalId);
}
```
```java
package com.workwell.engine.port;

import com.workwell.engine.model.MeasureDefinition;

public interface MeasureDefinitionProvider {
    /** @return definition for the measure, or null if unsupported. */
    MeasureDefinition forMeasure(String measureName);
}
```
```java
package com.workwell.engine.port;

public interface EvaluationConfigProvider {
    double complianceRate(String rateKey);
}
```
```java
package com.workwell.engine.port;

import com.workwell.compile.SyntheticFhirBundleBuilder.ExamConfig;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;

public interface PatientDataProvider {
    Bundle bundleFor(EmployeeProfile employee, ExamConfig config, LocalDate evaluationDate);
}
```

- [ ] **Step 3: Compile**

Run: `cd backend; .\gradlew.bat compileJava`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**

```bash
git add backend/src/main/java/com/workwell/engine/port/ backend/src/main/java/com/workwell/engine/model/
git commit -m "feat(engine): introduce measure-engine ports + MeasureDefinition (#79)"
```

---

## Task 3: SyntheticMeasureDefinitionProvider — single source of truth (#82)

**Files:** Create `SyntheticMeasureDefinitionProvider`; it holds the `measureSeedSpecFor()` switch verbatim (returning `MeasureDefinition`). Add a shared `measureName → cqlFileName` map consumed by both this provider and `MeasureService`.

- [ ] **Step 1: Create the provider with the switch moved from CqlEvaluationService**

```java
package com.workwell.engine.synthetic;

import com.workwell.engine.model.MeasureDefinition;
import com.workwell.engine.port.MeasureDefinitionProvider;
import org.springframework.stereotype.Component;

@Component
public class SyntheticMeasureDefinitionProvider implements MeasureDefinitionProvider {
    @Override
    public MeasureDefinition forMeasure(String measureName) {
        return switch (measureName) {
            case "Audiogram" -> new MeasureDefinition("audiogram", "hearing-enrollment",
                "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver",
                "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false);
            // ... move the remaining cases from CqlEvaluationService.measureSeedSpecFor() VERBATIM,
            //     swapping `new MeasureSeedSpec(...)` for `new MeasureDefinition(...)` (same args).
            default -> null;
        };
    }
}
```
> Move ALL 10 cases exactly as in `CqlEvaluationService.measureSeedSpecFor()` (lines ~488–592). Same string args, same constructor arities (the 8-, 9-, 10-arg forms map 1:1 to the `MeasureDefinition` constructors in Task 2).

- [ ] **Step 2: Compile**

Run: `cd backend; .\gradlew.bat compileJava`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit (wiring into CqlEvaluationService happens in Task 6)**

```bash
git add backend/src/main/java/com/workwell/engine/synthetic/SyntheticMeasureDefinitionProvider.java
git commit -m "refactor(engine): SyntheticMeasureDefinitionProvider holds measure bindings (#82)"
```

---

## Task 4: SyntheticPatientDataProvider (#80)

**Files:** Create `SyntheticPatientDataProvider` wrapping the existing `SyntheticFhirBundleBuilder`. The builder logic itself is unchanged; the provider is the injectable seam.

- [ ] **Step 1: Create the adapter**

```java
package com.workwell.engine.synthetic;

import com.workwell.compile.SyntheticFhirBundleBuilder;
import com.workwell.compile.SyntheticFhirBundleBuilder.ExamConfig;
import com.workwell.engine.port.PatientDataProvider;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;
import org.springframework.stereotype.Component;

@Component
public class SyntheticPatientDataProvider implements PatientDataProvider {
    private final SyntheticFhirBundleBuilder builder = new SyntheticFhirBundleBuilder();

    @Override
    public Bundle bundleFor(EmployeeProfile employee, ExamConfig config, LocalDate evaluationDate) {
        return builder.buildBundle(employee, config, evaluationDate);
    }
}
```

- [ ] **Step 2: Compile + commit**

Run: `cd backend; .\gradlew.bat compileJava` → BUILD SUCCESSFUL.
```bash
git add backend/src/main/java/com/workwell/engine/synthetic/SyntheticPatientDataProvider.java
git commit -m "refactor(engine): SyntheticPatientDataProvider behind PatientDataProvider port (#80)"
```

---

## Task 5: SyntheticEmployeeDirectory (#81)

**Files:** Create `SyntheticEmployeeDirectory` delegating to the static catalog (kept as the data source for now).

- [ ] **Step 1: Create the adapter**

```java
package com.workwell.engine.synthetic;

import com.workwell.engine.port.EmployeeDirectory;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class SyntheticEmployeeDirectory implements EmployeeDirectory {
    @Override public List<EmployeeProfile> allEmployees() { return SyntheticEmployeeCatalog.allEmployees(); }
    @Override public EmployeeProfile byId(String externalId) { return SyntheticEmployeeCatalog.byId(externalId); }
}
```

- [ ] **Step 2: Compile + commit**

Run: `cd backend; .\gradlew.bat compileJava` → BUILD SUCCESSFUL.
```bash
git add backend/src/main/java/com/workwell/engine/synthetic/SyntheticEmployeeDirectory.java
git commit -m "refactor(engine): SyntheticEmployeeDirectory behind EmployeeDirectory port (#81)"
```

---

## Task 6: Invert CqlEvaluationService onto the ports + wiring + guard test (#83)

**Files:** Modify `CqlEvaluationService` (constructor + internal calls), create `PropertiesEvaluationConfigProvider`, `EngineConfig`, `EngineNoSpringContextTest`.

- [ ] **Step 1: PropertiesEvaluationConfigProvider**

```java
package com.workwell.engine.synthetic;

import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.engine.port.EvaluationConfigProvider;
import org.springframework.stereotype.Component;

@Component
public class PropertiesEvaluationConfigProvider implements EvaluationConfigProvider {
    private final EvaluationPopulationProperties properties;
    public PropertiesEvaluationConfigProvider(EvaluationPopulationProperties properties) { this.properties = properties; }
    @Override public double complianceRate(String rateKey) {
        return properties.getComplianceRates().getOrDefault(rateKey, 0.80d);
    }
}
```

- [ ] **Step 2: Refactor `CqlEvaluationService` constructor + field usage**

In `compile/CqlEvaluationService.java`:
- Replace fields `syntheticFhirBundleBuilder` (the `new`), `evaluationPopulationProperties` with injected ports:
```java
    private final PatientDataProvider patientDataProvider;
    private final EmployeeDirectory employeeDirectory;
    private final MeasureDefinitionProvider measureDefinitionProvider;
    private final EvaluationConfigProvider evaluationConfigProvider;

    public CqlEvaluationService(PatientDataProvider patientDataProvider,
                                EmployeeDirectory employeeDirectory,
                                MeasureDefinitionProvider measureDefinitionProvider,
                                EvaluationConfigProvider evaluationConfigProvider) {
        this.patientDataProvider = patientDataProvider;
        this.employeeDirectory = employeeDirectory;
        this.measureDefinitionProvider = measureDefinitionProvider;
        this.evaluationConfigProvider = evaluationConfigProvider;
    }
```
- In `evaluateEmployee(...)`: replace `syntheticFhirBundleBuilder.buildBundle(...)` with `patientDataProvider.bundleFor(...)`.
- Replace `measureSeedSpecFor(measureName)` calls with `measureDefinitionProvider.forMeasure(measureName)` and the local type `MeasureSeedSpec` with `MeasureDefinition`.
- Replace `SyntheticEmployeeCatalog.allEmployees()` / `.byId(...)` with `employeeDirectory.allEmployees()` / `.byId(...)`.
- Replace `complianceRate(rateKey)` body to call `evaluationConfigProvider.complianceRate(rateKey)`.
- **Delete** the now-moved private members: `measureSeedSpecFor`, the private `MeasureSeedSpec` record. Keep `SeededInput`, `SeededOutcome`, `seededInputsFor`, `seededInputFor`, `orderedEmployeesFor`, `input(...)` (demo-shaping) — but they now use the injected `employeeDirectory`/`measureDefinitionProvider`/`evaluationConfigProvider`.
- Remove the now-unused `import ...EvaluationPopulationProperties` / `SyntheticFhirBundleBuilder` field (keep `ExamConfig` import — still referenced).

> Note: `@Service` stays on `CqlEvaluationService`; Spring injects the four `@Component` adapters. Constructor change is the only public-surface change; `evaluate(...)` / `evaluateSubject(...)` signatures are untouched (callers unaffected).

- [ ] **Step 3: EngineConfig (explicit wiring, documents the seam)**

```java
package com.workwell.engine;

import org.springframework.context.annotation.Configuration;

/**
 * Marker for the engine wiring boundary. The synthetic adapters are @Component beans and are the
 * DEFAULT data source. A future real adapter is added as an alternative bean selected by profile/config;
 * the synthetic beans remain default so the live demo is unchanged (see docs/PLAN.md principle 5).
 */
@Configuration
public class EngineConfig { }
```

- [ ] **Step 4: No-Spring guard test**

```java
package com.workwell.engine;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.engine.synthetic.*;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;
import static org.junit.jupiter.api.Assertions.assertEquals;

/** Proves the engine core runs with plain `new` wiring and NO Spring ApplicationContext. */
class EngineNoSpringContextTest {
    @Test
    void evaluatesWithoutSpringContext() throws Exception {
        CqlEvaluationService service = new CqlEvaluationService(
            new SyntheticPatientDataProvider(),
            new SyntheticEmployeeDirectory(),
            new SyntheticMeasureDefinitionProvider(),
            new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));
        String cql = FileCopyUtils.copyToString(new java.io.InputStreamReader(
            new ClassPathResource("measures/audiogram.cql").getInputStream(), StandardCharsets.UTF_8));
        DemoRunPayload payload = service.evaluate(
            "00000000-0000-0000-0000-000000000000", "Audiogram", "v1.0", cql, LocalDate.now());
        assertEquals(100, payload.outcomes().size());
    }
}
```

- [ ] **Step 5: Update the existing `CqlEvaluationServiceTest` constructor calls**

The 6 `new CqlEvaluationService(defaultPopulationProperties())` sites in `CqlEvaluationServiceTest` must use the 4-arg constructor. Replace `defaultPopulationProperties()` helper body to return the assembled service, or add a helper:
```java
    private static CqlEvaluationService newService() {
        return new CqlEvaluationService(
            new com.workwell.engine.synthetic.SyntheticPatientDataProvider(),
            new com.workwell.engine.synthetic.SyntheticEmployeeDirectory(),
            new com.workwell.engine.synthetic.SyntheticMeasureDefinitionProvider(),
            new com.workwell.engine.synthetic.PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));
    }
```
Replace each `new CqlEvaluationService(defaultPopulationProperties())` with `newService()`. For the subclass-override case (`perEmployeeFailureIsolationKeepsRunGoing`), keep the anonymous subclass but call the 4-arg `super(...)` via the same args.

- [ ] **Step 6: Compile + run the engine tests**

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.*" --tests "com.workwell.compile.CqlEvaluationServiceTest"`
Expected: PASS — including the golden parity test (outcomes unchanged) and the no-Spring guard.

- [ ] **Step 7: Commit**

```bash
git add backend/src/main/java/com/workwell/ backend/src/test/java/com/workwell/engine/EngineNoSpringContextTest.java backend/src/test/java/com/workwell/compile/CqlEvaluationServiceTest.java
git commit -m "refactor(engine): invert CqlEvaluationService onto ports + no-Spring guard test (#83)"
```

---

## Task 7: Dedupe the measure→CQL mapping in MeasureService (#82, second half)

The `ensureXxxSeed()` methods in `MeasureService` each call `loadSeedCql("<file>.cql")`. The measure-name↔file mapping now also lives in the engine. Add ONE shared mapping and have both reference it (minimal, no behavior change).

**Files:** Create `backend/src/main/java/com/workwell/engine/model/MeasureCatalog.java`; reference it from `SyntheticMeasureDefinitionProvider` (optional) and document the single source.

- [ ] **Step 1: Create the shared name→cql map**

```java
package com.workwell.engine.model;

import java.util.Map;

/** Single source for the runnable measure name -> CQL resource file mapping. */
public final class MeasureCatalog {
    private MeasureCatalog() {}
    public static final Map<String, String> CQL_FILE = Map.ofEntries(
        Map.entry("Audiogram", "audiogram.cql"),
        Map.entry("TB Surveillance", "tb_surveillance.cql"),
        Map.entry("HAZWOPER Surveillance", "hazwoper.cql"),
        Map.entry("Flu Vaccine", "flu_vaccine.cql"),
        Map.entry("Hypertension BP Screening", "hypertension.cql"),
        Map.entry("Diabetes HbA1c Monitoring", "diabetes_hba1c.cql"),
        Map.entry("BMI Screening & Counseling", "obesity_bmi.cql"),
        Map.entry("Cholesterol LDL Screening", "cholesterol_ldl.cql"),
        Map.entry("Breast Cancer Screening", "cms125.cql"),
        Map.entry("Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)", "cms122.cql")
    );
}
```

- [ ] **Step 2: Decide scope conservatively**

`MeasureService.ensureXxxSeed()` uses literal `loadSeedCql("audiogram.cql")` etc. Replacing each literal with `MeasureCatalog.CQL_FILE.get("Audiogram")` is a no-op behavior change but couples seeding to the catalog. **If this risks touching the 49-entry CMS catalog seeding or the spec_json builders, keep it minimal:** only swap the literal `.cql` filename strings, nothing else. Run the full suite after.

- [ ] **Step 3: Run the measure/seed tests + full backend suite**

Run: `cd backend; .\gradlew.bat test`
Expected: BUILD SUCCESSFUL — all 239 tests (now +2 engine tests) green.

- [ ] **Step 4: Commit**

```bash
git add backend/src/main/java/com/workwell/engine/model/MeasureCatalog.java backend/src/main/java/com/workwell/measure/MeasureService.java
git commit -m "refactor(engine): single measure name->cql mapping shared with seeding (#82)"
```

---

## Task 8: Docs + ADR

**Files:** `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.

- [ ] **Step 1: ARCHITECTURE — add the `engine` module boundary**

Under §3 backend module boundaries, add:
```
- `engine`: Spring-free measure-evaluation core (`CqlEvaluationService`) behind ports
  (`PatientDataProvider`, `EmployeeDirectory`, `MeasureDefinitionProvider`, `EvaluationConfigProvider`);
  `engine.synthetic` provides the default demo adapters. Future real-data adapters plug in here.
```

- [ ] **Step 2: DECISIONS — add ADR-005**

Add an ADR titled "ADR-005: Measure engine ports/adapters (same module, synthetic default adapter)" capturing: decision to invert onto 4 ports in-module (not a separate Gradle module), OutreachChannel deferred to E5, golden-file parity as the gate, demo preserved as default adapter.

- [ ] **Step 3: Commit**

```bash
git add docs/ARCHITECTURE.md docs/DECISIONS.md
git commit -m "docs(engine): ARCHITECTURE module boundary + ADR-005 for engine ports (#71)"
```

---

## Task 9: Final verification + PR

- [ ] **Step 1: Full suite green**

Run: `cd backend; .\gradlew.bat test`
Expected: BUILD SUCCESSFUL; golden parity + no-Spring guard pass; all prior tests pass.

- [ ] **Step 2: Push + open PR**

```bash
git push -u origin feat/e1-measure-engine-ports
gh pr create --title "feat(engine): E1 — reusable measure engine ports/adapters" \
  --body "Closes #71. Implements #79 #80 #81 #82 #83 #84.

Inverts CqlEvaluationService onto 4 ports with synthetic default adapters; golden-file parity proves outcomes unchanged; no-Spring guard test. Demo preserved as default adapter (docs/PLAN.md principle 5). Spec: docs/superpowers/specs/2026-06-10-e1-measure-engine-ports-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 3: Confirm CI green; request review (no auto-merge — Taleef reviews).**

---

## Self-review checklist (done)
- **Spec coverage:** ports (#79) T2; PatientDataProvider (#80) T4; EmployeeDirectory (#81) T5; single-source specs (#82) T3+T7; Spring-free core + guard (#83) T6; golden parity + config (#84) T1+T6. All covered.
- **Determinism:** golden projects to (employee→status), volatile dates excluded — documented up front.
- **No placeholders:** interface + test code is complete; the one "move verbatim" step (T3) references exact source lines.
- **Type consistency:** `MeasureDefinition` constructors mirror the existing `MeasureSeedSpec` arities; ports use existing `EmployeeProfile` / `ExamConfig` / `Bundle` types.
- **Constraints:** no schema migration; single module; OutreachChannel deferred; callers untouched.
