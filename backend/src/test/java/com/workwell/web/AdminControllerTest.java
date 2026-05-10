package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.admin.DataReadinessService;
import com.workwell.admin.IntegrationHealthService;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.WaiverService;
import com.workwell.audit.AuditQueryService;
import com.workwell.admin.SchedulerAdminService;
import com.workwell.measure.ValueSetGovernanceService;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(AdminController.class)
@AutoConfigureMockMvc(addFilters = false)
@WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
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

    @MockBean
    private DataReadinessService dataReadinessService;

    @MockBean
    private ValueSetGovernanceService valueSetGovernanceService;

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
        when(integrationHealthService.triggerManualSync("mcp", "admin@workwell.dev")).thenReturn(
                new IntegrationHealthService.IntegrationHealth("mcp", "MCP", "healthy", Instant.parse("2026-05-05T10:05:00Z"), "sync complete", java.util.Map.of("sseUrl", "http://127.0.0.1:8080/sse"))
        );

        mockMvc.perform(post("/api/admin/integrations/mcp/sync").param("actor", "spoofed@workwell.dev"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.integration").value("mcp"))
                .andExpect(jsonPath("$.status").value("healthy"));

        verify(integrationHealthService).triggerManualSync("mcp", "admin@workwell.dev");
    }

    @Test
    void returnsBadRequestForUnsupportedIntegration() throws Exception {
        when(integrationHealthService.triggerManualSync("unknown", "admin@workwell.dev"))
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
                "admin@workwell.dev"
        )).thenReturn(new OutreachTemplateService.OutreachTemplate(
                UUID.fromString("11111111-0000-0000-0000-000000000004"),
                "General Compliance Reminder",
                "Compliance Follow-up Required",
                "Please complete follow-up.",
                "OUTREACH",
                "admin@workwell.dev",
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
    void listDataMappingsReturnsOk() throws Exception {
        UUID mappingId = UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        when(dataReadinessService.listMappings()).thenReturn(List.of(
                new DataReadinessService.DataElementMapping(
                        mappingId, "fhir", "FHIR Repository", "FHIR_R4",
                        "procedure.audiogram", "Procedure.performedDateTime",
                        "Procedure", "Procedure.where(code in audiogram-vs).performedDateTime",
                        null, "MAPPED", null, "Most recent audiogram date"
                )
        ));

        mockMvc.perform(get("/api/admin/data-mappings"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].canonicalElement").value("procedure.audiogram"))
                .andExpect(jsonPath("$[0].mappingStatus").value("MAPPED"))
                .andExpect(jsonPath("$[0].sourceId").value("fhir"));
    }

    @Test
    void validateDataMappingsReturnsUpdatedList() throws Exception {
        UUID mappingId = UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
        when(dataReadinessService.validateMappings()).thenReturn(List.of(
                new DataReadinessService.DataElementMapping(
                        mappingId, "hris", "HRIS", "INTERNAL",
                        "employee.role", "employee_role",
                        null, null, null, "MAPPED",
                        java.time.Instant.parse("2026-05-09T12:00:00Z"), null
                )
        ));

        mockMvc.perform(post("/api/admin/data-mappings/validate"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].canonicalElement").value("employee.role"))
                .andExpect(jsonPath("$[0].mappingStatus").value("MAPPED"))
                .andExpect(jsonPath("$[0].lastValidatedAt").isNotEmpty());
    }

    @Test
    void listTerminologyMappingsReturnsOk() throws Exception {
        UUID mappingId = UUID.fromString("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
        when(valueSetGovernanceService.listTerminologyMappings()).thenReturn(List.of(
                new ValueSetGovernanceService.TerminologyMapping(
                        mappingId,
                        "LOCAL-AUD-001", "Baseline audiogram", "urn:workwell:demo",
                        "92557", "Comprehensive audiometry evaluation", "http://www.ama-assn.org/go/cpt",
                        "APPROVED", 0.90, "occupational-health-team",
                        Instant.parse("2026-05-09T00:00:00Z"),
                        "Demo mapping"
                )
        ));

        mockMvc.perform(get("/api/admin/terminology-mappings"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].localCode").value("LOCAL-AUD-001"))
                .andExpect(jsonPath("$[0].standardCode").value("92557"))
                .andExpect(jsonPath("$[0].mappingStatus").value("APPROVED"));
    }

    @Test
    void rejectsInvalidWaiverDates() throws Exception {
        mockMvc.perform(get("/api/admin/waivers").param("expiresAfter", "not-a-date"))
                .andExpect(status().isBadRequest());
    }
}
