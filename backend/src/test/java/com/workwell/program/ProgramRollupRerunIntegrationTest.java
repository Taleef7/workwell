package com.workwell.program;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * #150 C4 regression: a single-subject CASE/EMPLOYEE rerun-to-verify must NOT become a measure's
 * "latest run" in the program rollups. The Java backend persists those scope types LOWERCASE
 * ("case" via CaseFlowService, "employee"/"measure"/"site" via {@code .name().toLowerCase()}),
 * while ALL_PROGRAMS is stored uppercase — so the rollup exclusion must be case-insensitive
 * (UPPER(r.scope_type) ...). Without that, a 1-subject rerun crashes the per-measure rate to
 * 0%/100% and corrupts the program dashboard.
 *
 * <p>This test fails against the uppercase-only predicate (the rerun is picked as latest) and
 * passes once the exclusion normalizes case.
 */
@SpringBootTest
class ProgramRollupRerunIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ProgramService programService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void reset() {
        jdbcTemplate.execute(
                "TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, "
                        + "outreach_records, scheduled_appointments, waivers CASCADE");
    }

    @Test
    void caseRerunDoesNotBecomeLatestRunOrSkewRollup() {
        UUID measureId = jdbcTemplate.queryForObject(
                "SELECT id FROM measures WHERE name = ?", UUID.class, "Audiogram");
        UUID measureVersionId = jdbcTemplate.queryForObject(
                "SELECT id FROM measure_versions WHERE measure_id = ? AND status = 'Active' "
                        + "ORDER BY created_at DESC LIMIT 1",
                UUID.class, measureId);
        UUID empCompliant = insertEmployee("C4 Compliant");
        UUID empOverdue = insertEmployee("C4 Overdue");

        // Population run (ALL_PROGRAMS, stored uppercase): 2 evaluated, 1 compliant -> 50%.
        UUID populationRun = insertRun("ALL_PROGRAMS", Instant.parse("2026-06-13T00:00:00Z"));
        insertOutcome(populationRun, empCompliant, measureVersionId, "COMPLIANT");
        insertOutcome(populationRun, empOverdue, measureVersionId, "OVERDUE");

        // A NEWER single-subject CASE rerun-to-verify, persisted lowercase exactly like
        // CaseFlowService does (ps.setString(2, "case")). One OVERDUE row -> would skew to 0%.
        UUID caseRerun = insertRun("case", Instant.parse("2026-06-14T00:00:00Z"));
        insertOutcome(caseRerun, empOverdue, measureVersionId, "OVERDUE");

        ProgramService.ProgramSummary audiogram = programService.listPrograms(null, null, null).stream()
                .filter(p -> p.measureId().equals(measureId))
                .findFirst()
                .orElseThrow();

        assertThat(audiogram.latestRunId())
                .as("rollup latest run is the population run, not the lowercase CASE rerun")
                .isEqualTo(populationRun);
        assertThat(audiogram.totalEvaluated()).isEqualTo(2L);
        assertThat(audiogram.compliant()).isEqualTo(1L);
        assertThat(audiogram.complianceRate()).isEqualTo(50.0);

        // Trend excludes the CASE rerun too; the only point is the population run.
        assertThat(programService.trend(measureId, null, null, null))
                .extracting(ProgramService.ProgramTrendPoint::runId)
                .containsExactly(populationRun);
    }

    /**
     * #150 H4 (covered by the same C4 scope-type exclusion): a single-subject CASE rerun must not
     * become the "latest run" the Top Sites / Top Roles drivers are computed from — otherwise a rerun
     * that verified its subject COMPLIANT leaves the OVERDUE-only drivers empty ("—" on the overview).
     */
    @Test
    void caseRerunDoesNotEmptyTheTopDrivers() {
        UUID measureId = jdbcTemplate.queryForObject(
                "SELECT id FROM measures WHERE name = ?", UUID.class, "Audiogram");
        UUID measureVersionId = jdbcTemplate.queryForObject(
                "SELECT id FROM measure_versions WHERE measure_id = ? AND status = 'Active' "
                        + "ORDER BY created_at DESC LIMIT 1",
                UUID.class, measureId);
        UUID empOverdue = insertEmployee("H4 Overdue");

        // Population run (ALL_PROGRAMS): the overdue employee at Plant A / Welder is the driver.
        UUID populationRun = insertRun("ALL_PROGRAMS", Instant.parse("2026-06-13T00:00:00Z"));
        insertOutcome(populationRun, empOverdue, measureVersionId, "OVERDUE");

        // A NEWER single-subject CASE rerun-to-verify that found the subject COMPLIANT (the case closed).
        // If this were picked as the latest run, the OVERDUE-only drivers would be EMPTY (the H4 symptom).
        UUID caseRerun = insertRun("case", Instant.parse("2026-06-14T00:00:00Z"));
        insertOutcome(caseRerun, empOverdue, measureVersionId, "COMPLIANT");

        ProgramService.TopDrivers drivers = programService.topDrivers(measureId, null, null, null);

        assertThat(drivers.bySite())
                .as("top sites come from the population run, not the compliant CASE rerun (H4)")
                .extracting(ProgramService.DriverSite::site)
                .containsExactly("Plant A");
        assertThat(drivers.byRole())
                .as("top roles come from the population run, not the compliant CASE rerun (H4)")
                .extracting(ProgramService.DriverRole::role)
                .containsExactly("Welder");
    }

    private UUID insertRun(String scopeType, Instant startedAt) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO runs (id, scope_type, trigger_type, status, triggered_by, started_at, "
                        + "total_evaluated, compliant, non_compliant, measurement_period_start, "
                        + "measurement_period_end, requested_scope_json) "
                        + "VALUES (?, ?, 'MANUAL', 'COMPLETED', 'test@workwell.dev', ?, 0, 0, 0, ?, ?, '{}'::jsonb)",
                id, scopeType, Timestamp.from(startedAt), Timestamp.from(startedAt), Timestamp.from(startedAt));
        return id;
    }

    private void insertOutcome(UUID runId, UUID employeeId, UUID measureVersionId, String status) {
        jdbcTemplate.update(
                "INSERT INTO outcomes (id, run_id, employee_id, measure_version_id, evaluation_period, "
                        + "status, evidence_json) VALUES (?, ?, ?, ?, ?, ?, '{}'::jsonb)",
                UUID.randomUUID(), runId, employeeId, measureVersionId, "2026-06-13", status);
    }

    private UUID insertEmployee(String name) {
        UUID id = UUID.randomUUID();
        jdbcTemplate.update(
                "INSERT INTO employees (id, external_id, name, role, site, active) "
                        + "VALUES (?, ?, ?, 'Welder', 'Plant A', true)",
                id, "c4-emp-" + id, name);
        return id;
    }
}
