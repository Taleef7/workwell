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
            MeasureService measureService
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
                    var summaries = caseFlowService.listCases(status, measureId);
                    List<Map<String, Object>> payload = summaries.stream().map(summary -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("case_id", summary.caseId());
                        row.put("employee_id", summary.employeeId());
                        row.put("employee_name", summary.employeeName());
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
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        return McpServer.sync(transportProvider)
                .serverInfo("workwell-mcp", "1.0.1")
                .tools(getCaseSpec, listCasesSpec, getRunSummarySpec)
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
}
