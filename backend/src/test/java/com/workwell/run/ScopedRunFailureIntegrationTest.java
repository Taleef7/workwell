package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.workwell.AbstractIntegrationTest;
import com.workwell.compile.CqlEvaluationService;
import com.workwell.measure.MeasureService;
import java.time.LocalDate;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
@SpringBootTest
class ScopedRunFailureIntegrationTest extends AbstractIntegrationTest {
    private static final Set<String> TERMINAL_RUN_STATUSES = Set.of("COMPLETED", "FAILED", "PARTIAL_FAILURE", "CANCELLED");

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MeasureService measureService;

    @Autowired
    private RunPersistenceService runPersistenceService;

    @MockBean
    private CqlEvaluationService cqlEvaluationService;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void measureScopeFailurePersistsMissingDataAndPartialFailure() {
        measureService.listMeasures();

        UUID measureId = jdbcTemplate.queryForObject(
                "SELECT id FROM measures WHERE name = ?",
                UUID.class,
                "Audiogram"
        );

        when(cqlEvaluationService.evaluate(anyString(), anyString(), anyString(), anyString(), any(LocalDate.class)))
                .thenThrow(new RuntimeException("CQL engine boom"));

        var response = allProgramsRunService.run(
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

        assertThat(response.status()).isEqualTo("REQUESTED");
        assertThat(response.activeMeasuresExecuted()).isEqualTo(1);

        UUID runId = UUID.fromString(response.runId());
        RunPersistenceService.RunSummaryResponse summary = awaitTerminalRun(runId);
        assertThat(summary.status()).isEqualTo("PARTIAL_FAILURE");
        assertThat(summary.totalEvaluated()).isEqualTo(1L);
        assertThat(summary.nonCompliantCount()).isEqualTo(1L);

        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT status, failure_summary, partial_failure_count FROM runs WHERE id = ?",
                runId
        );
        assertThat(String.valueOf(runRow.get("status"))).isEqualTo("PARTIAL_FAILURE");
        assertThat(String.valueOf(runRow.get("failure_summary"))).contains("evaluationError");
        assertThat(((Number) runRow.get("partial_failure_count")).longValue()).isEqualTo(1L);
        Integer outcomeCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM outcomes WHERE run_id = ?",
                Integer.class,
                runId
        );
        assertThat(outcomeCount).isEqualTo(1);
        String persistedOutcome = jdbcTemplate.queryForObject(
                "SELECT status FROM outcomes WHERE run_id = ?",
                String.class,
                runId
        );
        assertThat(persistedOutcome).isEqualTo("MISSING_DATA");
    }

    private RunPersistenceService.RunSummaryResponse awaitTerminalRun(UUID runId) {
        long deadlineMs = System.currentTimeMillis() + 10_000L;
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
        throw new AssertionError("Run did not reach a terminal state within 10 seconds: " + runId);
    }
}
