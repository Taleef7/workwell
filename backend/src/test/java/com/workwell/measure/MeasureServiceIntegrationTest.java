package com.workwell.measure;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers
class MeasureServiceIntegrationTest {

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
    private JdbcTemplate jdbcTemplate;

    @Test
    void blocksActivationWhenFixturesMissingOrInvalid() {
        var measureId = measureService.createMeasure("Test Measure", "OSHA test", "QA");
        measureService.updateCql(measureId, "library Test version '1.0.0'\n\ndefine \"Initial Population\": true");
        measureService.compileCql(measureId);
        measureService.transitionStatus(measureId, "Approved");

        assertThatThrownBy(() -> measureService.transitionStatus(measureId, "Active"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("test fixtures pass validation");

        measureService.updateTests(measureId, List.of(
                new MeasureService.TestFixture("fixture-1", "", "INVALID_OUTCOME", "bad")
        ));
        assertThatThrownBy(() -> measureService.transitionStatus(measureId, "Active"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("test fixtures pass validation");
    }

    @Test
    void writesRichStatusTransitionAuditPayload() {
        var measureId = measureService.createMeasure("Audit Measure", "OSHA audit", "QA");
        measureService.updateCql(measureId, "library Test version '1.0.0'\n\ndefine \"Initial Population\": true");
        measureService.compileCql(measureId);
        measureService.updateTests(measureId, List.of(
                new MeasureService.TestFixture("fixture-1", "emp-001", "COMPLIANT", "ok")
        ));
        measureService.transitionStatus(measureId, "Approved");

        String payload = jdbcTemplate.queryForObject(
                """
                SELECT payload_json::text
                FROM audit_events
                WHERE event_type = 'MEASURE_VERSION_STATUS_CHANGED'
                ORDER BY occurred_at DESC
                LIMIT 1
                """,
                String.class
        );

        assertThat(payload).contains("compileStatus");
        assertThat(payload).contains("testFixtureCount");
        assertThat(payload).contains("valueSetCount");
        assertThat(payload).contains("activationBlockers");
    }
}
