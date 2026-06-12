/**
 * Build-time CQL → ELM compiler for the WorkWell measures (#106). Pure Node via
 * @cqframework/cql (Kotlin-Multiplatform, NO JVM) — the Path C build step, now
 * Java-free. Emits committed ELM JSON consumed by the runtime engine
 * (src/engine/cql/CqlExecutionEngine).
 *
 *   node scripts/compile-measures.mjs [measures-src-dir] [out-elm-dir]
 *
 * Resources (src/engine/cql/resources): System + FHIR R4 model-info XML and
 * FHIRHelpers CQL — standard, version-stable config (not a Java dependency).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
const root = path.resolve(here, "..");
const resDir = path.join(root, "src/engine/cql/resources");
// Measures are authored as .cql/.yaml text resources (language-agnostic, not Java).
const measuresDir = process.argv[2] ?? path.resolve(root, "../backend/src/main/resources/measures");
const outDir = process.argv[3] ?? path.join(root, "src/engine/cql/elm");
mkdirSync(outDir, { recursive: true });

const systemModelInfoXml = readFileSync(path.join(resDir, "system-modelinfo.xml"), "utf8");
const fhirModelInfoXml = readFileSync(path.join(resDir, "fhir-modelinfo-4.0.1.xml"), "utf8");
const fhirHelpersCql = readFileSync(path.join(resDir, "FHIRHelpers-4.0.1.cql"), "utf8");

function manager() {
  const mm = new ModelManager();
  mm.modelInfoLoader.registerModelInfoProvider(
    createModelInfoProvider((name) =>
      name === "System" ? stringAsSource(systemModelInfoXml) : name === "FHIR" ? stringAsSource(fhirModelInfoXml) : null,
    ),
  );
  const lm = new LibraryManager(mm);
  lm.librarySourceLoader.registerProvider(
    createLibrarySourceProvider((name) => (name === "FHIRHelpers" ? stringAsSource(fhirHelpersCql) : null)),
  );
  return lm;
}

function translate(cqlText, label) {
  const json = CqlTranslator.fromText(cqlText, manager()).toJson();
  if (/"errorSeverity"\s*:\s*"error"/i.test(json)) throw new Error(`CQL translation errors in ${label}`);
  return json;
}

const cqlFiles = readdirSync(measuresDir).filter((f) => f.endsWith(".cql")).sort();
for (const f of cqlFiles) {
  const json = translate(readFileSync(path.join(measuresDir, f), "utf8"), f);
  const id = JSON.parse(json).library.identifier;
  writeFileSync(path.join(outDir, `${id.id}-${id.version}.elm.json`), json);
}
writeFileSync(path.join(outDir, "FHIRHelpers-4.0.1.elm.json"), translate(fhirHelpersCql, "FHIRHelpers-4.0.1"));
console.log(`compiled ${cqlFiles.length} measures + FHIRHelpers → ${path.relative(root, outDir)} (pure Node, no JVM)`);
