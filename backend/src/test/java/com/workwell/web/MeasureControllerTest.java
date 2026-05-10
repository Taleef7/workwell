package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.admin.DataReadinessService;
import com.workwell.measure.MeasureImpactPreviewService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.MeasureTraceabilityService;
import com.workwell.measure.ValueSetGovernanceService;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(MeasureController.class)
@AutoConfigureMockMvc(addFilters = false)
class MeasureControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private MeasureService measureService;

    @MockBean
    private MeasureTraceabilityService traceabilityService;

    @MockBean
    private MeasureImpactPreviewService impactPreviewService;

    @MockBean
    private DataReadinessService dataReadinessService;

    @MockBean
    private ValueSetGovernanceService valueSetGovernanceService;

    @Test
    void createsNewMeasureVersion() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID versionId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(measureService.createVersion(measureId, "Regulatory wording update")).thenReturn(versionId);

        mockMvc.perform(post("/api/measures/{id}/versions", measureId)
                        .contentType("application/json")
                        .content("{\"changeSummary\":\"Regulatory wording update\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("created"))
                .andExpect(jsonPath("$.versionId").value(versionId.toString()));
    }

    @Test
    void rejectsInvalidVersionCloneRequest() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");

        mockMvc.perform(post("/api/measures/{id}/versions", measureId)
                        .contentType("application/json")
                        .content("{\"changeSummary\":\"\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void traceabilityEndpointReturnsOk() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID versionId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(traceabilityService.generate(measureId)).thenReturn(
                new MeasureTraceabilityService.TraceabilityResponse(
                        measureId, versionId, "Test Measure", "v1.0",
                        List.of(), List.of()
                )
        );

        mockMvc.perform(get("/api/measures/{id}/traceability", measureId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.measureId").value(measureId.toString()))
                .andExpect(jsonPath("$.measureName").value("Test Measure"))
                .andExpect(jsonPath("$.version").value("v1.0"))
                .andExpect(jsonPath("$.rows").isArray())
                .andExpect(jsonPath("$.gaps").isArray());
    }

    @Test
    void impactPreviewEndpointReturnsOk() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID versionId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(impactPreviewService.preview(measureId, null)).thenReturn(
                new MeasureImpactPreviewService.ImpactPreviewResponse(
                        measureId, versionId, "2026-05-09",
                        10, java.util.Map.of("COMPLIANT", 7, "OVERDUE", 3),
                        new MeasureImpactPreviewService.CaseImpact(3, 0, 0, 0),
                        List.of(), List.of(), List.of()
                )
        );

        mockMvc.perform(post("/api/measures/{id}/impact-preview", measureId)
                        .contentType("application/json"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.measureId").value(measureId.toString()))
                .andExpect(jsonPath("$.populationEvaluated").value(10))
                .andExpect(jsonPath("$.caseImpact.wouldCreate").value(3));
    }

    @Test
    void dataReadinessEndpointReturnsOk() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        when(dataReadinessService.computeReadiness(measureId)).thenReturn(
                new DataReadinessService.DataReadinessResponse(
                        "READY",
                        List.of(new DataReadinessService.RequiredElementReadiness(
                                "procedure.audiogram", "Last audiogram date", "fhir", "MAPPED", "FRESH", 0.0, List.of()
                        )),
                        List.of(),
                        List.of()
                )
        );

        mockMvc.perform(get("/api/measures/{id}/data-readiness", measureId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.overallStatus").value("READY"))
                .andExpect(jsonPath("$.requiredElements[0].canonicalElement").value("procedure.audiogram"))
                .andExpect(jsonPath("$.requiredElements[0].mappingStatus").value("MAPPED"))
                .andExpect(jsonPath("$.blockers").isArray())
                .andExpect(jsonPath("$.warnings").isArray());
    }

    @Test
    void resolveCheckEndpointReturnsOk() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID versionId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(valueSetGovernanceService.resolveCheck(measureId)).thenReturn(
                new ValueSetGovernanceService.ResolveCheckResult(
                        measureId, versionId, true,
                        List.of(new ValueSetGovernanceService.ValueSetCheckItem(
                                UUID.fromString("a0000001-0000-0000-0000-000000000001"),
                                "Audiogram Procedure Codes",
                                "urn:workwell:vs:audiogram-procedure-codes",
                                "2025-demo", "RESOLVED", 4, List.of(), false
                        )),
                        List.of(), List.of()
                )
        );

        mockMvc.perform(post("/api/measures/{id}/value-sets/resolve-check", measureId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.allResolved").value(true))
                .andExpect(jsonPath("$.valueSets[0].name").value("Audiogram Procedure Codes"))
                .andExpect(jsonPath("$.valueSets[0].codeCount").value(4))
                .andExpect(jsonPath("$.blockers").isArray())
                .andExpect(jsonPath("$.warnings").isArray());
    }

    @Test
    void valueSetDiffEndpointReturnsOk() throws Exception {
        UUID fromId = UUID.fromString("a0000001-0000-0000-0000-000000000001");
        UUID toId   = UUID.fromString("a0000001-0000-0000-0000-000000000002");
        when(valueSetGovernanceService.diff(fromId, toId)).thenReturn(
                new ValueSetGovernanceService.ValueSetDiffResponse(
                        fromId.toString(), "Audiogram Procedure Codes", "2025-demo",
                        toId.toString(), "TB Screening Procedure Codes", "2025-demo",
                        List.of(new ValueSetGovernanceService.CodeEntry("LOCAL-TB-001", "PPD skin test", "urn:workwell:demo")),
                        List.of(new ValueSetGovernanceService.CodeEntry("LOCAL-AUD-001", "Baseline audiogram", "urn:workwell:demo")),
                        List.of(), List.of("1 code(s) added.", "1 code(s) removed.")
                )
        );

        mockMvc.perform(get("/api/value-sets/{id}/diff", fromId).param("to", toId.toString()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.fromName").value("Audiogram Procedure Codes"))
                .andExpect(jsonPath("$.toName").value("TB Screening Procedure Codes"))
                .andExpect(jsonPath("$.addedCodes[0].code").value("LOCAL-TB-001"))
                .andExpect(jsonPath("$.removedCodes[0].code").value("LOCAL-AUD-001"));
    }

    @Test
    void listsOshaReferences() throws Exception {
        UUID referenceId = UUID.fromString("33333333-3333-3333-3333-333333333333");
        when(measureService.listOshaReferences()).thenReturn(List.of(
                new MeasureService.OshaReference(referenceId, "29 CFR 1910.95", "Occupational Noise Exposure", "Hearing Conservation")
        ));

        mockMvc.perform(get("/api/osha-references"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].id").value(referenceId.toString()))
                .andExpect(jsonPath("$[0].cfrCitation").value("29 CFR 1910.95"))
                .andExpect(jsonPath("$[0].title").value("Occupational Noise Exposure"))
                .andExpect(jsonPath("$[0].programArea").value("Hearing Conservation"));
    }
}
