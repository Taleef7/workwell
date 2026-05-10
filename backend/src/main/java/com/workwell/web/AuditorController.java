package com.workwell.web;

import com.workwell.audit.AuditPacketService;
import com.workwell.security.SecurityActor;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AuditorController {

    private final AuditPacketService auditPacketService;

    public AuditorController(AuditPacketService auditPacketService) {
        this.auditPacketService = auditPacketService;
    }

    @GetMapping("/api/auditor/cases/{caseId}/packet")
    public ResponseEntity<byte[]> casePacket(
            @PathVariable UUID caseId,
            @RequestParam(name = "format", defaultValue = "json") String format
    ) {
        requireCaseRunAccess();
        return buildResponse(format, () -> auditPacketService.buildCasePacket(caseId, SecurityActor.currentActor(), format));
    }

    @GetMapping("/api/auditor/runs/{runId}/packet")
    public ResponseEntity<byte[]> runPacket(
            @PathVariable UUID runId,
            @RequestParam(name = "format", defaultValue = "json") String format
    ) {
        requireCaseRunAccess();
        return buildResponse(format, () -> auditPacketService.buildRunPacket(runId, SecurityActor.currentActor(), format));
    }

    @GetMapping("/api/auditor/measure-versions/{measureVersionId}/packet")
    public ResponseEntity<byte[]> measureVersionPacket(
            @PathVariable UUID measureVersionId,
            @RequestParam(name = "format", defaultValue = "json") String format
    ) {
        requireMeasureVersionAccess();
        return buildResponse(format, () -> auditPacketService.buildMeasureVersionPacket(measureVersionId, SecurityActor.currentActor(), format));
    }

    private ResponseEntity<byte[]> buildResponse(String format, PacketSupplier supplier) {
        if (!"json".equalsIgnoreCase(format) && !"html".equalsIgnoreCase(format)) {
            return ResponseEntity.badRequest().body("Unsupported format. Use format=json or format=html.".getBytes());
        }
        try {
            AuditPacketService.PacketResult result = supplier.get();
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + result.filename() + "\"")
                    .contentType(MediaType.parseMediaType(result.contentType()))
                    .body(result.content());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    private void requireCaseRunAccess() {
        if (!SecurityActor.hasAnyAuthority("ROLE_CASE_MANAGER", "ROLE_ADMIN")) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Case and run audit packets require case manager or admin access");
        }
    }

    private void requireMeasureVersionAccess() {
        if (!SecurityActor.hasAnyAuthority("ROLE_APPROVER", "ROLE_ADMIN")) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Measure version audit packets require approver or admin access");
        }
    }

    @FunctionalInterface
    private interface PacketSupplier {
        AuditPacketService.PacketResult get();
    }
}
