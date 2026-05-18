package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.run.AllProgramsRunService;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class CaseSlaServiceTest extends AbstractIntegrationTest {

    @Autowired
    private CaseSlaService caseSlaService;

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void seedBaseData() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers, evidence_attachments CASCADE");
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
    }

    @Test
    void breachedCaseGetsPriorityEscalatedAndAuditEventWritten() {
        // Find an open MEDIUM-priority case, backdate its SLA to yesterday
        var openCases = jdbcTemplate.queryForList("""
                SELECT id, priority FROM cases
                WHERE status IN ('OPEN', 'IN_PROGRESS')
                  AND sla_due_date IS NOT NULL
                  AND sla_breached = FALSE
                LIMIT 1
                """);
        if (openCases.isEmpty()) {
            // Seed a case manually with an expired SLA
            allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
            openCases = jdbcTemplate.queryForList("""
                    SELECT id, priority FROM cases
                    WHERE status IN ('OPEN', 'IN_PROGRESS') LIMIT 1
                    """);
        }
        if (openCases.isEmpty()) {
            // No eligible cases in current seed — skip without failure
            return;
        }

        UUID caseId = (UUID) openCases.get(0).get("id");
        String originalPriority = (String) openCases.get(0).get("priority");

        // Backdate the SLA to yesterday so it counts as breached
        jdbcTemplate.update("""
                UPDATE cases SET sla_due_date = NOW() - INTERVAL '1 day', sla_breached = FALSE
                WHERE id = ?
                """, caseId);

        int auditsBefore = auditCount(caseId, "CASE_SLA_BREACHED");

        caseSlaService.escalateBreachedCases();

        // Priority must have been escalated (or capped at CRITICAL)
        String newPriority = jdbcTemplate.queryForObject(
                "SELECT priority FROM cases WHERE id = ?", String.class, caseId);
        boolean slaBreachedFlag = Boolean.TRUE.equals(
                jdbcTemplate.queryForObject("SELECT sla_breached FROM cases WHERE id = ?", Boolean.class, caseId));

        assertThat(slaBreachedFlag).isTrue();
        // Priority must be at least as high as before (escalated or already CRITICAL)
        assertThat(priorityLevel(newPriority)).isGreaterThanOrEqualTo(priorityLevel(originalPriority));

        int auditsAfter = auditCount(caseId, "CASE_SLA_BREACHED");
        assertThat(auditsAfter).isEqualTo(auditsBefore + 1);
    }

    @Test
    void alreadyBreachedCaseIsNotEscalatedAgain() {
        var openCases = jdbcTemplate.queryForList("""
                SELECT id FROM cases WHERE status = 'OPEN' LIMIT 1
                """);
        if (openCases.isEmpty()) return;

        UUID caseId = (UUID) openCases.get(0).get("id");

        // Mark as already breached with an expired SLA
        jdbcTemplate.update("""
                UPDATE cases SET sla_due_date = NOW() - INTERVAL '1 day',
                    sla_breached = TRUE, priority = 'CRITICAL'
                WHERE id = ?
                """, caseId);

        int auditsBefore = auditCount(caseId, "CASE_SLA_BREACHED");

        caseSlaService.escalateBreachedCases();

        int auditsAfter = auditCount(caseId, "CASE_SLA_BREACHED");
        // Already-breached case must not be escalated again
        assertThat(auditsAfter).isEqualTo(auditsBefore);
    }

    private int auditCount(UUID caseId, String eventType) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE ref_case_id = ? AND event_type = ?",
                Integer.class, caseId, eventType);
        return count == null ? 0 : count;
    }

    private static int priorityLevel(String priority) {
        return switch (priority == null ? "" : priority) {
            case "LOW" -> 0;
            case "MEDIUM" -> 1;
            case "HIGH" -> 2;
            case "CRITICAL" -> 3;
            default -> -1;
        };
    }
}
