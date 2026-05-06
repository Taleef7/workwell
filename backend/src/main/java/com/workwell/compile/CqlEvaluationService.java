package com.workwell.compile;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.context.support.DefaultProfileValidationSupport;
import ca.uhn.fhir.repository.IRepository;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Attachment;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.CanonicalType;
import org.hl7.fhir.r4.model.Enumerations;
import org.hl7.fhir.r4.model.IdType;
import org.hl7.fhir.r4.model.Library;
import org.hl7.fhir.r4.model.Measure;
import org.opencds.cqf.cql.engine.execution.CqlEngine;
import org.opencds.cqf.cql.engine.execution.EvaluationResult;
import org.opencds.cqf.fhir.cql.Engines;
import org.opencds.cqf.fhir.cr.measure.MeasureEvaluationOptions;
import org.opencds.cqf.fhir.cr.measure.common.MeasureProcessorUtils;
import org.opencds.cqf.fhir.cr.measure.r4.R4MeasureProcessor;
import org.opencds.cqf.fhir.utility.monad.Eithers;
import org.opencds.cqf.fhir.utility.repository.InMemoryFhirRepository;
import org.springframework.stereotype.Service;

@Service
public class CqlEvaluationService {

    private final SyntheticFhirBundleBuilder syntheticFhirBundleBuilder = new SyntheticFhirBundleBuilder();

    public DemoRunPayload evaluate(String runId, String measureName, String measureVersion, String cqlText, LocalDate evaluationDate) {
        List<SeededInput> seededInputs = seededInputsFor(measureName);
        List<DemoOutcome> outcomes = new ArrayList<>();

        for (SeededInput input : seededInputs) {
            try {
                if (shouldFailEmployeeForTesting(input.employee().externalId())) {
                    throw new IllegalStateException("Forced employee evaluation failure for testing");
                }
                EvaluationResult eval = evaluateEmployee(measureName, measureVersion, cqlText, evaluationDate, input);
                Map<String, ?> expressionResultsMap = eval.expressionResults == null ? Map.of() : eval.expressionResults;
                String outcomeStatus = normalizeOutcomeStatus(expressionResultsMap.get("Outcome Status"));
                Map<String, Object> evidenceJson = buildEvidenceJson(input.employee(), expressionResultsMap, outcomeStatus, input.config(), evaluationDate);

                outcomes.add(new DemoOutcome(
                        input.employee().externalId(),
                        input.employee().name(),
                        input.employee().role(),
                        input.employee().site(),
                        outcomeStatus,
                        "Outcome derived from CQL define 'Outcome Status'.",
                        evidenceJson
                ));
            } catch (Exception ex) {
                outcomes.add(new DemoOutcome(
                        input.employee().externalId(),
                        input.employee().name(),
                        input.employee().role(),
                        input.employee().site(),
                        "MISSING_DATA",
                        "CQL evaluation failed for this employee.",
                        Map.of(
                                "evaluationError", "CQL engine failure",
                                "message", ex.getMessage()
                        )
                ));
            }
        }

        return new DemoRunPayload(runId, measureName, measureVersion, evaluationDate.toString(), outcomes);
    }

    protected boolean shouldFailEmployeeForTesting(String employeeExternalId) {
        return false;
    }

    private EvaluationResult evaluateEmployee(
            String measureName,
            String measureVersion,
            String cqlText,
            LocalDate evaluationDate,
            SeededInput input
    ) {
        FhirContext context = FhirContext.forR4Cached();
        context.setValidationSupport(new DefaultProfileValidationSupport(context));
        MeasureEvaluationOptions options = MeasureEvaluationOptions.defaultOptions();

        Bundle bundle = syntheticFhirBundleBuilder.buildBundle(input.employee(), input.config());

        IRepository repository = new InMemoryFhirRepository(context);
        List<IBaseResource> allResources = new ArrayList<>();
        Library library = buildLibrary(cqlText, measureName);
        Measure measure = buildMeasure(measureName, measureVersion, library.getUrl());
        allResources.add(measure);
        allResources.add(library);
        bundle.getEntry().forEach(e -> allResources.add(e.getResource()));
        for (IBaseResource resource : allResources) {
            repository.update(resource, new LinkedHashMap<>());
        }

        CqlEngine cqlEngine = Engines.forRepository(repository, options.getEvaluationSettings());
        R4MeasureProcessor processor = new R4MeasureProcessor(repository, options, new MeasureProcessorUtils());

        ZonedDateTime start = evaluationDate.atStartOfDay(ZoneOffset.UTC);
        ZonedDateTime end = evaluationDate.plusDays(1).atStartOfDay(ZoneOffset.UTC).minusSeconds(1);
        String subjectId = "Patient/" + input.employee().externalId();

        var composite = processor.evaluateMeasureWithCqlEngine(
                List.of(subjectId),
                Eithers.forLeft3(new CanonicalType(measure.getUrl())),
                start,
                end,
                null,
                cqlEngine
        );

        Map<String, EvaluationResult> bySubject = composite.getResultsPerMeasure().values().stream().findFirst().orElse(Map.of());
        EvaluationResult eval = bySubject.get(subjectId);
        if (eval == null) {
            throw new IllegalStateException("No evaluation result returned for " + subjectId);
        }
        return eval;
    }

    private Map<String, Object> buildEvidenceJson(
            SyntheticEmployeeCatalog.EmployeeProfile employee,
            Map<String, ?> expressionResults,
            String outcomeStatus,
            SyntheticFhirBundleBuilder.ExamConfig config,
            LocalDate evaluationDate
    ) {
        List<Map<String, Object>> expressionResultsList = expressionResults.entrySet().stream()
                .map(entry -> {
                    Map<String, Object> value = new LinkedHashMap<>();
                    value.put("define", entry.getKey());
                    value.put("result", normalizeExpressionValue(entry.getValue()));
                    return value;
                })
                .toList();

        String lastExamDate = config.daysSinceLastExam() == null ? null : evaluationDate.minusDays(config.daysSinceLastExam()).toString();
        Integer daysOverdue = config.daysSinceLastExam() == null ? null : Math.max(config.daysSinceLastExam() - 365, 0);

        Map<String, Object> whyFlagged = new LinkedHashMap<>();
        whyFlagged.put("last_exam_date", lastExamDate);
        whyFlagged.put("compliance_window_days", 365);
        whyFlagged.put("days_overdue", daysOverdue);
        whyFlagged.put("role_eligible", config.programEnrolled());
        whyFlagged.put("site_eligible", true);
        whyFlagged.put("waiver_status", config.hasWaiver() ? "active" : "none");
        whyFlagged.put("generated_at", Instant.now().toString());
        whyFlagged.put("outcome_status", outcomeStatus);

        Map<String, Object> evaluatedResource = new LinkedHashMap<>();
        evaluatedResource.put("subjectId", employee.externalId());
        evaluatedResource.put("employeeName", employee.name());
        evaluatedResource.put("role", employee.role());
        evaluatedResource.put("site", employee.site());

        Map<String, Object> evidenceJson = new LinkedHashMap<>();
        evidenceJson.put("expressionResults", expressionResultsList);
        evidenceJson.put("evaluatedResource", evaluatedResource);
        evidenceJson.put("why_flagged", whyFlagged);
        return evidenceJson;
    }

    private String normalizeOutcomeStatus(Object value) {
        String raw = value == null ? "MISSING_DATA" : normalizeExpressionValue(value).toString();
        if (raw.startsWith("\"") && raw.endsWith("\"")) {
            raw = raw.substring(1, raw.length() - 1);
        }
        return switch (raw) {
            case "COMPLIANT", "DUE_SOON", "OVERDUE", "MISSING_DATA", "EXCLUDED" -> raw;
            default -> "MISSING_DATA";
        };
    }

    private Object normalizeExpressionValue(Object value) {
        if (value == null) {
            return null;
        }
        String rendered = value.toString();
        if ("true".equalsIgnoreCase(rendered) || "false".equalsIgnoreCase(rendered)) {
            return Boolean.parseBoolean(rendered);
        }
        try {
            return Long.parseLong(rendered);
        } catch (NumberFormatException ignored) {
            return rendered;
        }
    }

    private Library buildLibrary(String cqlText, String measureName) {
        Library library = new Library();
        String libId = measureName.toLowerCase().replace(" ", "-") + "-library";
        library.setId(libId);
        library.setUrl("http://workwell.local/Library/" + libId);
        library.setStatus(Enumerations.PublicationStatus.ACTIVE);
        library.setType(new org.hl7.fhir.r4.model.CodeableConcept().setText("logic-library"));
        library.addContent(new Attachment().setContentType("text/cql").setData(cqlText.getBytes(StandardCharsets.UTF_8)));
        return library;
    }

    private Measure buildMeasure(String measureName, String measureVersion, String libraryUrl) {
        String id = measureName.toLowerCase().replace(" ", "-");
        Measure measure = new Measure();
        measure.setId(new IdType("Measure", id));
        measure.setUrl("http://workwell.local/Measure/" + id);
        measure.setVersion(measureVersion);
        measure.setName(id.replace("-", ""));
        measure.setTitle(measureName);
        measure.setStatus(Enumerations.PublicationStatus.ACTIVE);
        measure.addLibrary(libraryUrl);
        return measure;
    }

    private List<SeededInput> seededInputsFor(String measureName) {
        return switch (measureName) {
            case "Audiogram" -> List.of(
                    input("emp-001", 120, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
                    input("emp-002", 350, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
                    input("emp-003", 420, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
                    input("emp-004", null, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
                    input("emp-005", 600, true, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false)
            );
            case "TB Surveillance" -> List.of(
                    input("emp-041", 120, false, true, "tb-program", "urn:workwell:vs:tb-eligible-roles", "tb-exemption", "urn:workwell:vs:tb-exemption", "tb-screen", "urn:workwell:vs:tb-screening", false),
                    input("emp-044", 330, false, true, "tb-program", "urn:workwell:vs:tb-eligible-roles", "tb-exemption", "urn:workwell:vs:tb-exemption", "tb-screen", "urn:workwell:vs:tb-screening", false),
                    input("emp-046", 380, false, true, "tb-program", "urn:workwell:vs:tb-eligible-roles", "tb-exemption", "urn:workwell:vs:tb-exemption", "tb-screen", "urn:workwell:vs:tb-screening", false),
                    input("emp-049", null, false, true, "tb-program", "urn:workwell:vs:tb-eligible-roles", "tb-exemption", "urn:workwell:vs:tb-exemption", "tb-screen", "urn:workwell:vs:tb-screening", false),
                    input("emp-050", 600, true, true, "tb-program", "urn:workwell:vs:tb-eligible-roles", "tb-exemption", "urn:workwell:vs:tb-exemption", "tb-screen", "urn:workwell:vs:tb-screening", false)
            );
            case "HAZWOPER Surveillance" -> List.of(
                    input("emp-003", 120, false, true, "hazwoper-program", "urn:workwell:vs:hazwoper-enrollment", "hazwoper-exemption", "urn:workwell:vs:hazwoper-exemption", "hazwoper-exam", "urn:workwell:vs:hazwoper-exams", false),
                    input("emp-008", 355, false, true, "hazwoper-program", "urn:workwell:vs:hazwoper-enrollment", "hazwoper-exemption", "urn:workwell:vs:hazwoper-exemption", "hazwoper-exam", "urn:workwell:vs:hazwoper-exams", false),
                    input("emp-013", 380, false, true, "hazwoper-program", "urn:workwell:vs:hazwoper-enrollment", "hazwoper-exemption", "urn:workwell:vs:hazwoper-exemption", "hazwoper-exam", "urn:workwell:vs:hazwoper-exams", false),
                    input("emp-018", null, false, true, "hazwoper-program", "urn:workwell:vs:hazwoper-enrollment", "hazwoper-exemption", "urn:workwell:vs:hazwoper-exemption", "hazwoper-exam", "urn:workwell:vs:hazwoper-exams", false),
                    input("emp-023", 440, true, true, "hazwoper-program", "urn:workwell:vs:hazwoper-enrollment", "hazwoper-exemption", "urn:workwell:vs:hazwoper-exemption", "hazwoper-exam", "urn:workwell:vs:hazwoper-exams", false)
            );
            case "Flu Vaccine" -> List.of(
                    input("emp-041", 120, false, true, "clinical-role", "urn:workwell:vs:clinical-roles", "flu-exemption", "urn:workwell:vs:flu-exemption", "flu-vaccine", "urn:workwell:vs:flu-vaccines", true),
                    input("emp-042", null, false, true, "clinical-role", "urn:workwell:vs:clinical-roles", "flu-exemption", "urn:workwell:vs:flu-exemption", "flu-vaccine", "urn:workwell:vs:flu-vaccines", true),
                    input("emp-043", 40, false, true, "clinical-role", "urn:workwell:vs:clinical-roles", "flu-exemption", "urn:workwell:vs:flu-exemption", "flu-vaccine", "urn:workwell:vs:flu-vaccines", true),
                    input("emp-044", null, true, true, "clinical-role", "urn:workwell:vs:clinical-roles", "flu-exemption", "urn:workwell:vs:flu-exemption", "flu-vaccine", "urn:workwell:vs:flu-vaccines", true),
                    input("emp-045", null, false, true, "clinical-role", "urn:workwell:vs:clinical-roles", "flu-exemption", "urn:workwell:vs:flu-exemption", "flu-vaccine", "urn:workwell:vs:flu-vaccines", true)
            );
            default -> List.of();
        };
    }

    private SeededInput input(
            String employeeId,
            Integer daysSinceLastExam,
            boolean hasWaiver,
            boolean programEnrolled,
            String enrollmentCode,
            String enrollmentVs,
            String waiverCode,
            String waiverVs,
            String examCode,
            String examVs,
            boolean useImmunization
    ) {
        SyntheticEmployeeCatalog.EmployeeProfile employee = SyntheticEmployeeCatalog.byId(employeeId);
        SyntheticFhirBundleBuilder.ExamConfig config = new SyntheticFhirBundleBuilder.ExamConfig(
                daysSinceLastExam,
                hasWaiver,
                programEnrolled,
                enrollmentCode,
                enrollmentVs,
                waiverCode,
                waiverVs,
                examCode,
                examVs,
                useImmunization
        );
        return new SeededInput(employee, config);
    }

    private record SeededInput(
            SyntheticEmployeeCatalog.EmployeeProfile employee,
            SyntheticFhirBundleBuilder.ExamConfig config
    ) {
    }
}
