/**
 * A stand-in `fqm-execution` calculator for `fqm-worker.test.ts`, loaded INSIDE the worker thread (a
 * function cannot be posted to one). The first patient bundle's `mode` picks the behaviour.
 */
export async function calculate(
  _measure: unknown,
  patientBundles: Array<{ mode?: string; cpuMs?: number }>,
  options?: { patientSource?: { currentPatient(): { findRecords(profile: string, details: unknown): unknown[] } | undefined } },
) {
  const first = patientBundles[0] ?? {};
  if (first.mode === "narrowed") {
    // Reports what the PatientSource built on THIS side of the thread reads for a blood pressure (#591):
    // -1 when none was built.
    const patient = options?.patientSource?.currentPatient();
    const read = patient
      ? patient.findRecords("http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure", { datatype: "{http://hl7.org/fhir}Observation" }).length
      : -1;
    return { results: [{ patientId: "p0", detailedResults: [{ populationResults: [{ populationType: "initial-population", result: true, read }] }] }] };
  }
  if (first.mode === "throw") throw new Error("fqm could not parse the measure");
  if (first.mode === "exit") process.exit(3); // in a worker this ends the thread, as a fatal crash would
  if (first.mode === "uncaught") {
    // An exception outside any promise the worker awaits: the thread emits `error`, then `exit`.
    setTimeout(() => {
      throw new Error("uncaught inside fqm");
    }, 0);
    return new Promise(() => {});
  }
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
