package com.workwell.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import com.workwell.measure.AudiogramDemoService;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
@Validated
public class EvalController {
    private final AudiogramDemoService audiogramDemoService;

    public EvalController(AudiogramDemoService audiogramDemoService) {
        this.audiogramDemoService = audiogramDemoService;
    }

    @PostMapping("/api/eval")
    public EvalResponse eval(@Valid @RequestBody EvalRequest request) {
        Map<String, String> patientBundle = request.patientBundle() == null ? Map.of() : request.patientBundle();
        String patientId = patientBundle.getOrDefault("id", "unknown");
        String evaluationId = "eval-" + Instant.now().toEpochMilli();
        String summary = "S0 placeholder evaluation completed for patient " + patientId + ".";

        return new EvalResponse(
                evaluationId,
                "COMPLIANT",
                summary,
                List.of(
                        Map.of(
                                "define", "S0-Stub-Define",
                                "result", true
                        )
                ),
                Map.of(
                        "patientBundleId", patientId,
                        "cqlLength", request.cqlLibrary().length()
                )
        );
    }

    @PostMapping("/api/runs/audiogram")
    public AudiogramDemoService.AudiogramDemoRun runAudiogram() {
        return audiogramDemoService.run();
    }

    public record EvalRequest(
            Map<String, String> patientBundle,
            @NotBlank String cqlLibrary
    ) {
    }

    public record EvalResponse(
            String evaluationId,
            String outcome,
            String summary,
            List<Map<String, Object>> expressionResults,
            Map<String, Object> evaluatedResource
    ) {
    }
}
