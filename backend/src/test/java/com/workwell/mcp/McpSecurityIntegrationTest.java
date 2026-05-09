package com.workwell.mcp;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-mcp-security"
})
@AutoConfigureMockMvc
@Testcontainers
class McpSecurityIntegrationTest {

    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16-alpine");

    @DynamicPropertySource
    static void datasource(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", postgres::getJdbcUrl);
        registry.add("spring.datasource.username", postgres::getUsername);
        registry.add("spring.datasource.password", postgres::getPassword);
        registry.add("spring.flyway.url", postgres::getJdbcUrl);
        registry.add("spring.flyway.user", postgres::getUsername);
        registry.add("spring.flyway.password", postgres::getPassword);
    }

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
}
