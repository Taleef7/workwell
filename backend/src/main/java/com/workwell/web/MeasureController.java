package com.workwell.web;

import com.workwell.admin.DataReadinessService;
import com.workwell.measure.MeasureImpactPreviewService;
import com.workwell.measure.MeasureService;
import com.workwell.measure.MeasureTraceabilityService;
import com.workwell.measure.ValueSetGovernanceService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
public class MeasureController {
    private final MeasureService measureService;
    private final MeasureTraceabilityService traceabilityService;
    private final MeasureImpactPreviewService impactPreviewService;
    private final DataReadinessService dataReadinessService;
    private final ValueSetGovernanceService valueSetGovernanceService;

    public MeasureController(
            MeasureService measureService,
            MeasureTraceabilityService traceabilityService,
            MeasureImpactPreviewService impactPreviewService,
            DataReadinessService dataReadinessService,
            ValueSetGovernanceService valueSetGovernanceService
    ) {
        this.measureService = measureService;
        this.traceabilityService = traceabilityService;
        this.impactPreviewService = impactPreviewService;
        this.dataReadinessService = dataReadinessService;
        this.valueSetGovernanceService = valueSetGovernanceService;
    }

    @GetMapping("/api/measures")
    public List<MeasureService.MeasureCatalogItem> listMeasures(
            @RequestParam(name = "status", required = false) String status,
            @RequestParam(name = "search", required = false) String search
    ) {
        return measureService.listMeasures(status, search);
    }

    @PostMapping("/api/measures")
    public Map<String, String> createMeasure(@Valid @RequestBody CreateMeasureRequest request) {
        UUID id = measureService.createMeasure(request.name(), request.policyRef(), request.owner());
        return Map.of("id", id.toString());
    }

    @GetMapping("/api/measures/{id}")
    public MeasureService.MeasureDetail getMeasure(@PathVariable UUID id) {
        MeasureService.MeasureDetail detail = measureService.getMeasure(id);
        if (detail == null) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Measure not found");
        }
        return detail;
    }

    @PostMapping("/api/measures/{id}/versions")
    public Map<String, String> createVersion(@PathVariable UUID id, @Valid @RequestBody CreateVersionRequest request) {
        try {
            UUID versionId = measureService.createVersion(id, request.changeSummary());
            return Map.of("status", "created", "versionId", versionId.toString());
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @GetMapping("/api/measures/{id}/versions")
    public List<MeasureService.MeasureVersionHistoryItem> versionHistory(@PathVariable UUID id) {
        return measureService.listVersionHistory(id);
    }

    @GetMapping("/api/value-sets")
    public List<MeasureService.ValueSetRef> listValueSets() {
        return measureService.listValueSets();
    }

    @GetMapping("/api/osha-references")
    public List<MeasureService.OshaReference> listOshaReferences() {
        return measureService.listOshaReferences();
    }

    @PostMapping("/api/value-sets")
    public Map<String, String> createValueSet(@Valid @RequestBody CreateValueSetRequest request) {
        UUID id = measureService.createValueSet(request.oid(), request.name(), request.version());
        return Map.of("id", id.toString());
    }

    @PostMapping("/api/measures/{id}/value-sets/{valueSetId}")
    public Map<String, String> attachValueSet(@PathVariable UUID id, @PathVariable UUID valueSetId) {
        measureService.attachValueSet(id, valueSetId);
        return Map.of("status", "linked");
    }

    @DeleteMapping("/api/measures/{id}/value-sets/{valueSetId}")
    public Map<String, String> detachValueSet(@PathVariable UUID id, @PathVariable UUID valueSetId) {
        measureService.detachValueSet(id, valueSetId);
        return Map.of("status", "unlinked");
    }

    @PutMapping("/api/measures/{id}/spec")
    public Map<String, String> updateSpec(@PathVariable UUID id, @Valid @RequestBody SpecUpdateRequest request) {
        EligibilityCriteriaRequest eligibility = request.eligibilityCriteria() == null
                ? new EligibilityCriteriaRequest("", "", "")
                : request.eligibilityCriteria();
        measureService.updateSpec(id, new MeasureService.SpecUpdateRequest(
                request.policyRef(),
                request.oshaReferenceId(),
                request.description(),
                new MeasureService.EligibilityCriteria(
                        nullToEmpty(eligibility.roleFilter()),
                        nullToEmpty(eligibility.siteFilter()),
                        nullToEmpty(eligibility.programEnrollmentText())
                ),
                request.exclusions() == null ? List.of() : request.exclusions(),
                nullToEmpty(request.complianceWindow()),
                request.requiredDataElements() == null ? List.of() : request.requiredDataElements()
        ));
        return Map.of("status", "saved");
    }

    @PutMapping("/api/measures/{id}/cql")
    public Map<String, String> updateCql(@PathVariable UUID id, @Valid @RequestBody CqlUpdateRequest request) {
        measureService.updateCql(id, request.cqlText());
        return Map.of("status", "saved");
    }

    @PostMapping("/api/measures/{id}/cql/compile")
    public MeasureService.CompileResponse compile(@PathVariable UUID id, @Valid @RequestBody CqlUpdateRequest request) {
        measureService.updateCql(id, request.cqlText());
        return measureService.compileCql(id);
    }

    @PostMapping("/api/measures/{id}/status")
    public Map<String, String> transitionStatus(@PathVariable UUID id, @Valid @RequestBody StatusUpdateRequest request) {
        try {
            String status = measureService.transitionStatus(id, request.targetStatus());
            return Map.of("status", status);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PostMapping("/api/measures/{id}/approve")
    public Map<String, String> approveMeasure(@PathVariable UUID id) {
        try {
            String status = measureService.approveMeasure(id);
            return Map.of("status", status);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PostMapping("/api/measures/{id}/deprecate")
    public Map<String, String> deprecateMeasure(@PathVariable UUID id, @Valid @RequestBody DeprecateRequest request) {
        try {
            String status = measureService.deprecateMeasure(id, request.reason());
            return Map.of("status", status);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ex.getMessage());
        }
    }

    @PutMapping("/api/measures/{id}/tests")
    public Map<String, String> updateTests(@PathVariable UUID id, @RequestBody TestsUpdateRequest request) {
        measureService.updateTests(id, request.fixtures() == null ? List.of() : request.fixtures());
        return Map.of("status", "saved");
    }

    @PostMapping("/api/measures/{id}/tests/validate")
    public MeasureService.TestValidationResult validateTests(@PathVariable UUID id) {
        return measureService.validateTests(id);
    }

    @GetMapping("/api/measures/{id}/activation-readiness")
    public MeasureService.ActivationReadiness activationReadiness(@PathVariable UUID id) {
        MeasureService.ActivationReadiness base = measureService.activationReadiness(id);
        ValueSetGovernanceService.ResolveCheckResult vsCheck = valueSetGovernanceService.resolveCheck(id);
        List<String> allBlockers = new ArrayList<>(base.activationBlockers());
        allBlockers.addAll(vsCheck.blockers());
        return new MeasureService.ActivationReadiness(
                base.ready() && vsCheck.allResolved(),
                base.compileStatus(),
                base.testFixtureCount(),
                base.valueSetCount(),
                base.testValidationPassed(),
                allBlockers
        );
    }

    @PostMapping("/api/measures/{id}/value-sets/resolve-check")
    public ValueSetGovernanceService.ResolveCheckResult resolveCheck(@PathVariable UUID id) {
        try {
            return valueSetGovernanceService.resolveCheck(id);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    @GetMapping("/api/value-sets/{id}/diff")
    public ValueSetGovernanceService.ValueSetDiffResponse valueSetDiff(
            @PathVariable UUID id,
            @RequestParam(name = "to") UUID toId
    ) {
        try {
            return valueSetGovernanceService.diff(id, toId);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    @GetMapping("/api/value-sets/{id}/detail")
    public ValueSetGovernanceService.ValueSetDetail valueSetDetail(@PathVariable UUID id) {
        try {
            return valueSetGovernanceService.getValueSetDetail(id);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    @GetMapping("/api/measures/{id}/traceability")
    public MeasureTraceabilityService.TraceabilityResponse getTraceability(@PathVariable UUID id) {
        try {
            return traceabilityService.generate(id);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    @PostMapping("/api/measures/{id}/impact-preview")
    public MeasureImpactPreviewService.ImpactPreviewResponse impactPreview(
            @PathVariable UUID id,
            @RequestBody(required = false) MeasureImpactPreviewService.ImpactPreviewRequest request
    ) {
        try {
            return impactPreviewService.preview(id, request);
        } catch (IllegalArgumentException ex) {
            String msg = ex.getMessage();
            HttpStatus status = (msg != null && msg.contains("evaluationDate"))
                    ? HttpStatus.BAD_REQUEST : HttpStatus.NOT_FOUND;
            throw new ResponseStatusException(status, msg);
        }
    }

    @GetMapping("/api/measures/{id}/data-readiness")
    public DataReadinessService.DataReadinessResponse dataReadiness(@PathVariable UUID id) {
        try {
            return dataReadinessService.computeReadiness(id);
        } catch (IllegalArgumentException ex) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, ex.getMessage());
        }
    }

    public record CreateMeasureRequest(
            @NotBlank String name,
            @NotBlank String policyRef,
            @NotBlank String owner
    ) {
    }

    public record EligibilityCriteriaRequest(
            String roleFilter,
            String siteFilter,
            String programEnrollmentText
    ) {
    }

    public record SpecUpdateRequest(
            @NotBlank String policyRef,
            UUID oshaReferenceId,
            String description,
            EligibilityCriteriaRequest eligibilityCriteria,
            List<Map<String, String>> exclusions,
            String complianceWindow,
            List<String> requiredDataElements
    ) {
    }

    public record CqlUpdateRequest(String cqlText) {
    }

    public record StatusUpdateRequest(
            @NotBlank String targetStatus
    ) {
    }

    public record CreateValueSetRequest(
            @NotBlank String oid,
            @NotBlank String name,
            String version
    ) {
    }

    public record CreateVersionRequest(
            @NotBlank String changeSummary
    ) {
    }

    public record TestsUpdateRequest(
            List<MeasureService.TestFixture> fixtures
    ) {
    }

    public record DeprecateRequest(
            @NotBlank String reason
    ) {
    }

    private String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
