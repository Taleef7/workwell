# E2 — Declarative YAML Measures + Headless Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make YAML files the single declarative source of measure bindings behind the E1 `MeasureDefinitionProvider` port, and add a Spring-free headless CLI answering "given this patient bundle + this measure YAML, are they compliant?".

**Architecture:** New `com.workwell.engine.yaml` package (SnakeYAML parser + classpath-scanning provider) replaces the hardcoded `SyntheticMeasureDefinitionProvider` switch, gated by the existing golden-parity test. A public `evaluateBundle(...)` is extracted from `CqlEvaluationService`'s inner evaluation so arbitrary FHIR bundles can be evaluated; `engine/cli/HeadlessEvaluatorCli` (plain `main`, no Spring) + a Gradle `evaluateMeasure` JavaExec task expose it.

**Tech Stack:** Java 21, SnakeYAML 2.2 (already on classpath — no new dependency), HAPI FHIR R4 JSON parser, Jackson, JUnit 5, Gradle Kotlin DSL.

**Spec:** `docs/superpowers/specs/2026-06-10-e2-yaml-measures-design.md`
**Branch:** `feat/e2-yaml-measures` (already created)
**Epic:** #72 — sub-issues #85 (schema+parser), #86 (provider), #87 (10 YAMLs + golden), #88 (CLI)

---

## File structure

- Create `backend/src/main/java/com/workwell/engine/yaml/YamlMeasure.java` (record: metadata + cqlFile + MeasureDefinition)
- Create `backend/src/main/java/com/workwell/engine/yaml/YamlMeasureParser.java`
- Create `backend/src/main/java/com/workwell/engine/yaml/YamlMeasureDefinitionProvider.java` (`@Component`, default bean)
- Create `backend/src/main/resources/measures/*.yaml` (10 files, sibling to the `.cql` files)
- Delete `backend/src/main/java/com/workwell/engine/synthetic/SyntheticMeasureDefinitionProvider.java`
- Modify `backend/src/main/java/com/workwell/compile/CqlEvaluationService.java` (extract internal bundle evaluation; add public `evaluateBundle`)
- Create `backend/src/main/java/com/workwell/engine/model/BundleOutcome.java`
- Create `backend/src/main/java/com/workwell/engine/cli/HeadlessEvaluatorCli.java`
- Modify `backend/build.gradle.kts` (JavaExec task `evaluateMeasure`)
- Tests: `engine/yaml/YamlMeasureParserTest.java`, `engine/yaml/YamlMeasureDefinitionProviderTest.java`, `engine/cli/HeadlessEvaluatorCliTest.java`; update construction sites in `EngineGoldenParityTest`, `EngineNoSpringContextTest`, `CqlEvaluationServiceTest`
- Docs: `docs/DECISIONS.md` (ADR-006), `docs/ARCHITECTURE.md`, `README.md`, `docs/JOURNAL.md`

Exact binding values (copied verbatim from the switch being deleted; `vs:` prefix = `urn:workwell:vs:`):

| name (YAML `name`) | id / rateKey | enrollment code → VS | waiver code → VS | event code → VS | type | window |
|---|---|---|---|---|---|---|
| Audiogram | audiogram | hearing-enrollment → vs:hearing-enrollment | audiogram-waiver → vs:audiogram-waiver | audiogram-procedure → vs:audiogram-procedures | procedure | 365 |
| TB Surveillance | tb_surveillance | tb-program → vs:tb-eligible-roles | tb-exemption → vs:tb-exemption | tb-screen → vs:tb-screening | procedure | 365 |
| HAZWOPER Surveillance | hazwoper | hazwoper-program → vs:hazwoper-enrollment | hazwoper-exemption → vs:hazwoper-exemption | hazwoper-exam → vs:hazwoper-exams | procedure | 365 |
| Flu Vaccine | flu_vaccine | clinical-role → vs:clinical-roles | flu-exemption → vs:flu-exemption | flu-vaccine → vs:flu-vaccines | immunization | 365 |
| Hypertension BP Screening | hypertension | wellness-enrolled → vs:wellness-enrollment | wellness-exempt → vs:wellness-exemption | bp-screen → vs:bp-screening | procedure | 365 |
| Diabetes HbA1c Monitoring | diabetes_hba1c | diabetes-enrolled → vs:diabetes-program | diabetes-exempt → vs:diabetes-exemption | hba1c-lab → vs:hba1c-labs | procedure | 180 |
| BMI Screening & Counseling | obesity_bmi | wellness-enrolled → vs:wellness-enrollment | wellness-exempt → vs:wellness-exemption | bmi-screen → vs:bmi-screening | procedure | 365 |
| Cholesterol LDL Screening | cholesterol_ldl | cholesterol-enrolled → vs:cholesterol-program | cholesterol-exempt → vs:cholesterol-exemption | ldl-lab → vs:ldl-labs | procedure | 365 |
| Breast Cancer Screening | cms125 | cms125-eligible → vs:cms125-eligible | cms125-excluded → vs:cms125-excluded | mammogram → vs:cms125-mammogram | procedure | 820 |
| "Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)" | cms122 | cms122-diabetes → vs:cms122-diabetes | cms122-excluded → vs:cms122-excluded | hba1c-obs → vs:cms122-hba1c | observation | 365 |

`event.type` mapping: `procedure` → `useImmunization=false, observationBased=false`; `immunization` → `useImmunization=true, observationBased=false`; `observation` → `useImmunization=false, observationBased=true`.

---

## Task 1: YAML parser (TDD) — #85

**Files:**
- Test: `backend/src/test/java/com/workwell/engine/yaml/YamlMeasureParserTest.java`
- Create: `backend/src/main/java/com/workwell/engine/yaml/YamlMeasure.java`
- Create: `backend/src/main/java/com/workwell/engine/yaml/YamlMeasureParser.java`

- [ ] **Step 1: Write the failing tests**

```java
package com.workwell.engine.yaml;

import static org.junit.jupiter.api.Assertions.*;

import com.workwell.engine.model.MeasureDefinition;
import org.junit.jupiter.api.Test;

class YamlMeasureParserTest {

    private final YamlMeasureParser parser = new YamlMeasureParser();

    private static final String VALID = """
            id: audiogram
            name: Audiogram
            version: 1.0.0
            title: Annual Audiogram Completed
            policyRef: OSHA 29 CFR 1910.95
            tags: [surveillance, hearing, osha]
            cql: audiogram.cql
            bindings:
              rateKey: audiogram
              enrollment: { code: hearing-enrollment, valueSet: "urn:workwell:vs:hearing-enrollment" }
              waiver:     { code: audiogram-waiver,   valueSet: "urn:workwell:vs:audiogram-waiver" }
              event:      { code: audiogram-procedure, valueSet: "urn:workwell:vs:audiogram-procedures", type: procedure }
              complianceWindowDays: 365
            """;

    @Test
    void parsesValidProcedureMeasure() {
        YamlMeasure m = parser.parse(VALID, "audiogram.yaml");
        assertEquals("audiogram", m.id());
        assertEquals("Audiogram", m.name());
        assertEquals("audiogram.cql", m.cqlFile());
        MeasureDefinition d = m.definition();
        assertEquals("audiogram", d.rateKey());
        assertEquals("hearing-enrollment", d.enrollmentCode());
        assertEquals("urn:workwell:vs:hearing-enrollment", d.enrollmentVs());
        assertEquals("audiogram-waiver", d.waiverCode());
        assertEquals("audiogram-procedure", d.examCode());
        assertFalse(d.useImmunization());
        assertFalse(d.observationBased());
        assertEquals(365, d.complianceWindowDays());
    }

    @Test
    void immunizationAndObservationTypesMapToFlags() {
        YamlMeasure immz = parser.parse(VALID.replace("type: procedure", "type: immunization"), "x.yaml");
        assertTrue(immz.definition().useImmunization());
        assertFalse(immz.definition().observationBased());

        YamlMeasure obs = parser.parse(VALID.replace("type: procedure", "type: observation"), "x.yaml");
        assertFalse(obs.definition().useImmunization());
        assertTrue(obs.definition().observationBased());
    }

    @Test
    void complianceWindowDefaultsTo365() {
        String noWindow = VALID.replace("  complianceWindowDays: 365\n", "");
        assertEquals(365, parser.parse(noWindow, "x.yaml").definition().complianceWindowDays());
    }

    @Test
    void missingRequiredFieldFailsWithFileAndField() {
        String noName = VALID.replace("name: Audiogram\n", "");
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> parser.parse(noName, "audiogram.yaml"));
        assertTrue(ex.getMessage().contains("audiogram.yaml"), ex.getMessage());
        assertTrue(ex.getMessage().contains("name"), ex.getMessage());
    }

    @Test
    void invalidEventTypeRejected() {
        String bad = VALID.replace("type: procedure", "type: surgery");
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> parser.parse(bad, "x.yaml"));
        assertTrue(ex.getMessage().contains("event.type"), ex.getMessage());
    }

    @Test
    void unknownTopLevelKeyRejected() {
        String extra = VALID + "populations: {}\n";
        IllegalArgumentException ex = assertThrows(IllegalArgumentException.class,
                () -> parser.parse(extra, "x.yaml"));
        assertTrue(ex.getMessage().contains("populations"), ex.getMessage());
    }
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.yaml.YamlMeasureParserTest"`
Expected: COMPILE FAILURE (`YamlMeasureParser` does not exist).

- [ ] **Step 3: Implement `YamlMeasure` + `YamlMeasureParser`**

```java
package com.workwell.engine.yaml;

import com.workwell.engine.model.MeasureDefinition;
import java.util.List;

/** One parsed measure YAML: identity metadata + CQL file reference + engine bindings. */
public record YamlMeasure(
        String id, String name, String version, String title, String policyRef,
        List<String> tags, String cqlFile, MeasureDefinition definition) {
}
```

```java
package com.workwell.engine.yaml;

import com.workwell.engine.model.MeasureDefinition;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.yaml.snakeyaml.Yaml;

/**
 * Parses + validates one measure YAML document (schema v1, see the E2 design spec).
 * Pure SnakeYAML map-loading — no custom type instantiation, no Spring.
 */
public final class YamlMeasureParser {

    private static final Set<String> TOP_LEVEL_KEYS =
            Set.of("id", "name", "version", "title", "policyRef", "tags", "cql", "bindings");
    private static final Set<String> EVENT_TYPES = Set.of("procedure", "immunization", "observation");

    @SuppressWarnings("unchecked")
    public YamlMeasure parse(String yamlText, String sourceName) {
        Object root = new Yaml().load(yamlText);
        if (!(root instanceof Map)) {
            throw err(sourceName, "document", "expected a YAML mapping at the top level");
        }
        Map<String, Object> doc = (Map<String, Object>) root;
        for (String key : doc.keySet()) {
            if (!TOP_LEVEL_KEYS.contains(key)) {
                throw err(sourceName, key, "unknown top-level key");
            }
        }
        String id = requireString(doc, "id", sourceName);
        String name = requireString(doc, "name", sourceName);
        String version = requireString(doc, "version", sourceName);
        String cqlFile = requireString(doc, "cql", sourceName);
        String title = optionalString(doc, "title");
        String policyRef = optionalString(doc, "policyRef");
        List<String> tags = doc.get("tags") instanceof List<?> l ? l.stream().map(String::valueOf).toList() : List.of();

        Object bindingsObj = doc.get("bindings");
        if (!(bindingsObj instanceof Map)) {
            throw err(sourceName, "bindings", "required mapping is missing");
        }
        Map<String, Object> b = (Map<String, Object>) bindingsObj;
        String rateKey = requireString(b, "rateKey", sourceName);
        Map<String, Object> enrollment = requireMap(b, "enrollment", sourceName);
        Map<String, Object> waiver = requireMap(b, "waiver", sourceName);
        Map<String, Object> event = requireMap(b, "event", sourceName);

        String eventType = requireString(event, "type", sourceName);
        if (!EVENT_TYPES.contains(eventType)) {
            throw err(sourceName, "event.type", "must be one of " + EVENT_TYPES + " but was '" + eventType + "'");
        }
        int window = 365;
        Object windowObj = b.get("complianceWindowDays");
        if (windowObj != null) {
            if (!(windowObj instanceof Integer i) || i <= 0) {
                throw err(sourceName, "complianceWindowDays", "must be a positive integer");
            }
            window = (Integer) windowObj;
        }

        MeasureDefinition definition = new MeasureDefinition(
                rateKey,
                requireString(enrollment, "code", sourceName),
                requireString(enrollment, "valueSet", sourceName),
                requireString(waiver, "code", sourceName),
                requireString(waiver, "valueSet", sourceName),
                requireString(event, "code", sourceName),
                requireString(event, "valueSet", sourceName),
                "immunization".equals(eventType),
                window,
                "observation".equals(eventType));
        return new YamlMeasure(id, name, version, title, policyRef, tags, cqlFile, definition);
    }

    private static String requireString(Map<String, Object> map, String field, String sourceName) {
        Object value = map.get(field);
        if (value == null || String.valueOf(value).isBlank()) {
            throw err(sourceName, field, "required field is missing or blank");
        }
        return String.valueOf(value);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> requireMap(Map<String, Object> map, String field, String sourceName) {
        Object value = map.get(field);
        if (!(value instanceof Map)) {
            throw err(sourceName, field, "required mapping is missing");
        }
        return (Map<String, Object>) value;
    }

    private static String optionalString(Map<String, Object> map, String field) {
        Object value = map.get(field);
        return value == null ? null : String.valueOf(value);
    }

    private static IllegalArgumentException err(String sourceName, String field, String message) {
        return new IllegalArgumentException("Invalid measure YAML " + sourceName + ": " + field + " — " + message);
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.yaml.YamlMeasureParserTest"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/com/workwell/engine/yaml/ backend/src/test/java/com/workwell/engine/yaml/YamlMeasureParserTest.java
git commit -m "feat(engine): YAML measure schema parser (#85)"
```

---

## Task 2: Ten measure YAML files — #87 (part 1)

**Files:** Create `backend/src/main/resources/measures/{audiogram,tb_surveillance,hazwoper,flu_vaccine,hypertension,diabetes_hba1c,obesity_bmi,cholesterol_ldl,cms125,cms122}.yaml`

- [ ] **Step 1: Write the 10 files from the binding table (top of plan) using this template** — `id` = file stem = rateKey; `name`/codes/VS/type/window exactly per the table; `cql: <id>.cql`; titles/policyRef from `docs/MEASURES.md`; version `1.0.0` everywhere. Two non-obvious ones in full:

```yaml
# flu_vaccine.yaml
id: flu_vaccine
name: Flu Vaccine
version: 1.0.0
title: Flu Vaccine This Season
policyRef: CDC seasonal influenza guidance
tags: [vaccine, seasonal, immunization]
cql: flu_vaccine.cql
bindings:
  rateKey: flu_vaccine
  enrollment: { code: clinical-role, valueSet: "urn:workwell:vs:clinical-roles" }
  waiver:     { code: flu-exemption, valueSet: "urn:workwell:vs:flu-exemption" }
  event:      { code: flu-vaccine, valueSet: "urn:workwell:vs:flu-vaccines", type: immunization }
```

```yaml
# cms122.yaml
id: cms122
name: "Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)"
version: 1.0.0
title: Diabetes HbA1c Poor Control (CMS122v14 / MIPS 1)
policyRef: CMS122v14
tags: [ecqm, cms, diabetes]
cql: cms122.cql
bindings:
  rateKey: cms122
  enrollment: { code: cms122-diabetes, valueSet: "urn:workwell:vs:cms122-diabetes" }
  waiver:     { code: cms122-excluded, valueSet: "urn:workwell:vs:cms122-excluded" }
  event:      { code: hba1c-obs, valueSet: "urn:workwell:vs:cms122-hba1c", type: observation }
  complianceWindowDays: 365
```

(For `diabetes_hba1c.yaml` set `complianceWindowDays: 180`; for `cms125.yaml` set `820`; omit the key where the table says 365 — the default covers it. The cms122 `name` MUST be quoted.)

- [ ] **Step 2: Sanity-parse them in a quick scratch test or via Task 3's provider test (next task asserts all 10 load). Commit:**

```bash
git add backend/src/main/resources/measures/*.yaml
git commit -m "feat(engine): express all 10 runnable measures as YAML (#87)"
```

---

## Task 3: YamlMeasureDefinitionProvider (TDD) — #86

**Files:**
- Test: `backend/src/test/java/com/workwell/engine/yaml/YamlMeasureDefinitionProviderTest.java`
- Create: `backend/src/main/java/com/workwell/engine/yaml/YamlMeasureDefinitionProvider.java`

- [ ] **Step 1: Failing test**

```java
package com.workwell.engine.yaml;

import static org.junit.jupiter.api.Assertions.*;

import com.workwell.engine.model.MeasureDefinition;
import org.junit.jupiter.api.Test;

class YamlMeasureDefinitionProviderTest {

    private final YamlMeasureDefinitionProvider provider = new YamlMeasureDefinitionProvider();

    @Test
    void loadsAllTenRunnableMeasuresFromClasspath() {
        assertEquals(10, provider.measureCount());
    }

    @Test
    void looksUpByExactCatalogName() {
        MeasureDefinition audiogram = provider.forMeasure("Audiogram");
        assertNotNull(audiogram);
        assertEquals("audiogram", audiogram.rateKey());
        assertEquals(365, audiogram.complianceWindowDays());

        MeasureDefinition cms122 = provider.forMeasure("Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)");
        assertNotNull(cms122);
        assertTrue(cms122.observationBased());

        MeasureDefinition diabetes = provider.forMeasure("Diabetes HbA1c Monitoring");
        assertEquals(180, diabetes.complianceWindowDays());

        MeasureDefinition cms125 = provider.forMeasure("Breast Cancer Screening");
        assertEquals(820, cms125.complianceWindowDays());

        MeasureDefinition flu = provider.forMeasure("Flu Vaccine");
        assertTrue(flu.useImmunization());
    }

    @Test
    void unknownMeasureReturnsNull() {
        assertNull(provider.forMeasure("No Such Measure"));
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cd backend; .\gradlew.bat test --tests "com.workwell.engine.yaml.YamlMeasureDefinitionProviderTest"` → COMPILE FAILURE.

- [ ] **Step 3: Implement the provider**

```java
package com.workwell.engine.yaml;

import com.workwell.engine.model.MeasureDefinition;
import com.workwell.engine.port.MeasureDefinitionProvider;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;
import org.springframework.util.FileCopyUtils;

/**
 * Default {@link MeasureDefinitionProvider}: loads every classpath measures/*.yaml at construction
 * and indexes by the measure's exact catalog {@code name}. Replaces the former hardcoded switch
 * (single source of truth — ADR-006). Uses Spring-core's resource resolver as plain library code:
 * no ApplicationContext required (the no-Spring guard test constructs this with {@code new}).
 */
@Component
public class YamlMeasureDefinitionProvider implements MeasureDefinitionProvider {

    private final Map<String, YamlMeasure> byName = new LinkedHashMap<>();

    public YamlMeasureDefinitionProvider() {
        YamlMeasureParser parser = new YamlMeasureParser();
        try {
            Resource[] resources = new PathMatchingResourcePatternResolver()
                    .getResources("classpath*:measures/*.yaml");
            for (Resource resource : resources) {
                String text = FileCopyUtils.copyToString(
                        new InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8));
                YamlMeasure measure = parser.parse(text, String.valueOf(resource.getFilename()));
                YamlMeasure previous = byName.putIfAbsent(measure.name(), measure);
                if (previous != null) {
                    throw new IllegalStateException("Duplicate measure name '" + measure.name()
                            + "' in " + resource.getFilename());
                }
            }
        } catch (IOException ex) {
            throw new IllegalStateException("Failed to load measure YAML definitions from classpath", ex);
        }
    }

    @Override
    public MeasureDefinition forMeasure(String measureName) {
        YamlMeasure measure = byName.get(measureName);
        return measure == null ? null : measure.definition();
    }

    public int measureCount() {
        return byName.size();
    }
}
```

- [ ] **Step 4: Run to verify pass** — same command → PASS (3 tests). If `measureCount` ≠ 10, a YAML file failed to parse or a name is wrong; the exception names the file/field.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/com/workwell/engine/yaml/YamlMeasureDefinitionProvider.java backend/src/test/java/com/workwell/engine/yaml/YamlMeasureDefinitionProviderTest.java
git commit -m "feat(engine): YamlMeasureDefinitionProvider loads measures/*.yaml (#86)"
```

---

## Task 4: Swap the default + delete the switch — #87 (golden gate)

**Files:**
- Delete: `backend/src/main/java/com/workwell/engine/synthetic/SyntheticMeasureDefinitionProvider.java`
- Modify: `backend/src/test/java/com/workwell/engine/EngineGoldenParityTest.java` (newService helper)
- Modify: `backend/src/test/java/com/workwell/engine/EngineNoSpringContextTest.java`
- Modify: `backend/src/test/java/com/workwell/compile/CqlEvaluationServiceTest.java` (newService + anonymous subclass)
- Modify: `backend/src/main/java/com/workwell/engine/EngineConfig.java` (javadoc only: mention YAML provider as the definition source)

- [ ] **Step 1: Delete the class.** `git rm backend/src/main/java/com/workwell/engine/synthetic/SyntheticMeasureDefinitionProvider.java`

- [ ] **Step 2: Replace every `new SyntheticMeasureDefinitionProvider()` with `new com.workwell.engine.yaml.YamlMeasureDefinitionProvider()`** (3 test files, 4 sites total: golden helper, guard test, `CqlEvaluationServiceTest.newService()`, and the anonymous-subclass constructor call). Update the corresponding imports (`com.workwell.engine.synthetic.SyntheticMeasureDefinitionProvider` → `com.workwell.engine.yaml.YamlMeasureDefinitionProvider`).

- [ ] **Step 3: Run the gate — golden parity + engine + evaluation tests**

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.*" --tests "com.workwell.compile.CqlEvaluationServiceTest" --tests "com.workwell.engine.yaml.*"`
Expected: PASS. The golden test (100 employees × 10 measures byte-identical) is the proof that YAML == the deleted switch. Any drift = a wrong value in a YAML file; fix the YAML, never the golden.

- [ ] **Step 4: Commit**

```bash
git add -A backend/src/main backend/src/test
git commit -m "refactor(engine): YAML provider is the single measure-definition source; delete hardcoded switch (#87)"
```

---

## Task 5: Public `evaluateBundle` on the engine core

**Files:**
- Create: `backend/src/main/java/com/workwell/engine/model/BundleOutcome.java`
- Modify: `backend/src/main/java/com/workwell/compile/CqlEvaluationService.java`
- Test: add to `backend/src/test/java/com/workwell/engine/EngineNoSpringContextTest.java`

- [ ] **Step 1: Failing test (add to EngineNoSpringContextTest — it already wires the engine without Spring)**

```java
    @Test
    void evaluatesArbitraryBundleHeadlessly() throws Exception {
        CqlEvaluationService service = newService(); // extract the existing wiring into this helper
        String cql = readClasspath("measures/audiogram.cql");

        // A compliant subject: enrolled, no waiver, audiogram 100 days ago.
        var employee = new com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile(
                "headless-001", "Headless Test", "Welder", "Plant A");
        var config = new com.workwell.compile.SyntheticFhirBundleBuilder.ExamConfig(
                100, false, true,
                "hearing-enrollment", "urn:workwell:vs:hearing-enrollment",
                "audiogram-waiver", "urn:workwell:vs:audiogram-waiver",
                "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false);
        org.hl7.fhir.r4.model.Bundle bundle =
                new com.workwell.compile.SyntheticFhirBundleBuilder().buildBundle(employee, config, java.time.LocalDate.now());

        com.workwell.engine.model.BundleOutcome outcome = service.evaluateBundle(
                "Audiogram", "v1.0", cql, java.time.LocalDate.now(), bundle, "headless-001");

        org.junit.jupiter.api.Assertions.assertEquals("COMPLIANT", outcome.outcomeStatus());
        org.junit.jupiter.api.Assertions.assertEquals("headless-001", outcome.subjectId());
        org.junit.jupiter.api.Assertions.assertFalse(outcome.expressionResults().isEmpty());
    }
```

(Also refactor the existing test body to share `newService()` and `readClasspath(...)` helpers.)

- [ ] **Step 2: Run to verify failure** — compile error: `evaluateBundle` undefined.

- [ ] **Step 3: Implement.** Create the record:

```java
package com.workwell.engine.model;

import java.util.List;
import java.util.Map;

/** Result of a headless bundle evaluation: normalized bucket + define-level evidence core. */
public record BundleOutcome(String subjectId, String outcomeStatus,
                            List<Map<String, Object>> expressionResults) {
}
```

In `CqlEvaluationService`: rename the private `evaluateEmployee(...)`'s body so the part **after** the bundle is built becomes a private core, and add the public method. Concretely:

1. Change the private method to build the bundle then delegate:
```java
    private EvaluationResult evaluateEmployee(String measureName, String measureVersion, String cqlText,
                                              LocalDate evaluationDate, SeededInput input) {
        Bundle bundle = patientDataProvider.bundleFor(input.employee(), input.config(), evaluationDate);
        return evaluateBundleInternal(measureName, measureVersion, cqlText, evaluationDate, bundle,
                input.employee().externalId());
    }
```
2. Move everything that previously followed the `bundleFor` line (FhirContext setup through the `eval == null` checks) into:
```java
    private EvaluationResult evaluateBundleInternal(String measureName, String measureVersion, String cqlText,
                                                    LocalDate evaluationDate, Bundle bundle,
                                                    String subjectExternalId) {
        // identical body; every `input.employee().externalId()` becomes `subjectExternalId`
    }
```
3. Add the public surface (sharing the existing private normalizers — do not duplicate them):
```java
    public com.workwell.engine.model.BundleOutcome evaluateBundle(String measureName, String measureVersion,
            String cqlText, LocalDate evaluationDate, Bundle bundle, String subjectId) {
        EvaluationResult eval = evaluateBundleInternal(measureName, measureVersion, cqlText, evaluationDate,
                bundle, subjectId);
        Map<String, ?> expressionResults = eval.expressionResults == null ? Map.of() : eval.expressionResults;
        String outcomeStatus = normalizeOutcomeStatus(expressionResults.get("Outcome Status"));
        List<Map<String, Object>> rows = expressionResults.entrySet().stream()
                .map(entry -> {
                    Map<String, Object> row = new LinkedHashMap<String, Object>();
                    row.put("define", entry.getKey());
                    row.put("result", normalizeExpressionValue(entry.getValue()));
                    return row;
                })
                .toList();
        return new com.workwell.engine.model.BundleOutcome(subjectId, outcomeStatus, rows);
    }
```

- [ ] **Step 4: Run the gate** — `cd backend; .\gradlew.bat test --tests "com.workwell.engine.*" --tests "com.workwell.compile.CqlEvaluationServiceTest"` → PASS, golden parity unchanged.

- [ ] **Step 5: Commit**

```bash
git add backend/src/main/java/com/workwell/ backend/src/test/java/com/workwell/engine/EngineNoSpringContextTest.java
git commit -m "refactor(engine): extract public evaluateBundle for arbitrary FHIR bundles"
```

---

## Task 6: Headless CLI + Gradle task (TDD) — #88

**Files:**
- Test: `backend/src/test/java/com/workwell/engine/cli/HeadlessEvaluatorCliTest.java`
- Create: `backend/src/main/java/com/workwell/engine/cli/HeadlessEvaluatorCli.java`
- Modify: `backend/build.gradle.kts` (append JavaExec task)

- [ ] **Step 1: Failing test**

```java
package com.workwell.engine.cli;

import static org.junit.jupiter.api.Assertions.*;

import ca.uhn.fhir.context.FhirContext;
import com.workwell.compile.SyntheticFhirBundleBuilder;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

class HeadlessEvaluatorCliTest {

    @TempDir
    Path tempDir;

    @Test
    void patientPlusYamlYieldsOutcomeJson() throws Exception {
        // Stage measure YAML + CQL side by side in a temp dir (CWD-independent).
        Path yamlPath = copyClasspath("measures/audiogram.yaml", tempDir.resolve("audiogram.yaml"));
        copyClasspath("measures/audiogram.cql", tempDir.resolve("audiogram.cql"));

        // A compliant patient bundle, serialized to JSON.
        var employee = new EmployeeProfile("headless-cli-001", "CLI Test", "Welder", "Plant A");
        var config = new SyntheticFhirBundleBuilder.ExamConfig(
                100, false, true,
                "hearing-enrollment", "urn:workwell:vs:hearing-enrollment",
                "audiogram-waiver", "urn:workwell:vs:audiogram-waiver",
                "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false);
        Bundle bundle = new SyntheticFhirBundleBuilder().buildBundle(employee, config, LocalDate.now());
        Path bundlePath = tempDir.resolve("patient.json");
        Files.writeString(bundlePath,
                FhirContext.forR4Cached().newJsonParser().encodeResourceToString(bundle),
                StandardCharsets.UTF_8);

        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        int exit = HeadlessEvaluatorCli.run(
                new String[]{bundlePath.toString(), yamlPath.toString()},
                new PrintStream(stdout, true, StandardCharsets.UTF_8), System.err);

        assertEquals(0, exit);
        String json = stdout.toString(StandardCharsets.UTF_8);
        assertTrue(json.contains("\"outcome\" : \"COMPLIANT\"") || json.contains("\"outcome\":\"COMPLIANT\""), json);
        assertTrue(json.contains("headless-cli-001"), json);
    }

    @Test
    void usageErrorReturnsExitCode1() {
        int exit = HeadlessEvaluatorCli.run(new String[]{}, System.out, System.err);
        assertEquals(1, exit);
    }

    private Path copyClasspath(String resource, Path target) throws Exception {
        String text = FileCopyUtils.copyToString(new java.io.InputStreamReader(
                new ClassPathResource(resource).getInputStream(), StandardCharsets.UTF_8));
        Files.writeString(target, text, StandardCharsets.UTF_8);
        return target;
    }
}
```

- [ ] **Step 2: Run to verify failure** — COMPILE FAILURE (`HeadlessEvaluatorCli` missing).

- [ ] **Step 3: Implement the CLI**

```java
package com.workwell.engine.cli;

import ca.uhn.fhir.context.FhirContext;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.engine.model.BundleOutcome;
import com.workwell.engine.synthetic.PropertiesEvaluationConfigProvider;
import com.workwell.engine.synthetic.SyntheticEmployeeDirectory;
import com.workwell.engine.synthetic.SyntheticPatientDataProvider;
import com.workwell.engine.yaml.YamlMeasure;
import com.workwell.engine.yaml.YamlMeasureParser;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Patient;
import org.springframework.core.io.ClassPathResource;

/**
 * Headless evaluator: "given this patient bundle and this measure YAML, are they compliant?"
 * Plain Java — no Spring context, no DB, no web server. Run via:
 *   ./gradlew.bat evaluateMeasure --args="patient-bundle.json path/to/measure.yaml [--date YYYY-MM-DD]"
 */
public final class HeadlessEvaluatorCli {

    private HeadlessEvaluatorCli() {
    }

    public static void main(String[] args) {
        System.exit(run(args, System.out, System.err));
    }

    static int run(String[] args, PrintStream out, PrintStream err) {
        try {
            if (args.length < 2) {
                err.println("usage: HeadlessEvaluatorCli <patient-bundle.json> <measure.yaml> [--date YYYY-MM-DD]");
                return 1;
            }
            Path bundlePath = Path.of(args[0]);
            Path yamlPath = Path.of(args[1]);
            LocalDate evaluationDate = LocalDate.now();
            for (int i = 2; i < args.length - 1; i++) {
                if ("--date".equals(args[i])) {
                    evaluationDate = LocalDate.parse(args[i + 1]);
                }
            }
            if (!Files.isRegularFile(bundlePath) || !Files.isRegularFile(yamlPath)) {
                err.println("error: bundle or measure YAML file not found");
                return 1;
            }

            YamlMeasure measure = new YamlMeasureParser()
                    .parse(Files.readString(yamlPath, StandardCharsets.UTF_8), yamlPath.getFileName().toString());
            String cqlText = readCql(yamlPath, measure.cqlFile());

            Bundle bundle = (Bundle) FhirContext.forR4Cached().newJsonParser()
                    .parseResource(Files.readString(bundlePath, StandardCharsets.UTF_8));
            String subjectId = bundle.getEntry().stream()
                    .map(Bundle.BundleEntryComponent::getResource)
                    .filter(Patient.class::isInstance)
                    .map(r -> ((Patient) r).getIdElement().getIdPart())
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("bundle contains no Patient resource"));

            CqlEvaluationService engine = new CqlEvaluationService(
                    new SyntheticPatientDataProvider(),
                    new SyntheticEmployeeDirectory(),
                    name -> measure.definition(),
                    new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));
            BundleOutcome outcome = engine.evaluateBundle(
                    measure.name(), measure.version(), cqlText, evaluationDate, bundle, subjectId);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("subjectId", outcome.subjectId());
            result.put("measure", measure.name());
            result.put("evaluationDate", evaluationDate.toString());
            result.put("outcome", outcome.outcomeStatus());
            result.put("evidence", Map.of("expressionResults", outcome.expressionResults()));
            out.println(new ObjectMapper().writerWithDefaultPrettyPrinter().writeValueAsString(result));
            return 0;
        } catch (IllegalArgumentException ex) {
            err.println("error: " + ex.getMessage());
            return 1;
        } catch (Exception ex) {
            err.println("evaluation error: " + ex);
            return 2;
        }
    }

    private static String readCql(Path yamlPath, String cqlFile) throws Exception {
        Path sibling = yamlPath.toAbsolutePath().getParent().resolve(cqlFile);
        if (Files.isRegularFile(sibling)) {
            return Files.readString(sibling, StandardCharsets.UTF_8);
        }
        ClassPathResource fallback = new ClassPathResource("measures/" + cqlFile);
        if (fallback.exists()) {
            return new String(fallback.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
        throw new IllegalArgumentException("CQL file '" + cqlFile + "' not found beside the YAML or on the classpath");
    }
}
```

- [ ] **Step 4: Append the Gradle task to `backend/build.gradle.kts`**

```kotlin
tasks.register<JavaExec>("evaluateMeasure") {
	group = "application"
	description = "Headless: evaluate a patient FHIR bundle JSON against a measure YAML (no Spring, no DB)"
	classpath = sourceSets["main"].runtimeClasspath
	mainClass.set("com.workwell.engine.cli.HeadlessEvaluatorCli")
}
```

- [ ] **Step 5: Run tests + a real CLI invocation**

Run: `cd backend; .\gradlew.bat test --tests "com.workwell.engine.cli.HeadlessEvaluatorCliTest"`
Expected: PASS.

Then the live demo command (generate a bundle file first by copying the one the test wrote, or hand-write a minimal Patient+Procedure bundle):
`cd backend; .\gradlew.bat evaluateMeasure --args="<path-to-bundle.json> src/main/resources/measures/audiogram.yaml"`
Expected: pretty JSON with `"outcome"` on stdout, exit 0.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/com/workwell/engine/cli/ backend/src/test/java/com/workwell/engine/cli/ backend/build.gradle.kts
git commit -m "feat(engine): headless evaluator CLI + gradle evaluateMeasure task (#88)"
```

---

## Task 7: Docs + ADR-006

**Files:** `docs/DECISIONS.md` (ADR-006 at top), `docs/ARCHITECTURE.md` (engine bullet), `README.md` (CLI demo block in "At a glance"/usage area), `docs/JOURNAL.md` (new 2026-06-10 E2 entry on top).

- [ ] **Step 1: ADR-006** — title "ADR-006: YAML measure definitions + headless evaluator CLI". Capture: YAML as single binding source behind `MeasureDefinitionProvider` (switch deleted, golden-gated); minimal v1 schema with `event.type` replacing the two booleans; logic stays in CQL; plain-Java CLI via `evaluateMeasure` (REST endpoint deferred); SnakeYAML already shipped (no new dependency).
- [ ] **Step 2: ARCHITECTURE** — extend the `engine` bullet: `engine.yaml` loads `measures/*.yaml` as the definition source; public `evaluateBundle` headless surface; CLI entrypoint.
- [ ] **Step 3: README** — add a short "Headless evaluation" snippet with the gradle command + sample output.
- [ ] **Step 4: JOURNAL** — E2 entry (what shipped, decisions, verification), newest-on-top.
- [ ] **Step 5: Commit** — `git add docs/ README.md && git commit -m "docs(engine): ADR-006 YAML measures + headless CLI; ARCHITECTURE/README/JOURNAL"`

---

## Task 8: Final verification + PR

- [ ] **Step 1: Targeted gate locally** (full local suite is Docker-flaky; CI is authoritative):
`cd backend; .\gradlew.bat test --tests "com.workwell.engine.*" --tests "com.workwell.compile.*"` → PASS.
- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/e2-yaml-measures
gh pr create --base main --head feat/e2-yaml-measures \
  --title "feat(engine): E2 — declarative YAML measures + headless evaluator" \
  --body "Closes #72. Closes #85. Closes #86. Closes #87. Closes #88. ..."
```
Use `Closes` for every sub-issue (E1 lesson: "Implements" does not auto-close).
- [ ] **Step 3: Verify CI green (test steps, not the reporter), await Taleef review. After merge: confirm #72/#85–#88 closed, delete branch, doc-closeout follow-up.**

---

## Self-review (done)

- **Spec coverage:** parser+schema (#85) T1; provider (#86) T3; 10 YAMLs + golden + switch deletion (#87) T2+T4; evaluateBundle + CLI + gradle task (#88) T5+T6; docs/ADR T7; acceptance gates T4/T8. All spec sections mapped.
- **Type consistency:** `YamlMeasure(id,name,version,title,policyRef,tags,cqlFile,definition)`; `BundleOutcome(subjectId,outcomeStatus,expressionResults)`; `evaluateBundle(measureName, measureVersion, cqlText, evaluationDate, bundle, subjectId)`; `run(String[], PrintStream, PrintStream)` — used consistently across tasks.
- **No placeholders:** every code step has full code; the 10 YAMLs are fully specified by template + exact-values table + the two non-obvious files in full.
- **Constraints honored:** no new dependencies (SnakeYAML/Jackson/HAPI/spring-core all present); no schema migrations; golden fixtures never edited; lambda is valid for `MeasureDefinitionProvider` (single abstract method); `EmployeeDirectory` (two methods) gets the synthetic instance.
