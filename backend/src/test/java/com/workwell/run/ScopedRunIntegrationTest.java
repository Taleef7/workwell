package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import com.workwell.web.EvalController.ManualRunResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.annotation.DirtiesContext;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest
@Testcontainers
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class ScopedRunIntegrationTest {

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
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void measureScopePersistsOnlySelectedMeasureAndAuditActor() {
        UUID measureId = jdbcTemplate.queryForObject(
                "SELECT id FROM measures WHERE name = ?",
                UUID.class,
                "Audiogram"
        );

        ManualRunResponse response = allProgramsRunService.run(
                new ManualRunRequest(
                        RunScopeType.MEASURE,
                        measureId,
                        null,
                        null,
                        null,
                        null,
                        LocalDate.of(2026, 5, 9),
                        false
                ),
                "cm@workwell.dev"
        );

        UUID runId = UUID.fromString(response.runId());
        assertThat(response.scopeType()).isEqualTo("MEASURE");
        assertThat(response.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(response.activeMeasuresExecuted()).isEqualTo(1);
        assertThat(response.totalEvaluated()).isGreaterThan(0);

        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT scope_type, status, partial_failure_count, requested_scope_json FROM runs WHERE id = ?",
                runId
        );
        assertThat(String.valueOf(runRow.get("scope_type"))).isEqualTo("measure");
        assertThat(String.valueOf(runRow.get("status"))).isEqualTo(response.status());
        assertThat(((Number) runRow.get("partial_failure_count")).intValue()).isGreaterThanOrEqualTo(0);

        List<String> measureNames = jdbcTemplate.query(
                """
                        SELECT DISTINCT m.name
                        FROM outcomes o
                        JOIN measure_versions mv ON o.measure_version_id = mv.id
                        JOIN measures m ON mv.measure_id = m.id
                        WHERE o.run_id = ?
                        ORDER BY m.name
                        """,
                (rs, rowNum) -> rs.getString("name"),
                runId
        );
        assertThat(measureNames).containsExactly("Audiogram");

        Integer outcomeCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM outcomes WHERE run_id = ?",
                Integer.class,
                runId
        );
        assertThat(outcomeCount).isEqualTo((int) response.totalEvaluated());

        String auditActor = jdbcTemplate.queryForObject(
                """
                        SELECT actor
                        FROM audit_events
                        WHERE ref_run_id = ? AND event_type = 'RUN_STARTED'
                        ORDER BY occurred_at ASC
                        LIMIT 1
                        """,
                String.class,
                runId
        );
        assertThat(auditActor).isEqualTo("cm@workwell.dev");

        List<String> logMessages = jdbcTemplate.query(
                "SELECT message FROM run_logs WHERE run_id = ? ORDER BY ts ASC",
                (rs, rowNum) -> rs.getString("message"),
                runId
        );
        assertThat(logMessages).anySatisfy(message -> assertThat(message).contains("Run requested"));
        assertThat(logMessages).anySatisfy(message -> assertThat(message).contains("Evaluation completed"));
        assertThat(logMessages).anySatisfy(message -> assertThat(message).contains("Run completed"));
    }

    @Test
    void caseScopeRerunsSingleEmployeeAndKeepsCaseStableOnRepeat() {
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        Map<String, Object> caseRow = jdbcTemplate.queryForMap(
                """
                        SELECT id, employee_id, measure_version_id, evaluation_period, current_outcome_status, status, last_run_id
                        FROM cases
                        ORDER BY created_at ASC
                        LIMIT 1
                        """
        );
        UUID caseId = (UUID) caseRow.get("id");
        UUID employeeId = (UUID) caseRow.get("employee_id");
        UUID measureVersionId = (UUID) caseRow.get("measure_version_id");
        String evaluationPeriod = String.valueOf(caseRow.get("evaluation_period"));

        int initialCaseCount = countCases(employeeId, measureVersionId, evaluationPeriod);

        ManualRunResponse response = allProgramsRunService.run(
                new ManualRunRequest(
                        RunScopeType.CASE,
                        null,
                        null,
                        null,
                        null,
                        caseId,
                        null,
                        false
                ),
                "cm@workwell.dev"
        );

        UUID runId = UUID.fromString(response.runId());
        assertThat(response.scopeType()).isEqualTo("CASE");
        assertThat(response.activeMeasuresExecuted()).isEqualTo(1);
        assertThat(response.totalEvaluated()).isEqualTo(1L);

        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT scope_type, status, total_evaluated, compliant, non_compliant FROM runs WHERE id = ?",
                runId
        );
        assertThat(String.valueOf(runRow.get("scope_type"))).isEqualTo("case");
        assertThat(((Number) runRow.get("total_evaluated")).longValue()).isEqualTo(1L);

        String persistedOutcome = jdbcTemplate.queryForObject(
                """
                        SELECT status
                        FROM outcomes
                        WHERE run_id = ? AND employee_id = ? AND measure_version_id = ? AND evaluation_period = ?
                        """,
                String.class,
                runId,
                employeeId,
                measureVersionId,
                evaluationPeriod
        );
        assertThat(persistedOutcome).isNotBlank();

        Map<String, Object> updatedCase = jdbcTemplate.queryForMap(
                "SELECT current_outcome_status, status, last_run_id FROM cases WHERE id = ?",
                caseId
        );
        assertThat(String.valueOf(updatedCase.get("current_outcome_status"))).isEqualTo(persistedOutcome);
        assertThat((UUID) updatedCase.get("last_run_id")).isEqualTo(runId);

        String auditActor = jdbcTemplate.queryForObject(
                """
                        SELECT actor
                        FROM audit_events
                        WHERE ref_run_id = ? AND event_type = 'RUN_STARTED'
                        ORDER BY occurred_at ASC
                        LIMIT 1
                """,
                String.class,
                runId
        );
        assertThat(auditActor).isEqualTo("cm@workwell.dev");

        ManualRunResponse repeatResponse = allProgramsRunService.rerunSameScope(runId, "cm@workwell.dev");
        assertThat(repeatResponse.scopeType()).isEqualTo("CASE");
        assertThat(repeatResponse.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(countCases(employeeId, measureVersionId, evaluationPeriod)).isEqualTo(initialCaseCount);
    }

    @Test
    void unsupportedScopesFailFast() {
        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                allProgramsRunService.run(
                        new ManualRunRequest(
                                RunScopeType.SITE,
                                null,
                                null,
                                "Plant A",
                                null,
                                null,
                                LocalDate.now(),
                                false
                        ),
                        "cm@workwell.dev"
                )
        ).isInstanceOf(IllegalArgumentException.class);

        org.assertj.core.api.Assertions.assertThatThrownBy(() ->
                allProgramsRunService.run(
                        new ManualRunRequest(
                                RunScopeType.EMPLOYEE,
                                null,
                                null,
                                null,
                                "emp-001",
                                null,
                                LocalDate.now(),
                                false
                        ),
                        "cm@workwell.dev"
                )
        ).isInstanceOf(IllegalArgumentException.class);
    }

    private int countCases(UUID employeeId, UUID measureVersionId, String evaluationPeriod) {
        Integer count = jdbcTemplate.queryForObject(
                """
                        SELECT COUNT(*)
                        FROM cases
                        WHERE employee_id = ? AND measure_version_id = ? AND evaluation_period = ?
                        """,
                Integer.class,
                employeeId,
                measureVersionId,
                evaluationPeriod
        );
        return count == null ? 0 : count;
    }
}
