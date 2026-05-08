package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.admin.IntegrationHealthService;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.WaiverService;
import com.workwell.audit.AuditQueryService;
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

    @MockBean
    private WaiverService waiverService;

    @MockBean
    private AuditQueryService auditQueryService;

    @Test
    void listsIntegrationHealth() throws Exception {
        when(integrationHealthService.listHealth()).thenReturn(List.of(
                new IntegrationHealthService.IntegrationHealth("fhir", "FHIR", "healthy", Instant.parse("2026-05-05T10:00:00Z"), "ok", java.util.Map.of())
        ));

        mockMvc.perform(get("/api/admin/integrations"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].integration").value("fhir"))
                .andExpect(jsonPath("$[0].displayName").value("FHIR"))
                .andExpect(jsonPath("$[0].status").value("healthy"));
    }

    @Test
    void triggersIntegrationSync() throws Exception {
        when(integrationHealthService.triggerManualSync("mcp", "admin-user")).thenReturn(
                new IntegrationHealthService.IntegrationHealth("mcp", "MCP", "healthy", Instant.parse("2026-05-05T10:05:00Z"), "sync complete", java.util.Map.of("sseUrl", "http://127.0.0.1:8080/sse"))
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
                        "OUTREACH",
                        "admin@workwell.dev",
                        Instant.parse("2026-05-06T01:00:00Z"),
                        Instant.parse("2026-05-06T01:00:00Z"),
                        true
                )
        ));

        mockMvc.perform(get("/api/admin/outreach-templates"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].name").value("Audiogram Overdue Reminder"));
    }

    @Test
    void listsWaivers() throws Exception {
        when(waiverService.listWaivers(null, null, null, null, null)).thenReturn(List.of(
                new WaiverService.WaiverRecord(
                        UUID.fromString("11111111-0000-0000-0000-000000000011"),
                        "patient-003",
                        "Patient Three",
                        "Plant A",
                        UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                        "Audiogram",
                        UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                        "1.0.0",
                        "Active waiver on file.",
                        "admin-user",
                        Instant.parse("2026-05-06T01:00:00Z"),
                        Instant.parse("2026-06-06T01:00:00Z"),
                        "Demo waiver",
                        true,
                        false
                )
        ));

        mockMvc.perform(get("/api/admin/waivers"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].employeeExternalId").value("patient-003"))
                .andExpect(jsonPath("$[0].measureName").value("Audiogram"));
    }

    @Test
    void listsAuditEvents() throws Exception {
        when(auditQueryService.listEvents("access", 100)).thenReturn(List.of(
                new AuditQueryService.AuditEventRow(
                        Instant.parse("2026-05-08T12:00:00Z"),
                        "CASE_VIEWED",
                        "access",
                        UUID.fromString("11111111-1111-1111-1111-111111111111"),
                        null,
                        "Audiogram",
                        "patient-003",
                        "case-manager",
                        "{\"caseId\":\"11111111-1111-1111-1111-111111111111\"}"
                )
        ));

        mockMvc.perform(get("/api/admin/audit-events").param("scope", "access"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].eventType").value("CASE_VIEWED"))
                .andExpect(jsonPath("$[0].scope").value("access"));
    }

    @Test
    void createsOutreachTemplate() throws Exception {
        when(outreachTemplateService.createTemplate(
                "General Compliance Reminder",
                "Compliance Follow-up Required",
                "Please complete follow-up.",
                "OUTREACH",
                "admin-user"
        )).thenReturn(new OutreachTemplateService.OutreachTemplate(
                UUID.fromString("11111111-0000-0000-0000-000000000004"),
                "General Compliance Reminder",
                "Compliance Follow-up Required",
                "Please complete follow-up.",
                "OUTREACH",
                "admin-user",
                Instant.parse("2026-05-08T01:00:00Z"),
                Instant.parse("2026-05-08T01:00:00Z"),
                true
        ));

        mockMvc.perform(post("/api/admin/outreach-templates")
                        .contentType("application/json")
                        .content("""
                                {
                                  "name":"General Compliance Reminder",
                                  "subject":"Compliance Follow-up Required",
                                  "bodyText":"Please complete follow-up.",
                                  "type":"OUTREACH"
                                }
                                """))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("General Compliance Reminder"))
                .andExpect(jsonPath("$.type").value("OUTREACH"));
    }

    @Test
    void rejectsInvalidWaiverDates() throws Exception {
        mockMvc.perform(get("/api/admin/waivers").param("expiresAfter", "not-a-date"))
                .andExpect(status().isBadRequest());
    }
}
