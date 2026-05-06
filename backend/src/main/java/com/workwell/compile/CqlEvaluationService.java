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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.r4.model.Attachment;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.CanonicalType;
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
        return switch (measureName) {
            case "Audiogram" -> List.of(
                    input("emp-001", 120, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
                    input("emp-002", 350, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
                    input("emp-006", 420, false, true, "hearing-enrollment", "urn:workwell:vs:hearing-enrollment", "audiogram-waiver", "urn:workwell:vs:audiogram-waiver", "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false),
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

    private record CqlLibraryMetadata(
            String name,
            String version
    ) {
    }
}
