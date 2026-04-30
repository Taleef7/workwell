# cqf-fhir-cr Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove that `cqf-fhir-cr` can evaluate a trivial CQL measure against an in-memory FHIR Bundle and produce a `MeasureReport` — outside of any running server — before building Phase 2 infrastructure around it.

**Architecture:** Minimal Java 21 + Gradle project (no Spring) in a sibling directory `../workwell-spike-cqf/`. Loads a FHIR `Measure` + `Library` (CQL base64-encoded) and a test patient `Bundle` into an `InMemoryFhirRepository`, calls `R4MeasureProcessor.evaluateMeasure()`, and prints the resulting `MeasureReport` JSON to stdout. All findings are documented in `SPIKE_NOTES.md`.

**Tech Stack:** Java 21, Gradle Kotlin DSL, `org.opencds.cqf.fhir:cqf-fhir-cr` (verify version), `org.opencds.cqf.fhir:cqf-fhir-utility`, HAPI FHIR R4 (pulled transitively)

---

## Critical Background: How cqf-fhir-cr Expects CQL

This is the #1 thing that surprises developers. You cannot pass a raw `.cql` text file to the evaluation engine. The pipeline requires:

1. A FHIR **`Library`** resource whose `content[0]` has `contentType = "text/cql"` and `data` = base64-encoded CQL text
2. A FHIR **`Measure`** resource that references that Library via canonical URL in `measure.library[]`
3. Population criteria in the Measure that reference named CQL `define` expressions by identifier

Both resources must be in the `IRepository` before evaluation begins. Patient data (Bundle) goes into the same repository. In production (Phase 2), the HAPI JPA server's repository contains all of these. In this spike, we use `InMemoryFhirRepository`.

---

## File Map

```
workwell-spike-cqf/                       ← sibling of main repo
├── settings.gradle.kts
├── build.gradle.kts
├── gradlew  /  gradlew.bat  /  gradle/wrapper/
├── src/main/java/com/workwell/spike/
│   ├── CqfSpike.java                     ← main() entry point
│   ├── ResourceLoader.java               ← reads FHIR JSON + CQL from classpath
│   └── RepositoryBuilder.java            ← assembles InMemoryFhirRepository
├── src/main/resources/
│   ├── cql/
│   │   └── HasRecentProcedure.cql        ← raw CQL (base64-encoded at runtime)
│   └── fhir/
│       ├── Measure-HasRecentProcedure.json
│       └── test-patient-bundle.json
└── SPIKE_NOTES.md                        ← filled in after the spike runs
```

| File | Responsibility |
|------|---------------|
| `build.gradle.kts` | Declares cqf-fhir-cr + utility deps; Java 21 toolchain |
| `CqfSpike.java` | Orchestrates: load → build repo → evaluate → print |
| `ResourceLoader.java` | Reads classpath files; base64-encodes CQL into Library resource |
| `RepositoryBuilder.java` | Creates `InMemoryFhirRepository` from assembled Bundle |
| `HasRecentProcedure.cql` | Trivial measure: all patients in denominator; patients with a completed Procedure in numerator |
| `Measure-HasRecentProcedure.json` | FHIR R4 Measure resource referencing the Library |
| `test-patient-bundle.json` | Transaction Bundle: one Patient + one completed Procedure in 2026 |
| `SPIKE_NOTES.md` | Documents versions that worked, API surface, gotchas for Phase 2 |

---

## Task 1: Initialize Gradle project and verify dependencies resolve

**Files:**
- Create: `../workwell-spike-cqf/settings.gradle.kts`
- Create: `../workwell-spike-cqf/build.gradle.kts`

- [ ] **Step 1: Create the sibling directory and initialize Gradle wrapper**

Run from the parent of the main repo:
```bash
mkdir ../workwell-spike-cqf
cd ../workwell-spike-cqf
gradle wrapper --gradle-version 8.10.2
```

Expected: `gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`, `gradle/wrapper/gradle-wrapper.properties` all created.

- [ ] **Step 2: Check current latest versions of cqf-fhir-cr artifacts**

Before writing any dependency coordinates, check what's actually on Maven Central. Open these two URLs and record the latest versions:

- https://central.sonatype.com/artifact/org.opencds.cqf.fhir/cqf-fhir-cr (core)
- https://central.sonatype.com/artifact/org.opencds.cqf.fhir/cqf-fhir-utility (utilities)

Both artifacts are in the same project but may have different version numbers. Use whatever `LATEST` shows (not SNAPSHOT).

Record the two versions in `SPIKE_NOTES.md` before proceeding.

- [ ] **Step 3: Create settings.gradle.kts**

```kotlin
rootProject.name = "workwell-spike-cqf"
```

- [ ] **Step 4: Create build.gradle.kts**

Replace `CQF_CR_VERSION` and `CQF_UTILITY_VERSION` with the versions you found in Step 2.

```kotlin
plugins {
    java
    application
}

group = "com.workwell.spike"
version = "0.0.1-SNAPSHOT"

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(21)
    }
}

application {
    mainClass = "com.workwell.spike.CqfSpike"
}

repositories {
    mavenCentral()
}

dependencies {
    // Clinical reasoning core — evaluates CQL measures, produces MeasureReport
    implementation("org.opencds.cqf.fhir:cqf-fhir-cr:CQF_CR_VERSION")
    // Utilities — InMemoryFhirRepository lives here
    implementation("org.opencds.cqf.fhir:cqf-fhir-utility:CQF_UTILITY_VERSION")
    // CQL-FHIR interop layer — required by cqf-fhir-cr
    implementation("org.opencds.cqf.fhir:cqf-fhir-cql:CQF_CR_VERSION")

    // HAPI FHIR R4 — pulled transitively, but explicit for FhirContext usage in main()
    // Let Gradle's resolution pick the version compatible with cqf-fhir-cr.
    // If you get version conflicts, add: implementation("ca.uhn.hapi.fhir:hapi-fhir-structures-r4:VERSION")
    // and pin to whatever cqf-fhir-utility's transitive dependency requires.

    // Logging — cqf-fhir uses SLF4J; provide a simple impl so it doesn't fail silently
    runtimeOnly("org.slf4j:slf4j-simple:2.0.16")
}
```

- [ ] **Step 5: Resolve dependencies and check for conflicts**

```bash
cd ../workwell-spike-cqf
./gradlew dependencies --configuration runtimeClasspath 2>&1 | head -80
```

Expected: dependency tree prints without "FAILED" lines.

If you see `Could not resolve org.opencds.cqf.fhir:cqf-fhir-cr:CQF_CR_VERSION`:
- Verify the version number is exactly right (no typo, no snapshot suffix)
- Try `./gradlew dependencies --refresh-dependencies`

If you see version conflict warnings between HAPI FHIR versions pulled in transitively, add an explicit `implementation("ca.uhn.hapi.fhir:hapi-fhir-structures-r4:VERSION")` where VERSION matches what `cqf-fhir-cr` requires (check its POM on Maven Central).

Record any conflict resolutions needed in `SPIKE_NOTES.md`.

- [ ] **Step 6: Create source directories**

```bash
mkdir -p src/main/java/com/workwell/spike
mkdir -p src/main/resources/cql
mkdir -p src/main/resources/fhir
```

- [ ] **Step 7: Commit**

```bash
git init
git add .
git commit -m "chore: spike project init — gradle + cqf-fhir-cr deps resolve"
```

---

## Task 2: CQL file and FHIR resources

**Files:**
- Create: `src/main/resources/cql/HasRecentProcedure.cql`
- Create: `src/main/resources/fhir/Measure-HasRecentProcedure.json`

This measure is intentionally trivial: every patient is in the denominator; a patient is in the numerator if they have at least one `Procedure` with `status = completed` during the measurement period. This exercises both Patient data and Procedure data retrieval — the two most common FHIR resources we'll use in Phase 2.

- [ ] **Step 1: Create the CQL library**

`src/main/resources/cql/HasRecentProcedure.cql`:
```cql
library HasRecentProcedure version '1.0.0'
using FHIR version '4.0.1'
include FHIRHelpers version '4.0.1' called FHIRHelpers

parameter "Measurement Period" Interval<DateTime>

context Patient

define "Initial Population":
  true

define "Denominator":
  "Initial Population"

define "Numerator":
  exists(
    [Procedure] P
      where P.status = 'completed'
        and P.performed during "Measurement Period"
  )
```

Why `true` for Initial Population: simplest possible gate. In Phase 2, this would be the denominator enrollment check (e.g., "enrolled in Hearing Conservation Program").

Why `P.performed during "Measurement Period"`: tests that the Measurement Period parameter injection works — the single most important correctness feature per plan §17.

- [ ] **Step 2: Create the FHIR Measure resource**

`src/main/resources/fhir/Measure-HasRecentProcedure.json`:
```json
{
  "resourceType": "Measure",
  "id": "HasRecentProcedure",
  "url": "http://workwell.spike.org/Measure/HasRecentProcedure",
  "version": "1.0.0",
  "name": "HasRecentProcedure",
  "title": "Has Recent Procedure (Spike)",
  "status": "active",
  "experimental": true,
  "description": "Spike measure: patients with a completed procedure during the measurement period.",
  "scoring": {
    "coding": [{
      "system": "http://terminology.hl7.org/CodeSystem/measure-scoring",
      "code": "proportion",
      "display": "Proportion"
    }]
  },
  "library": [
    "http://workwell.spike.org/Library/HasRecentProcedure"
  ],
  "group": [{
    "id": "group-1",
    "population": [
      {
        "id": "initial-population",
        "code": {
          "coding": [{
            "system": "http://terminology.hl7.org/CodeSystem/measure-population",
            "code": "initial-population",
            "display": "Initial Population"
          }]
        },
        "criteria": {
          "language": "text/cql-identifier",
          "expression": "Initial Population"
        }
      },
      {
        "id": "denominator",
        "code": {
          "coding": [{
            "system": "http://terminology.hl7.org/CodeSystem/measure-population",
            "code": "denominator",
            "display": "Denominator"
          }]
        },
        "criteria": {
          "language": "text/cql-identifier",
          "expression": "Denominator"
        }
      },
      {
        "id": "numerator",
        "code": {
          "coding": [{
            "system": "http://terminology.hl7.org/CodeSystem/measure-population",
            "code": "numerator",
            "display": "Numerator"
          }]
        },
        "criteria": {
          "language": "text/cql-identifier",
          "expression": "Numerator"
        }
      }
    ]
  }]
}
```

Key things to note about this resource:
- `library[]` contains the canonical URL of the `Library` resource that holds our CQL. This URL must exactly match the `Library.url` field we create in `RepositoryBuilder`.
- `criteria.language = "text/cql-identifier"` means the expression is a named `define` in the CQL library (not inline CQL).
- `scoring.code = "proportion"` — same pattern as all 4 demo measures (Initial Pop → Denominator → Numerator).

- [ ] **Step 3: Commit**

```bash
git add src/main/resources/
git commit -m "feat(spike): CQL library + FHIR Measure resource"
```

---

## Task 3: Test patient bundle

**Files:**
- Create: `src/main/resources/fhir/test-patient-bundle.json`

Two scenarios in one bundle: one patient with a procedure (should land in numerator), one without (should land in denominator only). This lets us verify both paths in a single run.

- [ ] **Step 1: Create the test patient bundle**

`src/main/resources/fhir/test-patient-bundle.json`:
```json
{
  "resourceType": "Bundle",
  "id": "test-patient-bundle",
  "type": "collection",
  "entry": [
    {
      "resource": {
        "resourceType": "Patient",
        "id": "patient-with-procedure",
        "active": true,
        "name": [{"family": "TestCompliant", "given": ["Alice"]}],
        "birthDate": "1985-06-15",
        "gender": "female"
      }
    },
    {
      "resource": {
        "resourceType": "Procedure",
        "id": "proc-001",
        "status": "completed",
        "subject": {
          "reference": "Patient/patient-with-procedure"
        },
        "code": {
          "coding": [{
            "system": "http://loinc.org",
            "code": "28615-2",
            "display": "Audiometry study"
          }]
        },
        "performedDateTime": "2026-03-10T10:00:00Z"
      }
    },
    {
      "resource": {
        "resourceType": "Patient",
        "id": "patient-without-procedure",
        "active": true,
        "name": [{"family": "TestOverdue", "given": ["Bob"]}],
        "birthDate": "1978-11-22",
        "gender": "male"
      }
    }
  ]
}
```

Expected evaluation outcome when run against measurement period 2026-01-01 to 2026-12-31:
- `patient-with-procedure`: InitialPop=1, Denominator=1, Numerator=1 (has completed procedure on 2026-03-10)
- `patient-without-procedure`: InitialPop=1, Denominator=1, Numerator=0 (no procedures)

- [ ] **Step 2: Commit**

```bash
git add src/main/resources/fhir/test-patient-bundle.json
git commit -m "feat(spike): test patient bundle (compliant + non-compliant)"
```

---

## Task 4: Java spike classes

**Files:**
- Create: `src/main/java/com/workwell/spike/ResourceLoader.java`
- Create: `src/main/java/com/workwell/spike/RepositoryBuilder.java`
- Create: `src/main/java/com/workwell/spike/CqfSpike.java`

- [ ] **Step 1: Create ResourceLoader.java**

Reads classpath resources and base64-encodes the CQL into a FHIR `Library` resource. The base64 encoding step is required by the CQL evaluation pipeline — the Library's `content.data` field must be base64.

```java
package com.workwell.spike;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.parser.IParser;
import org.hl7.fhir.r4.model.*;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

public class ResourceLoader {

    private final FhirContext fhirContext;
    private final IParser jsonParser;

    public ResourceLoader(FhirContext fhirContext) {
        this.fhirContext = fhirContext;
        this.jsonParser = fhirContext.newJsonParser().setPrettyPrint(true);
    }

    public Measure loadMeasure(String classpathPath) throws IOException {
        return (Measure) jsonParser.parseResource(readClasspath(classpathPath));
    }

    public Bundle loadBundle(String classpathPath) throws IOException {
        return (Bundle) jsonParser.parseResource(readClasspath(classpathPath));
    }

    /**
     * Reads the CQL text from classpath, base64-encodes it, and wraps it in
     * a FHIR Library resource. The Library canonical URL must match the
     * Measure.library[] reference exactly.
     */
    public Library buildLibraryFromCql(String cqlClasspathPath) throws IOException {
        String cqlText = readClasspath(cqlClasspathPath);
        String base64Cql = Base64.getEncoder().encodeToString(
            cqlText.getBytes(StandardCharsets.UTF_8)
        );

        Library library = new Library();
        library.setId("HasRecentProcedure");
        library.setUrl("http://workwell.spike.org/Library/HasRecentProcedure");
        library.setVersion("1.0.0");
        library.setName("HasRecentProcedure");
        library.setStatus(Enumerations.PublicationStatus.ACTIVE);
        library.getType().addCoding()
            .setSystem("http://terminology.hl7.org/CodeSystem/library-type")
            .setCode("logic-library");

        Attachment content = new Attachment();
        content.setContentType("text/cql");
        content.setDataElement(new Base64BinaryType(base64Cql));
        library.addContent(content);

        return library;
    }

    private String readClasspath(String path) throws IOException {
        try (InputStream is = getClass().getClassLoader().getResourceAsStream(path)) {
            if (is == null) {
                throw new IllegalArgumentException("Classpath resource not found: " + path);
            }
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
```

- [ ] **Step 2: Create RepositoryBuilder.java**

Assembles all FHIR resources into a single Bundle and creates the `InMemoryFhirRepository`. The repository is the single object that `R4MeasureProcessor` queries for everything — Measure, Library, patient data.

```java
package com.workwell.spike;

import ca.uhn.fhir.context.FhirContext;
import org.hl7.fhir.r4.model.*;
import org.opencds.cqf.fhir.api.Repository;
import org.opencds.cqf.fhir.utility.repository.InMemoryFhirRepository;

import java.util.List;

public class RepositoryBuilder {

    private final FhirContext fhirContext;
    private final Bundle masterBundle = new Bundle();

    public RepositoryBuilder(FhirContext fhirContext) {
        this.fhirContext = fhirContext;
        masterBundle.setType(Bundle.BundleType.COLLECTION);
    }

    public RepositoryBuilder add(Resource resource) {
        masterBundle.addEntry().setResource(resource);
        return this;
    }

    /**
     * Adds all entries from a Bundle into the master bundle.
     * Use this to add patient data (Patient, Procedure, Condition, etc.)
     */
    public RepositoryBuilder addAll(Bundle bundle) {
        bundle.getEntry().forEach(e -> masterBundle.addEntry().setResource(e.getResource()));
        return this;
    }

    public Repository build() {
        return new InMemoryFhirRepository(fhirContext, masterBundle);
    }
}
```

**If `InMemoryFhirRepository` is not found at this package path**, check the actual package by running:
```bash
./gradlew dependencies --configuration runtimeClasspath | grep cqf-fhir-utility
jar tf ~/.gradle/caches/modules-2/files-2.1/org.opencds.cqf.fhir/cqf-fhir-utility/VERSION/*/cqf-fhir-utility-VERSION.jar | grep -i "repository" | grep "\.class"
```
This lists all Repository-related classes. Update the import in `RepositoryBuilder.java` to match.

- [ ] **Step 3: Create CqfSpike.java**

```java
package com.workwell.spike;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.parser.IParser;
import org.hl7.fhir.r4.model.*;
import org.opencds.cqf.fhir.api.Repository;
import org.opencds.cqf.fhir.cr.measure.r4.R4MeasureProcessor;

import java.time.LocalDate;

public class CqfSpike {

    public static void main(String[] args) throws Exception {
        FhirContext fhirContext = FhirContext.forR4Cached();
        IParser printer = fhirContext.newJsonParser().setPrettyPrint(true);

        System.out.println("=== WorkWell cqf-fhir-cr Spike ===\n");

        // --- 1. Load resources ---
        ResourceLoader loader = new ResourceLoader(fhirContext);

        Measure measure = loader.loadMeasure("fhir/Measure-HasRecentProcedure.json");
        Library library = loader.buildLibraryFromCql("cql/HasRecentProcedure.cql");
        Bundle patientBundle = loader.loadBundle("fhir/test-patient-bundle.json");

        System.out.println("Loaded Measure: " + measure.getUrl());
        System.out.println("Loaded Library: " + library.getUrl());
        System.out.println("Patient bundle entries: " + patientBundle.getEntry().size());
        System.out.println();

        // --- 2. Build in-memory repository ---
        Repository repository = new RepositoryBuilder(fhirContext)
            .add(measure)
            .add(library)
            .addAll(patientBundle)
            .build();

        System.out.println("Repository built with all resources.\n");

        // --- 3. Evaluate the measure ---
        // IMPORTANT: R4MeasureProcessor constructor and evaluateMeasure() signature
        // may differ between versions. If this does not compile:
        //   a) Run: jar tf <cqf-fhir-cr jar> | grep R4MeasureProcessor
        //   b) Open the class in your IDE to see actual constructor + method signatures
        //   c) Update accordingly and record the actual API in SPIKE_NOTES.md
        R4MeasureProcessor processor = new R4MeasureProcessor(repository);

        String measureUrl = "http://workwell.spike.org/Measure/HasRecentProcedure";
        String periodStart = "2026-01-01";
        String periodEnd   = "2026-12-31";

        // Evaluate for each patient separately (subject-level report)
        for (String patientId : new String[]{"patient-with-procedure", "patient-without-procedure"}) {
            System.out.println("--- Evaluating for Patient/" + patientId + " ---");

            MeasureReport report = processor.evaluateMeasure(
                measureUrl,
                periodStart,
                periodEnd,
                "subject",           // report type: "subject" | "subject-list" | "population"
                null,                // practitioner (null = any)
                "Patient/" + patientId,
                null,                // last received on
                null,                // product line
                null,                // program
                null                 // additional data
            );

            System.out.println(printer.encodeResourceToString(report));
            System.out.println();
        }

        System.out.println("=== Spike complete ===");
    }
}
```

**If `evaluateMeasure` does not compile** (wrong number of args, wrong types), run:
```bash
jar tf ~/.gradle/caches/modules-2/files-2.1/org.opencds.cqf.fhir/cqf-fhir-cr/VERSION/*/cqf-fhir-cr-VERSION.jar | grep R4MeasureProcessor
javap -p ~/.gradle/caches/modules-2/files-2.1/org.opencds.cqf.fhir/cqf-fhir-cr/VERSION/*/cqf-fhir-cr-VERSION.jar com/workwell/...R4MeasureProcessor.class
```

This shows the actual method signatures. Update `CqfSpike.java` to match and record the actual signature in `SPIKE_NOTES.md`.

- [ ] **Step 4: Attempt to compile**

```bash
./gradlew compileJava
```

Expected: `BUILD SUCCESSFUL`.

Common failures at this stage and their fixes:

| Error | Fix |
|-------|-----|
| `cannot find symbol: class InMemoryFhirRepository` | Wrong package. Grep the jar: `jar tf <cqf-fhir-utility jar> \| grep -i memory` |
| `cannot find symbol: class R4MeasureProcessor` | Wrong package or wrong artifact. Add `cqf-fhir-cr-hapi` to deps. |
| `incompatible types: IBaseResource` | HAPI version mismatch. Pin HAPI explicitly to match cqf's transitive. |
| `method evaluateMeasure not found` | Signature changed. Use `javap` to find actual method. |

Record every fix in `SPIKE_NOTES.md` under "Compilation gotchas".

- [ ] **Step 5: Run the spike**

```bash
./gradlew run
```

Expected output structure:
```
=== WorkWell cqf-fhir-cr Spike ===

Loaded Measure: http://workwell.spike.org/Measure/HasRecentProcedure
Loaded Library: http://workwell.spike.org/Library/HasRecentProcedure
Patient bundle entries: 3

Repository built with all resources.

--- Evaluating for Patient/patient-with-procedure ---
{
  "resourceType": "MeasureReport",
  "status": "complete",
  "type": "individual",
  ...
  "group": [{
    "population": [
      { "code": {..., "code": "initial-population"}, "count": 1 },
      { "code": {..., "code": "denominator"},        "count": 1 },
      { "code": {..., "code": "numerator"},           "count": 1 }
    ]
  }]
}

--- Evaluating for Patient/patient-without-procedure ---
{
  ...
  "group": [{
    "population": [
      { "code": {..., "code": "initial-population"}, "count": 1 },
      { "code": {..., "code": "denominator"},        "count": 1 },
      { "code": {..., "code": "numerator"},           "count": 0 }
    ]
  }]
}

=== Spike complete ===
```

Verify: `patient-with-procedure` numerator count = 1, `patient-without-procedure` numerator count = 0. If both show 0 or both show 1, the Procedure data is not being retrieved correctly — see "Debugging tips" below.

**Debugging tips if numerator is always 0:**
1. Print the MeasureReport's `evaluatedResource` list — it shows which FHIR resources the CQL engine actually read. If it's empty, data retrieval is broken.
2. Check that `Procedure.subject.reference = "Patient/patient-with-procedure"` matches exactly.
3. Check that `Procedure.performedDateTime = "2026-03-10T10:00:00Z"` falls within the period start/end passed to `evaluateMeasure`.
4. Try changing the `context Patient` in CQL to `context Unfiltered` to rule out patient-scoping issues.

**Debugging if you get a NullPointerException or missing Library error:**
1. The canonical URL in `Measure.library[]` must exactly match `Library.url`. Check for trailing slashes, version suffixes.
2. The `Library.content[0].contentType` must be `"text/cql"` exactly (not `"text/cql+identifier"` or `"application/elm+xml"`).

- [ ] **Step 6: Commit**

```bash
git add src/
git commit -m "feat(spike): CqfSpike evaluates HasRecentProcedure measure, prints MeasureReport"
```

---

## Task 5: Write SPIKE_NOTES.md

The deliverable. Document everything learned so Phase 2 doesn't start from scratch.

- [ ] **Step 1: Create SPIKE_NOTES.md**

Template — fill in each section with actual values observed during the spike:

```markdown
# cqf-fhir-cr Spike Notes

**Date:** 2026-04-29  
**Engineer:** Taleef Tamsal  
**Goal:** Validate that `cqf-fhir-cr` can evaluate a CQL measure against in-memory FHIR data outside a server.

**Result:** [SUCCESS / PARTIAL / FAILED — and one-line summary]

---

## Versions that worked

| Artifact | Version used | Maven Central link |
|----------|-------------|-------------------|
| `org.opencds.cqf.fhir:cqf-fhir-cr` | X.X.X | [link] |
| `org.opencds.cqf.fhir:cqf-fhir-utility` | X.X.X | [link] |
| `org.opencds.cqf.fhir:cqf-fhir-cql` | X.X.X | [link] |
| `ca.uhn.hapi.fhir:hapi-fhir-base` | X.X.X | (transitive) |
| `ca.uhn.hapi.fhir:hapi-fhir-structures-r4` | X.X.X | (transitive) |

---

## API surface used

### Entry point class
```
package: [actual package]
class: R4MeasureProcessor
constructor: [exact signature observed]
```

### evaluateMeasure() signature
```java
// Actual signature from javap / IDE:
MeasureReport evaluateMeasure(
    [param 1 type] [param 1 name],
    [param 2 type] [param 2 name],
    ...
);
```

### InMemoryFhirRepository
```
package: [actual package]
constructor: InMemoryFhirRepository(FhirContext, Bundle)
```

---

## What the pipeline actually needs (confirmed)

- [ ] `Library` resource in repository with `content[0].contentType = "text/cql"` and `data` = base64 CQL
- [ ] `Measure` resource in repository with `library[]` = canonical URL matching Library.url exactly
- [ ] Patient + clinical data resources in the same repository (or a composable repository)
- [ ] Measurement Period passed as ISO-8601 date strings (not as FHIR Period objects)
- [ ] FHIRHelpers: [was it bundled automatically, or did we need to add it?]

---

## Surprises / gotchas

1. [Describe anything unexpected that required a fix]
2. [Note any classes that don't exist despite being in docs]
3. [Note any transitive dependency conflicts and how you resolved them]

---

## Implications for Phase 2 (Week 5–6)

### What the Run Service needs to do
The `FhirDataFetcher` must:
1. Load the active `MeasureVersion` from Postgres — get its `cql_text`
2. Build a FHIR `Library` resource programmatically (base64-encode the CQL)
3. Build a FHIR `Measure` resource from `spec_json` (or load from HAPI FHIR JPA)
4. Fetch patient data from HAPI FHIR JPA for the employee in scope
5. Combine into a Repository and call `R4MeasureProcessor.evaluateMeasure()`

### Difference from this spike when using HAPI FHIR JPA
In production, the repository is backed by a running HAPI FHIR JPA server, not in-memory.
The `cqf-fhir-cr-hapi` artifact provides `JpaFhirRepository` (or similar) that wraps the JPA store.
The Measure + Library resources should be registered in HAPI FHIR, not built programmatically.

### Risk update for plan §17
[Was the integration as hard as feared? Did anything need plan adjustment?]

---

## How to re-run this spike

```bash
cd ../workwell-spike-cqf
./gradlew run
```
```

- [ ] **Step 2: Commit SPIKE_NOTES.md**

```bash
git add SPIKE_NOTES.md
git commit -m "docs(spike): SPIKE_NOTES with versions, API surface, Phase 2 implications"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| Minimal Java 21 + Gradle, no Spring | Task 1 |
| HAPI FHIR + cqf-fhir-cr at latest stable | Task 1 Steps 2–4 |
| Load FHIR Bundle from disk | Task 3 + ResourceLoader |
| Trivial CQL measure from disk (has-recent-procedure) | Task 2 Step 1 |
| Evaluate measure against bundle | Task 4 Step 3–5 |
| Print resulting MeasureReport JSON | Task 4 Step 5 |
| SPIKE_NOTES.md with versions, gotchas, API surface, Phase 2 implications | Task 5 |

### Placeholder scan

- Version numbers: deliberately left as `CQF_CR_VERSION` / `CQF_UTILITY_VERSION` with explicit instructions to look up live values at Step 1.2. This is intentional — they change frequently and pinning stale values in the plan would cause failures.
- `evaluateMeasure()` signature: provided a likely form with explicit fallback instructions for when it doesn't compile. This is a spike — the signature discovery is part of the work.
- No other TBD/TODO patterns.

### Type consistency

- `Repository` interface referenced in `RepositoryBuilder.build()` return type and `CqfSpike` parameter — consistent.
- `InMemoryFhirRepository(FhirContext, Bundle)` constructor — same args in both RepositoryBuilder and the note in Task 4 Step 2 fallback instructions.
- `ResourceLoader` methods: `loadMeasure()` → `Measure`, `loadBundle()` → `Bundle`, `buildLibraryFromCql()` → `Library` — all consistent with how they're used in `CqfSpike.java`.
- `R4MeasureProcessor(repository)` constructor — consistent across RepositoryBuilder output type and CqfSpike usage.
