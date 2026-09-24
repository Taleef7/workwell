/**
 * A stand-in `fqm-execution` calculator for `fqm-worker.test.ts`, loaded INSIDE the worker thread (a
 * function cannot be posted to one). The first patient bundle's `mode` picks the behaviour.
 */
export async function calculate(_measure: unknown, patientBundles: Array<{ mode?: string; cpuMs?: number }>) {
  const first = patientBundles[0] ?? {};
  if (first.mode === "throw") throw new Error("fqm could not parse the measure");
  if (first.mode === "exit") process.exit(3); // in a worker this ends the thread, as a fatal crash would
  if (first.mode === "busy") {
    // Synchronous CPU, like fqm's own loop: nothing yields until it is done.
    const until = Date.now() + (first.cpuMs ?? 1000);
    while (Date.now() < until) {
      /* spin */
    }
  }
  return {
    results: patientBundles.map((_, i) => ({
      patientId: `p${i}`,
      detailedResults: [{ populationResults: [{ populationType: "initial-population", criteriaExpression: "Initial Population", result: true }] }],
      evaluatedResource: [{ resourceType: "Encounter" }],
    })),
  };
}
