package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.program.ProgramService;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(ProgramController.class)
@AutoConfigureMockMvc(addFilters = false)
class ProgramControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private ProgramService programService;

    @Test
    void listsPrograms() throws Exception {
        UUID measureId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID runId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(programService.listPrograms()).thenReturn(List.of(
                new ProgramService.ProgramSummary(
                        measureId,
                        "Audiogram",
                        "OSHA 29 CFR 1910.95",
                        "v1.0",
                        runId,
                        Instant.parse("2026-05-07T00:00:00Z"),
                        15,
                        3,
                        3,
                        3,
                        3,
                        3,
                        20.0,
                        9
                )
        ));

        mockMvc.perform(get("/api/programs"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].measureId").value(measureId.toString()))
                .andExpect(jsonPath("$[0].measureName").value("Audiogram"))
                .andExpect(jsonPath("$[0].overdue").value(3));
    }

    @Test
    void returnsTrend() throws Exception {
        UUID measureId = UUID.fromString("33333333-3333-3333-3333-333333333333");
        UUID runIdA = UUID.fromString("44444444-4444-4444-4444-444444444444");
        UUID runIdB = UUID.fromString("55555555-5555-5555-5555-555555555555");
        when(programService.trend(measureId)).thenReturn(List.of(
                new ProgramService.ProgramTrendPoint(runIdA, Instant.parse("2026-05-07T00:00:00Z"), 55.0, 100),
                new ProgramService.ProgramTrendPoint(runIdB, Instant.parse("2026-04-07T00:00:00Z"), 50.0, 100)
        ));

        mockMvc.perform(get("/api/programs/{measureId}/trend", measureId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].runId").value(runIdA.toString()))
                .andExpect(jsonPath("$[0].complianceRate").value(55.0))
                .andExpect(jsonPath("$[1].runId").value(runIdB.toString()));
    }

    @Test
    void returnsTopDrivers() throws Exception {
        UUID measureId = UUID.fromString("66666666-6666-6666-6666-666666666666");
        when(programService.topDrivers(measureId)).thenReturn(
                new ProgramService.TopDrivers(
                        List.of(new ProgramService.DriverSite("Plant A", 7, "High overdue concentration")),
                        List.of(new ProgramService.DriverRole("Maintenance Tech", 5)),
                        List.of(new ProgramService.DriverOutcomeReason("OVERDUE", 9, 60.0))
                )
        );

        mockMvc.perform(get("/api/programs/{measureId}/top-drivers", measureId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.bySite[0].site").value("Plant A"))
                .andExpect(jsonPath("$.byRole[0].role").value("Maintenance Tech"))
                .andExpect(jsonPath("$.byOutcomeReason[0].reason").value("OVERDUE"));
    }
}

