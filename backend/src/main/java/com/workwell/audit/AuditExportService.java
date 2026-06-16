package com.workwell.audit;

import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.UncheckedIOException;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuditExportService {
    /** Server-side cursor page size — keeps the Postgres driver from buffering the whole ResultSet. */
    private static final int FETCH_SIZE = 500;

    private static final String EXPORT_SQL = """
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

    private static final String HEADER =
            "timestamp,eventType,caseId,runId,measureName,employeeId,actor,detail\n";

    private final JdbcTemplate jdbcTemplate;

    public AuditExportService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /**
     * Stream the full audit ledger as CSV directly to {@code out}, one row at a time from a server-side
     * cursor (#150 M9). The previous implementation materialized the entire ledger (a {@code List<Map>}
     * plus a single ~12MB {@code String}) in heap, which grows unbounded with the audit trail. Here a
     * read-only transaction + a bounded fetch size keep the Postgres driver in cursor mode, so peak
     * memory is one page of rows regardless of ledger size. The CSV bytes are identical to before
     * (same header, columns, and quoting), so the export contract is unchanged.
     */
    @Transactional(readOnly = true)
    public void streamCsv(OutputStream out) {
        Writer writer = new OutputStreamWriter(out, StandardCharsets.UTF_8);
        try {
            writer.write(HEADER);
            jdbcTemplate.query(
                    con -> {
                        var ps = con.prepareStatement(EXPORT_SQL);
                        ps.setFetchSize(FETCH_SIZE);
                        return ps;
                    },
                    rs -> {
                        try {
                            writer.write(escape(value(rs.getObject("occurred_at"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("event_type"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("ref_case_id"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("ref_run_id"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("measure_name"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("employee_external_id"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("actor"))));
                            writer.write(",");
                            writer.write(escape(value(rs.getObject("payload_json"))));
                            writer.write("\n");
                        } catch (IOException e) {
                            throw new UncheckedIOException(e);
                        }
                    });
            writer.flush();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private String value(Object value) {
        return value == null ? "" : value.toString();
    }

    private String escape(String value) {
        String normalized = value.replace("\"", "\"\"");
        return "\"" + normalized + "\"";
    }
}
