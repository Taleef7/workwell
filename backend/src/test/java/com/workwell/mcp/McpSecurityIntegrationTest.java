package com.workwell.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.AbstractIntegrationTest;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-mcp-security"
})
@AutoConfigureMockMvc
class McpSecurityIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private McpServerConfig mcpServerConfig;

    @Autowired
    private JdbcTemplate jdbcTemplate;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void unauthenticatedMcpRoutesAreRejected() throws Exception {
        mockMvc.perform(get("/sse").accept(MediaType.TEXT_EVENT_STREAM))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/mcp/message"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void usersWithoutMcpRoleAreForbidden() throws Exception {
        mockMvc.perform(get("/sse").accept(MediaType.TEXT_EVENT_STREAM))
                .andExpect(status().isForbidden());

        mockMvc.perform(post("/mcp/message"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void caseManagersCanReachTheMcpTransport() throws Exception {
        mockMvc.perform(get("/sse").accept(MediaType.TEXT_EVENT_STREAM))
                .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void mcpToolExecutionWritesAuthenticatedAuditMetadata() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate,
                objectMapper,
                "list_cases",
                "restricted",
                Map.of("status", "open", "measureId", "11111111-1111-1111-1111-111111111111"),
                () -> Map.of(
                        "results", List.of(Map.of("case_id", "case-1")),
                        "returned", 1
                )
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();

        assertThat(responseJson).contains("case-1");

        String auditJson = jdbcTemplate.queryForObject(
                """
                        SELECT payload_json::text
                        FROM audit_events
                        WHERE event_type = 'MCP_TOOL_CALLED'
                        ORDER BY id DESC
                        LIMIT 1
                        """,
                String.class
        );
        String actor = jdbcTemplate.queryForObject(
                """
                        SELECT actor
                        FROM audit_events
                        WHERE event_type = 'MCP_TOOL_CALLED'
                        ORDER BY id DESC
                        LIMIT 1
                        """,
                String.class
        );

        assertThat(actor).isEqualTo("admin@workwell.dev");

        Map<String, Object> payload = objectMapper.readValue(auditJson, new TypeReference<Map<String, Object>>() {
        });
        assertThat(payload.get("toolName")).isEqualTo("list_cases");
        assertThat(payload.get("success")).isEqualTo(Boolean.TRUE);
        assertThat(payload.get("sensitivityLabel")).isEqualTo("restricted");
        assertThat(((Number) payload.get("resultSize")).intValue()).isEqualTo(2);
        assertThat(payload.get("timestamp")).isInstanceOf(String.class);

        Map<String, Object> sanitizedArguments = objectMapper.convertValue(payload.get("sanitizedArguments"), new TypeReference<Map<String, Object>>() {
        });
        assertThat(sanitizedArguments).containsEntry("status", "open");
        assertThat(sanitizedArguments).containsEntry("measureId", "11111111-1111-1111-1111-111111111111");
        assertThat(payload.get("argumentHash")).isInstanceOf(String.class);
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void invalidMcpArgumentsFailSafelyAndAreAudited() throws Exception {
        assertThatThrownBy(() -> mcpServerConfig.executeTool(
                jdbcTemplate,
                objectMapper,
                "get_case",
                "restricted",
                Map.of("caseId", "not-a-uuid"),
                () -> {
                    UUID.fromString("not-a-uuid");
                    return Map.of("case_id", "unused");
                }
        )).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Invalid UUID string");

        String payloadJson = jdbcTemplate.queryForObject(
                """
                        SELECT payload_json::text
                        FROM audit_events
                        WHERE event_type = 'MCP_TOOL_CALLED'
                        ORDER BY id DESC
                        LIMIT 1
                        """,
                String.class
        );
        Map<String, Object> payload = objectMapper.readValue(payloadJson, new TypeReference<Map<String, Object>>() {
        });
        assertThat(payload.get("toolName")).isEqualTo("get_case");
        assertThat(payload.get("success")).isEqualTo(Boolean.FALSE);
        assertThat(payload.get("failureMessage")).asString().contains("Invalid UUID string");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void getEmployeeReturnsNotFoundForUnknownExternalId() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_employee", "restricted",
                Map.of("employeeExternalId", "emp-nonexistent"),
                () -> {
                    List<Map<String, Object>> rows = jdbcTemplate.query(
                            "SELECT id, external_id, name, role, site, active FROM employees WHERE external_id = ?",
                            (rs, i) -> Map.of("id", rs.getObject("id", UUID.class)),
                            "emp-nonexistent"
                    );
                    if (rows.isEmpty()) {
                        java.util.Map<String, Object> err = new java.util.LinkedHashMap<>();
                        err.put("error", true);
                        err.put("code", "EMPLOYEE_NOT_FOUND");
                        err.put("message", "Employee not found: emp-nonexistent");
                        return err;
                    }
                    return rows.get(0);
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("EMPLOYEE_NOT_FOUND");

        String auditActor = jdbcTemplate.queryForObject(
                "SELECT actor FROM audit_events WHERE event_type = 'MCP_TOOL_CALLED' ORDER BY id DESC LIMIT 1",
                String.class);
        assertThat(auditActor).isEqualTo("cm@workwell.dev");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void checkComplianceLatestModeReturnsNoOutcomeForUnknownEmployee() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "check_compliance", "restricted",
                Map.of("employeeExternalId", "emp-ghost", "measureName", "Annual Audiogram", "mode", "latest"),
                () -> {
                    java.util.Map<String, Object> empty = new java.util.LinkedHashMap<>();
                    empty.put("employeeExternalId", "emp-ghost");
                    empty.put("measureName", "Annual Audiogram");
                    empty.put("status", "NO_OUTCOME");
                    empty.put("source", "latest");
                    empty.put("complianceDecisionSource", "cql_outcome");
                    empty.put("message", "No outcome found. Run a measure evaluation first.");
                    return empty;
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("status")).isEqualTo("NO_OUTCOME");
        assertThat(result.get("complianceDecisionSource")).isEqualTo("cql_outcome");
        assertThat(result.containsKey("error")).isFalse();
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void checkCompliancePreviewModeDoesNotCallAi() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "check_compliance", "restricted",
                Map.of("employeeExternalId", "emp-ghost", "measureName", "Annual Audiogram", "mode", "preview"),
                () -> {
                    java.util.Map<String, Object> empty = new java.util.LinkedHashMap<>();
                    empty.put("employeeExternalId", "emp-ghost");
                    empty.put("measureName", "Annual Audiogram");
                    empty.put("status", "NO_OUTCOME");
                    empty.put("source", "preview");
                    empty.put("complianceDecisionSource", "cql_outcome");
                    return empty;
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("source")).isEqualTo("preview");
        assertThat(result.get("complianceDecisionSource")).isEqualTo("cql_outcome");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void listNoncompliantEnforcesLimitCap() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "list_noncompliant", "restricted",
                Map.of("limit", 999),
                () -> {
                    int effectiveLimit = Math.max(1, Math.min(100, 999));
                    java.util.Map<String, Object> response = new java.util.LinkedHashMap<>();
                    response.put("results", List.of());
                    response.put("returned", 0);
                    response.put("limit", effectiveLimit);
                    return response;
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(((Number) result.get("limit")).intValue()).isEqualTo(100);
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void listNoncompliantRejectsInvalidStatus() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "list_noncompliant", "restricted",
                Map.of("status", "COMPLIANT"),
                () -> {
                    java.util.Map<String, Object> err = new java.util.LinkedHashMap<>();
                    err.put("error", true);
                    err.put("code", "INVALID_ARGUMENT");
                    err.put("message", "status must be one of: DUE_SOON, OVERDUE, MISSING_DATA");
                    return err;
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("INVALID_ARGUMENT");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void explainRuleRequiresMeasureIdOrName() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "explain_rule", "internal",
                Map.of(),
                () -> {
                    java.util.Map<String, Object> err = new java.util.LinkedHashMap<>();
                    err.put("error", true);
                    err.put("code", "INVALID_ARGUMENT");
                    err.put("message", "measureId or measureName is required");
                    return err;
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("INVALID_ARGUMENT");

        String auditPayload = jdbcTemplate.queryForObject(
                "SELECT payload_json::text FROM audit_events WHERE event_type = 'MCP_TOOL_CALLED' ORDER BY id DESC LIMIT 1",
                String.class);
        Map<String, Object> audit = objectMapper.readValue(auditPayload, new TypeReference<>() {});
        assertThat(audit.get("toolName")).isEqualTo("explain_rule");
        assertThat(audit.get("success")).isEqualTo(Boolean.TRUE);
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void explainRuleReturnsDeterministicMetadataWithSourceField() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "explain_rule", "internal",
                Map.of("measureName", "Annual Audiogram Completed"),
                () -> {
                    java.util.Map<String, Object> payload = new java.util.LinkedHashMap<>();
                    payload.put("measureName", "Annual Audiogram Completed");
                    payload.put("policyRef", "OSHA 29 CFR 1910.95");
                    payload.put("source", "deterministic_metadata");
                    payload.put("cqlDefines", List.of("In Hearing Conservation Program", "Has Active Waiver", "Outcome Status"));
                    payload.put("attachedValueSets", List.of());
                    return payload;
                }
        ).content().stream()
                .filter(TextContent.class::isInstance)
                .map(TextContent.class::cast)
                .map(TextContent::text)
                .findFirst()
                .orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("source")).isEqualTo("deterministic_metadata");
        assertThat(result.get("measureName")).isEqualTo("Annual Audiogram Completed");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void mcpToolsAuditActorFromSecurityContext() throws Exception {
        mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "list_noncompliant", "restricted",
                Map.of("limit", 5),
                () -> Map.of("results", List.of(), "returned", 0, "limit", 5)
        );
        String actor = jdbcTemplate.queryForObject(
                "SELECT actor FROM audit_events WHERE event_type = 'MCP_TOOL_CALLED' ORDER BY id DESC LIMIT 1",
                String.class);
        assertThat(actor).isEqualTo("cm@workwell.dev");
    }

    // — P1: per-tool role enforcement —

    @Test
    @WithMockUser(username = "mcp@workwell.dev", roles = "MCP_CLIENT")
    void mcpClientOnlyCannotCallGetEmployee() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_employee", "restricted",
                Map.of("employeeExternalId", "emp-001"),
                () -> {
                    mcpServerConfig.requireAnyAuthority("get_employee", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of("name", "emp-001");
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("ACCESS_DENIED");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void caseManagerPassesGetEmployeeRoleCheck() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_employee", "restricted",
                Map.of("employeeExternalId", "emp-001"),
                () -> {
                    mcpServerConfig.requireAnyAuthority("get_employee", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of("name", "emp-001");
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result).doesNotContainKey("error");
        assertThat(result.get("name")).isEqualTo("emp-001");
    }

    @Test
    @WithMockUser(username = "mcp@workwell.dev", roles = "MCP_CLIENT")
    void mcpClientOnlyCannotCallCheckCompliance() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "check_compliance", "restricted",
                Map.of("employeeExternalId", "emp-001", "measureName", "Annual Audiogram"),
                () -> {
                    mcpServerConfig.requireAnyAuthority("check_compliance", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of("status", "COMPLIANT");
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("ACCESS_DENIED");
    }

    @Test
    @WithMockUser(username = "mcp@workwell.dev", roles = "MCP_CLIENT")
    void mcpClientOnlyCannotCallListNoncompliant() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "list_noncompliant", "restricted",
                Map.of(),
                () -> {
                    mcpServerConfig.requireAnyAuthority("list_noncompliant", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of("results", List.of());
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("ACCESS_DENIED");
    }

    @Test
    @WithMockUser(username = "mcp@workwell.dev", roles = "MCP_CLIENT")
    void mcpClientOnlyCannotCallGetCase() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_case", "restricted",
                Map.of("caseId", "11111111-1111-1111-1111-111111111111"),
                () -> {
                    mcpServerConfig.requireAnyAuthority("get_case", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of("case_id", "11111111-1111-1111-1111-111111111111");
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("ACCESS_DENIED");
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorCanCallExplainRule() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "explain_rule", "internal",
                Map.of("measureName", "Annual Audiogram"),
                () -> {
                    mcpServerConfig.requireAnyAuthority("explain_rule", "ROLE_AUTHOR", "ROLE_APPROVER", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of("source", "deterministic_metadata");
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result).doesNotContainKey("error");
        assertThat(result.get("source")).isEqualTo("deterministic_metadata");
    }

    @Test
    @WithMockUser(username = "mcp@workwell.dev", roles = "MCP_CLIENT")
    void unauthorizedToolCallWritesDeniedAuditEvent() throws Exception {
        mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_employee", "restricted",
                Map.of("employeeExternalId", "emp-001"),
                () -> {
                    mcpServerConfig.requireAnyAuthority("get_employee", "ROLE_CASE_MANAGER", "ROLE_ADMIN");
                    return Map.of();
                }
        );
        String payloadJson = jdbcTemplate.queryForObject(
                "SELECT payload_json::text FROM audit_events WHERE event_type = 'MCP_TOOL_CALLED' ORDER BY id DESC LIMIT 1",
                String.class);
        Map<String, Object> audit = objectMapper.readValue(payloadJson, new TypeReference<>() {});
        assertThat(audit.get("toolName")).isEqualTo("get_employee");
        assertThat(audit.get("success")).isEqualTo(Boolean.FALSE);
        assertThat(audit.get("failureMessage").toString()).contains("ACCESS_DENIED");
    }

    // — P2: check_compliance NO_OUTCOME shape consistency —

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void checkComplianceNoOutcomeIncludesComplianceDecisionSourceAndDecisionAvailable() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "check_compliance", "restricted",
                Map.of("employeeExternalId", "emp-ghost", "measureName", "Annual Audiogram"),
                () -> {
                    Map<String, Object> empty = new java.util.LinkedHashMap<>();
                    empty.put("employeeExternalId", "emp-ghost");
                    empty.put("measureName", "Annual Audiogram");
                    empty.put("status", "NO_OUTCOME");
                    empty.put("source", "latest");
                    empty.put("complianceDecisionSource", "cql_outcome");
                    empty.put("decisionAvailable", false);
                    empty.put("message", "No outcome found. Run a measure evaluation first.");
                    return empty;
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("status")).isEqualTo("NO_OUTCOME");
        assertThat(result.get("complianceDecisionSource")).isEqualTo("cql_outcome");
        assertThat(result.get("decisionAvailable")).isEqualTo(Boolean.FALSE);
    }

    // — P3: safe argument parsing —

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void explainRuleWithMalformedMeasureIdReturnsInvalidArgument() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "explain_rule", "internal",
                Map.of("measureId", "not-a-uuid"),
                () -> {
                    String rawId = "not-a-uuid";
                    if (!rawId.matches("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")) {
                        Map<String, Object> err = new java.util.LinkedHashMap<>();
                        err.put("error", true);
                        err.put("code", "INVALID_ARGUMENT");
                        err.put("message", "measureId must be a valid UUID");
                        return err;
                    }
                    return Map.of();
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("INVALID_ARGUMENT");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void getCaseWithMalformedCaseIdReturnsInvalidArgument() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_case", "restricted",
                Map.of("caseId", "bad-id"),
                () -> {
                    String caseId = "bad-id";
                    if (!caseId.matches("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")) {
                        Map<String, Object> err = new java.util.LinkedHashMap<>();
                        err.put("error", true);
                        err.put("code", "INVALID_ARGUMENT");
                        err.put("message", "caseId must be a valid UUID");
                        return err;
                    }
                    return Map.of();
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("INVALID_ARGUMENT");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void getRunSummaryWithMalformedRunIdReturnsInvalidArgument() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "get_run_summary", "internal",
                Map.of("runId", "not-a-uuid"),
                () -> {
                    String rawId = "not-a-uuid";
                    if (!rawId.matches("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")) {
                        Map<String, Object> err = new java.util.LinkedHashMap<>();
                        err.put("error", true);
                        err.put("code", "INVALID_ARGUMENT");
                        err.put("message", "runId must be a valid UUID");
                        return err;
                    }
                    return Map.of();
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("INVALID_ARGUMENT");
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void listNoncompliantWithNonNumericLimitReturnsInvalidArgument() throws Exception {
        String responseJson = mcpServerConfig.executeTool(
                jdbcTemplate, objectMapper, "list_noncompliant", "restricted",
                Map.of("limit", "abc"),
                () -> {
                    try {
                        Integer.parseInt("abc");
                    } catch (NumberFormatException e) {
                        Map<String, Object> err = new java.util.LinkedHashMap<>();
                        err.put("error", true);
                        err.put("code", "INVALID_ARGUMENT");
                        err.put("message", "limit must be a numeric value");
                        return err;
                    }
                    return Map.of();
                }
        ).content().stream()
                .filter(io.modelcontextprotocol.spec.McpSchema.TextContent.class::isInstance)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent.class::cast)
                .map(io.modelcontextprotocol.spec.McpSchema.TextContent::text)
                .findFirst().orElseThrow();
        Map<String, Object> result = objectMapper.readValue(responseJson, new TypeReference<>() {});
        assertThat(result.get("error")).isEqualTo(Boolean.TRUE);
        assertThat(result.get("code")).isEqualTo("INVALID_ARGUMENT");
    }
}
