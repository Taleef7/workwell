package com.workwell.engine.cli;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ca.uhn.fhir.context.FhirContext;
import com.workwell.compile.SyntheticFhirBundleBuilder;
import com.workwell.measure.SyntheticEmployeeCatalog.EmployeeProfile;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import org.hl7.fhir.r4.model.Bundle;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

class HeadlessEvaluatorCliTest {

    @TempDir
    Path tempDir;

    @Test
    void patientPlusYamlYieldsOutcomeJson() throws Exception {
        // Stage measure YAML + CQL side by side in a temp dir (CWD-independent).
        Path yamlPath = copyClasspath("measures/audiogram.yaml", tempDir.resolve("audiogram.yaml"));
        copyClasspath("measures/audiogram.cql", tempDir.resolve("audiogram.cql"));

        // A compliant patient bundle, serialized to JSON.
        EmployeeProfile employee = new EmployeeProfile("headless-cli-001", "CLI Test", "Welder", "Plant A");
        SyntheticFhirBundleBuilder.ExamConfig config = new SyntheticFhirBundleBuilder.ExamConfig(
                100, false, true,
                "hearing-enrollment", "urn:workwell:vs:hearing-enrollment",
                "audiogram-waiver", "urn:workwell:vs:audiogram-waiver",
                "audiogram-procedure", "urn:workwell:vs:audiogram-procedures", false);
        Bundle bundle = new SyntheticFhirBundleBuilder().buildBundle(employee, config, LocalDate.now());
        Path bundlePath = tempDir.resolve("patient.json");
        Files.writeString(bundlePath,
                FhirContext.forR4Cached().newJsonParser().encodeResourceToString(bundle),
                StandardCharsets.UTF_8);

        ByteArrayOutputStream stdout = new ByteArrayOutputStream();
        int exit = HeadlessEvaluatorCli.run(
                new String[]{bundlePath.toString(), yamlPath.toString()},
                new PrintStream(stdout, true, StandardCharsets.UTF_8), System.err);

        String json = stdout.toString(StandardCharsets.UTF_8);
        assertEquals(0, exit, json);
        assertTrue(json.contains("\"outcome\" : \"COMPLIANT\"") || json.contains("\"outcome\":\"COMPLIANT\""), json);
        assertTrue(json.contains("headless-cli-001"), json);
        assertTrue(json.contains("expressionResults"), json);
    }

    @Test
    void usageErrorReturnsExitCode1() {
        ByteArrayOutputStream stderr = new ByteArrayOutputStream();
        int exit = HeadlessEvaluatorCli.run(new String[]{}, System.out,
                new PrintStream(stderr, true, StandardCharsets.UTF_8));
        assertEquals(1, exit);
        assertTrue(stderr.toString(StandardCharsets.UTF_8).contains("usage:"));
    }

    @Test
    void missingFilesReturnExitCode1() {
        ByteArrayOutputStream stderr = new ByteArrayOutputStream();
        int exit = HeadlessEvaluatorCli.run(
                new String[]{tempDir.resolve("nope.json").toString(), tempDir.resolve("nope.yaml").toString()},
                System.out, new PrintStream(stderr, true, StandardCharsets.UTF_8));
        assertEquals(1, exit);
    }

    private Path copyClasspath(String resource, Path target) throws Exception {
        String text = FileCopyUtils.copyToString(new java.io.InputStreamReader(
                new ClassPathResource(resource).getInputStream(), StandardCharsets.UTF_8));
        Files.writeString(target, text, StandardCharsets.UTF_8);
        return target;
    }
}
