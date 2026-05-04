package com.workwell.web;

import com.workwell.measure.MeasureService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
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
import org.springframework.web.server.ResponseStatusException;

@RestController
@Validated
public class MeasureController {
    private final MeasureService measureService;

    public MeasureController(MeasureService measureService) {
        this.measureService = measureService;
    }

    @GetMapping("/api/measures")
    public List<MeasureService.MeasureCatalogItem> listMeasures() {
        return measureService.listMeasures();
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

    @GetMapping("/api/value-sets")
    public List<MeasureService.ValueSetRef> listValueSets() {
        return measureService.listValueSets();
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
        return measureService.activationReadiness(id);
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

    public record TestsUpdateRequest(
            List<MeasureService.TestFixture> fixtures
    ) {
    }

    private String nullToEmpty(String value) {
        return value == null ? "" : value;
    }
}
