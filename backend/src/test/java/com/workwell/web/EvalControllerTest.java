package com.workwell.web;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.measure.AudiogramDemoService;
import com.workwell.measure.TBSurveillanceDemoService;
import com.workwell.run.RunPersistenceService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

import static org.mockito.Mockito.when;
import static java.util.Optional.of;

@WebMvcTest(EvalController.class)
@AutoConfigureMockMvc(addFilters = false)
class EvalControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private AudiogramDemoService audiogramDemoService;

    @MockBean
    private TBSurveillanceDemoService tbSurveillanceDemoService;

    @MockBean
    private RunPersistenceService runPersistenceService;

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

    @Test
    void runsSeededAudiogramVertical() throws Exception {
        when(audiogramDemoService.run()).thenReturn(
                new AudiogramDemoService.AudiogramDemoRun(
                        "run-123",
                        "Audiogram",
                        "v1.0",
                        "2026-05-04",
                        new AudiogramDemoService.RunSummary(1, 1, 1, 1, 1),
                        List.of(
                                new AudiogramDemoService.AudiogramOutcome(
                                        "patient-001",
                                        "COMPLIANT",
                                        "Audiogram completed within compliant window.",
                                        Map.of("expressionResults", List.of(), "evaluatedResource", Map.of())
                                )
                        )
                )
        );

        mockMvc.perform(post("/api/runs/audiogram").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isOk())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_JSON))
                .andExpect(jsonPath("$.runId").value("run-123"))
                .andExpect(jsonPath("$.measureName").value("Audiogram"))
                .andExpect(jsonPath("$.outcomes[0].patientId").value("patient-001"));
    }

    @Test
    void returnsLatestAudiogramRunFromPersistence() throws Exception {
        when(runPersistenceService.loadLatestAudiogramRun()).thenReturn(of(
                new AudiogramDemoService.AudiogramDemoRun(
                        "run-456",
                        "Audiogram",
                        "v1.0",
                        "2026-05-04",
                        new AudiogramDemoService.RunSummary(1, 1, 1, 1, 1),
                        List.of()
                )
        ));

        mockMvc.perform(org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get("/api/runs/audiogram/latest"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runId").value("run-456"))
                .andExpect(jsonPath("$.measureVersion").value("v1.0"));
    }
}
