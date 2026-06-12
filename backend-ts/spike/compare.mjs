/**
 * CQL Path C golden-parity check (#103, the GO/NO-GO gate).
 *
 * For each scenario it compares, define-by-define:
 *   - the JAVA engine output  (spike/golden/<name>.json, from HeadlessEvaluatorCli)
 *   - the NODE engine output  (cql-execution over the Java-translated ELM)
 * against the SAME FHIR bundle and the SAME pinned evaluation date.
 *
 * Exit code 0 iff every define of every scenario matches exactly.
 *   node spike/compare.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cql from "cql-execution";
import cqlfhir from "cql-exec-fhir";

const here = path.dirname(fileURLToPath(import.meta.url));
const elmDir = path.join(here, "elm");
const DATE = "2026-06-12";
const SCENARIOS = ["compliant", "due_soon", "overdue", "missing_data", "excluded"];

const measureElm = JSON.parse(readFileSync(path.join(elmDir, "AnnualAudiogramCompleted-1.0.0.elm.json"), "utf8"));
const fhirHelpersElm = JSON.parse(readFileSync(path.join(elmDir, "FHIRHelpers-4.0.1.elm.json"), "utf8"));

/** Normalize a value from either engine to a comparable primitive. */
function norm(v) {
  if (v == null) return null;
  if (typeof v === "boolean" || typeof v === "number") return v;
  let s = typeof v === "object" ? (v.value ?? v.toString()) : String(v);
  s = String(s);
  // Java renders DateTime as "DateTimeType[2026-03-04T00:00:00.000Z]"
  const m = s.match(/\[(.+)\]$/);
  if (m) s = m[1];
  // If it parses as a date, compare on the absolute instant (Z vs +00:00 agnostic).
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(t).toISOString();
  return s;
}

function javaDefines(name) {
  const raw = readFileSync(path.join(here, "golden", `${name}.json`), "utf8");
  const json = JSON.parse(raw.slice(raw.indexOf("{"))); // strip HAPI log prefix
  const out = {};
  for (const { define, result } of json.evidence.expressionResults) {
    if (define === "Patient") continue;
    out[define] = norm(result);
  }
  return out;
}

async function nodeDefines(name) {
  const library = new cql.Library(measureElm, new cql.Repository({ FHIRHelpers: fhirHelpersElm }));
  const executor = new cql.Executor(library, new cql.CodeService({}), {});
  const ps = cqlfhir.PatientSource.FHIRv401();
  ps.loadBundles([JSON.parse(readFileSync(path.join(here, "bundles", `${name}.json`), "utf8"))]);
  const results = await executor.exec(ps, cql.DateTime.parse(`${DATE}T00:00:00.0`));
  const defines = Object.values(results.patientResults)[0] ?? {};
  const out = {};
  for (const [k, v] of Object.entries(defines)) {
    if (k === "Patient") continue;
    out[k] = norm(v);
  }
  return out;
}

let failures = 0;
for (const name of SCENARIOS) {
  const java = javaDefines(name);
  const node = await nodeDefines(name);
  const keys = [...new Set([...Object.keys(java), ...Object.keys(node)])].sort();
  const diffs = [];
  for (const k of keys) {
    const a = JSON.stringify(java[k]);
    const b = JSON.stringify(node[k]);
    if (a !== b) diffs.push(`    ✗ ${k}: java=${a} node=${b}`);
  }
  const status = diffs.length === 0 ? "PASS" : "FAIL";
  if (diffs.length) failures++;
  console.log(`${status}  ${name.padEnd(13)} outcome=${java["Outcome Status"]}  (${keys.length} defines)`);
  for (const d of diffs) console.log(d);
}

console.log(`\n${failures === 0 ? "✅ GOLDEN PARITY: all scenarios match Java exactly" : `❌ ${failures} scenario(s) diverged`}`);
process.exit(failures === 0 ? 0 : 1);
