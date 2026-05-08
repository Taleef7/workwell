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
                "List measures with optional lifecycle-status filter",
                "{\"type\":\"object\",\"properties\":{\"status\":{\"type\":\"string\"}}}"
        );
        Tool getMeasureVersion = new Tool(
                "get_measure_version",
                "Get latest active measure detail by measureId or measureName",
                "{\"type\":\"object\",\"properties\":{\"measureId\":{\"type\":\"string\"},\"measureName\":{\"type\":\"string\"}}}"
        );
        Tool listRuns = new Tool(
                "list_runs",
                "List run summaries with optional measure filter",
                "{\"type\":\"object\",\"properties\":{\"measureId\":{\"type\":\"string\"},\"limit\":{\"type\":\"number\"}}}"
        );
        Tool explainOutcome = new Tool(
                "explain_outcome",
                "Explain why a case was flagged using deterministic evidence fields",
                "{\"type\":\"object\",\"properties\":{\"caseId\":{\"type\":\"string\"}},\"required\":[\"caseId\"]}"
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
                    var summaries = caseFlowService.listCases(status, measureId, null, null, null, null, null);
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
                    String requestedStatus = args.get("status") == null || args.get("status").toString().isBlank()
                            ? "Active"
                            : args.get("status").toString().trim();
                    List<Map<String, Object>> payload = jdbcTemplate.query("""
                            SELECT
                                m.id AS measure_id,
                                m.name AS measure_name,
                                m.policy_ref,
                                mv.version,
                                mv.status,
                                mv.compile_status,
                                COALESCE(jsonb_array_length(COALESCE(mv.spec_json -> 'testFixtures', '[]'::jsonb)), 0) AS test_fixture_count,
                                (
                                    SELECT COUNT(*)
                                    FROM measure_value_set_links l
                                    WHERE l.measure_version_id = mv.id
                                ) AS value_set_count,
                                mv.created_at AS last_updated
                            FROM measures m
                            JOIN LATERAL (
                                SELECT id, version, status, compile_status, spec_json, created_at
                                FROM measure_versions
                                WHERE measure_id = m.id
                                ORDER BY created_at DESC
                                LIMIT 1
                            ) mv ON TRUE
                            WHERE LOWER(mv.status) = LOWER(?)
                            ORDER BY m.name ASC
                            """, (rs, rowNum) -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("measureId", rs.getObject("measure_id", UUID.class));
                        row.put("measureName", rs.getString("measure_name"));
                        row.put("policyRef", rs.getString("policy_ref"));
                        row.put("version", rs.getString("version"));
                        row.put("status", rs.getString("status"));
                        row.put("compileStatus", rs.getString("compile_status"));
                        row.put("testFixtureCount", rs.getInt("test_fixture_count"));
                        row.put("valueSetCount", rs.getInt("value_set_count"));
                        row.put("lastUpdated", rs.getTimestamp("last_updated") == null ? null : rs.getTimestamp("last_updated").toInstant());
                        return row;
                    }, requestedStatus);
                    recordMcpAudit(jdbcTemplate, objectMapper, "list_measures", Map.of(
                            "status", requestedStatus,
                            "returned", payload.size()
                    ));
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
                    String cqlText = detail.cqlText() == null ? "" : detail.cqlText();
                    String cqlPreview = cqlText.length() <= 500 ? cqlText : cqlText.substring(0, 500);
                    List<Map<String, Object>> valueSetPayload = detail.valueSets().stream().map(vs -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("id", vs.id());
                        row.put("name", vs.name());
                        row.put("oid", vs.oid());
                        row.put("version", vs.version() == null ? "" : vs.version());
                        return row;
                    }).toList();
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("measureId", detail.id());
                    payload.put("measureName", detail.name());
                    payload.put("policyRef", detail.policyRef());
                    payload.put("version", detail.version());
                    payload.put("lifecycleStatus", detail.status());
                    payload.put("compileStatus", detail.compileStatus());
                    payload.put("specJson", Map.of(
                            "description", detail.description(),
                            "eligibilityCriteria", detail.eligibilityCriteria(),
                            "exclusions", detail.exclusions(),
                            "complianceWindow", detail.complianceWindow(),
                            "requiredDataElements", detail.requiredDataElements()
                    ));
                    payload.put("cqlText", cqlPreview);
                    payload.put("attachedValueSets", valueSetPayload);
                    payload.put("testFixtureCount", detail.testFixtures().size());
                    payload.put("valueSetCount", detail.valueSets().size());
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
                    UUID measureId = args.get("measureId") == null || args.get("measureId").toString().isBlank()
                            ? null
                            : UUID.fromString(args.get("measureId").toString().trim());
                    int limit = args.get("limit") == null ? 10 : Math.max(1, Math.min(200, Integer.parseInt(args.get("limit").toString())));
                    List<Object> queryArgs = new java.util.ArrayList<>();
                    StringBuilder sql = new StringBuilder("""
                            SELECT
                                r.id AS run_id,
                                COALESCE(m.name, 'All Programs') AS measure_name,
                                COALESCE(mv.version, '-') AS measure_version,
                                r.status,
                                r.scope_type,
                                r.trigger_type,
                                r.started_at,
                                r.completed_at,
                                COALESCE(r.duration_ms, 0) AS duration_ms,
                                COALESCE(r.total_evaluated, 0) AS total_evaluated,
                                COALESCE(SUM(CASE WHEN o.status = 'COMPLIANT' THEN 1 ELSE 0 END), 0) AS compliant_count,
                                COALESCE(SUM(CASE WHEN o.status = 'DUE_SOON' THEN 1 ELSE 0 END), 0) AS due_soon_count,
                                COALESCE(SUM(CASE WHEN o.status = 'OVERDUE' THEN 1 ELSE 0 END), 0) AS overdue_count,
                                COALESCE(SUM(CASE WHEN o.status = 'MISSING_DATA' THEN 1 ELSE 0 END), 0) AS missing_data_count,
                                COALESCE(SUM(CASE WHEN o.status = 'EXCLUDED' THEN 1 ELSE 0 END), 0) AS excluded_count,
                                CASE
                                    WHEN COALESCE(r.total_evaluated, 0) = 0 THEN 0
                                    ELSE ROUND(
                                        100.0 * COALESCE(SUM(CASE WHEN o.status = 'COMPLIANT' THEN 1 ELSE 0 END), 0) / r.total_evaluated,
                                        1
                                    )
                                END AS compliance_rate
                            FROM runs r
                            LEFT JOIN measure_versions mv ON mv.id = r.scope_id
                            LEFT JOIN measures m ON m.id = mv.measure_id
                            LEFT JOIN outcomes o ON o.run_id = r.id
                            WHERE 1=1
                            """);
                    if (measureId != null) {
                        sql.append(" AND mv.measure_id = ? ");
                        queryArgs.add(measureId);
                    }
                    sql.append("""
                            GROUP BY r.id, m.name, mv.version
                            ORDER BY r.started_at DESC
                            LIMIT ?
                            """);
                    queryArgs.add(limit);
                    List<Map<String, Object>> payload = jdbcTemplate.query(sql.toString(), (rs, rowNum) -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("run_id", rs.getObject("run_id", UUID.class));
                        row.put("measure_name", rs.getString("measure_name"));
                        row.put("measure_version", rs.getString("measure_version"));
                        row.put("status", rs.getString("status"));
                        row.put("scope_type", rs.getString("scope_type"));
                        row.put("trigger_type", rs.getString("trigger_type"));
                        row.put("started_at", rs.getTimestamp("started_at") == null ? null : rs.getTimestamp("started_at").toInstant());
                        row.put("completed_at", rs.getTimestamp("completed_at") == null ? null : rs.getTimestamp("completed_at").toInstant());
                        row.put("duration_ms", rs.getLong("duration_ms"));
                        row.put("total_evaluated", rs.getLong("total_evaluated"));
                        row.put("compliance_rate", rs.getDouble("compliance_rate"));
                        row.put("outcome_counts", Map.of(
                                "COMPLIANT", rs.getLong("compliant_count"),
                                "DUE_SOON", rs.getLong("due_soon_count"),
                                "OVERDUE", rs.getLong("overdue_count"),
                                "MISSING_DATA", rs.getLong("missing_data_count"),
                                "EXCLUDED", rs.getLong("excluded_count")
                        ));
                        return row;
                    }, queryArgs.toArray());
                    recordMcpAudit(jdbcTemplate, objectMapper, "list_runs", Map.of(
                            "measureId", measureId == null ? "" : measureId.toString(),
                            "limit", limit,
                            "returned", payload.size()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        McpServerFeatures.SyncToolSpecification explainOutcomeSpec = new McpServerFeatures.SyncToolSpecification(
                explainOutcome,
                (exchange, args) -> {
                    String caseId = stringArg(args, "caseId");
                    var caseDetail = caseFlowService.loadCase(UUID.fromString(caseId))
                            .orElseThrow(() -> new IllegalArgumentException("Case not found: " + caseId));
                    Map<String, Object> whyFlagged = caseDetail.evidenceJson() == null
                            ? Map.of()
                            : objectMapper.convertValue(caseDetail.evidenceJson().getOrDefault("why_flagged", Map.of()), new TypeReference<Map<String, Object>>() {
                            });
                    // Fixed: was reading camelCase keys; CqlEvaluationService writes snake_case.
                    String lastExamDate = whyFlagged.get("last_exam_date") == null ? "unknown date" : whyFlagged.get("last_exam_date").toString();
                    String daysOverdue = whyFlagged.get("days_overdue") == null ? "unknown" : whyFlagged.get("days_overdue").toString();
                    String complianceWindowDays = whyFlagged.get("compliance_window_days") == null ? "unknown" : whyFlagged.get("compliance_window_days").toString();
                    String roleEligible = whyFlagged.get("role_eligible") == null ? "unknown" : whyFlagged.get("role_eligible").toString();
                    String siteEligible = whyFlagged.get("site_eligible") == null ? "unknown" : whyFlagged.get("site_eligible").toString();
                    String waiverStatus = whyFlagged.get("waiver_status") == null ? "unknown" : whyFlagged.get("waiver_status").toString();
                    String explanation = "%s was flagged as %s for the %s measure. Their last qualifying exam was %s (%s days ago), which exceeds the %s-day compliance window. Role eligibility: %s. Site eligibility: %s. Waiver status: %s."
                            .formatted(
                                    caseDetail.employeeName(),
                                    caseDetail.currentOutcomeStatus(),
                                    caseDetail.measureName(),
                                    lastExamDate,
                                    daysOverdue,
                                    complianceWindowDays,
                                    roleEligible,
                                    siteEligible,
                                    waiverStatus
                            );
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("case_id", caseId);
                    payload.put("employee_name", caseDetail.employeeName());
                    payload.put("measure_name", caseDetail.measureName());
                    payload.put("status", caseDetail.currentOutcomeStatus());
                    payload.put("explanation", explanation);
                    payload.put("why_flagged", whyFlagged);
                    recordMcpAudit(jdbcTemplate, objectMapper, "explain_outcome", Map.of(
                            "caseId", caseId,
                            "outcomeStatus", caseDetail.currentOutcomeStatus()
                    ));
                    return new CallToolResult(toJson(objectMapper, payload), false);
                }
        );

        return McpServer.sync(transportProvider)
                .serverInfo("workwell-mcp", "1.1.0")
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
