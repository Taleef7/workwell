package com.workwell.compile;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.workwell.engine.synthetic.PropertiesEvaluationConfigProvider;
import com.workwell.engine.synthetic.SyntheticEmployeeDirectory;
import com.workwell.engine.yaml.YamlMeasureDefinitionProvider;
import com.workwell.engine.synthetic.SyntheticPatientDataProvider;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

class CqlEvaluationServiceTest {

    private static CqlEvaluationService newService() {
        return new CqlEvaluationService(
                new SyntheticPatientDataProvider(),
                new SyntheticEmployeeDirectory(),
                new YamlMeasureDefinitionProvider(),
                new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));
    }

    @SuppressWarnings("unchecked")
    @Test
    void cqlEvaluationProducesRealExpressionResults() throws Exception {
        CqlEvaluationService service = newService();
        String cqlText = readClasspathText("measures/audiogram.cql");

        DemoRunPayload payload = service.evaluate(
                "11111111-1111-1111-1111-111111111111",
                "Audiogram",
                "v1.0",
                cqlText,
                LocalDate.now()
        );

        DemoOutcome overdue = payload.outcomes().stream()
                .filter(o -> "OVERDUE".equals(o.outcome()))
                .findFirst()
                .orElseThrow();

        assertEquals(100, payload.outcomes().size());
        assertEquals("OVERDUE", overdue.outcome(), "Outcome payload: " + overdue.evidenceJson());
        List<Map<String, Object>> expressionResults = (List<Map<String, Object>>) overdue.evidenceJson().get("expressionResults");
        assertNotNull(expressionResults);
        boolean hasOverdueTrue = expressionResults.stream().anyMatch(row ->
                "Overdue".equals(String.valueOf(row.get("define")))
                        && "true".equalsIgnoreCase(String.valueOf(row.get("result"))));
        assertTrue(hasOverdueTrue, "Expected real CQL define result Overdue=true");
    }

    @Test
    void singleSubjectEvaluationMatchesBatchOutcome() throws Exception {
        CqlEvaluationService service = newService();
        String cqlText = readClasspathText("measures/audiogram.cql");
        LocalDate evaluationDate = LocalDate.now();

        DemoRunPayload payload = service.evaluate(
                "11111111-1111-1111-1111-111111111111",
                "Audiogram",
                "v1.0",
                cqlText,
                evaluationDate
        );

        DemoOutcome expected = payload.outcomes().stream()
                .filter(outcome -> "emp-003".equals(outcome.subjectId()))
                .findFirst()
                .orElseThrow();

        DemoOutcome actual = service.evaluateSubject(
                "Audiogram",
                "v1.0",
                cqlText,
                evaluationDate,
                "emp-003"
        );

        assertEquals(expected.outcome(), actual.outcome());
        assertEquals(expected.summary(), actual.summary());
        assertEquals(expected.evidenceJson().keySet(), actual.evidenceJson().keySet());
        assertEquals(expected.evidenceJson().get("expressionResults"), actual.evidenceJson().get("expressionResults"));
        assertEquals(expected.evidenceJson().get("evaluatedResource"), actual.evidenceJson().get("evaluatedResource"));
        
        Map<String, Object> expectedWhyFlagged = (Map<String, Object>) expected.evidenceJson().get("why_flagged");
        Map<String, Object> actualWhyFlagged = (Map<String, Object>) actual.evidenceJson().get("why_flagged");
        assertNotNull(expectedWhyFlagged);
        assertNotNull(actualWhyFlagged);
        assertEquals(expectedWhyFlagged.keySet(), actualWhyFlagged.keySet());
        assertEquals(expectedWhyFlagged.get("last_exam_date"), actualWhyFlagged.get("last_exam_date"));
        assertEquals(expectedWhyFlagged.get("compliance_window_days"), actualWhyFlagged.get("compliance_window_days"));
        assertEquals(expectedWhyFlagged.get("days_overdue"), actualWhyFlagged.get("days_overdue"));
        assertEquals(expectedWhyFlagged.get("role_eligible"), actualWhyFlagged.get("role_eligible"));
        assertEquals(expectedWhyFlagged.get("site_eligible"), actualWhyFlagged.get("site_eligible"));
        assertEquals(expectedWhyFlagged.get("waiver_status"), actualWhyFlagged.get("waiver_status"));
        assertEquals(expectedWhyFlagged.get("outcome_status"), actualWhyFlagged.get("outcome_status"));

        Map<String, Object> whyFlagged = actualWhyFlagged;
        assertNotNull(whyFlagged);
        assertTrue(whyFlagged.containsKey("last_exam_date"));
        assertTrue(whyFlagged.containsKey("compliance_window_days"));
        assertTrue(whyFlagged.containsKey("days_overdue"));
        assertTrue(whyFlagged.containsKey("role_eligible"));
        assertTrue(whyFlagged.containsKey("site_eligible"));
        assertTrue(whyFlagged.containsKey("waiver_status"));
        assertTrue(whyFlagged.containsKey("outcome_status"));
        assertTrue(whyFlagged.containsKey("generated_at"));

        List<Map<String, Object>> expressionResults = (List<Map<String, Object>>) actual.evidenceJson().get("expressionResults");
        assertTrue(expressionResults.stream().anyMatch(row -> "Outcome Status".equals(String.valueOf(row.get("define")))),
                "Expected Outcome Status in expressionResults: " + expressionResults);
    }

    @Test
    void perEmployeeFailureIsolationKeepsRunGoing() throws Exception {
        CqlEvaluationService service = new CqlEvaluationService(
                new SyntheticPatientDataProvider(),
                new SyntheticEmployeeDirectory(),
                new YamlMeasureDefinitionProvider(),
                new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties())) {
            @Override
            protected boolean shouldFailEmployeeForTesting(String employeeExternalId) {
                return "emp-002".equals(employeeExternalId);
            }
        };

        String cqlText = readClasspathText("measures/audiogram.cql");

        DemoRunPayload payload = assertDoesNotThrow(() -> service.evaluate(
                "22222222-2222-2222-2222-222222222222",
                "Audiogram",
                "v1.0",
                cqlText,
                LocalDate.now()
        ));

        DemoOutcome failed = payload.outcomes().stream()
                .filter(o -> "emp-002".equals(o.subjectId()))
                .findFirst()
                .orElseThrow();

        assertEquals("CQL engine failure", String.valueOf(failed.evidenceJson().get("evaluationError")));
        assertEquals("MISSING_DATA", failed.outcome());
        assertEquals(failed.outcome(), String.valueOf(failed.evidenceJson().get("fallbackOutcome")));

        boolean hasSuccessfulOthers = payload.outcomes().stream()
                .filter(o -> !"emp-002".equals(o.subjectId()))
                .anyMatch(o -> o.evidenceJson().get("expressionResults") != null);
        assertTrue(hasSuccessfulOthers, "Expected other employees to evaluate successfully. Outcomes: " + payload.outcomes());

        boolean everyoneFailed = payload.outcomes().stream()
                .allMatch(o -> o.evidenceJson().containsKey("evaluationError"));
        assertFalse(everyoneFailed, "Expected isolated failure, not full-run failure");
    }

    @Test
    void tbHazwoperAndFluEvaluationsProduceStructuredOutcomes() throws Exception {
        CqlEvaluationService service = newService();

        for (String measureName : List.of("TB Surveillance", "HAZWOPER Surveillance", "Flu Vaccine")) {
            String cqlText = readClasspathText("measures/" + resourceName(measureName) + ".cql");
            DemoRunPayload payload = service.evaluate(
                    "33333333-3333-3333-3333-333333333333",
                    measureName,
                    "v1.0",
                    cqlText,
                    LocalDate.now()
            );

            assertEquals(100, payload.outcomes().size(), measureName + " should evaluate every seeded employee");
            long excludedCount = payload.outcomes().stream().filter(outcome -> "EXCLUDED".equals(outcome.outcome())).count();
            long compliantCount = payload.outcomes().stream().filter(outcome -> "COMPLIANT".equals(outcome.outcome())).count();
            assertEquals(3, excludedCount, measureName + " should preserve the seeded exclusion cohort");
            assertTrue(compliantCount > 0, measureName + " should produce compliant outcomes");
        }
    }

    @Test
    @SuppressWarnings("unchecked")
    void cms125BreastCancerScreeningProducesAllFiveOutcomeBuckets() throws Exception {
        CqlEvaluationService service = newService();
        String cqlText = readClasspathText("measures/cms125.cql");

        DemoRunPayload payload = service.evaluate(
                "44444444-4444-4444-4444-444444444444",
                "Breast Cancer Screening",
                "v1.0",
                cqlText,
                LocalDate.now()
        );

        assertEquals(100, payload.outcomes().size(), "CMS125 should evaluate every seeded employee");

        long compliant = payload.outcomes().stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long dueSoon = payload.outcomes().stream().filter(o -> "DUE_SOON".equals(o.outcome())).count();
        long overdue = payload.outcomes().stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = payload.outcomes().stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = payload.outcomes().stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();

        assertTrue(compliant > 0, "CMS125 should produce COMPLIANT outcomes");
        assertTrue(dueSoon > 0, "CMS125 should produce DUE_SOON outcomes");
        assertTrue(overdue > 0, "CMS125 should produce OVERDUE outcomes");
        assertTrue(missingData > 0, "CMS125 should produce MISSING_DATA outcomes");
        assertTrue(excluded > 0, "CMS125 should produce EXCLUDED outcomes");

        DemoOutcome overdueOutcome = payload.outcomes().stream()
                .filter(o -> "OVERDUE".equals(o.outcome()))
                .findFirst()
                .orElseThrow();
        List<Map<String, Object>> expressionResults = (List<Map<String, Object>>) overdueOutcome.evidenceJson().get("expressionResults");
        assertNotNull(expressionResults);
        assertTrue(expressionResults.stream().anyMatch(r -> "Outcome Status".equals(r.get("define"))),
                "CMS125 evidence should contain Outcome Status define");
    }

    @Test
    @SuppressWarnings("unchecked")
    void cms122DiabetesHbA1cProducesStructuredOutcomes() throws Exception {
        CqlEvaluationService service = newService();
        String cqlText = readClasspathText("measures/cms122.cql");

        DemoRunPayload payload = service.evaluate(
                "55555555-5555-5555-5555-555555555555",
                "Diabetes: Hemoglobin A1c (HbA1c) Poor Control (> 9%)",
                "v1.0",
                cqlText,
                LocalDate.now()
        );

        assertEquals(100, payload.outcomes().size(), "CMS122 should evaluate every seeded employee");

        long compliant = payload.outcomes().stream().filter(o -> "COMPLIANT".equals(o.outcome())).count();
        long overdue = payload.outcomes().stream().filter(o -> "OVERDUE".equals(o.outcome())).count();
        long missingData = payload.outcomes().stream().filter(o -> "MISSING_DATA".equals(o.outcome())).count();
        long excluded = payload.outcomes().stream().filter(o -> "EXCLUDED".equals(o.outcome())).count();

        assertTrue(compliant > 0, "CMS122 should produce COMPLIANT outcomes (good HbA1c control)");
        assertTrue(overdue > 0, "CMS122 should produce OVERDUE outcomes (poor HbA1c control > 9%)");
        assertTrue(missingData > 0, "CMS122 should produce MISSING_DATA outcomes (no HbA1c result)");
        assertTrue(excluded > 0, "CMS122 should produce EXCLUDED outcomes");

        DemoOutcome overdueOutcome = payload.outcomes().stream()
                .filter(o -> "OVERDUE".equals(o.outcome()))
                .findFirst()
                .orElseThrow();
        List<Map<String, Object>> expressionResults = (List<Map<String, Object>>) overdueOutcome.evidenceJson().get("expressionResults");
        assertNotNull(expressionResults, "CMS122 OVERDUE evidence should contain expressionResults");
        assertTrue(
                expressionResults.stream().anyMatch(r -> "HbA1c Poor Control".equals(r.get("define")) && "true".equalsIgnoreCase(String.valueOf(r.get("result")))),
                "CMS122 OVERDUE evidence should show HbA1c Poor Control=true, got: " + expressionResults
        );
    }

    private String resourceName(String measureName) {
        return switch (measureName) {
            case "TB Surveillance" -> "tb_surveillance";
            case "HAZWOPER Surveillance" -> "hazwoper";
            case "Flu Vaccine" -> "flu_vaccine";
            default -> throw new IllegalArgumentException(measureName);
        };
    }

    private String readClasspathText(String resourcePath) throws Exception {
        ClassPathResource resource = new ClassPathResource(resourcePath);
        return FileCopyUtils.copyToString(new java.io.InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8));
    }
}
