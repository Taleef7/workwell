// Generates measures/generated/<id>.cql from each measure YAML's `rule:` block (E11.1). The hand-written
// measures/<id>.cql remains the build source — this generated output is the parity-proof artifact.
//   node --import tsx scripts/gen-cql.mjs
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateCql } from "../src/engine/cql/codegen/generate-cql.ts";
import { MEASURES } from "../src/engine/cql/measure-registry.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const measuresDir = path.join(root, "measures");
const outDir = path.join(measuresDir, "generated");
mkdirSync(outDir, { recursive: true });

const line = (s, key) => s.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, "m"))?.[1].trim();
const inField = (block, k) => block?.match(new RegExp(`${k}:\\s*"?([^,"}]+?)"?\\s*[,}]`))?.[1].trim() ?? null;
const codeOf = (s, key) => { const b = line(s, key); return b ? { code: inField(b, "code"), valueSet: inField(b, "valueSet"), type: inField(b, "type") ?? undefined } : null; };

let count = 0;
for (const f of readdirSync(measuresDir).filter((x) => x.endsWith(".yaml")).sort()) {
  const s = readFileSync(path.join(measuresDir, f), "utf8");
  const ruleType = line(s, "type"); // the `rule:` block's type is the file's only top-level `type:` line
  if (ruleType !== "series-completion" && ruleType !== "windowed-recency") continue; // opt-in
  const id = line(s, "id");
  const meta = MEASURES[id];
  if (!meta) throw new Error(`measure '${id}' has a rule: block but no registry entry`);
  const [library, version] = meta.library.split(/-(?=[0-9])/); // "MmrSeries-1.0.0" → ["MmrSeries","1.0.0"]

  const enrollment = codeOf(s, "enrollment");
  const waiver = codeOf(s, "waiver");
  const event = codeOf(s, "event");
  const refusal = codeOf(s, "refusal");
  const bindings = { enrollment, waiver, event, ...(refusal ? { refusal } : {}) };

  // E11.2a added optional codegen capabilities — titer (allowPositiveTiter + a titer binding), grace
  // (gracePeriodDays), and a windowed Refused define. They are intentionally NOT parsed here yet: no
  // committed measure YAML sets them. When the E11.2b Rule Builder UI emits them, wire them in here.
  const rule = ruleType === "series-completion"
    ? { type: "series-completion", requiredDoses: Number(line(s, "requiredDoses") ?? 2) }
    : { type: "windowed-recency", windowDays: Number(line(s, "windowDays") ?? 365), dueSoonDays: Number(line(s, "dueSoonDays") ?? 30) };

  const cql = generateCql({ library, version, rule, bindings });
  writeFileSync(path.join(outDir, `${id}.cql`), cql, "utf8");
  count++;
}
console.log(`gen-cql: wrote ${count} generated CQL file(s) to measures/generated/`);
