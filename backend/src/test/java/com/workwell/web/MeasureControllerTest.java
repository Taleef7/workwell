package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.measure.MeasureService;
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
