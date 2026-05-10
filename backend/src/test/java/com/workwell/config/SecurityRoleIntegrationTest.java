package com.workwell.config;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

/**
 * Verifies that SecurityConfig role boundaries are enforced end-to-end.
 * These tests run with auth enabled so security filters are active.
 */
@SpringBootTest(properties = {
        "workwell.auth.enabled=true",
        "workwell.auth.jwt-secret=test-secret-for-role-integration"
})
@AutoConfigureMockMvc
@Testcontainers
class SecurityRoleIntegrationTest {

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

    // --- Unauthenticated ---

    @Test
    void unauthenticatedGetMeasuresFails() throws Exception {
        mockMvc.perform(get("/api/measures"))
                .andExpect(status().isForbidden());
    }

    @Test
    void unauthenticatedPostRunFails() throws Exception {
        mockMvc.perform(post("/api/runs/manual")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scopeType\":\"ALL_PROGRAMS\"}"))
                .andExpect(status().isForbidden());
    }

    // --- VIEWER (authenticated but no privileged role) ---

    @Test
    @WithMockUser(username = "viewer@workwell.dev", roles = "VIEWER")
    void viewerCanReadMeasures() throws Exception {
        mockMvc.perform(get("/api/measures"))
                .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(username = "viewer@workwell.dev", roles = "VIEWER")
    void viewerCannotPostCaseActions() throws Exception {
        UUID caseId = UUID.randomUUID();
        mockMvc.perform(post("/api/cases/{caseId}/actions", caseId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"OUTREACH\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "viewer@workwell.dev", roles = "VIEWER")
    void viewerCannotTriggerRun() throws Exception {
        mockMvc.perform(post("/api/runs/manual")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scopeType\":\"ALL_PROGRAMS\"}"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "viewer@workwell.dev", roles = "VIEWER")
    void viewerCannotAccessAdminEndpoints() throws Exception {
        mockMvc.perform(get("/api/admin/integrations"))
                .andExpect(status().isForbidden());
    }

    // --- AUTHOR ---

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorCanEditMeasureSpec() throws Exception {
        UUID measureId = UUID.randomUUID();
        mockMvc.perform(put("/api/measures/{id}/spec", measureId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"description\":\"test\",\"complianceWindow\":\"365 days\"}"))
                .andExpect(status().is(org.hamcrest.Matchers.not(403)));
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorCannotApprove() throws Exception {
        UUID measureId = UUID.randomUUID();
        mockMvc.perform(post("/api/measures/{id}/approve", measureId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorCannotActivate() throws Exception {
        UUID measureId = UUID.randomUUID();
        mockMvc.perform(post("/api/measures/{id}/activate", measureId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void authorCannotAccessAdminEndpoints() throws Exception {
        mockMvc.perform(get("/api/admin/integrations"))
                .andExpect(status().isForbidden());
    }

    // --- APPROVER ---

    @Test
    @WithMockUser(username = "approver@workwell.dev", roles = "APPROVER")
    void approverCannotAccessAdminEndpoints() throws Exception {
        mockMvc.perform(get("/api/admin/integrations"))
                .andExpect(status().isForbidden());
    }

    @Test
    @WithMockUser(username = "approver@workwell.dev", roles = "APPROVER")
    void approverCannotPostCaseActions() throws Exception {
        UUID caseId = UUID.randomUUID();
        mockMvc.perform(post("/api/cases/{caseId}/actions", caseId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"type\":\"OUTREACH\"}"))
                .andExpect(status().isForbidden());
    }

    // --- ADMIN ---

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void adminCanAccessAdminEndpoints() throws Exception {
        mockMvc.perform(get("/api/admin/integrations"))
                .andExpect(status().isOk());
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void adminCanReadMeasures() throws Exception {
        mockMvc.perform(get("/api/measures"))
                .andExpect(status().isOk());
    }

    // --- Internal eval endpoint ---

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void evalWithoutInternalHeaderReturnsNotFound() throws Exception {
        // With auth active, a request that passes security but lacks the internal header is rejected by the controller (404).
        mockMvc.perform(post("/api/eval")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"patientBundle\":{},\"cqlLibrary\":\"library X version '1.0'\"}"))
                .andExpect(status().isNotFound());
    }
}
