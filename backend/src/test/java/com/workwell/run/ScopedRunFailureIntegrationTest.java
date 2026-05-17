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
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.annotation.DirtiesContext;

@SpringBootTest
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_EACH_TEST_METHOD)
class ScopedRunFailureIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private MeasureService measureService;

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

        assertThat(response.status()).isEqualTo("FAILED");
        assertThat(response.totalEvaluated()).isEqualTo(0L);
        assertThat(response.nonCompliant()).isEqualTo(0L);

        UUID runId = UUID.fromString(response.runId());
        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT status, failure_summary, partial_failure_count FROM runs WHERE id = ?",
                runId
        );
        assertThat(String.valueOf(runRow.get("status"))).isEqualTo("FAILED");
        assertThat(String.valueOf(runRow.get("failure_summary"))).contains("CQL engine boom");
        assertThat(((Number) runRow.get("partial_failure_count")).longValue()).isEqualTo(0L);
        Integer outcomeCount = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM outcomes WHERE run_id = ?",
                Integer.class,
                runId
        );
        assertThat(outcomeCount).isEqualTo(0);
    }
}
