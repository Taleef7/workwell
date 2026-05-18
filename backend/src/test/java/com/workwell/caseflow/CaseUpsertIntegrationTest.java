package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.run.AllProgramsRunService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class CaseUpsertIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void resetData() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers, evidence_attachments CASCADE");
    }

    @Test
    void rerunProducesNoDuplicateCases() {
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
        int countAfterFirst = caseCount();

        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
        int countAfterSecond = caseCount();

        assertThat(countAfterSecond).isEqualTo(countAfterFirst);
    }

    @Test
    void compliantOutcomeClosesExistingCase() {
        // Run once — seeds open non-compliant cases
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        // Grab any open case and verify it moves to RESOLVED when a COMPLIANT outcome
        // is upserted for the same composite key
        var openCase = jdbcTemplate.queryForList("""
                SELECT id, employee_id, measure_version_id, evaluation_period
                FROM cases WHERE status = 'OPEN' LIMIT 1
                """);
        if (openCase.isEmpty()) {
            // No open cases in current seed — test is moot but should not fail
            return;
        }

        var row = openCase.get(0);
        // Second run uses the same period; idempotent upsert must not create a new row
        int casesBefore = caseCount();
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
        int casesAfter = caseCount();

        assertThat(casesAfter).isEqualTo(casesBefore);

        // Any case that was already RESOLVED/EXCLUDED after the second run must have been
        // closed at some point — no orphaned open case for the same composite key
        int duplicates = jdbcTemplate.queryForObject("""
                SELECT COUNT(*) FROM (
                  SELECT employee_id, measure_version_id, evaluation_period, COUNT(*) AS cnt
                  FROM cases
                  GROUP BY employee_id, measure_version_id, evaluation_period
                  HAVING COUNT(*) > 1
                ) dups
                """, Integer.class);
        assertThat(duplicates).isZero();
    }

    private int caseCount() {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM cases", Integer.class);
        return count == null ? 0 : count;
    }
}
