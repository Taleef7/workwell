package com.workwell.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.compile.SyntheticFhirBundleBuilder;
import com.workwell.engine.model.BundleOutcome;
import com.workwell.engine.synthetic.PropertiesEvaluationConfigProvider;
import com.workwell.engine.synthetic.SyntheticEmployeeDirectory;
import com.workwell.engine.synthetic.SyntheticPatientDataProvider;
import com.workwell.engine.yaml.YamlMeasureDefinitionProvider;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

/**
 * Proves the measure engine core runs with plain {@code new} wiring and NO Spring
 * {@code ApplicationContext} — the acceptance gate for the Spring-free engine boundary (#83, #88).
 */
class EngineNoSpringContextTest {

    private static CqlEvaluationService newService() {
        return new CqlEvaluationService(
                new SyntheticPatientDataProvider(),
                new SyntheticEmployeeDirectory(),
                new YamlMeasureDefinitionProvider(),
                new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));
    }

    private static String readClasspath(String path) throws Exception {
        return FileCopyUtils.copyToString(new java.io.InputStreamReader(
                new ClassPathResource(path).getInputStream(), StandardCharsets.UTF_8));
    }

    @Test
    void evaluatesWithoutSpringContext() throws Exception {
        DemoRunPayload payload = newService().evaluate(
                "00000000-0000-0000-0000-000000000000", "Audiogram", "v1.0",
                readClasspath("measures/audiogram.cql"), LocalDate.now());

        assertEquals(100, payload.outcomes().size());
    }

    @Test
    void evaluatesArbitraryBundleHeadlessly() throws Exception {
        CqlEvaluationService service = newService();
        String cql = readClasspath("measures/audiogram.cql");

        // A compliant subject: enrolled in the hearing program, no waiver, audiogram 100 days ago.
        EmployeeProfile employee = new EmployeeProfile("headless-001", "Headless Test", "Welder", "Plant A");
        SyntheticFhirBundleBuilder.ExamConfig config = new SyntheticFhirBundleBuilder.ExamConfig(
                100, false, true,
                "hearing-enrollment", "urn:workwell:vs:hearing-enrollment",
                "audiogram-waiver", "urn:workwell:vs:audiogram-waiver",
                "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false);
        Bundle bundle = new SyntheticFhirBundleBuilder().buildBundle(employee, config, LocalDate.now());

        BundleOutcome outcome = service.evaluateBundle(
                "Audiogram", "v1.0", cql, LocalDate.now(), bundle, "headless-001");

        assertEquals("COMPLIANT", outcome.outcomeStatus());
        assertEquals("headless-001", outcome.subjectId());
        assertFalse(outcome.expressionResults().isEmpty());
    }
}
