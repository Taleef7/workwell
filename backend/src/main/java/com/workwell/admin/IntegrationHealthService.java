package com.workwell.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.security.SecurityActor;
import java.net.URI;
import java.net.HttpURLConnection;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class IntegrationHealthService {
    private static final Logger log = LoggerFactory.getLogger(IntegrationHealthService.class);
    private static final Set<String> INTEGRATIONS = Set.of("fhir", "mcp", "ai", "hris");
    private static final String HRIS_SIMULATED_MESSAGE =
            "Integration not connected — synthetic data only";

    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final HttpClient httpClient;
    private final String openAiApiKey;
    private final String openAiModel;
    private final String mcpSseUrl;

    public IntegrationHealthService(
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            @Value("${spring.ai.openai.api-key:}") String openAiApiKey,
            @Value("${spring.ai.openai.chat.options.model:gpt-5.4-nano}") String openAiModel,
            @Value("${workwell.mcp.sse-url:http://127.0.0.1:8080/sse}") String mcpSseUrl
    ) {
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        this.httpClient = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        this.openAiApiKey = openAiApiKey == null ? "" : openAiApiKey.trim();
        this.openAiModel = openAiModel == null || openAiModel.isBlank() ? "gpt-5.4-nano" : openAiModel.trim();
        this.mcpSseUrl = mcpSseUrl == null || mcpSseUrl.isBlank() ? "http://127.0.0.1:8080/sse" : mcpSseUrl.trim();
    }

    public List<IntegrationHealth> listHealth() {
        return jdbcTemplate.query(
                """
                        SELECT id, display_name, status, last_sync_at, last_sync_result, config_json
                        FROM integration_health
                        ORDER BY id ASC
                        """,
                (rs, rowNum) -> new IntegrationHealth(
                        rs.getString("id"),
                        rs.getString("display_name"),
                        rs.getString("status"),
                        rs.getTimestamp("last_sync_at") == null ? null : rs.getTimestamp("last_sync_at").toInstant(),
                        rs.getString("last_sync_result"),
                        parseJsonMap(rs.getString("config_json"))
                )
        );
    }

    public IntegrationHealth triggerManualSync(String integration, String actor) {
        String integrationId = normalizeIntegration(integration);
        Instant now = Instant.now();

        SyncResult syncResult = switch (integrationId) {
            case "ai" -> checkAiHealth();
            case "mcp" -> checkMcpHealth();
            case "fhir" -> checkFhirHealth();
            case "hris" -> hrisSimulatedResult();
            default -> throw new IllegalArgumentException("Unsupported integration: " + integration);
        };

        jdbcTemplate.update(
                """
                        UPDATE integration_health
                        SET status = ?,
                            last_sync_at = ?,
                            last_sync_result = ?,
                            config_json = ?::jsonb
                        WHERE id = ?
                        """,
                syncResult.status(),
                java.sql.Timestamp.from(now),
                syncResult.message(),
                toJson(syncResult.config()),
                integrationId
        );

        insertAuditEvent(
                "INTEGRATION_SYNC_TRIGGERED",
                actor,
                Map.of(
                        "integrationId", integrationId,
                        "result", syncResult.status(),
                        "actor", actor,
                        "message", syncResult.message(),
                        "syncedAt", now.toString()
                )
        );

        return loadIntegration(integrationId).orElseThrow(() -> new IllegalStateException("Integration row missing: " + integrationId));
    }

    private Optional<IntegrationHealth> loadIntegration(String integrationId) {
        List<IntegrationHealth> rows = jdbcTemplate.query(
                """
                        SELECT id, display_name, status, last_sync_at, last_sync_result, config_json
                        FROM integration_health
                        WHERE id = ?
                        """,
                (rs, rowNum) -> new IntegrationHealth(
                        rs.getString("id"),
                        rs.getString("display_name"),
                        rs.getString("status"),
                        rs.getTimestamp("last_sync_at") == null ? null : rs.getTimestamp("last_sync_at").toInstant(),
                        rs.getString("last_sync_result"),
                        parseJsonMap(rs.getString("config_json"))
                ),
                integrationId
        );
        return rows.stream().findFirst();
    }

    private SyncResult checkAiHealth() {
        if (openAiApiKey.isBlank()) {
            return new SyncResult("degraded", "OPENAI_API_KEY not configured", Map.of("model", openAiModel));
        }

        // Use the models list endpoint — a simple GET that validates the API key
        // without requiring a specific model name to exist.
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.openai.com/v1/models"))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + openAiApiKey)
                .GET()
                .build();

        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                return new SyncResult("healthy", "OpenAI API key valid", Map.of("model", openAiModel, "statusCode", response.statusCode()));
            }
            return new SyncResult("degraded", "OpenAI health check failed (HTTP " + response.statusCode() + ")", Map.of("model", openAiModel, "statusCode", response.statusCode()));
        } catch (Exception ex) {
            return new SyncResult("degraded", "OpenAI health check failed: " + ex.getMessage(), Map.of("model", openAiModel));
        }
    }

    private SyncResult checkMcpHealth() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) URI.create(mcpSseUrl).toURL().openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.connect();

            int statusCode = connection.getResponseCode();
            String contentType = connection.getHeaderField("Content-Type");
            if (statusCode >= 200 && statusCode < 400) {
                return new SyncResult("healthy", "Manual sync triggered", Map.of(
                        "sseUrl", mcpSseUrl,
                        "statusCode", statusCode,
                        "contentType", contentType == null ? "" : contentType
                ));
            }
            // 401/403 means the SSE endpoint is reachable and correctly secured by auth —
            // not a connectivity failure. Report as healthy with a note.
            if (statusCode == 401 || statusCode == 403) {
                return new SyncResult("healthy", "MCP SSE reachable and secured by auth (HTTP " + statusCode + ")", Map.of(
                        "sseUrl", mcpSseUrl,
                        "statusCode", statusCode,
                        "note", "Unauthenticated health probe returns auth challenge — endpoint is protected as expected"
                ));
            }
            return new SyncResult("degraded", "MCP SSE not reachable (HTTP " + statusCode + ")", Map.of(
                    "sseUrl", mcpSseUrl,
                    "statusCode", statusCode,
                    "contentType", contentType == null ? "" : contentType
            ));
        } catch (Exception ex) {
            return new SyncResult("degraded", "MCP SSE check failed: " + ex.getMessage(), Map.of("sseUrl", mcpSseUrl));
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private SyncResult checkFhirHealth() {
        // The backend evaluates measures against an in-memory synthetic FHIR bundle, so there
        // is no external endpoint to ping. A meaningful smoke test is confirming the HAPI FHIR
        // R4 context (the foundation of the CQL engine) can be instantiated.
        try {
            ca.uhn.fhir.context.FhirContext.forR4Cached();
            return new SyncResult("healthy", "In-memory CQL evaluation engine responsive", Map.of(
                    "mode", "in-memory",
                    "fhirVersion", "R4"
            ));
        } catch (Exception ex) {
            return new SyncResult("unhealthy", "CQL engine initialization failed: " + ex.getMessage(), Map.of(
                    "mode", "in-memory"
            ));
        }
    }

    private SyncResult hrisSimulatedResult() {
        // No real HRIS integration exists. Report a distinct "simulated" status so the demo is
        // transparent that workforce data is synthetic rather than sourced from a live HRIS.
        return new SyncResult("simulated", HRIS_SIMULATED_MESSAGE, Map.of(
                "mode", "synthetic",
                "connected", false
        ));
    }

    /**
     * Background refresh for the integrations that have a deterministic health signal
     * (FHIR + MCP + HRIS). AI health is updated reactively from {@link #recordAiHealth}
     * after each real AI call, so it is intentionally excluded here.
     */
    @Scheduled(fixedDelay = 900_000L)
    public void scheduledRefresh() {
        try {
            persistStatus("fhir", checkFhirHealth());
            persistStatus("mcp", checkMcpHealth());
            persistStatus("hris", hrisSimulatedResult());
        } catch (Exception ex) {
            log.warn("Scheduled integration health refresh failed: {}", ex.getMessage());
        }
    }

    /**
     * Lightweight reactive status update used by {@code AiAssistService} after every AI call.
     * Intentionally does NOT write an audit event (status only) to avoid audit spam on each
     * AI invocation.
     */
    public void recordAiHealth(boolean success, String detail) {
        String status = success ? "healthy" : "degraded";
        String message = detail == null || detail.isBlank()
                ? (success ? "Last AI call succeeded" : "Last AI call failed")
                : detail;
        try {
            jdbcTemplate.update(
                    """
                            UPDATE integration_health
                            SET status = ?,
                                last_sync_at = ?,
                                last_sync_result = ?
                            WHERE id = 'ai'
                            """,
                    status,
                    java.sql.Timestamp.from(Instant.now()),
                    message
            );
        } catch (Exception ex) {
            log.warn("Unable to record AI integration health: {}", ex.getMessage());
        }
    }

    private void persistStatus(String integrationId, SyncResult result) {
        jdbcTemplate.update(
                """
                        UPDATE integration_health
                        SET status = ?,
                            last_sync_at = ?,
                            last_sync_result = ?,
                            config_json = ?::jsonb
                        WHERE id = ?
                        """,
                result.status(),
                java.sql.Timestamp.from(Instant.now()),
                result.message(),
                toJson(result.config()),
                integrationId
        );
    }

    private String normalizeIntegration(String integration) {
        if (integration == null || integration.isBlank()) {
            throw new IllegalArgumentException("Unsupported integration: " + integration);
        }
        String normalized = integration.trim().toLowerCase();
        if (!INTEGRATIONS.contains(normalized)) {
            throw new IllegalArgumentException("Unsupported integration: " + integration);
        }
        return normalized;
    }

    private void insertAuditEvent(String eventType, String actor, Map<String, Object> payload) {
        String resolvedActor = SecurityActor.currentActorOr(actor);
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, payload_json) VALUES (?, ?, ?, ?, ?::jsonb)",
                eventType,
                "integration",
                UUID.randomUUID(),
                resolvedActor,
                toJson(payload)
        );
    }

    private Map<String, Object> parseJsonMap(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = objectMapper.readValue(json, LinkedHashMap.class);
            return map;
        } catch (Exception ex) {
            return Map.of("raw", json);
        }
    }

    private String toJson(Map<String, Object> payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize integration payload", ex);
        }
    }

    private record SyncResult(String status, String message, Map<String, Object> config) {
    }

    public record IntegrationHealth(
            String integration,
            String displayName,
            String status,
            Instant lastSyncAt,
            String detail,
            Map<String, Object> config
    ) {
    }
}
