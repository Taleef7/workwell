package com.workwell.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.caseflow.CaseFlowService;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class AiAssistService {
    private final CaseFlowService caseFlowService;
    private final JdbcTemplate jdbcTemplate;
    private final ObjectMapper objectMapper;

    public AiAssistService(
            CaseFlowService caseFlowService,
            JdbcTemplate jdbcTemplate,
            ObjectMapper objectMapper
    ) {
        this.caseFlowService = caseFlowService;
        this.jdbcTemplate = jdbcTemplate;
        this.objectMapper = objectMapper;
    }

    public DraftSpecResponse draftSpec(String policyText, String measureName, String actor) {
        String text = policyText == null ? "" : policyText.trim();
        if (text.isBlank()) {
            throw new IllegalArgumentException("policyText is required");
        }
        String resolvedMeasure = (measureName == null || measureName.isBlank()) ? "New Measure" : measureName.trim();
        Map<String, Object> suggestion = buildSuggestion(text, resolvedMeasure);
        DraftSpecResponse response = new DraftSpecResponse(
                resolvedMeasure,
                suggestion,
                "AI suggestion generated from policy text. Human review and explicit apply are required.",
                "fallback-rules",
                true
        );
        insertAiAudit("AI_DRAFT_SPEC_GENERATED", actor, null, null, Map.of(
                "measureName", resolvedMeasure,
                "policyTextLength", text.length(),
                "provider", response.provider(),
                "fallbackUsed", response.fallbackUsed()
        ));
        return response;
    }

    public CaseExplanationResponse explainCase(UUID caseId, String actor) {
        CaseFlowService.CaseDetail detail = caseFlowService.loadCase(caseId)
                .orElseThrow(() -> new IllegalArgumentException("Case not found"));
        String explanation = buildExplanation(detail);
        insertAiAudit("AI_CASE_EXPLANATION_GENERATED", actor, detail.lastRunId(), caseId, Map.of(
                "measureName", detail.measureName(),
                "outcomeStatus", detail.currentOutcomeStatus(),
                "provider", "fallback-rules",
                "fallbackUsed", true
        ));
        return new CaseExplanationResponse(
                caseId.toString(),
                explanation,
                "fallback-rules",
                true,
                "AI explanation is advisory text only. Compliance decisions come from structured CQL evidence."
        );
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

    private String buildExplanation(CaseFlowService.CaseDetail detail) {
        Map<String, Object> whyFlagged = detail.evidenceJson() == null
                ? Map.of()
                : safeMap(detail.evidenceJson().get("why_flagged"));
        String lastExamDate = valueAsString(whyFlagged.get("last_exam_date"), "unknown");
        String daysOverdue = valueAsString(whyFlagged.get("days_overdue"), "unknown");
        String window = valueAsString(whyFlagged.get("compliance_window_days"), "unknown");
        String waiver = valueAsString(whyFlagged.get("waiver_status"), "unknown");
        return detail.employeeName()
                + " was flagged for " + detail.measureName()
                + " with status " + detail.currentOutcomeStatus()
                + ". Last recorded exam/vaccine date is " + lastExamDate
                + " against a " + window + "-day window, with " + daysOverdue
                + " days overdue and waiver status " + waiver
                + ". This explanation is derived from structured evidence_json and does not determine compliance.";
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
            String measureName,
            Map<String, Object> suggestion,
            String explanation,
            String provider,
            boolean fallbackUsed
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
}
