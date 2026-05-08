package com.workwell.web;

import com.workwell.run.RunPersistenceService;
import com.workwell.run.AllProgramsRunService;
import com.workwell.security.SecurityActor;
import com.workwell.web.EvalController.ManualRunResponse;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class RunController {
    private final RunPersistenceService runPersistenceService;
    private final AllProgramsRunService allProgramsRunService;

    public RunController(RunPersistenceService runPersistenceService, AllProgramsRunService allProgramsRunService) {
        this.runPersistenceService = runPersistenceService;
        this.allProgramsRunService = allProgramsRunService;
    }

    @GetMapping("/api/runs/{id}")
    public RunPersistenceService.RunSummaryResponse runById(@PathVariable UUID id) {
        return runPersistenceService.loadRunById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Run not found"));
    }

    @GetMapping("/api/runs")
    public List<RunPersistenceService.RunListItem> listRuns(
            @RequestParam(name = "status", required = false) String status,
            @RequestParam(name = "scopeType", required = false) String scopeType,
            @RequestParam(name = "triggerType", required = false) String triggerType,
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to,
            @RequestParam(name = "limit", defaultValue = "50") int limit
    ) {
        int safeLimit = Math.max(1, Math.min(limit, 200));
        return runPersistenceService.listRuns(
                status,
                scopeType,
                triggerType,
                site,
                parseFromDate(from),
                parseToDate(to),
                safeLimit
        );
    }

    @GetMapping("/api/runs/{id}/logs")
    public List<RunPersistenceService.RunLogEntry> runLogs(
            @PathVariable UUID id,
            @RequestParam(name = "limit", defaultValue = "100") int limit
    ) {
        int safeLimit = Math.max(1, Math.min(limit, 500));
        return runPersistenceService.loadRunLogs(id, safeLimit);
    }

    @GetMapping("/api/runs/{id}/outcomes")
    public List<RunPersistenceService.RunOutcomeRow> runOutcomes(@PathVariable UUID id) {
        return runPersistenceService.loadRunOutcomes(id);
    }

    @PostMapping("/api/runs/{id}/rerun")
    public ManualRunResponse rerunSameScope(@PathVariable UUID id) {
        try {
            return allProgramsRunService.rerunSameScope(id, SecurityActor.currentActor());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    private Instant parseFromDate(String from) {
        if (from == null || from.isBlank()) {
            return null;
        }
        return LocalDate.parse(from.trim()).atStartOfDay().toInstant(ZoneOffset.UTC);
    }

    private Instant parseToDate(String to) {
        if (to == null || to.isBlank()) {
            return null;
        }
        return LocalDate.parse(to.trim()).plusDays(1).atStartOfDay().minusSeconds(1).toInstant(ZoneOffset.UTC);
    }
}
