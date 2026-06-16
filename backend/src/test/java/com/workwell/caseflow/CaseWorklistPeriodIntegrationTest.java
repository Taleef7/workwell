package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * #150 H1 (A): the worklist defaults to each measure's CURRENT compliance cycle (its latest
 * {@code evaluation_period}), so prior cycles' cases don't flood the default view. {@code period="all"}
 * shows every cycle; an explicit period filters to exactly one.
 */
@SpringBootTest
class CaseWorklistPeriodIntegrationTest extends AbstractIntegrationTest {

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
    void defaultsToCurrentCyclePeriodWithAllAndExactOverrides() {
        UUID measureVersionId = jdbcTemplate.queryForObject(
                "SELECT mv.id FROM measure_versions mv JOIN measures m ON mv.measure_id = m.id "
                        + "WHERE m.name = 'Audiogram' AND mv.status = 'Active' ORDER BY mv.created_at DESC LIMIT 1",
                UUID.class);
        UUID runId = insertRun();
        // Same measure, two compliance cycles. The default view must show only the current one.
        insertOpenCase(insertEmployee("Old Cycle"), measureVersionId, "2025-01-01", runId);
        insertOpenCase(insertEmployee("Current Cycle"), measureVersionId, "2026-01-01", runId);

        assertThat(listCases(null))
                .as("default view = the measure's latest cycle only")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly("2026-01-01");

        assertThat(listCases("all"))
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactlyInAnyOrder("2025-01-01", "2026-01-01");

        assertThat(listCases("2025-01-01"))
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly("2025-01-01");
    }

    private List<CaseFlowService.CaseSummary> listCases(String period) {
        return caseFlowService.listCases("open", null, null, null, null, null, null, null, period, 100, 0);
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
                id, "h1a-emp-" + id, name);
        return id;
    }

    private void insertOpenCase(UUID employeeId, UUID measureVersionId, String period, UUID runId) {
        jdbcTemplate.update(
                "INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, "
                        + "assignee, next_action, current_outcome_status, last_run_id, sla_due_date, "
                        + "created_at, updated_at, closed_at) "
                        + "VALUES (?, ?, ?, ?, 'OPEN', 'HIGH', NULL, 'Send reminder', 'OVERDUE', ?, NULL, NOW(), NOW(), NULL)",
                UUID.randomUUID(), employeeId, measureVersionId, period, runId);
    }
}
