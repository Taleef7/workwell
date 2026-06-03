package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import com.workwell.web.EvalController.ManualRunResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.Execution;
import org.junit.jupiter.api.parallel.ExecutionMode;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
@SpringBootTest
@Execution(ExecutionMode.SAME_THREAD)
class ScopedRunIntegrationTest extends AbstractIntegrationTest {
    private static final Set<String> TERMINAL_RUN_STATUSES = Set.of("COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED");

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private RunPersistenceService runPersistenceService;

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
        assertThat(response.status()).isEqualTo("REQUESTED");
        assertThat(response.scopeLabel()).contains("Audiogram");
        assertThat(response.activeMeasuresExecuted()).isEqualTo(1);

        RunPersistenceService.RunSummaryResponse summary = awaitTerminalRun(runId);
        assertThat(summary.scopeType()).isEqualTo("measure");
        assertThat(summary.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(summary.totalEvaluated()).isGreaterThan(0L);

        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT scope_type, status, partial_failure_count, requested_scope_json FROM runs WHERE id = ?",
                runId
        );
        assertThat(String.valueOf(runRow.get("scope_type"))).isEqualTo("measure");
        assertThat(String.valueOf(runRow.get("status"))).isEqualTo(summary.status());
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
        assertThat(outcomeCount).isEqualTo((int) summary.totalEvaluated());

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
        assertThat(logMessages).anySatisfy(message -> assertThat(message).contains("Async all-programs run started"));
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
    void siteScopeQueuesAndPersistsOnlyRequestedSite() {
        ManualRunResponse response = allProgramsRunService.run(
                new ManualRunRequest(
                        RunScopeType.SITE,
                        null,
                        null,
                        "Plant A",
                        null,
                        null,
                        LocalDate.of(2026, 5, 9),
                        false
                ),
                "cm@workwell.dev"
        );

        assertThat(response.scopeType()).isEqualTo("SITE");
        assertThat(response.status()).isEqualTo("REQUESTED");

        UUID runId = UUID.fromString(response.runId());
        RunPersistenceService.RunSummaryResponse summary = awaitTerminalRun(runId);
        assertThat(summary.scopeType()).isEqualTo("site");
        assertThat(summary.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(summary.totalEvaluated()).isGreaterThan(0L);

        List<String> outcomeSites = jdbcTemplate.query(
                """
                        SELECT DISTINCT e.site
                        FROM outcomes o
                        JOIN employees e ON e.id = o.employee_id
                        WHERE o.run_id = ?
                        ORDER BY e.site
                        """,
                (rs, rowNum) -> rs.getString("site"),
                runId
        );
        assertThat(outcomeSites).containsExactly("Plant A");
        assertThat(requestedSite(runId)).isEqualTo("Plant A");
        assertThat(runStartedActor(runId)).isEqualTo("cm@workwell.dev");
    }

    @Test
    void employeeScopeQueuesAndPersistsOnlyRequestedEmployee() {
        ManualRunResponse response = allProgramsRunService.run(
                new ManualRunRequest(
                        RunScopeType.EMPLOYEE,
                        null,
                        null,
                        null,
                        "emp-041",
                        null,
                        LocalDate.of(2026, 5, 9),
                        false
                ),
                "cm@workwell.dev"
        );

        assertThat(response.scopeType()).isEqualTo("EMPLOYEE");
        assertThat(response.status()).isEqualTo("REQUESTED");

        UUID runId = UUID.fromString(response.runId());
        RunPersistenceService.RunSummaryResponse summary = awaitTerminalRun(runId);
        assertThat(summary.scopeType()).isEqualTo("employee");
        assertThat(summary.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(summary.totalEvaluated()).isGreaterThan(0L);

        List<String> outcomeEmployees = jdbcTemplate.query(
                """
                        SELECT DISTINCT e.external_id
                        FROM outcomes o
                        JOIN employees e ON e.id = o.employee_id
                        WHERE o.run_id = ?
                        ORDER BY e.external_id
                        """,
                (rs, rowNum) -> rs.getString("external_id"),
                runId
        );
        assertThat(outcomeEmployees).containsExactly("emp-041");
        assertThat(requestedEmployeeExternalId(runId)).isEqualTo("emp-041");
        assertThat(runStartedActor(runId)).isEqualTo("cm@workwell.dev");
    }

    @Test
    void caseRerunSameScopeSucceedsEvenAfterLastRunIdIsStale() {
        // Regression test for Fix 5.
        // Scenario: run CASE scope once to produce runB (which stores caseId in requested_scope_json),
        // then SQL-advance cases.last_run_id to a synthetic later run so runB is now "stale".
        // rerunSameScope(runB) must still succeed by reading caseId from runB's JSON,
        // not by looking up cases WHERE last_run_id = runB (which now finds nothing).

        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        UUID caseId = jdbcTemplate.queryForObject(
                "SELECT id FROM cases WHERE status = 'OPEN' ORDER BY created_at ASC LIMIT 1", UUID.class
        );

        // CASE-scope run → produces runB; runB stores {"caseId": caseId} in requested_scope_json
        ManualRunResponse runBResponse = allProgramsRunService.run(
                new ManualRunRequest(RunScopeType.CASE, null, null, null, null, caseId, null, false),
                "cm@workwell.dev"
        );
        UUID runBId = UUID.fromString(runBResponse.runId());

        // Insert a synthetic later run and point the case's last_run_id at it,
        // simulating what happens when a subsequent evaluation overwrites last_run_id.
        UUID laterRunId = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO runs (id, scope_type, trigger_type, status, triggered_by, started_at, " +
                "total_evaluated, compliant, non_compliant, measurement_period_start, measurement_period_end, requested_scope_json) " +
                "VALUES (?, 'ALL_PROGRAMS', 'MANUAL', 'COMPLETED', 'test@workwell.dev', NOW(), 0, 0, 0, NOW(), NOW(), '{}')",
                laterRunId
        );
        jdbcTemplate.update("UPDATE cases SET last_run_id = ? WHERE id = ?", laterRunId, caseId);

        UUID currentLastRunId = jdbcTemplate.queryForObject(
                "SELECT last_run_id FROM cases WHERE id = ?", UUID.class, caseId
        );
        assertThat(currentLastRunId).isEqualTo(laterRunId).isNotEqualTo(runBId);

        // rerunSameScope resolves caseId from runB's requested_scope_json — must not throw
        ManualRunResponse rerunResponse = allProgramsRunService.rerunSameScope(runBId, "cm@workwell.dev");

        assertThat(rerunResponse.scopeType()).isEqualTo("CASE");
        assertThat(rerunResponse.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(rerunResponse.activeMeasuresExecuted()).isEqualTo(1);
        assertThat(rerunResponse.totalEvaluated()).isEqualTo(1L);
    }

    @Test
    void siteScopeRerunUsesPersistedRequestedSite() {
        ManualRunResponse initialResponse = allProgramsRunService.run(
                new ManualRunRequest(
                        RunScopeType.SITE,
                        null,
                        null,
                        "Plant A",
                        null,
                        null,
                        LocalDate.of(2026, 5, 9),
                        false
                ),
                "cm@workwell.dev"
        );
        UUID initialRunId = UUID.fromString(initialResponse.runId());
        awaitTerminalRun(initialRunId);

        ManualRunResponse rerunResponse = allProgramsRunService.rerunSameScope(initialRunId, "cm@workwell.dev");
        assertThat(rerunResponse.scopeType()).isEqualTo("SITE");
        assertThat(rerunResponse.status()).isEqualTo("REQUESTED");

        UUID rerunId = UUID.fromString(rerunResponse.runId());
        RunPersistenceService.RunSummaryResponse rerunSummary = awaitTerminalRun(rerunId);
        assertThat(rerunSummary.scopeType()).isEqualTo("site");
        assertThat(rerunSummary.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(requestedSite(rerunId)).isEqualTo("Plant A");

        List<String> outcomeSites = jdbcTemplate.query(
                """
                        SELECT DISTINCT e.site
                        FROM outcomes o
                        JOIN employees e ON e.id = o.employee_id
                        WHERE o.run_id = ?
                        ORDER BY e.site
                        """,
                (rs, rowNum) -> rs.getString("site"),
                rerunId
        );
        assertThat(outcomeSites).containsExactly("Plant A");
    }

    @Test
    void employeeScopeRerunUsesPersistedRequestedEmployee() {
        ManualRunResponse initialResponse = allProgramsRunService.run(
                new ManualRunRequest(
                        RunScopeType.EMPLOYEE,
                        null,
                        null,
                        null,
                        "emp-041",
                        null,
                        LocalDate.of(2026, 5, 9),
                        false
                ),
                "cm@workwell.dev"
        );
        UUID initialRunId = UUID.fromString(initialResponse.runId());
        awaitTerminalRun(initialRunId);

        ManualRunResponse rerunResponse = allProgramsRunService.rerunSameScope(initialRunId, "cm@workwell.dev");
        assertThat(rerunResponse.scopeType()).isEqualTo("EMPLOYEE");
        assertThat(rerunResponse.status()).isEqualTo("REQUESTED");

        UUID rerunId = UUID.fromString(rerunResponse.runId());
        RunPersistenceService.RunSummaryResponse rerunSummary = awaitTerminalRun(rerunId);
        assertThat(rerunSummary.scopeType()).isEqualTo("employee");
        assertThat(rerunSummary.status()).isIn("COMPLETED", "PARTIAL_FAILURE");
        assertThat(requestedEmployeeExternalId(rerunId)).isEqualTo("emp-041");

        List<String> outcomeEmployees = jdbcTemplate.query(
                """
                        SELECT DISTINCT e.external_id
                        FROM outcomes o
                        JOIN employees e ON e.id = o.employee_id
                        WHERE o.run_id = ?
                        ORDER BY e.external_id
                        """,
                (rs, rowNum) -> rs.getString("external_id"),
                rerunId
        );
        assertThat(outcomeEmployees).containsExactly("emp-041");
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

    private RunPersistenceService.RunSummaryResponse awaitTerminalRun(UUID runId) {
        long deadlineMs = System.currentTimeMillis() + 120_000L;
        while (System.currentTimeMillis() < deadlineMs) {
            RunPersistenceService.RunSummaryResponse summary = runPersistenceService.loadRunById(runId)
                    .orElseThrow(() -> new AssertionError("Run not found: " + runId));
            if (TERMINAL_RUN_STATUSES.contains(summary.status())) {
                return summary;
            }
            try {
                Thread.sleep(100L);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                throw new AssertionError("Interrupted while waiting for run " + runId + " to complete", ex);
            }
        }
        throw new AssertionError("Run did not reach a terminal state within 120 seconds: " + runId);
    }

    private String runStartedActor(UUID runId) {
        return jdbcTemplate.queryForObject(
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
    }

    private String requestedSite(UUID runId) {
        return jdbcTemplate.queryForObject(
                "SELECT requested_scope_json->>'site' FROM runs WHERE id = ?",
                String.class,
                runId
        );
    }

    private String requestedEmployeeExternalId(UUID runId) {
        return jdbcTemplate.queryForObject(
                "SELECT requested_scope_json->>'employeeExternalId' FROM runs WHERE id = ?",
                String.class,
                runId
        );
    }
}
