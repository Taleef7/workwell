package com.workwell.web;

import com.workwell.ai.AiAssistService;
import com.workwell.security.SecurityActor;
import jakarta.validation.constraints.NotBlank;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
public class AiController {
    private final AiAssistService aiAssistService;

    public AiController(AiAssistService aiAssistService) {
        this.aiAssistService = aiAssistService;
    }

    @PostMapping({"/api/ai/draft-spec", "/api/measures/{measureId}/ai/draft-spec"})
    public AiAssistService.DraftSpecResponse draftSpec(
            @PathVariable(name = "measureId", required = false) UUID measureId,
            @RequestBody DraftSpecRequest request
    ) {
        try {
            return aiAssistService.draftSpec(request.policyText(), request.measureName(), SecurityActor.currentActor(), measureId);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PostMapping({"/api/cases/{caseId}/explain", "/api/cases/{caseId}/ai/explain"})
    public AiAssistService.CaseExplanationResponse explainCase(
            @PathVariable UUID caseId
    ) {
        try {
            return aiAssistService.explainCase(caseId, SecurityActor.currentActor());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    @PostMapping("/api/runs/{runId}/ai/insight")
    public AiAssistService.RunInsightResponse runInsight(
            @PathVariable UUID runId
    ) {
        try {
            return aiAssistService.runInsight(runId, SecurityActor.currentActor());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    public record DraftSpecRequest(
            String measureName,
            @NotBlank String policyText
    ) {
    }
}
