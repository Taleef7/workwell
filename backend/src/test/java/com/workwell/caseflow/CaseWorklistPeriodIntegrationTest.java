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

    @Test
    void currentCycleIgnoresTerminalStaleRowsWithLaterPeriods() {
        UUID measureVersionId = jdbcTemplate.queryForObject(
                "SELECT mv.id FROM measure_versions mv JOIN measures m ON mv.measure_id = m.id "
                        + "WHERE m.name = 'Audiogram' AND mv.status = 'Active' ORDER BY mv.created_at DESC LIMIT 1",
                UUID.class);
        UUID runId = insertRun();
        // OPEN anchor at the cycle start, plus two TERMINAL stale rows whose raw daily periods are
        // lexically LATER: a CLOSED row (V022-style) and an EXCLUDED row with closed_at = NULL
        // (the upsertExcludedCase convention, which V022 does NOT close). The current-cycle MAX is
        // over ACTIONABLE status only, so neither poisons it and the open anchor still shows (Codex P1).
        insertOpenCase(insertEmployee("Anchor"), measureVersionId, "2026-01-01", runId);
        insertTerminalCase(insertEmployee("Closed Stale"), measureVersionId, "2026-06-15", runId, "CLOSED", true);
        insertTerminalCase(insertEmployee("Excluded Stale"), measureVersionId, "2026-09-09", runId, "EXCLUDED", false);

        assertThat(listCases(null))
                .as("current cycle ignores later CLOSED + EXCLUDED stale rows (status-based MAX)")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly("2026-01-01");
    }

    @Test
    void terminalTabsShowFullHistoryNotJustTheCurrentCycle() {
        UUID measureVersionId = jdbcTemplate.queryForObject(
                "SELECT mv.id FROM measure_versions mv JOIN measures m ON mv.measure_id = m.id "
                        + "WHERE m.name = 'Audiogram' AND mv.status = 'Active' ORDER BY mv.created_at DESC LIMIT 1",
                UUID.class);
        UUID runId = insertRun();
        // OPEN at the current cycle anchor + an EXCLUDED case in a PRIOR cycle.
        insertOpenCase(insertEmployee("Open Current"), measureVersionId, "2026-01-01", runId);
        insertTerminalCase(insertEmployee("Excluded Prior"), measureVersionId, "2025-01-01", runId, "EXCLUDED", false);

        // The excluded tab (no period) must show FULL history, not be restricted to the open cycle (Codex P2).
        assertThat(listCases("excluded", null))
                .as("excluded tab shows prior-cycle excluded cases (full history)")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .contains("2025-01-01");
        // The open tab still defaults to the current cycle only.
        assertThat(listCases("open", null))
                .as("open tab stays on the current cycle")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly("2026-01-01");
    }

    @Test
    void currentCycleIsTheLatestEvaluatedCycleNotTheLatestOpenRow() {
        UUID measureVersionId = jdbcTemplate.queryForObject(
                "SELECT mv.id FROM measure_versions mv JOIN measures m ON mv.measure_id = m.id "
                        + "WHERE m.name = 'Audiogram' AND mv.status = 'Active' ORDER BY mv.created_at DESC LIMIT 1",
                UUID.class);
        UUID runId = insertRun();
        // A lingering OPEN case in a PRIOR cycle (+ its outcome).
        insertOpenCase(insertEmployee("Lingering Open"), measureVersionId, "2026-01-01", runId);
        // A LATER cycle that was evaluated but produced NO open case (everyone compliant → an outcome only).
        insertOutcome(insertEmployee("Now Compliant"), measureVersionId, "2027-01-01", "COMPLIANT", runId);

        // The current cycle is the latest EVALUATED cycle (2027), which has no open cases — so the open
        // worklist is empty, NOT the prior cycle's stale open (2026) (Codex P2).
        assertThat(listCases(null))
                .as("open worklist follows the latest evaluated cycle, not the latest open row")
                .isEmpty();
    }

    private List<CaseFlowService.CaseSummary> listCases(String period) {
        return listCases("open", period);
    }

    private List<CaseFlowService.CaseSummary> listCases(String status, String period) {
        return caseFlowService.listCases(status, null, null, null, null, null, null, null, period, 100, 0);
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
        insertOutcome(employeeId, measureVersionId, period, "OVERDUE", runId);
    }

    /** A terminal case (CLOSED with closed_at set, or EXCLUDED with closed_at NULL) used to verify
     *  it never wins the current-cycle MAX. */
    private void insertTerminalCase(UUID employeeId, UUID measureVersionId, String period, UUID runId, String status, boolean closedAtSet) {
        jdbcTemplate.update(
                "INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, "
                        + "assignee, next_action, current_outcome_status, last_run_id, sla_due_date, "
                        + "created_at, updated_at, closed_at) "
                        + "VALUES (?, ?, ?, ?, ?, 'HIGH', NULL, 'n/a', ?, ?, NULL, NOW(), NOW(), " + (closedAtSet ? "NOW()" : "NULL") + ")",
                UUID.randomUUID(), employeeId, measureVersionId, period, status, status, runId);
        insertOutcome(employeeId, measureVersionId, period, status, runId);
    }

    /** A persisted outcome (every run writes one per subject) — the worklist's current cycle is the
     *  latest cycle with outcomes at a cycle anchor, so cases without a matching outcome won't surface. */
    private void insertOutcome(UUID employeeId, UUID measureVersionId, String period, String status, UUID runId) {
        jdbcTemplate.update(
                "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, status, evidence_json) "
                        + "VALUES (gen_random_uuid(), ?, ?, ?, ?, ?, '{}'::jsonb)",
                runId, employeeId, measureVersionId, period, status);
    }
}
