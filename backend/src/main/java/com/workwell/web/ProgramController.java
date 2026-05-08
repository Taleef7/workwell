package com.workwell.web;

import com.workwell.program.ProgramService;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class ProgramController {
    private final ProgramService programService;

    public ProgramController(ProgramService programService) {
        this.programService = programService;
    }

    @GetMapping("/api/programs")
    public List<ProgramService.ProgramSummary> programs(
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to
    ) {
        return programService.listPrograms(site, parseFromDate(from), parseToDate(to));
    }

    @GetMapping("/api/programs/overview")
    public List<ProgramService.ProgramSummary> programsOverview(
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to
    ) {
        return programService.listPrograms(site, parseFromDate(from), parseToDate(to));
    }

    @GetMapping("/api/programs/sites")
    public List<String> sites() {
        return programService.listSites();
    }

    @GetMapping("/api/programs/{measureId}/trend")
    public List<ProgramService.ProgramTrendPoint> trend(
            @PathVariable UUID measureId,
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to
    ) {
        return programService.trend(measureId, site, parseFromDate(from), parseToDate(to));
    }

    @GetMapping("/api/programs/{measureId}/top-drivers")
    public ProgramService.TopDrivers topDrivers(
            @PathVariable UUID measureId,
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to
    ) {
        return programService.topDrivers(measureId, site, parseFromDate(from), parseToDate(to));
    }

    private Instant parseFromDate(String from) {
        if (from == null || from.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(from.trim()).atStartOfDay().toInstant(ZoneOffset.UTC);
        } catch (DateTimeParseException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "from must use YYYY-MM-DD", ex);
        }
    }

    private Instant parseToDate(String to) {
        if (to == null || to.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(to.trim()).plusDays(1).atStartOfDay().minusSeconds(1).toInstant(ZoneOffset.UTC);
        } catch (DateTimeParseException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "to must use YYYY-MM-DD", ex);
        }
    }
}
