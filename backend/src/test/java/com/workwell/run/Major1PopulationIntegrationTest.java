package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.measure.MeasureService;
import com.workwell.web.EvalController.ManualRunResponse;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class Major1PopulationIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private MeasureService measureService;

    @Autowired
    private SeedHistoricalRunsService seedHistoricalRunsService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void setUp() { resetTables(); }

    @Test
    void manualRunPersistsOneHundredOutcomesPerMeasureAndTbHighCompliance() {
        ManualRunResponse response = allProgramsRunService.runAllPrograms("All Programs", "cm@workwell.dev");

        List<Map<String, Object>> counts = jdbcTemplate.queryForList(
                """
                        SELECT m.name AS measure_name, COUNT(*) AS outcome_count,
                               SUM(CASE WHEN o.status = 'COMPLIANT' THEN 1 ELSE 0 END) AS compliant_count
                        FROM outcomes o
                        JOIN measure_versions mv ON o.measure_version_id = mv.id
                        JOIN measures m ON mv.measure_id = m.id
                        WHERE o.run_id = ?
                        GROUP BY m.name
                        ORDER BY m.name
                        """,
                java.util.UUID.fromString(response.runId())
        );

        assertThat(counts).hasSize(4);
        assertThat(counts).allSatisfy(row -> assertThat(((Number) row.get("outcome_count")).intValue()).isEqualTo(100));

        int tbCompliant = counts.stream()
                .filter(row -> "TB Surveillance".equals(row.get("measure_name")))
                .map(row -> ((Number) row.get("compliant_count")).intValue())
                .findFirst()
                .orElse(0);
        assertThat(tbCompliant)
                .withFailMessage("Expected TB compliant >= 85 but got %s from counts %s", tbCompliant, counts)
                .isGreaterThanOrEqualTo(85);
    }

    @Test
    void manualRunAutoQueuesOutreachForNonCompliantOutcomesAndSkipsExcluded() {
        ManualRunResponse response = allProgramsRunService.runAllPrograms("All Programs", "cm@workwell.dev");
        java.util.UUID runId = java.util.UUID.fromString(response.runId());

        List<Map<String, Object>> counts = jdbcTemplate.queryForList(
                """
                        SELECT o.status AS outcome_status,
                               COUNT(*) AS outcome_count,
                               COUNT(orw.id) AS outreach_count
                        FROM outcomes o
                        LEFT JOIN cases c
                               ON c.employee_id = o.employee_id
                              AND c.measure_version_id = o.measure_version_id
                              AND c.evaluation_period = o.evaluation_period
                        LEFT JOIN outreach_records orw
                               ON orw.case_id = c.id
                        WHERE o.run_id = ?
                        GROUP BY o.status
                        ORDER BY o.status
                        """,
                runId
        );

        assertThat(counts).isNotEmpty();
        counts.forEach(row -> {
            String status = String.valueOf(row.get("outcome_status"));
            int outcomeCount = ((Number) row.get("outcome_count")).intValue();
            int outreachCount = ((Number) row.get("outreach_count")).intValue();
            if ("COMPLIANT".equals(status) || "EXCLUDED".equals(status)) {
                assertThat(outreachCount).isZero();
            } else {
                assertThat(outreachCount)
                        .withFailMessage("Expected outreach records for %s outcomes but got row %s", status, row)
                        .isEqualTo(outcomeCount);
            }
        });

        Integer excludedOutreachCount = jdbcTemplate.queryForObject(
                """
                        SELECT COUNT(*)
                        FROM outcomes o
                        LEFT JOIN cases c
                               ON c.employee_id = o.employee_id
                              AND c.measure_version_id = o.measure_version_id
                              AND c.evaluation_period = o.evaluation_period
                        LEFT JOIN outreach_records orw
                               ON orw.case_id = c.id
                        WHERE o.run_id = ?
                          AND o.status = 'EXCLUDED'
                          AND orw.id IS NOT NULL
                        """,
                Integer.class,
                runId
        );
        assertThat(excludedOutreachCount).isZero();

        Integer excludedCaseCount = jdbcTemplate.queryForObject(
                """
                        SELECT COUNT(*)
                        FROM outcomes o
                        JOIN cases c
                          ON c.employee_id = o.employee_id
                         AND c.measure_version_id = o.measure_version_id
                         AND c.evaluation_period = o.evaluation_period
                        WHERE o.run_id = ?
                          AND o.status = 'EXCLUDED'
                          AND c.status = 'EXCLUDED'
                        """,
                Integer.class,
                runId
        );
        assertThat(excludedCaseCount).isGreaterThan(0);

        Integer excludedWaiverCount = jdbcTemplate.queryForObject(
                """
                        SELECT COUNT(*)
                        FROM waivers w
                        JOIN cases c
                          ON c.employee_id = w.employee_id
                         AND c.measure_version_id = w.measure_version_id
                        JOIN outcomes o
                          ON o.employee_id = c.employee_id
                         AND o.measure_version_id = c.measure_version_id
                         AND o.evaluation_period = c.evaluation_period
                        WHERE o.run_id = ?
                          AND o.status = 'EXCLUDED'
                        """,
                Integer.class,
                runId
        );
        assertThat(excludedWaiverCount).isEqualTo(excludedCaseCount);

        Integer excludedAuditEvents = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE event_type = 'CASE_EXCLUDED' AND ref_run_id = ?",
                Integer.class,
                runId
        );
        assertThat(excludedAuditEvents).isEqualTo(excludedCaseCount);

        Integer autoQueuedAuditEvents = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE event_type = 'NOTIFICATION_AUTO_QUEUED' AND ref_run_id = ?",
                Integer.class,
                runId
        );
        int queuedOutreachTotal = counts.stream()
                .filter(row -> {
                    String status = String.valueOf(row.get("outcome_status"));
                    return List.of("DUE_SOON", "OVERDUE", "MISSING_DATA").contains(status);
                })
                .mapToInt(row -> ((Number) row.get("outreach_count")).intValue())
                .sum();
        assertThat(autoQueuedAuditEvents).isEqualTo(queuedOutreachTotal);
    }

    @Test
    void historicalSeedCreatesFiveRunsWithTrendVariance() {
        measureService.listMeasures();
        seedHistoricalRunsService.seedHistoricalRunsIfEmpty();
        Integer runCount = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM runs", Integer.class);
        assertThat(runCount).isEqualTo(5);

        List<Integer> compliantCounts = jdbcTemplate.query(
                "SELECT compliant FROM runs ORDER BY started_at ASC",
                (rs, rowNum) -> rs.getInt("compliant")
        );
        assertThat(compliantCounts).hasSize(5);
        assertThat(compliantCounts.get(4)).isGreaterThan(compliantCounts.get(0));
    }

    private void resetTables() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers CASCADE");
    }
}
