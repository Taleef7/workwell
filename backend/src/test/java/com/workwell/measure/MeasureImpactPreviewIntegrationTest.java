package com.workwell.measure;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.measure.MeasureImpactPreviewService.ImpactPreviewRequest;
import com.workwell.measure.MeasureImpactPreviewService.ImpactPreviewResponse;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers
class MeasureImpactPreviewIntegrationTest {

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
    private MeasureImpactPreviewService impactPreviewService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewReturnsOutcomeCounts() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Audiogram not seeded"));

        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), null);

        assertThat(response).isNotNull();
        assertThat(response.measureId()).isEqualTo(audiogram.id());
        assertThat(response.populationEvaluated()).isGreaterThan(0);
        assertThat(response.outcomeCounts()).isNotEmpty();

        // All outcome statuses should be represented
        int total = response.outcomeCounts().values().stream().mapToInt(Integer::intValue).sum();
        assertThat(total).isEqualTo(response.populationEvaluated());
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewDoesNotPersistOutcomes() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        int outcomesBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outcomes", Integer.class);
        impactPreviewService.preview(audiogram.id(), null);
        int outcomesAfter = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM outcomes", Integer.class);

        assertThat(outcomesAfter).isEqualTo(outcomesBefore);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewDoesNotCreateOrUpdateCases() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        int casesBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM cases", Integer.class);
        impactPreviewService.preview(audiogram.id(), null);
        int casesAfter = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM cases", Integer.class);

        assertThat(casesAfter).isEqualTo(casesBefore);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewDoesNotCreateRuns() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        int runsBefore = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runs", Integer.class);
        impactPreviewService.preview(audiogram.id(), null);
        int runsAfter = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runs", Integer.class);

        assertThat(runsAfter).isEqualTo(runsBefore);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewWritesAuditEvent() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        impactPreviewService.preview(audiogram.id(), null);

        int auditCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE event_type = 'MEASURE_IMPACT_PREVIEWED'",
                Integer.class
        );
        assertThat(auditCount).isGreaterThan(0);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewWithExplicitEvaluationDate() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        ImpactPreviewRequest request = new ImpactPreviewRequest(null, "2026-05-01", null);
        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), request);

        assertThat(response.evaluationDate()).isEqualTo("2026-05-01");
        assertThat(response.populationEvaluated()).isGreaterThan(0);
    }

    @Test
    @WithMockUser(username = "previewer@workwell.dev", roles = "APPROVER")
    void previewReturnsSiteAndRoleBreakdown() {
        var measures = measureService.listMeasures();
        var audiogram = measures.stream()
                .filter(m -> "Audiogram".equals(m.name()))
                .findFirst()
                .orElseThrow();

        ImpactPreviewResponse response = impactPreviewService.preview(audiogram.id(), null);

        // siteBreakdown and roleBreakdown are populated from evaluation outcomes
        assertThat(response.siteBreakdown()).isNotNull();
        assertThat(response.roleBreakdown()).isNotNull();
    }
}
