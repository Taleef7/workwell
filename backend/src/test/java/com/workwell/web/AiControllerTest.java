package com.workwell.web;

import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.workwell.ai.AiAssistService;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.http.MediaType;
import org.springframework.security.test.context.support.WithMockUser;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(AiController.class)
@AutoConfigureMockMvc(addFilters = false)
class AiControllerTest {
    @Autowired
    private MockMvc mockMvc;

    @MockBean
    private AiAssistService aiAssistService;

    @Test
    @WithMockUser(username = "author@workwell.dev", roles = "AUTHOR")
    void draftsSpec() throws Exception {
        when(aiAssistService.draftSpec("policy text", "Audiogram", "author@workwell.dev", null)).thenReturn(
                new AiAssistService.DraftSpecResponse(
                        true,
                        "Audiogram",
                        Map.of("description", "Draft"),
                        "advisory",
                        "fallback-rules",
                        true,
                        null
                )
        );

        mockMvc.perform(post("/api/ai/draft-spec")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"measureName\":\"Audiogram\",\"policyText\":\"policy text\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.measureName").value("Audiogram"))
                .andExpect(jsonPath("$.provider").value("fallback-rules"));
    }

    @Test
    @WithMockUser(username = "cm@workwell.dev", roles = "CASE_MANAGER")
    void explainsCase() throws Exception {
        UUID caseId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        when(aiAssistService.explainCase(caseId, "cm@workwell.dev")).thenReturn(
                new AiAssistService.CaseExplanationResponse(
                        caseId.toString(),
                        "Explanation",
                        "fallback-rules",
                        true,
                        "advisory"
                )
        );

        mockMvc.perform(post("/api/cases/{caseId}/explain", caseId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.caseId").value(caseId.toString()))
                .andExpect(jsonPath("$.explanation").value("Explanation"));
    }

    @Test
    @WithMockUser(username = "admin@workwell.dev", roles = "ADMIN")
    void runInsight() throws Exception {
        UUID runId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        when(aiAssistService.runInsight(runId, "admin@workwell.dev")).thenReturn(
                new AiAssistService.RunInsightResponse(false, java.util.List.of("Insight A", "Insight B"))
        );

        mockMvc.perform(post("/api/runs/{runId}/ai/insight", runId))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.fallback").value(false))
                .andExpect(jsonPath("$.insights[0]").value("Insight A"));
    }
}
