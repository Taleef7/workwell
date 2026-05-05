package com.workwell.web;

import com.workwell.ai.AiAssistService;
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

    @PostMapping("/api/ai/draft-spec")
    public AiAssistService.DraftSpecResponse draftSpec(
            @RequestBody DraftSpecRequest request,
            @RequestParam(name = "actor", defaultValue = "measure-author") String actor
    ) {
        try {
            return aiAssistService.draftSpec(request.policyText(), request.measureName(), actor);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PostMapping("/api/cases/{caseId}/explain")
    public AiAssistService.CaseExplanationResponse explainCase(
            @PathVariable UUID caseId,
            @RequestParam(name = "actor", defaultValue = "case-manager") String actor
    ) {
        try {
            return aiAssistService.explainCase(caseId, actor);
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
