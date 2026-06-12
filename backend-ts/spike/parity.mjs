/**
 * CQL Path C parity harness (#103). Executes the Java-translated ELM in Node via
 * cql-execution + cql-exec-fhir, with the evaluation timestamp pinned to match
 * the Java engine's --date, and prints the define-level results so they can be
 * compared to the Java golden output (HeadlessEvaluatorCli).
 *
 *   node spike/parity.mjs <bundle.json> [YYYY-MM-DD]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cql from "cql-execution";
import cqlfhir from "cql-exec-fhir";

const here = path.dirname(fileURLToPath(import.meta.url));
const elmDir = path.join(here, "elm");

const bundlePath = process.argv[2] ?? path.join(here, "bundles", "compliant.json");
const dateArg = process.argv[3] ?? "2026-06-12";

const measureElm = JSON.parse(readFileSync(path.join(elmDir, "AnnualAudiogramCompleted-1.0.0.elm.json"), "utf8"));
const fhirHelpersElm = JSON.parse(readFileSync(path.join(elmDir, "FHIRHelpers-4.0.1.elm.json"), "utf8"));

const library = new cql.Library(measureElm, new cql.Repository({ FHIRHelpers: fhirHelpersElm }));
const codeService = new cql.CodeService({}); // inline codes — no value-set expansion needed
const executor = new cql.Executor(library, codeService, {});

const patientSource = cqlfhir.PatientSource.FHIRv401();
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
patientSource.loadBundles([bundle]);

// Pin Now()/Today() to the same instant the Java run used (--date, midnight UTC).
const executionDateTime = cql.DateTime.parse(`${dateArg}T00:00:00.0`);

const results = await executor.exec(patientSource, executionDateTime);

const render = (v) => {
  if (v == null) return null;
  if (typeof v === "object" && typeof v.toString === "function" && (v.isDateTime || v.isDate)) return v.toString();
  return v;
};

const out = {};
for (const [pid, defines] of Object.entries(results.patientResults)) {
  out[pid] = {};
  for (const [name, value] of Object.entries(defines)) {
    if (name === "Patient") continue;
    out[pid][name] = render(value);
  }
}
console.log(JSON.stringify(out, null, 2));
