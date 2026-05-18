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
        var openCases = jdbcTemplate.queryForList("""
                SELECT id, priority FROM cases
                WHERE status IN ('OPEN', 'IN_PROGRESS')
                  AND sla_due_date IS NOT NULL
                  AND sla_breached = FALSE
                LIMIT 1
                """);

        assertThat(openCases)
                .as("@BeforeEach must produce open cases with sla_due_date set — check seed/run logic")
                .isNotEmpty();

        UUID caseId = (UUID) openCases.get(0).get("id");
        String originalPriority = (String) openCases.get(0).get("priority");

        // Backdate SLA to yesterday so the scheduler treats this case as breached
        jdbcTemplate.update("""
                UPDATE cases SET sla_due_date = NOW() - INTERVAL '1 day', sla_breached = FALSE
                WHERE id = ?
                """, caseId);

        int auditsBefore = auditCount(caseId, "CASE_SLA_BREACHED");

        caseSlaService.escalateBreachedCases();

        String newPriority = jdbcTemplate.queryForObject(
                "SELECT priority FROM cases WHERE id = ?", String.class, caseId);
        boolean slaBreachedFlag = Boolean.TRUE.equals(
                jdbcTemplate.queryForObject("SELECT sla_breached FROM cases WHERE id = ?", Boolean.class, caseId));

        assertThat(slaBreachedFlag)
                .as("sla_breached flag must be set to TRUE after escalation")
                .isTrue();

        // Strict escalation: priority must increase unless it was already CRITICAL
        if ("CRITICAL".equals(originalPriority)) {
            assertThat(newPriority).isEqualTo("CRITICAL");
        } else {
            assertThat(priorityLevel(newPriority))
                    .as("Priority must increase by at least one level (was %s)", originalPriority)
                    .isGreaterThan(priorityLevel(originalPriority));
        }

        int auditsAfter = auditCount(caseId, "CASE_SLA_BREACHED");
        assertThat(auditsAfter)
                .as("Exactly one CASE_SLA_BREACHED audit event must be written")
                .isEqualTo(auditsBefore + 1);
    }

    @Test
    void alreadyBreachedCaseIsNotEscalatedAgain() {
        var openCases = jdbcTemplate.queryForList("""
                SELECT id FROM cases WHERE status = 'OPEN' LIMIT 1
                """);

        assertThat(openCases)
                .as("@BeforeEach must produce open cases — check seed/run logic")
                .isNotEmpty();

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
        assertThat(auditsAfter)
                .as("Already-breached case must not generate a second CASE_SLA_BREACHED event")
                .isEqualTo(auditsBefore);
    }

    // ---- helpers ----

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
