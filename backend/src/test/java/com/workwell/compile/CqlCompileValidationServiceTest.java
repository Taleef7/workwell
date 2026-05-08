package com.workwell.compile;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.util.FileCopyUtils;

class CqlCompileValidationServiceTest {

    private final CqlCompileValidationService service = new CqlCompileValidationService();

    @Test
    void allSeededMeasuresCompileCleanly() throws Exception {
        List<String> files = List.of(
                "measures/audiogram.cql",
                "measures/tb_surveillance.cql",
                "measures/hazwoper.cql",
                "measures/flu_vaccine.cql"
        );

        for (String file : files) {
            String cql = readClasspathText(file);
            CqlCompileValidationService.CompileResult result = service.validate(cql);
            assertEquals("COMPILED", result.status(), "Expected COMPILED for " + file + " but got errors: " + result.errors());
            assertTrue(result.errors().isEmpty(), "Expected empty errors for " + file + " but got: " + result.errors());
        }
    }

    @Test
    void compileErrorsIncludeLineAndColumnInformation() {
        String invalidCql = """
                library Broken version '1.0.0'

                define "Broken Expression": true and
                """;

        CqlCompileValidationService.CompileResult result = service.validate(invalidCql);

        assertEquals("ERROR", result.status());
        assertTrue(
                result.errors().stream().anyMatch(error -> error.matches("(?i).*line\\s+\\d+.*column\\s+\\d+.*")),
                () -> "Expected at least one compile error to include line and column information but got: " + result.errors()
        );
    }

    private String readClasspathText(String resourcePath) throws Exception {
        ClassPathResource resource = new ClassPathResource(resourcePath);
        return FileCopyUtils.copyToString(new java.io.InputStreamReader(resource.getInputStream(), StandardCharsets.UTF_8));
    }
}
