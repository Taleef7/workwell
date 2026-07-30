/** TEMP review probe: compare FULL population vectors (incl. denominator-exception) vs MADiE expecteds. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadOfficialMeasureCases } from "./src/standards/official-cases.ts";
import { calculationOptions, hasRetrieveSignal, loadCalculator } from "@workwell/official-executor";

const ALL = [
  "initial-population",
  "denominator",
  "denominator-exclusion",
  "denominator-exception",
  "numerator",
] as const;

function expectedFull(caseDir: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of readdirSync(caseDir).filter((f) => f.toLowerCase().endsWith(".json"))) {
    let r: any;
    try { r = JSON.parse(readFileSync(join(caseDir, f), "utf8")); } catch { continue; }
    if (r?.resourceType !== "MeasureReport") continue;
    for (const p of r.group?.[0]?.population ?? []) {
      const code = p.code?.coding?.[0]?.code;
      if (code) out[code] = p.count;
    }
  }
  return out;
}

const measure = process.argv[2] as any;
const upstreamName = process.argv[3]!;
const loaded = loadOfficialMeasureCases(".official-content", measure);
const calculate: any = await loadCalculator();
const valid = loaded.cases.filter((c: any) => !c.loadError && c.patientId && c.patientBundle);

let output = await calculate(
  loaded.measureBundle as any,
  valid.map((c: any) => c.patientBundle),
  calculationOptions(loaded.measurementPeriod as any, { trustMetaProfile: false }),
);
if (!hasRetrieveSignal(output) && valid.length > 0) {
  output = await calculate(
    loaded.measureBundle as any,
    valid.map((c: any) => c.patientBundle),
    calculationOptions(loaded.measurementPeriod as any, { trustMetaProfile: true }),
  );
}

const byPatient = new Map((output.results ?? []).map((r: any) => [r.patientId, r]));
let mismatchExcep = 0;
let mismatchOther = 0;
const rows: string[] = [];
for (const c of valid as any[]) {
  const res: any = byPatient.get(c.patientId);
  const pops: any[] = res?.detailedResults?.[0]?.populationResults ?? [];
  const actual: Record<string, number> = {};
  for (const p of pops) actual[p.populationType] = p.result ? 1 : 0;
  const exp = expectedFull(join(".official-content/input/tests/measure", upstreamName, c.uuid));
  const diffs = ALL.filter((code) => {
    const e = exp[code];
    const a = actual[code];
    if (e === undefined && a === undefined) return false;
    return (e ?? 0) !== (a ?? 0);
  });
  if (diffs.length) {
    if (diffs.includes("denominator-exception" as any)) mismatchExcep++;
    else mismatchOther++;
    rows.push(
      `  ${c.uuid} [${c.name}] diffs=${diffs.join(",")}\n` +
        `     expected=${ALL.map((k) => `${k}:${exp[k] ?? "-"}`).join(" ")}\n` +
        `     actual  =${ALL.map((k) => `${k}:${actual[k] ?? "-"}`).join(" ")}`,
    );
  }
}
console.log(`\n### ${measure} (${upstreamName}) — ${valid.length} cases, FULL vector incl. DENEXCEP`);
console.log(`  mismatches involving denominator-exception: ${mismatchExcep}`);
console.log(`  other mismatches: ${mismatchOther}`);
for (const r of rows) console.log(r);
