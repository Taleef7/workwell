package com.workwell.web;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(EvalController.class)
@AutoConfigureMockMvc(addFilters = false)
class EvalControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void returnsStubEvaluationPayload() throws Exception {
        String payload = """
                {
                  "patientBundle": { "id": "patient-001" },
                  "cqlLibrary": "library Stub version '1.0.0'"
                }
                """;

        mockMvc.perform(post("/api/eval")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.outcome").value("COMPLIANT"))
                .andExpect(jsonPath("$.evaluatedResource.patientBundleId").value("patient-001"))
                .andExpect(jsonPath("$.expressionResults[0].define").value("S0-Stub-Define"));
    }
}
