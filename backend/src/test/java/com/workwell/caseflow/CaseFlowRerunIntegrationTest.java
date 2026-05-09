package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.run.AllProgramsRunService;
import java.util.Map;
import java.util.UUID;
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
class CaseFlowRerunIntegrationTest {

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
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private CaseFlowService caseFlowService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Test
    void rerunToVerifyKeepsNonCompliantCasesOpenAndUsesStructuredOutcome() {
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        Map<String, Object> caseRow = jdbcTemplate.queryForMap("""
                SELECT id,
                       employee_id,
                       measure_version_id,
                       evaluation_period,
                       status,
                       current_outcome_status,
                       last_run_id
                FROM cases
                WHERE status = 'OPEN'
                ORDER BY created_at ASC
                LIMIT 1
                """);

        UUID caseId = (UUID) caseRow.get("id");
        UUID originalRunId = (UUID) caseRow.get("last_run_id");
        String originalOutcome = String.valueOf(caseRow.get("current_outcome_status"));
        UUID employeeId = (UUID) caseRow.get("employee_id");
        UUID measureVersionId = (UUID) caseRow.get("measure_version_id");
        String evaluationPeriod = String.valueOf(caseRow.get("evaluation_period"));

        CaseFlowService.CaseDetail rerun = caseFlowService.rerunToVerify(caseId, "cm@workwell.dev")
                .orElseThrow(() -> new AssertionError("Expected rerun-to-verify to return case detail"));

        assertThat(rerun.status()).isEqualTo("OPEN");
        assertThat(rerun.closedAt()).isNull();
        assertThat(rerun.currentOutcomeStatus()).isEqualTo(rerun.outcomeStatus());
        assertThat(rerun.currentOutcomeStatus()).isEqualTo(originalOutcome);
        assertThat(rerun.currentOutcomeStatus()).isNotEqualTo("COMPLIANT");
        assertThat(rerun.lastRunId()).isNotEqualTo(originalRunId);

        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT total_evaluated, compliant, non_compliant, scope_type, trigger_type FROM runs WHERE id = ?",
                rerun.lastRunId()
        );
        assertThat(((Number) runRow.get("total_evaluated")).longValue()).isEqualTo(1L);
        assertThat(((Number) runRow.get("compliant")).longValue()).isEqualTo(0L);
        assertThat(((Number) runRow.get("non_compliant")).longValue()).isEqualTo(1L);
        assertThat(String.valueOf(runRow.get("scope_type"))).isEqualTo("case");
        assertThat(String.valueOf(runRow.get("trigger_type"))).isEqualTo("manual");

        String persistedOutcome = jdbcTemplate.queryForObject(
                """
                        SELECT status
                        FROM outcomes
                        WHERE run_id = ? AND employee_id = ? AND measure_version_id = ? AND evaluation_period = ?
                        """,
                String.class,
                rerun.lastRunId(),
                employeeId,
                measureVersionId,
                evaluationPeriod
        );
        assertThat(persistedOutcome).isEqualTo(rerun.currentOutcomeStatus());

        String verifiedStatus = jdbcTemplate.queryForObject(
                """
                        SELECT payload_json ->> 'verifiedStatus'
                        FROM audit_events
                        WHERE ref_case_id = ? AND event_type = 'CASE_RERUN_VERIFIED'
                        ORDER BY occurred_at DESC
                        LIMIT 1
                        """,
                String.class,
                caseId
        );
        assertThat(verifiedStatus).isEqualTo(rerun.currentOutcomeStatus());

        Integer resolvedEvents = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE ref_case_id = ? AND event_type = 'CASE_RESOLVED'",
                Integer.class,
                caseId
        );
        assertThat(resolvedEvents).isZero();
    }
}
