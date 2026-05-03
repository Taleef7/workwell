package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
        when(caseFlowService.listCases()).thenReturn(List.of(
                new CaseFlowService.CaseSummary(
                        caseId,
                        "patient-003",
                        "patient-003",
                        "AnnualAudiogramCompleted",
                        "1.0.0",
                        "2026-05-04",
                        "OPEN",
                        "HIGH",
                        "OVERDUE",
                        UUID.fromString("22222222-2222-2222-2222-222222222222"),
                        Instant.parse("2026-05-04T12:00:00Z")
                )
        ));

        mockMvc.perform(get("/api/cases"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].caseId").value(caseId.toString()))
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
}
