package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.caseflow.CaseFlowService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(CaseController.class)
@AutoConfigureMockMvc(addFilters = false)
class CaseControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private CaseFlowService caseFlowService;

    @Test
    void listsCases() throws Exception {
        UUID caseId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        when(caseFlowService.listCases("open", null, null, null, null)).thenReturn(List.of(
                new CaseFlowService.CaseSummary(
                        caseId,
                        "patient-003",
                        "patient-003",
                        "Plant A",
                        UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                        "AnnualAudiogramCompleted",
                        "1.0.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        null,
                        "OVERDUE",
                        UUID.fromString("22222222-2222-2222-2222-222222222222"),
                        Instant.parse("2026-05-04T12:00:00Z")
                )
        ));

        mockMvc.perform(get("/api/cases"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].caseId").value(caseId.toString()))
                .andExpect(jsonPath("$[0].site").value("Plant A"))
                .andExpect(jsonPath("$[0].priority").value("HIGH"))
                .andExpect(jsonPath("$[0].currentOutcomeStatus").value("OVERDUE"));
    }

    @Test
    void returnsCaseDetail() throws Exception {
        UUID caseId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        when(caseFlowService.loadCase(caseId)).thenReturn(java.util.Optional.of(
                new CaseFlowService.CaseDetail(
                        caseId,
                        "patient-003",
                        "patient-003",
                        "AnnualAudiogramCompleted",
                        "1.0.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        null,
                        "Escalate audiogram follow-up immediately.",
                        "OVERDUE",
                        UUID.fromString("22222222-2222-2222-2222-222222222222"),
                        Instant.parse("2026-05-04T12:00:00Z"),
                        Instant.parse("2026-05-04T12:05:00Z"),
                        null,
                        Map.of(
                                "expressionResults", List.of(
                                        Map.of("define", "In Hearing Conservation Program", "result", true),
                                        Map.of("define", "Has Active Waiver", "result", false),
                                        Map.of("define", "Days Since Last Audiogram", "result", 420)
                                ),
                                "evaluatedResource", Map.of(
                                        "patientId", "patient-003",
                                        "daysSinceLastAudiogram", 420,
                                        "hasActiveWaiver", false,
                                        "measurementWindowDays", 365
                                )
                        ),
                        "OVERDUE",
                        "Audiogram is outside annual compliance window.",
                        Instant.parse("2026-05-04T12:00:10Z"),
                        null,
                        List.of(
                                new CaseFlowService.AuditEvent(
                                        "CASE_CREATED",
                                        "system",
                                        Instant.parse("2026-05-04T12:05:00Z"),
                                        Map.of("status", "OVERDUE")
                                )
                        )
                )
        ));

        mockMvc.perform(get("/api/cases/{caseId}", caseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.caseId").value(caseId.toString()))
                .andExpect(jsonPath("$.outcomeStatus").value("OVERDUE"))
                .andExpect(jsonPath("$.evidenceJson.evaluatedResource.patientId").value("patient-003"))
                .andExpect(jsonPath("$.timeline[0].eventType").value("CASE_CREATED"));
    }

    @Test
    void sendsOutreachAction() throws Exception {
        UUID caseId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        when(caseFlowService.sendOutreach(caseId, "case-manager", null)).thenReturn(java.util.Optional.of(
                new CaseFlowService.CaseDetail(
                        caseId,
                        "patient-003",
                        "patient-003",
                        "AnnualAudiogramCompleted",
                        "1.0.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        null,
                        "Wait for employee follow-up, then rerun to verify closure.",
                        "OVERDUE",
                        UUID.fromString("22222222-2222-2222-2222-222222222222"),
                        Instant.parse("2026-05-04T12:00:00Z"),
                        Instant.parse("2026-05-04T12:15:00Z"),
                        null,
                        Map.of(),
                        "OVERDUE",
                        "Audiogram is outside annual compliance window.",
                        Instant.parse("2026-05-04T12:00:10Z"),
                        "QUEUED",
                        List.of(
                                new CaseFlowService.AuditEvent(
                                        "CASE_OUTREACH_SENT",
                                        "case-manager",
                                        Instant.parse("2026-05-04T12:15:00Z"),
                                        Map.of("channel", "SIMULATED_EMAIL")
                                )
                        )
                )
        ));

        mockMvc.perform(post("/api/cases/{caseId}/actions/outreach", caseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.caseId").value(caseId.toString()))
                .andExpect(jsonPath("$.nextAction").value("Wait for employee follow-up, then rerun to verify closure."));
    }

    @Test
    void previewsOutreach() throws Exception {
        UUID caseId = UUID.fromString("12121212-1212-1212-1212-121212121212");
        UUID templateId = UUID.fromString("11111111-0000-0000-0000-000000000001");
        when(caseFlowService.previewOutreach(caseId, templateId)).thenReturn(java.util.Optional.of(
                new CaseFlowService.OutreachPreview(
                        templateId,
                        "Audiogram Overdue Reminder",
                        "Action Needed: Overdue Audiogram Follow-up",
                        "Hello patient-003, please complete your audiogram by 2026-06-01.",
                        "patient-003",
                        "AnnualAudiogramCompleted",
                        "2026-06-01"
                )
        ));

        mockMvc.perform(get("/api/cases/{caseId}/actions/outreach/preview", caseId).param("templateId", templateId.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.templateName").value("Audiogram Overdue Reminder"))
                .andExpect(jsonPath("$.dueDate").value("2026-06-01"));
    }

    @Test
    void rerunsCaseToVerifyClosure() throws Exception {
        UUID caseId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        when(caseFlowService.rerunToVerify(caseId, "case-manager")).thenReturn(java.util.Optional.of(
                new CaseFlowService.CaseDetail(
                        caseId,
                        "patient-003",
                        "patient-003",
                        "AnnualAudiogramCompleted",
                        "1.0.0",
                        "2026-05-04",
                        "RESOLVED",
                        "LOW",
                        null,
                        "No follow-up needed after compliant verification rerun.",
                        "COMPLIANT",
                        UUID.fromString("33333333-3333-3333-3333-333333333333"),
                        Instant.parse("2026-05-04T12:00:00Z"),
                        Instant.parse("2026-05-04T12:18:00Z"),
                        Instant.parse("2026-05-04T12:18:00Z"),
                        Map.of(),
                        "COMPLIANT",
                        "Audiogram completed within compliant window.",
                        Instant.parse("2026-05-04T12:18:00Z"),
                        "SENT",
                        List.of(
                                new CaseFlowService.AuditEvent(
                                        "CASE_RESOLVED",
                                        "case-manager",
                                        Instant.parse("2026-05-04T12:18:00Z"),
                                        Map.of("status", "COMPLIANT")
                                )
                        )
                )
        ));

        mockMvc.perform(post("/api/cases/{caseId}/rerun-to-verify", caseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("RESOLVED"))
                .andExpect(jsonPath("$.currentOutcomeStatus").value("COMPLIANT"));
    }

    @Test
    void assignsCase() throws Exception {
        UUID caseId = UUID.fromString("aaaaaaaa-1111-1111-1111-111111111111");
        when(caseFlowService.assignCase(caseId, "supervisor-a", "case-manager")).thenReturn(java.util.Optional.of(
                new CaseFlowService.CaseDetail(
                        caseId,
                        "patient-003",
                        "patient-003",
                        "AnnualAudiogramCompleted",
                        "1.0.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        "supervisor-a",
                        "Escalate audiogram follow-up immediately.",
                        "OVERDUE",
                        UUID.fromString("22222222-2222-2222-2222-222222222222"),
                        Instant.parse("2026-05-04T12:00:00Z"),
                        Instant.parse("2026-05-04T12:20:00Z"),
                        null,
                        Map.of(),
                        "OVERDUE",
                        "Audiogram is outside annual compliance window.",
                        Instant.parse("2026-05-04T12:00:10Z"),
                        null,
                        List.of()
                )
        ));

        mockMvc.perform(post("/api/cases/{caseId}/assign", caseId).param("assignee", "supervisor-a"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.assignee").value("supervisor-a"));
    }

    @Test
    void escalatesCase() throws Exception {
        UUID caseId = UUID.fromString("bbbbbbbb-1111-1111-1111-111111111111");
        when(caseFlowService.escalateCase(caseId, "case-manager")).thenReturn(java.util.Optional.of(
                new CaseFlowService.CaseDetail(
                        caseId,
                        "patient-004",
                        "patient-004",
                        "TB Surveillance",
                        "1.3.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        "supervisor-b",
                        "Escalated to supervisor queue for immediate handling.",
                        "OVERDUE",
                        UUID.fromString("33333333-3333-3333-3333-333333333333"),
                        Instant.parse("2026-05-04T12:00:00Z"),
                        Instant.parse("2026-05-04T12:30:00Z"),
                        null,
                        Map.of(),
                        "OVERDUE",
                        "TB screening is outside annual compliance window.",
                        Instant.parse("2026-05-04T12:00:10Z"),
                        "FAILED",
                        List.of()
                )
        ));

        mockMvc.perform(post("/api/cases/{caseId}/escalate", caseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.nextAction").value("Escalated to supervisor queue for immediate handling."));
    }

    @Test
    void updatesOutreachDeliveryState() throws Exception {
        UUID caseId = UUID.fromString("cccccccc-1111-1111-1111-111111111111");
        when(caseFlowService.updateOutreachDelivery(caseId, "FAILED", "case-manager")).thenReturn(java.util.Optional.of(
                new CaseFlowService.CaseDetail(
                        caseId,
                        "patient-004",
                        "patient-004",
                        "TB Surveillance",
                        "1.3.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        "supervisor-b",
                        "Retry outreach delivery or escalate if contact path remains blocked.",
                        "OVERDUE",
                        UUID.fromString("33333333-3333-3333-3333-333333333333"),
                        Instant.parse("2026-05-04T12:00:00Z"),
                        Instant.parse("2026-05-04T12:40:00Z"),
                        null,
                        Map.of(),
                        "OVERDUE",
                        "TB screening is outside annual compliance window.",
                        Instant.parse("2026-05-04T12:00:10Z"),
                        "FAILED",
                        List.of()
                )
        ));

        mockMvc.perform(post("/api/cases/{caseId}/actions/outreach/delivery", caseId).param("deliveryStatus", "FAILED"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.latestOutreachDeliveryStatus").value("FAILED"));
    }

    @Test
    void rejectsOutreachDeliveryUpdateWhenServiceValidationFails() throws Exception {
        UUID caseId = UUID.fromString("cccccccc-1111-1111-1111-111111111111");
        when(caseFlowService.updateOutreachDelivery(caseId, "SENT", "case-manager"))
                .thenThrow(new IllegalArgumentException("Cannot update delivery state before outreach is sent"));

        mockMvc.perform(post("/api/cases/{caseId}/actions/outreach/delivery", caseId).param("deliveryStatus", "SENT"))
                .andExpect(status().isBadRequest())
                .andExpect(status().reason("Cannot update delivery state before outreach is sent"));
    }
}
