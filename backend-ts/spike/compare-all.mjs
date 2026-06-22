/**
 * Multi-measure CQL Path C golden parity (#106): all 10 runnable measures × 4
 * scenarios, Node (cql-execution over Java-translated ELM) vs the Java engine
 * (_java_golden.json), define-by-define. Exit 0 iff every define matches.
 *
 *   node spike/compare-all.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cql from "cql-execution";
import cqlfhir from "cql-exec-fhir";

const here = path.dirname(fileURLToPath(import.meta.url));
// Optional arg: ELM dir override (e.g. spike/elm-js for the pure-Node @cqframework/cql build).
const elmDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(here, "elm");
const synthRoot = path.join(here, "synthetic");

const index = JSON.parse(readFileSync(path.join(synthRoot, "_index.json"), "utf8"));
const golden = JSON.parse(readFileSync(path.join(synthRoot, "_java_golden.json"), "utf8"));
const fhirHelpersElm = JSON.parse(readFileSync(path.join(elmDir, "FHIRHelpers-4.0.1.elm.json"), "utf8"));

const EVAL = index.evalDate; // "2026-06-12"
const evalEodIso = `${EVAL}T23:59:59.0`;
const minus12moIso = `${new Date(Date.parse(`${EVAL}T00:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.0`;
const execDateTime = cql.DateTime.parse(`${EVAL}T00:00:00.0`);

function measurementPeriod(measureId) {
  // The Java engine uses a 12-month window for flu (occurrence "during" MP) and a
  // single-day window otherwise (unused by those measures). Match it exactly.
  const startIso = measureId === "flu_vaccine" ? minus12moIso : `${EVAL}T00:00:00.0`;
  return new cql.Interval(cql.DateTime.parse(startIso), cql.DateTime.parse(evalEodIso), true, true);
}

/**
 * Normalize a value from either engine. Scalars (bool/number/string/date) compare
 * directly. Non-scalar intermediate defines — a raw FHIR Observation/Quantity that
 * Java renders as `org.hl7.fhir...@hash` and Node as `[object Object]` — are NOT
 * part of the outcome contract; collapse both to `[opaque-object]` so the
 * comparison rests on the scalar/boolean/outcome defines that drive results.
 */
function norm(v) {
  if (v == null) return null;
  if (typeof v === "boolean" || typeof v === "number") return v;
  let s = String(typeof v === "object" ? (v.value ?? v.toString()) : v);
  if (/^[\w.$]+@[0-9a-f]+$/.test(s)) return "[opaque-object]"; // Java FHIR object toString
  if (s === "[object Object]") return "[opaque-object]"; // Node FHIR object
  const m = s.match(/\[(.+)\]$/);
  if (m) s = m[1];
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}T/.test(s)) return new Date(t).toISOString();
  return s;
}

async function nodeDefines(measure, scenario) {
  const elm = JSON.parse(readFileSync(path.join(elmDir, `${measure.lib}.elm.json`), "utf8"));
  const library = new cql.Library(elm, new cql.Repository({ FHIRHelpers: fhirHelpersElm }));
  const executor = new cql.Executor(library, new cql.CodeService({}), { "Measurement Period": measurementPeriod(measure.id) });
  const ps = cqlfhir.PatientSource.FHIRv401();
  ps.loadBundles([JSON.parse(readFileSync(path.join(synthRoot, measure.id, `${scenario}.json`), "utf8"))]);
  const results = await executor.exec(ps, execDateTime);
  const defines = Object.values(results.patientResults)[0] ?? {};
  const out = {};
  for (const [k, v] of Object.entries(defines)) if (k !== "Patient") out[k] = norm(v);
  return out;
}

function javaDefines(measureId, scenario) {
  const out = {};
  for (const { define, result } of golden[measureId][scenario].expressionResults) {
    if (define !== "Patient") out[define] = norm(result);
  }
  return out;
}

let scenarioCount = 0;
let defineCount = 0;
let failures = 0;
for (const measure of index.measures) {
  // Measures added after the JVM was retired (adult_immunization + the E10 vaccine panel) have no
  // entry in the frozen _java_golden.json — skip them rather than crash. compare-all only validates
  // the measures whose Java outcomes were captured before the JVM was removed.
  if (!golden[measure.id]) {
    console.log(`  - ${measure.id}: skipped (no Java golden; added post-JVM)`);
    continue;
  }
  for (const scenario of measure.scenarios) {
    scenarioCount++;
    const java = javaDefines(measure.id, scenario);
    const node = await nodeDefines(measure, scenario);
    const keys = [...new Set([...Object.keys(java), ...Object.keys(node)])].sort();
    const diffs = [];
    for (const k of keys) {
      defineCount++;
      if (JSON.stringify(java[k]) !== JSON.stringify(node[k]))
        diffs.push(`      ✗ ${k}: java=${JSON.stringify(java[k])} node=${JSON.stringify(node[k])}`);
    }
    const ok = diffs.length === 0;
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${measure.id}/${scenario}  →  ${java["Outcome Status"]}`);
    for (const d of diffs) console.log(d);
  }
}

console.log(
  `\n${failures === 0 ? "✅" : "❌"} ${scenarioCount - failures}/${scenarioCount} scenarios match Java exactly ` +
    `(${defineCount} define comparisons, 10 measures × 4 scenarios)`,
);
process.exit(failures === 0 ? 0 : 1);
