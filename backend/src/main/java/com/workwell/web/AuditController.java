package com.workwell.web;

import com.workwell.audit.AuditExportService;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class AuditController {
    private final AuditExportService auditExportService;

    public AuditController(AuditExportService auditExportService) {
        this.auditExportService = auditExportService;
    }

    @GetMapping("/api/audit-events/export")
    public ResponseEntity<String> exportAudit(@RequestParam(name = "format", defaultValue = "csv") String format) {
        if (!"csv".equalsIgnoreCase(format)) {
            return ResponseEntity.badRequest().body("Unsupported format. Use format=csv.");
        }
        String csv = auditExportService.exportCsv();
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"audit-events.csv\"")
                .contentType(MediaType.parseMediaType("text/csv"))
                .body(csv);
    }
}
