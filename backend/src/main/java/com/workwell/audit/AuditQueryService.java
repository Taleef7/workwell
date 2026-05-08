package com.workwell.audit;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AuditQueryService {
    private final JdbcTemplate jdbcTemplate;

    public AuditQueryService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<AuditEventRow> listEvents(String scope, int limit) {
        StringBuilder sql = new StringBuilder("""
                SELECT ae.occurred_at,
                       ae.event_type,
                       ae.ref_case_id,
                       ae.ref_run_id,
                       m.name AS measure_name,
                       e.external_id AS employee_external_id,
                       ae.actor,
                       ae.payload_json
                FROM audit_events ae
                LEFT JOIN measure_versions mv ON ae.ref_measure_version_id = mv.id
                LEFT JOIN measures m ON mv.measure_id = m.id
                LEFT JOIN cases c ON ae.ref_case_id = c.id
                LEFT JOIN outcomes o ON ae.entity_type = 'outcome' AND ae.entity_id = o.id
                LEFT JOIN employees e ON COALESCE(c.employee_id, o.employee_id) = e.id
                WHERE 1=1
                """);
        List<Object> args = new ArrayList<>();
        String normalized = scope == null ? "all" : scope.trim().toLowerCase();
        if ("access".equals(normalized)) {
            sql.append(" AND ae.event_type = 'CASE_VIEWED'");
        } else if ("mutation".equals(normalized) || "mutations".equals(normalized)) {
            sql.append(" AND ae.event_type <> 'CASE_VIEWED'");
        }
        sql.append(" ORDER BY ae.occurred_at DESC, ae.id DESC LIMIT ?");
        args.add(limit);

        return jdbcTemplate.query(sql.toString(), (rs, rowNum) -> new AuditEventRow(
                rs.getTimestamp("occurred_at").toInstant(),
                rs.getString("event_type"),
                "CASE_VIEWED".equalsIgnoreCase(rs.getString("event_type")) ? "access" : "mutation",
                rs.getObject("ref_case_id") == null ? null : (UUID) rs.getObject("ref_case_id"),
                rs.getObject("ref_run_id") == null ? null : (UUID) rs.getObject("ref_run_id"),
                rs.getString("measure_name"),
                rs.getString("employee_external_id"),
                rs.getString("actor"),
                rs.getString("payload_json")
        ), args.toArray());
    }

    public record AuditEventRow(
            java.time.Instant occurredAt,
            String eventType,
            String scope,
            UUID caseId,
            UUID runId,
            String measureName,
            String employeeExternalId,
            String actor,
            String detail
    ) {
    }
}
