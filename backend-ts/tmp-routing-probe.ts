/** TEMP review probe: routing legality + registry coverage for every vendored measure. */
import { officialRoutingProblems } from "./src/wiring/executor-router.ts";
import { MEASURES } from "./src/engine/cql/measure-registry.ts";
import { MEASURE_BINDINGS } from "./src/engine/synthetic/measure-bindings.ts";
import { officialMeasureSemantics } from "./src/wiring/official-measure-semantics.ts";
import { officialMeasurementPeriod } from "./src/wiring/official-executor-adapter.ts";
import { loadOfficialArtifact } from "./src/wiring/official-artifacts.ts";

for (const id of ["cms122", "cms125", "cms2", "cms68", "cms951"]) {
  const problems = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: id } as any);
  const art = loadOfficialArtifact(id);
  console.log(`\n=== ${id} ===`);
  console.log("  officialRoutingProblems:", problems.length === 0 ? "[] (ROUTABLE)" : JSON.stringify(problems, null, 2));
  console.log("  in measure-registry (MEASURES):", id in MEASURES, "| periodMonths:", (MEASURES as any)[id]?.periodMonths ?? "(none → default 12)");
  console.log("  in MEASURE_BINDINGS:", id in MEASURE_BINDINGS);
  console.log("  semantics:", officialMeasureSemantics(id)?.numeratorMeansCompliant);
  console.log("  manifest populationBasis:", (art?.manifest as any)?.populationBasis, "| scoring:", art?.manifest.scoring);
  console.log("  measurement period @2026-07-30:", JSON.stringify(officialMeasurementPeriod(id, "2026-07-30")));
}

console.log("\n=== all five at once ===");
const all = officialRoutingProblems({ WORKWELL_OFFICIAL_MEASURES: "cms122,cms125,cms2,cms68,cms951" } as any);
console.log(all.length === 0 ? "[] (all ROUTABLE)" : JSON.stringify(all, null, 2));
