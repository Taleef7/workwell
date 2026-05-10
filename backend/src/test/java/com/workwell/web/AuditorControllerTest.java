package com.workwell.web;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.audit.AuditPacketService;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(AuditorController.class)
@AutoConfigureMockMvc(addFilters = false)
class AuditorControllerTest {

    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private AuditPacketService auditPacketService;

    @Test
    @WithMockUser(roles = "CASE_MANAGER")
    void casePacketJsonReturnsOk() throws Exception {
        UUID caseId = UUID.fromString("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        when(auditPacketService.buildCasePacket(eq(caseId), any(), eq("json")))
                .thenReturn(new AuditPacketService.PacketResult(
                        "{\"packetType\":\"CASE\"}".getBytes(),
                        "application/json",
                        "workwell-case-packet-" + caseId + ".json"
                ));

        mockMvc.perform(get("/api/auditor/cases/{caseId}/packet", caseId).param("format", "json"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", "attachment; filename=\"workwell-case-packet-" + caseId + ".json\""));
    }

    @Test
    @WithMockUser(roles = "CASE_MANAGER")
    void casePacketHtmlReturnsOk() throws Exception {
        UUID caseId = UUID.fromString("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        when(auditPacketService.buildCasePacket(eq(caseId), any(), eq("html")))
                .thenReturn(new AuditPacketService.PacketResult(
                        "<html>test</html>".getBytes(),
                        "text/html",
                        "workwell-case-packet-" + caseId + ".html"
                ));

        mockMvc.perform(get("/api/auditor/cases/{caseId}/packet", caseId).param("format", "html"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", "attachment; filename=\"workwell-case-packet-" + caseId + ".html\""));
    }

    @Test
    @WithMockUser(roles = "CASE_MANAGER")
    void runPacketJsonReturnsOk() throws Exception {
        UUID runId = UUID.fromString("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        when(auditPacketService.buildRunPacket(eq(runId), any(), eq("json")))
                .thenReturn(new AuditPacketService.PacketResult(
                        "{\"packetType\":\"RUN\"}".getBytes(),
                        "application/json",
                        "workwell-run-packet-" + runId + ".json"
                ));

        mockMvc.perform(get("/api/auditor/runs/{runId}/packet", runId).param("format", "json"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", "attachment; filename=\"workwell-run-packet-" + runId + ".json\""));
    }

    @Test
    @WithMockUser(roles = "APPROVER")
    void measureVersionPacketJsonReturnsOk() throws Exception {
        UUID mvId = UUID.fromString("cccccccc-cccc-cccc-cccc-cccccccccccc");
        when(auditPacketService.buildMeasureVersionPacket(eq(mvId), any(), eq("json")))
                .thenReturn(new AuditPacketService.PacketResult(
                        "{\"packetType\":\"MEASURE_VERSION\"}".getBytes(),
                        "application/json",
                        "workwell-measure-version-packet-" + mvId + ".json"
                ));

        mockMvc.perform(get("/api/auditor/measure-versions/{mvId}/packet", mvId).param("format", "json"))
                .andExpect(status().isOk())
                .andExpect(header().string("Content-Disposition", "attachment; filename=\"workwell-measure-version-packet-" + mvId + ".json\""));
    }

    @Test
    @WithMockUser(roles = "CASE_MANAGER")
    void unsupportedFormatReturnsBadRequest() throws Exception {
        UUID caseId = UUID.fromString("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

        mockMvc.perform(get("/api/auditor/cases/{caseId}/packet", caseId).param("format", "pdf"))
                .andExpect(status().isBadRequest());
    }

    @Test
    @WithMockUser(roles = "CASE_MANAGER")
    void missingEntityReturnsNotFound() throws Exception {
        UUID caseId = UUID.fromString("dddddddd-dddd-dddd-dddd-dddddddddddd");
        when(auditPacketService.buildCasePacket(eq(caseId), any(), any()))
                .thenThrow(new IllegalArgumentException("Case not found: " + caseId));

        mockMvc.perform(get("/api/auditor/cases/{caseId}/packet", caseId).param("format", "json"))
                .andExpect(status().isNotFound());
    }
}
