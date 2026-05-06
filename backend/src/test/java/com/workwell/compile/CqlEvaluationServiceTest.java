package com.workwell.compile;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

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

    @SuppressWarnings("unchecked")
    @Test
    void cqlEvaluationProducesRealExpressionResults() throws Exception {
        CqlEvaluationService service = new CqlEvaluationService();
        String cqlText = readClasspathText("measures/audiogram.cql");

        DemoRunPayload payload = service.evaluate(
                "11111111-1111-1111-1111-111111111111",
                "Audiogram",
                "v1.0",
                cqlText,
                LocalDate.now()
        );

        DemoOutcome overdue = payload.outcomes().stream()
                .filter(o -> "emp-003".equals(o.subjectId()))
                .findFirst()
                .orElseThrow();

        assertEquals("OVERDUE", overdue.outcome());
        List<Map<String, Object>> expressionResults = (List<Map<String, Object>>) overdue.evidenceJson().get("expressionResults");
        assertNotNull(expressionResults);
        boolean hasOverdueTrue = expressionResults.stream().anyMatch(row ->
                "Overdue".equals(String.valueOf(row.get("define")))
                        && "true".equalsIgnoreCase(String.valueOf(row.get("result"))));
        assertTrue(hasOverdueTrue, "Expected real CQL define result Overdue=true");
    }

    @Test
    void perEmployeeFailureIsolationKeepsRunGoing() throws Exception {
        CqlEvaluationService service = new CqlEvaluationService() {
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

        assertEquals("MISSING_DATA", failed.outcome());
        assertEquals("CQL engine failure", String.valueOf(failed.evidenceJson().get("evaluationError")));

        boolean hasSuccessfulOthers = payload.outcomes().stream()
                .filter(o -> !"emp-002".equals(o.subjectId()))
                .anyMatch(o -> o.evidenceJson().get("expressionResults") != null);
        assertTrue(hasSuccessfulOthers, "Expected other employees to evaluate successfully");

        boolean everyoneFailed = payload.outcomes().stream()
                .allMatch(o -> "MISSING_DATA".equals(o.outcome()) && o.evidenceJson().containsKey("evaluationError"));
        assertFalse(everyoneFailed, "Expected isolated failure, not full-run failure");
    }

    private String readClasspathText(String resourcePath) throws Exception {
        ClassPathResource resource = new ClassPathResource(resourcePath);
        return FileCopyUtils.copyToString(new java.io.InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8));
    }
}
