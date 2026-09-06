/**
 * The corpus as a `SubjectBundleSource` — the seam the run pipeline evaluates through (spec §4).
 *
 * This lives in `wiring/`, not in `engine/synthetic/corpus/` with the generator it calls: implementing
 * an app-side port is wiring by definition, and the engine boundary test refuses the import that would
 * be needed the other way round.
 *
 * The corpus is DATA-FIRST: it emits clinical facts at population rates and CQL decides every
 * outcome (docs/AI_GUARDRAILS.md §1). So there is no seeded bucket to honour here, and the bundle a
 * subject carries does not depend on which measure is asking — one whole record answers all six.
 */
import type { EmployeeProfile } from "../engine/synthetic/employee-catalog.ts";
import type { FhirBundle } from "../engine/synthetic/fhir-bundle-builder.ts";
import type { TargetOutcome } from "../engine/synthetic/exam-config.ts";
import type { SeededAssignment } from "../run/distribution.ts";
import type { SubjectBundleSource } from "./subject-bundle-source.ts";
import { DEFAULT_CORPUS_SEED } from "../engine/synthetic/corpus/corpus-parameters.ts";
import { patientAt } from "../engine/synthetic/corpus/corpus-patient.ts";
import { bundleForPatient } from "../engine/synthetic/corpus/corpus-bundle.ts";

/**
 * `pat-001..pat-048` (the fixture prefix) and `pat-00049..` (generated) both encode their own index.
 * The parsed index is VERIFIED by regenerating the record and comparing ids, so a three-digit id past
 * the prefix or a five-digit id inside it is rejected rather than silently resolving to a neighbour.
 */
export function corpusIndexOf(externalId: string): number | null {
  const match = /^pat-(\d{3,5})$/.exec(externalId);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  if (index < 0) return null;
  return patientAt(DEFAULT_CORPUS_SEED, index).externalId === externalId ? index : null;
}

export function corpusBundleSource(seed: string = DEFAULT_CORPUS_SEED): SubjectBundleSource {
  const bundleForSubject = (employee: EmployeeProfile, evaluationDate: string): FhirBundle => {
    const index = corpusIndexOf(employee.externalId);
    if (index === null) {
      throw new Error(`[workwell] ${employee.externalId} is not a corpus subject — the Maui roster is the corpus (spec §4)`);
    }
    // The NAME is the one field a standalone `patientAt` may render differently from a full
    // generation, because disambiguation depends on who came before (see `patientAt`'s note). The
    // directory already resolved it, so take it from there rather than regenerating the whole prefix.
    const patient = { ...patientAt(seed, index), name: employee.name };
    return bundleForPatient(patient, evaluationDate, seed) as unknown as FhirBundle;
  };

  return {
    // Every subject is evaluated, and the target is threaded through unused: the corpus decides
    // nothing about an outcome, so there is no bucket to assign. COMPLIANT is the inert value the
    // pipeline's signature requires, NOT a claim about the subject.
    targetFor: () => "COMPLIANT" as TargetOutcome,
    distribution: (employees): SeededAssignment[] =>
      employees.map((employee) => ({ employee, target: "COMPLIANT" as TargetOutcome })),
    bundleFor: (employee, _measureId, _target, evaluationDate) => bundleForSubject(employee, evaluationDate),
    bundleForSubject,
  };
}

/** The pilot's measure set, exported for the test that proves one record answers all of them. */
export const MAUI_MEASURE_IDS_FOR_TEST = ["cms122", "cms125", "cms2", "cms130", "cms165", "cms137"] as const;
