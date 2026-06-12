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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Patient;

/**
 * Batch golden generator for the multi-measure parity check (#106). For every
 * {@code synthetic/<measureId>/<scenario>.json} bundle, evaluates it against
 * {@code <measuresDir>/<measureId>.yaml} with the Java engine and writes the
 * outcome + define-level results to {@code synthetic/_java_golden.json} — one JVM.
 *
 * <pre>
 *   ./gradlew.bat batchEvaluate --args="src/main/resources/measures ../backend-ts/spike/synthetic 2026-06-12"
 * </pre>
 */
public final class BatchEvaluateCli {

    private BatchEvaluateCli() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 3) {
            System.err.println("usage: BatchEvaluateCli <measures-yaml-dir> <synthetic-root> <YYYY-MM-DD>");
            System.exit(1);
            return;
        }
        Path measuresDir = Path.of(args[0]);
        Path syntheticRoot = Path.of(args[1]);
        LocalDate evalDate = LocalDate.parse(args[2]);
        ObjectMapper mapper = new ObjectMapper();

        Map<String, Object> golden = new LinkedHashMap<>();
        List<Path> measureDirs;
        try (Stream<Path> s = Files.list(syntheticRoot)) {
            measureDirs = s.filter(Files::isDirectory).sorted().toList();
        }

        for (Path measureDir : measureDirs) {
            String measureId = measureDir.getFileName().toString();
            Path yamlPath = measuresDir.resolve(measureId + ".yaml");
            if (!Files.isRegularFile(yamlPath)) {
                System.err.println("skip " + measureId + " (no " + yamlPath.getFileName() + ")");
                continue;
            }
            YamlMeasure measure = new YamlMeasureParser()
                    .parse(Files.readString(yamlPath, StandardCharsets.UTF_8), yamlPath.getFileName().toString());
            String cqlText = Files.readString(measuresDir.resolve(measure.cqlFile()), StandardCharsets.UTF_8);

            CqlEvaluationService engine = new CqlEvaluationService(
                    new SyntheticPatientDataProvider(),
                    new SyntheticEmployeeDirectory(),
                    name -> measure.definition(),
                    new PropertiesEvaluationConfigProvider(new EvaluationPopulationProperties()));

            Map<String, Object> perScenario = new LinkedHashMap<>();
            List<Path> bundles;
            try (Stream<Path> s = Files.list(measureDir)) {
                bundles = s.filter(p -> p.toString().endsWith(".json")).sorted().toList();
            }
            for (Path bundlePath : bundles) {
                String scenario = bundlePath.getFileName().toString().replace(".json", "");
                Bundle bundle = (Bundle) FhirContext.forR4Cached().newJsonParser()
                        .parseResource(Files.readString(bundlePath, StandardCharsets.UTF_8));
                String subjectId = bundle.getEntry().stream()
                        .map(Bundle.BundleEntryComponent::getResource)
                        .filter(Patient.class::isInstance)
                        .map(r -> ((Patient) r).getIdElement().getIdPart())
                        .findFirst().orElseThrow();
                BundleOutcome outcome = engine.evaluateBundle(
                        measure.name(), measure.version(), cqlText, evalDate, bundle, subjectId);
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("outcome", outcome.outcomeStatus());
                row.put("expressionResults", outcome.expressionResults());
                perScenario.put(scenario, row);
                System.out.println(measureId + "/" + scenario + " -> " + outcome.outcomeStatus());
            }
            golden.put(measureId, perScenario);
        }

        Path out = syntheticRoot.resolve("_java_golden.json");
        Files.writeString(out, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(golden), StandardCharsets.UTF_8);
        System.out.println("wrote " + out.toAbsolutePath());
    }
}
