package com.workwell.engine;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.engine.synthetic.PropertiesEvaluationConfigProvider;
import com.workwell.engine.synthetic.SyntheticEmployeeDirectory;
import com.workwell.engine.yaml.YamlMeasureDefinitionProvider;
import com.workwell.engine.synthetic.SyntheticPatientDataProvider;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

/**
 * Proves the measure engine core runs with plain {@code new} wiring and NO Spring
 * {@code ApplicationContext} — the acceptance gate for the Spring-free engine boundary (#83).
 */
class EngineNoSpringContextTest {

    @Test
    void evaluatesWithoutSpringContext() throws Exception {
        CqlEvaluationService service = new CqlEvaluationService(
                new SyntheticPatientDataProvider(),
                new SyntheticEmployeeDirectory(),
                new YamlMeasureDefinitionProvider(),
                new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));

        String cql = FileCopyUtils.copyToString(new java.io.InputStreamReader(
                new ClassPathResource("measures/audiogram.cql").getInputStream(), StandardCharsets.UTF_8));

        DemoRunPayload payload = service.evaluate(
                "00000000-0000-0000-0000-000000000000", "Audiogram", "v1.0", cql, LocalDate.now());

        assertEquals(100, payload.outcomes().size());
    }
}
