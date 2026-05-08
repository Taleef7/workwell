package com.workwell.ai;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.RETURNS_DEEP_STUBS;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;

class AiServiceIntegrationTest {
    @Test
    void draftSpecReturnsAiPayloadAndWritesAudit() {
        CaseFlowService caseFlowService = mock(CaseFlowService.class);
        RunPersistenceService runPersistenceService = mock(RunPersistenceService.class);
        JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
        ChatClient chatClient = mock(ChatClient.class, RETURNS_DEEP_STUBS);
        ChatClient.Builder builder = mock(ChatClient.Builder.class);
        ObjectProvider<ChatClient.Builder> provider = mock(ObjectProvider.class);

        when(provider.getIfAvailable()).thenReturn(builder);
        when(builder.build()).thenReturn(chatClient);
        when(chatClient.prompt().options(any()).system(anyString()).user(anyString()).call().content())
                .thenReturn("""
                        {
                          "description":"draft",
                          "eligibilityCriteria":{"roleFilter":"Nurse","siteFilter":"Clinic","programEnrollmentText":"Program"},
                          "exclusions":[{"label":"Exemption","criteriaText":"criteria"}],
                          "complianceWindow":"Annual",
                          "requiredDataElements":["Last exam date"]
                        }
                        """);

        AiAssistService service = new AiAssistService(
                caseFlowService,
                runPersistenceService,
                jdbcTemplate,
                new ObjectMapper(),
                provider,
                "gpt-5.4-nano",
                "gpt-4o-mini"
        );

        AiAssistService.DraftSpecResponse response =
                service.draftSpec("policy text", "Audiogram", "measure-author", null);

        assertThat(response.success()).isTrue();
        assertThat(response.provider()).isEqualTo("openai");
        assertThat(response.suggestion()).containsKey("description");
        verify(jdbcTemplate, atLeastOnce()).update(anyString(), any(), any(), any(), any(), any(), any(), any());
    }

    @Test
    void explainCaseFallsBackAndWritesAuditWhenAiUnavailable() {
        CaseFlowService caseFlowService = mock(CaseFlowService.class);
        RunPersistenceService runPersistenceService = mock(RunPersistenceService.class);
        JdbcTemplate jdbcTemplate = mock(JdbcTemplate.class);
        ObjectProvider<ChatClient.Builder> provider = mock(ObjectProvider.class);
        when(provider.getIfAvailable()).thenReturn(null);

        UUID caseId = UUID.fromString("11111111-1111-1111-1111-111111111111");
        UUID runId = UUID.fromString("22222222-2222-2222-2222-222222222222");
        CaseFlowService.CaseDetail detail = new CaseFlowService.CaseDetail(
                caseId,
                "emp-001",
                "Aisha Khan",
                "Audiogram",
                UUID.fromString("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
                "v1.0",
                "2026-05-01",
                "OPEN",
                "HIGH",
                "unassigned",
                "Follow up",
                "OVERDUE",
                runId,
                Instant.now().minusSeconds(120),
                Instant.now().minusSeconds(60),
                null,
                null,
                null,
                null,
                null,
                false,
                Map.of(
                        "why_flagged", Map.of(
                                "last_exam_date", "2025-03-01",
                                "days_overdue", 420,
                                "compliance_window_days", 365,
                                "waiver_status", "none"
                        ),
                        "expressionResults", List.of(Map.of("define", "Overdue", "result", true))
                ),
                "OVERDUE",
                "summary",
                Instant.now().minusSeconds(60),
                null,
                List.of()
        );
        when(caseFlowService.loadCase(caseId)).thenReturn(Optional.of(detail));

        AiAssistService service = new AiAssistService(
                caseFlowService,
                runPersistenceService,
                jdbcTemplate,
                new ObjectMapper(),
                provider,
                "gpt-5.4-nano",
                "gpt-4o-mini"
        );

        AiAssistService.CaseExplanationResponse response = service.explainCase(caseId, "case-manager");

        assertThat(response.fallbackUsed()).isTrue();
        assertThat(response.provider()).isEqualTo("fallback-rules");
        assertThat(response.explanation()).contains("OVERDUE");
        verify(jdbcTemplate, atLeastOnce()).update(anyString(), any(), any(), any(), any(), any(), any(), any());
    }
}
