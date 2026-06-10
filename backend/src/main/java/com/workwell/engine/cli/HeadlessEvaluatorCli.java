package com.workwell.engine.cli;

import ca.uhn.fhir.context.FhirContext;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.workwell.compile.CqlEvaluationService;
import com.workwell.compile.EvaluationPopulationProperties;
import com.workwell.engine.model.BundleOutcome;
import com.workwell.engine.synthetic.PropertiesEvaluationConfigProvider;
import com.workwell.engine.synthetic.SyntheticEmployeeDirectory;
import com.workwell.engine.synthetic.SyntheticPatientDataProvider;
import com.workwell.engine.yaml.YamlMeasure;
import com.workwell.engine.yaml.YamlMeasureParser;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.Map;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Patient;
import org.springframework.core.io.ClassPathResource;

/**
 * Headless evaluator: "given this patient bundle and this measure YAML, are they compliant?"
 * Plain Java — no Spring context, no DB, no web server (E2 / #88). Run via:
 *
 * <pre>
 *   ./gradlew.bat evaluateMeasure --args="patient-bundle.json path/to/measure.yaml [--date YYYY-MM-DD]"
 * </pre>
 *
 * Prints {@code {subjectId, measure, evaluationDate, outcome, evidence}} JSON to stdout.
 * Exit codes: 0 success, 1 usage/input error, 2 evaluation error.
 */
public final class HeadlessEvaluatorCli {

    private HeadlessEvaluatorCli() {
    }

    public static void main(String[] args) {
        System.exit(run(args, System.out, System.err));
    }

    static int run(String[] args, PrintStream out, PrintStream err) {
        try {
            if (args.length < 2) {
                err.println("usage: HeadlessEvaluatorCli <patient-bundle.json> <measure.yaml> [--date YYYY-MM-DD]");
                return 1;
            }
            Path bundlePath = Path.of(args[0]);
            Path yamlPath = Path.of(args[1]);
            LocalDate evaluationDate = LocalDate.now();
            for (int i = 2; i < args.length; i++) {
                if ("--date".equals(args[i])) {
                    if (i + 1 >= args.length) {
                        err.println("error: --date requires a YYYY-MM-DD value");
                        return 1;
                    }
                    String dateArg = args[++i];
                    try {
                        evaluationDate = LocalDate.parse(dateArg);
                    } catch (DateTimeParseException ex) {
                        err.println("error: invalid --date value '" + dateArg + "' (expected YYYY-MM-DD)");
                        return 1;
                    }
                } else {
                    err.println("error: unrecognized argument '" + args[i] + "'");
                    return 1;
                }
            }
            if (!Files.isRegularFile(bundlePath) || !Files.isRegularFile(yamlPath)) {
                err.println("error: bundle or measure YAML file not found");
                return 1;
            }

            YamlMeasure measure = new YamlMeasureParser()
                    .parse(Files.readString(yamlPath, StandardCharsets.UTF_8), yamlPath.getFileName().toString());
            String cqlText = readCql(yamlPath, measure.cqlFile());

            Bundle bundle = (Bundle) FhirContext.forR4Cached().newJsonParser()
                    .parseResource(Files.readString(bundlePath, StandardCharsets.UTF_8));
            String subjectId = bundle.getEntry().stream()
                    .map(Bundle.BundleEntryComponent::getResource)
                    .filter(Patient.class::isInstance)
                    .map(resource -> ((Patient) resource).getIdElement().getIdPart())
                    .findFirst()
                    .orElseThrow(() -> new IllegalArgumentException("bundle contains no Patient resource"));

            CqlEvaluationService engine = new CqlEvaluationService(
                    new SyntheticPatientDataProvider(),
                    new SyntheticEmployeeDirectory(),
                    name -> measure.definition(),
                    new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));
            BundleOutcome outcome = engine.evaluateBundle(
                    measure.name(), measure.version(), cqlText, evaluationDate, bundle, subjectId);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("subjectId", outcome.subjectId());
            result.put("measure", measure.name());
            result.put("evaluationDate", evaluationDate.toString());
            result.put("outcome", outcome.outcomeStatus());
            result.put("evidence", Map.of("expressionResults", outcome.expressionResults()));
            out.println(new ObjectMapper().writerWithDefaultPrettyPrinter().writeValueAsString(result));
            return 0;
        } catch (IllegalArgumentException ex) {
            err.println("error: " + ex.getMessage());
            return 1;
        } catch (Exception ex) {
            err.println("evaluation error: " + ex);
            return 2;
        }
    }

    private static String readCql(Path yamlPath, String cqlFile) throws Exception {
        Path sibling = yamlPath.toAbsolutePath().getParent().resolve(cqlFile);
        if (Files.isRegularFile(sibling)) {
            return Files.readString(sibling, StandardCharsets.UTF_8);
        }
        ClassPathResource fallback = new ClassPathResource("measures/" + cqlFile);
        if (fallback.exists()) {
            return new String(fallback.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
        throw new IllegalArgumentException("CQL file '" + cqlFile + "' not found beside the YAML or on the classpath");
    }
}
