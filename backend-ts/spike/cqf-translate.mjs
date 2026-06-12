/**
 * Pure-Node CQL → ELM translation via @cqframework/cql (Kotlin-Multiplatform JS
 * build — NO JVM). Investigates whether the *last* Java dependency (the build-time
 * CQL→ELM translator, ElmCompilerCli) can be eliminated entirely (#96 end-state).
 *
 * Supplies the two standard static resources the translator needs (committed once,
 * not a Java dependency): FHIR R4 model-info XML + FHIRHelpers 4.0.1 CQL.
 *
 *   node spike/cqf-translate.mjs <measure.cql> <out-dir>
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ModelManager,
  LibraryManager,
  CqlTranslator,
  createModelInfoProvider,
  createLibrarySourceProvider,
  stringAsSource,
} from "@cqframework/cql/cql-to-elm";

const here = path.dirname(fileURLToPath(import.meta.url));
const res = path.join(here, "cqf-resources");
const modelInfoXml = readFileSync(path.join(res, "fhir-modelinfo-4.0.1.xml"), "utf8");
const systemModelInfoXml = readFileSync(path.join(res, "system-modelinfo.xml"), "utf8");
const fhirHelpersCql = readFileSync(path.join(res, "FHIRHelpers-4.0.1.cql"), "utf8");

const cqlPath = process.argv[2] ?? path.resolve(here, "../../backend/src/main/resources/measures/audiogram.cql");
const outDir = process.argv[3] ?? path.join(here, "elm-js");
mkdirSync(outDir, { recursive: true });

function newManager() {
  const modelManager = new ModelManager();
  modelManager.modelInfoLoader.registerModelInfoProvider(
    createModelInfoProvider((name) => {
      if (name === "System") return stringAsSource(systemModelInfoXml);
      if (name === "FHIR") return stringAsSource(modelInfoXml);
      return null;
    }),
  );
  const libraryManager = new LibraryManager(modelManager);
  libraryManager.librarySourceLoader.registerProvider(
    createLibrarySourceProvider((name) => (name === "FHIRHelpers" ? stringAsSource(fhirHelpersCql) : null)),
  );
  return libraryManager;
}

function translate(cqlText, label) {
  const translator = CqlTranslator.fromText(cqlText, newManager());
  let errorCount = 0;
  try {
    const errs = translator.errors;
    errorCount = errs ? (errs.size ?? errs.size_0 ?? 0) : 0;
  } catch {
    /* Kotlin list interop — fall back to scanning the ELM for error annotations */
  }
  const json = translator.toJson();
  if (/"errorSeverity"\s*:\s*"error"/i.test(json)) errorCount = Math.max(errorCount, 1);
  console.log(`  translated ${label}: ${json.length} bytes, errors=${errorCount}`);
  if (errorCount > 0) throw new Error(`translation of ${label} reported errors`);
  return json;
}

// Accept a single .cql or a directory of measures.
const cqlFiles = statSync(cqlPath).isDirectory()
  ? readdirSync(cqlPath).filter((f) => f.endsWith(".cql")).sort().map((f) => path.join(cqlPath, f))
  : [cqlPath];

for (const f of cqlFiles) {
  const measureJson = translate(readFileSync(f, "utf8"), path.basename(f));
  const libId = JSON.parse(measureJson).library.identifier;
  writeFileSync(path.join(outDir, `${libId.id}-${libId.version}.elm.json`), measureJson);
}

const fhirHelpersJson = translate(fhirHelpersCql, "FHIRHelpers-4.0.1");
writeFileSync(path.join(outDir, "FHIRHelpers-4.0.1.elm.json"), fhirHelpersJson);

console.log(`ELM (pure Node, no JVM) for ${cqlFiles.length} measure(s) written to ${outDir}`);
