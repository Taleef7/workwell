package com.workwell.measure;

import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
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
    @WithMockUser(username = "approver@workwell.dev", roles = "ADMIN")
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
        String actor = jdbcTemplate.queryForObject(
                """
                SELECT actor
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
        assertThat(actor).isEqualTo("approver@workwell.dev");
    }

    @Test
    void exposesSeededOshaReferencesAndPersistsStructuredSelection() {
        var references = measureService.listOshaReferences();
        assertThat(references).hasSizeGreaterThanOrEqualTo(8);

        var audiogramReference = references.stream()
                .filter(reference -> "29 CFR 1910.95".equals(reference.cfrCitation()))
                .findFirst()
                .orElseThrow();

        var measureId = measureService.createMeasure("Structured Policy Measure", "OSHA 29 CFR 1910.95", "QA");
        measureService.updateSpec(measureId, new MeasureService.SpecUpdateRequest(
                "29 CFR 1910.95 — Occupational Noise Exposure",
                audiogramReference.id(),
                "Updated description",
                new MeasureService.EligibilityCriteria("Maintenance Tech", "Plant A", "Hearing Conservation Program"),
                List.of(),
                "Annual",
                List.of("Last audiogram date")
        ));

        var detail = measureService.getMeasure(measureId);
        assertThat(detail.policyRef()).isEqualTo("29 CFR 1910.95 — Occupational Noise Exposure");
        assertThat(detail.oshaReferenceId()).isEqualTo(audiogramReference.id());
    }

    @Test
    void preservesCustomPolicyTextWithoutStructuredSelection() {
        var measureId = measureService.createMeasure("Custom Policy Measure", "Company Occupational Health Policy", "QA");
        measureService.updateSpec(measureId, new MeasureService.SpecUpdateRequest(
                "Company Occupational Health Policy",
                null,
                "Updated description",
                new MeasureService.EligibilityCriteria("All", "All Sites", "Custom program"),
                List.of(),
                "Annual",
                List.of("Policy memo")
        ));

        var detail = measureService.getMeasure(measureId);
        assertThat(detail.policyRef()).isEqualTo("Company Occupational Health Policy");
        assertThat(detail.oshaReferenceId()).isNull();
    }
}
