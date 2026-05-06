package com.workwell.web;

import com.workwell.export.CsvExportService;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ExportController {
    private final CsvExportService csvExportService;

    public ExportController(CsvExportService csvExportService) {
        this.csvExportService = csvExportService;
    }

    @GetMapping("/api/exports/runs")
    public ResponseEntity<String> exportRuns(
            @RequestParam(name = "format", defaultValue = "csv") String format,
            @RequestParam(name = "status", required = false) String status,
            @RequestParam(name = "scopeType", required = false) String scopeType,
            @RequestParam(name = "triggerType", required = false) String triggerType,
            @RequestParam(name = "limit", defaultValue = "200") int limit
    ) {
        return csvResponse(
                format,
                "runs-export.csv",
                csvExportService.exportRunSummaryCsv(status, scopeType, triggerType, limit)
        );
    }

    @GetMapping("/api/exports/outcomes")
    public ResponseEntity<String> exportOutcomes(
            @RequestParam(name = "format", defaultValue = "csv") String format,
            @RequestParam(name = "runId", required = false) UUID runId
    ) {
        return csvResponse(format, "outcomes.csv", csvExportService.exportOutcomeCsv(runId));
    }

    @GetMapping("/api/exports/cases")
    public ResponseEntity<String> exportCases(
            @RequestParam(name = "format", defaultValue = "csv") String format,
            @RequestParam(name = "status", required = false) String status,
            @RequestParam(name = "measureId", required = false) UUID measureId,
            @RequestParam(name = "priority", required = false) String priority,
            @RequestParam(name = "assignee", required = false) String assignee,
            @RequestParam(name = "site", required = false) String site
    ) {
        return csvResponse(
                format,
                "cases.csv",
                csvExportService.exportCaseCsv(status, measureId, priority, assignee, site)
        );
    }

    private ResponseEntity<String> csvResponse(String format, String filename, String csv) {
        if (!"csv".equalsIgnoreCase(format)) {
            return ResponseEntity.badRequest().body("Unsupported format. Use format=csv.");
        }
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentType(MediaType.parseMediaType("text/csv"))
                .body(csv);
    }
}
