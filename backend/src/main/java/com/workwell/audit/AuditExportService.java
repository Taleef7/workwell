package com.workwell.audit;

import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AuditExportService {
    private final JdbcTemplate jdbcTemplate;

    public AuditExportService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public String exportCsv() {
        String sql = """
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
                ORDER BY ae.occurred_at ASC, ae.id ASC
                """;

        List<Map<String, Object>> rows = jdbcTemplate.queryForList(sql);
        StringBuilder csv = new StringBuilder();
        csv.append("timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail\n");
        for (Map<String, Object> row : rows) {
            csv.append(escape(value(row.get("occurred_at")))).append(",");
            csv.append(escape(value(row.get("event_type")))).append(",");
            csv.append(escape(value(row.get("ref_case_id")))).append(",");
            csv.append(escape(value(row.get("ref_run_id")))).append(",");
            csv.append(escape(value(row.get("measure_name")))).append(",");
            csv.append(escape(value(row.get("employee_external_id")))).append(",");
            csv.append(escape(value(row.get("actor")))).append(",");
            csv.append(escape(value(row.get("payload_json")))).append("\n");
        }
        return csv.toString();
    }

    private String value(Object value) {
        return value == null ? "" : value.toString();
    }

    private String escape(String value) {
        String normalized = value.replace("\"", "\"\"");
        return "\"" + normalized + "\"";
    }
}
