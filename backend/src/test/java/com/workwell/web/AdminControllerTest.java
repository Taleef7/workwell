package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.admin.IntegrationHealthService;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(AdminController.class)
@AutoConfigureMockMvc(addFilters = false)
class AdminControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private IntegrationHealthService integrationHealthService;

    @Test
    void listsIntegrationHealth() throws Exception {
        when(integrationHealthService.listHealth()).thenReturn(List.of(
                new IntegrationHealthService.IntegrationHealth("fhir", "healthy", Instant.parse("2026-05-05T10:00:00Z"), "ok")
        ));

        mockMvc.perform(get("/api/admin/integrations"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].integration").value("fhir"))
                .andExpect(jsonPath("$[0].status").value("healthy"));
    }

    @Test
    void triggersIntegrationSync() throws Exception {
        when(integrationHealthService.triggerManualSync("mcp", "admin-user")).thenReturn(
                new IntegrationHealthService.IntegrationHealth("mcp", "healthy", Instant.parse("2026-05-05T10:05:00Z"), "sync complete")
        );

        mockMvc.perform(post("/api/admin/integrations/mcp/sync"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.integration").value("mcp"))
                .andExpect(jsonPath("$.status").value("healthy"));
    }

    @Test
    void returnsBadRequestForUnsupportedIntegration() throws Exception {
        when(integrationHealthService.triggerManualSync("unknown", "admin-user"))
                .thenThrow(new IllegalArgumentException("Unsupported integration: unknown"));

        mockMvc.perform(post("/api/admin/integrations/unknown/sync"))
                .andExpect(status().isBadRequest());
    }
}
