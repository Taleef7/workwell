package com.workwell.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.concurrent.ConcurrentHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AiAssistService {
    private final CaseFlowService caseFlowService;
    private final RunPersistenceService runPersistenceService;
    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;
    private final ChatClient chatClient;
    private final String modelName;
    private final String fallbackModelName;
    private final ConcurrentHashMap<CaseExplanationCacheKey, CachedCaseExplanation> caseExplanationCache = new ConcurrentHashMap<>();

    public AiAssistService(
            CaseFlowService caseFlowService,
            RunPersistenceService runPersistenceService,
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper,
            ObjectProvider<ChatClient.Builder> chatClientBuilderProvider,
            @Value("${spring.ai.openai.chat.options.model:gpt-5.4-nano}") String modelName,
            @Value("${workwell.ai.openai.fallback-model:gpt-4o-mini}") String fallbackModelName
    ) {
        this.caseFlowService = caseFlowService;
        this.runPersistenceService = runPersistenceService;
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
        ChatClient.Builder chatClientBuilder = chatClientBuilderProvider.getIfAvailable();
        this.chatClient = chatClientBuilder == null ? null : chatClientBuilder.build();
        this.modelName = modelName;
        this.fallbackModelName = fallbackModelName;
    }

    public DraftSpecResponse draftSpec(String policyText, String measureName, String actor, UUID measureId) {
        String text = policyText == null ? "" : policyText.trim();
        if (text.isBlank()) {
            throw new IllegalArgumentException("policyText is required");
        }
        String resolvedMeasure = (measureName == null || measureName.isBlank()) ? "New Measure" : measureName.trim();
        DraftSpecResponse response;
        int promptLength = text.length();
        try {
            String modelResponse = callWithModelFallback(
                    """
                            You are a compliance measure assistant.
                            Return ONLY a valid JSON object matching:
                            {
                              "description": string,
                              "eligibilityCriteria": {
                                "roleFilter": string,
                                "siteFilter": string,
                                "programEnrollmentText": string
                              },
                              "exclusions": [{"label": string, "criteriaText": string}],
                              "complianceWindow": string,
                              "requiredDataElements": [string]
                            }
                            You must NOT make any compliance determination about specific employees.
                            Output is a draft for human review only.
                            """,
                    "Measure: " + resolvedMeasure + "\nPolicy text:\n" + text
            );

            Map<String, Object> suggestion = parseSuggestionJson(modelResponse);
            if (suggestion.isEmpty()) {
                throw new IllegalStateException("Model response did not include valid JSON spec fields.");
            }
            response = new DraftSpecResponse(
                    true,
                    resolvedMeasure,
                    suggestion,
                    "AI-generated draft - review and edit before saving.",
                    "openai",
                    false,
                    null
            );
        } catch (Exception ex) {
            response = new DraftSpecResponse(
                    false,
                    resolvedMeasure,
                    Map.of(),
                    "AI temporarily unavailable. Please fill the spec manually.",
                    "fallback-rules",
                    true,
                    "AI temporarily unavailable. Please fill the spec manually."
            );
        }
        insertAiAudit("AI_DRAFT_SPEC_GENERATED", actor, null, null, Map.of(
                "measureName", resolvedMeasure,
                "measureId", measureId == null ? "" : measureId.toString(),
                "promptLength", promptLength,
                "outputLength", response.suggestion().toString().length(),
                "model", modelName,
                "tokensUsed", -1,
                "provider", response.provider(),
                "fallbackUsed", response.fallbackUsed()
        ));
        return response;
    }

    public CaseExplanationResponse explainCase(UUID caseId, String actor) {
        CaseFlowService.CaseDetail detail = caseFlowService.loadCase(caseId)
                .orElseThrow(() -> new IllegalArgumentException("Case not found"));
        CaseExplanationCacheKey cacheKey = new CaseExplanationCacheKey(caseId, detail.measureVersion());
        CachedCaseExplanation cached = caseExplanationCache.get(cacheKey);
        if (cached != null && cached.updatedAt().equals(detail.updatedAt())) {
            return cached.response();
        }
        String explanation;
        String provider;
        boolean fallbackUsed;
        try {
            String modelResponse = callWithModelFallback(
                    "You are a clinical quality measure analyst. Based only on provided structured evidence, explain in 2-3 plain English sentences why the employee was flagged. Do not add information not present. Do not make compliance recommendations.",
                    "Outcome status: " + detail.currentOutcomeStatus() + "\nEvidence JSON:\n" + toJson(detail.evidenceJson())
            );
            explanation = modelResponse == null ? "" : modelResponse.trim();
            if (explanation.isBlank()) {
                throw new IllegalStateException("Empty model response");
            }
            provider = "openai";
            fallbackUsed = false;
        } catch (Exception ex) {
            explanation = buildDeterministicFallbackExplanation(detail);
            provider = "fallback-rules";
            fallbackUsed = true;
        }
        insertAiAudit("AI_CASE_EXPLANATION_GENERATED", actor, detail.lastRunId(), caseId, Map.of(
                "measureName", detail.measureName(),
                "outcomeStatus", detail.currentOutcomeStatus(),
                "provider", provider,
                "fallbackUsed", fallbackUsed
        ));
        CaseExplanationResponse response = new CaseExplanationResponse(
                caseId.toString(),
                explanation,
                provider,
                fallbackUsed,
                "AI explanation is advisory text only. Compliance decisions come from structured CQL evidence."
        );
        caseExplanationCache.put(cacheKey, new CachedCaseExplanation(detail.updatedAt(), response));
        return response;
    }

    public RunInsightResponse runInsight(UUID runId, String actor) {
        RunPersistenceService.RunSummaryResponse run = runPersistenceService.loadRunById(runId)
                .orElseThrow(() -> new IllegalArgumentException("Run not found"));
        try {
            String prompt = "Run summary:\n"
                    + "measure=" + run.measureName() + "\n"
                    + "version=" + run.measureVersion() + "\n"
                    + "status=" + run.status() + "\n"
                    + "evaluated=" + run.totalEvaluated() + "\n"
                    + "compliant=" + run.compliantCount() + "\n"
                    + "nonCompliant=" + run.nonCompliantCount() + "\n"
                    + "passRate=" + run.passRate() + "\n"
                    + "outcomeCounts=" + run.outcomeCounts();
            String content = callWithModelFallback(
                    "You are an operations analyst. Return exactly 3 to 5 concise bullet points. Verify before acting. No markdown headings.",
                    prompt
            );
            List<String> bullets = parseBullets(content);
            insertAiAudit("AI_RUN_INSIGHT_GENERATED", actor, runId, null, Map.of(
                    "runId", runId.toString(),
                    "measureName", run.measureName(),
                    "model", modelName,
                    "fallbackUsed", false,
                    "bulletCount", bullets.size()
            ));
            return new RunInsightResponse(false, bullets);
        } catch (Exception ex) {
            insertAiAudit("AI_RUN_INSIGHT_GENERATED", actor, runId, null, Map.of(
                    "runId", runId.toString(),
                    "measureName", run.measureName(),
                    "model", modelName,
                    "fallbackUsed", true,
                    "bulletCount", 0
            ));
            return new RunInsightResponse(true, List.of());
        }
    }

    private Map<String, Object> buildSuggestion(String policyText, String measureName) {
        String lowered = policyText.toLowerCase();
        String window = lowered.contains("annual") || lowered.contains("12 month") ? "Annual"
                : lowered.contains("season") ? "Seasonal"
                : "Defined by policy";
        String roleFilter = lowered.contains("nurse") ? "Nurse, Clinic Staff"
                : lowered.contains("industrial") || lowered.contains("hazwoper") ? "Industrial Hygienist, Maintenance Tech"
                : "All";
        String siteFilter = lowered.contains("clinic") ? "Clinic" : "Plant A, Plant B, Clinic";
        String exclusionLabel = lowered.contains("waiver") || lowered.contains("exempt") ? "Medical Exemption" : "Documented Exception";
        String program = measureName + " Program";

        Map<String, Object> suggestion = new LinkedHashMap<>();
        suggestion.put("description", "Drafted from policy text: " + compact(policyText, 180));
        suggestion.put("eligibilityCriteria", Map.of(
                "roleFilter", roleFilter,
                "siteFilter", siteFilter,
                "programEnrollmentText", program
        ));
        suggestion.put("exclusions", List.of(Map.of(
                "label", exclusionLabel,
                "criteriaText", "Valid documented exemption during the compliance window"
        )));
        suggestion.put("complianceWindow", window);
        suggestion.put("requiredDataElements", List.of(
                "Most recent qualifying exam or vaccine date",
                "Employee role and site",
                "Program enrollment evidence",
                "Exemption status"
        ));
        return suggestion;
    }

    private String buildDeterministicFallbackExplanation(CaseFlowService.CaseDetail detail) {
        Map<String, Object> whyFlagged = detail.evidenceJson() == null
                ? Map.of()
                : safeMap(detail.evidenceJson().get("why_flagged"));
        List<Map<String, Object>> expressionResults = detail.evidenceJson() == null
                ? List.of()
                : readExpressionResults(detail.evidenceJson().get("expressionResults"));
        String lastExamDate = valueAsString(whyFlagged.get("last_exam_date"), "unknown");
        String daysOverdue = valueAsString(whyFlagged.get("days_overdue"), "unknown");
        String window = valueAsString(whyFlagged.get("compliance_window_days"), "unknown");
        String waiver = valueAsString(whyFlagged.get("waiver_status"), "unknown");
        String defineSnippet = expressionResults.stream()
                .limit(3)
                .map(row -> valueAsString(row.get("define"), "define") + "=" + valueAsString(row.get("result"), "unknown"))
                .reduce((a, b) -> a + ", " + b)
                .orElse("no define-level results available");

        return detail.employeeName() + " was flagged as " + detail.currentOutcomeStatus()
                + " for " + detail.measureName() + " based on structured evaluation evidence. "
                + "The last recorded exam/vaccine date is " + lastExamDate + " with a " + window
                + "-day window, days overdue " + daysOverdue + ", and waiver status " + waiver + ". "
                + "Observed define results include " + defineSnippet + ".";
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> safeMap(Object value) {
        if (value instanceof Map<?, ?> map) {
            return (Map<String, Object>) map;
        }
        return Map.of();
    }

    private String compact(String text, int maxLen) {
        String trimmed = text.replaceAll("\\s+", " ").trim();
        if (trimmed.length() <= maxLen) return trimmed;
        return trimmed.substring(0, maxLen - 3) + "...";
    }

    private String callWithModelFallback(String systemPrompt, String userPrompt) {
        if (chatClient == null) {
            throw new IllegalStateException("OpenAI ChatClient is not configured.");
        }
        Exception primaryError = null;
        try {
            return chatClient.prompt()
                    .options(OpenAiChatOptions.builder().model(modelName).temperature(0.3).maxTokens(1000).build())
                    .system(systemPrompt)
                    .user(userPrompt)
                    .call()
                    .content();
        } catch (Exception ex) {
            primaryError = ex;
        }

        if (fallbackModelName == null || fallbackModelName.isBlank() || fallbackModelName.equalsIgnoreCase(modelName)) {
            throw new IllegalStateException("Primary model call failed and no fallback model configured.", primaryError);
        }

        try {
            return chatClient.prompt()
                    .options(OpenAiChatOptions.builder().model(fallbackModelName).temperature(0.3).maxTokens(1000).build())
                    .system(systemPrompt)
                    .user(userPrompt)
                    .call()
                    .content();
        } catch (Exception fallbackError) {
            throw new IllegalStateException("Primary and fallback model calls failed.", fallbackError);
        }
    }

    private List<String> parseBullets(String content) {
        if (content == null || content.isBlank()) {
            return List.of();
        }
        List<String> bullets = new ArrayList<>();
        for (String line : content.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isBlank()) {
                continue;
            }
            if (trimmed.startsWith("-")) {
                bullets.add(trimmed.substring(1).trim());
            } else if (trimmed.matches("^\\d+[\\.)].*")) {
                bullets.add(trimmed.replaceFirst("^\\d+[\\.)]\\s*", ""));
            } else {
                bullets.add(trimmed);
            }
        }
        return bullets.stream().filter(s -> !s.isBlank()).limit(5).toList();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parseSuggestionJson(String rawContent) {
        if (rawContent == null || rawContent.isBlank()) {
            return Map.of();
        }
        String trimmed = rawContent.trim();
        if (trimmed.startsWith("```")) {
            List<String> lines = new ArrayList<>(List.of(trimmed.split("\\R")));
            if (!lines.isEmpty()) {
                lines.remove(0);
            }
            if (!lines.isEmpty() && lines.get(lines.size() - 1).startsWith("```")) {
                lines.remove(lines.size() - 1);
            }
            trimmed = String.join("\n", lines).trim();
        }
        try {
            return objectMapper.readValue(trimmed, new TypeReference<Map<String, Object>>() {
            });
        } catch (Exception ex) {
            return Map.of();
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> readExpressionResults(Object value) {
        if (value instanceof List<?> list) {
            List<Map<String, Object>> rows = new ArrayList<>();
            for (Object item : list) {
                if (item instanceof Map<?, ?> map) {
                    rows.add((Map<String, Object>) map);
                }
            }
            return rows;
        }
        return List.of();
    }

    private String valueAsString(Object value, String fallback) {
        return value == null ? fallback : String.valueOf(value);
    }

    private void insertAiAudit(String eventType, String actor, UUID runId, UUID caseId, Map<String, Object> payload) {
        jdbcTemplate.update(
                "INSERT INTO audit_events (event_type, entity_type, entity_id, actor, ref_run_id, ref_case_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb)",
                eventType,
                "ai",
                UUID.randomUUID(),
                actor,
                runId,
                caseId,
                toJson(Map.of(
                        "timestamp", Instant.now().toString(),
                        "payload", payload
                ))
        );
    }

    private String toJson(Object payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("Unable to serialise AI audit payload", ex);
        }
    }

    public record DraftSpecResponse(
            boolean success,
            String measureName,
            Map<String, Object> suggestion,
            String explanation,
            String provider,
            boolean fallbackUsed,
            String fallback
    ) {
    }

    public record CaseExplanationResponse(
            String caseId,
            String explanation,
            String provider,
            boolean fallbackUsed,
            String disclaimer
    ) {
    }

    public record RunInsightResponse(
            boolean fallback,
            List<String> insights
    ) {
    }

    private record CachedCaseExplanation(
            Instant updatedAt,
            CaseExplanationResponse response
    ) {
    }

    private record CaseExplanationCacheKey(
            UUID caseId,
            String measureVersion
    ) {
    }
}
