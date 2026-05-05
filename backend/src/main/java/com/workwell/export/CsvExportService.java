package com.workwell.export;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.run.RunPersistenceService;
import com.workwell.run.RunPersistenceService.OutcomeExportRow;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;

@Service
public class CsvExportService {
    private static final int DEFAULT_RUN_LIMIT = 200;

    private final RunPersistenceService runPersistenceService;
    private final CaseFlowService caseFlowService;
    private final ObjectMapper objectMapper;

    public CsvExportService(
            RunPersistenceService runPersistenceService,
            CaseFlowService caseFlowService,
            ObjectMapper objectMapper
    ) {
        this.runPersistenceService = runPersistenceService;
        this.caseFlowService = caseFlowService;
        this.objectMapper = objectMapper;
    }

    public String exportRunSummaryCsv(String status, String scopeType, String triggerType, int limit) {
        List<RunPersistenceService.RunListItem> runs = runPersistenceService.listRuns(status, scopeType, triggerType, safeLimit(limit));
        StringBuilder csv = new StringBuilder();
        appendRow(csv, "runId", "measureName", "status", "scopeType", "triggerType", "startedAt", "completedAt", "durationMs", "totalEvaluated", "compliant", "nonCompliant");
        for (RunPersistenceService.RunListItem run : runs) {
            appendRow(
                    csv,
                    run.runId(),
                    run.measureName(),
                    run.status(),
                    run.scopeType(),
                    run.triggerType(),
                    run.startedAt(),
                    run.completedAt(),
                    run.durationMs(),
                    run.totalEvaluated(),
                    run.compliantCount(),
                    run.nonCompliantCount()
            );
        }
        return csv.toString();
    }

    public String exportOutcomeCsv(UUID runId) {
        UUID resolvedRunId = runId == null ? latestRunId() : runId;
        List<OutcomeExportRow> outcomes = runPersistenceService.loadOutcomeExportRows(resolvedRunId);
        StringBuilder csv = new StringBuilder();
        appendRow(csv, "runId", "employeeId", "employeeName", "site", "measureName", "measureVersion", "evaluationPeriod", "status", "summary", "evaluatedAt", "evidenceJson");
        for (OutcomeExportRow row : outcomes) {
            appendRow(
                    csv,
                    row.runId(),
                    row.employeeId(),
                    row.employeeName(),
                    row.site(),
                    row.measureName(),
                    row.measureVersion(),
                    row.evaluationPeriod(),
                    row.status(),
                    row.summary(),
                    row.evaluatedAt(),
                    row.evidenceJson()
            );
        }
        return csv.toString();
    }

    public String exportCaseCsv(String status, UUID measureId, String priority, String assignee, String site) {
        List<CaseFlowService.CaseSummary> cases = caseFlowService.listCases(status, measureId, priority, assignee, site);
        StringBuilder csv = new StringBuilder();
        appendRow(csv, "caseId", "employeeId", "employeeName", "site", "measureName", "measureVersion", "evaluationPeriod", "status", "priority", "assignee", "currentOutcomeStatus", "lastRunId", "updatedAt");
        for (CaseFlowService.CaseSummary item : cases) {
            appendRow(
                    csv,
                    item.caseId(),
                    item.employeeId(),
                    item.employeeName(),
                    item.site(),
                    item.measureName(),
                    item.measureVersion(),
                    item.evaluationPeriod(),
                    item.status(),
                    item.priority(),
                    item.assignee(),
                    item.currentOutcomeStatus(),
                    item.lastRunId(),
                    item.updatedAt()
            );
        }
        return csv.toString();
    }

    private UUID latestRunId() {
        return UUID.fromString(
                runPersistenceService.loadLatestRun()
                        .map(RunPersistenceService.RunSummaryResponse::runId)
                        .orElseThrow(() -> new IllegalStateException("No runs available for CSV export"))
        );
    }

    private int safeLimit(int limit) {
        return Math.max(1, Math.min(limit, DEFAULT_RUN_LIMIT));
    }

    private void appendRow(StringBuilder csv, Object... values) {
        for (int i = 0; i < values.length; i++) {
            csv.append(escape(csvValue(values[i])));
            if (i < values.length - 1) {
                csv.append(',');
            }
        }
        csv.append('\n');
    }

    private String csvValue(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof Instant instant) {
            return instant.toString();
        }
        if (value instanceof UUID uuid) {
            return uuid.toString();
        }
        if (value instanceof java.util.Map<?, ?> || value instanceof java.util.Collection<?>) {
            try {
                return objectMapper.writeValueAsString(value);
            } catch (JsonProcessingException ex) {
                throw new IllegalStateException("Unable to serialise CSV value", ex);
            }
        }
        return value.toString();
    }

    private String escape(String value) {
        return "\"" + value.replace("\"", "\"\"") + "\"";
    }
}
