package com.workwell.web;

import com.workwell.program.ProgramService;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ProgramController {
    private final ProgramService programService;

    public ProgramController(ProgramService programService) {
        this.programService = programService;
    }

    @GetMapping("/api/programs")
    public List<ProgramService.ProgramSummary> programs() {
        return programService.listPrograms();
    }

    @GetMapping("/api/programs/{measureId}/trend")
    public List<ProgramService.ProgramTrendPoint> trend(@PathVariable UUID measureId) {
        return programService.trend(measureId);
    }

    @GetMapping("/api/programs/{measureId}/top-drivers")
    public ProgramService.TopDrivers topDrivers(@PathVariable UUID measureId) {
        return programService.topDrivers(measureId);
    }
}
