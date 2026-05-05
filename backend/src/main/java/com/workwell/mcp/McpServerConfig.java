package com.workwell.mcp;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.measure.MeasureService;
import com.workwell.run.RunPersistenceService;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.WebMvcSseServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.function.RouterFunction;
import org.springframework.web.servlet.function.ServerResponse;

@Configuration
public class McpServerConfig {
    private static final String MESSAGE_ENDPOINT = "/mcp/message";
    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
    );

    @Bean
    WebMvcSseServerTransportProvider mcpTransportProvider(ObjectMapper objectMapper) {
        return new WebMvcSseServerTransportProvider(objectMapper, MESSAGE_ENDPOINT);
    }

    @Bean
    RouterFunction<ServerResponse> mcpRouterFunction(WebMvcSseServerTransportProvider transportProvider) {
        return transportProvider.getRouterFunction();
    }

    @Bean
    McpSyncServer mcpServer(
            WebMvcSseServerTransportProvider transportProvider,
            ObjectMapper objectMapper,
            CaseFlowService caseFlowService,
            RunPersistenceService runPersistenceService,
            MeasureService measureService,
            JdbcTemplate jdbcTemplate
    ) {
        Tool getCase = new Tool(
                "get_case",
                "Get full case detail by caseId",
                "{\"type\":\"object\",\"properties\":{\"caseId\":{\"type\":\"string\"}},\"required\":[\"caseId\"]}"
        );
        Tool listCases = new Tool(
                "list_cases",
                "List case summaries with optional status and measure filter (measureId or measureName)",
                "{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\",\"enum\":[\"open\",\"closed\",\"all\"]},\"measureId\":{\"type\":\"string\"},\"measureName\":{\"type\":\"string\"}}}"
        );
        Tool getRunSummary = new Tool(
                "get_run_summary",
                "Get run metadata and outcome counts by runId. If runId is omitted, returns latest run.",
                "{\"type\":\"object\",\"properties\":{\"runId\":{\"type\":\"string\"}}}"
        );
        Tool listMeasures = new Tool(
                "list_measures",
                "List active measures with catalog metadata",
                "{\"type\":\"object\"}"
        );
        Tool getMeasureVersion = new Tool(
                "get_measure_version",
                "Get latest active measure detail by measureId or measureName",
                "{\"type\":\"object\",\"properties\":{\"measureId\":{\"type\":\"string\"},\"measureName\":{\"type\":\"string\"}}}"
        );
        Tool listRuns = new Tool(
                "list_runs",
                "List run summaries with optional filters",
                "{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"},\"scopeType\":{\"type\":\"string\"},\"triggerType\":{\"type\":\"string\"},\"limit\":{\"type\":\"number\"}}}"
        );
        Tool explainOutcome = new Tool(
                "explain_outcome",
                "Explain a run outcome from structured evidence only",
                "{\"type\":\"object\",\"properties\":{\"runId\":{\"type\":\"string\"},\"employeeId\":{\"type\":\"string\"}},\"required\":[\"runId\",\"employeeId\"]}"
        );

        McpServerFeatures.SyncToolSpecification getCaseSpec = new McpServerFeatures.SyncToolSpecification(
                getCase,
                (exchange, args) -> {
                    String caseId = stringArg(args, "caseId");
                    var detail = caseFlowService.loadCase(UUID.fromString(caseId))
                            .orElseThrow(() -> new IllegalArgumentException("Case not found: " + caseId));
                    Map<String, Object> payload = objectMapper.convertValue(detail, new TypeReference<Map<String, Object>>() {
                    });
                    Object evidencePayload = payload.get("evidenceJson");
                    payload.put("evidence_payload", evidencePayload == null ? Map.of() : evidencePayload);
                    if (evidencePayload instanceof Map<?, ?> evidenceMap) {
                        Object whyFlagged = evidenceMap.containsKey("why_flagged")
                                ? evidenceMap.get("why_flagged")
                                : Map.of();
                        payload.put("why_flagged", whyFlagged);
                    } else {
                        payload.put("why_flagged", Map.of());
                    }
                    recordMcpAudit(jdbcTemplate, objectMapper, "get_case", Map.of("caseId", caseId));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification listCasesSpec = new McpServerFeatures.SyncToolSpecification(
                listCases,
                (exchange, args) -> {
                    String status = args.get("status") == null ? "open" : args.get("status").toString();
                    UUID measureId = null;
                    if (args.get("measureId") != null && !args.get("measureId").toString().isBlank()) {
                        String rawMeasureId = args.get("measureId").toString().trim();
                        // Backward-compatible fallback for clients still sending human labels in measureId.
                        if (UUID_PATTERN.matcher(rawMeasureId).matches()) {
                            measureId = UUID.fromString(rawMeasureId);
                        } else {
                            measureId = lookupMeasureIdByName(measureService, rawMeasureId);
                        }
                    } else if (args.get("measureName") != null && !args.get("measureName").toString().isBlank()) {
                        String requestedMeasureName = args.get("measureName").toString().trim();
                        measureId = lookupMeasureIdByName(measureService, requestedMeasureName);
                    }
                    var summaries = caseFlowService.listCases(status, measureId, null, null, null);
                    List<Map<String, Object>> payload = summaries.stream().map(summary -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("case_id", summary.caseId());
                        row.put("employee_id", summary.employeeId());
                        row.put("employee_name", summary.employeeName());
                        row.put("site", summary.site());
                        row.put("measure_name", summary.measureName());
                        row.put("measure_version", summary.measureVersion());
                        row.put("measure_version_id", summary.measureVersionId());
                        row.put("evaluation_period", summary.evaluationPeriod());
                        row.put("status", summary.status());
                        row.put("priority", summary.priority());
                        row.put("assignee", summary.assignee() == null ? "" : summary.assignee());
                        row.put("current_outcome_status", summary.currentOutcomeStatus());
                        row.put("last_run_id", summary.lastRunId());
                        row.put("updated_at", summary.updatedAt());
                        return row;
                    }).toList();
                    recordMcpAudit(jdbcTemplate, objectMapper, "list_cases", Map.of(
                            "status", status,
                            "measureId", measureId == null ? "" : measureId.toString(),
                            "returned", payload.size()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification getRunSummarySpec = new McpServerFeatures.SyncToolSpecification(
                getRunSummary,
                (exchange, args) -> {
                    var summary = args.get("runId") == null || args.get("runId").toString().isBlank()
                            ? runPersistenceService.loadLatestRun()
                                    .orElseThrow(() -> new IllegalArgumentException("No runs found"))
                            : runPersistenceService.loadRunById(UUID.fromString(args.get("runId").toString()))
                                    .orElseThrow(() -> new IllegalArgumentException("Run not found: " + args.get("runId")));
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("run_id", summary.runId());
                    payload.put("scope", summary.scopeType());
                    payload.put("total_cases", summary.totalCases());
                    payload.put("compliant_count", summary.compliantCount());
                    payload.put("non_compliant_count", summary.nonCompliantCount());
                    payload.put("pass_rate", summary.passRate());
                    payload.put("duration", summary.durationMs());
                    payload.put("outcome_counts", summary.outcomeCounts());
                    payload.put("started_at", summary.startedAt());
                    payload.put("completed_at", summary.completedAt());
                    recordMcpAudit(jdbcTemplate, objectMapper, "get_run_summary", Map.of(
                            "runId", summary.runId(),
                            "scope", summary.scopeType()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification listMeasuresSpec = new McpServerFeatures.SyncToolSpecification(
                listMeasures,
                (exchange, args) -> {
                    List<Map<String, Object>> payload = measureService.listMeasures().stream().map(m -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("id", m.id());
                        row.put("name", m.name());
                        row.put("policy_ref", m.policyRef());
                        row.put("version", m.version());
                        row.put("status", m.status());
                        row.put("owner", m.owner());
                        row.put("tags", m.tags());
                        row.put("last_updated", m.lastUpdated());
                        return row;
                    }).toList();
                    recordMcpAudit(jdbcTemplate, objectMapper, "list_measures", Map.of("returned", payload.size()));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification getMeasureVersionSpec = new McpServerFeatures.SyncToolSpecification(
                getMeasureVersion,
                (exchange, args) -> {
                    UUID measureId;
                    if (args.get("measureId") != null && !args.get("measureId").toString().isBlank()) {
                        measureId = UUID.fromString(args.get("measureId").toString().trim());
                    } else if (args.get("measureName") != null && !args.get("measureName").toString().isBlank()) {
                        measureId = lookupMeasureIdByName(measureService, args.get("measureName").toString().trim());
                    } else {
                        throw new IllegalArgumentException("measureId or measureName is required");
                    }
                    var detail = measureService.getMeasure(measureId);
                    if (detail == null) {
                        throw new IllegalArgumentException("Measure not found");
                    }
                    Map<String, Object> payload = objectMapper.convertValue(detail, new TypeReference<Map<String, Object>>() {
                    });
                    recordMcpAudit(jdbcTemplate, objectMapper, "get_measure_version", Map.of(
                            "measureId", measureId.toString(),
                            "measureName", detail.name()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification listRunsSpec = new McpServerFeatures.SyncToolSpecification(
                listRuns,
                (exchange, args) -> {
                    String status = args.get("status") == null ? null : args.get("status").toString();
                    String scopeType = args.get("scopeType") == null ? null : args.get("scopeType").toString();
                    String triggerType = args.get("triggerType") == null ? null : args.get("triggerType").toString();
                    int limit = args.get("limit") == null ? 20 : Math.max(1, Math.min(200, Integer.parseInt(args.get("limit").toString())));
                    List<Map<String, Object>> payload = runPersistenceService.listRuns(status, scopeType, triggerType, limit).stream().map(run -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("run_id", run.runId());
                        row.put("measure_name", run.measureName());
                        row.put("status", run.status());
                        row.put("scope_type", run.scopeType());
                        row.put("trigger_type", run.triggerType());
                        row.put("started_at", run.startedAt());
                        row.put("completed_at", run.completedAt());
                        row.put("duration_ms", run.durationMs());
                        row.put("total_evaluated", run.totalEvaluated());
                        row.put("compliant_count", run.compliantCount());
                        row.put("non_compliant_count", run.nonCompliantCount());
                        return row;
                    }).toList();
                    recordMcpAudit(jdbcTemplate, objectMapper, "list_runs", Map.of(
                            "status", status == null ? "" : status,
                            "scopeType", scopeType == null ? "" : scopeType,
                            "triggerType", triggerType == null ? "" : triggerType,
                            "returned", payload.size()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification explainOutcomeSpec = new McpServerFeatures.SyncToolSpecification(
                explainOutcome,
                (exchange, args) -> {
                    String runId = stringArg(args, "runId");
                    String employeeId = stringArg(args, "employeeId");
                    var outcome = runPersistenceService.loadOutcomeExportRows(UUID.fromString(runId)).stream()
                            .filter(row -> employeeId.equalsIgnoreCase(row.employeeId()))
                            .findFirst()
                            .orElseThrow(() -> new IllegalArgumentException("Outcome not found for runId/employeeId"));
                    Map<String, Object> whyFlagged = Map.of();
                    Object why = outcome.evidenceJson().get("why_flagged");
                    if (why instanceof Map<?, ?> map) {
                        whyFlagged = objectMapper.convertValue(map, new TypeReference<Map<String, Object>>() {
                        });
                    }
                    String explanation = outcome.employeeName()
                            + " is " + outcome.status()
                            + " for " + outcome.measureName()
                            + " (" + outcome.measureVersion() + ")"
                            + " based on structured evidence only. "
                            + "Summary: " + outcome.summary() + ". "
                            + "why_flagged: " + toJson(objectMapper, whyFlagged) + ".";
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("run_id", runId);
                    payload.put("employee_id", outcome.employeeId());
                    payload.put("employee_name", outcome.employeeName());
                    payload.put("measure_name", outcome.measureName());
                    payload.put("measure_version", outcome.measureVersion());
                    payload.put("status", outcome.status());
                    payload.put("summary", outcome.summary());
                    payload.put("explanation", explanation);
                    payload.put("why_flagged", whyFlagged);
                    payload.put("disclaimer", "Explanation is advisory text derived from evidence_json; compliance remains CQL-driven.");
                    recordMcpAudit(jdbcTemplate, objectMapper, "explain_outcome", Map.of(
                            "runId", runId,
                            "employeeId", employeeId,
                            "measureName", outcome.measureName()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        return McpServer.sync(transportProvider)
                .serverInfo("workwell-mcp", "1.0.1")
                .tools(
                        getCaseSpec,
                        listCasesSpec,
                        getRunSummarySpec,
                        listMeasuresSpec,
                        getMeasureVersionSpec,
                        listRunsSpec,
                        explainOutcomeSpec
                )
                .build();
    }

    private UUID lookupMeasureIdByName(MeasureService measureService, String requestedMeasureName) {
        return measureService.listMeasures().stream()
                .filter(m -> m.name().equalsIgnoreCase(requestedMeasureName))
                .findFirst()
                .map(MeasureService.MeasureCatalogItem::id)
                .orElseThrow(() -> new IllegalArgumentException("Measure not found: " + requestedMeasureName));
    }

    private String stringArg(Map<String, Object> args, String key) {
        Object value = args.get(key);
        if (value == null || value.toString().isBlank()) {
            throw new IllegalArgumentException("Missing required argument: " + key);
        }
        return value.toString();
    }

    private String toJson(ObjectMapper objectMapper, Object payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialize MCP response", ex);
        }
    }

    private void recordMcpAudit(JdbcTemplate jdbcTemplate, ObjectMapper objectMapper, String toolName, Map<String, Object> args) {
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, payload_json) VALUES (?, ?, ?, ?, ?::jsonb)",
                "MCP_TOOL_CALLED",
                "mcp_tool",
                UUID.randomUUID(),
                "mcp",
                toJson(objectMapper, Map.of("tool", toolName, "args", args))
        );
    }
}
