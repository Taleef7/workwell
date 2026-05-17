package com.workwell.caseflow;

import static org.assertj.core.api.Assertions.assertThat;

import com.workwell.AbstractIntegrationTest;
import com.workwell.run.AllProgramsRunService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

@SpringBootTest
class CaseFlowRerunIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private AllProgramsRunService allProgramsRunService;

    @Autowired
    private CaseFlowService caseFlowService;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @BeforeEach
    void seedData() {
        jdbcTemplate.execute("TRUNCATE TABLE runs, outcomes, cases, case_actions, run_logs, audit_events, outreach_records, scheduled_appointments, waivers, evidence_attachments CASCADE");
        allProgramsRunService.runAllPrograms("All Programs", "admin@workwell.dev");
    }

    @Test
    void rerunToVerifyKeepsCompliantCasesResolved() {
        verifyRerunBehavior("COMPLIANT", true, false, true);
    }

    @Test
    void rerunToVerifyKeepsExcludedCasesExcluded() {
        verifyRerunBehavior("EXCLUDED", true, true, false);
    }

    @Test
    void rerunToVerifyKeepsDueSoonCasesOpen() {
        verifyRerunBehavior("DUE_SOON", false, false, false);
    }

    @Test
    void rerunToVerifyKeepsOverdueCasesOpen() {
        verifyRerunBehavior("OVERDUE", false, false, false);
    }

    @Test
    void rerunToVerifyKeepsMissingDataCasesOpen() {
        verifyRerunBehavior("MISSING_DATA", false, false, false);
    }

    private void verifyRerunBehavior(String originalOutcome, boolean expectedClosed, boolean expectedExcluded, boolean expectedResolved) {
        Map<String, Object> caseRow = loadOrSeedCaseRow(originalOutcome);

        UUID caseId = (UUID) caseRow.get("id");
        UUID originalRunId = (UUID) caseRow.get("last_run_id");
        String originalCurrentOutcome = String.valueOf(caseRow.get("current_outcome_status"));
        UUID employeeId = (UUID) caseRow.get("employee_id");
        UUID measureVersionId = (UUID) caseRow.get("measure_version_id");
        String evaluationPeriod = String.valueOf(caseRow.get("evaluation_period"));

        int verifiedBefore = countEvents(caseId, "CASE_RERUN_VERIFIED");
        int resolvedBefore = countEvents(caseId, "CASE_RESOLVED");
        int excludedBefore = countEvents(caseId, "CASE_EXCLUDED");

        CaseFlowService.CaseDetail rerun = caseFlowService.rerunToVerify(caseId, "cm@workwell.dev")
                .orElseThrow(() -> new AssertionError("Expected rerun-to-verify to return case detail"));

        assertThat(rerun.currentOutcomeStatus()).isEqualTo(originalCurrentOutcome);
        assertThat(rerun.currentOutcomeStatus()).isEqualTo(originalOutcome);
        assertThat(rerun.lastRunId()).isNotEqualTo(originalRunId);

        if (expectedClosed) {
            assertThat(rerun.closedAt()).isNotNull();
        } else {
            assertThat(rerun.closedAt()).isNull();
        }

        if (expectedResolved) {
            assertThat(rerun.status()).isEqualTo("RESOLVED");
            assertThat(rerun.closedReason()).isEqualTo("RERUN_VERIFIED");
            assertThat(rerun.closedBy()).isEqualTo("cm@workwell.dev");
        }

        if (expectedExcluded) {
            assertThat(rerun.status()).isEqualTo("EXCLUDED");
            assertThat(rerun.closedReason()).isEqualTo("RERUN_EXCLUDED");
            assertThat(rerun.closedBy()).isEqualTo("cm@workwell.dev");
        }

        if (!expectedResolved && !expectedExcluded) {
            assertThat(rerun.status()).isIn("OPEN", "IN_PROGRESS");
        }

        Map<String, Object> runRow = jdbcTemplate.queryForMap(
                "SELECT total_evaluated, compliant, non_compliant, scope_type, trigger_type FROM runs WHERE id = ?",
                rerun.lastRunId()
        );
        assertThat(((Number) runRow.get("total_evaluated")).longValue()).isEqualTo(1L);
        assertThat(((Number) runRow.get("compliant")).longValue()).isEqualTo("COMPLIANT".equals(originalOutcome) ? 1L : 0L);
        assertThat(((Number) runRow.get("non_compliant")).longValue()).isEqualTo("COMPLIANT".equals(originalOutcome) ? 0L : 1L);
        assertThat(String.valueOf(runRow.get("scope_type"))).isEqualTo("case");
        assertThat(String.valueOf(runRow.get("trigger_type"))).isEqualTo("manual");

        String persistedOutcome = jdbcTemplate.queryForObject(
                """
                        SELECT status
                        FROM outcomes
                        WHERE run_id = ? AND employee_id = ? AND measure_version_id = ? AND evaluation_period = ?
                        """,
                String.class,
                rerun.lastRunId(),
                employeeId,
                measureVersionId,
                evaluationPeriod
        );
        assertThat(persistedOutcome).isEqualTo(rerun.currentOutcomeStatus());

        String verifiedStatus = jdbcTemplate.queryForObject(
                """
                        SELECT payload_json ->> 'verifiedStatus'
                        FROM audit_events
                        WHERE ref_case_id = ? AND event_type = 'CASE_RERUN_VERIFIED'
                        ORDER BY occurred_at DESC
                        LIMIT 1
                        """,
                String.class,
                caseId
        );
        assertThat(verifiedStatus).isEqualTo(rerun.currentOutcomeStatus());

        Integer verifiedEvents = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE ref_case_id = ? AND event_type = 'CASE_RERUN_VERIFIED'",
                Integer.class,
                caseId
        );
        assertThat(verifiedEvents).isEqualTo(verifiedBefore + 1);

        int resolvedEvents = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE ref_case_id = ? AND event_type = 'CASE_RESOLVED'",
                Integer.class,
                caseId
        );
        int excludedEvents = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE ref_case_id = ? AND event_type = 'CASE_EXCLUDED'",
                Integer.class,
                caseId
        );

        if (expectedResolved) {
            assertThat(resolvedEvents).isEqualTo(resolvedBefore + 1);
            assertThat(excludedEvents).isEqualTo(excludedBefore);
        } else if (expectedExcluded) {
            assertThat(excludedEvents).isEqualTo(excludedBefore + 1);
            assertThat(resolvedEvents).isEqualTo(resolvedBefore);
        } else {
            assertThat(resolvedEvents).isEqualTo(resolvedBefore);
            assertThat(excludedEvents).isEqualTo(excludedBefore);
        }
    }

    private int countEvents(UUID caseId, String eventType) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM audit_events WHERE ref_case_id = ? AND event_type = ?",
                Integer.class,
                caseId,
                eventType
        );
        return count == null ? 0 : count;
    }

    private Map<String, Object> loadOrSeedCaseRow(String originalOutcome) {
        List<Map<String, Object>> existingCases = jdbcTemplate.queryForList("""
                SELECT id,
                       employee_id,
                       measure_version_id,
                       evaluation_period,
                       current_outcome_status,
                       last_run_id
                FROM cases
                WHERE current_outcome_status = ?
                ORDER BY created_at ASC
                LIMIT 1
                """, originalOutcome);
        if (!existingCases.isEmpty()) {
            return existingCases.get(0);
        }

        Map<String, Object> outcomeRow = jdbcTemplate.queryForMap("""
                SELECT employee_id,
                       measure_version_id,
                       evaluation_period,
                       run_id
                FROM outcomes
                WHERE status = ?
                ORDER BY evaluated_at ASC
                LIMIT 1
                """, originalOutcome);

        UUID caseId = UUID.randomUUID();
        jdbcTemplate.update(
                """
                        INSERT INTO cases (
                            id,
                            employee_id,
                            measure_version_id,
                            evaluation_period,
                            status,
                            priority,
                            assignee,
                            next_action,
                            current_outcome_status,
                            last_run_id,
                            created_at,
                            updated_at,
                            closed_at,
                            closed_reason,
                            closed_by
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NULL, NULL, NULL)
                        """,
                caseId,
                outcomeRow.get("employee_id"),
                outcomeRow.get("measure_version_id"),
                outcomeRow.get("evaluation_period"),
                "OPEN",
                "LOW",
                null,
                "Verification rerun pending.",
                originalOutcome,
                outcomeRow.get("run_id")
        );

        return jdbcTemplate.queryForMap("""
                SELECT id,
                       employee_id,
                       measure_version_id,
                       evaluation_period,
                       current_outcome_status,
                       last_run_id
                FROM cases
                WHERE id = ?
                """, caseId);
    }
}
