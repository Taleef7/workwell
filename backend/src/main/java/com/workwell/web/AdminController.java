package com.workwell.web;

import com.workwell.admin.DataReadinessService;
import com.workwell.admin.IntegrationHealthService;
import com.workwell.admin.OutreachTemplateService;
import com.workwell.admin.WaiverService;
import com.workwell.audit.AuditQueryService;
import com.workwell.admin.SchedulerAdminService;
import com.workwell.measure.ValueSetGovernanceService;
import com.workwell.security.SecurityActor;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
public class AdminController {
    private final IntegrationHealthService integrationHealthService;
    private final SchedulerAdminService schedulerAdminService;
    private final OutreachTemplateService outreachTemplateService;
    private final WaiverService waiverService;
    private final AuditQueryService auditQueryService;
    private final DataReadinessService dataReadinessService;
    private final ValueSetGovernanceService valueSetGovernanceService;

    public AdminController(
            IntegrationHealthService integrationHealthService,
            SchedulerAdminService schedulerAdminService,
            OutreachTemplateService outreachTemplateService,
            WaiverService waiverService,
            AuditQueryService auditQueryService,
            DataReadinessService dataReadinessService,
            ValueSetGovernanceService valueSetGovernanceService
    ) {
        this.integrationHealthService = integrationHealthService;
        this.schedulerAdminService = schedulerAdminService;
        this.outreachTemplateService = outreachTemplateService;
        this.waiverService = waiverService;
        this.auditQueryService = auditQueryService;
        this.dataReadinessService = dataReadinessService;
        this.valueSetGovernanceService = valueSetGovernanceService;
    }

    @GetMapping("/api/admin/integrations")
    public List<IntegrationHealthService.IntegrationHealth> listIntegrations() {
        return integrationHealthService.listHealth();
    }

    @PostMapping("/api/admin/integrations/{integration}/sync")
    public IntegrationHealthService.IntegrationHealth syncIntegration(
            @PathVariable String integration
    ) {
        try {
            return integrationHealthService.triggerManualSync(
                    integration,
                    SecurityActor.currentActor()
            );
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/admin/scheduler")
    public SchedulerAdminService.SchedulerStatus schedulerStatus() {
        return schedulerAdminService.status();
    }

    @PostMapping("/api/admin/scheduler")
    public SchedulerAdminService.SchedulerStatus updateScheduler(@RequestParam(name = "enabled") boolean enabled) {
        return schedulerAdminService.updateEnabled(enabled);
    }

    @GetMapping("/api/admin/outreach-templates")
    public List<OutreachTemplateService.OutreachTemplate> outreachTemplates() {
        return outreachTemplateService.listTemplates();
    }

    @PostMapping("/api/admin/outreach-templates")
    public OutreachTemplateService.OutreachTemplate createOutreachTemplate(@Valid @RequestBody OutreachTemplateRequest request) {
        try {
            return outreachTemplateService.createTemplate(
                    request.name(),
                    request.subject(),
                    request.bodyText(),
                    request.type(),
                    SecurityActor.currentActor()
            );
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PutMapping("/api/admin/outreach-templates/{id}")
    public OutreachTemplateService.OutreachTemplate updateOutreachTemplate(
            @PathVariable UUID id,
            @Valid @RequestBody OutreachTemplateUpdateRequest request
    ) {
        try {
            return outreachTemplateService.updateTemplate(
                    id,
                    request.name(),
                    request.subject(),
                    request.bodyText(),
                    request.type(),
                    request.active()
            );
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/admin/waivers")
    public List<WaiverService.WaiverRecord> listWaivers(
            @RequestParam(name = "measureId", required = false) UUID measureId,
            @RequestParam(name = "site", required = false) String site,
            @RequestParam(name = "expiresAfter", required = false) String expiresAfter,
            @RequestParam(name = "expiresBefore", required = false) String expiresBefore,
            @RequestParam(name = "active", required = false) Boolean active
    ) {
        return waiverService.listWaivers(
                measureId,
                site,
                parseFromDate(expiresAfter),
                parseToDate(expiresBefore),
                active
        );
    }

    @PostMapping("/api/admin/waivers")
    public WaiverService.WaiverRecord grantWaiver(@Valid @RequestBody WaiverRequest request) {
        try {
            return waiverService.grantWaiver(
                    request.employeeExternalId(),
                    request.measureId(),
                    request.exclusionReason(),
                    SecurityActor.currentActor(),
                    request.expiresAt(),
                    request.notes(),
                    request.active()
            );
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/admin/data-mappings")
    public List<DataReadinessService.DataElementMapping> listDataMappings() {
        return dataReadinessService.listMappings();
    }

    @PostMapping("/api/admin/data-mappings/validate")
    public List<DataReadinessService.DataElementMapping> validateDataMappings() {
        return dataReadinessService.validateMappings();
    }

    @GetMapping("/api/admin/terminology-mappings")
    public List<ValueSetGovernanceService.TerminologyMapping> listTerminologyMappings() {
        return valueSetGovernanceService.listTerminologyMappings();
    }

    @PostMapping("/api/admin/terminology-mappings")
    public ValueSetGovernanceService.TerminologyMapping createTerminologyMapping(
            @Valid @RequestBody CreateTerminologyMappingRequest request
    ) {
        try {
            return valueSetGovernanceService.createTerminologyMapping(
                    request.localCode(), request.localDisplay(), request.localSystem(),
                    request.standardCode(), request.standardDisplay(), request.standardSystem(),
                    request.mappingStatus(), request.mappingConfidence(), request.notes()
            );
        } catch (Exception ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/admin/audit-events")
    public List<AuditQueryService.AuditEventRow> listAuditEvents(
            @RequestParam(name = "scope", defaultValue = "all") String scope,
            @RequestParam(name = "limit", defaultValue = "100") int limit
    ) {
        int safeLimit = Math.max(1, Math.min(limit, 250));
        return auditQueryService.listEvents(scope, safeLimit);
    }

    public record OutreachTemplateRequest(
            @NotBlank String name,
            @NotBlank String subject,
            @NotBlank String bodyText,
            String type
    ) {
    }

    public record OutreachTemplateUpdateRequest(
            @NotBlank String name,
            @NotBlank String subject,
            @NotBlank String bodyText,
            String type,
            boolean active
    ) {
    }

    public record WaiverRequest(
            @NotBlank String employeeExternalId,
            UUID measureId,
            @NotBlank String exclusionReason,
            Instant expiresAt,
            String notes,
            Boolean active
    ) {
    }

    public record CreateTerminologyMappingRequest(
            @NotBlank String localCode,
            String localDisplay,
            @NotBlank String localSystem,
            @NotBlank String standardCode,
            String standardDisplay,
            @NotBlank String standardSystem,
            String mappingStatus,
            Double mappingConfidence,
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
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "expiresAfter must use YYYY-MM-DD", ex);
        }
    }

    private Instant parseToDate(String to) {
        if (to == null || to.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(to.trim()).plusDays(1).atStartOfDay().minusSeconds(1).toInstant(ZoneOffset.UTC);
        } catch (DateTimeParseException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "expiresBefore must use YYYY-MM-DD", ex);
        }
    }
}
