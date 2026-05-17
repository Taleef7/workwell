package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.measure.AudiogramDemoService;
import javax.sql.DataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class RunPersistenceServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AudiogramDemoService audiogramDemoService;

    @Autowired
    private RunPersistenceService runPersistenceService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void audiogramRunsUpsertCasesIdempotently() {
        var run = audiogramDemoService.run();
        var runId = java.util.UUID.fromString(run.runId());

        assertThat(count("SELECT COUNT(*) FROM runs")).isEqualTo(1L);
        assertThat(count("SELECT COUNT(*) FROM outcomes")).isEqualTo(15L);
        assertThat(count("SELECT COUNT(*) FROM cases")).isEqualTo(12L);
        assertThat(count("SELECT COUNT(*) FROM cases WHERE status = 'OPEN'")).isEqualTo(10L);
        assertThat(count("SELECT COUNT(*) FROM cases WHERE status = 'EXCLUDED'")).isEqualTo(2L);
        assertThat(count("SELECT COUNT(*) FROM audit_events WHERE event_type IN ('CASE_CREATED', 'CASE_UPDATED', 'CASE_CLOSED')")).isEqualTo(10L);
        assertThat(runPersistenceService.loadOutcomeExportRows(runId)).hasSize(15);

        audiogramDemoService.run();

        assertThat(count("SELECT COUNT(*) FROM runs")).isEqualTo(2L);
        assertThat(count("SELECT COUNT(*) FROM outcomes")).isEqualTo(30L);
        assertThat(count("SELECT COUNT(*) FROM cases")).isEqualTo(12L);
        assertThat(count("SELECT COUNT(*) FROM cases WHERE status = 'EXCLUDED'")).isEqualTo(2L);
        assertThat(count("SELECT COUNT(*) FROM audit_events WHERE event_type IN ('CASE_CREATED', 'CASE_UPDATED', 'CASE_CLOSED')")).isEqualTo(20L);
    }

    private Long count(String sql) {
        return jdbcTemplate.queryForObject(sql, Long.class);
    }
}
