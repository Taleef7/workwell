package com.workwell.web;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.measure.AudiogramDemoService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.TBSurveillanceDemoService;
import com.workwell.run.RunPersistenceService;
import java.util.List;
import java.util.Map;
import java.util.UUID;
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

    @MockBean
    private MeasureService measureService;

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

    @Test
    void runsAllProgramsScopeUsingActiveMeasureVersions() throws Exception {
        UUID runId = UUID.fromString("44444444-4444-4444-4444-444444444444");
        when(runPersistenceService.loadActiveMeasureScopes()).thenReturn(List.of(
                new com.workwell.run.DemoRunModels.ActiveMeasureScope(
                        UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                        "Audiogram",
                        UUID.fromString("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                        "Active"
                ),
                new com.workwell.run.DemoRunModels.ActiveMeasureScope(
                        UUID.fromString("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
                        "TB Surveillance",
                        UUID.fromString("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
                        "Active"
                )
        ));
        when(audiogramDemoService.buildPayload(
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any(java.time.LocalDate.class)
        )).thenReturn(new com.workwell.run.DemoRunModels.DemoRunPayload(
                "run-1",
                "Audiogram",
                "v1.0",
                "2026-05-04",
                List.of()
        ));
        when(tbSurveillanceDemoService.buildPayload(
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.any(java.time.LocalDate.class)
        )).thenReturn(new com.workwell.run.DemoRunModels.DemoRunPayload(
                "run-1",
                "TB Surveillance",
                "v1.3",
                "2026-05-04",
                List.of()
        ));
        when(runPersistenceService.persistAllProgramsRun(
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.eq("All Programs"),
                org.mockito.ArgumentMatchers.anyList()
        )).thenReturn(runId);

        mockMvc.perform(post("/api/runs/manual")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"All Programs\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runId").value(runId.toString()))
                .andExpect(jsonPath("$.scope").value("All Programs"))
                .andExpect(jsonPath("$.activeMeasuresExecuted").value(2));
    }
}
