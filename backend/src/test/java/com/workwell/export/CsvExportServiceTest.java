package com.workwell.export;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class CsvExportServiceTest {
    @Mock
    private RunPersistenceService runPersistenceService;

    @Mock
    private JdbcTemplate jdbcTemplate;

    private CsvExportService csvExportService;

    @BeforeEach
    void setUp() {
        csvExportService = new CsvExportService(runPersistenceService, jdbcTemplate, new ObjectMapper());
    }

    @Test
    void exportsRunSummaryCsv() {
        LinkedHashMap<String, Object> row = new LinkedHashMap<>();
        row.put("run_id", UUID.fromString("11111111-1111-1111-1111-111111111111"));
        row.put("measure_name", "All Programs");
        row.put("measure_version", "-");
        row.put("scope_type", "all_programs");
        row.put("trigger_type", "manual");
        row.put("status", "completed");
        row.put("started_at", Instant.parse("2026-05-04T00:00:00Z"));
        row.put("completed_at", Instant.parse("2026-05-04T00:01:00Z"));
        row.put("duration_ms", 60000L);
        row.put("total_evaluated", 25L);
        row.put("compliant", 8L);
        row.put("due_soon", 3L);
        row.put("overdue", 10L);
        row.put("missing_data", 2L);
        row.put("excluded", 2L);
        row.put("pass_rate", 32.0d);
        row.put("data_fresh_as_of", Instant.parse("2026-05-04T00:00:59Z"));
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(row));

        String csv = csvExportService.exportRunSummaryCsv("completed", "all_programs", "manual", 20);

        assertThat(csv.lines().toList()).containsExactly(
                "\"runId\",\"measureName\",\"measureVersion\",\"scopeType\",\"triggerType\",\"status\",\"startedAt\",\"completedAt\",\"durationMs\",\"totalEvaluated\",\"compliant\",\"dueSoon\",\"overdue\",\"missingData\",\"excluded\",\"passRate\",\"dataFreshAsOf\"",
                "\"11111111-1111-1111-1111-111111111111\",\"All Programs\",\"-\",\"all_programs\",\"manual\",\"completed\",\"2026-05-04T00:00:00Z\",\"2026-05-04T00:01:00Z\",\"60000\",\"25\",\"8\",\"3\",\"10\",\"2\",\"2\",\"32.0\",\"2026-05-04T00:00:59Z\""
        );
    }

    @Test
    void exportsCaseCsv() {
        LinkedHashMap<String, Object> row = new LinkedHashMap<>();
        row.put("case_id", UUID.fromString("22222222-2222-2222-2222-222222222222"));
        row.put("employee_external_id", "patient-003");
        row.put("employee_name", "Pat Example");
        row.put("role", "Nurse");
        row.put("site", "Clinic");
        row.put("measure_name", "Audiogram");
        row.put("measure_version", "1.0.0");
        row.put("evaluation_period", "2026-05-04");
        row.put("status", "OPEN");
        row.put("priority", "HIGH");
        row.put("assignee", "");
        row.put("current_outcome_status", "OVERDUE");
        row.put("next_action", "Review");
        row.put("last_run_id", UUID.fromString("33333333-3333-3333-3333-333333333333"));
        row.put("created_at", Instant.parse("2026-05-04T11:00:00Z"));
        row.put("updated_at", Instant.parse("2026-05-04T12:00:00Z"));
        row.put("closed_at", null);
        row.put("latest_outreach_delivery_status", "QUEUED");
        when(jdbcTemplate.queryForList(anyString(), any(Object[].class))).thenReturn(List.of(row));

        String csv = csvExportService.exportCaseCsv("open", UUID.fromString("44444444-4444-4444-4444-444444444444"), "HIGH", "unassigned", "Clinic");

        assertThat(csv.lines().toList()).containsExactly(
                "\"caseId\",\"employeeExternalId\",\"employeeName\",\"role\",\"site\",\"measureName\",\"measureVersion\",\"evaluationPeriod\",\"status\",\"priority\",\"assignee\",\"currentOutcomeStatus\",\"nextAction\",\"lastRunId\",\"createdAt\",\"updatedAt\",\"closedAt\",\"latestOutreachDeliveryStatus\"",
                "\"22222222-2222-2222-2222-222222222222\",\"patient-003\",\"Pat Example\",\"Nurse\",\"Clinic\",\"Audiogram\",\"1.0.0\",\"2026-05-04\",\"OPEN\",\"HIGH\",\"\",\"OVERDUE\",\"Review\",\"33333333-3333-3333-3333-333333333333\",\"2026-05-04T11:00:00Z\",\"2026-05-04T12:00:00Z\",\"\",\"QUEUED\""
        );
    }

    @Test
    void exportsOutcomeCsvForLatestRunWhenRunIdMissing() {
        UUID runId = UUID.fromString("55555555-5555-5555-5555-555555555555");
        when(runPersistenceService.loadLatestRun()).thenReturn(Optional.of(
                new RunPersistenceService.RunSummaryResponse(
                        runId.toString(),
                        "Audiogram",
                        "1.0.0",
                        "completed",
                        "manual",
                        "all_programs",
                        Instant.parse("2026-05-04T00:00:00Z"),
                        Instant.parse("2026-05-04T00:01:00Z"),
                        25L,
                        10L,
                        6L,
                        4L,
                        40.0d,
                        60000L,
                        List.of(),
                        Instant.parse("2026-05-04T00:00:59Z"),
                        1L
                )
        ));
        LinkedHashMap<String, Object> row = new LinkedHashMap<>();
        row.put("outcome_id", UUID.fromString("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
        row.put("run_id", runId);
        row.put("employee_external_id", "patient-003");
        row.put("employee_name", "Pat Example");
        row.put("role", "Nurse");
        row.put("site", "Clinic");
        row.put("measure_name", "Audiogram");
        row.put("measure_version", "1.0.0");
        row.put("evaluation_period", "2026-05-04");
        row.put("status", "OVERDUE");
        row.put("last_exam_date", "2025-03-10");
        row.put("compliance_window_days", "365");
        row.put("days_overdue", "55");
        row.put("role_eligible", "true");
        row.put("site_eligible", "true");
        row.put("waiver_status", "NONE");
        row.put("evaluated_at", Instant.parse("2026-05-04T12:00:00Z"));
        when(jdbcTemplate.queryForList(anyString(), any(Object.class))).thenReturn(List.of(row));

        String csv = csvExportService.exportOutcomeCsv(null);

        assertThat(csv.lines().toList()).containsExactly(
                "\"outcomeId\",\"runId\",\"employeeExternalId\",\"employeeName\",\"role\",\"site\",\"measureName\",\"measureVersion\",\"evaluationPeriod\",\"status\",\"lastExamDate\",\"complianceWindowDays\",\"daysOverdue\",\"roleEligible\",\"siteEligible\",\"waiverStatus\",\"evaluatedAt\"",
                "\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"55555555-5555-5555-5555-555555555555\",\"patient-003\",\"Pat Example\",\"Nurse\",\"Clinic\",\"Audiogram\",\"1.0.0\",\"2026-05-04\",\"OVERDUE\",\"2025-03-10\",\"365\",\"55\",\"true\",\"true\",\"NONE\",\"2026-05-04T12:00:00Z\""
        );
    }
}
