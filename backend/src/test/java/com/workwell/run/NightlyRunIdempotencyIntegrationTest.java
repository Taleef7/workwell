package com.workwell.run;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import java.time.LocalDate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * #150 H1 Phase 2: the nightly recurring run must be idempotent. Outcomes + cases now bucket into
 * the measure's compliance cycle (a first-of-month anchor), not the run date — so a second nightly
 * ALL_PROGRAMS run on the same day updates the same cases instead of minting a new
 * {@code evaluation_period} cohort. This is the guard against the 4,703-perpetually-open-case flood.
 */
@SpringBootTest
class NightlyRunIdempotencyIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute(
                "TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, "
                        + "outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void secondNightlyRunCreatesNoNewCasesOrPeriods() {
        allProgramsRunService.runAllPrograms("All Programs", "scheduler@workwell.dev");
        long casesAfterFirst = count("SELECT COUNT(*) FROM cases");
        long distinctPeriods = count("SELECT COUNT(DISTINCT evaluation_period) FROM cases");
        assertThat(casesAfterFirst).isGreaterThan(0);
        assertThat(distinctPeriods)
                .as("one bucket per measure cadence (annual/biannual/season), not per run date")
                .isLessThanOrEqualTo(3L);

        // A second nightly run on the same day must update the same cases, not append a cohort.
        allProgramsRunService.runAllPrograms("All Programs", "scheduler@workwell.dev");
        assertThat(count("SELECT COUNT(*) FROM cases"))
                .as("second nightly run creates 0 new cases (cycle-bucketed -> idempotent)")
                .isEqualTo(casesAfterFirst);
        assertThat(count("SELECT COUNT(DISTINCT evaluation_period) FROM cases"))
                .as("no new evaluation_period cohort")
                .isEqualTo(distinctPeriods);

        // The period is the compliance-cycle anchor (a first-of-month), never the run date.
        String today = LocalDate.now().toString();
        assertThat(jdbcTemplate.queryForList("SELECT DISTINCT evaluation_period FROM cases", String.class))
                .as("cases bucket into cycle anchors, not the run date")
                .doesNotContain(today)
                .allSatisfy(period -> assertThat(period).endsWith("-01"));
    }

    private long count(String sql) {
        Long n = jdbcTemplate.queryForObject(sql, Long.class);
        return n == null ? 0L : n;
    }
}
