package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.run.AllProgramsRunService;
import com.workwell.run.DemoRunModels;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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
    private CaseFlowService caseFlowService;

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

        assertThat(countAfterFirst)
                .as("First run must produce at least one case — check seed data")
                .isGreaterThan(0);

        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
        int countAfterSecond = caseCount();

        assertThat(countAfterSecond)
                .as("Rerun must not create duplicate cases for the same composite key")
                .isEqualTo(countAfterFirst);
    }

    @Test
    void compliantOutcomeClosesExistingCase() {
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        var openCases = jdbcTemplate.queryForList("""
                SELECT c.id, c.employee_id, c.measure_version_id, c.evaluation_period,
                       e.external_id, e.name, e.role, e.site
                FROM cases c
                JOIN employees e ON e.id = c.employee_id
                WHERE c.status = 'OPEN'
                LIMIT 1
                """);

        assertThat(openCases)
                .as("First run must produce at least one OPEN case for this test to be meaningful")
                .isNotEmpty();

        var row = openCases.get(0);
        UUID caseId          = (UUID) row.get("id");
        UUID employeeId      = (UUID) row.get("employee_id");
        UUID measureVersionId = (UUID) row.get("measure_version_id");
        String evaluationPeriod = (String) row.get("evaluation_period");
        String externalId    = (String) row.get("external_id");
        String name          = (String) row.get("name");
        String role          = (String) row.get("role");
        String site          = (String) row.get("site");

        // Create a minimal run entry to satisfy the FK on cases.last_run_id
        UUID newRunId = insertMinimalRun();

        // Upsert a COMPLIANT outcome for the same composite key
        caseFlowService.upsertCases(
                newRunId,
                measureVersionId,
                evaluationPeriod,
                List.of(employeeId),
                List.of(new DemoRunModels.DemoOutcome(
                        externalId, name, role != null ? role : "", site != null ? site : "",
                        "COMPLIANT", "Now compliant", Map.of()
                ))
        );

        String newStatus = jdbcTemplate.queryForObject(
                "SELECT status FROM cases WHERE id = ?", String.class, caseId);
        assertThat(newStatus)
                .as("Case with COMPLIANT outcome must be resolved, not left OPEN")
                .isEqualTo("RESOLVED");
    }

    @Test
    void noCompositeKeyDuplicatesAfterMultipleRuns() {
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");

        Integer duplicates = jdbcTemplate.queryForObject("""
                SELECT COUNT(*) FROM (
                  SELECT employee_id, measure_version_id, evaluation_period
                  FROM cases
                  GROUP BY employee_id, measure_version_id, evaluation_period
                  HAVING COUNT(*) > 1
                ) dups
                """, Integer.class);
        assertThat(duplicates)
                .as("No composite key (employee, measure_version, period) must appear in more than one case row")
                .isZero();
    }

    @Test
    void sendingOutreachImmediatelySurfacesSimulatedDeliveryStatus() {
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
        UUID caseId = jdbcTemplate.queryForObject(
                "SELECT id FROM cases WHERE status = 'OPEN' ORDER BY created_at ASC LIMIT 1",
                UUID.class
        );

        CaseFlowService.CaseDetail detail = caseFlowService.sendOutreach(caseId, "cm@workwell.dev")
                .orElseThrow();

        assertThat(detail.latestOutreachDeliveryStatus())
                .as("The case payload returned after send should refresh the badge with the simulated email status")
                .isEqualTo("SIMULATED");
        assertThat(jdbcTemplate.queryForObject(
                """
                        SELECT payload_json ->> 'deliveryStatus'
                        FROM case_actions
                        WHERE case_id = ? AND action_type = 'OUTREACH_SENT'
                        ORDER BY performed_at DESC
                        LIMIT 1
                        """,
                String.class,
                caseId
        )).isEqualTo("SIMULATED");
    }

    // ---- helpers ----

    private int caseCount() {
        Integer count = jdbcTemplate.queryForObject("SELECT COUNT(*) FROM cases", Integer.class);
        return count == null ? 0 : count;
    }

    private UUID insertMinimalRun() {
        UUID runId = UUID.randomUUID();
        jdbcTemplate.update("""
                INSERT INTO runs (
                    id, scope_type, trigger_type, status, started_at,
                    measurement_period_start, measurement_period_end,
                    requested_scope_json, partial_failure_count, dry_run
                ) VALUES (?, 'ALL_PROGRAMS', 'test', 'COMPLETED', NOW(),
                    NOW() - INTERVAL '1 year', NOW(), '{}'::jsonb, 0, false)
                """, runId);
        return runId;
    }
}
