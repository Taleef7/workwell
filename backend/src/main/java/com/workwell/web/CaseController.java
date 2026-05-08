package com.workwell.web;

import com.workwell.caseflow.CaseFlowService;
import com.workwell.caseflow.EvidenceService;
import com.workwell.audit.CaseAccessAuditService;
import com.workwell.security.SecurityActor;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class CaseController {
    private final CaseFlowService caseFlowService;
    private final EvidenceService evidenceService;
    private final CaseAccessAuditService caseAccessAuditService;

    public CaseController(
            CaseFlowService caseFlowService,
            EvidenceService evidenceService,
            CaseAccessAuditService caseAccessAuditService
    ) {
        this.caseFlowService = caseFlowService;
        this.evidenceService = evidenceService;
        this.caseAccessAuditService = caseAccessAuditService;
    }

    @GetMapping("/api/cases")
    public List<CaseFlowService.CaseSummary> listCases(
            @RequestParam(name = "status", defaultValue = "open") String status,
            @RequestParam(name = "measureId", required = false) UUID measureId,
            @RequestParam(name = "priority", required = false) String priority,
            @RequestParam(name = "assignee", required = false) String assignee,
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "from", required = false) String from,
            @RequestParam(name = "to", required = false) String to
    ) {
        try {
            return caseFlowService.listCases(
                    status,
                    measureId,
                    priority,
                    assignee,
                    site,
                    parseFromDate(from),
                    parseToDate(to)
            );
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/cases/{caseId}")
    public CaseFlowService.CaseDetail caseDetail(@PathVariable UUID caseId) {
        CaseFlowService.CaseDetail detail = caseFlowService.loadCase(caseId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
        caseAccessAuditService.recordCaseViewed(
                detail.caseId(),
                detail.measureVersionId(),
                SecurityActor.currentActor(),
                detail.employeeId(),
                detail.measureName(),
                Instant.now()
        );
        return detail;
    }

    @PostMapping("/api/cases/{caseId}/actions/outreach")
    public CaseFlowService.CaseDetail sendOutreach(
            @PathVariable UUID caseId,
            @RequestParam(name = "templateId", required = false) UUID templateId,
            @RequestParam(name = "actor", required = false) String actor
    ) {
        String resolvedActor = actor == null || actor.isBlank() ? SecurityActor.currentActorOr("case-manager") : actor;
        return caseFlowService.sendOutreach(caseId, resolvedActor, templateId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    @PostMapping("/api/cases/{caseId}/actions")
    public CaseFlowService.CaseDetail caseAction(
            @PathVariable UUID caseId,
            @Valid @RequestBody CaseActionRequest request
    ) {
        try {
            String actor = SecurityActor.currentActorOr("case-manager");
            if ("RESOLVE".equalsIgnoreCase(request.type())) {
                return caseFlowService.resolveCase(
                                caseId,
                                actor,
                                request.note(),
                                request.resolvedAt(),
                                request.resolvedBy()
                        )
                        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
            }
            if ("SCHEDULE_APPOINTMENT".equalsIgnoreCase(request.type())) {
                return caseFlowService.scheduleAppointment(
                                caseId,
                                actor,
                                request.appointmentType(),
                                request.scheduledAt(),
                                request.location(),
                                request.notes()
                        )
                        .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
            }
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unsupported action type");
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/cases/{caseId}/appointments")
    public List<CaseFlowService.ScheduledAppointment> listAppointments(@PathVariable UUID caseId) {
        return caseFlowService.listAppointments(caseId);
    }

    @PostMapping(value = "/api/cases/{caseId}/evidence", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public EvidenceService.EvidenceAttachment uploadEvidence(
            @PathVariable UUID caseId,
            @RequestParam("file") MultipartFile file,
            @RequestParam(name = "description", required = false) String description
    ) {
        try {
            return evidenceService.upload(caseId, file, description, SecurityActor.currentActorOr("case-manager"));
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        } catch (IllegalStateException ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, ex.getMessage());
        }
    }

    @GetMapping("/api/cases/{caseId}/evidence")
    public List<EvidenceService.EvidenceAttachment> listEvidence(@PathVariable UUID caseId) {
        return evidenceService.list(caseId);
    }

    @GetMapping("/api/evidence/{id}/download")
    public ResponseEntity<byte[]> downloadEvidence(@PathVariable UUID id) {
        try {
            EvidenceService.DownloadedEvidence downloaded = evidenceService.loadForDownload(id);
            String disposition = downloaded.inline() ? "inline" : "attachment";
            return ResponseEntity.ok()
                    .contentType(downloaded.mediaType())
                    .header(HttpHeaders.CONTENT_DISPOSITION, disposition + "; filename=\"" + downloaded.attachment().fileName() + "\"")
                    .body(downloaded.bytes());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        } catch (IllegalStateException ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, ex.getMessage());
        }
    }

    @GetMapping("/api/cases/{caseId}/actions/outreach/preview")
    public CaseFlowService.OutreachPreview previewOutreach(
            @PathVariable UUID caseId,
            @RequestParam(name = "templateId", required = false) UUID templateId
    ) {
        return caseFlowService.previewOutreach(caseId, templateId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    @PostMapping("/api/cases/{caseId}/actions/outreach/delivery")
    public CaseFlowService.CaseDetail updateOutreachDelivery(
            @PathVariable UUID caseId,
            @RequestParam(name = "deliveryStatus") String deliveryStatus,
            @RequestParam(name = "actor", required = false) String actor
    ) {
        try {
            String resolvedActor = actor == null || actor.isBlank() ? SecurityActor.currentActorOr("case-manager") : actor;
            return caseFlowService.updateOutreachDelivery(caseId, deliveryStatus, resolvedActor)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PostMapping("/api/cases/{caseId}/rerun-to-verify")
    public CaseFlowService.CaseDetail rerunToVerify(
            @PathVariable UUID caseId,
            @RequestParam(name = "actor", required = false) String actor
    ) {
        String resolvedActor = actor == null || actor.isBlank() ? SecurityActor.currentActorOr("case-manager") : actor;
        return caseFlowService.rerunToVerify(caseId, resolvedActor)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    @PostMapping("/api/cases/{caseId}/assign")
    public CaseFlowService.CaseDetail assignCase(
            @PathVariable UUID caseId,
            @RequestParam(name = "assignee", required = false) String assignee,
            @RequestParam(name = "actor", required = false) String actor
    ) {
        String resolvedActor = actor == null || actor.isBlank() ? SecurityActor.currentActorOr("case-manager") : actor;
        return caseFlowService.assignCase(caseId, assignee, resolvedActor)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    @PostMapping("/api/cases/{caseId}/escalate")
    public CaseFlowService.CaseDetail escalateCase(
            @PathVariable UUID caseId,
            @RequestParam(name = "actor", required = false) String actor
    ) {
        String resolvedActor = actor == null || actor.isBlank() ? SecurityActor.currentActorOr("case-manager") : actor;
        return caseFlowService.escalateCase(caseId, resolvedActor)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Case not found"));
    }

    public record CaseActionRequest(
            @NotBlank String type,
            String note,
            Instant resolvedAt,
            String resolvedBy,
            String appointmentType,
            Instant scheduledAt,
            String location,
            String notes
    ) {
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
