package com.workwell.web;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import com.workwell.measure.AudiogramDemoService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.TBSurveillanceDemoService;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import com.workwell.run.RunPersistenceService;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;

@RestController
@Validated
public class EvalController {
    private final AudiogramDemoService audiogramDemoService;
    private final TBSurveillanceDemoService tbSurveillanceDemoService;
    private final RunPersistenceService runPersistenceService;
    private final MeasureService measureService;

    public EvalController(
            AudiogramDemoService audiogramDemoService,
            TBSurveillanceDemoService tbSurveillanceDemoService,
            RunPersistenceService runPersistenceService,
            MeasureService measureService
    ) {
        this.audiogramDemoService = audiogramDemoService;
        this.tbSurveillanceDemoService = tbSurveillanceDemoService;
        this.runPersistenceService = runPersistenceService;
        this.measureService = measureService;
    }

    @PostMapping("/api/eval")
    public EvalResponse eval(
            @RequestHeader(name = "X-WorkWell-Internal", required = false) String internalHeader,
            @Valid @RequestBody EvalRequest request
    ) {
        if (!"true".equalsIgnoreCase(internalHeader)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Endpoint not found");
        }
        Map<String, String> patientBundle = request.patientBundle() == null ? Map.of() : request.patientBundle();
        String patientId = patientBundle.getOrDefault("id", "unknown");
        String evaluationId = "eval-" + Instant.now().toEpochMilli();
        String summary = "Internal compatibility evaluation completed for patient " + patientId + ".";

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

    @PostMapping("/api/runs/tb-surveillance")
    public TBSurveillanceDemoService.TBDemoRun runTbSurveillance() {
        return tbSurveillanceDemoService.run();
    }

    @PostMapping("/api/runs/manual")
    public ManualRunResponse runAllPrograms(@RequestBody(required = false) ManualRunRequest request) {
        String scope = request == null || request.scope() == null || request.scope().isBlank()
                ? "All Programs"
                : request.scope().trim();
        if (!"All Programs".equalsIgnoreCase(scope)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only scope 'All Programs' is supported for MVP.");
        }

        // Ensure default demo measures are present before resolving active run scope.
        measureService.listMeasures();
        UUID runId = UUID.randomUUID();
        LocalDate evaluationDate = LocalDate.now();
        List<DemoRunPayload> payloads = runPersistenceService.loadActiveMeasureScopes().stream()
                .map(scopeRow -> switch (scopeRow.measureName()) {
                    case "Audiogram" -> audiogramDemoService.buildPayload(runId.toString(), evaluationDate);
                    case "TB Surveillance" -> tbSurveillanceDemoService.buildPayload(runId.toString(), evaluationDate);
                    default -> null;
                })
                .filter(payload -> payload != null)
                .toList();
        UUID persistedRunId = runPersistenceService.persistAllProgramsRun(runId.toString(), "All Programs", payloads);
        return new ManualRunResponse(
                persistedRunId.toString(),
                "All Programs",
                payloads.size(),
                payloads.stream().map(DemoRunPayload::measureName).toList()
        );
    }

    @GetMapping("/api/runs/audiogram/latest")
    public Optional<AudiogramDemoService.AudiogramDemoRun> latestAudiogramRun() {
        return runPersistenceService.loadLatestAudiogramRun();
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

    public record ManualRunRequest(String scope) {
    }

    public record ManualRunResponse(
            String runId,
            String scope,
            int activeMeasuresExecuted,
            List<String> measuresExecuted
    ) {
    }
}
