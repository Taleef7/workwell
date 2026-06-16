package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.run.CompliancePeriodResolver;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * #150 H1 (A): the open worklist defaults to each measure's CURRENT compliance cycle — derived from
 * TODAY + the measure's cadence ({@code bucketPeriod(measure, today)}), so it is exact and
 * cadence-correct (no fallback to a prior cycle, no poisoning by stale/raw rows; Codex P1+P2).
 * {@code period="all"} shows every cycle; an explicit period filters to exactly one; the
 * closed/excluded tabs show full history.
 */
@SpringBootTest
class CaseWorklistPeriodIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private CaseFlowService caseFlowService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private CompliancePeriodResolver compliancePeriodResolver;

    /** Audiogram is annual → its current cycle anchor is Jan 1 of the year containing {@code asOf}. */
    private String anchor(LocalDate asOf) {
        return compliancePeriodResolver.bucketPeriod("Audiogram", asOf);
    }

    @BeforeEach
    void reset() {
        jdbcTemplate.execute(
                "TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, "
                        + "outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void defaultsToCurrentCyclePeriodWithAllAndExactOverrides() {
        UUID measureVersionId = audiogramVersion();
        UUID runId = insertRun();
        String current = anchor(LocalDate.now());
        String prior = anchor(LocalDate.now().minusYears(1));
        // Same measure, two compliance cycles. The default view must show only the current one.
        insertOpenCase(insertEmployee("Old Cycle"), measureVersionId, prior, runId);
        insertOpenCase(insertEmployee("Current Cycle"), measureVersionId, current, runId);

        assertThat(listCases(null))
                .as("default view = the measure's current cycle only")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly(current);

        assertThat(listCases("all"))
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactlyInAnyOrder(prior, current);

        assertThat(listCases(prior))
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly(prior);
    }

    @Test
    void currentCycleUsesTheMeasureCadenceAnchorNotEveryAnchorFormat() {
        UUID measureVersionId = audiogramVersion();
        UUID runId = insertRun();
        String current = anchor(LocalDate.now()); // annual → Jan 1 of this year
        int year = LocalDate.now().getYear();
        // For an ANNUAL measure, Jul 1 is NOT a valid cycle anchor — a stale OPEN case there must not
        // appear in the open worklist (a broad '%-07-01' anchor check would have surfaced it; Codex P2).
        insertOpenCase(insertEmployee("Current"), measureVersionId, current, runId);
        insertOpenCase(insertEmployee("Wrong-cadence Jul 1"), measureVersionId, year + "-07-01", runId);

        assertThat(listCases(null))
                .as("annual measure's current cycle is Jan 1 only; a Jul-1 open case is not part of it")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly(current);
    }

    @Test
    void terminalTabsShowFullHistoryNotJustTheCurrentCycle() {
        UUID measureVersionId = audiogramVersion();
        UUID runId = insertRun();
        String current = anchor(LocalDate.now());
        String prior = anchor(LocalDate.now().minusYears(1));
        insertOpenCase(insertEmployee("Open Current"), measureVersionId, current, runId);
        insertTerminalCase(insertEmployee("Excluded Prior"), measureVersionId, prior, runId, "EXCLUDED", false);

        // The excluded tab (no period) must show FULL history, not be restricted to the open cycle (Codex P2).
        assertThat(listCases("excluded", null))
                .as("excluded tab shows prior-cycle excluded cases (full history)")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .contains(prior);
        // The open tab still defaults to the current cycle only.
        assertThat(listCases("open", null))
                .as("open tab stays on the current cycle")
                .extracting(CaseFlowService.CaseSummary::evaluationPeriod)
                .containsExactly(current);
    }

    @Test
    void priorCycleOpenCasesAreHiddenWhenCurrentCycleHasNone() {
        UUID measureVersionId = audiogramVersion();
        UUID runId = insertRun();
        String prior = anchor(LocalDate.now().minusYears(1));
        // A lingering OPEN case in a PRIOR cycle, with nothing in the current cycle.
        insertOpenCase(insertEmployee("Lingering Open"), measureVersionId, prior, runId);

        assertThat(listCases(null))
                .as("open worklist follows today's cycle; a prior-cycle stale open is not surfaced")
                .isEmpty();
    }

    private UUID audiogramVersion() {
        return jdbcTemplate.queryForObject(
                "SELECT mv.id FROM measure_versions mv JOIN measures m ON mv.measure_id = m.id "
                        + "WHERE m.name = 'Audiogram' AND mv.status = 'Active' ORDER BY mv.created_at DESC LIMIT 1",
                UUID.class);
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
    }

    /** A terminal case (CLOSED with closed_at set, or EXCLUDED with closed_at NULL) — used to verify it
     *  never appears in the open worklist and that the closed/excluded tabs still show it. */
    private void insertTerminalCase(UUID employeeId, UUID measureVersionId, String period, UUID runId, String status, boolean closedAtSet) {
        jdbcTemplate.update(
                "INSERT INTO cases (id, employee_id, measure_version_id, evaluation_period, status, priority, "
                        + "assignee, next_action, current_outcome_status, last_run_id, sla_due_date, "
                        + "created_at, updated_at, closed_at) "
                        + "VALUES (?, ?, ?, ?, ?, 'HIGH', NULL, 'n/a', ?, ?, NULL, NOW(), NOW(), " + (closedAtSet ? "NOW()" : "NULL") + ")",
                UUID.randomUUID(), employeeId, measureVersionId, period, status, status, runId);
    }
}
