package com.workwell.compile;

import ca.uhn.fhir.context.FhirContext;
import ca.uhn.fhir.context.support.DefaultProfileValidationSupport;
import ca.uhn.fhir.repository.IRepository;
import com.workwell.measure.SyntheticEmployeeCatalog;
import com.workwell.run.DemoRunModels.DemoOutcome;
import com.workwell.run.DemoRunModels.DemoRunPayload;
import org.cqframework.cql.cql2elm.CqlTranslator;
import org.cqframework.cql.cql2elm.LibraryManager;
import org.cqframework.cql.cql2elm.ModelManager;
import org.cqframework.cql.cql2elm.quick.FhirLibrarySourceProvider;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Comparator;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Attachment;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Enumerations;
import org.hl7.fhir.r4.model.Expression;
import org.hl7.fhir.r4.model.IdType;
import org.hl7.fhir.r4.model.Library;
import org.hl7.fhir.r4.model.Measure;
import org.opencds.cqf.cql.engine.execution.CqlEngine;
import org.opencds.cqf.cql.engine.execution.EvaluationResult;
import org.opencds.cqf.fhir.cql.Engines;
import org.opencds.cqf.fhir.cr.measure.MeasureEvaluationOptions;
import org.opencds.cqf.fhir.cr.measure.common.MeasureProcessorUtils;
import org.opencds.cqf.fhir.cr.measure.r4.R4MeasureProcessor;
import org.opencds.cqf.fhir.utility.repository.InMemoryFhirRepository;
import org.springframework.stereotype.Service;

@Service
public class CqlEvaluationService {
    private static final String FLU_VACCINE_MEASURE_NAME = "Flu Vaccine";
    private static final int EXCLUDED_COUNT = 3;
    private static final int MISSING_DATA_COUNT = 2;

    private final SyntheticFhirBundleBuilder syntheticFhirBundleBuilder = new SyntheticFhirBundleBuilder();
    private final EvaluationPopulationProperties evaluationPopulationProperties;

    public CqlEvaluationService(EvaluationPopulationProperties evaluationPopulationProperties) {
        this.evaluationPopulationProperties = evaluationPopulationProperties;
    }

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
                String fallbackOutcome = "MISSING_DATA";
                outcomes.add(new DemoOutcome(
                        input.employee().externalId(),
                        input.employee().name(),
                        input.employee().role(),
                        input.employee().site(),
                        fallbackOutcome,
                        "CQL evaluation failed for this employee; recorded as MISSING_DATA.",
                        Map.of(
                                "evaluationError", "CQL engine failure",
                                "message", ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage(),
                                "fallbackOutcome", fallbackOutcome
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

        Bundle bundle = syntheticFhirBundleBuilder.buildBundle(input.employee(), input.config(), evaluationDate);

        IRepository repository = new InMemoryFhirRepository(context);
        List<IBaseResource> allResources = new ArrayList<>();
        Library library = buildLibrary(cqlText, measureName, measureVersion);
        Measure measure = buildMeasure(measureName, measureVersion, library.getUrl() + "|" + library.getVersion());
        allResources.add(measure);
        allResources.add(library);
        bundle.getEntry().forEach(e -> allResources.add(e.getResource()));
        for (IBaseResource resource : allResources) {
            repository.create(resource, new LinkedHashMap<>());
        }

        CqlEngine cqlEngine = Engines.forRepository(repository, options.getEvaluationSettings());
        R4MeasureProcessor processor = new R4MeasureProcessor(repository, options, new MeasureProcessorUtils());

        ZonedDateTime end = evaluationDate.plusDays(1).atStartOfDay(ZoneOffset.UTC).minusSeconds(1);
        ZonedDateTime start;
        // Fixed: Flu Vaccine used a one-day period, which made seasonal compliance effectively unreachable.
        if (FLU_VACCINE_MEASURE_NAME.equalsIgnoreCase(measureName)) {
            start = evaluationDate.minusMonths(12).atStartOfDay(ZoneOffset.UTC);
        } else {
            start = evaluationDate.atStartOfDay(ZoneOffset.UTC);
        }
        String subjectId = "Patient/" + input.employee().externalId();

        // Pass the in-memory Measure directly; CQF canonical re-resolution is brittle for these synthetic demo measures.
        var composite = processor.evaluateMeasureWithCqlEngine(
                List.of(subjectId),
                measure,
                start,
                end,
                null,
                cqlEngine
        );

        Map<String, EvaluationResult> bySubject = composite.getResultsPerMeasure().values().stream().findFirst().orElse(Map.of());
        EvaluationResult eval = bySubject.get(subjectId);
        if (eval == null) {
            eval = bySubject.get(input.employee().externalId());
        }
        if (eval == null) {
            eval = bySubject.entrySet().stream()
                    .filter(e -> e.getKey() != null && e.getKey().endsWith(input.employee().externalId()))
                    .map(Map.Entry::getValue)
                    .findFirst()
                    .orElse(null);
        }
        if (eval == null && bySubject.size() == 1) {
            eval = bySubject.values().stream().findFirst().orElse(null);
        }
        if (eval == null) {
            throw new IllegalStateException("No evaluation result returned for " + subjectId + ". keys=" + bySubject.keySet());
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
        Object unwrapped = unwrapExpressionResult(value);
        if (unwrapped != value) {
            return normalizeExpressionValue(unwrapped);
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

    private Object unwrapExpressionResult(Object value) {
        Class<?> type = value.getClass();
        String className = type.getName();
        if (!className.contains("ExpressionResult")) {
            return value;
        }
        for (String methodName : List.of("getValue", "value", "getResult", "result")) {
            try {
                var method = type.getMethod(methodName);
                return method.invoke(value);
            } catch (Exception ignored) {
            }
        }
        for (String fieldName : List.of("value", "result")) {
            try {
                var field = type.getDeclaredField(fieldName);
                field.setAccessible(true);
                return field.get(value);
            } catch (Exception ignored) {
            }
        }
        return value;
    }

    private Library buildLibrary(String cqlText, String measureName, String measureVersion) {
        Library library = new Library();
        CqlLibraryMetadata metadata = parseCqlLibraryMetadata(cqlText);
        String libId = metadata.name();
        String resolvedVersion = metadata.version() == null || metadata.version().isBlank() ? measureVersion : metadata.version();
        library.setId(new IdType("Library", libId));
        library.setUrl("http://workwell.local/Library/" + libId);
        library.setVersion(resolvedVersion);
        library.setName(libId);
        library.setTitle(measureName + " Logic Library");
        library.setStatus(Enumerations.PublicationStatus.ACTIVE);
        library.setType(new org.hl7.fhir.r4.model.CodeableConcept().addCoding(
                new org.hl7.fhir.r4.model.Coding()
                        .setSystem("http://terminology.hl7.org/CodeSystem/library-type")
                        .setCode("logic-library")
        ));
        library.addContent(new Attachment().setContentType("text/cql").setData(cqlText.getBytes(StandardCharsets.UTF_8)));
        String elmJson = compileToElmJson(cqlText);
        if (elmJson != null && !elmJson.isBlank()) {
            library.addContent(new Attachment()
                    .setContentType("application/elm+json")
                    .setData(elmJson.getBytes(StandardCharsets.UTF_8)));
        }
        return library;
    }

    private CqlLibraryMetadata parseCqlLibraryMetadata(String cqlText) {
        Pattern pattern = Pattern.compile("(?im)^\\s*library\\s+([A-Za-z0-9_\\-]+)\\s+version\\s+'([^']+)'\\s*$");
        Matcher matcher = pattern.matcher(cqlText);
        if (matcher.find()) {
            return new CqlLibraryMetadata(matcher.group(1), matcher.group(2));
        }
        return new CqlLibraryMetadata("WorkWellLibrary", null);
    }

    private String compileToElmJson(String cqlText) {
        try {
            ModelManager modelManager = new ModelManager();
            LibraryManager libraryManager = new LibraryManager(modelManager);
            libraryManager.getLibrarySourceLoader().registerProvider(new FhirLibrarySourceProvider());
            CqlTranslator translator = CqlTranslator.fromText(cqlText, libraryManager);
            if (!translator.getErrors().isEmpty()) {
                return null;
            }
            return translator.toJson();
        } catch (Exception ex) {
            return null;
        }
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
        measure.getScoring().addCoding()
                .setSystem("http://terminology.hl7.org/CodeSystem/measure-scoring")
                .setCode("proportion");

        Measure.MeasureGroupComponent group = measure.addGroup();
        group.setId(id + "-group");
        group.addPopulation()
                .setCode(new org.hl7.fhir.r4.model.CodeableConcept().addCoding(
                        new org.hl7.fhir.r4.model.Coding()
                                .setSystem("http://terminology.hl7.org/CodeSystem/measure-population")
                                .setCode("initial-population")
                ))
                .setCriteria(new Expression()
                        .setLanguage("text/cql-identifier")
                        .setExpression("Initial Population"));
        group.addPopulation()
                .setCode(new org.hl7.fhir.r4.model.CodeableConcept().addCoding(
                        new org.hl7.fhir.r4.model.Coding()
                                .setSystem("http://terminology.hl7.org/CodeSystem/measure-population")
                                .setCode("denominator")
                ))
                .setCriteria(new Expression()
                        .setLanguage("text/cql-identifier")
                        .setExpression("Initial Population"));
        group.addPopulation()
                .setCode(new org.hl7.fhir.r4.model.CodeableConcept().addCoding(
                        new org.hl7.fhir.r4.model.Coding()
                                .setSystem("http://terminology.hl7.org/CodeSystem/measure-population")
                                .setCode("numerator")
                ))
                .setCriteria(new Expression()
                        .setLanguage("text/cql-identifier")
                        .setExpression("Compliant"));
        return measure;
    }

    private List<SeededInput> seededInputsFor(String measureName) {
        MeasureSeedSpec spec = measureSeedSpecFor(measureName);
        if (spec == null) {
            return List.of();
        }

        List<SyntheticEmployeeCatalog.EmployeeProfile> orderedEmployees = SyntheticEmployeeCatalog.allEmployees().stream()
                .sorted(Comparator.comparingInt(employee -> Math.floorMod((spec.rateKey() + "|" + employee.externalId()).hashCode(), Integer.MAX_VALUE)))
                .toList();
        int populationSize = orderedEmployees.size();
        int compliantCount = Math.max(0, Math.min(populationSize, (int) Math.round(populationSize * complianceRate(spec.rateKey()))));
        int excludedCount = Math.min(EXCLUDED_COUNT, Math.max(0, populationSize - compliantCount));
        int missingCount = Math.min(MISSING_DATA_COUNT, Math.max(0, populationSize - compliantCount - excludedCount));
        int remaining = Math.max(0, populationSize - compliantCount - excludedCount - missingCount);
        int dueSoonCount = remaining / 2;

        List<SeededInput> seededInputs = new ArrayList<>(populationSize);
        for (int i = 0; i < orderedEmployees.size(); i++) {
            SyntheticEmployeeCatalog.EmployeeProfile employee = orderedEmployees.get(i);
            SeededOutcome seededOutcome;
            if (i < compliantCount) {
                seededOutcome = SeededOutcome.COMPLIANT;
            } else if (i < compliantCount + excludedCount) {
                seededOutcome = SeededOutcome.EXCLUDED;
            } else if (i < compliantCount + excludedCount + missingCount) {
                seededOutcome = SeededOutcome.MISSING_DATA;
            } else if (i < compliantCount + excludedCount + missingCount + dueSoonCount) {
                seededOutcome = SeededOutcome.DUE_SOON;
            } else {
                seededOutcome = SeededOutcome.OVERDUE;
            }
            seededInputs.add(input(employee, spec, seededOutcome));
        }
        return seededInputs;
    }

    private double complianceRate(String rateKey) {
        return evaluationPopulationProperties.getComplianceRates().getOrDefault(rateKey, 0.80d);
    }

    private MeasureSeedSpec measureSeedSpecFor(String measureName) {
        return switch (measureName) {
            case "Audiogram" -> new MeasureSeedSpec(
                    "audiogram",
                    "hearing-enrollment",
                    "urn:workwell:vs:hearing-enrollment",
                    "audiogram-waiver",
                    "urn:workwell:vs:audiogram-waiver",
                    "audiogram-procedure",
                    "urn:workwell:vs:audiogram-procedures",
                    false
            );
            case "TB Surveillance" -> new MeasureSeedSpec(
                    "tb_surveillance",
                    "tb-program",
                    "urn:workwell:vs:tb-eligible-roles",
                    "tb-exemption",
                    "urn:workwell:vs:tb-exemption",
                    "tb-screen",
                    "urn:workwell:vs:tb-screening",
                    false
            );
            case "HAZWOPER Surveillance" -> new MeasureSeedSpec(
                    "hazwoper",
                    "hazwoper-program",
                    "urn:workwell:vs:hazwoper-enrollment",
                    "hazwoper-exemption",
                    "urn:workwell:vs:hazwoper-exemption",
                    "hazwoper-exam",
                    "urn:workwell:vs:hazwoper-exams",
                    false
            );
            case FLU_VACCINE_MEASURE_NAME -> new MeasureSeedSpec(
                    "flu_vaccine",
                    "clinical-role",
                    "urn:workwell:vs:clinical-roles",
                    "flu-exemption",
                    "urn:workwell:vs:flu-exemption",
                    "flu-vaccine",
                    "urn:workwell:vs:flu-vaccines",
                    true
            );
            default -> null;
        };
    }

    private SeededInput input(
            SyntheticEmployeeCatalog.EmployeeProfile employee,
            MeasureSeedSpec spec,
            SeededOutcome targetOutcome
    ) {
        Integer daysSinceLastExam = switch (targetOutcome) {
            case COMPLIANT -> 120;
            case DUE_SOON -> 350;
            case OVERDUE -> 430;
            case MISSING_DATA -> null;
            case EXCLUDED -> 500;
        };
        boolean hasWaiver = targetOutcome == SeededOutcome.EXCLUDED;
        SyntheticFhirBundleBuilder.ExamConfig config = new SyntheticFhirBundleBuilder.ExamConfig(
                daysSinceLastExam,
                hasWaiver,
                true,
                spec.enrollmentCode(),
                spec.enrollmentVs(),
                spec.waiverCode(),
                spec.waiverVs(),
                spec.examCode(),
                spec.examVs(),
                spec.useImmunization()
        );
        return new SeededInput(employee, config, targetOutcome.name());
    }

    private record SeededInput(
            SyntheticEmployeeCatalog.EmployeeProfile employee,
            SyntheticFhirBundleBuilder.ExamConfig config,
            String targetOutcomeStatus
    ) {
    }

    private record CqlLibraryMetadata(
            String name,
            String version
    ) {
    }

    private enum SeededOutcome {
        COMPLIANT,
        DUE_SOON,
        OVERDUE,
        MISSING_DATA,
        EXCLUDED
    }

    private record MeasureSeedSpec(
            String rateKey,
            String enrollmentCode,
            String enrollmentVs,
            String waiverCode,
            String waiverVs,
            String examCode,
            String examVs,
            boolean useImmunization
    ) {
    }
}
