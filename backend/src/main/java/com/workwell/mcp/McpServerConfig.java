package com.workwell.mcp;

import com.fasterxml.jackson.core.JsonProcessingException;
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
                    return new CallToolResult(toJson(objectMapper, detail), false);
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
                    return new CallToolResult(toJson(objectMapper, summaries), false);
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
                    return new CallToolResult(toJson(objectMapper, summary), false);
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
