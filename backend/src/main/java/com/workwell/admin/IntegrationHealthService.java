package com.workwell.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class IntegrationHealthService {
    private static final Set<String> INTEGRATIONS = Set.of("fhir", "mcp", "ai", "hris");

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
            case "fhir" -> new SyncResult("healthy", "Manual sync triggered", Map.of("mode", "manual-stub"));
            case "hris" -> new SyncResult("healthy", "Manual sync triggered", Map.of("mode", "manual-stub"));
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

        String body = toJson(Map.of(
                "model", openAiModel,
                "input", "ping",
                "max_output_tokens", 1
        ));
        HttpRequest request = HttpRequest.newBuilder(URI.create("https://api.openai.com/v1/responses"))
                .timeout(Duration.ofSeconds(10))
                .header("Authorization", "Bearer " + openAiApiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body))
                .build();

        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() >= 200 && response.statusCode() < 300) {
                return new SyncResult("healthy", "Manual sync triggered", Map.of("model", openAiModel, "statusCode", response.statusCode()));
            }
            return new SyncResult("degraded", "OpenAI health check failed (HTTP " + response.statusCode() + ")", Map.of("model", openAiModel, "statusCode", response.statusCode()));
        } catch (Exception ex) {
            return new SyncResult("degraded", "OpenAI health check failed: " + ex.getMessage(), Map.of("model", openAiModel));
        }
    }

    private SyncResult checkMcpHealth() {
        try {
            HttpURLConnection connection = (HttpURLConnection) URI.create(mcpSseUrl).toURL().openConnection();
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
            return new SyncResult("degraded", "MCP SSE not reachable (HTTP " + statusCode + ")", Map.of(
                    "sseUrl", mcpSseUrl,
                    "statusCode", statusCode,
                    "contentType", contentType == null ? "" : contentType
            ));
        } catch (Exception ex) {
            return new SyncResult("degraded", "MCP SSE check failed: " + ex.getMessage(), Map.of("sseUrl", mcpSseUrl));
        }
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
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, payload_json) VALUES (?, ?, ?, ?, ?::jsonb)",
                eventType,
                "integration",
                UUID.randomUUID(),
                actor,
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
