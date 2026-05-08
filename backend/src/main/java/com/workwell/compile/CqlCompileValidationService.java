package com.workwell.compile;

import java.util.ArrayList;
import java.util.List;
import org.cqframework.cql.cql2elm.CqlCompilerException;
import org.cqframework.cql.cql2elm.CqlTranslator;
import org.cqframework.cql.cql2elm.LibraryManager;
import org.cqframework.cql.cql2elm.ModelManager;
import org.cqframework.cql.cql2elm.model.CompiledLibrary;
import org.cqframework.cql.cql2elm.quick.FhirLibrarySourceProvider;
import org.cqframework.cql.elm.tracking.TrackBack;
import org.hl7.elm.r1.VersionedIdentifier;
import org.springframework.stereotype.Service;

@Service
public class CqlCompileValidationService {

    public CompileResult validate(String cqlText) {
        if (cqlText == null || cqlText.trim().isEmpty()) {
            return new CompileResult("ERROR", List.of(), List.of("CQL body is empty."));
        }

        List<String> warnings = new ArrayList<>();
        List<String> errors = new ArrayList<>();

        try {
            ModelManager modelManager = new ModelManager();
            LibraryManager libraryManager = new LibraryManager(modelManager);
            libraryManager.getLibrarySourceLoader().registerProvider(new FhirLibrarySourceProvider());

            CqlTranslator translator = CqlTranslator.fromText(cqlText, libraryManager);
            for (CqlCompilerException exception : translator.getExceptions()) {
                String message = formatCompilerMessage(exception);
                if (exception.getSeverity() == CqlCompilerException.ErrorSeverity.Warning) {
                    warnings.add(message);
                } else {
                    errors.add(message);
                }
            }

            if (errors.isEmpty()) {
                try {
                    CompiledLibrary translated = translator.getTranslatedLibrary();
                    VersionedIdentifier id = translated == null ? null : translated.getIdentifier();
                    if (id == null || id.getId() == null || id.getId().isBlank()) {
                        warnings.add("Translated CQL did not include a library identifier.");
                    }
                } catch (RuntimeException ex) {
                    errors.add("ERROR: Failed to build translated library: " + ex.getMessage());
                }
            }
        } catch (RuntimeException ex) {
            errors.add("ERROR: CQL validation failed: " + ex.getMessage());
        }

        return new CompileResult(errors.isEmpty() ? "COMPILED" : "ERROR", warnings, errors);
    }

    private String formatCompilerMessage(CqlCompilerException exception) {
        String severity = exception.getSeverity() == CqlCompilerException.ErrorSeverity.Warning ? "WARNING" : "ERROR";
        TrackBack locator = exception.getLocator();
        String location = "";
        if (locator != null && locator.getStartLine() > 0 && locator.getStartChar() > 0) {
            location = "Line " + locator.getStartLine() + ", Column " + locator.getStartChar() + ": ";
        }
        return location + severity + ": " + exception.getMessage();
    }

    public record CompileResult(String status, List<String> warnings, List<String> errors) {
    }
}
