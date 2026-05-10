package com.workwell.measure;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.measure.MeasureTraceabilityService.TraceabilityResponse;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers
class MeasureTraceabilityIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.flyway.url", postgres::getJdbcUrl);
        registry.add("spring.flyway.user", postgres::getUsername);
        registry.add("spring.flyway.password", postgres::getPassword);
    }

    @Autowired
    private MeasureService measureService;

    @Autowired
    private MeasureTraceabilityService traceabilityService;

    @Test
    void returnsTraceabilityRowsForSeededMeasure() {
        // listMeasures triggers seed
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Audiogram measure not seeded"));

        TraceabilityResponse response = traceabilityService.generate(audiogram.id());

        assertThat(response).isNotNull();
        assertThat(response.measureId()).isEqualTo(audiogram.id());
        assertThat(response.measureName()).isEqualTo("Audiogram");
        assertThat(response.rows()).isNotEmpty();

        // At least one row should have a policy citation
        assertThat(response.rows()).anyMatch(r -> r.policyCitation() != null && !r.policyCitation().isBlank());

        // At least one row should reference a CQL define
        assertThat(response.rows()).anyMatch(r -> r.cqlDefine() != null && !r.cqlDefine().isBlank());
    }

    @Test
    void returnsGapsForSeededMeasureWithNoFixtures() {
        var measureId = measureService.createMeasure("Trace Gap Test", "OSHA test-gap", "QA");
        measureService.updateCql(measureId,
                "library TraceGap version '1.0.0'\n\ndefine \"Initial Population\": true\ndefine \"Outcome Status\": 'COMPLIANT'");

        TraceabilityResponse response = traceabilityService.generate(measureId);

        assertThat(response.gaps()).isNotEmpty();
        // No test fixtures → should warn
        assertThat(response.gaps()).anyMatch(g ->
                g.message() != null && g.message().toLowerCase().contains("test fixture"));
    }

    @Test
    void returnsGapForMissingCompileStatus() {
        var measureId = measureService.createMeasure("Compile Gap Test", "OSHA compile-gap", "QA");
        // No CQL, status is ERROR by default

        TraceabilityResponse response = traceabilityService.generate(measureId);

        assertThat(response.gaps()).anyMatch(g ->
                "ERROR".equals(g.severity()) || "WARN".equals(g.severity()));
    }

    @Test
    void returnsGapForMissingDataFixtureCoverage() {
        var measureId = measureService.createMeasure("Coverage Gap Test", "OSHA coverage-gap", "QA");
        measureService.updateCql(measureId, "library CoverageGap version '1.0.0'\n\ndefine \"Initial Population\": true");
        measureService.compileCql(measureId);
        // Add only a COMPLIANT fixture — no MISSING_DATA, no EXCLUDED
        measureService.updateTests(measureId, List.of(
                new MeasureService.TestFixture("compliant-case", "emp-001", "COMPLIANT", "")
        ));

        TraceabilityResponse response = traceabilityService.generate(measureId);

        // Should warn about missing MISSING_DATA and EXCLUDED fixture coverage
        assertThat(response.gaps()).anyMatch(g ->
                g.message() != null && g.message().contains("MISSING_DATA"));
        assertThat(response.gaps()).anyMatch(g ->
                g.message() != null && g.message().contains("EXCLUDED"));
    }

    @Test
    void audiogramResponseContainsCqlDefinesFromCqlText() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        TraceabilityResponse response = traceabilityService.generate(audiogram.id());

        // Audiogram CQL has defines like "Most Recent Audiogram Date", "Outcome Status", etc.
        boolean hasAnyDefine = response.rows().stream()
                .anyMatch(r -> r.cqlDefine() != null && !r.cqlDefine().isBlank());
        assertThat(hasAnyDefine).isTrue();
    }
}
