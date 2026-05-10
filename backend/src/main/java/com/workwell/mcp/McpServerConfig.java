package com.workwell.mcp;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.admin.DataReadinessService;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.MeasureTraceabilityService;
import com.workwell.run.RunPersistenceService;
import com.workwell.security.SecurityActor;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.server.transport.WebMvcSseServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.HexFormat;
import java.util.UUID;
import java.util.regex.Pattern;
import java.util.function.Supplier;
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
            MeasureTraceabilityService traceabilityService,
            DataReadinessService dataReadinessService,
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
                    return executeTool(jdbcTemplate, objectMapper, "get_case", "restricted", args, () -> {
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
                        return payload;
                    });
                }
        );

        McpServerFeatures.SyncToolSpecification listCasesSpec = new McpServerFeatures.SyncToolSpecification(
                listCases,
                (exchange, args) -> {
                    return executeTool(jdbcTemplate, objectMapper, "list_cases", "restricted", args, () -> {
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
                        Map<String, Object> response = new LinkedHashMap<>();
                        response.put("results", payload);
                        response.put("returned", payload.size());
                        response.put("filters", Map.of(
                                "status", status,
                                "measureId", measureId == null ? "" : measureId.toString()
                        ));
                        return response;
                    });
                }
        );

        McpServerFeatures.SyncToolSpecification getRunSummarySpec = new McpServerFeatures.SyncToolSpecification(
                getRunSummary,
                (exchange, args) -> {
                    return executeTool(jdbcTemplate, objectMapper, "get_run_summary", "internal", args, () -> {
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
                        return payload;
                    });
                }
        );

        McpServerFeatures.SyncToolSpecification listMeasuresSpec = new McpServerFeatures.SyncToolSpecification(
                listMeasures,
                (exchange, args) -> {
                    return executeTool(jdbcTemplate, objectMapper, "list_measures", "internal", args, () -> {
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
                        Map<String, Object> response = new LinkedHashMap<>();
                        response.put("results", payload);
                        response.put("returned", payload.size());
                        response.put("status", requestedStatus);
                        return response;
                    });
                }
        );

        McpServerFeatures.SyncToolSpecification getMeasureVersionSpec = new McpServerFeatures.SyncToolSpecification(
                getMeasureVersion,
                (exchange, args) -> {
                    return executeTool(jdbcTemplate, objectMapper, "get_measure_version", "restricted", args, () -> {
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
                        return payload;
                    });
                }
        );

        McpServerFeatures.SyncToolSpecification listRunsSpec = new McpServerFeatures.SyncToolSpecification(
                listRuns,
                (exchange, args) -> {
                    return executeTool(jdbcTemplate, objectMapper, "list_runs", "internal", args, () -> {
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
                        Map<String, Object> response = new LinkedHashMap<>();
                        response.put("results", payload);
                        response.put("returned", payload.size());
                        response.put("measureId", measureId == null ? "" : measureId.toString());
                        response.put("limit", limit);
                        return response;
                    });
                }
        );

        McpServerFeatures.SyncToolSpecification explainOutcomeSpec = new McpServerFeatures.SyncToolSpecification(
                explainOutcome,
                (exchange, args) -> {
                    return executeTool(jdbcTemplate, objectMapper, "explain_outcome", "restricted", args, () -> {
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
                        return payload;
                    });
                }
        );

        // — v2 tools —

        Tool getEmployee = new Tool(
                "get_employee",
                "Get employee summary and latest compliance outcomes by employeeExternalId",
                "{\"type\":\"object\",\"properties\":{\"employeeExternalId\":{\"type\":\"string\"}},\"required\":[\"employeeExternalId\"]}"
        );

        Tool checkCompliance = new Tool(
                "check_compliance",
                "Return latest or preview compliance status for an employee/measure. mode=latest retrieves the persisted outcome; mode=preview returns the same data labeled as preview (no official records created). AI is never used.",
                "{\"type\":\"object\",\"properties\":{\"employeeExternalId\":{\"type\":\"string\"},\"measureName\":{\"type\":\"string\"},\"evaluationDate\":{\"type\":\"string\"},\"mode\":{\"type\":\"string\",\"enum\":[\"latest\",\"preview\"]}},\"required\":[\"employeeExternalId\",\"measureName\"]}"
        );

        Tool listNoncompliant = new Tool(
                "list_noncompliant",
                "List non-compliant open cases filtered by measureName, site, and outcome status. Default limit 25, max 100.",
                "{\"type\":\"object\",\"properties\":{\"measureName\":{\"type\":\"string\"},\"site\":{\"type\":\"string\"},\"status\":{\"type\":\"string\",\"enum\":[\"DUE_SOON\",\"OVERDUE\",\"MISSING_DATA\"]},\"limit\":{\"type\":\"number\"}}}"
        );

        Tool explainRule = new Tool(
                "explain_rule",
                "Explain measure rule logic from deterministic measure metadata: policy ref, description, eligibility, compliance window, required data elements, CQL defines, and value sets. Does not use AI.",
                "{\"type\":\"object\",\"properties\":{\"measureName\":{\"type\":\"string\"},\"measureId\":{\"type\":\"string\"}},\"required\":[]}"
        );

        Tool getMeasureTraceability = new Tool(
                "get_measure_traceability",
                "Return policy-to-evidence traceability matrix rows and gaps for a measure. Uses the same backend as the traceability endpoint.",
                "{\"type\":\"object\",\"properties\":{\"measureName\":{\"type\":\"string\"},\"measureId\":{\"type\":\"string\"}}}"
        );

        Tool listDataQualityGaps = new Tool(
                "list_data_quality_gaps",
                "Return data readiness gaps and blockers for a measure. Uses the data readiness backend service.",
                "{\"type\":\"object\",\"properties\":{\"measureName\":{\"type\":\"string\"},\"measureId\":{\"type\":\"string\"}}}"
        );

        McpServerFeatures.SyncToolSpecification getEmployeeSpec = new McpServerFeatures.SyncToolSpecification(
                getEmployee,
                (exchange, args) -> executeTool(jdbcTemplate, objectMapper, "get_employee", "restricted", args, () -> {
                    String externalId = stringArg(args, "employeeExternalId");
                    List<Map<String, Object>> empRows = jdbcTemplate.query(
                            "SELECT id, external_id, name, role, site, active FROM employees WHERE external_id = ?",
                            (rs, i) -> {
                                Map<String, Object> row = new LinkedHashMap<>();
                                row.put("employeeInternalId", rs.getObject("id", UUID.class));
                                row.put("employeeExternalId", rs.getString("external_id"));
                                row.put("name", rs.getString("name"));
                                row.put("role", rs.getString("role"));
                                row.put("site", rs.getString("site"));
                                row.put("active", rs.getBoolean("active"));
                                return row;
                            }, externalId
                    );
                    if (empRows.isEmpty()) {
                        return safeError("EMPLOYEE_NOT_FOUND", "Employee not found: " + externalId);
                    }
                    Map<String, Object> emp = empRows.get(0);
                    UUID internalId = (UUID) emp.get("employeeInternalId");
                    List<Map<String, Object>> latestOutcomes = jdbcTemplate.query(
                            """
                            SELECT m.name AS measure_name, mv.version, o.status, o.evaluation_period, o.evaluated_at
                            FROM outcomes o
                            JOIN measure_versions mv ON mv.id = o.measure_version_id
                            JOIN measures m ON m.id = mv.measure_id
                            WHERE o.employee_id = ?
                            ORDER BY o.evaluated_at DESC
                            LIMIT 5
                            """,
                            (rs, i) -> {
                                Map<String, Object> row = new LinkedHashMap<>();
                                row.put("measureName", rs.getString("measure_name"));
                                row.put("version", rs.getString("version"));
                                row.put("status", rs.getString("status"));
                                row.put("evaluationPeriod", rs.getString("evaluation_period"));
                                row.put("evaluatedAt", rs.getTimestamp("evaluated_at") == null ? null : rs.getTimestamp("evaluated_at").toInstant());
                                return row;
                            }, internalId
                    );
                    Map<String, Object> payload = new LinkedHashMap<>(emp);
                    payload.remove("employeeInternalId");
                    payload.put("latestOutcomes", latestOutcomes);
                    return payload;
                })
        );

        McpServerFeatures.SyncToolSpecification checkComplianceSpec = new McpServerFeatures.SyncToolSpecification(
                checkCompliance,
                (exchange, args) -> executeTool(jdbcTemplate, objectMapper, "check_compliance", "restricted", args, () -> {
                    String externalId = stringArg(args, "employeeExternalId");
                    String measureName = stringArg(args, "measureName");
                    String mode = args.get("mode") == null ? "latest" : args.get("mode").toString();
                    if (!"latest".equals(mode) && !"preview".equals(mode)) {
                        return safeError("INVALID_ARGUMENT", "mode must be 'latest' or 'preview'");
                    }
                    List<Map<String, Object>> rows = jdbcTemplate.query(
                            """
                            SELECT o.status, o.evaluation_period, o.evaluated_at,
                                   m.name AS measure_name, mv.version,
                                   c.id AS case_id
                            FROM outcomes o
                            JOIN measure_versions mv ON mv.id = o.measure_version_id
                            JOIN measures m ON m.id = mv.measure_id
                            JOIN employees e ON e.id = o.employee_id
                            LEFT JOIN cases c ON c.employee_id = o.employee_id
                              AND c.measure_version_id = o.measure_version_id
                              AND c.evaluation_period = o.evaluation_period
                              AND c.status = 'OPEN'
                            WHERE e.external_id = ?
                              AND LOWER(m.name) = LOWER(?)
                            ORDER BY o.evaluated_at DESC
                            LIMIT 1
                            """,
                            (rs, i) -> {
                                Map<String, Object> row = new LinkedHashMap<>();
                                row.put("status", rs.getString("status"));
                                row.put("evaluationPeriod", rs.getString("evaluation_period"));
                                row.put("evaluatedAt", rs.getTimestamp("evaluated_at") == null ? null : rs.getTimestamp("evaluated_at").toInstant());
                                row.put("measureName", rs.getString("measure_name"));
                                row.put("measureVersion", rs.getString("version"));
                                row.put("caseId", rs.getObject("case_id", UUID.class));
                                return row;
                            }, externalId, measureName
                    );
                    if (rows.isEmpty()) {
                        Map<String, Object> empty = new LinkedHashMap<>();
                        empty.put("employeeExternalId", externalId);
                        empty.put("measureName", measureName);
                        empty.put("status", "NO_OUTCOME");
                        empty.put("source", mode);
                        empty.put("message", "No outcome found. Run a measure evaluation first.");
                        return empty;
                    }
                    Map<String, Object> result = new LinkedHashMap<>(rows.get(0));
                    result.put("employeeExternalId", externalId);
                    result.put("source", mode);
                    // AI is never consulted — status comes from persisted CQL outcome only
                    result.put("complianceDecisionSource", "cql_outcome");
                    return result;
                })
        );

        McpServerFeatures.SyncToolSpecification listNoncompliantSpec = new McpServerFeatures.SyncToolSpecification(
                listNoncompliant,
                (exchange, args) -> executeTool(jdbcTemplate, objectMapper, "list_noncompliant", "restricted", args, () -> {
                    int limit = args.get("limit") == null ? 25 : Math.max(1, Math.min(100, Integer.parseInt(args.get("limit").toString())));
                    String measureNameFilter = args.get("measureName") == null ? null : args.get("measureName").toString().trim();
                    String siteFilter = args.get("site") == null ? null : args.get("site").toString().trim();
                    String statusFilter = args.get("status") == null ? null : args.get("status").toString().trim();
                    if (statusFilter != null && !List.of("DUE_SOON", "OVERDUE", "MISSING_DATA").contains(statusFilter)) {
                        return safeError("INVALID_ARGUMENT", "status must be one of: DUE_SOON, OVERDUE, MISSING_DATA");
                    }
                    StringBuilder sql = new StringBuilder("""
                            SELECT c.id AS case_id, e.external_id AS employee_external_id, e.name AS employee_name,
                                   e.site, m.name AS measure_name, mv.version, c.evaluation_period,
                                   c.current_outcome_status, c.priority, c.next_action, c.assignee, c.updated_at
                            FROM cases c
                            JOIN employees e ON e.id = c.employee_id
                            JOIN measure_versions mv ON mv.id = c.measure_version_id
                            JOIN measures m ON m.id = mv.measure_id
                            WHERE c.status = 'OPEN'
                              AND c.current_outcome_status IN ('DUE_SOON', 'OVERDUE', 'MISSING_DATA')
                            """);
                    List<Object> params = new java.util.ArrayList<>();
                    if (measureNameFilter != null && !measureNameFilter.isBlank()) {
                        sql.append(" AND LOWER(m.name) = LOWER(?)");
                        params.add(measureNameFilter);
                    }
                    if (siteFilter != null && !siteFilter.isBlank()) {
                        sql.append(" AND LOWER(COALESCE(e.site, '')) = LOWER(?)");
                        params.add(siteFilter);
                    }
                    if (statusFilter != null) {
                        sql.append(" AND c.current_outcome_status = ?");
                        params.add(statusFilter);
                    }
                    sql.append(" ORDER BY c.updated_at DESC LIMIT ?");
                    params.add(limit);
                    List<Map<String, Object>> results = jdbcTemplate.query(sql.toString(), (rs, i) -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("caseId", rs.getObject("case_id", UUID.class));
                        row.put("employeeExternalId", rs.getString("employee_external_id"));
                        row.put("employeeName", rs.getString("employee_name"));
                        row.put("site", rs.getString("site"));
                        row.put("measureName", rs.getString("measure_name"));
                        row.put("measureVersion", rs.getString("version"));
                        row.put("evaluationPeriod", rs.getString("evaluation_period"));
                        row.put("outcomeStatus", rs.getString("current_outcome_status"));
                        row.put("priority", rs.getString("priority"));
                        row.put("nextAction", rs.getString("next_action"));
                        row.put("assignee", rs.getString("assignee"));
                        row.put("updatedAt", rs.getTimestamp("updated_at") == null ? null : rs.getTimestamp("updated_at").toInstant());
                        return row;
                    }, params.toArray());
                    Map<String, Object> response = new LinkedHashMap<>();
                    response.put("results", results);
                    response.put("returned", results.size());
                    response.put("limit", limit);
                    response.put("filters", Map.of(
                            "measureName", measureNameFilter == null ? "" : measureNameFilter,
                            "site", siteFilter == null ? "" : siteFilter,
                            "status", statusFilter == null ? "" : statusFilter
                    ));
                    return response;
                })
        );

        McpServerFeatures.SyncToolSpecification explainRuleSpec = new McpServerFeatures.SyncToolSpecification(
                explainRule,
                (exchange, args) -> executeTool(jdbcTemplate, objectMapper, "explain_rule", "internal", args, () -> {
                    UUID measureId;
                    if (args.get("measureId") != null && !args.get("measureId").toString().isBlank()) {
                        measureId = UUID.fromString(args.get("measureId").toString().trim());
                    } else if (args.get("measureName") != null && !args.get("measureName").toString().isBlank()) {
                        measureId = lookupMeasureIdByName(measureService, args.get("measureName").toString().trim());
                    } else {
                        return safeError("INVALID_ARGUMENT", "measureId or measureName is required");
                    }
                    var detail = measureService.getMeasure(measureId);
                    if (detail == null) {
                        return safeError("MEASURE_NOT_FOUND", "Measure not found");
                    }
                    String cqlText = detail.cqlText() == null ? "" : detail.cqlText();
                    List<String> defineNames = java.util.regex.Pattern
                            .compile("define\\s+\"([^\"]+)\"\\s*:", java.util.regex.Pattern.CASE_INSENSITIVE | java.util.regex.Pattern.MULTILINE)
                            .matcher(cqlText)
                            .results()
                            .map(mr -> mr.group(1))
                            .toList();
                    List<Map<String, Object>> valueSets = detail.valueSets().stream().map(vs -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("name", vs.name());
                        row.put("oid", vs.oid());
                        row.put("version", vs.version() == null ? "" : vs.version());
                        return row;
                    }).toList();
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("measureName", detail.name());
                    payload.put("policyRef", detail.policyRef());
                    payload.put("description", detail.description());
                    payload.put("eligibility", detail.eligibilityCriteria());
                    payload.put("exclusions", detail.exclusions());
                    payload.put("complianceWindow", detail.complianceWindow());
                    payload.put("requiredDataElements", detail.requiredDataElements());
                    payload.put("cqlDefines", defineNames);
                    payload.put("attachedValueSets", valueSets);
                    payload.put("source", "deterministic_metadata");
                    return payload;
                })
        );

        McpServerFeatures.SyncToolSpecification getMeasureTraceabilitySpec = new McpServerFeatures.SyncToolSpecification(
                getMeasureTraceability,
                (exchange, args) -> executeTool(jdbcTemplate, objectMapper, "get_measure_traceability", "internal", args, () -> {
                    UUID measureId;
                    if (args.get("measureId") != null && !args.get("measureId").toString().isBlank()) {
                        measureId = UUID.fromString(args.get("measureId").toString().trim());
                    } else if (args.get("measureName") != null && !args.get("measureName").toString().isBlank()) {
                        measureId = lookupMeasureIdByName(measureService, args.get("measureName").toString().trim());
                    } else {
                        return safeError("INVALID_ARGUMENT", "measureId or measureName is required");
                    }
                    var traceability = traceabilityService.generate(measureId);
                    List<Map<String, Object>> rows = traceability.rows().stream().map(row -> {
                        Map<String, Object> r = new LinkedHashMap<>();
                        r.put("policyCitation", row.policyCitation());
                        r.put("policyRequirement", row.policyRequirement());
                        r.put("specField", row.specField());
                        r.put("specValue", row.specValue());
                        r.put("cqlDefine", row.cqlDefine());
                        r.put("runtimeEvidenceKeys", row.runtimeEvidenceKeys());
                        return r;
                    }).toList();
                    List<Map<String, Object>> gaps = traceability.gaps().stream().map(gap -> Map.of(
                            "severity", (Object) gap.severity(),
                            "message", gap.message()
                    )).toList();
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("measureId", traceability.measureId());
                    payload.put("measureName", traceability.measureName());
                    payload.put("version", traceability.version());
                    payload.put("rows", rows);
                    payload.put("gaps", gaps);
                    return payload;
                })
        );

        McpServerFeatures.SyncToolSpecification listDataQualityGapsSpec = new McpServerFeatures.SyncToolSpecification(
                listDataQualityGaps,
                (exchange, args) -> executeTool(jdbcTemplate, objectMapper, "list_data_quality_gaps", "internal", args, () -> {
                    UUID measureId;
                    if (args.get("measureId") != null && !args.get("measureId").toString().isBlank()) {
                        measureId = UUID.fromString(args.get("measureId").toString().trim());
                    } else if (args.get("measureName") != null && !args.get("measureName").toString().isBlank()) {
                        measureId = lookupMeasureIdByName(measureService, args.get("measureName").toString().trim());
                    } else {
                        return safeError("INVALID_ARGUMENT", "measureId or measureName is required");
                    }
                    var readiness = dataReadinessService.computeReadiness(measureId);
                    List<Map<String, Object>> elements = readiness.requiredElements().stream().map(el -> {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("canonicalElement", el.canonicalElement());
                        row.put("label", el.label());
                        row.put("mappingStatus", el.mappingStatus());
                        row.put("freshnessStatus", el.freshnessStatus());
                        row.put("missingnessRate", el.missingnessRate());
                        return row;
                    }).toList();
                    Map<String, Object> payload = new LinkedHashMap<>();
                    payload.put("measureId", measureId);
                    payload.put("overallStatus", readiness.overallStatus());
                    payload.put("blockers", readiness.blockers());
                    payload.put("warnings", readiness.warnings());
                    payload.put("elementReadiness", elements);
                    return payload;
                })
        );

        return McpServer.sync(transportProvider)
                .serverInfo("workwell-mcp", "2.0.0")
                .tools(
                        getCaseSpec,
                        listCasesSpec,
                        getRunSummarySpec,
                        listMeasuresSpec,
                        getMeasureVersionSpec,
                        listRunsSpec,
                        explainOutcomeSpec,
                        getEmployeeSpec,
                        checkComplianceSpec,
                        listNoncompliantSpec,
                        explainRuleSpec,
                        getMeasureTraceabilitySpec,
                        listDataQualityGapsSpec
                )
                .build();
    }

    private Map<String, Object> safeError(String code, String message) {
        Map<String, Object> err = new LinkedHashMap<>();
        err.put("error", true);
        err.put("code", code);
        err.put("message", message);
        return err;
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
        recordMcpAudit(
                jdbcTemplate,
                objectMapper,
                toolName,
                SecurityActor.currentActor(),
                args,
                Map.of(),
                true,
                "unclassified",
                Instant.now(),
                null
        );
    }

    CallToolResult executeTool(
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            String toolName,
            String sensitivityLabel,
            Map<String, Object> args,
            Supplier<Object> payloadSupplier
    ) {
        Map<String, Object> safeArgs = args == null ? Map.of() : args;
        String actor = SecurityActor.currentActor();
        Instant timestamp = Instant.now();
        try {
            Object payload = payloadSupplier.get();
            recordMcpAudit(jdbcTemplate, objectMapper, toolName, actor, safeArgs, payload, true, sensitivityLabel, timestamp, null);
            return new CallToolResult(toJson(objectMapper, payload), false);
        } catch (RuntimeException ex) {
            try {
                recordMcpAudit(jdbcTemplate, objectMapper, toolName, actor, safeArgs, Map.of(), false, sensitivityLabel, timestamp, ex.getMessage());
            } catch (RuntimeException auditEx) {
                ex.addSuppressed(auditEx);
            }
            throw ex;
        }
    }

    private void recordMcpAudit(
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            String toolName,
            String actor,
            Map<String, Object> args,
            Object resultPayload,
            boolean success,
            String sensitivityLabel,
            Instant occurredAt,
            String failureMessage
    ) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("toolName", toolName);
        payload.put("sanitizedArguments", sanitizeArgs(args));
        payload.put("argumentHash", hashArgs(objectMapper, args));
        payload.put("resultSize", resultSize(resultPayload));
        payload.put("success", success);
        payload.put("sensitivityLabel", sensitivityLabel);
        payload.put("timestamp", occurredAt.toString());
        if (failureMessage != null && !failureMessage.isBlank()) {
            payload.put("failureMessage", failureMessage);
        }

        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, payload_json) VALUES (?, ?, ?, ?, ?::jsonb)",
                "MCP_TOOL_CALLED",
                "mcp_tool",
                UUID.randomUUID(),
                actor,
                toJson(objectMapper, payload)
        );
    }

    private Map<String, Object> sanitizeArgs(Map<String, Object> args) {
        Map<String, Object> sanitized = new LinkedHashMap<>();
        if (args == null) {
            return sanitized;
        }
        args.forEach((key, value) -> sanitized.put(key, sanitizeValue(value)));
        return sanitized;
    }

    private Object sanitizeValue(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Number || value instanceof Boolean) {
            return value;
        }
        if (value instanceof UUID uuid) {
            return uuid.toString();
        }
        if (value instanceof Map<?, ?> map) {
            return Map.of("size", map.size());
        }
        if (value instanceof Collection<?> collection) {
            return Map.of("size", collection.size());
        }
        String text = value.toString();
        if (text.length() <= 256) {
            return text;
        }
        return text.substring(0, 253) + "...";
    }

    private String hashArgs(ObjectMapper objectMapper, Map<String, Object> args) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(toJson(objectMapper, sanitizeArgs(args)).getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("Unable to hash MCP arguments", ex);
        }
    }

    private int resultSize(Object payload) {
        if (payload == null) {
            return 0;
        }
        if (payload instanceof Map<?, ?> map) {
            return map.size();
        }
        if (payload instanceof Collection<?> collection) {
            return collection.size();
        }
        return 1;
    }
}
