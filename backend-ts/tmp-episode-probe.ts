/** TEMP review probe: what does fqm return for the Encounter-basis measure (cms68)? */
import { loadOfficialMeasureCases } from "./src/standards/official-cases.ts";
import { calculationOptions, hasRetrieveSignal, loadCalculator } from "@workwell/official-executor";

const loaded = loadOfficialMeasureCases(".official-content", "cms68" as any);
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

const r: any = output.results?.[0];
console.log("subject keys:", Object.keys(r ?? {}));
const dr: any = r?.detailedResults?.[0];
console.log("detailedResults[0] keys:", Object.keys(dr ?? {}));
console.log("populationResults:", JSON.stringify(dr?.populationResults?.map((p: any) => ({ t: p.populationType, r: p.result })), null, 1));
console.log("episodeResults present:", Array.isArray(dr?.episodeResults), "count:", dr?.episodeResults?.length);
if (dr?.episodeResults?.length) {
  console.log("episodeResults[0]:", JSON.stringify(dr.episodeResults[0], null, 1).slice(0, 900));
}
// How many subjects have >1 episode?
let multi = 0;
for (const s of output.results ?? []) {
  const n = (s as any)?.detailedResults?.[0]?.episodeResults?.length ?? 0;
  if (n > 1) multi++;
}
console.log(`subjects with >1 episode across all ${output.results?.length} cases:`, multi);
