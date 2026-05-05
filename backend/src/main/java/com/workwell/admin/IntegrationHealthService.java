package com.workwell.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class IntegrationHealthService {
    private static final List<String> INTEGRATIONS = List.of("fhir", "mcp", "ai");

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public IntegrationHealthService(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public List<IntegrationHealth> listHealth() {
        return INTEGRATIONS.stream().map(this::healthFor).toList();
    }

    public IntegrationHealth triggerManualSync(String integration, String actor) {
        validateIntegration(integration);
        Instant triggeredAt = Instant.now();

        insertAuditEvent(
                "INTEGRATION_SYNC_TRIGGERED",
                actor,
                Map.of(
                        "integration", integration,
                        "mode", "manual",
                        "status", "QUEUED"
                )
        );

        insertAuditEvent(
                "INTEGRATION_SYNC_COMPLETED",
                actor,
                Map.of(
                        "integration", integration,
                        "mode", "manual",
                        "status", "SUCCESS",
                        "durationMs", 250
                )
        );

        return new IntegrationHealth(
                integration,
                "healthy",
                triggeredAt,
                "Manual sync stub completed; external side effects are disabled in MVP."
        );
    }

    private IntegrationHealth healthFor(String integration) {
        Instant lastSuccess = jdbcTemplate.query(
                """
                        SELECT occurred_at
                        FROM audit_events
                        WHERE event_type = 'INTEGRATION_SYNC_COMPLETED'
                          AND payload_json ->> 'integration' = ?
                          AND payload_json ->> 'status' = 'SUCCESS'
                        ORDER BY occurred_at DESC
                        LIMIT 1
                        """,
                rs -> rs.next() ? rs.getTimestamp("occurred_at").toInstant() : null,
                integration
        );

        String status;
        String detail;
        if (lastSuccess == null) {
            status = "unknown";
            detail = "No successful sync has been recorded yet.";
        } else {
            long minutesSince = ChronoUnit.MINUTES.between(lastSuccess, Instant.now());
            status = minutesSince <= 60 ? "healthy" : "stale";
            detail = "Last successful sync was " + minutesSince + " minute(s) ago.";
        }

        return new IntegrationHealth(integration, status, lastSuccess, detail);
    }

    private void validateIntegration(String integration) {
        if (!INTEGRATIONS.contains(integration)) {
            throw new IllegalArgumentException("Unsupported integration: " + integration);
        }
    }

    private void insertAuditEvent(String eventType, String actor, Map<String, Object> payload) {
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, payload_json) VALUES (?, ?, ?, ?, ?::jsonb)",
                eventType,
                "integration",
                UUID.randomUUID(),
                actor,
                toJson(payload)
        );
    }

    private String toJson(Map<String, Object> payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize integration payload", ex);
        }
    }

    public record IntegrationHealth(
            String integration,
            String status,
            Instant lastSyncAt,
            String detail
    ) {
    }
}
