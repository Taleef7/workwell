package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.export.CsvExportService;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(ExportController.class)
@AutoConfigureMockMvc(addFilters = false)
class ExportControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private CsvExportService csvExportService;

    @Test
    void exportsRunSummaryCsv() throws Exception {
        when(csvExportService.exportRunSummaryCsv("completed", "all_programs", "manual", 20)).thenReturn("\"runId\"\n\"1\"\n");

        mockMvc.perform(get("/api/exports/runs")
                        .param("status", "completed")
                        .param("scopeType", "all_programs")
                        .param("triggerType", "manual")
                        .param("limit", "20"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"runs-export.csv\""))
                .andExpect(content().contentTypeCompatibleWith(MediaType.parseMediaType("text/csv")))
                .andExpect(content().string("\"runId\"\n\"1\"\n"));
    }

    @Test
    void exportsOutcomeCsv() throws Exception {
        UUID runId = UUID.fromString("55555555-5555-5555-5555-555555555555");
        when(csvExportService.exportOutcomeCsv(runId)).thenReturn("\"runId\"\n\"555\"\n");

        mockMvc.perform(get("/api/exports/outcomes").param("runId", runId.toString()))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"outcomes.csv\""))
                .andExpect(content().string("\"runId\"\n\"555\"\n"));
    }

    @Test
    void exportsCasesCsv() throws Exception {
        when(csvExportService.exportCaseCsv(null, null, null, null, null, java.util.List.of())).thenReturn("\"caseId\"\n\"abc\"\n");

        mockMvc.perform(get("/api/exports/cases"))
                .andExpect(status().isOk())
                .andExpect(header().string(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"cases.csv\""))
                .andExpect(content().string("\"caseId\"\n\"abc\"\n"));
    }
}
