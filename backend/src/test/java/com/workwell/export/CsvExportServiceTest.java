package com.workwell.export;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
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
    private CaseFlowService caseFlowService;

    private CsvExportService csvExportService;

    @BeforeEach
    void setUp() {
        csvExportService = new CsvExportService(runPersistenceService, caseFlowService, new ObjectMapper());
    }

    @Test
    void exportsRunSummaryCsv() {
        when(runPersistenceService.listRuns("completed", "all_programs", "manual", 20)).thenReturn(List.of(
                new RunPersistenceService.RunListItem(
                        "11111111-1111-1111-1111-111111111111",
                        "All Programs",
                        "completed",
                        "all_programs",
                        "manual",
                        Instant.parse("2026-05-04T00:00:00Z"),
                        Instant.parse("2026-05-04T00:01:00Z"),
                        60000L,
                        25L,
                        8L,
                        17L
                )
        ));

        String csv = csvExportService.exportRunSummaryCsv("completed", "all_programs", "manual", 20);

        assertThat(csv.lines().toList()).containsExactly(
                "\"runId\",\"measureName\",\"status\",\"scopeType\",\"triggerType\",\"startedAt\",\"completedAt\",\"durationMs\",\"totalEvaluated\",\"compliant\",\"nonCompliant\"",
                "\"11111111-1111-1111-1111-111111111111\",\"All Programs\",\"completed\",\"all_programs\",\"manual\",\"2026-05-04T00:00:00Z\",\"2026-05-04T00:01:00Z\",\"60000\",\"25\",\"8\",\"17\""
        );
    }

    @Test
    void exportsCaseCsv() {
        UUID caseId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        UUID runId = UUID.fromString("33333333-3333-3333-3333-333333333333");
        UUID measureId = UUID.fromString("44444444-4444-4444-4444-444444444444");
        when(caseFlowService.listCases("open", measureId, "HIGH", "unassigned", "Clinic")).thenReturn(List.of(
                new CaseFlowService.CaseSummary(
                        caseId,
                        "patient-003",
                        "Pat Example",
                        "Clinic",
                        measureId,
                        "Audiogram",
                        "1.0.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        null,
                        "OVERDUE",
                        runId,
                        Instant.parse("2026-05-04T12:00:00Z")
                )
        ));

        String csv = csvExportService.exportCaseCsv("open", measureId, "HIGH", "unassigned", "Clinic");

        assertThat(csv.lines().toList()).containsExactly(
                "\"caseId\",\"employeeId\",\"employeeName\",\"site\",\"measureName\",\"measureVersion\",\"evaluationPeriod\",\"status\",\"priority\",\"assignee\",\"currentOutcomeStatus\",\"lastRunId\",\"updatedAt\"",
                "\"22222222-2222-2222-2222-222222222222\",\"patient-003\",\"Pat Example\",\"Clinic\",\"Audiogram\",\"1.0.0\",\"2026-05-04\",\"OPEN\",\"HIGH\",\"\",\"OVERDUE\",\"33333333-3333-3333-3333-333333333333\",\"2026-05-04T12:00:00Z\""
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
        when(runPersistenceService.loadOutcomeExportRows(runId)).thenReturn(List.of(
                new RunPersistenceService.OutcomeExportRow(
                        runId,
                        "patient-003",
                        "Pat Example",
                        "Clinic",
                        "Audiogram",
                        "1.0.0",
                        "2026-05-04",
                        "OVERDUE",
                        "Audiogram is outside annual compliance window.",
                        Instant.parse("2026-05-04T12:00:00Z"),
                        orderedEvidence("patient-003", 420)
                )
        ));

        String csv = csvExportService.exportOutcomeCsv(null);

        assertThat(csv.lines().toList()).containsExactly(
                "\"runId\",\"employeeId\",\"employeeName\",\"site\",\"measureName\",\"measureVersion\",\"evaluationPeriod\",\"status\",\"summary\",\"evaluatedAt\",\"evidenceJson\"",
                "\"55555555-5555-5555-5555-555555555555\",\"patient-003\",\"Pat Example\",\"Clinic\",\"Audiogram\",\"1.0.0\",\"2026-05-04\",\"OVERDUE\",\"Audiogram is outside annual compliance window.\",\"2026-05-04T12:00:00Z\",\"{\"\"patientId\"\":\"\"patient-003\"\",\"\"daysSinceLastAudiogram\"\":420}\""
        );
    }

    private Map<String, Object> orderedEvidence(String patientId, int daysSinceLastAudiogram) {
        Map<String, Object> evidence = new LinkedHashMap<>();
        evidence.put("patientId", patientId);
        evidence.put("daysSinceLastAudiogram", daysSinceLastAudiogram);
        return evidence;
    }
}
