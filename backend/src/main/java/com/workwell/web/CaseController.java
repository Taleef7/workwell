package com.workwell.web;

import com.workwell.caseflow.CaseFlowService;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class CaseController {
    private final CaseFlowService caseFlowService;

    public CaseController(CaseFlowService caseFlowService) {
        this.caseFlowService = caseFlowService;
    }

    @GetMapping("/api/cases")
    public List<CaseFlowService.CaseSummary> listCases() {
        return caseFlowService.listCases();
    }

    @GetMapping("/api/cases/{caseId}")
    public CaseFlowService.CaseDetail caseDetail(@PathVariable UUID caseId) {
        return caseFlowService.loadCase(caseId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    @PostMapping("/api/cases/{caseId}/actions/outreach")
    public CaseFlowService.CaseDetail sendOutreach(
            @PathVariable UUID caseId,
            @RequestParam(name = "actor", defaultValue = "case-manager") String actor
    ) {
        return caseFlowService.sendOutreach(caseId, actor)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    @PostMapping("/api/cases/{caseId}/rerun-to-verify")
    public CaseFlowService.CaseDetail rerunToVerify(
            @PathVariable UUID caseId,
            @RequestParam(name = "actor", defaultValue = "case-manager") String actor
    ) {
        return caseFlowService.rerunToVerify(caseId, actor)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }
}
