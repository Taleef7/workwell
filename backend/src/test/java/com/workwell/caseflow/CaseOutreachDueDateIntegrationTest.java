package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * #150 M13: an OVERDUE case computes a due date (last_exam + window) that's already in the past, so an
 * outreach reading "complete by &lt;past date&gt;" is confusing. The preview must never render a past due
 * date — it clamps to today.
 */
@SpringBootTest
class CaseOutreachDueDateIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private CaseFlowService caseFlowService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute(
                "TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, "
                        + "outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void outreachPreviewClampsAnAlreadyPastDueDateToToday() {
        UUID measureVersionId = audiogramVersion();
        UUID runId = insertRun();
        UUID employeeId = insertEmployee("Overdue Person");
        String period = LocalDate.now().withDayOfYear(1).toString(); // current annual cycle anchor (Jan 1)
        // why_flagged with a last exam well over a year ago → last_exam + 365d window is in the past.
        insertOutcome(runId, employeeId, measureVersionId, period,
                "{\"why_flagged\":{\"last_exam_date\":\"2024-01-01\",\"compliance_window_days\":365,\"outcome_status\":\"OVERDUE\"}}");
        UUID caseId = insertOpenCase(employeeId, measureVersionId, period, runId);

        String dueDate = caseFlowService.previewOutreach(caseId, null).orElseThrow().dueDate();
        // 2024-01-01 + 365d is well in the past → clamped to today, never a past "due by" date.
        assertThat(dueDate).isEqualTo(LocalDate.now(ZoneOffset.UTC).toString());
    }

    private UUID audiogramVersion() {
        return jdbcTemplate.queryForObject(
                "SELECT mv.id FROM measure_versions mv JOIN measures m ON mv.measure_id = m.id "
                        + "WHERE m.name = 'Audiogram' AND mv.status = 'Active' ORDER BY mv.created_at DESC LIMIT 1",
                UUID.class);
    }

    private UUID insertRun() {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO runs (id, scope_type, trigger_type, status, triggered_by, started_at, "
                        + "total_evaluated, compliant, non_compliant, measurement_period_start, "
                        + "measurement_period_end, requested_scope_json) "
                        + "VALUES (?, 'ALL_PROGRAMS', 'MANUAL', 'COMPLETED', 'test', NOW(), 0, 0, 0, NOW(), NOW(), '{}'::jsonb)",
                id);
        return id;
    }

    private UUID insertEmployee(String name) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO employees (id, external_id, name, role, site, active) "
                        + "VALUES (?, ?, ?, 'Welder', 'Plant A', true)",
                id, "m13-emp-" + id, name);
        return id;
    }

    private void insertOutcome(UUID runId, UUID employeeId, UUID measureVersionId, String period, String evidenceJson) {
        jdbcTemplate.update(
                "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, status, evidence_json, evaluated_at) "
                        + "VALUES (?, ?, ?, ?, ?, 'OVERDUE', ?::jsonb, NOW())",
                UUID.randomUUID(), runId, employeeId, measureVersionId, period, evidenceJson);
    }

    private UUID insertOpenCase(UUID employeeId, UUID measureVersionId, String period, UUID runId) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, "
                        + "assignee, next_action, current_outcome_status, last_run_id, sla_due_date, "
                        + "created_at, updated_at, closed_at) "
                        + "VALUES (?, ?, ?, ?, 'OPEN', 'HIGH', NULL, 'Send reminder', 'OVERDUE', ?, NULL, NOW(), NOW(), NULL)",
                id, employeeId, measureVersionId, period, runId);
        return id;
    }
}
