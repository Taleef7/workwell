package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.admin.IntegrationHealthService;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.SchedulerAdminService;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
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

    @MockBean
    private SchedulerAdminService schedulerAdminService;

    @MockBean
    private OutreachTemplateService outreachTemplateService;

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

    @Test
    void returnsSchedulerStatus() throws Exception {
        when(schedulerAdminService.status()).thenReturn(new SchedulerAdminService.SchedulerStatus(
                true,
                "0 0 6 * * *",
                Instant.parse("2026-05-07T10:00:00Z"),
                Instant.parse("2026-05-06T10:00:00Z"),
                "completed"
        ));

        mockMvc.perform(get("/api/admin/scheduler"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(true))
                .andExpect(jsonPath("$.cron").value("0 0 6 * * *"));
    }

    @Test
    void updatesSchedulerEnabledFlag() throws Exception {
        when(schedulerAdminService.updateEnabled(false)).thenReturn(new SchedulerAdminService.SchedulerStatus(
                false,
                "0 0 6 * * *",
                Instant.parse("2026-05-07T10:00:00Z"),
                null,
                "never"
        ));

        mockMvc.perform(post("/api/admin/scheduler").param("enabled", "false"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.enabled").value(false));
    }

    @Test
    void listsOutreachTemplates() throws Exception {
        when(outreachTemplateService.listTemplates()).thenReturn(List.of(
                new OutreachTemplateService.OutreachTemplate(
                        UUID.fromString("11111111-0000-0000-0000-000000000001"),
                        "Audiogram Overdue Reminder",
                        "Action Needed",
                        "Please schedule",
                        null,
                        Instant.parse("2026-05-06T01:00:00Z")
                )
        ));

        mockMvc.perform(get("/api/admin/outreach-templates"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").value("Audiogram Overdue Reminder"));
    }
}
