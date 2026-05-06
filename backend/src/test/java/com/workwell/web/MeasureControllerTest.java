package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.measure.MeasureService;
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
}
