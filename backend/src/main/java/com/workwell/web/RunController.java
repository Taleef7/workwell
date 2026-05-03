package com.workwell.web;

import com.workwell.run.RunPersistenceService;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class RunController {
    private final RunPersistenceService runPersistenceService;

    public RunController(RunPersistenceService runPersistenceService) {
        this.runPersistenceService = runPersistenceService;
    }

    @GetMapping("/api/runs/{id}")
    public RunPersistenceService.RunSummaryResponse runById(@PathVariable UUID id) {
        return runPersistenceService.loadRunById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Run not found"));
    }
}
