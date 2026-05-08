package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.mockito.Mockito.doThrow;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.run.AllProgramsRunService;
import com.workwell.run.RunPersistenceService;
import com.workwell.web.EvalController.ManualRunResponse;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(RunController.class)
@AutoConfigureMockMvc(addFilters = false)
class RunControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private RunPersistenceService runPersistenceService;

    @MockBean
    private AllProgramsRunService allProgramsRunService;

    @Test
    void listsRunsWithFilters() throws Exception {
        when(runPersistenceService.listRuns("completed", "all_programs", "manual", null, null, null, 20)).thenReturn(List.of(
                new RunPersistenceService.RunListItem(
                        "11111111-1111-1111-1111-111111111111",
                        "All Programs",
                        "completed",
                        "all_programs",
                        "manual",
                        Instant.parse("2026-05-04T00:00:00Z"),
                        Instant.parse("2026-05-04T00:01:00Z"),
                        60000L,
                        25L,
                        8L,
                        17L
                )
        ));

        mockMvc.perform(get("/api/runs")
                        .param("status", "completed")
                        .param("scopeType", "all_programs")
                        .param("triggerType", "manual")
                        .param("limit", "20"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].status").value("completed"))
                .andExpect(jsonPath("$[0].durationMs").value(60000));
    }

    @Test
    void returnsRunDetailById() throws Exception {
        UUID runId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(runPersistenceService.loadRunById(runId)).thenReturn(Optional.of(
                new RunPersistenceService.RunSummaryResponse(
                        runId.toString(),
                        "All Programs",
                        "",
                        "completed",
                        "manual",
                        "all_programs",
                        Instant.parse("2026-05-04T00:00:00Z"),
                        Instant.parse("2026-05-04T00:01:00Z"),
                        25L,
                        14L,
                        8L,
                        17L,
                        32.0d,
                        60000L,
                        List.of(Map.of("status", "OVERDUE", "count", 4L)),
                        Instant.parse("2026-05-04T00:00:59Z"),
                        15L
                )
        ));

        mockMvc.perform(get("/api/runs/{id}", runId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.runId").value(runId.toString()))
                .andExpect(jsonPath("$.passRate").value(32.0));
    }

    @Test
    void returnsRunLogs() throws Exception {
        UUID runId = UUID.fromString("33333333-3333-3333-3333-333333333333");
        when(runPersistenceService.loadRunLogs(runId, 50)).thenReturn(List.of(
                new RunPersistenceService.RunLogEntry(
                        Instant.parse("2026-05-04T00:00:10Z"),
                        "INFO",
                        "Manual all-programs run persisted with 25 outcomes across 2 measures."
                )
        ));

        mockMvc.perform(get("/api/runs/{id}/logs", runId).param("limit", "50"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].level").value("INFO"));
    }

    @Test
    void returnsRunOutcomes() throws Exception {
        UUID runId = UUID.fromString("44444444-4444-4444-4444-444444444444");
        when(runPersistenceService.loadRunOutcomes(runId)).thenReturn(List.of(
                new RunPersistenceService.RunOutcomeRow(
                        "Alex Rivera",
                        "emp-001",
                        "Maintenance Tech",
                        "Plant A",
                        "OVERDUE",
                        "420",
                        "NONE",
                        "55555555-5555-5555-5555-555555555555"
                )
        ));

        mockMvc.perform(get("/api/runs/{id}/outcomes", runId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].employeeExternalId").value("emp-001"))
                .andExpect(jsonPath("$[0].outcomeStatus").value("OVERDUE"));
    }

    @Test
    void rerunsSameScope() throws Exception {
        UUID runId = UUID.fromString("66666666-6666-6666-6666-666666666666");
        when(allProgramsRunService.rerunSameScope(runId, "system")).thenReturn(new ManualRunResponse(
                "77777777-7777-7777-7777-777777777777",
                "All Programs",
                4,
                List.of("Audiogram", "TB Surveillance", "HAZWOPER Surveillance", "Flu Vaccine")
        ));

        mockMvc.perform(post("/api/runs/{id}/rerun", runId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.activeMeasuresExecuted").value(4));
    }

    @Test
    void rerunReturnsBadRequestWhenScopeInvalid() throws Exception {
        UUID runId = UUID.fromString("88888888-8888-8888-8888-888888888888");
        doThrow(new IllegalArgumentException("Unsupported run scope type: custom"))
                .when(allProgramsRunService).rerunSameScope(runId, "system");

        mockMvc.perform(post("/api/runs/{id}/rerun", runId))
                .andExpect(status().isBadRequest());
    }
}
