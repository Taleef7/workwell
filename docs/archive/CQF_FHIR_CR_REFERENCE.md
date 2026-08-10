# CQF FHIR CR Reference

Date: 2026-05-01

## 1) Confirmed Maven Coordinates and Version Pin

Confirmed on Maven Central metadata:

- `org.opencds.cqf.fhir:cqf-fhir-cr`
- `org.opencds.cqf.fhir:cqf-fhir-cr-hapi`

Version notes:

- Main-spike-compatible pin: `3.26.0`
- Latest available (as of 2026-05-01): `4.6.0`

Metadata sources:

- `https://repo.maven.apache.org/maven2/org/opencds/cqf/fhir/cqf-fhir-cr/maven-metadata.xml`
- `https://repo.maven.apache.org/maven2/org/opencds/cqf/fhir/cqf-fhir-cr-hapi/maven-metadata.xml`

## 2) Minimal Working Wiring for `R4MeasureService`

```kotlin
// build.gradle.kts
dependencies {
    implementation("org.opencds.cqf.fhir:cqf-fhir-cr:3.26.0")
    implementation("org.opencds.cqf.fhir:cqf-fhir-cql:3.26.0")
    implementation("org.opencds.cqf.fhir:cqf-fhir-utility:3.26.0")

    // Required runtime extras discovered in spike
    runtimeOnly("ca.uhn.hapi.fhir:hapi-fhir-caching-caffeine:8.4.0")
    runtimeOnly("org.eclipse.persistence:org.eclipse.persistence.moxy:4.0.2")
}
```

```java
FhirContext fhirContext = FhirContext.forR4Cached();
fhirContext.setValidationSupport(new DefaultProfileValidationSupport(fhirContext));

R4MeasureService service = new R4MeasureService(
    repository, // ca.uhn.fhir.repository.IRepository
    MeasureEvaluationOptions.defaultOptions(),
    new MeasurePeriodValidator()
);
```

## 3) Plan Corrections (from spike)

| Plan assumed | Reality |
|---|---|
| Use `R4MeasureProcessor` directly | Use `R4MeasureService(repo, options, validator)` for main wiring |
| Use `org.opencds.cqf.fhir.api.Repository` | Use `ca.uhn.fhir.repository.IRepository` |
| `Library.content.data` pre-base64 | `Attachment.setData(byte[])` must receive raw bytes |
| `InMemoryFhirRepository.create()` okay for loaded resources | Use `update()` to preserve ids used by measure evaluation |
| No extra runtime deps beyond core cqf artifacts | Add caffeine cache provider + moxy + `setValidationSupport(...)` |
| Build `evidence_json` via custom extraction | `MeasureReport.evaluatedResource` already provides evidence links |

## 4) JPA Path Transferability

- `cqf-fhir-cr-hapi` provides the bridge from HAPI JPA internals to `IRepository`.
- In the `3.26.0` line, `RepositoryConfig` wires `HapiFhirRepository`.
- `HapiFhirRepository` implements `ca.uhn.fhir.repository.IRepository`.
- Result: the same `R4MeasureService` wiring transfers from in-memory to JPA without a constructor/interface rewrite.

## 5) Known Gotcha: Classpath Conflict (cost ~15 min)

Exact symptom observed in sub-spike test logs:

- `Multiple ModelInfoReaderProviders found on the classpath. You need to remove a reference to either the 'model-jackson' or the 'model-jaxb' package`
- Follow-on failures included many CQL model resolution errors and numerator dropped to `0` for the positive patient.

Exact fix that restored passing behavior:

```kotlin
testImplementation("org.opencds.cqf.fhir:cqf-fhir-cr-hapi:3.26.0") {
    exclude(group = "org.opencds.cqf.fhir", module = "cqf-fhir-jackson")
}
```

Why this fix: this keeps a single model reader path (`model-jaxb`) instead of conflicting reader providers.

## 6) Working Example Pointer

Full runnable examples live in spike repo:

- `../workwell-spike-cqf/SPIKE_REPORT.md`
- `../workwell-spike-cqf/SPIKE_NOTES.md`
- `../workwell-spike-cqf/src/main/java/com/workwell/spike/CqfSpike.java`
- `../workwell-spike-cqf/src/test/java/com/workwell/spike/HapiJpaPathSubSpikeTest.java`

## ADR-002 Probe: Per-Define Results for `evidence_json`

Question: does measure evaluation expose `{define_name -> value}` directly?

Probe result:

- `R4MeasureService.evaluate(...)` returns `MeasureReport` only; no define-result map is surfaced on `MeasureReport`.
- `R4MeasureProcessor.evaluateMeasureWithCqlEngine(...)` returns `CompositeEvaluationResultsPerMeasure`, which contains per-subject `EvaluationResult`.
- `EvaluationResult.expressionResults` exposes define names and values.

Observed in probe output:

- `EXPR_KEYS=[Denominator, Initial Population, Numerator, Patient]`
- `EXPR_VALUE=Denominator => true`
- `EXPR_VALUE=Initial Population => true`
- `EXPR_VALUE=Numerator => true`

Implication for ADR-002:

- If we keep service-level integration only: choose A/B (`evaluatedResource`-driven evidence with optional AI summarization).
- If we allow processor-level capture in run pipeline: `rule_path[]` can be generated from define names/values without AI.
