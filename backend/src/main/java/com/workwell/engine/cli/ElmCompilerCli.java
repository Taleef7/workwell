package com.workwell.engine.cli;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Stream;
import org.cqframework.cql.cql2elm.CqlCompilerException;
import org.cqframework.cql.cql2elm.CqlTranslator;
import org.cqframework.cql.cql2elm.LibraryManager;
import org.cqframework.cql.cql2elm.ModelManager;
import org.cqframework.cql.cql2elm.quick.FhirLibrarySourceProvider;
import org.hl7.elm.r1.VersionedIdentifier;

/**
 * Build-time CQL → ELM JSON translator — the only Java on the Path C path (ADR-008 / issue #96).
 * Plain Java, no Spring, no DB. Emits ELM JSON that the TypeScript backend executes in Node via
 * cql-execution (so the JVM is absent from the runtime/deploy path). Also emits FHIRHelpers ELM,
 * the one dependency the WorkWell measures include.
 *
 * <pre>
 *   ./gradlew.bat generateElm --args="src/main/resources/measures/audiogram.cql ../backend-ts/spike/elm"
 * </pre>
 */
public final class ElmCompilerCli {

    private ElmCompilerCli() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: ElmCompilerCli <input.cql | measures-dir> <output-dir>");
            System.exit(1);
            return;
        }
        Path input = Path.of(args[0]);
        Path outDir = Path.of(args[1]);
        Files.createDirectories(outDir);

        // 1) the measure libraries — a single .cql, or every .cql in a directory
        List<Path> cqlFiles;
        if (Files.isDirectory(input)) {
            try (Stream<Path> s = Files.list(input)) {
                cqlFiles = s.filter(p -> p.toString().endsWith(".cql")).sorted().toList();
            }
        } else {
            cqlFiles = List.of(input);
        }
        for (Path cqlPath : cqlFiles) {
            translateAndWrite(Files.readString(cqlPath, StandardCharsets.UTF_8), outDir, null);
        }

        // 2) FHIRHelpers 4.0.1 (included by every WorkWell measure) — cql-execution needs its ELM too
        FhirLibrarySourceProvider provider = new FhirLibrarySourceProvider();
        try (InputStream src = provider.getLibrarySource(
                new VersionedIdentifier().withId("FHIRHelpers").withVersion("4.0.1"))) {
            if (src == null) {
                throw new IllegalStateException("FHIRHelpers 4.0.1 source not found on the classpath");
            }
            translateAndWrite(new String(src.readAllBytes(), StandardCharsets.UTF_8), outDir, "FHIRHelpers-4.0.1");
        }
        System.out.println("ELM written to " + outDir.toAbsolutePath());
    }

    private static void translateAndWrite(String cqlText, Path outDir, String forcedName) throws Exception {
        ModelManager modelManager = new ModelManager();
        LibraryManager libraryManager = new LibraryManager(modelManager);
        libraryManager.getLibrarySourceLoader().registerProvider(new FhirLibrarySourceProvider());

        CqlTranslator translator = CqlTranslator.fromText(cqlText, libraryManager);
        boolean error = false;
        for (CqlCompilerException ex : translator.getExceptions()) {
            if (ex.getSeverity() == CqlCompilerException.ErrorSeverity.Error) {
                error = true;
                System.err.println("ERROR: " + ex.getMessage());
            }
        }
        if (error) {
            throw new IllegalStateException("CQL translation failed");
        }

        VersionedIdentifier id = translator.getTranslatedLibrary().getIdentifier();
        String name = forcedName != null ? forcedName : id.getId() + "-" + id.getVersion();
        Path out = outDir.resolve(name + ".elm.json");
        Files.writeString(out, translator.toJson(), StandardCharsets.UTF_8);
        System.out.println("wrote " + out.getFileName());
    }
}
