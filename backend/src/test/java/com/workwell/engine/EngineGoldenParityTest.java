package com.workwell.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

/**
 * Characterization (golden-file) baseline for the measure engine. Captures the deterministic
 * (employeeExternalId -> outcomeStatus) mapping for every runnable measure so the E1 ports/adapters
 * refactor can be proven to leave outcomes unchanged.
 *
 * <p>The CQL uses {@code Now()} for recency math, so absolute-date evidence fields drift by run date
 * and are intentionally excluded; the per-employee outcome bucket is date-independent and is the
 * meaningful invariant.
 */
class EngineGoldenParityTest {

    // measureName -> CQL resource file (the 10 runnable measures)
    private static final Map<String, String> MEASURES = buildMeasures();

    private static Map<String, String> buildMeasures() {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("Audiogram", "audiogram.cql");
        m.put("TB Surveillance", "tb_surveillance.cql");
        m.put("HAZWOPER Surveillance", "hazwoper.cql");
        m.put("Flu Vaccine", "flu_vaccine.cql");
        m.put("Hypertension BP Screening", "hypertension.cql");
        m.put("Diabetes HbA1c Monitoring", "diabetes_hba1c.cql");
        m.put("BMI Screening & Counseling", "obesity_bmi.cql");
        m.put("Cholesterol LDL Screening", "cholesterol_ldl.cql");
        m.put("Breast Cancer Screening", "cms125.cql");
        m.put("Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)", "cms122.cql");
        return m;
    }

    // Generate goldens when true; compare when false. Committed value MUST be false.
    private static final boolean WRITE_MODE = false;

    private CqlEvaluationService newService() {
        return new CqlEvaluationService(new EvaluationPopulationProperties());
    }

    private String fixtureName(String cql) {
        return cql.replace(".cql", ".txt");
    }

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
        return FileCopyUtils.copyToString(
                new java.io.InputStreamReader(new ClassPathResource(p).getInputStream(), StandardCharsets.UTF_8));
    }
}
