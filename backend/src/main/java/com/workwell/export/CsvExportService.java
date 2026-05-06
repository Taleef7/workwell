package com.workwell.export;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.jdbc.core.JdbcTemplate;

@Service
public class CsvExportService {
    private static final int DEFAULT_RUN_LIMIT = 200;

    private final RunPersistenceService runPersistenceService;
    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public CsvExportService(
            RunPersistenceService runPersistenceService,
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper
    ) {
        this.runPersistenceService = runPersistenceService;
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public String exportRunSummaryCsv(String status, String scopeType, String triggerType, int limit) {
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("""
                SELECT
                    r.id AS run_id,
                    COALESCE(m.name, 'All Programs') AS measure_name,
                    COALESCE(mv.version, '-') AS measure_version,
                    r.scope_type,
                    r.trigger_type,
                    r.status,
                    r.started_at,
                    r.completed_at,
                    COALESCE(r.duration_ms, 0) AS duration_ms,
                    COALESCE(r.total_evaluated, 0) AS total_evaluated,
                    COALESCE(SUM(CASE WHEN o.status = 'COMPLIANT' THEN 1 ELSE 0 END), 0) AS compliant,
                    COALESCE(SUM(CASE WHEN o.status = 'DUE_SOON' THEN 1 ELSE 0 END), 0) AS due_soon,
                    COALESCE(SUM(CASE WHEN o.status = 'OVERDUE' THEN 1 ELSE 0 END), 0) AS overdue,
                    COALESCE(SUM(CASE WHEN o.status = 'MISSING_DATA' THEN 1 ELSE 0 END), 0) AS missing_data,
                    COALESCE(SUM(CASE WHEN o.status = 'EXCLUDED' THEN 1 ELSE 0 END), 0) AS excluded,
                    CASE
                        WHEN COALESCE(r.total_evaluated, 0) = 0 THEN 0
                        ELSE ROUND(
                            100.0 * COALESCE(SUM(CASE WHEN o.status = 'COMPLIANT' THEN 1 ELSE 0 END), 0) / r.total_evaluated,
                            1
                        )
                    END AS pass_rate,
                    MAX(o.evaluated_at) AS data_fresh_as_of
                FROM runs r
                LEFT JOIN measure_versions mv ON mv.id = r.scope_id
                LEFT JOIN measures m ON m.id = mv.measure_id
                LEFT JOIN outcomes o ON o.run_id = r.id
                WHERE 1=1
                """);
        if (hasText(status)) {
            sql.append(" AND r.status = ? ");
            args.add(status.trim());
        }
        if (hasText(scopeType)) {
            sql.append(" AND r.scope_type = ? ");
            args.add(scopeType.trim());
        }
        if (hasText(triggerType)) {
            sql.append(" AND r.trigger_type = ? ");
            args.add(triggerType.trim());
        }
        sql.append("""
                GROUP BY r.id, m.name, mv.version
                ORDER BY r.started_at DESC
                LIMIT ?
                """);
        args.add(safeLimit(limit));

        List<java.util.Map<String, Object>> rows = jdbcTemplate.queryForList(sql.toString(), args.toArray());

        StringBuilder csv = new StringBuilder();
        appendRow(csv, "runId", "measureName", "measureVersion", "scopeType", "triggerType", "status", "startedAt", "completedAt", "durationMs", "totalEvaluated", "compliant", "dueSoon", "overdue", "missingData", "excluded", "passRate", "dataFreshAsOf");
        for (java.util.Map<String, Object> run : rows) {
            appendRow(
                    csv,
                    run.get("run_id"),
                    run.get("measure_name"),
                    run.get("measure_version"),
                    run.get("scope_type"),
                    run.get("trigger_type"),
                    run.get("status"),
                    asInstant(run.get("started_at")),
                    asInstant(run.get("completed_at")),
                    run.get("duration_ms"),
                    run.get("total_evaluated"),
                    run.get("compliant"),
                    run.get("due_soon"),
                    run.get("overdue"),
                    run.get("missing_data"),
                    run.get("excluded"),
                    run.get("pass_rate"),
                    asInstant(run.get("data_fresh_as_of"))
            );
        }
        return csv.toString();
    }

    public String exportOutcomeCsv(UUID runId) {
        UUID resolvedRunId = runId == null ? latestRunId() : runId;
        List<java.util.Map<String, Object>> outcomes = jdbcTemplate.queryForList("""
                SELECT
                    o.id AS outcome_id,
                    o.run_id,
                    e.external_id AS employee_external_id,
                    e.name AS employee_name,
                    e.role,
                    e.site,
                    m.name AS measure_name,
                    mv.version AS measure_version,
                    o.evaluation_period,
                    o.status,
                    COALESCE(o.evidence_json -> 'why_flagged' ->> 'lastExamDate', '') AS last_exam_date,
                    COALESCE(o.evidence_json -> 'why_flagged' ->> 'complianceWindowDays', '') AS compliance_window_days,
                    COALESCE(o.evidence_json -> 'why_flagged' ->> 'daysOverdue', '') AS days_overdue,
                    COALESCE(o.evidence_json -> 'why_flagged' ->> 'roleEligible', '') AS role_eligible,
                    COALESCE(o.evidence_json -> 'why_flagged' ->> 'siteEligible', '') AS site_eligible,
                    COALESCE(o.evidence_json -> 'why_flagged' ->> 'waiverStatus', '') AS waiver_status,
                    o.evaluated_at
                FROM outcomes o
                JOIN employees e ON e.id = o.employee_id
                JOIN measure_versions mv ON mv.id = o.measure_version_id
                JOIN measures m ON m.id = mv.measure_id
                WHERE o.run_id = ?
                ORDER BY e.external_id ASC
                """, resolvedRunId);

        StringBuilder csv = new StringBuilder();
        appendRow(csv, "outcomeId", "runId", "employeeExternalId", "employeeName", "role", "site", "measureName", "measureVersion", "evaluationPeriod", "status", "lastExamDate", "complianceWindowDays", "daysOverdue", "roleEligible", "siteEligible", "waiverStatus", "evaluatedAt");
        for (java.util.Map<String, Object> row : outcomes) {
            appendRow(
                    csv,
                    row.get("outcome_id"),
                    row.get("run_id"),
                    row.get("employee_external_id"),
                    row.get("employee_name"),
                    row.get("role"),
                    row.get("site"),
                    row.get("measure_name"),
                    row.get("measure_version"),
                    row.get("evaluation_period"),
                    row.get("status"),
                    row.get("last_exam_date"),
                    row.get("compliance_window_days"),
                    row.get("days_overdue"),
                    row.get("role_eligible"),
                    row.get("site_eligible"),
                    row.get("waiver_status"),
                    asInstant(row.get("evaluated_at"))
            );
        }
        return csv.toString();
    }

    public String exportCaseCsv(String status, UUID measureId, String priority, String assignee, String site) {
        List<Object> args = new ArrayList<>();
        StringBuilder sql = new StringBuilder("""
                SELECT
                    c.id AS case_id,
                    e.external_id AS employee_external_id,
                    e.name AS employee_name,
                    e.role,
                    e.site,
                    m.name AS measure_name,
                    mv.version AS measure_version,
                    c.evaluation_period,
                    c.status,
                    c.priority,
                    c.assignee,
                    c.current_outcome_status,
                    c.next_action,
                    c.last_run_id,
                    c.created_at,
                    c.updated_at,
                    c.closed_at,
                    COALESCE((
                        SELECT ca.payload_json ->> 'deliveryStatus'
                        FROM case_actions ca
                        WHERE ca.case_id = c.id
                          AND ca.action_type = 'OUTREACH_DELIVERY_UPDATED'
                        ORDER BY ca.performed_at DESC
                        LIMIT 1
                    ), '') AS latest_outreach_delivery_status
                FROM cases c
                JOIN employees e ON e.id = c.employee_id
                JOIN measure_versions mv ON mv.id = c.measure_version_id
                JOIN measures m ON m.id = mv.measure_id
                WHERE 1=1
                """);
        if (hasText(status) && !"all".equalsIgnoreCase(status.trim())) {
            sql.append(" AND c.status = ? ");
            args.add(status.trim().toUpperCase());
        }
        if (measureId != null) {
            sql.append(" AND mv.measure_id = ? ");
            args.add(measureId);
        }
        if (hasText(priority)) {
            sql.append(" AND c.priority = ? ");
            args.add(priority.trim().toUpperCase());
        }
        if (hasText(assignee)) {
            if ("unassigned".equalsIgnoreCase(assignee.trim())) {
                sql.append(" AND c.assignee IS NULL ");
            } else {
                sql.append(" AND c.assignee = ? ");
                args.add(assignee.trim());
            }
        }
        if (hasText(site)) {
            sql.append(" AND e.site = ? ");
            args.add(site.trim());
        }
        sql.append(" ORDER BY c.updated_at DESC ");

        List<java.util.Map<String, Object>> cases = jdbcTemplate.queryForList(sql.toString(), args.toArray());

        StringBuilder csv = new StringBuilder();
        appendRow(csv, "caseId", "employeeExternalId", "employeeName", "role", "site", "measureName", "measureVersion", "evaluationPeriod", "status", "priority", "assignee", "currentOutcomeStatus", "nextAction", "lastRunId", "createdAt", "updatedAt", "closedAt", "latestOutreachDeliveryStatus");
        for (java.util.Map<String, Object> item : cases) {
            appendRow(
                    csv,
                    item.get("case_id"),
                    item.get("employee_external_id"),
                    item.get("employee_name"),
                    item.get("role"),
                    item.get("site"),
                    item.get("measure_name"),
                    item.get("measure_version"),
                    item.get("evaluation_period"),
                    item.get("status"),
                    item.get("priority"),
                    item.get("assignee"),
                    item.get("current_outcome_status"),
                    item.get("next_action"),
                    item.get("last_run_id"),
                    asInstant(item.get("created_at")),
                    asInstant(item.get("updated_at")),
                    asInstant(item.get("closed_at")),
                    item.get("latest_outreach_delivery_status")
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

    private boolean hasText(String value) {
        return value != null && !value.trim().isEmpty();
    }

    private Instant asInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof java.sql.Timestamp timestamp) {
            return timestamp.toInstant();
        }
        return null;
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
