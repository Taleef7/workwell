package com.workwell.admin;

import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Read model over {@code outreach_delivery_log} for the Admin delivery-history panel.
 * Joins through cases -> measure_versions -> measures so each row shows the measure name.
 */
@Service
public class OutreachDeliveryLogService {
    private final JdbcTemplate jdbcTemplate;

    public OutreachDeliveryLogService(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    public List<DeliveryLogEntry> recent(int limit) {
        int safeLimit = Math.max(1, Math.min(limit, 200));
        return jdbcTemplate.query(
                """
                        SELECT odl.id,
                               odl.case_id,
                               odl.to_address,
                               odl.subject,
                               odl.provider,
                               odl.status,
                               odl.sent_at,
                               odl.error_detail,
                               m.name AS measure_name
                        FROM outreach_delivery_log odl
                        LEFT JOIN cases c ON c.id = odl.case_id
                        LEFT JOIN measure_versions mv ON mv.id = c.measure_version_id
                        LEFT JOIN measures m ON m.id = mv.measure_id
                        ORDER BY odl.sent_at DESC
                        LIMIT ?
                        """,
                (rs, rowNum) -> new DeliveryLogEntry(
                        (UUID) rs.getObject("id"),
                        (UUID) rs.getObject("case_id"),
                        rs.getString("to_address"),
                        rs.getString("subject"),
                        rs.getString("provider"),
                        rs.getString("status"),
                        rs.getTimestamp("sent_at") == null ? null : rs.getTimestamp("sent_at").toInstant(),
                        rs.getString("error_detail"),
                        rs.getString("measure_name")
                ),
                safeLimit
        );
    }

    public record DeliveryLogEntry(
            UUID id,
            UUID caseId,
            String toAddress,
            String subject,
            String provider,
            String status,
            Instant sentAt,
            String errorDetail,
            String measureName
    ) {
    }
}
