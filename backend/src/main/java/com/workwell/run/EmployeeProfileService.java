package com.workwell.run;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.web.dto.EmployeeProfileResponse;
import com.workwell.web.dto.EmployeeProfileResponse.AuditEventSummary;
import com.workwell.web.dto.EmployeeProfileResponse.MeasureOutcomeSummary;
import com.workwell.web.dto.EmployeeProfileResponse.OpenCaseSummary;
import org.springframework.dao.EmptyResultDataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class EmployeeProfileService {

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public EmployeeProfileService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public EmployeeProfileResponse getProfile(String externalId) {
        // 1. Fetch base employee data
        Map<String, Object> emp;
        try {
            emp = jdbcTemplate.queryForMap("""
                SELECT e.id, e.external_id, e.name, e.role, e.site,
                       s.name AS supervisor_name, e.start_date,
                       e.fhir_patient_id, e.active
                FROM employees e
                LEFT JOIN employees s ON s.id = e.supervisor_id
                WHERE e.external_id = ?
                """, externalId);
        } catch (EmptyResultDataAccessException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Employee not found: " + externalId);
        }

        UUID employeeId = (UUID) emp.get("id");

        // 2. Latest outcome per measure (DISTINCT ON measure, ordered by evaluated_at DESC)
        List<Map<String, Object>> outcomeRows = jdbcTemplate.queryForList("""
            SELECT DISTINCT ON (mv.measure_id)
                   o.id AS outcome_id,
                   o.measure_version_id,
                   mv.version AS measure_version,
                   m.name AS measure_name,
                   o.status AS outcome_status,
                   o.evaluated_at,
                   o.evidence_json
            FROM outcomes o
            JOIN measure_versions mv ON mv.id = o.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            WHERE o.employee_id = ?
            ORDER BY mv.measure_id, o.evaluated_at DESC
            """, employeeId);

        // 3. Open cases
        List<Map<String, Object>> caseRows = jdbcTemplate.queryForList("""
            SELECT c.id, m.name AS measure_name,
                   c.current_outcome_status, c.priority, c.assignee,
                   c.created_at, c.sla_due_date, c.sla_breached
            FROM cases c
            JOIN measure_versions mv ON mv.id = c.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            WHERE c.employee_id = ?
              AND c.status IN ('OPEN', 'IN_PROGRESS')
            ORDER BY c.created_at DESC
            """, employeeId);

        // Build a lookup: measureVersionId -> open caseId
        List<Map<String, Object>> openCaseIdRows = jdbcTemplate.queryForList("""
            SELECT c.id AS case_id, c.measure_version_id
            FROM cases c
            WHERE c.employee_id = ?
              AND c.status IN ('OPEN', 'IN_PROGRESS')
            """, employeeId);
        Map<UUID, UUID> openCaseByMv = new HashMap<>();
        for (var row : openCaseIdRows) {
            openCaseByMv.put((UUID) row.get("measure_version_id"), (UUID) row.get("case_id"));
        }

        // 4. Recent audit events (for this employee's cases)
        List<Map<String, Object>> auditRows = jdbcTemplate.queryForList("""
            SELECT ae.event_type, ae.occurred_at, ae.actor,
                   m.name AS measure_name
            FROM audit_events ae
            JOIN cases c ON c.id = ae.ref_case_id
            JOIN measure_versions mv ON mv.id = c.measure_version_id
            JOIN measures m ON m.id = mv.measure_id
            WHERE c.employee_id = ?
            ORDER BY ae.occurred_at DESC
            LIMIT 20
            """, employeeId);

        // Build outcome summaries
        List<MeasureOutcomeSummary> outcomes = new ArrayList<>();
        for (var row : outcomeRows) {
            UUID mvId = (UUID) row.get("measure_version_id");
            String status = (String) row.get("outcome_status");
            Instant evaluatedAt = ((java.sql.Timestamp) row.get("evaluated_at")).toInstant();

            // Parse evidence_json for why_flagged data
            // JdbcTemplate returns JSONB columns as String when using queryForList
            Integer daysSince = null;
            Integer daysUntil = null;
            Object evidenceObj = row.get("evidence_json");
            String evidenceStr = evidenceObj != null ? evidenceObj.toString() : null;
            if (evidenceStr != null && !evidenceStr.isBlank()) {
                try {
                    var tree = objectMapper.readTree(evidenceStr);
                    var whyFlagged = tree.path("why_flagged");
                    if (!whyFlagged.isMissingNode()) {
                        var daysOverdue = whyFlagged.path("days_overdue");
                        var windowDays = whyFlagged.path("compliance_window_days");
                        if (!daysOverdue.isMissingNode()) daysSince = daysOverdue.asInt();
                        if (!daysOverdue.isMissingNode() && !windowDays.isMissingNode()) {
                            daysUntil = windowDays.asInt() - daysOverdue.asInt();
                        }
                    }
                } catch (Exception ignored) {}
            }

            outcomes.add(new MeasureOutcomeSummary(
                mvId,
                (String) row.get("measure_name"),
                (String) row.get("measure_version"),
                status,
                evaluatedAt.toString(),
                daysSince,
                daysUntil,
                openCaseByMv.get(mvId)
            ));
        }

        // Build open case summaries
        List<OpenCaseSummary> openCases = new ArrayList<>();
        for (var row : caseRows) {
            java.sql.Timestamp slaTs = (java.sql.Timestamp) row.get("sla_due_date");
            String slaDueDate = slaTs != null ? slaTs.toInstant().toString() : null;
            Integer slaRemainingDays = slaTs != null
                ? (int) java.time.Duration.between(Instant.now(), slaTs.toInstant()).toDays()
                : null;
            boolean slaBreached = Boolean.TRUE.equals(row.get("sla_breached"));
            openCases.add(new OpenCaseSummary(
                (UUID) row.get("id"),
                (String) row.get("measure_name"),
                (String) row.get("current_outcome_status"),
                (String) row.get("priority"),
                (String) row.get("assignee"),
                slaDueDate,
                slaRemainingDays,
                slaBreached
            ));
        }

        // Build audit event summaries
        List<AuditEventSummary> auditEvents = new ArrayList<>();
        for (var row : auditRows) {
            String eventType = (String) row.get("event_type");
            Instant occurredAt = ((java.sql.Timestamp) row.get("occurred_at")).toInstant();
            String actor = (String) row.get("actor");
            String measureName = (String) row.get("measure_name");
            auditEvents.add(new AuditEventSummary(
                eventType,
                occurredAt.toString(),
                actor != null ? actor : "system",
                measureName,
                humanReadable(eventType, actor, measureName)
            ));
        }

        return new EmployeeProfileResponse(
            employeeId,
            (String) emp.get("external_id"),
            (String) emp.get("name"),
            (String) emp.get("role"),
            (String) emp.get("site"),
            (String) emp.get("supervisor_name"),
            emp.get("start_date") != null ? ((java.sql.Date) emp.get("start_date")).toLocalDate() : null,
            (String) emp.get("fhir_patient_id"),
            Boolean.TRUE.equals(emp.get("active")),
            outcomes,
            openCases,
            auditEvents
        );
    }

    public List<EmployeeSearchResult> search(String q, int limit) {
        if (q == null || q.length() < 2) return List.of();
        String pattern = "%" + q.toLowerCase() + "%";
        return jdbcTemplate.query("""
            SELECT e.external_id, e.name, e.role, e.site,
                   (
                     SELECT o.status
                     FROM outcomes o
                     WHERE o.employee_id = e.id
                     ORDER BY o.evaluated_at DESC
                     LIMIT 1
                   ) AS latest_outcome
            FROM employees e
            WHERE e.active = true
              AND (LOWER(e.name) LIKE ? OR LOWER(e.external_id) LIKE ? OR LOWER(e.role) LIKE ?)
            ORDER BY e.name
            LIMIT ?
            """,
            (rs, row) -> new EmployeeSearchResult(
                rs.getString("external_id"),
                rs.getString("name"),
                rs.getString("role"),
                rs.getString("site"),
                rs.getString("latest_outcome")
            ),
            pattern, pattern, pattern, limit);
    }

    private String humanReadable(String eventType, String actor, String measureName) {
        String who = (actor != null && !actor.equals("system")) ? actor : "System";
        String measure = measureName != null ? " (" + measureName + ")" : "";
        return switch (eventType) {
            case "CASE_CREATED" -> who + " opened a case" + measure;
            case "CASE_UPDATED" -> who + " updated the case" + measure;
            case "CASE_RESOLVED" -> who + " resolved the case" + measure;
            case "OUTREACH_SENT" -> who + " sent outreach" + measure;
            case "CASE_SLA_BREACHED" -> "Case SLA breached — priority escalated" + measure;
            default -> eventType.replace('_', ' ').toLowerCase();
        };
    }

    public record EmployeeSearchResult(
        String externalId,
        String name,
        String role,
        String site,
        String latestOutcome
    ) {}
}
